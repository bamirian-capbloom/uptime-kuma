import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { MariaDbContainer } from "@testcontainers/mariadb";
const require = createRequire(import.meta.url);
const dependency = require("../../db/knex_migrations/2026-11-05-0000-add-monitor-dependency");
const notification = require("../../db/knex_migrations/2026-11-06-0000-dependency-notification-state");

test(
    "MariaDB dependency migrations preserve old monitors, enforce cleanup and roll back",
    {
        timeout: 180000,
        skip: Boolean(process.env.SKIP_TESTCONTAINER),
    },
    async (t) => {
        const container = await new MariaDbContainer("mariadb:10.11").withStartupTimeout(90000).start();
        t.after(() => container.stop());
        const db = require("knex")({
            client: "mysql2",
            connection: {
                host: container.getHost(),
                port: container.getPort(),
                user: container.getUsername(),
                password: container.getUserPassword(),
                database: container.getDatabase(),
            },
        });
        t.after(() => db.destroy());
        await db.schema.createTable("monitor", (table) => {
            table.increments("id");
            table.string("name");
        });
        await db("monitor").insert([
            { id: 1, name: "Legacy" },
            { id: 2, name: "Parent" },
        ]);
        await dependency.up(db);
        await notification.up(db);
        assert.equal((await db("monitor").where({ id: 1 }).first()).dependency_monitor_id, null);
        await db("monitor").where({ id: 1 }).update({ dependency_monitor_id: 2 });
        await db("monitor_notification_state").insert({ monitor_id: 2, status: 0, incident_open: true });
        await assert.rejects(db("monitor").where({ id: 1 }).update({ dependency_monitor_id: 999 }));
        await db("monitor").where({ id: 2 }).del();
        assert.equal((await db("monitor").where({ id: 1 }).first()).dependency_monitor_id, null);
        assert.equal(await db("monitor_notification_state").first(), undefined);
        await notification.down(db);
        await dependency.down(db);
        assert.equal(await db.schema.hasColumn("monitor", "dependency_monitor_id"), false);
        assert.equal((await db("monitor").where({ id: 1 }).first()).name, "Legacy");
        await dependency.up(db);
        await notification.up(db);
        assert.equal((await db("monitor").where({ id: 1 }).first()).dependency_monitor_id, null);
    }
);
