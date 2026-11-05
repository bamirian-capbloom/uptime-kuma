import { before, after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const knex = require("knex");
const { R } = require("redbean-node");
const Monitor = require("../../server/model/monitor");
const { UptimeKumaServer } = require("../../server/uptime-kuma-server");
const { validateMonitorDependency, saveMonitorWithDependency } = require("../../server/monitor-dependency");
const migration = require("../../db/knex_migrations/2026-11-05-0000-add-monitor-dependency");

const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });

before(async () => {
    R.setup(db);
    await db.raw("PRAGMA foreign_keys = ON");
    await db.schema.createTable("monitor", (table) => {
        table.increments("id");
        table.string("name");
        table.string("user_id");
        table.string("type");
        table.integer("parent");
    });
    await db("monitor").insert({ id: 1, name: "Before migration", user_id: "alice" });
    await migration.up(db);
    assert.equal((await db("monitor").where({ id: 1 }).first()).dependency_monitor_id, null);
});
after(async () => db.destroy());

beforeEach(async () => {
    await db("monitor").update({ dependency_monitor_id: null });
    await db("monitor").del();
    await db("monitor").insert([
        { id: 1, name: "A", user_id: "alice" },
        { id: 2, name: "B", user_id: "alice" },
        { id: 3, name: "C", user_id: "alice" },
        { id: 4, name: "Other user", user_id: "bob" },
        { id: 5, name: "Legacy", user_id: null },
    ]);
});

describe("monitor dependency validation", () => {
    test("permits a dependency chain and clearing a dependency", async () => {
        await db("monitor").where({ id: 2 }).update({ dependency_monitor_id: 3 });
        assert.equal(await validateMonitorDependency(2, 1, "alice"), 2);
        assert.equal(await validateMonitorDependency(null, 1, "alice"), null);
        assert.equal(await validateMonitorDependency(5, 1, "alice"), 5);
        assert.equal(await validateMonitorDependency(4, 1, "alice"), 4);
    });

    test("rejects malformed IDs without coercion", async () => {
        for (const value of [
            undefined,
            "2",
            "",
            0,
            -1,
            1.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
            true,
            {},
            [],
        ]) {
            await assert.rejects(validateMonitorDependency(value, 1, "alice"), /Invalid dependency/);
        }
    });

    test("rejects nonexistent and unauthorized dependencies", async () => {
        await assert.rejects(validateMonitorDependency(999, 1, "alice"), /not found or access denied/);

        await assert.rejects(validateMonitorDependency(2, 1, undefined), /access denied/);
        await db("monitor").where({ id: 2 }).update({ dependency_monitor_id: 4 });
        assert.equal(await validateMonitorDependency(2, 1, "alice"), 2);
    });

    test("rejects self references, indirect cycles and preexisting cycles", async () => {
        await assert.rejects(validateMonitorDependency(1, 1, "alice"), /circular/);
        await db("monitor").where({ id: 2 }).update({ dependency_monitor_id: 3 });
        await db("monitor").where({ id: 3 }).update({ dependency_monitor_id: 1 });
        await assert.rejects(validateMonitorDependency(2, 1, "alice"), /circular/);
        await db("monitor").where({ id: 3 }).update({ dependency_monitor_id: 2 });
        await assert.rejects(validateMonitorDependency(2, undefined, "alice"), /circular/);
    });
});

