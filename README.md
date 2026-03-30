# March Madness Fantasy

A live scoreboard for a friends-and-family March Madness fantasy game, hosted on GitHub Pages.

**Live site:** [skyshib.github.io/march-madness-fantasy](https://skyshib.github.io/march-madness-fantasy/)

## How It Works

Each entrant drafts one NCAA player per tournament seed (1-16), plus two captain designations:
- **Scorer Captain** (seed 5-10 or 11-16): earns 1.5x their points
- **Playmaker Captain** (the other range): earns points + rebounds + assists

Players accumulate stats across all tournament games their team plays. The entrant with the most total fantasy points wins.

## Architecture

Static HTML/CSS/JS site with automated score updates:

- **Frontend** (`index.html`, `js/`, `css/`): Renders the scoreboard, auto-refreshes every 2 minutes, and polls ESPN client-side for live game data
- **GitHub Actions cron** (`.github/workflows/update-scores.yml`): Runs every hour during the tournament, fetches box scores from the ESPN API, computes player stat totals, and commits updated `stats.json`
- **Data** (`data/`): Picks and stats stored as JSON, with historical data for 2022-2025

## Features

- Live scoreboard with rank, total points, and per-seed player breakdown
- Player headshots and team logos from ESPN CDN
- Expandable detail panels showing per-game stats and opponents
- Elimination detection with dramatic "DOWN GOES" banner and sound effect
- Live game tracker showing in-progress scores
- Conditional formatting (red/green) for player performance relative to field
- Year selector for historical data (2022-2025)
- "Report a bug" feature

## Scoring

```
For each entrant:
  total = 0
  for each seed 1-16:
    player = entrant.picks[seed]
    if player is scorer_captain:
      total += player.pts * 1.5
    elif player is playmaker_captain:
      total += player.pts + player.reb + player.ast
    else:
      total += player.pts
```

## Data Flow

```
Google Form (picks) --> import script --> picks.json
ESPN API (box scores) --> update_scores.py --> stats.json --> GitHub Pages
Browser polls ESPN for live games between cron updates
```

## Project Structure

```
index.html                     Main scoreboard page
css/style.css                  Styling (dark theme, responsive)
js/
  app.js                       Init, auto-refresh, live game tracker, elimination detection
  scoreboard.js                Score calculation, captain logic, rendering
  espn.js                      ESPN API client (live game overlay)
data/
  config.json                  Tournament year, settings
  picks.json                   Current year entrant picks
  stats.json                   Current year player stats (auto-updated)
  headshots.json               ESPN headshot URLs
  team_logos.json               ESPN team logo URLs
  2022/-2025/                  Historical picks and stats
scripts/
  update_scores.py             ESPN API --> stats.json (used by cron + manual)
  import_picks.py              Google Form CSV --> picks.json
  import_2026.py               2026-specific import with name/team overrides
  convert_xlsx.py              XLSX to JSON converter
  backfill_stats.py            Backfill historical stats from ESPN
  requirements.txt             Python dependencies (requests)
.github/workflows/
  update-scores.yml            Cron: every hour during tournament
```

## Setup

1. Clone the repo
2. `pip install -r scripts/requirements.txt`
3. Import picks: `python3 scripts/import_picks.py`
4. Update scores: `python3 scripts/update_scores.py`
5. Push to GitHub — Pages deploys automatically

## Payouts

| Place | Prize |
|-------|-------|
| 1st   | $500  |
| 2nd   | $300  |
| 3rd   | $250  |
| 4th   | $150  |
| 5th   | $50   |
