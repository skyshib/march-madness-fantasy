/**
 * Scoreboard rendering and scoring logic.
 */
const Scoreboard = (() => {
  let picksData = null;
  let statsData = null;
  let headshotsData = {};
  let teamLogosData = {};
  let liveOverrides = {};  // athleteId -> { pts, reb, ast } from live ESPN fetch
  let compactMode = false;

  function setData(picks, stats, headshots, teamLogos) {
    picksData = picks;
    statsData = stats;
    headshotsData = headshots || {};
    teamLogosData = teamLogos || {};
  }

  function setLiveOverrides(overrides) {
    liveOverrides = overrides || {};
  }

  /**
   * Get stats for a player, merging committed stats with live overrides.
   * If a player has live data AND their last committed game is an active game,
   * we replace that game's stats with the live data to avoid double-counting.
   */
  function getPlayerStats(playerId) {
    const committed = statsData?.players?.[playerId];
    const base = committed ? { ...committed.stats } : { pts: 0, reb: 0, ast: 0 };
    const live = liveOverrides[playerId];

    if (live) {
      const activeGames = statsData?.active_games || [];
      const games = committed?.games || [];

      // Check if any committed game overlaps with an active game
      let overlapPts = 0, overlapReb = 0, overlapAst = 0;
      for (const g of games) {
        if (g.game_id && activeGames.includes(g.game_id)) {
          overlapPts += g.pts || 0;
          overlapReb += g.reb || 0;
          overlapAst += g.ast || 0;
        }
      }

      // Subtract overlapping committed stats, then add live stats
      return {
        pts: base.pts - overlapPts + live.pts,
        reb: base.reb - overlapReb + live.reb,
        ast: base.ast - overlapAst + live.ast,
      };
    }

    return base;
  }

  function isEliminated(playerId) {
    return statsData?.players?.[playerId]?.eliminated || false;
  }

  function isLive(playerId) {
    return !!liveOverrides[playerId];
  }

  /**
   * Calculate fantasy points for a single pick.
   */
  function calcPickPoints(pick, captainType) {
    const stats = getPlayerStats(pick.player_id);
    if (captainType === 'scorer') {
      return Math.round(stats.pts * 1.5 * 10) / 10; // keep one decimal
    } else if (captainType === 'playmaker') {
      return stats.pts + stats.reb + stats.ast;
    } else {
      return stats.pts;
    }
  }

  /**
   * Calculate full scoring breakdown for an entrant.
   */
  function scoreEntrant(entrant) {
    let total = 0;
    const seedBreakdown = {};

    for (let seed = 1; seed <= 16; seed++) {
      const pick = entrant.picks[String(seed)];
      if (!pick) {
        seedBreakdown[seed] = { pts: 0, pick: null, captain: null };
        continue;
      }

      let captainType = null;
      if (entrant.scorer_captain && entrant.scorer_captain.player_id === pick.player_id) {
        captainType = 'scorer';
      } else if (entrant.playmaker_captain && entrant.playmaker_captain.player_id === pick.player_id) {
        captainType = 'playmaker';
      }

      const pts = calcPickPoints(pick, captainType);
      total += pts;
      seedBreakdown[seed] = {
        pts,
        pick,
        captain: captainType,
        eliminated: isEliminated(pick.player_id),
        live: isLive(pick.player_id),
        rawStats: getPlayerStats(pick.player_id),
      };
    }

    const remaining = Object.values(seedBreakdown)
      .filter(s => s.pick && !s.eliminated).length;

    return { total: Math.round(total * 10) / 10, seedBreakdown, remaining };
  }

  /**
   * Score all entrants and sort by total descending.
   */
  function rankAll() {
    if (!picksData?.entrants) return [];

    return picksData.entrants
      .map(entrant => ({
        name: entrant.name,
        entrant,
        ...scoreEntrant(entrant),
      }))
      .sort((a, b) => b.total - a.total);
  }

  /**
   * Render the scoreboard table.
   */
  function render() {
    const tbody = document.getElementById('scoreboard-body');
    if (!tbody) return;

    const ranked = rankAll();
    tbody.innerHTML = '';

    // Count how many entrants picked each player
    const pickCounts = {};
    const totalEntrants = picksData?.entrants?.length || 0;
    for (const ent of picksData?.entrants || []) {
      for (const [seed, pick] of Object.entries(ent.picks || {})) {
        const pid = pick.player_id;
        pickCounts[pid] = (pickCounts[pid] || 0) + 1;
      }
    }

    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i];
      const tr = document.createElement('tr');
      tr.dataset.entrant = r.name;

      // Rank
      const rankTd = document.createElement('td');
      rankTd.className = 'col-rank';
      rankTd.textContent = i + 1;
      tr.appendChild(rankTd);

      // Name
      const nameTd = document.createElement('td');
      nameTd.className = 'col-name';
      nameTd.textContent = r.name;
      tr.appendChild(nameTd);

      // Total
      const totalTd = document.createElement('td');
      totalTd.className = 'col-total';
      totalTd.textContent = r.total;
      tr.appendChild(totalTd);

      // Remaining
      const remTd = document.createElement('td');
      remTd.className = 'col-remaining';
      remTd.textContent = `${r.remaining}/16`;
      tr.appendChild(remTd);

      // Seed columns 1-16
      for (let seed = 1; seed <= 16; seed++) {
        const td = document.createElement('td');
        td.className = 'seed-cell';
        if (compactMode) td.classList.add('compact');
        const info = r.seedBreakdown[seed];

        if (!info.pick) {
          td.textContent = '-';
          td.classList.add('eliminated');
        } else {
          if (info.eliminated) td.classList.add('eliminated');
          if (info.live) td.classList.add('live');

          if (compactMode) {
            // Compact: short name on top, pts below
            const fullName = info.pick.name;
            const parts = fullName.replace(/\s+(Jr\.?|Sr\.?|III|II|IV|V)$/i, '').trim().split(' ');
            const lastName = parts[parts.length - 1];
            let prefix = '';
            if (info.captain === 'scorer') prefix = '👑';
            else if (info.captain === 'playmaker') prefix = '🅿';

            const nameEl = document.createElement('span');
            nameEl.className = 'compact-name';
            nameEl.textContent = prefix + lastName;
            td.appendChild(nameEl);

            const ptsEl = document.createElement('span');
            ptsEl.className = 'compact-pts';
            ptsEl.textContent = info.pts;
            td.appendChild(ptsEl);
          } else {
            // Full mode with headshots
            if (info.captain) {
              const icon = document.createElement('span');
              icon.className = `captain-icon ${info.captain}`;
              icon.textContent = info.captain === 'scorer' ? '👑' : '🅿';
              td.appendChild(icon);
            }

            const hsUrl = headshotsData[info.pick.player_id];
            const logoUrl = teamLogosData[info.pick.team];
            if (hsUrl || logoUrl) {
              const wrapper = document.createElement('div');
              wrapper.className = 'seed-headshot-wrap';
              if (logoUrl) {
                wrapper.style.backgroundImage = `url(${logoUrl})`;
              }
              if (hsUrl) {
                const img = document.createElement('img');
                img.className = 'seed-headshot';
                img.src = hsUrl;
                img.alt = '';
                img.onerror = function() { this.style.display = 'none'; };
                wrapper.appendChild(img);
              }
              td.appendChild(wrapper);
            }

            const nameSpan = document.createElement('span');
            nameSpan.className = 'seed-player-name';
            const fullName = info.pick.name;
            const parts = fullName.replace(/\s+(Jr\.?|Sr\.?|III|II|IV|V)$/i, '').trim().split(' ');
            nameSpan.textContent = parts[parts.length - 1];
            td.appendChild(nameSpan);

            const ptsSpan = document.createElement('span');
            ptsSpan.className = 'seed-pts';
            ptsSpan.textContent = info.pts;
            td.appendChild(ptsSpan);
          }

          td.addEventListener('mouseenter', (e) => showPlayerTooltip(e, info, pickCounts, totalEntrants));
          td.addEventListener('mouseleave', hidePlayerTooltip);
        }

        if (seed === 4 || seed === 10) {
          td.classList.add('seed-divider-right');
        }

        tr.appendChild(td);
      }

      tr.addEventListener('click', () => showDetail(r));
      tbody.appendChild(tr);
    }
  }

  /**
   * Show detail panel for an entrant.
   */
  function showDetail(ranked) {
    const panel = document.getElementById('player-detail');
    const nameEl = document.getElementById('detail-name');
    const contentEl = document.getElementById('detail-content');

    nameEl.textContent = ranked.name;

    let html = '<table class="detail-table"><thead><tr>';
    html += '<th>Seed</th><th>Player</th><th>Team</th><th>PTS</th><th>Fantasy</th>';
    html += '</tr></thead><tbody>';

    for (let seed = 1; seed <= 16; seed++) {
      const info = ranked.seedBreakdown[seed];
      if (!info.pick) {
        html += `<tr><td>${seed}</td><td colspan="4" style="color:var(--text-muted)">No pick</td></tr>`;
        continue;
      }

      let rowClass = '';
      if (info.captain === 'scorer') rowClass = 'scorer-row';
      else if (info.captain === 'playmaker') rowClass = 'playmaker-row';

      const stats = info.rawStats || { pts: 0, reb: 0, ast: 0 };
      const elimClass = info.eliminated ? 'style="text-decoration:line-through;color:var(--eliminated)"' : '';
      const liveClass = info.live ? 'style="color:var(--live-green)"' : '';

      let captainBadge = '';
      if (info.captain === 'scorer') {
        captainBadge = ' <span class="captain-badge scorer">1.5x</span>';
      } else if (info.captain === 'playmaker') {
        captainBadge = ' <span class="captain-badge playmaker">P+R+A</span>';
      }

      // PTS column: show "pts+reb+ast" breakdown for playmaker, just pts otherwise
      let ptsDisplay;
      if (info.captain === 'playmaker') {
        ptsDisplay = `${stats.pts}+${stats.reb}+${stats.ast}`;
      } else {
        ptsDisplay = `${stats.pts}`;
      }

      const hsUrl = headshotsData[info.pick.player_id];
      const hsImg = hsUrl ? `<img class="detail-headshot" src="${hsUrl}" alt="" onerror="this.style.display='none'">` : '';

      html += `<tr class="${rowClass}" ${elimClass}>`;
      html += `<td>${seed}</td>`;
      html += `<td ${liveClass}><span class="detail-player-cell">${hsImg}${info.pick.name}${captainBadge}</span></td>`;
      html += `<td>${info.pick.team || ''}</td>`;
      html += `<td>${ptsDisplay}</td>`;
      html += `<td style="font-weight:700">${info.pts}</td>`;
      html += '</tr>';
    }

    html += '</tbody></table>';

    html += `<div style="margin-top:1rem;font-size:0.9rem"><strong>Total: ${ranked.total}</strong> &middot; ${ranked.remaining} players remaining</div>`;

    html += '<div class="legend">';
    html += '<span class="legend-item"><span class="captain-badge scorer">1.5x</span> Scorer Captain</span>';
    html += '<span class="legend-item"><span class="captain-badge playmaker">P+R+A</span> Playmaker Captain</span>';
    html += '</div>';

    contentEl.innerHTML = html;
    panel.classList.remove('hidden');
    panel.classList.add('visible');
  }

  function hideDetail() {
    const panel = document.getElementById('player-detail');
    panel.classList.remove('visible');
    panel.classList.add('hidden');
  }

  /**
   * Show a tooltip with per-game stats on seed cell hover.
   */
  function showPlayerTooltip(e, info, pickCounts, totalEntrants) {
    hidePlayerTooltip();
    const player = statsData?.players?.[info.pick.player_id];
    const games = player?.games || [];
    const count = pickCounts?.[info.pick.player_id] || 0;

    const tip = document.createElement('div');
    tip.id = 'player-tooltip';
    tip.className = 'player-tooltip';

    let captainLabel = '';
    if (info.captain === 'scorer') captainLabel = ' <span class="captain-badge scorer">1.5x PTS</span>';
    else if (info.captain === 'playmaker') captainLabel = ' <span class="captain-badge playmaker">PTS+REB+AST</span>';

    let html = `<div class="tt-header">${info.pick.name}${captainLabel}</div>`;
    html += `<div class="tt-team">${info.pick.team} &middot; Picked by ${count}/${totalEntrants}</div>`;

    const isPlaymaker = info.captain === 'playmaker';

    if (games.length > 0) {
      if (isPlaymaker) {
        html += '<table class="tt-games"><thead><tr><th>Round</th><th>Opp</th><th>PTS</th><th>REB</th><th>AST</th></tr></thead><tbody>';
        for (const g of games) {
          const opp = g.opponent || '—';
          html += `<tr><td>${g.round}</td><td>${opp}</td><td>${g.pts}</td><td>${g.reb}</td><td>${g.ast}</td></tr>`;
        }
        html += '</tbody></table>';
      } else {
        html += '<table class="tt-games"><thead><tr><th>Round</th><th>Opp</th><th>PTS</th></tr></thead><tbody>';
        for (const g of games) {
          const opp = g.opponent || '—';
          html += `<tr><td>${g.round}</td><td>${opp}</td><td>${g.pts}</td></tr>`;
        }
        html += '</tbody></table>';
      }
    } else {
      const totalStats = player?.stats || { pts: 0, reb: 0, ast: 0 };
      if (totalStats.pts > 0 || totalStats.reb > 0 || totalStats.ast > 0) {
        // Has aggregate stats but no per-game breakdown
        html += '<div class="tt-no-games">Per-game breakdown unavailable</div>';
        if (isPlaymaker) {
          html += `<div style="font-size:0.75rem;color:var(--text-secondary)">Totals: ${totalStats.pts} pts, ${totalStats.reb} reb, ${totalStats.ast} ast</div>`;
        }
      } else if (info.live) {
        const liveStats = info.rawStats || { pts: 0, reb: 0, ast: 0 };
        html += '<div class="tt-live-game">In active game</div>';
        html += `<div style="font-size:0.75rem;color:var(--text-secondary)">${liveStats.pts} pts, ${liveStats.reb} reb, ${liveStats.ast} ast</div>`;
      } else {
        html += '<div class="tt-no-games">No games played yet</div>';
      }
    }

    html += `<div class="tt-total">Fantasy: ${info.pts}</div>`;

    tip.innerHTML = html;
    document.body.appendChild(tip);

    // Position near the cell
    const rect = e.currentTarget.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();

    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.top - tipRect.height - 8;

    // Keep within viewport
    if (left < 8) left = 8;
    if (left + tipRect.width > window.innerWidth - 8) left = window.innerWidth - tipRect.width - 8;
    if (top < 8) {
      top = rect.bottom + 8; // show below instead
    }

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.classList.add('visible');
  }

  function hidePlayerTooltip() {
    const existing = document.getElementById('player-tooltip');
    if (existing) existing.remove();
  }

  function toggleCompact() {
    compactMode = !compactMode;
    document.getElementById('scoreboard')?.classList.toggle('compact-mode', compactMode);
    render();
    return compactMode;
  }

  return { setData, setLiveOverrides, render, rankAll, hideDetail, scoreEntrant, toggleCompact };
})();
