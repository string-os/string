---
title: Editing
---

String is not read-only. AI creates, modifies, and manages documents
as a core part of its workflow — writing reports, updating configs,
building String apps, maintaining notes.

This section covers how AI edits documents through String.

---

## The editing commands

| Command | What it does |
|---------|-------------|
| `/edit path` | Open raw source with line numbers (same as `/open --edit`) |
| `/write path` | Create a new file or overwrite existing |
| `/write path#block` | Write content to a specific block |
| `/append path` | Add content to the end of a file |
| `/replace path` | Replace exact text in any UTF-8 text file |
| `/replace path --all` | Replace every exact text match |
| `/replace path#block` | Replace a block's content |
| `/replace path:L5` | Replace a single line |
| `/replace path:L5-L10` | Replace a range of lines |
| `/refresh` | Reload the current document |
| `/ls [path]` | List files in the workspace |

`/edit` is a view command — it opens the document in raw mode so the
AI can see the actual source. All modifications go through `/write`,
`/append`, and `/replace`.

---

## Creating a document

`/write` creates a new file or overwrites an existing one entirely.

```
<𝒞=string:notes>
/write ~/notes/meeting.md
---
title: Team Meeting
---

# Meeting Notes — 2026-03-18

## Attendees
- Alice
- Bob

<!-- #decisions -->
## Decisions
(none yet)
<!-- /decisions -->

<!-- #action-items -->
## Action Items
- [ ] Alice: review proposal
- [ ] Bob: update timeline
<!-- /action-items -->
</𝒞>
```

The file is created at `~/notes/meeting.md` with the full content.
Block markers are included from the start — this makes the document
addressable for later edits.

### Overwrite warning

If the file already exists, `/write` replaces it entirely. This is
intentional — sometimes you want a clean rewrite. But it means the
AI should read a file before overwriting to avoid losing content
it didn't intend to remove.

String enforces this for existing files: whole-file `/write` and
whole-file `/edit` refuse to overwrite a file the current topic has
not read yet. Run `/open path` or `/edit path` first, then retry. If
you intentionally want a blind whole-file overwrite, pass `--force`:

```
/write --force ~/notes/meeting.md
replacement content
```

---

## Appending content

`/append` adds content to the end of an existing file.

```
<𝒞=string:notes>
/append ~/notes/meeting.md

## Follow-up
Next meeting scheduled for 2026-03-25.
</𝒞>
```

This is useful for:
- Logs and journals (add entries over time)
- Growing documents (new sections added incrementally)
- Notes that accumulate during a session

---

## Replacing content

`/replace` is the precision tool. It targets exact text, a block, or a
line range and replaces just that portion. Everything else stays
untouched.

### Replace exact text

Use exact text replacement for ordinary text files, config files, code
snippets, and documents without stable block markers.

```
/replace config.env
API_URL=http://localhost:3000
---
API_URL=https://api.example.com
```

If the old text appears exactly once, String replaces it. If it does
not appear, String returns `NOT_FOUND`. If it appears more than once,
String refuses the edit as ambiguous and tells the AI to either provide
a larger unique old text or use `--all`:

```
/replace config.env --all
dev
---
prod
```

### Replace a block

```
/replace ~/notes/meeting.md#decisions
## Decisions
1. Move deadline to April 1
2. Switch to weekly syncs
```

Before:

```markdown
<!-- #decisions -->
## Decisions
(none yet)
<!-- /decisions -->
```

After:

```markdown
<!-- #decisions -->
## Decisions
1. Move deadline to April 1
2. Switch to weekly syncs
<!-- /decisions -->
```

The block markers stay. The AI sends only the replacement content.

### Replace a line

After `/edit` shows line numbers, the AI can topic specific lines:

```
/replace ~/notes/meeting.md:L13
1. Move deadline to April 1
```

Line 13 (`(none yet)`) is replaced with the new content. One line
in, one line out.

### Replace a line range

```
/replace ~/notes/meeting.md:L18-L19
- [ ] Alice: review proposal (updated scope)
- [ ] Bob: update timeline to April
- [ ] Carol: prepare demo
```

Lines 18–19 are replaced with three new lines. The range can expand
or shrink — the rest of the file adjusts.

### When to use which

| Topic | Use when |
|--------|----------|
| `#block` | Content has named blocks — the preferred approach |
| `:L5` | Quick single-line fix, no block available |
| `:L5-L10` | Multi-line change in a region without block markers |

Block-based editing is preferred because block IDs are stable —
they don't shift when lines are added above. Line numbers change
after every edit, so always `/edit` again to get fresh line numbers
before a second line-based replace.

