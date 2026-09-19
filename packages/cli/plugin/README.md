# Agent Issues Plugin

Agent Issues gives coding agents a durable work model for planning and delivery. It adds workflow skills, an issue-first custom agent, and MCP tools for work that needs clear scope, dependencies, and acceptance criteria.

## Install

Install the two required commands first. The plugin uses `agent-issues-mcp`, which starts `agent-issues --mcp`.

```bash
npm install --global agent-issues agent-issues-mcp
```

Then install the plugin for Copilot CLI or Claude Code:

```bash
agent-issues plugin install copilot
agent-issues plugin install claude
```

The commands add this plugin marketplace and install Agent Issues:

```bash
copilot plugin marketplace add arcmantle/agent-issues-plugin
copilot plugin install agent-issues@agent-issues
```

```bash
claude plugin marketplace add arcmantle/agent-issues-plugin
claude plugin install agent-issues@agent-issues --scope user
```

In VS Code, enable `chat.plugins.enabled`. VS Code loads the installed plugin from the shared Copilot plugin directory.

## Included

- An issue-first Agent Issues custom agent for scoped implementation work.
- Skills for planning, issue breakdown, test-driven development, implementation, handoff, and next-work selection.
- MCP tools for initiatives, PRDs, user stories, issues, ADRs, project context, relations, and comments.
- A shared language standard and operating contract for consistent agent behavior.

## Start work

Open a workspace and initialize its local tracker data:

```bash
cd /path/to/workspace
agent-issues init
agent-issues create initiative --title "Platform cleanup"
```

Use the Agent Issues agent when work should follow an existing issue. The agent reads the issue context, keeps changes within its scope, and validates the changed behavior before it finishes.

## Update

Update the command packages and then update the installed plugin:

```bash
npm install --global agent-issues@latest agent-issues-mcp@latest
copilot plugin marketplace update agent-issues
copilot plugin update agent-issues
```

## Help

Run `agent-issues help --json` for the CLI command catalog, or `agent-issues capabilities --json` for the combined command and workflow schema.

For complete documentation, source code, and issue reporting, see the [Agent Issues repository](https://github.com/arcmantle/agent-issues).