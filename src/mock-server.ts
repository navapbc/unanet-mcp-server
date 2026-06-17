#!/usr/bin/env node

/**
 * Mock Unanet API server for testing without real credentials.
 * Run with: npm run mock-server
 */

import express from "express";

const app = express();
app.use(express.json());

const MOCK_PLATFORM_TOKEN = "mock-platform-token";
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);

// Test-only counter so tests can assert how many timesheet PUTs happened
// (used to verify multi-entry add is all-or-nothing).
let timesheetPutCount = 0;
let nextExpenseKey = 9003;
let nextExpenseDetailKey = 9101;

const mockExpenses: any[] = [
	{
		key: 9001,
		purpose: "Professional development - AI conference",
		location: "Chicago, IL",
		status: "COMPLETED",
		voucherType: "EXPENSE_REPORT",
		createdDate: "2026-05-15T10:00:00Z",
		postDate: "2026-05-15",
		totalExpenses: 450,
		reimbursableAmount: 450,
		expenseCurrencyCode: "USD",
		attachmentCount: 1,
		expenseProjectAllocations: [
			{
				key: 7001,
				expenseReportKey: 9001,
				project: { key: 501, code: "PROF-DEV", name: "Professional Development" },
				allocation: 100,
				sequence: 0,
			},
		],
		expenseDetails: [
			{
				key: 8001,
				expenseReportKey: 9001,
				projectAllocationKey: 7001,
				sequence: 0,
				expenseType: { key: 301, expenseTypeName: "Training / Conference" },
				paymentMethod: { key: 401, paymentMethodCode: "EMPLOYEE_PAID", description: "Employee Paid" },
				expenseDate: "2026-05-12",
				amount: 450,
				exchangeRate: 1,
				expenseAmount: 450,
				transactionCurrency: { key: 1, code: "USD", name: "US Dollar" },
				vendorName: "AI Conf",
				summary: "AI conference registration",
				comments: "Professional development fund",
				receiptIncluded: true,
				wizard: { type: "ENTERTAINMENT" },
			},
		],
	},
	{
		key: 9002,
		purpose: "Chicago travel",
		location: "Chicago, IL",
		status: "INUSE",
		voucherType: "EXPENSE_REPORT",
		createdDate: "2026-05-20T10:00:00Z",
		postDate: "2026-05-20",
		totalExpenses: 83.86,
		reimbursableAmount: 83.86,
		expenseCurrencyCode: "USD",
		attachmentCount: 0,
		expenseProjectAllocations: [
			{
				key: 7002,
				expenseReportKey: 9002,
				project: { key: 502, code: "TRAVEL", name: "Travel" },
				allocation: 100,
				sequence: 0,
			},
		],
		expenseDetails: [],
	},
];

app.post("/platform/rest/login", (req, res) => {
	const { username, password } = req.body || {};

	if (username !== "test-user" || password !== "test-pass") {
		return res.status(401).json({ error: "Invalid platform credentials" });
	}

	return res.json({
		message: {
			token: MOCK_PLATFORM_TOKEN,
			expiresIn: 900,
		},
	});
});

app.post("/platform/rest/me/leave", (req, res) => {
	if (req.headers.authorization !== `Bearer ${MOCK_PLATFORM_TOKEN}`) {
		return res.status(401).json({ error: "Invalid bearer token" });
	}

	const rangeStart = req.body?.dateRange?.rangeStart;
	const rangeEnd = req.body?.dateRange?.rangeEnd;
	if (!rangeStart || !rangeEnd) {
		return res.status(400).json({
			error: "dateRange.rangeStart and dateRange.rangeEnd are required",
		});
	}

	return res.json({
		message: {
			items: [
				{
					project: { name: "PTO 2026" },
					task: { name: "Paid Time Off" },
					budget: "112.69",
					actuals: null,
				},
				{
					project: { name: "Holiday 2026" },
					task: { name: "Floating Holiday" },
					budget: "0.67",
					actuals: null,
				},
				{
					project: { name: "Sick Leave 2026" },
					task: null,
					budget: "4.05",
					actuals: "4",
				},
				{
					project: { name: "Granted Time Off" },
					task: null,
					budget: 0,
					actuals: null,
				},
				{
					project: { name: "LWOP" },
					task: null,
					budget: "0.02",
					actuals: null,
				},
			],
		},
	});
});

// Mock bearer-token validation for the sample Platform REST endpoints below.
// Test-only inspection routes bypass auth so tests can read counters.
app.use((req, res, next) => {
	if (req.path.startsWith("/platform/rest/__test/")) {
		return next();
	}
	if (req.headers.authorization !== `Bearer ${MOCK_PLATFORM_TOKEN}`) {
		return res.status(401).json({ error: "Invalid bearer token" });
	}
	next();
});

