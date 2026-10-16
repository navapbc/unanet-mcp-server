/**
 * Tests for the hardening of the ported tool surface: path-parameter handling,
 * response redaction, classification, tier flags, fail-closed destructive
 * tools, unknown-outcome reporting, error detail, response size, and parsing of
 * spec-shaped responses. Runs against the mock server.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPlatformTokenCache, createUnanetClient, isOutcomeUnknown } from "../dist/auth.js";
import { redactSensitiveFields } from "../dist/utils/http.js";
import { saveAttachmentToDisk } from "../dist/utils/attachments.js";
import { classify } from "../scripts/catalog-classify.mjs";

const MOCK_PORT = 3213;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
const auth = { username: "test-user", password: "test-pass", baseUrl: MOCK_BASE_URL };

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

const mock = (path) => `${MOCK_BASE_URL}/platform/rest${path}`;
const mockGet = async (path) => (await fetch(mock(path))).json();
const setWriteFault = (mode) =>
	fetch(mock("/__test/next-write-fault"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mode }),
	});

describe("hardening", () => {
	let mockProcess;

	beforeAll(async () => {
		clearPlatformTokenCache();
		process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK = "true";
		mockProcess = spawn("node", ["dist/mock-server.js"], { env: { ...process.env, PORT: String(MOCK_PORT) } });
		await waitForOutput(mockProcess, "Mock Unanet API server running");
	});

	afterAll(() => {
		delete process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK;
		delete process.env.UNANET_ENABLE_WRITE_TOOLS;
		if (mockProcess) mockProcess.kill();
	});

	// ---- Path parameters ------------------------------------------------------

	describe("path parameters", () => {
		it("refuses dot segments and non-numeric ids in the generic reader", async () => {
			const { apiReadTool } = await import("../dist/tools/api.js");
			const template = "/rest/exchange-rates/{fromCurrencyId}/{toCurrencyId}/{date}";
			for (const pathParams of [
				{ fromCurrencyId: "..", toCurrencyId: "config", date: "system" },
				{ fromCurrencyId: 1, toCurrencyId: 2, date: ".." },
				{ fromCurrencyId: 1, toCurrencyId: "2abc", date: "2026-01-01" },
				{ fromCurrencyId: 1, toCurrencyId: ".", date: "2026-01-01" },
			]) {
				const result = await apiReadTool.handler({ method: "GET", path: template, pathParams }, auth);
				expect(result.success, JSON.stringify(pathParams)).toBe(false);
				expect(result.error).toContain("Invalid path parameter");
			}
		});

		it("refuses dot segments for every tool at the client", async () => {
			const client = createUnanetClient(auth);
			for (const url of ["/me/../config/system", "/me/%2e%2e/config/system", "/me/time/./1"]) {
				await expect(client.get(url)).rejects.toThrow(/dot segment/);
			}
		});
	});

	// ---- Classification and redaction -----------------------------------------

	describe("classification", () => {
		it("classifies secret-bearing and cost-rate reads as sensitive and keeps ordinary reference reads", () => {
			for (const [method, path, summary, tag] of [
				["get", "/rest/token/refresh", "Issues refreshed token.", "Authentication"],
				["get", "/rest/people/{id}/rates", "Retrieves person rates", "People"],
				["get", "/rest/people/{id}/rates/{rateId}", "Retrieves a person rate", "People"],
				["get", "/rest/projects/{id}/cost-rates", "Retrieves cost rates", "Projects"],
				["get", "/rest/people/{id}/payroll", "Retrieves person payroll", "People"],
				["get", "/rest/config/system", "Retrieves system config", "Configuration"],
				["post", "/rest/config/properties", "Retrieves properties", "Configuration"],
				["post", "/rest/bank-reconciliations/search", "Search bank reconciliations", "Bank Reconciliation"],
			]) {
				expect(classify(method, path, summary, tag), `${method} ${path}`).toBe("sensitive");
			}
			for (const [method, path, summary, tag] of [
				["get", "/rest/mileage/{id}/rates", "Retrieves mileage rates", "Mileage"],
				["get", "/rest/labor-categories/{id}/rates", "Retrieves labor category rates", "Labor Categories"],
				["get", "/rest/projects/{id}/tasks", "Retrieves tasks", "Projects"],
				["post", "/rest/people/search", "Search people", "People"],
			]) {
				expect(classify(method, path, summary, tag), `${method} ${path}`).toBe("read");
			}
			expect(classify("post", "/rest/people", "Creates a person", "People")).toBe("write");
			expect(classify("delete", "/rest/people/{id}", "Deletes a person", "People")).toBe("sensitive");
		});

		it("keeps the committed catalog identical to a fresh build", () => {
			const result = spawnSync("node", ["scripts/build-api-catalog.mjs", "--check"], { encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0);
		});

		it("redacts tax, bank, cost-rate and id fields at any depth, case-insensitively", () => {
			const input = {
				name: "Acme",
				FederalTaxId: "12-3456789",
				contacts: [{ email: "a@b.c", nested: { costRate: 99, idCode1: "X" } }],
				vendorProfiles: [{ vendorAccountNumber: "ACCT-1", keep: "ok" }],
			};
			const output = redactSensitiveFields(input);
			expect(output).toEqual({
				name: "Acme",
				FederalTaxId: "[redacted]",
				contacts: [{ email: "a@b.c", nested: { costRate: "[redacted]", idCode1: "[redacted]" } }],
				vendorProfiles: [{ vendorAccountNumber: "[redacted]", keep: "ok" }],
			});
			expect(input.FederalTaxId).toBe("12-3456789");
		});

		it("redacts the generic reader and includeRaw output", async () => {
			const { apiReadTool } = await import("../dist/tools/api.js");
			const { getOrganizationTool, getPersonTool } = await import("../dist/tools/directory.js");

			const generic = await apiReadTool.handler(
				{ method: "GET", path: "/rest/organizations/{id}", pathParams: { id: 2 } },
				auth,
			);
			expect(generic.success).toBe(true);
			expect(generic.data.federalTaxId).toBe("[redacted]");
			expect(generic.data.federalTaxIdType).toBe("[redacted]");
			expect(generic.data.vendorProfiles[0].vendorAccountNumber).toBe("[redacted]");
			expect(generic.data.name).toBe("New Jersey Department of Labor");

			const org = await getOrganizationTool.handler(
				{ organizationId: 2, includeContacts: false, includeAddresses: false, includeRaw: true },
				auth,
			);
			expect(org.raw.federalTaxId).toBe("[redacted]");
			const person = await getPersonTool.handler(
				{ personId: 10, includeAssignments: false, includeLeaveBalances: false, includeRaw: true },
				auth,
			);
			expect(person.raw.idCode1).toBe("[redacted]");
			expect(person.raw.username).toBe("jane");
		});
	});

	// ---- Tier flags ----------------------------------------------------------------

	describe("tier flags", () => {
		it("ignores the retired legacy flag and says so", async () => {
			const child = spawn("node", ["dist/index.js"], {
				env: {
					...process.env,
					UNANET_USERNAME: "test-user",
					UNANET_PASSWORD: "test-pass",
					UNANET_BASE_URL: MOCK_BASE_URL,
					UNANET_ALLOW_INSECURE_LOCAL_MOCK: "true",
					UNANET_ENABLE_EXTENDED_READ_TOOLS: "false",
					UNANET_ENABLE_WRITE_TOOLS: "false",
					UNANET_ENABLE_LEGACY_READ_TOOLS: "true",
				},
			});
			let stderr = "";
			child.stderr.on("data", (data) => (stderr += data.toString()));
			await waitForOutput(child, "Server started successfully");
			child.kill();
			expect(stderr).toContain("UNANET_ENABLE_LEGACY_READ_TOOLS is no longer supported");
			expect(stderr).toContain("Registered 33 tool(s)");
			expect(stderr).toContain("extended reads: false");
		});
	});

	// ---- Fail-closed destructive tools -----------------------------------------

	describe("leave submit and delete", () => {
		it("send nothing when the request cannot be found", async () => {
			const { submitLeaveRequestTool, deleteLeaveRequestTool } = await import("../dist/tools/leave-requests.js");
			await setWriteFault("503");
			const submit = await submitLeaveRequestTool.handler({ leaveRequestId: 99999, confirm: true }, auth);
			const remove = await deleteLeaveRequestTool.handler({ leaveRequestId: 99999, confirm: true }, auth);
			expect(submit.success).toBe(false);
			expect(submit.error).toContain("not found");
			expect(remove.success).toBe(false);
			expect(remove.error).toContain("not found");
			// The pending fault proves no mutating request reached the server.
			expect((await mockGet("/__test/write-fault")).pending).toBe("503");
			await setWriteFault(null);
		});
	});

	describe("timesheet deletion", () => {
		it("refuses when hours exist only in the summary, or when emptiness cannot be established", async () => {
			const { deleteTimesheetTool } = await import("../dist/tools/timesheet-lifecycle.js");
			const before = (await mockGet("/__test/deleted-timesheets")).keys;

			const summaryOnly = await deleteTimesheetTool.handler({ timesheetId: 221, allowNonEmpty: false, confirm: true }, auth);
			expect(summaryOnly.success).toBe(false);
			expect(summaryOnly.hours).toBe(8);

			const unknown = await deleteTimesheetTool.handler({ timesheetId: 222, allowNonEmpty: false, confirm: true }, auth);
			expect(unknown.success).toBe(false);
			expect(unknown.error).toContain("Could not establish");

			expect((await mockGet("/__test/deleted-timesheets")).keys).toEqual(before);

			const forced = await deleteTimesheetTool.handler({ timesheetId: 222, allowNonEmpty: true, confirm: true }, auth);
			expect(forced.success).toBe(true);
		});
	});

	// ---- Unknown outcomes ------------------------------------------------------

	describe("unknown outcomes", () => {
		it("tells apart failed reads, failed writes and pre-send failures", async () => {
			const client = createUnanetClient(auth);
			const readError = await client.get("/__test/service-unavailable").catch((error) => error);
			const writeError = await client.post("/__test/service-unavailable", {}).catch((error) => error);
			expect(isOutcomeUnknown(readError)).toBe(false);
			expect(isOutcomeUnknown(writeError)).toBe(true);
			expect(writeError.message).not.toMatch(/try again later/i);
			const loginError = await createUnanetClient({ ...auth, username: "nobody" })
				.post("/me/leave-requests", {})
				.catch((error) => error);
			expect(isOutcomeUnknown(loginError)).toBe(false);
		});

		it("reports an unknown outcome from create and upload tools after a 5xx or dropped connection", async () => {
			const { createLeaveRequestTool } = await import("../dist/tools/leave-requests.js");
			const { addMyAttachmentTool } = await import("../dist/tools/user.js");
			const dir = mkdtempSync(join(tmpdir(), "unanet-unknown-"));
			const file = join(dir, "doc.pdf");
			writeFileSync(file, "%PDF-1.4 x");

			await setWriteFault("503");
			const created = await createLeaveRequestTool.handler(
				{ beginDate: "2026-08-03", endDate: "2026-08-03", hours: 8, nonWorkDays: false, confirm: true },
				auth,
			);
			expect(created).toMatchObject({ success: false, outcome: "unknown" });
			expect(created.warning).toContain("Check Unanet");

			await setWriteFault("no-response");
			const uploaded = await addMyAttachmentTool.handler({ filePath: file, confirm: true }, auth);
			expect(uploaded).toMatchObject({ success: false, outcome: "unknown" });

			const ordinary = await createLeaveRequestTool.handler(
				{ beginDate: "2026-08-04", endDate: "2026-08-04", hours: 8, nonWorkDays: false, confirm: true },
				{ ...auth, username: "nobody" },
			);
			expect(ordinary.success).toBe(false);
			expect(ordinary.outcome).toBeUndefined();
		});
	});

	// ---- Error detail --------------------------------------------------------------

	describe("401 and 403 detail", () => {
		it("appends Unanet's own error text and never echoes credentials", async () => {
			const client = createUnanetClient(auth);
			const forbidden = await client.get("/__test/forbidden").catch((error) => error);
			expect(forbidden.message).toContain("FORBIDDEN_INSUFFICIENT_ROLE — Role is missing");
			const unauthorized = await client.get("/__test/unauthorized").catch((error) => error);
			expect(unauthorized.message).toContain("UNAUTHORIZED — Session expired");
			for (const error of [forbidden, unauthorized]) {
				expect(error.message).not.toContain("test-pass");
				expect(error.message).not.toContain("test-user");
			}
		});
	});

	// ---- Response size ---------------------------------------------------------------

	describe("generic reader response size", () => {
		it("keeps the whole response within the cap even when one item is oversized", async () => {
			const { apiReadTool } = await import("../dist/tools/api.js");
			const result = await apiReadTool.handler(
				{ method: "GET", path: "/rest/projects/{id}/notes", pathParams: { id: 999 } },
				auth,
			);
			expect(result.success).toBe(true);
			expect(result.truncated).toBe(true);
			expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(200_000);

			const small = await apiReadTool.handler(
				{ method: "GET", path: "/rest/projects/{id}/notes", pathParams: { id: 5 } },
				auth,
			);
			expect(small.truncated).toBe(false);
			expect(small.data.items[0].title).toBe("Kickoff");
		});

		it("replaces a single oversized object with a bounded preview", async () => {
			const { apiReadTool } = await import("../dist/tools/api.js");
			const result = await apiReadTool.handler(
				{ method: "GET", path: "/rest/organizations/{id}", pathParams: { id: 998 } },
				auth,
			);
			expect(result.success).toBe(true);
			expect(result.truncated).toBe(true);
			expect(typeof result.data).toBe("string");
			expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(200_000);
		});
	});

	// ---- Spec-shaped responses -----------------------------------------------------

	describe("response parsing", () => {
		it("keeps every approver and approval type from nested approver groups", async () => {
			const { getProjectAdminsTool } = await import("../dist/tools/directory.js");
			const result = await getProjectAdminsTool.handler(
				{ projectId: 101, roles: ["project-approvers", "managers"] },
				auth,
			);
			expect(result.success).toBe(true);
			const approvers = result.admins.find((entry) => entry.role === "project-approvers");
			expect(approvers.primary).toEqual([
				{ key: 9, name: "Test User", approvalType: "ANY" },
				{ key: 10, name: "Jane Smith", approvalType: "ALL" },
			]);
			const managers = result.admins.find((entry) => entry.role === "managers");
			expect(managers.primary).toEqual([{ key: 9, name: "Test User" }]);
		});

		it("reads every envelope of the imported-expense search and a flat row array", async () => {
			const { searchImportedExpensesTool } = await import("../dist/tools/expense-lifecycle.js");
			const base = { status: "AVAILABLE", page: 1, pageSize: 50 };
			const multi = await searchImportedExpensesTool.handler({ ...base, vendors: ["MULTI"] }, auth);
			expect(multi.importedExpenses.map((row) => row.key)).toEqual([1, 2]);
			expect(multi.count).toBe(2);
			const flat = await searchImportedExpensesTool.handler({ ...base, vendors: ["FLAT"] }, auth);
			expect(flat.importedExpenses.map((row) => row.key)).toEqual([3, 4]);
			const single = await searchImportedExpensesTool.handler(base, auth);
			expect(single.importedExpenses[0].key).toBe(8801);
		});

		it("keeps the text and location of structured validation messages", async () => {
			const { normalizeErrors, normalizeWarnings } = await import("../dist/tools/expenses.js");
			expect(
				normalizeWarnings({
					expenseReportWarnings: ["Report note"],
					expenseWarnings: [{ projectKey: 101, taskKey: 5, violations: ["Over budget", "No receipt"] }],
					wizardWarnings: [{ expenseDate: "2026-09-14", expenseTypeName: "Lodging" }],
				}),
			).toEqual([
				"Report note",
				"(project 101, task 5) Over budget; No receipt",
				"(Lodging, 2026-09-14)",
			]);
			expect(normalizeErrors({ wizardErrors: [{ message: "Bad wizard" }] })).toEqual(["Bad wizard"]);
		});

		it("reports a failed health check when Unanet is unreachable", async () => {
			const { pingTool } = await import("../dist/tools/directory.js");
			const up = await pingTool.handler({}, auth);
			expect(up.success).toBe(true);
			const down = await pingTool.handler({}, { ...auth, baseUrl: "http://127.0.0.1:1" });
			expect(down.success).toBe(false);
			expect(down.error).toBeTruthy();
		});
	});

	// ---- Download tools ------------------------------------------------------------

	describe("attachment downloads", () => {
		it("gate saveTo on the write flag and confirm for every download tool, before any request", async () => {
			const { getExpenseAttachmentTool } = await import("../dist/tools/expense-lifecycle.js");
			const { getMyAttachmentsTool } = await import("../dist/tools/user.js");
			const dir = mkdtempSync(join(tmpdir(), "unanet-gate-"));
			const target = join(dir, "out.pdf");
			delete process.env.UNANET_ENABLE_WRITE_TOOLS;

			const expense = await getExpenseAttachmentTool.handler(
				{ expenseId: 1, attachmentId: 1, saveTo: target, overwrite: false, includeData: false, confirm: true },
				auth,
			);
			expect(expense.error).toContain("UNANET_ENABLE_WRITE_TOOLS");
			process.env.UNANET_ENABLE_WRITE_TOOLS = "true";
			const mine = await getMyAttachmentsTool.handler(
				{ attachmentId: 1, saveTo: target, overwrite: true, includeData: false, page: 1, pageSize: 50 },
				auth,
			);
			expect(mine.error).toContain("confirm=true");
			delete process.env.UNANET_ENABLE_WRITE_TOOLS;
			expect(existsSync(target)).toBe(false);
		});

		it("never writes through a symlink, even a dangling one, and never replaces a link target", () => {
			const dir = mkdtempSync(join(tmpdir(), "unanet-links-"));
			const attachment = { name: "r.pdf", data: Buffer.from("payload").toString("base64") };
			const realFile = join(dir, "real.pdf");
			writeFileSync(realFile, "original");
			symlinkSync(realFile, join(dir, "link-to-real.pdf"));
			symlinkSync(join(dir, "missing-target.pdf"), join(dir, "dangling.pdf"));

			for (const target of ["link-to-real.pdf", "dangling.pdf"]) {
				for (const overwrite of [false, true]) {
					const result = saveAttachmentToDisk(attachment, join(dir, target), { overwrite });
					expect(result.ok, `${target} overwrite=${overwrite}`).toBe(false);
				}
			}
			expect(readFileSync(realFile, "utf8")).toBe("original");
			expect(existsSync(join(dir, "missing-target.pdf"))).toBe(false);

			expect(saveAttachmentToDisk(attachment, realFile).ok).toBe(false);
			expect(saveAttachmentToDisk(attachment, realFile, { overwrite: true }).ok).toBe(true);
			expect(readFileSync(realFile, "utf8")).toBe("payload");
		});
	});
});
