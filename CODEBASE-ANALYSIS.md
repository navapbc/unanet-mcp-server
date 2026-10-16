# Unanet MCP Server - Codebase Analysis

## Overview
This is a Model Context Protocol (MCP) server that provides integration with the Unanet GovCon ERP system. It enables Claude Desktop to interact with Unanet through natural language, managing projects, timesheets, contacts, and financial operations.

## 1. Build and Development Commands

### Key Scripts (from package.json):
- **`npm run build`** - Compiles TypeScript to JavaScript in the `dist/` directory
- **`npm run dev`** - Runs the TypeScript source directly using `tsx` for development
- **`npm start`** - Runs the compiled JavaScript from `dist/`
- **`npm run clean`** - Removes the `dist/` directory
- **`npm run prepublishOnly`** - Automatically runs build before publishing

### Requirements:
- Node.js >= 20.0.0
- TypeScript 5.3.0
- ES Modules (type: "module" in package.json)

## 2. Architecture Overview

### Core Components:

#### Entry Point (`src/index.ts`)
- Implements MCP server using `@modelcontextprotocol/sdk`
- Uses StdioServerTransport for communication with Claude Desktop
- Handles tool and resource requests
- Validates authentication on startup
- Registers all tools and resources

#### Authentication (`src/auth.ts`)
- Manages Unanet API credentials
- Creates authenticated Axios clients
- Implements request/response interceptors for logging and error handling
- Requires environment variables:
  - `UNANET_USERNAME`
  - `UNANET_PASSWORD`
  - `UNANET_BASE_URL` (defaults to `https://navapbc.unanet.biz`)

#### Tools (`src/tools/`)
Organized by functional area:
- **projects.ts** - Project management operations
- **timesheet.ts** - Time and expense tracking
- **contacts.ts** - Contact and CRM operations
- **financials.ts** - Billing and financial reporting

#### Resources (`src/resources/`)
- **reports.ts** - Provides read-only data resources like active projects and timesheet templates

#### Types (`src/types/`)
- **unanet.ts** - TypeScript interfaces for all Unanet data structures

### Component Interaction Flow:
1. Claude Desktop connects to the MCP server via stdio
2. Server validates authentication credentials from environment
3. Claude requests available tools/resources
4. When Claude calls a tool:
   - Server validates input using Zod schemas
   - Creates authenticated HTTP client
   - Makes API calls to Unanet
   - Returns formatted response
5. Resources provide cached/aggregated data without requiring tool calls

## 3. Configuration Requirements

### Environment Variables (required):
```bash
UNANET_USERNAME=your_username
UNANET_PASSWORD=your_password
UNANET_BASE_URL=https://navapbc.unanet.biz  # origin only
```

### TypeScript Configuration:
- Target: ES2022
- Module: NodeNext (for ES modules support)
- Strict mode enabled
- Source maps and declarations generated
- Compiles from `src/` to `dist/`

### MCP Server Configuration:
- Communicates via stdio (standard input/output)
- Implements MCP protocol for tools and resources
- JSON-based request/response format

## 4. Code Patterns and Conventions

### Tool Pattern:
```typescript
export const toolNameTool = {
  name: "unanet_tool_name",
  description: "What the tool does",
  inputSchema: z.object({
    // Zod schema for validation
  }),
  handler: async (args: any, auth: UnanetAuth) => {
    const client = createUnanetClient(auth);
    try {
      // API call logic
      return { success: true, data: result };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },
};
```

### Resource Pattern:
```typescript
export const resourceName = {
  uri: "unanet://resource/path",
  name: "Resource Name",
  description: "What the resource provides",
  mimeType: "application/json",
  handler: async (auth: UnanetAuth) => {
    // Fetch and format data
    return formattedData;
  },
};
```

### Error Handling:
- HTTP errors are intercepted and transformed into user-friendly messages
- Authentication errors (401) provide specific guidance
- Rate limiting (429) is handled gracefully
- All tools return success/error status in response

### Logging:
- Uses console.error for server-side logging (doesn't interfere with stdio)
- Logs all API requests with method and URL
- Logs authentication validation status on startup

### Code Style:
- ES modules with .js extensions in imports
- Async/await for all asynchronous operations
- TypeScript strict mode for type safety
- Descriptive variable and function names
- Consistent error handling pattern

## 5. Key Dependencies

### Core:
- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `axios` - HTTP client for Unanet API
- `zod` - Runtime type validation
- `dotenv` - Environment variable management

### Development:
- `typescript` - Type safety and compilation
- `tsx` - Direct TypeScript execution for development
- `@types/node` - Node.js type definitions

## 6. Deployment Notes

The server is designed to be:
- Run locally alongside Claude Desktop
- Configured via environment variables
- Extensible with new tools and resources
- Type-safe with full TypeScript coverage
- Self-documenting through tool descriptions and schemas

## 7. Security Considerations

- Credentials stored in environment variables / local `.env`
- Per-user login via `POST /platform/rest/login`; short-lived bearer token cached in memory per (baseUrl, username, appName)
- No shared service account; the server inherits the caller's Unanet permissions
- 30-second timeout on all requests