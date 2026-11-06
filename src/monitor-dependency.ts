import { DOWN } from "./util";

/** Minimal authenticated monitor configuration used by dependency UI. */
export interface DependencyMonitor {
    id: number;
    name: string;
    active?: boolean | number;
    dependencyMonitorId?: number | null;
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

export interface DependencyBeat {
    monitorID: number;
    status: number;
    dependencyNotification?: {
        suppressed?: boolean;
        reason?: string;
        suppressedByMonitorId?: number;
    };
}

/**
 * Invalidate a decision when its child or any ancestor receives another observation,
 * including a historical response that replaces the UI's latest heartbeat.
 * @param observations Cached live decisions
 * @param monitorId Monitor whose displayed observation is changing
 * @returns {void}
 */
export function invalidateDependencyObservation(
    observations: Record<number, SuppressionObservation>,
    monitorId: number
): void {
    for (const [id, observation] of Object.entries(observations)) {
        if (Number(id) === monitorId || observation.ancestors.includes(monitorId)) {
            delete observations[Number(id)];
        }
    }
}

interface StoredDependencyBeat {
    id?: number;
    status?: number;
}

/**
 * A history response may replace the UI's latest beat. Preserve confirmation only
 * when it is the same stored observation, never create confirmation from history.
 * @param observations Cached live decisions
 * @param monitorId Monitor receiving history
 * @param previous Previously displayed beat
 * @param next Beat the history handler will display
 * @returns {void}
 */
export function invalidateDependencyHistory(
    observations: Record<number, SuppressionObservation>,
    monitorId: number,
    previous: StoredDependencyBeat | undefined,
    next: StoredDependencyBeat
): void {
    if (previous?.id == null || previous.id !== next.id || previous.status !== next.status) {
        invalidateDependencyObservation(observations, monitorId);
    }
}

/**
 * Keep only live backend-confirmed suppression. Any ancestor observation invalidates
 * the old decision until the child checks again. History must never call this.
 * @param observations Live suppression observations (mutated in place)
 * @param monitors Current authenticated configuration
 * @param beat Live heartbeat event
 * @param latestBeats Latest known observations, to reject a delayed decision after recovery
 * @returns {void}
 */
export function recordDependencyObservation(
    observations: Record<number, SuppressionObservation>,
    monitors: Record<number, DependencyMonitor>,
    beat: DependencyBeat,
    latestBeats: Record<number, { status: number }> = {}
): void {
    invalidateDependencyObservation(observations, Number(beat.monitorID));
    const monitor = monitors[beat.monitorID];
    const metadata = beat.dependencyNotification;
    if (
        !monitor?.active ||
        beat.status !== DOWN ||
        metadata?.suppressed !== true ||
        metadata.reason !== "ancestor-down"
    ) {
        return;
    }
    const ancestors = dependencyChain(monitors, monitor.dependencyMonitorId, monitor.id);
    const blockerId = Number(metadata.suppressedByMonitorId);
    if (latestBeats[blockerId] && latestBeats[blockerId].status !== DOWN) {
        return;
    }
    if (ancestors?.includes(blockerId) && monitors[blockerId]?.active) {
        observations[beat.monitorID] = { blockerId, ancestors };
    }
}
