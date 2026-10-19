/**
 * Holiday Lighting: the job's design on the Google satellite map (phones first). Kept simple: the
 * crew marks where things go; the office makes it a full design.
 *
 *  ✏️ Runs:  tap the corners of a run (or ✍️ Freehand: drag a finger along curves), Next / Done.
 *           Each run is a C9 roofline; tap a run later to say Garland / Fence / Ground / Other.
 *  🔌 Cords: extension cords and jumpers, drawn the same way.
 *  🌳 Items: trees, bushes, other (wreaths…): tap where they are.
 *  🏷️ Tags:  pick a color, tap the runs and cords that get it.
 *  ⚡ Power: tap where each outlet is.
 *
 * A job with the office's design shows it; things added on site are flagged for the office.
 * Rehangs (no design): this makes the house's design. Needs signal (Google's map); the Picking List
 * sheet is the no-signal copy. Odoo: worker_get_design_map, worker_map_save_run / _delete_run,
 * worker_map_save_cord / _delete_cord, worker_map_add_feature / _delete_feature,
 * worker_map_add_power / _delete_power.
 */
const HolidayMap = {
  COLORS: ['#f5c542', '#4fc3f7', '#81c784', '#ff8a65', '#ba68c8', '#4db6ac', '#e57373', '#7986cb'],
  WHERE: ['Front gutter', 'Garage', 'Peaks', 'Porch', 'Side', 'Back', 'Fence', 'Walkway'],
  _gLoading: null,

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },

  /** Google Maps (as the yard sign app loads it). */
  _loadGoogle(key) {
    if (window.google && window.google.maps && window.google.maps.Map) return Promise.resolve();
    if (!key) return Promise.reject(new Error('No Google Maps key in Odoo'));
    if (!this._gLoading) {
      this._gLoading = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this._gLoading = null; reject(new Error('The map took too long to load')); }, 15000);
        window.ohlGoogleReady = () => { clearTimeout(timer); resolve(); };
        window.gm_authFailure = () => {
          App.showToast('Google Maps isn\'t accepting our key: the office needs to check it. Use the Picking List.', 'error');
        };
        const s = document.createElement('script');
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=ohlGoogleReady&v=quarterly`;
        s.async = true;
        s.onerror = () => { clearTimeout(timer); this._gLoading = null; reject(new Error('The map didn\'t load')); };
        document.head.appendChild(s);
      });
    }
    return this._gLoading;
  },

  async open(job, onClose) {
    const overlay = document.createElement('div');
    overlay.className = 'ohu-overlay ohm-overlay';
    overlay.innerHTML = `
      <div class="ohu-head">
        <button class="btn btn-sm" data-act="close">&larr; Back</button>
        <div style="flex:1;min-width:0;"><div class="ohu-title">Map</div>
          <div class="ohu-sub">Loading&hellip;</div></div>
      </div>
      <div class="ohm-map"></div>
      <div class="ohm-bar"></div>
      <div class="ohu-add" hidden></div>`;
    document.body.appendChild(overlay);
    const $ = (s) => overlay.querySelector(s);
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="close"]')) { overlay.remove(); if (onClose) onClose(); }
    });
    const fail = (msg) => {
      $('.ohu-sub').textContent = '';
      $('.ohm-map').innerHTML = `<div class="empty-state" style="padding:24px;text-align:center;">
          <p>${this._esc(msg)}</p>
          <button class="btn btn-primary" data-act="sheet">Open the Picking List</button></div>`;
      $('[data-act="sheet"]').addEventListener('click', () => { overlay.remove(); InstallMap.open(job); });
    };
    if (!navigator.onLine) { fail('The map needs signal. The Picking List works without it.'); return; }
    let data;
    try {
      data = await OdooAPI.callKw('fsm.order', 'worker_get_design_map', [job.id], {});
      await this._loadGoogle(data.maps_key);
    } catch (err) {
      fail((err && err.message) || 'The map didn\'t load.');
      return;
    }
    this._run(job, overlay, data);
  },

  KINDS: [
    { key: 'roofline', label: 'Roofline' }, { key: 'garland', label: 'Garland' },
    { key: 'fence', label: 'Fence' }, { key: 'ground', label: 'Ground' }, { key: 'other', label: 'Other' },
  ],
  ITEMS: [
    { key: 'tree', label: '🌳 Tree', color: '#2e7d32' }, { key: 'bush', label: '🌿 Bush', color: '#9ccc65' },
    { key: 'other', label: '⭐ Other', color: '#ab47bc' },
  ],
  CORD_COLOR: '#ff9800',
  // Runs tool: a C9 bulb on a green wire.
  RUN_ICON: '<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><path d="M1 8 Q8 4 16 8 T31 8" stroke="#2e7d32" stroke-width="2.6" fill="none" stroke-linecap="round"/><rect x="12.5" y="8" width="7" height="5.5" rx="1.2" fill="#1b5e20"/><path d="M16 13.5 C9.5 17.5 10.5 27 16 29.5 C21.5 27 22.5 17.5 16 13.5 Z" fill="#ffca28" stroke="#f57f17" stroke-width="1.1"/><path d="M14 18 C13 20 13.2 23 14.3 25" stroke="#fff8e1" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',

  /** Ramer–Douglas–Peucker: a finger stroke (pixels) down to the points that matter. */
  _simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    let worst = 0, at = 0;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs(dy * pts[i].x - dx * pts[i].y + b.x * a.y - b.y * a.x) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst <= tol) return [a, b];
    return this._simplify(pts.slice(0, at + 1), tol).slice(0, -1).concat(this._simplify(pts.slice(at), tol));
  },

  async _run(job, overlay, data) {
    const $ = (s) => overlay.querySelector(s);
    const g = window.google.maps;
    const st = { data, mode: 'view', what: 'run', free: false, pts: [], temp: [], shapes: [], tag: null,
                 item: 'tree', busy: false };
    let center = data.center;
    if (!center || !(center.lat || center.lng)) {
      const pos = await GPS.getCurrentPosition().catch(() => null);
      center = pos ? { lat: pos.lat, lng: pos.lon } : { lat: 38.58157, lng: -121.4944 };
    }
    const map = new g.Map($('.ohm-map'), {
      center, zoom: data.zoom || 20, heading: data.heading || 0, tilt: 0, mapTypeId: 'satellite',
      gestureHandling: 'greedy', clickableIcons: false, disableDefaultUI: true, zoomControl: true,
      keyboardShortcuts: false,
    });
    // Pixels ↔ map, for freehand strokes.
    const proj = new g.OverlayView();
    proj.onAdd = () => {}; proj.draw = () => {}; proj.onRemove = () => {};
    proj.setMap(map);

    const list = (k) => st.data[k] || (st.data[k] = []);
    const editable = () => (st.data.design ? st.data.design.editable : st.data.can_start);
    const ownRun = (run) => !st.data.design || st.data.design.field || run.added_on_site;
    const UNTAGGED = '#ffffff';
    const sub = () => {
      const d = st.data.design;
      const n = list('runs').length;
      if (!d) return st.data.can_start ? 'No design yet: draw the runs, then tag them' : 'No design, and no house record: ask the office';
      const tagged = list('runs').filter(r => r.tag_id).length;
      return `${d.name} · ${n} run${n === 1 ? '' : 's'} · ${tagged} tagged · ${list('cords').length} cord${list('cords').length === 1 ? '' : 's'}${d.editable ? '' : ' · locked'}`;
    };
    const live = (m) => st.mode === m;
    const tappable = () => live('view') || live('tag');

    const pathOf = (geometry) => (geometry || []).map(([lng, lat]) => ({ lat, lng }));
    const draw = () => {
      st.shapes.forEach(s => s.setMap(null));
      st.shapes = [];
      const hitLine = (path, onTap) => {
        const hit = new g.Polyline({ map, path, strokeColor: '#000', strokeWeight: 28, strokeOpacity: 0.01,
                                     clickable: tappable(), zIndex: 3 });
        hit.addListener('click', onTap);
        st.shapes.push(hit);
      };
      list('runs').forEach((run) => {
        const path = pathOf(run.geometry);
        if (path.length < 2) return;
        const color = run.tag || UNTAGGED;
        const dashed = run.kind && run.kind !== 'roofline';
        st.shapes.push(new g.Polyline({ map, path, strokeColor: '#000', strokeWeight: 11, strokeOpacity: 0.45, clickable: false, zIndex: 1 }));
        st.shapes.push(new g.Polyline({ map, path, strokeColor: color, strokeWeight: 6, strokeOpacity: 1, clickable: false, zIndex: 2,
          icons: dashed ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#000', scale: 3 }, offset: '0', repeat: '14px' }] : [] }));
        if (run.tag2) {
          // Double tag: stripes of the second color over the first.
          st.shapes.push(new g.Polyline({ map, path, strokeOpacity: 0, clickable: false, zIndex: 2,
            icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: run.tag2, strokeWeight: 6, scale: 4 }, offset: '0', repeat: '20px' }] }));
        }
        hitLine(path, () => onRun(run));
        const num = new g.Marker({ map, position: path[0], clickable: tappable(), zIndex: 4,
          label: { text: String(run.run_no), color: '#000', fontWeight: '700', fontSize: '12px' },
          icon: { path: g.SymbolPath.CIRCLE, scale: 11, fillColor: color, fillOpacity: 1, strokeColor: '#000', strokeWeight: 2 } });
        num.addListener('click', () => onRun(run));
        st.shapes.push(num);
      });
      list('cords').forEach((cord) => {
        const path = pathOf(cord.geometry);
        if (path.length < 2) return;
        const color = cord.tag || this.CORD_COLOR;
        st.shapes.push(new g.Polyline({ map, path, strokeColor: '#000', strokeWeight: 6, strokeOpacity: 0.5, clickable: false, zIndex: 1 }));
        st.shapes.push(new g.Polyline({ map, path, strokeOpacity: 0, clickable: false, zIndex: 2,
          icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: color, strokeWeight: 4, scale: 3 }, offset: '0', repeat: '9px' }] }));
        if (cord.tag2) {
          st.shapes.push(new g.Polyline({ map, path, strokeOpacity: 0, clickable: false, zIndex: 2,
            icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: cord.tag2, strokeWeight: 4, scale: 3 }, offset: '9px', repeat: '18px' }] }));
        }
        hitLine(path, () => onCord(cord));
      });
      list('features').forEach((f) => {
        if (!(f.lat || f.lng)) return;
        const kind = this.ITEMS.find(i => i.key === f.kind) || this.ITEMS[2];
        const loose = st.data.design && st.data.design.field && !f.item_key && list('items').length;
        const m = new g.Marker({ map, position: { lat: f.lat, lng: f.lng }, zIndex: 6, title: f.item_label || f.label,
          clickable: st.mode === 'items' || st.mode === 'view',
          label: { text: (f.code || kind.label.slice(0, 2)) + (loose ? '?' : ''), color: '#fff', fontWeight: '700', fontSize: '11px' },
          icon: { path: g.SymbolPath.CIRCLE, scale: 13, fillColor: kind.color, fillOpacity: 1, strokeColor: loose ? '#ffeb3b' : '#fff', strokeWeight: loose ? 3 : 2 } });
        m.addListener('click', () => featureSheet(f));
        st.shapes.push(m);
      });
      list('power').forEach(p => {
        if (!(p.lat || p.lng)) return;
        const m = new g.Marker({ map, position: { lat: p.lat, lng: p.lng }, zIndex: 7, title: p.label,
          clickable: live('power'), label: { text: '⚡', fontSize: '16px' },
          icon: { path: g.SymbolPath.CIRCLE, scale: 13, fillColor: '#ffeb3b', fillOpacity: 1, strokeColor: '#000', strokeWeight: 2 } });
        m.addListener('click', () => removePower(p));
        st.shapes.push(m);
      });
      $('.ohu-sub').textContent = sub();
      bar();
      updatePill();
    };

    const bar = () => {
      const b = $('.ohm-bar');
      const done = '<button class="btn btn-primary" data-bar="done">Done</button>';
      if (live('draw')) {
        const n = st.pts.length;
        const what = st.what === 'cord' ? 'cord' : 'run';
        b.innerHTML = `<div class="ohm-seg"><button class="${st.free ? '' : 'on'}" data-bar="corners">&#128205; Tap corners</button>
            <button class="${st.free ? 'on' : ''}" data-bar="free">&#9997;&#65039; Freehand</button></div>
          <div class="ohm-hint">${st.free ? `Drag a finger along the ${what}. The map holds still.` : `Tap each corner of the ${what}.`}
            ${n ? `${n} point${n === 1 ? '' : 's'}.` : ''}</div>
          <div class="ohm-btns"><button class="btn" data-bar="undo" ${n ? '' : 'disabled'}>&#8630; ${st.free ? 'Clear' : 'Undo'}</button>
          <button class="btn btn-primary" data-bar="next" ${n < 2 ? 'disabled' : ''}>Next ${what}</button>${done}</div>`;
        return;
      }
      if (live('power')) {
        b.innerHTML = `<div class="ohm-hint">Tap where each outlet is. Tap an outlet to remove it.</div><div class="ohm-btns">${done}</div>`;
        return;
      }
      if (live('place')) {
        b.innerHTML = `<div class="ohm-hint">Tap the map where it is: <b>${this._esc(st.placing ? st.placing.label : '')}</b></div>
          <div class="ohm-btns"><button class="btn" data-bar="done">Cancel</button></div>`;
        return;
      }
      if (live('items')) {
        b.innerHTML = `<div class="ohm-row">${this.ITEMS.map(i => `<button class="ohu-chip${st.item === i.key ? ' on' : ''}" data-item="${i.key}">${i.label}</button>`).join('')}</div>
          <div class="ohm-hint">Tap where each one is. Tap one to assign it to the order's items, or delete it.</div><div class="ohm-btns">${done}</div>`;
        return;
      }
      if (live('tag')) {
        const tagOf = (id) => st.data.tags.find(t => t.id === id);
        const t1 = tagOf(st.tag), t2 = tagOf(st.tag2);
        const sel = t1 ? `<div class="ohm-tagsel"><span class="ohm-tagdot" style="background:${this._esc(t1.hex)}"></span>${this._esc(t1.name)}
            ${t2 ? ` + <span class="ohm-tagdot" style="background:${this._esc(t2.hex)}"></span>${this._esc(t2.name)}
              <button class="btn btn-sm btn-ghost" data-bar="tag2off" aria-label="One color only">&times;</button>`
              : `<button class="btn btn-sm" data-bar="tag2">+ 2nd color</button>`}</div>` : '';
        const hint = st.pick2 ? 'Pick the second color.'
          : st.tag ? 'Tap each run or cord that gets this tag.' : 'Pick a tag color, then tap the runs and cords.';
        b.innerHTML = `<div class="ohm-hint">${hint}</div>${sel}
          <div class="ohm-tags">${st.data.tags.map(t => `<button class="ohm-tag${st.tag === t.id || st.tag2 === t.id ? ' on' : ''}" data-tag="${t.id}"
              style="background:${this._esc(t.hex)}" aria-label="${this._esc(t.name)}"><span>${this._esc(t.name)}</span></button>`).join('')}</div>
          <div class="ohm-btns">${done}</div>`;
        return;
      }
      if (!editable()) {
        b.innerHTML = '<div class="ohm-hint">This design is locked: ask the office for changes.</div>';
        return;
      }
      const tool = (act, icon, label) => `<button class="ohm-tool" data-bar="${act}"><span>${icon}</span>${label}</button>`;
      b.innerHTML = `<div class="ohm-tools5">
          ${tool('runs', this.RUN_ICON, 'Runs')}${tool('cords', '&#128268;', 'Cords')}${tool('items', '&#127795;', 'Items')}
          ${tool('tag', '&#127991;&#65039;', 'Tags')}${tool('power', '&#9889;', 'Power')}</div>
        ${list('runs').length ? '<div class="ohm-hint">Not roofline? Tap the run.</div>' : ''}`;
    };

    // A full map state from Odoo (after placing / assigning items): take it all.
    const applyState = (state) => {
      if (!state) return;
      for (const k of ['runs', 'cords', 'features', 'power', 'items']) if (state[k]) st.data[k] = state[k];
      if ('unassigned' in state) st.data.unassigned = state.unassigned;
      if (state.design) { st.data.design = state.design; st.data.can_start = false; }
      if (state.design && !job.ohl_design_id) job.ohl_design_id = [state.design.id, state.design.name];
    };
    const pill = document.createElement('button');
    pill.className = 'ohm-pill';
    pill.hidden = true;
    $('.ohm-map').appendChild(pill);
    const updatePill = () => {
      const n = st.data.unassigned || 0;
      pill.hidden = !(n > 0 && editable() && (live('view') || live('items')));
      pill.innerHTML = `&#9888;&#65039; ${n} unassigned`;
    };
    pill.addEventListener('click', () => itemsList());

    const KIND_ICON = { tree: '🌳', bush: '🌿', other: '⭐' };
    const itemsList = () => {
      const box = $('.ohu-add');
      const items = list('items');
      box.innerHTML = `<div class="ohu-add-card">
          <div class="ohu-add-title">Items on this job</div>
          <div class="ohm-hint">Tap one, then tap the map where it is.</div>
          ${items.map(i => `<button class="ohm-item${i.placed ? ' placed' : ''}" data-place="${this._esc(i.key)}">
              <span>${KIND_ICON[i.kind] || '⭐'}</span><span class="ohm-item-label">${this._esc(i.label)}</span>
              <span class="ohm-item-state">${i.placed ? `&#10003; on the map${i.placed > 1 ? ' ×' + i.placed : ''}` : 'unassigned'}</span></button>`).join('')
            || '<p>No trees, bushes or other items on this order.</p>'}
          <div class="ohm-btns" style="margin-top:12px;"><button class="btn btn-primary" data-sheet="close">Close</button></div></div>`;
      box.hidden = false;
      box.onclick = (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        box.hidden = true;
        if (t.dataset.place) {
          st.placing = items.find(i => i.key === t.dataset.place);
          st.mode = 'place';
          draw();
        }
      };
    };

    const center3 = () => { const c = map.getCenter(); return { lat: c.lat(), lng: c.lng(), zoom: map.getZoom() }; };
    const took = (res) => {
      st.data.design = res.design;
      st.data.can_start = false;
      if (!job.ohl_design_id) job.ohl_design_id = [res.design.id, res.design.name];
    };
    const upsert = (key, item) => {
      const arr = list(key);
      const i = arr.findIndex(x => x.uid === item.uid);
      if (i >= 0) arr[i] = item; else arr.push(item);
    };
    const saveRun = async (values) => {
      const res = await OdooAPI.callKw('fsm.order', 'worker_map_save_run', [job.id, values, center3()], {});
      took(res); upsert('runs', res.run);
      return res.run;
    };
    const saveCord = async (values) => {
      const res = await OdooAPI.callKw('fsm.order', 'worker_map_save_cord', [job.id, values, center3()], {});
      took(res); upsert('cords', res.cord);
      return res.cord;
    };
    const guard = async (fn) => {
      if (st.busy) return;
      st.busy = true;
      try { await fn(); } catch (err) { App.showToast('Not saved: ' + (err.message || err), 'error'); }
      st.busy = false;
    };

    // ------------------------------------------------ Tapping things
    const onRun = (run) => guard(async () => {
      if (!editable()) return;
      if (live('tag')) {
        if (!st.tag) { App.showToast('Pick a tag color first', 'info'); return; }
        const same = run.tag_id === st.tag && (run.tag2_id || false) === (st.tag2 || false);
        await saveRun({ uid: run.uid, tag_color_id: same ? false : st.tag, tag_color2_id: same ? false : (st.tag2 || false) });
        draw();
        return;
      }
      if (!live('view')) return;
      if (!ownRun(run)) {
        App.showToast(`Run ${run.run_no}: ${Math.round(run.feet || 0)} ft (the office's run: tag it in Tags)`, 'info');
        return;
      }
      kindSheet(run);
    });
    const onCord = (cord) => guard(async () => {
      if (!editable()) return;
      if (live('tag')) {
        if (!st.tag) { App.showToast('Pick a tag color first', 'info'); return; }
        const same = cord.tag_id === st.tag && (cord.tag2_id || false) === (st.tag2 || false);
        await saveCord({ uid: cord.uid, tag_color_id: same ? false : st.tag, tag_color2_id: same ? false : (st.tag2 || false) });
        draw();
        return;
      }
      if (live('view') && window.confirm(`Cord ${cord.code || ''}: ${Math.round(cord.ft || 0)} ft. Delete it?`)) {
        await OdooAPI.callKw('fsm.order', 'worker_map_delete_cord', [job.id, cord.uid], {});
        st.data.cords = list('cords').filter(c => c.uid !== cord.uid);
        draw();
      }
    });
    // A tree / bush on the map: assign it to one of the order's items, unassign it, or delete it.
    const featureSheet = (f) => {
      if (!(live('items') || live('view')) || !editable() || st.busy) return;
      const field = !!(st.data.design && st.data.design.field);
      const own = field || f.added_on_site;
      const current = field ? f.item_key : (f.added_on_site ? false : `f:${f.id}`);
      const items = list('items');
      const box = $('.ohu-add');
      box.innerHTML = `<div class="ohu-add-card">
          <div class="ohu-add-title">${KIND_ICON[f.kind] || '⭐'} ${this._esc(f.code || f.label)}${current ? '' : ' · unassigned'}</div>
          ${items.length ? `<div class="ohm-sec">Assign to</div>
            ${items.map(i => `<button class="ohm-item${i.key === current ? ' on' : ''}" data-assign="${this._esc(i.key)}">
              <span>${KIND_ICON[i.kind] || '⭐'}</span><span class="ohm-item-label">${this._esc(i.label)}</span>
              <span class="ohm-item-state">${i.key === current ? '&#10003;' : (i.placed ? 'on the map' : 'unassigned')}</span></button>`).join('')}`
            : '<div class="ohm-hint">No trees or bushes on this order to assign it to.</div>'}
          <div class="ohm-btns" style="margin-top:12px;">
            ${current ? '<button class="btn" data-sheet="unassign">Unassign</button>' : ''}
            ${own ? '<button class="btn" data-sheet="delete">Delete</button>' : ''}
            <button class="btn btn-primary" data-sheet="close">Close</button></div></div>`;
      box.hidden = false;
      box.onclick = (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        if (t.dataset.sheet === 'close') { box.hidden = true; return; }
        guard(async () => {
          let state = null;
          if (t.dataset.assign && t.dataset.assign !== current) {
            state = await OdooAPI.callKw('fsm.order', 'worker_map_assign_feature', [job.id, f.id, t.dataset.assign], {});
          } else if (t.dataset.sheet === 'unassign') {
            state = await OdooAPI.callKw('fsm.order', 'worker_map_assign_feature', [job.id, f.id, false], {});
          } else if (t.dataset.sheet === 'delete') {
            if (!window.confirm(`Delete ${f.code || f.label}?`)) return;
            state = await OdooAPI.callKw('fsm.order', 'worker_map_delete_feature', [job.id, f.id], {});
          } else if (t.dataset.assign) {
            box.hidden = true;
            return;
          }
          box.hidden = true;
          applyState(state);
          draw();
        });
      };
    };
    const removePower = (p) => guard(async () => {
      if (!live('power') || !window.confirm(`Remove outlet ${p.code || ''}?`)) return;
      await OdooAPI.callKw('fsm.order', 'worker_map_delete_power', [job.id, p.id], {});
      st.data.power = list('power').filter(x => x.id !== p.id);
      draw();
    });

    const kindSheet = (run) => {
      const box = $('.ohu-add');
      box.innerHTML = `<div class="ohu-add-card">
          <div class="ohu-add-title">Run ${this._esc(run.run_no)} · ${Math.round(run.feet || 0)} ft</div>
          <div class="ohm-row">${this.KINDS.map(k => `<button class="ohu-chip${(run.kind || 'roofline') === k.key ? ' on' : ''}" data-kind="${k.key}">${k.label}</button>`).join('')}</div>
          <div class="ohm-btns" style="margin-top:14px;"><button class="btn" data-sheet="delete">Delete run</button>
            <button class="btn btn-primary" data-sheet="close">Close</button></div></div>`;
      box.hidden = false;
      box.onclick = (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        if (t.dataset.sheet === 'close') { box.hidden = true; return; }
        guard(async () => {
          if (t.dataset.kind) {
            if (t.dataset.kind !== (run.kind || 'roofline')) await saveRun({ uid: run.uid, kind: t.dataset.kind });
            box.hidden = true;
            draw();
          }
          if (t.dataset.sheet === 'delete' && window.confirm(`Delete run ${run.run_no}?`)) {
            await OdooAPI.callKw('fsm.order', 'worker_map_delete_run', [job.id, run.uid], {});
            st.data.runs = list('runs').filter(r => r.uid !== run.uid);
            box.hidden = true;
            draw();
          }
        });
      };
    };

    // ------------------------------------------------ Drawing runs and cords (corners or freehand)
    const drawTemp = () => {
      st.temp.forEach(s => s.setMap(null));
      st.temp = [];
      if (st.pts.length) {
        const color = st.what === 'cord' ? this.CORD_COLOR : '#ffeb3b';
        st.temp.push(new g.Polyline({ map, path: st.pts, strokeColor: color, strokeWeight: 5, clickable: false, zIndex: 8 }));
        if (!st.free) {
          st.pts.forEach(p => st.temp.push(new g.Marker({ map, position: p, clickable: false, zIndex: 9,
            icon: { path: g.SymbolPath.CIRCLE, scale: 6, fillColor: color, fillOpacity: 1, strokeColor: '#000', strokeWeight: 2 } })));
        }
      }
      bar();
    };
    const saveCurrent = async () => {
      if (st.pts.length < 2) return true;
      let ok = true;
      await guard(async () => {
        ok = false;
        const geometry = st.pts.map(p => [p.lng, p.lat]);
        if (st.what === 'cord') {
          const cord = await saveCord({ geometry });
          App.showToast(`Cord ${cord.code || ''}: ${Math.round(cord.ft || 0)} ft`, 'success');
        } else {
          const run = await saveRun({ geometry });
          App.showToast(`Run ${run.run_no}: ${Math.round(run.feet || 0)} ft`, 'success');
        }
        st.pts = [];
        drawTemp();
        draw();
        ok = true;
      });
      return ok;
    };
    // Freehand: a layer over the map takes the finger while the map holds still.
    const pad = document.createElement('div');
    pad.className = 'ohm-pad';
    pad.hidden = true;
    $('.ohm-map').appendChild(pad);
    let stroke = null;
    const toPx = (e) => { const r = pad.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pad.setPointerCapture && pad.setPointerCapture(e.pointerId);
      stroke = [toPx(e)];
    });
    pad.addEventListener('pointermove', (e) => {
      if (!stroke) return;
      const p = toPx(e);
      const last = stroke[stroke.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 4) return;
      stroke.push(p);
      const pj = proj.getProjection();
      if (pj) { st.pts = stroke.map(q => pj.fromContainerPixelToLatLng(new g.Point(q.x, q.y))).map(ll => ({ lat: ll.lat(), lng: ll.lng() })); drawTemp(); }
    });
    const endStroke = () => {
      if (!stroke) return;
      const pj = proj.getProjection();
      const kept = this._simplify(stroke, 3);
      stroke = null;
      if (pj && kept.length >= 2) {
        st.pts = kept.map(q => pj.fromContainerPixelToLatLng(new g.Point(q.x, q.y))).map(ll => ({ lat: ll.lat(), lng: ll.lng() }));
      } else {
        st.pts = [];
      }
      drawTemp();
    };
    pad.addEventListener('pointerup', endStroke);
    pad.addEventListener('pointercancel', endStroke);
    const setFree = (on) => {
      st.free = on;
      st.pts = [];
      pad.hidden = !(on && live('draw'));
      map.setOptions({ gestureHandling: pad.hidden ? 'greedy' : 'none' });
      drawTemp();
    };

    map.addListener('click', (e) => guard(async () => {
      if (live('power')) {
        const res = await OdooAPI.callKw('fsm.order', 'worker_map_add_power', [job.id, e.latLng.lat(), e.latLng.lng(), center3()], {});
        took(res); list('power').push(res.power);
        draw();
      } else if (live('items')) {
        const res = await OdooAPI.callKw('fsm.order', 'worker_map_add_feature', [job.id, st.item, e.latLng.lat(), e.latLng.lng(), center3()], {});
        took(res); applyState(res.state);
        draw();
      } else if (live('place') && st.placing) {
        const state = await OdooAPI.callKw('fsm.order', 'worker_map_place_item',
          [job.id, st.placing.key, e.latLng.lat(), e.latLng.lng(), center3()], {});
        applyState(state);
        st.mode = 'view'; st.placing = null;
        draw();
      } else if (live('draw') && !st.free) {
        st.pts.push({ lat: e.latLng.lat(), lng: e.latLng.lng() });
        drawTemp();
      }
    }));

    $('.ohm-bar').addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t || st.busy) return;
      if (t.dataset.tag) {
        const id = parseInt(t.dataset.tag, 10);
        if (st.pick2 && st.tag && id !== st.tag) { st.tag2 = id; st.pick2 = false; } else { st.tag = id; st.tag2 = null; st.pick2 = false; }
        bar();
        return;
      }
      if (t.dataset.bar === 'tag2') { st.pick2 = true; bar(); return; }
      if (t.dataset.bar === 'tag2off') { st.tag2 = null; st.pick2 = false; bar(); return; }
      if (t.dataset.item) { st.item = t.dataset.item; bar(); return; }
      const act = t.dataset.bar;
      if (act === 'runs' || act === 'cords') {
        st.mode = 'draw'; st.what = act === 'cords' ? 'cord' : 'run'; st.pts = [];
        draw(); setFree(st.free);
      }
      if (act === 'corners') setFree(false);
      if (act === 'free') setFree(true);
      if (act === 'tag' || act === 'power' || act === 'items') { st.mode = act; draw(); }
      if (act === 'undo') { if (st.free) st.pts = []; else st.pts.pop(); drawTemp(); }
      if (act === 'next') await saveCurrent();
      if (act === 'done') {
        if (live('draw') && !(await saveCurrent())) return;
        st.mode = 'view'; st.pts = [];
        pad.hidden = true; map.setOptions({ gestureHandling: 'greedy' });
        drawTemp(); draw();
      }
    });
    draw();
  },
};
