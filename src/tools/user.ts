// User self-service ("User" tag): My Projects list, rates, alternate
// approvers, and personal attachments.

import { z } from "zod";
import { type UnanetAuth, createUnanetClient } from "../auth.js";
import {
	attachmentInputFields,
	diskSaveBlocked,
	loadAttachmentInput,
	refineAttachmentInput,
	summarizeAttachment,
} from "../utils/attachments.js";
import { attachmentDownloadResult } from "./timesheet-lifecycle.js";
import {
	compact,
	confirmSchema,
	errorResult,
	itemsFromResponse,
	keyName,
	pageInfo,
	pageSchema,
	pageSizeSchema,
	requireConfirm,
	writeErrorResult,
} from "../utils/http.js";

function summarizeMyProject(project: any) {
	return {
		projectKey: project?.projectKey ?? null,
		projectCode: project?.projectCode ?? null,
		projectTitle: project?.projectTitle ?? null,
		taskKey: project?.taskKey ?? null,
		taskNumber: project?.taskNumber ?? null,
		taskName: project?.taskName ?? null,
		organizationCode: project?.organizationCode ?? null,
	};
}

export const getMyProjectsListTool = {
	name: "unanet_get_my_projects_list",
	description:
		"Read your Unanet 'My Projects' list: the project/task favourites shown on your timesheet. Read-only. (Distinct from unanet_get_my_timesheet_projects, which lists everything chargeable on a date.)",
	inputSchema: z.object({
		page: pageSchema,
		pageSize: pageSizeSchema(100, 500),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get("/me/my-projects", {
				params: { page: args.page, pageSize: args.pageSize },
			});
			const projects = itemsFromResponse<any>(response.data).map(summarizeMyProject);
			return { success: true, count: projects.length, paging: pageInfo(response.data), projects };
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const searchAvailableProjectsTool = {
	name: "unanet_search_available_projects",
	description:
		"Search projects/tasks you are eligible to add to your Unanet 'My Projects' list, by title, task name, organization, manager, type or status. Read-only.",
	inputSchema: z.object({
		projectTitle: z.string().optional(),
		taskName: z.string().optional(),
		projectKeys: z.array(z.number().int().positive()).optional(),
		organizationKeys: z.array(z.number().int().positive()).optional(),
		managerKeys: z.array(z.number().int().positive()).optional(),
		projectTypeKeys: z.array(z.number().int().positive()).optional(),
		statusKeys: z.array(z.number().int().positive()).optional(),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 500),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const { page, pageSize, ...criteria } = args;
			const response = await client.post(
				"/me/my-projects/available",
				compact(criteria),
				{ params: { page, pageSize } },
			);
			const projects = itemsFromResponse<any>(response.data).map(summarizeMyProject);
			return { success: true, count: projects.length, paging: pageInfo(response.data), projects };
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const addToMyProjectsTool = {
	name: "unanet_add_to_my_projects",
	description:
		"Add one or more projects (optionally a specific task) to your Unanet 'My Projects' list. Requires confirm: true.",
	inputSchema: z.object({
		projects: z
			.array(
				z.object({
					projectKey: z.number().int().positive(),
					taskKey: z.number().int().positive().optional(),
				}),
			)
			.min(1),
		confirm: confirmSchema("My Projects update"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "adding to My Projects");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			await client.post(
				"/me/my-projects",
				args.projects.map((project: any) => compact(project)),
			);
			return {
				success: true,
				added: args.projects,
				message: `Added ${args.projects.length} project(s) to My Projects.`,
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const removeFromMyProjectsTool = {
	name: "unanet_remove_from_my_projects",
	description:
		"Remove a project (optionally a specific task) from your Unanet 'My Projects' list. Does not affect timesheet entries. Requires confirm: true.",
	inputSchema: z.object({
		projectKey: z.number().int().positive(),
		taskKey: z.number().int().positive().optional(),
		confirm: confirmSchema("My Projects update"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "removing from My Projects");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			await client.delete(`/me/my-projects/${args.projectKey}`, {
				params: compact({ taskId: args.taskKey }),
			});
			return {
				success: true,
				projectKey: args.projectKey,
				taskKey: args.taskKey ?? null,
				message: "Removed from My Projects.",
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const getMyRatesTool = {
	name: "unanet_get_my_rates",
	description:
		"Read your Unanet person rate records (classification such as EXEMPT/NON_EXEMPT and effective dates). Read-only; sensitive personal compensation context.",
	inputSchema: z.object({}),
	handler: async (_args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const response = await client.get("/me/rates");
			const rates = itemsFromResponse<any>(response.data).map((rate) => ({
				key: rate?.key ?? null,
				classification: rate?.classification ?? null,
				beginDate: rate?.beginDate ?? null,
				endDate: rate?.endDate ?? null,
				costStructLaborKey: rate?.costStructLaborKey ?? null,
			}));
			return { success: true, count: rates.length, rates };
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const getMyAlternatesTool = {
	name: "unanet_get_my_alternates",
	description:
		"Read your Unanet alternate approvers (people who can act for you) and, with direction=for, the people you are an alternate FOR. Read-only.",
	inputSchema: z.object({
		direction: z
			.enum(["mine", "for", "both"])
			.optional()
			.default("both")
			.describe("mine = my alternates; for = people I am an alternate for; both."),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 200),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const summarize = (item: any) => ({
				personKey: item?.personKey ?? null,
				alternate: keyName(item?.alternate),
				alternateName:
					item?.alternate?.name ??
					[item?.alternate?.firstName, item?.alternate?.lastName]
						.filter(Boolean)
						.join(" ") ??
					null,
				roles: (item?.roles ?? []).map((role: any) => ({
					key: role?.key ?? null,
					name: role?.name ?? null,
					code: role?.code ?? null,
				})),
			});
			const load = async (path: string) => {
				try {
					const response = await client.get(path, {
						params: { page: args.page, pageSize: args.pageSize },
					});
					return {
						items: itemsFromResponse<any>(response.data).map(summarize),
						paging: pageInfo(response.data),
						error: null,
					};
				} catch (error: any) {
					return { items: [], paging: null, error: error.message };
				}
			};
			const [mine, forOthers] = await Promise.all([
				args.direction !== "for" ? load("/me/alternates") : Promise.resolve(null),
				args.direction !== "mine" ? load("/me/alternates/for") : Promise.resolve(null),
			]);
			return {
				success: Boolean((mine && !mine.error) || (forOthers && !forOthers.error)),
				myAlternates: mine,
				alternateFor: forOthers,
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const updateMyAlternatesTool = {
	name: "unanet_update_my_alternates",
	description:
		"Replace your Unanet alternate approvers with the given list (this is a full replacement, not an append). Each alternate needs the person key and the role keys they may act in. Requires confirm: true.",
	inputSchema: z.object({
		personKey: z
			.number()
			.int()
			.positive()
			.describe("Your own person key (the person whose alternates are being set)."),
		alternates: z.array(
			z.object({
				alternateKey: z.number().int().positive(),
				roleKeys: z.array(z.number().int().positive()).min(1),
			}),
		),
		confirm: confirmSchema("alternates update"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "updating alternates");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			await client.put(
				"/me/alternates",
				args.alternates.map((alternate: any) => ({
					personKey: args.personKey,
					alternateKey: alternate.alternateKey,
					roleKeys: alternate.roleKeys,
				})),
			);
			return {
				success: true,
				count: args.alternates.length,
				message: `Alternates replaced with ${args.alternates.length} entr${args.alternates.length === 1 ? "y" : "ies"}.`,
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const getMyAttachmentsTool = {
	name: "unanet_get_my_attachments",
	description:
		"List attachments on your Unanet person record (metadata only), or download one by attachmentId (includeData=true returns it as base64). saveTo writes it to a local document path and is the one option that changes your machine: it needs UNANET_ENABLE_WRITE_TOOLS=true and confirm: true.",
	inputSchema: z.object({
		attachmentId: z.number().int().positive().optional(),
		saveTo: z.string().min(1).optional(),
		overwrite: z.boolean().optional().default(false),
		includeData: z.boolean().optional().default(false),
		confirm: z.literal(true).optional().describe("Required with saveTo."),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 200),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const blocked = diskSaveBlocked(args);
		if (blocked) return { success: false, error: blocked };
		try {
			const client = createUnanetClient(auth);
			if (args.attachmentId) {
				const response = await client.get(`/me/attachments/${args.attachmentId}`);
				return attachmentDownloadResult(response.data, args);
			}
			const response = await client.get("/me/attachments", {
				params: { page: args.page, pageSize: args.pageSize },
			});
			const attachments = itemsFromResponse<any>(response.data).map(summarizeAttachment);
			return { success: true, count: attachments.length, paging: pageInfo(response.data), attachments };
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const addMyAttachmentTool = {
	name: "unanet_add_my_attachment",
	description:
		"Upload an attachment to your own Unanet person record. Provide a local filePath or inline base64 data. Requires confirm: true.",
	inputSchema: z
		.object({
			...attachmentInputFields,
			confirm: confirmSchema("attachment upload"),
		})
		.superRefine(refineAttachmentInput),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "uploading a personal attachment");
		if (confirmError) return { success: false, error: confirmError };
		const loaded = loadAttachmentInput(args);
		if (!loaded.ok) return { success: false, error: loaded.error };
		try {
			const client = createUnanetClient(auth);
			const response = await client.post("/me/attachments", loaded.payload);
			return {
				success: true,
				attachmentId: response.data?.key ?? null,
				name: loaded.payload.name,
				mimeType: loaded.payload.mimeType,
				length: loaded.payload.length,
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};

export const deleteMyAttachmentTool = {
	name: "unanet_delete_my_attachment",
	description:
		"Delete an attachment from your own Unanet person record. Irreversible. Requires confirm: true.",
	inputSchema: z.object({
		attachmentId: z.number().int().positive(),
		confirm: confirmSchema("attachment deletion"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "deleting a personal attachment");
		if (confirmError) return { success: false, error: confirmError };
		try {
			const client = createUnanetClient(auth);
			await client.delete(`/me/attachments/${args.attachmentId}`);
			return { success: true, attachmentId: args.attachmentId, message: "Attachment deleted." };
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};
