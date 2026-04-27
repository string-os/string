---
title: Nano Banana Pro — Requirements
---

# Requirements

What this app needs before its actions will run, and what to do when
they don't. Read this once at install time. Don't reload it every time
you call the actions — the [main page](./index.md) has everything you
need on a per-call basis.

## Runtime dependencies

- `curl`, `jq`, `base64` — all default in any modern Linux/macOS shell.
  No Python, no SDK, no helper script on disk.

That is the entire dependency list. If you have `string` installed, you
already have all three.

## API key

The actions read `GEMINI_API_KEY` from the daemon's environment. Get a
key at [Google AI Studio](https://aistudio.google.com/apikey), then set
it in the shell that starts `stringd`:

```bash
export GEMINI_API_KEY=...
string --daemon start
```

If `stringd` was already running before you set the key, restart it so
it inherits the new env:

```bash
string --daemon stop && string --daemon start
```

The actions inherit the daemon's process env, so once the daemon is
running with the key, every action call uses it automatically. No
per-call `--api-key` flag.

## Common failures

| Error | Cause | Fix |
|-------|-------|-----|
| `Method doesn't allow unregistered callers` | `GEMINI_API_KEY` not in daemon env | Set the env var, restart daemon |
| `API key not valid` | Wrong or expired key | Get a fresh one at AI Studio |
| `PERMISSION_DENIED` | Key has no `gemini-3-pro-image-preview` access | Enable the model on your Google project |
| `quota exceeded` / `429` | Hit per-minute or per-day rate limit | Wait, or use a different key |
| `Input not found: <path>` (`/act.edit` only) | The path passed as `--input_image` doesn't exist | Verify the file before retrying |
| `unknown error` | Response shape didn't match expectations | Run the same `curl` by hand to see the raw JSON |
| Output is text, not an image | Model refused (safety, ambiguity) | Rephrase the prompt, use the editing template from the main page |

## What this app is not

- **Not a chat interface.** Single-shot generation only. The agent
  manages multi-turn iteration by re-calling with new prompts.
- **Not a batch tool.** One image per call. For a batch, call N times.
- **Not a video generator.** Use a different skill for video.
- **Not self-hosted.** Every call goes to Google's API and consumes API
  quota.

## File extension caveat

The Gemini 3 Pro Image API returns image bytes with mime type
`image/jpeg`, not PNG. Both actions save the raw bytes to whatever path
you provide and report the actual mime type in the success line. If you
care about the extension matching the bytes, name your output `.jpg`
instead of `.png` — the bytes are valid JPEG either way.

## Credit

Adapted from [@steipete](https://clawhub.ai/steipete/nano-banana-pro)'s
`nano-banana-pro` skill on ClawHub. The original ships as a Codex /
Claude Code skill with a 167-line Python helper (`uv run` +
`google-genai` + `pillow`). This SFMD port removes the Python dependency
entirely; the actions call Gemini's REST API directly via `curl` + `jq` +
`base64`.
