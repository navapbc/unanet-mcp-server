# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Operations

- Pushes to `navapbc/unanet-mcp-server` should use Billy's `billyhunt` GitHub account, not `Billy-Hunt_njdol`.
- If GitHub CLI is active under the NJDOL account, run `gh auth switch -u billyhunt` before pushing.

## Development Commands

### Building and Running
```bash
npm run build    # Compile TypeScript to dist/
npm run dev      # Run in development mode with tsx (hot reload)
npm start        # Run compiled server from dist/
npm run clean    # Remove dist/ directory
```

### Setup Requirements
1. Create `.env` file from `.env.example` with Unanet credentials:
   - `UNANET_USERNAME`, `UNANET_PASSWORD`, `UNANET_BASE_URL` (defaults to the Nava tenant)
   - No API key or firm code. Auth is per-user Platform REST login (`POST /platform/rest/login` → short-lived bearer token). The server inherits exactly the caller's Unanet permissions.
2. Run `npm install` to install dependencies
3. Node.js >= 20.0.0 required (ES modules; matches `engines` in `package.json`)

## Architecture Overview

This is an MCP (Model Context Protocol) server that bridges Claude Desktop with Unanet GovCon ERP. The architecture follows a tool-based pattern where each Unanet operation is exposed as an MCP tool.

### Core Components

**MCP Server (`src/index.ts`)**
- Implements stdio transport (communicates via stdin/stdout with Claude Desktop)
- Registers all tools and resources with the MCP SDK
- Validates authentication on startup
- Routes tool calls to appropriate handlers

**Authentication (`src/auth.ts`)**
- Logs in with username/password via `POST /platform/rest/login`, caches the bearer token per (baseUrl, username, appName), and creates Axios clients that send `Authorization: Bearer <token>` plus `X-Una-App`
- Implements request/response interceptors for logging and error handling
- Maps HTTP errors to user-friendly messages

**Tools Pattern**
Each tool follows this structure:
```typescript
export const toolName = {
  name: "unanet_operation_name",
  description: "What it does",
  inputSchema: z.object({ /* Zod validation */ }),
  handler: async (args, auth) => {
    // 1. Create authenticated client
    // 2. Make API call(s)
    // 3. Return success/error object
  }
}
```

**Tool Categories** (94 tools at most, registered in three tiers in `src/index.ts`)
- `tools/leave.ts`, `tools/leave-requests.ts`: leave balances; leave request list/history/create/update/submit/cancel/delete
- `tools/expenses.ts`, `tools/expense-lifecycle.ts`: expense report reads, draft/line/receipt writes, update/delete, history, meal caps, imported card transactions, gated submit
- `tools/timesheet.ts`, `tools/timesheet-lifecycle.ts`: timeslip add/edit/delete/submit; time periods, list, history, adjustments, attachments, create/delete timesheet
- `tools/approvals.ts`, `tools/reviews.ts`: approval/review queues addressed to the user (type × role matrix) and approve/disapprove/complete actions
- `tools/user.ts`: My Projects list, rates, alternates, personal attachments
- `tools/project-assignments.ts`: `unanet_assign_people_to_project` (write tier): org-level staffing write with a 50-person cap, paged exact email lookup with validated identity/activity, overlap check at preflight, validated Unanet defaults (no `OVERRIDE` rates), dry run, silent by default, per-email failure outcomes, and a halt on a login, 401/403/429 error or an unknown outcome
- `tools/projects.ts`, `tools/directory.ts`: org-level reads — projects/tasks/assignments/notes/admins, people, organizations, contracts, invoices, reference lookups, ping
- `tools/contacts.ts`, `tools/financials.ts`: legacy CRM/billing tools (some are fail-closed stubs)
- `tools/api.ts`: spec-driven catalog (`unanet_api_search_operations`, `unanet_api_describe_operation`) and a read-only executor (`unanet_api_read`) backed by `spec/api-catalog.json`. There is no generic writer: writes need a dedicated tool. Operations that can return credentials, tokens, bank, payroll or configuration data are classified `sensitive` and refused.