---

## Writing to blocks

`/write` can topic blocks too. The difference from `/replace`:

- `/replace path#block` — replaces the block content, keeps markers
- `/write path#block` — overwrites the block content, keeps markers

Both keep the `<!-- #id -->` / `<!-- /id -->` markers. The distinction
is semantic: use `/replace` when updating existing content, `/write`
when setting content regardless of what was there.

```
/write ~/notes/meeting.md#decisions
## Decisions
No decisions were made in this meeting.
```

For a new file, `/write path` creates the entire file. For an
existing file, `/write path#block` topics just one section.

---

## Edit mode

`/edit` (or `/open --edit`) opens the raw SFMD source with line
numbers. Unlike `/open`, which renders the document for reading,
`/edit` shows everything — block markers, directives, frontmatter,
action spec blocks — exactly as written.

```
/edit ~/notes/meeting.md
```

```
  1 │ ---
  2 │ title: Team Meeting
  3 │ ---
  4 │
  5 │ # Meeting Notes — 2026-03-18
  6 │
  7 │ ## Attendees
  8 │ - Alice
  9 │ - Bob
 10 │
 11 │ <!-- #decisions -->
 12 │ ## Decisions
 13 │ (none yet)
 14 │ <!-- /decisions -->
 15 │
 16 │ <!-- #action-items -->
 17 │ ## Action Items
 18 │ - [ ] Alice: review proposal
 19 │ - [ ] Bob: update timeline
 20 │ <!-- /action-items -->
```

The AI now sees:
- **Line numbers** — for line-based `/replace`
- **Block markers** — `<!-- #decisions -->` at line 11, topic with `#decisions`
- **Frontmatter** — the raw YAML, normally hidden in `/open` view
- **Directives** — nav, action specs, everything the parsed view strips

This is the AI's equivalent of "View Source". It doesn't change the
file — it shows the file as it actually is.

---

## Editing feedback

Every editing command returns a diff-style feedback showing exactly
what changed, with surrounding context. The AI never guesses — it
sees the before and after.

### Block replace feedback

```
/replace ~/notes/meeting.md#decisions
## Decisions
1. Move deadline to April 1
2. Switch to weekly syncs
```

```
✓ ~/notes/meeting.md#decisions — Added 2 lines, removed 1 line

 11  │ <!-- #decisions -->
 12  │ ## Decisions
 13 -│ (none yet)
 13 +│ 1. Move deadline to April 1
 14 +│ 2. Switch to weekly syncs
 15  │ <!-- /decisions -->
```

The feedback shows:
- Summary of the change (lines added/removed)
- Context lines (unchanged, with line numbers)
- Removed lines marked with `-`
- Added lines marked with `+`

The AI immediately sees what was replaced and where, without a
separate readback step.

### Line replace feedback

```
/replace ~/notes/meeting.md:L18-L19
- [ ] Alice: review proposal (updated scope)
- [ ] Bob: update timeline to April
- [ ] Carol: prepare demo
```

```
✓ ~/notes/meeting.md:L18-L19 — Added 3 lines, removed 2 lines

 16  │ <!-- #action-items -->
 17  │ ## Action Items
 18 -│ - [ ] Alice: review proposal
 19 -│ - [ ] Bob: update timeline
 18 +│ - [ ] Alice: review proposal (updated scope)
 19 +│ - [ ] Bob: update timeline to April
 20 +│ - [ ] Carol: prepare demo
 21  │ <!-- /action-items -->
```

### Write and append feedback

```
/write ~/notes/new-doc.md
# New Document
Content here.
```

```
✓ created ~/notes/new-doc.md (3 lines)
```

```
/append ~/notes/meeting.md
## Follow-up
Next meeting: 2026-03-25
```

```
✓ ~/notes/meeting.md — Appended 2 lines (22 total)

 20  │ <!-- /action-items -->
 21  │
 22 +│ ## Follow-up
 23 +│ Next meeting: 2026-03-25
```

New file creation shows a simple confirmation. Appends show the
tail of the file with added lines marked.

### Error feedback

```
/replace ~/notes/meeting.md#nonexistent
New content here
```

```
✗ block #nonexistent not found in ~/notes/meeting.md
  available blocks: #decisions, #action-items
```

```
/replace ~/notes/meeting.md:L50
New content here
```

```
✗ line 50 out of range in ~/notes/meeting.md (20 lines)
```

Errors include actionable context — available block IDs, actual
line count — so the AI can correct and retry without an extra
round trip.

Every modification command returns feedback. The AI always knows
what happened.

---

