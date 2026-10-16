# Test Your Unanet MCP Setup

Follow these simple tests to make sure everything is working correctly.

## 🧪 Quick Test (2 minutes)

### Test 1: Basic Connection

Open Claude Desktop and type:
```
Can you connect to Unanet?
```

**✅ Good Response:**
> "Yes, I can connect to Unanet. I have access to tools for managing projects, timesheets, contacts, and financial data. How can I help you with Unanet today?"

**❌ Bad Response:**
> "I don't have access to Unanet" or any error message

---

### Test 2: List Projects

Type in Claude:
```
Show me my active Unanet projects
```

**✅ Good Response:**
> Claude lists actual projects with:
> - Project names
> - Project IDs
> - Status information
> - Budget details

**❌ Bad Response:**
> "I cannot access project data" or error messages

---

### Test 3: Specific Project

If Test 2 worked, pick a project ID and type:
```
Get details for project [YOUR-PROJECT-ID]
```

**✅ Good Response:**
> Detailed information about that specific project

**❌ Bad Response:**
> Error or "project not found" (unless the ID is wrong)

## 📊 Full Test Suite (5 minutes)

Try these commands to test each major feature:

### Projects
- [ ] "List all my projects"
- [ ] "Show me projects with status Active"
- [ ] "What's the budget for project XYZ?"

### Timesheets
- [ ] "Show my timesheets from last week"
- [ ] "How many hours did I log this month?"

### Contacts
- [ ] "Show me contacts from ABC Company"
- [ ] "List recent opportunities"

### Financial
- [ ] "What's the billing status for project ABC?"
- [ ] "Show me a project profitability summary"

## 🎯 Performance Tests

These help ensure the connection is fast:

1. **Speed Test**
   - Ask: "List 10 projects"
   - Should respond within 5-10 seconds

2. **Data Test**
   - Ask: "Show me project ABC123 with full details"
   - Should show complete information

## 🔍 What the Responses Tell You

### Everything Works! 🎉
If all tests pass, you're ready to use Unanet with Claude!

### Some Things Don't Work 🤔
- **Projects work but timesheets don't:** Check timesheet permissions in Unanet
- **Can list but not update:** Check API write permissions
- **Everything is slow:** Check internet connection

### Nothing Works 😟
1. Check the [Troubleshooting Guide](TROUBLESHOOTING-WINDOWS.md)
2. Verify credentials in `.env` (credentials belong only there, not in the Claude config)
3. Make sure you restarted Claude Desktop

## 📝 Test Log Template

Copy this to track your testing:

```
Date: ___________
Tester: ___________

Basic Tests:
[ ] Connection test - Pass/Fail
[ ] List projects - Pass/Fail  
[ ] Get project details - Pass/Fail

Feature Tests:
[ ] Timesheets - Pass/Fail
[ ] Contacts - Pass/Fail
[ ] Financial - Pass/Fail

Issues Found:
_________________________________
_________________________________
_________________________________

Next Steps:
_________________________________
_________________________________
```

## 💡 Testing Tips

1. **Start simple** - Don't try complex queries until basic ones work
2. **Note exact errors** - Screenshot or copy error messages
3. **Test during business hours** - Some systems have maintenance windows
4. **Try variations** - If "show projects" fails, try "list my projects"

## 🚀 What's Next?

Once testing passes:

1. Review the [Usage Examples](USAGE-EXAMPLES.md)
2. Set up your common queries
3. Share with your team!

---

**Remember:** It's normal for setup to need tweaking. Don't get discouraged if the first test fails!