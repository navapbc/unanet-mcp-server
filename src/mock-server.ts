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
					task: null,
					budget: "120",
					actuals: "16",
				},
				{
					project: { name: "Holiday 2026" },
					task: { name: "Floating Holiday" },
					budget: 16,
					actuals: 8,
				},
			],
		},
	});
});

// Mock bearer-token validation for the sample Platform REST endpoints below.
app.use((req, res, next) => {
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

app.post("/platform/rest/me/time/search", (_req, res) => {
	res.json({
		items: [
			{
				key: 201,
				beginDate: "2026-01-01",
				endDate: "2026-01-15",
				status: "INUSE",
				hours: 8,
			},
		],
	});
});

app.get("/platform/rest/me/time/:id", (req, res) => {
	res.json({
		key: Number(req.params.id),
		beginDate: "2026-01-01",
		endDate: "2026-01-15",
		status: "INUSE",
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

app.listen(PORT, HOST, () => {
	console.log(`Mock Unanet API server running on http://${HOST}:${PORT}`);
	console.log("Platform REST mock endpoints enabled for local-only testing.");
});