// Mock Platform REST endpoints
app.post("/platform/rest/projects/search", (_req, res) => {
	res.json({
		items: [
			{
				key: 101,
				projectCode: "PRJ-001",
				title: "Test Project Alpha",
				status: { key: 1, name: "Active" },
				projectOrg: { key: 1, name: "Delivery" },
				owningOrg: { key: 1, name: "Delivery" },
			},
			{
				key: 102,
				projectCode: "PRJ-002",
				title: "Test Project Beta",
				status: { key: 1, name: "Active" },
				projectOrg: { key: 1, name: "Delivery" },
				owningOrg: { key: 1, name: "Delivery" },
			},
		],
	});
});

app.get("/platform/rest/projects/:id", (req, res) => {
	res.json({
		id: req.params.id,
		name: "Test Project Details",
		status: "Active",
		startDate: "2024-01-01",
		endDate: "2024-12-31",
		budget: 150000,
		actualCost: 75000,
		percentComplete: 50,
		tasks: [
			{
				id: "TSK-001",
				name: "Design Phase",
				status: "Completed",
				hoursEstimated: 100,
				hoursActual: 95,
			},
		],
		team: [
			{
				id: "EMP-001",
				name: "Jane Smith",
				role: "Developer",
				email: "jane@test.com",
				allocation: 80,
			},
		],
	});
});

app.get("/platform/rest/me/expenses", (req, res) => {
	const status = req.query.status;
	const items = mockExpenses.filter(
		(expense) => !status || expense.status === status,
	);
	res.json({ items, page: 1, pageSize: items.length, resultCount: items.length });
});

app.post("/platform/rest/me/expenses", (req, res) => {
	const allocations = req.body?.expenseProjectAllocations;
	if (!Array.isArray(allocations) || allocations.length === 0) {
		return res.status(400).json({ error: "expenseProjectAllocations required" });
	}

	const key = nextExpenseKey++;
	const expense = {
		key,
		purpose: req.body?.purpose ?? null,
		location: req.body?.location ?? null,
		status: "INUSE",
		voucherType: req.body?.voucherType ?? "EXPENSE_REPORT",
		createdDate: "2026-06-01T10:00:00Z",
		postDate: "2026-06-01",
		totalExpenses: 0,
		reimbursableAmount: 0,
		expenseCurrencyCode: "USD",
		attachmentCount: 0,
		expenseProjectAllocations: allocations.map((allocation, index) => ({
			key: 7100 + index,
			expenseReportKey: key,
			project: {
				key: allocation.projectKey,
				code: allocation.projectKey === 501 ? "PROF-DEV" : "PROJECT",
				name:
					allocation.projectKey === 501
						? "Professional Development"
						: "Project",
			},
			task: allocation.taskKey ? { key: allocation.taskKey, name: "Task" } : null,
			allocation: allocation.allocation,
			sequence: index,
		})),
		expenseDetails: [],
	};
	mockExpenses.push(expense);
	res.json({ key });
});

app.get("/platform/rest/me/expenses/:id", (req, res) => {
	const expense = mockExpenses.find((item) => item.key === Number(req.params.id));
	if (!expense) return res.status(404).json({ error: "Expense not found" });
	res.json(expense);
});

app.post("/platform/rest/me/expenses/:id/details", (req, res) => {
	const expense = mockExpenses.find((item) => item.key === Number(req.params.id));
	if (!expense) return res.status(404).json({ error: "Expense not found" });
	if (expense.status !== "INUSE") {
		return res.status(400).json({ error: "Expense is not editable" });
	}
	const detail = {
		key: nextExpenseDetailKey++,
		expenseReportKey: expense.key,
		sequence: expense.expenseDetails.length,
		...req.body,
		expenseType: {
			key: req.body?.expenseTypeKey,
			expenseTypeName: "Training / Conference",
		},
		paymentMethod: {
			key: req.body?.paymentMethodKey,
			paymentMethodCode: "EMPLOYEE_PAID",
			description: "Employee Paid",
		},
	};
	expense.expenseDetails.push(detail);
	expense.totalExpenses += Number(req.body?.expenseAmount ?? req.body?.amount ?? 0);
	expense.reimbursableAmount = expense.totalExpenses;
	res.json({ key: detail.key });
});

