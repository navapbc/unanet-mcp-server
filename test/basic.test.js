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

		it("should add confirmed Platform REST timesheet entries", async () => {
			const { updateTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const result = await updateTimesheetTool.handler(
				{
					confirm: true,
					entries: [
						{
							projectId: "AI-PROJECT",
							date: "2026-01-01",
							hours: 1,
							description: "Built MCP connector",
						},
					],
				},
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
			);

			expect(result.success).toBe(true);
			expect(result.entries[0]).toMatchObject({
				projectKey: 102,
				hours: 1,
				comments: "Built MCP connector",
			});
		});

		it("should reject out-of-period timesheet writes", async () => {
			const { updateTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const result = await updateTimesheetTool.handler(
				{
					confirm: true,
					entries: [
						{
							projectId: "AI-PROJECT",
							date: "2026-01-20",
							hours: 1,
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
			expect(result.error).toContain("outside the resolved timesheet period");
		});

		it("should reject writes to non-editable timesheets", async () => {
			const { updateTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const result = await updateTimesheetTool.handler(
				{
					confirm: true,
					entries: [
						{
							projectId: "AI-PROJECT",
							date: "2026-01-02",
							hours: 1,
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
			expect(result.error).toContain("not editable");
		});

		it("should edit an existing timeslip in place", async () => {
			const { editTimeslipTool } = await import("../dist/tools/timesheet.js");
			const result = await editTimeslipTool.handler(
				{
					confirm: true,
					date: "2026-01-01",
					timeslipKey: 301,
					hours: 4,
					description: "Edited comment",
				},
				{ username: "test-user", password: "test-pass", baseUrl: MOCK_BASE_URL },
			);
			expect(result.success).toBe(true);
			expect(result.before.hoursWorked).toBe(8);
			expect(result.after.hoursWorked).toBe(4);
			expect(result.after.comments).toBe("Edited comment");
		});

		it("should reject edit when explicit date conflicts with the row's date", async () => {
			const { editTimeslipTool } = await import("../dist/tools/timesheet.js");
			// Row 301 is on 2026-01-01; asking to edit it under 2026-01-05 must fail.
			const result = await editTimeslipTool.handler(
				{
					confirm: true,
					date: "2026-01-05",
					timeslipKey: 301,
					hours: 2,
				},
				{ username: "test-user", password: "test-pass", baseUrl: MOCK_BASE_URL },
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain("is on 2026-01-01, not 2026-01-05");
		});

		it("should not commit any timesheet when a later batch entry is invalid", async () => {
			const { updateTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			await fetch(`${MOCK_BASE_URL}/platform/rest/__test/reset-put-count`, {
				method: "POST",
			});
			// Entry 1 (2026-01-01) is valid; entry 2 (2026-01-02) is a SUBMITTED,
			// non-editable sheet. The whole batch must abort before any PUT.
			const result = await updateTimesheetTool.handler(
				{
					confirm: true,
					entries: [
						{ projectId: "102", date: "2026-01-01", hours: 1 },
						{ projectId: "102", date: "2026-01-02", hours: 1 },
					],
				},
				{ username: "test-user", password: "test-pass", baseUrl: MOCK_BASE_URL },
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain("not editable");
			const { count } = await (
				await fetch(`${MOCK_BASE_URL}/platform/rest/__test/put-count`)
			).json();
			expect(count).toBe(0);
		});

		it("should clear (delete) an existing timeslip", async () => {
			const { deleteTimeslipTool } = await import("../dist/tools/timesheet.js");
			const result = await deleteTimeslipTool.handler(
				{ confirm: true, date: "2026-01-01", timeslipKey: 301 },
				{ username: "test-user", password: "test-pass", baseUrl: MOCK_BASE_URL },
			);
			expect(result.success).toBe(true);
			expect(result.cleared.key).toBe(301);
		});

		it("should reject adding a second entry for the same project/day", async () => {
			const { updateTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const result = await updateTimesheetTool.handler(
				{
					confirm: true,
					entries: [
						{ projectId: "101", date: "2026-01-01", hours: 2, description: "dup cell" },
					],
				},
				{ username: "test-user", password: "test-pass", baseUrl: MOCK_BASE_URL },
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain("only one entry per project/day");
			expect(result.existingRow.key).toBe(301);
		});

		it("should submit a clean timesheet for approval", async () => {
			const { submitTimesheetForApprovalTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const result = await submitTimesheetForApprovalTool.handler(
				{ confirm: true, date: "2026-01-01", comment: "Done" },
				{ username: "test-user", password: "test-pass", baseUrl: MOCK_BASE_URL },
			);
			expect(result.success).toBe(true);
			expect(result.timesheetKey).toBe(201);
		});

		it("should refuse to submit a timesheet with validation errors", async () => {
			const { submitTimesheetForApprovalTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const result = await submitTimesheetForApprovalTool.handler(
				{ confirm: true, date: "2026-01-03" },
				{ username: "test-user", password: "test-pass", baseUrl: MOCK_BASE_URL },
			);
			expect(result.success).toBe(false);
			expect(result.validationErrors.length).toBeGreaterThan(0);
		});

		it("should hold submission on warnings unless ignoreWarnings is set", async () => {
			const { submitTimesheetForApprovalTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const auth = { username: "test-user", password: "test-pass", baseUrl: MOCK_BASE_URL };
			const held = await submitTimesheetForApprovalTool.handler(
				{ confirm: true, date: "2026-01-04" },
				auth,
			);
			expect(held.success).toBe(false);
			expect(held.validationWarnings.length).toBeGreaterThan(0);
			const forced = await submitTimesheetForApprovalTool.handler(
				{ confirm: true, date: "2026-01-04", ignoreWarnings: true },
				auth,
			);
			expect(forced.success).toBe(true);
		});

		it("should require confirmation for live write tools", async () => {
			const {
				approveTimesheetTool,
				updateTimesheetTool,
				editTimeslipTool,
				deleteTimeslipTool,
				submitTimesheetForApprovalTool,
			} = await import("../dist/tools/timesheet.js");
			const { createContactTool } = await import("../dist/tools/contacts.js");

			expect(() =>
				updateTimesheetTool.inputSchema.parse({
					entries: [{ projectId: "101", date: "2026-01-01", hours: 1 }],
				}),
			).toThrow();
			expect(() =>
				approveTimesheetTool.inputSchema.parse({ timesheetId: "201" }),
			).toThrow();
			expect(() =>
				editTimeslipTool.inputSchema.parse({ timeslipKey: 301, hours: 1 }),
			).toThrow();
			expect(() =>
				deleteTimeslipTool.inputSchema.parse({ timeslipKey: 301 }),
			).toThrow();
			expect(() =>
				submitTimesheetForApprovalTool.inputSchema.parse({ date: "2026-01-01" }),
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

		it("should return entry-level timesheet detail and available projects", async () => {
			const { getTimesheetsTool, getMyTimesheetProjectsTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const auth = {
				username: "test-user",
				password: "test-pass",
				baseUrl: MOCK_BASE_URL,
			};

			const timesheets = await getTimesheetsTool.handler(
				{
					startDate: "2026-01-01",
					endDate: "2026-01-15",
					status: "All",
					limit: 1,
				},
				auth,
			);
			const projects = await getMyTimesheetProjectsTool.handler(
				{ date: "2026-01-01", search: "AI" },
				auth,
			);

			expect(timesheets.success).toBe(true);
			expect(timesheets.timesheets[0].entries).toBe(1);
			expect(timesheets.timesheets[0].timeslips[0].project.key).toBe(101);
			expect(projects.success).toBe(true);
			expect(projects.projects[0].code).toBe("AI-PROJECT");
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
					expect(toolNames).not.toContain("unanet_update_timesheet");
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
