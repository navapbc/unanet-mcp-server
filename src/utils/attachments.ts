// Shared attachment helpers. Unanet uploads attachments as a JSON
// AttachmentCreateModel ({ name, mimeType, length, data: base64 }) rather than
// multipart, on every attachment endpoint (expenses, timesheets, user, people,
// invoices...). Reads return the same shape with the full base64 bytes.

import {
	closeSync,
	constants,
	fstatSync,
	ftruncateSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	writeSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { isEnabled } from "../auth.js";
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

// Attachment tools read and write local files on behalf of a model. This is a
// guard against careless or injected paths, not a content scanner: it refuses
// hidden files and folders anywhere in the real path (symlinks resolved), so
// ~/.ssh, ~/.aws and .env style locations are out, and it only accepts the
// document/receipt extensions in MIME_BY_EXTENSION. A visible file with an
// allowed extension is accepted whatever it contains. Destinations that are
// symlinks or not regular files are refused.
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
			real = join(realpathSync(dirname(requested)), basename(requested));
			let existing;
			try {
				existing = lstatSync(real);
			} catch (error: any) {
				if (error.code !== "ENOENT") throw error;
			}
			if (existing && !existing.isFile()) {
				return {
					ok: false,
					error: `Refusing ${real}: the destination exists and is not a regular file (symbolic links are not followed).`,
				};
			}
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

// Writing a downloaded attachment to the local disk changes the user's
// machine, so it is gated like a write: the write tier must be enabled AND the
// caller must pass confirm=true. Metadata and inline (includeData) downloads
// stay available without either. Read at call time, never cached.
export function diskSaveBlocked(args: { saveTo?: string; confirm?: unknown }): string | null {
	if (!args.saveTo) return null;
	if (!isEnabled(process.env.UNANET_ENABLE_WRITE_TOOLS)) {
		return "Saving an attachment to disk requires UNANET_ENABLE_WRITE_TOOLS=true. Use includeData=true to receive the file inline instead.";
	}
	if (args.confirm !== true) {
		return "confirm=true is required before saving an attachment to disk.";
	}
	return null;
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
// file unless the caller opts in; returns the absolute path written. The file
// is opened without following a final symlink (and exclusively when not
// overwriting), so the checked path cannot be swapped for a link between the
// check and the write.
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
	const buffer = Buffer.from(attachment.data, "base64");
	const noFollow = constants.O_NOFOLLOW ?? 0;
	const flags = options.overwrite
		? constants.O_WRONLY | constants.O_CREAT | noFollow
		: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(target, flags, 0o600);
		if (!fstatSync(descriptor).isFile()) {
			return { ok: false, error: `Refusing ${target}: it is not a regular file.` };
		}
		ftruncateSync(descriptor, 0);
		writeSync(descriptor, buffer);
	} catch (writeError: any) {
		if (writeError.code === "EEXIST") {
			return {
				ok: false,
				error: `${target} already exists. Pass overwrite=true to replace it.`,
			};
		}
		return { ok: false, error: `Could not write ${target}: ${writeError.message}` };
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
	return { ok: true, path: target, bytes: buffer.length };
}
