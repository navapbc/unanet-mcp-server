import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "../setup-mac.sh");
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
const previous = { command: "old-node", args: ["/old path/index.js"], env: { UNANET_ENV_FILE: "/private settings/custom.env" } };

// Execute the entire installer, isolating client state and replacing only its
// external dependencies. No real credentials, registration, installs or sign-in.
function install({ existing = false, failAdd = false, failInstall = false, decline = false, hasClaude = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), "unanet registration "));
	try {
		const home = join(root, "home");
		const bin = join(root, "bin");
		const project = join(root, "project");
		for (const dir of [home, bin, project]) mkdirSync(dir);
		copyFileSync(SCRIPT, join(project, "setup-mac.sh"));
		writeFileSync(join(project, ".env"), "UNANET_USERNAME=synthetic\n");
		const registration = join(home, "registration.json");
		if (existing) writeFileSync(registration, JSON.stringify(previous));
		const executable = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		executable("node", `if [ "$1" = dist/check-setup.js ]; then touch "$HOME/sign-in-checked"; exit 0; fi\nexec ${quote(process.execPath)} "$@"`);
		executable("npm", `if [ "$1" = install ]; then exit ${failInstall ? 44 : 0}; fi\nexit 0`);
		if (hasClaude) {
			writeFileSync(join(home, "claude.cjs"), `
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.env.HOME, 'registration.json');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.HOME, 'calls'), JSON.stringify(args) + '\\n');
if (args[1] === 'remove') { fs.rmSync(file, { force: true }); process.exit(0); }
if (args[1] !== 'add') process.exit(2);
if (fs.existsSync(file)) { console.error('MCP server unanet already exists in user config'); process.exit(1); }
if (${failAdd}) process.exit(23);
const separator = args.indexOf('--');
fs.writeFileSync(file, JSON.stringify({ command: args[separator + 1], args: args.slice(separator + 2), env: {} }));
`);
			executable("claude", `exec ${quote(process.execPath)} "$HOME/claude.cjs" "$@"`);
		}
		const result = spawnSync("/bin/bash", [join(project, "setup-mac.sh")], {
			cwd: home,
			env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
			input: `n\n${decline ? "n" : "y"}\n`, encoding: "utf8", timeout: 15000,
		});
		return {
			...result,
			entry: existsSync(registration) ? JSON.parse(readFileSync(registration, "utf8")) : null,
			calls: existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8").trim().split("\n").map(JSON.parse) : [],
			checked: existsSync(join(home, "sign-in-checked")),
			server: join(realpathSync(project), "dist/index.js"),
			node: join(bin, "node"),
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe.skipIf(process.platform === "win32")("Mac installer Claude Code registration", () => {
	it("preserves an existing command, arguments and custom environment when registration is refused", () => {
		const result = install({ existing: true });
		expect(result.status).toBe(1);
		expect(result.entry).toEqual(previous);
		expect(result.calls.some((args) => args[1] === "remove")).toBe(false);
		expect(result.checked).toBe(false);
		expect(result.stdout).not.toContain("Setup complete.");
	});

	it("fails without claiming completion when a fresh registration cannot be added", () => {
		const result = install({ failAdd: true });
		expect(result.status).toBe(1);
		expect(result.entry).toBeNull();
		expect(result.checked).toBe(false);
		expect(result.stdout).not.toContain("Setup complete.");
	});

	it("registers a fresh install with intact spaced paths and proceeds to the sign-in check", () => {
		const result = install();
		expect(result.status).toBe(0);
		expect(result.entry).toEqual({ command: result.node, args: [result.server], env: {} });
		expect(result.checked).toBe(true);
	});

	it("leaves the previous entry intact when dependency installation fails", () => {
		const result = install({ existing: true, failInstall: true });
		expect(result.status).toBe(44);
		expect(result.entry).toEqual(previous);
		expect(result.checked).toBe(false);
	});

	it("keeps the existing entry and checks sign-in when registration is declined", () => {
		const result = install({ existing: true, decline: true });
		expect(result.status).toBe(0);
		expect(result.entry).toEqual(previous);
		expect(result.checked).toBe(true);
	});

	it("can check sign-in without Claude Code installed", () => {
		const result = install({ hasClaude: false });
		expect(result.status).toBe(0);
		expect(result.entry).toBeNull();
		expect(result.checked).toBe(true);
	});
});
