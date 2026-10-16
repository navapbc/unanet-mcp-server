// Mock Platform REST routes for the extended tool surface (timesheet
// lifecycle, leave requests, approvals, reviews, user, expense lifecycle,
// directory reads). Registered from mock-server.ts BEFORE the `:id` routes so
// literal segments like /me/time/time-periods win.

import type { Express } from "express";

export interface MockState {
	mockExpenses: any[];
	mockAttachments: Record<number, any[]>;
	nextDetailKey: () => number;
	nextAttachmentKey: () => number;
}

const paged = (items: any[]) => ({
	items,
	page: 1,
	pageSize: items.length,
	pageCount: 1,
	resultCount: items.length,
});

// DateRangeModel is { rangeStart, rangeEnd } (both required). Reject the
// tempting-but-wrong { start, end } so tests catch the mismatch.
function invalidDateRange(range: any): boolean {
	if (range === undefined || range === null) return false;
	return (
		typeof range !== "object" ||
		"start" in range ||
		"end" in range ||
		typeof range.rangeStart !== "string" ||
		typeof range.rangeEnd !== "string"
	);
}

export function registerExtendedMockRoutes(app: Express, state: MockState): void {
	// ---- Ping ---------------------------------------------------------------
	app.get("/platform/rest/ping", (_req, res) => res.json({ status: "OK" }));
	app.get("/platform/rest/ping/version", (_req, res) =>
		res.json({ version: "26.4.0.10440-mock" }),
	);

	// ---- User Time: lifecycle ----------------------------------------------
	app.get("/platform/rest/me/time/time-periods", (req, res) => {
		res.json(
			paged([
				{ timePeriodKey: 1, beginDate: "2026-01-01", endDate: "2026-01-15" },
				{ timePeriodKey: 1, beginDate: "2026-01-16", endDate: "2026-01-31" },
				...(req.query.includeProjected === "true"
					? [{ timePeriodKey: 1, beginDate: "2026-02-01", endDate: "2026-02-15" }]
					: []),
			]),
		);
	});

	app.get("/platform/rest/me/time", (req, res) => {
		const all = [
			{ key: 201, beginDate: "2026-01-01", endDate: "2026-01-15", status: "INUSE", hours: 8, owner: { key: 9, name: "Test User" } },
			{ key: 202, beginDate: "2025-12-16", endDate: "2025-12-31", status: "COMPLETED", hours: 80, owner: { key: 9, name: "Test User" } },
		];
		const active = req.query.active;
		res.json(
			paged(
				all.filter((ts) =>
					active === undefined ? true : active === "true" ? ts.status === "INUSE" : ts.status !== "INUSE",
				),
			),
		);
	});

	// POST /me/time (create) lives in mock-server.ts, which models creation.
	const deletedTimesheets = new Set<number>();
	app.delete("/platform/rest/me/time/:id", (req, res) => {
		deletedTimesheets.add(Number(req.params.id));
		res.status(204).end();
	});
	app.get("/platform/rest/__test/deleted-timesheets", (_req, res) =>
		res.json({ keys: [...deletedTimesheets] }),
	);

	app.get("/platform/rest/me/time/:id/history", (req, res) => {
		res.json(
			paged([
				{ key: 1, timesheetKey: Number(req.params.id), status: "INUSE", actionTimestamp: "2026-01-02T09:00:00Z", performedBy: { key: 9, name: "Test User" } },
				{ key: 2, timesheetKey: Number(req.params.id), status: "SUBMITTED", actionTimestamp: "2026-01-16T09:00:00Z", performedBy: { key: 9, name: "Test User" }, comments: "Submitted" },
			]),
		);
	});
	app.get("/platform/rest/me/time/:id/adjustments", (_req, res) => {
		res.json({
			timeslipAdjustmentsPending: [
				{ key: 301, workDate: "2026-01-01", hoursWorked: 8, project: { key: 101, name: "Test Project Alpha" } },
			],
			timeslipAdjustmentsCompleted: [],
		});
	});
	app.post("/platform/rest/me/time/:id/adjustments/reason", (_req, res) => res.status(204).end());

	const timesheetAttachments: Record<number, any[]> = {};
	app.get("/platform/rest/me/time/:id/attachments", (req, res) => {
		res.json(paged((timesheetAttachments[Number(req.params.id)] ?? []).map(({ data: _d, ...rest }) => rest)));
	});
	app.post("/platform/rest/me/time/:id/attachment", (req, res) => {
		const key = state.nextAttachmentKey();
		const list = (timesheetAttachments[Number(req.params.id)] ??= []);
		list.push({ key, ...req.body, created: "2026-01-05T10:00:00Z" });
		res.json({ key });
	});
	app.get("/platform/rest/me/time/:id/attachment/:aid", (req, res) => {
		const found = (timesheetAttachments[Number(req.params.id)] ?? []).find(
			(a) => a.key === Number(req.params.aid),
		);
		if (!found) return res.status(404).json({ error: "not found" });
		res.json(found);
	});
	app.delete("/platform/rest/me/time/:id/attachment/:aid", (req, res) => {
		const list = timesheetAttachments[Number(req.params.id)] ?? [];
		timesheetAttachments[Number(req.params.id)] = list.filter((a) => a.key !== Number(req.params.aid));
		res.status(204).end();
	});

	// ---- User Leave Requests -----------------------------------------------
	let nextLeaveKey = 601;
	const leaveRequests: any[] = [
		{ key: 600, person: { key: 9, name: "Test User" }, hours: 8, nonWorkDays: false, status: "COMPLETED", beginDate: "2025-12-24", endDate: "2025-12-24", comments: "Holiday" },
	];
	app.get("/platform/rest/me/leave-requests", (req, res) => {
		const statuses = req.query.status ? String(req.query.status).split(",") : null;
		res.json(paged(leaveRequests.filter((lr) => !statuses || statuses.includes(lr.status))));
	});
	app.post("/platform/rest/me/leave-requests", (req, res) => {
		const key = nextLeaveKey++;
		leaveRequests.push({ key, person: { key: 9, name: "Test User" }, status: "INUSE", ...req.body });
		res.json({ key });
	});
	app.put("/platform/rest/me/leave-requests/:id", (req, res) => {
		const index = leaveRequests.findIndex((lr) => lr.key === Number(req.params.id));
		if (index < 0) return res.status(404).json({ error: "not found" });
		leaveRequests[index] = { ...leaveRequests[index], ...req.body, key: Number(req.params.id) };
		res.status(204).end();
	});
	app.delete("/platform/rest/me/leave-requests/:id", (req, res) => {
		const index = leaveRequests.findIndex((lr) => lr.key === Number(req.params.id));
		if (index >= 0) leaveRequests.splice(index, 1);
		res.status(204).end();
	});
	app.post("/platform/rest/me/leave-requests/:id/submit", (req, res) => {
		const lr = leaveRequests.find((item) => item.key === Number(req.params.id));
		if (!lr) return res.status(404).json({ error: "not found" });
		lr.status = "SUBMITTED";
		res.status(204).end();
	});
	app.post("/platform/rest/me/leave-requests/:id/cancel", (req, res) => {
		const lr = leaveRequests.find((item) => item.key === Number(req.params.id));
		if (!lr) return res.status(404).json({ error: "not found" });
		lr.status = "CANCELED";
		res.status(204).end();
	});
	app.get("/platform/rest/me/leave-requests/:id/history", (req, res) => {
		res.json(paged([{ leaveRequestKey: Number(req.params.id), status: "INUSE", actionTimestamp: "2026-01-01T00:00:00Z", performedBy: { key: 9, name: "Test User" } }]));
	});

	// ---- User Approvals -----------------------------------------------------
	const approvalActions: any[] = [];
	app.get("/platform/rest/__test/approval-actions", (_req, res) => res.json(approvalActions));
	app.get("/platform/rest/me/approvals/alternates/:role", (_req, res) =>
		res.json(paged([{ person: { key: 42, name: "Primary Approver" }, approvalTypes: ["TIME"] }])),
	);
	app.get("/platform/rest/me/approvals/time/manager/:id/preview-message", (_req, res) =>
		res.json({ message: "Looks good" }),
	);
	app.get("/platform/rest/me/approvals/time/manager/:id", (req, res) =>
		res.json({ timesheetKey: Number(req.params.id), name: "Report Person", beginDate: "2026-01-01", endDate: "2026-01-15", hours: 80, status: "SUBMITTED" }),
	);
	app.get("/platform/rest/me/approvals/expense/manager/:id", (req, res) =>
		res.json({ expenseReportKey: Number(req.params.id), name: "Report Person", amount: 120.5, purpose: "Travel", status: "SUBMITTED", expenseReportCurrency: { code: "USD" } }),
	);
	app.get("/platform/rest/me/approvals/:type/:role", (req, res) => {
		const { type, role } = req.params;
		if (role === "customer") return res.status(403).json({ error: "Forbidden" });
		if (type === "time") {
			return res.json(paged(role === "manager" ? [{ timesheetKey: 7001, name: "Report Person", beginDate: "2026-01-01", endDate: "2026-01-15", hours: 80, status: "SUBMITTED" }] : []));
		}
		if (type === "expense") {
			return res.json(paged(role === "manager" ? [{ expenseReportKey: 9002, name: "Report Person", amount: 83.86, purpose: "Chicago travel", status: "SUBMITTED", expenseReportCurrency: { code: "USD" } }] : []));
		}
		if (type === "leave-request") {
			return res.json(paged([{ key: 600, personKey: 10, name: "Report Person", beginDate: "2026-02-02", endDate: "2026-02-03", hours: 16, status: "SUBMITTED" }]));
		}
		return res.json(paged([]));
	});
	app.post("/platform/rest/me/approvals/:type/:role/:id/:action", (req, res) => {
		if (req.body && "comments" in req.body) {
			return res.status(400).json({ error: "ApproveModel field is `comment`, not `comments`" });
		}
		approvalActions.push({ ...req.params, body: req.body });
		res.status(204).end();
	});

	// ---- User Reviews -------------------------------------------------------
	const reviewActions: any[] = [];
	app.get("/platform/rest/__test/review-actions", (_req, res) => res.json(reviewActions));
	app.get("/platform/rest/me/reviews/:type/:role", (req, res) => {
		if (req.params.role === "customer") return res.status(403).json({ error: "Forbidden" });
		res.json(paged([]));
	});
	app.get("/platform/rest/me/reviews/:type", (req, res) => {
		res.json(paged(req.params.type === "time" ? [{ timesheetKey: 201, name: "Test User", beginDate: "2026-01-01", endDate: "2026-01-15", hours: 80, status: "COMPLETED" }] : []));
	});
	app.post("/platform/rest/me/reviews/:type/:roleOrId/:id?", (req, res) => {
		reviewActions.push({ ...req.params, body: req.body });
		res.status(204).end();
	});

	// ---- User -----------------------------------------------------------------
	const myProjects: any[] = [
		{ projectKey: 101, projectCode: "PRJ-001", projectTitle: "Test Project Alpha", taskKey: null, organizationCode: "DELIVERY" },
	];
	app.get("/platform/rest/me/my-projects", (_req, res) => res.json(paged(myProjects)));
	app.post("/platform/rest/me/my-projects", (req, res) => {
		for (const item of req.body ?? []) myProjects.push({ ...item, projectCode: `PRJ-${item.projectKey}`, projectTitle: `Project ${item.projectKey}` });
		res.status(204).end();
	});
	app.post("/platform/rest/me/my-projects/available", (req, res) => {
		const title = String(req.body?.projectTitle ?? "").toLowerCase();
		const all = [
			{ projectKey: 102, projectCode: "AI-PROJECT", projectTitle: "AI Internal Enablement", taskKey: 5, taskName: "Research" },
			{ projectKey: 103, projectCode: "NJ-DOL", projectTitle: "New Jersey DOL Appeals", taskKey: null },
		];
		res.json(paged(all.filter((p) => !title || p.projectTitle.toLowerCase().includes(title))));
	});
	app.delete("/platform/rest/me/my-projects/:pid", (req, res) => {
		const index = myProjects.findIndex((p) => p.projectKey === Number(req.params.pid));
		if (index >= 0) myProjects.splice(index, 1);
		res.status(204).end();
	});
	app.get("/platform/rest/me/rates", (_req, res) =>
		res.json([{ key: 1, personKey: 9, classification: "EXEMPT", beginDate: "2024-01-01" }]),
	);
	app.get("/platform/rest/me/alternates", (_req, res) =>
		res.json(paged([{ personKey: 9, alternate: { key: 11, firstName: "Alt", lastName: "Approver" }, roles: [{ key: 1, name: "Manager", code: "MGR" }] }])),
	);
	app.get("/platform/rest/me/alternates/for", (_req, res) => res.json(paged([])));
	app.put("/platform/rest/me/alternates", (_req, res) => res.status(204).end());
	const userAttachments: any[] = [];
	app.get("/platform/rest/me/attachments", (_req, res) => res.json(paged(userAttachments.map(({ data: _d, ...rest }) => rest))));
	app.post("/platform/rest/me/attachments", (req, res) => {
		const key = state.nextAttachmentKey();
		userAttachments.push({ key, ...req.body, created: "2026-01-05T10:00:00Z" });
		res.json({ key });
	});
	app.get("/platform/rest/me/attachments/:id", (req, res) => {
		const found = userAttachments.find((a) => a.key === Number(req.params.id));
		if (!found) return res.status(404).json({ error: "not found" });
		res.json(found);
	});
	app.delete("/platform/rest/me/attachments/:id", (req, res) => {
		const index = userAttachments.findIndex((a) => a.key === Number(req.params.id));
		if (index >= 0) userAttachments.splice(index, 1);
		res.status(204).end();
	});

	// ---- User Expenses: lifecycle -------------------------------------------
	const findExpense = (id: string) => state.mockExpenses.find((e) => e.key === Number(id));
	app.get("/platform/rest/me/expenses/approved-requests", (_req, res) =>
		res.json(paged([{ key: 5001, expenseReportKey: null, purpose: "Conference travel", status: "AUTHORIZATION_APPROVED", totalExpenses: 900, expenseCurrencyCode: "USD", owner: { key: 9, name: "Test User" } }])),
	);
	app.get("/platform/rest/me/expenses/approved-requests/:id", (req, res) =>
		res.json({ key: Number(req.params.id), purpose: "Conference travel", status: "AUTHORIZATION_APPROVED", totalExpenses: 900 }),
	);
	app.post("/platform/rest/me/expenses/imported/search", (req, res) => {
		if (invalidDateRange(req.body?.expenseDateRange) || invalidDateRange(req.body?.importDateRange)) {
			return res.status(400).json({ error: "DateRangeModel requires rangeStart and rangeEnd" });
		}
		const status = req.body?.status ?? "AVAILABLE";
		res.json(paged(status === "USED" ? [] : [{ key: 8801, vendor: "UBER", amount: 23.4, expenseDate: "2026-05-18", status: "AVAILABLE" }]));
	});
	app.put("/platform/rest/me/expenses/:id", (req, res) => {
		const expense = findExpense(req.params.id);
		if (!expense) return res.status(404).json({ error: "not found" });
		if (!Array.isArray(req.body?.expenseProjectAllocations) || req.body.expenseProjectAllocations.length === 0) {
			return res.status(400).json({ error: "expenseProjectAllocations required" });
		}
		expense.purpose = req.body.purpose ?? expense.purpose;
		expense.location = req.body.location ?? expense.location;
		expense.expenseProjectAllocations = req.body.expenseProjectAllocations.map((a: any, i: number) => ({
			key: 7200 + i,
			expenseReportKey: expense.key,
			project: { key: a.projectKey, code: `P-${a.projectKey}`, name: `Project ${a.projectKey}` },
			task: a.taskKey ? { key: a.taskKey, name: "Task" } : null,
			allocation: a.allocation,
			sequence: i,
		}));
		res.status(204).end();
	});
	app.delete("/platform/rest/me/expenses/:id", (req, res) => {
		const index = state.mockExpenses.findIndex((e) => e.key === Number(req.params.id));
		if (index >= 0) state.mockExpenses.splice(index, 1);
		res.status(204).end();
	});
	app.get("/platform/rest/me/expenses/:id/history", (req, res) =>
		res.json(paged([{ status: "INUSE", actionTimestamp: "2026-05-20T10:00:00Z", performedBy: { key: 9, name: "Test User" } }])),
	);
	app.get("/platform/rest/me/expenses/:id/meal-caps", (_req, res) =>
		res.json({ cap: 79, items: [{ date: "2026-05-18", total: 61.5 }] }),
	);
	app.get("/platform/rest/me/expenses/:id/details/:did", (req, res) => {
		const expense = findExpense(req.params.id);
		const detail = expense?.expenseDetails.find((d: any) => d.key === Number(req.params.did));
		if (!detail) return res.status(404).json({ error: "not found" });
		res.json(detail);
	});
	app.put("/platform/rest/me/expenses/:id/details/:did", (req, res) => {
		const expense = findExpense(req.params.id);
		const index = expense?.expenseDetails.findIndex((d: any) => d.key === Number(req.params.did)) ?? -1;
		if (!expense || index < 0) return res.status(404).json({ error: "not found" });
		expense.expenseDetails[index] = { ...expense.expenseDetails[index], ...req.body, key: Number(req.params.did) };
		expense.totalExpenses = expense.expenseDetails.reduce((s: number, d: any) => s + Number(d.expenseAmount ?? d.amount ?? 0), 0);
		res.status(204).end();
	});
	app.delete("/platform/rest/me/expenses/:id/details/:did", (req, res) => {
		const expense = findExpense(req.params.id);
		if (!expense) return res.status(404).json({ error: "not found" });
		expense.expenseDetails = expense.expenseDetails.filter((d: any) => d.key !== Number(req.params.did));
		res.status(204).end();
	});
	app.get("/platform/rest/me/expenses/:id/attachments/:aid", (req, res) => {
		const found = (state.mockAttachments[Number(req.params.id)] ?? []).find((a) => a.key === Number(req.params.aid));
		if (!found) return res.status(404).json({ error: "not found" });
		res.json(found);
	});
	app.delete("/platform/rest/me/expenses/:id/attachments/:aid", (req, res) => {
		const list = state.mockAttachments[Number(req.params.id)] ?? [];
		state.mockAttachments[Number(req.params.id)] = list.filter((a) => a.key !== Number(req.params.aid));
		const expense = findExpense(req.params.id);
		if (expense) expense.attachmentCount = state.mockAttachments[Number(req.params.id)].length;
		res.status(204).end();
	});
	app.post("/platform/rest/me/expenses/:id/imported", (req, res) => {
		const expense = findExpense(req.params.id);
		if (!expense) return res.status(404).json({ error: "not found" });
		const key = state.nextDetailKey();
		expense.expenseDetails.push({ key, expenseReportKey: expense.key, amount: 23.4, expenseAmount: 23.4, expenseDate: "2026-05-18", vendorName: "UBER", importedExpenseDataKey: req.body?.importedExpenseKey, expenseType: { key: req.body?.expenseTypeKey, expenseTypeName: "Taxi" } });
		res.json({ key });
	});
	app.post("/platform/rest/me/expenses/:id/submit", (req, res) => {
		const expense = findExpense(req.params.id);
		if (!expense) return res.status(404).json({ error: "not found" });
		expense.status = "SUBMITTED";
		res.status(204).end();
	});

	// ---- Directory reads ------------------------------------------------------
	app.post("/platform/rest/people/search", (req, res) => {
		const name = String(req.body?.name ?? "").toLowerCase();
		const people = [
			{ key: 9, username: "test-user", firstName: "Test", lastName: "User", email: "test@example.com", active: true, organization: { key: 1, name: "Delivery", code: "DEL" } },
			{ key: 10, username: "jane", firstName: "Jane", lastName: "Smith", email: "jane@example.com", active: true, organization: { key: 1, name: "Delivery", code: "DEL" } },
		];
		res.json(paged(people.filter((p) => !name || `${p.firstName} ${p.lastName} ${p.username}`.toLowerCase().includes(name))));
	});
	app.get("/platform/rest/people/:id", (req, res) =>
		res.json({ key: Number(req.params.id), username: "jane", firstName: "Jane", lastName: "Smith", email: "jane@example.com", active: true, organization: { key: 1, name: "Delivery", code: "DEL" }, laborCategory: { key: 384, name: "Software Engineer" } }),
	);
	app.post("/platform/rest/people/:id/assignments/search", (_req, res) =>
		res.json(paged([{ key: 1, person: { key: 10, name: "Jane Smith" }, project: { key: 101, name: "Test Project Alpha", code: "PRJ-001" }, beginDate: "2026-01-01", endDate: "2026-12-31", budgetHours: 500 }])),
	);
	app.post("/platform/rest/organizations/search", (_req, res) =>
		res.json(paged([{ key: 1, code: "DEL", name: "Delivery", active: true }, { key: 2, code: "NJDOL", name: "New Jersey Department of Labor", active: true, type: "Customer" }])),
	);
	app.get("/platform/rest/organizations/:id", (req, res) =>
		res.json({ key: Number(req.params.id), code: "NJDOL", name: "New Jersey Department of Labor", active: true }),
	);
	app.get("/platform/rest/organizations/:id/contacts", (_req, res) =>
		res.json(paged([{ key: 31, first: "Pat", last: "Contact", title: "PM", active: true, primaryEmail: "pat@example.gov" }])),
	);
	app.post("/platform/rest/contracts/search", (_req, res) =>
		res.json(paged([{ key: 71, contractCode: "C-001", contractTitle: "NJ DOL Modernization", contractStatus: { key: 1, name: "Active" }, contractManager: { key: 9, name: "Test User" }, owningOrg: { key: 1, name: "Delivery" }, ceilingAmount: 1000000 }])),
	);
	app.get("/platform/rest/contracts/:id", (req, res) =>
		res.json({ key: Number(req.params.id), contractCode: "C-001", contractTitle: "NJ DOL Modernization", contractStatus: { key: 1, name: "Active" }, ceilingAmount: 1000000 }),
	);
	app.get("/platform/rest/contracts/:id/projects", (_req, res) => res.json(paged([{ projectKey: 101, projectCode: "PRJ-001" }])));
	app.get("/platform/rest/projects/:id/tasks", (req, res) =>
		res.json(paged([{ key: 5, projectKey: Number(req.params.id), name: "Research", number: "1", sequence: 1, active: true, revStartDate: "2026-01-01", revEndDate: "2026-12-31" }])),
	);
	app.post("/platform/rest/projects/tasks/search", (req, res) => {
		const name = String(req.body?.name ?? "").toLowerCase();
		const tasks = [
			{ key: 5, projectKey: 102, name: "Research", active: true },
			{ key: 6, projectKey: 102, name: "Delivery", active: true },
		];
		res.json(paged(tasks.filter((t) => !name || t.name.toLowerCase().includes(name))));
	});
	app.post("/platform/rest/projects/:id/people-assignments/search", (req, res) => {
		if (invalidDateRange(req.body?.dateRange)) {
			return res.status(400).json({ error: "DateRangeModel requires rangeStart and rangeEnd" });
		}
		res.json(paged([{ key: 1, person: { key: 10, name: "Jane Smith" }, project: { key: Number(req.params.id), name: "Test Project Alpha", code: "PRJ-001" }, beginDate: "2026-01-01", endDate: "2026-12-31" }]));
	});
	app.get("/platform/rest/projects/:id/notes", (req, res) =>
		res.json(paged([{ key: 1, project: { key: Number(req.params.id), name: "Test Project Alpha" }, title: "Kickoff", note: "Kickoff held.", noteType: { key: 1, name: "General" }, createDate: "2026-01-02" }])),
	);
	app.get("/platform/rest/projects/:id/admin/:role/:segment", (req, res) =>
		res.json(paged(req.params.segment === "primary" ? [{ key: 9, firstName: "Test", lastName: "User" }] : [])),
	);
	app.post("/platform/rest/invoices/search", (req, res) => {
		for (const field of ["invoiceDate", "createdDate", "completedDate", "extractedDate", "postedDate"]) {
			if (invalidDateRange(req.body?.[field])) {
				return res.status(400).json({ error: `${field}: DateRangeModel requires rangeStart and rangeEnd` });
			}
		}
		res.json(paged([{ key: 4001, invoiceNumber: "INV-1001", project: { key: 101, name: "Test Project Alpha", code: "PRJ-001" }, customer: { key: 2, name: "NJDOL" }, invoiceDate: "2026-04-30", amount: 12000, balance: 0, currency: { code: "USD" } }]));
	});
	app.get("/platform/rest/invoices/:id", (req, res) =>
		res.json({ key: Number(req.params.id), invoiceNumber: "INV-1001", project: { key: 101, name: "Test Project Alpha" }, invoiceDate: "2026-04-30", amount: 12000, balance: 0 }),
	);
	app.get("/platform/rest/invoices/:id/history", (_req, res) => res.json(paged([{ status: "COMPLETED", actionTimestamp: "2026-05-01T00:00:00Z" }])));
	app.get("/platform/rest/labor-categories", (_req, res) =>
		res.json(paged([{ key: 384, name: "Software Engineer", active: true }, { key: 385, name: "Senior Software Engineer", active: true }])),
	);
	app.get("/platform/rest/pay-codes", (_req, res) =>
		res.json(paged([{ key: 1, name: "RT", description: "Regular Time", active: true }])),
	);
	app.get("/platform/rest/project-types", (_req, res) =>
		res.json(paged([{ key: 17, name: "B-ST-PRM", billable: true, active: true }])),
	);
	app.get("/platform/rest/locations", (_req, res) => res.json(paged([{ key: 1, name: "Remote", active: true }])));
}
