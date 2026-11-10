import { test } from "node:test";
import assert from "node:assert/strict";
import { reactive, toRaw, markRaw } from "vue";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { applyBeat, applyLatestBeats, beatStatusEntry } from "../../src/beat-state";
import { BeatVersionThrottle } from "../../src/beat-version-throttle";
import { DependencyDownToasts } from "../../src/dependency-down-toasts";
import { dependencyObservations, recordDependencyBeat, type DependencyBeat } from "../../src/monitor-dependency";

/**
 * Create a reactive dashboard with a recording toast interface.
 * @returns Test dashboard
 */
function dashboard() {
    const monitors = {
        1: { id: 1, name: "Router", active: true },
        2: { id: 2, name: "Gateway", active: true, dependencyMonitorId: 1 },
        3: { id: 3, name: "Website", active: true, dependencyMonitorId: 2 },
        4: { id: 4, name: "Unrelated", active: true },
    };
    const beats = reactive<Record<number, DependencyBeat>>({});
    const shown: number[] = [];
    const dismissed: number[] = [];
    const closes = new Map<number, () => void>();
    let nextId = 0;
    const toasts = new DependencyDownToasts({
        error(message, options) {
            assert.equal(options.timeout, false);
            const id = ++nextId;
            shown.push(Number(message));
            closes.set(id, options.onClose);
            return id;
        },
        dismiss(id) {
            dismissed.push(Number(id));
        },
    });
    /**
     * Apply a live check or history snapshot.
     * @param monitorId Monitor ID
     * @param status Check status
     * @param time UTC check timestamp
     * @param important Whether to generate a toast
     * @param live Whether this is a live event
     * @returns {void}
     */
    function heartbeat(monitorId: number, status: number, time = "2026-11-09 12:00:00", important = true, live = true) {
        const beat = { status, time };
        recordDependencyBeat(beats, monitorId, beat, live);
        const observations = dependencyObservations(monitors, beats);
        toasts.reconcile(observations);
        if (important && status === 0 && live) {
            toasts.show(monitorId, beat, toRaw(beats[monitorId]), observations, String(monitorId), false);
        }
    }
    return { heartbeat, shown, dismissed, closes, beats, monitors, toasts };
}

test("suppresses direct and transitive DOWN toasts including repeated important heartbeats", () => {
    const d = dashboard();
    d.heartbeat(1, 0);
    for (let i = 0; i < 5; i++) {
        d.heartbeat(2, 0);
        d.heartbeat(3, 0);
    }
    d.heartbeat(4, 0);
    assert.deepEqual(d.shown, [1, 4]);
    assert.deepEqual(d.dismissed, []);
    assert.equal(d.beats[3].status, 0);
});

test("late upstream failure dismisses every child DOWN toast and leaves unrelated toasts alone", () => {
    const d = dashboard();
    d.heartbeat(3, 0);
    d.heartbeat(3, 0);
    d.heartbeat(4, 0);
    d.heartbeat(1, 0, undefined, false);
    d.heartbeat(1, 0, undefined, false);
    assert.deepEqual(d.shown, [3, 3, 4]);
    assert.deepEqual(d.dismissed, [1, 2]);
});

test("parent recovery does not replay suppressed events; subsequent child failure can toast", () => {
    const d = dashboard();
    d.heartbeat(1, 0);
    d.heartbeat(3, 0);
    d.heartbeat(1, 1, "2026-11-09 12:01:00");
    assert.deepEqual(d.shown, [1]);
    d.heartbeat(3, 1, "2026-11-09 12:01:00");
    d.heartbeat(3, 0, "2026-11-09 12:02:00");
    assert.deepEqual(d.shown, [1, 3]);
    assert.deepEqual(d.dismissed, []);
});

test("intermediate recovery still suppresses against the failed root", () => {
    const d = dashboard();
    d.heartbeat(1, 0);
    d.heartbeat(2, 0);
    d.heartbeat(2, 1, "2026-11-09 12:01:00");
    d.heartbeat(3, 0);
    assert.deepEqual(d.shown, [1]);
});

test("stale child DOWN events cannot toast after recovery; stale parent snapshots cannot suppress", () => {
    const d = dashboard();
    d.heartbeat(1, 1, "2026-11-09 12:02:00");
    d.heartbeat(1, 0, "2026-11-09 12:01:00", false, false);
    d.heartbeat(3, 0);
    d.heartbeat(3, 1, "2026-11-09 12:02:00");
    d.heartbeat(3, 0, "2026-11-09 12:01:00");
    assert.deepEqual(d.shown, [3]);
    assert.deepEqual(d.dismissed, []);
});

