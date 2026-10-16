#!/usr/bin/env node
// Read-only live smoke test against the real Unanet tenant.
//
//   npm run build && node test/smoke-readonly.mjs [--verbose] [--only=name,name]
//
// Loads credentials from .env (never printed). Invokes ONLY read tool handlers
// — no write tool is imported or called, and UNANET_ENABLE_WRITE_TOOLS is
// ignored. Prints, per tool: ok/fail, timing, item counts and the top-level
// keys of the response so shapes can be eyeballed against the Unanet UI.
// Personal data is summarised, not dumped, unless --verbose is passed.

import dotenv from "dotenv";
import { formatLocalDate } from "../dist/utils/http.js";

dotenv.config();

const verbose = process.argv.includes("--verbose");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice(7).split(",")) : null;

const auth = {
	username: process.env.UNANET_USERNAME || "",
	password: process.env.UNANET_PASSWORD || "",
	baseUrl: process.env.UNANET_BASE_URL || "https://navapbc.unanet.biz",
	appName: process.env.UNANET_APP_NAME || "NavaUnanetMCP",
	customerId: process.env.UNANET_CUSTOMER_ID || undefined,
};
if (!auth.username || !auth.password) {
	console.error("UNANET_USERNAME / UNANET_PASSWORD missing from .env");
	process.exit(1);
}

const today = formatLocalDate();
const yearStart = `${today.slice(0, 4)}-01-01`;
const d = new Date();
d.setDate(d.getDate() - 60);
const sixtyDaysAgo = formatLocalDate(d);

const leave = await import("../dist/tools/leave.js");
const leaveRequests = await import("../dist/tools/leave-requests.js");
const expenses = await import("../dist/tools/expenses.js");
const expenseLifecycle = await import("../dist/tools/expense-lifecycle.js");
const timesheet = await import("../dist/tools/timesheet.js");
const timesheetLifecycle = await import("../dist/tools/timesheet-lifecycle.js");
const approvals = await import("../dist/tools/approvals.js");
const reviews = await import("../dist/tools/reviews.js");
const user = await import("../dist/tools/user.js");
const projects = await import("../dist/tools/projects.js");
const directory = await import("../dist/tools/directory.js");
const api = await import("../dist/tools/api.js");

// Discovered keys are threaded from earlier calls into later ones.
const ctx = {};

