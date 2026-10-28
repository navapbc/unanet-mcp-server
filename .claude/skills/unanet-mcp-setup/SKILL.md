---
name: unanet-mcp-setup
description: Walk a Nava employee through installing and verifying the Unanet MCP connector (navapbc/unanet-mcp-server) so Claude Code or Claude Desktop can read their own Unanet timesheets, expenses, and leave balances. Use this whenever someone wants to "set up", "install", "connect", "get access to", or "start using" Unanet in Claude, asks how Billy's Unanet tool works, asks for "Unanet API access" or "REST API access" for Claude, hits a Unanet 401/403 or "tools not showing up" after an install attempt, sees only an unanet_setup_status tool, or wants to onboard a teammate. Trigger even if they don't say "MCP" — most people will say "the Unanet thing" or "Claude for Unanet".
---

# Unanet MCP Setup

You are onboarding one person onto the Unanet MCP connector. The connector is a small Node server that their Claude app (Claude Code or Claude Desktop) starts locally. It logs into Unanet **as the user, with the user's own username and password**, and can only do what that person can already do in the Unanet website.

That sentence is the most important thing in this skill. People arrive believing they need an API key, a firm code, a service account, "REST API access," or a grant from Finance/IT/Data. None of that exists for this connector. If the user mentions any of it, correct it plainly and early, because chasing a nonexistent permission has already cost a week of Slack threads. The right sentence is: *"There's nothing to grant. It uses your normal Unanet login and inherits exactly your permissions."*

**Never use a web browser for Unanet.** Do not open the Unanet website to install, test, look up data, or "check" anything. The connector's `unanet_*` tools are the only route. If they are missing, the connector is not connected yet, and the fix is in this skill, not in a browser. Assistants that browsed instead left users thinking the connector worked when it was not even running.

## Before you start: which mode are you in?

Setup means running commands on the user's own computer. Figure out what you can actually reach, then say which mode you're in so the user knows what to expect.

**Mode A — you have a shell on their machine** (Claude Code, or any harness where `node --version` runs on the Mac/PC they're sitting at). You do the mechanical work: check prerequisites, clone, build, register the connector, run the check. The user handles only the credential step.

**Mode B — you don't** (Claude Desktop chat, Cowork's sandboxed Linux shell, claude.ai). Cowork's shell is a separate Linux VM; it cannot install Node on their Mac or write their Claude config, so don't try. Give one step at a time, wait for them to paste the output back, and read it before moving on. Don't dump all steps at once — the person following this is often not an engineer, and a wall of commands is where they give up.

Also ask which Claude app they want the tools in: Claude Code, Claude Desktop, or both. The registration step differs.

In both modes the user runs the credential step themselves, because the password must never pass through this chat.

## The path

### 1. Prerequisites

Check, in order, and stop at the first hard blocker:

| Need | How to check | If missing |
|---|---|---|
| macOS or Windows 10/11 | ask | Linux users: follow the README by hand; the scripts are Mac/Windows only |
| Claude Code and/or Claude Desktop | `claude --version`, or ask | https://claude.ai/download (Desktop); Claude Code from Anthropic's docs |
| Node.js **20+** | `node --version` | https://nodejs.org (LTS installer) |
| git | `git --version` | Mac: `xcode-select --install`; or download the repo ZIP from GitHub instead |
| Access to the `navapbc` GitHub org | can they open https://github.com/navapbc/unanet-mcp-server | Not something you can fix. Tell them to ask Billy Hunt; stop here |
| Their Unanet login works | ask: can they sign in to Unanet themselves | Unanet/Finance problem, not yours |

Say explicitly what they do *not* need: an API key, a firm code, a service account, or anyone's approval.

### 2. Get the code

```bash
cd ~
git clone https://github.com/navapbc/unanet-mcp-server.git
cd unanet-mcp-server
```

