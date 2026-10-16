// User Approvals: what is waiting on YOU as an approver (manager, project
// approver, or customer) across timesheets, expenses, invoices, leave and
// purchase orders, plus approve/disapprove actions.
//
// The Platform REST surface is a matrix of {type} x {role}. Rather than one
// tool per cell (37 endpoints) these tools take type/role arguments and map
// them onto the right path, so the caller never has to know the URL layout.

import { z } from "zod";
import { type UnanetAuth, createUnanetClient } from "../auth.js";
import {
	compact,
	confirmSchema,
	errorResult,
	itemsFromResponse,
	keyName,
	pageInfo,
	pageSchema,
	pageSizeSchema,
	requireConfirm,
	toNumberOrNull,
	writeErrorResult,
} from "../utils/http.js";

export const APPROVAL_TYPES = [
	"time",
	"expense",
	"invoice",
	"leave-request",
	"purchase-order",
] as const;
export const APPROVAL_ROLES = ["manager", "project-approver", "customer"] as const;

type ApprovalType = (typeof APPROVAL_TYPES)[number];
type ApprovalRole = (typeof APPROVAL_ROLES)[number];

// Which {type, role} cells exist for listing (GET queue) and acting.
const LIST_CELLS: Record<ApprovalType, ApprovalRole[]> = {
	time: ["manager", "project-approver", "customer"],
	expense: ["manager", "project-approver", "customer"],
	invoice: ["manager", "project-approver", "customer"],
	"leave-request": ["manager"],
	"purchase-order": [],
};
const APPROVE_CELLS: Record<ApprovalType, ApprovalRole[]> = {
	time: ["manager", "project-approver", "customer"],
	expense: ["manager", "project-approver", "customer"],
	invoice: ["manager", "project-approver", "customer"],
	"leave-request": ["manager"],
	"purchase-order": ["project-approver", "customer"],
};
const DISAPPROVE_CELLS: Record<ApprovalType, ApprovalRole[]> = {
	time: ["manager", "project-approver", "customer"],
	expense: ["manager", "project-approver", "customer"],
	invoice: ["manager", "project-approver", "customer"],
	"leave-request": ["manager"],
	"purchase-order": [],
};

function queuePath(type: ApprovalType, role: ApprovalRole): string {
	return `/me/approvals/${type}/${role}`;
}

export function summarizeQueueItem(type: ApprovalType, item: any) {
	switch (type) {
		case "time":
			return {
				id: item?.timesheetKey ?? null,
				timesheetKey: item?.timesheetKey ?? null,
				person: item?.name ?? null,
				projectKey: item?.projectKey ?? null,
				project: item?.project ?? null,
				projectTitle: item?.projectTitle ?? null,
				beginDate: item?.beginDate ?? null,
				endDate: item?.endDate ?? null,
				hours: toNumberOrNull(item?.hours),
				status: item?.status ?? null,
				adjustmentStatus: item?.adjustmentStatus ?? null,
				statusDate: item?.statusDate ?? null,
				attachmentCount: toNumberOrNull(item?.attachmentCount),
				punchClock: item?.punchClockTimeSheet ?? null,
			};
		case "expense":
			return {
				id: item?.expenseReportKey ?? null,
				expenseReportKey: item?.expenseReportKey ?? null,
				person: item?.name ?? null,
				projectKey: item?.projectKey ?? null,
				project: item?.project ?? null,
				projectTitle: item?.projectTitle ?? null,
				purpose: item?.purpose ?? null,
				type: item?.type ?? null,
				amount: toNumberOrNull(item?.amount),
				currency:
					item?.expenseReportCurrency?.code ??
					item?.expenseReportCurrency?.name ??
					null,
				status: item?.status ?? null,
				attachmentCount: toNumberOrNull(item?.attachmentCount),
			};
		case "invoice":
			return {
				id: item?.invoiceKey ?? null,
				invoiceKey: item?.invoiceKey ?? null,
				invoiceNumber: item?.invoiceNumber ?? null,
				orgKey: item?.orgKey ?? null,
				orgCode: item?.orgCode ?? null,
				amount: toNumberOrNull(item?.amount),
				description: item?.description ?? null,
				projectKey: item?.projectKey ?? null,
				project: item?.project ?? null,
				projectCode: item?.projectCode ?? null,
				projectTitle: item?.projectTitle ?? null,
			};
		case "leave-request":
			return {
				id: item?.key ?? null,
				leaveRequestKey: item?.key ?? null,
				personKey: item?.personKey ?? null,
				person: item?.name ?? null,
				beginDate: item?.beginDate ?? null,
				endDate: item?.endDate ?? null,
				hours: toNumberOrNull(item?.hours),
				status: item?.status ?? null,
				statusDate: item?.statusDate ?? null,
				comments: item?.comments ?? null,
				includeNonWorkingDays: item?.includeNonWorkingDays ?? null,
			};
		default:
			return item;
	}
}

