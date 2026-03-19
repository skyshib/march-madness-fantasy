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
  let knownEliminated = new Set(); // track eliminated player slugs to detect new ones
  let currentHeadshots = {};
  let currentTeamLogos = {};

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
    currentHeadshots = headshots;
    currentTeamLogos = teamLogos;

    // Build ID mappings for live overlay
    buildPlayerMappings(picks, headshots);

    Scoreboard.setData(picks, stats, headshots, teamLogos);
    Scoreboard.setLiveOverrides({});
    Scoreboard.render();

    // Detect newly eliminated players
    if (isCurrentYear) {
      checkForEliminations(picks, stats);
    }

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

  /**
   * Detect newly eliminated players and show dramatic banner.
   */
  function checkForEliminations(picks, stats) {
    const newlyEliminated = [];

    for (const [slug, player] of Object.entries(stats.players || {})) {
      if (player.eliminated && !knownEliminated.has(slug)) {
        const owners = [];
        for (const ent of picks.entrants || []) {
          for (const [seed, pick] of Object.entries(ent.picks || {})) {
            if (pick.player_id === slug) {
              owners.push(ent.name);
            }
          }
        }
        // Get opponent from last game
        const lastGame = player.games?.[player.games.length - 1];
        const opponent = lastGame?.opponent || '';

        if (owners.length > 0) {
          newlyEliminated.push({
            slug,
            name: player.name,
            team: player.team,
            seed: player.seed,
            owners,
            opponent,
          });
        }
        knownEliminated.add(slug);
      }
    }

    const isFirstLoad = knownEliminated.size === 0;
    const recentUpdate = stats.last_updated &&
      (Date.now() - new Date(stats.last_updated).getTime()) < 120000;

    for (const [slug, player] of Object.entries(stats.players || {})) {
      if (player.eliminated) knownEliminated.add(slug);
    }

    if (newlyEliminated.length > 0 && (!isFirstLoad || recentUpdate)) {
      try {
        showEliminationBanner(newlyEliminated);
      } catch (e) {
        console.warn('Elimination banner failed:', e);
      }
    }
  }

  function playEliminationSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();

      // Deep boom
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(80, ctx.currentTime);
      osc1.frequency.exponentialRampToValueAtTime(30, ctx.currentTime + 1.5);
      gain1.gain.setValueAtTime(0.6, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);
      osc1.connect(gain1).connect(ctx.destination);
      osc1.start(); osc1.stop(ctx.currentTime + 1.5);

      // Buzzer
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sawtooth';
      osc2.frequency.setValueAtTime(150, ctx.currentTime);
      osc2.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.8);
      gain2.gain.setValueAtTime(0.3, ctx.currentTime);
      gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
      osc2.connect(gain2).connect(ctx.destination);
      osc2.start(); osc2.stop(ctx.currentTime + 0.8);

      // Second hit
      const osc3 = ctx.createOscillator();
      const gain3 = ctx.createGain();
      osc3.type = 'sine';
      osc3.frequency.setValueAtTime(60, ctx.currentTime + 0.3);
      osc3.frequency.exponentialRampToValueAtTime(20, ctx.currentTime + 2);
      gain3.gain.setValueAtTime(0, ctx.currentTime);
      gain3.gain.setValueAtTime(0.4, ctx.currentTime + 0.3);
      gain3.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2);
      osc3.connect(gain3).connect(ctx.destination);
      osc3.start(); osc3.stop(ctx.currentTime + 2);
    } catch (e) {
      // Audio not available, that's fine
    }
  }

  function showEliminationBanner(eliminated) {
    document.getElementById('elimination-banner')?.remove();
    playEliminationSound();

    const banner = document.createElement('div');
    banner.id = 'elimination-banner';
    banner.className = 'elimination-banner';

    // Skull rain
    for (let i = 0; i < 20; i++) {
      const skull = document.createElement('span');
      skull.className = 'falling-skull';
      skull.textContent = '💀';
      skull.style.left = Math.random() * 100 + '%';
      skull.style.animationDelay = Math.random() * 2 + 's';
      skull.style.animationDuration = (2 + Math.random() * 3) + 's';
      banner.appendChild(skull);
    }

    const content = document.createElement('div');
    content.className = 'elimination-content';

    // Group eliminated players by team
    const byTeam = {};
    for (const p of eliminated) {
      const teamKey = p.team || 'Unknown';
      if (!byTeam[teamKey]) {
        byTeam[teamKey] = { team: teamKey, opponent: p.opponent, seed: p.seed, players: [] };
      }
      byTeam[teamKey].players.push(p);
    }

    // Helper: find team logo by partial match (stats has "Ohio State Buckeyes", logos has "Ohio State")
    function findLogo(teamFullName) {
      if (currentTeamLogos[teamFullName]) return currentTeamLogos[teamFullName];
      for (const [key, url] of Object.entries(currentTeamLogos)) {
        if (teamFullName.toLowerCase().startsWith(key.toLowerCase())) return url;
      }
      return null;
    }

    let html = '';

    for (const [teamName, group] of Object.entries(byTeam)) {
      const logoUrl = findLogo(teamName);
      const logoHtml = logoUrl
        ? `<img class="elim-team-logo" src="${logoUrl}" alt="">`
        : '';

      const seedLabel = group.seed ? `(${group.seed})` : '';

      html += '<div class="elim-team-block">';
      html += '<div class="elimination-title">💀 DOWN GO THE 💀</div>';
      html += `<div class="elim-team-header">${logoHtml}<span class="elim-team-name">${seedLabel} ${teamName}</span></div>`;

      if (group.opponent) {
        html += `<div class="elim-lost-to">Eliminated by ${group.opponent}</div>`;
      }

      // Player cards
      html += '<div class="elim-players">';
      for (const p of group.players) {
        const hsUrl = currentHeadshots[p.slug] || '';
        const hsHtml = hsUrl
          ? `<img class="elim-headshot" src="${hsUrl}" alt="">`
          : '';
        html += '<div class="elim-player-card">';
        html += `${hsHtml}<div class="elim-player-info">`;
        html += `<div class="elim-player-name">${p.name}</div>`;
        html += `<div class="elim-player-owners">☠️ ${p.owners.join(', ')}</div>`;
        html += '</div></div>';
      }
      html += '</div></div>';
    }

    html += '<div class="elim-dismiss">tap to dismiss</div>';

    content.innerHTML = html;
    banner.appendChild(content);

    banner.addEventListener('click', () => {
      banner.classList.add('banner-exit');
      setTimeout(() => banner.remove(), 500);
    });

    document.body.appendChild(banner);
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
