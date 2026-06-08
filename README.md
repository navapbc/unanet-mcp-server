# Unanet GovCon ERP MCP Server

**Transform your 30-minute Unanet reports into 30-second conversations with AI**

## 🎯 For GovCon Leaders Who Are Tired Of:
- Clicking through 10 screens to answer one question
- Waiting 20 minutes for reports that should take 20 seconds
- Training new employees on complex ERP navigation
- Missing critical project updates buried in data

## 🚀 What if you could just ask: "Give me an executive briefing on all projects"?

![Executive Daily Briefing Example](assets/screenshots/executive-daily-briefing.png)

### ⏱️ Save 2-4 hours per week on ERP tasks:
- **Project Managers:** Instant status updates, resource allocation checks, budget tracking
- **Executives:** Daily briefings in seconds, not spreadsheets
- **Finance Teams:** Real-time billing status, instant invoice generation
- **Everyone:** No more clicking through 10 screens to find one answer

## 💡 See It In Action

### From Complex Navigation to Simple Questions

**Before:** Log in → Projects → Select Project → Export → Format in Excel → Write Summary (15-30 min)

**After:** "What's the status of all active projects?" (30 seconds)

![Executive Status Query](assets/screenshots/executive-status-query.png)


## 🎯 Quick Start

**For Windows Users:** Download → Run `setup-windows.bat` → Done! [Detailed Guide](README-WINDOWS.md)

