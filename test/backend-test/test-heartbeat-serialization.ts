import { test } from "node:test";
import assert from "node:assert/strict";
import Heartbeat from "../../server/model/heartbeat";
import { recordDependencyBeat, dependencyObservations } from "../../src/monitor-dependency";

test("authenticated live heartbeat time orders recovery after a stored DOWN snapshot", () => {
    const beat = Object.create(Heartbeat.prototype);
    Object.assign(beat, { _monitorId: 1, _status: 1, _time: "2026-11-09 13:00:00.002" });
    const payload = beat.toJSON();
    assert.equal(payload.time, "2026-11-09 13:00:00.002");
    const beats = {
        1: { id: 10, status: 0, time: "2026-11-09 13:00:00.001" },
        2: { id: 11, status: 0, time: "2026-11-09 13:00:00.001" },
    };
    recordDependencyBeat(beats, payload.monitorID, payload, true);
    const monitors = {
        1: { id: 1, name: "Gateway", active: true },
        2: { id: 2, name: "Service", active: true, dependencyMonitorId: 1 },
    };
    assert.deepEqual(dependencyObservations(monitors, beats), {});
    recordDependencyBeat(beats, 1, { id: 10, status: 0, time: "2026-11-09 13:00:00.001" });
    assert.deepEqual(dependencyObservations(monitors, beats), {});
    recordDependencyBeat(beats, 1, { id: 10, status: 0, time: "2026-11-09T13:00:00.001Z" });
    assert.deepEqual(dependencyObservations(monitors, beats), {});
    // Even a check in the same millisecond must apply in socket event order.
    recordDependencyBeat(beats, 1, { ...payload, status: 0 }, true);
    assert.equal(dependencyObservations(monitors, beats)[2].blockerId, 1);
    recordDependencyBeat(beats, 1, { ...payload, status: 1 });
    assert.equal(dependencyObservations(monitors, beats)[2].blockerId, 1);
    assert.equal("id" in beat.toPublicJSON(), false);
});
