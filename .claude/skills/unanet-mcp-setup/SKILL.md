---
name: unanet-mcp-setup
description: Walk a Nava employee through installing and verifying the Unanet MCP connector (navapbc/unanet-mcp-server) so Claude Desktop can read their own Unanet timesheets, expenses, and leave balances. Use this whenever someone wants to "set up", "install", "connect", "get access to", or "start using" Unanet in Claude, asks how Billy's Unanet tool works, asks for "Unanet API access" or "REST API access" for Claude, hits a Unanet 401/403 or "tools not showing up" after an install attempt, or wants to onboard a teammate. Trigger even if they don't say "MCP" — most people will say "the Unanet thing" or "Claude for Unanet".
---

# Unanet MCP Setup

You are onboarding one person onto the Unanet MCP connector. The connector is a small Node server that Claude Desktop launches locally. It logs into Unanet **as the user, with the user's own username and password**, and can only do what that person can already do in the Unanet website.

That sentence is the most important thing in this skill. People arrive believing they need an API key, a firm code, a service account, "REST API access," or a grant from Finance/IT/Data. None of that exists for this connector. If the user mentions any of it, correct it plainly and early, because chasing a nonexistent permission has already cost a week of Slack threads. The right sentence is: *"There's nothing to grant. It uses your normal Unanet login and inherits exactly your permissions."*

## Before you start: which mode are you in?

Setup means running commands on the user's own computer. Figure out what you can actually reach, then say which mode you're in so the user knows what to expect.

**Mode A — you have a shell on their machine** (Claude Code in a terminal, or any harness where `node --version` runs on the Mac/PC they're sitting at). You do the mechanical work: check prerequisites, clone, build, patch the Claude Desktop config, verify. The user handles only the credential step.

**Mode B — you don't** (Claude Desktop chat, Cowork's sandboxed Linux shell, claude.ai). Cowork's shell is a separate Linux VM; it cannot install Node on their Mac or write their Claude Desktop config, so don't try. Instead, give one step at a time, wait for them to paste the output back, and read it before moving on. Don't dump all steps at once — the person following this is often not an engineer, and a wall of commands is where they give up.

In both modes the user runs the credential step themselves, because the password must never pass through this chat.

## The path

### 1. Prerequisites

Check, in order, and stop at the first hard blocker:

| Need | How to check | If missing |
|---|---|---|
| macOS or Windows 10/11 | ask | Linux users: follow the README manually; the scripts are Mac/Windows only |
| Claude Desktop installed and signed in | ask | https://claude.ai/download |
| Node.js **20+** | `node --version` | https://nodejs.org (LTS installer). Node 18 will build but the README says 20; don't argue with it |
| git | `git --version` | Mac: `xcode-select --install`; or download the repo ZIP from GitHub instead |
| Access to the `navapbc` GitHub org | can they open https://github.com/navapbc/unanet-mcp-server | Not something you can fix. Tell them to ask Billy Hunt; stop here |
| Their Unanet login works | can they sign in at https://navapbc.unanet.biz in a browser | Unanet/Finance problem, not yours |

Say explicitly what they do *not* need: an API key, a firm code, a service account, or anyone's approval.

### 2. Get the code

```bash
cd ~
git clone https://github.com/navapbc/unanet-mcp-server.git
cd unanet-mcp-server
```

Anywhere under their home directory is fine; the setup script records the absolute path in the Claude config, so the folder shouldn't move later. If they downloaded a ZIP, unzip it and `cd` into it.

### 3. Run the installer (the user does this, in their own terminal)

The two installers behave differently. Describe only the one that matches their OS.

**macOS:** `./setup-mac.sh` (`./setup.sh` is a shim that runs it and refuses to run anywhere but macOS). Tell them what the script will ask so nothing surprises them:

1. **Unanet base URL** — press Enter to accept `https://navapbc.unanet.biz`.
2. **Username** — their Unanet username.
3. **Password** — typed blind (no characters appear). This goes into a `.env` file in the repo folder, permissions 600, git-ignored. It is plaintext on disk; tell them so, and tell them to treat that file like their password.
4. **"Enable extra read tools like projects and timesheets?"** — default Y. These are read-only and still limited by their Unanet permissions, so Y is fine. Someone doing invoicing or project work wants them.
5. **"Enable write-capable tools?"** — default N. Say N unless they specifically need Claude to create, edit, and submit timesheets or expenses and understand that it can change a live government-contract ERP, including submitting a timesheet for approval (one-way). They can flip it later in `.env`.

