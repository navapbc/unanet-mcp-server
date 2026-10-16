// User Expenses, part 2: everything after "create draft + add lines" that
// expenses.ts already covers. Update/delete report, read/update/delete a line,
// history, meal caps, attachment download/delete, approved requests, imported
// (credit-card) expenses, and the gated submit.

import { z } from "zod";
import { type UnanetAuth, createUnanetClient } from "../auth.js";
import { diskSaveBlocked, saveAttachmentToDisk, summarizeAttachment } from "../utils/attachments.js";
import {
	allocationInputSchema,
	assertAllocationsTotal100,
	normalizeErrors,
	normalizeWarnings,
	summarizeDetail,
	summarizeExpense,
	wizardSchema,
} from "./expenses.js";
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

const EDITABLE_EXPENSE_STATUSES = new Set(["INUSE", "DISAPPROVED"]);

async function loadEditableExpense(
	client: any,
	expenseId: number,
): Promise<{ ok: true; expense: any } | { ok: false; error: string }> {
	const expense = (await client.get(`/me/expenses/${expenseId}`)).data;
	const status = String(expense?.status ?? "").toUpperCase();
	if (!EDITABLE_EXPENSE_STATUSES.has(status)) {
		return {
			ok: false,
			error: `Expense report ${expenseId} is not editable; status is ${status || "unknown"}.`,
		};
	}
	return { ok: true, expense };
}

