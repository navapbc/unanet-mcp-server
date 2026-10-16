import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { z } from "zod";
import { type UnanetAuth, createUnanetClient } from "../auth.js";
import { checkLocalAttachmentPath } from "../utils/attachments.js";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Max receipt size we will base64-encode into a JSON body. Unanet accepts
// base64 attachments but large blobs are usually a mistake (wrong file).
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".heic": "image/heic",
	".heif": "image/heif",
	".tif": "image/tiff",
	".tiff": "image/tiff",
	".bmp": "image/bmp",
};

function inferMimeType(name: string): string | null {
	return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? null;
}

function summarizeAttachment(attachment: any) {
	return {
		key: attachment?.key ?? null,
		name: attachment?.name ?? null,
		mimeType: attachment?.mimeType ?? null,
		length: toNumberOrNull(attachment?.length),
		created: attachment?.created ?? null,
		createdBy: attachment?.createdBy?.name ?? attachment?.createdBy?.key ?? null,
		detailKey: attachment?.detailKey ?? null,
		projectKey: attachment?.projectKey ?? null,
	};
}

const EXPENSE_STATUSES = [
	"REQUESTING",
	"DENIED",
	"PREAPPROVING",
	"PREAPPROVED",
	"INUSE",
	"SUBMITTED",
	"DISAPPROVED",
	"APPROVING",
	"COMPLETED",
	"EXTRACTED",
	"LOCKED",
	"PENDING_REVIEW",
	"REQUEST_SUBMITTED",
] as const;

const reimbursableStatuses = [
	"INUSE",
	"SUBMITTED",
	"APPROVING",
	"COMPLETED",
	"EXTRACTED",
	"LOCKED",
	"PENDING_REVIEW",
] as const;

const expenseStatusSchema = z.enum(EXPENSE_STATUSES);

function itemsFromResponse<T>(data: any): T[] {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.items)) return data.items;
	if (Array.isArray(data?.message?.items)) return data.message.items;
	if (Array.isArray(data?.content)) return data.content;
	return [];
}

function pageCountFromResponse(data: any): number | undefined {
	return data?.pageCount ?? data?.message?.pageCount;
}

function resultCountFromResponse(data: any): number | undefined {
	return data?.resultCount ?? data?.message?.resultCount;
}

async function fetchMyExpensesPage(
	client: ReturnType<typeof createUnanetClient>,
	params: Record<string, unknown>,
) {
	return client.get("/me/expenses", { params });
}

async function fetchAllMyExpenses(
	client: ReturnType<typeof createUnanetClient>,
	params: Record<string, unknown>,
) {
	const pageSize = Number(params.pageSize ?? 100);
	const first = await fetchMyExpensesPage(client, {
		...params,
		page: 1,
		pageSize,
	});
	const firstItems = itemsFromResponse<any>(first.data);
	const pageCount = pageCountFromResponse(first.data) ?? 1;
	const resultCount = resultCountFromResponse(first.data) ?? firstItems.length;
	const items = [...firstItems];

	for (let page = 2; page <= pageCount; page += 1) {
		const response = await fetchMyExpensesPage(client, {
			...params,
			page,
			pageSize,
		});
		items.push(...itemsFromResponse<any>(response.data));
	}

	return {
		items,
		pageCount,
		resultCount,
		partial: items.length < resultCount,
	};
}

function formatUtcDate(date: Date): string {
	return date.toISOString().split("T")[0];
}

function isValidIsoDate(value: string): boolean {
	if (!ISO_DATE_PATTERN.test(value)) {
		return false;
	}

	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.getTime()) && formatUtcDate(parsed) === value;
}

function compareIsoDates(left: string, right: string): number {
	return left.localeCompare(right);
}

