// User Reviews: Unanet "reviews" are acknowledgement steps that some
// configurations require after a submission or approval (e.g. "review your
// approved timesheet"). Listing is read-only; completing a review is a write.

import { z } from "zod";
import { type UnanetAuth, createUnanetClient } from "../auth.js";
import { summarizeQueueItem } from "./approvals.js";
import {
	compact,
	confirmSchema,
	errorResult,
	itemsFromResponse,
	pageInfo,
	pageSchema,
	pageSizeSchema,
	requireConfirm,
	writeErrorResult,
} from "../utils/http.js";

const REVIEW_TYPES = ["time", "expense", "invoice"] as const;
const REVIEW_ROLES = ["owner", "manager", "project-approver", "customer"] as const;
type ReviewType = (typeof REVIEW_TYPES)[number];
type ReviewRole = (typeof REVIEW_ROLES)[number];

// GET list cells (invoice reviews have no list endpoint in the spec).
const LIST_CELLS: Record<ReviewType, ReviewRole[]> = {
	time: ["owner", "manager", "project-approver", "customer"],
	expense: ["owner", "manager", "project-approver", "customer"],
	invoice: [],
};
// POST complete-review cells.
const COMPLETE_CELLS: Record<ReviewType, ReviewRole[]> = {
	time: ["owner", "manager", "project-approver", "customer"],
	expense: ["owner", "manager", "project-approver", "customer"],
	invoice: ["manager", "project-approver", "customer"],
};

function reviewPath(type: ReviewType, role: ReviewRole, id?: number): string {
	const base = role === "owner" ? `/me/reviews/${type}` : `/me/reviews/${type}/${role}`;
	return id === undefined ? base : `${base}/${id}`;
}

export const getMyPendingReviewsTool = {
	name: "unanet_get_my_pending_reviews",
	description:
		"List Unanet timesheet/expense reviews waiting on you, as the owner (your own submissions) or as manager/project-approver/customer. Read-only.",
	inputSchema: z.object({
		type: z.enum(["time", "expense", "all"]).optional().default("all"),
		role: z.enum([...REVIEW_ROLES, "all"]).optional().default("all"),
		page: pageSchema,
		pageSize: pageSizeSchema(50, 200),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		try {
			const client = createUnanetClient(auth);
			const types: ReviewType[] =
				args.type === "all" ? ["time", "expense"] : [args.type];
			const roles: ReviewRole[] =
				args.role === "all" ? [...REVIEW_ROLES] : [args.role];
			const cells = types.flatMap((type) =>
				LIST_CELLS[type]
					.filter((role) => roles.includes(role))
					.map((role) => ({ type, role })),
			);
			const results = await Promise.all(
				cells.map(async ({ type, role }) => {
					try {
						const response = await client.get(reviewPath(type, role), {
							params: { page: args.page, pageSize: args.pageSize },
						});
						return {
							type,
							role,
							items: itemsFromResponse<any>(response.data).map((item) =>
								summarizeQueueItem(type, item),
							),
							paging: pageInfo(response.data),
							error: null,
						};
					} catch (error: any) {
						return { type, role, items: [], paging: null, error: error.message };
					}
				}),
			);
			const queues = results.filter((result) => !result.error);
			return {
				success: queues.length > 0,
				totalPending: queues.reduce((sum, queue) => sum + queue.items.length, 0),
				queues,
				endpointErrors: results
					.filter((result) => result.error)
					.map((result) => ({ type: result.type, role: result.role, error: result.error })),
			};
		} catch (error) {
			return errorResult(error);
		}
	},
};

export const completeReviewTool = {
	name: "unanet_complete_review",
	description:
		"Complete (acknowledge) a pending Unanet review of a timesheet, expense report or invoice, in the given role. projectKey is required for project-approver/customer (project-level) reviews. Requires confirm: true.",
	inputSchema: z.object({
		type: z.enum(REVIEW_TYPES),
		role: z.enum(REVIEW_ROLES),
		id: z.number().int().positive().describe("Timesheet, expense report or invoice key."),
		projectKey: z.number().int().positive().optional(),
		comment: z.string().optional(),
		confirm: confirmSchema("review completion"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const confirmError = requireConfirm(args, "completing a review");
		if (confirmError) return { success: false, error: confirmError };
		if (!COMPLETE_CELLS[args.type as ReviewType].includes(args.role)) {
			return {
				success: false,
				error: `Unanet has no ${args.type} review for role=${args.role}. Valid roles: ${COMPLETE_CELLS[args.type as ReviewType].join(", ")}.`,
			};
		}
		if (["project-approver", "customer"].includes(args.role) && !args.projectKey) {
			return {
				success: false,
				error: `projectKey is required for ${args.role} (project-level) reviews.`,
			};
		}
		try {
			const client = createUnanetClient(auth);
			await client.post(
				reviewPath(args.type, args.role, args.id),
				compact({ projectKey: args.projectKey, comment: args.comment }),
			);
			return {
				success: true,
				type: args.type,
				role: args.role,
				id: args.id,
				message: `${args.type} ${args.id} review completed as ${args.role}.`,
			};
		} catch (error) {
			return writeErrorResult(error);
		}
	},
};
