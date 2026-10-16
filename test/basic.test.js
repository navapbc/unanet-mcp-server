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

function localIsoDate(date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function addCalendarDays(date, days) {
	const copy = new Date(date);
	copy.setDate(copy.getDate() + days);
	return copy;
}

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

		it("should retrieve UI-aligned leave balances via bearer-token Platform REST flow", async () => {
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
			expect(result.count).toBe(5);
			expect(result.primaryLeaveBalance).toEqual({
				name: "Paid Time Off",
				balanceHours: 112.69,
				usedHours: null,
			});
			expect(result.leaveBalances.map((balance) => balance.name)).toEqual([
				"Paid Time Off",
				"Floating Holiday",
				"Sick Leave 2026",
				"Granted Time Off",
				"LWOP",
			]);
			expect(result.leaveBalances[0]).toEqual({
				name: "Paid Time Off",
				projectName: "PTO 2026",
				taskName: "Paid Time Off",
				balanceHours: 112.69,
				usedHours: null,
				reportedBudgetHours: 112.69,
				reportedActualHours: null,
			});
			expect(result.leaveBalances[2]).toMatchObject({
				name: "Sick Leave 2026",
				balanceHours: 4.05,
				usedHours: 4,
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

		it("should default leave ranges from the local calendar date", async () => {
			const { getMyLeaveBalancesTool } = await import("../dist/tools/leave.js");
			const before = new Date();
			const result = await getMyLeaveBalancesTool.handler(
				{ pageSize: 50 },
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
			);
			const after = new Date();

			expect(result.success).toBe(true);
			expect([localIsoDate(before), localIsoDate(after)]).toContain(
				result.range.endDate,
			);
			const endDate = new Date(`${result.range.endDate}T00:00:00`);
			expect(result.range.startDate).toBe(
				localIsoDate(addCalendarDays(endDate, -14)),
			);
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

		const createAuth = {
			username: "test-user",
			password: "test-pass",
			baseUrl: MOCK_BASE_URL,
		};
		const mockCount = async (name) =>
			(
				await (
					await fetch(`${MOCK_BASE_URL}/platform/rest/__test/${name}`)
				).json()
			).count;
		const injectCreateFault = (mode) =>
			fetch(`${MOCK_BASE_URL}/platform/rest/__test/next-create-fault`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode }),
			});

		it("should create one timesheet per period and refuse a duplicate period", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const createsBefore = await mockCount("timesheet-create-count");

			const created = await createTimesheetTool.handler(
				{ date: "2025-11-03", confirm: true },
				createAuth,
			);
			expect(created).toMatchObject({
				success: true,
				created: true,
				verified: true,
				period: { startDate: "2025-11-01", endDate: "2025-11-15" },
				status: "INUSE",
			});
			expect(created.timesheetKey).toBeGreaterThan(0);

			const duplicate = await createTimesheetTool.handler(
				{ date: "2025-11-10", confirm: true },
				createAuth,
			);
			expect(duplicate).toMatchObject({
				success: false,
				created: false,
				timesheetKey: created.timesheetKey,
			});
			expect(duplicate.error).toContain("already exists");

			const nextPeriod = await createTimesheetTool.handler(
				{ date: "2025-11-20", confirm: true },
				createAuth,
			);
			expect(nextPeriod).toMatchObject({
				success: true,
				created: true,
				verified: true,
				period: { startDate: "2025-11-16", endDate: "2025-11-30" },
			});
			expect(nextPeriod.timesheetKey).not.toBe(created.timesheetKey);

			expect(await mockCount("timesheet-create-count")).toBe(createsBefore + 2);
		});

		it("should refuse a future date before sending any request", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const searchesBefore = await mockCount("timesheet-search-count");
			const createsBefore = await mockCount("timesheet-create-count");

			const result = await createTimesheetTool.handler(
				{ date: "2999-01-01", confirm: true },
				createAuth,
			);

			expect(result).toMatchObject({ success: false, created: false });
			expect(result.error).toContain("future timesheet");
			expect(await mockCount("timesheet-search-count")).toBe(searchesBefore);
			expect(await mockCount("timesheet-create-count")).toBe(createsBefore);
		});

		it("should reject invalid dates and missing or false confirm without any request", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const searchesBefore = await mockCount("timesheet-search-count");
			const createsBefore = await mockCount("timesheet-create-count");

			for (const args of [
				{ date: "2025-02-29", confirm: true },
				{ date: "2025-13-01", confirm: true },
				{ date: "not-a-date", confirm: true },
				{ date: "2025-11-03" },
				{ date: "2025-11-03", confirm: false },
			]) {
				await expect(createTimesheetTool.handler(args, createAuth)).rejects.toThrow();
				expect(() => createTimesheetTool.inputSchema.parse(args)).toThrow();
			}

			expect(await mockCount("timesheet-search-count")).toBe(searchesBefore);
			expect(await mockCount("timesheet-create-count")).toBe(createsBefore);
		});

		it("should report an unknown outcome when the create request fails after being sent", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const createsBefore = await mockCount("timesheet-create-count");

			for (const [mode, date] of [
				["503", "2025-10-03"],
				["no-response", "2025-10-20"],
			]) {
				await injectCreateFault(mode);
				const result = await createTimesheetTool.handler(
					{ date, confirm: true },
					createAuth,
				);
				expect(result).toMatchObject({ success: false, created: "unknown" });
				expect(result.warning).toContain("Search the period before retrying");
			}

			expect(await mockCount("timesheet-create-count")).toBe(createsBefore);
		});

		it("should keep created:false when the lookup before the create fails", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const createsBefore = await mockCount("timesheet-create-count");

			const result = await createTimesheetTool.handler(
				{ date: "2025-09-03", confirm: true },
				{ ...createAuth, username: "wrong-user" },
			);

			expect(result).toMatchObject({ success: false, created: false });
			expect(await mockCount("timesheet-create-count")).toBe(createsBefore);
		});

		it("should keep created:false when Unanet rejects the create with a 4xx", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			await injectCreateFault("409");

			const result = await createTimesheetTool.handler(
				{ date: "2025-06-03", confirm: true },
				createAuth,
			);

			expect(result).toMatchObject({ success: false, created: false });
			expect(result.warning).toBeUndefined();
		});

		it("should not class a failed login as an unknown write outcome", async () => {
			const { isOutcomeUnknown } = await import("../dist/auth.js");
			const client = createUnanetClient({ ...createAuth, username: "wrong-user" });

			const error = await client
				.post("/me/time", { date: "2025-06-03" })
				.catch((caught) => caught);

			expect(error).toBeInstanceOf(Error);
			expect(isOutcomeUnknown(error)).toBe(false);
		});

		it("should create a timesheet for an ordinary recent period the seeded fixtures do not cover", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);

			const result = await createTimesheetTool.handler(
				{ date: "2026-10-15", confirm: true },
				createAuth,
			);

			expect(result).toMatchObject({
				success: true,
				created: true,
				verified: true,
				period: { startDate: "2026-10-01", endDate: "2026-10-15" },
			});
		});

		it("should create the second January period even though fixtures cover the first", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);

			// No second-half sheet exists yet; the fixtures cover January 1-15 only.
			const { getMyTimesheetProjectsTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const beforeCreate = await getMyTimesheetProjectsTool.handler(
				{ date: "2026-01-20" },
				createAuth,
			);
			expect(beforeCreate.success).toBe(false);
			expect(beforeCreate.error).toContain("No existing timesheet");
			const result = await createTimesheetTool.handler(
				{ date: "2026-01-20", confirm: true },
				createAuth,
			);

			expect(result).toMatchObject({
				success: true,
				created: true,
				verified: true,
				period: { startDate: "2026-01-16", endDate: "2026-01-31" },
			});
		});

		it("should not mistake a sheet for another period for a same-period duplicate", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);

			// Search returns fixture 201 (2026-01-01..15) for this date.
			const result = await createTimesheetTool.handler(
				{ date: "2026-04-07", confirm: true },
				createAuth,
			);

			expect(result).toMatchObject({
				success: true,
				created: true,
				verified: true,
				period: { startDate: "2026-04-01", endDate: "2026-04-15" },
			});
		});

		it.each([
			["no period", "2026-05-06", 212],
			["only a start date", "2026-06-20", 213],
			["only an end date", "2026-07-20", 214],
		])(
			"should create nothing when the found timesheet reports %s",
			async (_label, date, foundKey) => {
				const { createTimesheetTool } = await import(
					"../dist/tools/timesheet.js"
				);
				const createsBefore = await mockCount("timesheet-create-count");

				const result = await createTimesheetTool.handler(
					{ date, confirm: true },
					createAuth,
				);

				expect(result).toMatchObject({
					success: false,
					created: false,
					timesheetKey: foundKey,
				});
				expect(result.error).toContain("Could not determine the period");
				expect(await mockCount("timesheet-create-count")).toBe(createsBefore);
			},
		);

		it("should refuse when a later search result covers the date", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const createsBefore = await mockCount("timesheet-create-count");

			// Search returns a January sheet first, then the September sheet.
			const result = await createTimesheetTool.handler(
				{ date: "2026-09-09", confirm: true },
				createAuth,
			);

			expect(result).toMatchObject({
				success: false,
				created: false,
				timesheetKey: 217,
			});
			expect(result.error).toContain("already exists");
			expect(await mockCount("timesheet-create-count")).toBe(createsBefore);
		});

		it("should refuse when a full page of results leaves more possible", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const createsBefore = await mockCount("timesheet-create-count");

			// 25 sheets for other periods: a covering sheet could be on a later page.
			const result = await createTimesheetTool.handler(
				{ date: "2026-03-20", confirm: true },
				createAuth,
			);

			expect(result).toMatchObject({ success: false, created: false });
			expect(result.error).toContain("25 or more timesheets");
			expect(await mockCount("timesheet-create-count")).toBe(createsBefore);
		});

		it("should load the sheet when the search result carries no period", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const createsBefore = await mockCount("timesheet-create-count");

			// The search result is {key: 215}; only GET reports 2026-08-01..15.
			const result = await createTimesheetTool.handler(
				{ date: "2026-08-10", confirm: true },
				createAuth,
			);

			expect(result).toMatchObject({
				success: false,
				created: false,
				timesheetKey: 215,
			});
			expect(result.error).toContain("already exists");
			expect(await mockCount("timesheet-create-count")).toBe(createsBefore);
		});

		it("should flag, not fail, a create response with no key", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			await injectCreateFault("no-key");

			const result = await createTimesheetTool.handler(
				{ date: "2025-08-04", confirm: true },
				createAuth,
			);

			expect(result).toMatchObject({
				success: true,
				created: true,
				verified: false,
			});
			expect(result.warning).toContain("returned no timesheet key");
		});

		it("should verify the period from Unanet's null-field, nested-period shape", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			await injectCreateFault("nested-period");

			const result = await createTimesheetTool.handler(
				{ date: "2025-07-04", confirm: true },
				createAuth,
			);

			expect(result).toMatchObject({
				success: true,
				created: true,
				verified: true,
				period: { startDate: "2025-07-01", endDate: "2025-07-15" },
			});
		});

		it("should not verify a period that has no end date", async () => {
			const { createTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			await injectCreateFault("start-only");

			const result = await createTimesheetTool.handler(
				{ date: "2025-05-04", confirm: true },
				createAuth,
			);

			expect(result).toMatchObject({
				success: true,
				created: true,
				verified: false,
			});
		});

		it("should find a timesheet whose search result has null id and dates", async () => {
			const { getMyTimesheetProjectsTool } = await import(
				"../dist/tools/timesheet.js"
			);

			const projects = await getMyTimesheetProjectsTool.handler(
				{ date: "2026-02-10", search: "AI" },
				createAuth,
			);

			expect(projects.success).toBe(true);
			expect(projects.projects[0].code).toBe("AI-PROJECT");
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
							date: "2026-03-05",
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
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
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
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
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
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain("not editable");
			const { count } = await (
				await fetch(`${MOCK_BASE_URL}/platform/rest/__test/put-count`)
			).json();
			expect(count).toBe(0);
		});

		it("should refuse a batch spanning multiple timesheets and write nothing", async () => {
			const { updateTimesheetTool } = await import(
				"../dist/tools/timesheet.js"
			);
			await fetch(`${MOCK_BASE_URL}/platform/rest/__test/reset-put-count`, {
				method: "POST",
			});
			// 2026-01-01 -> timesheet 201, 2026-01-03 -> timesheet 203 (different
			// periods). The batch must abort with no PUT.
			const result = await updateTimesheetTool.handler(
				{
					confirm: true,
					entries: [
						{ projectId: "102", date: "2026-01-01", hours: 1 },
						{ projectId: "102", date: "2026-01-03", hours: 1 },
					],
				},
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain("multiple timesheets");
			expect(result.timesheetKeys).toHaveLength(2);
			const { count } = await (
				await fetch(`${MOCK_BASE_URL}/platform/rest/__test/put-count`)
			).json();
			expect(count).toBe(0);
		});

		it("should clear (delete) an existing timeslip", async () => {
			const { deleteTimeslipTool } = await import("../dist/tools/timesheet.js");
			const result = await deleteTimeslipTool.handler(
				{ confirm: true, date: "2026-01-01", timeslipKey: 301 },
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
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
						{
							projectId: "101",
							date: "2026-01-01",
							hours: 2,
							description: "dup cell",
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
			expect(result.error).toContain("only one entry per project/day");
			expect(result.existingRow.key).toBe(301);
		});

		it("should submit a clean timesheet for approval", async () => {
			const { submitTimesheetForApprovalTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const result = await submitTimesheetForApprovalTool.handler(
				{ confirm: true, date: "2026-01-01", comment: "Done" },
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
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
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
			);
			expect(result.success).toBe(false);
			expect(result.validationErrors.length).toBeGreaterThan(0);
		});

		it("should hold submission on warnings unless ignoreWarnings is set", async () => {
			const { submitTimesheetForApprovalTool } = await import(
				"../dist/tools/timesheet.js"
			);
			const auth = {
				username: "test-user",
				password: "test-pass",
				baseUrl: MOCK_BASE_URL,
			};
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
				submitTimesheetForApprovalTool.inputSchema.parse({
					date: "2026-01-01",
				}),
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

		it("should summarize personal development fund spending from expenses", async () => {
			const { getPersonalDevelopmentFundStatusTool } = await import(
				"../dist/tools/expenses.js"
			);
			const result = await getPersonalDevelopmentFundStatusTool.handler(
				{ annualBudget: 1000, startDate: "2026-01-01", endDate: "2026-12-31" },
				{
					username: "test-user",
					password: "test-pass",
					baseUrl: MOCK_BASE_URL,
				},
			);

			expect(result.success).toBe(true);
			expect(result.count).toBe(1);
			expect(result.totalSpent).toBe(450);
			expect(result.remainingBudget).toBe(550);
			expect(result.lineItems[0]).toMatchObject({
				expensePurpose: "Professional development - AI conference",
				vendorName: "AI Conf",
				matchedAmount: 450,
			});
		});

		it("should read expense reports and expense reference data", async () => {
			const { getMyExpensesTool, getExpenseReferenceDataTool } = await import(
				"../dist/tools/expenses.js"
			);
			const auth = {
				username: "test-user",
				password: "test-pass",
				baseUrl: MOCK_BASE_URL,
			};

			const expenses = await getMyExpensesTool.handler(
				{ status: "All", pageSize: 50 },
				auth,
			);
			const reference = await getExpenseReferenceDataTool.handler(
				{ pageSize: 50 },
				auth,
			);

			expect(expenses.success).toBe(true);
			expect(expenses.expenses[0]).toMatchObject({
				key: 9001,
				purpose: "Professional development - AI conference",
				totalExpenses: 450,
			});
			expect(expenses.expenses[0].details[0]).toMatchObject({
				expenseType: "Training / Conference",
				expenseAmount: 450,
			});
			expect(reference.success).toBe(true);
			expect(reference.expenseTypes[0]).toMatchObject({
				key: 301,
				name: "Training / Conference",
			});
			expect(reference.paymentMethods[0]).toMatchObject({
				key: 401,
				code: "EMPLOYEE_PAID",
			});
			expect(reference.currencies[0]).toMatchObject({ key: 1, code: "USD" });
		});

		it("should create expense drafts, add details, and validate without submitting", async () => {
			const {
				createExpenseReportDraftTool,
				addExpenseDetailTool,
				validateExpenseReportTool,
			} = await import("../dist/tools/expenses.js");
			const auth = {
				username: "test-user",
				password: "test-pass",
				baseUrl: MOCK_BASE_URL,
			};

			expect(() =>
				createExpenseReportDraftTool.inputSchema.parse({
					purpose: "Professional development",
					expenseProjectAllocations: [{ projectKey: 501, allocation: 100 }],
				}),
			).toThrow();

			const draft = await createExpenseReportDraftTool.handler(
				{
					confirm: true,
					purpose: "Professional development books",
					location: "Remote",
					expenseProjectAllocations: [{ projectKey: 501, allocation: 100 }],
				},
				auth,
			);
			expect(draft.success).toBe(true);
			expect(draft.expenseId).toBeGreaterThan(0);
			expect(draft.expense.status).toBe("INUSE");

			expect(() =>
				addExpenseDetailTool.inputSchema.parse({
					expenseId: draft.expenseId,
					expenseDate: "2026-06-01",
					expenseTypeKey: 301,
					paymentMethodKey: 401,
					transactionCurrency: 1,
					amount: 75,
					projectAllocationKey: 7100,
					wizard: { type: "ENTERTAINMENT" },
				}),
			).toThrow();

			const detail = await addExpenseDetailTool.handler(
				{
					confirm: true,
					expenseId: draft.expenseId,
					expenseDate: "2026-06-01",
					expenseTypeKey: 301,
					paymentMethodKey: 401,
					transactionCurrency: 1,
					amount: 75,
					projectAllocationKey: 7100,
					summary: "Professional development book",
					vendorName: "Bookshop",
					receiptIncluded: false,
					wizard: { type: "ENTERTAINMENT" },
				},
				auth,
			);
			expect(detail.success).toBe(true);
			expect(detail.detailId).toBeGreaterThan(0);
			expect(detail.message).toContain("Review and submit manually");

			const wizardLine = (
				await createUnanetClient(auth).get(`/me/expenses/${draft.expenseId}`)
			).data.expenseDetails.find((line) => line.key === detail.detailId);
			expect(wizardLine.wizard).toEqual({ type: "ENTERTAINMENT" });

			// Plain expense types (parking, baggage, tolls...) have no wizard.
			const plainArgs = addExpenseDetailTool.inputSchema.parse({
				confirm: true,
				expenseId: draft.expenseId,
				expenseDate: "2026-06-02",
				expenseTypeKey: 46,
				paymentMethodKey: 401,
				transactionCurrency: 1,
				amount: 12.5,
				projectAllocationKey: 7100,
				summary: "Parking",
				validateAfterAdd: false,
			});
			const plain = await addExpenseDetailTool.handler(plainArgs, auth);
			expect(plain.success).toBe(true);
			const stored = (
				await createUnanetClient(auth).get(`/me/expenses/${draft.expenseId}`)
			).data.expenseDetails.find((line) => line.key === plain.detailId);
			expect(stored.summary).toBe("Parking");
			expect("wizard" in stored).toBe(false);

			// A type that needs a wizard: the caller gets Unanet's error code and the
			// field it points at, not its support-staff description or context values.
			const missingWizard = await addExpenseDetailTool.handler(
				{ ...plainArgs, expenseTypeKey: 9998 },
				auth,
			);
			expect(missingWizard.success).toBe(false);
			expect(missingWizard.error).toContain("VALIDATION_MUST_NOT_BE_NULL");
			expect(missingWizard.error).toContain("(context: wizard)");
			expect(missingWizard.error).not.toContain("SUPPORT-ONLY");
			expect(missingWizard.error).not.toContain("do not echo");
			expect(missingWizard.error).not.toContain("secret value");

			const validation = await validateExpenseReportTool.handler(
				{ expenseId: draft.expenseId },
				auth,
			);
			expect(validation.success).toBe(true);
			expect(validation.warnings).toContain("At least one receipt is missing");

			const completed = await addExpenseDetailTool.handler(
				{
					confirm: true,
					expenseId: 9001,
					expenseDate: "2026-06-01",
					expenseTypeKey: 301,
					paymentMethodKey: 401,
					transactionCurrency: 1,
					amount: 75,
					projectAllocationKey: 7001,
					wizard: { type: "ENTERTAINMENT" },
				},
				auth,
			);
			expect(completed.success).toBe(false);
			expect(completed.error).toContain("not editable");
		});

		it("should upload and list receipt attachments on a draft", async () => {
			const {
				createExpenseReportDraftTool,
				addExpenseAttachmentTool,
				getExpenseAttachmentsTool,
			} = await import("../dist/tools/expenses.js");
			const auth = {
				username: "test-user",
				password: "test-pass",
				baseUrl: MOCK_BASE_URL,
			};

			const draft = await createExpenseReportDraftTool.handler(
				{
					confirm: true,
					purpose: "Receipt upload test",
					expenseProjectAllocations: [{ projectKey: 501, allocation: 100 }],
				},
				auth,
			);
			expect(draft.success).toBe(true);

			// Requires confirm: true.
			expect(() =>
				addExpenseAttachmentTool.inputSchema.parse({
					expenseId: draft.expenseId,
					data: Buffer.from("hello").toString("base64"),
					name: "r.pdf",
				}),
			).toThrow();

			// Requires exactly one of filePath/data.
			expect(() =>
				addExpenseAttachmentTool.inputSchema.parse({
					confirm: true,
					expenseId: draft.expenseId,
				}),
			).toThrow();

			const upload = await addExpenseAttachmentTool.handler(
				{
					confirm: true,
					expenseId: draft.expenseId,
					data: Buffer.from("%PDF-1.4 mock receipt").toString("base64"),
					name: "uber-2026-06-01.pdf",
				},
				auth,
			);
			expect(upload.success).toBe(true);
			expect(upload.verified).toBe(true);
			expect(upload.attachmentId).toBeGreaterThan(0);
			expect(upload.attachmentsOnReport).toBe(1);
			expect(upload.readbackError).toBeNull();
			expect(upload.mimeType).toBe("application/pdf");
			expect(upload.message).toContain("confirmed present");

			const listed = await getExpenseAttachmentsTool.handler(
				{ expenseId: draft.expenseId },
				auth,
			);
			expect(listed.success).toBe(true);
			expect(listed.count).toBe(1);
			expect(listed.attachments[0]).toMatchObject({
				name: "uber-2026-06-01.pdf",
				mimeType: "application/pdf",
			});

			// Unknown extension with no explicit mimeType is rejected.
			const badMime = await addExpenseAttachmentTool.handler(
				{
					confirm: true,
					expenseId: draft.expenseId,
					data: Buffer.from("x").toString("base64"),
					name: "receipt.xyz",
				},
				auth,
			);
			expect(badMime.success).toBe(false);
			expect(badMime.error).toContain("MIME type");

			// Not editable report is rejected.
			const locked = await addExpenseAttachmentTool.handler(
				{
					confirm: true,
					expenseId: 9001,
					data: Buffer.from("x").toString("base64"),
					name: "receipt.pdf",
				},
				auth,
			);
			expect(locked.success).toBe(false);
			expect(locked.error).toContain("not editable");
		});

		it("verifies via read-back when the upload POST returns no key", async () => {
			const { createExpenseReportDraftTool, addExpenseAttachmentTool } =
				await import("../dist/tools/expenses.js");
			const auth = {
				username: "test-user",
				password: "test-pass",
				baseUrl: MOCK_BASE_URL,
			};
			const draft = await createExpenseReportDraftTool.handler(
				{
					confirm: true,
					purpose: "No-key read-back test",
					expenseProjectAllocations: [{ projectKey: 501, allocation: 100 }],
				},
				auth,
			);
			// Mock returns {} (no key) for names containing __NOKEY__.
			const upload = await addExpenseAttachmentTool.handler(
				{
					confirm: true,
					expenseId: draft.expenseId,
					data: Buffer.from("%PDF mock").toString("base64"),
					name: "__NOKEY__receipt.pdf",
				},
				auth,
			);
			expect(upload.success).toBe(true);
			// POST gave no key, but read-back matched by name+length.
			expect(upload.verified).toBe(true);
			expect(upload.attachmentId).toBeGreaterThan(0);
			expect(upload.message).toContain("confirmed present");
		});

		it("associates an attachment with a line item via detailId", async () => {
			const {
				createExpenseReportDraftTool,
				addExpenseAttachmentTool,
				getExpenseAttachmentsTool,
			} = await import("../dist/tools/expenses.js");
			const auth = {
				username: "test-user",
				password: "test-pass",
				baseUrl: MOCK_BASE_URL,
			};
			const draft = await createExpenseReportDraftTool.handler(
				{
					confirm: true,
					purpose: "detailId association test",
					expenseProjectAllocations: [{ projectKey: 501, allocation: 100 }],
				},
				auth,
			);
			const upload = await addExpenseAttachmentTool.handler(
				{
					confirm: true,
					expenseId: draft.expenseId,
					detailId: 91044,
					data: Buffer.from("%PDF mock").toString("base64"),
					name: "taxi.pdf",
				},
				auth,
			);
			expect(upload.success).toBe(true);
			expect(upload.verified).toBe(true);
			expect(upload.detailId).toBe(91044);
			expect(upload.message).toContain("associated with the line item");

			const listed = await getExpenseAttachmentsTool.handler(
				{ expenseId: draft.expenseId },
				auth,
			);
			expect(listed.attachments[0].detailKey).toBe(91044);
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
					UNANET_ENABLE_EXTENDED_READ_TOOLS: "false",
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
					expect(toolNames).toContain(
						"unanet_get_personal_development_fund_status",
					);
					expect(toolNames).toContain("unanet_get_my_expenses");
					expect(toolNames).toContain("unanet_get_expense_attachments");
					expect(toolNames).not.toContain("unanet_update_timesheet");
					expect(toolNames).not.toContain("unanet_add_expense_attachment");
					expect(toolNames).not.toContain("unanet_update_project_budget");
					expect(toolNames).not.toContain("unanet_create_expense_report_draft");
					expect(toolNames).not.toContain("unanet_create_timesheet");
					resolve();
				});

				serverProcess.stdin.write(JSON.stringify(listToolsRequest) + "\n");
			});
		});

		it("should advertise timesheet creation when write tools are enabled", async () => {
			const writeServerProcess = spawn("node", ["dist/index.js"], {
				env: {
					...process.env,
					UNANET_USERNAME: "test-user",
					UNANET_PASSWORD: "test-pass",
					UNANET_BASE_URL: MOCK_BASE_URL,
					UNANET_ALLOW_INSECURE_LOCAL_MOCK: "true",
					UNANET_ENABLE_EXTENDED_READ_TOOLS: "false",
					UNANET_ENABLE_WRITE_TOOLS: "true",
				},
			});

			try {
				await new Promise((resolve) => setTimeout(resolve, 250));
				const response = await new Promise((resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error("Timed out waiting for tools/list")),
						3000,
					);
					writeServerProcess.stdout.once("data", (data) => {
						clearTimeout(timer);
						resolve(JSON.parse(data.toString()));
					});
					writeServerProcess.stdin.write(
						`${JSON.stringify({
							jsonrpc: "2.0",
							method: "tools/list",
							params: {},
							id: 1,
						})}\n`,
					);
				});
				const toolNames = response.result.tools.map((tool) => tool.name);
				expect(toolNames).toContain("unanet_create_timesheet");
			} finally {
				writeServerProcess.kill();
			}
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
			expect(() => schema.parse({ status: "Completed" })).toThrow();
			expect(() => schema.parse({ limit: -1 })).toThrow();
		});
	});
});
