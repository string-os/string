---
title: 04 — Porting Nano Banana Pro to a string app
---

# 04 — Porting Nano Banana Pro to a string app

**Goal:** take a real skill from the wild — [@steipete](https://clawhub.ai/steipete/nano-banana-pro)'s `nano-banana-pro` Codex skill on ClawHub — and port it to an SFMD app the agent uses natively. About 20 minutes if you follow along.

This is the "do it yourself" chapter. By the end you'll have the mental moves for converting any HTTP-based skill: read the API, map fields, declare the request, declare the response, ship. Most skills in `~/.codex/skills/` and on ClawHub follow the same shape, so the recipe transfers.

The finished port lives at [`apps/nano-banana-pro/`](./apps/nano-banana-pro/) in this cookbook. You can install and run it now — it works against the real Gemini API.

---

## What we're starting with

`nano-banana-pro` is `@steipete`'s skill for generating and editing images via Google's Gemini 3 Pro Image API (codename *Nano Banana Pro*). The Codex / Claude Code distribution is a zip with three files:

```
nano-banana-pro/
├── SKILL.md                      130 lines — usage prose + workflow guidance
├── scripts/generate_image.py     167 lines — Python helper around google-genai
└── _meta.json                    metadata (owner, version, slug)
```

The agent invokes it like this (from the SKILL.md):

```bash
uv run ~/.codex/skills/nano-banana-pro/scripts/generate_image.py \
  --prompt "A serene Japanese garden" \
  --filename "garden.png" \
  --resolution 4K
```

To use this skill on a fresh machine, the agent's host needs:

- `uv` installed (~10 MB binary)
- The Python script in a known location (`~/.codex/skills/nano-banana-pro/scripts/`)
- `google-genai` Python package (~5 MB + transitive deps)
- `pillow` (~5 MB + native image-format binaries)
- `GEMINI_API_KEY` exported in the environment

That's a meaningful amount of installable surface for what is, underneath, *one HTTP call*. Let's port it.

---

## Step 1: Read the API, not the skill

The first move when porting any skill is **forget the helper script** and look at what HTTP call it actually makes. Helper scripts wrap an API; the API is what you're really integrating with.

Open `scripts/generate_image.py` and find the actual request:

```python
client = genai.Client(api_key=api_key)
response = client.models.generate_content(
    model="gemini-3-pro-image-preview",
    contents=contents,
    config=types.GenerateContentConfig(
        response_modalities=["TEXT", "IMAGE"],
        image_config=types.ImageConfig(image_size=output_resolution),
    ),
)
```

The Python SDK is hiding a single REST call. Look it up in [Google's Gemini docs](https://ai.google.dev/gemini-api/docs/api-overview): it's a `POST` to `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` with a JSON body and an `x-goog-api-key` header.

A minimal raw `curl` for the same call:

```bash
curl -X POST \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent \
  -d '{
    "contents": [{"parts": [{"text": "A serene Japanese garden"}]}],
    "generationConfig": {
      "responseModalities": ["TEXT", "IMAGE"],
      "imageConfig": {"imageSize": "1K"}
    }
  }'
```

Try it in your shell. You'll get back JSON containing the image bytes at `candidates[0].content.parts[0].inlineData.data`, base64-encoded, alongside a `mimeType` field.

**That's the entire contract.** The Python script and the SDK are wrappers around this one POST. Once you can hit the endpoint with `curl`, the rest of the port is mechanical.

---

## Step 2: Map flags to fields

The original CLI flags become SFMD fields. There's no creative work here — just enumerate what the caller passes:

| Codex flag | SFMD field | Type | Notes |
|------------|------------|------|-------|
| `--prompt` | `prompt` | `string` (required) | The image description |
| `--filename` | `filename` | `string` (required) | Output path |
| `--resolution` | `resolution` | `string` | `1K`/`2K`/`4K`, default `1K` |
| `--input-image` | `input_image` | `string` (required, edit only) | Source image to edit |
| `--api-key` | *(none)* | — | Comes from env, not a flag |

`--api-key` was a flag in the original because the Python script ran as a fresh subprocess and needed an explicit way to receive the key. In SFMD, the action's header line is `-H "x-goog-api-key: $GEMINI_API_KEY"` — the `$GEMINI_API_KEY` reference is resolved at execution time from the daemon's process env. Once you `export GEMINI_API_KEY=...` and start `stringd`, every action call uses it automatically.

---

## Step 3: Declare the request

Now write the `act.generate` block. Same URL as the curl, headers from Step 1, fields from Step 2, and a `body:` directive that templates the JSON body with `{field}` placeholders:

````markdown
```act.generate
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent -H "x-goog-api-key: $GEMINI_API_KEY"
  prompt: string (required) "Image description"
  filename: string (required) "Output path"
  resolution: string "1K, 2K, or 4K" = "1K"

  body:
    {
      "contents": [{"parts": [{"text": "{prompt}"}]}],
      "generationConfig": {
        "responseModalities": ["TEXT", "IMAGE"],
        "imageConfig": {"imageSize": "{resolution}"}
      }
    }
```
````

Three things worth noticing:

- **Headers go on the first line** as `-H "Key: Value"` flags. This matches `curl`'s syntax, so the action block reads like the real curl call. The runtime parses these out as action-level headers.
- **`body:` is a multi-line directive.** Indentation marks the boundary — any line indented more than `body:` itself is part of the body. Blank lines inside the body are preserved, so you can format the JSON for readability.
- **`{prompt}` is JSON-string-aware.** Because the placeholder sits between `"` quotes inside a JSON string literal, the runtime escapes the value to be JSON-safe before substitution. A prompt containing a literal `"` or a newline doesn't break the body.

There is no shell escaping to think about. There is no `jq -n --arg p "$PROMPT" ...` template gymnastics. The body looks like the JSON the API expects, with placeholders where the per-call values go.

---

## Step 4: Declare the response handling

The Gemini API returns JSON. The image bytes we want are at one specific path inside that JSON, base64-encoded. We want to extract them, decode them, and write them to a file.

That's three directives in a sibling `act.<id>.response` block:

````markdown
```act.generate.response
{mime} = {Response.body.candidates[0].content.parts[0].inlineData.mimeType}
save: candidates[0].content.parts[0].inlineData.data
decode: base64
to: {filename}
Saved: {filename} ({mime}, {resolution})
```
````

What each line does:

- **`{mime} = {Response.body...}`** — the existing variable-assignment form. Walks the JSON, pulls out the mime type, stores it in a session variable for later. We surface the actual mime in the success line because the API's reported format sometimes differs from what you'd guess from the file extension.
- **`save: <path>`** — walks the JSON response body and stores the value at that path as the current buffer. The leading `$.` is optional. Array indices like `[0]` are supported.
- **`decode: base64`** — reinterprets the buffer as base64-decoded bytes. Without this, the buffer is the raw base64 string and `to:` would write the string to disk rather than the decoded image.
- **`to: {filename}`** — writes the decoded bytes to the path the caller supplied. The `{filename}` placeholder is substituted from the action's payload (the value the agent passed as `--filename`).
- **The final line is plain text** — a regular response template output line. The substituted variables (`{filename}`, `{mime}`, `{resolution}`) become the agent's success message: `Saved: garden.png (image/jpeg, 4K)`.

The agent can now invoke:

```bash
string app:nano-banana-pro '/act.generate --prompt "A serene Japanese garden" --filename garden.png --resolution 4K'
```

And get back:

```
Saved: garden.png (image/jpeg, 4K)
```

The image is on disk at `garden.png`. No Python launched. No SDK loaded. No bash escaping to debug.

---

## Step 5: The edit action and the `|base64file` modifier

The edit operation sends the *input image* as base64 inside the request body. The naïve port is "let the agent base64-encode the file and pass it as a flag." That works for tiny images but fails for real ones — a 1 MB JPEG becomes a 1.4 MB base64 string, and the OS argv limit on Linux is around 2 MB. The agent's call would be rejected by the kernel before `string` even saw it.

The fix is the `|base64file` field modifier. The agent passes a **file path** (~30 chars, fits in argv easily) and the runtime reads the file and base64-encodes it inline as it builds the body:

````markdown
```act.edit
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent -H "x-goog-api-key: $GEMINI_API_KEY"
  prompt: string (required) "Editing instruction"
  filename: string (required) "Output path"
  input_image: string (required) "Path to source image to edit"
  resolution: string "1K, 2K, or 4K" = "1K"

  body:
    {
      "contents": [{"parts": [
        {"inlineData": {"mimeType": "image/jpeg", "data": "{input_image|base64file}"}},
        {"text": "{prompt}"}
      ]}],
      "generationConfig": {
        "responseModalities": ["TEXT", "IMAGE"],
        "imageConfig": {"imageSize": "{resolution}"}
      }
    }
```

```act.edit.response
{mime} = {Response.body.candidates[0].content.parts[0].inlineData.mimeType}
save: candidates[0].content.parts[0].inlineData.data
decode: base64
to: {filename}
Saved: {filename} ({mime}, {resolution}, edited from {input_image})
```
````

The only difference from `generate` is the body shape (input image part comes first, prompt second) and the new `{input_image|base64file}` placeholder. Response template is structurally identical.

The agent uses it the same way:

```bash
string app:nano-banana-pro '/act.edit \
  --prompt "Change ONLY: sky to sunset. Keep identical: composition, lighting, foreground." \
  --filename sunset.png \
  --input_image garden.png'
```

Returns:

```
Saved: sunset.png (image/jpeg, 1K, edited from garden.png)
```

Modifiers compose. `{name|file}` reads a file as UTF-8. `{name|base64}` base64-encodes a literal value. `{name|base64file}` does both: read the file then base64. Future modifiers (`|gzip`, `|sha256`, etc.) compose the same way.

---

## Step 6: Write the body

The action blocks are the machinery. The `string.md` body is what the agent reads when it `/open`s the app — the place to surface the two things the agent needs *every call*:

1. **A 1-line example for each action.** Copy-paste-ready, with realistic prompts and filenames. This eliminates a `/act --help` round-trip on the first call.
2. **Per-call default rules.** Resolution rule of thumb, filename pattern, prompt-handling guidance. The things the agent should apply without thinking.

Setup concerns (API key, dependencies, common failures, what the app *isn't*) go into a sibling `REQUIREMENTS.md`, not into the main `string.md`. The agent reads `REQUIREMENTS.md` once at install time; everything in `string.md` is loaded on every `/open`. Keeping the per-call surface tight saves prompt tokens on every call.

The full body for `nano-banana-pro` is in [`apps/nano-banana-pro/string.md`](./apps/nano-banana-pro/string.md) — about 50 lines including the action blocks. The whole file is the single source of truth for the app, and it's what gets installed.

---

## What you didn't have to do

The Codex original needs:

- `uv` installed (~10 MB binary)
- A 167-line Python helper script in a known location on disk
- `google-genai` Python package and its transitive deps
- `pillow` plus native image-handling binaries
- Matching path between the SKILL.md instructions and the actual install location

The SFMD port needs:

- `curl`, `jq`, `base64` (already on every modern Linux/macOS shell)

Other things the SFMD port skips entirely:

- **No subprocess launch per call.** The runtime makes the HTTP request inline. No `uv run` startup cost (~1 second per first invocation).
- **No SDK to keep in sync with API changes.** The request shape is in plain view in the action block. When Google adds a new `generationConfig` field, you edit one line of the body template.
- **No "import google.genai" startup latency** on the first call after a daemon restart.
- **No PIL conversion code.** Base64 decode + file write is what the runtime already does for `to:` directives.
- **No manual error parsing from API responses.** Non-2xx responses get their body forwarded as the action's error message — the agent sees the API's actual `{"error": {"message": "..."}}` content, not just `HTTP 503`.
- **No `--api-key` flag in the action surface.** The header line resolves `$GEMINI_API_KEY` from the daemon's env, set once at startup.

And the agent itself doesn't have to think about any of the above. When it inspects the app via `/act` or `/act.<name> --help`, it sees only the call interface — verb name, fields, descriptions:

```
/act.generate
   --prompt <string> (required) — Image description
   --filename <string> (required) — Output path (yyyy-mm-dd-hh-mm-ss-name.png recommended)
   --resolution <string> (optional) — 1K, 2K, or 4K
```

The body template, the URL, the response extraction directives, the `$GEMINI_API_KEY` reference — all hidden as implementation. If a curious agent (or human auditor) wants to see what the action actually does on the wire, `/source` dumps the raw `.md` file. Otherwise, the runtime's job is to make the call, and the agent's job is to call the verb. Two layers, one contract.

---

## The general pattern

Every HTTP-based skill follows the same five-step recipe:

1. **Find the actual HTTP call** the helper script is wrapping. Read the script, run a `curl` by hand, confirm the request and response shapes.
2. **Map flags to fields.** Usually 1-to-1. Drop any flags that exist only to pass env vars through a subprocess — those become `$VAR` in headers.
3. **Declare the action block.** Method, URL, headers (with `$VAR` for secrets), fields, and a `body:` JSON template with `{field}` placeholders. Use `{field|base64file}` for binary inputs.
4. **Declare the response template.** Extract any auxiliary vars first (mime, ids, status messages), then `save:` → `decode:` → `to:` for binary outputs. End with a plain-text line for the agent's success message.
5. **Write the body.** A 1-line example per action, per-call default rules, a link to a separate `REQUIREMENTS.md` for setup.

Most skills you'll find on [ClawHub](https://clawhub.ai) or in `~/.codex/skills/` follow this exact shape: a `SKILL.md` describing how to invoke a Python or shell helper that wraps one or two HTTP calls. Once you've done one port, the next one is a 20-minute exercise. The hard part is only the first time.

The result, every time, is a single SFMD file with no helper scripts, no language runtime, and no install dance — just markdown the agent already knows how to read.

---

## Try it

```bash
git clone https://github.com/string-os/cookbook.git
cd cookbook
export GEMINI_API_KEY=...   # https://aistudio.google.com/apikey
string file:setup '/install --app ./apps/nano-banana-pro/string.md'
string app:nano-banana-pro '/open app:nano-banana-pro'
string app:nano-banana-pro '/act.generate --prompt "a vintage red bicycle leaning against a stone wall" --filename bike.png'
```

You'll get back `Saved: bike.png (image/jpeg, 1K)` and the file on disk.

---

## Next

- **[03 — Client library](./03-client-library.md)** — when you're building the agent itself, embed `@string-os/client` and expose one `string(topic, cmd)` tool that dispatches to every installed SFMD app, including this one.
- **[01 — Anatomy](./01-anatomy.md)** — the structural reference for every line type an SFMD app file can contain.
