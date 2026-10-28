#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
	type UnanetAuth,
	isEnabled,
} from "./auth.js";
import { loadConfig, loadEnvFile, setupAdvice } from "./config.js";
import {
	getProjectsTool,
	getProjectDetailsTool,
	updateProjectBudgetTool,
	getProjectStatusTool,
} from "./tools/projects.js";
import {
	createTimesheetTool,
	updateTimesheetTool,
	editTimeslipTool,
	deleteTimeslipTool,
	submitTimesheetForApprovalTool,
	getTimesheetsTool,
	getMyTimesheetProjectsTool,
	approveTimesheetTool,
} from "./tools/timesheet.js";
import {
	getTimePeriodsTool,
	listMyTimesheetsTool,
	getTimesheetHistoryTool,
	getTimesheetAdjustmentsTool,
	getTimesheetAttachmentsTool,
	getTimesheetAttachmentTool,
	deleteTimesheetTool,
	addTimesheetAttachmentTool,
	deleteTimesheetAttachmentTool,
	setTimesheetAdjustmentReasonsTool,
} from "./tools/timesheet-lifecycle.js";
import {
	getMyExpensesTool,
	getPersonalDevelopmentFundStatusTool,
	getMyExpenseReportTool,
	getExpenseReferenceDataTool,
	createExpenseReportDraftTool,
	addExpenseDetailTool,
	validateExpenseReportTool,
	getExpenseAttachmentsTool,
	addExpenseAttachmentTool,
} from "./tools/expenses.js";
import {
	updateExpenseReportTool,
	deleteExpenseReportTool,
	getExpenseDetailTool,
	updateExpenseDetailTool,
	deleteExpenseDetailTool,
	getExpenseHistoryTool,
	getExpenseMealCapsTool,
	getExpenseAttachmentTool,
	deleteExpenseAttachmentTool,
	getApprovedExpenseRequestsTool,
	searchImportedExpensesTool,
	addImportedExpenseToReportTool,
	submitExpenseReportTool,
} from "./tools/expense-lifecycle.js";
import { getMyLeaveBalancesTool } from "./tools/leave.js";
import {
	getMyLeaveRequestsTool,
	getLeaveRequestHistoryTool,
	createLeaveRequestTool,
	updateLeaveRequestTool,
	submitLeaveRequestTool,
	cancelLeaveRequestTool,
	deleteLeaveRequestTool,
} from "./tools/leave-requests.js";
import {
	getMyPendingApprovalsTool,
	getApprovalDetailTool,
	getApprovalAlternatesTool,
	approveTool,
	disapproveTool,
} from "./tools/approvals.js";
import { getMyPendingReviewsTool, completeReviewTool } from "./tools/reviews.js";
import {
	getMyProjectsListTool,
	searchAvailableProjectsTool,
	addToMyProjectsTool,
	removeFromMyProjectsTool,
	getMyRatesTool,
	getMyAlternatesTool,
	updateMyAlternatesTool,
	getMyAttachmentsTool,
	addMyAttachmentTool,
	deleteMyAttachmentTool,
} from "./tools/user.js";
import {
	createContactTool,
	updateLeadTool,
	createOpportunityTool,
	getCompanyInfoTool,
} from "./tools/contacts.js";
import {
	getBillingStatusTool,
	generateInvoiceTool,
	getFinancialReportTool,
} from "./tools/financials.js";
import {
	searchPeopleTool,
	getPersonTool,
	searchOrganizationsTool,
	getOrganizationTool,
	searchContractsTool,
	getContractTool,
	getProjectTasksTool,
	getProjectAssignmentsTool,
	getProjectNotesTool,
	getProjectAdminsTool,
	searchInvoicesTool,
	getInvoiceTool,
	getReferenceDataTool,
	pingTool,
} from "./tools/directory.js";
import { assignPeopleToProjectTool } from "./tools/project-assignments.js";
import {
	searchApiOperationsTool,
	describeApiOperationTool,
	apiReadTool,
} from "./tools/api.js";
import {
	projectListResource,
	timesheetTemplatesResource,
} from "./resources/reports.js";

// Server metadata
const SERVER_NAME = "unanet-mcp-server";
const SERVER_VERSION = "1.0.0";

// Credentials come from the repository's .env (found next to the code, not in
// the client's working directory) or from the client's environment.
const envFile = loadEnvFile();
const config = loadConfig();

