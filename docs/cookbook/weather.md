---
title: 00 — Weather app, end to end
---

# 00 — Weather app, end to end

**Goal:** install a real SFMD app, drive it from a terminal, then watch an AI agent use the same app through the CLI with no further integration. About 15 minutes.

Every captured output in this chapter is from a live run against the current v0.1 runtime. Nothing is mocked. If a command here returns something different for you, it is a drift and should be reported at [`string-os/string`](https://github.com/string-os/string/issues).

---

## 1. Install `string`

Requirements: Node 18+ and pnpm 9+ (or plain npm).

```bash
npm install -g @string-os/string
```

Or from source:

```bash
git clone https://github.com/string-os/string.git
cd string
pnpm install && pnpm -r build
pnpm --filter @string-os/string link --global
```

Verify:

```bash
string --help
```

You should see the usage banner starting with `String v0.1`.

---

## 2. Install the weather app

Clone this cookbook:

```bash
git clone https://github.com/string-os/cookbook.git
cd cookbook
```

Install the weather app into `string`'s package registry:

```bash
string file:setup '/install --app ./apps/weather/string.md'
```

Output:

```
<𝒞=string:file:setup>
Installed app:weather
  Source: /home/you/cookbook/apps/weather/string.md
  Path: /home/you/.string/users/default/.string/packages/weather/string.md
Use: /open app:weather
</𝒞>
```

The runtime copied the file into its package directory and registered `weather` under the apps registry. From now on, `app:weather` is addressable from any session.

### What are the `<𝒞=…>` lines?

Every `string` CLI call wraps its stdout in a short envelope: an opening line `<𝒞=string:<topic>>` and a closing line `</𝒞>`. Between them sits the actual payload. It is there so a calling program can tell runtime output apart from any stray noise (shell warnings, log lines, etc.) on stdout. This is the **default** output format — both human operators and agents parsing stdout see the frame form.

When you need to consume the output programmatically from stdout, two patterns:

- **Strip the first and last lines.** The payload is everything in between. Works in a one-line `sed` or the equivalent in your agent framework.
- **Read stdout as a block.** The frame markers are unique enough (`𝒞` is a rarely-used Unicode character) to `grep` out without false matches.

There is also a `--json` flag for callers that strongly prefer a JSON envelope (`{"ok":…, "topic":…, "content":…}`). It is a secondary convenience, not the default — the frame form is what you should expect when you run `string` without flags. The [client library](./03-client-library.md) (chapter 03) talks to the daemon directly and gives back structured results, bypassing both forms entirely.

---

## 3. Drive it yourself from a terminal

`string <topic> '<command>'` is the one-shot form. Topics are `type:name`: use `file:` for ad-hoc sessions, `app:` for installed apps, `web:` for HTTP, `bash:` for a persistent shell. For the weather app, use `app:weather`.

```bash
string app:weather '/open app:weather'
```

```
<𝒞=string:app:weather>
Opened .string/packages/weather/string.md
---
[actions] /act.now --city <string> | /act.forecast --city <string> | /act.search --q <string>
          /act.<name> --help for details


# Weather

A three-action weather app, backed by [wttr.in][@link-1] for the
weather data and [Nominatim][@link-2] (OpenStreetMap) for resolving
city names. No API key, no signup, no server to run. Works the
moment it is installed.

## Actions

- `/act.now --city <name>` — current conditions, one line
- `/act.forecast --city <name>` — detailed forecast with wind and humidity
- `/act.search --q <query>` — resolve a free-form location query to
  canonical names you can pass to `now` / `forecast`.

For multi-word cities passed directly to `now` / `forecast`, use `+` in
place of spaces: `--city New+York`. Or pass them through `search` first.
</𝒞>
```

Three things to notice inside the envelope:

1. `Opened <path>\n---\n` is always the first line of a successful `/open`.
2. The renderer prepends `[actions] …` when the page declares actions. This is the runtime telling the reader "here is what you can do on this page." No separate tool-discovery step.
3. The `act.` code blocks from the source file are **stripped** from the rendered viewport — they are machine-facing, not content.

Now call the actions:

```bash
$ string app:weather '/act.now --city Seoul'
<𝒞=string:app:weather>
seoul: Sunny +20°C ↘6km/h
</𝒞>

$ string app:weather '/act.forecast --city Tokyo'
<𝒞=string:app:weather>
tokyo: Patchy rain nearby +18°C ↙18km/h 83% 0.1mm
</𝒞>

$ string app:weather '/act.now --city New+York'
<𝒞=string:app:weather>
new york: Clear +27°C ↗18km/h
</𝒞>
```

Real weather data for three cities. Zero configuration beyond the one `/install`. This is what a human operator sees when they drive the app by hand.

---

## 4. See what the session knows

```bash
string app:weather '/info'
```

```
<𝒞=string:app:weather>
Session info
---
app:       weather
name:      weather
version:   0.1.0
title:     Weather
shortcuts: +1 auto
actions:   now(CLI), forecast(CLI)
history:   1 entries
</𝒞>
```

`/info` is the session's self-description. It tells the reader — human or agent — what app is loaded, which version, what actions exist, and how much history is stacked up. Everything an agent needs to decide "what can I do next" is here.

---

## 5. An AI uses `string` via the CLI — zero integration work

Most agent frameworks — OpenClaw, Hermes Agent, anything with a shell tool — already let the LLM run shell commands. **That is enough to use `string` today**, with no further integration.

The agent's prompt needs one paragraph:

> You have `string` installed. It is a markdown browser with installed apps. Call it as `string <topic> '<command>'` from the shell. The response is wrapped between `<𝒞=string:topic>` and `</𝒞>` — the payload between those lines is what you read. To find what an app can do, run `/open app:<name>` and then `/act`. Installed apps: `weather`.

With that in the prompt, an actual conversation looks like this:

> **User:** What's the weather in Seoul, Tokyo, and New York?

The agent, using its shell tool, runs four commands. Each of these outputs is **real** — captured from the actual runtime:

```bash
$ string app:weather '/open app:weather'
<𝒞=string:app:weather>
Opened .string/packages/weather/string.md
---
[actions] /act.now --city <string> | /act.forecast --city <string> | /act.search --q <string>
          /act.<name> --help for details


# Weather

A three-action weather app, backed by [wttr.in][@link-1] for the
weather data and [Nominatim][@link-2] (OpenStreetMap) for resolving
city names. ...
</𝒞>

$ string app:weather '/act.now --city Seoul'
<𝒞=string:app:weather>
seoul: Sunny +20°C ↘6km/h
</𝒞>

$ string app:weather '/act.now --city Tokyo'
<𝒞=string:app:weather>
tokyo: Patchy rain nearby +18°C ↙18km/h
</𝒞>

$ string app:weather '/act.now --city New+York'
<𝒞=string:app:weather>
new york: Clear +27°C ↗18km/h
</𝒞>
```

The agent reads the payload between the frame markers on each call. Then it answers:

> **Agent:** Seoul is sunny and 20°C with a light breeze. Tokyo has patchy rain at 18°C. New York is clear and 27°C.

One open, three actions, four shell calls. No tool registration, no API key management, no long-lived server started for this app. The agent treated `string` the same way it would treat `curl` or `jq` — a shell tool whose output it reads from stdout.

**When Path 1 is enough:** any agent whose prompt can accommodate a short instruction block and whose tool surface already includes shell exec. Most capable agents qualify.

**What Path 1 costs:** every call spawns a short-lived `string` CLI process. For latency-sensitive agent loops — say, a few dozen calls per turn — the per-call fork/exec overhead can add up. Path 2 (the [client library](./03-client-library.md)) eliminates this by talking to the daemon directly over loopback HTTP, with no subprocess per call.

---

## 6. When to move to the client library

Stay on Path 1 when you are:

- Proving the integration works on an existing agent framework with minimal effort.
- Running fewer than a handful of `string` calls per user turn.
- Shipping a demo where "install `string`, paste these instructions into the prompt" is the whole setup.

Move to Path 2 (chapter [03](./03-client-library.md)) when you are:

- Building the agent framework itself, not wiring into an existing one.
- Making `string` the primary surface the agent uses for tools. At that point the single-tool pattern (one `string` tool on the LLM's tool list, regardless of how many SFMD apps are installed) pays off.
- Wanting structured error codes the LLM can discriminate on.
- Running enough `string` calls per turn that subprocess overhead matters.

There is also a third option — the MCP bridge — for cases where the target is a third-party MCP host you don't control (Claude Desktop, Cursor, generic agent platforms). See the [runtime repo's agent integration doc](https://github.com/string-os/string/blob/main/docs/agent-integration.md) for the full rundown. It works, but for agents built around `string`, Path 1 and Path 2 are usually cleaner.

---

## 7. What you just saw, in one paragraph

The weather app is a markdown file. The runtime parses it, exposes its actions through a small verb set (`/open`, `/act`, `/nav`, `/info`), and wraps responses in a short `<𝒞=string:topic>` frame on stdout. An AI uses the app by running `string` as a shell command and reading the payload between the frame markers. Installing a new SFMD app is one `/install` call — no host restart, no schema registration, no new process. The runtime handles the shared concerns (shell quoting, HTTP, error shapes, session state) once and reuses them across every app.

---

## Next

- **[01 — Anatomy](./01-anatomy.md)** — every line of `apps/weather/string.md` explained, plus how larger SFMD apps compose multiple files.
- **[02 — Why this matters](./02-compare.md)** — the same weather capability built as an MCP server and as a function-calling tool, so you can see the delta honestly.
- **[03 — Client library](./03-client-library.md)** — the recommended integration path when you are building the agent framework yourself.
