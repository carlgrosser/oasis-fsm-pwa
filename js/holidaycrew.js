/**
 * Holiday Lighting crew tools (Odoo module ohl_dispatch):
 *  - Pick Up a Job: install leads see the next open installs they can do today, ranked by the
 *    office's rules (most urgent, then closest), and take one onto their day;
 *  - Report a Change: something done differently from the install map (note + photos), so the
 *    office updates the design;
 *  - Add Items: simple priced items added to the sold order on site, signed or approved by phone;
 *  - Load List: everything to load for the day's Holiday installs, added up (kept for no signal).
 * Except the Load List, all need signal (they change the job in Odoo straight away).
 */
const HolidayCrew = {
  _pool: null,
  _poolAt: 0,
  POOL_REFRESH_MS: 120000,

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },

  _modal(title, bodyHtml, footHtml) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" style="max-width:460px;">
        <div class="modal-header"><h3>${this._esc(title)}</h3><button class="modal-close" data-close>&times;</button></div>
        <div class="modal-body">${bodyHtml}</div>
        ${footHtml ? `<div class="modal-footer">${footHtml}</div>` : ''}
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-close]')) overlay.remove();
    });
    document.body.appendChild(overlay);
    return overlay;
  },

  _needSignal() {
    if (navigator.onLine) return false;
    App.showToast('Needs signal: try again when you have it', 'error');
    return true;
  },

  // ---------------------------------------------------------------- Pick Up a Job
  /** Appends the lead's pool to the Today list (nothing for helpers, or when the pool is off). */
  async renderPool(container) {
    if (!navigator.onLine || typeof Auth === 'undefined' || !Auth.getPersonId()) return;
    const host = document.createElement('div');
    host.className = 'ohl-pool';
    container.appendChild(host);
    try {
      if (!this._pool || Date.now() - this._poolAt > this.POOL_REFRESH_MS) {
        const pos = await GPS.getCurrentPosition().catch(() => null);
        this._pool = await OdooAPI.callKw('fsm.order', 'worker_get_pool',
          [Auth.getPersonId(), pos ? pos.lat : false, pos ? pos.lon : false], {});
        this._poolAt = Date.now();
        this._pos = pos;
      }
    } catch (err) {
      console.warn('Job pool unavailable', err);
      host.remove();
      return;
    }
    const pool = this._pool;
    if (!pool || pool.mode === 'not_lead' || pool.mode === 'off') { host.remove(); return; }
    const cards = pool.jobs.map(j => {
      const due = j.install_by
        ? new Date(j.install_by + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
      const bits = [j.city, j.hours ? `${j.hours}h` : '', j.crew ? `crew ${j.crew}` : '',
        due ? `by ${due}` : '', j.km != null ? `${Math.round(j.km * 0.621 * 10) / 10} mi` : ''].filter(Boolean);
      return `<div class="job-card ohl-pool-card">
          <div style="flex:1;min-width:0;"><b>${this._esc(j.customer)}</b>
            <div style="font-size:13px;color:var(--text-muted);">${this._esc(j.name)} &middot; ${this._esc(bits.join(' · '))}</div></div>
          <button class="btn btn-primary btn-sm" data-take="${j.id}">${pool.approval ? 'Ask' : 'Take'}</button>
        </div>`;
    }).join('');
    host.innerHTML = `<div class="jobs-section-divider"><span class="jobs-section-label">&#127876; Pick up a job</span></div>
      ${cards || '<div style="padding:8px 12px;color:var(--text-muted);font-size:14px;">Nothing open that fits the rest of today.</div>'}`;
    host.querySelectorAll('[data-take]').forEach(btn => btn.addEventListener('click', () => this.take(parseInt(btn.dataset.take, 10), btn)));
  },

  async take(orderId, btn) {
    if (this._needSignal()) return;
    btn.disabled = true;
    try {
      const pos = this._pos;
      const res = await OdooAPI.callKw('fsm.order', 'worker_claim_pool_job',
        [Auth.getPersonId(), orderId, pos ? pos.lat : false, pos ? pos.lon : false], {});
      this._pool = null;
      if (!res.ok) {
        App.showToast(res.reason || 'Not available any more', 'error');
      } else if (res.state === 'pending') {
        App.showToast('Asked the office: it shows up on your list once they approve', 'success');
      } else {
        App.showToast('On your day now', 'success');
      }
      await Jobs.loadJobs('today');
    } catch (err) {
      App.showToast('Could not take it: ' + (err.message || err), 'error');
      btn.disabled = false;
    }
  },

  // ---------------------------------------------------------------- Load List
  _isoDay(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  /** A Load List button on the Today list when today's or the next day's jobs have Holiday installs. */
  renderLoadButton(container, jobs, upcoming) {
    if (typeof InstallMap === 'undefined' || typeof Auth === 'undefined' || !Auth.getPersonId()) return;
    const isInstall = (j) => InstallMap.isHolidayJob(j) && j.ohl_job_kind === 'install';
    const days = [];
    if ((jobs || []).some(isInstall)) days.push({ iso: this._isoDay(new Date()), label: 'Today' });
    const next = (upcoming || []).find(isInstall);
    if (next && next.scheduled_date_start) {
      const d = new Date(next.scheduled_date_start.replace(' ', 'T') + 'Z');
      days.push({ iso: this._isoDay(d), label: d.toLocaleDateString([], { weekday: 'long' }) });
    }
    if (!days.length) return;
    const row = document.createElement('div');
    row.className = 'ohl-load-btn';
    row.style.cssText = 'display:flex;gap:8px;';
    row.innerHTML = days.map(d => `<button class="btn btn-sm" style="flex:1;" data-load="${d.iso}">&#128666; Load list: ${this._esc(d.label)}</button>`).join('');
    row.querySelectorAll('[data-load]').forEach(b => b.addEventListener('click', () => this.openLoadList(b.dataset.load, b.textContent.split(': ')[1])));
    container.insertBefore(row, container.firstChild);
  },

  async openLoadList(iso, label) {
    const key = 'ohl_load_' + iso;
    let data = null;
    let offline = false;
    if (navigator.onLine) {
      try {
        data = await OdooAPI.callKw('fsm.order', 'worker_get_load_list', [Auth.getPersonId(), iso], {});
        await DB.setState(key, Object.assign({ saved_at: Date.now() }, data)).catch(() => {});
      } catch (err) {
        console.warn('Load list: live fetch failed', err);
      }
    }
    if (!data) {
      data = await DB.getState(key).catch(() => null);
      offline = true;
    }
    if (!data) { App.showToast('Not on this phone yet: open it once with signal', 'error'); return; }
    const groups = data.groups.map(g => `<div class="ohl-load-group">${this._esc(g.title)}</div>
        ${g.lines.map(l => `<div class="ohl-load-line"><b>${l.qty}</b><div style="flex:1;">${this._esc(l.label)} ${this._esc(l.unit || '')}
          ${l.jobs.length > 1 ? `<div class="ohl-load-jobs">${this._esc(l.jobs.join(' · '))}</div>` : ''}</div></div>`).join('')}`).join('');
    const from = { design: 'design', last_season: 'last season\'s count', saved: 'count' };
    const jobs = data.jobs.map(j => `<li>${this._esc(j.customer)} <span class="ohl-load-jobs">(${this._esc(from[j.source] || j.source)})</span></li>`).join('');
    const missing = data.missing.length
      ? `<div style="margin-top:10px;color:#c62828;font-size:14px;"><b>No list for:</b> ${this._esc(data.missing.map(m => m.customer).join(', '))}. Check the rehang sheet (sold items and photos).</div>`
      : '';
    this._modal(`Load list: ${label}`, `
      ${offline ? '<div class="ohl-load-jobs">Offline copy</div>' : ''}
      ${groups || '<p>Nothing to add up for these jobs.</p>'}
      ${missing}
      ${jobs ? `<div style="margin-top:12px;font-size:13px;"><b>From</b><ul style="margin:4px 0 0 18px;padding:0;">${jobs}</ul></div>` : ''}
      <p class="ohl-load-jobs" style="margin-top:10px;">Each job's design, else last season's count at the house. Grab spares as usual.</p>`,
      '<button class="btn btn-primary" data-close>Done</button>');
  },

  // ---------------------------------------------------------------- Job buttons
  buttonsHtml(job) {
    if (typeof InstallMap === 'undefined' || !InstallMap.isHolidayJob(job)) return '';
    return `<div style="display:flex;gap:8px;padding:8px 12px 0;">
      <button class="btn btn-sm" id="ohlChangeBtn" style="flex:1;">&#9998;&#65039; Report a Change</button>
      <button class="btn btn-sm" id="ohlAddItemsBtn" style="flex:1;">&#10133; Add Items</button>
    </div>`;
  },

  bind(job) {
    document.getElementById('ohlChangeBtn')?.addEventListener('click', () => this.openChange(job));
    document.getElementById('ohlAddItemsBtn')?.addEventListener('click', () => this.openAddItems(job));
  },

  // ---------------------------------------------------------------- Report a Change
  openChange(job) {
    if (this._needSignal()) return;
    const overlay = this._modal('Different from the map', `
      <p style="margin-top:0;font-size:14px;">What did you do differently? The office updates the design before it's locked.</p>
      <textarea id="ohlChangeNote" rows="4" style="width:100%;" placeholder="e.g. Moved the tree lights to the left oak; extra run on the garage"></textarea>
      <label class="btn btn-sm" style="margin-top:8px;display:inline-block;">&#128247; Add photos
        <input type="file" id="ohlChangePhotos" accept="image/*" capture="environment" multiple style="display:none;"></label>
      <span id="ohlChangeCount" style="font-size:13px;color:var(--text-muted);"></span>`,
      '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="ohlChangeSend">Send</button>');
    const files = overlay.querySelector('#ohlChangePhotos');
    files.addEventListener('change', () => {
      overlay.querySelector('#ohlChangeCount').textContent = files.files.length ? ` ${files.files.length} photo(s)` : '';
    });
    overlay.querySelector('#ohlChangeSend').addEventListener('click', async (e) => {
      const note = overlay.querySelector('#ohlChangeNote').value.trim();
      if (!note) { App.showToast('Say what\'s different', 'error'); return; }
      e.target.disabled = true;
      try {
        for (const file of files.files) {
          const b64 = await this._fileBase64(file);
          await OdooAPI.uploadPhoto(job.id, b64, '', 'design_change');
        }
        const res = await OdooAPI.callKw('fsm.order', 'worker_report_design_change', [job.id, note], {});
        if (!res.ok) throw new Error(res.reason);
        App.showToast('Sent to the office', 'success');
        overlay.remove();
      } catch (err) {
        App.showToast('Not sent: ' + (err.message || err), 'error');
        e.target.disabled = false;
      }
    });
  },

  _fileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ''));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  // ---------------------------------------------------------------- Add Items
  async openAddItems(job) {
    if (this._needSignal()) return;
    let data;
    try {
      data = await OdooAPI.callKw('fsm.order', 'worker_get_addon_items', [job.id], {});
    } catch (err) {
      App.showToast('Could not load items: ' + (err.message || err), 'error');
      return;
    }
    if (!data.items.length) {
      App.showToast('No items set up for adding on site (Odoo: product "Crew Can Add on Site")', 'error');
      return;
    }
    const money = (n) => '$' + Number(n).toFixed(2);
    const overlay = this._modal('Add items on site', `
      ${data.items.map(i => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
          <div style="flex:1;">${this._esc(i.name)}<div style="font-size:12px;color:var(--text-muted);">${money(i.price)} / ${this._esc(i.unit)}</div></div>
          <input type="number" min="0" step="1" value="0" data-item="${i.id}" data-price="${i.price}" style="width:64px;">
        </div>`).join('')}
      <div style="margin:8px 0;font-weight:600;">Total before tax: <span id="ohlAddTotal">$0.00</span></div>
      <label style="display:block;font-size:14px;"><input type="radio" name="ohlAppr" value="signed" checked> Customer signs here</label>
      <label style="display:block;font-size:14px;"><input type="radio" name="ohlAppr" value="phone"> Approved by phone / text</label>
      <input type="text" id="ohlAddWho" value="${this._esc(data.customer)}" placeholder="Customer name" style="width:100%;margin-top:6px;">
      <div id="ohlSigBox" style="margin-top:8px;"><canvas id="ohlAddSig" style="width:100%;height:140px;border:1px solid var(--border-color);border-radius:6px;background:#fff;touch-action:none;"></canvas>
        <button class="btn btn-sm" id="ohlSigClear" style="margin-top:4px;">Clear signature</button></div>
      <textarea id="ohlAddNote" rows="2" style="width:100%;margin-top:6px;" placeholder="Note for the office (optional)"></textarea>`,
      '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="ohlAddSend">Add to order</button>');
    const $ = (s) => overlay.querySelector(s);
    const sig = (typeof Billing !== 'undefined' && Billing._renderSignaturePad) ? Billing._renderSignaturePad('ohlAddSig') : null;
    $('#ohlSigClear').addEventListener('click', () => sig && sig.clear());
    const total = () => {
      let t = 0;
      overlay.querySelectorAll('[data-item]').forEach(i => { t += (parseFloat(i.value) || 0) * parseFloat(i.dataset.price); });
      $('#ohlAddTotal').textContent = money(t);
    };
    overlay.querySelectorAll('[data-item]').forEach(i => i.addEventListener('input', total));
    overlay.querySelectorAll('input[name="ohlAppr"]').forEach(r => r.addEventListener('change', () => {
      const signed = overlay.querySelector('input[name="ohlAppr"]:checked').value === 'signed';
      $('#ohlSigBox').style.display = signed ? '' : 'none';
    }));
    $('#ohlAddSend').addEventListener('click', async (e) => {
      const lines = [...overlay.querySelectorAll('[data-item]')]
        .filter(i => (parseFloat(i.value) || 0) > 0)
        .map(i => ({ product_id: parseInt(i.dataset.item, 10), quantity: parseFloat(i.value) }));
      if (!lines.length) { App.showToast('Pick at least one item', 'error'); return; }
      const approval = overlay.querySelector('input[name="ohlAppr"]:checked').value;
      if (approval === 'signed' && (!sig || sig.isEmpty())) { App.showToast('Have the customer sign', 'error'); return; }
      e.target.disabled = true;
      try {
        await OdooAPI.callKw('fsm.order', 'worker_add_items_on_site', [job.id, lines, approval,
          $('#ohlAddWho').value.trim(), approval === 'signed' ? sig.toBase64() : false, $('#ohlAddNote').value.trim()], {});
        App.showToast('Added to the order', 'success');
        overlay.remove();
      } catch (err) {
        App.showToast('Not added: ' + (err.message || err), 'error');
        e.target.disabled = false;
      }
    });
  },
};
