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
        await OdooAPI.callKw('fsm.order', 'worker_save_used', [parseInt(id, 10), pending[id].rows, pending[id].groups || null], {});
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
    if (data.source === 'pending') return 'Saved on this phone: it goes to the office when there\'s signal.';
    if (data.source === 'design') return 'From the plan. Change only what\'s different, then Save.';
    if (data.source === 'last_season') return 'From last season\'s count here. Change what\'s different, then Save.';
    return 'Nothing to start from: tap Add for each thing you used.';
  },

  _step(row) {
    return (row.unit === 'ft' || Math.max(row.planned || 0, row.qty || 0) >= 100) ? 10 : 1;
  },

  /** {color id: bulbs} for a pattern's total (as Odoo splits it: odd colors as entered, the rest shared,
   *  a leftover bulb each on the remaining colors). */
  split(total, pattern, odd) {
    const weights = new Map();
    (pattern ? pattern.colors : []).forEach(c => weights.set(c.id, (weights.get(c.id) || 0) + 1));
    const out = {};
    let used = 0;
    Object.entries(odd || {}).forEach(([cid, q]) => { if (q > 0) { out[cid] = q; used += q; } });
    const rest = Math.max((total || 0) - used, 0);
    const restColors = [...weights.keys()].filter(c => !(String(c) in out));
    if (!restColors.length) return out;
    const totalW = restColors.reduce((a, c) => a + weights.get(c), 0);
    let left = rest;
    restColors.forEach(c => { out[c] = Math.floor(rest * weights.get(c) / totalW); left -= out[c]; });
    for (const c of restColors) { if (left <= 0) break; out[c] += 1; left -= 1; }
    return out;
  },

  async open(job, onClose) {
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
      $('.ohu-body').innerHTML = '<div class="empty-state" style="padding:24px;">Not on this phone yet: open it once with signal.</div>';
      $('[data-act="add"]').disabled = true;
      overlay.addEventListener('click', (e) => { if (e.target.closest('[data-act="close"]')) overlay.remove(); });
      return;
    }
    const rows = (data.rows || []).map(r => Object.assign({}, r));
    const catalog = data.catalog || { groups: [], bulb_types: [], colors: [], strand_types: [], attachments: [], extras: [] };
    // C9 / C7: one total per pattern (Odoo splits it across the colors).
    const bulbGroups = (data.bulb_groups || []).map(g => Object.assign({}, g, { odd: Object.assign({}, g.odd || {}),
      uneven: Object.keys(g.odd || {}).length > 0 }));
    const patterns = data.patterns || [];
    const patternOf = (id) => patterns.find(p => p.id === id);
    // Clips: worked out from the bulbs (one roof clip per bulb, less the special clips), stakes for ground runs.
    const clipCat = catalog.clips || null;
    const clip = { main: data.main_clip_id || (clipCat && clipCat.main[0] ? clipCat.main[0].id : false),
                   mainQty: null, groundQty: null, special: {}, more: false, others: [] };
    if (clipCat) {
      const managed = new Set([...clipCat.main.map(c => c.code), ...(clipCat.ground ? [clipCat.ground.code] : []),
                               ...clipCat.special.map(c => c.code)]);
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        const code = r.attachment_code || ((catalog.attachments || []).find(a => a.id === r.attachment_id) || {}).code
          || (/magnet/i.test(r.label) && r.group === 'attachment' ? 'magnetic_clip' : null);
        if (r.group !== 'attachment') continue;
        if (!code || !managed.has(code)) {
          // A clip typed in by name (Other): kept with the clips.
          clip.others.push({ label: r.label, qty: r.qty || 0 });
          rows.splice(i, 1);
          continue;
        }
        if (clipCat.main.some(c => c.code === code)) {
          clip.main = clipCat.main.find(c => c.code === code).id;
          if (data.source === 'saved') clip.mainQty = r.qty;
        } else if (clipCat.ground && code === clipCat.ground.code) {
          if (data.source === 'saved') clip.groundQty = r.qty;
        } else {
          clip.special[code] = r.qty;
        }
        rows.splice(i, 1);
      }
    }
    const perBulbSpecial = () => clipCat ? clipCat.special.filter(c => c.usage !== 'per_ft' && c.code !== 'hot_glue')
      .reduce((a, c) => a + (clip.special[c.code] || 0), 0) + clip.others.reduce((a, o) => a + (o.qty || 0), 0) : 0;
    const roofBulbs = () => bulbGroups.filter(g => !g.ground).reduce((a, g) => a + (g.total || 0), 0);
    const groundBulbs = () => bulbGroups.filter(g => g.ground).reduce((a, g) => a + (g.total || 0), 0);
    const mainAuto = () => Math.max(roofBulbs() - perBulbSpecial(), 0);
    const clipRows = () => {
      if (!clipCat) return [];
      const out = [];
      const main = clipCat.main.find(c => c.id === clip.main);
      const mainQty = clip.mainQty != null ? clip.mainQty : mainAuto();
      if (main && mainQty > 0) out.push({ group: 'attachment', label: main.name, qty: mainQty, attachment_id: main.id });
      const gq = clip.groundQty != null ? clip.groundQty : groundBulbs();
      if (clipCat.ground && gq > 0) out.push({ group: 'attachment', label: clipCat.ground.name, qty: gq, attachment_id: clipCat.ground.id });
      clipCat.special.forEach(c => { if ((clip.special[c.code] || 0) > 0) out.push({ group: 'attachment', label: c.name, qty: clip.special[c.code],
        unit: c.usage === 'per_ft' ? 'ft' : '', attachment_id: c.id }); });
      clip.others.forEach(o => { if ((o.label || '').trim() && (o.qty || 0) > 0) out.push({ group: 'attachment', label: o.label.trim(), qty: o.qty }); });
      return out;
    };
    $('.ohu-sub').textContent = this._sourceText(data);
    $('[data-act="save"]').disabled = false;

    const bulbName = (id) => ((catalog.bulb_types || []).find(b => b.id === id) || {}).name || 'C9';
    const renderBulbs = () => {
      if (!bulbGroups.length) return '';
      return `<div class="ohu-group">Bulbs (C9 / C7)</div>` + bulbGroups.map((g, gi) => {
        const pat = patternOf(g.pattern_id);
        const parts = this.split(g.total, pat, g.uneven ? g.odd : {});
        const uniq = pat ? [...new Map(pat.colors.map(c => [c.id, c])).values()] : [];
        const preview = uniq.map(c => `${this._esc(c.name)} ${parts[c.id] || 0}`).join(' · ');
        return `<div class="ohu-bulbs" data-g="${gi}">
            <div class="ohu-bulbs-head"><b>${this._esc(bulbName(g.bulb_type_id))}</b>
              ${bulbGroups.length > 1 ? `<button class="btn btn-sm btn-ghost" data-g-del="${gi}">Remove</button>` : ''}</div>
            <div class="ohu-patterns">${patterns.map(p => `<button class="ohu-chip${p.id === g.pattern_id ? ' on' : ''}" data-g-pat="${gi}:${p.id}">
              ${p.colors.slice(0, 4).map(c => `<span class="ohu-swatch" style="background:${this._esc(c.hex)}"></span>`).join('')}${this._esc(p.name)}</button>`).join('')}
              <button class="ohu-chip" data-g-custom="${gi}">&#10133; Custom</button></div>
            <div class="ohu-row">
              <div class="ohu-label">Total bulbs${g.planned ? `<div class="ohu-plan">plan ${g.planned}</div>` : ''}</div>
              <button class="ohu-btn" data-g-step="${gi}:-1" aria-label="Less">&minus;</button>
              <input class="ohu-qty ohu-total" type="number" inputmode="numeric" min="0" value="${g.total || 0}" data-g-total="${gi}">
              <button class="ohu-btn" data-g-step="${gi}:1" aria-label="More">+</button>
              <button class="btn btn-sm" data-g-step="${gi}:25">+25</button>
            </div>
            <label class="ohu-uneven"><input type="checkbox" data-g-uneven="${gi}" ${g.uneven ? 'checked' : ''}> Not an even split</label>
            <label class="ohu-uneven"><input type="checkbox" data-g-ground="${gi}" ${g.ground ? 'checked' : ''}> Ground run (stakes)</label>
            ${g.uneven ? `<div class="ohu-odd">${uniq.map(c => `<label class="ohu-odd-row"><span class="ohu-swatch" style="background:${this._esc(c.hex)}"></span>${this._esc(c.name)}
                <input type="number" inputmode="numeric" min="0" placeholder="the rest" value="${g.odd[c.id] != null ? g.odd[c.id] : ''}" data-g-odd="${gi}:${c.id}"></label>`).join('')}
              <div class="ohu-plan">Leave the main color empty: it gets the rest.</div></div>` : ''}
            ${pat && g.total ? `<div class="ohu-split">${preview}</div>` : ''}
          </div>`;
      }).join('') + '<button class="btn btn-sm" data-g-add>&#10133; Another pattern</button>';
    };

    const clipVal = (key) => key === 'main' ? (clip.mainQty != null ? clip.mainQty : mainAuto())
      : key === 'ground' ? (clip.groundQty != null ? clip.groundQty : groundBulbs()) : (clip.special[key] || 0);
    const setClip = (key, v) => {
      if (key === 'main') clip.mainQty = v;
      else if (key === 'ground') clip.groundQty = v;
      else clip.special[key] = v;
    };
    // A custom pattern: tap the colors in order (e.g. red, green, blue).
    const customPattern = (gi) => {
      if (!navigator.onLine) { App.showToast('A new pattern needs signal', 'error'); return; }
      const picked = [];
      const box = $('.ohu-add');
      const draw = () => {
        box.innerHTML = `<div class="ohu-add-card"><div class="ohu-add-title">Custom pattern: tap the colors in order</div>
            <div class="ohu-custom-seq">${picked.map(c => `<span class="ohu-swatch" style="background:${this._esc(c.hex)}"></span>`).join('') || '<span class="ohu-plan">e.g. red, green, blue</span>'}</div>
            <div class="ohu-patterns" style="flex-wrap:wrap;">${(catalog.colors || []).map(c => `<button class="ohu-chip" data-cc="${c.id}"><span class="ohu-swatch" style="background:${this._esc(c.hex)}"></span>${this._esc(c.name)}</button>`).join('')}</div>
            <div class="ohm-btns" style="margin-top:12px;display:flex;gap:8px;"><button class="btn" data-cc-undo ${picked.length ? '' : 'disabled'}>&#8630; Undo</button>
              <button class="btn" data-add-cancel>Cancel</button>
              <button class="btn btn-primary" data-cc-save ${picked.length ? '' : 'disabled'}>Save pattern</button></div></div>`;
      };
      draw();
      box.hidden = false;
      box.onclick = async (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        e.stopPropagation();
        if (t.hasAttribute('data-add-cancel')) { box.hidden = true; box.onclick = null; return; }
        if (t.dataset.cc) { picked.push((catalog.colors || []).find(c => String(c.id) === t.dataset.cc)); draw(); return; }
        if (t.hasAttribute('data-cc-undo')) { picked.pop(); draw(); return; }
        if (t.hasAttribute('data-cc-save')) {
          try {
            const pat = await OdooAPI.callKw('fsm.order', 'worker_create_pattern', [job.id, picked.map(c => c.id)], {});
            if (!patterns.find(p => p.id === pat.id)) patterns.push(pat);
            bulbGroups[gi].pattern_id = pat.id;
            bulbGroups[gi].odd = {};
            box.hidden = true; box.onclick = null;
            render();
          } catch (err) {
            App.showToast('Not saved: ' + (err.message || err), 'error');
          }
        }
      };
    };
    const clipRowHtml = (key, label, qty, hint) => `<div class="ohu-row" data-clip="${key}">
        <div class="ohu-label">${this._esc(label)}${hint ? `<div class="ohu-plan">${hint}</div>` : ''}</div>
        <button class="ohu-btn" data-clip-step="${key}:-1" aria-label="Less">&minus;</button>
        <input class="ohu-qty ohu-clipqty" type="number" inputmode="numeric" min="0" value="${qty}" data-clip-qty="${key}">
        <button class="ohu-btn" data-clip-step="${key}:1" aria-label="More">+</button>
        <span class="ohu-unit"></span></div>`;
    const renderClips = () => {
      if (!clipCat) return '';
      const auto = mainAuto();
      const main = clipCat.main.find(c => c.id === clip.main) || clipCat.main[0];
      const special = perBulbSpecial();
      let html = '<div class="ohu-group">Clips</div>';
      html += `<label class="ohu-clipsel">Roof clips <select data-clip-select>${clipCat.main.map(c =>
        `<option value="${c.id}"${c.id === clip.main ? ' selected' : ''}>${this._esc(c.name)}</option>`).join('')}</select></label>`;
      if (main) {
        html += clipRowHtml('main', main.name, clip.mainQty != null ? clip.mainQty : auto,
          clip.mainQty != null ? `typed in · from bulbs: ${auto} <button class="btn btn-sm btn-ghost" data-clip-auto>use ${auto}</button>`
            : `${roofBulbs()} roof bulbs${special ? ` − ${special} special clips` : ''}`);
      }
      if (clipCat.ground && (groundBulbs() > 0 || clip.groundQty)) {
        html += clipRowHtml('ground', clipCat.ground.name, clip.groundQty != null ? clip.groundQty : groundBulbs(), 'one per bulb on ground runs');
      }
      clipCat.special.forEach(c => {
        if (c.code === 'magnetic_clip' || (clip.special[c.code] || 0) > 0 || clip.special[c.code] === 0) {
          html += clipRowHtml(c.code, c.name, clip.special[c.code] || 0, c.code === 'magnetic_clip' ? 'counted as you go' : (c.usage === 'per_ft' ? 'feet' : ''));
        }
      });
      clip.others.forEach((o, oi) => {
        html += `<div class="ohu-row" data-other="${oi}">
            <input type="text" class="ohu-other-name" placeholder="What clip?" value="${this._esc(o.label || '')}" data-other-name="${oi}">
            <button class="ohu-btn" data-other-step="${oi}:-1" aria-label="Less">&minus;</button>
            <input class="ohu-qty ohu-clipqty" type="number" inputmode="numeric" min="0" value="${o.qty || 0}" data-other-qty="${oi}">
            <button class="ohu-btn" data-other-step="${oi}:1" aria-label="More">+</button>
            <span class="ohu-unit"></span></div>`;
      });
      // More: the two that come up (shingle tabs, ridge clips) and Other (type it in).
      const more = clipCat.special.filter(c => ['shingle_tab', 'ridge_clip'].includes(c.code) && clip.special[c.code] == null);
      html += clip.more
        ? `<div class="ohu-patterns">${more.map(c => `<button class="ohu-chip" data-clip-add="${c.code}">${this._esc(c.name)}</button>`).join('')}
            <button class="ohu-chip" data-clip-other>Other…</button></div>`
        : '<button class="btn btn-sm" data-clip-more>&#10133; More clips</button>';
      return html;
    };

    const render = () => {
      const groups = (catalog.groups.length ? catalog.groups : [{ key: 'other', title: 'Items' }]);
      let html = renderBulbs() + renderClips();
      groups.forEach(g => {
        if (g.key === 'bulb' && bulbGroups.length) return;  // counted above, by pattern
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

    // The bulb totals by pattern
    $('.ohu-body').addEventListener('click', (e) => {
      const t = e.target.closest('button, input[type="checkbox"]');
      if (!t) return;
      if (t.dataset.gPat) {
        const [gi, pid] = t.dataset.gPat.split(':').map(Number);
        bulbGroups[gi].pattern_id = pid; bulbGroups[gi].odd = {};
        render();
      } else if (t.dataset.gStep) {
        const [gi, d] = t.dataset.gStep.split(':').map(Number);
        bulbGroups[gi].total = Math.max(0, (bulbGroups[gi].total || 0) + d);
        render();
      } else if (t.dataset.gUneven) {
        const g = bulbGroups[parseInt(t.dataset.gUneven, 10)];
        g.uneven = t.checked;
        if (!g.uneven) g.odd = {};
        render();
      } else if (t.dataset.gGround) {
        bulbGroups[parseInt(t.dataset.gGround, 10)].ground = t.checked;
        render();
      } else if (t.dataset.gCustom) {
        customPattern(parseInt(t.dataset.gCustom, 10));
      } else if (t.dataset.clipMain) {
        clip.main = parseInt(t.dataset.clipMain, 10);
        render();
      } else if (t.dataset.clipStep) {
        const [key, d] = t.dataset.clipStep.split(':');
        setClip(key, Math.max(0, clipVal(key) + parseInt(d, 10)));
        render();
      } else if (t.hasAttribute('data-clip-auto')) {
        clip.mainQty = null;
        render();
      } else if (t.hasAttribute('data-clip-more')) {
        clip.more = true;
        render();
      } else if (t.hasAttribute('data-clip-other')) {
        clip.others.push({ label: '', qty: 0 });
        clip.more = false;
        render();
        const input = overlay.querySelector(`[data-other-name="${clip.others.length - 1}"]`);
        if (input) input.focus();
      } else if (t.dataset.otherStep) {
        const [oi, d] = t.dataset.otherStep.split(':').map(Number);
        clip.others[oi].qty = Math.max(0, (clip.others[oi].qty || 0) + d);
        render();
      } else if (t.dataset.clipAdd) {
        clip.special[t.dataset.clipAdd] = 0;
        clip.more = false;
        render();
        const input = overlay.querySelector(`[data-clip-qty="${t.dataset.clipAdd}"]`);
        if (input) { input.focus(); input.select(); }
      } else if (t.dataset.gDel) {
        bulbGroups.splice(parseInt(t.dataset.gDel, 10), 1);
        render();
      } else if (t.hasAttribute('data-g-add')) {
        const last = bulbGroups[bulbGroups.length - 1] || {};
        bulbGroups.push({ bulb_type_id: last.bulb_type_id || ((catalog.bulb_types || [])[0] || {}).id || false,
                          pattern_id: (patterns.find(p => p.id !== last.pattern_id) || patterns[0] || {}).id || false,
                          total: 0, planned: 0, odd: {}, uneven: false });
        render();
      }
    });
    $('.ohu-body').addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.gTotal) { bulbGroups[parseInt(t.dataset.gTotal, 10)].total = Math.max(0, t.valueAsNumber || 0); render(); }
      if (t.dataset.clipQty) { setClip(t.dataset.clipQty, Math.max(0, t.valueAsNumber || 0)); render(); }
      if (t.hasAttribute('data-clip-select')) { clip.main = parseInt(t.value, 10); render(); }
      if (t.dataset.otherName) { clip.others[parseInt(t.dataset.otherName, 10)].label = t.value; }
      if (t.dataset.otherQty) { clip.others[parseInt(t.dataset.otherQty, 10)].qty = Math.max(0, t.valueAsNumber || 0); render(); }
      if (t.dataset.gOdd) {
        const [gi, cid] = t.dataset.gOdd.split(':');
        const g = bulbGroups[parseInt(gi, 10)];
        if (t.value === '') delete g.odd[cid]; else g.odd[cid] = Math.max(0, t.valueAsNumber || 0);
        render();
      }
    });

    $('.ohu-body').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-step]');
      if (!btn) return;
      const i = parseInt(btn.closest('.ohu-row').dataset.i, 10);
      const row = rows[i];
      row.qty = Math.max(0, (parseFloat(row.qty) || 0) + parseInt(btn.dataset.step, 10) * this._step(row));
      render();
    });
    $('.ohu-body').addEventListener('change', (e) => {
      if (!e.target.classList.contains('ohu-qty') || e.target.dataset.gTotal || e.target.dataset.clipQty
          || e.target.dataset.otherQty) return;
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
        if (patterns.length) {
          // Bulbs are counted as a total per pattern.
          bulbGroups.push({ bulb_type_id: bulbPicked.id, pattern_id: patterns[0].id, total: 0, planned: 0, odd: {}, uneven: false });
          $('.ohu-add').hidden = true;
          render();
          return;
        }
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
      if (act.dataset.act === 'close') { overlay.remove(); if (onClose) onClose(); }
      if (act.dataset.act === 'add') showAdd('kind');
      if (act.dataset.act === 'save') {
        // An input still being typed in: take its value.
        overlay.querySelectorAll('.ohu-qty:not(.ohu-total):not(.ohu-clipqty)').forEach(inp => {
          const i = parseInt(inp.closest('.ohu-row').dataset.i, 10);
          rows[i].qty = Math.max(0, inp.valueAsNumber || 0);
        });
        overlay.querySelectorAll('[data-g-total]').forEach(inp => {
          bulbGroups[parseInt(inp.dataset.gTotal, 10)].total = Math.max(0, inp.valueAsNumber || 0);
        });
        overlay.querySelectorAll('[data-other-name]').forEach(inp => { clip.others[parseInt(inp.dataset.otherName, 10)].label = inp.value; });
        overlay.querySelectorAll('[data-other-qty]').forEach(inp => { clip.others[parseInt(inp.dataset.otherQty, 10)].qty = Math.max(0, inp.valueAsNumber || 0); });
        overlay.querySelectorAll('[data-clip-qty]').forEach(inp => {
          const key = inp.dataset.clipQty;
          const v = Math.max(0, inp.valueAsNumber || 0);
          if (v !== clipVal(key)) setClip(key, v);
        });
        const groupsOut = bulbGroups.filter(g => g.total > 0 && g.pattern_id).map(g => ({
          bulb_type_id: g.bulb_type_id, pattern_id: g.pattern_id, total: g.total, odd: g.uneven ? g.odd : {}, ground: !!g.ground }));
        act.disabled = true;
        try {
          // Added and left at 0: not used. A planned item at 0 stays (the plan was wrong).
          await this.save(job.id, rows.filter(r => (r.qty || 0) > 0 || (r.planned || 0) > 0).concat(clipRows()), data,
            data.bulb_groups ? groupsOut : null);
          overlay.remove();
          if (onClose) onClose();
        } catch (err) {
          App.showToast('Not saved: ' + (err.message || err), 'error');
          act.disabled = false;
        }
      }
    });
  },

  async save(jobId, rows, data, groups) {
    if (navigator.onLine) {
      try {
        await OdooAPI.callKw('fsm.order', 'worker_save_used', [jobId, rows, groups || null], {});
        await DB.setState(this._key(jobId), Object.assign({}, data, { rows, bulb_groups: groups || data.bulb_groups,
          source: 'saved', saved_at: '' })).catch(() => {});
        App.showToast('Count saved', 'success');
        return;
      } catch (err) {
        if (navigator.onLine && !OdooAPI.isOffline(err)) throw err;
      }
    }
    const pending = await this._pending();
    pending[jobId] = { rows, groups: groups || null, at: Date.now() };
    await DB.setState(this.PENDING_KEY, pending);
    App.showToast('Saved on this phone: it goes to the office when there\'s signal', 'success');
  },
};

window.addEventListener('online', () => HolidayUsed.flush().catch(() => {}));
setTimeout(() => HolidayUsed.flush().catch(() => {}), 5000);
