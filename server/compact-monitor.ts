export interface CompactPreloadData {
    paths: Map<number, string[]>;
    activeStatus: Map<number, boolean>;
    childrenIDs: Map<number, number[]>;
    tags: Map<number, unknown[]>;
}

export interface CompactMonitor {
    id: number;
    name: string;
    type: string;
    active: boolean | undefined;
    parent: number | null;
    dependencyMonitorId: number | null;
    childrenIDs: number[];
    tags: unknown[];
    path: string[];
    pathName: string;
    interval: number;
    weight: number | null;
}

/**
 * Fields the dashboard needs for one monitor. toJSON() builds ~60 fields per
 * monitor, which costs over a second for thousands of monitors at login.
 * @param monitor Monitor bean
 * @param monitor.id Monitor ID
 * @param monitor.name Display name
 * @param monitor.type Monitor type
 * @param monitor.parent Parent group ID
 * @param monitor.dependency_monitor_id Direct dependency ID
 * @param monitor.interval Check interval in seconds
 * @param monitor.weight Display order weight
 * @param preloadData Data prepared for the whole list
 * @returns Slim monitor payload
 */
export function toCompactMonitor(
    monitor: {
        id: number;
        name: string;
        type: string;
        parent?: number | null;
        dependency_monitor_id?: number | null;
        interval: number;
        weight?: number | null;
    },
    preloadData: CompactPreloadData
): CompactMonitor {
    const path = preloadData.paths.get(monitor.id) || [];

    return {
        id: monitor.id,
        name: monitor.name,
        type: monitor.type,
        active: preloadData.activeStatus.get(monitor.id),
        parent: monitor.parent ?? null,
        dependencyMonitorId: monitor.dependency_monitor_id ?? null,
        childrenIDs: preloadData.childrenIDs.get(monitor.id) || [],
        tags: preloadData.tags.get(monitor.id) || [],
        path,
        pathName: path.join(" / "),
        interval: monitor.interval,
        weight: monitor.weight ?? null,
    };
}
