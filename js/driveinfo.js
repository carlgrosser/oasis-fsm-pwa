/**
 * DriveInfo — drive-time info box + job badge bar for the worker PWA.
 *
 * Info box (above today's jobs, compact version above the upcoming day):
 *   - Estimated drive time to the first job and total drive for the day
 *   - Origin selector: leaving from Shop (default) or a custom address
 *     (e.g. home). The custom origin is saved on the worker's fsm.person
 *     record and persists across devices until changed or set back to shop.
 *
 * Badge bar on job cards: "⇠ 18m" drive from previous stop (shop for the
 * first job of a day) and "Σ 1h 05m" day total on the last job — from the
 * travel_* fields maintained by the office dispatch board. Which badges
 * appear here vs the office app is controlled in office dispatch settings.
 *
 * Routing: stored estimates when leaving from shop; OSRM (street routing,
 * no key) when a custom origin needs a fresh chain.
 */
const DriveInfo = {

  OSRM_BASE: 'https://router.project-osrm.org',

  _config:    null,  // shared app config (badges, clock-on policy)
  _shop:      null,  // [lat, lng]
  _origin:    null,  // { mode: 'shop'|'custom', address, ll }
  _ready:     null,  // ensureReady() promise
  _dayIndex:  {},    // orderId → { prevMins, dayTotalMins, dayTotalMiles, isFirst, isLast }
  _calcCache: {},    // cache key → { firstMins, totalMins, totalMiles }
  _lastApply: null,  // args of the last apply() for re-renders

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  ensureReady() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      try {
        const res = await OdooAPI.getAppConfig();
        this._config = res?.config || {};
        if (res?.shop_lat && res?.shop_lng) this._shop = [res.shop_lat, res.shop_lng];
      } catch (e) {
        this._config = {};
      }
      try {
        const pid = Auth.getPersonId();
        const saved = pid ? await OdooAPI.getTravelOrigin(pid) : null;
        if (saved && saved.address && saved.lat && saved.lng) {
          this._origin = { mode: 'custom', address: saved.address, ll: [saved.lat, saved.lng] };
        } else {
          this._origin = { mode: 'shop', address: '', ll: this._shop };
        }
      } catch (e) {
        this._origin = { mode: 'shop', address: '', ll: this._shop };
      }
    })();
    return this._ready;
  },

  /** Clock-on may be deferred to Arrived when leaving from a custom origin. */
  isRemoteStart() {
    return this._config?.clock_on_at_arrival_when_remote === true
      && this._origin?.mode === 'custom';
  },

  _badgeScope(key) {
    const badges = this._config?.badges || {};
    return badges[key] || 'both';
  },

  _showBadge(key) {
    const scope = this._badgeScope(key);
    return scope === 'both' || scope === 'pwa';
  },

  // ── Entry point (called from Jobs.renderJobList) ──────────────────────────

  async apply(container, todayJobs, upcomingJobs) {
    this._lastApply = { container, todayJobs, upcomingJobs };
    await this.ensureReady();
    if (!container.isConnected) return; // view changed while loading

    this._indexJobs([...(todayJobs || []), ...(upcomingJobs || [])]);
    this._applyBadgeBars(container, [...(todayJobs || []), ...(upcomingJobs || [])]);

    if ((todayJobs || []).length)    this._renderInfoBox(container, todayJobs, 'today');
    if ((upcomingJobs || []).length) this._renderInfoBox(container, upcomingJobs, 'upcoming');
  },

  _reapply() {
    if (this._lastApply && this._lastApply.container.isConnected) {
      this.apply(this._lastApply.container, this._lastApply.todayJobs, this._lastApply.upcomingJobs);
    }
  },

  // ── Per-day index + badge bars ────────────────────────────────────────────

  _indexJobs(jobs) {
    this._dayIndex = {};
    const byDay = {};
    for (const j of jobs) {
      if (!j.scheduled_date_start) continue;
      const d = new Date(j.scheduled_date_start.replace(' ', 'T') + 'Z');
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      (byDay[key] = byDay[key] || []).push(j);
    }
    for (const list of Object.values(byDay)) {
      list.sort((a, b) => a.scheduled_date_start.localeCompare(b.scheduled_date_start));
      const lastId = list[list.length - 1].id;
      list.forEach((j, i) => {
        this._dayIndex[j.id] = {
          prevMins:      Math.round(j.travel_minutes_from_prev || 0),
          dayTotalMins:  Math.round(j.travel_day_total_minutes || 0),
          dayTotalMiles: j.travel_day_total_miles || 0,
          isFirst:       i === 0,
          isLast:        j.id === lastId,
        };
      });
    }
  },

  _applyBadgeBars(container, jobs) {
    const showLeg   = this._showBadge('drive_leg');
    const showTotal = this._showBadge('drive_total');
    for (const j of jobs) {
      const card = container.querySelector(`.job-card[data-job-id="${j.id}"]`);
      if (!card) continue;
      card.querySelector('.job-badge-bar')?.remove();
      if (!showLeg && !showTotal) continue;

      const e = this._dayIndex[j.id];
      if (!e) continue;
      const chips = [];
      if (showLeg && e.prevMins > 0) {
        chips.push(`<span class="drive-badge drive-badge--leg">&#8672; ${this._fmtMins(e.prevMins)}</span>`);
      }
      if (showTotal && e.isLast && e.dayTotalMins > 0) {
        chips.push(`<span class="drive-badge drive-badge--total">&Sigma; ${this._fmtMins(e.dayTotalMins)}</span>`);
      }
      if (!chips.length) continue;

      const bar = document.createElement('span');
      bar.className = 'job-badge-bar';
      bar.innerHTML = chips.join('');
      // Sit immediately left of the status badge in the card footer
      const statusBadge = card.querySelector('.job-card-footer .status-badge');
      if (statusBadge) {
        statusBadge.insertAdjacentElement('beforebegin', bar);
      } else {
        const addr = card.querySelector('.job-card-address');
        if (addr) addr.insertAdjacentElement('afterend', bar);
        else card.appendChild(bar);
      }
    }
  },

  // ── Info box ──────────────────────────────────────────────────────────────

  _renderInfoBox(container, jobs, kind) {
    const boxId = kind === 'today' ? 'driveInfoToday' : 'driveInfoUpcoming';
    document.getElementById(boxId)?.remove();

    const firstCard = container.querySelector(`.job-card[data-job-id="${jobs[0].id}"]`);
    if (!firstCard) return;

    const box = document.createElement('div');
    box.id = boxId;
    box.className = 'drive-info-box' + (kind === 'upcoming' ? ' drive-info-box--compact' : '');

    const originRow = kind === 'today' ? `
      <div class="drive-info-origin">
        <span class="drive-info-origin-label">&#128663; Leaving from:</span>
        <select id="driveOriginSelect" class="drive-origin-select">
          <option value="shop"${this._origin.mode === 'shop' ? ' selected' : ''}>Shop</option>
          <option value="custom"${this._origin.mode === 'custom' ? ' selected' : ''}>Custom address&hellip;</option>
        </select>
      </div>
      ${this._origin.mode === 'custom'
        ? `<div class="drive-info-address" id="driveOriginAddress">${this._esc(this._origin.address)}
             <button class="drive-origin-change" id="driveOriginChange">change</button></div>`
        : ''}` : '';

    box.innerHTML = `
      ${originRow}
      <div class="drive-info-stats" id="${boxId}Stats">Calculating drive times&hellip;</div>`;
    container.insertBefore(box, firstCard);

    if (kind === 'today') {
      box.querySelector('#driveOriginSelect')?.addEventListener('change', (e) => {
        if (e.target.value === 'custom') this._promptCustomOrigin();
        else this._setShopOrigin();
      });
      box.querySelector('#driveOriginChange')?.addEventListener('click', () => this._promptCustomOrigin());
    }

    this._fillStats(boxId, jobs, kind);
  },

  async _fillStats(boxId, jobs, kind) {
    const el = () => document.getElementById(boxId + 'Stats');
    try {
      const stats = await this._computeDay(jobs);
      const target = el();
      if (!target) return; // re-rendered meanwhile
      if (!stats) { target.textContent = 'Drive times unavailable for this day.'; return; }
      // Compact inline legs: "To 1st job: ~22m · 2nd: ~15m · 3rd: ~9m"
      // (origin context comes from the "Leaving from" row above)
      const ord = (n) => {
        const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
      };
      const items = stats.legMins.slice(0, 10).map((mins, i) =>
        `<span class="drive-info-leg">${i === 0 ? 'To 1st job' : ord(i + 1)}: ` +
        `<b>~${this._fmtMins(mins)}</b></span>`);
      target.innerHTML = items.join('<span class="drive-info-sep">&middot;</span>');
    } catch (e) {
      const target = el();
      if (target) target.textContent = 'Could not compute drive times.';
    }
  },

  /**
   * Drive stats for one day's jobs from the current origin.
   * Shop origin → use the saved estimates when complete (no network);
   * otherwise (custom origin or missing data) → one OSRM route call
   * origin → jobs → origin.
   */
  async _computeDay(jobs) {
    const sorted = [...jobs].sort((a, b) =>
      (a.scheduled_date_start || '').localeCompare(b.scheduled_date_start || ''));

    // Saved estimates path (shop origin only — that's what they were computed
    // from). Each job's travel_minutes_from_prev is the leg that ends at it.
    if (this._origin.mode === 'shop') {
      const legMins = sorted.map(j => this._dayIndex[j.id]?.prevMins || 0);
      if (legMins.length && legMins.every(m => m > 0)) {
        return { legMins, estimated: false };
      }
    }

    const originLL = this._origin.mode === 'custom' ? this._origin.ll : this._shop;
    if (!originLL) return null;

    const ids = sorted.map(j => j.id);
    const cacheKey = `${originLL.join(',')}|${ids.join(',')}`;
    if (this._calcCache[cacheKey]) return this._calcCache[cacheKey];

    let coordMap = {};
    try { coordMap = await OdooAPI.getJobCoords(ids) || {}; } catch (e) { return null; }
    const stops = ids.map(id => coordMap[id]).filter(Boolean);
    if (!stops.length) return null;

    const points = [originLL, ...stops, originLL];
    const coords = points.map(ll => `${(+ll[1]).toFixed(6)},${(+ll[0]).toFixed(6)}`).join(';');
    const resp = await fetch(`${this.OSRM_BASE}/route/v1/driving/${coords}?overview=false`);
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.code !== 'Ok' || !json.routes?.[0]) return null;

    // legs[i] ends at stop i; the last leg (back to origin) isn't shown
    const legs = json.routes[0].legs || [];
    const stats = {
      legMins: legs.slice(0, stops.length).map(l => Math.round(l.duration / 60)),
      estimated: true,
    };
    this._calcCache[cacheKey] = stats;
    return stats;
  },

  // ── Origin selection ──────────────────────────────────────────────────────

  async _setShopOrigin() {
    this._origin = { mode: 'shop', address: '', ll: this._shop };
    const pid = Auth.getPersonId();
    if (pid) OdooAPI.setTravelOrigin(pid, '', 0, 0).catch(() => {});
    this._reapply();
  },

  _promptCustomOrigin() {
    const prefill = this._origin.mode === 'custom'
      ? this._origin.address
      : (localStorage.getItem('drive_origin_last') || '');

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Leaving From</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <p style="margin-top:0;">Enter the address you're leaving from (e.g. home). It will be saved until you change it or switch back to shop.</p>
          <input type="text" class="form-input" id="driveOriginInput"
                 placeholder="Street, City" value="${this._esc(prefill)}">
          <div id="driveOriginError" style="color:var(--error-color);font-size:13px;margin-top:6px;display:none;"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="driveOriginCancel">Cancel</button>
          <button class="btn btn-success" id="driveOriginSave">Save</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => {
      overlay.remove();
      this._reapply(); // restore selector to actual state if cancelled
    };
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.querySelector('#driveOriginCancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#driveOriginSave').addEventListener('click', async () => {
      const input = overlay.querySelector('#driveOriginInput');
      const errEl = overlay.querySelector('#driveOriginError');
      const addr = (input.value || '').trim();
      if (!addr) { errEl.textContent = 'Enter an address.'; errEl.style.display = ''; return; }

      const saveBtn = overlay.querySelector('#driveOriginSave');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Locating…';
      try {
        const ll = await this._geocode(addr);
        if (!ll) {
          errEl.textContent = 'Address not found — try adding city/state.';
          errEl.style.display = '';
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
          return;
        }
        this._origin = { mode: 'custom', address: addr, ll };
        try { localStorage.setItem('drive_origin_last', addr); } catch (e) {}
        const pid = Auth.getPersonId();
        if (pid) OdooAPI.setTravelOrigin(pid, addr, ll[0], ll[1]).catch(() => {});
        overlay.remove();
        this._reapply();
      } catch (e) {
        errEl.textContent = 'Could not save — check your connection.';
        errEl.style.display = '';
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });
  },

  /** Geocode: Odoo Google key first, then Photon (keyless OSM) fallback. */
  async _geocode(address) {
    try {
      const res = await OdooAPI.geocodeAddress(address);
      if (res && res.ok) return [res.lat, res.lng];
    } catch (e) { /* fall through */ }
    try {
      const bias = this._shop ? `&lat=${this._shop[0]}&lon=${this._shop[1]}` : '';
      const resp = await fetch(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(address)}&limit=1&lang=en${bias}`);
      const json = await resp.json();
      const f = json.features?.[0];
      if (f) return [f.geometry.coordinates[1], f.geometry.coordinates[0]];
    } catch (e) { /* no luck */ }
    return null;
  },

  // ── Utils ─────────────────────────────────────────────────────────────────

  _fmtMins(mins) {
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  },

  _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
