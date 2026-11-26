# Agent Workspace

`agent-workspace` manages retained Windows ProjFS workspaces for parallel build agents. Each slot projects one sealed lower tree into an isolated writable root, keeps its provider alive across task attempts, and persists task, capacity, authentication, and cleanup state.

Production supports Windows ProjFS only. The `test` adapter and script providers/watchers exist solely for deterministic automated tests and require explicit selection; they are never a production fallback.

## Requirements

- Windows with the Projected File System optional feature enabled.
- Node.js 20 or newer.
- A supported win32-x64 installation. The package bundles `projfs-provider.exe`, `launch-supervisor.exe`, `lower-freeze-guard.exe`, and `generation-supervisor.exe`; no native source build is required.
- A read-only lower workspace and separate retained-root parent. The lower, roots, and state directory must not overlap.

## Optional native source build

The package is ready to use with the native binaries under `native/projfs-provider/bin/win32-x64/`. Their SHA-256 hashes are recorded in `native/projfs-provider/bin/win32-x64/SHA256SUMS` and validated by `npm run test:package`.

To rebuild the binaries from source instead:

```powershell
cmake -S native/projfs-provider -B native/projfs-provider/build -A x64
cmake --build native/projfs-provider/build --config Release --parallel 8
```

The native targets build with `/W4 /WX` against Windows SDK 10.0.26100. Rebuilt outputs are not used by the installed package until the four reviewed executables and `SHA256SUMS` in `native/projfs-provider/bin/win32-x64/` are deliberately replaced.

## Pi package installation

Install a reviewed local checkout directly, or install a pinned git ref:

```powershell
pi install C:\path\to\agent-workspace
pi install git:https://github.com/JACC-Creations/agent_sandboxing_for_pi.dev.git@v0.1.5
```

The package manifest loads the typed extension and the `agent-workspace` skill together and installs the four win32-x64 native executables. `npm run test:package` verifies the exact executable allowlist, AMD64 PE identity, and every hash in `native/projfs-provider/bin/win32-x64/SHA256SUMS`.

Use `/revision-control` in Pi to report the project preference and active default broker generation, or `/revision-control p4|lore` to write `.pi/agent-workspace.json` in the project. The selected backend is immutable within a broker generation: changing the preference requires cleanup and reinitialization. Lore is selectable as a preference but generation initialization currently fails closed because its backend is not implemented.

### Release rollback and troubleshooting

Rollback is a destructive generation replacement, not an automatic workspace restoration or Perforce rebase:

1. Record the active `stateDir` and exact `brokerUuid` from `agent_workspace_status`, then run `agent_workspace_cleanup` with that exact generation. For the CLI, run `agent-workspace cleanup --state-dir STATE_DIR --broker-uuid BROKER_UUID`.
2. If cleanup fails, preserve the state directory, adjacent cleanup journal, roots, and owned resources. Correct the reported cause and retry the same cleanup; do not manually delete them.
3. Remove the installed package with `pi remove <source>`, using the same source identifier used for the installation.
4. Install the pinned prior package/ref, which restores its bundled native binaries and `native/projfs-provider/bin/win32-x64/SHA256SUMS`; do not mix executables from different releases.
5. Initialize a new generation. The CLI selects that release's bundled provider by default. A quarantined generation cannot be resumed or reused; it also requires successful cleanup followed by a new generation.

Initialization resolves the effective `P4PORT`—and optional `P4CHARSET`, `P4TICKETS`, and `P4TRUST`—from explicit inputs or bounded `p4 set -q` queries before creating generation-owned state or roots. Tagged `p4 info` `serverAddress` is server identity material only and is never persisted as the client endpoint. The broker constructs a controlled Perforce profile, verifies the live user and stable server fingerprint through it, and fails before resource creation when the effective endpoint is missing, malformed, or unusable.

A committed handoff is the exception to package-owned cleanup: its dedicated review client, pending change, and shelf intentionally survive cleanup and package removal. When review retention is no longer required, the only supported owner-directed disposal path is `agent_workspace_p4_dispose_handoff` after successful cleanup, using the retained `stateDir`, `brokerUuid`, and `taskId`. Do not use direct P4 deletion or supply endpoint, executable, client, change, or nonce identifiers. New cleanup receipts privately bind disposal to the generation's resolved P4 executable, effective port, exact user, optional charset/ticket/trust paths, and an opaque fingerprint of stable tagged `p4 info` server identity. Disposal reconnects only with that profile and verifies the server fingerprint and user before journal creation or mutation. Retrying an interrupted handoff or disposal must use the same retained identity so its durable transaction can resume.

