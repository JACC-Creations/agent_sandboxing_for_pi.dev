import { CONFIG_DIR_NAME, defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	checkpointAgentWorkspaceP4,
	cleanupAgentWorkspace,
	handoffAgentWorkspaceP4,
	inspectAgentWorkspace,
	openAgentWorkspaceP4,
	unshelveAgentWorkspaceP4,
} from "../../src/api.mjs";
import { disposeAgentWorkspaceP4HandoffAfterApproval } from "../../src/internal-api.mjs";
import { revisionControlCompletions, runRevisionControlCommand } from "../../src/revision-control-command.mjs";

const StateSchema = Type.Object({
	stateDir: Type.String({ minLength: 1, description: "Initialized agent-workspace state directory" }),
}, { additionalProperties: false });

const MutationIdentityProperties = {
	stateDir: Type.String({ minLength: 1, description: "Initialized agent-workspace state directory" }),
	brokerUuid: Type.String({
		pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
		description: "Exact broker generation UUID returned by agent_workspace_status",
	}),
};

const TaskMutationIdentityProperties = {
	...MutationIdentityProperties,
	taskId: Type.String({
		pattern: "^\\d{14}-[0-9a-f]{12}$",
		description: "Retained task ID bound to the target workspace slot",
	}),
};

const OpenSchema = Type.Object({
	...TaskMutationIdentityProperties,
	action: Type.Union([Type.Literal("edit"), Type.Literal("add"), Type.Literal("delete")]),
	depotPaths: Type.Array(Type.String({ pattern: "^//.+", minLength: 3 }), {
		minItems: 1,
		uniqueItems: true,
		description: "Unique absolute depot paths",
	}),
}, { additionalProperties: false });

const UnshelveSchema = Type.Object({
	...TaskMutationIdentityProperties,
	sourceChange: Type.Integer({ minimum: 1, description: "Positive source shelf changelist number" }),
}, { additionalProperties: false });

const TaskMutationSchema = Type.Object(TaskMutationIdentityProperties, { additionalProperties: false });
const CleanupSchema = Type.Object(MutationIdentityProperties, { additionalProperties: false });

const ErrorSchema = Type.Object({
	code: Type.String(),
	message: Type.String(),
}, { additionalProperties: false });

const ResultSchema = Type.Object({
	ok: Type.Boolean(),
	operation: Type.String(),
	brokerUuid: Type.Optional(Type.String()),
	taskId: Type.Optional(Type.String()),
	result: Type.Optional(Type.Unknown()),
	error: Type.Optional(ErrorSchema),
}, { additionalProperties: false });

type MutationContext = Pick<ExtensionContext, "hasUI" | "ui">;

function resultContent(details: Record<string, unknown>, text: string, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		structuredContent: details,
		...(isError ? { isError: true } : {}),
	};
}

function errorResult(operation: string, error: unknown, brokerUuid?: string, taskId?: string) {
	const diagnostic = error instanceof Error ? error.message : String(error);
	const code = classifyError(diagnostic);
	const message = publicErrorMessage(code);
	const details = {
		ok: false,
		operation,
		...(brokerUuid ? { brokerUuid } : {}),
		...(taskId ? { taskId } : {}),
		error: { code, message },
	};
	return resultContent(details, `${operation} failed: ${message}`, true);
}

function classifyError(message: string) {
	const disposal = /^review disposal refused: ([a-z_]+)$/.exec(message);
	if (disposal) return `review_disposal_${disposal[1]}`;
	if (/generation changed|broker generation|broker UUID/i.test(message)) return "generation_mismatch";
	if (/binding refused|slot identity|not uniquely assigned/i.test(message)) return "binding_mismatch";
	if (/declined|approval|no interactive UI/i.test(message)) return "approval_required";
	if (/invalid|must be|required|unique|nonempty|positive integer/i.test(message)) return "invalid_input";
	return "broker_error";
}

function publicErrorMessage(code: string) {
	if (code.startsWith("review_disposal_")) return `Review disposal failed closed (${code.slice("review_disposal_".length)}).`;
	if (code === "generation_mismatch") return "Broker generation mismatch; inspect status again before retrying.";
	if (code === "binding_mismatch") return "Task ownership binding mismatch; the operation was refused.";
	if (code === "approval_required") return "Interactive user approval is required for this mutation.";
	if (code === "invalid_input") return "The typed operation input is invalid.";
	return "The broker operation failed; inspect trusted local broker diagnostics for details.";
}

