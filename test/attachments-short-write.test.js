import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Make every writeSync call accept only 3 bytes, as a short write would.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		writeSync: (fd, buffer, ...rest) => actual.writeSync(fd, buffer.subarray(0, 3), ...rest),
	};
});

describe("saveAttachmentToDisk", () => {
	it("writes the whole file even when single write calls are short", async () => {
		const { saveAttachmentToDisk } = await import("../dist/utils/attachments.js");
		const target = join(mkdtempSync(join(tmpdir(), "unanet-short-")), "receipt.pdf");
		const payload = "0123456789abcdef";
		const result = saveAttachmentToDisk(
			{ name: "receipt.pdf", data: Buffer.from(payload).toString("base64") },
			target,
		);
		expect(result.ok).toBe(true);
		expect(readFileSync(target, "utf8")).toBe(payload);
	});
});
