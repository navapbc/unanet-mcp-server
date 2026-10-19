/**
 * Tests for the extended tool surface (timesheet lifecycle, leave requests,
 * approvals, reviews, user self-service, expense lifecycle, directory reads,
 * and the spec-driven generic API tools). Runs against the mock server.
 * Run with: npm test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPlatformTokenCache } from "../dist/auth.js";

const MOCK_PORT = 3211;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
const auth = {
	username: "test-user",
	password: "test-pass",
	baseUrl: MOCK_BASE_URL,
};

function waitForOutput(childProcess, expectedText, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Timed out waiting for ${expectedText}`)),
			timeoutMs,
		);
		const onData = (data) => {
			if (data.toString().includes(expectedText)) {
				clearTimeout(timer);
				resolve();
			}
		};
		childProcess.stdout.on("data", onData);
		childProcess.stderr.on("data", onData);
		childProcess.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Mock exited before ready; code=${code}`));
		});
	});
}

async function mockGet(path) {
	const response = await fetch(`${MOCK_BASE_URL}/platform/rest${path}`);
	return response.json();
}

describe("Extended Unanet MCP tools", () => {
	let mockProcess;

	beforeAll(async () => {
		clearPlatformTokenCache();
		process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK = "true";
		mockProcess = spawn("node", ["dist/mock-server.js"], {
			env: { ...process.env, PORT: String(MOCK_PORT) },
		});
		await waitForOutput(mockProcess, "Mock Unanet API server running");
	});

	afterAll(() => {
		delete process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK;
		if (mockProcess) mockProcess.kill();
	});

	// ---- Auth ------------------------------------------------------------------

	describe("token cache", () => {
		it("shares one login across concurrent cold-cache requests", async () => {
			const { getPlatformBearerToken } = await import("../dist/auth.js");
			await fetch(`${MOCK_BASE_URL}/platform/rest/__test/reset-login-count`, { method: "POST" });
			clearPlatformTokenCache();
			const tokens = await Promise.all(Array.from({ length: 6 }, () => getPlatformBearerToken(auth)));
			expect(new Set(tokens).size).toBe(1);
			const { count } = await mockGet("/__test/login-count");
			expect(count).toBe(1);
		});
	});

	// ---- Timesheet lifecycle -------------------------------------------------

	describe("timesheet lifecycle", () => {
		it("lists time periods, timesheets, history and adjustments", async () => {
			const {
				getTimePeriodsTool,
				listMyTimesheetsTool,
				getTimesheetHistoryTool,
				getTimesheetAdjustmentsTool,
			} = await import("../dist/tools/timesheet-lifecycle.js");

			const periods = await getTimePeriodsTool.handler(
				{ includeProjected: true, page: 1, pageSize: 50 },
				auth,
			);
			expect(periods.success).toBe(true);
			expect(periods.count).toBe(3);
			expect(periods.timePeriods[0]).toEqual({
				timePeriodKey: 1,
				beginDate: "2026-01-01",
				endDate: "2026-01-15",
			});

			const active = await listMyTimesheetsTool.handler(
				{ active: true, page: 1, pageSize: 25, sortOrder: "DESC" },
				auth,
			);
			expect(active.success).toBe(true);
			expect(active.timesheets.map((ts) => ts.key)).toEqual([201]);
			expect(active.timesheets[0].owner).toEqual({ key: 9, name: "Test User" });

			const history = await getTimesheetHistoryTool.handler(
				{ timesheetId: 201, page: 1, pageSize: 50 },
				auth,
			);
			expect(history.success).toBe(true);
			expect(history.history.map((h) => h.status)).toEqual(["INUSE", "SUBMITTED"]);

			const adjustments = await getTimesheetAdjustmentsTool.handler(
				{ timesheetId: 201, type: "ALL" },
				auth,
			);
			expect(adjustments.success).toBe(true);
			expect(adjustments.adjustments.timeslipsPending[0].project).toEqual({
				key: 101,
				name: "Test Project Alpha",
			});
		});

		let createdTimesheetKey;

		it("creates a timesheet only when none covers the date", async () => {
			const { createTimesheetTool } = await import("../dist/tools/timesheet.js");
			const blocked = await createTimesheetTool.handler(
				{ date: "2026-01-05", confirm: true },
				auth,
			);
			expect(blocked.success).toBe(false);
			expect(blocked.error).toContain("already exists");
			expect(blocked.timesheetKey).toBe(201);

			const created = await createTimesheetTool.handler(
				{ date: "2025-09-03", confirm: true },
				auth,
			);
			expect(created.success).toBe(true);
			expect(created.verified).toBe(true);
			createdTimesheetKey = created.timesheetKey;
			expect(createdTimesheetKey).toBeGreaterThan(0);
		});

		it("guards timesheet deletion on status and hours", async () => {
			const { deleteTimesheetTool } = await import(
				"../dist/tools/timesheet-lifecycle.js"
			);
			const submitted = await deleteTimesheetTool.handler(
				{ timesheetId: 202, allowNonEmpty: false, confirm: true },
				auth,
			);
			expect(submitted.success).toBe(false);
			expect(submitted.error).toContain("status SUBMITTED");

			const nonEmpty = await deleteTimesheetTool.handler(
				{ timesheetId: 201, allowNonEmpty: false, confirm: true },
				auth,
			);
			expect(nonEmpty.success).toBe(false);
			expect(nonEmpty.error).toContain("has 8 hours");
			expect(nonEmpty.hours).toBe(8);

			const empty = await deleteTimesheetTool.handler(
				{ timesheetId: createdTimesheetKey, allowNonEmpty: false, confirm: true },
				auth,
			);
			expect(empty.success).toBe(true);
			const deleted = await mockGet("/__test/deleted-timesheets");
			expect(deleted.keys).toContain(createdTimesheetKey);
			expect(deleted.keys).not.toContain(201);
		});

		it("uploads, lists, downloads and deletes timesheet attachments", async () => {
			const {
				addTimesheetAttachmentTool,
				getTimesheetAttachmentsTool,
				getTimesheetAttachmentTool,
				deleteTimesheetAttachmentTool,
			} = await import("../dist/tools/timesheet-lifecycle.js");
			const dir = mkdtempSync(join(tmpdir(), "unanet-ts-att-"));
			const file = join(dir, "note.pdf");
			writeFileSync(file, Buffer.from("%PDF-1.4 mock"));

			const uploaded = await addTimesheetAttachmentTool.handler(
				{ timesheetId: 201, filePath: file, confirm: true },
				auth,
			);
			expect(uploaded.success).toBe(true);
			expect(uploaded.verified).toBe(true);
			expect(uploaded.mimeType).toBe("application/pdf");

			const listed = await getTimesheetAttachmentsTool.handler(
				{ timesheetId: 201, page: 1, pageSize: 50 },
				auth,
			);
			expect(listed.attachments.map((a) => a.name)).toContain("note.pdf");

			const target = join(dir, "downloaded.pdf");
			const request = { timesheetId: 201, attachmentId: uploaded.attachmentId, saveTo: target };

			// Without the write flag, or without confirm, nothing is written.
			delete process.env.UNANET_ENABLE_WRITE_TOOLS;
			const noFlag = await getTimesheetAttachmentTool.handler({ ...request, confirm: true }, auth);
			expect(noFlag.success).toBe(false);
			expect(noFlag.error).toContain("UNANET_ENABLE_WRITE_TOOLS");
			process.env.UNANET_ENABLE_WRITE_TOOLS = "true";
			try {
				const noConfirm = await getTimesheetAttachmentTool.handler(request, auth);
				expect(noConfirm.success).toBe(false);
				expect(noConfirm.error).toContain("confirm=true");
				expect(existsSync(target)).toBe(false);

				const downloaded = await getTimesheetAttachmentTool.handler(
					{ ...request, confirm: true },
					auth,
				);
				expect(downloaded.success).toBe(true);
				expect(existsSync(target)).toBe(true);
				expect(readFileSync(target, "utf8")).toBe("%PDF-1.4 mock");
				// Refuses to overwrite by default.
				const again = await getTimesheetAttachmentTool.handler(
					{ ...request, confirm: true },
					auth,
				);
				expect(again.success).toBe(false);
				expect(again.error).toContain("already exists");
			} finally {
				delete process.env.UNANET_ENABLE_WRITE_TOOLS;
			}

			const removed = await deleteTimesheetAttachmentTool.handler(
				{ timesheetId: 201, attachmentId: uploaded.attachmentId, confirm: true },
				auth,
			);
			expect(removed.success).toBe(true);
			const after = await getTimesheetAttachmentsTool.handler(
				{ timesheetId: 201, page: 1, pageSize: 50 },
				auth,
			);
			expect(after.count).toBe(0);
		});
	});

	// ---- Leave requests --------------------------------------------------------

	describe("leave requests", () => {
		it("creates a draft, updates it, submits it, and refuses edits afterwards", async () => {
			const {
				getMyLeaveRequestsTool,
				createLeaveRequestTool,
				updateLeaveRequestTool,
				submitLeaveRequestTool,
				deleteLeaveRequestTool,
				cancelLeaveRequestTool,
			} = await import("../dist/tools/leave-requests.js");

			const created = await createLeaveRequestTool.handler(
				{ beginDate: "2026-07-01", endDate: "2026-07-02", hours: 16, nonWorkDays: false, confirm: true },
				auth,
			);
			expect(created.success).toBe(true);
			expect(created.leaveRequest.status).toBe("INUSE");
			const id = created.leaveRequestKey;

			const updated = await updateLeaveRequestTool.handler(
				{ leaveRequestId: id, hours: 24, endDate: "2026-07-03", confirm: true },
				auth,
			);
			expect(updated.success).toBe(true);
			expect(updated.leaveRequest.hours).toBe(24);
			expect(updated.leaveRequest.endDate).toBe("2026-07-03");
			expect(updated.leaveRequest.beginDate).toBe("2026-07-01");

			const badDates = await updateLeaveRequestTool.handler(
				{ leaveRequestId: id, endDate: "2026-06-01", confirm: true },
				auth,
			);
			expect(badDates.success).toBe(false);
			expect(badDates.error).toContain("after endDate");

			const submitted = await submitLeaveRequestTool.handler(
				{ leaveRequestId: id, comment: "Vacation", confirm: true },
				auth,
			);
			expect(submitted.success).toBe(true);
			expect(submitted.leaveRequest.status).toBe("SUBMITTED");

			const editAfterSubmit = await updateLeaveRequestTool.handler(
				{ leaveRequestId: id, hours: 8, confirm: true },
				auth,
			);
			expect(editAfterSubmit.success).toBe(false);
			expect(editAfterSubmit.error).toContain("status SUBMITTED");

			const deleteAfterSubmit = await deleteLeaveRequestTool.handler(
				{ leaveRequestId: id, confirm: true },
				auth,
			);
			expect(deleteAfterSubmit.success).toBe(false);
			expect(deleteAfterSubmit.error).toContain("unanet_cancel_leave_request");

			const cancelled = await cancelLeaveRequestTool.handler(
				{ leaveRequestId: id, confirm: true },
				auth,
			);
			expect(cancelled.success).toBe(true);
			expect(cancelled.leaveRequest.status).toBe("CANCELED");

			const listed = await getMyLeaveRequestsTool.handler(
				{ status: ["CANCELED"], page: 1, pageSize: 50, sortOrder: "DESC" },
				auth,
			);
			expect(listed.leaveRequests.map((lr) => lr.key)).toContain(id);
		});

		it("rejects invalid leave request input at the schema level", async () => {
			const { createLeaveRequestTool } = await import("../dist/tools/leave-requests.js");
			expect(() =>
				createLeaveRequestTool.inputSchema.parse({
					beginDate: "2026-07-05",
					endDate: "2026-07-01",
					hours: 8,
					confirm: true,
				}),
			).toThrow(/beginDate/);
			expect(() =>
				createLeaveRequestTool.inputSchema.parse({
					beginDate: "2026-07-01",
					endDate: "2026-07-01",
					hours: 8,
				}),
			).toThrow();
		});
	});

	// ---- Approvals & reviews ------------------------------------------------

	describe("approvals and reviews", () => {
		it("aggregates pending approvals across queues and reports forbidden ones", async () => {
			const { getMyPendingApprovalsTool } = await import("../dist/tools/approvals.js");
			const result = await getMyPendingApprovalsTool.handler(
				{ type: "all", role: "all", expenseRequests: false, page: 1, pageSize: 50 },
				auth,
			);
			expect(result.success).toBe(true);
			expect(result.totalPending).toBe(3);
			const managerTime = result.queues.find((q) => q.type === "time" && q.role === "manager");
			expect(managerTime.items[0]).toMatchObject({ id: 7001, person: "Report Person", hours: 80 });
			const leave = result.queues.find((q) => q.type === "leave-request");
			expect(leave.items[0]).toMatchObject({ id: 600, hours: 16 });
			// customer role is 403 in the mock: surfaced, not fatal.
			expect(result.endpointErrors.length).toBe(3);
			expect(result.endpointErrors.every((e) => e.role === "customer")).toBe(true);
		});

		it("reads approval detail with the manager preview message", async () => {
			const { getApprovalDetailTool } = await import("../dist/tools/approvals.js");
			const result = await getApprovalDetailTool.handler(
				{ type: "time", id: 7001, expenseRequests: false },
				auth,
			);
			expect(result.success).toBe(true);
			expect(result.item.timesheetKey).toBe(7001);
			expect(result.previewMessage).toBe("Looks good");
		});

		it("approves and disapproves with role validation", async () => {
			const { approveTool, disapproveTool } = await import("../dist/tools/approvals.js");

			const invalidCell = await approveTool.handler(
				{ type: "leave-request", role: "customer", id: 600, confirm: true },
				auth,
			);
			expect(invalidCell.success).toBe(false);
			expect(invalidCell.error).toContain("no approve action");

			const missingProject = await approveTool.handler(
				{ type: "time", role: "project-approver", id: 7001, confirm: true },
				auth,
			);
			expect(missingProject.success).toBe(false);
			expect(missingProject.error).toContain("projectKey is required");

			const approved = await approveTool.handler(
				{ type: "time", role: "manager", id: 7001, comment: "OK", confirm: true },
				auth,
			);
			expect(approved.success).toBe(true);

			const disapproved = await disapproveTool.handler(
				{
					type: "time",
					role: "manager",
					id: 7001,
					comment: "Wrong project",
					timeslips: [{ timeslipKey: 301, reason: "Should be PRJ-002" }],
					confirm: true,
				},
				auth,
			);
			expect(disapproved.success).toBe(true);

			// Legacy single-purpose tool must send ApproveModel.comment (singular).
			const { approveTimesheetTool } = await import("../dist/tools/timesheet.js");
			const legacy = await approveTimesheetTool.handler(
				{ timesheetId: "7002", comments: "Legacy OK", confirm: true },
				auth,
			);
			expect(legacy.success).toBe(true);

			const actions = await mockGet("/__test/approval-actions");
			expect(actions.pop()).toEqual({ type: "time", role: "manager", id: "7002", action: "approve", body: { comment: "Legacy OK" } });
			expect(actions).toEqual([
				{ type: "time", role: "manager", id: "7001", action: "approve", body: { comment: "OK" } },
				{
					type: "time",
					role: "manager",
					id: "7001",
					action: "disapprove",
					body: { comment: "Wrong project", timeslips: [{ timeslipKey: 301, reason: "Should be PRJ-002" }] },
				},
			]);
			// Schema requires confirm and a disapproval comment.
			expect(() => approveTool.inputSchema.parse({ type: "time", role: "manager", id: 1 })).toThrow();
			expect(() =>
				disapproveTool.inputSchema.parse({ type: "time", role: "manager", id: 1, confirm: true }),
			).toThrow();
		});

		it("lists and completes reviews", async () => {
			const { getMyPendingReviewsTool, completeReviewTool } = await import("../dist/tools/reviews.js");
			const pending = await getMyPendingReviewsTool.handler(
				{ type: "all", role: "all", page: 1, pageSize: 50 },
				auth,
			);
			expect(pending.success).toBe(true);
			expect(pending.totalPending).toBe(1);
			expect(pending.queues.find((q) => q.type === "time" && q.role === "owner").items[0].id).toBe(201);

			const invalid = await completeReviewTool.handler(
				{ type: "invoice", role: "owner", id: 1, confirm: true },
				auth,
			);
			expect(invalid.success).toBe(false);

			const done = await completeReviewTool.handler(
				{ type: "time", role: "owner", id: 201, comment: "Reviewed", confirm: true },
				auth,
			);
			expect(done.success).toBe(true);
			const actions = await mockGet("/__test/review-actions");
			expect(actions[0]).toMatchObject({ type: "time", roleOrId: "201", body: { comment: "Reviewed" } });
		});
	});

	// ---- User self-service ---------------------------------------------------

	describe("user self-service", () => {
		it("manages the My Projects list", async () => {
			const {
				getMyProjectsListTool,
				searchAvailableProjectsTool,
				addToMyProjectsTool,
				removeFromMyProjectsTool,
			} = await import("../dist/tools/user.js");

			const available = await searchAvailableProjectsTool.handler(
				{ projectTitle: "jersey", page: 1, pageSize: 50 },
				auth,
			);
			expect(available.success).toBe(true);
			expect(available.projects.map((p) => p.projectKey)).toEqual([103]);

			const added = await addToMyProjectsTool.handler(
				{ projects: [{ projectKey: 103 }], confirm: true },
				auth,
			);
			expect(added.success).toBe(true);
			let mine = await getMyProjectsListTool.handler({ page: 1, pageSize: 100 }, auth);
			expect(mine.projects.map((p) => p.projectKey)).toEqual([101, 103]);

			const removed = await removeFromMyProjectsTool.handler(
				{ projectKey: 103, confirm: true },
				auth,
			);
			expect(removed.success).toBe(true);
			mine = await getMyProjectsListTool.handler({ page: 1, pageSize: 100 }, auth);
			expect(mine.projects.map((p) => p.projectKey)).toEqual([101]);
		});

		it("reads rates and alternates", async () => {
			const { getMyRatesTool, getMyAlternatesTool } = await import("../dist/tools/user.js");
			const rates = await getMyRatesTool.handler({}, auth);
			expect(rates.success).toBe(true);
			expect(rates.rates[0].classification).toBe("EXEMPT");

			const alternates = await getMyAlternatesTool.handler(
				{ direction: "both", page: 1, pageSize: 50 },
				auth,
			);
			expect(alternates.success).toBe(true);
			expect(alternates.myAlternates.items[0].alternateName).toBe("Alt Approver");
			expect(alternates.myAlternates.items[0].roles[0].code).toBe("MGR");
			expect(alternates.alternateFor.items).toEqual([]);
		});
	});

	// ---- Expense lifecycle ---------------------------------------------------

	describe("expense lifecycle", () => {
		it("updates a draft report, edits and deletes a line, and submits with validation", async () => {
			const { createExpenseReportDraftTool, addExpenseDetailTool } = await import(
				"../dist/tools/expenses.js"
			);
			const {
				updateExpenseReportTool,
				getExpenseDetailTool,
				updateExpenseDetailTool,
				deleteExpenseDetailTool,
				getExpenseHistoryTool,
				getExpenseMealCapsTool,
				submitExpenseReportTool,
				deleteExpenseReportTool,
			} = await import("../dist/tools/expense-lifecycle.js");

			const draft = await createExpenseReportDraftTool.handler(
				{
					confirm: true,
					purpose: "Lifecycle test",
					voucherType: "EXPENSE_REPORT",
					expenseProjectAllocations: [{ projectKey: 501, allocation: 100 }],
				},
				auth,
			);
			expect(draft.success).toBe(true);
			const expenseId = draft.expenseId;

			const updated = await updateExpenseReportTool.handler(
				{ expenseId, purpose: "Lifecycle test (renamed)", location: "Trenton, NJ", confirm: true },
				auth,
			);
			expect(updated.success).toBe(true);
			expect(updated.expense.purpose).toBe("Lifecycle test (renamed)");
			expect(updated.expense.location).toBe("Trenton, NJ");
			// Allocations were preserved (required by the PUT model).
			expect(updated.expense.projectAllocations[0].projectKey).toBe(501);

			const emptySubmit = await submitExpenseReportTool.handler(
				{ expenseId, ignoreWarnings: false, confirm: true },
				auth,
			);
			expect(emptySubmit.success).toBe(false);
			expect(emptySubmit.error).toContain("no line items");

			const line = await addExpenseDetailTool.handler(
				{
					confirm: true,
					expenseId,
					expenseDate: "2026-06-02",
					expenseTypeKey: 301,
					paymentMethodKey: 401,
					transactionCurrency: 1,
					amount: 50,
					exchangeRate: 1,
					projectAllocationKey: 7100,
					summary: "Taxi",
					wizard: { type: "DEFAULT" },
				},
				auth,
			);
			expect(line.success).toBe(true);
			const detailId = line.detailId ?? line.detail?.key ?? line.expenseDetailId;
			expect(detailId).toBeTruthy();

			const editedLine = await updateExpenseDetailTool.handler(
				{ expenseId, detailId, amount: 75, summary: "Taxi to airport", confirm: true },
				auth,
			);
			expect(editedLine.success).toBe(true);
			expect(editedLine.detail.amount).toBe(75);
			expect(editedLine.detail.expenseAmount).toBe(75);
			expect(editedLine.detail.summary).toBe("Taxi to airport");

			const read = await getExpenseDetailTool.handler({ expenseId, detailId, includeRaw: false }, auth);
			expect(read.success).toBe(true);
			expect(read.detail.summary).toBe("Taxi to airport");

			const history = await getExpenseHistoryTool.handler({ expenseId, page: 1, pageSize: 50 }, auth);
			expect(history.success).toBe(true);
			expect(history.history[0].status).toBe("INUSE");
			const caps = await getExpenseMealCapsTool.handler({ expenseId }, auth);
			expect(caps.cap).toBe(79);

			// Mock validation warns when no receipt is attached: submission is held.
			const held = await submitExpenseReportTool.handler(
				{ expenseId, ignoreWarnings: false, confirm: true },
				auth,
			);
			expect(held.success).toBe(false);
			expect(held.validationWarnings).toEqual(["At least one receipt is missing"]);
			const stillDraft = await getExpenseDetailTool.handler({ expenseId, detailId, includeRaw: false }, auth);
			expect(stillDraft.success).toBe(true);

			const submitted = await submitExpenseReportTool.handler(
				{ expenseId, ignoreWarnings: true, confirm: true },
				auth,
			);
			expect(submitted.success).toBe(true);
			expect(submitted.expense.status).toBe("SUBMITTED");
			expect(submitted.submittedWarnings).toEqual(["At least one receipt is missing"]);

			// Now locked: edits, line deletes and report deletes are refused.
			const lockedEdit = await updateExpenseReportTool.handler(
				{ expenseId, purpose: "nope", confirm: true },
				auth,
			);
			expect(lockedEdit.success).toBe(false);
			expect(lockedEdit.error).toContain("not editable");
			const lockedDelete = await deleteExpenseDetailTool.handler(
				{ expenseId, detailId, confirm: true },
				auth,
			);
			expect(lockedDelete.success).toBe(false);
			const lockedReportDelete = await deleteExpenseReportTool.handler(
				{ expenseId, allowNonEmpty: true, confirm: true },
				auth,
			);
			expect(lockedReportDelete.success).toBe(false);
		});

		it("deletes an empty draft report but refuses non-empty ones without allowNonEmpty", async () => {
			const { createExpenseReportDraftTool, addExpenseDetailTool, getMyExpenseReportTool } = await import(
				"../dist/tools/expenses.js"
			);
			const { deleteExpenseReportTool, deleteExpenseDetailTool } = await import(
				"../dist/tools/expense-lifecycle.js"
			);
			const draft = await createExpenseReportDraftTool.handler(
				{
					confirm: true,
					purpose: "Delete me",
					voucherType: "EXPENSE_REPORT",
					expenseProjectAllocations: [{ projectKey: 501, allocation: 100 }],
				},
				auth,
			);
			const expenseId = draft.expenseId;
			await addExpenseDetailTool.handler(
				{
					confirm: true,
					expenseId,
					expenseDate: "2026-06-02",
					expenseTypeKey: 301,
					paymentMethodKey: 401,
					transactionCurrency: 1,
					amount: 10,
					exchangeRate: 1,
					projectAllocationKey: 7100,
					wizard: { type: "DEFAULT" },
				},
				auth,
			);
			const blocked = await deleteExpenseReportTool.handler(
				{ expenseId, allowNonEmpty: false, confirm: true },
				auth,
			);
			expect(blocked.success).toBe(false);
			expect(blocked.error).toContain("1 line item");

			const report = await getMyExpenseReportTool.handler({ expenseId, includeValidation: false }, auth);
			const detailId = report.expense.details?.[0]?.key ?? report.expense.lineItems?.[0]?.key;
			const removedLine = await deleteExpenseDetailTool.handler(
				{ expenseId, detailId, confirm: true },
				auth,
			);
			expect(removedLine.success).toBe(true);

			const deleted = await deleteExpenseReportTool.handler(
				{ expenseId, allowNonEmpty: false, confirm: true },
				auth,
			);
			expect(deleted.success).toBe(true);
			const gone = await getMyExpenseReportTool.handler({ expenseId, includeValidation: false }, auth);
			expect(gone.success).toBe(false);
		});

		it("reads approved requests and imported expenses, and places one on a report", async () => {
			const { createExpenseReportDraftTool } = await import("../dist/tools/expenses.js");
			const {
				getApprovedExpenseRequestsTool,
				searchImportedExpensesTool,
				addImportedExpenseToReportTool,
			} = await import("../dist/tools/expense-lifecycle.js");
			const requests = await getApprovedExpenseRequestsTool.handler({ page: 1, pageSize: 50 }, auth);
			expect(requests.success).toBe(true);
			expect(requests.requests[0].purpose).toBe("Conference travel");

			const imported = await searchImportedExpensesTool.handler(
				{ status: "AVAILABLE", expenseDateStart: "2026-05-01", expenseDateEnd: "2026-05-31", page: 1, pageSize: 50 },
				auth,
			);
			expect(imported.success).toBe(true);
			expect(imported.importedExpenses[0].vendor).toBe("UBER");
			expect(() =>
				searchImportedExpensesTool.inputSchema.parse({ importDateStart: "2026-05-01" }),
			).toThrow(/together/);

			const draft = await createExpenseReportDraftTool.handler(
				{
					confirm: true,
					purpose: "Card import",
					voucherType: "EXPENSE_REPORT",
					expenseProjectAllocations: [{ projectKey: 502, allocation: 100 }],
				},
				auth,
			);
			const placed = await addImportedExpenseToReportTool.handler(
				{ expenseId: draft.expenseId, importedExpenseKey: 8801, expenseTypeKey: 305, confirm: true },
				auth,
			);
			expect(placed.success).toBe(true);
			expect(placed.detailId).toBeTruthy();
		});
	});

	describe("runtime confirm guards", () => {
		it("refuse to write when confirm is not true even if the schema is bypassed", async () => {
			const { createExpenseReportDraftTool, addExpenseDetailTool, addExpenseAttachmentTool } = await import(
				"../dist/tools/expenses.js"
			);
			const { approveTool } = await import("../dist/tools/approvals.js");
			for (const [tool, args] of [
				[createExpenseReportDraftTool, { purpose: "x", expenseProjectAllocations: [{ projectKey: 501, allocation: 100 }] }],
				[addExpenseDetailTool, { expenseId: 9002, expenseDate: "2026-06-01", expenseTypeKey: 1, paymentMethodKey: 1, transactionCurrency: 1, amount: 1, projectAllocationKey: 7002, wizard: { type: "DEFAULT" } }],
				[addExpenseAttachmentTool, { expenseId: 9002, data: "aGk=", name: "x.pdf" }],
				[approveTool, { type: "time", role: "manager", id: 1 }],
			]) {
				const result = await tool.handler({ ...args, confirm: false }, auth);
				expect(result.success, tool.name).toBe(false);
				expect(result.error, tool.name).toMatch(/confirm=true/);
			}
		});
	});

	// ---- Directory reads --------------------------------------------------------

	describe("directory reads", () => {
		it("searches people, organizations, contracts, tasks, invoices and reference data", async () => {
			const {
				searchPeopleTool,
				getPersonTool,
				searchOrganizationsTool,
				getOrganizationTool,
				searchContractsTool,
				getProjectTasksTool,
				getProjectAssignmentsTool,
				searchInvoicesTool,
				getReferenceDataTool,
				pingTool,
			} = await import("../dist/tools/directory.js");

			const people = await searchPeopleTool.handler({ name: "jane", active: true, page: 1, pageSize: 50 }, auth);
			expect(people.success).toBe(true);
			expect(people.people).toEqual([
				expect.objectContaining({ key: 10, name: "Jane Smith", email: "jane@example.com" }),
			]);

			const person = await getPersonTool.handler(
				{ personId: 10, includeAssignments: true, includeLeaveBalances: false, includeRaw: false },
				auth,
			);
			expect(person.success).toBe(true);
			expect(person.person.laborCategory).toEqual({ key: 384, name: "Software Engineer" });
			expect(person.assignments.items[0].projectCode).toBe("PRJ-001");

			const orgs = await searchOrganizationsTool.handler({ page: 1, pageSize: 50 }, auth);
			expect(orgs.organizations.map((o) => o.code)).toEqual(["DEL", "NJDOL"]);
			const org = await getOrganizationTool.handler(
				{ organizationId: 2, includeContacts: true, includeAddresses: false, includeRaw: false },
				auth,
			);
			expect(org.organization.name).toContain("New Jersey");
			expect(org.contacts.items[0].name).toBe("Pat Contact");

			const contracts = await searchContractsTool.handler({ contractTitle: "NJ", page: 1, pageSize: 50 }, auth);
			expect(contracts.contracts[0]).toMatchObject({ contractCode: "C-001", ceilingAmount: 1000000 });

			const tasks = await getProjectTasksTool.handler({ projectId: 101, page: 1, pageSize: 100 }, auth);
			expect(tasks.tasks[0]).toMatchObject({ key: 5, name: "Research" });
			const taskSearch = await getProjectTasksTool.handler({ name: "deliv", page: 1, pageSize: 100 }, auth);
			expect(taskSearch.tasks.map((t) => t.name)).toEqual(["Delivery"]);

			const assignments = await getProjectAssignmentsTool.handler(
				{ projectId: 101, activeOnly: true, startDate: "2026-01-01", endDate: "2026-06-30", page: 1, pageSize: 100 },
				auth,
			);
			expect(assignments.success).toBe(true);
			expect(assignments.assignments[0].person).toEqual({ key: 10, name: "Jane Smith" });
			// DateRangeModel needs both ends; half-ranges are rejected at the schema.
			expect(() =>
				getProjectAssignmentsTool.inputSchema.parse({ projectId: 101, startDate: "2026-01-01" }),
			).toThrow(/together/);

			const invoices = await searchInvoicesTool.handler(
				{ invoiceDateStart: "2026-04-01", invoiceDateEnd: "2026-04-30", page: 1, pageSize: 50 },
				auth,
			);
			expect(invoices.success).toBe(true);
			expect(invoices.invoices[0]).toMatchObject({ invoiceNumber: "INV-1001", amount: 12000 });
			expect(() =>
				searchInvoicesTool.inputSchema.parse({ invoiceDateStart: "2026-04-01" }),
			).toThrow(/together/);

			const laborCategories = await getReferenceDataTool.handler(
				{ kind: "laborCategories", includeInactive: false, page: 1, pageSize: 100, includeRaw: false },
				auth,
			);
			expect(laborCategories.items.map((i) => i.name)).toEqual([
				"Software Engineer",
				"Senior Software Engineer",
			]);
			const payCodes = await getReferenceDataTool.handler(
				{ kind: "payCodes", includeInactive: false, page: 1, pageSize: 100, includeRaw: false },
				auth,
			);
			expect(payCodes.items[0]).toMatchObject({ key: 1, name: "RT" });

			const ping = await pingTool.handler({}, auth);
			expect(ping.success).toBe(true);
			expect(ping.version.version).toContain("mock");
		});
	});

	// ---- Generic spec-driven API tools -------------------------------------

	describe("generic API tools", () => {
		it("searches and describes operations offline from the committed catalog", async () => {
			const { searchApiOperationsTool, describeApiOperationTool } = await import("../dist/tools/api.js");
			const tags = await searchApiOperationsTool.handler({ limit: 50 }, auth);
			expect(tags.success).toBe(true);
			expect(tags.operationCount).toBeGreaterThan(1200);
			expect(tags.tags.find((t) => t.tag === "Projects").count).toBe(208);

			const search = await searchApiOperationsTool.handler(
				{ query: "vendor invoice search", kind: "read", limit: 10 },
				auth,
			);
			expect(search.success).toBe(true);
			expect(search.operations.some((op) => op.path === "/rest/vendor-invoices/search")).toBe(true);
			expect(search.operations.every((op) => op.kind === "read")).toBe(true);

			const described = await describeApiOperationTool.handler(
				{ method: "POST", path: "/rest/me/leave-requests", schemaDepth: 2 },
				auth,
			);
			expect(described.success).toBe(true);
			expect(described.operation.kind).toBe("write");
			expect(described.requestBodySchema.name).toBe("LeaveRequestCreateModel");
			const required = described.requestBodySchema.properties
				.filter((p) => p.required)
				.map((p) => p.name)
				.sort();
			expect(required).toEqual(["beginDate", "endDate", "hours"]);

			const sensitive = await describeApiOperationTool.handler(
				{ method: "POST", path: "/rest/me/time/{id}/submit", schemaDepth: 1 },
				auth,
			);
			expect(sensitive.operation.kind).toBe("sensitive");
			expect(sensitive.operation.executableWith).toContain("not executable");
			// Ledger/payment/auth-adjacent creates are sensitive even without a workflow verb.
			for (const path of ["/rest/fixed-assets/posts", "/rest/invoices/payment-portal/payout", "/rest/integrations/users", "/rest/journal-entries"]) {
				const op = await describeApiOperationTool.handler({ method: "POST", path, schemaDepth: 1 }, auth);
				expect(op.success, path).toBe(true);
				expect(op.operation.kind, path).toBe("sensitive");
			}
		});

		it("executes read operations and refuses non-read ones", async () => {
			const { apiReadTool } = await import("../dist/tools/api.js");
			const version = await apiReadTool.handler({ method: "GET", path: "/rest/ping/version" }, auth);
			expect(version.success).toBe(true);
			expect(version.data.version).toContain("mock");

			const withPathParam = await apiReadTool.handler(
				{ method: "GET", path: "/rest/projects/{id}/tasks", pathParams: { id: 101 } },
				auth,
			);
			expect(withPathParam.success).toBe(true);
			expect(withPathParam.data.items[0].name).toBe("Research");

			const missingParam = await apiReadTool.handler({ method: "GET", path: "/rest/projects/{id}/tasks" }, auth);
			expect(missingParam.success).toBe(false);
			expect(missingParam.error).toContain("Missing path parameter");

			const postSearch = await apiReadTool.handler(
				{ method: "POST", path: "/rest/people/search", body: { name: "jane" }, query: { page: 1, pageSize: 5 } },
				auth,
			);
			expect(postSearch.success).toBe(true);
			expect(postSearch.data.items[0].lastName).toBe("Smith");

			const refused = await apiReadTool.handler({ method: "POST", path: "/rest/me/leave-requests", body: {} }, auth);
			expect(refused.success).toBe(false);
			expect(refused.error).toContain("classified as 'write'");
		});

		it("has no generic writer and refuses secret-bearing reads", async () => {
			const api = await import("../dist/tools/api.js");
			expect(api.apiWriteTool).toBeUndefined();

			for (const [method, path, pathParams] of [
				["GET", "/rest/token/refresh"],
				["GET", "/rest/people/{id}/payroll", { id: 10 }],
				["GET", "/rest/integrations"],
				["GET", "/rest/me/device-tokens"],
				["GET", "/rest/config/system"],
				["GET", "/rest/bank-accounts"],
				["POST", "/rest/config/properties"],
			]) {
				const result = await api.apiReadTool.handler({ method, path, pathParams, body: {} }, auth);
				expect(result.success, `${method} ${path}`).toBe(false);
				expect(result.error, `${method} ${path}`).toContain("classified as 'sensitive'");
			}
		});
	});

	// ---- Server registration tiers -------------------------------------------

	describe("tool tiers over MCP", () => {
		async function listTools(env) {
			const serverProcess = spawn("node", ["dist/index.js"], {
				env: {
					...process.env,
					UNANET_USERNAME: "test-user",
					UNANET_PASSWORD: "test-pass",
					UNANET_BASE_URL: MOCK_BASE_URL,
					UNANET_ALLOW_INSECURE_LOCAL_MOCK: "true",
					// Explicit values stop dotenv from loading tier flags out of a
					// developer's local .env.
					UNANET_ENABLE_LEGACY_READ_TOOLS: "false",
					UNANET_ENABLE_EXTENDED_READ_TOOLS: "false",
					UNANET_ENABLE_WRITE_TOOLS: "false",
					...env,
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 800));
			const names = await new Promise((resolve) => {
				let buffer = "";
				serverProcess.stdout.on("data", (data) => {
					buffer += data.toString();
					try {
						const response = JSON.parse(buffer);
						resolve(response.result.tools.map((tool) => tool.name));
					} catch {
						// wait for more data
					}
				});
				serverProcess.stdin.write(
					JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 1 }) + "\n",
				);
			});
			serverProcess.kill();
			return names;
		}

		it("registers only self-service reads by default", async () => {
			const names = await listTools({});
			expect(names).toContain("unanet_get_my_pending_approvals");
			expect(names).toContain("unanet_get_my_leave_requests");
			expect(names).toContain("unanet_list_my_timesheets");
			expect(names).toContain("unanet_get_expense_history");
			expect(names).not.toContain("unanet_search_people");
			expect(names).not.toContain("unanet_api_read");
			expect(names).not.toContain("unanet_approve");
			expect(names).not.toContain("unanet_submit_expense_report");
			expect(names).not.toContain("unanet_api_write");
		});

		it("adds org-level reads and the generic reader with the extended flag", async () => {
			const names = await listTools({ UNANET_ENABLE_EXTENDED_READ_TOOLS: "true" });
			expect(names).toContain("unanet_search_people");
			expect(names).toContain("unanet_get_reference_data");
			expect(names).toContain("unanet_api_search_operations");
			expect(names).toContain("unanet_api_read");
			expect(names).not.toContain("unanet_api_write");
			expect(names).not.toContain("unanet_approve");
		});

		it("adds all write tools with the write flag", async () => {
			const names = await listTools({
				UNANET_ENABLE_EXTENDED_READ_TOOLS: "true",
				UNANET_ENABLE_WRITE_TOOLS: "true",
			});
			expect(names).toContain("unanet_approve");
			expect(names).toContain("unanet_disapprove");
			expect(names).toContain("unanet_create_leave_request");
			expect(names).toContain("unanet_submit_expense_report");
			expect(names).toContain("unanet_create_timesheet");
			expect(names).not.toContain("unanet_api_write");
			expect(new Set(names).size).toBe(names.length);
			expect(names.length).toBe(94);
			expect(names).toContain("unanet_assign_people_to_project");
		});
	});
});
