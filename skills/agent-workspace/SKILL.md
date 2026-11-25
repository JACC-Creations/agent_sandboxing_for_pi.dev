---
name: agent-workspace
description: Safely inspect and mutate retained agent-workspace ProjFS task workspaces through generation-pinned typed tools. Use for broker status, task Perforce opens, unshelving, checkpointing, review handoff/disposal, or retained-pool cleanup.
---

# Agent workspace

Use the `agent_workspace_*` typed tools for retained-workspace status and mutations. Do not use bash, direct `p4`, package CLI commands, or hand-built command arrays as a substitute.

The Pi project preference is managed with `/revision-control [p4|lore]`. Backend selection is immutable for each broker generation; switching modes requires cleanup and reinitialization. Lore preference is accepted, but Lore generation initialization currently fails closed as not implemented.

1. Call `agent_workspace_status` with the resolved state directory before every active-generation mutation. Post-cleanup handoff disposal is the sole exception and uses the identity retained before cleanup.
2. Copy the returned `brokerUuid` exactly into the active-generation mutation call. Never guess, cache across cleanup/reinitialization, or continue after a generation-mismatch error; call status again. For post-cleanup disposal, use only the retained prior-generation identity.
3. Identify the exact retained `taskId` from status before a task-scoped P4 operation, and retain it before cleanup if later handoff disposal may be needed.
4. Treat `agent_workspace_p4_open`, `agent_workspace_p4_unshelve`, `agent_workspace_p4_checkpoint`, and `agent_workspace_p4_handoff` as routine operations confined to package-owned task resources. They do not require user approval or an interactive UI. Their typed inputs, generation check, task binding, and broker validation remain mandatory; an already-aborted call must fail before mutation.
5. Use `agent_workspace_p4_open` only with unique absolute depot paths and `edit`, `add`, or `delete`.
6. Use `agent_workspace_p4_unshelve` only with a positive source changelist. Use `agent_workspace_p4_checkpoint` for the task's stable shelf.
7. Use `agent_workspace_p4_handoff` only for a terminal task with a nonempty stable shelf. It copies the shelf server-side into preserved same-user review resources and permanently seals the task; retries must use the same task and generation.
8. Never request, set, or emulate a target user, target client, resource nonce, raw Perforce flags, or protected-base authorization. Cross-user handoff is unsupported and protected inherited paths must remain blocked.
9. Treat `agent_workspace_cleanup` as a destructive generation reset. Retained projected roots and human slots may contain user work, so explain the exact generation-wide effect and require explicit user approval. Cleanup removes the retained pool and invalidates the prior `brokerUuid`; call status on any subsequently initialized broker. Before cleanup, retain the exact `stateDir`, `brokerUuid`, and handed-off `taskId` if the owner may later request disposal. The typed tool must fail closed without an interactive UI or when approval is declined.
10. After successful cleanup, `agent_workspace_p4_dispose_handoff` is the only supported owner-directed disposal path. Because it destroys preserved review resources, pass only the retained `stateDir`, `brokerUuid`, and `taskId`; explain and require approval for permanent shelf → change → client deletion. If the retained cleanup receipt is legacy version 1, the confirmation must also state that the current project P4 endpoint will be durably adopted, identity-checked, and used for controlled retries. The typed tool must fail closed without an interactive UI or when approval is declined. Never use direct P4 deletion or request/provide an endpoint, executable, client, change, or nonce.

Do not expose or request broker nonces, credentials, environment variables, raw configuration, the private disposal reconnect profile/server fingerprint, internal clients, executable paths, or resource ownership tokens. Status and handoff results may show only the sanitized handoff state, review change, configured review user, file count, promotion state, and completion time.
