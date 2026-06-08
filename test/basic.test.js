/**
 * Basic tests that can run without real Unanet credentials.
 * Run with: npm test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import {
	createUnanetClient,
	validateAuth,
	validateUnanetBaseUrl,
	clearPlatformTokenCache,
} from "../dist/auth.js";

const MOCK_PORT = 3210;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;

function waitForOutput(childProcess, expectedText, timeoutMs = 3000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Timed out waiting for ${expectedText}`)),
			timeoutMs,
		);
		childProcess.stdout.on("data", (data) => {
			if (data.toString().includes(expectedText)) {
				clearTimeout(timer);
				resolve();
			}
		});
		childProcess.stderr.on("data", (data) => {
			if (data.toString().includes(expectedText)) {
				clearTimeout(timer);
				resolve();
			}
		});
		childProcess.once("exit", (code) => {
			clearTimeout(timer);
			reject(
				new Error(
					`Process exited before readiness text ${expectedText}; code=${code}`,
				),
			);
		});
	});
}

describe("Unanet MCP Server Basic Tests", () => {
	describe("Authentication", () => {
		it("should reject missing credentials", () => {
			expect(() => validateAuth({})).toThrow(
				"UNANET_USERNAME environment variable is required",
			);
		});

		it("should accept valid Nava read-only credentials without API key or firm code", () => {
			const validAuth = {
				username: "test",
				password: "test",
				baseUrl: "https://navapbc.unanet.biz",
			};
			expect(() => validateAuth(validAuth)).not.toThrow();
		});

		it("should reject arbitrary production base URLs", () => {
			expect(() => validateUnanetBaseUrl("https://example.com")).toThrow(
				"UNANET_BASE_URL host is not allowed",
			);
		});

		it("should sanitize malformed base URL errors", () => {
			expect(() => validateUnanetBaseUrl("not a url with secret-pass")).toThrow(
				"UNANET_BASE_URL is invalid",
			);
		});

		it("should require an explicit flag for insecure local mock URLs", () => {
			expect(() => validateUnanetBaseUrl(MOCK_BASE_URL)).toThrow(
				"UNANET_ALLOW_INSECURE_LOCAL_MOCK=true",
			);
			expect(() =>
				validateUnanetBaseUrl(MOCK_BASE_URL, { allowInsecureLocalMock: true }),
			).not.toThrow();
		});

		it("should reject non-HTTPS production base URLs", () => {
			expect(() => validateUnanetBaseUrl("http://navapbc.unanet.biz")).toThrow(
				"Production UNANET_BASE_URL must use HTTPS",
			);
		});

		it("should create the Platform REST client without API key or firm code", () => {
			expect(() =>
				createUnanetClient({
					username: "test",
					password: "secret-password",
					baseUrl: "https://navapbc.unanet.biz",
				}),
			).not.toThrow();
		});
	});

	describe("Platform REST leave balance tool", () => {
		let mockProcess;

		beforeAll(async () => {
			clearPlatformTokenCache();
			process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK = "true";
			mockProcess = spawn("node", ["dist/mock-server.js"], {
				env: {
					...process.env,
					PORT: String(MOCK_PORT),
				},
			});
			await waitForOutput(mockProcess, "Mock Unanet API server running");
		});

		afterAll(() => {
			delete process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK;
			if (mockProcess) {
				mockProcess.kill();
			}
		});

		it("should retrieve minimized leave balances via bearer-token Platform REST flow", async () => {
			const { getMyLeaveBalancesTool } = await import("../dist/tools/leave.js");
			const result = await getMyLeaveBalancesTool.handler(
				{
					startDate: "2026-01-01",
					endDate: "2026-01-15",
					pageSize: 50,
				},
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
			);

			expect(result.success).toBe(true);
			expect(result.count).toBe(2);
			expect(result.leaveBalances[0]).toEqual({
				name: "PTO 2026",
				projectName: "PTO 2026",
				taskName: null,
				reportedBudgetHours: 120,
				reportedActualHours: 16,
			});
			expect(result.leaveBalances[0]).not.toHaveProperty("project");
			expect(result.leaveBalances[0]).not.toHaveProperty("raw");
		});

		it("should validate leave-balance input dates", async () => {
			const { leaveBalanceInputSchema } = await import(
				"../dist/tools/leave.js"
			);
			expect(() =>
				leaveBalanceInputSchema.parse({ startDate: "2026-02-30" }),
			).toThrow();
			expect(() =>
				leaveBalanceInputSchema.parse({
					startDate: "2026-02-02",
					endDate: "2026-02-01",
				}),
			).toThrow();
			expect(() => leaveBalanceInputSchema.parse({ pageSize: 101 })).toThrow();
		});

		it("should default startDate to 14 days before a provided endDate", async () => {
			const { getMyLeaveBalancesTool } = await import("../dist/tools/leave.js");
			const result = await getMyLeaveBalancesTool.handler(
				{
					endDate: "2026-01-15",
					pageSize: 50,
				},
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
			);

			expect(result.success).toBe(true);
			expect(result.range).toEqual({
				startDate: "2026-01-01",
				endDate: "2026-01-15",
			});
		});

		it("should auto-prefix Platform REST client paths and retrieve projects", async () => {
			const { getProjectsTool } = await import("../dist/tools/projects.js");
			const result = await getProjectsTool.handler(
				{ status: "Active", limit: 10 },
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
			);

			expect(result.success).toBe(true);
			expect(result.count).toBe(2);
			expect(result.projects[0].projectCode).toBe("PRJ-001");
		});

		it("should fail closed for incomplete timesheet write tool", async () => {
			const { submitTimesheetTool } = await import("../dist/tools/timesheet.js");
			const result = await submitTimesheetTool.handler(
				{
					entries: [
						{
							projectId: "101",
							date: "2026-01-01",
							hours: 8,
						},
					],
				},
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain("disabled");
		});

		it("should require confirmation for live write tools", async () => {
			const { approveTimesheetTool } = await import("../dist/tools/timesheet.js");
			const { createContactTool } = await import("../dist/tools/contacts.js");

			expect(() =>
				approveTimesheetTool.inputSchema.parse({ timesheetId: "201" }),
			).toThrow();
			expect(() =>
				createContactTool.inputSchema.parse({
					organizationId: "101",
					firstName: "Test",
					lastName: "User",
					email: "test@example.com",
				}),
			).toThrow();
		});

		it("should serve migrated Platform REST resources when enabled", async () => {
			const { projectListResource, timesheetTemplatesResource } = await import(
				"../dist/resources/reports.js"
			);
			const auth = {
				username: "test-user",
				password: "test-pass",
				baseUrl: MOCK_BASE_URL,
			};

			const projects = await projectListResource.handler(auth);
			const templates = await timesheetTemplatesResource.handler(auth);

			expect(projects.count).toBe(2);
			expect(projects.projects[0].code).toBe("PRJ-001");
			expect(templates.templates[0].projectKey).toBe(101);
		});
	});

	describe("MCP Server Protocol", () => {
		let serverProcess;

		beforeAll(async () => {
			serverProcess = spawn("node", ["dist/index.js"], {
				env: {
					...process.env,
					UNANET_USERNAME: "test-user",
					UNANET_PASSWORD: "test-pass",
					UNANET_BASE_URL: MOCK_BASE_URL,
					UNANET_ALLOW_INSECURE_LOCAL_MOCK: "true",
					UNANET_ENABLE_LEGACY_READ_TOOLS: "false",
					UNANET_ENABLE_WRITE_TOOLS: "false",
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 1000));
		});

		afterAll(() => {
			if (serverProcess) {
				serverProcess.kill();
			}
		});

		it("should list only read-only tools by default", async () => {
			const listToolsRequest = {
				jsonrpc: "2.0",
				method: "tools/list",
				params: {},
				id: 1,
			};

			return new Promise((resolve) => {
				serverProcess.stdout.once("data", (data) => {
					const response = JSON.parse(data.toString());
					expect(response.result).toBeDefined();
					expect(response.result.tools).toBeInstanceOf(Array);
					const toolNames = response.result.tools.map((tool) => tool.name);
					expect(toolNames).toContain("unanet_get_my_leave_balances");
					expect(toolNames).not.toContain("unanet_submit_timesheet");
					expect(toolNames).not.toContain("unanet_update_project_budget");
					resolve();
				});

				serverProcess.stdin.write(JSON.stringify(listToolsRequest) + "\n");
			});
		});

		it("should not list legacy resources in safe read-only mode", async () => {
			const listResourcesRequest = {
				jsonrpc: "2.0",
				method: "resources/list",
				params: {},
				id: 2,
			};

			return new Promise((resolve) => {
				serverProcess.stdout.once("data", (data) => {
					const response = JSON.parse(data.toString());
					expect(response.result).toBeDefined();
					expect(response.result.resources).toBeInstanceOf(Array);
					expect(response.result.resources.length).toBe(0);
					resolve();
				});

				serverProcess.stdin.write(JSON.stringify(listResourcesRequest) + "\n");
			});
		});
	});

	describe("Tool Input Validation", () => {
		it("should validate project tool inputs", async () => {
			const { getProjectsTool } = await import("../dist/tools/projects.js");
			const schema = getProjectsTool.inputSchema;

			expect(() => schema.parse({ status: "Active", limit: 10 })).not.toThrow();
			expect(() => schema.parse({ status: "Invalid" })).toThrow();
			expect(() => schema.parse({ limit: -1 })).toThrow();
		});
	});
});
