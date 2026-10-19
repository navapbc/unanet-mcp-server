/**
 * unanet_assign_people_to_project against the mock server: person resolution,
 * duplicate detection, dry run, request body, notification default, batch
 * halting, and unknown-outcome reporting.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "child_process";
import { clearPlatformTokenCache } from "../dist/auth.js";

const MOCK_PORT = 3214;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
const auth = { username: "test-user", password: "test-pass", baseUrl: MOCK_BASE_URL };
const mock = (path) => `${MOCK_BASE_URL}/platform/rest${path}`;

function waitForOutput(childProcess, expectedText, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedText}`)), timeoutMs);
		const onData = (data) => {
			if (data.toString().includes(expectedText)) {
				clearTimeout(timer);
				resolve();
			}
		};
		childProcess.stdout.on("data", onData);
		childProcess.stderr.on("data", onData);
	});
}

const posts = async () => (await (await fetch(mock("/__test/assignment-posts"))).json()).posts;
const statuses = (result) => result.results.map((entry) => [entry.personKey, entry.status]);

describe("unanet_assign_people_to_project", () => {
	let mockProcess;
	let tool;

	beforeAll(async () => {
		clearPlatformTokenCache();
		process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK = "true";
		mockProcess = spawn("node", ["dist/mock-server.js"], { env: { ...process.env, PORT: String(MOCK_PORT) } });
		await waitForOutput(mockProcess, "Mock Unanet API server running");
		({ assignPeopleToProjectTool: tool } = await import("../dist/tools/project-assignments.js"));
	});

	afterAll(() => {
		delete process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK;
		if (mockProcess) mockProcess.kill();
	});

	beforeEach(async () => {
		await fetch(mock("/__test/reset-assignment-posts"), { method: "POST" });
	});

	const run = (input) => tool.handler(tool.inputSchema.parse({ confirm: true, projectId: 101, ...input }), auth);

	it("requires confirm, at least one person, at most 50, and a sane date range", () => {
		const base = { projectId: 101, personKeys: [11] };
		expect(() => tool.inputSchema.parse(base)).toThrow();
		expect(() => tool.inputSchema.parse({ confirm: true, projectId: 101 })).toThrow();
		expect(() => tool.inputSchema.parse({ confirm: true, projectId: 101, personKeys: Array.from({ length: 51 }, (_, i) => i + 1) })).toThrow();
		expect(() =>
			tool.inputSchema.parse({
				confirm: true,
				projectId: 101,
				personKeys: Array.from({ length: 30 }, (_, i) => i + 1),
				emails: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`),
			}),
		).toThrow();
		expect(() => tool.inputSchema.parse({ ...base, confirm: true, beginDate: "2026-05-02", endDate: "2026-05-01" })).toThrow();
	});

	it("refuses a handler call without confirm before any request", async () => {
		const result = await tool.handler({ projectId: 101, personKeys: [11] }, auth);
		expect(result.success).toBe(false);
		expect(result.error).toContain("confirm=true");
		expect(await posts()).toEqual([]);
	});

	it("dry run resolves people and changes nothing", async () => {
		const result = await run({
			dryRun: true,
			personKeys: [10, 11],
			emails: ["sam@example.com", "dup@example.com", "gone@example.com", "sa@example.com", "nobody@example.com"],
		});
		expect(result.dryRun).toBe(true);
		expect(await posts()).toEqual([]);
		const byEmail = Object.fromEntries(result.results.filter((entry) => entry.email).map((entry) => [entry.email, entry]));
		expect(byEmail["dup@example.com"].status).toBe("ambiguous");
		expect(byEmail["dup@example.com"].candidates).toEqual([12, 13]);
		// Loose search hits that are not an exact, active email match are not people.
		expect(byEmail["gone@example.com"].status).toBe("notFound");
		expect(byEmail["sa@example.com"].status).toBe("notFound");
		expect(byEmail["nobody@example.com"].status).toBe("notFound");
		// 10 already has an active assignment; 11 (by key and by email) is counted once.
		expect(statuses(result).filter(([, status]) => status === "alreadyAssigned")).toEqual([[10, "alreadyAssigned"]]);
		expect(statuses(result).filter(([, status]) => status === "wouldAssign")).toEqual([[11, "wouldAssign"]]);
		expect(result.success).toBe(false);
		expect(result.summary).toMatchObject({ wouldAssign: 1, alreadyAssigned: 1, ambiguous: 1, notFound: 3 });
	});

	it("assigns with the person's Unanet defaults, silently, and never twice", async () => {
		const first = await run({ emails: ["Sam@Example.com"] });
		expect(first.success).toBe(true);
		expect(first.results[0]).toMatchObject({ personKey: 11, status: "assigned" });

		const [posted] = await posts();
		expect(posted).toMatchObject({
			projectKey: 101,
			personKey: 11,
			billRateSource: "LABOR_CATEGORY",
			costRateSource: "PERSON",
			personOrganizationKey: 1,
			projectOrganizationKey: 2,
			laborCategoryKey: 384,
			useWbsDates: true,
			assignmentNotification: { notifyUser: false, notifyPM: false, notifyPL: false, notifyPlanner: false },
		});
		expect(posted).not.toHaveProperty("beginDate");
		// Rates are looked up for their source only; no rate is sent or returned.
		expect(JSON.stringify(posted)).not.toMatch(/77\.5|150/);
		expect(JSON.stringify(first)).not.toMatch(/77\.5|150/);

		const second = await run({ personKeys: [11] });
		expect(statuses(second)).toEqual([[11, "alreadyAssigned"]]);
		expect(await posts()).toHaveLength(1);
	});

	it("sends dates, task and notifications only when asked", async () => {
		await run({ personKeys: [11], taskKey: 5, beginDate: "2026-06-01", endDate: "2026-12-31", notify: true });
		const [posted] = await posts();
		expect(posted).toMatchObject({
			taskKey: 5,
			beginDate: "2026-06-01",
			endDate: "2026-12-31",
			assignmentNotification: { notifyUser: true, notifyPM: true, notifyPL: true, notifyPlanner: true },
		});
		expect(posted).not.toHaveProperty("useWbsDates");
	});

	it("keeps going after a rejected person and does not echo Unanet's description", async () => {
		const result = await run({ personKeys: [97, 11] });
		expect(statuses(result)).toEqual([[97, "failed"], [11, "assigned"]]);
		expect(result.success).toBe(false);
		expect(result.results[0].error).toContain("VALIDATION_GENERIC");
		expect(result.results[0].error).not.toContain("SUPPORT-ONLY");
		expect(result.outcome).toBeUndefined();
	});

	it("stops the batch on a permission error", async () => {
		const result = await run({ personKeys: [94, 11] });
		expect(statuses(result)).toEqual([[94, "failed"], [11, "notAttempted"]]);
		expect(await posts()).toEqual([]);
	});

	it("stops and reports an unknown outcome after a dropped connection or a 5xx on create", async () => {
		for (const unknownKey of [96, 95]) {
			const result = await run({ personKeys: [unknownKey, 11] });
			expect(statuses(result)).toEqual([[unknownKey, "unknown"], [11, "notAttempted"]]);
			expect(result.outcome).toBe("unknown");
			expect(result.warning).toContain("unanet_get_project_assignments");
		}
		expect(await posts()).toEqual([]);
	});

	it("treats a failed lookup as an ordinary failure, not an unknown outcome", async () => {
		const bad = await tool.handler(
			tool.inputSchema.parse({ confirm: true, projectId: 101, personKeys: [11] }),
			{ ...auth, username: "nobody" },
		);
		expect(bad.success).toBe(false);
		expect(bad.outcome).toBeUndefined();
	});

	it("treats a 5xx on the duplicate lookup as an ordinary failure too", async () => {
		// The next mutating-method request is the lookup POST, which the mock fails.
		await fetch(mock("/__test/next-write-fault"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "503" }),
		});
		const result = await run({ personKeys: [11] });
		expect(statuses(result)).toEqual([[11, "failed"]]);
		expect(result.outcome).toBeUndefined();
		expect(await posts()).toEqual([]);
	});

	it("assigns each person once even when listed twice", async () => {
		const result = await run({ personKeys: [11, 11] });
		expect(statuses(result)).toEqual([[11, "assigned"]]);
		expect(await posts()).toHaveLength(1);
	});

	it("only counts an assignment on the same task as a duplicate", async () => {
		// Person 10 is on the project without a task; adding them to task 5 is new.
		const result = await run({ personKeys: [10], taskKey: 5 });
		expect(statuses(result)).toEqual([[10, "assigned"]]);
		expect(await posts()).toHaveLength(1);
	});
});
