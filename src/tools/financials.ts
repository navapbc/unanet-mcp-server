import { z } from "zod";
import { type UnanetAuth, createUnanetClient } from "../auth.js";

function itemsFromResponse<T>(data: any): T[] {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.items)) return data.items;
	if (Array.isArray(data?.message?.items)) return data.message.items;
	if (Array.isArray(data?.content)) return data.content;
	return [];
}

// Get billing status tool
export const getBillingStatusTool = {
	name: "unanet_get_billing_status",
	description:
		"Get billing-adjacent project invoice setup and accounts from Platform REST",
	inputSchema: z.object({
		projectId: z.string().describe("The ID/key of the project"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const client = createUnanetClient(auth);

		try {
			const [invoiceSetup, accounts] = await Promise.all([
				client
					.get(`/projects/${args.projectId}/invoice-setup`)
					.catch((error) => ({
						data: { error: error.message },
					})),
				client.get(`/projects/${args.projectId}/accounts`).catch((error) => ({
					data: { error: error.message },
				})),
			]);

			return {
				success: true,
				projectId: args.projectId,
				billing: {
					invoiceSetup: invoiceSetup.data,
					accounts: accounts.data,
				},
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};

// Generate invoice tool
export const generateInvoiceTool = {
	name: "unanet_generate_invoice",
	description:
		"Unsupported as a safe generic write: Platform REST exposes invoice search/submit/complete, but not the legacy /invoices/generate endpoint.",
	inputSchema: z.object({
		projectId: z.string().describe("The ID of the project"),
		periodStart: z
			.string()
			.describe("Start date for the invoice period (YYYY-MM-DD)"),
		periodEnd: z
			.string()
			.describe("End date for the invoice period (YYYY-MM-DD)"),
		includeExpenses: z.boolean().optional().default(true),
		notes: z.string().optional(),
	}),
	handler: async (args: any, _auth: UnanetAuth) => ({
		success: false,
		projectId: args.projectId,
		error:
			"Platform REST OpenAPI does not expose /invoices/generate. Use invoice search plus explicit submit/complete flows after selecting an existing invoice key.",
	}),
};

// Get financial report tool
export const getFinancialReportTool = {
	name: "unanet_get_financial_report",
	description:
		"Retrieve invoice-oriented financial data via Platform REST invoice search",
	inputSchema: z.object({
		reportType: z.enum([
			"ProjectProfitability",
			"CashFlow",
			"RevenueRecognition",
			"BudgetVsActual",
			"ARAgingSummary",
			"UtilizationReport",
		]),
		startDate: z.string().describe("Report start date (YYYY-MM-DD)"),
		endDate: z.string().describe("Report end date (YYYY-MM-DD)"),
		projectId: z
			.string()
			.optional()
			.describe("Optional: Filter by specific project"),
		format: z.enum(["json", "summary"]).optional().default("summary"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const client = createUnanetClient(auth);

		try {
			if (args.reportType !== "ARAgingSummary") {
				return {
					success: false,
					error:
						"Generic financial report endpoints are not present in Platform REST OpenAPI. Currently only invoice search data is available through this tool.",
					reportType: args.reportType,
				};
			}

			const response = await client.post(
				"/invoices/search",
				{
					invoiceDate: {
						start: args.startDate,
						end: args.endDate,
					},
				},
				{ params: { page: 1, pageSize: 50 } },
			);
			const invoices = itemsFromResponse<any>(response.data);

			if (args.format === "summary") {
				return {
					success: true,
					reportType: args.reportType,
					period: `${args.startDate} to ${args.endDate}`,
					count: invoices.length,
					summary: {
						invoiceCount: invoices.length,
						invoiceNumbers: invoices
							.map((invoice) => invoice.invoiceNumber)
							.filter(Boolean)
							.slice(0, 10),
					},
				};
			}

			return {
				success: true,
				report: {
					reportType: args.reportType,
					period: `${args.startDate} to ${args.endDate}`,
					invoices,
				},
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};
