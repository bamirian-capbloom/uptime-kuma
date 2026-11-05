import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { io, type Socket } from "socket.io-client";

/**
 * Reserve an available local server port.
 * @returns {Promise<number>} Port number
 */
async function freePort(): Promise<number> {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

/**
 * Wait for an asynchronous condition, with a bounded timeout.
 * @param {Function} condition Condition to check
 * @returns {Promise<void>} Resolves once ready
 */
async function waitFor(condition: () => Promise<boolean>) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        if (await condition()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Timed out waiting for the dependency test server");
}

/**
 * Call a real Socket.IO handler with an acknowledgement timeout.
 * @param {Socket} socket Connected socket
 * @param {string} event Event to emit
 * @param {any[]} args Event arguments
 * @returns {Promise<any>} Acknowledgement
 */
async function call(socket: Socket, event: string, ...args: any[]): Promise<any> {
    return socket.timeout(10000).emitWithAck(event, ...args);
}

/**
 * A complete legacy add-monitor payload without dependency configuration.
 * @param {string} name Monitor name
 * @param {object} extra Additional fields
 * @returns {object} Monitor payload
 */
function payload(name: string, extra = {}) {
    return {
        name,
        type: "manual",
        manual_status: 1,
        active: false,
        parent: null,
        interval: 20,
        retryInterval: 20,
        maxretries: 0,
        accepted_statuscodes: ["200-299"],
        kafkaProducerBrokers: [],
        kafkaProducerSaslOptions: {},
        rabbitmqNodes: [],
        conditions: [],
        notificationIDList: {},
        ...extra,
    };
}

test("Socket.IO monitor dependency lifecycle and independent health checks", { timeout: 120000 }, async (t) => {
    fs.mkdirSync("data", { recursive: true });
    const dataDir = fs.mkdtempSync(path.resolve("data/test-dependency-socket-"));
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const username = "dependencyadmin";
    const password = "Kuma-Dependency-Test-8f4Q2xR9p";
    const child = spawn(process.execPath, ["--import=tsx", "server/server.js"], {
        env: {
            ...process.env,
            DATA_DIR: dataDir,
            UPTIME_KUMA_PORT: String(port),
            UPTIME_KUMA_DB_TYPE: "sqlite",
            UK_INITIAL_ADMIN_USERNAME: username,
            UK_INITIAL_ADMIN_PASSWORD: password,
            UPTIME_KUMA_DISABLE_LEAK_PWD_CHECK: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
        output += data;
    });
    child.stderr.on("data", (data) => {
        output += data;
    });
    const sockets: Socket[] = [];
    t.after(async () => {
        for (const socket of sockets) {
            socket.disconnect();
        }
        if (child.exitCode === null) {
            child.kill();
            await once(child, "exit");
        }
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    try {
        await waitFor(async () => {
            try {
                return (await fetch(`${baseUrl}/api/entry-page`)).ok;
            } catch {
                return false;
            }
        });
        const login = await fetch(`${baseUrl}/api/auth/sign-in/username`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username, password }),
        });
        assert.equal(login.status, 200);
        const cookie = login.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
        const socket = io(baseUrl, { extraHeaders: { cookie }, reconnection: false });
        sockets.push(socket);
        await once(socket, "session");

        const add = async (monitor) => {
            const result = await call(socket, "add", monitor);
            assert.equal(result.ok, true, result.msg);
            return result.monitorID;
        };
        const get = async (id) => {
            const result = await call(socket, "getMonitor", id);
            assert.equal(result.ok, true, result.msg);
            return result.monitor;
        };
        const edit = async (id, fields) => call(socket, "editMonitor", { ...(await get(id)), ...fields });
        const root = await add(payload("Root"));
        assert.equal((await get(root)).dependencyMonitorId, null);
        const middle = await add(payload("Middle", { dependencyMonitorId: root }));
        const leaf = await add(payload("Leaf", { dependencyMonitorId: middle }));
        assert.equal((await get(leaf)).dependencyMonitorId, middle);

        for (const value of ["1", 0, -1, 1.5, {}, [], 9999999]) {
            const result = await call(socket, "add", payload("Invalid", { dependencyMonitorId: value }));
            assert.equal(result.ok, false);
        }
        assert.equal((await edit(root, { dependencyMonitorId: root })).ok, false);
        assert.equal((await edit(root, { dependencyMonitorId: leaf })).ok, false);
        assert.equal((await get(root)).dependencyMonitorId, null);

        // A pre-feature client gets and saves the other fields without knowing about dependencies.
        const oldClient = await get(leaf);
        delete oldClient.dependencyMonitorId;
        oldClient.name = "Legacy edit";
        assert.equal((await call(socket, "editMonitor", oldClient)).ok, true);
        assert.equal((await get(leaf)).dependencyMonitorId, middle);
        assert.equal((await edit(leaf, { dependencyMonitorId: null })).ok, true);
        assert.equal((await get(leaf)).dependencyMonitorId, null);

        // Neither import aliases nor raw database fields bypass dependency validation.
        const raw = await add(payload("Raw import", { dependency_monitor_id: 9999999 }));
        assert.equal((await get(raw)).dependencyMonitorId, null);
        assert.equal((await edit(raw, { dependency_monitor_id: 9999999 })).ok, true);
        assert.equal((await get(raw)).dependencyMonitorId, null);

        const opposing = await Promise.all([
            edit(root, { dependencyMonitorId: leaf }),
            edit(leaf, { dependencyMonitorId: root }),
        ]);
        assert.equal(opposing.filter((result) => result.ok).length, 1);
        await edit(root, { dependencyMonitorId: null });
        await edit(leaf, { dependencyMonitorId: middle });

        // Both monitors run checks; the dependency being DOWN cannot change the child's actual UP status.
        const down = await add(payload("Down dependency", { active: true, manual_status: 0 }));
        const up = await add(payload("Independent child", { active: true, dependencyMonitorId: down }));
        await waitFor(async () => {
            const downBeats = await call(socket, "getMonitorBeats", down, 24);
            const upBeats = await call(socket, "getMonitorBeats", up, 24);
            return downBeats.data?.some((beat) => beat.status === 0) && upBeats.data?.some((beat) => beat.status === 1);
        });
        assert.equal((await get(up)).active, true);

        // The legacy delete signature still works and survivors receive their cleared dependency.
        const updatedList = once(socket, "monitorList");
        assert.equal((await call(socket, "deleteMonitor", middle)).ok, true);
        const [list] = await updatedList;
        assert.equal(list[leaf].dependencyMonitorId, null);
        assert.equal((await get(leaf)).dependencyMonitorId, null);
        assert.equal((await get(root)).dependencyMonitorId, null);

        const group = await add(payload("Group", { type: "group" }));
        const childID = await add(payload("Grouped monitor", { parent: group }));
        await edit(raw, { dependencyMonitorId: childID });
        assert.equal((await call(socket, "deleteMonitor", group, true)).ok, true);
        assert.equal((await get(raw)).dependencyMonitorId, null);
        assert.equal((await call(socket, "getMonitor", childID)).ok, false);

        const anonymous = io(baseUrl, { reconnection: false });
        sockets.push(anonymous);
        await once(anonymous, "info");
        for (const [event, args] of [
            ["add", [payload("Unauthorized", { dependencyMonitorId: root })]],
            ["editMonitor", [{ ...(await get(root)), dependencyMonitorId: leaf }]],
            ["getMonitor", [root]],
            ["deleteMonitor", [root]],
        ] as [string, any[]][]) {
            const result = await call(anonymous, event, ...args);
            assert.equal(result.ok, false);
            assert.match(result.msg, /not logged in/);
        }
    } catch (error) {
        t.diagnostic(output);
        throw error;
    }
});
