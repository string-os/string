---
title: Weather
name: weather
type: app
version: 0.1.0
---

# Weather

A three-action weather app, backed by [wttr.in](https://wttr.in) for the
weather data and [Nominatim](https://nominatim.openstreetmap.org/) (OpenStreetMap)
for resolving city names. No API key, no signup, no server to run.
Works the moment it is installed.

## Actions

- `/act.now --city <name>` — current conditions, one line
- `/act.forecast --city <name>` — detailed forecast with wind and humidity
- `/act.search --q <query>` — resolve a free-form location query (city,
  country, landmark, airport code, ZIP, GPS) to canonical names you can
  pass to `now` / `forecast`. Use this first when the user's location
  is ambiguous (e.g. *"Springfield"*, *"Cambridge"*) or transliterated.

For multi-word cities passed directly to `now` / `forecast`, use `+` in
place of spaces: `--city New+York`. Or pass them through `search` first.

```act.now
GET https://wttr.in/{city}?format=%l:+%C+%t+%w&m
  city: string (required) "City name"
```

```act.forecast
GET https://wttr.in/{city}?format=%l:+%C+%t+%w+%h+%p&m
  city: string (required) "City name"
```

```act.search
GET https://nominatim.openstreetmap.org/search?format=json&limit=5 -H "User-Agent: string-cookbook-weather/0.1"
  q: string (required) "Free-form location query"
```

```act.search.response
{top} = {Response.body[0].display_name}
{lat} = {Response.body[0].lat}
{lon} = {Response.body[0].lon}
Top match: {top}
Coordinates: {lat}, {lon}

Other matches:
- {Response.body[1].display_name}
- {Response.body[2].display_name}
- {Response.body[3].display_name}
- {Response.body[4].display_name}

(Pass the top match to /act.now --city, or the coordinates as --city {lat},{lon})
```
