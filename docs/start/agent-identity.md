---
title: Agent Identity
---

String runs every CLI, MCP, and HTTP call as an agent. The agent id selects the
home where sessions, installed apps, history, and `/set $X` values live.

Most users do nothing. String uses the `default` agent automatically:

```bash
string main '/info'
```

## Map an agent to a home

When you want a named workspace, create the mapping once:

```bash
string agent add leo --home /home/ubuntu/crew/leo
```

From then on, select only the agent id. Do not pass the home path in every MCP
or CLI launch.

## Option A: session environment

Use this when one terminal, tmux pane, or AI client process should run as a
specific agent:

```bash
STRING_AGENT_ID=leo claude
STRING_AGENT_ID=leo string main '/info'
```

This works for CLI and MCP because `string --mcp` reads the same environment as
the process that launches it.

## Option B: workspace-local config

Use this when a directory should always select the same String agent without an
environment variable:

```bash
cd /home/ubuntu/crew/leo
mkdir -p .string
string agent use leo
```

This writes:

```json
{
  "currentAgent": "leo"
}
```

to `/home/ubuntu/crew/leo/.string/config.json`. Any `string` CLI or `string
--mcp` process launched from that workspace uses `leo`.

Claude Code also exposes the project directory to MCP servers, so the Claude
Code plugin's bundled MCP server can use this file even though the plugin config
itself is generic.

## Claude Code plugin behavior

The String Claude Code plugin bundles this MCP server:

```json
{
  "mcpServers": {
    "string": {
      "command": "npx",
      "args": ["-y", "@string-os/string", "--mcp"]
    }
  }
}
```

The plugin does not hardcode an agent id. That is intentional.

Agent selection happens inside String:

1. `--agent <id>`
2. `STRING_AGENT_ID`
3. nearest `.string/config.json` from the launched project/workspace
4. `~/.string/config.json`
5. `default`

So a plugin install can stay zero-config for normal users while advanced users
can still make each workspace run as a different agent.

## Claude MCP local scope

If you do not want to use the plugin's bundled MCP server, Claude Code also
supports project-local MCP entries:

```bash
cd /home/ubuntu/crew/leo
claude mcp add --scope local string -- npx -y @string-os/string --mcp --agent leo
```

This stores a private MCP override for the current project path in
`~/.claude.json`. Keep the server name `string` so Claude Code's tool id stays
`mcp__string__string`.

Use this only when you need to replace the plugin-provided MCP server for one
project. Otherwise prefer the workspace-local `.string/config.json` approach.

## One-shot overrides

For a single command:

```bash
string --agent reviewer main '/info'
```

For debugging launch wrappers only:

```bash
STRING_HOME=/tmp/string-home STRING_AGENT_ID=scratch string main '/info'
```

`STRING_HOME` forces the home for that invocation. It is not the recommended
multi-agent setup; use `string agent add <id> --home <path>` instead.
