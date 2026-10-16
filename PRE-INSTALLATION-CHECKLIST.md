# Pre-Installation Checklist

Keep this open while you set up. Setup takes about 15 minutes.

## What you need

- [ ] **Your Unanet login** — the same username and password you use at https://navapbc.unanet.biz
  - That is all. There is **no API key, firm code, or special access** to request. The connector logs in as you and can only do what your Unanet account can already do in the website.
  - Do not write your password down here or anywhere else. You will type it once, into a file that stays on your computer.

- [ ] **Claude Desktop** installed and signed in — https://claude.ai/download

- [ ] **Node.js 20 or newer** — https://nodejs.org/ (pick the LTS installer). The setup script will tell you if it is missing.

- [ ] **A copy of this repository** on your computer
  - Nava GitHub: https://github.com/navapbc/unanet-mcp-server (requires access to the `navapbc` org — ask Billy Hunt if you do not have it)

- [ ] **About 500 MB of free disk space** and an internet connection

## Which guide to follow

| You are on | Run | Then read |
| --- | --- | --- |
| macOS | `./setup-mac.sh` in the repo folder | [README](README.md) |
| Windows 10/11 | `setup-windows.bat` | [Windows Setup Guide](README-WINDOWS.md), [Visual Guide](SETUP-VISUAL-GUIDE.md) |

Both scripts create a local `.env` file for your credentials, build the server, and point Claude Desktop at it. Your password is never copied into the Claude Desktop config.

## What you do NOT need

- Programming knowledge
- An API key, firm code, service account, or "REST API access"
- Anyone in Finance, IT, or Data to grant you anything (unless the connector later returns a 403 — that means your Unanet account lacks a permission, and Finance can tell you whether you should have it)
- To disable antivirus or change any security settings. If something says "Access Denied", stop and ask for help instead.

## If you get stuck

1. [Troubleshooting Guide](TROUBLESHOOTING-WINDOWS.md) (most entries apply to macOS too)
2. [FAQ](FAQ.md)
3. Ask Billy Hunt

## Ready?

Open a terminal (macOS) or double-click the `.bat` file (Windows) and run the setup script. When it finishes, fully quit and reopen Claude Desktop, then ask Claude: *"What are my Unanet leave balances?"* If the number matches what you see in Unanet, you are done.
