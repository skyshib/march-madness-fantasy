/**
 * ESPN API client for live game data overlay.
 * Fetches box scores client-side for real-time scoring updates.
 */
const ESPN = (() => {
  const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';

  async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`ESPN API ${resp.status}: ${url}`);
    return resp.json();
  }

  /**
   * Fetch the NCAA tournament scoreboard.
   * groups=100 filters to NCAA tournament games.
   */
  async function getTournamentScoreboard() {
    return fetchJSON(`${BASE}/scoreboard?groups=100&limit=100`);
  }

  /**
   * Fetch full game summary (box score) for a given event ID.
   */
  async function getGameSummary(eventId) {
    return fetchJSON(`${BASE}/summary?event=${eventId}`);
  }

  /**
   * Extract player stats from a game summary response.
   * Returns map of ESPN athleteId -> { pts, reb, ast, name, team }.
   */
  function extractPlayerStats(summary) {
    const stats = {};
    const boxScore = summary.boxscore;
    if (!boxScore || !boxScore.players) return stats;

    for (const teamBox of boxScore.players) {
      const teamName = teamBox.team?.displayName || '';
      for (const statGroup of teamBox.statistics || []) {
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
   * Fetch live stats for given game IDs.
   * Returns merged map of ESPN athleteId -> { pts, reb, ast, name, team }.
   */
  async function getLivePlayerStats(gameIds) {
    if (!gameIds || gameIds.length === 0) return {};

    const results = await Promise.allSettled(
      gameIds.map(id => getGameSummary(id))
    );

    const merged = {};
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const gameStats = extractPlayerStats(result.value);
      for (const [athleteId, s] of Object.entries(gameStats)) {
        // If player appears in multiple games (shouldn't happen live),
        // sum their stats
        if (merged[athleteId]) {
          merged[athleteId].pts += s.pts;
          merged[athleteId].reb += s.reb;
          merged[athleteId].ast += s.ast;
        } else {
          merged[athleteId] = { ...s };
        }
      }
    }
    return merged;
  }

  /**
   * Check the scoreboard and return IDs of games currently in progress
   * AND games completed today (so recently-finished games update immediately).
   */
  async function getActiveGameIds() {
    try {
      const data = await getTournamentScoreboard();
      const active = [];
      for (const event of data.events || []) {
        // Skip First Four games
        const notes = event.competitions?.[0]?.notes || [];
        const isFirstFour = notes.some(n => (n.headline || '').toLowerCase().includes('first four'));
        if (isFirstFour) continue;

        for (const comp of event.competitions || []) {
          const state = comp.status?.type?.state;
          // Include in-progress AND recently completed games
          if (state === 'in' || state === 'post') {
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

  /**
   * Check if any games are currently in progress (not just completed).
   */
  async function hasGamesInProgress() {
    try {
      const data = await getTournamentScoreboard();
      for (const event of data.events || []) {
        for (const comp of event.competitions || []) {
          if (comp.status?.type?.state === 'in') return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  return {
    getTournamentScoreboard,
    getGameSummary,
    extractPlayerStats,
    getLivePlayerStats,
    getActiveGameIds,
    hasGamesInProgress,
  };
})();