export const getMyPendingApprovalsTool = {
	name: "unanet_get_my_pending_approvals",
	description:
		"List items waiting for YOUR approval in Unanet: timesheets, expense reports/requests, invoices and leave requests, as manager, project approver and/or customer. Defaults to all types and roles you hold; queues you lack the role for are reported in endpointErrors rather than failing the call. Read-only.",
	inputSchema: z.object({
		type: z
			.enum([...APPROVAL_TYPES, "all"])
			.optional()
			.default("all")
			.describe("Approval type. Default all."),
		role: z
			.enum([...APPROVAL_ROLES, "all"])
			.optional()
			.default("all")
			.describe("Your approver role. Default all."),
		expenseRequests: z
			.boolean()
			.optional()
			.default(false)
			.describe("For expense queues: true lists expense REQUESTS (pre-approvals) instead of reports."),
		alternateKey: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Person key of the primary approver you are acting as alternate for."),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 200),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const types: ApprovalType[] =
				args.type === "all" ? [...APPROVAL_TYPES] : [args.type];
			const roles: ApprovalRole[] =
				args.role === "all" ? [...APPROVAL_ROLES] : [args.role];
			const cells = types.flatMap((type) =>
				LIST_CELLS[type]
					.filter((role) => roles.includes(role))
					.map((role) => ({ type, role })),
			);
			if (cells.length === 0) {
				return {
					success: false,
					error: `No approval queue exists for type=${args.type} role=${args.role}.`,
				};
			}
			const results = await Promise.all(
				cells.map(async ({ type, role }) => {
					try {
						const response = await client.get(queuePath(type, role), {
							params: compact({
								page: args.page,
								pageSize: args.pageSize,
								alternateKey: args.alternateKey,
								requests: type === "expense" ? args.expenseRequests : undefined,
							}),
						});
						const items = itemsFromResponse<any>(response.data).map((item) =>
							summarizeQueueItem(type, item),
						);
						return { type, role, items, paging: pageInfo(response.data), error: null };
					} catch (error: any) {
						return { type, role, items: [], paging: null, error: error.message };
					}
				}),
			);
			const queues = results.filter((result) => !result.error);
			const endpointErrors = results
				.filter((result) => result.error)
				.map((result) => ({ type: result.type, role: result.role, error: result.error }));
			const totalPending = queues.reduce((sum, queue) => sum + queue.items.length, 0);
			return {
				success: queues.length > 0,
				totalPending,
				queues,
				endpointErrors,
				hint:
					totalPending > 0
						? "Use unanet_approve / unanet_disapprove with the same type, role and id to act on an item (write tools, human review required)."
						: undefined,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getApprovalDetailTool = {
	name: "unanet_get_approval_detail",
	description:
		"Read one item from your manager approval queue by key (timesheet or expense report), including the manager approval preview message for timesheets. Read-only.",
	inputSchema: z.object({
		type: z.enum(["time", "expense"]),
		id: z.number().int().positive().describe("Timesheet key or expense report key."),
		expenseRequests: z.boolean().optional().default(false),
		alternateKey: z.number().int().positive().optional(),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const [detail, preview] = await Promise.all([
				client.get(`/me/approvals/${args.type}/manager/${args.id}`, {
					params: compact({
						alternateKey: args.alternateKey,
						requests: args.type === "expense" ? args.expenseRequests : undefined,
					}),
				}),
				args.type === "time"
					? client
							.get(`/me/approvals/time/manager/${args.id}/preview-message`)
							.then((response) => response.data?.message ?? null)
							.catch(() => null)
					: Promise.resolve(null),
			]);
			return {
				success: true,
				type: args.type,
				item: summarizeQueueItem(args.type, detail.data),
				previewMessage: preview,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getApprovalAlternatesTool = {
	name: "unanet_get_approval_alternates",
	description:
		"List the primary approvers who have pending approvals that you can act on as their alternate (manager and project-approver alternates). Read-only.",
	inputSchema: z.object({
		page: pageSchema,
		pageSize: pageSizeSchema(50, 200),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const load = async (role: "manager" | "project-approver") => {
				try {
					const response = await client.get(`/me/approvals/alternates/${role}`, {
						params: { page: args.page, pageSize: args.pageSize },
					});
					return {
						role,
						people: itemsFromResponse<any>(response.data).map((item) => ({
							person: keyName(item?.person),
							approvalTypes: item?.approvalTypes ?? [],
						})),
						error: null,
					};
				} catch (error: any) {
					return { role, people: [], error: error.message };
				}
			};
			const [manager, projectApprover] = await Promise.all([
				load("manager"),
				load("project-approver"),
			]);
			return {
				success: !manager.error || !projectApprover.error,
				manager,
				projectApprover,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

function resolveActionCell(
	action: "approve" | "disapprove",
	type: ApprovalType,
	role: ApprovalRole,
): string | null {
	const cells = action === "approve" ? APPROVE_CELLS : DISAPPROVE_CELLS;
	if (!cells[type].includes(role)) {
		return `Unanet has no ${action} action for type=${type} as role=${role}. Valid roles: ${cells[type].join(", ") || "none"}.`;
	}
	return null;
}

const actionCommonFields = {
	type: z.enum(APPROVAL_TYPES),
	role: z.enum(APPROVAL_ROLES),
	id: z
		.number()
		.int()
		.positive()
		.describe("Timesheet / expense report / invoice / leave request / PO key from the pending queue."),
	projectKey: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Required for project-approver and customer roles (project-level approvals)."),
};

function projectKeyRequirementError(role: ApprovalRole, projectKey?: number): string | null {
	if (role !== "manager" && !projectKey) {
		return `projectKey is required when acting as ${role} (project-level approval).`;
	}
	return null;
}

export const approveTool = {
	name: "unanet_approve",
	description:
		"Approve a pending item in one of YOUR Unanet approval queues (timesheet, expense, invoice, leave request or purchase order) as manager, project approver or customer. This changes another person's record and advances a real workflow: only call after the human has reviewed the item. Requires confirm: true.",
	inputSchema: z.object({
		...actionCommonFields,
		comment: z.string().optional(),
		confirm: confirmSchema("approval"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "approving");
		if (confirmError) return { success: false, error: confirmError };
		const cellError = resolveActionCell("approve", args.type, args.role);
		if (cellError) return { success: false, error: cellError };
		const projectError = projectKeyRequirementError(args.role, args.projectKey);
		if (projectError) return { success: false, error: projectError };
		try {
			const client = createUnanetClient(auth);
			const body =
				args.type === "leave-request"
					? compact({ comment: args.comment })
					: compact({ projectKey: args.projectKey, comment: args.comment });
			await client.post(
				`/me/approvals/${args.type}/${args.role}/${args.id}/approve`,
				body,
			);
			return {
				success: true,
				action: "approve",
				type: args.type,
				role: args.role,
				id: args.id,
				message: `${args.type} ${args.id} approved as ${args.role}.`,
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const disapproveTool = {
	name: "unanet_disapprove",
	description:
		"Disapprove (reject back to the submitter) a pending item in one of YOUR Unanet approval queues. A comment explaining the reason is required. For timesheets you may flag specific timeslips with reasons. Requires confirm: true.",
	inputSchema: z.object({
		...actionCommonFields,
		comment: z.string().min(1).describe("Reason for disapproval (shown to the submitter)."),
		timeslips: z
			.array(
				z.object({
					timeslipKey: z.number().int().positive(),
					reason: z.string().min(1),
				}),
			)
			.optional()
			.describe("Time only: specific timeslips being disapproved, with reasons."),
		confirm: confirmSchema("disapproval"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "disapproving");
		if (confirmError) return { success: false, error: confirmError };
		const cellError = resolveActionCell("disapprove", args.type, args.role);
		if (cellError) return { success: false, error: cellError };
		const projectError = projectKeyRequirementError(args.role, args.projectKey);
		if (projectError) return { success: false, error: projectError };
		try {
			const client = createUnanetClient(auth);
			let body: Record<string, unknown>;
			if (args.type === "leave-request") {
				body = { comment: args.comment };
			} else if (args.type === "time") {
				body = compact({
					projectKey: args.projectKey,
					comment: args.comment,
					timeslips: args.timeslips,
				});
			} else {
				body = compact({ projectKey: args.projectKey, comment: args.comment });
			}
			await client.post(
				`/me/approvals/${args.type}/${args.role}/${args.id}/disapprove`,
				body,
			);
			return {
				success: true,
				action: "disapprove",
				type: args.type,
				role: args.role,
				id: args.id,
				message: `${args.type} ${args.id} disapproved as ${args.role}.`,
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};