function toNumberOrNull(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const numeric = typeof value === "number" ? value : Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

function textIncludesAny(value: unknown, terms: string[]): boolean {
	const haystack = String(value ?? "").toLowerCase();
	return terms.some((term) => haystack.includes(term.toLowerCase()));
}

function detailDate(detail: any): string | null {
	return detail?.expenseDate ?? detail?.date ?? null;
}

function firstPresent<T>(...values: Array<T | null | undefined>): T | null {
	for (const value of values) {
		if (value !== null && value !== undefined) return value;
	}
	return null;
}

function detailAmount(detail: any): number | null {
	return firstPresent(
		toNumberOrNull(detail?.expenseAmount),
		toNumberOrNull(detail?.amount),
		toNumberOrNull(detail?.reimbursableAmount),
	);
}

function expenseMatchesRange(
	expense: any,
	startDate?: string,
	endDate?: string,
): boolean {
	if (!startDate && !endDate) return true;
	const dates = [
		expense?.postDate,
		expense?.createdDate?.slice?.(0, 10),
		...(expense?.expenseDetails ?? []).map(detailDate),
	].filter(Boolean) as string[];

	if (dates.length === 0) return true;

	return dates.some((date) => {
		if (startDate && compareIsoDates(date, startDate) < 0) return false;
		if (endDate && compareIsoDates(date, endDate) > 0) return false;
		return true;
	});
}

function summarizeAllocation(allocation: any) {
	return {
		key: allocation?.key ?? null,
		projectKey: allocation?.project?.key ?? allocation?.projectKey ?? null,
		projectCode:
			allocation?.project?.code ?? allocation?.project?.projectCode ?? null,
		projectName:
			allocation?.project?.name ?? allocation?.project?.title ?? null,
		taskKey: allocation?.task?.key ?? allocation?.taskKey ?? null,
		taskName: allocation?.task?.name ?? null,
		allocation: toNumberOrNull(allocation?.allocation),
	};
}

export function summarizeDetail(detail: any) {
	const expenseType = firstPresent(
		detail?.expenseType?.expenseTypeName,
		detail?.expenseType?.name,
		detail?.expenseTypeName,
	);
	const paymentMethod = firstPresent(
		detail?.paymentMethod?.paymentMethodCode,
		detail?.paymentMethod?.description,
	);

	return {
		key: detail?.key ?? null,
		sequence: detail?.sequence ?? null,
		expenseDate: detailDate(detail),
		expenseType,
		expenseTypeKey: firstPresent(
			detail?.expenseType?.key,
			detail?.expenseTypeKey,
		),
		paymentMethod,
		paymentMethodKey: firstPresent(
			detail?.paymentMethod?.key,
			detail?.paymentMethodKey,
		),
		amount: toNumberOrNull(detail?.amount),
		expenseAmount: toNumberOrNull(detail?.expenseAmount),
		vendorName: detail?.vendorName ?? null,
		summary: detail?.summary ?? null,
		comments: detail?.comments ?? null,
		receiptIncluded: detail?.receiptIncluded ?? null,
	};
}

export function summarizeExpense(expense: any) {
	const details = expense?.expenseDetails ?? [];
	return {
		key: expense?.key ?? null,
		purpose: expense?.purpose ?? null,
		location: expense?.location ?? null,
		status: expense?.status ?? null,
		voucherType: expense?.voucherType ?? null,
		createdDate: expense?.createdDate ?? null,
		postDate: expense?.postDate ?? null,
		totalExpenses: toNumberOrNull(expense?.totalExpenses),
		reimbursableAmount: toNumberOrNull(expense?.reimbursableAmount),
		expenseCurrencyCode:
			expense?.expenseCurrencyCode ?? expense?.currency?.code ?? null,
		attachmentCount: expense?.attachmentCount ?? null,
		projectAllocations: (expense?.expenseProjectAllocations ?? []).map(
			summarizeAllocation,
		),
		detailCount: details.length,
		details: details.map(summarizeDetail),
	};
}

function expenseText(expense: any): string {
	const details = expense?.expenseDetails ?? [];
	return [
		expense?.purpose,
		expense?.location,
		...(expense?.expenseProjectAllocations ?? []).flatMap((allocation: any) => [
			allocation?.project?.code,
			allocation?.project?.name,
			allocation?.project?.title,
			allocation?.task?.name,
		]),
		...details.flatMap((detail: any) => [
			detail?.summary,
			detail?.comments,
			detail?.vendorName,
			detail?.expenseType?.expenseTypeName,
			detail?.expenseType?.name,
		]),
	]
		.filter(Boolean)
		.join(" ");
}

function matchedLineItems(
	expense: any,
	terms: string[],
	startDate?: string,
	endDate?: string,
) {
	return (expense?.expenseDetails ?? [])
		.filter((detail: any) => {
			const date = detailDate(detail);
			if (date && startDate && compareIsoDates(date, startDate) < 0)
				return false;
			if (date && endDate && compareIsoDates(date, endDate) > 0) return false;
			const detailText = [
				expense?.purpose,
				detail?.summary,
				detail?.comments,
				detail?.vendorName,
				detail?.expenseType?.expenseTypeName,
				detail?.expenseType?.name,
			]
				.filter(Boolean)
				.join(" ");
			return textIncludesAny(detailText, terms);
		})
		.map((detail: any) => ({
			expenseKey: expense?.key ?? null,
			expensePurpose: expense?.purpose ?? null,
			status: expense?.status ?? null,
			...summarizeDetail(detail),
			matchedAmount: detailAmount(detail),
		}));
}

// ValidationItemModel is { projectKey, taskKey, violations[] } and
// WizardValidationItemModel carries { expenseDate, expenseTypeName, ... }; keep
// the text and where it applies instead of String()-ing the object.
function describeValidationItem(item: any): string {
	if (typeof item === "string") return item;
	if (item === null || typeof item !== "object") return String(item);
	const where = [
		item.projectKey !== undefined ? `project ${item.projectKey}` : null,
		item.taskKey !== undefined && item.taskKey !== null ? `task ${item.taskKey}` : null,
		item.expenseTypeName,
		item.expenseDate,
	]
		.filter(Boolean)
		.join(", ");
	const what = [
		...(Array.isArray(item.violations) ? item.violations : []),
		item.message,
		item.description,
	]
		.filter(Boolean)
		.join("; ");
	return [where && `(${where})`, what].filter(Boolean).join(" ") || JSON.stringify(item);
}

export function normalizeErrors(validation: any): string[] {
	return [
		...(validation?.expenseReportErrors ?? []),
		...(validation?.expenseErrors ?? []),
		...(validation?.wizardErrors ?? []),
		...(validation?.wizardReceiptErrors ?? []),
	].map(describeValidationItem);
}

export function normalizeWarnings(validation: any): string[] {
	return [
		...(validation?.expenseReportWarnings ?? []),
		...(validation?.expenseWarnings ?? []),
		...(validation?.wizardWarnings ?? []),
	].map(describeValidationItem);
}

function compactParams(
	params: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(params).filter(
			([, value]) => value !== undefined && value !== null && value !== "",
		),
	);
}

