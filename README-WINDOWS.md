# Unanet connector: Windows setup

This connects Claude Code or Claude Desktop on Windows 10/11 to Nava's Unanet. It signs in with your normal Unanet username and password and can only do what your Unanet account can already do. You do not need an API key, a firm code or anyone's approval. The Windows script is less exercised than the Mac one; if something here does not match what you see, tell Billy Hunt.

## 1. Install Node.js

Download the LTS installer (version 20 or newer) from https://nodejs.org/ and run it with the default options. Open a new Command Prompt afterwards so `node --version` works.

## 2. Get the code

Either `git clone https://github.com/navapbc/unanet-mcp-server.git`, or on GitHub use **Code → Download ZIP** and extract it to a permanent place such as `C:\UnanetMCP\unanet-mcp-server`. Do not move the folder later: the client configuration points at it.

## 3. Run the setup script

Double-click `setup-windows.bat` in that folder. It installs and builds the connector, creates `.env`, and opens it in Notepad. Fill in:

```
UNANET_USERNAME=your-username
UNANET_PASSWORD=your-password
UNANET_BASE_URL=https://navapbc.unanet.biz
```

- Leave `UNANET_BASE_URL` exactly as shown: https, no path after `.biz`.
- If your password contains `#`, or starts or ends with a space, wrap it in single quotes: `UNANET_PASSWORD='p#ss word'` (backticks if it also contains a single quote).
- Save and close Notepad. The file is plain text on your disk; treat it like your password.

The script then backs up and updates the Claude Desktop configuration so it starts the connector from this folder. Your password is never copied into that configuration.

## 4. Check the sign-in

In a Command Prompt in the folder:

```
npm run check-setup
```

`READY: signed in ...` means the credentials work. `NOT READY:` gives the problem and next steps: fix settings for configuration or credential errors, ask Finance for permission or license denials, or check connectivity for network failures. Do not change credentials for every failure.

## 5. Connect your Claude app

- **Claude Desktop:** right-click the Claude icon in the system tray, choose Quit, and start Claude Desktop again.
- **Claude Code:** open PowerShell in the repository folder, run `npm run check-setup`, then run the `claude mcp add` command it prints. That generated command is quoted for PowerShell, **not Command Prompt**, so installation paths containing spaces or shell characters stay intact. Start a new Claude Code session afterwards.

Then ask *"What are my Unanet leave balances?"* and compare the answer with Unanet yourself. Claude should use the `unanet` tools. If it opens the Unanet website in a browser instead, the connector is not connected: go back to step 4.

## Turning on more tools

By default only your own records are readable. In `.env`, `UNANET_ENABLE_EXTENDED_READ_TOOLS=true` adds org-level reads (projects, people, organizations, contracts, invoices) and `UNANET_ENABLE_WRITE_TOOLS=true` adds tools that change Unanet. Leave writes off unless you need them, and review anything in Unanet before it is submitted. Restart the Claude app after changing `.env`.

## Troubleshooting

- **"Node.js is not installed":** finish step 1 and open a new Command Prompt.
- **"Failed to install dependencies":** check your internet connection and run the script again. Do not turn off antivirus; send the error text to IT or Billy Hunt. "Access denied" errors also go to IT.
- **Tools missing in the Claude app:** run `npm run check-setup` and fix what it reports. If only a tool called `unanet_setup_status` appears, the connector is running but `.env` has a problem; fix it and restart the app. For Claude Code, `claude mcp list` should show `unanet`.
- **401 / authentication failed:** sign in to the Unanet website with the same username and password, then check `.env` for typos and the quoting rule above.
- **403 / access forbidden:** your Unanet account lacks a permission or required license. Ask Finance, not IT; do not change credentials to fix it.
