/**
 * Holiday Lighting: Actual Used — what the crew used on a job (bulbs, strands, clips, cords, timers),
 * counted at the end of the job or in the truck (Odoo: worker_get_used / worker_save_used).
 *
 * The count starts from the plan (the design's picking list) or last season's count at the house,
 * so the crew only changes what's different and taps Save. Kept on the device for no-signal use;
 * a count saved without signal is sent when the signal is back.
 */
const HolidayUsed = {
  PENDING_KEY: 'ohu_pending',

  _key(jobId) { return 'ohu_' + jobId; },

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },

  /** {source, rows, saved_at, saved_by, catalog} from Odoo, else the device's copy. */
  async load(jobId) {
    const saved = await DB.getState(this._key(jobId)).catch(() => null);
    const pending = (await this._pending())[jobId];
    if (navigator.onLine && !pending) {
      try {
        const data = await OdooAPI.callKw('fsm.order', 'worker_get_used', [jobId], {});
        await DB.setState(this._key(jobId), data).catch(() => {});
        return data;
      } catch (err) {
        console.warn('Actual used: live fetch failed, using the saved copy', err);
      }
    }
    if (saved && pending) return Object.assign({}, saved, { rows: pending.rows, source: 'pending' });
    return saved || null;
  },

  async prewarm(job) {
    if (!navigator.onLine || job.ohl_job_kind !== 'install') return;
    await this.load(job.id).catch(() => {});
  },

  async _pending() {
    return (await DB.getState(this.PENDING_KEY).catch(() => null)) || {};
  },

  /** Send the counts saved without signal. */
  async flush() {
    if (!navigator.onLine) return;
    const pending = await this._pending();
    const ids = Object.keys(pending);
    if (!ids.length) return;
    for (const id of ids) {
      try {
        await OdooAPI.callKw('fsm.order', 'worker_save_used', [parseInt(id, 10), pending[id].rows], {});
        delete pending[id];
        await DB.setState(this._key(id), null).catch(() => {});
      } catch (err) {
        console.warn('Actual used: still not sent for job', id, err);
      }
    }
    await DB.setState(this.PENDING_KEY, pending).catch(() => {});
    if (!Object.keys(pending).length && typeof App !== 'undefined') App.showToast('Counts sent to the office', 'success');
  },

  _sourceText(data) {
    if (data.source === 'saved') {
      const when = data.saved_at
        ? new Date(data.saved_at.replace(' ', 'T') + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '';
      return `Saved${data.saved_by ? ' by ' + data.saved_by : ''}${when ? ', ' + when : ''}. Change anything and save again.`;
    }
    if (data.source === 'pending') return 'Saved on this iPad: it goes to the office when there\'s signal.';
    if (data.source === 'design') return 'From the plan. Change only what\'s different, then Save.';
    if (data.source === 'last_season') return 'From last season\'s count here. Change what\'s different, then Save.';
    return 'Nothing to start from: tap Add for each thing you used.';
  },

  _step(row) {
    return (row.unit === 'ft' || Math.max(row.planned || 0, row.qty || 0) >= 100) ? 10 : 1;
  },

  async open(job) {
    const overlay = document.createElement('div');
    overlay.className = 'ohu-overlay';
    overlay.innerHTML = `
      <div class="ohu-head">
        <button class="btn btn-sm" data-act="close">&larr; Back</button>
        <div style="flex:1;min-width:0;"><div class="ohu-title">Actual Used</div>
          <div class="ohu-sub">Loading&hellip;</div></div>
      </div>
      <div class="ohu-body"></div>
      <div class="ohu-foot">
        <button class="btn btn-lg" data-act="add">&#10133; Add</button>
        <button class="btn btn-primary btn-lg" data-act="save" disabled>&#10003; Save</button>
      </div>
      <div class="ohu-add" hidden></div>`;
    document.body.appendChild(overlay);
    const $ = (s) => overlay.querySelector(s);
    const data = await this.load(job.id);
    if (!data) {
      $('.ohu-sub').textContent = '';
      $('.ohu-body').innerHTML = '<div class="empty-state" style="padding:24px;">Not on this iPad yet: open it once with signal.</div>';
      $('[data-act="add"]').disabled = true;
      overlay.addEventListener('click', (e) => { if (e.target.closest('[data-act="close"]')) overlay.remove(); });
      return;
    }
    const rows = (data.rows || []).map(r => Object.assign({}, r));
    const catalog = data.catalog || { groups: [], bulb_types: [], colors: [], strand_types: [], attachments: [], extras: [] };
    $('.ohu-sub').textContent = this._sourceText(data);
    $('[data-act="save"]').disabled = false;

    const render = () => {
      const groups = (catalog.groups.length ? catalog.groups : [{ key: 'other', title: 'Items' }]);
      let html = '';
      groups.forEach(g => {
        const list = rows.map((r, i) => [r, i]).filter(([r]) => (r.group || 'other') === g.key);
        if (!list.length) return;
        html += `<div class="ohu-group">${this._esc(g.title)}</div>`;
        html += list.map(([r, i]) => {
          const diff = r.planned && r.qty !== r.planned;
          return `<div class="ohu-row${diff ? ' ohu-diff' : ''}" data-i="${i}">
              <div class="ohu-label">${this._esc(r.label)}
                ${r.planned ? `<div class="ohu-plan">plan ${r.planned}${r.unit ? ' ' + this._esc(r.unit) : ''}</div>` : ''}</div>
              <button class="ohu-btn" data-step="-1" aria-label="Less">&minus;</button>
              <input class="ohu-qty" type="number" inputmode="decimal" min="0" value="${r.qty || 0}" aria-label="${this._esc(r.label)}">
              <button class="ohu-btn" data-step="1" aria-label="More">+</button>
              <span class="ohu-unit">${this._esc(r.unit || '')}</span>
            </div>`;
        }).join('');
      });
      $('.ohu-body').innerHTML = html || '<div class="empty-state" style="padding:24px;">Tap &#10133; Add for each thing you used.</div>';
    };
    render();

    $('.ohu-body').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-step]');
      if (!btn) return;
      const i = parseInt(btn.closest('.ohu-row').dataset.i, 10);
      const row = rows[i];
      row.qty = Math.max(0, (parseFloat(row.qty) || 0) + parseInt(btn.dataset.step, 10) * this._step(row));
      render();
    });
    $('.ohu-body').addEventListener('change', (e) => {
      if (!e.target.classList.contains('ohu-qty')) return;
      const i = parseInt(e.target.closest('.ohu-row').dataset.i, 10);
      rows[i].qty = Math.max(0, e.target.valueAsNumber || 0);
      render();
    });

    const addRow = (row) => {
      const found = rows.findIndex(r => r.label === row.label);
      if (found < 0) rows.push(Object.assign({ qty: 0, planned: 0, unit: '' }, row));
      $('.ohu-add').hidden = true;
      render();
      const idx = found < 0 ? rows.length - 1 : found;
      const input = overlay.querySelector(`.ohu-row[data-i="${idx}"] .ohu-qty`);
      if (input) { input.scrollIntoView({ block: 'center' }); input.focus(); input.select(); }
    };
    const showAdd = (step, picked) => {
      const box = $('.ohu-add');
      box.hidden = false;
      const chip = (attrs, text, swatch) => `<button class="ohu-chip" ${attrs}>${swatch ? `<span class="ohu-swatch" style="background:${this._esc(swatch)}"></span>` : ''}${this._esc(text)}</button>`;
      let body = '';
      if (step === 'kind') {
        body = `<div class="ohu-add-title">What did you use?</div>
          ${chip('data-kind="bulb"', 'Bulbs')}${chip('data-kind="strand"', 'Mini strands')}
          ${chip('data-kind="attachment"', 'Clips / stakes')}${chip('data-kind="cord"', 'Cords & plugs')}
          ${chip('data-kind="timer"', 'Timers')}${chip('data-kind="other"', 'Something else')}`;
      } else if (step === 'bulb') {
        body = `<div class="ohu-add-title">Which bulbs?</div>${catalog.bulb_types.map(b => chip(`data-bulb="${b.id}"`, b.name)).join('')}`;
      } else if (step === 'color') {
        body = `<div class="ohu-add-title">${this._esc(picked.name)}: which color?</div>
          ${catalog.colors.map(c => chip(`data-color="${c.id}"`, c.name, c.hex)).join('')}`;
      } else if (step === 'strand') {
        body = `<div class="ohu-add-title">Which strands?</div>${catalog.strand_types.map(s => chip(`data-strand="${s.id}"`, s.name)).join('')}`;
      } else if (step === 'attachment') {
        body = `<div class="ohu-add-title">Which clips?</div>${catalog.attachments.map(a => chip(`data-att="${a.id}"`, a.name)).join('')}
          ${catalog.extras.filter(x => x.group === 'attachment').map((x) => chip(`data-extra="${this._esc(x.label)}"`, x.label)).join('')}`;
      } else if (step === 'cord' || step === 'timer') {
        body = `<div class="ohu-add-title">Which one?</div>
          ${catalog.extras.filter(x => x.group === step).map(x => chip(`data-extra="${this._esc(x.label)}"`, x.label)).join('')}
          ${chip('data-kind="other"', 'Something else')}`;
      } else {
        body = `<div class="ohu-add-title">What was it?</div>
          <input type="text" class="ohu-other" placeholder="e.g. Wreath hanger, Command hooks">
          <button class="btn btn-primary" data-other-ok style="margin-top:8px;">Add</button>`;
      }
      box.innerHTML = `<div class="ohu-add-card">${body}<div style="margin-top:12px;"><button class="btn" data-add-cancel>Cancel</button></div></div>`;
      box.dataset.step = step;
      box.dataset.group = step === 'other' ? (picked && picked.group) || 'other' : (box.dataset.group || '');
      const other = box.querySelector('.ohu-other');
      if (other) other.focus();
    };
    let bulbPicked = null;
    $('.ohu-add').addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.hasAttribute('data-add-cancel')) { $('.ohu-add').hidden = true; return; }
      if (t.dataset.kind) { showAdd(t.dataset.kind, { group: t.dataset.kind === 'other' ? $('.ohu-add').dataset.step : t.dataset.kind }); return; }
      if (t.dataset.bulb) {
        bulbPicked = catalog.bulb_types.find(b => String(b.id) === t.dataset.bulb);
        showAdd('color', bulbPicked);
        return;
      }
      if (t.dataset.color) {
        const color = catalog.colors.find(c => String(c.id) === t.dataset.color);
        addRow({ group: 'bulb', label: `${bulbPicked.name} ${color.name}`, unit: 'bulbs',
                 bulb_type_id: bulbPicked.id, color_id: color.id });
        return;
      }
      if (t.dataset.strand) {
        const s = catalog.strand_types.find(x => String(x.id) === t.dataset.strand);
        addRow({ group: 'strand', label: s.name, unit: 'strands', strand_type_id: s.id });
        return;
      }
      if (t.dataset.att) {
        const a = catalog.attachments.find(x => String(x.id) === t.dataset.att);
        addRow({ group: 'attachment', label: a.name, attachment_id: a.id });
        return;
      }
      if (t.dataset.extra) {
        const x = catalog.extras.find(y => y.label === t.dataset.extra);
        addRow({ group: x.group, label: x.label, unit: x.unit });
        return;
      }
      if (t.hasAttribute('data-other-ok')) {
        const label = ($('.ohu-other').value || '').trim();
        if (!label) return;
        const g = $('.ohu-add').dataset.group;
        addRow({ group: ['cord', 'timer', 'attachment'].includes(g) ? g : 'other', label });
      }
    });

    overlay.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'close') overlay.remove();
      if (act.dataset.act === 'add') showAdd('kind');
      if (act.dataset.act === 'save') {
        // An input still being typed in: take its value.
        overlay.querySelectorAll('.ohu-qty').forEach(inp => {
          const i = parseInt(inp.closest('.ohu-row').dataset.i, 10);
          rows[i].qty = Math.max(0, inp.valueAsNumber || 0);
        });
        act.disabled = true;
        try {
          // Added and left at 0: not used. A planned item at 0 stays (the plan was wrong).
          await this.save(job.id, rows.filter(r => (r.qty || 0) > 0 || (r.planned || 0) > 0), data);
          overlay.remove();
        } catch (err) {
          App.showToast('Not saved: ' + (err.message || err), 'error');
          act.disabled = false;
        }
      }
    });
  },

  async save(jobId, rows, data) {
    if (navigator.onLine) {
      try {
        await OdooAPI.callKw('fsm.order', 'worker_save_used', [jobId, rows], {});
        await DB.setState(this._key(jobId), Object.assign({}, data, { rows, source: 'saved', saved_at: '' })).catch(() => {});
        App.showToast('Count saved', 'success');
        return;
      } catch (err) {
        if (navigator.onLine && !/network|fetch|timeout/i.test(String(err.message || err))) throw err;
      }
    }
    const pending = await this._pending();
    pending[jobId] = { rows, at: Date.now() };
    await DB.setState(this.PENDING_KEY, pending);
    App.showToast('Saved on this iPad: it goes to the office when there\'s signal', 'success');
  },
};

window.addEventListener('online', () => HolidayUsed.flush().catch(() => {}));
setTimeout(() => HolidayUsed.flush().catch(() => {}), 5000);