function optionalGet(
	client: ReturnType<typeof createUnanetClient>,
	enabled: boolean,
	path: string,
	params: Record<string, unknown>,
): Promise<{ data: any }> | { data: any } {
	if (!enabled) return { data: { items: [] } };
	return client.get(path, { params: compactParams(params) });
}

async function referenceDataRequest(
	label: string,
	request: Promise<{ data: any }> | { data: any },
): Promise<{ label: string; data: any; error: string | null }> {
	try {
		const response = await request;
		return { label, data: response.data, error: null };
	} catch (error: any) {
		return { label, data: { items: [] }, error: error.message };
	}
}

const dateRangeShape = {
	startDate: z
		.string()
		.refine(isValidIsoDate, "startDate must be a valid YYYY-MM-DD date")
		.optional(),
	endDate: z
		.string()
		.refine(isValidIsoDate, "endDate must be a valid YYYY-MM-DD date")
		.optional(),
};

// Cross-field validation: startDate must be on or before endDate.
// Applied via superRefine on a single flattened object so the generated
// JSON Schema root stays `type: "object"` (a top-level `allOf` from
// z.intersection breaks Claude Desktop's connector tool-list renderer).
function refineDateRange(
	value: { startDate?: string; endDate?: string },
	context: z.RefinementCtx,
) {
	if (
		value.startDate &&
		value.endDate &&
		compareIsoDates(value.startDate, value.endDate) > 0
	) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["startDate"],
			message: "startDate must be on or before endDate",
		});
	}
}

