/**
 * App initialization, data loading, auto-refresh, and year routing.
 */
(async function () {
  const REFRESH_STATIC_MS = 300000; // 5 min: re-check stats.json from GitHub
  const REFRESH_LIVE_MS = 30000;    // 30 sec: poll ESPN for live game stats
  let currentYear = null;
  let refreshTimer = null;
  let liveTimer = null;
  let lastLiveFetch = null;
  let currentPicks = null;
  let currentStats = null;
  let espnIdToSlug = {};   // ESPN athlete ID -> our slug
  let nameToSlug = {};     // normalized name -> our slug
  let hasActiveGames = false;

  // --- Helpers ---
  async function loadJSON(path) {
    const resp = await fetch(path + '?t=' + Date.now());
    if (!resp.ok) throw new Error(`Failed to load ${path}: ${resp.status}`);
    return resp.json();
  }

  function normalizeName(name) {
    return name.toLowerCase()
      .replace(/['\.\-\u2019]/g, '')
      .replace(/\s+(jr|sr|iii|ii|iv|v)$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function timeAgo(isoStr) {
    if (!isoStr) return 'never';
    const diff = Date.now() - new Date(isoStr).getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 10) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function updateIndicator() {
    const el = document.getElementById('update-indicator');
    if (hasActiveGames && lastLiveFetch) {
      el.textContent = `Live \u2022 ${timeAgo(lastLiveFetch.toISOString())}`;
      el.className = 'update-indicator live';
    } else if (currentStats?.last_updated) {
      el.textContent = `Updated ${timeAgo(currentStats.last_updated)}`;
      el.className = 'update-indicator';
    } else {
      el.textContent = 'No data yet';
      el.className = 'update-indicator';
    }
  }

  /**
   * Build mappings from ESPN athlete ID and name -> our slug.
   * Uses headshots.json (contains ESPN IDs in URLs) and picks.json.
   */
  function buildPlayerMappings(picks, headshots) {
    espnIdToSlug = {};
    nameToSlug = {};

    // Extract ESPN IDs from headshot URLs: .../full/{ID}.png
    for (const [slug, url] of Object.entries(headshots || {})) {
      const match = url.match(/\/full\/(\d+)\.png/);
      if (match) {
        espnIdToSlug[match[1]] = slug;
      }
    }

    // Build name -> slug from picks
    for (const entrant of picks.entrants || []) {
      for (const [seed, pick] of Object.entries(entrant.picks || {})) {
        const norm = normalizeName(pick.name);
        nameToSlug[norm] = pick.player_id;
      }
    }
  }

  /**
   * Translate ESPN live stats (keyed by ESPN athlete ID) to slug-keyed stats.
   */
  function translateLiveStats(espnStats) {
    const translated = {};
    for (const [espnId, stats] of Object.entries(espnStats)) {
      // Try ESPN ID mapping first
      let slug = espnIdToSlug[espnId];
      // Fallback to name matching
      if (!slug && stats.name) {
        slug = nameToSlug[normalizeName(stats.name)];
      }
      if (slug) {
        translated[slug] = stats;
      }
    }
    return translated;
  }

  /**
   * Fetch live ESPN data for active games and update the scoreboard.
   */
  async function refreshLive() {
    if (!currentYear || !currentPicks) return;

    try {
      // Check what games are active right now
      const activeIds = await ESPN.getActiveGameIds();
      hasActiveGames = activeIds.length > 0;

      if (hasActiveGames) {
        // Fetch box scores for all active games
        const espnLiveStats = await ESPN.getLivePlayerStats(activeIds);
        if (Object.keys(espnLiveStats).length > 0) {
          const translated = translateLiveStats(espnLiveStats);
          Scoreboard.setLiveOverrides(translated);
          Scoreboard.render();
        }
        lastLiveFetch = new Date();
      } else {
        // No active games, clear overrides
        Scoreboard.setLiveOverrides({});
        Scoreboard.render();
      }
    } catch (e) {
      console.warn('Live refresh failed:', e);
    }

    updateIndicator();
  }

  // --- Data loading ---
  async function loadYear(year) {
    currentYear = year;
    const config = await loadJSON('data/config.json');
    const isCurrentYear = (year === config.year);

    const dataPrefix = isCurrentYear ? 'data' : `data/${year}`;
    const [picks, stats, headshots, teamLogos] = await Promise.all([
      loadJSON(`${dataPrefix}/picks.json`),
      loadJSON(`${dataPrefix}/stats.json`),
      loadJSON('data/headshots.json').catch(() => ({})),
      loadJSON('data/team_logos.json').catch(() => ({})),
    ]);

    currentPicks = picks;
    currentStats = stats;

    // Build ID mappings for live overlay
    buildPlayerMappings(picks, headshots);

    Scoreboard.setData(picks, stats, headshots, teamLogos);
    Scoreboard.setLiveOverrides({});
    Scoreboard.render();

    // If current year, immediately try live fetch
    if (isCurrentYear) {
      await refreshLive();
    }

    updateIndicator();
  }

  // --- Year selector ---
  async function initYearSelector() {
    const config = await loadJSON('data/config.json');
    const select = document.getElementById('year-select');
    select.innerHTML = '';

    for (const year of config.years_available.sort((a, b) => b - a)) {
      const opt = document.createElement('option');
      opt.value = year;
      opt.textContent = year;
      if (year === config.year) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      loadYear(parseInt(select.value));
    });

    return config.year;
  }

  // --- Auto-refresh ---
  function startTimers() {
    // Slow timer: re-fetch stats.json (picks up cron-committed changes)
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (currentYear) loadYear(currentYear);
    }, REFRESH_STATIC_MS);

    // Fast timer: poll ESPN live data
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(() => {
      if (currentYear) refreshLive();
    }, REFRESH_LIVE_MS);

    // Also update the indicator text every 10s
    setInterval(updateIndicator, 10000);
  }

  // --- View toggle ---
  document.getElementById('view-toggle')?.addEventListener('click', () => {
    const btn = document.getElementById('view-toggle');
    const isCompact = Scoreboard.toggleCompact();
    btn.textContent = isCompact ? 'Full Mode' : 'Compact Mode';
  });

  // --- Detail panel close ---
  document.getElementById('close-detail')?.addEventListener('click', () => {
    Scoreboard.hideDetail();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') Scoreboard.hideDetail();
  });

  // --- Init ---
  try {
    const defaultYear = await initYearSelector();
    await loadYear(defaultYear);
    startTimers();
  } catch (e) {
    console.error('Init failed:', e);
    document.getElementById('scoreboard-body').innerHTML =
      '<tr><td colspan="20" style="text-align:center;padding:2rem;color:var(--text-muted)">Failed to load data. Check console for details.</td></tr>';
  }
})();
