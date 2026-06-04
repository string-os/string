---
name: using-string
description: >
  Use the installed String MCP tool for String apps, SFMD, web pages, shell
  sessions, and commands like /open, /act, /install, or /set.
---

# Using String

You have the installed String MCP tool named `string`; some hosts display it with a server prefix.

Call it with `{ topic, cmd }`, for example `{ "topic": "main", "cmd": "/info" }`.

Use topics like `main`, `app:<name>`, `app:<name>:<config>`, `bash:<name>`, or hubs `app`, `tool`, `bash`, `system`.

`cmd` must start with `/`; use `/help`, `/info`, and `/act --help` to discover what to do.

Use `/open` to read files, URLs, or apps; installed apps can run `/act.<name>` directly from `app:<name>` if you already know the action.

Use `/install` to add apps; `/set $VAR = "..."` for app credentials.

Read the payload inside `<𝒞=string:TOPIC>...</𝒞>` and follow `Recovery:` or `next:` hints.