The script installs dependencies, builds, backs up `claude_desktop_config.json`, and adds a `unanet` entry that starts the server *from the repo folder* (that's why it uses `bash -lc "cd … && node dist/index.js"` — the server reads `.env` from its working directory). The Claude config never contains the password.

**Windows:** double-click `setup-windows.bat`. It asks no questions about credentials or tools. It installs dependencies, builds, copies `.env.example` to `.env`, and opens Notepad: the user fills in `UNANET_USERNAME` and `UNANET_PASSWORD`, saves, and closes. In that copied file the extra read tools and the write tools are both **off**; to turn either on they edit `.env`. The script does not restrict the file's permissions, so it is plaintext on disk; tell them to treat it like their password. If the password contains `#` or a space, it must be wrapped in single quotes in `.env` (`UNANET_PASSWORD='p#ss'`), or the value is cut off. The script then backs up and updates `claude_desktop_config.json` with a `unanet` entry that starts the server from the repo folder (`cmd.exe /c "cd /d <repo> && node dist\index.js"`). The Claude config never contains the password.

In Mode A you may run `npm install && npm run build` yourself first so the script's build step is quick, but still hand the script itself to the user for the credential prompts. Never write a password into `.env` on their behalf, and if they paste one into chat, tell them to change it.

### 4. Restart and verify

1. **Fully quit** Claude Desktop (Cmd+Q on Mac; right-click the tray icon → Quit on Windows), then reopen it. A window close isn't enough; the MCP process only starts on launch.
2. Ask Claude Desktop: *"What are my Unanet leave balances?"*
3. Have them open Unanet in a browser and compare. If the numbers match, the install is correct. Numbers that match are the test; "the tool responded" is not.

Mode A: you can also confirm the server boots by running `node dist/index.js` from the repo folder and looking for `Authentication configured successfully` on stderr (Ctrl+C to stop). It won't chat with you; it speaks MCP over stdin.

### 5. Say what they've got

Close with a short summary, every time:

- What's installed and where (the repo path).
- Where the credentials live (`<repo>/.env`, local only, plaintext, mode 600) and that the Claude config only has the launch command.
- What the connector can do right now: read their own leave, expenses, approvals, and My Projects. Their own timesheets, plus project and billing reads, only if the extra read tools are on (default on macOS, off on Windows). Writes are off unless they enabled them.
- How to turn it off: remove the `unanet` block from `claude_desktop_config.json` and restart Claude Desktop; delete the folder to remove the credentials.
- Who to ask: Billy Hunt for connector problems, Finance (Sharma Scatliffe) for Unanet permission problems.

## Triage

Read the actual error before guessing. These cover nearly everything:

| Symptom | Meaning | Fix |
|---|---|---|
| Unanet tools don't appear in Claude Desktop | Claude didn't launch the server | Was Claude fully quit and reopened? Is the JSON in `claude_desktop_config.json` valid (a trailing comma breaks it)? Does `dist/index.js` exist (`npm run build`)? Check Claude Desktop → Settings → Developer → MCP logs |
| `UNANET_USERNAME environment variable is required` in logs | server started outside the repo folder or `.env` missing | the config command must `cd` into the repo before `node dist/index.js` |
| **401** / "Authentication failed" | wrong username, password, or base URL | log into the Unanet website with the same credentials; check `.env` for typos (a password containing `#` or a space must be wrapped in single quotes, or it is cut off); base URL must be the origin only, no `/platform/rest` |
| **403** | login worked; their Unanet account lacks that permission | Not a connector problem. Note what they tried and ask Finance whether they should have it. Don't work around it |
| Leave balances work but projects/timesheets don't show | extra read tools disabled | set `UNANET_ENABLE_LEGACY_READ_TOOLS=true` in `.env` (name is historical), restart Claude Desktop |
| Windows "Access Denied" during setup | permissions / corporate policy | do **not** disable antivirus; stop and get IT or Billy |
| `node: command not found` after installing Node | terminal opened before install | close and reopen the terminal |

If none of these fit, get the exact log line from Claude Desktop's MCP log and the output of `node --version`, and hand both to Billy.

## Things not to do

- Don't suggest, request, or configure the `Workday.Integration` account or any shared service credential. Each person uses their own login; that's the security model, not a limitation.
- Don't accept the user's password in chat, and don't write it to a file for them.
- Don't enable write tools "to be safe" or "just in case." Off is the safe state.
- Don't route Unanet permission questions to the Data team or IT. 403s are Finance.

## Reference

- Repo: https://github.com/navapbc/unanet-mcp-server — `README.md` (env vars, config snippet), `PRE-INSTALLATION-CHECKLIST.md`, `TROUBLESHOOTING-WINDOWS.md` (mostly applies to Mac too), `SECURITY.md`.
- Auth: `POST /platform/rest/login` with username/password → short-lived bearer token, cached in memory. No API key.
- Default tools: 7 read-only self-service tools. `UNANET_ENABLE_LEGACY_READ_TOOLS=true` adds 8 org-level reads. `UNANET_ENABLE_WRITE_TOOLS=true` adds 14 write tools: 10 that require `confirm: true` (create/update/edit/delete timesheet entries, **submit a timesheet for approval**, **approve a timesheet**, expense draft/detail/attachment, create contact), and 4 stubs with no `confirm` field (update project budget, update lead, create opportunity, generate invoice) that always return `success: false` and change nothing. Submitting and approving write to the live ERP, so tell the user to review in Unanet before anything is submitted.
