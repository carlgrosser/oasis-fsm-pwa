/**
 * Materials used, the simple way (Carl 2026-11-23): which bulbs and which strands, how many. Nothing per run, tree
 * or bush, no clips or cords, no "where did it come from".
 *  - Install count (opened by HolidayUsed): one line per bulb pattern and strand, last year's actual count filled in
 *    when there is one; add what's missing. Boxes left empty aren't recorded. Saved with worker_save_actual.
 *  - Service call: tap the bulbs or strands used, or Nothing used. Saved with worker_save_swaps.
 * The truck is the crew's own (as Odoo knows it). With no signal it's kept on the phone and sent later.
 */
const SimpleUsed = {
  _esc(s) { return HolidayActual._esc(s); },

  _blank(v) { return v === null || v === undefined || v === ''; },

  _stepper(ref, value) {
    return `<button class="ohu-btn" data-less="${ref}" aria-label="Less">&minus;</button>
      <input class="ohu-qty" type="number" inputmode="numeric" min="0" placeholder="?" value="${this._blank(value) ? '' : value}" data-qty="${ref}">
      <button class="ohu-btn" data-more="${ref}" aria-label="More">+</button>`;
  },

  _swatches(pat) {
    return (pat ? pat.colors : []).slice(0, 6)
      .map(c => `<span class="ohu-swatch" style="background:${this._esc(c.hex)}"></span>`).join('');
  },

  // ---------------------------------------------------------------- Install: what went up
  async openCount(job, data, onClose, overlay) {
    const $ = (s) => overlay.querySelector(s);
    const draft = await DB.getState(HolidayActual._draftKey(job.id)).catch(() => null);
    const pending = (await HolidayActual._pending())[job.id];
    const src = (pending && pending.payload) || draft || null;
    const patterns = data.patterns || [];
    const bulbTypes = (data.catalog && data.catalog.bulb_types) || [];
    const strandTypes = (data.catalog && data.catalog.strand_types) || [];
    const patternOf = (id) => patterns.find(p => p.id === id);
    const lines = JSON.parse(JSON.stringify((src && src.elements) || data.elements || []))
      .filter(e => !e.hidden && e.items && e.items.length);
    const swaps = (src && src.swaps) || data.swaps || [];
    let adding = null;          // 'bulb' | 'strand'
    let bulbType = (bulbTypes[0] || {}).id || false;
    const items = () => lines.flatMap((e, ei) => e.items.map((it, ii) => ({ e, it, ref: `${ei}:${ii}` })));
    const isStrand = (it) => it.group === 'strand';
    const stepOf = (it) => it.step || (isStrand(it) ? 1 : 25);
    $('.ohu-title').textContent = 'What went up?';
    $('.ohu-sub').textContent = data.source === 'saved' ? 'Saved. Change anything and save again.'
      : pending ? 'Saved on this phone: sent when there\'s signal.'
        : 'How many bulbs and strands. Leave a box empty if you didn\'t use it.';

    const lineHtml = ({ e, it, ref }) => {
      const last = e.source === 'last_season' && it.planned !== undefined ? `<div class="ohu-plan">last year ${it.planned}</div>` : '';
      return `<div class="ohu-row"><div class="ohu-label">${it.pattern_id ? this._swatches(patternOf(it.pattern_id)) + ' ' : ''}${this._esc(it.label || e.label)}${last}</div>
        ${this._stepper(ref, it.qty)}
        ${e.kind === 'added' ? `<button class="btn btn-sm btn-ghost" data-del="${ref}" aria-label="Remove">&#10005;</button>` : ''}</div>`;
    };
    const addHtml = () => {
      if (adding === 'bulb') {
        return `${bulbTypes.length > 1 ? `<div class="oha-chips">${bulbTypes.map(b => `<button class="ohu-chip${b.id === bulbType ? ' on' : ''}" data-bt="${b.id}">${this._esc(b.name)}</button>`).join('')}</div>` : ''}
          <div class="oha-chips">${patterns.map(p => `<button class="ohu-chip" data-add-pat="${p.id}">${this._swatches(p)}${this._esc(p.name)}</button>`).join('')}
            <button class="btn btn-sm btn-ghost" data-add-x>Cancel</button></div>`;
      }
      if (adding === 'strand') {
        return `<div class="oha-chips">${strandTypes.map(s => `<button class="ohu-chip" data-add-strand="${s.id}">${this._esc(s.name)}</button>`).join('')}
            <button class="btn btn-sm btn-ghost" data-add-x>Cancel</button></div>`;
      }
      return '';
    };
    const draw = () => {
      const all = items();
      const section = (title, list, kind) => `<div class="ohu-group">${title}</div>${list.map(lineHtml).join('')}
        ${adding === kind ? addHtml() : `<button class="btn oha-add-btn" data-add="${kind}">&#10133; Add ${kind === 'bulb' ? 'bulbs' : 'strands'}</button>`}`;
      $('.ohu-body').innerHTML = section('Bulbs', all.filter(x => !isStrand(x.it)), 'bulb')
        + section('Strands', all.filter(x => isStrand(x.it)), 'strand');
    };
    const at = (ref) => { const [a, b] = ref.split(':').map(Number); return lines[a].items[b]; };
    const readInputs = () => overlay.querySelectorAll('[data-qty]').forEach(inp => {
      const it = at(inp.dataset.qty);
      const v = inp.value === '' ? null : Math.max(0, inp.valueAsNumber || 0);
      if (v !== it.qty && !(this._blank(v) && this._blank(it.qty))) it.counted = v !== null;
      it.qty = v;
    });
    const add = (it) => {
      lines.push({ uid: HolidayActual._uid(), label: it.label, kind: 'added', source: '', from: 'truck', items: [it] });
      adding = null;
      draw();
      const boxes = overlay.querySelectorAll('[data-qty]');
      const box = [...boxes].find(b => b.dataset.qty === `${lines.length - 1}:0`);
      if (box) box.focus();
    };
    draw();

    const payload = () => {
      readInputs();
      const from = (src && src.from) || (data.source === 'saved' ? 'mix' : data.default_from) || 'kit';
      const used = lines.map(e => Object.assign({}, e, { items: e.items.filter(it => !this._blank(it.qty)) })).filter(e => e.items.length);
      const totals = {};
      used.forEach(e => { totals[e.uid] = e.items[0].qty; });
      // Kept as they were counted before (the detailed screen): never asked here, never dropped by a re-save.
      const sums = {};
      const oldParts = (src && src.parts) || (data.source === 'saved' ? data.parts : []) || [];
      oldParts.forEach(p => p.items.forEach(i => { if (!this._blank(i.qty)) sums[i.product_uid] = (sums[i.product_uid] || 0) + i.qty; }));
      const parts = oldParts.map(p => Object.assign({}, p, { items: p.items.filter(i => !this._blank(i.qty)
        && totals[i.product_uid] >= sums[i.product_uid]) })).filter(p => p.items.length);
      const houseRows = ((src && src.house_rows) || data.house_rows || []).filter(r => !this._blank(r.qty)
        && (data.source === 'saved' || src || !r.planned)).map(r => Object.assign({}, r, { counted: true }));
      return {
        from, truck_id: (src && src.truck_id) || data.truck_id || false,
        elements: used.map(e => ({ uid: e.uid, label: e.label, kind: e.kind, run_id: e.run_id || false,
          feature_id: e.feature_id || false, source: e.source, ok: true, from: e.from || false,
          items: e.items.map(it => Object.assign({}, it, {
            from: e.kind === 'added' ? 'truck' : undefined,
            truck_qty: e.kind === 'added' || from === 'truck' ? it.qty : from === 'kit' ? 0 : Math.min(it.truck_qty || 0, it.qty),
          })) })),
        house_rows: houseRows, swaps, parts,
      };
    };
    const close = () => { overlay.remove(); if (onClose) onClose(); };
    overlay.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const d = t.dataset;
      if (d.act === 'close') { overlay.remove(); if (onClose) onClose(); return; }
      if (d.less || d.more) {
        readInputs();
        const it = at(d.less || d.more);
        it.qty = Math.max(0, (it.qty || 0) + (d.more ? 1 : -1) * stepOf(it));
        it.counted = true;
        return draw();
      }
      if (d.del) { readInputs(); lines.splice(+d.del.split(':')[0], 1); return draw(); }
      if (d.add) { readInputs(); adding = d.add; return draw(); }
      if (t.hasAttribute('data-add-x')) { readInputs(); adding = null; return draw(); }
      if (d.bt) { readInputs(); bulbType = +d.bt; return draw(); }
      if (d.addPat) {
        readInputs();
        const pat = patternOf(+d.addPat);
        const name = (bulbTypes.find(b => b.id === bulbType) || {}).name || 'C9';
        return add({ group: 'bulb', label: `${name} · ${pat.name}`, bulb_type_id: bulbType, pattern_id: pat.id, qty: null, unit: 'bulbs', step: 25 });
      }
      if (d.addStrand) {
        readInputs();
        const s = strandTypes.find(x => x.id === +d.addStrand);
        const label = /strand/i.test(s.name) ? s.name : `Strands · ${s.name}`;
        return add({ group: 'strand', label, strand_type_id: s.id, qty: null, unit: 'strands', step: 1 });
      }
      if (d.act === 'later') {
        t.disabled = true;
        try { await HolidayActual.later(job, payload()); close(); } catch (err) { App.showToast('Not saved: ' + (err.message || err), 'error'); t.disabled = false; }
        return;
      }
      if (d.act === 'save') {
        const body = payload();
        if (!body.elements.length) { App.showToast('Type how many bulbs or strands went up, or tap Finish later.', 'error'); return; }
        // A number typed here is a count: last year's, saved as it is, was looked at on this screen.
        body.elements.forEach(el => el.items.forEach(it => { it.counted = true; }));
        t.disabled = true;
        try {
          const res = await HolidayActual._call(job.id, 'worker_save_actual', [body], { kind: 'count', payload: body });
          await DB.setState(HolidayActual._draftKey(job.id), res.queued ? body : null).catch(() => {});
          App.showToast(res.queued ? 'Saved on this phone: sent when there\'s signal' : 'Saved', 'success');
          close();
        } catch (err) { App.showToast('Not saved: ' + (err.message || err), 'error'); t.disabled = false; }
      }
    });
  },

  // ---------------------------------------------------------------- Service call
  async openService(job, code, after) {
    const overlay = document.createElement('div');
    overlay.className = 'ohu-overlay';
    overlay.innerHTML = `<div class="ohu-head"><button class="btn btn-sm" data-x>&larr; Back</button>
        <div style="flex:1;min-width:0;"><div class="ohu-title">Materials used?</div>
          <div class="ohu-sub">Tap what you used and how many.</div></div></div>
      <div class="ohu-body"></div>
      <div class="ohu-foot"><button class="btn btn-lg" data-none>Nothing used</button>
        <button class="btn btn-primary btn-lg" data-ok disabled>&#10003; Save</button></div>`;
    document.body.appendChild(overlay);
    const $ = (s) => overlay.querySelector(s);
    $('.ohu-body').innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    const data = (typeof HolidayUsed !== 'undefined' ? await HolidayUsed.load(job.id) : null) || {};
    const pending = (await HolidayActual._pending())[job.id];
    const swaps = JSON.parse(JSON.stringify((pending && pending.swaps) || data.swaps || []));
    const lists = data.swap_items || {};
    const KINDS = [['bulbs', 'Bulbs'], ['strand', 'Strands']];
    const more = {};
    const draw = () => {
      $('.ohu-body').innerHTML = KINDS.map(([kind, title]) => {
        const all = lists[kind] || [];
        const list = more[kind] ? all : all.slice(0, 8);
        return `<div class="ohu-group">${title}</div>
          ${swaps.map((s, i) => s.kind !== kind ? '' : `<div class="ohu-row"><div class="ohu-label">${this._esc(s.label)}</div>${this._stepper(String(i), s.qty)}</div>`).join('')}
          <div class="oha-chips">${list.filter(p => !swaps.some(s => s.kind === kind && s.product_id === p.id))
            .map(p => `<button class="ohu-chip" data-p="${kind}:${p.id}">${this._esc(p.name)}</button>`).join('')}
            ${!more[kind] && all.length > 8 ? `<button class="btn btn-sm btn-ghost" data-all="${kind}">More&hellip; (${all.length - 8})</button>` : ''}
            <button class="ohu-chip" data-other="${kind}">Other&hellip;</button></div>`;
      }).join('')
        // Wire or clips noted before stay as they are.
        + swaps.map((s, i) => KINDS.some(([k]) => k === s.kind) ? '' : `<div class="ohu-row"><div class="ohu-label">${this._esc(s.label)}</div>${this._stepper(String(i), s.qty)}</div>`).join('');
      $('[data-ok]').disabled = !swaps.length;
      $('[data-none]').hidden = swaps.length > 0;
    };
    draw();
    const readInputs = () => overlay.querySelectorAll('[data-qty]').forEach(inp => {
      swaps[+inp.dataset.qty].qty = Math.max(0, inp.valueAsNumber || 0);
    });
    overlay.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const d = t.dataset;
      if (t.hasAttribute('data-x')) { overlay.remove(); return; }
      readInputs();
      if (d.p) {
        const [kind, id] = d.p.split(':');
        const p = (lists[kind] || []).find(x => String(x.id) === id);
        swaps.push({ kind, product_id: p.id, label: p.name, qty: 1 });
        return draw();
      }
      if (d.all) { more[d.all] = true; return draw(); }
      if (d.other) {
        const label = (window.prompt(d.other === 'bulbs' ? 'Which bulbs?' : 'Which strands?') || '').trim();
        if (label) swaps.push({ kind: d.other, product_id: false, label, qty: 1 });
        return draw();
      }
      if (d.more || d.less) {
        const i = +(d.more || d.less);
        swaps[i].qty = Math.max(0, swaps[i].qty + (d.more ? 1 : -1));
        if (!swaps[i].qty) swaps.splice(i, 1);
        return draw();
      }
      if (!t.hasAttribute('data-none') && !t.hasAttribute('data-ok')) return;
      t.disabled = true;
      try {
        const list = swaps.filter(s => s.qty > 0);
        if (list.length || (data.swaps || []).length) {
          const truck = data.truck_id || false;
          const res = await HolidayActual._call(job.id, 'worker_save_swaps', [list, truck], { kind: 'swaps', swaps: list, truck_id: truck });
          await DB.setState(HolidayUsed._key(job.id), Object.assign({}, data, { swaps: list })).catch(() => {});
          if (res.queued) App.showToast('Saved on this phone: sent when there\'s signal', 'success');
        }
        await HolidayFlow.setStep(job, code, 'done');
        overlay.remove();
        if (after) after();
      } catch (err) { App.showToast('Not saved: ' + (err.message || err), 'error'); t.disabled = false; }
    });
  },
};
