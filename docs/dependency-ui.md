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

The label is reconciled from the authenticated dependency graph and confirmed
heartbeat states: the child must be DOWN and an active ancestor must be DOWN.
The closest active DOWN ancestor blocks, matching the notification gate; paused
or maintenance ancestors do not block but their ancestors still can. Unknown or
retrying states alone never establish suppression. Repeated DOWN checks preserve
the label. Recovery, dependency edits, pause and deletion reconcile it immediately.
The label describes current blocking of failure alerts, not past delivery success.

Disconnection, browser offline events and logout clear the connection's confirmed
observations. Login heartbeat snapshots restore labels on reload/reconnect without
waiting for the child to check again. Lazy history can supply confirmation, but an
older stored heartbeat cannot replace a newer live observation. UTC heartbeat
timestamps order live events (normal checks emit before storage and have no ID);
same-time history cannot override a live decision. Child metadata
from a prior check cannot override a parent recovery.

No heartbeat status, history, uptime, dashboard health counter or notification
behavior is changed. Public status pages, public badges and historical event
status components retain their existing semantics and do not expose dependency
names or metadata. New text is in `src/lang/en.json`, using the project's English
fallback for locales that do not yet have translations.

Coverage includes graph validation and state reconciliation unit tests,
and browser tests for saving/clearing, self/cycle filtering, real push heartbeat
suppression, unchanged DOWN status, dashboard/list/details labels, reconnect,
keyboard explanations and mobile/dark presentation.
