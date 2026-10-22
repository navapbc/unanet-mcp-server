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
import dotenv from "dotenv";
import {
	DEFAULT_NAVA_UNANET_BASE_URL,
	DEFAULT_UNANET_APP_NAME,
	type UnanetAuth,
	isEnabled,
	validateAuth,
	validateUnanetBaseUrl,
} from "./auth.js";
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

// Load environment variables
dotenv.config();

// Server metadata
const SERVER_NAME = "unanet-mcp-server";
const SERVER_VERSION = "1.0.0";

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
	},
);

const allowInsecureLocalMock = isEnabled(
	process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK,
);
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

function loadAuthFromEnv(): UnanetAuth {
	const normalizedBaseUrl = validateUnanetBaseUrl(
		process.env.UNANET_BASE_URL || DEFAULT_NAVA_UNANET_BASE_URL,
		{ allowInsecureLocalMock },
	);

	return {
		username: process.env.UNANET_USERNAME || "",
		password: process.env.UNANET_PASSWORD || "",
		baseUrl: normalizedBaseUrl,
		appName: process.env.UNANET_APP_NAME || DEFAULT_UNANET_APP_NAME,
		customerId: process.env.UNANET_CUSTOMER_ID || undefined,
	};
}

// Authentication configuration and startup validation.
const auth = (() => {
	try {
		const configuredAuth = loadAuthFromEnv();
		validateAuth(configuredAuth, { allowInsecureLocalMock });
		console.error(`[${SERVER_NAME}] Authentication configured successfully`);
		return configuredAuth;
	} catch (error) {
		console.error(
			`[${SERVER_NAME}] Authentication error: ${errorMessage(error)}`,
		);
		process.exit(1);
	}
})();

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

// Tool registration by tier.
const tools = [
	...selfServiceReadTools,
	...(enableExtendedReadTools ? extendedReadTools : []),
	...(enableWriteTools ? mutatingTools : []),
];

const duplicateToolNames = tools
	.map((tool) => tool.name)
	.filter((name, index, names) => names.indexOf(name) !== index);
if (duplicateToolNames.length > 0) {
	throw new Error(`Duplicate tool names registered: ${duplicateToolNames.join(", ")}`);
}

// Resource definitions. Additional resources are opt-in with the extended read flag.
const resources = enableExtendedReadTools
	? [projectListResource, timesheetTemplatesResource]
	: [];

console.error(
	`[${SERVER_NAME}] Registered ${tools.length} tool(s); extended reads: ${enableExtendedReadTools}; write tools: ${enableWriteTools}`,
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
	return {
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: zodToJsonSchema(tool.inputSchema),
		})),
	};
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;

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
