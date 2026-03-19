/**
 * Scoreboard rendering and scoring logic.
 */
const Scoreboard = (() => {
  let picksData = null;
  let statsData = null;
  let liveOverrides = {};  // athleteId -> { pts, reb, ast } from live ESPN fetch

  function setData(picks, stats) {
    picksData = picks;
    statsData = stats;
  }

  function setLiveOverrides(overrides) {
    liveOverrides = overrides || {};
  }

  /**
   * Get stats for a player, merging committed stats with live overrides.
   * For live games, the live override replaces the current game's stats.
   */
  function getPlayerStats(playerId) {
    const committed = statsData?.players?.[playerId];
    const base = committed ? { ...committed.stats } : { pts: 0, reb: 0, ast: 0 };
    const live = liveOverrides[playerId];

    if (live && committed) {
      // The committed stats include all completed games.
      // The live override is the current in-progress game's stats.
      // If the player's last game in committed data matches an active game,
      // we replace it; otherwise we add it.
      const activeGames = statsData.active_games || [];
      const lastGame = committed.games?.[committed.games.length - 1];
      if (lastGame && activeGames.includes(lastGame.game_id)) {
        // Replace the last game's stats with live data
        return {
          pts: base.pts - lastGame.pts + live.pts,
          reb: base.reb - lastGame.reb + live.reb,
          ast: base.ast - lastGame.ast + live.ast,
        };
      } else {
        // Add live stats on top
        return {
          pts: base.pts + live.pts,
          reb: base.reb + live.reb,
          ast: base.ast + live.ast,
        };
      }
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
        const info = r.seedBreakdown[seed];

        if (!info.pick) {
          td.textContent = '-';
          td.classList.add('eliminated');
        } else {
          td.textContent = info.pts;
          if (info.eliminated) td.classList.add('eliminated');
          if (info.live) td.classList.add('live');

          if (info.captain) {
            const icon = document.createElement('span');
            icon.className = `captain-icon ${info.captain}`;
            icon.textContent = info.captain === 'scorer' ? '👑' : '🅿';
            icon.title = info.captain === 'scorer' ? 'Scorer Captain (1.5x PTS)' : 'Playmaker Captain (PTS+REB+AST)';
            td.appendChild(icon);
          }

          td.title = `${info.pick.name} (${info.pick.team})`;
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
    html += '<th>Seed</th><th>Player</th><th>Team</th><th>PTS</th><th>REB</th><th>AST</th><th>Fantasy</th>';
    html += '</tr></thead><tbody>';

    for (let seed = 1; seed <= 16; seed++) {
      const info = ranked.seedBreakdown[seed];
      if (!info.pick) {
        html += `<tr><td>${seed}</td><td colspan="6" style="color:var(--text-muted)">No pick</td></tr>`;
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

      html += `<tr class="${rowClass}" ${elimClass}>`;
      html += `<td>${seed}</td>`;
      html += `<td ${liveClass}>${info.pick.name}${captainBadge}</td>`;
      html += `<td>${info.pick.team || ''}</td>`;
      html += `<td>${stats.pts}</td>`;
      html += `<td>${stats.reb}</td>`;
      html += `<td>${stats.ast}</td>`;
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

  return { setData, setLiveOverrides, render, rankAll, hideDetail, scoreEntrant };
})();