| Symptom | Action |
|---|---|
| Cleanup reports an owned process, root, or Perforce failure | Leave state and resources intact, resolve the reported cause, and retry cleanup for the exact generation. The typed cleanup path may recover a legacy unusable endpoint only after workers stop: it requires the stored user and server fingerprint, performs an exact read-only ownership preflight through a controlled profile, and durably binds that profile in the generation cleanup journal before any P4 mutation. Retries use only that binding. Public API/CLI cleanup never initiates ambient endpoint recovery. Never manually delete the roots or package-owned resources. |
| Generation is quarantined | Cleanup the quarantined generation, then initialize a new one. Retained roots are not reusable. |
| Handoff was interrupted | Retry the same handoff for the same task so its durable intent can resume. Do not alter its intent or destination. |
| Review resources remain after cleanup or `pi remove` | This is intentional for a committed handoff. The owner may call `agent_workspace_p4_dispose_handoff` with the retained `stateDir`, `brokerUuid`, and `taskId`; never delete by direct P4 endpoint/client/change input. A version-1 receipt requires one explicitly approved legacy adoption through the typed Pi tool: the current project P4 endpoint is checked read-only against the exact retained ownership markers, converted to a controlled profile, then reconnected and re-inspected through that profile before the binding is persisted or deletion begins. The public package API refuses an unbound legacy receipt; version-2 bound receipts remain supported. |
| Lore initialization fails | Lore currently fails closed because its backend is not implemented; select `p4` only after cleaning up and creating a new generation. |
| Task failed or diagnostics are needed | Use `agent-workspace status --state-dir STATE_DIR` and `agent-workspace logs --state-dir STATE_DIR TASK_ID`. Local task state is under `STATE_DIR/tasks/`, logs are under `STATE_DIR/logs/`, and the successful cleanup receipt is `STATE_DIR.cleanup-receipt.json`. Inspect these locally and share only sanitized status or necessary error excerpts; do not expose `STATE_DIR/secrets/`, token files, credentials, or raw private configuration. |

### Typed tools

| Tool | Inputs | Effect |
|---|---|---|
| `agent_workspace_status` | `stateDir` | Returns a concise sanitized broker summary and immutable `brokerUuid`. |
| `agent_workspace_p4_open` | `stateDir`, `brokerUuid`, `taskId`, `action`, `depotPaths` | Opens unique absolute depot paths for `edit`, `add`, or `delete`. |
| `agent_workspace_p4_unshelve` | `stateDir`, `brokerUuid`, `taskId`, `sourceChange` | Unshelves one positive source changelist into the task's owned change. |
| `agent_workspace_p4_checkpoint` | `stateDir`, `brokerUuid`, `taskId` | Creates or replaces the task's stable shelf checkpoint. |
| `agent_workspace_p4_handoff` | `stateDir`, `brokerUuid`, `taskId` | Copies the stable shelf server-side into dedicated review resources and permanently seals the task. |
| `agent_workspace_p4_dispose_handoff` | `stateDir`, `brokerUuid`, `taskId` | After cleanup, permanently deletes the exact handed-off shelf, change, and client recorded by the retained receipt. |
| `agent_workspace_cleanup` | `stateDir`, `brokerUuid` | Destructively cleans the exact retained broker generation. |

Call `agent_workspace_status` immediately before an active-generation mutation and pass its exact `brokerUuid`; stale generations fail before Perforce mutation. Preserve that `stateDir`, `brokerUuid`, and `taskId` before cleanup if a handed-off review may later need disposal. `agent_workspace_p4_open`, `agent_workspace_p4_unshelve`, `agent_workspace_p4_checkpoint`, and `agent_workspace_p4_handoff` are routine operations confined to package-owned task resources, so they do not prompt and work without an interactive UI. They still require exact generation and task identity, preserve all broker validation, and fail before mutation if the call is already aborted.

`agent_workspace_cleanup` runs without a prompt when the lifecycle-locked generation snapshot contains no human slots, allowing autonomous destruction of package-owned agent roots and resources. If any human slot exists, the typed extension requires interactive approval and passes human-slot authorization only after confirmation; `cleanupBroker` re-enforces that authorization under the lifecycle lock to close the inspection/approval race. `agent_workspace_p4_dispose_handoff` always requires interactive approval because it permanently destroys preserved review resources. Its confirmation explicitly states shelf → change → client deletion and that a legacy receipt will durably adopt the current project P4 endpoint. Approval-required operations fail closed without an interactive UI or when confirmation is declined. Direct public API disposal accepts only already-bound receipts and the same three retained identity fields; legacy adoption is package-internal to the approved typed tool.

The typed tools call the broker APIs directly and never expose executable paths, clients, resource nonces, raw Perforce flags, credentials, environment, raw configuration, or protected-base authorization. They therefore do not require an exemption for direct `p4` execution; do not retain qualification-specific direct-P4 exemptions alongside the typed integration.

## Usage

Run `node bin/agent-workspace.mjs`, or install the `agent-workspace` bin with `npm link`.