export const allocationInputSchema = z.object({
	projectKey: z.number().int().positive(),
	taskKey: z.number().int().positive().optional(),
	allocation: z.number().positive().max(100),
});

export const wizardSchema = z
	.object({
		type: z.string().min(1),
	})
	.passthrough();

export function assertAllocationsTotal100(
	allocations: Array<z.infer<typeof allocationInputSchema>>,
) {
	const total = allocations.reduce(
		(sum, allocation) => sum + allocation.allocation,
		0,
	);
	if (Math.abs(total - 100) > 0.001) {
		throw new Error("expenseProjectAllocations must total 100 percent");
	}
}

export const getMyExpensesTool = {
	name: "unanet_get_my_expenses",
	description:
		"Read your Unanet expense reports and return minimized report/detail fields. This is read-only.",
	inputSchema: z
		.object({
			...dateRangeShape,
			status: expenseStatusSchema
				.or(z.literal("All"))
				.optional()
				.default("All"),
			voucherType: z
				.enum(["EXPENSE_REPORT", "EXPENSE_REQUEST"])
				.optional()
				.default("EXPENSE_REPORT"),
			pageSize: z.number().int().min(1).max(100).optional().default(50),
		})
		.superRefine(refineDateRange),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const pageSize = args.pageSize ?? 50;
			const voucherType = args.voucherType ?? "EXPENSE_REPORT";
			const client = createUnanetClient(auth);
			const result = await fetchAllMyExpenses(client, {
				pageSize,
				voucherType,
				...(args.status && args.status !== "All"
					? { status: args.status }
					: {}),
			});
			const expenses = result.items
				.filter((expense) =>
					expenseMatchesRange(expense, args.startDate, args.endDate),
				)
				.map(summarizeExpense);

			return {
				success: true,
				count: expenses.length,
				resultCount: result.resultCount,
				pageCount: result.pageCount,
				partial: result.partial,
				expenses,
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	},
};

export const getPersonalDevelopmentFundStatusTool = {
	name: "unanet_get_personal_development_fund_status",
	description:
		"Estimate personal/professional development spending from your Unanet expense reports. Remaining balance is only calculated when a budget amount is provided.",
	inputSchema: z
		.object({
			...dateRangeShape,
			annualBudget: z.number().positive().optional(),
			matchTerms: z
				.array(z.string().min(1))
				.optional()
				.default([
					"personal development",
					"professional development",
					"development fund",
					"learning",
					"training",
					"conference",
					"certification",
					"course",
				]),
			statuses: z
				.array(expenseStatusSchema)
				.optional()
				.default([...reimbursableStatuses]),
			pageSize: z.number().int().min(1).max(100).optional().default(100),
		})
		.superRefine(refineDateRange),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const pageSize = args.pageSize ?? 100;
			const matchTerms = args.matchTerms ?? [
				"personal development",
				"professional development",
				"development fund",
				"learning",
				"training",
				"conference",
				"certification",
				"course",
			];
			const statuses = args.statuses ?? [...reimbursableStatuses];
			const client = createUnanetClient(auth);
			const result = await fetchAllMyExpenses(client, {
				pageSize,
				voucherType: "EXPENSE_REPORT",
			});
			const expenses = result.items.filter(
				(expense) =>
					statuses.includes(expense?.status) &&
					expenseMatchesRange(expense, args.startDate, args.endDate) &&
					textIncludesAny(expenseText(expense), matchTerms),
			);
			const lineItems = expenses.flatMap((expense) =>
				matchedLineItems(expense, matchTerms, args.startDate, args.endDate),
			);
			const totalSpent =
				lineItems.length > 0
					? lineItems.reduce((sum, item) => sum + (item.matchedAmount ?? 0), 0)
					: expenses.reduce(
							(sum, expense) =>
								sum +
								(toNumberOrNull(expense?.reimbursableAmount) ??
									toNumberOrNull(expense?.totalExpenses) ??
									0),
							0,
						);

			return {
				success: true,
				basis:
					"Unanet expense-report history matched by purpose/detail text. This does not prove the official remaining allowance unless annualBudget is provided.",
				matchTerms,
				count: expenses.length,
				resultCount: result.resultCount,
				pageCount: result.pageCount,
				partial: result.partial,
				totalSpent,
				annualBudget: args.annualBudget ?? null,
				remainingBudget: args.annualBudget
					? args.annualBudget - totalSpent
					: null,
				lineItems,
				expenses: expenses.map(summarizeExpense),
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	},
};

