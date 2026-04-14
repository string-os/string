---
name: env-test
default: run
env:
  - REQUIRED_VAR: "A required variable"
  - OPTIONAL_VAR: "An optional variable"
    default: fallback
---

```act.run
CLI echo "$REQUIRED_VAR"
```
