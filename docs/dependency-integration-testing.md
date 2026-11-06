# Step 5: monitor dependency integration testing

Tested November 6, 2026, against fork master `82a3d2108c2de6142f974af799df430176c787bc`, on branch `feature/dependency-integration-testing`. PRs #1, #2 and #3 were independently confirmed merged into the fork's master. No production instance or upstream repository was modified.

## Results

| Check | Concrete result |
| --- | --- |
| Full backend and frontend unit/integration suite | 644 passed, 1 skipped, 0 failed (570 + 74 passed in its two phases). Includes actual MQTT, MSSQL, MariaDB, Oracle, PostgreSQL, RabbitMQ, SFTP, migration and SNMP tests. |
| Full Chromium browser suite | Baseline: 64 passed, 0 failed (4.2 minutes). Final expanded suite after both fixes: 65 passed, 0 failed (4.3 minutes). |
| Dependency backend regression set, including new integration tests | 46 passed, 0 failed, 0 skipped. |
| Expanded dependency browser suite | 9 passed, including six setup checks and three dependency scenarios. |
| Lint | Exit 0; 84 existing JavaScript warnings, no errors. Stylelint reports deprecated rules. Explicit lint of the new TypeScript tests also passes. |
| Production build | Exit 0; Vite production bundle and compression complete. |
| Formatting / whitespace | New tests pass Prettier; `git diff --check` passes. |

Two responsive defects were found during visual review and fixed on the feature branch:

1. The monitor URL did not wrap, producing a 552px-wide document on a 390px Arabic/RTL viewport. `Details.vue` now allows URL wrapping. The regression asserts the whole document fits the viewport.
2. The shared tooltip used a physical `left` coordinate with a stylesheet transform that RTL processing reverses. Its centering transform is now an inline physical transform, keeping the dependency explanation on screen in RTL as well as LTR. The regression checks the entire tooltip wrapper after resetting horizontal scroll, and saves a stable screenshot.

No core dependency configuration or notification logic defect was confirmed. The layout changes and test evidence are submitted as a draft PR against the fork's master for review. No merge was performed.

## Reproduction

Environment: macOS arm64, Node 26.5.0, repository-installed dependencies, headless Chromium from the installed Playwright browser cache, Docker-backed test containers. Node was made available with:

```sh
export PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH
```

Commands, from the repository root:

```sh
npm run test-backend
HEADLESS_E2E_TESTS=1 SKIP_TESTCONTAINER=1 npm run test-e2e -- --max-failures=0
TEST_BACKEND=1 node --import=tsx --import=./test/setup.ts --test test/backend-test/test-dependency-*.ts test/backend-test/test-monitor-dependency*.ts test/frontend-test/test-monitor-dependency.ts
HEADLESS_E2E_TESTS=1 SKIP_TESTCONTAINER=1 npm run test-e2e -- monitor-dependency
npm run lint
npm run build
node_modules/.bin/eslint --no-ignore test/backend-test/test-dependency-delivery.ts test/backend-test/test-dependency-mariadb.ts test/e2e/specs/monitor-dependency.spec.js
node_modules/.bin/prettier --check test/backend-test/test-dependency-delivery.ts test/backend-test/test-dependency-mariadb.ts test/e2e/specs/monitor-dependency.spec.js
git diff --check
```

`SKIP_TESTCONTAINER=1` is used only for the browser runner; the backend container phase ran without it. Tests requiring local listeners and containers ran with networking enabled. Browser tests use only `data/playwright-test`; server integration tests create temporary SQLite directories, start subprocesses on reserved local ports, and remove those directories afterward. MariaDB tests use disposable containers.

Logs and screenshots are saved in `private/dependency-step5/` (ignored by Git). The full backend suite was run on the unmodified master implementation. The final 46-test dependency regression set separately covers the added backend tests. Both fixes affect CSS positioning only; backend code is unchanged. Lint, build, and the full expanded browser suite were rerun against the final changes.

## Scenario evidence

