/**
 * App initialization, data loading, auto-refresh, and year routing.
 */
(async function () {
  const REFRESH_MS = 60000; // 1 min: re-fetch stats.json
  let currentYear = null;
  let refreshTimer = null;
  let currentPicks = null;
  let currentStats = null;
  let currentHeadshots = {};
  let currentTeamLogos = {};
  let knownEliminated = new Set();
  let isFirstLoad = true;

  // --- Helpers ---

  /**
   * Check if a picks.json team name matches an ESPN full team name.
   */
  function teamsMatch(pickTeam, espnTeam) {
    if (!pickTeam || !espnTeam) return false;
    const pt = pickTeam.toLowerCase().trim();
    const et = espnTeam.toLowerCase().trim();
    if (pt === et) return true;
    const espnWords = et.split(' ');
    const espnSchool = espnWords.slice(0, -1).join(' ');
    if (pt === espnSchool) return true;
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
    const hasLive = currentStats?.live_games?.length > 0;
    if (hasLive && currentStats?.last_updated) {
      el.textContent = `Live \u2022 ${timeAgo(currentStats.last_updated)}`;
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

    // Render live games tracker
    renderLiveGames(stats);

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
  function renderLiveGames(stats) {
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
            const playerStats = stats.players?.[data.slug];
            const pts = playerStats?.stats?.pts || 0;
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

    // Add all currently eliminated to known set
    for (const [slug, player] of Object.entries(stats.players || {})) {
      if (player.eliminated) knownEliminated.add(slug);
    }

    // On page load, show banner only if localStorage has a recent elimination (within 2 minutes)
    try {
      const stored = JSON.parse(localStorage.getItem('lastElimination') || 'null');
      if (stored && (Date.now() - stored.time) < 120000 && stored.data?.length > 0) {
        showEliminationBanner(stored.data);
        localStorage.removeItem('lastElimination');
        return;
      }
    } catch (e) {}

    // Show banner for new eliminations — but not on first page load
    // (first load sees all historical eliminations as "new")
    if (newlyEliminated.length > 0 && !isFirstLoad) {
      localStorage.setItem('lastElimination', JSON.stringify({
        time: Date.now(),
        data: newlyEliminated,
      }));
      try {
        showEliminationBanner(newlyEliminated);
      } catch (e) {
        console.warn('Elimination banner failed:', e);
      }
    }
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

  function showEliminationBanner(eliminated) {
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
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (currentYear) loadYear(currentYear);
    }, REFRESH_MS);

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
