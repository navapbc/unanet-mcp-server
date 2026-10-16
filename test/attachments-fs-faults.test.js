import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two injected faults:
//  - every writeSync call accepts only 3 bytes, as a short write would;
//  - lstatSync reports ENOENT for "swapped.pdf", as if a symlink were put there
//    after the path check ran and before the file was opened.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		writeSync: (fd, buffer, ...rest) => actual.writeSync(fd, buffer.subarray(0, 3), ...rest),
		lstatSync: (path, ...rest) => {
			if (String(path).endsWith("swapped.pdf")) {
				throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
			}
			return actual.lstatSync(path, ...rest);
		},
	};
});

const attachment = (payload) => ({ name: "receipt.pdf", data: Buffer.from(payload).toString("base64") });

describe("saveAttachmentToDisk under injected faults", () => {
	it("writes the whole file even when single write calls are short", async () => {
		const { saveAttachmentToDisk } = await import("../dist/utils/attachments.js");
		const target = join(mkdtempSync(join(tmpdir(), "unanet-short-")), "receipt.pdf");
		const payload = "0123456789abcdef";
		const result = saveAttachmentToDisk(attachment(payload), target);
		expect(result.ok).toBe(true);
		expect(readFileSync(target, "utf8")).toBe(payload);
	});

	it("does not follow a symlink that appears after the path check", async () => {
		const { saveAttachmentToDisk } = await import("../dist/utils/attachments.js");
		const dir = mkdtempSync(join(tmpdir(), "unanet-race-"));
		const victim = join(dir, "victim.pdf");
		writeFileSync(victim, "original");
		symlinkSync(victim, join(dir, "swapped.pdf"));
		const result = saveAttachmentToDisk(attachment("replacement"), join(dir, "swapped.pdf"), { overwrite: true });
		expect(result.ok).toBe(false);
		expect(readFileSync(victim, "utf8")).toBe("original");
	});
});