export const getMyExpenseReportTool = {
	name: "unanet_get_my_expense_report",
	description:
		"Read one of your Unanet expense reports, optionally including validation results.",
	inputSchema: z.object({
		expenseId: z.number().int().positive(),
		includeValidation: z.boolean().optional().default(false),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const [expenseResponse, validationResponse] = await Promise.all([
				client.get(`/me/expenses/${args.expenseId}`),
				args.includeValidation
					? client
							.get(`/me/expenses/${args.expenseId}/validate`)
							.catch((error) => ({
								data: { error: error.message },
							}))
					: Promise.resolve(null),
			]);

			return {
				success: true,
				expense: summarizeExpense(expenseResponse.data),
				validation: validationResponse ? validationResponse.data : null,
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	},
};

export const getExpenseReferenceDataTool = {
	name: "unanet_get_expense_reference_data",
	description:
		"Read Unanet expense types, payment methods, and currency codes needed before drafting expense reports.",
	inputSchema: z.object({
		search: z.string().optional(),
		includeExpenseTypes: z.boolean().optional().default(true),
		includePaymentMethods: z.boolean().optional().default(true),
		includeCurrencies: z.boolean().optional().default(true),
		pageSize: z.number().int().min(1).max(100).optional().default(100),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const pageSize = args.pageSize ?? 100;
			const includeExpenseTypes = args.includeExpenseTypes ?? true;
			const includePaymentMethods = args.includePaymentMethods ?? true;
			const includeCurrencies = args.includeCurrencies ?? true;
			const client = createUnanetClient(auth);
			const [expenseTypes, paymentMethods, currencies] = await Promise.all([
				referenceDataRequest(
					"expenseTypes",
					optionalGet(client, includeExpenseTypes, "/expense-types", {
						page: 1,
						pageSize,
						name: args.search,
						enabled: true,
					}),
				),
				referenceDataRequest(
					"paymentMethods",
					optionalGet(client, includePaymentMethods, "/payment-methods", {
						page: 1,
						pageSize,
						activeOnly: true,
					}),
				),
				referenceDataRequest(
					"currencies",
					optionalGet(client, includeCurrencies, "/currencies/currency-codes", {
						page: 1,
						pageSize,
						currencyCode: args.search,
					}),
				),
			]);

			const endpointErrors = [expenseTypes, paymentMethods, currencies]
				.filter((result) => result.error)
				.map((result) => ({ endpoint: result.label, error: result.error }));

			return {
				success: endpointErrors.length < 3,
				endpointErrors,
				expenseTypes: itemsFromResponse<any>(expenseTypes.data).map((type) => ({
					key: type.key,
					name: type.name ?? type.expenseTypeName,
					code: type.code ?? type.expenseType,
					wizardType: type.wizardType ?? null,
					receiptRequired: type.receiptRequired ?? null,
				})),
				paymentMethods: itemsFromResponse<any>(paymentMethods.data).map(
					(method) => ({
						key: method.key,
						code: method.paymentMethodCode,
						description: method.description ?? null,
						reimbursable: method.reimbursable ?? null,
						active: method.active ?? null,
					}),
				),
				currencies: itemsFromResponse<any>(currencies.data).map((currency) => ({
					key: currency.key,
					code: currency.code,
					name: currency.name,
					decimals: currency.decimals ?? null,
				})),
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	},
};

export const createExpenseReportDraftTool = {
	name: "unanet_create_expense_report_draft",
	description:
		"Create a draft Unanet expense report shell. This writes to Unanet and never submits the report.",
	inputSchema: z.object({
		confirm: z
			.literal(true)
			.describe("Must be true to create a live draft expense report."),
		purpose: z.string().min(1),
		location: z.string().optional(),
		voucherType: z
			.enum(["EXPENSE_REPORT", "EXPENSE_REQUEST"])
			.optional()
			.default("EXPENSE_REPORT"),
		expenseProjectAllocations: z.array(allocationInputSchema).min(1),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		if (args.confirm !== true) {
			return { success: false, error: "confirm=true is required before creating a draft expense report." };
		}
		try {
			assertAllocationsTotal100(args.expenseProjectAllocations);
			const client = createUnanetClient(auth);
			const response = await client.post("/me/expenses", {
				purpose: args.purpose,
				location: args.location,
				voucherType: args.voucherType,
				expenseProjectAllocations: args.expenseProjectAllocations,
			});
			const expenseId = response.data?.key;
			const expense = expenseId
				? await client
						.get(`/me/expenses/${expenseId}`)
						.then((detail) => summarizeExpense(detail.data))
						.catch(() => null)
				: null;

			return {
				success: true,
				expenseId,
				expense,
				message:
					"Draft expense report created. Review and submit manually in Unanet when ready.",
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	},
};

export const addExpenseDetailTool = {
	name: "unanet_add_expense_detail",
	description:
		"Add a line item to a draft Unanet expense report. This writes to Unanet and never submits the report.",
	inputSchema: z.object({
		confirm: z
			.literal(true)
			.describe("Must be true to add a live expense detail."),
		expenseId: z.number().int().positive(),
		expenseDate: z
			.string()
			.refine(isValidIsoDate, "expenseDate must be a valid YYYY-MM-DD date"),
		expenseTypeKey: z.number().int().positive(),
		paymentMethodKey: z.number().int().positive(),
		transactionCurrency: z
			.number()
			.int()
			.positive()
			.describe("Currency key, e.g. the USD key from reference data."),
		amount: z.number().positive(),
		expenseAmount: z.number().positive().optional(),
		exchangeRate: z.number().positive().optional().default(1),
		projectAllocationKey: z
			.number()
			.int()
			.positive()
			.describe("Expense project allocation key from the draft report."),
		projectTypeKey: z.number().int().positive().optional(),
		summary: z.string().optional(),
		comments: z.string().optional(),
		vendorName: z.string().optional(),
		receiptIncluded: z.boolean().optional(),
		noReceiptReason: z.string().optional(),
		wizard: wizardSchema.describe(
			"Unanet expense wizard payload, including a discriminator `type`.",
		),
		validateAfterAdd: z.boolean().optional().default(true),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		if (args.confirm !== true) {
			return { success: false, error: "confirm=true is required before adding an expense detail." };
		}
		try {
			const client = createUnanetClient(auth);
			const expenseResponse = await client.get(
				`/me/expenses/${args.expenseId}`,
			);
			if (expenseResponse.data?.status !== "INUSE") {
				return {
					success: false,
					error: `Expense report ${args.expenseId} is not editable; status is ${expenseResponse.data?.status ?? "unknown"}`,
				};
			}

			const body = {
				projectAllocationKey: args.projectAllocationKey,
				expenseTypeKey: args.expenseTypeKey,
				paymentMethodKey: args.paymentMethodKey,
				expenseDate: args.expenseDate,
				amount: args.amount,
				exchangeRate: args.exchangeRate,
				expenseAmount: args.expenseAmount ?? args.amount,
				transactionCurrency: args.transactionCurrency,
				projectTypeKey: args.projectTypeKey,
				summary: args.summary,
				comments: args.comments,
				vendorName: args.vendorName,
				receiptIncluded: args.receiptIncluded,
				noReceiptReason: args.noReceiptReason,
				wizard: args.wizard,
			};
			const response = await client.post(
				`/me/expenses/${args.expenseId}/details`,
				body,
			);
			const validation = args.validateAfterAdd
				? await client
						.get(`/me/expenses/${args.expenseId}/validate`)
						.then((result) => result.data)
						.catch((error) => ({ error: error.message }))
				: null;

			return {
				success: true,
				expenseId: args.expenseId,
				detailId: response.data?.key ?? null,
				validation,
				message:
					"Expense detail added to draft. Review and submit manually in Unanet when ready.",
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	},
};

export const validateExpenseReportTool = {
	name: "unanet_validate_expense_report",
	description: "Validate a draft Unanet expense report without submitting it.",
	inputSchema: z.object({
		expenseId: z.number().int().positive(),
		submitValidation: z.boolean().optional().default(false),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get(
				`/me/expenses/${args.expenseId}/validate`,
				{
					params: { submitValidation: args.submitValidation },
				},
			);
			const errors = normalizeErrors(response.data);
			const warnings = normalizeWarnings(response.data);
			return {
				success: errors.length === 0,
				expenseId: args.expenseId,
				errors,
				warnings,
				validation: response.data,
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	},
};

export const getExpenseAttachmentsTool = {
	name: "unanet_get_expense_attachments",
	description:
		"List the receipt attachments on one of your Unanet expense reports. This is read-only and does not return file bytes.",
	inputSchema: z.object({
		expenseId: z.number().int().positive(),
		pageSize: z.number().int().min(1).max(100).optional().default(100),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const pageSize = args.pageSize ?? 100;
			const client = createUnanetClient(auth);
			const response = await client.get(
				`/me/expenses/${args.expenseId}/attachments`,
				{ params: { page: 1, pageSize } },
			);
			const items = itemsFromResponse<any>(response.data);
			return {
				success: true,
				expenseId: args.expenseId,
				count: items.length,
				resultCount: resultCountFromResponse(response.data) ?? items.length,
				attachments: items.map(summarizeAttachment),
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	},
};

export const addExpenseAttachmentTool = {
	name: "unanet_add_expense_attachment",
	description:
		"Upload a receipt to a draft Unanet expense report. Provide either a local filePath or inline base64 data. Optionally associate it with a specific line via detailId. This writes to Unanet and never submits the report.",
	inputSchema: z
		.object({
			confirm: z
				.literal(true)
				.describe("Must be true to upload a live receipt attachment."),
			expenseId: z.number().int().positive(),
			detailId: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Optional expense detail (line item) key to attach this receipt to."),
			filePath: z
				.string()
				.min(1)
				.optional()
				.describe("Absolute local path to the receipt file to read and upload."),
			data: z
				.string()
				.min(1)
				.optional()
				.describe("Base64-encoded receipt bytes. Use instead of filePath."),
			name: z
				.string()
				.min(1)
				.optional()
				.describe("Attachment file name. Defaults to the filePath basename."),
			mimeType: z
				.string()
				.min(1)
				.optional()
				.describe("MIME type. Inferred from the file extension when omitted."),
		})
		.superRefine((value, context) => {
			if (!value.filePath && !value.data) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["filePath"],
					message: "Provide either filePath or data.",
				});
			}
			if (value.filePath && value.data) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["data"],
					message: "Provide filePath or data, not both.",
				});
			}
			if (value.data && !value.name) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["name"],
					message: "name is required when uploading inline data.",
				});
			}
		}),
	handler: async (args: any, auth: UnanetAuth) => {
		if (args.confirm !== true) {
			return { success: false, error: "confirm=true is required before uploading a receipt attachment." };
		}
		try {
			let base64Data: string;
			let length: number;
			const name = args.name ?? (args.filePath ? basename(args.filePath) : null);
			if (!name) {
				return { success: false, error: "Could not determine attachment name." };
			}

			if (args.filePath) {
				const checked = checkLocalAttachmentPath(args.filePath, "read");
				if (!checked.ok) {
					return { success: false, error: checked.error };
				}
				let buffer: Buffer;
				try {
					buffer = readFileSync(checked.path);
				} catch (readError: any) {
					return {
						success: false,
						error: `Could not read file ${args.filePath}: ${readError.message}`,
					};
				}
				length = buffer.length;
				base64Data = buffer.toString("base64");
			} else {
				base64Data = args.data;
				length = Buffer.from(base64Data, "base64").length;
			}

			if (length === 0) {
				return { success: false, error: "Attachment is empty (0 bytes)." };
			}
			if (length > MAX_ATTACHMENT_BYTES) {
				return {
					success: false,
					error: `Attachment is ${length} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte limit.`,
				};
			}

			const mimeType = args.mimeType ?? inferMimeType(name);
			if (!mimeType) {
				return {
					success: false,
					error: `Could not infer MIME type for "${name}". Pass mimeType explicitly (e.g. application/pdf).`,
				};
			}

			const client = createUnanetClient(auth);
			const expenseResponse = await client.get(
				`/me/expenses/${args.expenseId}`,
			);
			if (expenseResponse.data?.status !== "INUSE") {
				return {
					success: false,
					error: `Expense report ${args.expenseId} is not editable; status is ${expenseResponse.data?.status ?? "unknown"}`,
				};
			}

			const response = await client.post(
				`/me/expenses/${args.expenseId}/attachments`,
				{ name, mimeType, length, data: base64Data },
				args.detailId ? { params: { detailId: args.detailId } } : undefined,
			);
			const postedKey = response.data?.key ?? null;

			// Unanet's write responses are unreliable, so read the attachment list
			// back and confirm the upload actually landed instead of trusting the
			// POST response alone. Match by returned key when present, otherwise
			// fall back to name + byte length.
			let readback: any[] = [];
			let readbackError: string | null = null;
			try {
				const listResponse = await client.get(
					`/me/expenses/${args.expenseId}/attachments`,
					{ params: { page: 1, pageSize: 100 } },
				);
				readback = itemsFromResponse<any>(listResponse.data).map(
					summarizeAttachment,
				);
			} catch (listError: any) {
				readbackError = listError.message;
			}

			const matched =
				postedKey !== null
					? readback.find((a) => a.key === postedKey)
					: readback.find(
							(a) => a.name === name && a.length === length,
						);
			const verified = Boolean(matched);
			const attachmentId = matched?.key ?? postedKey;

			return {
				success: true,
				verified,
				expenseId: args.expenseId,
				attachmentId,
				name,
				mimeType,
				length,
				detailId: args.detailId ?? null,
				readbackError,
				attachmentsOnReport: readback.length,
				message: verified
					? `Receipt uploaded and confirmed present on the report${
							args.detailId ? " (associated with the line item)" : ""
						}. Review and submit manually in Unanet when ready.`
					: `Upload POST succeeded but read-back could NOT confirm the attachment on the report${
							readbackError ? ` (list failed: ${readbackError})` : ""
						}. Verify manually in Unanet before relying on it.`,
			};
		} catch (error: any) {
			return { success: false, error: error.message };
		}
	},
};