**For Technical Users:** See [Installation](#installation) below

## 🎯 What You Can Do

Ask Claude natural questions about your Unanet data. By default, this server starts in the safe read-only Nava leave-balance mode:

✅ **"Show my Unanet leave balances"**
✅ **"Check my PTO balance for the last two weeks"**

Legacy project, financial, and write examples require explicit opt-in flags and additional safeguards before live use. Do not enable mutating tools against company Unanet until preview/confirmation controls are implemented.

No more memorizing menu paths or waiting for reports to load!

## 💰 ROI & Time Savings

Based on real GovCon operations:
- **Project Managers:** Save 2-4 hours per week
- **Executives:** Save 1-2 hours daily on status updates
- **Finance Teams:** Cut monthly billing reconciliation time by 75%
- **Everyone:** Get answers in seconds, not minutes

### Real Example: Executive Daily Briefing

**Traditional Method:** Run reports → Export data → Analyze → Format (20+ minutes)
**With Claude:** "Give me an exec daily briefing" (30 seconds)

```
Executive Daily Briefing - Unanet Projects

• Portfolio Health: 2 active projects ($350K total budget) tracking on schedule
• Project Alpha: 50% complete with proportional budget burn - entering critical phase
• Project Beta: Early stage execution at 25% complete, healthy trajectory
• Resource Status: Team allocation stable, no conflicts identified
• Risk Assessment: All projects green status

Recommended Action: Schedule mid-project review for Alpha this week
```

![Billing Status Integration](assets/screenshots/billing-status-check.png)

📸 **[See More Power User Examples](docs/POWER-USER-SCREENSHOTS.md)**

## Features

### Tools Available

#### Project Management
- `unanet_get_projects` - List all projects with filtering options (legacy read tool; requires `UNANET_ENABLE_LEGACY_READ_TOOLS=true`)
- `unanet_get_project_details` - Get detailed information about a specific project (legacy read tool; requires `UNANET_ENABLE_LEGACY_READ_TOOLS=true`)
- `unanet_update_project_budget` - Update project budget (requires `UNANET_ENABLE_WRITE_TOOLS=true`)
- `unanet_get_project_status` - Get project status and dashboard metrics (legacy read tool; requires `UNANET_ENABLE_LEGACY_READ_TOOLS=true`)

#### Personal Leave Balances
- `unanet_get_my_leave_balances` - Read your Nava Unanet leave balances using Platform REST bearer-token auth. Registered by default in safe read-only mode.

#### Time & Expense Tracking
- `unanet_submit_timesheet` - Submit time entries (requires `UNANET_ENABLE_WRITE_TOOLS=true`)
- `unanet_get_timesheets` - Retrieve timesheets for a date range (legacy read tool; requires `UNANET_ENABLE_LEGACY_READ_TOOLS=true`)
- `unanet_submit_expense` - Submit expense reports (requires `UNANET_ENABLE_WRITE_TOOLS=true`)
- `unanet_approve_timesheet` - Approve submitted timesheets (requires `UNANET_ENABLE_WRITE_TOOLS=true`)

#### Contact Management
- `unanet_create_contact` - Create new contacts (requires `UNANET_ENABLE_WRITE_TOOLS=true`)
- `unanet_update_lead` - Update lead information (requires `UNANET_ENABLE_WRITE_TOOLS=true`)
- `unanet_create_opportunity` - Create new opportunities (requires `UNANET_ENABLE_WRITE_TOOLS=true`)
- `unanet_get_company_info` - Get company details (legacy read tool; requires `UNANET_ENABLE_LEGACY_READ_TOOLS=true`)

#### Financial Operations
- `unanet_get_billing_status` - Get project billing information (legacy read tool; requires `UNANET_ENABLE_LEGACY_READ_TOOLS=true`)
- `unanet_generate_invoice` - Generate project invoices (requires `UNANET_ENABLE_WRITE_TOOLS=true`)
- `unanet_get_financial_report` - Generate various financial reports (legacy read tool; requires `UNANET_ENABLE_LEGACY_READ_TOOLS=true`)

### Resources Available

Legacy resources are not registered in the default safe read-only mode. They require `UNANET_ENABLE_LEGACY_READ_TOOLS=true` plus legacy API credentials.

- `unanet://projects/active` - List of active projects (legacy gated)
- `unanet://timesheets/templates` - Timesheet templates and common entries (legacy gated)

## Installation

### 🪟 Windows Users (Recommended)

1. **Download the project**:
   - Download from GitHub as a ZIP file
   - Extract to `C:\UnanetMCP\`

2. **Run the automated setup**:
   - Double-click `setup-windows.bat`
   - Follow the prompts

That's it! See [Windows Setup Guide](README-WINDOWS.md) for detailed instructions.

### 🐧 Mac/Linux Users

1. Clone this repository:
```bash
git clone https://github.com/navapbc/unanet-mcp-server.git
cd unanet-mcp-server
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
npm run build
```

4. Set up your environment variables:
```bash
cp .env.example .env
# Edit .env with your Unanet credentials
```

## Configuration

### Environment Variables

Create a `.env` file with your Unanet credentials. For Nava local read-only use, start with the security-first Platform REST mode:

```env
UNANET_USERNAME=your-username
UNANET_PASSWORD=your-password
UNANET_BASE_URL=https://navapbc.unanet.biz
# Optional; defaults to NavaUnanetMCP
UNANET_APP_NAME=NavaUnanetMCP
```

Safe defaults:
- `UNANET_BASE_URL` is tenant-locked to `https://navapbc.unanet.biz` unless additional exact origins are configured with `UNANET_ALLOWED_BASE_URLS`.
- `http://127.0.0.1` / `http://localhost` are accepted only when `UNANET_ALLOW_INSECURE_LOCAL_MOCK=true` for local mock testing.
- Mutating tools are not registered unless `UNANET_ENABLE_WRITE_TOOLS=true`.
- Legacy read tools that use the older API key/firm-code client are not registered unless `UNANET_ENABLE_LEGACY_READ_TOOLS=true`.

Legacy tools require the additional credentials below and should not be enabled for the first Nava leave-balance slice:

```env
UNANET_API_KEY=your-api-key
UNANET_FIRM_CODE=your-firm-code
```

### Claude Desktop Configuration

Add the following to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "unanet": {
      "command": "node",
      "args": ["/absolute/path/to/unanet-mcp-server/dist/index.js"],
      "env": {
        "UNANET_USERNAME": "your-username",
        "UNANET_PASSWORD": "your-password",
        "UNANET_BASE_URL": "https://navapbc.unanet.biz",
        "UNANET_APP_NAME": "NavaUnanetMCP"
      }
    }
  }
}
```

## Usage Examples

Once configured, you can interact with Unanet through Claude:

### Default Safe Read-Only Mode
```
"Show my Unanet leave balances"
"Check my PTO balance for the last two weeks"
```

### Legacy Read Tools (explicit opt-in)

The following examples require `UNANET_ENABLE_LEGACY_READ_TOOLS=true` and legacy API credentials. Confirm the API contract and data-owner approval before using them with company data.

```
"Show me all active projects"
"Get details for project ABC123"
"What's the status of the government contract project?"
"Show my timesheets for last week"
"Generate a project profitability report for Q4"
"Show billing status for project DEF456"
```

### Mutating Tools (unsafe legacy opt-in)

These examples require `UNANET_ENABLE_WRITE_TOOLS=true`. Write mode is intentionally disabled by default and should not be used against live Nava Unanet until preview/confirmation safeguards and per-tool allowlists are implemented.

```
"Update the budget for project XYZ to $150,000"
"Submit 8 hours for project ABC123 for today"
"Approve timesheet TS-2024-001"
"Create an invoice for the last billing period"
"Create a new contact: John Smith from ABC Corp"
"Update the lead status to 'Proposal' with 75% probability"
"Create a new opportunity worth $500k closing next month"
```


## Development

### Running in Development Mode
```bash
npm run dev
```

### Project Structure
```
src/
├── index.ts           # Main server entry point
├── auth.ts            # Authentication handling
├── tools/             # MCP tool implementations
│   ├── projects.ts    # Project management tools
│   ├── timesheet.ts   # Time/expense tools
│   ├── contacts.ts    # Contact management
│   └── financials.ts  # Financial tools
├── resources/         # MCP resource providers
│   └── reports.ts     # Report resources
└── types/             # TypeScript type definitions
    └── unanet.ts      # Unanet API types
