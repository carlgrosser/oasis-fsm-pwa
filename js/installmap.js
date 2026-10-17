/**
 * Holiday Lighting: the job's Install Map & Picking List on the iPad.
 *
 * The office approves a design (Ready for Install); Odoo sends the printed sheet as one
 * stand-alone page (worker_get_install_sheet). A rehang with no design gets the sold order's
 * picking list with the house's map photos and last season's count instead. It is kept on the device (IndexedDB) so it
 * opens with no signal, and fetched again only when the design changed (stamp).
 */
const InstallMap = {
  /** A Holiday install or takedown (Tile Cleaning jobs carry the same default job kind). */
  isHolidayJob(job) {
    const company = Array.isArray(job.company_id) ? job.company_id[0] : job.company_id;
    return company === CONFIG.HOLIDAY_COMPANY_ID
      && (job.ohl_job_kind === 'install' || job.ohl_job_kind === 'takedown');
  },

  buttonHtml(job) {
    if (!this.isHolidayJob(job)) return '';
    const sheet = job.ohl_design_id ? 'Picking List' : 'Rehang Sheet';
    const map = typeof HolidayMap !== 'undefined'
      ? '<button class="btn btn-primary" id="ohlMapBtn">&#128506;&#65039; Map</button>' : '';
    const used = job.ohl_job_kind === 'install' && typeof HolidayUsed !== 'undefined'
      ? '<div class="ohl-map-row"><button class="btn" id="ohlUsedBtn">&#9989; Actual Used</button></div>' : '';
    return `<div class="install-map-row ohl-map-row">
      ${map}
      <button class="btn${map ? '' : ' btn-primary'}" id="installMapBtn">&#128196; ${sheet}</button>
    </div>${used}`;
  },

  bind(job) {
    document.getElementById('installMapBtn')?.addEventListener('click', () => this.open(job));
    document.getElementById('ohlMapBtn')?.addEventListener('click', () => HolidayMap.open(job));
    document.getElementById('ohlUsedBtn')?.addEventListener('click', () => HolidayUsed.open(job));
  },

  _key(jobId) { return 'ism_' + jobId; },

  /**
   * The sheet for a job: {html, stamp, design, status, saved_at, offline} or {reason}.
   * Online: ask Odoo (sending the saved stamp, so an unchanged sheet isn't re-sent).
   * Offline or failing: the saved copy.
   */
  async load(job) {
    const saved = await DB.getState(this._key(job.id)).catch(() => null);
    if (navigator.onLine) {
      try {
        const res = await OdooAPI.callKw('fsm.order', 'worker_get_install_sheet',
          [job.id, saved ? saved.stamp : false], {});
        if (res && res.ok && res.unchanged && saved) return saved;
        if (res && res.ok && res.html) {
          const sheet = { html: res.html, stamp: res.stamp, design: res.design, status: res.status,
                          saved_at: Date.now() };
          await DB.setState(this._key(job.id), sheet).catch(() => {});
          return sheet;
        }
        if (res && !res.ok) {
          // No sheet (any more): don't keep showing an old one.
          await DB.setState(this._key(job.id), null).catch(() => {});
          return { reason: res.reason };
        }
      } catch (err) {
        console.warn('Install sheet: live fetch failed, using the saved copy', err);
      }
    }
    if (saved && saved.html) return Object.assign({}, saved, { offline: true });
    return { reason: 'Not saved on this device yet: open it once with signal.' };
  },

  /** Fetch and keep the sheet for a job ahead of time (called with the day's jobs). */
  async prewarm(job) {
    if (!this.isHolidayJob(job) || !navigator.onLine) return;
    await this.load(job).catch(() => {});
    if (typeof HolidayUsed !== 'undefined') await HolidayUsed.prewarm(job);
  },

  async open(job) {
    const overlay = document.createElement('div');
    overlay.className = 'install-map-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:#fff;display:flex;flex-direction:column;';
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #ddd;
                  padding-top:max(8px, env(safe-area-inset-top));background:#f7f7f7;">
        <button class="btn btn-sm" data-act="close">&larr; Back</button>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${job.ohl_design_id ? 'Install Map &amp; Picking List' : 'Rehang Sheet &amp; Photos'}</div>
          <div class="ism-sub" style="font-size:12px;color:#666;">Loading&hellip;</div>
        </div>
        <button class="btn btn-sm" data-act="out" aria-label="Zoom out">&minus;</button>
        <button class="btn btn-sm" data-act="in" aria-label="Zoom in">+</button>
      </div>
      <div class="ism-body" style="flex:1;position:relative;overflow:hidden;"></div>`;
    document.body.appendChild(overlay);
    const sub = overlay.querySelector('.ism-sub');
    const body = overlay.querySelector('.ism-body');
    let zoom = 1;
    const applyZoom = () => {
      const frame = body.querySelector('iframe');
      const doc = frame && frame.contentDocument;
      if (doc && doc.body) doc.body.style.zoom = String(zoom);
    };
    overlay.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'close') overlay.remove();
      if (act.dataset.act === 'in') { zoom = Math.min(zoom * 1.25, 4); applyZoom(); }
      if (act.dataset.act === 'out') { zoom = Math.max(zoom / 1.25, 0.3); applyZoom(); }
    });

    const sheet = await this.load(job);
    if (!sheet.html) {
      sub.textContent = '';
      body.innerHTML = `<div class="empty-state" style="padding:24px;text-align:center;">
        <p>${this._esc(sheet.reason || 'No install map for this job.')}</p></div>`;
      return;
    }
    const when = new Date(sheet.saved_at).toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    sub.textContent = `${sheet.design || ''}${sheet.status ? ' · ' + sheet.status : ''} · `
      + (sheet.offline ? `offline copy from ${when}` : `updated ${when}`);
    const frame = document.createElement('iframe');
    // No scripts in the sheet; same-origin only so the zoom buttons can reach its body.
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.style.cssText = 'border:0;width:100%;height:100%;';
    frame.srcdoc = sheet.html;
    frame.addEventListener('load', () => {
      // Fit the Letter-width sheet to the screen to start with.
      const width = body.clientWidth || 800;
      zoom = Math.min(1, Math.max(0.3, width / 840));
      applyZoom();
    });
    body.appendChild(frame);
  },

  _esc(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
};