export const updateExpenseReportTool = {
	name: "unanet_update_expense_report",
	description:
		"Update the purpose, location and/or project allocations of one of your DRAFT Unanet expense reports. Allocations, when provided, replace the existing set and must total 100. Never submits. Requires confirm: true.",
	inputSchema: z
		.object({
			expenseId: z.number().int().positive(),
			purpose: z.string().min(1).optional(),
			location: z.string().optional(),
			expenseProjectAllocations: z.array(allocationInputSchema).min(1).optional(),
			confirm: confirmSchema("expense report update"),
		})
		.refine(
			(value) =>
				value.purpose !== undefined ||
				value.location !== undefined ||
				value.expenseProjectAllocations !== undefined,
			{ message: "Provide at least one field to change.", path: ["purpose"] },
		),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "updating an expense report");
		if (confirmError) return { success: false, error: confirmError };
		try {
			if (args.expenseProjectAllocations) {
				assertAllocationsTotal100(args.expenseProjectAllocations);
			}
			const client = createUnanetClient(auth);
			const loaded = await loadEditableExpense(client, args.expenseId);
			if (!loaded.ok) return { success: false, error: loaded.error };
			const existing = loaded.expense;
			// ExpenseUpdateModel requires the full allocation list every time.
			const allocations =
				args.expenseProjectAllocations ??
				(existing.expenseProjectAllocations ?? []).map((allocation: any) =>
					compact({
						projectKey: allocation.project?.key ?? allocation.projectKey,
						taskKey: allocation.task?.key ?? allocation.taskKey ?? undefined,
						allocation: allocation.allocation,
					}),
				);
			await client.put(
				`/me/expenses/${args.expenseId}`,
				compact({
					purpose: args.purpose ?? existing.purpose,
					location: args.location ?? existing.location,
					expenseProjectAllocations: allocations,
				}),
			);
			const readback = await client
				.get(`/me/expenses/${args.expenseId}`)
				.then((response) => summarizeExpense(response.data))
				.catch(() => null);
			return {
				success: true,
				expenseId: args.expenseId,
				expense: readback,
				message: "Expense report updated (still a draft; not submitted).",
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const deleteExpenseReportTool = {
	name: "unanet_delete_expense_report",
	description:
		"Delete one of your DRAFT (INUSE/DISAPPROVED) Unanet expense reports, including its lines and attachments. Irreversible. Refuses when the report has lines unless allowNonEmpty=true. Requires confirm: true.",
	inputSchema: z.object({
		expenseId: z.number().int().positive(),
		allowNonEmpty: z.boolean().optional().default(false),
		confirm: confirmSchema("expense report deletion"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "deleting an expense report");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			const loaded = await loadEditableExpense(client, args.expenseId);
			if (!loaded.ok) return { success: false, error: loaded.error };
			const detailCount = (loaded.expense.expenseDetails ?? []).length;
			if (detailCount > 0 && !args.allowNonEmpty) {
				return {
					success: false,
					error: `Expense report ${args.expenseId} has ${detailCount} line item(s). Nothing was deleted. Pass allowNonEmpty=true to delete it anyway.`,
					expense: summarizeExpense(loaded.expense),
				};
			}
			await client.delete(`/me/expenses/${args.expenseId}`);
			return {
				success: true,
				expenseId: args.expenseId,
				deletedDetailCount: detailCount,
				message: `Expense report ${args.expenseId} deleted.`,
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const getExpenseDetailTool = {
	name: "unanet_get_expense_detail",
	description:
		"Read one line item (expense detail) of one of your Unanet expense reports, including its wizard fields. Read-only.",
	inputSchema: z.object({
		expenseId: z.number().int().positive(),
		detailId: z.number().int().positive(),
		includeRaw: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include the full raw ExpenseDetailModel (needed to see wizard/VAT fields)."),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get(
				`/me/expenses/${args.expenseId}/details/${args.detailId}`,
			);
			return {
				success: true,
				detail: summarizeDetail(response.data),
				wizard: response.data?.wizard ?? null,
				raw: args.includeRaw ? response.data : undefined,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const updateExpenseDetailTool = {
	name: "unanet_update_expense_detail",
	description:
		"Update fields on one line item of one of your DRAFT Unanet expense reports. Only provided fields change; the tool reads the current line, merges, and PUTs the full model back. Never submits. Requires confirm: true.",
	inputSchema: z.object({
		expenseId: z.number().int().positive(),
		detailId: z.number().int().positive(),
		expenseDate: isoDateSchema.optional(),
		expenseTypeKey: z.number().int().positive().optional(),
		paymentMethodKey: z.number().int().positive().optional(),
		amount: z.number().positive().optional(),
		expenseAmount: z.number().positive().optional(),
		exchangeRate: z.number().positive().optional(),
		transactionCurrency: z.number().int().positive().optional(),
		projectAllocationKey: z.number().int().positive().optional(),
		projectTypeKey: z.number().int().positive().optional(),
		summary: z.string().optional(),
		comments: z.string().optional(),
		vendorName: z.string().optional(),
		receiptIncluded: z.boolean().optional(),
		noReceiptReason: z.string().optional(),
		wizard: wizardSchema.optional(),
		confirm: confirmSchema("expense detail update"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "updating an expense detail");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			const loaded = await loadEditableExpense(client, args.expenseId);
			if (!loaded.ok) return { success: false, error: loaded.error };
			const current = (
				await client.get(`/me/expenses/${args.expenseId}/details/${args.detailId}`)
			).data;
			const updated: Record<string, unknown> = { ...current };
			const setIf = (field: string, value: unknown) => {
				if (value !== undefined) updated[field] = value;
			};
			setIf("expenseDate", args.expenseDate);
			setIf("amount", args.amount);
			setIf("expenseAmount", args.expenseAmount);
			setIf("exchangeRate", args.exchangeRate);
			setIf("projectAllocationKey", args.projectAllocationKey);
			setIf("summary", args.summary);
			setIf("comments", args.comments);
			setIf("vendorName", args.vendorName);
			setIf("receiptIncluded", args.receiptIncluded);
			setIf("noReceiptReason", args.noReceiptReason);
			setIf("wizard", args.wizard);
			// Nested key/name references: the model carries objects, callers give keys.
			if (args.expenseTypeKey !== undefined) {
				updated.expenseType = { ...(current.expenseType ?? {}), key: args.expenseTypeKey };
			}
			if (args.paymentMethodKey !== undefined) {
				updated.paymentMethod = { ...(current.paymentMethod ?? {}), key: args.paymentMethodKey };
			}
			if (args.transactionCurrency !== undefined) {
				updated.transactionCurrency = {
					...(current.transactionCurrency ?? {}),
					key: args.transactionCurrency,
				};
			}
			if (args.projectTypeKey !== undefined) {
				updated.projectType = { ...(current.projectType ?? {}), key: args.projectTypeKey };
			}
			// If amount changed but expenseAmount was not given, keep them in sync
			// for single-currency (rate 1) lines so totals stay right.
			if (
				args.amount !== undefined &&
				args.expenseAmount === undefined &&
				Number(updated.exchangeRate ?? 1) === 1
			) {
				updated.expenseAmount = args.amount;
			}
			await client.put(
				`/me/expenses/${args.expenseId}/details/${args.detailId}`,
				updated,
			);
			const readback = await client
				.get(`/me/expenses/${args.expenseId}/details/${args.detailId}`)
				.then((response) => summarizeDetail(response.data))
				.catch(() => null);
			return {
				success: true,
				expenseId: args.expenseId,
				detailId: args.detailId,
				detail: readback,
				message: "Expense line updated (report still a draft; not submitted).",
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const deleteExpenseDetailTool = {
	name: "unanet_delete_expense_detail",
	description:
		"Delete one line item from one of your DRAFT Unanet expense reports. Irreversible. Requires confirm: true.",
	inputSchema: z.object({
		expenseId: z.number().int().positive(),
		detailId: z.number().int().positive(),
		confirm: confirmSchema("expense detail deletion"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "deleting an expense detail");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			const loaded = await loadEditableExpense(client, args.expenseId);
			if (!loaded.ok) return { success: false, error: loaded.error };
			const existing = (loaded.expense.expenseDetails ?? []).find(
				(detail: any) => Number(detail.key) === Number(args.detailId),
			);
			await client.delete(`/me/expenses/${args.expenseId}/details/${args.detailId}`);
			return {
				success: true,
				expenseId: args.expenseId,
				detailId: args.detailId,
				deleted: existing ? summarizeDetail(existing) : null,
				message: "Expense line deleted.",
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const getExpenseHistoryTool = {
	name: "unanet_get_expense_history",
	description:
		"Read the status history (submitted/approved/disapproved, by whom, when, comments) of one of your Unanet expense reports. Read-only.",
	inputSchema: z.object({
		expenseId: z.number().int().positive(),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 200),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get(`/me/expenses/${args.expenseId}/history`, {
				params: { page: args.page, pageSize: args.pageSize },
			});
			const history = itemsFromResponse<any>(response.data).map((item) => ({
				status: item?.status ?? null,
				actionTimestamp: item?.actionTimestamp ?? null,
				performedBy: keyName(item?.performedBy),
				performedFor: keyName(item?.performedFor),
				role: keyName(item?.role),
				project: keyName(item?.project),
				comments: item?.comments ?? null,
			}));
			return {
				success: true,
				expenseId: args.expenseId,
				count: history.length,
				paging: pageInfo(response.data),
				history,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getExpenseMealCapsTool = {
	name: "unanet_get_expense_meal_caps",
	description:
		"Read the daily meal cap and per-day meal totals Unanet computes for one of your expense reports (useful before adding M&IE lines). Read-only.",
	inputSchema: z.object({ expenseId: z.number().int().positive() }),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get(`/me/expenses/${args.expenseId}/meal-caps`);
			return {
				success: true,
				expenseId: args.expenseId,
				cap: toNumberOrNull(response.data?.cap),
				items: response.data?.items ?? [],
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getExpenseAttachmentTool = {
	name: "unanet_get_expense_attachment",
	description:
		"Download one receipt attachment from one of your Unanet expense reports. Returns metadata; includeData=true returns the file as base64. saveTo writes it to a local document path and is the one option that changes your machine: it needs UNANET_ENABLE_WRITE_TOOLS=true and confirm: true.",
	inputSchema: z.object({
		expenseId: z.number().int().positive(),
		attachmentId: z.number().int().positive(),
		saveTo: z.string().min(1).optional(),
		overwrite: z.boolean().optional().default(false),
		includeData: z.boolean().optional().default(false),
		confirm: z.literal(true).optional().describe("Required with saveTo."),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const blocked = diskSaveBlocked(args);
		if (blocked) return { success: false, error: blocked };
		try {
			const client = createUnanetClient(auth);
			const response = await client.get(
				`/me/expenses/${args.expenseId}/attachments/${args.attachmentId}`,
			);
			const attachment = response.data;
			let saved: { path: string; bytes: number } | null = null;
			if (args.saveTo) {
				const written = saveAttachmentToDisk(attachment, args.saveTo, {
					overwrite: args.overwrite,
				});
				if (!written.ok) {
					return { success: false, error: written.error, attachment: summarizeAttachment(attachment) };
				}
				saved = { path: written.path, bytes: written.bytes };
			}
			return {
				success: true,
				attachment: summarizeAttachment(attachment),
				saved,
				data: args.includeData ? (attachment?.data ?? null) : undefined,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const deleteExpenseAttachmentTool = {
	name: "unanet_delete_expense_attachment",
	description:
		"Delete a receipt attachment (and its line associations) from one of your DRAFT Unanet expense reports. Irreversible. Requires confirm: true.",
	inputSchema: z.object({
		expenseId: z.number().int().positive(),
		attachmentId: z.number().int().positive(),
		confirm: confirmSchema("attachment deletion"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "deleting an expense attachment");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			const loaded = await loadEditableExpense(client, args.expenseId);
			if (!loaded.ok) return { success: false, error: loaded.error };
			await client.delete(
				`/me/expenses/${args.expenseId}/attachments/${args.attachmentId}`,
			);
			return {
				success: true,
				expenseId: args.expenseId,
				attachmentId: args.attachmentId,
				message: "Attachment deleted.",
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const getApprovedExpenseRequestsTool = {
	name: "unanet_get_approved_expense_requests",
	description:
		"List your approved Unanet expense REQUESTS (pre-approvals / travel authorizations), or read one by id. Read-only.",
	inputSchema: z.object({
		requestId: z.number().int().positive().optional(),
		ownerKey: z.number().int().positive().optional(),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 200),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			if (args.requestId) {
				const response = await client.get(
					`/me/expenses/approved-requests/${args.requestId}`,
				);
				return { success: true, request: response.data };
			}
			const response = await client.get("/me/expenses/approved-requests", {
				params: compact({ page: args.page, pageSize: args.pageSize, ownerKey: args.ownerKey }),
			});
			const requests = itemsFromResponse<any>(response.data).map((request) => ({
				key: request?.key ?? null,
				expenseReportKey: request?.expenseReportKey ?? null,
				purpose: request?.purpose ?? null,
				location: request?.location ?? null,
				status: request?.status ?? null,
				owner: keyName(request?.owner),
				completedDate: request?.completedDate ?? null,
				totalExpenses: toNumberOrNull(request?.totalExpenses),
				reimbursableAmount: toNumberOrNull(request?.reimbursableAmount),
				expenseCurrencyCode: request?.expenseCurrencyCode ?? null,
			}));
			return { success: true, count: requests.length, paging: pageInfo(response.data), requests };
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const searchImportedExpensesTool = {
	name: "unanet_search_imported_expenses",
	description:
		"Search your imported (corporate credit-card) expense transactions in Unanet, e.g. AVAILABLE ones not yet placed on a report. Read-only.",
	inputSchema: z.object({
		status: z.enum(["AVAILABLE", "USED", "ALL"]).optional().default("AVAILABLE"),
		vendors: z.array(z.string()).optional(),
		expenseReportKeys: z.array(z.number().int().positive()).optional(),
		expenseDateStart: isoDateSchema.optional(),
		expenseDateEnd: isoDateSchema.optional(),
		importDateStart: isoDateSchema.optional(),
		importDateEnd: isoDateSchema.optional(),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 200),
	}).superRefine((value, context) => {
		for (const field of ["expenseDate", "importDate"]) {
			const start = (value as any)[`${field}Start`];
			const end = (value as any)[`${field}End`];
			if (Boolean(start) !== Boolean(end)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: [`${field}Start`],
					message: `${field}Start and ${field}End must be provided together (DateRangeModel requires both).`,
				});
			}
		}
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			// DateRangeModel is { rangeStart, rangeEnd }, both required.
			const range = (start?: string, end?: string) =>
				start && end ? { rangeStart: start, rangeEnd: end } : undefined;
			const body = compact({
				status: args.status,
				vendors: args.vendors,
				expenseReportKeys: args.expenseReportKeys,
				expenseDateRange: range(args.expenseDateStart, args.expenseDateEnd),
				importDateRange: range(args.importDateStart, args.importDateEnd),
			});
			const response = await client.post("/me/expenses/imported/search", body, {
				params: { page: args.page, pageSize: args.pageSize },
			});
			// The spec declares an array of paged envelopes; also accept one
			// envelope or a flat array of rows. Every envelope is read, and any
			// other shape is an error rather than an empty result.
			const data = response.data;
			const isObject = (entry: unknown) => entry !== null && typeof entry === "object" && !Array.isArray(entry);
			const isEnvelope = (entry: any) => isObject(entry) && Array.isArray(entry.items);
			let envelopes: any[] | null = null;
			let rows: any[] | null = null;
			if (Array.isArray(data) && data.length > 0 && data.every(isEnvelope)) {
				envelopes = data;
			} else if (Array.isArray(data) && data.every((entry: any) => isObject(entry) && !isEnvelope(entry))) {
				rows = data;
			} else if (isEnvelope(data)) {
				envelopes = [data];
			}
			if (!envelopes && !rows) {
				return {
					success: false,
					error: "Unexpected response shape from the imported-expense search; expected an array of paged envelopes or rows.",
				};
			}
			const items = envelopes ? envelopes.flatMap((envelope) => itemsFromResponse<any>(envelope)) : (rows ?? []);
			const paging = envelopes
				? envelopes.length === 1
					? pageInfo(envelopes[0])
					: envelopes.map((envelope) => pageInfo(envelope))
				: pageInfo(data);
			return { success: true, count: items.length, paging, importedExpenses: items };
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const addImportedExpenseToReportTool = {
	name: "unanet_add_imported_expense_to_report",
	description:
		"Place an imported (credit-card) transaction onto one of your DRAFT Unanet expense reports as a new line with the given expense type. Requires confirm: true.",
	inputSchema: z.object({
		expenseId: z.number().int().positive(),
		importedExpenseKey: z.number().int().positive(),
		expenseTypeKey: z.number().int().positive(),
		confirm: confirmSchema("imported expense placement"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "adding an imported expense");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			const loaded = await loadEditableExpense(client, args.expenseId);
			if (!loaded.ok) return { success: false, error: loaded.error };
			const response = await client.post(`/me/expenses/${args.expenseId}/imported`, {
				importedExpenseKey: args.importedExpenseKey,
				expenseTypeKey: args.expenseTypeKey,
			});
			return {
				success: true,
				expenseId: args.expenseId,
				detailId: response.data?.key ?? null,
				message: "Imported expense added as a line on the draft report.",
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const submitExpenseReportTool = {
	name: "unanet_submit_expense_report",
	description:
		"Submit one of your DRAFT Unanet expense reports for approval (POST /me/expenses/{id}/submit). Validates first: refuses on validation errors, and on warnings returns them and does nothing unless ignoreWarnings is true. One-way action that locks the report from edits; only call after the human has reviewed the report in Unanet. Requires confirm: true.",
	inputSchema: z.object({
		expenseId: z.number().int().positive(),
		comment: z.string().optional(),
		ignoreWarnings: z.boolean().optional().default(false),
		confirm: confirmSchema("one-way expense submission"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "submitting an expense report");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			const loaded = await loadEditableExpense(client, args.expenseId);
			if (!loaded.ok) return { success: false, error: loaded.error };
			if ((loaded.expense.expenseDetails ?? []).length === 0) {
				return {
					success: false,
					error: `Expense report ${args.expenseId} has no line items and was not submitted.`,
				};
			}
			const validation = (
				await client.get(`/me/expenses/${args.expenseId}/validate`, {
					params: { submitValidation: true },
				})
			).data;
			const errors = normalizeErrors(validation);
			if (errors.length > 0) {
				return {
					success: false,
					error: "Expense report has validation errors and was not submitted. Fix these and retry.",
					validationErrors: errors,
				};
			}
			const warnings = normalizeWarnings(validation);
			if (warnings.length > 0 && !args.ignoreWarnings) {
				return {
					success: false,
					error: "Expense report has validation warnings. Review them, then re-run with ignoreWarnings=true to submit anyway.",
					validationWarnings: warnings,
				};
			}
			await client.post(
				`/me/expenses/${args.expenseId}/submit`,
				compact({ comment: args.comment, ignoreWarnings: args.ignoreWarnings }),
			);
			const readback = await client
				.get(`/me/expenses/${args.expenseId}`)
				.then((response) => summarizeExpense(response.data))
				.catch(() => null);
			return {
				success: true,
				expenseId: args.expenseId,
				expense: readback,
				submittedWarnings: warnings.length > 0 ? warnings : undefined,
				message: `Submitted expense report ${args.expenseId} for approval.`,
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};
