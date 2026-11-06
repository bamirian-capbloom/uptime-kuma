import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { R } = require("redbean-node");
const { UP, DOWN, PENDING, MAINTENANCE } = require("../../src/util");
const {
    processDependencyNotification: processBeat,
    dependencyMetadata,
} = require("../../server/dependency-notification");
const migration = require("../../db/knex_migrations/2026-11-06-0000-dependency-notification-state");
const db = require("knex")({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
let sent: number[];
let child: any;
const beat = (monitor: any, status: number, previous: number | null = DOWN, requested = false) =>
    processBeat(monitor, { status }, previous === null ? null : { status: previous }, requested, async () => {
        sent.push(status);
    });
before(async () => {
    R.setup(db);
    await db.raw("PRAGMA foreign_keys = ON");
    await db.schema.createTable("monitor", (t) => {
        t.integer("id").primary();
        t.integer("dependency_monitor_id");
        t.boolean("active");
    });
    await db.schema.createTable("heartbeat", (t) => {
        t.increments("id");
        t.integer("monitor_id");
        t.integer("status");
    });
    await migration.up(db);
});
after(async () => {
    await migration.down(db);
    await db.destroy();
});
beforeEach(async () => {
    await db("monitor_notification_state").del();
    await db("heartbeat").del();
    await db("monitor").del();
    await db("monitor").insert([
        { id: 1, active: true, dependency_monitor_id: 2 },
        { id: 2, active: true, dependency_monitor_id: 3 },
        { id: 3, active: true },
    ]);
    child = { id: 1, dependency_monitor_id: 2 };
    sent = [];
});
/**
 * Record an ancestor heartbeat.
 * @param status Observed status
 * @param id Ancestor ID
 * @returns Resolves after storing the observation
 */
async function parent(status: number, id = 3) {
    await db("heartbeat").insert({ monitor_id: id, status });
}
test("transitive confirmed DOWN wins over unknown direct parent; beats remain DOWN", async () => {
    await parent(DOWN);
    const current = { status: DOWN };
    const result = await processBeat(child, current, { status: UP }, true, async () => {
        sent.push(DOWN);
    });
    assert.equal(result.suppressedByMonitorId, 3);
    assert.equal(result.deferred, true);
    assert.equal(current.status, DOWN);
    assert.deepEqual(sent, []);
});
test("unknown and retrying ancestors defer until conclusive; paused ancestors do not block", async () => {
    assert.equal((await beat(child, DOWN, UP, true)).reason, "ancestor-unconfirmed");
    await parent(PENDING, 2);
    await parent(UP);
    assert.equal((await beat(child, DOWN)).waitingForMonitorId, 2);
    await db("monitor").where({ id: 2 }).update({ active: false });
    await beat(child, DOWN);
    assert.deepEqual(sent, [DOWN]);
});
test("deferred incident sends once after parent recovery even with repeats disabled", async () => {
    await parent(DOWN, 2);
    await parent(UP);
    await beat(child, DOWN, UP, true);
    await beat(child, DOWN, DOWN, true);
    await parent(UP, 2);
    await beat(child, DOWN);
    await beat(child, DOWN);
    assert.deepEqual(sent, [DOWN]);
    await beat(child, DOWN, DOWN, true);
    assert.deepEqual(sent, [DOWN, DOWN]);
    await beat(child, UP, DOWN, true);
    assert.deepEqual(sent, [DOWN, DOWN, UP]);
});
test("silent incidents recover silently, including across maintenance and restart", async () => {
    await parent(DOWN, 2);
    await beat(child, DOWN, UP, true);
    await beat(child, MAINTENANCE);
    // Reload the module to discard process-local serialization state.
    delete require.cache[require.resolve("../../server/dependency-notification")];
    const reloaded = require("../../server/dependency-notification").processDependencyNotification;
    await reloaded(child, { status: UP }, { status: MAINTENANCE }, false, async () => {
        sent.push(UP);
    });
    assert.deepEqual(sent, []);
});
test("already alerted legacy incident recovers while parent is DOWN; repeats suppressed", async () => {
    await parent(DOWN, 2);
    await beat(child, DOWN, DOWN, true);
    await beat(child, UP, DOWN, true);
    assert.deepEqual(sent, [UP]);
});
test("concurrent duplicate decisions produce one deferred DOWN; observations override stale heartbeat", async () => {
    await parent(DOWN, 2);
    await parent(UP);
    await beat(child, DOWN, UP, true);
    await beat({ id: 2, dependency_monitor_id: 3 }, UP, DOWN, true);
    sent = [];
    await Promise.all([beat(child, DOWN), beat(child, DOWN)]);
    assert.deepEqual(sent, [DOWN]);
});
test("maintenance ancestor is not DOWN; paused ancestor still traverses to failed grandparent", async () => {
    await parent(MAINTENANCE, 2);
    await parent(UP);
    assert.equal((await dependencyMetadata(child)).reason, null);
    await db("monitor").where({ id: 2 }).update({ active: false });
    await parent(DOWN);
    assert.equal((await dependencyMetadata(child)).suppressedByMonitorId, 3);
});
test("no dependency preserves ordinary transitions and repeats", async () => {
    child.dependency_monitor_id = null;
    await beat(child, UP, null, true);
    await beat(child, DOWN, UP, true);
    await beat(child, DOWN);
    await beat(child, DOWN, DOWN, true);
    await beat(child, UP, DOWN, true);
    assert.deepEqual(sent, [UP, DOWN, DOWN, UP]);
});
test("failed send retries deferred incident without opening it", async () => {
    await parent(DOWN, 2);
    await parent(UP);
    await beat(child, DOWN, UP, true);
    await parent(UP, 2);
    await assert.rejects(
        processBeat(child, { status: DOWN }, { status: DOWN }, false, async () => {
            throw Error("failed");
        })
    );
    await beat(child, DOWN);
    assert.deepEqual(sent, [DOWN]);
});

test("removing a dependency releases a deferred incident and silent recovery remains silent", async () => {
    await parent(DOWN, 2);
    await beat(child, DOWN, UP, true);
    child.dependency_monitor_id = null;
    await beat(child, DOWN);
    await beat(child, DOWN);
    assert.deepEqual(sent, [DOWN]);
});
test("paused parent ignores its stale DOWN observation", async () => {
    await parent(DOWN, 2);
    await parent(UP);
    await db("monitor").where({ id: 2 }).update({ active: false });
    await beat(child, DOWN, UP, true);
    assert.deepEqual(sent, [DOWN]);
});
test("ordinary maintenance recovery does not create an extra notification", async () => {
    child.dependency_monitor_id = null;
    await beat(child, DOWN, UP, true);
    await beat(child, MAINTENANCE, DOWN, false);
    await beat(child, UP, MAINTENANCE, false);
    assert.deepEqual(sent, [DOWN]);
});
test("first delivery failure is durable and retried without a new transition", async () => {
    child.dependency_monitor_id = null;
    await assert.rejects(
        processBeat(child, { status: DOWN }, { status: UP }, true, async () => {
            throw Error("failed");
        })
    );
    await beat(child, DOWN);
    assert.deepEqual(sent, [DOWN]);
});
test("notification state is deleted with its monitor", async () => {
    await beat(child, DOWN, UP, true);
    await db("monitor").where({ id: 1 }).del();
    assert.equal(await db("monitor_notification_state").where({ monitor_id: 1 }).first(), undefined);
});

test("concurrent pushes with the same stale transition send one DOWN and one recovery", async () => {
    child.dependency_monitor_id = null;
    await Promise.all([beat(child, DOWN, UP, true), beat(child, DOWN, UP, true)]);
    assert.deepEqual(sent, [DOWN]);
    await Promise.all([beat(child, UP, DOWN, true), beat(child, UP, DOWN, true)]);
    assert.deepEqual(sent, [DOWN, UP]);
});

test("released alert starts a fresh repeat interval", async () => {
    await parent(DOWN, 2);
    await parent(UP);
    await beat(child, DOWN, UP, true);
    await parent(UP, 2);
    const current = { status: DOWN, downCount: 4 };
    await processBeat(child, current, { status: DOWN }, false, async () => {
        sent.push(DOWN);
    });
    assert.equal(current.downCount, 0);
    assert.deepEqual(sent, [DOWN]);
});

test("slow parent delivery does not block child checks or hide confirmed DOWN", async () => {
    await parent(UP);
    let release: () => void;
    let started: () => void;
    const delivering = new Promise<void>((resolve) => {
        started = resolve;
    });
    const delivery = new Promise<void>((resolve) => {
        release = resolve;
    });
    const parentBeat = processBeat(
        { id: 2, dependency_monitor_id: 3 },
        { status: DOWN },
        { status: UP },
        true,
        async () => {
            started();
            await delivery;
        }
    );
    await delivering;
    try {
        const result = await beat(child, DOWN, UP, true);
        assert.equal(result.suppressedByMonitorId, 2);
        assert.deepEqual(sent, []);
    } finally {
        release();
        await parentBeat;
    }
});
