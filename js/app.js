/**
 * App initialization, data loading, auto-refresh, and year routing.
 */
(async function () {
  const REFRESH_MS = 120000; // 2 minutes
  let currentYear = null;
  let refreshTimer = null;

  // --- Helpers ---
  async function loadJSON(path) {
    const resp = await fetch(path + '?t=' + Date.now());
    if (!resp.ok) throw new Error(`Failed to load ${path}: ${resp.status}`);
    return resp.json();
  }

  function timeAgo(isoStr) {
    if (!isoStr) return 'never';
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function updateIndicator(statsData, hasLive) {
    const el = document.getElementById('update-indicator');
    const ago = timeAgo(statsData?.last_updated);
    if (hasLive) {
      el.textContent = `Live • Updated ${ago}`;
      el.className = 'update-indicator live';
    } else {
      el.textContent = `Updated ${ago}`;
      el.className = 'update-indicator';
    }
  }

  // --- Data loading ---
  async function loadYear(year) {
    currentYear = year;
    const config = await loadJSON('data/config.json');
    const isCurrentYear = (year === config.year);

    const dataPrefix = isCurrentYear ? 'data' : `data/${year}`;
    const [picks, stats, headshots] = await Promise.all([
      loadJSON(`${dataPrefix}/picks.json`),
      loadJSON(`${dataPrefix}/stats.json`),
      loadJSON('data/headshots.json').catch(() => ({})),
    ]);

    Scoreboard.setData(picks, stats, headshots);
    Scoreboard.setLiveOverrides({});
    Scoreboard.render();

    // If current year, try live overlay
    let hasLive = false;
    if (isCurrentYear && stats.active_games?.length > 0) {
      try {
        const liveStats = await ESPN.getLivePlayerStats(stats.active_games);
        if (Object.keys(liveStats).length > 0) {
          Scoreboard.setLiveOverrides(liveStats);
          Scoreboard.render();
          hasLive = true;
        }
      } catch (e) {
        console.warn('Live overlay failed:', e);
      }
    }

    // Also check ESPN for any new active games not yet in stats.json
    if (isCurrentYear) {
      try {
        const activeIds = await ESPN.getActiveGameIds();
        if (activeIds.length > 0) {
          const liveStats = await ESPN.getLivePlayerStats(activeIds);
          if (Object.keys(liveStats).length > 0) {
            Scoreboard.setLiveOverrides(liveStats);
            Scoreboard.render();
            hasLive = true;
          }
        }
      } catch (e) {
        console.warn('Active game check failed:', e);
      }
    }

    updateIndicator(stats, hasLive);
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
  function startRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (currentYear) loadYear(currentYear);
    }, REFRESH_MS);
  }

  // --- Detail panel close ---
  document.getElementById('close-detail')?.addEventListener('click', () => {
    Scoreboard.hideDetail();
  });

  // Close detail on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') Scoreboard.hideDetail();
  });

  // --- Init ---
  try {
    const defaultYear = await initYearSelector();
    await loadYear(defaultYear);
    startRefresh();
  } catch (e) {
    console.error('Init failed:', e);
    document.getElementById('scoreboard-body').innerHTML =
      '<tr><td colspan="20" style="text-align:center;padding:2rem;color:var(--text-muted)">Failed to load data. Check console for details.</td></tr>';
  }
})();
