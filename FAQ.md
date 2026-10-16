# Frequently Asked Questions (FAQ)

## 🤔 General Questions

### Q: What is this Unanet MCP Server?
**A:** It's a connector that lets Claude Desktop talk to your Unanet system. Think of it as a translator between Claude and Unanet, allowing you to use natural language to work with your projects, timesheets, and reports.

### Q: Do I need to be technical to set this up?
**A:** No! The setup guide is written for non-technical users. If you can install software like Microsoft Office, you can install this.

### Q: Is this official Unanet software?
**A:** No, this is a third-party integration tool that uses Unanet's official API. It's like how Outlook can connect to Gmail - different companies, but they work together.

### Q: How much does it cost?
**A:** The MCP server itself is free and open source. You need:
- Claude Desktop (check Claude's pricing)
- Unanet API access (included with most Unanet subscriptions)

## 🔧 Setup Questions

### Q: Why do I need to install Node.js?
**A:** Node.js is like Microsoft .NET or Java - it's a runtime that allows the connector to run. It's free, safe, and used by millions of developers.

### Q: Where should I install this?
**A:** We recommend `C:\UnanetMCP\` for simplicity. Avoid:
- Program Files (permission issues)
- OneDrive folders (sync conflicts)
- Network drives (connection issues)

### Q: Can I install this on my work computer?
**A:** Check with your IT department first. You'll need:
- Permission to install software
- Access to Unanet API
- No conflicts with security policies

### Q: How long does setup take?
**A:** Usually 10-15 minutes if you have all your credentials ready. First-time Node.js installation might add 5 minutes.

## 🔒 Security Questions

### Q: Is this secure?
**A:** Yes! Your credentials are:
- Stored locally on your computer only
- Never sent to third parties
- Encrypted when talking to Unanet
- Same security as using Unanet directly

### Q: Who can see my Unanet data?
**A:** Only you. The connection is:
- Your Computer → Claude Desktop → MCP Server → Unanet
- No cloud storage or external servers involved

### Q: What if someone gets my computer?
**A:** They would need:
- Your Windows login
- Your Claude Desktop access
- Knowledge of what commands to use
Same risk as having Unanet bookmarked in your browser.

### Q: Can this break my Unanet system?
**A:** No. It only does what you tell it to do, using the same permissions as your Unanet account. If you can't do something in Unanet normally, Claude can't do it either.

## 💻 Technical Questions

### Q: What versions of Windows are supported?
**A:** Windows 10 and Windows 11. Windows 7/8 might work but aren't tested.

### Q: Can I use this on Mac or Linux?
**A:** Yes! The core server works on all platforms. This guide is Windows-specific, but Mac/Linux users can follow the technical README.

### Q: What Node.js version do I need?
**A:** Version 18 or higher. The installer from nodejs.org will give you the latest stable version.

### Q: Can I move the installation later?
**A:** Yes, but you'll need to:
1. Move the folder
2. Update Claude Desktop config with new path
3. Restart Claude Desktop

## 🚀 Usage Questions

### Q: What can I actually do with this?
**A:** Ask Claude things like:
- "Show me all active projects"
- "Submit 8 hours to project ABC for today"
- "Generate a project profitability report"
- "Create a new contact for John Smith"
- "What's the budget status for project XYZ?"

### Q: Do I need to remember special commands?
**A:** No! Use natural language. Claude understands variations:
- "Show projects" = "List my projects" = "What projects do I have?"

### Q: Can multiple people use this?
**A:** Each person needs their own installation with their own Unanet credentials. It's tied to individual Unanet accounts.

### Q: Does this work offline?
**A:** No. You need internet to connect to Unanet, just like using Unanet in a web browser.

## 🔧 Troubleshooting Questions

### Q: Claude says "I don't have access to Unanet"
**A:** Usually means:
1. You haven't restarted Claude Desktop after setup
2. Configuration file has wrong path
3. Credentials aren't set correctly

See [Troubleshooting Guide](TROUBLESHOOTING-WINDOWS.md) for fixes.

### Q: It worked yesterday but not today
**A:** Check:
- Did your Unanet password change?
- Is Unanet down for maintenance?
- Did Windows Update restart your computer?

### Q: It's really slow
**A:** Normal response time is 2-5 seconds. If slower:
- Check internet connection
- Try simpler queries first
- Unanet might be under heavy load

### Q: Can I uninstall this?
**A:** Yes! Simply:
1. Delete the UnanetMCP folder
2. Remove the "unanet" section from Claude Desktop config
3. Optionally uninstall Node.js from Control Panel

## 📱 Support Questions

### Q: Where do I get help?
**A:** In order:
1. Check the [Troubleshooting Guide](TROUBLESHOOTING-WINDOWS.md)
2. Ask your Unanet administrator
3. Contact your IT support
4. Check the GitHub repository issues

### Q: What info should I provide when asking for help?
**A:** 
- What step failed
- Exact error message (screenshot helps)
- Windows version
- When it last worked (if ever)

### Q: Is there a user community?
**A:** Check the GitHub repository for:
- Issues others have solved
- Feature requests
- Tips and tricks

## 🎯 Best Practices

### Q: Should I share my setup with others?
**A:** Share the guide, not your credentials! Each person installs it with their own Unanet username and password, and the connector inherits exactly their Unanet permissions.

### Q: How often should I update?
**A:** Check the GitHub repository monthly for updates. Updates usually add features or fix bugs.

### Q: Can I customize what it can do?
**A:** Advanced users can modify the code. Basic users should stick with the provided features.

---

**Don't see your question?** Check the full documentation or open an issue on GitHub!