```powershell
agent-workspace init `
  --state-dir C:\AgentWorkspace\state `
  --revision-control p4 `
  --workspace C:\FrozenLower `
  --root-parent C:\AgentWorkspace\roots `
  --max-agent-workspaces 10 `
  --max-concurrent-heavy-builds 5 `
  --build-capacity-policy wait `
  --build-wait-timeout-ms 3600000 `
  --p4-exe C:\Tools\p4.exe `
  --p4-base-client FrozenLowerClient `
  --p4-port ssl:perforce.example.net:1666 `
  --p4-user build-user `
  --p4-tickets C:\Perforce\tickets.txt `
  --p4-trust C:\Perforce\trust.txt

agent-workspace start --state-dir C:\AgentWorkspace\state `
  --resource-class heavy-build --timeout-ms 7200000 -- PROGRAM ARG...
agent-workspace run --state-dir C:\AgentWorkspace\state TASK_ID `
  --resource-class light --timeout-ms 7200000 -- PROGRAM ARG...

agent-workspace status --state-dir C:\AgentWorkspace\state
agent-workspace logs --state-dir C:\AgentWorkspace\state TASK_ID
agent-workspace cancel --state-dir C:\AgentWorkspace\state TASK_ID
agent-workspace p4 status --state-dir C:\AgentWorkspace\state TASK_ID
agent-workspace p4 open --state-dir C:\AgentWorkspace\state TASK_ID --action edit -- //depot/path.cpp
agent-workspace p4 unshelve --state-dir C:\AgentWorkspace\state TASK_ID --source-change 12345
agent-workspace p4 checkpoint --state-dir C:\AgentWorkspace\state TASK_ID
agent-workspace p4 handoff --state-dir C:\AgentWorkspace\state TASK_ID
agent-workspace human-slot create --state-dir C:\AgentWorkspace\state --name investigation
agent-workspace cleanup --state-dir C:\AgentWorkspace\state --broker-uuid <UUID from status>
```

`AGENT_WORKSPACE_STATE_DIR` can replace `--state-dir`; the default is `.agent-workspace` in the current directory. Production `init` defaults `--provider-exe` to the bundled `native/projfs-provider/bin/win32-x64/projfs-provider.exe`; the other three executables are resolved beside it. On Windows, durable JSON publication uses the bundled `launch-supervisor.exe` for a same-directory, pre-flushed `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)` replacement and fails closed if the helper is missing or fails. Pass `--provider-exe FILE` only to deliberately override that bundle. Explicit `--test-mode` still requires an explicit script fixture and never falls back to production binaries. `init --revision-control p4|lore` overrides the project preference; otherwise init reads `<cwd>/.pi/agent-workspace.json`, then defaults to `p4`. The selected mode is snapshotted into immutable generation configuration. Every production `start` and `run` requires `--resource-class light|heavy-build`. Heavy builds use a durable FIFO queue with a bounded wait or reject policy.

Slots remain assigned after completion, failure, timeout, or cancellation. `run` reuses the retained task ID, root, provider, Perforce client, and stable changelist. Human slots consume the same capacity and remain visible in status.

A handoff requires a terminal task with a nonempty stable shelf. It records durable intent first, then uses `p4 reshelve` to copy the shelf into a deterministic dedicated review client and pending change owned by the configured `p4.user`. Edge servers use promoted reshelve; standard and commit servers do not. The operation never unshelves or changes the base/task client Root, have state, or open state. Verification compares exact indexed `describe -S` records (path, action, revision, type, and move fields) plus the exact `fstat -e CHANGE -Rs -Ol` shelf path set and content metadata. The verifier accepts complete direct or `shelvedDigest`/`shelvedFileSize`/`shelvedType` families. If the server returns an exact shelf record but wholly omits digest and size, it falls back to binary-safe `p4 print` and canonicalizes the exact shelf bytes as SHA-256 plus byte size; partial, mixed, and head-only metadata still fail closed. Fallback reads are capped at 256 MiB per shelved file. Once intent exists, the task is permanently sealed: rerun, open, unshelve, and checkpoint are refused, while an exact retry resumes the same transaction.

Cleanup recovers any incomplete handoff before Perforce deletion. A verified committed handoff preserves its destination review client, pending change, and shelf even after the projected metadata Root is removed; source task resources remain package-owned and are deleted normally. Reviewers should unshelve the preserved destination change into their own client. Cross-user handoff is not supported and no handoff API accepts user, client, nonce, command, or flag overrides.

The P4 backend is optional and available only with ProjFS. Initialization verifies that the base client's Root exactly matches the frozen lower, records its opened paths as a protected baseline, and provisions one package-owned client per slot without copying bytes or eagerly populating have metadata. Production P4 commands have a bounded 60-second default timeout; focused tests may provide an explicit override. Worker commands receive only sanitized non-secret connection settings. Depot paths are required by `p4 open`; automatic checkpoints reject protected baseline paths and replace the task's stable shelf after each launched attempt. The human-operated CLI can explicitly authorize exact protected paths with `--allow-protected-base`; this capability is intentionally absent from the typed Pi tools and must not be requested or emulated by agents.