async function approveMutation(
	ctx: MutationContext,
	signal: AbortSignal | undefined,
	operation: string,
	brokerUuid: string,
	taskDetail: string,
	operationDetails: string[],
) {
	if (signal?.aborted) throw new Error("operation aborted before approval");
	if (!ctx.hasUI) throw new Error("mutation refused: no interactive UI is available for approval");
	const approved = await ctx.ui.confirm(
		`Approve ${operation}?`,
		[
			`Operation: ${operation}`,
			`Broker generation: ${brokerUuid}`,
			`Task: ${taskDetail}`,
			...operationDetails,
		].join("\n"),
	);
	if (!approved) throw new Error("mutation declined by user");
	if (signal?.aborted) throw new Error("operation aborted before broker mutation began");
}

const statusTool = defineTool({
	name: "agent_workspace_status",
	label: "Agent Workspace Status",
	description: "Inspect a retained agent-workspace broker and return its sanitized status plus immutable broker UUID. Call this before every active-generation mutation.",
	exposure: "direct",
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	parameters: StateSchema,
	outputSchema: ResultSchema,
	async execute(_toolCallId, params, signal) {
		if (signal?.aborted) return errorResult("status", new Error("status aborted before inspection"));
		try {
			const summary = await inspectAgentWorkspace(params.stateDir);
			const details = { ok: true, operation: "status", brokerUuid: summary.brokerUuid, result: summary };
			return resultContent(details, `Broker ${summary.brokerUuid}: ${summary.safety.state}; ${summary.capacity.available}/${summary.capacity.total} slots available.`);
		} catch (error) {
			return errorResult("status", error);
		}
	},
});

const openTool = defineTool({
	name: "agent_workspace_p4_open",
	label: "Agent Workspace P4 Open",
	description: "Open unique absolute depot paths for edit, add, or delete in a retained task after interactive approval.",
	exposure: "direct",
	executionMode: "sequential",
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	parameters: OpenSchema,
	outputSchema: ResultSchema,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		try {
			await approveMutation(ctx, signal, "P4 open", params.brokerUuid, params.taskId, [
				`Action: ${params.action}`,
				`Depot paths: ${params.depotPaths.join(", ")}`,
			]);
			const value = await openAgentWorkspaceP4({
				stateDir: params.stateDir,
				expectedBrokerUuid: params.brokerUuid,
				taskId: params.taskId,
				action: params.action,
				depotPaths: params.depotPaths,
			});
			const details = { ok: true, operation: "p4_open", brokerUuid: params.brokerUuid, taskId: params.taskId, result: value.result };
			return resultContent(details, `Opened ${value.result.depotPaths.length} depot path(s) for ${value.result.action} in task ${params.taskId}.`);
		} catch (error) {
			return errorResult("p4_open", error, params.brokerUuid, params.taskId);
		}
	},
});

const unshelveTool = defineTool({
	name: "agent_workspace_p4_unshelve",
	label: "Agent Workspace P4 Unshelve",
	description: "Unshelve one positive source changelist into a retained task after interactive approval.",
	exposure: "direct",
	executionMode: "sequential",
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	parameters: UnshelveSchema,
	outputSchema: ResultSchema,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		try {
			await approveMutation(ctx, signal, "P4 unshelve", params.brokerUuid, params.taskId, [
				`Source change: ${params.sourceChange}`,
			]);
			const value = await unshelveAgentWorkspaceP4({
				stateDir: params.stateDir,
				expectedBrokerUuid: params.brokerUuid,
				taskId: params.taskId,
				sourceChange: params.sourceChange,
			});
			const details = { ok: true, operation: "p4_unshelve", brokerUuid: params.brokerUuid, taskId: params.taskId, result: value.result };
			return resultContent(details, `Unshelved change ${params.sourceChange} into task ${params.taskId} (${value.result.depotPaths.length} path(s)).`);
		} catch (error) {
			return errorResult("p4_unshelve", error, params.brokerUuid, params.taskId);
		}
	},
});

const checkpointTool = defineTool({
	name: "agent_workspace_p4_checkpoint",
	label: "Agent Workspace P4 Checkpoint",
	description: "Create or replace the retained task's stable shelf checkpoint after interactive approval.",
	exposure: "direct",
	executionMode: "sequential",
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
	parameters: TaskMutationSchema,
	outputSchema: ResultSchema,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		try {
			await approveMutation(ctx, signal, "P4 checkpoint", params.brokerUuid, params.taskId, []);
			const value = await checkpointAgentWorkspaceP4({
				stateDir: params.stateDir,
				expectedBrokerUuid: params.brokerUuid,
				taskId: params.taskId,
			});
			const details = { ok: true, operation: "p4_checkpoint", brokerUuid: params.brokerUuid, taskId: params.taskId, result: value.result };
			return resultContent(details, `Checkpoint ${value.result.state} for task ${params.taskId}, change ${value.result.change}.`);
		} catch (error) {
			return errorResult("p4_checkpoint", error, params.brokerUuid, params.taskId);
		}
	},
});

