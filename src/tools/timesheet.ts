import { z } from "zod";
import { type UnanetAuth, createUnanetClient } from "../auth.js";

function itemsFromResponse<T>(data: any): T[] {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.items)) return data.items;
	if (Array.isArray(data?.message?.items)) return data.message.items;
	if (Array.isArray(data?.content)) return data.content;
	return [];
}

const statusMap: Record<string, string> = {
	Draft: "INUSE",
	Submitted: "SUBMITTED",
	Approved: "COMPLETED",
	Rejected: "DISAPPROVED",
};

// Submit timesheet tool
export const submitTimesheetTool = {
	name: "unanet_submit_timesheet",
	description:
		"Disabled until Platform REST timeslip row creation is implemented safely.",
	inputSchema: z.object({
		entries: z.array(
			z.object({
				projectId: z.string(),
				taskId: z.string().optional(),
				date: z.string().describe("Date in YYYY-MM-DD format"),
				hours: z.number().positive(),
				description: z.string().optional(),
				billable: z.boolean().default(true),
			}),
		),
	}),
	handler: async (args: any, _auth: UnanetAuth) => {
		return {
			success: false,
			error:
				"Platform REST timesheet writes require updating timeslip rows on an existing timesheet. The legacy submit_timesheet shape would only create a shell timesheet, so this tool is disabled until a safe dedicated implementation is added.",
			requestedEntries: args.entries?.length ?? 0,
		};
	},
};

// Get timesheets tool
export const getTimesheetsTool = {
	name: "unanet_get_timesheets",
	description: "Retrieve timesheets for a date range via Platform REST",
	inputSchema: z.object({
		startDate: z.string().describe("Start date in YYYY-MM-DD format"),
		endDate: z.string().describe("End date in YYYY-MM-DD format"),
		status: z
			.enum(["Draft", "Submitted", "Approved", "Rejected", "All"])
			.optional()
			.default("All"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const client = createUnanetClient(auth);

		try {
			const criteria: Record<string, unknown> = {
				beginDateStart: args.startDate,
				beginDateEnd: args.endDate,
			};
			if (args.status !== "All") {
				criteria.statuses = [statusMap[args.status] ?? args.status];
			}

			const response = await client.post("/me/time/search", criteria, {
				params: { page: 1, pageSize: 50 },
			});
			const timesheets = itemsFromResponse<any>(response.data);

			return {
				success: true,
				count: timesheets.length,
				timesheets: timesheets.map((ts) => ({
					id: ts.id ?? ts.key,
					period: `${ts.periodStart ?? ts.beginDate ?? "unknown"} to ${ts.periodEnd ?? ts.endDate ?? "unknown"}`,
					status: ts.status,
					totalHours: ts.totalHours ?? ts.hours,
					totalBillableHours: ts.totalBillableHours ?? ts.billableHours,
					entries: ts.entries?.length ?? ts.details?.length ?? 0,
				})),
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};

// Submit expense tool
export const submitExpenseTool = {
	name: "unanet_submit_expense",
	description:
		"Create an expense report shell via Platform REST. Project allocation details require Platform-specific keys.",
	inputSchema: z.object({
		projectId: z.string(),
		date: z.string().describe("Date in YYYY-MM-DD format"),
		category: z
			.string()
			.describe("Expense category (e.g., Travel, Meals, Supplies)"),
		amount: z.number().positive(),
		description: z.string(),
		reimbursable: z.boolean().default(true),
	}),
	handler: async (args: any, _auth: UnanetAuth) => {
		return {
			success: false,
			error:
				"Platform REST expense creation requires expenseProjectAllocations with Unanet keys, not the legacy projectId/category/amount shape. This tool needs a dedicated expense-allocation implementation before it can safely write.",
			requestedExpense: args,
		};
	},
};

// Approve timesheet tool
export const approveTimesheetTool = {
	name: "unanet_approve_timesheet",
	description:
		"Approve a submitted manager-approval timesheet via Platform REST",
	inputSchema: z.object({
		timesheetId: z
			.string()
			.describe("The ID/key of the timesheet approval to approve"),
		comments: z.string().optional().describe("Approval comments"),
		confirm: z
			.literal(true)
			.describe("Must be true to confirm this live approval write."),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		if (args.confirm !== true) {
			return {
				success: false,
				error: "confirm=true is required before approving a timesheet.",
			};
		}

		const client = createUnanetClient(auth);

		try {
			await client.post(
				`/me/approvals/time/manager/${args.timesheetId}/approve`,
				{
					comments: args.comments,
				},
			);

			return {
				success: true,
				message: `Timesheet ${args.timesheetId} approved successfully`,
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};