test("history arriving child-first or parent-first dismisses only confirmed suppressed toasts", () => {
    for (const order of [
        [1, 2],
        [2, 1],
    ]) {
        const d = dashboard();
        d.heartbeat(3, 0);
        for (const id of order) {
            d.heartbeat(id, 0, undefined, false, false);
        }
        assert.deepEqual(d.shown, [3]);
        assert.deepEqual(d.dismissed, [1]);
    }
});

test("closed toasts are forgotten and delayed close callbacks cannot forget a newer toast", () => {
    const d = dashboard();
    d.heartbeat(3, 0);
    d.closes.get(1)!();
    d.heartbeat(1, 0);
    assert.deepEqual(d.dismissed, []);
    d.heartbeat(1, 1, "2026-11-09 12:01:00");
    d.heartbeat(3, 0, "2026-11-09 12:02:00");
    d.heartbeat(1, 0, "2026-11-09 12:02:00");
    d.heartbeat(1, 1, "2026-11-09 12:03:00");
    d.heartbeat(3, 0, "2026-11-09 12:03:00");
    d.closes.get(3)!();
    d.heartbeat(1, 0, "2026-11-09 12:04:00");
    assert.deepEqual(d.dismissed, [3, 5]);
});

test("configuration changes reconcile existing toasts using the existing suppression helper", () => {
    const d = dashboard();
    d.heartbeat(1, 0);
    d.heartbeat(4, 0);
    Object.assign(d.monitors[4], { dependencyMonitorId: 1 });
    d.toasts.reconcile(dependencyObservations(d.monitors, d.beats));
    assert.deepEqual(d.dismissed, [2]);
});

test("socket handlers preserve history, important events, UP and generic toasts while suppressing DOWN", () => {
    const handlers = new Map<string, (...args: any[]) => void>();
    const shown: string[] = [];
    const dismissed: number[] = [];
    const important: unknown[] = [];
    const toast = Object.assign((message: string) => shown.push(message), {
        error: (message: string) => shown.push(message),
        success: (message: string) => shown.push(message),
        dismiss: (id: number) => dismissed.push(id),
    });
    // Execute the actual mixin with only browser/transport boundaries replaced.
    const source = readFileSync(new URL("../../src/mixins/socket.js", import.meta.url), "utf8")
        .replace(/^import .*;$/gm, "")
        .replace("export default", "globalThis.mixin =")
        .replace(/^export /gm, "");
    const context: any = {
        dependencyObservations,
        recordDependencyBeat,
        DependencyDownToasts,
        markRaw,
        toRaw,
        applyBeat,
        applyLatestBeats,
        beatStatusEntry,
        BeatVersionThrottle,
        useToast: () => toast,
        Favico: class {},
        io: () => ({ on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) }),
        navigator: { onLine: true },
        location: { pathname: "/dashboard", protocol: "http:", port: "3001" },
        localStorage: {},
        mitt: () => ({ emit: (_event: string, beat: unknown) => important.push(beat) }),
        getToastErrorTimeout: () => false,
        getToastSuccessTimeout: () => 1234,
        DOWN: 0,
        UP: 1,
        PENDING: 2,
        MAINTENANCE: 3,
        setTimeout,
        clearTimeout,
    };
    runInNewContext(source, context);
    const state: any = { $t: (key: string) => key };
    Object.assign(state, context.mixin.data.call(state));
    for (const [name, method] of Object.entries(context.mixin.methods)) {
        state[name] = (method as (...args: any[]) => any).bind(state);
    }
    state.monitorList = dashboard().monitors;
    state.dependencyBeats = reactive({});
    state.initSocketIO();
    /**
     * Deliver a check through the registered Socket.IO handler.
     * @param monitorID Monitor ID
     * @param status Check status
     * @returns Delivered check
     */
    function heartbeat(monitorID: number, status: number) {
        const beat = { monitorID, status, important: true, msg: "check", time: "2026-11-09 12:00:00" };
        handlers.get("heartbeat")!(beat);
        return beat;
    }
    try {
        heartbeat(3, 0);
        heartbeat(4, 0);
        heartbeat(1, 0);
        const suppressed = heartbeat(3, 0);
        assert.equal(state.heartbeatList[3].at(-1), suppressed);
        assert.equal(state.statusList[3].color, "danger");
        assert.equal(state.dependencyObservations[3].blockerId, 1);
        assert.equal(important.at(-1), suppressed);
        heartbeat(3, 1);
        heartbeat(4, 2);
        assert.deepEqual(shown, [
            "[Website] [DOWN] check",
            "[Unrelated] [DOWN] check",
            "[Router] [DOWN] check",
            "[Website] [Up] check",
            "[Unrelated] check",
        ]);
        assert.deepEqual(dismissed, [1]);
        assert.equal(important.length, 6);
    } finally {
        state.heartbeatVersionThrottle.cancel();
    }
});