## Auto-save and undo

Every edit is saved immediately. There is no explicit save command —
`/write`, `/append`, and `/replace` all persist to disk the moment
they execute. The diff feedback the AI receives confirms the save.

### /undo

String keeps the state from before the current topic's last edit.
`/undo` reverts to that state — one time only.

```
/replace ~/notes/meeting.md#decisions
## Decisions
1. Wrong decision

/undo
```

```
✓ ~/notes/meeting.md — Reverted last change

 11  │ <!-- #decisions -->
 12  │ ## Decisions
 13 -│ 1. Wrong decision
 13 +│ (none yet)
 14  │ <!-- /decisions -->
```

Each topic has one undo record. After another edit in the same topic,
that topic's previous undo is gone:

```
/replace meeting.md#decisions    ← topic undo: previous state
/replace meeting.md#action-items ← topic undo: overwritten
/undo                            ← undoes #action-items, NOT #decisions
```

This is deliberately simple. One level of undo is a safety net,
not a full history system. In a git repository, use git for durable
version history and String's editing commands for the immediate write.
Undo records are stored in String's daemon state directory, not beside
the edited files, so they do not create `.undo` files in the workspace.

---

## Workspace boundaries

All file operations are scoped to the AI's workspace. The AI cannot
write to arbitrary system paths — only to files within its home
directory or the configured workspace root.

```
/write ~/docs/report.md         ← OK (within workspace)
/write /etc/passwd              ← BLOCKED (outside workspace)
/write ../../../etc/passwd      ← BLOCKED (path traversal)
```

String validates all paths before executing. Symlinks that escape
the workspace boundary are also rejected.

---

## Practical workflows

### Write a report from research

```
# 1. Research across multiple topics
<𝒞=string:docs>
/open https://api.example.com/docs
</𝒞>

<𝒞=string:stats>
/open https://analytics.example.com/dashboard
</𝒞>

# 2. Create the report
<𝒞=string:reports>
/write ~/reports/q1.md
---
title: Q1 Report
---

# Q1 Performance Report

<!-- #summary -->
## Summary
Revenue grew 15% quarter-over-quarter...
<!-- /summary -->

<!-- #details -->
## Detailed Analysis
...
<!-- /details -->
</𝒞>
```

AI reads from one tab, writes from another. Multiple sources,
single output — same topic type, different sessions.

### Iterative editing

```
# 1. Open and review
/open ~/docs/proposal.md

# 2. Switch to edit mode to see structure
/edit ~/docs/proposal.md

# 3. Update just the budget section
/replace ~/docs/proposal.md#budget
## Budget
Revised total: $45,000
- Engineering: $25,000
- Design: $12,000
- Testing: $8,000

# 4. Verify the change
/open ~/docs/proposal.md#budget
```

### Build an String app

```
# 1. Create the nav file
/write ~/my-app/nav/main.md
[@home Home](../string.md)
[@search Search](../search.md)
[@settings Settings](../settings.md)

# 2. Create the main page
/write ~/my-app/string.md
---
title: My App
---

[!nav:main](./nav/main.md)

# My App

Welcome. Use search to find anything.

`/act.search --q "{query}"`

# 3. Create the search page with action spec
/write ~/my-app/search.md
---
title: Search
---

[!nav:main](./nav/main.md)

# Search

`/act.search --q "{query}"`

```act.search
GET https://api.example.com/search
  q: string (required)
```

```act.search.response
{count} = {Response.body.total}
## Results ({count})
{Response.body.results}
```
```

AI creates a multi-page String app — nav file, pages, action specs,
response templates — all through String's editing commands.

---

## Summary

| Command | Use when |
|---------|----------|
| `/edit path` | View raw source with line numbers |
| `/write path[#block]` | Create a new file, full rewrite, or write to block |
| `/append path` | Add content to the end |
| `/replace path` | Replace exact text; fails if the old text is ambiguous |
| `/replace path --all` | Replace every exact text match |
| `/replace path#block` | Replace a block's content |
| `/replace path:L5[-L10]` | Replace a line or line range |
| `/undo` | Revert the last edit (one time only) |
| `/refresh` | Reload document after changes |

| Principle | Why |
|-----------|-----|
| **Auto-save** | Every edit saves immediately, no explicit save |
| **`/edit` first** | See raw source, line numbers, block IDs before modifying |
| **Prefer blocks** | Stable IDs, don't shift — unlike line numbers |
| **Diff feedback** | Every edit returns before/after context |
| **1-time `/undo`** | Safety net for the last edit |
| **Workspace boundary** | All writes scoped to AI's workspace |
