/**
 * Setup behaviour: the server finds its settings regardless of the folder it
 * is started in, starts in setup mode (one explanatory tool) instead of
 * exiting when misconfigured, and `npm run check-setup` reports the result.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const SERVER = join(REPO, "dist", "index.js");
const CHECK = join(REPO, "dist", "check-setup.js");
const MOCK_PORT = 3215;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
const OUTSIDE = mkdtempSync(join(tmpdir(), "unanet-cwd-"));
const MISSING_ENV = join(OUTSIDE, "does-not-exist.env");

// Only PATH and HOME from the parent: nothing from a developer's shell or .env.
const cleanEnv = (extra) => ({ PATH: process.env.PATH, HOME: OUTSIDE, ...extra });

function writeEnvFile(lines) {
	const path = join(mkdtempSync(join(tmpdir(), "unanet-env-")), ".env");
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

// Start the server, run initialize + the given requests, return the replies by id.
async function talk(env, requests) {
	const child = spawn("node", [SERVER], { cwd: OUTSIDE, env });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (data) => (stdout += data));
	child.stderr.on("data", (data) => (stderr += data));
	const messages = [
		{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
		...requests.map((request, index) => ({ jsonrpc: "2.0", id: index + 2, ...request })),
	];
	try {
		for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const replies = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
			if (replies.length >= messages.length) {
				return { byId: Object.fromEntries(replies.map((reply) => [reply.id, reply])), stdout, stderr };
			}
			if (child.exitCode !== null) break;
			await new Promise((done) => setTimeout(done, 25));
		}
		throw new Error(`No complete reply. exit=${child.exitCode} stderr=${stderr}`);
	} finally {
		child.kill();
	}
}

const listTools = { method: "tools/list", params: {} };
const callTool = (name) => ({ method: "tools/call", params: { name, arguments: {} } });

describe("setup", () => {
	let mockProcess;

	beforeAll(async () => {
		mockProcess = spawn("node", ["dist/mock-server.js"], { cwd: REPO, env: { ...process.env, PORT: String(MOCK_PORT) } });
		await new Promise((done, fail) => {
			const timer = setTimeout(() => fail(new Error("mock did not start")), 5000);
			const watch = (data) => {
				if (data.toString().includes("Mock Unanet API server running")) {
					clearTimeout(timer);
					done();
				}
			};
			mockProcess.stdout.on("data", watch);
			mockProcess.stderr.on("data", watch);
		});
	});

	afterAll(() => {
		if (mockProcess) mockProcess.kill();
	});

	it("reads .env from the repository folder, not the folder it is started in", () => {
		const result = spawnSync(
			"node",
			["--input-type=module", "-e", `const m = await import(${JSON.stringify(join(REPO, "dist", "config.js"))}); console.log(m.loadEnvFile().path);`],
			{ cwd: OUTSIDE, env: cleanEnv({}), encoding: "utf8" },
		);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(join(REPO, ".env"));
	});

	it("serves the full read surface when started elsewhere with a valid settings file", async () => {
		const envFile = writeEnvFile([
			"UNANET_USERNAME=test-user",
			"UNANET_PASSWORD=test-pass",
			`UNANET_BASE_URL=${MOCK_BASE_URL}`,
			"UNANET_ALLOW_INSECURE_LOCAL_MOCK=true",
		]);
		const { byId } = await talk(cleanEnv({ UNANET_ENV_FILE: envFile }), [listTools]);
		const names = byId[2].result.tools.map((tool) => tool.name);
		expect(names).toHaveLength(33);
		expect(names).toContain("unanet_get_my_leave_balances");
		expect(names).not.toContain("unanet_setup_status");
		expect(byId[1].result.instructions).toMatch(/do not open the Unanet website in a browser/i);
	});

	it("lets the client's environment override the settings file", async () => {
		const envFile = writeEnvFile([
			"UNANET_USERNAME=test-user",
			"UNANET_PASSWORD=test-pass",
			"UNANET_BASE_URL=https://navapbc.unanet.biz/platform/rest",
		]);
		const { byId } = await talk(
			cleanEnv({ UNANET_ENV_FILE: envFile, UNANET_BASE_URL: MOCK_BASE_URL, UNANET_ALLOW_INSECURE_LOCAL_MOCK: "true" }),
			[listTools],
		);
		expect(byId[2].result.tools).toHaveLength(33);
	});

	it("starts in setup mode with one tool that explains a missing configuration", async () => {
		const { byId, stderr } = await talk(cleanEnv({ UNANET_ENV_FILE: MISSING_ENV }), [
			listTools,
			callTool("unanet_setup_status"),
			callTool("unanet_get_my_leave_balances"),
		]);
		expect(byId[1].result.instructions).toContain("unanet_setup_status");
		expect(byId[1].result.instructions).toMatch(/browser/);
		expect(byId[2].result.tools.map((tool) => tool.name)).toEqual(["unanet_setup_status"]);
		const status = JSON.parse(byId[3].result.content[0].text);
		expect(status).toMatchObject({
			success: false,
			configured: false,
			problem: "UNANET_USERNAME environment variable is required",
			envFile: MISSING_ENV,
			envFileExists: false,
		});
		expect(status.howToFix.join(" ")).toContain("npm run check-setup");
		expect(status.howToFix.join(" ")).toMatch(/never ask for it in chat/);
		// Data tools are not reachable in setup mode.
		expect(byId[4].error.message).toContain("unanet_setup_status");
		expect(stderr).toContain("setup mode");
	});

	it("names a bad base URL and never echoes the password", async () => {
		const envFile = writeEnvFile([
			"UNANET_USERNAME=someone",
			"UNANET_PASSWORD=very-secret-pw",
			"UNANET_BASE_URL=https://navapbc.unanet.biz/platform/rest",
		]);
		const { byId, stdout, stderr } = await talk(cleanEnv({ UNANET_ENV_FILE: envFile }), [callTool("unanet_setup_status")]);
		const status = JSON.parse(byId[2].result.content[0].text);
		expect(status.problem).toContain("origin only");
		expect(status.envFileExists).toBe(true);
		expect(status.baseUrl).toBe("https://navapbc.unanet.biz/platform/rest");
		expect(stdout + stderr).not.toContain("very-secret-pw");
	});

	describe("npm run check-setup", () => {
		const check = (extra) => spawnSync("node", [CHECK], { cwd: OUTSIDE, env: cleanEnv(extra), encoding: "utf8" });
		const mockEnv = (password) => ({
			UNANET_ENV_FILE: MISSING_ENV,
			UNANET_USERNAME: "test-user",
			UNANET_PASSWORD: password,
			UNANET_BASE_URL: MOCK_BASE_URL,
			UNANET_ALLOW_INSECURE_LOCAL_MOCK: "true",
		});

		it("reports READY after a real sign-in and prints the Claude Code command", () => {
			const result = check(mockEnv("test-pass"));
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(`READY: signed in to ${MOCK_BASE_URL} as test-user`);
			expect(result.stdout).toContain(`claude mcp add --scope user unanet -- node "${SERVER}"`);
			expect(result.stdout).not.toContain("test-pass");
		});

		it("reports NOT READY with the reason for a rejected password, a bad address and missing settings", () => {
			const rejected = check(mockEnv("wrong-pass"));
			expect(rejected.status).toBe(1);
			expect(rejected.stdout).toContain("NOT READY: sign-in");
			expect(rejected.stdout).toContain("Authentication failed");
			expect(rejected.stdout).not.toContain("wrong-pass");

			const badUrl = check({ ...mockEnv("test-pass"), UNANET_BASE_URL: "http://navapbc.unanet.biz" });
			expect(badUrl.status).toBe(1);
			expect(badUrl.stdout).toContain("NOT READY: Production UNANET_BASE_URL must use HTTPS");

			const missing = check({ UNANET_ENV_FILE: MISSING_ENV });
			expect(missing.status).toBe(1);
			expect(missing.stdout).toContain("NOT READY: UNANET_USERNAME environment variable is required");
			expect(missing.stdout).toContain(`${MISSING_ENV} (not found)`);
		});
	});
});