Anywhere under their home directory is fine. The client configuration records the absolute path, so the folder shouldn't move later. If they downloaded a ZIP, unzip it and `cd` into it.

### 3. Run the installer (the user does this, in their own terminal)

**macOS:** `./setup-mac.sh`. Tell them what it will ask so nothing surprises them:

1. **Unanet base URL** — press Enter to accept `https://navapbc.unanet.biz`. The script checks the address and asks again if it would be refused (a path such as `/platform/rest`, http instead of https, or another host). A wrong base URL is the most common install failure.
2. **Username** — their Unanet username.
3. **Password** — typed blind (no characters appear). This goes into `.env` in the repo folder, git-ignored, created with permissions 600. If `.env` already exists the script leaves it unchanged and skips these prompts. It is plaintext on disk; tell them so.
4. **"Enable org-level read tools?"** — default N. Read-only and limited by their permissions, but they expose other people's and the company's records to the model; Y only for invoicing, project or resourcing work.
5. **"Enable write-capable tools?"** — default N. Say N unless they need Claude to create, edit and submit timesheets or expenses and understand it can change a live government-contract ERP, including one-way submissions.
6. **"Add the connector to Claude Code?"** — asked only when the `claude` command exists; default Y. It runs `claude mcp add --scope user unanet -- <node> <repo>/dist/index.js`.

The script also adds a `unanet` entry to Claude Desktop's config when Claude Desktop is installed, and finishes with `npm run check-setup`, which signs in once and prints `READY` or `NOT READY` with the reason. Neither client config ever contains the password.

**Windows:** double-click `setup-windows.bat` and follow `README-WINDOWS.md`. It builds, copies `.env.example` to `.env`, and opens Notepad for the username and password (leave `UNANET_BASE_URL` as `https://navapbc.unanet.biz`). It configures Claude Desktop; for Claude Code the user runs the `claude mcp add` command the script prints. `.env` gets default file permissions; tell them to treat it like their password. If the password contains `#`, or starts or ends with a space, it must be wrapped in single quotes in `.env` (backticks if it also contains a single quote), or the value is cut off.

In Mode A you may run `npm install && npm run build` yourself first so the script's build step is quick, but hand the script itself to the user for the credential prompts. Never write a password into `.env` on their behalf, and if they paste one into chat, tell them to change it.

### 4. Check, connect, verify

1. `npm run check-setup` in the repo folder must print `READY: signed in to https://navapbc.unanet.biz as <user>`. On `NOT READY`, follow its guidance: the user edits `.env` for configuration or credential errors, asks Finance about permission or license denials, or checks connectivity for network failures. Do not edit credentials for every failure. Don't move on until it says READY.
2. **Claude Code:** `claude mcp list` shows `unanet`; if not, run `claude mcp add --scope user unanet -- node "$PWD/dist/index.js"` from the repo folder. The user starts a **new** session; `/mcp` lists `unanet` as connected. **Claude Desktop:** fully quit (Cmd+Q on Mac; tray icon → Quit on Windows) and reopen; the MCP process only starts on launch.
3. Ask: *"What are my Unanet leave balances?"* Claude should call `unanet_get_my_leave_balances`. The user compares the numbers with Unanet themselves. Matching numbers are the test; "the tool responded" is not.

If Claude reaches for a browser at this point, stop it: the tools are not connected. Go back to step 2.

### 5. Say what they've got

Close with a short summary, every time:

- What's installed and where (the repo path), and which Claude app(s) it is registered with.
- Where the credentials live (`<repo>/.env`, local only, plaintext; mode 600 when the macOS script created it) and that client configs only hold the launch command.
- What the connector can do right now: 33 self-service read tools: their own leave balances and requests, expense reports (lines, history, receipts), timesheets, approval and review queues addressed to them, My Projects, rates and alternates. Org-level reads only if they enabled them. Writes are off unless they enabled them.
- How to turn it off: `claude mcp remove --scope user unanet` (Claude Code) or remove the `unanet` block from `claude_desktop_config.json` and restart (Claude Desktop); delete the folder to remove the credentials.
- Who to ask: Billy Hunt for connector problems, Finance (Sharma Scatliffe) for Unanet permission problems.

