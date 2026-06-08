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
	updateTimesheetTool,
	editTimeslipTool,
	deleteTimeslipTool,
	submitTimesheetForApprovalTool,
	getTimesheetsTool,
	getMyTimesheetProjectsTool,
	submitExpenseTool,
	approveTimesheetTool,
} from "./tools/timesheet.js";
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
import { getMyLeaveBalancesTool } from "./tools/leave.js";
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
const enableLegacyReadTools = isEnabled(
	process.env.UNANET_ENABLE_LEGACY_READ_TOOLS,
);
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
		apiKey: process.env.UNANET_API_KEY || undefined,
		firmCode: process.env.UNANET_FIRM_CODE || undefined,
		baseUrl: normalizedBaseUrl,
		appName: process.env.UNANET_APP_NAME || DEFAULT_UNANET_APP_NAME,
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

const readOnlyTools = [getMyLeaveBalancesTool];

const legacyReadTools = [
	getProjectsTool,
	getProjectDetailsTool,
	getProjectStatusTool,
	getTimesheetsTool,
	getMyTimesheetProjectsTool,
	getCompanyInfoTool,
	getBillingStatusTool,
	getFinancialReportTool,
];

const mutatingTools = [
	updateProjectBudgetTool,
	updateTimesheetTool,
	editTimeslipTool,
	deleteTimeslipTool,
	submitTimesheetForApprovalTool,
	submitExpenseTool,
	approveTimesheetTool,
	createContactTool,
	updateLeadTool,
	createOpportunityTool,
	generateInvoiceTool,
];

// Tool definitions. Safe mode registers only the read-only Nava leave-balance tool.
const tools = [
	...readOnlyTools,
	...(enableLegacyReadTools ? legacyReadTools : []),
	...(enableWriteTools ? mutatingTools : []),
];

// Resource definitions. Additional resources are opt-in with the legacy read flag.
const resources = enableLegacyReadTools
	? [projectListResource, timesheetTemplatesResource]
	: [];

console.error(
	`[${SERVER_NAME}] Registered ${tools.length} tool(s); write tools enabled: ${enableWriteTools}`,
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
