import { type UnanetAuth, createUnanetClient } from "../auth.js";

function itemsFromResponse<T>(data: any): T[] {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.items)) return data.items;
	if (Array.isArray(data?.message?.items)) return data.message.items;
	if (Array.isArray(data?.content)) return data.content;
	return [];
}

// Project list resource
export const projectListResource = {
	uri: "unanet://projects/active",
	name: "Active Projects",
	description: "List of active projects in Unanet Platform REST",
	mimeType: "application/json",
	handler: async (auth: UnanetAuth) => {
		const client = createUnanetClient(auth);

		try {
			const response = await client.post(
				"/projects/search",
				{ projectStatusActive: true },
				{ params: { page: 1, pageSize: 100 } },
			);
			const projects = itemsFromResponse<any>(response.data);

			return {
				projects: projects.map((project) => ({
					key: project.key,
					code: project.code ?? project.projectCode,
					title: project.title ?? project.name,
					status: project.status?.name ?? project.status,
					projectOrg: project.projectOrg?.name,
					owningOrg: project.owningOrg?.name,
					projectManager:
						project.projectManager?.name ?? project.projectManager,
				})),
				count: projects.length,
				lastUpdated: new Date().toISOString(),
			};
		} catch (error: any) {
			return {
				error: error.message,
				projects: [],
				count: 0,
			};
		}
	},
};

// Timesheet templates resource
export const timesheetTemplatesResource = {
	uri: "unanet://timesheets/templates",
	name: "Timesheet Templates",
	description: "Recent Platform REST timesheet project/pay-code combinations",
	mimeType: "application/json",
	handler: async (auth: UnanetAuth) => {
		const client = createUnanetClient(auth);

		try {
			const endDate = new Date();
			const startDate = new Date();
			startDate.setDate(startDate.getDate() - 30);

			const response = await client.post(
				"/me/time/search",
				{
					beginDateStart: startDate.toISOString().split("T")[0],
					beginDateEnd: endDate.toISOString().split("T")[0],
				},
				{ params: { page: 1, pageSize: 5 } },
			);
			const timesheets = itemsFromResponse<any>(response.data);

			const templates = new Map<string, any>();
			for (const timesheet of timesheets) {
				const details = await client
					.get(`/me/time/${timesheet.key ?? timesheet.id}`)
					.then((result) => result.data)
					.catch(() => undefined);

				for (const timeslip of details?.timeslips ?? []) {
					const projectKey = timeslip.project?.key;
					if (!projectKey) continue;
					const key = [
						projectKey,
						timeslip.task?.key ?? "default",
						timeslip.projectType?.key ?? "project-type",
						timeslip.payCode?.key ?? "pay-code",
					].join("-");

					if (!templates.has(key)) {
						templates.set(key, {
							projectKey,
							projectName: timeslip.project?.name,
							taskKey: timeslip.task?.key ?? null,
							taskName: timeslip.task?.name ?? null,
							projectTypeKey: timeslip.projectType?.key,
							projectTypeName: timeslip.projectType?.name,
							payCodeKey: timeslip.payCode?.key,
							payCodeName: timeslip.payCode?.name,
							laborCategoryKey: timeslip.laborCategory?.key ?? null,
							laborCategoryName: timeslip.laborCategory?.name ?? null,
							locationKey: timeslip.location?.key ?? null,
							locationName: timeslip.location?.name ?? null,
						});
					}
				}
			}

			return {
				templates: Array.from(templates.values()),
				commonCategories: [
					{ name: "Development", billable: true },
					{ name: "Meeting", billable: true },
					{ name: "Code Review", billable: true },
					{ name: "Documentation", billable: true },
					{ name: "Training", billable: false },
					{ name: "Administrative", billable: false },
				],
				lastUpdated: new Date().toISOString(),
			};
		} catch (error: any) {
			return {
				error: error.message,
				templates: [],
				commonCategories: [],
			};
		}
	},
};
