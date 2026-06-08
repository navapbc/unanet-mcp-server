import { z } from "zod";
import {
	createPlatformRestClient,
	getPlatformBearerToken,
	type UnanetAuth,
} from "../auth.js";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const flexibleNumberSchema = z
	.union([z.number(), z.string(), z.null()])
	.optional();

const platformLeaveItemSchema = z
	.object({
		project: z
			.object({
				name: z.string().optional(),
			})
			.passthrough()
			.optional(),
		task: z
			.object({
				name: z.string().optional(),
			})
			.passthrough()
			.nullable()
			.optional(),
		budget: flexibleNumberSchema,
		actuals: flexibleNumberSchema,
	})
	.passthrough();

const platformLeaveResponseSchema = z
	.object({
		items: z.array(platformLeaveItemSchema).optional(),
		message: z
			.object({
				items: z.array(platformLeaveItemSchema).optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough()
	.refine((value) => value.items || value.message?.items, {
		message: "Leave response must include items",
	});

function formatDate(date: Date): string {
	return date.toISOString().split("T")[0];
}

function defaultEndDate(): string {
	return formatDate(new Date());
}

function defaultStartDate(endDate: string): string {
	const end = new Date(`${endDate}T00:00:00.000Z`);
	return formatDate(new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000));
}

function isValidIsoDate(value: string): boolean {
	if (!ISO_DATE_PATTERN.test(value)) {
		return false;
	}

	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.getTime()) && formatDate(parsed) === value;
}

function compareIsoDates(left: string, right: string): number {
	return left.localeCompare(right);
}

function toNumberOrNull(value: unknown): number | null {
	if (value === null || value === undefined || value === "") {
		return null;
	}

	const numeric = typeof value === "number" ? value : Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

function displayLeaveName(
	item: z.infer<typeof platformLeaveItemSchema>,
): string {
	const projectName = item.project?.name;
	const taskName = item.task?.name;

	if (projectName && taskName) {
		return `${projectName} / ${taskName}`;
	}

	return projectName || taskName || "Unknown leave type";
}

export const leaveBalanceInputSchema = z
	.object({
		startDate: z
			.string()
			.refine(isValidIsoDate, "startDate must be a valid YYYY-MM-DD date")
			.optional()
			.describe(
				"Optional start date in YYYY-MM-DD format. Defaults to 14 days before endDate.",
			),
		endDate: z
			.string()
			.refine(isValidIsoDate, "endDate must be a valid YYYY-MM-DD date")
			.optional()
			.describe("Optional end date in YYYY-MM-DD format. Defaults to today."),
		pageSize: z
			.number()
			.int()
			.min(1)
			.max(100)
			.optional()
			.default(50)
			.describe("Number of leave records to request, between 1 and 100."),
	})
	.superRefine((value, context) => {
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
	});

export const getMyLeaveBalancesTool = {
	name: "unanet_get_my_leave_balances",
	description:
		"Read your Nava Unanet leave balances for a date range. This tool is read-only and returns minimized fields.",
	inputSchema: leaveBalanceInputSchema,
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const endDate = args.endDate || defaultEndDate();
			const startDate = args.startDate || defaultStartDate(endDate);

			if (compareIsoDates(startDate, endDate) > 0) {
				return {
					success: false,
					error: "startDate must be on or before endDate",
				};
			}

			const token = await getPlatformBearerToken(auth);
			const client = createPlatformRestClient(auth, token);
			const response = await client.post(
				"/platform/rest/me/leave",
				{
					dateRange: {
						rangeStart: startDate,
						rangeEnd: endDate,
					},
				},
				{
					params: {
						page: 1,
						pageSize: args.pageSize,
					},
				},
			);

			const parsed = platformLeaveResponseSchema.safeParse(response.data);
			if (!parsed.success) {
				return {
					success: false,
					error: "Unexpected Unanet leave-balance response shape",
				};
			}

			const leaveItems = parsed.data.items ?? parsed.data.message?.items ?? [];
			const leaveBalances = leaveItems.map((item) => ({
				name: displayLeaveName(item),
				projectName: item.project?.name ?? null,
				taskName: item.task?.name ?? null,
				reportedBudgetHours: toNumberOrNull(item.budget),
				reportedActualHours: toNumberOrNull(item.actuals),
			}));

			return {
				success: true,
				range: {
					startDate,
					endDate,
				},
				count: leaveBalances.length,
				leaveBalances,
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};
