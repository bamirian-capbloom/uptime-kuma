import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    dependencyChain,
    dependencyObservations,
    recordDependencyBeat,
    type DependencyBeat,
    type DependencyMonitor,
} from "../../src/monitor-dependency";

/**
 * Example: service -> proxy (paused) -> gateway, plus an unrelated monitor.
 * @returns Monitor configuration
 */
function monitors(): Record<number, DependencyMonitor> {
    return {
        1: { id: 1, name: "Gateway", active: true, dependencyMonitorId: null },
        2: { id: 2, name: "Proxy", active: false, dependencyMonitorId: 1 },
        3: { id: 3, name: "Service", active: true, dependencyMonitorId: 2 },
        4: { id: 4, name: "Other", active: true, dependencyMonitorId: null },
    };
}

describe("dependency selection", () => {
    test("allows None, independent monitors and transitive ancestors including paused monitors", () => {
        assert.deepEqual(dependencyChain(monitors(), null, 3), []);
        assert.deepEqual(dependencyChain(monitors(), 4, 3), [4]);
        assert.deepEqual(dependencyChain(monitors(), 2, 3), [2, 1]);
    });
    test("rejects self, descendants, existing cycles and missing configuration", () => {
        assert.equal(dependencyChain(monitors(), 3, 3), null);
        assert.equal(dependencyChain(monitors(), 3, 1), null);
        const list = monitors();
        list[1].dependencyMonitorId = 2;
        assert.equal(dependencyChain(list, 2, 4), null);
        assert.equal(dependencyChain(list, 99, 3), null);
        delete list[1];
        assert.equal(dependencyChain(list, 2, 3), null);
    });
});

describe("current suppression observations", () => {
    test("repeated child, parent, intermediate and unrelated DOWN beats preserve the label", () => {
        const beats: Record<number, DependencyBeat> = {};
        recordDependencyBeat(beats, 1, { id: 1, status: 0 });
        recordDependencyBeat(beats, 3, { id: 2, status: 0 });
        for (let id = 3; id < 30; id++) {
            for (const monitorId of [1, 2, 3, 4]) {
                recordDependencyBeat(beats, monitorId, { id, status: 0 });
                assert.deepEqual(dependencyObservations(monitors(), beats)[3], { blockerId: 1, ancestors: [2, 1] });
            }
        }
    });
    test("removes labels immediately on child or blocker recovery, pending or maintenance", () => {
        for (const monitorId of [1, 3]) {
            for (const status of [1, 2, 3]) {
                const beats = { 1: { status: 0 }, 3: { status: 0 } };
                recordDependencyBeat(beats, monitorId, { status });
                assert.deepEqual(dependencyObservations(monitors(), beats), {});
            }
        }
    });
    test("unknown children and ancestors do not establish suppression", () => {
        for (const beats of [{}, { 1: { status: 0 } }, { 3: { status: 0 } }]) {
            assert.deepEqual(dependencyObservations(monitors(), beats), {});
        }
    });
    test("reload/reconnect snapshots reconcile in either order without a new child heartbeat", () => {
        for (const order of [[1, 3], [3, 1]]) {
            const beats: Record<number, DependencyBeat> = {};
            assert.deepEqual(dependencyObservations(monitors(), beats), {});
            recordDependencyBeat(beats, order[0], { id: 10, status: 0 });
            assert.deepEqual(dependencyObservations(monitors(), beats), {});
            recordDependencyBeat(beats, order[1], { id: 11, status: 0 });
            assert.equal(dependencyObservations(monitors(), beats)[3].blockerId, 1);
            // A new connection starts with no trusted observations.
            assert.deepEqual(dependencyObservations(monitors(), {}), {});
        }
    });
    test("delayed history cannot roll back live recovery or a newer DOWN observation", () => {
        const beats = { 1: { id: 20, status: 1 }, 3: { id: 21, status: 0 } };
        recordDependencyBeat(beats, 1, { id: 19, status: 0 });
        recordDependencyBeat(beats, 1, { status: 0 });
        assert.deepEqual(dependencyObservations(monitors(), beats), {});
        recordDependencyBeat(beats, 1, { id: 22, status: 0 });
        recordDependencyBeat(beats, 3, { id: 18, status: 1 });
        assert.equal(dependencyObservations(monitors(), beats)[3].blockerId, 1);
        recordDependencyBeat(beats, 3, { id: 23, status: 1 });
        assert.deepEqual(dependencyObservations(monitors(), beats), {});
    });
    test("configuration changes, deletion, pause and malformed chains reconcile immediately", () => {
        const beats = { 1: { status: 0 }, 3: { status: 0 }, 4: { status: 0 } };
        const list = monitors();
        list[3].dependencyMonitorId = 4;
        assert.equal(dependencyObservations(list, beats)[3].blockerId, 4);
        list[3].dependencyMonitorId = null;
        assert.deepEqual(dependencyObservations(list, beats), {});
        list[3].dependencyMonitorId = 2;
        list[1].active = false;
        assert.deepEqual(dependencyObservations(list, beats), {});
        list[1].active = true;
        list[3].active = false;
        assert.deepEqual(dependencyObservations(list, beats), {});
        list[3].active = true;
        list[1].dependencyMonitorId = 3;
        assert.deepEqual(dependencyObservations(list, beats), {});
        delete list[1];
        assert.deepEqual(dependencyObservations(list, beats), {});
    });
    test("uses the closest active DOWN ancestor and falls back when it recovers", () => {
        const list = monitors();
        list[2].active = true;
        const beats = { 1: { status: 0 }, 2: { status: 0 }, 3: { status: 0 } };
        assert.equal(dependencyObservations(list, beats)[3].blockerId, 2);
        recordDependencyBeat(beats, 2, { status: 1 });
        assert.equal(dependencyObservations(list, beats)[3].blockerId, 1);
    });
});
