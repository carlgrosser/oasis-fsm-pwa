/**
 * Holiday Lighting: Actual Used by element (Odoo ohl_dispatch: worker_get_used → elements, worker_save_actual,
 * worker_used_later, worker_save_swaps).
 *
 * Every part of the house (roofline runs, Tree 1, the bushes) is listed:
 *  - first count at a house (Carl 2026-11-08): every box starts empty and must be typed; nothing comes from the
 *    quote or design (estimates), and there is no one-tap button;
 *  - later years: prefilled from last year's ACTUAL count, with "Same as last year's count"; anything new, or
 *    changed in the design since that count, is blank and must be counted.
 *  - Where it came from: all from the kit (a rehang), all from the truck (a new house), or some of each.
 *    Only the truck part comes off the truck.
 *  - Replaced anything? Strand / Bulbs / Wire / Clips chips (optional, zero taps when skipped).
 *  - Finish later closes the job without it (the office sees it on its list); the draft stays on the phone.
 *  - With no signal it's saved on the phone and sent once when the signal is back.
 */
const HolidayActual = {
  PENDING_KEY: 'oha_pending',
  TRUCK_KEY: 'oha_truck',
  SWAP_TITLES: { strand: 'Strand', bulbs: 'Bulbs', wire: 'Wire', clips: 'Clips' },
  SWAP_HELP: {
    strand: 'A bad strand swapped: a good one off the truck, the bad one rides back to the Repair bin.',
    bulbs: 'Optional. Broken bulbs are thrown away; the Friday truck check corrects the bulb count anyway.',
    wire: 'Wire replaced: off the truck, the old piece is thrown away.',
    clips: 'Clips replaced: off the truck.',
  },

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },
  _draftKey(jobId) { return 'oha_draft_' + jobId; },
  _uid() { return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },

  async _pending() { return (await DB.getState(this.PENDING_KEY).catch(() => null)) || {}; },

  /** Send what was saved without signal (counts, swaps, "finish later"). */
  async flush() {
    if (!navigator.onLine) return;
    const pending = await this._pending();
    const ids = Object.keys(pending);
    if (!ids.length) return;
    let sent = 0;
    for (const id of ids) {
      const p = pending[id];
      try {
        if (p.kind === 'later') await OdooAPI.callKw('fsm.order', 'worker_used_later', [parseInt(id, 10)], {});
        else if (p.kind === 'swaps') await OdooAPI.callKw('fsm.order', 'worker_save_swaps', [parseInt(id, 10), p.swaps, p.truck_id || false], {});
        else await OdooAPI.callKw('fsm.order', 'worker_save_actual', [parseInt(id, 10), p.payload], {});
        delete pending[id];
        sent += 1;
        if (!p.kind || p.kind === 'count') await DB.setState(this._draftKey(id), null).catch(() => {});
      } catch (err) {
        console.warn('Actual used: still not sent for job', id, err);
      }
    }
    await DB.setState(this.PENDING_KEY, pending).catch(() => {});
    if (sent && typeof App !== 'undefined') App.showToast(`Counts sent to the office (${sent})`, 'success');
  },

  async _queue(jobId, entry) {
    const pending = await this._pending();
    // A count replaces an earlier "finish later" or swaps for the same job (it carries the swaps too).
    if (entry.kind === 'swaps' && pending[jobId] && (!pending[jobId].kind || pending[jobId].kind === 'count')) {
      pending[jobId].payload.swaps = entry.swaps;
    } else {
      pending[jobId] = Object.assign({ at: Date.now() }, entry);
    }
    await DB.setState(this.PENDING_KEY, pending);
  },

  async _call(jobId, method, args, entry) {
    if (navigator.onLine) {
      try {
        return await OdooAPI.callKw('fsm.order', method, [jobId].concat(args), {});
      } catch (err) {
        if (navigator.onLine && !OdooAPI.isOffline(err)) throw err;
      }
    }
    await this._queue(jobId, entry);
    return { queued: true };
  },

  /** Finish later: the job can close; the office's "Actual Used Missing" list shows it. */
  async later(job, draft) {
    if (draft) await DB.setState(this._draftKey(job.id), draft).catch(() => {});
    const res = await this._call(job.id, 'worker_used_later', [], { kind: 'later' });
    App.showToast(res.queued ? 'Finish later: saved on this phone (sent with signal)' : 'Finish later: the office sees it on its list. Count it tonight.', 'success');
    // Show it on the job at once, online or not (round 4 F-13): the step reads "Finish later" straight away.
    if (typeof HolidayFlow !== 'undefined') {
      const data = HolidayFlow._data && HolidayFlow._data[job.id];
      const step = data && data.steps.find(s => s.type === 'used');
      if (step) {
        Object.assign(step, { done: false, skipped: true, reason: 'Finish later' });
        await DB.setState(HolidayFlow._key(job.id), data).catch(() => {});
      }
      if (res.queued && data) {
        const top = document.getElementById('ohfTop');
        if (top) HolidayFlow._renderTop(job, data, top);
        HolidayFlow.renderFinish(job);
      } else {
        HolidayFlow.refresh(job).catch(() => {});
      }
    }
    return res;
  },

  // ------------------------------------------------------------------ the screen
  async render(job, data, onClose, overlay, opts) {
    const $ = (s) => overlay.querySelector(s);
    const draft = await DB.getState(this._draftKey(job.id)).catch(() => null);
    const pending = (await this._pending())[job.id];
    let src = (pending && pending.payload) || draft || null;
    // First count at this house (Carl 2026-11-08): everything is counted, nothing comes from the quote or design.
    // A draft made by an older app version from the estimate doesn't count.
    const first = !!data.first_count && data.source !== 'saved';
    if (first && src && !pending && (src.elements || []).some(e => ['design', 'quote'].includes(e.source))) src = null;
    const isBlank = (v) => v === null || v === undefined || v === '';
    const state = {
      from: (src && src.from) || (data.source === 'saved' ? 'mix' : data.default_from || 'kit'),
      truckId: (src && src.truck_id) || data.truck_id || (await DB.getState(this.TRUCK_KEY).catch(() => null)) || null,
      elements: JSON.parse(JSON.stringify((src && src.elements) || data.elements || [])),
      houseRows: JSON.parse(JSON.stringify((src && src.house_rows) || data.house_rows || [])),
      // Per tree / bush / run (optional; they feed the product totals), when the house has a design or a crew map.
      parts: JSON.parse(JSON.stringify((src && src.parts) || data.parts || [])),
      swaps: JSON.parse(JSON.stringify((src && src.swaps) || data.swaps || [])),
      open: null, adding: null, swapKind: null,
    };
    state.elements.forEach(e => {
      if (e.ok === undefined) e.ok = data.source === 'saved' || e.source === 'saved';
      e.items.forEach(i => {
        if (i.truck_qty === undefined || i.truck_qty === null) i.truck_qty = state.from === 'truck' ? (i.qty || 0) : 0;
        if (i.counted === undefined) i.counted = e.source === 'saved';
      });
    });
    state.houseRows.forEach(r => { if (r.counted === undefined) r.counted = data.source === 'saved'; });
    const elBlank = (e) => e.items.some(i => isBlank(i.qty));
    const lastYear = (e) => e.source === 'last_season';
    const trucks = data.trucks || [];
    if (!state.truckId && trucks.length === 1) state.truckId = trucks[0].id;
    const sub = data.source === 'saved' ? `Saved${data.saved_by ? ' by ' + this._esc(data.saved_by) : ''}. Change anything and save again.`
      : pending ? 'Saved on this phone: it goes to the office when there\'s signal.'
        : draft ? 'Your draft from earlier (Finish later).'
          : first ? (data.per_product ? '<b>First count at this house:</b> type how many of each went up (0 if none). Nothing comes from the quote.'
            : '<b>First count at this house:</b> count everything and type each number (0 if none). Nothing comes from the quote.')
            : 'From last year\'s count: tap Same as last year, or change what\'s different. Anything new or changed in the design must be counted.';
    $('.ohu-sub').innerHTML = sub;

    const checked = () => state.elements.filter(e => e.ok).length;
    const truckPart = () => state.from === 'truck' || state.elements.some(e => e.kind === 'added' && e.from !== 'kit')
      || (state.from === 'mix' && state.elements.some(e => e.items.some(i => (i.truck_qty || 0) > 0)));
    // "Some of each" (round 4 F-05): from the kit, except what is above last year's count, which came off the truck.
    const mixTruck = (e, i) => (e.kind === 'added' ? (e.from === 'kit' ? 0 : (i.qty || 0))
      : lastYear(e) ? Math.max(0, (i.qty || 0) - (i.planned || 0)) : 0);
    const needsTruck = () => truckPart() || state.swaps.length > 0;
    // recount: the design changed this element since its last count, so it is counted again (no last-year figure).
    const sourceBadge = (e) => (e.recount ? 'changed in the design: count again' : { last_season: 'last year', count: 'count it', saved: 'saved' }[e.source] || '');
    const itemLine = (i, e) => isBlank(i.qty) ? `${this._esc(i.label)}: <b class="oha-tocount">not counted</b>`
      : `${this._esc(i.label)}: <b>${i.qty}</b> ${this._esc(i.unit || '')}${lastYear(e) && i.planned && i.planned !== i.qty ? ` <span class="oha-was">(last year ${i.planned})</span>` : ''}${state.from === 'mix' && i.truck_qty ? ` <span class="oha-truckq">${i.truck_qty} off the truck</span>` : ''}`;

    const stepper = (attr, value, label) => `<div class="oha-step">
        <button class="ohu-btn" data-${attr}="-1" aria-label="Less">&minus;</button>
        <input class="ohu-qty" type="number" inputmode="decimal" min="0" value="${isBlank(value) ? '' : value}" placeholder="?" data-${attr}-in aria-label="${this._esc(label)}">
        <button class="ohu-btn" data-${attr}="1" aria-label="More">+</button></div>`;

    // One line per product (Carl 2026-11-09): the box is open at once, one total, "for:" what it covers.
    const productHtml = (e, ei) => {
      const i = e.items[0] || {};
      const lastNote = !first && lastYear(e) && i.planned !== undefined ? `<div class="ohu-plan">last year ${i.planned} ${this._esc(i.unit || '')}</div>` : '';
      return `<div class="oha-el open oha-prod${e.ok ? ' ok' : ''}" data-ei="${ei}">
          <div class="oha-el-head"><div class="oha-el-title">${e.ok ? '&#10003; ' : ''}${this._esc(e.label)}
              ${e.recount ? '<span class="oha-src">changed in the design: count again</span>' : e.kind === 'added' ? '<span class="oha-src">added</span>' : ''}</div>
            ${!first && lastYear(e) && !e.ok ? `<button class="btn btn-sm btn-success" data-el-ok="${ei}">&#10003; Same as last year</button>` : ''}
            ${e.kind === 'added' ? `<button class="btn btn-sm btn-ghost" data-el-del="${ei}" aria-label="Remove">&#10005;</button>` : ''}</div>
          ${(e.covers || []).length ? `<div class="ohu-plan">for: ${this._esc(e.covers.join(', '))}</div>` : ''}
          ${e.kind === 'added' ? `<div class="oha-chips oha-addfrom">Came: <button class="ohu-chip${e.from !== 'kit' ? ' on' : ''}" data-el-from="${ei}:truck">off the truck</button><button class="ohu-chip${e.from === 'kit' ? ' on' : ''}" data-el-from="${ei}:kit">from the kit</button></div>` : ''}
          ${e.items.map((it, ii) => `<div class="oha-item"><div class="oha-item-label">${e.kind === 'added' ? this._esc(it.label) : 'How many went up?'}${lastNote}</div>
              ${stepper(`q="${ei}:${ii}"`, it.qty, it.label)}<span class="ohu-unit">${this._esc(it.unit || '')}</span>
              ${state.from === 'mix' && e.kind !== 'added' ? `<div class="oha-truckrow">off the truck ${stepper(`t="${ei}:${ii}"`, it.truck_qty, 'off the truck')}</div>` : ''}
            </div>`).join('')}
        </div>`;
    };
    const elementHtml = (e, ei) => {
      if (data.per_product) return productHtml(e, ei);
      const editing = state.open === ei;
      const diff = lastYear(e) && e.items.some(i => i.planned !== undefined && i.qty !== i.planned);
      return `<div class="oha-el${e.ok ? ' ok' : ''}${editing ? ' open' : ''}" data-ei="${ei}">
          <div class="oha-el-head"><div class="oha-el-title">${e.ok ? '&#10003; ' : ''}${this._esc(e.label)}
              ${sourceBadge(e) ? `<span class="oha-src">${sourceBadge(e)}</span>` : ''}</div>
            ${editing ? '' : e.ok ? `<button class="btn btn-sm btn-ghost" data-el-edit="${ei}">Change</button>`
              : (first || elBlank(e) || !lastYear(e)) ? `<button class="btn btn-primary oha-asplanned" data-el-edit="${ei}">Count it</button>`
                : `<span class="oha-elbtns"><button class="btn btn-sm btn-ghost" data-el-edit="${ei}">Change</button><button class="btn btn-success oha-asplanned" data-el-ok="${ei}">&#10003; Same as last year</button></span>`}</div>
          ${e.kind === 'added' ? `<div class="oha-chips oha-addfrom">Came: <button class="ohu-chip${e.from !== 'kit' ? ' on' : ''}" data-el-from="${ei}:truck">off the truck</button><button class="ohu-chip${e.from === 'kit' ? ' on' : ''}" data-el-from="${ei}:kit">from the kit</button></div>` : ''}
          ${editing ? e.items.map((i, ii) => `<div class="oha-item">
              <div class="oha-item-label">${this._esc(i.label)}${!first && lastYear(e) && i.planned !== undefined ? `<div class="ohu-plan">last year ${i.planned} ${this._esc(i.unit || '')}</div>` : ''}</div>
              ${stepper(`q="${ei}:${ii}"`, i.qty, i.label)}<span class="ohu-unit">${this._esc(i.unit || '')}</span>
              ${state.from === 'mix' && e.kind !== 'added' ? `<div class="oha-truckrow">off the truck ${stepper(`t="${ei}:${ii}"`, i.truck_qty, 'off the truck')}</div>` : ''}
            </div>`).join('') + `<div class="oha-el-foot">${e.kind === 'added' ? `<button class="btn btn-sm btn-ghost" data-el-del="${ei}">Remove</button>` : ''}
              <button class="btn btn-primary" data-el-done="${ei}">Done</button></div>`
            : `<div class="oha-el-items${diff ? ' diff' : ''}">${e.items.map(i => itemLine(i, e)).join('<br>') || '<span class="ohu-plan">Nothing listed</span>'}</div>`}
        </div>`;
    };

    const houseHtml = () => {
      if (!state.houseRows.length) return '';
      const open = data.per_product || state.open === 'house';  // one-line-per-product screen: always open
      const blank = state.houseRows.some(r => isBlank(r.qty));
      return `<div class="oha-el${blank ? '' : ' ok'}${open ? ' open' : ''}"><div class="oha-el-head"><div class="oha-el-title">Clips, cords &amp; timers</div>
          ${open ? '' : blank ? '<button class="btn btn-primary" data-house-edit>Count it</button>' : '<button class="btn btn-sm btn-ghost" data-house-edit>Change</button>'}</div>
          ${open ? state.houseRows.map((r, ri) => `<div class="oha-item"><div class="oha-item-label">${this._esc(r.label)}${r.planned && !first && !r.blank ? `<div class="ohu-plan">last year ${r.planned}</div>` : ''}</div>
              ${stepper(`h="${ri}"`, r.qty, r.label)}<span class="ohu-unit">${this._esc(r.unit || '')}</span></div>`).join('')
              + (data.per_product ? '' : '<div class="oha-el-foot"><button class="btn btn-primary" data-house-done>Done</button></div>')
            : `<div class="oha-el-items">${state.houseRows.map(r => `${this._esc(r.label)} ${isBlank(r.qty) ? '<b class="oha-tocount">not counted</b>' : r.qty}`).join(' · ')}</div>`}</div>`;
    };

    const swapsHtml = () => {
      const items = data.swap_items || {};
      let html = `<div class="ohu-group">Replaced anything? <span class="ohu-plan">(optional)</span></div><div class="oha-chips">
        ${Object.keys(this.SWAP_TITLES).map(k => `<button class="ohu-chip${state.swapKind === k ? ' on' : ''}" data-swap-kind="${k}">${this.SWAP_TITLES[k]}</button>`).join('')}</div>`;
      if (state.swapKind) {
        // This house's own items first (its colours), then every other one: search or "More…" (round 4 F-06).
        const all = items[state.swapKind] || [];
        const q = (state.swapQ || '').toLowerCase();
        const list = q ? all.filter(p => p.name.toLowerCase().includes(q)) : state.swapMore ? all : all.slice(0, 8);
        html += `<div class="oha-swappick"><div class="ohu-plan">${this.SWAP_HELP[state.swapKind]}</div>
            ${all.length > 8 ? `<input class="ohu-other" type="search" placeholder="Search, e.g. warm" value="${this._esc(state.swapQ || '')}" data-swap-q>` : ''}
            ${list.length ? list.map(p => `<button class="ohu-chip${p.house ? ' on' : ''}" data-swap-add="${p.id}">${this._esc(p.name)}</button>`).join('')
              : `<div class="ohu-plan">${q ? 'Nothing found.' : 'No stock items of this kind.'}</div>`}
            ${!q && !state.swapMore && all.length > 8 ? `<button class="btn btn-sm btn-ghost" data-swap-more>More&hellip; (${all.length - 8})</button>` : ''}</div>`;
      }
      html += state.swaps.map((s, si) => `<div class="oha-item"><div class="oha-item-label">${this.SWAP_TITLES[s.kind] || ''}: ${this._esc(s.label)}</div>
          ${stepper(`s="${si}"`, s.qty, s.label)}<button class="btn btn-sm btn-ghost" data-swap-del="${si}" aria-label="Remove">&#10005;</button></div>`).join('');
      return html;
    };

    const addHtml = () => {
      if (!state.adding) {
        return '<button class="btn oha-add-btn" data-add-el>&#10133; Add a tree, bush, run&hellip;</button>';
      }
      const kinds = data.add_kinds || [];
      const strands = (data.catalog && data.catalog.strand_types) || [];
      const patterns = data.patterns || [];
      const a = state.adding;
      return `<div class="oha-el open"><div class="oha-el-title">Add: what is it?</div>
          <div class="oha-chips">${kinds.map(k => `<button class="ohu-chip${a.kind === k.key ? ' on' : ''}" data-add-kind="${k.key}">${this._esc(k.label)}</button>`).join('')}</div>
          ${a.kind ? `<div class="oha-item-label" style="margin-top:6px;">Lights on it</div><div class="oha-chips">
              ${strands.map(s => `<button class="ohu-chip${a.strand === s.id ? ' on' : ''}" data-add-strand="${s.id}">${this._esc(s.name)}</button>`).join('')}
              ${patterns.slice(0, 6).map(p => `<button class="ohu-chip${a.pattern === p.id ? ' on' : ''}" data-add-pattern="${p.id}">C9 ${this._esc(p.name)}</button>`).join('')}</div>` : ''}
          ${a.kind ? `<div class="oha-item-label" style="margin-top:6px;">Name</div><input class="ohu-other" type="text" data-add-name value="${this._esc(a.name || this._addName(a.kind))}" placeholder="e.g. Tree 3">
            <div class="oha-chips">It came: <button class="ohu-chip${a.from !== 'kit' ? ' on' : ''}" data-add-from="truck">off the truck</button><button class="ohu-chip${a.from === 'kit' ? ' on' : ''}" data-add-from="kit">from the kit</button></div>` : ''}
          <div class="oha-el-foot"><button class="btn btn-ghost" data-add-cancel>Cancel</button>
            <button class="btn btn-primary" data-add-ok ${a.kind && (a.strand || a.pattern) ? '' : 'disabled'}>Add</button></div></div>`;
    };

    // What the trees, bushes and runs add up to, per product total.
    const partSums = () => {
      const out = {};
      state.parts.forEach(pt => pt.items.forEach(it => {
        if (isBlank(it.qty)) return;
        const o = out[it.product_uid] || (out[it.product_uid] = { qty: 0, labels: [] });
        o.qty += it.qty;
        if (!o.labels.includes(pt.label)) o.labels.push(pt.label);
      }));
      return out;
    };
    // A total is at least what its parts add up to: raise it (and count it as typed) when the parts pass it.
    const feedTotals = () => {
      const sums = partSums();
      state.elements.forEach(e => {
        const sum = sums[e.uid];
        if (!sum) return;
        const it = e.items[0];
        if (isBlank(it.qty) || it.qty < sum.qty) {
          it.qty = sum.qty; it.counted = true; e.ok = true;
          if (state.from === 'truck') it.truck_qty = it.qty;
        }
      });
    };
    const partsHtml = () => {
      if (!data.per_product || !state.parts.length) return '';
      return `<div class="ohu-group">Per tree, bush, run <span class="ohu-plan">(optional: they add up into the totals)</span></div>
        ${state.parts.map((pt, pi) => `<div class="oha-el open oha-part" data-part="${this._esc(pt.uid)}">
          <div class="oha-el-head"><div class="oha-el-title">${pt.items.every(i => !isBlank(i.qty)) ? '&#10003; ' : ''}${this._esc(pt.label)}
            ${pt.recount ? '<span class="oha-src">changed in the design: count again</span>' : ''}</div></div>
          ${pt.items.map((it, ii) => `<div class="oha-item"><div class="oha-item-label">${this._esc(it.label)}${!first && pt.source === 'last_season' && it.planned !== undefined ? `<div class="ohu-plan">last year ${it.planned}</div>` : ''}</div>
            ${stepper(`r="${pi}:${ii}"`, it.qty, it.label)}<span class="ohu-unit">${this._esc(it.unit || '')}</span></div>`).join('')}
        </div>`).join('')}`;
    };
    const render = () => {
      const n = state.elements.length;
      const sums = partSums();
      const fromBtn = (k, t) => `<button class="oha-seg${state.from === k ? ' on' : ''}" data-from="${k}">${t}</button>`;
      $('.ohu-body').innerHTML = `
        <div class="oha-from"><div class="oha-from-title">Where did it come from?</div>
          <div class="oha-segs">${fromBtn('kit', 'All from the kit')}${fromBtn('truck', 'All from the truck')}${fromBtn('mix', 'Some of each')}</div>
          ${needsTruck() ? `<div class="oha-trucks">${trucks.length ? 'Truck: ' + trucks.map(t => `<button class="ohu-chip${state.truckId === t.id ? ' on' : ''}" data-truck="${t.id}">${this._esc(t.name)}</button>`).join('')
            : '<span class="ohu-plan">No trucks set up: the truck count won\'t change.</span>'}</div>` : ''}
        </div>
        ${n && !first && state.elements.some(e => lastYear(e) && !e.ok && !elBlank(e)) ? `<button class="btn btn-success btn-lg oha-all" data-all-ok>&#10003; Same as last year's count</button>` : ''}
        ${data.per_product ? '<div class="ohu-group">Total material</div>' : ''}
        ${state.elements.map((e, ei) => elementHtml(e, ei) + (sums[e.uid] ? `<div class="ohu-plan oha-fromparts">from ${this._esc(sums[e.uid].labels.join(', '))}: ${sums[e.uid].qty}</div>` : '')).join('')}
        ${addHtml()}
        ${partsHtml()}
        ${houseHtml()}
        ${swapsHtml()}`;
      const save = $('[data-act="save"]');
      save.textContent = n && checked() < n ? `✓ Save (${checked()} of ${n} ${first ? 'counted' : 'checked'})` : '✓ Save';
    };

    const setFromInputs = () => {
      overlay.querySelectorAll('.oha-step').forEach(holder => {
        const inp = holder.querySelector('input');
        const ref = holder.dataset.ref;
        if (!ref) return;
        const typed = inp.value !== '';
        const v = Math.max(0, inp.valueAsNumber || 0);
        const [kind, a, b] = ref.split(':');
        // A box left empty stays "not counted"; a number typed is counted.
        if (kind === 'q') {
          const it = state.elements[a].items[b];
          if (!typed) return;
          if (isBlank(it.qty) || it.qty !== v) { it.counted = true; if (data.per_product) state.elements[a].ok = !elBlank(state.elements[a]); }
          const changed = it.qty !== v;
          it.qty = v; if (state.from === 'truck') it.truck_qty = v;
          if (state.from === 'mix' && changed && !it.truckSet) it.truck_qty = mixTruck(state.elements[a], it);
          if (it.truck_qty > it.qty) it.truck_qty = it.qty;
        }
        if (kind === 't') { const it = state.elements[a].items[b]; if (it.truck_qty !== Math.min(v, it.qty || 0)) it.truckSet = true; it.truck_qty = Math.min(v, it.qty || 0); }
        if (kind === 'h') {
          const r = state.houseRows[a];
          if (!typed) return;
          if (isBlank(r.qty) || r.qty !== v) r.counted = true;
          r.qty = v;
        }
        if (kind === 's') state.swaps[a].qty = v;
        if (kind === 'r') state.parts[a].items[b].qty = typed ? v : null;
      });
    };
    // Each stepper knows what it holds (data-ref), so typed values are kept on every re-draw.
    const tagSteppers = () => {
      overlay.querySelectorAll('.oha-step').forEach(holder => {
        const btn = holder.querySelector('button');
        const ds = btn.dataset;
        if (ds.q) holder.dataset.ref = 'q:' + ds.q;
        else if (ds.t) holder.dataset.ref = 't:' + ds.t;
        else if (ds.h) holder.dataset.ref = 'h:' + ds.h;
        else if (ds.s) holder.dataset.ref = 's:' + ds.s;
        else if (ds.r) holder.dataset.ref = 'r:' + ds.r;
      });
    };
    this._addName = (kind) => {
      const label = ((data.add_kinds || []).find(k => k.key === kind) || {}).label || 'Item';
      // Tree 3 when the house already has Tree 1 and Tree 2 (design T1, T2 count too).
      const prefix = label.charAt(0).toUpperCase();
      const n = state.elements.filter(el => (el.label || '').startsWith(label) || new RegExp('^' + prefix + '\\d').test(el.label || '')).length;
      return `${label} ${n + 1}`;
    };
    const redraw = () => { render(); tagSteppers(); };
    feedTotals();  // counts made from the map's element sheet (in the draft) add up into the totals
    redraw();
    // Opened from the map ("Count this tree"): straight to that tree's box.
    if (opts && opts.focus) {
      const card = [...overlay.querySelectorAll('.oha-part')].find(c => c.dataset.part === opts.focus);
      if (card) { card.scrollIntoView({ block: 'center' }); const inp = card.querySelector('input'); if (inp) inp.focus(); }
    }

    const stepOf = (it) => it.step || ((it.unit === 'ft' || (it.planned || it.qty || 0) >= 100) ? 10 : 1);
    $('.ohu-body').addEventListener('change', (e) => {
      setFromInputs();
      if (e.target.closest('.oha-part')) { feedTotals(); redraw(); }
    });
    $('.ohu-body').addEventListener('input', (e) => {
      if (!e.target.matches('[data-swap-q]')) return;
      state.swapQ = e.target.value;
      const pos = e.target.selectionStart;
      redraw();
      const box = overlay.querySelector('[data-swap-q]');
      if (box) { box.focus(); box.setSelectionRange(pos, pos); }
    });
    $('.ohu-body').addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const holder = t.closest('.oha-step');
      if (holder && holder.dataset.ref) {
        setFromInputs();
        const sign = t.getAttribute('aria-label') === 'More' ? 1 : -1;
        const [kind, a, b] = holder.dataset.ref.split(':');
        if (kind === 'q') {
          const it = state.elements[a].items[b];
          it.qty = isBlank(it.qty) ? (sign > 0 ? stepOf(it) : 0) : Math.max(0, it.qty + sign * stepOf(it));
          it.counted = true;
          if (data.per_product) state.elements[a].ok = !elBlank(state.elements[a]);
          if (state.from === 'truck') it.truck_qty = it.qty;
          if (state.from === 'mix' && !it.truckSet) it.truck_qty = mixTruck(state.elements[a], it);
          if (it.truck_qty > it.qty) it.truck_qty = it.qty;
        } else if (kind === 't') {
          const it = state.elements[a].items[b];
          it.truck_qty = Math.min(it.qty || 0, Math.max(0, (it.truck_qty || 0) + sign * stepOf(it)));
          it.truckSet = true;
        } else if (kind === 'h') {
          const r = state.houseRows[a];
          const st = (r.unit === 'ft' || (r.qty || 0) >= 100) ? 10 : 1;
          r.qty = isBlank(r.qty) ? (sign > 0 ? st : 0) : Math.max(0, r.qty + sign * st);
          r.counted = true;
        } else if (kind === 'r') {
          const it = state.parts[a].items[b];
          it.qty = isBlank(it.qty) ? (sign > 0 ? stepOf(it) : 0) : Math.max(0, it.qty + sign * stepOf(it));
          feedTotals();
        } else if (kind === 's') {
          state.swaps[a].qty = Math.max(0, (state.swaps[a].qty || 0) + sign);
        }
        return redraw();
      }
      setFromInputs();
      if (t.dataset.from) {
        state.from = t.dataset.from;
        state.elements.forEach(el => el.items.forEach(i => {
          if (state.from === 'truck') i.truck_qty = i.qty || 0;
          if (state.from === 'kit') i.truck_qty = 0;
          if (state.from === 'mix') { i.truck_qty = mixTruck(el, i); i.truckSet = false; }
        }));
        return redraw();
      }
      if (t.dataset.truck) {
        state.truckId = parseInt(t.dataset.truck, 10);
        await DB.setState(this.TRUCK_KEY, state.truckId).catch(() => {});
        return redraw();
      }
      // Same as last year's count: only elements that have last year's actual count (never a blank one).
      if (t.hasAttribute('data-all-ok')) { state.elements.forEach(el => { if (lastYear(el) && !elBlank(el)) el.ok = true; }); state.open = null; return redraw(); }
      if (t.dataset.elOk) { state.elements[t.dataset.elOk].ok = true; return redraw(); }
      if (t.dataset.elEdit) { state.open = parseInt(t.dataset.elEdit, 10); return redraw(); }
      if (t.dataset.elDone) {
        const el = state.elements[t.dataset.elDone];
        if (elBlank(el)) { App.showToast('Type a number for each one (0 if none)', 'error'); return; }
        el.ok = true; state.open = null; return redraw();
      }
      if (t.dataset.elFrom) { const [ei, f] = t.dataset.elFrom.split(':'); state.elements[ei].from = f; return redraw(); }
      if (t.dataset.elDel) { state.elements.splice(parseInt(t.dataset.elDel, 10), 1); state.open = null; return redraw(); }
      if (t.hasAttribute('data-house-edit')) { state.open = 'house'; return redraw(); }
      if (t.hasAttribute('data-house-done')) {
        if (state.houseRows.some(r => isBlank(r.qty))) { App.showToast('Type a number for each one (0 if none)', 'error'); return; }
        state.open = null; return redraw();
      }
      if (t.hasAttribute('data-add-el')) { state.adding = {}; return redraw(); }
      if (t.hasAttribute('data-add-cancel')) { state.adding = null; return redraw(); }
      const keepName = () => { const n = overlay.querySelector('[data-add-name]'); if (n && state.adding) state.adding.name = n.value; };
      if (t.dataset.addKind) { keepName(); state.adding.kind = t.dataset.addKind; state.adding.name = null; return redraw(); }
      if (t.dataset.addFrom) { keepName(); state.adding.from = t.dataset.addFrom; return redraw(); }
      if (t.dataset.addStrand) { keepName(); state.adding.strand = parseInt(t.dataset.addStrand, 10); state.adding.pattern = null; return redraw(); }
      if (t.dataset.addPattern) { keepName(); state.adding.pattern = parseInt(t.dataset.addPattern, 10); state.adding.strand = null; return redraw(); }
      if (t.hasAttribute('data-add-ok')) {
        const a = state.adding;
        keepName();
        const item = a.strand
          ? { group: 'strand', label: ((data.catalog.strand_types || []).find(s => s.id === a.strand) || {}).name || 'Mini strands', strand_type_id: a.strand, qty: null, counted: false, unit: 'strands', step: 1 }
          : { group: 'bulb', label: 'C9 · ' + (((data.patterns || []).find(p => p.id === a.pattern) || {}).name || ''), bulb_type_id: ((data.catalog.bulb_types || [])[0] || {}).id || false, pattern_id: a.pattern, qty: null, counted: false, unit: 'bulbs', step: 25 };
        item.truck_qty = 0;
        // Added on site: off the truck unless they say the kit (round 4 F-03); named as they typed ("Tree 3").
        state.elements.push({ uid: this._uid(), label: (a.name || '').trim() || this._addName(a.kind), kind: 'added', source: '',
          from: a.from === 'kit' ? 'kit' : 'truck', items: [item], ok: false });
        state.adding = null;
        state.open = state.elements.length - 1;
        redraw();
        const inp = overlay.querySelector(`.oha-el[data-ei="${state.open}"] input`);
        if (inp) { inp.focus(); inp.select(); }
        return;
      }
      if (t.dataset.swapKind) { state.swapKind = state.swapKind === t.dataset.swapKind ? null : t.dataset.swapKind; state.swapQ = ''; state.swapMore = false; return redraw(); }
      if (t.hasAttribute('data-swap-more')) { state.swapMore = true; return redraw(); }
      if (t.dataset.swapAdd) {
        const list = (data.swap_items || {})[state.swapKind] || [];
        const p = list.find(x => String(x.id) === t.dataset.swapAdd);
        const found = state.swaps.find(s => s.kind === state.swapKind && s.product_id === p.id);
        if (found) found.qty += 1; else state.swaps.push({ kind: state.swapKind, product_id: p.id, label: p.name, qty: 1 });
        state.swapKind = null; state.swapQ = ''; state.swapMore = false;
        return redraw();
      }
      if (t.dataset.swapDel) { state.swaps.splice(parseInt(t.dataset.swapDel, 10), 1); return redraw(); }
    });

    const payload = () => {
      setFromInputs();
      return {
        from: state.from, truck_id: state.truckId || false,
        elements: state.elements.map(el => ({ uid: el.uid, label: el.label, kind: el.kind, run_id: el.run_id || false,
          feature_id: el.feature_id || false, source: el.source, ok: el.ok,
          from: el.from || false,
          items: el.items.map(i => Object.assign({}, i, { from: el.kind === 'added' ? (el.from === 'kit' ? 'kit' : 'truck') : undefined,
            truck_qty: el.kind === 'added' ? (el.from === 'kit' ? 0 : (i.qty || 0))
              : state.from === 'kit' ? 0 : state.from === 'truck' ? (i.qty || 0) : Math.min(i.truck_qty || 0, i.qty || 0) })) })),
        house_rows: state.houseRows, swaps: state.swaps.filter(s => s.qty > 0), parts: state.parts,
      };
    };

    const close = () => { overlay.remove(); if (onClose) onClose(); };
    overlay.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'close') return close();
      if (act.dataset.act === 'later') {
        act.disabled = true;
        try { await this.later(job, payload()); close(); } catch (err) { App.showToast('Not saved: ' + (err.message || err), 'error'); act.disabled = false; }
        return;
      }
      if (act.dataset.act === 'save') {
        const body = payload();
        // Blank boxes (and, on a first count, anything not counted) must be counted first.
        const toCount = state.elements.filter(el => elBlank(el) || (first && !el.ok)).map(el => el.label);
        if (state.houseRows.some(r => isBlank(r.qty))) toCount.push('Clips, cords & timers');
        if (toCount.length) {
          App.showToast(`Count these first (0 if none): ${toCount.slice(0, 4).join(', ')}${toCount.length > 4 ? '…' : ''}. Or tap Finish later.`, 'error');
          return;
        }
        const sums = partSums();
        const under = state.elements.find(e => sums[e.uid] && !isBlank(e.items[0].qty) && e.items[0].qty < sums[e.uid].qty);
        if (under) { App.showToast(`${under.label}: the total can't be less than its trees, bushes and runs (${sums[under.uid].qty}).`, 'error'); return; }
        const left = body.elements.filter(el => !el.ok).length;
        if (left && !window.confirm(`${left} not checked yet. Save them the same as last year?`)) return;
        if (needsTruck() && !body.truck_id && trucks.length) { App.showToast('Which truck did it come off? Tap it at the top.', 'error'); return; }
        act.disabled = true;
        try {
          const res = await this._call(job.id, 'worker_save_actual', [body], { kind: 'count', payload: body });
          await DB.setState(this._draftKey(job.id), res.queued ? body : null).catch(() => {});
          // A truck that didn't have it all is marked for a count: say so (round 4 F-12).
          const flagged = (res.notes || []).find(n => /marked for a count/.test(n));
          App.showToast(res.queued ? 'Saved on this phone: it goes to the office when there\'s signal'
            : flagged ? `Count saved. ${flagged}` : 'Count saved', flagged ? 'info' : 'success', flagged ? 8000 : undefined);
          close();
        } catch (err) {
          App.showToast('Not saved: ' + (err.message || err), 'error');
          act.disabled = false;
        }
      }
    });
  },

  /** A callback's "Replaced anything?" on its own (no count). */
  async openSwaps(job, onClose) {
    const data = typeof HolidayUsed !== 'undefined' ? await HolidayUsed.load(job.id) : null;
    if (!data || !data.swap_items) { App.showToast('Open it once with signal first', 'error'); return; }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const swaps = JSON.parse(JSON.stringify(data.swaps || []));
    let kind = null;
    let truckId = data.truck_id || (await DB.getState(this.TRUCK_KEY).catch(() => null));
    const trucks = data.trucks || [];
    if (!truckId && trucks.length === 1) truckId = trucks[0].id;
    const draw = () => {
      const list = kind ? ((data.swap_items || {})[kind] || []) : [];
      overlay.innerHTML = `<div class="modal" style="max-width:460px;">
          <div class="modal-header"><h3>Replaced anything?</h3></div>
          <div class="modal-body">
            <div class="oha-chips">${Object.keys(this.SWAP_TITLES).map(k => `<button class="ohu-chip${kind === k ? ' on' : ''}" data-k="${k}">${this.SWAP_TITLES[k]}</button>`).join('')}</div>
            ${kind ? `<div class="ohu-plan">${this.SWAP_HELP[kind]}</div>${list.slice(0, 8).map(p => `<button class="ohu-chip" data-p="${p.id}">${this._esc(p.name)}</button>`).join('')}` : ''}
            ${swaps.map((s, i) => `<div class="oha-item"><div class="oha-item-label">${this.SWAP_TITLES[s.kind]}: ${this._esc(s.label)}</div>
              <button class="ohu-btn" data-m="${i}">&minus;</button><b style="min-width:28px;text-align:center;">${s.qty}</b><button class="ohu-btn" data-pl="${i}">+</button></div>`).join('')}
            ${swaps.length ? `<div class="oha-trucks">Truck: ${trucks.map(t => `<button class="ohu-chip${truckId === t.id ? ' on' : ''}" data-t="${t.id}">${this._esc(t.name)}</button>`).join('')}</div>` : ''}
          </div>
          <div class="modal-footer"><button class="btn" data-x>Cancel</button><button class="btn btn-primary" data-ok>Save</button></div></div>`;
    };
    draw();
    document.body.appendChild(overlay);
    overlay.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.hasAttribute('data-x')) { overlay.remove(); return; }
      if (t.dataset.k) { kind = kind === t.dataset.k ? null : t.dataset.k; return draw(); }
      if (t.dataset.p) {
        const p = ((data.swap_items || {})[kind] || []).find(x => String(x.id) === t.dataset.p);
        const found = swaps.find(s => s.kind === kind && s.product_id === p.id);
        if (found) found.qty += 1; else swaps.push({ kind, product_id: p.id, label: p.name, qty: 1 });
        kind = null;
        return draw();
      }
      if (t.dataset.m) { const s = swaps[t.dataset.m]; s.qty = Math.max(0, s.qty - 1); if (!s.qty) swaps.splice(t.dataset.m, 1); return draw(); }
      if (t.dataset.pl) { swaps[t.dataset.pl].qty += 1; return draw(); }
      if (t.dataset.t) { truckId = parseInt(t.dataset.t, 10); await DB.setState(this.TRUCK_KEY, truckId).catch(() => {}); return draw(); }
      if (t.hasAttribute('data-ok')) {
        if (swaps.length && !truckId && trucks.length) { App.showToast('Which truck? Tap it.', 'error'); return; }
        t.disabled = true;
        try {
          const res = await this._call(job.id, 'worker_save_swaps', [swaps, truckId || false], { kind: 'swaps', swaps, truck_id: truckId || false });
          App.showToast(res.queued ? 'Saved on this phone' : (res.message || 'Saved'), 'success');
          overlay.remove();
          if (onClose) onClose();
        } catch (err) { App.showToast('Not saved: ' + (err.message || err), 'error'); t.disabled = false; }
      }
    });
  },
};

window.addEventListener('online', () => HolidayActual.flush().catch(() => {}));
setTimeout(() => HolidayActual.flush().catch(() => {}), 6000);