**Tiers / flags**
- Default: self-service `/me/…` reads only.
- `UNANET_ENABLE_EXTENDED_READ_TOOLS=true`: org-level reads + API catalog/read-only reader + MCP resources. (The old `UNANET_ENABLE_LEGACY_READ_TOOLS` no longer does anything; the server warns if it is set.)
- `UNANET_ENABLE_WRITE_TOOLS=true`: every write. All live writes take `confirm: true` (enforced by `z.literal(true)` and re-checked in the handler via `requireConfirm`); the 4 legacy stubs always fail. Timesheet and expense submits validate first and hold on warnings; leave submit only checks the draft status. The leave, timesheet-lifecycle, expense-lifecycle, user, approvals and reviews write handlers report `outcome: "unknown"` (via `writeErrorResult`) when a mutating request got no response or a 5xx; `unanet_create_timesheet` uses `created: "unknown"`, and the older expense tools return a plain error. Callers check Unanet before retrying.

**Shared helpers**
- `src/utils/http.ts`: `itemsFromResponse`, `pageInfo`, `compact`, `isoDateSchema`, `pageSchema`/`pageSizeSchema`, `confirmSchema`/`requireConfirm`, `keyName`, `errorResult`.
- `src/utils/attachments.ts`: base64 attachment upload input (`attachmentInputFields`, `loadAttachmentInput`) and download (`saveAttachmentToDisk`). Local paths go through `checkLocalAttachmentPath`: no hidden files or folders (`.ssh`, `.aws`, `.env`), document/receipt extensions only, symlinks resolved.

**Resources (`src/resources/`)**
Resources provide read-only data endpoints:
- `projectListResource`: Active projects list
- `timesheetTemplatesResource`: Common timesheet entries

### Key Patterns

1. **Error Handling**: All tools return `{ success: boolean, error?: string, ...data }` objects
2. **Type Safety**: Full TypeScript types in `src/types/unanet.ts` for all API entities
3. **Validation**: Zod schemas validate all tool inputs before execution
4. **Async Handlers**: All tool handlers are async and auth is passed as second parameter

### Windows Setup Automation

The `setup-windows.bat` script:
1. Checks for Node.js installation
2. Runs `npm install` and `npm run build`
3. Creates `.env` from template
4. Optionally configures Claude Desktop's `claude_desktop_config.json` using PowerShell

### Testing Tools

To test a specific tool during development:
```bash
# Run the server in dev mode
npm run dev

# In Claude Desktop, test with:
# "Show me all active projects" (tests unanet_get_projects)
# "Get details for project ABC123" (tests unanet_get_project_details)
```

### Adding New Tools

1. Look the endpoint up first: `node scripts/build-api-catalog.mjs` keeps `spec/api-catalog.json` current; `unanet_api_describe_operation` (or `spec/api-schemas.json`) shows the request/response schema.
2. Add the tool definition to the appropriate file in `src/tools/` using the shared helpers in `src/utils/`.
3. Import it in `src/index.ts` and add it to the right tier array (`selfServiceReadTools`, `extendedReadTools`, or `mutatingTools`). Startup throws on duplicate tool names.
4. Keep the input schema a single `z.object` (use `.refine`/`.superRefine` for cross-field rules) so the JSON Schema root stays `type: "object"` — Claude Desktop rejects top-level `allOf`.
5. Add mock routes (`src/mock-routes-extended.ts`) and a test in `test/extended.test.js`; run `npm test` and `npm run lint`.
### Spec & catalog scripts

- `npm run fetch-spec` — refresh `spec/unanet-openapi.json` from the Unanet dev portal.
- `npm run build-catalog` — regenerate `spec/api-catalog.json` (operations + read/write/sensitive classification) and `spec/api-schemas.json`. Re-run after fetching a new spec.
- `npm run spec-drift-check` — monthly live-vs-committed spec drift check (report-only).
- `npm run smoke:readonly` — live read-only smoke test using `.env` credentials (`test/smoke-readonly.mjs`; read handlers only, no writes; never pass `--verbose` in a shared transcript — it dumps personal data).

### Important Notes

- Server runs as stdio transport (not HTTP) - it communicates through standard input/output
- All console.error() calls are for logging (stdout is reserved for MCP protocol)
- Environment variables can also be passed via Claude Desktop config instead of .env file
- The server validates auth on startup and exits if credentials are missing