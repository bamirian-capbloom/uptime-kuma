import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    dependencyChain,
    invalidateDependencyObservation,
    invalidateDependencyHistory,
    recordDependencyObservation,
    type DependencyMonitor,
    type SuppressionObservation,
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

const suppressedBeat = {
    monitorID: 3,
    status: 0,
    dependencyNotification: { suppressed: true, reason: "ancestor-down", suppressedByMonitorId: 1 },
};

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

describe("live suppression observations", () => {
    test("uses backend metadata without changing heartbeat status, supports transitive blockers", () => {
        const observations: Record<number, SuppressionObservation> = {};
        recordDependencyObservation(observations, monitors(), suppressedBeat);
        assert.deepEqual(observations[3], { blockerId: 1, ancestors: [2, 1] });
        assert.equal(suppressedBeat.status, 0);
    });
    test("never infers suppression from DOWN, unknown/retrying metadata, or history without metadata", () => {
        for (const status of [0, 1, 2, 3]) {
            const observations = {};
            recordDependencyObservation(observations, monitors(), { monitorID: 3, status });
            assert.deepEqual(observations, {});
        }
        const observations = {};
        recordDependencyObservation(observations, monitors(), {
            ...suppressedBeat,
            dependencyNotification: { suppressed: false, reason: "ancestor-unconfirmed" },
        });
        assert.deepEqual(observations, {});
    });
    test("rejects inactive, missing, unrelated and recovered blockers, and non-DOWN children", () => {
        for (const status of [1, 2, 3]) {
            const observations = {};
            recordDependencyObservation(observations, monitors(), { ...suppressedBeat, status });
            assert.deepEqual(observations, {});
            recordDependencyObservation(observations, monitors(), suppressedBeat, { 1: { status } });
            assert.deepEqual(observations, {});
        }
        for (const blocker of [2, 4, 99]) {
            const observations = {};
            recordDependencyObservation(observations, monitors(), {
                ...suppressedBeat,
                dependencyNotification: { ...suppressedBeat.dependencyNotification, suppressedByMonitorId: blocker },
            });
            assert.deepEqual(observations, {});
        }
        const list = monitors();
        list[3].active = false;
        const observations = {};
        recordDependencyObservation(observations, list, suppressedBeat);
        assert.deepEqual(observations, {});
    });
    test("invalidates on child or ancestor beats but preserves observations on unrelated beats", () => {
        for (const id of [1, 2, 3, 4]) {
            const observations: Record<number, SuppressionObservation> = {};
            recordDependencyObservation(observations, monitors(), suppressedBeat);
            recordDependencyObservation(observations, monitors(), { monitorID: id, status: 1 });
            assert.equal(Boolean(observations[3]), id === 4);
        }
    });
    test("historical latest-beat replacements invalidate live claims without reestablishing them", () => {
        const observations: Record<number, SuppressionObservation> = {};
        recordDependencyObservation(observations, monitors(), suppressedBeat);
        invalidateDependencyObservation(observations, 4);
        assert.equal(observations[3].blockerId, 1);
        invalidateDependencyObservation(observations, 1);
        assert.deepEqual(observations, {});
        recordDependencyObservation(observations, monitors(), suppressedBeat);
        invalidateDependencyObservation(observations, 3);
        assert.deepEqual(observations, {});
    });
    test("the same stored beat in history preserves confirmation, changed or unidentified beats invalidate it", () => {
        const observations: Record<number, SuppressionObservation> = {};
        recordDependencyObservation(observations, monitors(), suppressedBeat);
        invalidateDependencyHistory(observations, 3, { id: 10, status: 0 }, { id: 10, status: 0 });
        assert.equal(observations[3].blockerId, 1);
        invalidateDependencyHistory(observations, 3, { id: 10, status: 0 }, { id: 11, status: 1 });
        assert.deepEqual(observations, {});
        recordDependencyObservation(observations, monitors(), suppressedBeat);
        invalidateDependencyHistory(observations, 1, undefined, { status: 1 });
        assert.deepEqual(observations, {});
    });
    test("a fresh backend decision reestablishes suppression after invalidation", () => {
        const observations: Record<number, SuppressionObservation> = {};
        recordDependencyObservation(observations, monitors(), suppressedBeat);
        recordDependencyObservation(observations, monitors(), { monitorID: 1, status: 1 });
        assert.deepEqual(observations, {});
        recordDependencyObservation(observations, monitors(), suppressedBeat, { 1: { status: 0 } });
        assert.equal(observations[3].blockerId, 1);
    });
});
