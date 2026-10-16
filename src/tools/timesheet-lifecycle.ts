// Timesheet lifecycle tools: everything around a timesheet other than editing
// its rows (which lives in timesheet.ts). Covers the remaining User Time
// endpoints: time periods, list, history, adjustments, attachments, create and
// delete.

import { z } from "zod";
import { type UnanetAuth, createUnanetClient } from "../auth.js";
import {
	attachmentInputFields,
	diskSaveBlocked,
	loadAttachmentInput,
	refineAttachmentInput,
	saveAttachmentToDisk,
	summarizeAttachment,
} from "../utils/attachments.js";
import {
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
	compact,
	writeErrorResult,
} from "../utils/http.js";

function summarizeTimesheetListItem(timesheet: any) {
	return {
		key: timesheet?.key ?? null,
		beginDate: timesheet?.beginDate ?? timesheet?.timePeriod?.beginDate ?? null,
		endDate: timesheet?.endDate ?? timesheet?.timePeriod?.endDate ?? null,
		status: timesheet?.status ?? null,
		adjustmentStatus: timesheet?.adjustmentStatus ?? null,
		hours: toNumberOrNull(timesheet?.hours),
		owner: keyName(timesheet?.owner),
		controller: keyName(timesheet?.controller),
		attachmentCount: toNumberOrNull(timesheet?.attachmentCount),
		pendingReview: timesheet?.pendingReview ?? null,
		historical: timesheet?.historical ?? null,
		lastUpdatedTimestamp: timesheet?.lastUpdatedTimestamp ?? null,
	};
}

function summarizeHistoryItem(item: any) {
	return {
		key: item?.key ?? null,
		status: item?.status ?? null,
		adjustmentStatus: item?.adjustmentStatus ?? null,
		actionTimestamp: item?.actionTimestamp ?? null,
		performedBy: keyName(item?.performedBy),
		performedFor: keyName(item?.performedFor),
		role: keyName(item?.role),
		project: keyName(item?.project),
		comments: item?.comments ?? null,
		reviewRequired: item?.reviewRequired ?? null,
		reviewComments: item?.reviewComments ?? null,
	};
}

function summarizeAdjustmentTimeslip(timeslip: any) {
	return {
		key: timeslip?.key ?? null,
		workDate: timeslip?.workDate ?? null,
		hoursWorked: toNumberOrNull(timeslip?.hoursWorked),
		project: keyName(timeslip?.project),
		task: keyName(timeslip?.task),
		payCode: keyName(timeslip?.payCode),
		comments: timeslip?.comments ?? null,
		adjustmentReason: timeslip?.adjustmentReason ?? timeslip?.reason ?? null,
	};
}

