#!/usr/bin/env python3
"""
Backfill real PTS/REB/AST from ESPN box scores into stats.json.
Matches ESPN players to existing stats.json entries by normalized name.
"""

import json
import re
import sys
from pathlib import Path

try:
    import requests
except ImportError:
    print("pip install requests")
    sys.exit(1)

ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball"


def normalize(name):
    name = name.strip().lower()
    name = re.sub(r"['\.\-]", "", name)
    name = re.sub(r"\s+(jr|sr|iii|ii|iv|v)$", "", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def fetch_tournament_events(year):
    url = f"{ESPN_BASE}/scoreboard?groups=100&limit=200&dates={year}0301-{year}0410"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return resp.json().get("events", [])


def fetch_boxscore(event_id):
    url = f"{ESPN_BASE}/summary?event={event_id}"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return resp.json()


def extract_player_stats(summary):
    """Extract per-player stats from a game summary."""
    players = {}
    boxscore = summary.get("boxscore", {})
    for team_box in boxscore.get("players", []):
        team_name = team_box.get("team", {}).get("displayName", "")
        for stat_group in team_box.get("statistics", []):
            labels = [l.lower() for l in stat_group.get("labels", [])]
            pts_i = labels.index("pts") if "pts" in labels else -1
            reb_i = labels.index("reb") if "reb" in labels else -1
            ast_i = labels.index("ast") if "ast" in labels else -1

            for ath in stat_group.get("athletes", []):
                athlete = ath.get("athlete", {})
                name = athlete.get("displayName", "")
                stats_row = ath.get("stats", [])
                if not stats_row or not name:
                    continue

                def safe_int(idx):
                    if idx < 0 or idx >= len(stats_row):
                        return 0
                    try:
                        return int(stats_row[idx])
                    except (ValueError, TypeError):
                        return 0

                norm = normalize(name)
                if norm not in players:
                    players[norm] = {"name": name, "team": team_name, "pts": 0, "reb": 0, "ast": 0, "games": []}

                g_pts, g_reb, g_ast = safe_int(pts_i), safe_int(reb_i), safe_int(ast_i)
                players[norm]["pts"] += g_pts
                players[norm]["reb"] += g_reb
                players[norm]["ast"] += g_ast
                players[norm]["games"].append({"pts": g_pts, "reb": g_reb, "ast": g_ast})

    return players


def main():
    data_dir = Path(__file__).parent.parent / "data"
    stats_path = data_dir / "stats.json"

    with open(stats_path) as f:
        stats = json.load(f)

    # Build name -> slug mapping from existing stats
    name_to_slug = {}
    for slug, p in stats["players"].items():
        norm = normalize(p["name"])
        name_to_slug[norm] = slug

    print("Fetching 2025 tournament games from ESPN...")
    events = fetch_tournament_events(2025)
    print(f"  Found {len(events)} events")

    # Collect all player stats across all games
    all_players = {}  # normalized_name -> aggregated stats

    completed = 0
    for event in events:
        event_id = event["id"]
        status = event.get("competitions", [{}])[0].get("status", {}).get("type", {})
        state = status.get("state", "")
        if state == "pre":
            continue

        try:
            summary = fetch_boxscore(event_id)
            game_players = extract_player_stats(summary)

            for norm, pdata in game_players.items():
                if norm not in all_players:
                    all_players[norm] = {"name": pdata["name"], "team": pdata["team"], "pts": 0, "reb": 0, "ast": 0}
                all_players[norm]["pts"] += pdata["pts"]
                all_players[norm]["reb"] += pdata["reb"]
                all_players[norm]["ast"] += pdata["ast"]

            completed += 1
        except Exception as e:
            print(f"  Warning: Failed event {event_id}: {e}")

    print(f"  Fetched box scores for {completed} games, {len(all_players)} unique players")

    # Match and update
    updated = 0
    missing = []
    for slug, p in stats["players"].items():
        norm = normalize(p["name"])
        if norm in all_players:
            espn = all_players[norm]
            old_pts, old_reb, old_ast = p["stats"]["pts"], p["stats"]["reb"], p["stats"]["ast"]
            # Only update reb/ast from ESPN — keep pts from spreadsheet (ESPN includes play-in games)
            p["stats"]["reb"] = espn["reb"]
            p["stats"]["ast"] = espn["ast"]
            if not p.get("team") or p["team"] == "":
                p["team"] = espn["team"]

            if old_reb != espn["reb"] or old_ast != espn["ast"]:
                print(f"  Updated {p['name']:30s}: reb {old_reb:3d}->{espn['reb']:3d}  ast {old_ast:3d}->{espn['ast']:3d}")
                updated += 1
        else:
            missing.append(p["name"])

    print(f"\nUpdated {updated} players")
    if missing:
        print(f"Could not match {len(missing)} players: {', '.join(missing)}")

    # Write back
    with open(stats_path, "w") as f:
        json.dump(stats, f, indent=2)
    print(f"Wrote {stats_path}")

    # Also update 2025 archive
    archive_path = data_dir / "2025" / "stats.json"
    with open(archive_path, "w") as f:
        json.dump(stats, f, indent=2)
    print(f"Wrote {archive_path}")


if __name__ == "__main__":
    main()
