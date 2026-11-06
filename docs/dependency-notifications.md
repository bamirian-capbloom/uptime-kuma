# Dependency notification suppression (Step 3)

A monitor has one direct dependency (`dependency_monitor_id`); the full ancestor
chain is evaluated. Checks, retries, heartbeat UP/DOWN/PENDING/MAINTENANCE values,
heartbeat importance, uptime calculations, status pages and metrics keep their
existing meaning. Only ordinary status notifications and their repeats are gated. Both scheduled
checks and incoming push API heartbeats use the same notification state machine.
Certificate and domain expiry notifications are unchanged.

## Decisions

- Any active ancestor whose latest observed status is DOWN blocks downstream DOWN
  notifications, even when an intermediate ancestor is unknown or paused.
- An active unknown or PENDING ancestor defers a new DOWN alert until its state is
  conclusive. This can defer indefinitely if that ancestor never checks. Unknown
  is not presented as confirmed-down suppression.
- A paused ancestor's own stored DOWN is ignored. Traversal continues through it.
  MAINTENANCE is not treated as DOWN; its ancestors are still evaluated.
- An incident first observed during suppression stays silent on recovery. If its
  dependencies become available while it is still down, the next child check
  sends one DOWN, even with repeat notifications disabled. Later repeats use the
  existing resend interval.
- An incident already announced before a parent outage retains its recovery
  notification. Its repeats are blocked during the outage. Existing maintenance
  transition notification rules still apply.
- Removing a dependency releases deferred notifications on the next child check.

`monitor_notification_state` separately persists the latest observed check state,
whether an incident was announced, and whether delivery is deferred. Existing
incidents are conservatively treated as previously announced if the prior
heartbeat was DOWN when this state is first created. State is removed when the
monitor is deleted. This migration does not change heartbeat history or monitor
configuration columns.

Live dashboard heartbeat events add `dependencyNotification` with `suppressed`,
`reason`, `suppressedByMonitorId` (when blocked by DOWN), `waitingForMonitorId`
(when waiting), `incidentOpen` and `deferred`. This is derived metadata for a later
UI stage, not a replacement for heartbeat status. Historical heartbeat records
and legacy monitor configuration APIs keep their existing shape. The exported
`dependencyMetadata()` resolver can recompute dependency metadata after restart.

## Ordering and delivery limits

Notification decisions are serialized per monitor in this server process.
New observations are persisted before consulting ancestors or sending notifications; descendants
can use them before the corresponding heartbeat history write completes.
Unknown and retrying parents defer child alerts regardless of check order.
Concurrent push requests carrying the same stale transition are deduplicated.
A parent last confirmed UP cannot predict a future failure: a child can alert
before that parent's next check detects DOWN. No fixed grace period is imposed.
Parent recovery releases the child on its next scheduled check, not immediately.

The incident records survive restarts; the latest persisted DOWN remains a
confirmed observation until a new parent check supersedes it. Serialization is
process-local, consistent with the existing single-server monitor scheduler.
Slow notification providers delay subsequent decisions for that monitor, without
blocking other monitors' checks or notification decisions.

Delivery retains the existing notification-provider behavior: provider failures
are logged by `Monitor.sendNotification`, which does not report per-provider
success. Incident state therefore tracks notification attempts, not guaranteed
receipt or individual recipient state. As with existing alerts, a process crash
between external delivery and the state write can duplicate an alert. Exactly-once
external delivery is not promised. No UI controls or status redesign is included.
