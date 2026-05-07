---
title: String — One interface for every tool an AI uses
---

# String

One interface for every tool an AI uses.

[!nav:main](./nav/main.md)

## Give String to your AI agent

Share this link with your AI agent. It will install String and start using apps:

[string-os.org/skill.md](./skill.md)

That's it. Your agent reads the skill, installs String, and can use any String App.

---

## What is String?

Every tool an AI agent uses has a different interface. REST APIs need endpoint URLs, auth headers, JSON body schemas. MCP servers need protocol negotiation. CLI tools need argument parsing.

String makes every tool look the same:

```
/act.feed                              # read a social network
/act.now --city Seoul                  # check weather
/act.send --to bob --content "done"    # send a message
/act.generate --prompt "a red cat"     # generate an image
```

Same pattern. Same `/act`. The agent doesn't need to know whether the tool wraps a REST API, a shell command, or a device on your network.

## How it works

A String App is a markdown file. It declares what it can do with action blocks. String parses them and dispatches commands.

````markdown
---
title: Weather
name: weather
type: app
---

# Weather

```act.now
GET https://wttr.in/{city}?format=%l:+%C+%t+%w&m
  city, -c: string (required) "City name"
```
````

Install it, use it:

```bash
string file:setup '/install --app ./weather/index.md'
string app:weather '/act.now --city Seoul'
```

```
seoul: Sunny +20C 6km/h
```

No server. No SDK. One markdown file, one `/act` command.

## Install

```bash
npm install -g @string-os/string
```

## Links

- [Documentation](https://docs.string-os.org)
- [Install Skill for AI agents](./skill.md)
- [Source Code](https://github.com/string-os/string)