// Extended (org-level) reads: projects, people, organizations, contracts,
// invoices, reference data and the spec-driven API reader. Opt-in only.
const enableExtendedReadTools = isEnabled(
	process.env.UNANET_ENABLE_EXTENDED_READ_TOOLS,
);
if (process.env.UNANET_ENABLE_LEGACY_READ_TOOLS !== undefined) {
	console.error(
		`[${SERVER_NAME}] UNANET_ENABLE_LEGACY_READ_TOOLS is no longer supported and has no effect. Set UNANET_ENABLE_EXTENDED_READ_TOOLS=true to enable org-level reads.`,
	);
}
const enableWriteTools = isEnabled(process.env.UNANET_ENABLE_WRITE_TOOLS);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// With a broken configuration the server still starts, offering only
// unanet_setup_status, so the assistant sees what is wrong instead of finding
// no Unanet tools at all (which led assistants to open the Unanet website in a
// browser instead).
const auth: UnanetAuth | null = config.ok ? config.auth : null;
if (config.ok) {
	console.error(`[${SERVER_NAME}] Authentication configured successfully`);
} else {
	console.error(
		`[${SERVER_NAME}] Configuration error: ${config.problem} (env file: ${envFile.path}${envFile.exists ? "" : ", not found"}). Starting in setup mode with unanet_setup_status only.`,
	);
}

const setupStatusTool = {
	name: "unanet_setup_status",
	description:
		"The Unanet connector is installed but not configured, so no Unanet data tools are available. Call this to get the exact problem and the fix, then tell the user. Do not open the Unanet website in a browser instead.",
	inputSchema: z.object({}),
	handler: async () => ({
		success: false,
		configured: false,
		problem: config.ok ? null : config.problem,
		envFile: envFile.path,
		envFileExists: envFile.exists,
		baseUrl: config.ok ? null : config.baseUrl,
		howToFix: setupAdvice(envFile),
	}),
};

const SERVER_INSTRUCTIONS = config.ok
	? "Unanet (Nava's ERP: timesheets, expenses, leave, projects) is reached through these unanet_* tools, which act as the signed-in user with their own Unanet permissions. Use them for anything about Unanet; do not open the Unanet website in a browser."
	: "The Unanet connector is not configured yet. Call unanet_setup_status and walk the user through the fix it returns. Do not open the Unanet website in a browser instead.";

// Initialize server
const server = new Server(
	{
		name: SERVER_NAME,
		version: SERVER_VERSION,
	},
	{
		capabilities: {
			resources: {},
			tools: {},
		},
		instructions: SERVER_INSTRUCTIONS,
	},
);

// Tier 1 (default): self-service reads. Everything here is scoped to the
// authenticated user's own records (or queues they own as an approver).
const selfServiceReadTools = [
	// Leave
	getMyLeaveBalancesTool,
	getMyLeaveRequestsTool,
	getLeaveRequestHistoryTool,
	// Expenses
	getMyExpensesTool,
	getPersonalDevelopmentFundStatusTool,
	getMyExpenseReportTool,
	getExpenseReferenceDataTool,
	validateExpenseReportTool,
	getExpenseAttachmentsTool,
	getExpenseAttachmentTool,
	getExpenseDetailTool,
	getExpenseHistoryTool,
	getExpenseMealCapsTool,
	getApprovedExpenseRequestsTool,
	searchImportedExpensesTool,
	// Time
	getTimesheetsTool,
	listMyTimesheetsTool,
	getMyTimesheetProjectsTool,
	getTimePeriodsTool,
	getTimesheetHistoryTool,
	getTimesheetAdjustmentsTool,
	getTimesheetAttachmentsTool,
	getTimesheetAttachmentTool,
	// Approvals & reviews (queues addressed to me)
	getMyPendingApprovalsTool,
	getApprovalDetailTool,
	getApprovalAlternatesTool,
	getMyPendingReviewsTool,
	// User
	getMyProjectsListTool,
	searchAvailableProjectsTool,
	getMyRatesTool,
	getMyAlternatesTool,
	getMyAttachmentsTool,
	pingTool,
];

// Tier 2 (UNANET_ENABLE_EXTENDED_READ_TOOLS): org-level reads.
const extendedReadTools = [
	getProjectsTool,
	getProjectDetailsTool,
	getProjectStatusTool,
	getProjectTasksTool,
	getProjectAssignmentsTool,
	getProjectNotesTool,
	getProjectAdminsTool,
	searchPeopleTool,
	getPersonTool,
	searchOrganizationsTool,
	getOrganizationTool,
	getCompanyInfoTool,
	searchContractsTool,
	getContractTool,
	searchInvoicesTool,
	getInvoiceTool,
	getBillingStatusTool,
	getFinancialReportTool,
	getReferenceDataTool,
	// Generic spec-driven catalog + reader
	searchApiOperationsTool,
	describeApiOperationTool,
	apiReadTool,
];