## Safety and lifecycle

Initialization exclusively creates each projected root and records broker UUID, root nonce, and process ownership. Native launch supervision creates process jobs before child execution, publishes ownership durably, and only then resumes the child. Cancellation, recovery, quarantine, and cleanup act on matching ownership and process identities rather than image names.

The lower watcher registers one recursive asynchronous directory notification before reporting readiness. Every top-level lower directory whose name starts with `.` is non-authoritative: providers do not project it, and the guard ignores mutations to that directory and its descendants. This directory-only policy does not hide top-level dotfiles such as `.editorconfig`, `.loreignore`, `.p4ignore.txt`, and `.vsconfig`, and it does not apply to nested dot-directories such as `nested/.vs` or `nested/.ugs`. Agents may create private projected versions of hidden root directories, and those private directories persist across provider restart without lower mutation. The policy is not configurable. Clean up generations created before the current cache policy before upgrading so previously materialized placeholders cannot be reused. The guard snapshots existing root dot-directories at startup and uses directory attributes carried by native notifications to recognize new ones without treating dotfiles as directories. It parses every event in each completed batch, tracks rename pairs across notification-buffer boundaries, rearms an alternate buffer before accepting an ignored-only batch, and settles pending directory I/O on every exit. A rename from ignored to protected space, any protected lower mutation, watcher death, stale heartbeat, notification overflow, malformed event, root identity/path change, reboot, or monitoring gap quarantines the generation. Quarantine blocks new work, cancels queued/running tasks, and stops all providers, including idle human slots. Retained roots are not reused after continuity is lost; create a new generation.

The generation supervisor runs independently from CLI and task monitors. It continuously checks watcher ownership, heartbeat, and quarantine state, then enforces generation-wide cancellation and provider shutdown.

`cleanup` is aggressive and generation-scoped. It blocks new work, removes capacity state, terminates identity-matched owned jobs, stops the generation supervisor, watcher, and providers, verifies shutdown, and removes package-owned roots and private state. The lower is excluded. A surviving or unverifiable owned process makes cleanup fail closed.

The threat model is cooperative processes under one Windows user. Ownership metadata prevents accidental cross-generation cleanup but is not tamper-resistant against a hostile same-user process.

## Authentication

```powershell
agent-workspace auth prepare --state-dir C:\AgentWorkspace\state `
  --horde-url https://horde.example.net `
  --oidc-token-exe C:\Workspace\Engine\Binaries\DotNET\OidcToken\win-x64\OidcToken.exe `
  --min-valid-ms 300000
agent-workspace auth status --state-dir C:\AgentWorkspace\state
```

Prepared Horde tokens are stored in restricted generation files and injected only into task children. Token bytes are excluded from task commands, process arguments, status, logs, and retained history. Authenticated tasks require a timeout whose lifetime fits within the selected token generation. `--no-auth` also strips inherited Horde variables.

## Watcher benchmark evidence

A disposable-lower benchmark measured the native watcher over a 3-second idle interval:

- idle CPU: `0 ms`
- working set: `5,038,080 bytes`
- event-to-quarantine latency: approximately `41.468 ms`

These are observations from one disposable test run, not latency or resource guarantees. Run the benchmark on the target machine with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File native/projfs-provider/watcher-benchmark.ps1 `
  -GuardPath native/projfs-provider/bin/win32-x64/lower-freeze-guard.exe -IdleSeconds 3
```

## Limitations

- Watcher continuity is process-bound; it does not recover events across downtime, reboot, or overflow.
- Quarantine recovery does not verify restoration of a prior lower or reuse mixed-generation roots.
- Perforce rebase remains deferred. Handoff passed a disposable real edge-server qualification, including promoted reshelve, independent unshelve, retry recovery, cleanup preservation, and exact lower-baseline verification. Direct standard/commit-server topology remains covered by deterministic tests rather than a separate real deployment.
- The provider does not project reparse points, extended attributes, alternate streams, or case-sensitive directory semantics.
- The same-user ownership model is operational safety, not a security boundary.

## Tests

```powershell
npm test
npm run test:revision-control
npm run test:perforce
npm run test:handoff
npm run test:disposal
npm run test:pi
npm run test:all
powershell -NoProfile -ExecutionPolicy Bypass -File native/projfs-provider/lower-freeze-test.ps1 `
  -GuardPath native/projfs-provider/bin/win32-x64/lower-freeze-guard.exe
```

The native watcher test and benchmark use disposable `%TEMP%` trees. Test fixture processes are tracked by ownership and creation identity and are terminated and verified during teardown.
