/**
 * Scoreboard rendering and scoring logic.
 */
const Scoreboard = (() => {
  let picksData = null;
  let statsData = null;
  let headshotsData = {};
  let teamLogosData = {};
  let liveOverrides = {};  // athleteId -> { pts, reb, ast } from live ESPN fetch
  let liveGamesInfo = [];  // [{ teams: [{name, seed, score}], status }] from ESPN
  let compactMode = false;

  function setData(picks, stats, headshots, teamLogos) {
    picksData = picks;
    statsData = stats;
    headshotsData = headshots || {};
    teamLogosData = teamLogos || {};
  }

  function setLiveGames(games) {
    liveGamesInfo = games || [];
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
   * Compute the Best Possible Roster given current stats.
   * No budget cap — just pick max-value player per seed, then optimize captain assignment.
   * Scorer captain must be seed 5-16; playmaker must be in opposite half (5-10 vs 11-16).
   */
  function computeBestRoster() {
    if (!statsData?.players) return null;

    const bySeed = {};
    for (let s = 1; s <= 16; s++) bySeed[s] = [];
    for (const [pid, p] of Object.entries(statsData.players)) {
      const seed = p.seed;
      if (!seed || seed < 1 || seed > 16) continue;
      const s = getPlayerStats(pid);
      bySeed[seed].push({
        player_id: pid,
        name: p.name,
        team: p.team,
        pts: s.pts,
        pra: s.pts + s.reb + s.ast,
      });
    }

    // Best by pts (also best as scorer captain, since 1.5x is monotonic) and best by P+R+A.
    const bestPts = {}, bestPRA = {};
    for (let s = 1; s <= 16; s++) {
      const arr = bySeed[s];
      if (!arr.length) continue;
      bestPts[s] = arr.reduce((a, b) => (a.pts >= b.pts ? a : b));
      bestPRA[s] = arr.reduce((a, b) => (a.pra >= b.pra ? a : b));
    }

    function buildRoster(scorerSeed, playmakerSeed) {
      let total = 0;
      const picks = {};
      let scorerCap = null, playmakerCap = null;
      for (let s = 1; s <= 16; s++) {
        if (!bestPts[s]) continue;
        let player, pts;
        if (s === scorerSeed) {
          player = bestPts[s];
          pts = Math.round(player.pts * 1.5 * 10) / 10;
          scorerCap = { seed: s, player_id: player.player_id, name: player.name, team: player.team };
        } else if (s === playmakerSeed) {
          player = bestPRA[s];
          pts = player.pra;
          playmakerCap = { seed: s, player_id: player.player_id, name: player.name, team: player.team };
        } else {
          player = bestPts[s];
          pts = player.pts;
        }
        picks[String(s)] = { player_id: player.player_id, name: player.name, team: player.team };
        total += pts;
      }
      return { total, picks, scorerCap, playmakerCap };
    }

    let best = null;
    for (let ss = 5; ss <= 16; ss++) {
      const pmRange = ss <= 10 ? [11, 12, 13, 14, 15, 16] : [5, 6, 7, 8, 9, 10];
      for (const pm of pmRange) {
        if (!bestPts[ss] || !bestPRA[pm]) continue;
        const cfg = buildRoster(ss, pm);
        if (!best || cfg.total > best.total) best = cfg;
      }
    }
    if (!best) return null;

    return {
      name: '⭐ Best Possible Roster',
      _synthetic: true,
      scorer_captain: best.scorerCap,
      playmaker_captain: best.playmakerCap,
      picks: best.picks,
    };
  }

  /**
   * Score all entrants and sort by total descending.
   */
  function rankAll() {
    if (!picksData?.entrants) return [];

    const entrants = [...picksData.entrants];
    const bpr = computeBestRoster();
    if (bpr) entrants.push(bpr);

    return entrants
      .map(entrant => ({
        name: entrant.name,
        entrant,
        _synthetic: !!entrant._synthetic,
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

    const rankedAll = rankAll();
    const syntheticRanked = rankedAll.filter(r => r._synthetic);
    const ranked = rankedAll.filter(r => !r._synthetic);
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

    // Compute ranks with ties
    const ranks = [];
    for (let i = 0; i < ranked.length; i++) {
      if (i === 0 || ranked[i].total < ranked[i - 1].total) {
        ranks.push(i + 1);
      } else {
        ranks.push(ranks[i - 1]); // same rank as previous (tie)
      }
    }

    const displayRows = [...syntheticRanked, ...ranked];
    for (let i = 0; i < displayRows.length; i++) {
      const r = displayRows[i];
      const tr = document.createElement('tr');
      tr.dataset.entrant = r.name;
      if (r._synthetic) tr.classList.add('synthetic-row');

      // Rank
      const rankTd = document.createElement('td');
      rankTd.className = 'col-rank';
      if (r._synthetic) {
        rankTd.textContent = '⭐';
      } else {
        const realIdx = i - syntheticRanked.length;
        const rank = ranks[realIdx];
        const isTied = ranks.filter(x => x === rank).length > 1;
        const badges = ['🥇', '🥈', '🥉', '💲', '💲'];
        const prefix = isTied ? 'T-' : '';
        rankTd.textContent = rank <= 5 ? `${prefix}${rank} ${badges[rank - 1]}` : `${prefix}${rank}`;
        if (rank === 1) rankTd.classList.add('rank-gold');
        else if (rank === 2) rankTd.classList.add('rank-silver');
        else if (rank === 3) rankTd.classList.add('rank-bronze');
      }
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

      // Count alive players grouped by their next round
      const roundNames = ['R64', 'R32', 'S16', 'E8', 'F4', 'Final'];
      const byRound = {}; // round name -> count of players yet to play

      for (let s = 1; s <= 16; s++) {
        const info = r.seedBreakdown[s];
        if (info.pick && !info.eliminated && !info.live) {
          const player = statsData?.players?.[info.pick.player_id];
          const numGames = player?.games?.length || 0;
          const nextRound = roundNames[numGames] || '';
          if (nextRound) {
            byRound[nextRound] = (byRound[nextRound] || 0) + 1;
          }
        }
      }

      const roundOrder = ['R64', 'R32', 'S16', 'E8', 'F4', 'Final'];
      const roundEntries = roundOrder.filter(rd => byRound[rd]).map(rd => `${rd}: ${byRound[rd]}`);
      if (!compactMode && roundEntries.length > 0) {
        const roundText = roundEntries.map(r => `<span class="remaining-round">${r}</span>`).join('');
        remTd.innerHTML = `${r.remaining}/16<br>${roundText}`;
      } else {
        remTd.textContent = `${r.remaining}/16`;
      }
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
            else if (info.captain === 'playmaker') prefix = '⛹️';

            // Red-white-green gradient based on pts
            if (maxPts > minPts) {
              const mid = (minPts + maxPts) / 2;
              const pts = info.pts;
              let r, g, b;
              if (pts <= mid) {
                // Red -> neutral
                const t = (pts - minPts) / (mid - minPts || 1);
                r = Math.round(180 + (60 - 180) * t);
                g = Math.round(40 + (60 - 40) * t);
                b = Math.round(40 + (60 - 40) * t);
              } else {
                // Neutral -> Green
                const t = (pts - mid) / (maxPts - mid || 1);
                r = Math.round(60 + (30 - 60) * t);
                g = Math.round(60 + (140 - 60) * t);
                b = Math.round(60 + (30 - 60) * t);
              }
              td.style.backgroundColor = `rgb(${r},${g},${b})`;
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
              icon.textContent = info.captain === 'scorer' ? '👑' : '⛹️';
              td.appendChild(icon);
            }

            // Seed number
            const seedLabel = document.createElement('span');
            seedLabel.className = 'seed-number';
            seedLabel.textContent = seed;
            td.appendChild(seedLabel);

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

    // Find most similar entrant (most overlapping picks)
    const myPicks = new Set();
    for (let s = 1; s <= 16; s++) {
      const p = ranked.seedBreakdown[s]?.pick;
      if (p) myPicks.add(p.player_id);
    }

    let bestMatch = null;
    let bestOverlap = -1;
    for (const ent of picksData?.entrants || []) {
      if (ent.name === ranked.name) continue;
      let overlap = 0;
      for (const [seed, pick] of Object.entries(ent.picks || {})) {
        if (myPicks.has(pick.player_id)) overlap++;
      }
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestMatch = ent.name;
      }
    }

    let html = `<div class="detail-uniqueness">Uniqueness: #${uRank} of ${totalEntrants}</div>`;
    if (bestMatch) {
      html += `<div class="detail-uniqueness">Most similar: ${bestMatch} (${bestOverlap}/16 picks in common)</div>`;
    }

    // Rooting for section (live games only) — at the top
    if (liveGamesInfo.length > 0) {
      const myTeams = new Set();
      for (let s = 1; s <= 16; s++) {
        const info = ranked.seedBreakdown[s];
        if (info.pick && !info.eliminated) {
          myTeams.add(info.pick.team?.toLowerCase());
        }
      }

      const rooting = [];
      for (const game of liveGamesInfo) {
        if (game.teams.length < 2) continue;
        const t0 = game.teams[0];
        const t1 = game.teams[1];
        // Match: check if any of our teams match ESPN full name
        function teamMatchLocal(pickTeam, espnFull) {
          if (!pickTeam || !espnFull) return false;
          if (pickTeam === espnFull) return true;
          const aliases = {'penn':'pennsylvania','uconn':'connecticut','liu':'long island',"hawaii":"hawai'i"};
          const mapped = aliases[pickTeam] || pickTeam;
          if (mapped === espnFull) return true;
          const espnMap = {'duke':'duke blue devils','alabama':'alabama crimson tide','illinois':'illinois fighting illini','tcu':'tcu horned frogs','uconn':'uconn huskies','hawaii':"hawai'i rainbow warriors",'tennessee':'tennessee volunteers','tennessee state':'tennessee state tigers','michigan':'michigan wolverines','michigan state':'michigan state spartans','north carolina':'north carolina tar heels','north dakota state':'north dakota state bison','miami':'miami hurricanes','miami (oh)':'miami (oh) redhawks','iowa':'iowa hawkeyes','iowa state':'iowa state cyclones','texas':'texas longhorns','texas a&m':'texas a&m aggies','texas tech':'texas tech red raiders',"saint mary's":"saint mary's gaels",'saint louis':'saint louis billikens'};
          const resolvedPt = aliases[pickTeam] || pickTeam;
          if (resolvedPt in espnMap) return espnMap[resolvedPt] === espnFull;
          if (espnMap[pickTeam] === espnFull) return true;
          const words = espnFull.split(' ');
          if (mapped === words.slice(0, -1).join(' ')) return true;
          if (words.length > 3 && mapped === words.slice(0, -2).join(' ')) return true;
          return false;
        }
        const t0match = [...myTeams].some(pt => teamMatchLocal(pt, t0.fullName));
        const t1match = [...myTeams].some(pt => teamMatchLocal(pt, t1.fullName));
        if (t0match && !t1match) {
          rooting.push(`(${t0.seed}) ${t0.name} over (${t1.seed}) ${t1.name}`);
        } else if (t1match && !t0match) {
          rooting.push(`(${t1.seed}) ${t1.name} over (${t0.seed}) ${t0.name}`);
        } else if (t0match && t1match) {
          rooting.push(`(${t0.seed}) ${t0.name} vs (${t1.seed}) ${t1.name} — conflicted!`);
        }
      }

      if (rooting.length > 0) {
        html += '<div class="detail-rooting"><div class="detail-rooting-title">🏀 Rooting for...</div>';
        for (const line of rooting) {
          html += `<div class="detail-rooting-line">${line}</div>`;
        }
        html += '</div>';
      }
    }

    html += '<table class="detail-table"><thead><tr>';
    html += '<th>Seed</th><th>Round</th><th>Player</th><th>Team</th><th>Picked</th><th>PTS</th>';
    html += '</tr></thead><tbody>';

    for (let seed = 1; seed <= 16; seed++) {
      const info = ranked.seedBreakdown[seed];
      if (!info.pick) {
        html += `<tr><td>${seed}</td><td colspan="5" style="color:var(--text-muted)">No pick</td></tr>`;
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
      if (info.captain === 'scorer') {
        ptsDisplay = `${stats.pts} × 1.5 = ${Math.round(stats.pts * 1.5 * 10) / 10}`;
      } else if (info.captain === 'playmaker') {
        ptsDisplay = `${stats.pts}+${stats.reb}+${stats.ast} = ${stats.pts + stats.reb + stats.ast}`;
      } else {
        ptsDisplay = `${stats.pts}`;
      }

      const hsUrl = headshotsData[info.pick.player_id];
      const hsImg = hsUrl ? `<img class="detail-headshot" src="${hsUrl}" alt="" onerror="this.style.display='none'">` : '';

      // Round column
      const player = statsData?.players?.[info.pick.player_id];
      const numGames = player?.games?.length || 0;
      const detailRoundNames = ['R64', 'R32', 'S16', 'E8', 'F4', 'Final'];
      let roundDisplay;
      if (info.eliminated) {
        const lastRound = player?.games?.[numGames - 1]?.round || detailRoundNames[numGames - 1] || '';
        roundDisplay = `<span style="color:var(--eliminated)">☠️ ${lastRound}</span>`;
      } else if (info.live) {
        roundDisplay = `<span style="color:var(--live-green)">● ${detailRoundNames[numGames > 0 ? numGames - 1 : 0]}</span>`;
      } else {
        roundDisplay = `<span style="color:var(--text-primary)">${detailRoundNames[numGames] || '—'}</span>`;
      }

      const liveRowClass = info.live ? ' detail-live-row' : '';
      html += `<tr class="${rowClass}${liveRowClass}" ${elimClass}>`;
      html += `<td>${seed}</td>`;
      html += `<td>${roundDisplay}</td>`;
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

    // Show live game indicator with clock
    if (info.live) {
      const liveData = liveOverrides[info.pick.player_id];
      const clock = liveData?.gameStatus || '';
      html += `<div class="tt-live-game">LIVE${clock ? ' \u2022 ' + clock : ''}</div>`;
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

  function getLiveOverride(slug) {
    return liveOverrides[slug] || null;
  }

  /**
   * Mark players as eliminated in the stats data (called from live poll).
   * Creates stub entries if they don't exist yet in stats.
   */
  function markEliminated(slugs) {
    if (!statsData) return;
    if (!statsData.players) statsData.players = {};
    for (const slug of slugs) {
      if (statsData.players[slug]) {
        statsData.players[slug].eliminated = true;
      } else {
        statsData.players[slug] = { name: '', team: '', seed: 0, eliminated: true, stats: { pts: 0, reb: 0, ast: 0 }, games: [] };
      }
    }
    render();
  }

  return { setData, setLiveGames, setLiveOverrides, getLiveOverride, markEliminated, render, rankAll, hideDetail, scoreEntrant, toggleCompact };
})();