## Triage

Read the actual error before guessing. Start with `npm run check-setup`; it names the problem. These cover nearly everything:

| Symptom | Meaning | Fix |
|---|---|---|
| Claude opens the Unanet website in a browser | the `unanet_*` tools are not available in that session | Never accept that as a workaround. Check registration (`claude mcp list`, `/mcp`, or Claude Desktop's config), run `npm run check-setup`, start a new session |
| Only a tool called `unanet_setup_status` is listed | the connector runs but `.env` is incomplete or invalid | call `unanet_setup_status`; it returns the problem, the `.env` path and the fix. The user edits `.env`, then restart the client |
| No `unanet` server in `claude mcp list` / `/mcp` | never registered with Claude Code | `claude mcp add --scope user unanet -- node "<repo>/dist/index.js"`, then a new session |
| Unanet tools don't appear in Claude Desktop | Claude Desktop didn't launch the server | fully quit and reopen; valid JSON in `claude_desktop_config.json` (a trailing comma breaks it); `dist/index.js` exists (`npm run build`); Settings → Developer → MCP logs |
| `UNANET_BASE_URL must be an origin only` / `host is not allowed` / `must use HTTPS` | wrong address in `.env` | set `UNANET_BASE_URL=https://navapbc.unanet.biz` exactly |
| **401** / "Authentication failed" | wrong username or password | sign in to the Unanet website with the same credentials; check `.env` for typos and the `#` quoting rule |
| **403** | login worked; their Unanet account lacks that permission | not a connector problem. Note what they tried and ask Finance whether they should have it. Don't work around it |
| Own data works but project, people or contract questions return "not found" | org-level read tools disabled | set `UNANET_ENABLE_EXTENDED_READ_TOOLS=true` in `.env`, restart the client |
| Windows "Access Denied" during setup | permissions / corporate policy | do **not** disable antivirus; stop and get IT or Billy |
| `node: command not found` after installing Node | terminal opened before install | close and reopen the terminal |

If none of these fit, get the `npm run check-setup` output, the client's MCP log line, and `node --version`, and hand them to Billy.

## Things not to do

- Don't open the Unanet website in a browser, for any reason, as part of setup or use.
- Don't suggest, request, or configure the `Workday.Integration` account or any shared service credential. Each person uses their own login; that's the security model, not a limitation.
- Don't accept the user's password in chat, and don't write it to a file for them.
- Don't enable write tools "to be safe" or "just in case." Off is the safe state.
- Don't route Unanet permission questions to the Data team or IT. 403s are Finance.

## Reference

- Repo: https://github.com/navapbc/unanet-mcp-server — `README.md` (Install, environment variables, troubleshooting), `README-WINDOWS.md`, `SECURITY.md`.
- Auth: `POST /platform/rest/login` with username/password → short-lived bearer token, cached in memory. No API key.
- `.env` is read from the repo folder (next to `dist/`), whatever folder the client starts the server in; `UNANET_ENV_FILE` points elsewhere; values in the client's environment win.
- Default tools: 33 read-only self-service tools. `UNANET_ENABLE_EXTENDED_READ_TOOLS=true` adds 22 org-level reads and the API catalog reader (`unanet_api_read` refuses anything classified sensitive: credentials, tokens, bank, payroll, configuration). `UNANET_ENABLE_WRITE_TOOLS=true` adds 39 tools: 35 live writes, each requiring `confirm: true`, and 4 legacy stubs that always return `success: false` and change nothing. Writes include submitting timesheets, expense reports and leave requests, approving or disapproving other people's items, and assigning people to a project, all on the live ERP, so tell the user to review in Unanet before anything is submitted. There is no generic API writer.