app.get("/platform/rest/me/expenses/:id/validate", (req, res) => {
	const expense = mockExpenses.find((item) => item.key === Number(req.params.id));
	if (!expense) return res.status(404).json({ error: "Expense not found" });
	res.json({
		expenseReportErrors: [],
		expenseReportWarnings:
			expense.attachmentCount === 0 ? ["At least one receipt is missing"] : [],
		expenseErrors: [],
		expenseWarnings: [],
		wizardErrors: [],
		wizardReceiptErrors: [],
		wizardWarnings: [],
	});
});

app.get("/platform/rest/expense-types", (_req, res) => {
	res.json({
		items: [
			{
				key: 301,
				name: "Training / Conference",
				code: "TRAINING",
				wizardType: "ENTERTAINMENT",
				receiptRequired: true,
			},
			{
				key: 302,
				name: "Books / Education Materials",
				code: "BOOKS",
				wizardType: "ENTERTAINMENT",
				receiptRequired: true,
			},
		],
	});
});

app.get("/platform/rest/payment-methods", (_req, res) => {
	res.json({
		items: [
			{
				key: 401,
				paymentMethodCode: "EMPLOYEE_PAID",
				description: "Employee Paid",
				reimbursable: true,
				active: true,
			},
			{
				key: 402,
				paymentMethodCode: "COMPANY_PAID",
				description: "Company Paid",
				reimbursable: false,
				active: true,
			},
		],
	});
});

app.get("/platform/rest/currencies/currency-codes", (_req, res) => {
	res.json({ items: [{ key: 1, code: "USD", name: "US Dollar", decimals: 2 }] });
});

const SEARCH_KEY_BY_DATE: Record<string, number> = {
	"2026-01-02": 202,
	"2026-01-03": 203,
	"2026-01-04": 204,
};

app.post("/platform/rest/me/time/search", (req, res) => {
	const workDate = req.body?.workDate;
	const key = SEARCH_KEY_BY_DATE[workDate] ?? 201;
	res.json({
		items: [
			{
				key,
				beginDate: "2026-01-01",
				endDate: "2026-01-15",
				status: key === 202 ? "SUBMITTED" : "INUSE",
				hours: 8,
			},
		],
	});
});

app.get("/platform/rest/me/time/:id", (req, res) => {
	const key = Number(req.params.id);
	res.json({
		key,
		beginDate: "2026-01-01",
		endDate: "2026-01-15",
		status: key === 202 ? "SUBMITTED" : "INUSE",
		timeslips: [
			{
				key: 301,
				workDate: "2026-01-01",
				hoursWorked: 8,
				project: { key: 101, name: "Test Project Alpha" },
				projectType: { key: 17, name: "B-ST-PRM" },
				payCode: { key: 1, name: "RT" },
				laborCategory: { key: 384, name: "Software Engineer" },
			},
		],
	});
});

app.get("/platform/rest/time/:id/projects", (_req, res) => {
	res.json({
		items: [
			{
				key: 101,
				projectCode: "PRJ-001",
				title: "Test Project Alpha",
				payCodeKey: 1,
				projectTypeKey: 17,
				laborCategoryKey: 384,
			},
			{
				key: 102,
				projectCode: "AI-PROJECT",
				title: "AI Internal Enablement",
				payCodeKey: 1,
				projectTypeKey: 17,
				laborCategoryKey: 384,
			},
		],
	});
});

app.put("/platform/rest/me/time/:id", (req, res) => {
	timesheetPutCount += 1;
	res.json({
		key: Number(req.params.id),
		updatedTimeslips: req.body?.timeslips?.length ?? 0,
		timeslips: req.body?.timeslips ?? [],
	});
});

app.get("/platform/rest/__test/put-count", (_req, res) => {
	res.json({ count: timesheetPutCount });
});

app.post("/platform/rest/__test/reset-put-count", (_req, res) => {
	timesheetPutCount = 0;
	res.json({ count: timesheetPutCount });
});

app.get("/platform/rest/me/time/:id/validate", (req, res) => {
	const key = Number(req.params.id);
	res.json({
		errors: key === 203 ? ["Missing required pay code"] : [],
		warnings: key === 204 ? ["Hours below expected for period"] : [],
		timeslipErrors: [],
		itemEntryErrors: [],
	});
});

app.post("/platform/rest/me/time/:id/submit", (req, res) => {
	res.json({
		key: Number(req.params.id),
		status: "SUBMITTED",
		comment: req.body?.comment ?? null,
	});
});

app.listen(PORT, HOST, () => {
	console.log(`Mock Unanet API server running on http://${HOST}:${PORT}`);
	console.log("Platform REST mock endpoints enabled for local-only testing.");
});