const handoffTool = defineTool({
	name: "agent_workspace_p4_handoff",
	label: "Agent Workspace P4 Handoff",
	description: "Copy a task's stable shelf server-side into dedicated review resources and permanently seal the task after interactive approval.",
	exposure: "direct",
	executionMode: "sequential",
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
	parameters: TaskMutationSchema,
	outputSchema: ResultSchema,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		try {
			await approveMutation(ctx, signal, "P4 review handoff", params.brokerUuid, params.taskId, [
				"Effect: server-side shelf copy into preserved review resources",
				"Task sealing: permanent; rerun and further Perforce mutations will be refused",
			]);
			const value = await handoffAgentWorkspaceP4({
				stateDir: params.stateDir,
				expectedBrokerUuid: params.brokerUuid,
				taskId: params.taskId,
			});
			const details = { ok: true, operation: "p4_handoff", brokerUuid: params.brokerUuid, taskId: params.taskId, result: value.result };
			return resultContent(details, `Handed off task ${params.taskId} as review change ${value.result.change} for ${value.result.user}.`);
		} catch (error) {
			return errorResult("p4_handoff", error, params.brokerUuid, params.taskId);
		}
	},
});

const disposeHandoffTool = defineTool({
	name: "agent_workspace_p4_dispose_handoff",
	label: "Agent Workspace P4 Dispose Handoff",
	description: "Permanently delete a handed-off review shelf, change, and client after broker cleanup, using only its retained receipt identity.",
	exposure: "direct",
	executionMode: "sequential",
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
	parameters: TaskMutationSchema,
	outputSchema: ResultSchema,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		try {
			await approveMutation(ctx, signal, "P4 review handoff disposal", params.brokerUuid, params.taskId, [
				"Effect: permanent deletion in shelf → change → client order",
				"Legacy receipt: the current project P4 endpoint will be durably adopted before deletion",
				"Recovery: retries use the same retained cleanup receipt and transaction journal",
			]);
			const value = await disposeAgentWorkspaceP4HandoffAfterApproval({
				stateDir: params.stateDir,
				brokerUuid: params.brokerUuid,
				taskId: params.taskId,
			});
			const details = { ok: true, operation: "p4_dispose_handoff", brokerUuid: params.brokerUuid, taskId: params.taskId, result: value.result };
			return resultContent(details, `Disposed handed-off review resources for task ${params.taskId}${value.result.idempotent ? " (already complete)" : ""}.`);
		} catch (error) {
			return errorResult("p4_dispose_handoff", error, params.brokerUuid, params.taskId);
		}
	},
});

const cleanupTool = defineTool({
	name: "agent_workspace_cleanup",
	label: "Agent Workspace Cleanup",
	description: "Destructively clean one exact broker generation and reset its retained pool after interactive approval.",
	exposure: "direct",
	executionMode: "sequential",
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
	parameters: CleanupSchema,
	outputSchema: ResultSchema,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		try {
			await approveMutation(ctx, signal, "workspace cleanup", params.brokerUuid, "none (generation-wide cleanup)", [
				"Effect: destructive retained-pool generation reset",
			]);
			const value = await cleanupAgentWorkspace({ stateDir: params.stateDir, expectedBrokerUuid: params.brokerUuid });
			const details = { ok: true, operation: "cleanup", brokerUuid: params.brokerUuid, result: value };
			return resultContent(details, `Cleaned broker generation ${params.brokerUuid}${value.idempotent ? " (already complete)" : ""}.`);
		} catch (error) {
			return errorResult("cleanup", error, params.brokerUuid);
		}
	},
});

export default function agentWorkspaceExtension(pi: ExtensionAPI) {
	pi.registerCommand("revision-control", {
		description: "Show or set the project revision-control preference (p4 or lore)",
		getArgumentCompletions: revisionControlCompletions,
		handler: (args, ctx) => runRevisionControlCommand(args, ctx, CONFIG_DIR_NAME),
	});
	pi.registerTool(statusTool);
	pi.registerTool(openTool);
	pi.registerTool(unshelveTool);
	pi.registerTool(checkpointTool);
	pi.registerTool(handoffTool);
	pi.registerTool(disposeHandoffTool);
	pi.registerTool(cleanupTool);
}
