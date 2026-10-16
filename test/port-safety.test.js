/**
 * Safety checks for the attachment file helpers, the optional login customer
 * id, and the Unanet error detail on 401/403. Runs against the mock server.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPlatformTokenCache, getPlatformBearerToken } from "../dist/auth.js";
import { checkLocalAttachmentPath, loadAttachmentInput, saveAttachmentToDisk } from "../dist/utils/attachments.js";

const MOCK_PORT = 3212;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;

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

describe("attachment path safety", () => {
	const root = mkdtempSync(join(tmpdir(), "unanet-safety-"));
	const hiddenDir = join(root, ".ssh");
	mkdirSync(hiddenDir);
	writeFileSync(join(hiddenDir, "receipt.pdf"), "%PDF-1.4 hidden");
	writeFileSync(join(root, "id_rsa"), "PRIVATE KEY");
	writeFileSync(join(root, ".env"), "SECRET=1");
	writeFileSync(join(root, "receipt.pdf"), "%PDF-1.4 ok");
	symlinkSync(join(root, ".env"), join(root, "innocent.pdf"));
	symlinkSync(hiddenDir, join(root, "visible-dir"));

	it("reads an ordinary receipt", () => {
		const loaded = loadAttachmentInput({ filePath: join(root, "receipt.pdf") });
		expect(loaded.ok).toBe(true);
		expect(loaded.payload.mimeType).toBe("application/pdf");
	});

	it.each([
		["a credential file with no extension, even with an explicit mimeType", join(root, "id_rsa"), "text/plain"],
		["a hidden file", join(root, ".env"), undefined],
		["a file inside a hidden folder", join(hiddenDir, "receipt.pdf"), undefined],
		["a symlink that resolves to a hidden file", join(root, "innocent.pdf"), undefined],
		["a symlinked folder that resolves into a hidden folder", join(root, "visible-dir", "receipt.pdf"), undefined],
	])("refuses to upload %s", (_label, filePath, mimeType) => {
		const loaded = loadAttachmentInput({ filePath, mimeType });
		expect(loaded.ok).toBe(false);
		expect(loaded.error).toMatch(/Refusing/);
	});

	it("only saves downloads as document files outside hidden folders, and never over a file by default", () => {
		const attachment = { name: "r.pdf", data: Buffer.from("hello").toString("base64") };

		const ok = saveAttachmentToDisk(attachment, join(root, "saved.pdf"));
		expect(ok.ok).toBe(true);
		expect(readFileSync(join(root, "saved.pdf"), "utf8")).toBe("hello");

		for (const target of [
			join(root, "evil.sh"),
			join(root, "LaunchAgent.plist"),
			join(root, ".zshrc"),
			join(hiddenDir, "authorized.pdf"),
			join(root, "visible-dir", "dropped.pdf"),
		]) {
			const refused = saveAttachmentToDisk(attachment, target);
			expect(refused.ok, target).toBe(false);
			expect(existsSync(target), target).toBe(false);
		}

		const overwrite = saveAttachmentToDisk(attachment, join(root, "saved.pdf"));
		expect(overwrite.ok).toBe(false);
		expect(overwrite.error).toContain("already exists");
		expect(checkLocalAttachmentPath(join(root, "no-such-dir", "x.pdf"), "write").ok).toBe(false);
	});
});

describe("login and error handling against the mock", () => {
	let mockProcess;
	const base = { username: "test-user", password: "test-pass", baseUrl: MOCK_BASE_URL };

	beforeAll(async () => {
		process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK = "true";
		mockProcess = spawn("node", ["dist/mock-server.js"], { env: { ...process.env, PORT: String(MOCK_PORT) } });
		await waitForOutput(mockProcess, "Mock Unanet API server running");
	});

	afterAll(() => {
		delete process.env.UNANET_ALLOW_INSECURE_LOCAL_MOCK;
		if (mockProcess) mockProcess.kill();
	});

	async function lastLoginKeys() {
		return (await (await fetch(`${MOCK_BASE_URL}/platform/rest/__test/last-login-keys`)).json()).keys;
	}

	it("omits customerId unless one is configured", async () => {
		clearPlatformTokenCache();
		await getPlatformBearerToken(base);
		expect(await lastLoginKeys()).toEqual(["password", "username"]);

		clearPlatformTokenCache();
		await getPlatformBearerToken({ ...base, customerId: "acme" });
		expect(await lastLoginKeys()).toEqual(["customerId", "password", "username"]);
	});

	it("does not reuse a token across different customer ids", async () => {
		clearPlatformTokenCache();
		await getPlatformBearerToken(base);
		await getPlatformBearerToken({ ...base, customerId: "acme" });
		expect(await lastLoginKeys()).toEqual(["customerId", "password", "username"]);
	});
});
