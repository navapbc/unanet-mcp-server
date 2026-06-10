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
   - `UNANET_USERNAME`, `UNANET_PASSWORD`, `UNANET_API_KEY`, `UNANET_FIRM_CODE`, `UNANET_BASE_URL`
2. Run `npm install` to install dependencies
3. Node.js >= 18.0.0 required (ES modules)

## Architecture Overview

This is an MCP (Model Context Protocol) server that bridges Claude Desktop with Unanet GovCon ERP. The architecture follows a tool-based pattern where each Unanet operation is exposed as an MCP tool.

### Core Components

**MCP Server (`src/index.ts`)**
- Implements stdio transport (communicates via stdin/stdout with Claude Desktop)
- Registers all tools and resources with the MCP SDK
- Validates authentication on startup
- Routes tool calls to appropriate handlers

**Authentication (`src/auth.ts`)**
- Creates authenticated Axios clients with Basic Auth + API Key headers
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

**Tool Categories**
- `tools/projects.ts`: Project management operations
- `tools/timesheet.ts`: Time and expense tracking
- `tools/contacts.ts`: CRM operations (contacts, leads, opportunities)
- `tools/financials.ts`: Billing, invoicing, and financial reports

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

1. Add tool definition to appropriate file in `src/tools/`
2. Import and add to `tools` array in `src/index.ts`
3. Follow existing patterns for error handling and response format
4. Update TypeScript types in `src/types/unanet.ts` if needed

### Important Notes

- Server runs as stdio transport (not HTTP) - it communicates through standard input/output
- All console.error() calls are for logging (stdout is reserved for MCP protocol)
- Environment variables can also be passed via Claude Desktop config instead of .env file
- The server validates auth on startup and exits if credentials are missing