export const getTimePeriodsTool = {
	name: "unanet_get_time_periods",
	description:
		"List your Unanet time periods (pay periods) in a date range, including projected future periods. Useful to find which period a date falls in before creating a timesheet.",
	inputSchema: z.object({
		startDate: isoDateSchema
			.optional()
			.describe("Range start (YYYY-MM-DD). Defaults to Unanet's default window."),
		endDate: isoDateSchema.optional().describe("Range end (YYYY-MM-DD)."),
		includeProjected: z.boolean().optional().default(true),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 200),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get("/me/time/time-periods", {
				params: compact({
					page: args.page,
					pageSize: args.pageSize,
					start: args.startDate,
					end: args.endDate,
					includeProjected: args.includeProjected,
				}),
			});
			const periods = itemsFromResponse<any>(response.data).map((period) => ({
				timePeriodKey: period.timePeriodKey ?? null,
				beginDate: period.beginDate ?? null,
				endDate: period.endDate ?? null,
			}));
			return {
				success: true,
				count: periods.length,
				paging: pageInfo(response.data),
				timePeriods: periods,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const listMyTimesheetsTool = {
	name: "unanet_list_my_timesheets",
	description:
		"List your Unanet timesheets (summary rows only, no per-entry detail). NOTE: Unanet returns only ACTIVE (open) timesheets unless active=false is passed, which returns historical (LOCKED/COMPLETED) ones. Use ownerKey to list timesheets of a person you are a time alternate for. For date-range detail use unanet_get_timesheets.",
	inputSchema: z.object({
		active: z
			.boolean()
			.optional()
			.describe("Omitted or true = only active/open timesheets (server default); false = only historical/inactive ones."),
		ownerKey: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Person key of a user you are a time alternate for."),
		sortBy: z.enum(["BEGIN_DATE", "HOURS", "STATUS", "CONTROLLER"]).optional(),
		sortOrder: z.enum(["ASC", "DESC"]).optional().default("DESC"),
		page: pageSchema,
		pageSize: pageSizeSchema(25, 200),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get("/me/time", {
				params: compact({
					page: args.page,
					pageSize: args.pageSize,
					active: args.active,
					ownerKey: args.ownerKey,
					sortBy: args.sortBy,
					sortOrder: args.sortOrder,
				}),
			});
			const timesheets = itemsFromResponse<any>(response.data).map(
				summarizeTimesheetListItem,
			);
			return {
				success: true,
				count: timesheets.length,
				paging: pageInfo(response.data),
				timesheets,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getTimesheetHistoryTool = {
	name: "unanet_get_timesheet_history",
	description:
		"Read the status history (submitted, approved, disapproved, etc. with who/when/comments) of one of your Unanet timesheets.",
	inputSchema: z.object({
		timesheetId: z.number().int().positive(),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 200),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get(`/me/time/${args.timesheetId}/history`, {
				params: { page: args.page, pageSize: args.pageSize },
			});
			const history = itemsFromResponse<any>(response.data).map(
				summarizeHistoryItem,
			);
			return {
				success: true,
				timesheetId: args.timesheetId,
				count: history.length,
				paging: pageInfo(response.data),
				history,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getTimesheetAdjustmentsTool = {
	name: "unanet_get_timesheet_adjustments",
	description:
		"Read pending/completed adjustments (post-approval changes) on one of your Unanet timesheets.",
	inputSchema: z.object({
		timesheetId: z.number().int().positive(),
		projectId: z.number().int().positive().optional(),
		type: z
			.enum(["PENDING", "COMPLETED", "COMPLETED_UNEXTRACTED", "NONE", "ALL"])
			.optional()
			.default("ALL"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get(
				`/me/time/${args.timesheetId}/adjustments`,
				{ params: compact({ projectId: args.projectId, type: args.type }) },
			);
			const data = response.data ?? {};
			return {
				success: true,
				timesheetId: args.timesheetId,
				adjustments: {
					timeslipsPending: (data.timeslipAdjustmentsPending ?? []).map(
						summarizeAdjustmentTimeslip,
					),
					timeslipsCompleted: (data.timeslipAdjustmentsCompleted ?? []).map(
						summarizeAdjustmentTimeslip,
					),
					timeslipsCompletedUnextracted: (
						data.timeslipAdjustmentsCompletedUnextracted ?? []
					).map(summarizeAdjustmentTimeslip),
					itemEntriesPending: data.itemEntryAdjustmentsPending ?? [],
					itemEntriesCompleted: data.itemEntryAdjustmentsCompleted ?? [],
					dailyTitoPending: data.dailyTitoAdjustmentsPending ?? [],
					dailyTitoCompleted: data.dailyTitoAdjustmentsCompleted ?? [],
				},
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getTimesheetAttachmentsTool = {
	name: "unanet_get_timesheet_attachments",
	description:
		"List attachments (metadata only) on one of your Unanet timesheets. Use unanet_get_timesheet_attachment to download one.",
	inputSchema: z.object({
		timesheetId: z.number().int().positive(),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 200),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get(
				`/me/time/${args.timesheetId}/attachments`,
				{ params: { page: args.page, pageSize: args.pageSize } },
			);
			const attachments = itemsFromResponse<any>(response.data).map(
				summarizeAttachment,
			);
			return {
				success: true,
				timesheetId: args.timesheetId,
				count: attachments.length,
				paging: pageInfo(response.data),
				attachments,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getTimesheetAttachmentTool = {
	name: "unanet_get_timesheet_attachment",
	description:
		"Download one attachment from one of your Unanet timesheets. Returns metadata; includeData=true returns the file as base64. saveTo writes it to a local document path and is the one option that changes your machine: it needs UNANET_ENABLE_WRITE_TOOLS=true and confirm: true.",
	inputSchema: z.object({
		timesheetId: z.number().int().positive(),
		attachmentId: z.number().int().positive(),
		saveTo: z
			.string()
			.min(1)
			.optional()
			.describe("Absolute local path to write the file to."),
		overwrite: z.boolean().optional().default(false),
		includeData: z
			.boolean()
			.optional()
			.default(false)
			.describe("Return base64 data inline (can be large)."),
		confirm: z.literal(true).optional().describe("Required with saveTo."),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const blocked = diskSaveBlocked(args);
		if (blocked) return { success: false, error: blocked };
		try {
			const client = createUnanetClient(auth);
			const response = await client.get(
				`/me/time/${args.timesheetId}/attachment/${args.attachmentId}`,
			);
			return attachmentDownloadResult(response.data, args);
		} catch (error) {
			return errorResult(error);
		}
	},
};

export function attachmentDownloadResult(
	attachment: any,
	args: { saveTo?: string; overwrite?: boolean; includeData?: boolean },
) {
	const summary = summarizeAttachment(attachment);
	let saved: { path: string; bytes: number } | null = null;
	if (args.saveTo) {
		const written = saveAttachmentToDisk(attachment, args.saveTo, {
			overwrite: args.overwrite,
		});
		if (!written.ok) return { success: false, error: written.error, attachment: summary };
		saved = { path: written.path, bytes: written.bytes };
	}
	return {
		success: true,
		attachment: summary,
		saved,
		data: args.includeData ? (attachment?.data ?? null) : undefined,
	};
}

// Write tools ---------------------------------------------------------------

export const deleteTimesheetTool = {
	name: "unanet_delete_timesheet",
	description:
		"Delete one of your Unanet timesheets. Only NEW/INUSE timesheets can be deleted, and by default only when they contain no hours; set allowNonEmpty=true to delete a timesheet that has entries. Irreversible. Requires confirm: true.",
	inputSchema: z.object({
		timesheetId: z.number().int().positive(),
		allowNonEmpty: z
			.boolean()
			.optional()
			.default(false)
			.describe("Set true to delete a timesheet that already has hours on it."),
		confirm: confirmSchema("timesheet deletion"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "deleting a timesheet");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			const detail = (await client.get(`/me/time/${args.timesheetId}`)).data;
			const status = String(detail?.status ?? "").toUpperCase();
			if (!["NEW", "INUSE"].includes(status)) {
				return {
					success: false,
					error: `Timesheet ${args.timesheetId} has status ${status || "unknown"} and cannot be deleted. Only NEW or INUSE timesheets can be deleted.`,
				};
			}
			// Emptiness must be established, not assumed. Take the larger of the
			// hours summed from timeslips (only when the list is present and every
			// entry has a usable number; hoursWorked is optional in the spec) and
			// the summary total, and refuse when neither is available.
			const slipValues = Array.isArray(detail?.timeslips)
				? detail.timeslips.map((timeslip: any) => toNumberOrNull(timeslip?.hoursWorked))
				: null;
			const slipHours =
				slipValues && slipValues.every((value: number | null) => value !== null)
					? slipValues.reduce((sum: number, value: number | null) => sum + (value ?? 0), 0)
					: null;
			const known = [slipHours, toNumberOrNull(detail?.hours)].filter(
				(value): value is number => value !== null,
			);
			const hours = known.length ? Math.max(...known) : null;
			if (hours === null && !args.allowNonEmpty) {
				return {
					success: false,
					error: `Could not establish whether timesheet ${args.timesheetId} has hours (the response had neither timeslips nor a total). Nothing was deleted. Pass allowNonEmpty=true to delete it anyway.`,
				};
			}
			if (hours !== null && hours > 0 && !args.allowNonEmpty) {
				return {
					success: false,
					error: `Timesheet ${args.timesheetId} has ${hours} hours recorded. Nothing was deleted. Pass allowNonEmpty=true to delete it anyway.`,
					hours,
					period: {
						beginDate: detail?.timePeriod?.beginDate ?? detail?.beginDate ?? null,
						endDate: detail?.timePeriod?.endDate ?? detail?.endDate ?? null,
					},
				};
			}
			await client.delete(`/me/time/${args.timesheetId}`);
			return {
				success: true,
				timesheetId: args.timesheetId,
				deletedHours: hours,
				message: `Timesheet ${args.timesheetId} deleted.`,
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const addTimesheetAttachmentTool = {
	name: "unanet_add_timesheet_attachment",
	description:
		"Upload an attachment (e.g. supporting document) to one of your Unanet timesheets. Provide a local filePath or inline base64 data. Requires confirm: true.",
	inputSchema: z
		.object({
			timesheetId: z.number().int().positive(),
			...attachmentInputFields,
			confirm: confirmSchema("attachment upload"),
		})
		.superRefine(refineAttachmentInput),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "uploading a timesheet attachment");
		if (confirmError) return { success: false, error: confirmError };
		const loaded = loadAttachmentInput(args);
		if (!loaded.ok) return { success: false, error: loaded.error };
		try {
			const client = createUnanetClient(auth);
			const response = await client.post(
				`/me/time/${args.timesheetId}/attachment`,
				loaded.payload,
			);
			const postedKey = response.data?.key ?? null;
			let readback: any[] = [];
			let readbackError: string | null = null;
			try {
				readback = itemsFromResponse<any>(
					(
						await client.get(`/me/time/${args.timesheetId}/attachments`, {
							params: { page: 1, pageSize: 100 },
						})
					).data,
				).map(summarizeAttachment);
			} catch (listError: any) {
				readbackError = listError.message;
			}
			const matched =
				postedKey !== null
					? readback.find((a) => a.key === postedKey)
					: readback.find(
							(a) =>
								a.name === loaded.payload.name &&
								a.length === loaded.payload.length,
						);
			return {
				success: true,
				verified: Boolean(matched),
				timesheetId: args.timesheetId,
				attachmentId: matched?.key ?? postedKey,
				name: loaded.payload.name,
				mimeType: loaded.payload.mimeType,
				length: loaded.payload.length,
				readbackError,
				attachmentsOnTimesheet: readback.length,
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const deleteTimesheetAttachmentTool = {
	name: "unanet_delete_timesheet_attachment",
	description:
		"Delete an attachment from one of your Unanet timesheets. Irreversible. Requires confirm: true.",
	inputSchema: z.object({
		timesheetId: z.number().int().positive(),
		attachmentId: z.number().int().positive(),
		confirm: confirmSchema("attachment deletion"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "deleting a timesheet attachment");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			await client.delete(
				`/me/time/${args.timesheetId}/attachment/${args.attachmentId}`,
			);
			return {
				success: true,
				timesheetId: args.timesheetId,
				attachmentId: args.attachmentId,
				message: "Attachment deleted.",
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const setTimesheetAdjustmentReasonsTool = {
	name: "unanet_set_timesheet_adjustment_reasons",
	description:
		"Record adjustment reasons on one of your Unanet timesheets (required when changing an already-approved timesheet). Provide a global reason and/or per-timeslip reasons. Requires confirm: true.",
	inputSchema: z
		.object({
			timesheetId: z.number().int().positive(),
			reason: z
				.string()
				.min(1)
				.optional()
				.describe("Global reason applied to all adjusted rows."),
			timeslipReasons: z
				.array(z.object({ key: z.number().int().positive(), value: z.string().min(1) }))
				.optional()
				.describe("Per-timeslip reasons keyed by timeslip key."),
			confirm: confirmSchema("adjustment reason update"),
		})
		.refine((value) => value.reason || value.timeslipReasons?.length, {
			message: "Provide reason and/or timeslipReasons.",
			path: ["reason"],
		}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "setting adjustment reasons");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			await client.post(
				`/me/time/${args.timesheetId}/adjustments/reason`,
				compact({ reason: args.reason, timeslipReasons: args.timeslipReasons }),
			);
			return {
				success: true,
				timesheetId: args.timesheetId,
				message: "Adjustment reasons recorded.",
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};