```

### Adding New Tools

1. Create a new tool in the appropriate file under `src/tools/`
2. Export the tool definition with:
   - `name`: Unique tool identifier
   - `description`: Clear description of what the tool does
   - `inputSchema`: Zod schema for input validation
   - `handler`: Async function that executes the tool
3. Import and add the tool to the `tools` array in `src/index.ts`

## Security Considerations

- Never commit your `.env` file
- Use environment variables for all sensitive data
- The server defaults to read-only Nava leave-balance access
- Production `UNANET_BASE_URL` values must use HTTPS and match the approved tenant allowlist
- Local insecure mock URLs require `UNANET_ALLOW_INSECURE_LOCAL_MOCK=true`
- Mutating tools require explicit `UNANET_ENABLE_WRITE_TOOLS=true`; write mode is legacy/unsafe until preview-confirmation safeguards are added
- Legacy read tools and resources require explicit `UNANET_ENABLE_LEGACY_READ_TOOLS=true`
- The Nava leave-balance tool uses Platform REST bearer-token auth with in-memory token caching only
- Development and tests require Node.js 20+ because the secure Vitest 4 toolchain requires Node 20 or newer

## Troubleshooting

### Authentication Errors
- Verify your credentials in the `.env` file
- Ensure your API key has the necessary permissions
- Check that your firm code is correct

### Connection Issues
- Verify the `UNANET_BASE_URL` is correct
- Check network connectivity
- Ensure the Unanet API is accessible from your network

### Claude Desktop Integration
- Restart Claude Desktop after configuration changes
- Check the logs for any MCP connection errors
- Verify the absolute path to the server is correct

## Support

For issues or questions:
1. Check the Unanet API documentation
2. Review the MCP documentation at https://modelcontextprotocol.io
3. Open an issue in this repository

## 🎯 Getting Started Today

**Option 1: Quick Setup (Windows)**
1. Download this repository
2. Run `setup-windows.bat`
3. Start asking Claude about your Unanet data!

**Option 2: Manual Setup**
See [Installation](#installation) for Mac/Linux or advanced setup

## 💬 Join the Conversation

Are you using AI to transform your GovCon operations? Let's connect!

- 🌟 Star this repo if you find it useful
- 🔄 Share your Unanet automation success stories
- 💡 Suggest features or improvements via Issues

## About GSD at Work LLC

We help GovCon CEOs integrate AI into their core business operations and accelerate growth. From DoD contractors to civilian agencies, we're transforming how government contractors work.

**What We Do:**
- AI Strategy & Implementation for GovCons
- ERP Integration & Automation
- Custom AI Solutions for Compliance & Operations

**Let's Talk:** christian@gsdat.work | [gsdat.work](https://gsdat.work)

---

*Because your time should be spent winning contracts, not wrestling with ERPs.*

## License

MIT License - Copyright (c) 2025 GSD at Work LLC - See LICENSE file for details