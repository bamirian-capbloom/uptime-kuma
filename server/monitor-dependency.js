const { R } = require("redbean-node");

let pendingChange = Promise.resolve();

/**
 * Serialize dependency saves and deletions in this server process. Validation
 * must run inside the lock so simultaneous edits cannot introduce a cycle.
 * @param {Function} action Change to perform
 * @returns {Promise<any>} Result of the change
 */
function withMonitorDependencyLock(action) {
    const result = pendingChange.then(action);
    pendingChange = result.catch(() => {});
    return result;
}

/**
 * Match the shared-access model: authenticated users can manage every monitor.
 * Callers must authenticate the session before supplying its user ID.
 * @param {object|null} monitor Monitor bean
 * @param {string} userID Authenticated user ID
 * @returns {void}
 * @throws {Error} If the monitor does not exist or is inaccessible
 */
function assertMonitorAccess(monitor, userID) {
    if (!userID || !monitor) {
        throw new Error("Monitor not found or access denied");
    }
}

/**
 * Validate a single dependency and every link in its chain.
 * @param {number|null} dependencyMonitorId Proposed dependency, or null to clear
 * @param {number|undefined} monitorID Monitor being saved (absent on creation)
 * @param {string} userID Authenticated user ID
 * @returns {Promise<number|null>} Validated dependency ID
 */
async function validateMonitorDependency(dependencyMonitorId, monitorID, userID) {
    if (dependencyMonitorId === null) {
        return null;
    }
    if (!Number.isSafeInteger(dependencyMonitorId) || dependencyMonitorId <= 0) {
        throw new Error("Invalid dependency monitor ID");
    }

    const visited = new Set(monitorID ? [Number(monitorID)] : []);
    let currentID = dependencyMonitorId;
    while (currentID !== null) {
        if (!Number.isSafeInteger(currentID) || currentID <= 0) {
            throw new Error("Invalid dependency monitor ID");
        }
        if (visited.has(currentID)) {
            throw new Error("Monitor dependency would create a circular dependency");
        }
        visited.add(currentID);
        const dependency = await R.findOne("monitor", " id = ? ", [currentID]);
        assertMonitorAccess(dependency, userID);
        currentID = dependency.dependency_monitor_id ?? null;
    }
    return dependencyMonitorId;
}

/**
 * Save a monitor atomically with respect to other dependency changes.
 * Omitted fields preserve the stored value on edit and default to null on add.
 * @param {object} bean Monitor bean to save
 * @param {number|null|undefined} dependencyMonitorId Client dependency field
 * @param {string} userID Authenticated user ID
 * @returns {Promise<number>} Saved monitor ID
 */
async function saveMonitorWithDependency(bean, dependencyMonitorId, userID) {
    return withMonitorDependencyLock(async () => {
        let current = null;
        if (bean.id) {
            current = await R.findOne("monitor", " id = ? ", [bean.id]);
            assertMonitorAccess(current, userID);
        }
        const proposed =
            dependencyMonitorId === undefined ? (current?.dependency_monitor_id ?? null) : dependencyMonitorId;
        bean.dependency_monitor_id = await validateMonitorDependency(proposed, bean.id, userID);
        return R.store(bean);
    });
}

module.exports = {
    assertMonitorAccess,
    validateMonitorDependency,
    saveMonitorWithDependency,
    withMonitorDependencyLock,
};
