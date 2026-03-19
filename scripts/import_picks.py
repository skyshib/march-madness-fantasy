#!/usr/bin/env python3
"""
Import picks from Google Form CSV export into picks.json.

Usage:
  python import_picks.py <csv_file> [--year 2025] [--output ../data/picks.json]

The CSV should have columns:
  Name, Seed 1, Seed 2, ..., Seed 16, Scorer Captain Seed, Playmaker Captain Seed

The script:
1. Fetches ESPN tournament rosters for the given year
2. Fuzzy-matches player names against ESPN data
3. Validates captain seed constraints
4. Outputs picks.json with ESPN athlete IDs
"""

import argparse
import csv
import json
import sys
import re
from pathlib import Path

try:
    import requests
    from thefuzz import fuzz, process
except ImportError:
    print("Install dependencies: pip install -r requirements.txt")
    sys.exit(1)


ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball"

# Map of seed -> list of team IDs (populated from tournament bracket)
seed_teams = {}
# Map of (team_id, normalized_name) -> { id, name, team, team_id }
player_index = {}
# All players flat list for fuzzy matching
all_players = []


def normalize_name(name):
    """Normalize a player name for matching."""
    name = name.strip()
    # Remove suffixes
    name = re.sub(r'\s+(Jr\.?|Sr\.?|III|II|IV|V)$', '', name, flags=re.IGNORECASE)
    # Remove periods and extra spaces
    name = name.replace('.', '').replace('-', ' ')
    name = re.sub(r'\s+', ' ', name).strip()
    return name.lower()


def fetch_tournament_teams(year):
    """Fetch NCAA tournament teams and their seeds from ESPN."""
    print(f"Fetching {year} NCAA tournament bracket from ESPN...")

    # Try scoreboard with groups=100 (NCAA tournament)
    url = f"{ESPN_BASE}/scoreboard?groups=100&limit=200&dates={year}0301-{year}0410"
    resp = requests.get(url)
    resp.raise_for_status()
    data = resp.json()

    teams_seen = {}  # team_id -> { name, seed }

    for event in data.get("events", []):
        for comp in event.get("competitions", []):
            for team_entry in comp.get("competitors", []):
                tid = team_entry.get("id")
                seed = team_entry.get("curatedRank", {}).get("current")
                if not seed:
                    # Try seed from the competition data
                    seed = int(team_entry.get("seed", 0)) if team_entry.get("seed") else None

                team_name = team_entry.get("team", {}).get("displayName", "")

                if tid and seed and tid not in teams_seen:
                    teams_seen[tid] = {"name": team_name, "seed": int(seed)}
                    seed_teams.setdefault(int(seed), []).append(tid)

    print(f"  Found {len(teams_seen)} tournament teams across {len(seed_teams)} seeds")
    return teams_seen


def fetch_team_roster(team_id, team_name):
    """Fetch roster for a team from ESPN."""
    url = f"{ESPN_BASE}/teams/{team_id}/roster"
    try:
        resp = requests.get(url)
        resp.raise_for_status()
        data = resp.json()

        players = []
        for athlete in data.get("athletes", []):
            player = {
                "id": athlete.get("id"),
                "name": athlete.get("displayName", ""),
                "team": team_name,
                "team_id": team_id,
            }
            players.append(player)
            norm = normalize_name(player["name"])
            player_index[(team_id, norm)] = player
            all_players.append(player)

        return players
    except Exception as e:
        print(f"  Warning: Could not fetch roster for {team_name} ({team_id}): {e}")
        return []


def fetch_all_rosters(teams):
    """Fetch rosters for all tournament teams."""
    print(f"Fetching rosters for {len(teams)} teams...")
    total = 0
    for tid, info in teams.items():
        players = fetch_team_roster(tid, info["name"])
        total += len(players)
    print(f"  Indexed {total} players total")


def match_player(name_input, seed):
    """
    Match a user-entered name to an ESPN player on a team with the given seed.
    Returns (player_dict, confidence, match_type) or (None, 0, 'failed').
    """
    norm_input = normalize_name(name_input)
    candidate_team_ids = seed_teams.get(seed, [])

    if not candidate_team_ids:
        return None, 0, "no_teams_for_seed"

    # 1. Try exact match against players on correct-seed teams
    for tid in candidate_team_ids:
        key = (tid, norm_input)
        if key in player_index:
            return player_index[key], 100, "exact"

    # 2. Fuzzy match against players on correct-seed teams
    candidates = [p for p in all_players if p["team_id"] in candidate_team_ids]
    if not candidates:
        return None, 0, "no_players_for_seed"

    candidate_names = [p["name"] for p in candidates]
    result = process.extractOne(name_input, candidate_names, scorer=fuzz.token_sort_ratio)

    if result:
        matched_name, score, idx = result
        if score >= 85:
            matched_player = candidates[idx]
            return matched_player, score, "fuzzy"
        elif score >= 60:
            matched_player = candidates[idx]
            return matched_player, score, "low_confidence"

    return None, 0, "failed"