const cases = [
	// --- self-service ---
	["ping", directory.pingTool, {}],
	["leave balances", leave.getMyLeaveBalancesTool, { pageSize: 50 }],
	["leave requests", leaveRequests.getMyLeaveRequestsTool, { page: 1, pageSize: 20, sortOrder: "DESC" }, (r) => { ctx.leaveRequestId = r.leaveRequests?.[0]?.key; }],
	["leave request history", leaveRequests.getLeaveRequestHistoryTool, () => ({ leaveRequestId: ctx.leaveRequestId, page: 1, pageSize: 20 }), null, () => ctx.leaveRequestId],
	["my expenses", expenses.getMyExpensesTool, { startDate: yearStart, endDate: today, pageSize: 20 }, (r) => { const e = (r.expenses ?? r.expenseReports ?? [])[0]; ctx.expenseId = e?.key; }],
	["expense report", expenses.getMyExpenseReportTool, () => ({ expenseId: ctx.expenseId, includeValidation: true }), (r) => { ctx.detailId = r.expense?.details?.[0]?.key; }, () => ctx.expenseId],
	["expense detail", expenseLifecycle.getExpenseDetailTool, () => ({ expenseId: ctx.expenseId, detailId: ctx.detailId, includeRaw: false }), null, () => ctx.expenseId && ctx.detailId],
	["expense history", expenseLifecycle.getExpenseHistoryTool, () => ({ expenseId: ctx.expenseId, page: 1, pageSize: 20 }), null, () => ctx.expenseId],
	["expense meal caps", expenseLifecycle.getExpenseMealCapsTool, () => ({ expenseId: ctx.expenseId }), null, () => ctx.expenseId],
	["expense attachments", expenses.getExpenseAttachmentsTool, () => ({ expenseId: ctx.expenseId, page: 1, pageSize: 20 }), null, () => ctx.expenseId],
	["expense reference data", expenses.getExpenseReferenceDataTool, { pageSize: 20 }],
	["approved expense requests", expenseLifecycle.getApprovedExpenseRequestsTool, { page: 1, pageSize: 20 }],
	["imported expenses (AVAILABLE)", expenseLifecycle.searchImportedExpensesTool, { status: "AVAILABLE", page: 1, pageSize: 20 }],
	["timesheets (60d)", timesheet.getTimesheetsTool, { startDate: sixtyDaysAgo, endDate: today, status: "All", limit: 5 }, (r) => { ctx.timesheetId = r.timesheets?.[0]?.id; }],
	["list my timesheets", timesheetLifecycle.listMyTimesheetsTool, { page: 1, pageSize: 10, sortOrder: "DESC" }, (r) => { ctx.timesheetId ??= r.timesheets?.[0]?.key; }],
	["time periods", timesheetLifecycle.getTimePeriodsTool, { includeProjected: true, page: 1, pageSize: 20 }],
	["timesheet projects", timesheet.getMyTimesheetProjectsTool, { limit: 20 }],
	["timesheet history", timesheetLifecycle.getTimesheetHistoryTool, () => ({ timesheetId: ctx.timesheetId, page: 1, pageSize: 20 }), null, () => ctx.timesheetId],
	["timesheet adjustments", timesheetLifecycle.getTimesheetAdjustmentsTool, () => ({ timesheetId: ctx.timesheetId, type: "ALL" }), null, () => ctx.timesheetId],
	["timesheet attachments", timesheetLifecycle.getTimesheetAttachmentsTool, () => ({ timesheetId: ctx.timesheetId, page: 1, pageSize: 20 }), null, () => ctx.timesheetId],
	["pending approvals", approvals.getMyPendingApprovalsTool, { type: "all", role: "all", expenseRequests: false, page: 1, pageSize: 20 }],
	["approval alternates", approvals.getApprovalAlternatesTool, { page: 1, pageSize: 20 }],
	["pending reviews", reviews.getMyPendingReviewsTool, { type: "all", role: "all", page: 1, pageSize: 20 }],
	["my projects list", user.getMyProjectsListTool, { page: 1, pageSize: 50 }, (r) => { ctx.projectKey = r.projects?.[0]?.projectKey; }],
	["available projects", user.searchAvailableProjectsTool, { page: 1, pageSize: 10 }],
	["my rates", user.getMyRatesTool, {}],
	["my alternates", user.getMyAlternatesTool, { direction: "both", page: 1, pageSize: 20 }],
	["my attachments", user.getMyAttachmentsTool, { page: 1, pageSize: 20 }],
	// --- extended reads ---
	["projects search", projects.getProjectsTool, { status: "Active", limit: 5 }, (r) => { ctx.projectKey ??= r.projects?.[0]?.key; }],
	["project details", projects.getProjectDetailsTool, () => ({ projectId: String(ctx.projectKey) }), null, () => ctx.projectKey],
	["project tasks", directory.getProjectTasksTool, () => ({ projectId: ctx.projectKey, page: 1, pageSize: 20 }), null, () => ctx.projectKey],
	["project assignments", directory.getProjectAssignmentsTool, () => ({ projectId: ctx.projectKey, activeOnly: true, page: 1, pageSize: 20 }), null, () => ctx.projectKey],
	["project notes", directory.getProjectNotesTool, () => ({ projectId: ctx.projectKey }), null, () => ctx.projectKey],
	["project admins", directory.getProjectAdminsTool, () => ({ projectId: ctx.projectKey, roles: ["managers", "project-approvers"] }), null, () => ctx.projectKey],
	["people search (self)", directory.searchPeopleTool, { name: auth.username, active: true, page: 1, pageSize: 5 }, (r) => { ctx.personKey = r.people?.[0]?.key; }],
	["person", directory.getPersonTool, () => ({ personId: ctx.personKey, includeAssignments: true, includeLeaveBalances: true, includeRaw: false }), null, () => ctx.personKey],
	["organizations search", directory.searchOrganizationsTool, { active: true, page: 1, pageSize: 5 }, (r) => { ctx.orgKey = r.organizations?.[0]?.key; }],
	["organization", directory.getOrganizationTool, () => ({ organizationId: ctx.orgKey, includeContacts: true, includeAddresses: true, includeRaw: false }), null, () => ctx.orgKey],
	["contracts search", directory.searchContractsTool, { page: 1, pageSize: 5 }, (r) => { ctx.contractKey = r.contracts?.[0]?.key; }],
	["contract", directory.getContractTool, () => ({ contractId: ctx.contractKey, includeProjects: true, includeMods: true, includeRaw: false }), null, () => ctx.contractKey],
	["invoices search (year)", directory.searchInvoicesTool, { invoiceDateStart: yearStart, invoiceDateEnd: today, page: 1, pageSize: 5 }, (r) => { ctx.invoiceKey = r.invoices?.[0]?.key; }],
	["invoice", directory.getInvoiceTool, () => ({ invoiceId: ctx.invoiceKey, includeHistory: true, includeTransactionSummary: true, includeRaw: false }), null, () => ctx.invoiceKey],
	["reference: laborCategories", directory.getReferenceDataTool, { kind: "laborCategories", includeInactive: false, page: 1, pageSize: 10, includeRaw: false }],
	["reference: payCodes", directory.getReferenceDataTool, { kind: "payCodes", includeInactive: false, page: 1, pageSize: 10, includeRaw: false }],
	["reference: projectTypes", directory.getReferenceDataTool, { kind: "projectTypes", includeInactive: false, page: 1, pageSize: 10, includeRaw: false }],
	["reference: locations", directory.getReferenceDataTool, { kind: "locations", includeInactive: false, page: 1, pageSize: 10, includeRaw: false }],
	["reference: projectStatuses", directory.getReferenceDataTool, { kind: "projectStatuses", includeInactive: false, page: 1, pageSize: 10, includeRaw: false }],
	["reference: employeeTypes", directory.getReferenceDataTool, { kind: "employeeTypes", includeInactive: false, page: 1, pageSize: 10, includeRaw: false }],
	["reference: fiscalYears", directory.getReferenceDataTool, { kind: "fiscalYears", includeInactive: false, page: 1, pageSize: 10, includeRaw: false }],
	["reference: contractTypes", directory.getReferenceDataTool, { kind: "contractTypes", includeInactive: false, page: 1, pageSize: 10, includeRaw: false }],
	["api catalog: tags", api.searchApiOperationsTool, { limit: 5 }],
	["api read: GET /rest/ping/version", api.apiReadTool, { method: "GET", path: "/rest/ping/version" }],
	["api read: GET /rest/me/time/time-periods", api.apiReadTool, { method: "GET", path: "/rest/me/time/time-periods", query: { page: 1, pageSize: 3 } }],
];

