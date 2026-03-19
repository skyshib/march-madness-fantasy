#!/usr/bin/env python3
"""
Fetch NCAA tournament box scores from ESPN and update stats.json.

Usage:
  python update_scores.py [--year 2026] [--data-dir ../data]

Uses slug-based player IDs (matching picks.json) by building a
name -> slug mapping from picks.json, then matching ESPN box score
players by normalized name.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("Install dependencies: pip install requests")
    sys.exit(1)


ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball"


def normalize_name(name):
    """Normalize a name for matching."""
    name = name.strip().lower()
    name = re.sub(r"['\.\-\u2019]", "", name)
    name = re.sub(r"\s+(jr|sr|iii|ii|iv|v)$", "", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def slugify(name):
    """Create a slug from a player name."""
    s = name.lower().strip()
    s = re.sub(r"['\.\-]", "", s)
    s = re.sub(r"\s+", "-", s)
    return s


def fetch_tournament_games(year):
    """Fetch all NCAA tournament games from ESPN scoreboard."""
    print(f"Fetching {year} tournament games...")
    all_events = []

    url = f"{ESPN_BASE}/scoreboard?groups=100&limit=200&dates={year}0301-{year}0410"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    all_events.extend(resp.json().get("events", []))

    # Also fetch today's games
    today = datetime.now().strftime("%Y%m%d")
    try:
        resp2 = requests.get(f"{ESPN_BASE}/scoreboard?groups=100&limit=50&dates={today}", timeout=30)
        resp2.raise_for_status()
        existing_ids = {e["id"] for e in all_events}
        for event in resp2.json().get("events", []):
            if event["id"] not in existing_ids:
                all_events.append(event)
    except Exception as e:
        print(f"  Warning: today's fetch failed: {e}")

    print(f"  Found {len(all_events)} tournament events")
    return all_events


def get_team_seeds(events):
    """Build team_id -> seed mapping."""
    seeds = {}
    for event in events:
        for comp in event.get("competitions", []):
            for team in comp.get("competitors", []):
                tid = team.get("id")
                seed_val = team.get("curatedRank", {}).get("current")
                if not seed_val:
                    try:
                        seed_val = int(team.get("seed", 0))
                    except (ValueError, TypeError):
                        seed_val = None
                if tid and seed_val:
                    seeds[tid] = int(seed_val)
    return seeds


def get_eliminated_teams(events):
    """Determine which teams have been eliminated."""
    eliminated = set()
    for event in events:
        for comp in event.get("competitions", []):
            if comp.get("status", {}).get("type", {}).get("completed", False):
                for team in comp.get("competitors", []):
                    if team.get("winner") is False:
                        eliminated.add(team.get("id"))
    return eliminated


def classify_round(event):
    """Determine tournament round from event data."""
    notes = event.get("competitions", [{}])[0].get("notes", [])
    for note in notes:
        headline = note.get("headline", "").lower()
        if "first four" in headline:
            return "First Four"
        if "1st round" in headline or "first round" in headline:
            return "R64"
        if "2nd round" in headline or "second round" in headline:
            return "R32"
        if "sweet 16" in headline:
            return "S16"
        if "elite 8" in headline or "elite eight" in headline:
            return "E8"
        if "final four" in headline or "semifinal" in headline:
            return "F4"
        if "championship" in headline or "final" in headline:
            return "Championship"
    return "Unknown"


def get_opponent(comp, team_id):
    """Get the opponent team name for a given team in a competition."""
    for team in comp.get("competitors", []):
        if team.get("id") != team_id:
            return team.get("team", {}).get("displayName", "")
    return ""


def fetch_game_boxscore(event_id):
    """Fetch detailed box score for a game."""
    url = f"{ESPN_BASE}/summary?event={event_id}"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return resp.json()


def load_player_mapping(data_dir):
    """
    Build name -> { slug, team } mapping from picks.json.
    This lets us match ESPN players to our slug-based IDs.
    """
    picks_path = data_dir / "picks.json"
    if not picks_path.exists():
        return {}

    with open(picks_path) as f:
        picks = json.load(f)

    mapping = {}  # normalized_name -> { slug, name, team }
    for entrant in picks.get("entrants", []):
        for seed, pick in entrant.get("picks", {}).items():
            norm = normalize_name(pick["name"])
            mapping[norm] = {
                "slug": pick["player_id"],
                "name": pick["name"],
                "team": pick.get("team", ""),
            }

    return mapping


def main():
    parser = argparse.ArgumentParser(description="Update tournament stats from ESPN")
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--data-dir", default=None)
    parser.add_argument("--all-players", action="store_true")
    args = parser.parse_args()

    data_dir = Path(args.data_dir) if args.data_dir else Path(__file__).parent.parent / "data"

    # Load player name -> slug mapping
    player_mapping = load_player_mapping(data_dir)
    if player_mapping:
        print(f"Tracking {len(player_mapping)} unique players from picks.json")
    else:
        print("No picks.json found, tracking all players")

    # Fetch games
    events = fetch_tournament_games(args.year)
    if not events:
        print("No tournament games found.")
        sys.exit(0)

    team_seeds = get_team_seeds(events)
    eliminated_teams = get_eliminated_teams(events)
    active_games = []

    # slug -> aggregated stats
    player_stats = {}

    print("Fetching box scores...")
    for event in events:
        event_id = event.get("id")
        comp = event.get("competitions", [{}])[0]
        status = comp.get("status", {}).get("type", {})
        state = status.get("state", "")

        if state == "pre":
            continue
        if state == "in":
            active_games.append(event_id)

        game_round = classify_round(event)

        try:
            summary = fetch_game_boxscore(event_id)
        except Exception as e:
            print(f"  Warning: Failed event {event_id}: {e}")
            continue

        boxscore = summary.get("boxscore", {})
        for team_box in boxscore.get("players", []):
            team_info = team_box.get("team", {})
            team_name = team_info.get("displayName", "")
            team_id = team_info.get("id", "")

            # Find opponent
            opponent = get_opponent(comp, team_id)

            for stat_group in team_box.get("statistics", []):
                labels = [l.lower() for l in stat_group.get("labels", [])]
                pts_idx = labels.index("pts") if "pts" in labels else -1
                reb_idx = labels.index("reb") if "reb" in labels else -1
                ast_idx = labels.index("ast") if "ast" in labels else -1

                for athlete_data in stat_group.get("athletes", []):
                    athlete = athlete_data.get("athlete", {})
                    espn_name = athlete.get("displayName", "")
                    stats_row = athlete_data.get("stats", [])
                    if not stats_row or not espn_name:
                        continue

                    def safe_int(idx):
                        if idx < 0 or idx >= len(stats_row):
                            return 0
                        try:
                            return int(stats_row[idx])
                        except (ValueError, TypeError):
                            return 0

                    # Match to our player mapping
                    norm = normalize_name(espn_name)
                    mapped = player_mapping.get(norm)

                    if not mapped and not args.all_players:
                        continue

                    if mapped:
                        slug = mapped["slug"]
                        display_name = mapped["name"]
                    else:
                        slug = slugify(espn_name)
                        display_name = espn_name

                    g_pts = safe_int(pts_idx)
                    g_reb = safe_int(reb_idx)
                    g_ast = safe_int(ast_idx)
                    seed = team_seeds.get(team_id, 0)

                    if slug not in player_stats:
                        player_stats[slug] = {
                            "name": display_name,
                            "team": team_name,
                            "seed": seed,
                            "eliminated": team_id in eliminated_teams,
                            "stats": {"pts": 0, "reb": 0, "ast": 0},
                            "games": [],
                        }

                    player_stats[slug]["stats"]["pts"] += g_pts
                    player_stats[slug]["stats"]["reb"] += g_reb
                    player_stats[slug]["stats"]["ast"] += g_ast
                    player_stats[slug]["eliminated"] = team_id in eliminated_teams

                    player_stats[slug]["games"].append({
                        "round": game_round,
                        "pts": g_pts,
                        "reb": g_reb,
                        "ast": g_ast,
                        "game_id": event_id,
                        "opponent": opponent,
                    })

    print(f"\nStats built for {len(player_stats)} players")
    print(f"Active games: {len(active_games)}")

    output = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "players": player_stats,
        "active_games": active_games,
    }

    stats_path = data_dir / "stats.json"
    with open(stats_path, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"Wrote {stats_path}")


if __name__ == "__main__":
    main()
