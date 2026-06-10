import { z } from "zod";
import { type UnanetAuth, createUnanetClient } from "../auth.js";
import type { Project, ProjectDetails } from "../types/unanet.js";

function itemsFromResponse<T>(data: any): T[] {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.items)) return data.items;
	if (Array.isArray(data?.message?.items)) return data.message.items;
	if (Array.isArray(data?.content)) return data.content;
	return [];
}

function platformProjectSearch(args: any): Record<string, unknown> {
	const criteria: Record<string, unknown> = {};
	if (args.status === "Active") criteria.projectStatusActive = true;
	if (args.status === "Inactive") criteria.projectStatusActive = false;
	if (args.projectCode) criteria.projectCode = args.projectCode;
	if (args.projectTitle) criteria.projectTitle = args.projectTitle;
	return criteria;
}

// Get all projects tool
export const getProjectsTool = {
	name: "unanet_get_projects",
	description: "Search projects from Unanet Platform REST",
	inputSchema: z.object({
		status: z
			.enum(["Active", "Inactive", "All"])
			.optional()
			.default("All")
			.describe(
				"Project activity filter. Completed is intentionally not accepted because the Platform REST search flag is not yet confirmed.",
			),
		limit: z.number().positive().optional().default(50),
		projectCode: z
			.string()
			.optional()
			.describe("Optional project code search term"),
		projectTitle: z
			.string()
			.optional()
			.describe("Optional project title search term"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const client = createUnanetClient(auth);

		try {
			const response = await client.post(
				"/projects/search",
				platformProjectSearch(args),
				{
					params: { page: 1, pageSize: args.limit },
				},
			);
			const projects = itemsFromResponse<Project>(response.data);

			return {
				success: true,
				count: projects.length,
				projects,
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};

// Get project details tool
export const getProjectDetailsTool = {
	name: "unanet_get_project_details",
	description:
		"Get detailed information about a specific Platform REST project key",
	inputSchema: z.object({
		projectId: z
			.string()
			.describe("The numeric key/id of the project to retrieve"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const client = createUnanetClient(auth);

		try {
			const response = await client.get<ProjectDetails>(
				`/projects/${args.projectId}`,
			);

			return {
				success: true,
				project: response.data,
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};

// Update project budget tool
export const updateProjectBudgetTool = {
	name: "unanet_update_project_budget",
	description:
		"Not directly supported by the Platform REST project update model without a full project payload",
	inputSchema: z.object({
		projectId: z.string().describe("The ID of the project to update"),
		budget: z.number().positive().describe("The new budget amount"),
		notes: z.string().optional().describe("Notes about the budget change"),
	}),
	handler: async (args: any, _auth: UnanetAuth) => {
		return {
			success: false,
			projectId: args.projectId,
			error:
				"Platform REST does not expose a simple project budget PATCH endpoint. Updating a project requires a full ProjectUpdateModel payload; this tool is disabled until that model is explicitly implemented.",
		};
	},
};

// Get project status tool
export const getProjectStatusTool = {
	name: "unanet_get_project_status",
	description: "Get current status data for a project from Platform REST",
	inputSchema: z.object({
		projectId: z.string().describe("The numeric key/id of the project"),
	}),
	handler: async (args: any, auth: UnanetAuth) => {
		const client = createUnanetClient(auth);

		try {
			const projectResponse = await client.get<ProjectDetails>(
				`/projects/${args.projectId}`,
			);
			const project: any = projectResponse.data;

			return {
				success: true,
				projectId: args.projectId,
				name: project.name ?? project.title ?? project.projectTitle,
				status: project.status ?? project.projectStatus ?? project.statusKey,
				percentComplete: project.percentComplete ?? project.pctComplete,
				budget: {
					total: project.budget,
					spent: project.actualCost,
					remaining:
						project.budget !== undefined && project.actualCost !== undefined
							? project.budget - project.actualCost
							: null,
				},
				schedule: {
					startDate: project.startDate ?? project.revStartDate,
					endDate: project.endDate ?? project.revEndDate,
					daysRemaining: calculateDaysRemaining(
						project.endDate ?? project.revEndDate,
					),
				},
				project,
			};
		} catch (error: any) {
			return {
				success: false,
				error: error.message,
			};
		}
	},
};

// Helper function
function calculateDaysRemaining(endDate?: string): number | null {
	if (!endDate) return null;

	const end = new Date(endDate);
	const today = new Date();
	const diffTime = end.getTime() - today.getTime();
	const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

	return diffDays;
}