def parse_csv(csv_path):
    """Parse the Google Form CSV export."""
    entrants = []
    with open(csv_path, newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames
        print(f"CSV columns: {headers}")

        for row in reader:
            name = row.get("Name", "").strip()
            if not name:
                continue

            picks = {}
            for seed in range(1, 17):
                # Try common column name patterns
                for col_pattern in [f"Seed {seed}", f"Pick {seed}", f"{seed}", f"Seed_{seed}"]:
                    if col_pattern in row and row[col_pattern].strip():
                        picks[seed] = row[col_pattern].strip()
                        break

            # Captain seeds
            scorer_seed = None
            playmaker_seed = None
            for col in headers:
                col_lower = col.lower()
                if 'scorer' in col_lower and 'captain' in col_lower:
                    val = row[col].strip()
                    scorer_seed = int(re.search(r'\d+', val).group()) if re.search(r'\d+', val) else None
                elif 'playmaker' in col_lower and 'captain' in col_lower:
                    val = row[col].strip()
                    playmaker_seed = int(re.search(r'\d+', val).group()) if re.search(r'\d+', val) else None

            entrants.append({
                "name": name,
                "raw_picks": picks,
                "scorer_captain_seed": scorer_seed,
                "playmaker_captain_seed": playmaker_seed,
            })

    print(f"Parsed {len(entrants)} entrants from CSV")
    return entrants


def resolve_entrants(raw_entrants):
    """Resolve all entrant picks against ESPN data."""
    resolved = []
    issues = []

    for entrant in raw_entrants:
        print(f"\n{'='*60}")
        print(f"  {entrant['name']}")
        print(f"{'='*60}")

        picks = {}
        scorer_captain = None
        playmaker_captain = None

        for seed in range(1, 17):
            raw_name = entrant["raw_picks"].get(seed, "")
            if not raw_name:
                issues.append(f"  {entrant['name']}: No pick for seed {seed}")
                continue

            player, confidence, match_type = match_player(raw_name, seed)

            if match_type == "exact":
                symbol = "✓"
                color = "\033[92m"
            elif match_type == "fuzzy" and confidence >= 85:
                symbol = "⚠"
                color = "\033[93m"
            else:
                symbol = "✗"
                color = "\033[91m"

            reset = "\033[0m"

            if player:
                print(f"  {color}{symbol} Seed {seed:2d}: \"{raw_name}\" → {player['name']} ({player['team']}) [{confidence}%]{reset}")
                pick_entry = {
                    "player_id": player["id"],
                    "name": player["name"],
                    "team": player["team"],
                }
                picks[str(seed)] = pick_entry

                if seed == entrant.get("scorer_captain_seed"):
                    scorer_captain = {"seed": seed, **pick_entry}
                if seed == entrant.get("playmaker_captain_seed"):
                    playmaker_captain = {"seed": seed, **pick_entry}
            else:
                print(f"  {color}{symbol} Seed {seed:2d}: \"{raw_name}\" → NO MATCH{reset}")
                issues.append(f"  {entrant['name']}: Seed {seed} \"{raw_name}\" - no match found")

        resolved.append({
            "name": entrant["name"],
            "scorer_captain": scorer_captain,
            "playmaker_captain": playmaker_captain,
            "picks": picks,
        })

    return resolved, issues


def main():
    parser = argparse.ArgumentParser(description="Import March Madness picks from CSV")
    parser.add_argument("csv_file", help="Path to Google Form CSV export")
    parser.add_argument("--year", type=int, default=2025, help="Tournament year (default: 2025)")
    parser.add_argument("--output", default=None, help="Output path for picks.json")
    args = parser.parse_args()

    if not args.output:
        args.output = str(Path(__file__).parent.parent / "data" / "picks.json")

    # Fetch ESPN data
    teams = fetch_tournament_teams(args.year)
    fetch_all_rosters(teams)

    # Parse CSV
    raw_entrants = parse_csv(args.csv_file)

    # Resolve names
    resolved, issues = resolve_entrants(raw_entrants)

    # Report
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    print(f"Resolved: {len(resolved)} entrants")

    if issues:
        print(f"\n⚠ Issues ({len(issues)}):")
        for issue in issues:
            print(f"  {issue}")

    # Confirm
    print(f"\nOutput: {args.output}")
    response = input("Write picks.json? [y/N] ").strip().lower()
    if response != 'y':
        print("Aborted.")
        sys.exit(0)

    # Write
    output = {
        "year": args.year,
        "entrants": resolved,
    }

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
