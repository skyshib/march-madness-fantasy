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

    // Compute uniqueness score per entrant
    // Lower average pick count = more unique selections
    const uniquenessScores = ranked.map(r => {
      let totalPickCount = 0;
      let numPicks = 0;
      for (let seed = 1; seed <= 16; seed++) {
        const info = r.seedBreakdown[seed];
        if (info.pick) {
          totalPickCount += pickCounts[info.pick.player_id] || 0;
          numPicks++;
        }
      }
      return { name: r.name, avgPopularity: numPicks > 0 ? totalPickCount / numPicks : 0 };
    });
    // Sort by avg popularity ascending (most unique first)
    const sorted = [...uniquenessScores].sort((a, b) => a.avgPopularity - b.avgPopularity);
    const uniquenessRanks = {};
    sorted.forEach((entry, idx) => { uniquenessRanks[entry.name] = idx + 1; });

    // Compute min/max fantasy pts across all seed cells for gradient
    let minPts = Infinity, maxPts = -Infinity;
    for (const r of ranked) {
      for (let seed = 1; seed <= 16; seed++) {
        const info = r.seedBreakdown[seed];
        if (info.pick) {
          if (info.pts < minPts) minPts = info.pts;
          if (info.pts > maxPts) maxPts = info.pts;
        }
      }
    }
    if (!isFinite(minPts)) minPts = 0;
    if (!isFinite(maxPts)) maxPts = 0;

    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i];
      const tr = document.createElement('tr');
      tr.dataset.entrant = r.name;

      // Rank
      const rankTd = document.createElement('td');
      rankTd.className = 'col-rank';
      const badges = ['🥇', '🥈', '🥉', '💲', '💲'];
      rankTd.textContent = i < 5 ? badges[i] : i + 1;
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
            // Compact: short name on top, pts below, gradient bg
            const fullName = info.pick.name;
            const parts = fullName.replace(/\s+(Jr\.?|Sr\.?|III|II|IV|V)$/i, '').trim().split(' ');
            const lastName = parts[parts.length - 1];
            let prefix = '';
            if (info.captain === 'scorer') prefix = '👑';
            else if (info.captain === 'playmaker') prefix = '🅿';

            // Red-white-green gradient based on pts
            if (maxPts > minPts) {
              const mid = (minPts + maxPts) / 2;
              const pts = info.pts;
              let r, g, b;
              if (pts <= mid) {
                // Red (220,50,50) -> White (255,255,255)
                const t = (pts - minPts) / (mid - minPts || 1);
                r = Math.round(220 + (255 - 220) * t);
                g = Math.round(50 + (255 - 50) * t);
                b = Math.round(50 + (255 - 50) * t);
              } else {
                // White (255,255,255) -> Green (50,180,50)
                const t = (pts - mid) / (maxPts - mid || 1);
                r = Math.round(255 + (50 - 255) * t);
                g = Math.round(255 + (180 - 255) * t);
                b = Math.round(255 + (50 - 255) * t);
              }
              td.style.backgroundColor = `rgba(${r},${g},${b},0.2)`;
            }

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

      tr.addEventListener('click', () => showDetail(r, pickCounts, totalEntrants, uniquenessRanks));
      tbody.appendChild(tr);
    }
  }

  /**
   * Show detail panel for an entrant.
   */
  function showDetail(ranked, pickCounts, totalEntrants, uniquenessRanks) {
    const panel = document.getElementById('player-detail');
    const nameEl = document.getElementById('detail-name');
    const contentEl = document.getElementById('detail-content');

    nameEl.textContent = ranked.name;

    const uRank = uniquenessRanks?.[ranked.name] || '?';
    let html = `<div class="detail-uniqueness">Uniqueness: #${uRank} of ${totalEntrants}</div>`;

    html += '<table class="detail-table"><thead><tr>';
    html += '<th>Seed</th><th>Player</th><th>Team</th><th>Picked</th><th>PTS</th>';
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
      const pCount = pickCounts?.[info.pick.player_id] || 0;
      html += `<td>${info.pick.team || ''}</td>`;
      html += `<td style="color:var(--text-muted)">${pCount}/${totalEntrants}</td>`;
      html += `<td style="font-weight:700">${ptsDisplay}</td>`;
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

    // Show live game indicator if player is in an active game
    if (info.live) {
      html += '<div class="tt-live-game">In active game</div>';
    }

    const activeGameIds = statsData?.active_games || [];

    if (games.length > 0 || info.live) {
      const liveStats = info.live ? liveOverrides[info.pick.player_id] : null;
      const cols = isPlaymaker
        ? '<th>Round</th><th>Opp</th><th>PTS</th><th>REB</th><th>AST</th>'
        : '<th>Round</th><th>Opp</th><th>PTS</th>';
      html += `<table class="tt-games"><thead><tr>${cols}</tr></thead><tbody>`;

      for (const g of games) {
        const opp = g.opponent || '—';
        const isActiveRow = g.game_id && activeGameIds.includes(g.game_id);
        const rowStyle = isActiveRow ? ' style="color:var(--live-green)"' : '';

        // For active game rows, show live stats instead of committed
        const pts = (isActiveRow && liveStats) ? liveStats.pts : g.pts;
        const reb = (isActiveRow && liveStats) ? liveStats.reb : g.reb;
        const ast = (isActiveRow && liveStats) ? liveStats.ast : g.ast;
        const liveTag = isActiveRow ? ' \u25cf' : '';

        if (isPlaymaker) {
          html += `<tr${rowStyle}><td>${g.round}${liveTag}</td><td>${opp}</td><td>${pts}</td><td>${reb}</td><td>${ast}</td></tr>`;
        } else {
          html += `<tr${rowStyle}><td>${g.round}${liveTag}</td><td>${opp}</td><td>${pts}</td></tr>`;
        }
      }

      // If live but no committed game for this active game yet, add a row
      if (info.live && !games.some(g => activeGameIds.includes(g.game_id))) {
        const ls = liveStats || { pts: 0, reb: 0, ast: 0 };
        const opp = ls.opponent || '—';
        if (isPlaymaker) {
          html += `<tr style="color:var(--live-green)"><td>Live \u25cf</td><td>${opp}</td><td>${ls.pts}</td><td>${ls.reb}</td><td>${ls.ast}</td></tr>`;
        } else {
          html += `<tr style="color:var(--live-green)"><td>Live \u25cf</td><td>${opp}</td><td>${ls.pts}</td></tr>`;
        }
      }

      html += '</tbody></table>';
    } else {
      html += '<div class="tt-no-games">No games played yet</div>';
    }

    html += `<div class="tt-total">Total: ${info.pts}</div>`;

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
