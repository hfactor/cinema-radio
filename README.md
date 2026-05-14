# Cinema Radio

A 24×7 browser-based movie station. You tune in and something is already playing — like switching on a channel that was never really off. No browsing, no queue, no deciding what comes next.

Bands let you pick a mood. That's all the choice you get.

---

## How it works

- A GitHub Action runs every morning and generates a schedule from the library
- Each band is a YAML file in `/library` — a curated list of YouTube movies
- The frontend reads the schedule JSON, finds the current slot, and seeks the YouTube player to the exact position so all listeners are in sync
- Durations are fetched automatically via `yt-dlp` — no YouTube API key needed

---

## Adding movies to an existing band

Open the relevant file in `library/` and add an entry:

```yaml
- url: https://www.youtube.com/watch?v=VIDEO_ID
  title: Movie Title
```

Duration is fetched automatically on the next Action run. That's it.

The optional `skip` field lets you trim intros, certificate cards, or credits:

```yaml
- url: https://www.youtube.com/watch?v=VIDEO_ID
  title: Movie Title
  skip: "0:00 - 0:01:30"          # single range

- url: https://www.youtube.com/watch?v=ANOTHER_ID
  title: Another Movie
  skip:
    - "0:00 - 0:02:00"            # opening certificate
    - "2:44:00 - 2:46:00"         # end credits
```

---

## Adding a new band

Create a new file in `library/`:

```yaml
# library/my-band.yaml
name: My Band
movies:
  - url: https://www.youtube.com/watch?v=VIDEO_ID
    title: Movie Title
```

The filename becomes the band ID (`my-band`). It appears on the radio automatically after the next schedule generation. No other config needed.

---

## Running locally

```bash
npm install
node scripts/generate.js --fetch-durations
```

Then serve the project root with any static server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Without `--fetch-durations`, the generator skips movies that don't have a `duration` field and aren't in the local cache. Use the flag the first time you add new movies.

---

## Deployment

Push to GitHub and point GitHub Pages (or Cloudflare Pages) at the root. The included Actions handle the rest.

### GitHub Actions

| Workflow | Schedule | What it does |
|----------|----------|--------------|
| `generate-schedule.yml` | Daily, 5 AM IST | Picks movies, calculates timestamps, commits updated schedules |
| `check-videos.yml` | Weekly, Monday | Pings every URL in the library; opens issues for broken videos, closes them when fixed |

---

## Project structure

```
/
├── library/              ← edit these to add movies
│   ├── comedy-malayalam.yaml
│   ├── thriller-malayalam.yaml
│   └── kairali.yaml
├── schedules/            ← auto-generated, do not edit
│   ├── index.json
│   └── *.json
├── cache/
│   └── durations.json    ← auto-managed duration cache
├── scripts/
│   └── generate.js
├── .github/workflows/
│   ├── generate-schedule.yml
│   └── check-videos.yml
├── config.yaml
├── index.html
├── style.css
└── app.js
```

---

## config.yaml

```yaml
default_band: comedy-malayalam   # band shown on first load
timezone: Asia/Kolkata
movies_per_batch: 15             # slots generated per run
lookahead_hours: 36              # skip generation if already stocked
dedup_hours: 48                  # don't repeat a movie within this window
```

---

## Contributing

Add movies to an existing band, or start a new one. The library grows through the people who use it.

If a video goes down, the weekly health check will open a GitHub Issue automatically. To fix it, replace or remove the entry in the relevant YAML file.
