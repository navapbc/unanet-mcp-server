// Shared attachment helpers. Unanet uploads attachments as a JSON
// AttachmentCreateModel ({ name, mimeType, length, data: base64 }) rather than
// multipart, on every attachment endpoint (expenses, timesheets, user, people,
// invoices...). Reads return the same shape with the full base64 bytes.

import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { toNumberOrNull } from "./http.js";

// Large blobs are usually the wrong file. Keep in step with expenses.ts.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".heic": "image/heic",
	".heif": "image/heif",
	".tif": "image/tiff",
	".tiff": "image/tiff",
	".bmp": "image/bmp",
	".txt": "text/plain",
	".csv": "text/csv",
	".doc": "application/msword",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx":
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function inferMimeType(name: string): string | null {
	return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? null;
}

// Attachment tools read and write local files on behalf of a model. Keep them
// to ordinary document files so a prompt-injected path cannot upload a
// credential file (~/.ssh/id_rsa, ~/.aws/credentials, .env) or drop a script:
// no hidden file or directory anywhere in the real path (symlinks resolved),
// and only the document/receipt extensions in MIME_BY_EXTENSION.
export function checkLocalAttachmentPath(
	path: string,
	purpose: "read" | "write",
): { ok: true; path: string } | { ok: false; error: string } {
	const requested = resolve(path);
	let real: string;
	try {
		if (purpose === "read") {
			real = realpathSync(requested);
		} else {
			const target = join(realpathSync(dirname(requested)), basename(requested));
			real = existsSync(target) ? realpathSync(target) : target;
		}
	} catch (error: any) {
		return { ok: false, error: `Could not resolve ${requested}: ${error.message}` };
	}
	if (real.split(sep).some((part) => part.startsWith(".") && part !== "." && part !== "..")) {
		return {
			ok: false,
			error: `Refusing ${real}: hidden files and folders (such as .ssh, .aws or .env) are not allowed for attachments.`,
		};
	}
	if (!inferMimeType(real)) {
		return {
			ok: false,
			error: `Refusing ${real}: attachments must be one of ${Object.keys(MIME_BY_EXTENSION).join(", ")}.`,
		};
	}
	return { ok: true, path: real };
}

export function summarizeAttachment(attachment: any) {
	return {
		key: attachment?.key ?? null,
		name: attachment?.name ?? null,
		mimeType: attachment?.mimeType ?? null,
		length: toNumberOrNull(attachment?.length),
		created: attachment?.created ?? null,
		createdBy: attachment?.createdBy?.name ?? attachment?.createdBy?.key ?? null,
	};
}

// Input fields shared by every "upload an attachment" tool. Spread into the
// tool's own z.object() and pass the parsed args to loadAttachmentInput().
export const attachmentInputFields = {
	filePath: z
		.string()
		.min(1)
		.optional()
		.describe("Absolute local path to the file to read and upload."),
	data: z
		.string()
		.min(1)
		.optional()
		.describe("Base64-encoded file bytes. Use instead of filePath."),
	name: z
		.string()
		.min(1)
		.optional()
		.describe("Attachment file name. Defaults to the filePath basename."),
	mimeType: z
		.string()
		.min(1)
		.optional()
		.describe("MIME type. Inferred from the file extension when omitted."),
};

export function refineAttachmentInput(
	value: { filePath?: string; data?: string; name?: string },
	context: z.RefinementCtx,
): void {
	if (!value.filePath && !value.data) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["filePath"],
			message: "Provide either filePath or data.",
		});
	}
	if (value.filePath && value.data) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["data"],
			message: "Provide filePath or data, not both.",
		});
	}
	if (value.data && !value.name) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["name"],
			message: "name is required when uploading inline data.",
		});
	}
}

export type AttachmentPayload = {
	name: string;
	mimeType: string;
	length: number;
	data: string;
};

export function loadAttachmentInput(args: {
	filePath?: string;
	data?: string;
	name?: string;
	mimeType?: string;
}): { ok: true; payload: AttachmentPayload } | { ok: false; error: string } {
	const name = args.name ?? (args.filePath ? basename(args.filePath) : null);
	if (!name) return { ok: false, error: "Could not determine attachment name." };

	let data: string;
	let length: number;
	if (args.filePath) {
		const checked = checkLocalAttachmentPath(args.filePath, "read");
		if (!checked.ok) return checked;
		let buffer: Buffer;
		try {
			buffer = readFileSync(checked.path);
		} catch (readError: any) {
			return {
				ok: false,
				error: `Could not read file ${args.filePath}: ${readError.message}`,
			};
		}
		length = buffer.length;
		data = buffer.toString("base64");
	} else {
		data = args.data as string;
		length = Buffer.from(data, "base64").length;
	}

	if (length === 0) return { ok: false, error: "Attachment is empty (0 bytes)." };
	if (length > MAX_ATTACHMENT_BYTES) {
		return {
			ok: false,
			error: `Attachment is ${length} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte limit.`,
		};
	}

	const mimeType = args.mimeType ?? inferMimeType(name);
	if (!mimeType) {
		return {
			ok: false,
			error: `Could not infer MIME type for "${name}". Pass mimeType explicitly (e.g. application/pdf).`,
		};
	}

	return { ok: true, payload: { name, mimeType, length, data } };
}

// Write a downloaded AttachmentModel to disk. Never overwrites an existing
// file unless the caller opts in; returns the absolute path written.
export function saveAttachmentToDisk(
	attachment: { name?: string; data?: string },
	saveTo: string,
	options: { overwrite?: boolean } = {},
): { ok: true; path: string; bytes: number } | { ok: false; error: string } {
	if (!attachment?.data) {
		return { ok: false, error: "Attachment response contained no data." };
	}
	const checked = checkLocalAttachmentPath(saveTo, "write");
	if (!checked.ok) return checked;
	const target = checked.path;
	if (existsSync(target) && !options.overwrite) {
		return {
			ok: false,
			error: `${target} already exists. Pass overwrite=true to replace it.`,
		};
	}
	const buffer = Buffer.from(attachment.data, "base64");
	try {
		writeFileSync(target, buffer);
	} catch (writeError: any) {
		return { ok: false, error: `Could not write ${target}: ${writeError.message}` };
	}
	return { ok: true, path: target, bytes: buffer.length };
}
