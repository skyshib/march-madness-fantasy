#!/usr/bin/env python3
"""
Fetch NCAA tournament box scores from ESPN and update stats.json.

Usage:
  python update_scores.py [--year 2025] [--data-dir ../data]

This script:
1. Loads picks.json to know which players to track
2. Fetches all tournament games from ESPN
3. Aggregates per-player stats (pts, reb, ast) across games
4. Tracks elimination status
5. Writes stats.json

Designed to run via GitHub Actions cron every 10 minutes during tournament games.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("Install dependencies: pip install requests")
    sys.exit(1)


ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball"


def fetch_tournament_games(year):
    """Fetch all NCAA tournament games from ESPN scoreboard."""
    print(f"Fetching {year} tournament games...")

    all_events = []
    # Scan the tournament date range
    url = f"{ESPN_BASE}/scoreboard?groups=100&limit=200&dates={year}0301-{year}0410"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    all_events.extend(data.get("events", []))

    # Also fetch today's games specifically (for live updates)
    today = datetime.now().strftime("%Y%m%d")
    url_today = f"{ESPN_BASE}/scoreboard?groups=100&limit=50&dates={today}"
    try:
        resp2 = requests.get(url_today, timeout=30)
        resp2.raise_for_status()
        data2 = resp2.json()
        today_ids = {e["id"] for e in all_events}
        for event in data2.get("events", []):
            if event["id"] not in today_ids:
                all_events.append(event)
    except Exception as e:
        print(f"  Warning: today's scoreboard fetch failed: {e}")

    print(f"  Found {len(all_events)} tournament events")
    return all_events


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


def fetch_game_boxscore(event_id):
    """Fetch detailed box score for a game."""
    url = f"{ESPN_BASE}/summary?event={event_id}"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return resp.json()


def extract_players_from_boxscore(summary, event_id, game_round):
    """Extract per-player stats from a game summary."""
    players = {}
    boxscore = summary.get("boxscore", {})

    for team_box in boxscore.get("players", []):
        team_info = team_box.get("team", {})
        team_name = team_info.get("displayName", "")
        team_id = team_info.get("id", "")

        for stat_group in team_box.get("statistics", []):
            labels = [l.lower() for l in stat_group.get("labels", [])]
            pts_idx = labels.index("pts") if "pts" in labels else -1
            reb_idx = labels.index("reb") if "reb" in labels else -1
            ast_idx = labels.index("ast") if "ast" in labels else -1

            for athlete_data in stat_group.get("athletes", []):
                athlete = athlete_data.get("athlete", {})
                athlete_id = athlete.get("id")
                if not athlete_id:
                    continue

                stats_row = athlete_data.get("stats", [])
                # Some athletes (DNP) have no stats
                if not stats_row:
                    continue

                # Handle stats that might be "--" for DNP
                def safe_int(idx):
                    if idx < 0 or idx >= len(stats_row):
                        return 0
                    val = stats_row[idx]
                    try:
                        return int(val)
                    except (ValueError, TypeError):
                        return 0

                players[athlete_id] = {
                    "name": athlete.get("displayName", ""),
                    "team": team_name,
                    "team_id": team_id,
                    "game_stats": {
                        "pts": safe_int(pts_idx),
                        "reb": safe_int(reb_idx),
                        "ast": safe_int(ast_idx),
                    },
                    "game_id": event_id,
                    "round": game_round,
                }

    return players


def get_team_seeds(events):
    """Build a map of team_id -> seed from tournament events."""
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
    """Determine which teams have been eliminated (lost a game)."""
    eliminated = set()
    for event in events:
        for comp in event.get("competitions", []):
            status = comp.get("status", {}).get("type", {})
            if status.get("completed", False):
                for team in comp.get("competitors", []):
                    if team.get("winner") is False:
                        eliminated.add(team.get("id"))
    return eliminated


def build_stats(events, tracked_player_ids):
    """
    Build aggregated player stats from all tournament games.
    tracked_player_ids: set of ESPN athlete IDs we care about (from picks.json).
    If empty, track all players.
    """
    team_seeds = get_team_seeds(events)
    eliminated_teams = get_eliminated_teams(events)
    active_games = []

    # player_id -> { name, team, seed, eliminated, stats: {pts, reb, ast}, games: [...] }
    player_stats = {}

    for event in events:
        event_id = event.get("id")
        game_round = classify_round(event)

        # Check game status
        comp = event.get("competitions", [{}])[0]
        status = comp.get("status", {}).get("type", {})
        state = status.get("state", "")

        if state == "pre":
            continue  # Game hasn't started

        if state == "in":
            active_games.append(event_id)

        # Fetch box score
        try:
            summary = fetch_game_boxscore(event_id)
        except Exception as e:
            print(f"  Warning: Failed to fetch box score for event {event_id}: {e}")
            continue

        game_players = extract_players_from_boxscore(summary, event_id, game_round)

        for pid, pdata in game_players.items():
            if tracked_player_ids and pid not in tracked_player_ids:
                continue

            if pid not in player_stats:
                seed = team_seeds.get(pdata["team_id"], 0)
                player_stats[pid] = {
                    "name": pdata["name"],
                    "team": pdata["team"],
                    "seed": seed,
                    "eliminated": pdata["team_id"] in eliminated_teams,
                    "stats": {"pts": 0, "reb": 0, "ast": 0},
                    "games": [],
                }

            gs = pdata["game_stats"]
            player_stats[pid]["stats"]["pts"] += gs["pts"]
            player_stats[pid]["stats"]["reb"] += gs["reb"]
            player_stats[pid]["stats"]["ast"] += gs["ast"]
            player_stats[pid]["eliminated"] = pdata["team_id"] in eliminated_teams
            player_stats[pid]["games"].append({
                "round": pdata["round"],
                "pts": gs["pts"],
                "reb": gs["reb"],
                "ast": gs["ast"],
                "game_id": pdata["game_id"],
            })

    return player_stats, active_games


def load_tracked_players(data_dir):
    """Load the set of player IDs from picks.json that we need to track."""
    picks_path = data_dir / "picks.json"
    if not picks_path.exists():
        return set()

    with open(picks_path) as f:
        picks = json.load(f)

    ids = set()
    for entrant in picks.get("entrants", []):
        for seed, pick in entrant.get("picks", {}).items():
            if pick.get("player_id"):
                ids.add(pick["player_id"])
    return ids


def main():
    parser = argparse.ArgumentParser(description="Update tournament stats from ESPN")
    parser.add_argument("--year", type=int, default=2025)
    parser.add_argument("--data-dir", default=None, help="Path to data directory")
    parser.add_argument("--all-players", action="store_true",
                        help="Track all tournament players, not just those in picks.json")
    args = parser.parse_args()

    if args.data_dir:
        data_dir = Path(args.data_dir)
    else:
        data_dir = Path(__file__).parent.parent / "data"

    # Load tracked players
    tracked = set() if args.all_players else load_tracked_players(data_dir)
    if tracked:
        print(f"Tracking {len(tracked)} players from picks.json")
    else:
        print("Tracking all tournament players")

    # Fetch games
    events = fetch_tournament_games(args.year)
    if not events:
        print("No tournament games found. Exiting.")
        sys.exit(0)

    # Build stats
    print("Fetching box scores...")
    player_stats, active_games = build_stats(events, tracked)

    print(f"\nStats built for {len(player_stats)} players")
    print(f"Active games: {len(active_games)}")

    # Write stats.json
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
