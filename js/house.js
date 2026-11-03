/**
 * Holiday Lighting: the House screen. Everything about the house in one place, install map first:
 * the design's map or the map photos on the house, how it should look, what's still open there
 * (damage, a callback), outlets and timers, the house notes, earlier seasons' photos and the last count.
 *
 * Odoo sends it as data (worker_get_house) with its pictures; it is kept on the device (IndexedDB)
 * so it opens with no signal, and fetched again only when something changed (stamp).
 */
const HouseScreen = {
  KINDS: ['install', 'takedown', 'service', 'greenery', 'consult'],

  isHouseJob(job) {
    const company = Array.isArray(job.company_id) ? job.company_id[0] : job.company_id;
    return company === CONFIG.HOLIDAY_COMPANY_ID && this.KINDS.includes(job.ohl_job_kind);
  },

  _key(jobId) { return 'house_' + jobId; },

  /** {house data..., saved_at, offline} or {reason}. Online: ask Odoo with the saved stamp. */
  async load(job) {
    const saved = await DB.getState(this._key(job.id)).catch(() => null);
    if (navigator.onLine) {
      try {
        const res = await OdooAPI.callKw('fsm.order', 'worker_get_house', [job.id, saved ? saved.stamp : false], {});
        if (res && res.ok && res.unchanged && saved) return saved;
        if (res && res.ok && res.sections) {
          const house = Object.assign({}, res, { saved_at: Date.now() });
          await DB.setState(this._key(job.id), house).catch(() => {});
          return house;
        }
        if (res && !res.ok) return { reason: res.reason };
      } catch (err) {
        console.warn('House screen: live fetch failed, using the saved copy', err);
      }
    }
    if (saved && saved.sections) return Object.assign({}, saved, { offline: true });
    return { reason: 'Not saved on this device yet: open it once with signal.' };
  },

  /** Fetch and keep it ahead of time (with the day's jobs). */
  async prewarm(job) {
    if (!this.isHouseJob(job) || !navigator.onLine) return;
    await this.load(job).catch(() => {});
  },

  async open(job) {
    const overlay = document.createElement('div');
    overlay.className = 'house-overlay';
    overlay.innerHTML = `
      <div class="house-bar">
        <button class="btn btn-sm" data-act="close">&larr; Back</button>
        <div class="house-bar-title">
          <div class="house-title">&#127968; House</div>
          <div class="house-sub">Loading&hellip;</div>
        </div>
      </div>
      <div class="house-body"></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'close') overlay.remove();
      const pic = e.target.closest('[data-pic]');
      if (pic) this.zoom(pic.querySelector('img'));
    });
    const sub = overlay.querySelector('.house-sub');
    const body = overlay.querySelector('.house-body');
    const house = await this.load(job);
    if (!house.sections) {
      sub.textContent = '';
      body.innerHTML = `<div class="empty-state" style="padding:24px;text-align:center;">
        <p>${this._esc(house.reason || 'Nothing about this house yet.')}</p></div>`;
      return;
    }
    const when = new Date(house.saved_at).toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    overlay.querySelector('.house-title').textContent = house.title || 'House';
    sub.textContent = (house.address ? house.address + ' · ' : '')
      + (house.offline ? `offline copy from ${when}` : `updated ${when}`);
    body.innerHTML = this._render(house);
  },

  _render(house) {
    const facts = (house.facts || []).filter((f) => f[1]).map((f) =>
      `<span class="house-fact"><b>${this._esc(f[0])}:</b> ${this._esc(f[1])}</span>`).join('');
    const notes = (house.notes || []).map((n) => `<div class="house-note">${this._esc(n)}</div>`).join('');
    // The install map first, then what's open at the house, then the notes.
    const [first, ...rest] = house.sections || [];
    const open = rest.filter((s) => s.warn);
    const others = rest.filter((s) => !s.warn);
    const html = (list) => list.map((s) => this._section(s)).join('');
    return `${facts ? `<div class="house-facts">${facts}</div>` : ''}${first ? this._section(first) : ''}${html(open)}
      ${notes ? `<div class="house-section"><h3>Notes</h3>${notes}</div>` : ''}${html(others)}`;
  },

  _section(section) {
    const parts = [];
    if (section.svg) {
      // The drawn diagram, as a picture (an SVG in an <img> runs nothing).
      const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(section.svg);
      parts.push(`<div class="house-pic" data-pic="1"><img src="${src}" alt="Install map"/></div>`);
    }
    for (const pic of section.pictures || []) {
      const img = pic.style
        ? `<div class="house-crop"><img src="${pic.src}" style="${this._esc(pic.style).replace(/"/g, '&quot;')}" alt=""/></div>`
        : `<img src="${pic.src}" alt=""/>`;
      parts.push(`<div class="house-pic" data-pic="1">${img}
        ${pic.caption ? `<div class="house-caption">${this._esc(pic.caption)}</div>` : ''}</div>`);
    }
    if (section.rows && section.rows.length) {
      parts.push(`<ul class="house-rows">${section.rows.map((r) => `<li>${this._esc(r)}</li>`).join('')}</ul>`);
    }
    if (section.empty) parts.push(`<div class="house-empty">${this._esc(section.empty)}</div>`);
    return `<div class="house-section${section.warn ? ' house-warn' : ''}">
      <h3>${this._esc(section.title || '')}</h3>${parts.join('')}</div>`;
  },

  /** One picture full screen: tap + / − (or pinch) to zoom, drag to look around. */
  zoom(img) {
    if (!img) return;
    const view = document.createElement('div');
    view.className = 'house-zoom';
    view.innerHTML = `<div class="house-zoom-bar">
        <button class="btn btn-sm" data-z="close">&times; Close</button>
        <span style="flex:1"></span>
        <button class="btn btn-sm" data-z="out" aria-label="Zoom out">&minus;</button>
        <button class="btn btn-sm" data-z="in" aria-label="Zoom in">+</button>
      </div>
      <div class="house-zoom-body"><img src="${img.getAttribute('src')}" alt=""/></div>`;
    document.body.appendChild(view);
    const big = view.querySelector('img');
    let scale = 1;
    view.addEventListener('click', (e) => {
      const z = e.target.closest('[data-z]');
      if (!z) return;
      if (z.dataset.z === 'close') view.remove();
      if (z.dataset.z === 'in') scale = Math.min(scale * 1.5, 6);
      if (z.dataset.z === 'out') scale = Math.max(scale / 1.5, 1);
      big.style.width = (100 * scale) + '%';
    });
  },

  _esc(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  },
};
