---
name: using-string
description: >
  Use the installed String MCP tool for String apps, SFMD documents, web pages,
  app actions, shell sessions, or commands like /open, /act, /install, /set,
  and app:<name>.
---

# Using String

You have the installed MCP tool `mcp__string__string`.

Call it as `mcp__string__string({ topic: "main", cmd: "/info" })`.

`topic` is the session: use `main`, `app:<name>`, `app:<name>:<config>`, `bash:<name>`, or hubs like `app`, `tool`, `bash`, `system`.

`cmd` must start with `/`; use `/info` or `/help` first when unsure.

Use `/open <path|url|app:name>` to read files, web pages, or app home pages.

Use `/act` to list actions and `/act.<name> ...` to run one; `/act.<name> --help` shows arguments.

Use `/install <github-url|path>` to install a String app, then open it in `app:<name>`.

Use `/set $VAR = "..."` inside an `app:<name>` topic for app credentials.

Read only the payload inside `<𝒞=string:TOPIC>...</𝒞>` and follow any `Recovery:` or `next:` hints.
