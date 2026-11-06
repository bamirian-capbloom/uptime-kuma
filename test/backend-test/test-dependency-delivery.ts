import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import axios from "axios";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { io, type Socket } from "socket.io-client";

/**
 * Use the HTTP client used by monitors, with fresh connections across restarts.
 * @param url Local endpoint
 * @param options Request options
 * @returns Response helpers
 */
async function request(url: string, options: any = {}) {
    const response = await axios({
        url,
        method: options.method || "GET",
        data: options.body,
        headers: options.headers,
        validateStatus: () => true,
        httpAgent: new http.Agent({ keepAlive: false }),
    });
    return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        json: async () => response.data,
        headers: { getSetCookie: () => response.headers["set-cookie"] || [] },
    };
}

/**
 * Reserve an available local server port.
 * @returns {Promise<number>} Port number
 */
async function freePort(): Promise<number> {
    // Stay outside the OS ephemeral client-port range: clients opened during
    // migration could otherwise claim a port between reservation and startup.
    for (let attempt = 0; attempt < 20; attempt++) {
        const server = net.createServer();
        server.listen(20000 + Math.floor(Math.random() * 10000), "::");
        try {
            await once(server, "listening");
            const port = (server.address() as net.AddressInfo).port;
            await new Promise<void>((resolve) => server.close(() => resolve()));
            return port;
        } catch (error) {
            if (error.code !== "EADDRINUSE") {
                throw error;
            }
        }
    }
    throw new Error("No local test port available");
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

test("real notification delivery, dependency chains and restart persistence", { timeout: 180000 }, async (t) => {
    fs.mkdirSync("data", { recursive: true });
    const dataDir = fs.mkdtempSync(path.resolve("data/test-dependency-socket-"));
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const username = "dependencyadmin";
    const password = "Kuma-Dependency-Test-8f4Q2xR9p";
    const launch = () =>
        spawn(process.execPath, ["--import=tsx", "server/server.js"], {
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
    let child = launch();
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
                return (await request(`${baseUrl}/api/entry-page`)).ok;
            } catch {
                return false;
            }
        });
        const login = await request(`${baseUrl}/api/auth/sign-in/username`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username, password }),
        });
        assert.equal(login.status, 200);
        const cookie = login.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
        let socket = io(baseUrl, { extraHeaders: { cookie }, reconnection: false });
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

        const deliveries: any[] = [];
        const deliveryGates = new Map<string, Promise<void>>();
        const endpointStatus = new Map<string, number>();
        const receiver = http.createServer(async (req, res) => {
            if (req.url === "/capture") {
                let body = "";
                for await (const chunk of req) {
                    body += chunk;
                }
                const delivery = JSON.parse(body);
                deliveries.push(delivery);
                await deliveryGates.get(delivery.monitor.name);
                res.end("ok");
            } else {
                res.writeHead(endpointStatus.get(req.url || "") ?? 200);
                res.end("controlled health endpoint");
            }
        });
        receiver.listen(0, "127.0.0.1");
        await once(receiver, "listening");
        t.after(() => new Promise<void>((resolve) => receiver.close(() => resolve())));
        const receiverUrl = `http://127.0.0.1:${(receiver.address() as net.AddressInfo).port}`;
        const notification = await call(
            socket,
            "addNotification",
            {
                name: "Local capture",
                type: "webhook",
                webhookURL: `${receiverUrl}/capture`,
                webhookContentType: "json",
                isDefault: false,
            },
            null
        );
        assert.equal(notification.ok, true, notification.msg);
        const notifications = { [notification.id]: true };
        const pushMonitor = async (name, dependencyMonitorId = null, extra = {}) => {
            const id = await add(
                payload(name, {
                    type: "push",
                    active: true,
                    interval: 3600,
                    retryInterval: 3600,
                    pushToken: `step5-${name}`,
                    dependencyMonitorId,
                    notificationIDList: notifications,
                    ...extra,
                })
            );
            return id;
        };
        const push = async (id, status) => {
            const monitor = await get(id);
            const response = await request(`${baseUrl}/api/push/${monitor.pushToken}?status=${status}`);
            assert.equal(response.status, 200);
            assert.equal((await response.json()).ok, true);
        };
        const statuses = (id) => deliveries.filter((d) => d.monitor.id === id).map((d) => d.heartbeat.status);
        const a = await pushMonitor("A");
        const b = await pushMonitor("B", a);
        const c = await pushMonitor("C", b);
        await push(a, "up");
        await push(b, "up");
        await push(c, "up");
        assert.deepEqual(deliveries, []);
        await push(a, "down");
        await push(b, "down");
        await push(c, "down");
        assert.deepEqual(statuses(a), [0]);
        assert.deepEqual(statuses(b), []);
        assert.deepEqual(statuses(c), []);
        const beats = await call(socket, "getMonitorBeats", c, 24);
        assert.equal(beats.data.at(-1).status, 0);
        await push(c, "up");
        assert.deepEqual(statuses(c), []); // no orphan recovery
        await push(c, "down");
        await push(a, "up");
        await push(c, "down"); // B remains DOWN
        assert.deepEqual(statuses(c), []);
        await push(b, "down"); // deferred failure released on next check
        await push(b, "down");
        assert.deepEqual(statuses(b), [0]);
        await push(b, "up");
        await Promise.all([push(c, "down"), push(c, "down")]);
        assert.deepEqual(statuses(c), [0]);

        // Reopen the same SQLite DB in a fresh process, preserving announced incidents.
        socket.disconnect();
        child.kill();
        await once(child, "exit");
        child = launch();
        child.stdout.on("data", (data) => {
            output += data;
        });
        child.stderr.on("data", (data) => {
            output += data;
        });
        await waitFor(async () => {
            try {
                return (await request(`${baseUrl}/api/entry-page`)).ok;
            } catch {
                return false;
            }
        });
        socket = io(baseUrl, { extraHeaders: { cookie }, reconnection: false });
        sockets.push(socket);
        await once(socket, "session");
        assert.equal((await get(c)).dependencyMonitorId, b);
        await push(c, "down");
        assert.deepEqual(statuses(c), [0]); // no duplicate on restart
        await push(a, "down");
        await push(c, "up");
        assert.deepEqual(statuses(c), [0, 1]); // announced incident recovers despite A
        await push(c, "down");
        assert.deepEqual(statuses(c), [0, 1]);

        // Restart a silent deferred incident, then remove the blocker.
        socket.disconnect();
        child.kill();
        await once(child, "exit");
        child = launch();
        child.stdout.on("data", (data) => {
            output += data;
        });
        child.stderr.on("data", (data) => {
            output += data;
        });
        await waitFor(async () => {
            try {
                return (await request(`${baseUrl}/api/entry-page`)).ok;
            } catch {
                return false;
            }
        });
        socket = io(baseUrl, { extraHeaders: { cookie }, reconnection: false });
        sockets.push(socket);
        await once(socket, "session");
        await push(c, "down");
        assert.deepEqual(statuses(c), [0, 1]);
        assert.equal((await call(socket, "deleteMonitor", a)).ok, true);
        assert.equal((await get(b)).dependencyMonitorId, null);
        await push(c, "down");
        assert.deepEqual(statuses(c), [0, 1, 0]);

        // Public pages include the child health but never reveal private ancestors or live metadata.
        assert.equal((await call(socket, "addStatusPage", "Public service", "step5")).ok, true);
        const savedPage = await call(
            socket,
            "saveStatusPage",
            "step5",
            {
                slug: "step5",
                title: "Public service",
                theme: "auto",
                analyticsType: null,
                domainNameList: [],
                autoRefreshInterval: 300,
            },
            "",
            [{ name: "Services", monitorList: [{ id: c, sendUrl: false }] }]
        );
        assert.equal(savedPage.ok, true, savedPage.msg);
        const publicPage = await (await request(`${baseUrl}/api/status-page/step5`)).json();
        const published = publicPage.publicGroupList[0].monitorList;
        assert.deepEqual(
            published.map((monitor) => monitor.id),
            [c]
        );
        assert.equal(published[0].dependencyMonitorId, undefined);
        const publicBeats = await (await request(`${baseUrl}/api/status-page/heartbeat/step5`)).json();
        assert.deepEqual(Object.keys(publicBeats.heartbeatList), [String(c)]);
        assert.equal(publicBeats.heartbeatList[c].at(-1).status, 0);
        assert.equal(JSON.stringify(publicBeats).includes("dependencyNotification"), false);
        assert.equal(JSON.stringify(publicPage).includes("step5-B"), false);
        const anonymous = io(baseUrl, { reconnection: false });
        sockets.push(anonymous);
        await once(anonymous, "info");
        let leaked = false;
        anonymous.on("heartbeat", () => {
            leaked = true;
        });
        assert.equal((await call(anonymous, "getMonitor", c)).ok, false);
        assert.equal((await call(anonymous, "getMonitorBeats", c, 24)).ok, false);
        const liveBeat = once(socket, "heartbeat");
        await push(c, "down");
        await liveBeat;
        assert.equal(leaked, false);

        // Unknown/PENDING defer, while a paused dependency's stale DOWN is ignored.
        const unknown = await pushMonitor("Unknown");
        const waiting = await pushMonitor("Waiting", unknown);
        await push(waiting, "down");
        assert.deepEqual(statuses(waiting), []);
        await push(unknown, "up");
        await push(waiting, "down");
        assert.deepEqual(statuses(waiting), [0]);
        await push(unknown, "down");
        assert.equal((await call(socket, "pauseMonitor", unknown)).ok, true);
        await push(waiting, "up");
        await push(waiting, "down");
        assert.deepEqual(statuses(waiting), [0, 1, 0]);

        // Scheduled HTTP checks use the same gate and retain real status/retry semantics.
        endpointStatus.set("/health", 503);
        const httpChild = await add(
            payload("HTTP child", {
                type: "http",
                active: true,
                url: `${receiverUrl}/health`,
                interval: 1,
                retryInterval: 1,
                maxretries: 1,
                dependencyMonitorId: b,
                notificationIDList: notifications,
            })
        );
        await waitFor(async () => {
            const result = await call(socket, "getMonitorBeats", httpChild, 24);
            return result.data?.some((beat) => beat.status === 2) && result.data?.some((beat) => beat.status === 0);
        });
        await waitFor(async () => statuses(httpChild).length === 1);
        assert.deepEqual(statuses(httpChild), [0]);
        await push(b, "down");
        endpointStatus.set("/health", 200);
        await waitFor(async () => statuses(httpChild).length === 2);
        assert.deepEqual(statuses(httpChild), [0, 1]);
        endpointStatus.set("/health", 503);
        await waitFor(async () => {
            const result = await call(socket, "getMonitorBeats", httpChild, 24);
            return result.data?.filter((beat) => beat.status === 0).length >= 2;
        });
        assert.deepEqual(statuses(httpChild), [0, 1]);
        endpointStatus.set("/health", 200);
        await waitFor(async () => {
            const result = await call(socket, "getMonitorBeats", httpChild, 24);
            return result.data?.at(-1).status === 1;
        });
        assert.deepEqual(statuses(httpChild), [0, 1]);
        // Actual repeats resume after release and remain blocked during a parent outage.
        const repeat = await pushMonitor("Repeats", b, { resendInterval: 1 });
        await push(repeat, "down");
        assert.deepEqual(statuses(repeat), []);
        await push(b, "up");
        await push(repeat, "down");
        await push(repeat, "down");
        assert.deepEqual(statuses(repeat), [0, 0]);
        await push(b, "down");
        await push(repeat, "down");
        assert.deepEqual(statuses(repeat), [0, 0]);
        await push(repeat, "up");
        assert.deepEqual(statuses(repeat), [0, 0, 1]);

        // Child checks can finish while a parent's notification is still in flight.
        const slow = await pushMonitor("Slow-root");
        const fast = await pushMonitor("Fast-child", slow);
        await push(slow, "up");
        await push(fast, "up");
        let release: () => void;
        deliveryGates.set(
            "Slow-root",
            new Promise<void>((resolve) => {
                release = resolve;
            })
        );
        const slowFailure = push(slow, "down");
        try {
            await waitFor(async () => statuses(slow).length === 1);
            await push(fast, "down");
            assert.deepEqual(statuses(fast), []);
        } finally {
            release();
            await slowFailure;
        }
        deliveryGates.delete("Slow-root");
        await push(slow, "up");
        await push(fast, "down");
        assert.deepEqual(statuses(fast), [0]);
    } catch (error) {
        t.diagnostic(output);
        throw error;
    }
});