// Tier 3 (UNANET_ENABLE_WRITE_TOOLS): every write. All require confirm: true.
const mutatingTools = [
	// Time
	updateTimesheetTool,
	editTimeslipTool,
	deleteTimeslipTool,
	submitTimesheetForApprovalTool,
	createTimesheetTool,
	deleteTimesheetTool,
	addTimesheetAttachmentTool,
	deleteTimesheetAttachmentTool,
	setTimesheetAdjustmentReasonsTool,
	// Expenses
	createExpenseReportDraftTool,
	updateExpenseReportTool,
	deleteExpenseReportTool,
	addExpenseDetailTool,
	updateExpenseDetailTool,
	deleteExpenseDetailTool,
	addExpenseAttachmentTool,
	deleteExpenseAttachmentTool,
	addImportedExpenseToReportTool,
	submitExpenseReportTool,
	// Leave
	createLeaveRequestTool,
	updateLeaveRequestTool,
	submitLeaveRequestTool,
	cancelLeaveRequestTool,
	deleteLeaveRequestTool,
	// Approvals & reviews
	approveTool,
	disapproveTool,
	approveTimesheetTool,
	completeReviewTool,
	// User
	addToMyProjectsTool,
	removeFromMyProjectsTool,
	updateMyAlternatesTool,
	addMyAttachmentTool,
	deleteMyAttachmentTool,
	// Project staffing
	assignPeopleToProjectTool,
	// Org-level / legacy
	updateProjectBudgetTool,
	createContactTool,
	updateLeadTool,
	createOpportunityTool,
	generateInvoiceTool,
];

// Tool registration by tier. Without a valid configuration there are no data
// tools; only unanet_setup_status is listed.
const tools = auth
	? [
			...selfServiceReadTools,
			...(enableExtendedReadTools ? extendedReadTools : []),
			...(enableWriteTools ? mutatingTools : []),
		]
	: [];
const listedTools = auth ? tools : [setupStatusTool];

const duplicateToolNames = tools
	.map((tool) => tool.name)
	.filter((name, index, names) => names.indexOf(name) !== index);
if (duplicateToolNames.length > 0) {
	throw new Error(`Duplicate tool names registered: ${duplicateToolNames.join(", ")}`);
}

// Resource definitions. Additional resources are opt-in with the extended read flag.
const resources = auth && enableExtendedReadTools
	? [projectListResource, timesheetTemplatesResource]
	: [];

console.error(
	`[${SERVER_NAME}] Registered ${listedTools.length} tool(s); extended reads: ${enableExtendedReadTools}; write tools: ${enableWriteTools}`,
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
	return {
		tools: listedTools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: zodToJsonSchema(tool.inputSchema),
		})),
	};
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;

	if (!auth) {
		if (name !== setupStatusTool.name) {
			throw new Error(`Tool not found: ${name}. The Unanet connector is not configured; call ${setupStatusTool.name}.`);
		}
		return { content: [{ type: "text", text: JSON.stringify(await setupStatusTool.handler(), null, 2) }] };
	}

	const tool = tools.find((t) => t.name === name);
	if (!tool) {
		throw new Error(`Tool not found: ${name}`);
	}

	try {
		// Validate input
		const validatedArgs = tool.inputSchema.parse(args);

		// Execute tool with authentication
		const result = await tool.handler(validatedArgs, auth);

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(result, null, 2),
				},
			],
		};
	} catch (error) {
		if (error instanceof z.ZodError) {
			throw new Error(
				`Invalid arguments: ${error.errors.map((e) => e.message).join(", ")}`,
			);
		}
		throw error;
	}
});

// Handle list resources request
server.setRequestHandler(ListResourcesRequestSchema, async () => {
	return {
		resources: resources.map((resource) => ({
			uri: resource.uri,
			name: resource.name,
			description: resource.description,
			mimeType: resource.mimeType,
		})),
	};
});

// Handle read resource request
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
	const { uri } = request.params;

	const resource = resources.find((r) => r.uri === uri);
	if (!resource) {
		throw new Error(`Resource not found: ${uri}`);
	}

	if (!auth) throw new Error("The Unanet connector is not configured.");
	const content = await resource.handler(auth);

	return {
		contents: [
			{
				uri,
				mimeType: resource.mimeType,
				text: JSON.stringify(content, null, 2),
			},
		],
	};
});

// Start server
async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`[${SERVER_NAME}] Server started successfully`);
}

main().catch((error) => {
	console.error(`[${SERVER_NAME}] Fatal error: ${errorMessage(error)}`);
	process.exit(1);
});
