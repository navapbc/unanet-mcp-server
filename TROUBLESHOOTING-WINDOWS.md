# Windows Troubleshooting Guide

This guide helps you fix common issues with the Unanet MCP Server on Windows.

## 🔴 Quick Fixes (Try These First!)

### 1. Restart Claude Desktop
Many issues are fixed by a simple restart:
1. Right-click Claude icon in system tray (bottom-right)
2. Click "Quit" or "Exit"
3. Wait 10 seconds
4. Start Claude Desktop again

### 2. Check Your Credentials
The #1 cause of issues is incorrect credentials:
1. Open your `.env` file in the installation folder
2. Verify each line has the correct information
3. Make sure there are no extra spaces
4. Save the file if you make changes

### 3. Run as Administrator
1. Right-click `setup-windows.bat`
2. Select "Run as administrator"
3. Try the setup again

## 📋 Common Issues and Solutions

### Issue: "Node.js is not installed"

**Symptom:**
```
[ERROR] Node.js is not installed!
Please install Node.js first
```

**Solutions:**
1. Download Node.js from https://nodejs.org/
2. Run the installer (use default options)
3. **Restart your computer** (important!)
4. Try setup again

---

### Issue: "Cannot find Claude Desktop config"

**Symptom:**
```
[WARNING] Claude Desktop config directory not found!
```

**Solutions:**
1. Make sure Claude Desktop is installed
2. Run Claude Desktop at least once
3. Check if folder exists: `C:\Users\YOUR_NAME\AppData\Roaming\Claude`
4. If not, create it manually:
   - Press `Windows + R`
   - Type `%APPDATA%`
   - Create a new folder called "Claude"

---

### Issue: "Failed to install dependencies"

**Symptom:**
```
[ERROR] Failed to install dependencies!
Please check your internet connection
```

**Solutions:**
1. **Check Internet:** Open a browser, go to google.com
2. **Antivirus or policy blocking npm:** Do not turn antivirus off. Send the exact error text to your IT team or Billy Hunt.
3. **Check Firewall:** Allow Node.js through Windows Firewall
4. **Use Command Prompt:**
   ```
   cd C:\UnanetMCP\unanet-mcp-server
   npm install
   ```

---

### Issue: Claude says "I don't have access to Unanet"

**Symptom:**
Claude doesn't recognize Unanet commands

**Solutions:**

1. **Check Claude Config File:**
   - Open: `%APPDATA%\Claude\claude_desktop_config.json`
   - Verify it has the "unanet" section
   - Check all paths use double backslashes: `C:\\UnanetMCP\\...`

2. **Verify Installation Path:**
   - Make sure the path in config matches where you installed
   - Path should end with `\\dist\\index.js`

3. **Check Environment Variables:**
   - Credentials belong only in `.env`; the Claude config must not contain them
   - If your password contains `#`, or starts or ends with a space, wrap it in single quotes in `.env`: `UNANET_PASSWORD='p#ss word'` (backticks if it also contains a single quote)

4. **Test the Server Directly:**
   Open Command Prompt and run:
   ```
   cd C:\UnanetMCP\unanet-mcp-server
   node dist\index.js
   ```
   You should see: "Server started successfully"

---

### Issue: "Access Denied" or "Permission Denied"

**Symptom:**
Windows blocks the setup or file access

**Solutions:**
1. **Right-click → Run as Administrator**
2. **Check File Properties:**
   - Right-click setup-windows.bat
   - Click Properties
   - If you see "Unblock", check it
   - Click OK

3. **Move to Different Location:**
   - Try `C:\UnanetMCP` instead of Program Files
   - Avoid OneDrive or network folders

---

### Issue: "Invalid credentials" from Unanet

**Symptom:**
Connection works but Unanet rejects login

**Solutions:**
1. **Test Credentials:**
   - Try logging into Unanet web interface
   - Confirm username/password work

2. **Verify URL Format:**
   - Must be the origin only: `https://navapbc.unanet.biz` ✓
   - Not: `https://navapbc.unanet.biz/platform/rest` ✗
   - A trailing slash is accepted and removed; a path such as `/platform/rest` is rejected

3. **Getting a 403 instead of 401?**
   - Your login worked but your Unanet account lacks permission for that action
   - This is a Unanet access question for Finance, not a connector problem

---

### Issue: "Rate limit exceeded"

**Symptom:**
Works briefly then stops

**Solutions:**
1. Wait 15 minutes and try again
2. Don't make rapid repeated requests
3. Contact Unanet admin about API limits

## 🛠️ Advanced Troubleshooting

### Check Node.js Installation

Open Command Prompt and type:
```
node --version
npm --version
```

Should show version numbers like:
```
v20.11.0
10.2.4
```

### Check File Locations

Your installation should look like:
```
C:\UnanetMCP\unanet-mcp-server\
├── dist\
│   └── index.js (this file must exist)
├── node_modules\ (created during setup)
├── src\
├── .env (your credentials)
├── package.json
└── setup-windows.bat
```

### View Claude Logs

1. Open Claude Desktop
2. Press `Ctrl + Shift + I` (Developer Tools)
3. Click "Console" tab
4. Look for red error messages
5. Take screenshot for support

### Test Individual Components

1. **Test Node.js:**
   ```
   node -e "console.log('Node works!')"
   ```

2. **Test NPM:**
   ```
   npm --version
   ```

3. **Test Server:**
   ```
   cd C:\UnanetMCP\unanet-mcp-server
   node dist\index.js
   ```

## 📞 Getting More Help

### Information to Gather

Before asking for help, collect:

1. **Error Messages:** Copy exact text or screenshot
2. **Windows Version:** Settings → System → About
3. **Node Version:** Run `node --version`
4. **Installation Path:** Where you installed (e.g., C:\UnanetMCP)
5. **What Step Failed:** Which part of setup

### Create a Support Package

1. Open Command Prompt in installation folder
2. Run these commands:
   ```
   echo Node Version: > support-info.txt
   node --version >> support-info.txt
   echo. >> support-info.txt
   echo NPM Version: >> support-info.txt
   npm --version >> support-info.txt
   echo. >> support-info.txt
   echo Directory Contents: >> support-info.txt
   dir >> support-info.txt
   ```
3. Share `support-info.txt` with support

## 🔄 Complete Reinstall

If nothing else works:

1. **Backup your credentials** from .env file
2. **Delete the folder:** `C:\UnanetMCP`
3. **Clear Claude config:**
   - Open `%APPDATA%\Claude\claude_desktop_config.json`
   - Remove the "unanet" section
   - Save file
4. **Start fresh** with the installation guide

## 💡 Prevention Tips

1. **Use Simple Paths:** Install at `C:\UnanetMCP` not deep folders
2. **Close Other Programs:** During setup
3. **Update Windows:** Keep system current
4. **Note What Works:** Keep track of successful settings

---

**Still stuck?** Don't worry! Setup issues are common and fixable. Take a break and try again, or reach out to your IT support with the information gathered above.