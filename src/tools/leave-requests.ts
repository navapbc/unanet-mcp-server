// User Leave Requests: list, history, create (draft), update, submit, cancel,
// delete. Pairs with the read-only leave-balance tool in leave.ts.

import { z } from "zod";
import { type UnanetAuth, createUnanetClient } from "../auth.js";
import {
	compact,
	confirmSchema,
	errorResult,
	isoDateSchema,
	itemsFromResponse,
	keyName,
	pageInfo,
	pageSchema,
	pageSizeSchema,
	requireConfirm,
	toNumberOrNull,
	writeErrorResult,
} from "../utils/http.js";

const LEAVE_REQUEST_STATUSES = [
	"INUSE",
	"SUBMITTED",
	"DISAPPROVED",
	"APPROVING",
	"COMPLETED",
	"LOCKED",
	"CANCELED",
] as const;

const EDITABLE_STATUSES = new Set(["INUSE", "DISAPPROVED"]);

export function summarizeLeaveRequest(request: any) {
	return {
		key: request?.key ?? null,
		person: keyName(request?.person),
		beginDate: request?.beginDate ?? null,
		endDate: request?.endDate ?? null,
		hours: toNumberOrNull(request?.hours),
		nonWorkDays: request?.nonWorkDays ?? null,
		status: request?.status ?? null,
		statusDate: request?.statusDate ?? null,
		controller: keyName(request?.controller),
		comments: request?.comments ?? null,
	};
}

async function loadLeaveRequest(client: any, id: number): Promise<any | null> {
	// The /me/leave-requests collection has no by-id GET; find it in the list.
	// Page through a generous window sorted newest first.
	for (let page = 1; page <= 10; page += 1) {
		const response = await client.get("/me/leave-requests", {
			params: { page, pageSize: 100, sortBy: "BEGIN_DATE", sortOrder: "DESC" },
		});
		const items = itemsFromResponse<any>(response.data);
		const match = items.find((item) => Number(item.key) === Number(id));
		if (match) return match;
		const paging = pageInfo(response.data);
		if (!paging.pageCount || page >= paging.pageCount || items.length === 0) break;
	}
	return null;
}

