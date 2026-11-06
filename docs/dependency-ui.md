# Monitor dependency UI (Step 4)

The authenticated add/edit monitor form has one **Monitor Dependency** selector.
**None** sends `dependencyMonitorId: null`. Existing selections are read from
`getMonitor`; option values remain numeric IDs. The compact monitor list supplies
the graph used to exclude self, descendants, existing cycles and missing chains.
Paused monitors remain selectable, matching backend semantics. Validation on save
remains authoritative for permissions, concurrent changes and cycle prevention.
If a saved selection cannot be found in the current options, a disabled current
selection explains the situation without silently clearing the saved value.

A shared suppression label appears in the monitor list and monitor details, and
the dashboard includes a current suppression summary. The label has an accessible
explanation and a tooltip available on hover or keyboard focus (Escape dismisses
it). It uses the existing warning palette, wraps on small screens and names the
failed ancestor, including transitive dependencies.

Only live `heartbeat` events with backend `dependencyNotification.suppressed ===
true`, `reason: ancestor-down`, and a matching active ancestor can establish a
label for a DOWN child. An already-known non-DOWN blocker rejects a delayed
suppression decision. DOWN alone, unknown/retrying dependencies and historical
heartbeat responses never establish suppression. A subsequent child or ancestor
heartbeat (including a history response replacing the displayed latest beat with a different observation)
invalidates the old observation; a fresh backend child decision can
establish it again. Configuration changes, deletion, logout and disconnection
clear cached observations immediately. Browser offline events also clear them,
without waiting for the Socket.IO heartbeat timeout. Consequently, after loading/reconnecting,
or after an ancestor update, an indicator may be absent until the next child
heartbeat. Absence means no current confirmation, not a guarantee of delivery.
This deliberately conservative policy avoids presenting stale suppression as fact.

No heartbeat status, history, uptime, dashboard health counter or notification
behavior is changed. Public status pages, public badges and historical event
status components retain their existing semantics and do not expose dependency
names or metadata. New text is in `src/lang/en.json`, using the project's English
fallback for locales that do not yet have translations.

Coverage includes graph validation and live-observation invalidation unit tests,
and browser tests for saving/clearing, self/cycle filtering, real push heartbeat
suppression, unchanged DOWN status, dashboard/list/details labels, reconnect,
keyboard explanations and mobile/dark presentation.
