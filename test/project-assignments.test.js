/**
 * unanet_assign_people_to_project against the mock server: person resolution
 * (paged, exact), duplicate detection by period, dry run, validated defaults,
 * request body, notification default, batch halting, and unknown-outcome
 * reporting.
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

const recorded = async () => (await fetch(mock("/__test/assignment-posts"))).json();
const posts = async () => (await recorded()).posts;
const statuses = (result) => result.results.map((entry) => [entry.personKey, entry.status]);
const localToday = () => {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
// Fixed dates inside and outside Jane Smith's mock assignment (2026-01-01 to 2026-12-31).
const INSIDE = { beginDate: "2026-06-01", endDate: "2026-06-30" };
const OUTSIDE = { beginDate: "2027-02-01", endDate: "2027-03-01" };

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

	const run = (input, as = auth) => tool.handler(tool.inputSchema.parse({ confirm: true, projectId: 101, ...input }), as);

	it("requires confirm, at least one person, at most 50, short emails, and a sane date range", () => {
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
		expect(() => tool.inputSchema.parse({ ...base, confirm: true, emails: [`${"a".repeat(45)}@example.com`] })).toThrow();
		expect(() => tool.inputSchema.parse({ ...base, confirm: true, beginDate: "2026-05-02", endDate: "2026-05-01" })).toThrow();
		// A single date is accepted: the create model makes each optional.
		expect(() => tool.inputSchema.parse({ ...base, confirm: true, beginDate: "2026-05-02" })).not.toThrow();
		expect(() => tool.inputSchema.parse({ ...base, confirm: true, endDate: "2026-05-02" })).not.toThrow();
	});

	it("refuses a handler call without confirm before any request", async () => {
		const result = await tool.handler({ projectId: 101, personKeys: [11] }, auth);
		expect(result.success).toBe(false);
		expect(result.error).toContain("confirm=true");
		expect(await posts()).toEqual([]);
	});

	it("dry run resolves people and changes nothing", async () => {
		const result = await run({
			...INSIDE,
			dryRun: true,
			personKeys: [10, 11],
			emails: ["sam@example.com", "dup@example.com", "gone@example.com", "sa@example.com", "nobody@example.com"],
		});
		expect(result.dryRun).toBe(true);
		const { posts: made, defaults } = await recorded();
		expect(made).toEqual([]);
		expect(defaults).toEqual([]);
		const byEmail = Object.fromEntries(result.results.filter((entry) => entry.email).map((entry) => [entry.email, entry]));
		expect(byEmail["dup@example.com"].status).toBe("ambiguous");
		expect(byEmail["dup@example.com"].candidates).toEqual([12, 13]);
		// Loose search hits that are not an exact, active email match are not people.
		expect(byEmail["gone@example.com"].status).toBe("notFound");
		expect(byEmail["sa@example.com"].status).toBe("notFound");
		expect(byEmail["nobody@example.com"].status).toBe("notFound");
		// 10 already has an assignment in that period; 11 (by key and by email) is counted once.
		expect(statuses(result).filter(([, status]) => status === "alreadyAssigned")).toEqual([[10, "alreadyAssigned"]]);
		expect(statuses(result).filter(([, status]) => status === "wouldAssign")).toEqual([[11, "wouldAssign"]]);
		expect(result.success).toBe(false);
		expect(result.summary).toMatchObject({ wouldAssign: 1, alreadyAssigned: 1, ambiguous: 1, notFound: 3 });
	});

	describe("email resolution", () => {
		it("decides over every result page, not just the first", async () => {
			const result = await run({ dryRun: true, emails: ["Many@Example.com"] });
			expect(statuses(result)).toEqual([[200, "wouldAssign"]]);
		});

		it("reports exact duplicates that sit on different pages as ambiguous", async () => {
			const result = await run({ emails: ["span@example.com"] });
			expect(result.results).toEqual([
				expect.objectContaining({ personKey: null, status: "ambiguous", candidates: [300, 301] }),
			]);
			expect(await posts()).toEqual([]);
		});

		it("refuses an email whose search never ends, and an unrecognised search response", async () => {
			const endless = await run({ emails: ["endless@example.com"] });
			expect(endless.results[0]).toMatchObject({ personKey: null, status: "failed" });
			expect(endless.results[0].error).toContain("Too many search results");
			// Exact duplicates seen before the search gives up are ambiguous, not just "too many".
			const dup = await run({ emails: ["endlessdup@example.com"] });
			expect(dup.results[0]).toMatchObject({ status: "ambiguous", candidates: [400, 401] });
			const malformed = await run({ emails: ["malformed@example.com"] });
			expect(malformed.success).toBe(false);
			expect(malformed.error).toContain("Unexpected response shape");
			expect(await posts()).toEqual([]);
		});
	});

	it("assigns with the person's Unanet defaults, silently, and never twice", async () => {
		const first = await run({ emails: ["Sam@Example.com"] });
		expect(first.success).toBe(true);
		expect(first.results[0]).toMatchObject({ personKey: 11, status: "assigned" });

		const { posts: made, defaults } = await recorded();
		const [posted] = made;
		expect(posted).toMatchObject({
			projectKey: 101,
			personKey: 11,
			billRateSource: "LABOR_CATEGORY",
			costRateSource: "PERSON",
			personOrganizationKey: 1,
			projectOrganizationKey: 2,
			laborCategoryKey: 384,
			useWbsDates: true,
			assignmentNotification: {
				notifyUser: false,
				notifyPM: false,
				notifyPL: false,
				notifyPlanner: false,
				notifyAssigner: false,
				notifyRequestor: false,
			},
		});
		expect(posted).not.toHaveProperty("beginDate");
		// Rates are looked up for their source only; no rate is sent or returned.
		expect(JSON.stringify(posted)).not.toMatch(/77\.5|150/);
		expect(JSON.stringify(first)).not.toMatch(/77\.5|150/);
		// Without dates the defaults are read for today.
		expect(defaults).toEqual([{ projectId: 101, personId: 11, date: localToday() }]);

		const second = await run({ personKeys: [11] });
		expect(statuses(second)).toEqual([[11, "alreadyAssigned"]]);
		expect(await posts()).toHaveLength(1);
	});

	it("sends dates, task and notifications only when asked, and reads defaults for the start date", async () => {
		await run({ personKeys: [11], taskKey: 5, ...OUTSIDE, notify: true });
		const { posts: made, defaults } = await recorded();
		expect(made[0]).toMatchObject({
			taskKey: 5,
			beginDate: "2027-02-01",
			endDate: "2027-03-01",
			assignmentNotification: {
				notifyUser: true,
				notifyPM: true,
				notifyPL: true,
				notifyPlanner: true,
				notifyAssigner: true,
				notifyRequestor: true,
			},
		});
		expect(made[0]).not.toHaveProperty("useWbsDates");
		expect(defaults).toEqual([{ projectId: 101, personId: 11, date: "2027-02-01" }]);
	});

	it("treats overlap with the period as already assigned, including future-dated assignments", async () => {
		// With no dates every period counts: Jane (assigned through 2026) and 86 (2099) are both found.
		expect(statuses(await run({ personKeys: [86, 10] }))).toEqual([[86, "alreadyAssigned"], [10, "alreadyAssigned"]]);
		// 10 is assigned through 2026: inside that period it is a duplicate, outside it is new.
		expect(statuses(await run({ personKeys: [10], ...INSIDE }))).toEqual([[10, "alreadyAssigned"]]);
		expect(statuses(await run({ personKeys: [10], ...OUTSIDE }))).toEqual([[10, "assigned"]]);
		// An explicit end date bounds the lookup: 86 starts in 2099, after this period.
		expect(statuses(await run({ personKeys: [86], ...OUTSIDE }))).toEqual([[86, "assigned"]]);
		expect(await posts()).toHaveLength(2);
	});

	it("with no dates a fully past assignment still counts; a later start date makes it new", async () => {
		expect(statuses(await run({ personKeys: [83] }))).toEqual([[83, "alreadyAssigned"]]);
		expect(statuses(await run({ personKeys: [83], beginDate: "2027-01-01" }))).toEqual([[83, "assigned"]]);
	});

	it("reads Unanet's defaults even when the body is wrapped in a message", async () => {
		expect(statuses(await run({ personKeys: [82] }))).toEqual([[82, "assigned"]]);
		expect((await posts())[0]).toMatchObject({ billRateSource: "LABOR_CATEGORY", costRateSource: "PERSON", projectOrganizationKey: 2 });
	});

	it("with only a start date, looks from that date onward and sends only that date", async () => {
		const result = await run({ personKeys: [10, 86], beginDate: "2027-02-01" });
		expect(statuses(result)).toEqual([[10, "assigned"], [86, "alreadyAssigned"]]);
		const [posted] = await posts();
		expect(posted).toMatchObject({ personKey: 10, beginDate: "2027-02-01" });
		expect(posted).not.toHaveProperty("endDate");
		expect(posted).not.toHaveProperty("useWbsDates");
	});

	it("only counts an assignment on the same task as a duplicate", async () => {
		// Person 10 is on the project without a task; adding them to task 5 is new.
		const result = await run({ personKeys: [10], taskKey: 5, ...INSIDE });
		expect(statuses(result)).toEqual([[10, "assigned"]]);
		expect(await posts()).toHaveLength(1);
	});

	it("assigns each person once even when listed twice", async () => {
		const result = await run({ personKeys: [11, 11] });
		expect(statuses(result)).toEqual([[11, "assigned"]]);
		expect(await posts()).toHaveLength(1);
	});

	it("refuses a person whose defaults are missing or unusable, without writing", async () => {
		// 93: {}, 92: unknown bill source, 85: unknown cost source, 91: no project
		// organization, 84: no person organization, 90: null.
		const result = await run({ personKeys: [93, 92, 85, 91, 84, 90] });
		expect(statuses(result)).toEqual([[93, "failed"], [92, "failed"], [85, "failed"], [91, "failed"], [84, "failed"], [90, "failed"]]);
		for (const entry of result.results) expect(entry.error).toContain("no usable assignment defaults");
		expect(await posts()).toEqual([]);
	});

	it("fails a person whose duplicate lookup comes back unrecognised, without writing", async () => {
		const result = await run({ personKeys: [89, 11] });
		expect(statuses(result)).toEqual([[89, "failed"], [11, "assigned"]]);
		expect(result.results[0].error).toContain("Unexpected response shape");
		expect(await posts()).toHaveLength(1);
		expect((await posts())[0].personKey).toBe(11);
	});

	it("keeps going after a rejected person and does not echo Unanet's description", async () => {
		const result = await run({ personKeys: [97, 11] });
		expect(statuses(result)).toEqual([[97, "failed"], [11, "assigned"]]);
		expect(result.success).toBe(false);
		expect(result.results[0].error).toContain("VALIDATION_GENERIC");
		expect(result.results[0].error).not.toContain("SUPPORT-ONLY");
		expect(result.outcome).toBeUndefined();
	});

	it("stops the batch on a permission error, an authentication error or rate limiting", async () => {
		for (const haltingKey of [94, 88, 87]) {
			const result = await run({ personKeys: [haltingKey, 11] });
			expect(statuses(result), `person ${haltingKey}`).toEqual([[haltingKey, "failed"], [11, "notAttempted"]]);
			expect(result.outcome).toBeUndefined();
		}
		expect(await posts()).toEqual([]);
	});

	it("stops after the first failed login instead of logging in for every person", async () => {
		await fetch(mock("/__test/reset-login-count"), { method: "POST" });
		const result = await run({ personKeys: [11, 12, 13] }, { ...auth, username: "nobody" });
		expect(statuses(result)).toEqual([[11, "failed"], [12, "notAttempted"], [13, "notAttempted"]]);
		expect((await (await fetch(mock("/__test/login-count"))).json()).count).toBe(1);
		const { posts: made, defaults } = await recorded();
		expect(made).toEqual([]);
		expect(defaults).toEqual([]);
	});

	it("stops and reports an unknown outcome after a dropped connection or a 5xx on create", async () => {
		for (const unknownKey of [96, 95]) {
			const result = await run({ personKeys: [unknownKey, 11] });
			expect(statuses(result)).toEqual([[unknownKey, "unknown"], [11, "notAttempted"]]);
			expect(result.outcome).toBe("unknown");
			expect(result.warning).toContain("dryRun=true");
			// The recovery advice must not depend on an optional read tool being registered.
			expect(result.warning).not.toContain("unanet_get_project_assignments");
		}
		expect(await posts()).toEqual([]);
	});

	it("treats a failed lookup as an ordinary failure, not an unknown outcome", async () => {
		const bad = await run({ personKeys: [11] }, { ...auth, username: "nobody" });
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
});
