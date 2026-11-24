/**
 * Materials used, the simple way (Carl 2026-11-23): which bulbs and which strands, how many. Nothing per run, tree
 * or bush, no cords, no "where did it come from". Clips work themselves out: one per roof bulb, less the magnets and
 * other special clips (typed); one stake per ground bulb. Timers: how many.
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
    // ---- Clips (worked out) and timers
    const clipCat = (data.catalog && data.catalog.clips) || { main: [], ground: false, special: [] };
    const rowsIn = (src && src.house_rows) || data.house_rows || [];
    const trusted = data.source === 'saved' || !!src;
    const codeOf = (r) => {
      const known = [...clipCat.main, ...clipCat.special, ...(clipCat.ground ? [clipCat.ground] : [])];
      const c = known.find(k => k.id === r.attachment_id) || known.find(k => k.name.toLowerCase() === (r.label || '').toLowerCase());
      return c && r.group === 'attachment' ? c.code : null;
    };
    const clip = { main: data.main_clip_id || (clipCat.main[0] || {}).id || false, typed: null, stakes: null, special: {}, last: {}, more: false };
    const timer = { qty: null, last: null };
    const savedQty = {};
    const keepRows = [];   // cords and the like, counted before: kept, not asked
    rowsIn.forEach(r => {
      const code = codeOf(r);
      const qty = this._blank(r.qty) ? null : r.qty;
      if (r.group === 'timer') {
        if (qty !== null) { timer.qty = (timer.qty || 0) + qty; if (!trusted && r.planned) timer.last = timer.qty; }
        return;
      }
      if (!code) {
        if (qty !== null && (trusted || !r.planned)) keepRows.push(Object.assign({}, r, { counted: true }));
        return;
      }
      if (qty === null) return;
      const main = clipCat.main.find(c => c.code === code);
      if (main) { clip.main = main.id; savedQty.main = (savedQty.main || 0) + qty; }
      else if (clipCat.ground && code === clipCat.ground.code) savedQty.stakes = qty;
      else { clip.special[code] = qty; if (!trusted && r.planned) clip.last[code] = qty; }
    });
    // Counted as they went (the Magnets +1 / +5 buttons).
    const flow = typeof HolidayFlow !== 'undefined' && HolidayFlow._data && HolidayFlow._data[job.id];
    const magnets = (flow && flow.tally && flow.tally[HolidayFlow.MAGNETS]) || 0;
    if (magnets && !trusted) { clip.special.magnetic_clip = magnets; delete clip.last.magnetic_clip; }
    const bulbs = (ground) => items().filter(x => x.it.group === 'bulb' && !!x.it.ground === ground)
      .reduce((a, x) => a + (x.it.qty || 0), 0);
    // Staples (per foot) and glue hold no bulb's clip place.
    const swapped = () => clipCat.special.filter(c => c.usage !== 'per_ft' && c.code !== 'hot_glue')
      .reduce((a, c) => a + (clip.special[c.code] || 0), 0);
    const autoMain = () => Math.max(bulbs(false) - swapped(), 0);
    // A saved number the crew had changed by hand stays theirs; one that was worked out keeps following the bulbs.
    if (trusted) {
      if (savedQty.main !== undefined && savedQty.main !== autoMain()) clip.typed = savedQty.main;
      if (savedQty.stakes !== undefined && savedQty.stakes !== bulbs(true)) clip.stakes = savedQty.stakes;
    }
    const clipsHtml = () => {
      const main = clipCat.main.find(c => c.id === clip.main);
      const roof = bulbs(false);
      let html = '';
      if (main && (roof || clip.typed)) {
        const auto = clip.typed === null;
        html += `<div class="ohu-row"><div class="ohu-label">${clipCat.main.length > 1 ? `<select data-clip-main style="height:40px;font-size:16px;max-width:100%;">${clipCat.main.map(c =>
          `<option value="${c.id}"${c.id === clip.main ? ' selected' : ''}>${this._esc(c.name)}</option>`).join('')}</select>` : this._esc(main.name)}
          <div class="ohu-plan">${auto ? `automatic: ${roof} bulbs${swapped() ? ` − ${swapped()} special` : ''}` : `you typed it <button class="btn btn-sm btn-ghost" data-clip-auto="main">use ${autoMain()}</button>`}</div></div>
          ${this._stepper('clip:main', auto ? autoMain() : clip.typed)}</div>`;
      }
      if (clipCat.ground && (bulbs(true) || clip.stakes)) {
        const auto = clip.stakes === null;
        html += `<div class="ohu-row"><div class="ohu-label">${this._esc(clipCat.ground.name)}
          <div class="ohu-plan">${auto ? 'automatic: 1 per ground bulb' : `you typed it <button class="btn btn-sm btn-ghost" data-clip-auto="stakes">use ${bulbs(true)}</button>`}</div></div>
          ${this._stepper('clip:stakes', auto ? bulbs(true) : clip.stakes)}</div>`;
      }
      clipCat.special.filter(c => clip.special[c.code] !== undefined).forEach(c => {
        html += `<div class="ohu-row"><div class="ohu-label">${this._esc(c.name)}${c.usage === 'per_ft' ? ' (feet)' : ''}${clip.last[c.code] ? `<div class="ohu-plan">last year ${clip.last[c.code]}</div>` : ''}</div>
          ${this._stepper('special:' + c.code, clip.special[c.code])}</div>`;
      });
      const rest = clipCat.special.filter(c => clip.special[c.code] === undefined);
      if (clip.more) html += `<div class="oha-chips">${rest.map(c => `<button class="ohu-chip" data-special="${c.code}">${this._esc(c.name)}</button>`).join('')}</div>`;
      else if (rest.length) html += '<button class="btn oha-add-btn" data-special-more>&#10133; Magnets or other clips</button>';
      return html;
    };
    const houseRows = () => {
      const out = keepRows.slice();
      const push = (c, qty, unit) => { if (c && qty > 0) out.push({ group: 'attachment', label: c.name, qty, unit: unit || '', attachment_id: c.id, counted: true }); };
      push(clipCat.main.find(c => c.id === clip.main), clip.typed === null ? autoMain() : clip.typed);
      push(clipCat.ground, clip.stakes === null ? bulbs(true) : clip.stakes);
      clipCat.special.forEach(c => push(c, clip.special[c.code] || 0, c.usage === 'per_ft' ? 'ft' : ''));
      if (!this._blank(timer.qty)) out.push({ group: 'timer', label: 'Timer', qty: timer.qty, unit: '', counted: true });
      return out;
    };
    // A number box: a light line, a clip or the timers.
    const getQ = (ref) => {
      if (ref === 'clip:main') return clip.typed === null ? autoMain() : clip.typed;
      if (ref === 'clip:stakes') return clip.stakes === null ? bulbs(true) : clip.stakes;
      if (ref === 'timer') return timer.qty;
      if (ref.startsWith('special:')) return clip.special[ref.slice(8)];
      return at(ref).qty;
    };
    const setQ = (ref, v) => {
      if (ref === 'clip:main') clip.typed = v;
      else if (ref === 'clip:stakes') clip.stakes = v;
      else if (ref === 'timer') timer.qty = v;
      else if (ref.startsWith('special:')) clip.special[ref.slice(8)] = v === null ? 0 : v;
      else Object.assign(at(ref), { qty: v, counted: v !== null });
    };
    const draw = () => {
      const all = items();
      const section = (title, list, kind) => `<div class="ohu-group">${title}</div>${list.map(lineHtml).join('')}
        ${adding === kind ? addHtml() : `<button class="btn oha-add-btn" data-add="${kind}">&#10133; Add ${kind === 'bulb' ? 'bulbs' : 'strands'}</button>`}`;
      $('.ohu-body').innerHTML = section('Bulbs', all.filter(x => !isStrand(x.it)), 'bulb')
        + section('Strands', all.filter(x => isStrand(x.it)), 'strand')
        + `<div class="ohu-group">Clips</div>${clipsHtml()}`
        + `<div class="ohu-group">Timers</div><div class="ohu-row"><div class="ohu-label">How many timers?${timer.last ? `<div class="ohu-plan">last year ${timer.last}</div>` : ''}</div>${this._stepper('timer', timer.qty)}</div>`;
    };
    const at = (ref) => { const [a, b] = ref.split(':').map(Number); return lines[a].items[b]; };
    const readInputs = () => {
      // What's typed, against what the boxes were drawn with (a worked-out clip number isn't a typed one).
      const typed = [...overlay.querySelectorAll('[data-qty]')]
        .map(inp => [inp.dataset.qty, inp.value === '' ? null : Math.max(0, inp.valueAsNumber || 0), inp.defaultValue, inp.value])
        .filter(x => x[2] !== x[3]);
      typed.forEach(([ref, v]) => setQ(ref, v));
      overlay.querySelectorAll('[data-qty]').forEach(inp => { inp.defaultValue = inp.value; });
    };
    const add = (it) => {
      lines.push({ uid: HolidayActual._uid(), label: it.label, kind: 'added', source: '', from: 'truck', items: [it] });
      adding = null;
      draw();
      const boxes = overlay.querySelectorAll('[data-qty]');
      const box = [...boxes].find(b => b.dataset.qty === `${lines.length - 1}:0`);
      if (box) box.focus();
    };
    draw();

    // The clips follow as the bulbs are typed (redrawn when the box is left).
    $('.ohu-body').addEventListener('change', (e) => {
      if (e.target.matches('[data-clip-main]')) clip.main = +e.target.value;
      const next = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.qty : null;
      readInputs();
      // Redrawn after this tap is done: redrawing at once would swallow a tap on Save's neighbours.
      setTimeout(() => { if (!overlay.isConnected || (document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-qty]') && document.activeElement.value !== document.activeElement.defaultValue)) return;
        const focus = (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.qty) || next;
        draw();
        const box = focus && [...overlay.querySelectorAll('[data-qty]')].find(b => b.dataset.qty === focus);
        if (box && focus !== e.target.dataset.qty) box.focus();
      }, 250);
    });

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
      return {
        from, truck_id: (src && src.truck_id) || data.truck_id || false,
        elements: used.map(e => ({ uid: e.uid, label: e.label, kind: e.kind, run_id: e.run_id || false,
          feature_id: e.feature_id || false, source: e.source, ok: true, from: e.from || false,
          items: e.items.map(it => Object.assign({}, it, {
            from: e.kind === 'added' ? 'truck' : undefined,
            truck_qty: e.kind === 'added' || from === 'truck' ? it.qty : from === 'kit' ? 0 : Math.min(it.truck_qty || 0, it.qty),
          })) })),
        house_rows: houseRows(), swaps, parts,
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
        const ref = d.less || d.more;
        const step = /^(clip|special|timer)/.test(ref) ? 1 : stepOf(at(ref));
        setQ(ref, Math.max(0, (getQ(ref) || 0) + (d.more ? 1 : -1) * step));
        return draw();
      }
      if (d.del) { readInputs(); lines.splice(+d.del.split(':')[0], 1); return draw(); }
      if (d.add) { readInputs(); adding = d.add; return draw(); }
      if (t.hasAttribute('data-add-x')) { readInputs(); adding = null; return draw(); }
      if (t.hasAttribute('data-special-more')) { readInputs(); clip.more = true; return draw(); }
      if (d.special) { readInputs(); clip.special[d.special] = 0; clip.more = false; return draw(); }
      if (d.clipAuto) { readInputs(); if (d.clipAuto === 'main') clip.typed = null; else clip.stakes = null; return draw(); }
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
