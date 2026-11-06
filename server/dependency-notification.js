const { R } = require("redbean-node");
const { UP, DOWN, PENDING, MAINTENANCE } = require("../src/util");

const pending = new Map();

/**
 * Resolve the whole chain. Paused and maintenance ancestors do not block alerts,
 * but their own ancestors still can. Unknown/retrying ancestors defer a new
 * incident until a conclusive check; they are not reported as confirmed DOWN.
 * @param {object} monitor Monitor being checked
 * @returns {Promise<object>} Derived notification metadata
 */
async function dependencyMetadata(monitor) {
    let id = monitor.dependency_monitor_id;
    const visited = new Set([Number(monitor.id)]);
    let waitingForMonitorId = null;
    while (id) {
        if (visited.has(Number(id))) {
            return { suppressed: false, waitingForMonitorId: id, reason: "invalid-chain" };
        }
        visited.add(Number(id));
        const parent = await R.knex("monitor").where({ id }).first();
        if (!parent) {
            break;
        }
        if (parent.active) {
            const observed = await R.knex("monitor_notification_state").where({ monitor_id: id }).first();
            const heartbeat =
                observed || (await R.knex("heartbeat").where({ monitor_id: id }).orderBy("id", "desc").first());
            if (heartbeat?.status === DOWN) {
                return { suppressed: true, suppressedByMonitorId: id, reason: "ancestor-down" };
            }
            if (!heartbeat || heartbeat.status === PENDING || ![UP, DOWN, MAINTENANCE].includes(heartbeat.status)) {
                waitingForMonitorId ??= id;
            }
        }
        id = parent.dependency_monitor_id;
    }
    return { suppressed: false, waitingForMonitorId, reason: waitingForMonitorId ? "ancestor-unconfirmed" : null };
}

/**
 * Serialize each monitor's notification decisions without blocking other checks.
 * State is independent of heartbeat status/importance and survives restarts.
 * Legacy incidents are initialized as open when their preceding beat was DOWN.
 * @param {object} monitor Monitor being checked
 * @param {object} beat Current heartbeat
 * @param {object|null} previous Previous heartbeat
 * @param {boolean} requested Legacy transition/repeat notification decision
 * @param {Function} send Send the existing notification payload
 * @returns {Promise<object>} Suppression metadata for future UI consumers
 */
function processDependencyNotification(monitor, beat, previous, requested, send) {
    const key = Number(monitor.id);
    const action = (pending.get(key) || Promise.resolve()).then(async () => {
        const db = R.knex;
        let state = await db("monitor_notification_state").where({ monitor_id: monitor.id }).first();
        if (!state) {
            state = { monitor_id: monitor.id, incident_open: previous?.status === DOWN, deferred: false };
        }
        const priorObservedStatus = state.status;
        state.status = beat.status;
        // Publish the check before consulting ancestors or awaiting providers.
        // A slow notification must not hide a confirmed observation from children.
        await db("monitor_notification_state").insert(state).onConflict("monitor_id").merge();
        const metadata = await dependencyMetadata(monitor);
        let notify = requested;
        if (beat.status === DOWN) {
            const blocked = metadata.suppressed || metadata.waitingForMonitorId;
            notify =
                !blocked &&
                (state.deferred ||
                    (requested && (previous?.status === DOWN || priorObservedStatus !== DOWN || !state.incident_open)));
            if (notify) {
                state.deferred = true;
                await db("monitor_notification_state").insert(state).onConflict("monitor_id").merge();
                await send();
                beat.downCount = 0;
                state.incident_open = true;
                state.deferred = false;
            } else if (!state.incident_open) {
                state.deferred = true;
            }
        } else if (beat.status === UP) {
            // A suppressed incident must not produce an orphan recovery. An
            // already announced incident still recovers even if a parent fails.
            notify = requested && (state.incident_open || (!state.deferred && priorObservedStatus !== UP));
            if (notify) {
                await send();
            }
            state.incident_open = false;
            state.deferred = false;
        } else {
            notify = false;
        }
        await db("monitor_notification_state").insert(state).onConflict("monitor_id").merge();
        const currentMetadata =
            beat.status === DOWN ? metadata : { suppressed: false, waitingForMonitorId: null, reason: null };
        return { ...currentMetadata, incidentOpen: Boolean(state.incident_open), deferred: Boolean(state.deferred) };
    });
    const settled = action.catch(() => {});
    pending.set(key, settled);
    settled.then(() => {
        if (pending.get(key) === settled) {
            pending.delete(key);
        }
    });
    return action;
}

module.exports = { processDependencyNotification, dependencyMetadata };
