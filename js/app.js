/**
 * App initialization, data loading, auto-refresh, and year routing.
 */
(async function () {
  const REFRESH_STATIC_MS = 300000; // 5 min: re-fetch stats.json from GitHub
  const REFRESH_LIVE_MS = 60000;   // 60 sec: poll ESPN for live data
  let currentYear = null;
  let refreshTimer = null;
  let liveTimer = null;
  let currentPicks = null;
  let currentStats = null;
  let currentHeadshots = {};
  let currentTeamLogos = {};
  let espnIdToSlug = {};
  let nameToSlug = {};
  let knownEliminated = new Set();
  let knownCompletedGames = new Set();
  let isFirstLoad = true;
  let lastESPNRefresh = null;

  // --- Helpers ---

  /**
   * Check if a picks.json team name matches an ESPN full team name.
   */
  const TEAM_ALIASES = {
    'penn': 'pennsylvania',
    'uconn': 'connecticut',
    'liu': 'long island',
    'hawaii': "hawai'i",
  };

  // Teams where simple word-stripping fails (1-word school + 2-word mascot)
  const TEAM_ESPN_MAP = {
    'duke': 'duke blue devils',
    'alabama': 'alabama crimson tide',
    'illinois': 'illinois fighting illini',
    'tcu': 'tcu horned frogs',
    'uconn': 'uconn huskies',
    'hawaii': "hawai'i rainbow warriors",
    'tennessee': 'tennessee volunteers',
    'tennessee state': 'tennessee state tigers',
    'michigan': 'michigan wolverines',
    'michigan state': 'michigan state spartans',
    'north carolina': 'north carolina tar heels',
    'north dakota state': 'north dakota state bison',
    'miami': 'miami hurricanes',
    'miami (oh)': 'miami (oh) redhawks',
    'iowa': 'iowa hawkeyes',
    'iowa state': 'iowa state cyclones',
    'texas': 'texas longhorns',
    'texas a&m': 'texas a&m aggies',
    'texas tech': 'texas tech red raiders',
    "saint mary's": "saint mary's gaels",
    'saint louis': 'saint louis billikens',
  };

  function teamsMatch(pickTeam, espnTeam) {
    if (!pickTeam || !espnTeam) return false;
    let pt = pickTeam.toLowerCase().trim();
    const et = espnTeam.toLowerCase().trim();
    pt = TEAM_ALIASES[pt] || pt;
    if (pt === et) return true;
    // If we have an explicit mapping, use ONLY that (avoids Tennessee/Tennessee State conflicts)
    if (pt in TEAM_ESPN_MAP) return TEAM_ESPN_MAP[pt] === et;
    // Strip 1 word: "Gonzaga Bulldogs" -> "Gonzaga"
    const espnWords = et.split(' ');
    const espnSchool1 = espnWords.slice(0, -1).join(' ');
    if (pt === espnSchool1) return true;
    // Strip 2 words: "Prairie View A&M Panthers" -> "Prairie View A&M"
    if (espnWords.length > 3) {
      const espnSchool2 = espnWords.slice(0, -2).join(' ');
      if (pt === espnSchool2) return true;
    }
    return false;
  }

  const NAME_OVERRIDES = {
    'brayden burries': 'brayden burris',
    'peter suder': 'pete suder',
  };

  function normalizeName(name) {
    let n = name.toLowerCase().replace(/['\.\-\u2019]/g, '').replace(/\s+(jr|sr|iii|ii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
    return NAME_OVERRIDES[n] || n;
  }

  function buildPlayerMappings(picks, headshots) {
    espnIdToSlug = {};
    nameToSlug = {};
    for (const [slug, url] of Object.entries(headshots || {})) {
      const match = url.match(/\/full\/(\d+)\.png/);
      if (match) espnIdToSlug[match[1]] = slug;
    }
    for (const entrant of picks.entrants || []) {
      for (const [seed, pick] of Object.entries(entrant.picks || {})) {
        nameToSlug[normalizeName(pick.name)] = pick.player_id;
      }
    }
  }

  function translateLiveStats(espnStats) {
    const translated = {};
    for (const [espnId, stats] of Object.entries(espnStats)) {
      let slug = espnIdToSlug[espnId];
      if (!slug && stats.name) slug = nameToSlug[normalizeName(stats.name)];
      if (slug) translated[slug] = stats;
    }
    return translated;
  }

  async function loadJSON(path) {
    const resp = await fetch(path + '?t=' + Date.now());
    if (!resp.ok) throw new Error(`Failed to load ${path}: ${resp.status}`);
    return resp.json();
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
    if (lastESPNRefresh) {
      el.textContent = `Live \u2022 ${timeAgo(lastESPNRefresh.toISOString())}`;
      el.className = 'update-indicator live';
    } else if (currentStats?.last_updated) {
      el.textContent = `Updated ${timeAgo(currentStats.last_updated)}`;
      el.className = 'update-indicator';
    } else {
      el.textContent = 'No data yet';
      el.className = 'update-indicator';
    }
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

    buildPlayerMappings(picks, headshots);

    Scoreboard.setData(picks, stats, headshots, teamLogos);
    Scoreboard.setLiveOverrides({});

    // Pass live game info for rooting-for feature
    const liveGamesForScoreboard = (stats.live_games || []).map(g => ({
      teams: (g.teams || []).map(t => ({
        name: t.abbrev || t.name,
        fullName: (t.name || '').toLowerCase(),
        seed: t.seed,
      })),
    }));
    Scoreboard.setLiveGames(liveGamesForScoreboard);
    Scoreboard.render();

    // Detect eliminations
    if (isCurrentYear) {
      checkForEliminations(picks, stats);
    }

    // Render live games tracker from cron data
    renderLiveGames(stats);

    // Seed knownCompletedGames and bannerShownForSlugs from ESPN
    // so we don't treat existing completed games as new eliminations
    if (isCurrentYear) {
      try {
        const scoreboard = await ESPN.getTournamentScoreboard();
        for (const event of scoreboard.events || []) {
          const comp = event.competitions?.[0];
          if (comp?.status?.type?.state === 'post') {
            knownCompletedGames.add(event.id);
            // Also mark losing team's players as already shown
            for (const team of comp.competitors || []) {
              if (team.winner === false) {
                const losingTeam = team.team?.displayName || '';
                for (const ent of currentPicks.entrants || []) {
                  for (const [seed, pick] of Object.entries(ent.picks || {})) {
                    if (teamsMatch(pick.team, losingTeam)) {
                      bannerShownForSlugs.add(pick.player_id);
                    }
                  }
                }
              }
            }
          }
        }
      } catch (e) {}
      refreshFromESPN();
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
   * Render live games tracker from stats.json live_games data.
   */
  function renderLiveGames(stats, livePlayerStats) {
    const container = document.getElementById('live-games-container');
    if (!container) return;

    const liveGames = stats.live_games || [];

    if (liveGames.length === 0) {
      container.innerHTML = '';
      return;
    }

    let html = '<div class="live-games">';
    for (const game of liveGames) {
      html += '<div class="live-game-card">';
      html += `<div class="live-game-status">${game.status || 'Live'}</div>`;
      html += '<div class="live-game-matchup">';

      const teams = game.teams || [];
      for (let i = 0; i < teams.length; i++) {
        const t = teams[i];
        const otherScore = parseInt(teams[1 - i]?.score || 0);
        const myScore = parseInt(t.score || 0);
        const isWinning = myScore >= otherScore && (i === 0 || myScore > otherScore);

        html += `<div class="live-game-team ${isWinning ? 'winning' : ''}">`;
        html += `<img class="live-game-logo" src="${t.logo}" alt="" onerror="this.style.display='none'">`;
        html += '<div class="live-game-team-info">';
        html += `<span class="live-game-team-name">(${t.seed}) ${t.abbrev || t.name}</span>`;
        html += `<span class="live-game-score">${t.score}</span>`;
        html += '</div></div>';

        if (i === 0) html += '<div class="live-game-vs">vs</div>';
      }
      html += '</div>';

      // Players grouped by side
      const hasPicks = teams.some(t => {
        for (const ent of currentPicks?.entrants || []) {
          for (const [s, pick] of Object.entries(ent.picks || {})) {
            if (teamsMatch(pick.team, t.name)) return true;
          }
        }
        return false;
      });

      if (hasPicks) {
        html += '<div class="live-game-players-row">';
        for (let i = 0; i < teams.length; i++) {
          const t = teams[i];
          const byPlayer = {};
          for (const ent of currentPicks?.entrants || []) {
            for (const [s, pick] of Object.entries(ent.picks || {})) {
              if (teamsMatch(pick.team, t.name)) {
                if (!byPlayer[pick.name]) byPlayer[pick.name] = { owners: [], slug: pick.player_id };
                let captain = '';
                if (ent.scorer_captain?.player_id === pick.player_id) captain = '👑';
                else if (ent.playmaker_captain?.player_id === pick.player_id) captain = '⛹️';
                byPlayer[pick.name].owners.push({ name: ent.name, captain });
              }
            }
          }
          const align = i === 0 ? 'left' : 'right';
          html += `<div class="live-game-side-picks ${align}">`;
          for (const [player, data] of Object.entries(byPlayer)) {
            data.owners.sort((a, b) => {
              if (a.captain && !b.captain) return -1;
              if (!a.captain && b.captain) return 1;
              return a.name.localeCompare(b.name);
            });
            const count = data.owners.length;
            const ownerList = data.owners.map(o => (o.captain ? o.captain + ' ' : '') + o.name).join(', ');
            const safeOwners = ownerList.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
            // Prefer live ESPN pts, fall back to cron stats
            const livePts = livePlayerStats?.[data.slug]?.pts;
            const cronPts = stats.players?.[data.slug]?.stats?.pts || 0;
            const pts = livePts !== undefined ? livePts : cronPts;
            const ptsHtml = pts > 0 ? ` <span class="live-game-pts">${pts}</span>` : '';
            html += `<div class="live-game-pick" data-owners="${safeOwners}">${count}x ${player}${ptsHtml}</div>`;
          }
          html += '</div>';
          if (i === 0) html += '<div class="live-game-picks-divider"></div>';
        }
        html += '</div>';
      }

      html += '</div>';
    }
    html += '</div>';

    container.innerHTML = html;

    // Attach hover tooltips
    container.querySelectorAll('.live-game-pick[data-owners]').forEach(el => {
      el.addEventListener('mouseenter', (e) => {
        document.getElementById('player-tooltip')?.remove();
        const owners = el.dataset.owners;
        if (!owners) return;
        const playerName = el.textContent.replace(/^\d+x\s*/, '').replace(/\s*\d+$/, '').trim();
        const ownerLines = owners.split(', ').map(o => `<div style="padding:0.1rem 0">${o}</div>`).join('');
        const tip = document.createElement('div');
        tip.id = 'player-tooltip';
        tip.className = 'player-tooltip';
        tip.innerHTML = `<div class="tt-header">${playerName}</div><div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:0.3rem">Picked by</div><div style="font-size:0.8rem;color:var(--text-secondary)">${ownerLines}</div>`;
        document.body.appendChild(tip);
        const rect = el.getBoundingClientRect();
        const tipRect = tip.getBoundingClientRect();
        let left = rect.left + rect.width / 2 - tipRect.width / 2;
        let top = rect.top - tipRect.height - 6;
        if (left < 4) left = 4;
        if (left + tipRect.width > window.innerWidth - 4) left = window.innerWidth - tipRect.width - 4;
        if (top < 4) top = rect.bottom + 6;
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
        tip.classList.add('visible');
      });
      el.addEventListener('mouseleave', () => {
        document.getElementById('player-tooltip')?.remove();
      });
    });
  }

  /**
   * Detect newly eliminated players and show dramatic banner.
   */
  /**
   * Poll ESPN directly for live game data (supplements cron).
   */
  async function refreshFromESPN() {
    if (!currentYear || !currentPicks) return;
    try {
      const data = await ESPN.getTournamentScoreboard();
      const activeIds = [];
      const liveGames = [];
      const newEliminations = [];

      for (const event of data.events || []) {
        const notes = event.competitions?.[0]?.notes || [];
        const isFirstFour = notes.some(n => (n.headline || '').toLowerCase().includes('first four'));
        if (isFirstFour) continue;

        const comp = event.competitions?.[0];
        const state = comp?.status?.type?.state;

        if (state === 'in') {
          activeIds.push(event.id);
          const statusDetail = comp.status?.type?.shortDetail || '';
          const teams = (comp.competitors || []).map(t => ({
            name: t.team?.displayName || '',
            abbrev: t.team?.abbreviation || '',
            seed: t.curatedRank?.current || t.seed || '',
            score: t.score || '0',
            logo: `https://a.espncdn.com/i/teamlogos/ncaa/500/${t.team?.id || ''}.png`,
          }));
          liveGames.push({ id: event.id, status: statusDetail, teams });
        }

        // Detect newly completed games
        if (state === 'post' && !knownCompletedGames.has(event.id)) {
          knownCompletedGames.add(event.id);
          for (const team of comp.competitors || []) {
            if (team.winner === false) {
              const losingTeam = team.team?.displayName || '';
              const losingSeed = team.curatedRank?.current || team.seed || '';
              const winner = comp.competitors.find(t => t.winner === true);
              const winnerName = winner?.team?.displayName || '';

              for (const ent of currentPicks.entrants || []) {
                for (const [seed, pick] of Object.entries(ent.picks || {})) {
                  if (teamsMatch(pick.team, losingTeam)) {
                    const existing = newEliminations.find(e => e.slug === pick.player_id);
                    if (existing) {
                      if (!existing.owners.includes(ent.name)) existing.owners.push(ent.name);
                    } else {
                      newEliminations.push({
                        slug: pick.player_id, name: pick.name,
                        team: losingTeam, seed: losingSeed,
                        owners: [ent.name], opponent: winnerName,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Mark eliminations
      if (newEliminations.length > 0) {
        Scoreboard.markEliminated(newEliminations.map(e => e.slug));
        localStorage.setItem('lastElimination', JSON.stringify({ time: Date.now(), data: newEliminations }));
        try { showEliminationBanner(newEliminations); } catch (e) {}
      }

      // Merge live player stats
      let translatedLive = {};
      if (activeIds.length > 0) {
        const espnLive = await ESPN.getLivePlayerStats(activeIds);
        if (Object.keys(espnLive).length > 0) {
          translatedLive = translateLiveStats(espnLive);
          Scoreboard.setLiveOverrides(translatedLive);
          Scoreboard.render();
        }
      } else {
        Scoreboard.setLiveOverrides({});
        Scoreboard.render();
      }

      // Update live game tracker + rooting-for
      const liveForScoreboard = liveGames.map(g => ({
        teams: g.teams.map(t => ({ name: t.abbrev, fullName: t.name.toLowerCase(), seed: t.seed })),
      }));
      Scoreboard.setLiveGames(liveForScoreboard);

      // Render live games with fresh ESPN player stats
      renderLiveGames({ live_games: liveGames, players: currentStats?.players }, translatedLive);

      lastESPNRefresh = new Date();
      updateIndicator();
    } catch (e) {
      console.warn('ESPN refresh failed:', e);
    }
  }

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

    // Add all currently eliminated to known set AND bannerShownForSlugs
    // so we don't replay sounds/banners for old eliminations
    for (const [slug, player] of Object.entries(stats.players || {})) {
      if (player.eliminated) {
        knownEliminated.add(slug);
        bannerShownForSlugs.add(slug);
      }
    }

    // Clear stale localStorage
    localStorage.removeItem('lastElimination');

    isFirstLoad = false;
  }

  // Pre-warm audio context on first user interaction
  let audioCtx = null;
  document.addEventListener('click', () => {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }, { once: true });

  function playEliminationSound() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t = audioCtx.currentTime;

      const osc1 = audioCtx.createOscillator();
      const gain1 = audioCtx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(80, t);
      osc1.frequency.exponentialRampToValueAtTime(30, t + 1.5);
      gain1.gain.setValueAtTime(0.6, t);
      gain1.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
      osc1.connect(gain1).connect(audioCtx.destination);
      osc1.start(t); osc1.stop(t + 1.5);

      const osc2 = audioCtx.createOscillator();
      const gain2 = audioCtx.createGain();
      osc2.type = 'sawtooth';
      osc2.frequency.setValueAtTime(150, t);
      osc2.frequency.exponentialRampToValueAtTime(50, t + 0.8);
      gain2.gain.setValueAtTime(0.3, t);
      gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
      osc2.connect(gain2).connect(audioCtx.destination);
      osc2.start(t); osc2.stop(t + 0.8);

      const osc3 = audioCtx.createOscillator();
      const gain3 = audioCtx.createGain();
      osc3.type = 'sine';
      osc3.frequency.setValueAtTime(60, t + 0.3);
      osc3.frequency.exponentialRampToValueAtTime(20, t + 2);
      gain3.gain.setValueAtTime(0, t);
      gain3.gain.setValueAtTime(0.4, t + 0.3);
      gain3.gain.exponentialRampToValueAtTime(0.001, t + 2);
      osc3.connect(gain3).connect(audioCtx.destination);
      osc3.start(t); osc3.stop(t + 2);
    } catch (e) {}
  }

  let bannerShownForSlugs = new Set();

  function showEliminationBanner(eliminated) {
    // Don't re-show banner for the same players
    const newSlugs = eliminated.filter(e => !bannerShownForSlugs.has(e.slug));
    if (newSlugs.length === 0) return;
    for (const e of eliminated) bannerShownForSlugs.add(e.slug);

    document.getElementById('elimination-banner')?.remove();
    playEliminationSound();

    const banner = document.createElement('div');
    banner.id = 'elimination-banner';
    banner.className = 'elimination-banner';

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

    const byTeam = {};
    for (const p of eliminated) {
      const teamKey = p.team || 'Unknown';
      if (!byTeam[teamKey]) {
        byTeam[teamKey] = { team: teamKey, opponent: p.opponent, seed: p.seed, players: [] };
      }
      byTeam[teamKey].players.push(p);
    }

    function findLogo(teamFullName) {
      if (currentTeamLogos[teamFullName]) return currentTeamLogos[teamFullName];
      for (const [key, url] of Object.entries(currentTeamLogos)) {
        if (teamFullName.toLowerCase().startsWith(key.toLowerCase())) return url;
      }
      return null;
    }

    let html = '<div class="elimination-title">💀 DOWN GO THE 💀</div>';
    html += '<div class="elim-teams-grid">';

    for (const [teamName, group] of Object.entries(byTeam)) {
      const logoUrl = findLogo(teamName);
      const logoHtml = logoUrl ? `<img class="elim-team-logo" src="${logoUrl}" alt="">` : '';
      const seedLabel = group.seed ? `(${group.seed})` : '';

      html += '<div class="elim-team-block">';
      html += `<div class="elim-team-header">${logoHtml}<span class="elim-team-name">${seedLabel} ${teamName}</span></div>`;

      if (group.opponent) {
        let oppSeed = '';
        for (const [, pl] of Object.entries(currentStats?.players || {})) {
          if (pl.team === group.opponent && pl.seed) {
            oppSeed = `(${pl.seed}) `;
            break;
          }
        }
        html += `<div class="elim-lost-to">Eliminated by ${oppSeed}${group.opponent}</div>`;
      }

      html += '<div class="elim-players">';
      for (const p of group.players) {
        const hsUrl = currentHeadshots[p.slug] || '';
        const hsHtml = hsUrl ? `<img class="elim-headshot" src="${hsUrl}" alt="">` : '';
        const ownerLines = p.owners.map(o => `<span class="owner-line">☠️ ${o}</span>`).join('');
        const playerStats = currentStats?.players?.[p.slug];
        const totalPts = playerStats?.stats?.pts || 0;
        html += '<div class="elim-player-card">';
        html += hsHtml;
        html += '<div class="elim-player-info">';
        html += `<div class="elim-player-name">${p.name}</div>`;
        html += `<div class="elim-player-dates">He scored ${totalPts} points.<br>May he rest in peace.</div>`;
        html += '<div class="elim-player-divider"></div>';
        html += `<div class="elim-player-owners">${ownerLines}</div>`;
        html += '</div></div>';
      }
      html += '</div></div>';
    }

    html += '</div>';
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
    // Slow: re-fetch stats.json (picks up cron commits)
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (currentYear) loadYear(currentYear);
    }, REFRESH_STATIC_MS);

    // Fast: poll ESPN directly every 60s
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(() => {
      if (currentYear) refreshFromESPN();
    }, REFRESH_LIVE_MS);

    setInterval(updateIndicator, 10000);
  }

  // --- View toggle ---
  document.getElementById('view-toggle')?.addEventListener('click', () => {
    const btn = document.getElementById('view-toggle');
    const isCompact = Scoreboard.toggleCompact();
    btn.textContent = isCompact ? 'Full Mode' : 'Compact Mode';
  });

  // --- Bug Report ---
  const bugModal = document.getElementById('bug-modal');
  const bugForm = document.getElementById('bug-form');
  const bugList = document.getElementById('bug-list');

  function loadBugReports() {
    const bugs = JSON.parse(localStorage.getItem('bugReports') || '[]');
    if (bugList) {
      bugList.innerHTML = bugs.length === 0
        ? '<div style="color:var(--text-muted);font-size:0.75rem">No reports yet</div>'
        : bugs.slice(-20).reverse().map(b =>
          `<div class="bug-entry"><span class="bug-entry-name">${b.name}</span> <span class="bug-entry-time">${new Date(b.time).toLocaleString()}</span><br>${b.desc}</div>`
        ).join('');
    }
  }

  document.getElementById('bug-report-btn')?.addEventListener('click', () => {
    bugModal?.classList.remove('hidden');
    loadBugReports();
  });

  document.getElementById('bug-close')?.addEventListener('click', () => {
    bugModal?.classList.add('hidden');
  });

  bugModal?.addEventListener('click', (e) => {
    if (e.target === bugModal) bugModal.classList.add('hidden');
  });

  bugForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('bug-name').value.trim();
    const desc = document.getElementById('bug-desc').value.trim();
    if (!name || !desc) return;

    const report = { name, desc, time: Date.now() };
    const bugs = JSON.parse(localStorage.getItem('bugReports') || '[]');
    bugs.push(report);
    localStorage.setItem('bugReports', JSON.stringify(bugs));

    // Also open a GitHub issue as a backup
    const issueTitle = encodeURIComponent(`[Bug] ${desc.slice(0, 60)}`);
    const issueBody = encodeURIComponent(`Reported by: ${name}\n\n${desc}\n\nTimestamp: ${new Date().toISOString()}`);
    window.open(`https://github.com/skyshib/march-madness-fantasy/issues/new?title=${issueTitle}&body=${issueBody}`, '_blank');

    document.getElementById('bug-status').textContent = '✓ Submitted!';
    bugForm.reset();
    loadBugReports();

    setTimeout(() => {
      document.getElementById('bug-status').textContent = '';
    }, 3000);
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
