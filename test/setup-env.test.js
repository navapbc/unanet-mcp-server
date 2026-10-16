/**
 * setup-mac.sh writes the Unanet password into .env. dotenv truncates an
 * unquoted value at "#" and treats quoted values literally, so the installer's
 * dotenv_quote must produce a line that dotenv reads back unchanged.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { resolve } from "path";
import dotenv from "dotenv";

const SCRIPT = resolve(import.meta.dirname, "../setup-mac.sh");

function quote(value) {
	return spawnSync(
		"bash",
		[
			"-c",
			'source <(sed -n "/^dotenv_quote()/,/^}/p" "$1"); dotenv_quote "$2"',
			"_",
			SCRIPT,
			value,
		],
		{ encoding: "utf8" },
	);
}

describe("setup-mac.sh dotenv_quote", () => {
	it.each([
		"p#ss",
		"p=ss",
		"p space",
		"it's",
		'say "hi"',
		"back`tick",
		"trail\\n",
		"$HOME and ${X}",
		"plain",
	])("round-trips %j through dotenv", (value) => {
		const result = quote(value);
		expect(result.status).toBe(0);
		const parsed = dotenv.parse(`UNANET_PASSWORD=${result.stdout}\n`);
		expect(parsed.UNANET_PASSWORD).toBe(value);
	});

	it.each(["line\nbreak", "all'three`quote\"kinds"])(
		"refuses %j instead of writing a wrong value",
		(value) => {
			const result = quote(value);
			expect(result.status).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("cannot be stored");
		},
	);
});
