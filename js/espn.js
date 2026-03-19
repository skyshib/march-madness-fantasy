/**
 * ESPN API client for live game data overlay.
 * Fetches box scores client-side to fill the gap between GitHub Actions cron runs.
 */
const ESPN = (() => {
  const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';

  async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`ESPN API ${resp.status}: ${url}`);
    return resp.json();
  }

  /**
   * Fetch the NCAA tournament scoreboard for a given date or today.
   * groups=100 filters to NCAA tournament games.
   */
  async function getTournamentScoreboard(dateStr) {
    let url = `${BASE}/scoreboard?groups=100&limit=100`;
    if (dateStr) url += `&dates=${dateStr}`;
    return fetchJSON(url);
  }

  /**
   * Fetch full game summary (box score) for a given event ID.
   */
  async function getGameSummary(eventId) {
    return fetchJSON(`${BASE}/summary?event=${eventId}`);
  }

  /**
   * Extract player stats from a game summary response.
   * Returns map of athleteId -> { pts, reb, ast, name, team }.
   */
  function extractPlayerStats(summary) {
    const stats = {};
    const boxScore = summary.boxscore;
    if (!boxScore || !boxScore.players) return stats;

    for (const teamBox of boxScore.players) {
      const teamName = teamBox.team?.displayName || '';
      for (const statGroup of teamBox.statistics || []) {
        // Find column indices for pts, reb, ast
        const labels = (statGroup.labels || []).map(l => l.toLowerCase());
        const ptsIdx = labels.indexOf('pts');
        const rebIdx = labels.indexOf('reb');
        const astIdx = labels.indexOf('ast');

        for (const athlete of statGroup.athletes || []) {
          const id = athlete.athlete?.id;
          if (!id) continue;
          const row = athlete.stats || [];
          stats[id] = {
            name: athlete.athlete?.displayName || '',
            team: teamName,
            pts: ptsIdx >= 0 ? parseInt(row[ptsIdx]) || 0 : 0,
            reb: rebIdx >= 0 ? parseInt(row[rebIdx]) || 0 : 0,
            ast: astIdx >= 0 ? parseInt(row[astIdx]) || 0 : 0,
          };
        }
      }
    }
    return stats;
  }

  /**
   * Fetch live stats for all active tournament games.
   * Returns a merged map of athleteId -> { pts, reb, ast } for in-progress games only.
   */
  async function getLivePlayerStats(activeGameIds) {
    if (!activeGameIds || activeGameIds.length === 0) return {};

    const results = await Promise.allSettled(
      activeGameIds.map(id => getGameSummary(id))
    );

    const merged = {};
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const gameStats = extractPlayerStats(result.value);
      for (const [athleteId, s] of Object.entries(gameStats)) {
        merged[athleteId] = s;
      }
    }
    return merged;
  }

  /**
   * Check the scoreboard and return IDs of games currently in progress.
   */
  async function getActiveGameIds() {
    try {
      const data = await getTournamentScoreboard();
      const active = [];
      for (const event of data.events || []) {
        for (const comp of event.competitions || []) {
          const state = comp.status?.type?.state;
          if (state === 'in') {
            active.push(event.id);
          }
        }
      }
      return active;
    } catch (e) {
      console.warn('Failed to fetch active games:', e);
      return [];
    }
  }

  return {
    getTournamentScoreboard,
    getGameSummary,
    extractPlayerStats,
    getLivePlayerStats,
    getActiveGameIds,
  };
})();