function countOf(result) {
	if (typeof result?.count === "number") return result.count;
	if (typeof result?.totalPending === "number") return result.totalPending;
	for (const value of Object.values(result ?? {})) if (Array.isArray(value)) return value.length;
	return null;
}

const rows = [];
for (const [label, tool, argsOrFn, after, precondition] of cases) {
	if (only && !only.has(label) && !only.has(tool.name)) continue;
	if (precondition && !precondition()) {
		rows.push({ label, tool: tool.name, status: "skip", note: "no key discovered upstream" });
		continue;
	}
	const args = typeof argsOrFn === "function" ? argsOrFn() : argsOrFn;
	let parsed;
	try {
		parsed = tool.inputSchema.parse(args);
	} catch (error) {
		rows.push({ label, tool: tool.name, status: "schema-fail", note: error.message.split("\n")[0] });
		continue;
	}
	const started = Date.now();
	const result = await tool.handler(parsed, auth);
	const ms = Date.now() - started;
	const ok = result?.success === true;
	const note = ok
		? `count=${countOf(result) ?? "-"} keys=[${Object.keys(result).filter((k) => k !== "success").slice(0, 8).join(",")}]${result.endpointErrors?.length ? ` endpointErrors=${result.endpointErrors.length}` : ""}`
		: `error=${result?.error}`;
	rows.push({ label, tool: tool.name, status: ok ? "ok" : "FAIL", ms, note });
	if (verbose) console.log(`\n### ${label}\n${JSON.stringify(result, null, 2).slice(0, 4000)}`);
	if (ok && after) {
		try { after(result); } catch { /* ignore */ }
	}
}

const pad = (s, n) => String(s ?? "").padEnd(n);
console.log(`\nLive read-only smoke test — ${auth.baseUrl} — ${new Date().toISOString()}\n`);
for (const r of rows) console.log(`${pad(r.status, 11)} ${pad(r.ms ? r.ms + "ms" : "", 7)} ${pad(r.label, 34)} ${pad(r.tool, 42)} ${r.note ?? ""}`);
const summary = rows.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
console.log(`\nSummary: ${JSON.stringify(summary)}`);
process.exit(summary.FAIL || summary["schema-fail"] ? 1 : 0);
