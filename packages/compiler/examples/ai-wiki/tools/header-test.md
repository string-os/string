---
name: header-test
default: fetch
---

```act.fetch
GET https://api.example.com/data -H "Authorization: Bearer $TOKEN" -H "X-Custom: test"
```