export const getMyLeaveRequestsTool = {
	name: "unanet_get_my_leave_requests",
	description:
		"List your Unanet leave requests, optionally filtered by date range and status. Read-only.",
	inputSchema: z.object({
		startDate: isoDateSchema.optional(),
		endDate: isoDateSchema.optional(),
		status: z.array(z.enum(LEAVE_REQUEST_STATUSES)).optional(),
		ownerKey: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Person key of a user you are a leave alternate for."),
		sortBy: z.enum(["BEGIN_DATE", "HOURS", "STATUS", "COMMENTS"]).optional(),
		sortOrder: z.enum(["ASC", "DESC"]).optional().default("DESC"),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 200),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get("/me/leave-requests", {
				params: compact({
					page: args.page,
					pageSize: args.pageSize,
					start: args.startDate,
					end: args.endDate,
					status: args.status?.length ? args.status.join(",") : undefined,
					ownerKey: args.ownerKey,
					sortBy: args.sortBy,
					sortOrder: args.sortOrder,
				}),
			});
			const leaveRequests = itemsFromResponse<any>(response.data).map(
				summarizeLeaveRequest,
			);
			return {
				success: true,
				count: leaveRequests.length,
				paging: pageInfo(response.data),
				leaveRequests,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getLeaveRequestHistoryTool = {
	name: "unanet_get_leave_request_history",
	description: "Read the status history of one of your Unanet leave requests.",
	inputSchema: z.object({
		leaveRequestId: z.number().int().positive(),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 200),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get(
				`/me/leave-requests/${args.leaveRequestId}/history`,
				{ params: { page: args.page, pageSize: args.pageSize } },
			);
			const history = itemsFromResponse<any>(response.data).map((item) => ({
				status: item?.status ?? null,
				actionTimestamp: item?.actionTimestamp ?? null,
				performedBy: keyName(item?.performedBy),
				performedFor: keyName(item?.performedFor),
				role: keyName(item?.role),
				comments: item?.comments ?? null,
			}));
			return {
				success: true,
				leaveRequestId: args.leaveRequestId,
				count: history.length,
				paging: pageInfo(response.data),
				history,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const createLeaveRequestTool = {
	name: "unanet_create_leave_request",
	description:
		"Create a DRAFT Unanet leave request (status INUSE). Does not submit it for approval; use unanet_submit_leave_request after review. Requires confirm: true.",
	inputSchema: z
		.object({
			beginDate: isoDateSchema,
			endDate: isoDateSchema,
			hours: z.number().positive().describe("Total hours requested."),
			nonWorkDays: z
				.boolean()
				.optional()
				.default(false)
				.describe("Include non-working days (weekends/holidays) in the request."),
			comments: z.string().optional(),
			confirm: confirmSchema("leave request creation"),
		})
		.refine((value) => value.beginDate <= value.endDate, {
			message: "beginDate must be on or before endDate",
			path: ["beginDate"],
		}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "creating a leave request");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			const response = await client.post(
				"/me/leave-requests",
				compact({
					beginDate: args.beginDate,
					endDate: args.endDate,
					hours: args.hours,
					nonWorkDays: args.nonWorkDays,
					comments: args.comments,
				}),
			);
			const leaveRequestKey = response.data?.key ?? null;
			const leaveRequest = leaveRequestKey
				? await loadLeaveRequest(client, leaveRequestKey)
						.then((item) => (item ? summarizeLeaveRequest(item) : null))
						.catch(() => null)
				: null;
			return {
				success: true,
				leaveRequestKey,
				leaveRequest,
				message:
					"Draft leave request created (not submitted). Review it, then use unanet_submit_leave_request.",
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const updateLeaveRequestTool = {
	name: "unanet_update_leave_request",
	description:
		"Update dates/hours/comments on one of your DRAFT (INUSE or DISAPPROVED) Unanet leave requests. Only provided fields change. Requires confirm: true.",
	inputSchema: z
		.object({
			leaveRequestId: z.number().int().positive(),
			beginDate: isoDateSchema.optional(),
			endDate: isoDateSchema.optional(),
			hours: z.number().positive().optional(),
			nonWorkDays: z.boolean().optional(),
			comments: z.string().optional(),
			confirm: confirmSchema("leave request update"),
		})
		.refine(
			(value) =>
				value.beginDate !== undefined ||
				value.endDate !== undefined ||
				value.hours !== undefined ||
				value.nonWorkDays !== undefined ||
				value.comments !== undefined,
			{ message: "Provide at least one field to change.", path: ["hours"] },
		),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "updating a leave request");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			const existing = await loadLeaveRequest(client, args.leaveRequestId);
			if (!existing) {
				return {
					success: false,
					error: `Leave request ${args.leaveRequestId} was not found among your leave requests.`,
				};
			}
			const status = String(existing.status ?? "").toUpperCase();
			if (!EDITABLE_STATUSES.has(status)) {
				return {
					success: false,
					error: `Leave request ${args.leaveRequestId} has status ${status} and cannot be edited.`,
				};
			}
			const updated = {
				...existing,
				beginDate: args.beginDate ?? existing.beginDate,
				endDate: args.endDate ?? existing.endDate,
				hours: args.hours ?? existing.hours,
				nonWorkDays: args.nonWorkDays ?? existing.nonWorkDays,
				comments: args.comments ?? existing.comments,
			};
			if (updated.beginDate > updated.endDate) {
				return {
					success: false,
					error: `Resulting beginDate ${updated.beginDate} is after endDate ${updated.endDate}. Nothing was changed.`,
				};
			}
			await client.put(`/me/leave-requests/${args.leaveRequestId}`, updated);
			const readback = await loadLeaveRequest(client, args.leaveRequestId).catch(
				() => null,
			);
			return {
				success: true,
				leaveRequest: summarizeLeaveRequest(readback ?? updated),
				message: "Leave request updated (still not submitted).",
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const submitLeaveRequestTool = {
	name: "unanet_submit_leave_request",
	description:
		"Submit one of your DRAFT Unanet leave requests for manager approval. This starts a real approval workflow; only call after the human has reviewed the request. Requires confirm: true.",
	inputSchema: z.object({
		leaveRequestId: z.number().int().positive(),
		comment: z.string().optional(),
		additionalEmails: z.array(z.string().email()).optional(),
		confirm: confirmSchema("leave request submission"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "submitting a leave request");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			const existing = await loadLeaveRequest(client, args.leaveRequestId);
			if (!existing) {
				return {
					success: false,
					error: `Leave request ${args.leaveRequestId} was not found among your most recent leave requests, so its status could not be checked. Nothing was submitted.`,
				};
			}
			const status = String(existing.status ?? "").toUpperCase();
			if (!EDITABLE_STATUSES.has(status)) {
				return {
					success: false,
					error: `Leave request ${args.leaveRequestId} has status ${status}; only INUSE or DISAPPROVED requests can be submitted.`,
				};
			}
			await client.post(
				`/me/leave-requests/${args.leaveRequestId}/submit`,
				compact({ comment: args.comment, additionalEmails: args.additionalEmails }),
			);
			const readback = await loadLeaveRequest(client, args.leaveRequestId).catch(
				() => null,
			);
			return {
				success: true,
				leaveRequestId: args.leaveRequestId,
				leaveRequest: readback ? summarizeLeaveRequest(readback) : null,
				message: "Leave request submitted for approval.",
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const cancelLeaveRequestTool = {
	name: "unanet_cancel_leave_request",
	description:
		"Cancel one of your submitted/approved Unanet leave requests. Requires confirm: true.",
	inputSchema: z.object({
		leaveRequestId: z.number().int().positive(),
		confirm: confirmSchema("leave request cancellation"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "cancelling a leave request");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			await client.post(`/me/leave-requests/${args.leaveRequestId}/cancel`, {});
			const readback = await loadLeaveRequest(client, args.leaveRequestId).catch(
				() => null,
			);
			return {
				success: true,
				leaveRequestId: args.leaveRequestId,
				leaveRequest: readback ? summarizeLeaveRequest(readback) : null,
				message: "Leave request cancelled.",
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const deleteLeaveRequestTool = {
	name: "unanet_delete_leave_request",
	description:
		"Delete one of your DRAFT (INUSE or DISAPPROVED) Unanet leave requests. Irreversible. Requires confirm: true.",
	inputSchema: z.object({
		leaveRequestId: z.number().int().positive(),
		confirm: confirmSchema("leave request deletion"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "deleting a leave request");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			const existing = await loadLeaveRequest(client, args.leaveRequestId);
			if (!existing) {
				return {
					success: false,
					error: `Leave request ${args.leaveRequestId} was not found among your most recent leave requests, so its status could not be checked. Nothing was deleted.`,
				};
			}
			const status = String(existing.status ?? "").toUpperCase();
			if (!EDITABLE_STATUSES.has(status)) {
				return {
					success: false,
					error: `Leave request ${args.leaveRequestId} has status ${status}; only INUSE or DISAPPROVED requests can be deleted. Use unanet_cancel_leave_request for submitted ones.`,
				};
			}
			await client.delete(`/me/leave-requests/${args.leaveRequestId}`);
			return {
				success: true,
				leaveRequestId: args.leaveRequestId,
				message: "Leave request deleted.",
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};
