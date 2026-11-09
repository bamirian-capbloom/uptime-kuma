import { DOWN } from "./util";

/** Minimal authenticated monitor configuration used by dependency UI. */
export interface DependencyMonitor {
    id: number;
    name: string;
    active?: boolean | number;
    dependencyMonitorId?: number | null;
    dependencyActive?: boolean;
}

/**
 * Walk a proposed chain, rejecting self references, existing cycles and missing monitors.
 * The server still validates ownership and the graph when saving.
 * @param monitors Authenticated monitor list
 * @param candidate Proposed dependency
 * @param monitorId Monitor being edited
 * @returns Ancestor IDs, or null for an invalid chain
 */
export function dependencyChain(
    monitors: Record<number, DependencyMonitor>,
    candidate: number | null | undefined,
    monitorId?: number
): number[] | null {
    const chain: number[] = [];
    const visited = new Set(monitorId ? [Number(monitorId)] : []);
    let id = candidate;
    while (id != null) {
        if (visited.has(Number(id)) || !monitors[id]) {
            return null;
        }
        visited.add(Number(id));
        chain.push(Number(id));
        id = monitors[id].dependencyMonitorId;
    }
    return chain;
}

export interface SuppressionObservation {
    blockerId: number;
    ancestors: number[];
}

/** Only observations received during the current connection are eligible. */
export interface DependencyBeat {
    id?: number;
    status: number;
    time?: string;
}

/**
 * Accept live checks and login/history snapshots without rolling back a newer check.
 * @param beats Observations from this connection (mutated in place)
 * @param monitorId Monitor receiving a check
 * @param beat Live or stored heartbeat
 * @param live Whether this is an ordered live socket event
 * @returns {void}
 */
export function recordDependencyBeat(
    beats: Record<number, DependencyBeat>,
    monitorId: number,
    beat: DependencyBeat,
    live = false
): void {
    const previous = beats[monitorId];
    if (previous) {
        if (previous.time && beat.time) {
            // Live checks are emitted before normal monitors are stored, so they
            // have no database ID. Both paths carry the UTC check timestamp.
            const previousTime = Date.parse(previous.time.replace(" ", "T").replace(/Z?$/, "Z"));
            const nextTime = Date.parse(beat.time.replace(" ", "T").replace(/Z?$/, "Z"));
            if (nextTime < previousTime || (!live && nextTime === previousTime)) {
                return;
            }
        } else if (!live && previous.id != null && (beat.id == null || beat.id < previous.id)) {
            return;
        }
    }
    beats[monitorId] = beat;
}

/**
 * Reconcile current suppression using the same active-ancestor DOWN rule as the
 * notification gate. History supplies confirmed states on reload; metadata on an
 * older child check cannot override a newer parent recovery. No delivery state is
 * inferred: this only describes whether failure alerts are currently blocked.
 * @param monitors Current authenticated configuration
 * @param beats Confirmed observations from this connection
 * @returns Current suppression labels
 */
export function dependencyObservations(
    monitors: Record<number, DependencyMonitor>,
    beats: Record<number, DependencyBeat>
): Record<number, SuppressionObservation> {
    const observations: Record<number, SuppressionObservation> = {};
    for (const monitor of Object.values(monitors)) {
        if (!monitor.active || beats[monitor.id]?.status !== DOWN) {
            continue;
        }
        const ancestors = dependencyChain(monitors, monitor.dependencyMonitorId, monitor.id);
        // The gate uses the ancestor's own active flag, even inside a paused group.
        const blockerId = ancestors?.find(
            (id) => (monitors[id].dependencyActive ?? monitors[id].active) && beats[id]?.status === DOWN
        );
        if (blockerId != null) {
            observations[monitor.id] = { blockerId, ancestors: ancestors! };
        }
    }
    return observations;
}