describe("saving monitor dependencies", () => {
    test("shared access permits editing another user's monitor but cannot resurrect a deleted monitor", async () => {
        const other = await R.findOne("monitor", "id = ?", [4]);
        await saveMonitorWithDependency(other, 2, "alice");
        assert.equal((await db("monitor").where({ id: 4 }).first()).dependency_monitor_id, 2);
        const deleted = await R.findOne("monitor", "id = ?", [1]);
        await db("monitor").where({ id: 1 }).del();
        await assert.rejects(saveMonitorWithDependency(deleted, undefined, "alice"), /not found/);
    });

    test("defaults old add payloads to null and ignores imported raw values", async () => {
        const bean = R.dispense("monitor");
        bean.name = "New";
        bean.user_id = "alice";
        bean.dependency_monitor_id = 4;
        await saveMonitorWithDependency(bean, undefined, "alice");
        assert.equal((await db("monitor").where({ id: bean.id }).first()).dependency_monitor_id, null);
    });

    test("omitted edit field preserves the stored dependency; null clears it", async () => {
        await db("monitor").where({ id: 1 }).update({ dependency_monitor_id: 2 });
        const bean = await R.findOne("monitor", "id = ?", [1]);
        bean.name = "Renamed";
        await saveMonitorWithDependency(bean, undefined, "alice");
        assert.equal((await db("monitor").where({ id: 1 }).first()).dependency_monitor_id, 2);
        await saveMonitorWithDependency(bean, null, "alice");
        assert.equal((await db("monitor").where({ id: 1 }).first()).dependency_monitor_id, null);
    });

    test("invalid edits leave the stored monitor unchanged", async () => {
        const bean = await R.findOne("monitor", "id = ?", [1]);
        bean.name = "Should not save";
        await assert.rejects(saveMonitorWithDependency(bean, 999, "alice"), /not found/);
        assert.equal((await db("monitor").where({ id: 1 }).first()).name, "A");
    });

    test("simultaneous opposing edits cannot introduce a cycle, and failures release the lock", async () => {
        const a = await R.findOne("monitor", "id = ?", [1]);
        const b = await R.findOne("monitor", "id = ?", [2]);
        const results = await Promise.allSettled([
            saveMonitorWithDependency(a, 2, "alice"),
            saveMonitorWithDependency(b, 1, "alice"),
        ]);
        assert.deepEqual(
            results.map((result) => result.status),
            ["fulfilled", "rejected"]
        );
        await saveMonitorWithDependency(b, 3, "alice");
        assert.equal((await db("monitor").where({ id: 2 }).first()).dependency_monitor_id, 3);
    });
});

describe("dependency deletion", () => {
    test("explicit cleanup works when SQLite foreign keys are disabled", async (t) => {
        await db("monitor").where({ id: 1 }).update({ dependency_monitor_id: 2 });
        t.mock.method(UptimeKumaServer, "getInstance", () => ({ monitorList: {} }));
        await db.raw("PRAGMA foreign_keys = OFF");
        try {
            await Monitor.deleteMonitor(2);
            assert.equal((await db("monitor").where({ id: 1 }).first()).dependency_monitor_id, null);
        } finally {
            await db.raw("PRAGMA foreign_keys = ON");
        }
    });

    test("deletion clears persisted and running references; stale edits do not restore them", async (t) => {
        await db("monitor").whereIn("id", [1, 3]).update({ dependency_monitor_id: 2 });
        const staleBean = await R.findOne("monitor", "id = ?", [1]);
        let stopped = false;
        const running = {
            1: { dependency_monitor_id: 2 },
            2: {
                stop: async () => {
                    stopped = true;
                },
            },
            3: { dependency_monitor_id: 2 },
        };
        t.mock.method(UptimeKumaServer, "getInstance", () => ({ monitorList: running }));
        await Monitor.deleteMonitor("2");
        assert.equal(stopped, true);
        assert.equal(running[2], undefined);
        assert.equal(running[1].dependency_monitor_id, null);
        assert.equal(running[3].dependency_monitor_id, null);
        assert.equal((await db("monitor").where({ id: 3 }).first()).dependency_monitor_id, null);
        await saveMonitorWithDependency(staleBean, undefined, "alice");
        assert.equal((await db("monitor").where({ id: 1 }).first()).dependency_monitor_id, null);
        await assert.rejects(saveMonitorWithDependency(staleBean, 2, "alice"), /not found/);
    });

    test("recursive group deletion clears dependencies of surviving monitors", async (t) => {
        await db("monitor").where({ id: 2 }).update({ type: "group" });
        await db("monitor").where({ id: 3 }).update({ parent: 2 });
        await db("monitor").where({ id: 1 }).update({ dependency_monitor_id: 3 });
        t.mock.method(UptimeKumaServer, "getInstance", () => ({ monitorList: {} }));
        await Monitor.deleteMonitorRecursively(2);
        assert.equal(await db("monitor").where({ id: 3 }).first(), undefined);
        assert.equal((await db("monitor").where({ id: 1 }).first()).dependency_monitor_id, null);
    });

    test("foreign key clears references even for direct database deletions", async () => {
        await db("monitor").where({ id: 1 }).update({ dependency_monitor_id: 2 });
        await db("monitor").where({ id: 2 }).del();
        assert.equal((await db("monitor").where({ id: 1 }).first()).dependency_monitor_id, null);
    });
});

test("dependency migration rolls back and can be reapplied without losing monitors", async () => {
    await migration.down(db);
    assert.equal(await db.schema.hasColumn("monitor", "dependency_monitor_id"), false);
    assert.equal((await db("monitor").where({ id: 1 }).first()).name, "A");
    await migration.up(db);
    assert.equal((await db("monitor").where({ id: 1 }).first()).dependency_monitor_id, null);
});
