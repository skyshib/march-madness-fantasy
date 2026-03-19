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

  /**
   * Check if a picks.json team name matches an ESPN full team name.
   * ESPN uses "Michigan Wolverines", "Michigan State Spartans", etc.
   * We strip the last word (mascot) from ESPN name and compare.
   */
  function teamsMatch(pickTeam, espnTeam) {
    if (!pickTeam || !espnTeam) return false;
    const pt = pickTeam.toLowerCase().trim();
    const et = espnTeam.toLowerCase().trim();
    // Exact match
    if (pt === et) return true;
    // Strip last word (mascot) from ESPN name: "Michigan State Spartans" -> "Michigan State"
    const espnWords = et.split(' ');
    const espnSchool = espnWords.slice(0, -1).join(' ');
    if (pt === espnSchool) return true;
    // Handle two-word mascots: "North Carolina Tar Heels" -> "North Carolina"
    // Only if stripping 2 words still leaves at least 2 words (avoids "Michigan State Spartans" -> "Michigan")
    if (espnWords.length > 3) {
      const espnSchool2 = espnWords.slice(0, -2).join(' ');
      if (pt === espnSchool2) return true;
    }
    return false;
  }

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

  let knownCompletedGames = new Set(); // track game IDs we've already processed

  /**
   * Fetch live ESPN data for active games and update the scoreboard.
   * Also detect newly completed games for elimination banners.
   */
  async function refreshLive() {
    if (!currentYear || !currentPicks) return;

    try {
      const data = await ESPN.getTournamentScoreboard();
      const activeIds = [];
      const gameStatusByTeam = {}; // lowercase team prefix -> status string
      const newEliminations = [];

      for (const event of data.events || []) {
        // Skip First Four
        const notes = event.competitions?.[0]?.notes || [];
        const isFirstFour = notes.some(n => (n.headline || '').toLowerCase().includes('first four'));
        if (isFirstFour) continue;

        const comp = event.competitions?.[0];
        const state = comp?.status?.type?.state;

        if (state === 'in') {
          activeIds.push(event.id);
          const statusDetail = comp.status?.type?.shortDetail || '';
          for (const team of comp.competitors || []) {
            const tn = team.team?.displayName?.toLowerCase() || '';
            gameStatusByTeam[tn] = statusDetail;
          }
        }

        // Detect newly completed games
        if (state === 'post' && !knownCompletedGames.has(event.id)) {
          knownCompletedGames.add(event.id);

          // Find the losing team
          for (const team of comp.competitors || []) {
            if (team.winner === false) {
              const losingTeam = team.team?.displayName || '';
              const losingSeed = team.curatedRank?.current || team.seed || '';
              const winnerTeam = comp.competitors.find(t => t.winner === true);
              const winnerName = winnerTeam?.team?.displayName || '';
              const winnerSeed = winnerTeam?.curatedRank?.current || winnerTeam?.seed || '';

              // Find players from this team in our picks
              for (const ent of currentPicks.entrants || []) {
                for (const [seed, pick] of Object.entries(ent.picks || {})) {
                  const playerTeam = pick.team?.toLowerCase() || '';
                  if (teamsMatch(pick.team, losingTeam)) {
                    // This entrant had a player on the losing team
                    const existing = newEliminations.find(e => e.slug === pick.player_id);
                    if (existing) {
                      if (!existing.owners.includes(ent.name)) existing.owners.push(ent.name);
                    } else {
                      newEliminations.push({
                        slug: pick.player_id,
                        name: pick.name,
                        team: losingTeam,
                        seed: losingSeed,
                        owners: [ent.name],
                        opponent: winnerName,
                        opponentSeed: winnerSeed,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Mark newly eliminated players in the scoreboard stats
      if (newEliminations.length > 0) {
        Scoreboard.markEliminated(newEliminations.map(e => e.slug));
      }

      hasActiveGames = activeIds.length > 0;

      if (activeIds.length > 0) {
        const espnLiveStats = await ESPN.getLivePlayerStats(activeIds);
        if (Object.keys(espnLiveStats).length > 0) {
          const translated = translateLiveStats(espnLiveStats);
          // Attach game clock to each live player
          for (const [slug, stats] of Object.entries(translated)) {
            const teamLower = (stats.team || '').toLowerCase();
            for (const [tn, status] of Object.entries(gameStatusByTeam)) {
              if (tn.startsWith(teamLower.split(' ')[0]) || teamLower.startsWith(tn.split(' ')[0])) {
                stats.gameStatus = status;
                break;
              }
            }
          }
          Scoreboard.setLiveOverrides(translated);
          Scoreboard.render();
        }
        lastLiveFetch = new Date();
      } else {
        Scoreboard.setLiveOverrides({});
        Scoreboard.render();
      }

      renderLiveGames(data);

      // Show elimination banner for newly completed games
      if (newEliminations.length > 0) {
        // Store elimination time in localStorage for the 5-min refresh window
        localStorage.setItem('lastElimination', JSON.stringify({
          time: Date.now(),
          data: newEliminations,
        }));
        try {
          showEliminationBanner(newEliminations);
        } catch (e) {
          console.warn('Elimination banner failed:', e);
        }
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
   * Render live games tracker above the scoreboard.
   */
  function renderLiveGames(espnData) {
    const container = document.getElementById('live-games-container');
    if (!container) return;

    const games = [];
    for (const event of espnData.events || []) {
      const comp = event.competitions?.[0];
      const state = comp?.status?.type?.state;
      if (state !== 'in') continue;

      // Skip First Four
      const notes = comp.notes || [];
      if (notes.some(n => (n.headline || '').toLowerCase().includes('first four'))) continue;

      const statusDetail = comp.status?.type?.shortDetail || '';
      const teams = comp.competitors || [];

      const gameInfo = { id: event.id, status: statusDetail, sides: [] };

      for (const team of teams) {
        const teamName = team.team?.displayName || '';
        const teamShort = team.team?.abbreviation || '';
        const seed = team.curatedRank?.current || team.seed || '';
        const score = team.score || '0';
        const logoId = team.team?.id;
        const logoUrl = logoId ? `https://a.espncdn.com/i/teamlogos/ncaa/500/${logoId}.png` : '';

        // Find picked players on this team
        const pickedPlayers = [];
        for (const ent of currentPicks?.entrants || []) {
          for (const [s, pick] of Object.entries(ent.picks || {})) {
            if (teamsMatch(pick.team, teamName)) {
              let captain = '';
              if (ent.scorer_captain?.player_id === pick.player_id) captain = '👑';
              else if (ent.playmaker_captain?.player_id === pick.player_id) captain = '⛹️';
              pickedPlayers.push({ player: pick.name, owner: ent.name, slug: pick.player_id, captain });
            }
          }
        }

        gameInfo.sides.push({ teamName, teamShort, seed, score, logoUrl, pickedPlayers });
      }

      games.push(gameInfo);
    }

    // Pass game info to Scoreboard for name hover tooltips
    const liveGamesForScoreboard = games.map(g => ({
      teams: g.sides.map(s => ({
        name: s.teamShort,
        fullName: s.teamName.toLowerCase(),
        seed: s.seed,
      })),
    }));
    Scoreboard.setLiveGames(liveGamesForScoreboard);

    if (games.length === 0) {
      container.innerHTML = '';
      return;
    }

    let html = '<div class="live-games">';
    for (const game of games) {
      html += '<div class="live-game-card">';
      html += `<div class="live-game-status">${game.status}</div>`;
      html += '<div class="live-game-matchup">';

      for (let i = 0; i < game.sides.length; i++) {
        const s = game.sides[i];
        const isWinning = i === 0
          ? parseInt(s.score) >= parseInt(game.sides[1]?.score || 0)
          : parseInt(s.score) > parseInt(game.sides[0]?.score || 0);

        html += `<div class="live-game-team ${isWinning ? 'winning' : ''}">`;
        html += `<img class="live-game-logo" src="${s.logoUrl}" alt="" onerror="this.style.display='none'">`;
        html += `<div class="live-game-team-info">`;
        html += `<span class="live-game-team-name">(${s.seed}) ${s.teamShort}</span>`;
        html += `<span class="live-game-score">${s.score}</span>`;
        html += '</div></div>';

        if (i === 0) html += '<div class="live-game-vs">vs</div>';
      }
      html += '</div>';

      // Players at stake
      // Players grouped by side — show (count) Name pts
      const hasPicks = game.sides.some(s => s.pickedPlayers.length > 0);
      if (hasPicks) {
        // Get live box score stats for this game
        const gameStats = {};
        try {
          // Use already-fetched live data from Scoreboard overrides
          // Match players by name to get their current pts
        } catch (e) {}

        html += '<div class="live-game-players-row">';
        for (let i = 0; i < game.sides.length; i++) {
          const s = game.sides[i];
          const byPlayer = {};
          for (const pp of s.pickedPlayers) {
            if (!byPlayer[pp.player]) byPlayer[pp.player] = { owners: [], slug: pp.slug };
            byPlayer[pp.player].owners.push({ name: pp.owner, captain: pp.captain });
          }
          const align = i === 0 ? 'left' : 'right';
          html += `<div class="live-game-side-picks ${align}">`;
          for (const [player, data] of Object.entries(byPlayer)) {
            data.owners.sort((a, b) => {
              // Captains first, then alphabetical
              if (a.captain && !b.captain) return -1;
              if (!a.captain && b.captain) return 1;
              return a.name.localeCompare(b.name);
            });
            const count = data.owners.length;
            const ownerList = data.owners.map(o => (o.captain ? o.captain + ' ' : '') + o.name).join(', ');
            // Get live pts from Scoreboard overrides
            const liveData = Scoreboard.getLiveOverride?.(data.slug);
            const ptsHtml = liveData ? ` <span class="live-game-pts">${liveData.pts}</span>` : '';
            const safeOwners = ownerList.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
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

    // Attach custom hover tooltips to live game player picks
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

    // Add all currently eliminated to known set
    for (const [slug, player] of Object.entries(stats.players || {})) {
      if (player.eliminated) {
        knownEliminated.add(slug);
        knownCompletedGames.add(player.games?.[player.games.length - 1]?.game_id);
      }
    }

    // Check localStorage for recent elimination (within 5 minutes) to show on refresh
    try {
      const stored = JSON.parse(localStorage.getItem('lastElimination') || 'null');
      if (stored && (Date.now() - stored.time) < 300000 && stored.data?.length > 0) {
        showEliminationBanner(stored.data);
        return;
      }
    } catch (e) {}

    // Fallback: show banner for new eliminations from stats.json if recent
    const recentUpdate = stats.last_updated &&
      (Date.now() - new Date(stats.last_updated).getTime()) < 300000;

    if (newlyEliminated.length > 0 && recentUpdate) {
      try {
        showEliminationBanner(newlyEliminated);
      } catch (e) {
        console.warn('Elimination banner failed:', e);
      }
    }
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

      // Deep boom
      const osc1 = audioCtx.createOscillator();
      const gain1 = audioCtx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(80, t);
      osc1.frequency.exponentialRampToValueAtTime(30, t + 1.5);
      gain1.gain.setValueAtTime(0.6, t);
      gain1.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
      osc1.connect(gain1).connect(audioCtx.destination);
      osc1.start(t); osc1.stop(t + 1.5);

      // Buzzer
      const osc2 = audioCtx.createOscillator();
      const gain2 = audioCtx.createGain();
      osc2.type = 'sawtooth';
      osc2.frequency.setValueAtTime(150, t);
      osc2.frequency.exponentialRampToValueAtTime(50, t + 0.8);
      gain2.gain.setValueAtTime(0.3, t);
      gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
      osc2.connect(gain2).connect(audioCtx.destination);
      osc2.start(t); osc2.stop(t + 0.8);

      // Second hit
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
    } catch (e) {
      // Audio not available
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

    let html = '<div class="elimination-title">💀 DOWN GO THE 💀</div>';
    html += '<div class="elim-teams-grid">';

    for (const [teamName, group] of Object.entries(byTeam)) {
      const logoUrl = findLogo(teamName);
      const logoHtml = logoUrl
        ? `<img class="elim-team-logo" src="${logoUrl}" alt="">`
        : '';

      const seedLabel = group.seed ? `(${group.seed})` : '';

      html += '<div class="elim-team-block">';
      html += `<div class="elim-team-header">${logoHtml}<span class="elim-team-name">${seedLabel} ${teamName}</span></div>`;

      if (group.opponent) {
        // Find opponent seed by looking up any player on that team
        let oppSeed = '';
        for (const [, pl] of Object.entries(currentStats?.players || {})) {
          if (pl.team === group.opponent && pl.seed) {
            oppSeed = `(${pl.seed}) `;
            break;
          }
        }
        html += `<div class="elim-lost-to">Eliminated by ${oppSeed}${group.opponent}</div>`;
      }

      // Player cards
      html += '<div class="elim-players">';
      for (const p of group.players) {
        const hsUrl = currentHeadshots[p.slug] || '';
        const hsHtml = hsUrl
          ? `<img class="elim-headshot" src="${hsUrl}" alt="">`
          : '';
        const ownerLines = p.owners.map(o => `<span class="owner-line">☠️ ${o}</span>`).join('');
        html += '<div class="elim-player-card">';
        html += hsHtml;
        html += '<div class="elim-player-info">';
        const playerStats = currentStats?.players?.[p.slug];
        const totalPts = playerStats?.stats?.pts || 0;
        html += `<div class="elim-player-name">${p.name}</div>`;
        html += `<div class="elim-player-dates">He scored ${totalPts} points.<br>May he rest in peace.</div>`;
        html += '<div class="elim-player-divider"></div>';
        html += `<div class="elim-player-owners">${ownerLines}</div>`;
        html += '</div></div>';
      }
      html += '</div></div>';
    }

    html += '</div>'; // close elim-teams-grid
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