| Area | Exercise and observed result |
| --- | --- |
| Migration | Fresh SQLite and MariaDB/MySQL migrations pass in the full suite. Targeted SQLite/MariaDB tests migrate pre-existing monitors, preserve names, default dependencies to NULL, roll back/reapply, reject invalid foreign keys, clear references on deletion and cascade notification-state cleanup. |
| Socket.IO configuration | Real authenticated create/read/edit operations persist chains; omitted old-client edit fields preserve dependencies, explicit NULL clears them, and old add payloads default to NULL. Raw database field aliases cannot bypass validation. |
| Cycles / deletion | Self, indirect, existing and concurrent opposing cycles are rejected. Direct and recursive group deletion clear persisted/running dependencies; stale edits cannot resurrect them. |
| Parent DOWN, child DOWN | Captured webhook receives the parent's DOWN and no child's DOWN; child heartbeat remains DOWN. |
| Parent DOWN, child UP | Child remains UP. A wholly suppressed incident recovers silently; an already-announced incident sends its recovery even while an ancestor is DOWN. |
| Parent recovers, child still DOWN | The child's next check sends one deferred DOWN, including with repeats disabled; subsequent unchanged checks do not duplicate it. |
| A → B → C | Root failure suppresses both descendants. Root recovery alone does not release C while B remains DOWN. B recovery releases C on its next check. |
| Concurrent / slow checks | Concurrent duplicate child pushes produce one deferred DOWN. A deliberately held parent webhook does not hide its DOWN observation: the child check completes without delivering a failure. Unit tests also cover stale previous heartbeats and overlapping DOWN/UP notification decisions. |
| Retries / repeats | A controlled HTTP 503 endpoint yields PENDING then DOWN with one retry. Actual webhook delivery waits for DOWN. Suppressed HTTP incidents retain their real status and recover silently. Captured repeats resume after dependency recovery and stop while the ancestor is DOWN. |
| Paused / unknown / maintenance | Unknown and PENDING ancestors defer alerts without falsely reporting confirmed-down suppression. Paused ancestors ignore their own stale DOWN but still traverse their ancestors; MAINTENANCE is not DOWN. |
| Restart / durable incidents | Two complete server process restarts reopen the same SQLite database. Dependencies persist, announced DOWN is not duplicated, announced incidents recover, and silent deferred incidents remain silent until released. |
| UI | Real forms select/persist/clear dependencies and filter self/cycles. Actual DOWN remains visible beside suppression. Keyboard focus exposes explanation; Escape dismisses it. History, reconnect, parent changes and disconnect invalidate stale claims. Mobile 390×844 and dark mode render the badge within the viewport. |
| Locale / accessibility / input safety | Arabic `ar-SY` uses RTL with English fallback for untranslated feature strings. A long mixed-direction name containing literal image/event-handler markup remains text; no image or script is created. Badge and tooltip bounds, accessible explanation, keyboard access and screenshots are checked. This is targeted accessibility coverage, not an exhaustive WCAG audit. |
| Privacy / public dashboards | Real public page responses contain only the published child, without its dependency ID, private ancestor token or suppression metadata. Public heartbeat history retains true DOWN. Anonymous sockets cannot read configuration/history and receive no live private heartbeat while an authenticated socket does. |
| Multi-user model | This version explicitly disables user-management/signup APIs and shares all monitors among authenticated dashboard users. Existing access tests permit authenticated cross-owner/legacy monitors. Tenant isolation is not a supported feature and is not claimed by these results. |

## Qualifications and recommendation

The first default browser run stopped at an intermittent maintenance-form timeout after 18 passes; the complete rerun passed all 64 tests. Snapshot restoration also logs closed-connection, monitor cleanup and Prometheus errors in the broad browser suite, even when its assertions pass. These are baseline test-harness issues, not confirmed dependency defects; do not interpret green assertions as absence of all runtime log noise.

A late parallel regression attempt hit a temporary port collision during initial migration. The new capture harness now reserves outside the OS ephemeral client-port range; the final 46-test dependency run passed. An early attempt also encountered a Node native-fetch `setTypeOfService EINVAL`; the capture harness uses the application's Axios client with fresh HTTP connections across restarts. Failed attempts are not counted as passing evidence.

Suppression follows observed check order. If a parent is last known UP, a child can alert before a later parent check discovers DOWN. Recovery releases deferred failures on the next child check. Unknown ancestors can defer indefinitely. Provider state tracks attempts, not guaranteed recipient delivery; a crash between external delivery and persistence can duplicate an alert. These documented semantics are intentional and were not changed.

Recommendation: review the draft fixes before preparing an upstream contribution proposal, with these semantics clearly described. Obtain the maintainers' agreement on behavior and contribution requirements, and have a human review and manually exercise the changes before submitting upstream. Add native translations through the normal locale workflow. No upstream publication or merge is authorized or performed here.
