/**
 * Holiday Lighting: the job's design on the Google satellite map (phones first). Kept simple: the
 * crew marks where the lights go and their tag colors; the office makes it a full design.
 *
 *  1. Draw runs: tap the corners of a run, Next run / Done. Each run is a C9 roofline.
 *  2. Tag colors: pick a color, tap the runs that get it.
 *  3. Power: tap where each outlet is (tap one again to remove it).
 *  Only if it isn't roofline: tap a run → Garland / Fence / Ground / Other (or Delete).
 *
 * A job with the office's design shows its runs; the crew tags them and can add runs (flagged for
 * the office). Rehangs (no design): the runs drawn here become the house's design.
 * Needs signal (Google's map); the Picking List sheet is the no-signal copy.
 * Odoo: worker_get_design_map, worker_map_save_run, worker_map_delete_run, worker_map_add_power,
 * worker_map_delete_power.
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

  async open(job) {
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
    overlay.addEventListener('click', (e) => { if (e.target.closest('[data-act="close"]')) overlay.remove(); });
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

  async _run(job, overlay, data) {
    const $ = (s) => overlay.querySelector(s);
    const g = window.google.maps;
    const st = { data, mode: 'view', pts: [], temp: [], shapes: [], tag: null, busy: false };
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
    const runs = () => st.data.runs || (st.data.runs = []);
    const editable = () => (st.data.design ? st.data.design.editable : st.data.can_start);
    const ownRun = (run) => !st.data.design || st.data.design.field || run.added_on_site;
    const UNTAGGED = '#ffffff';
    const sub = () => {
      const d = st.data.design;
      const n = runs().length;
      const tagged = runs().filter(r => r.tag_id).length;
      if (!d) return st.data.can_start ? 'No design yet: Draw runs, then Tag colors' : 'No design, and no house record: ask the office';
      return `${d.name} · ${n} run${n === 1 ? '' : 's'} · ${tagged} tagged${d.editable ? '' : ' · locked'}`;
    };

    const draw = () => {
      st.shapes.forEach(s => s.setMap(null));
      st.shapes = [];
      runs().forEach((run) => {
        const path = (run.geometry || []).map(([lng, lat]) => ({ lat, lng }));
        if (path.length < 2) return;
        const color = run.tag || UNTAGGED;
        const kindDash = run.kind && run.kind !== 'roofline';
        st.shapes.push(new g.Polyline({ map, path, strokeColor: '#000', strokeWeight: 11, strokeOpacity: 0.45, clickable: false, zIndex: 1 }));
        st.shapes.push(new g.Polyline({ map, path, strokeColor: color, strokeWeight: 6, strokeOpacity: 1, clickable: false, zIndex: 2,
          icons: kindDash ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#000', scale: 3 }, offset: '0', repeat: '14px' }] : [] }));
        // A wide, see-through line on top: easy to tap with a finger.
        const hit = new g.Polyline({ map, path, strokeColor: '#000', strokeWeight: 28, strokeOpacity: 0.01,
                                     clickable: st.mode !== 'draw', zIndex: 3 });
        hit.addListener('click', () => onRun(run));
        st.shapes.push(hit);
        const num = new g.Marker({ map, position: path[0], clickable: st.mode !== 'draw', zIndex: 4,
          label: { text: String(run.run_no), color: '#000', fontWeight: '700', fontSize: '12px' },
          icon: { path: g.SymbolPath.CIRCLE, scale: 11, fillColor: color, fillOpacity: 1, strokeColor: '#000', strokeWeight: 2 } });
        num.addListener('click', () => onRun(run));
        st.shapes.push(num);
      });
      (st.data.power || []).forEach(p => {
        if (!(p.lat || p.lng)) return;
        const m = new g.Marker({ map, position: { lat: p.lat, lng: p.lng }, zIndex: 7, title: p.label,
          clickable: st.mode === 'power',
          label: { text: '⚡', fontSize: '16px' },
          icon: { path: g.SymbolPath.CIRCLE, scale: 13, fillColor: '#ffeb3b', fillOpacity: 1, strokeColor: '#000', strokeWeight: 2 } });
        m.addListener('click', () => removePower(p));
        st.shapes.push(m);
      });
      $('.ohu-sub').textContent = sub();
      bar();
    };

    const removePower = async (p) => {
      if (st.mode !== 'power' || st.busy || !window.confirm(`Remove outlet ${p.code || ''}?`)) return;
      st.busy = true;
      try {
        await OdooAPI.callKw('fsm.order', 'worker_map_delete_power', [job.id, p.id], {});
        st.data.power = (st.data.power || []).filter(x => x.id !== p.id);
        draw();
      } catch (err) {
        App.showToast('Not removed: ' + (err.message || err), 'error');
      }
      st.busy = false;
    };

    const bar = () => {
      const b = $('.ohm-bar');
      if (st.mode === 'draw') {
        const n = st.pts.length;
        b.innerHTML = `<div class="ohm-hint">Tap each corner of the run. ${n} point${n === 1 ? '' : 's'}.</div>
          <div class="ohm-btns"><button class="btn" data-bar="undo" ${n ? '' : 'disabled'}>&#8630; Undo</button>
          <button class="btn btn-primary" data-bar="next" ${n < 2 ? 'disabled' : ''}>Next run</button>
          <button class="btn" data-bar="done">Done</button></div>`;
        return;
      }
      if (st.mode === 'power') {
        b.innerHTML = `<div class="ohm-hint">Tap where each outlet is. Tap an outlet to remove it.</div>
          <div class="ohm-btns"><button class="btn btn-primary" data-bar="done">Done</button></div>`;
        return;
      }
      if (st.mode === 'tag') {
        b.innerHTML = `<div class="ohm-hint">${st.tag ? 'Tap each run that gets this tag.' : 'Pick a tag color, then tap the runs.'}</div>
          <div class="ohm-tags">${st.data.tags.map(t => `<button class="ohm-tag${st.tag === t.id ? ' on' : ''}" data-tag="${t.id}"
              style="background:${this._esc(t.hex)}" aria-label="${this._esc(t.name)}"><span>${this._esc(t.name)}</span></button>`).join('')}</div>
          <div class="ohm-btns"><button class="btn btn-primary" data-bar="done">Done</button></div>`;
        return;
      }
      b.innerHTML = `<div class="ohm-btns">
          ${editable() ? '<button class="btn btn-primary" data-bar="draw">&#9999;&#65039; Draw runs</button>' : ''}
          ${editable() && runs().length ? '<button class="btn btn-primary" data-bar="tag">&#127991;&#65039; Tag colors</button>' : ''}
          ${editable() ? '<button class="btn" data-bar="power">&#9889; Power</button>' : ''}
          <button class="btn" data-bar="me" aria-label="Where I am">&#128205;</button></div>
        ${editable() && runs().length ? '<div class="ohm-hint">Not roofline? Tap the run.</div>' : ''}`;
    };

    const save = async (values) => {
      const c = map.getCenter();
      const res = await OdooAPI.callKw('fsm.order', 'worker_map_save_run',
        [job.id, values, { lat: c.lat(), lng: c.lng(), zoom: map.getZoom() }], {});
      st.data.design = res.design;
      st.data.can_start = false;
      const i = runs().findIndex(r => r.uid === res.run.uid);
      if (i >= 0) runs()[i] = res.run; else runs().push(res.run);
      if (!job.ohl_design_id) job.ohl_design_id = [res.design.id, res.design.name];
      return res.run;
    };

    // ------------------------------------------------ Tapping a run: tag it (Tag mode) or say what it is
    const onRun = async (run) => {
      if (st.mode === 'draw' || st.mode === 'power' || st.busy || !editable()) return;
      if (st.mode === 'tag') {
        if (!st.tag) { App.showToast('Pick a tag color first', 'info'); return; }
        st.busy = true;
        try {
          await save({ uid: run.uid, tag_color_id: run.tag_id === st.tag ? false : st.tag });
          draw();
        } catch (err) {
          App.showToast('Not saved: ' + (err.message || err), 'error');
        }
        st.busy = false;
        return;
      }
      if (!ownRun(run)) {
        App.showToast(`Run ${run.run_no}: ${Math.round(run.feet || 0)} ft (the office's run: tag it in Tag colors)`, 'info');
        return;
      }
      kindSheet(run);
    };

    const kindSheet = (run) => {
      const box = $('.ohu-add');
      box.innerHTML = `<div class="ohu-add-card">
          <div class="ohu-add-title">Run ${this._esc(run.run_no)} · ${Math.round(run.feet || 0)} ft</div>
          <div class="ohm-row">${this.KINDS.map(k => `<button class="ohu-chip${(run.kind || 'roofline') === k.key ? ' on' : ''}" data-kind="${k.key}">${k.label}</button>`).join('')}</div>
          <div class="ohm-btns" style="margin-top:14px;"><button class="btn" data-sheet="delete">Delete run</button>
            <button class="btn btn-primary" data-sheet="close">Close</button></div></div>`;
      box.hidden = false;
      box.onclick = async (e) => {
        const t = e.target.closest('button');
        if (!t || st.busy) return;
        if (t.dataset.sheet === 'close') { box.hidden = true; return; }
        st.busy = true;
        try {
          if (t.dataset.kind && t.dataset.kind !== (run.kind || 'roofline')) {
            await save({ uid: run.uid, kind: t.dataset.kind });
            box.hidden = true;
            draw();
          } else if (t.dataset.kind) {
            box.hidden = true;
          }
          if (t.dataset.sheet === 'delete' && window.confirm(`Delete run ${run.run_no}?`)) {
            await OdooAPI.callKw('fsm.order', 'worker_map_delete_run', [job.id, run.uid], {});
            st.data.runs = runs().filter(r => r.uid !== run.uid);
            box.hidden = true;
            draw();
          }
        } catch (err) {
          App.showToast('Not saved: ' + (err.message || err), 'error');
        }
        st.busy = false;
      };
    };

    // ------------------------------------------------ Drawing
    const drawTemp = () => {
      st.temp.forEach(s => s.setMap(null));
      st.temp = [];
      if (st.pts.length) {
        st.temp.push(new g.Polyline({ map, path: st.pts, strokeColor: '#ffeb3b', strokeWeight: 5, clickable: false, zIndex: 5 }));
        st.pts.forEach(p => st.temp.push(new g.Marker({ map, position: p, clickable: false, zIndex: 6,
          icon: { path: g.SymbolPath.CIRCLE, scale: 6, fillColor: '#ffeb3b', fillOpacity: 1, strokeColor: '#000', strokeWeight: 2 } })));
      }
      bar();
    };
    const saveCurrent = async () => {
      if (st.pts.length < 2) return true;
      st.busy = true;
      try {
        const run = await save({ geometry: st.pts.map(p => [p.lng, p.lat]) });
        App.showToast(`Run ${run.run_no}: ${Math.round(run.feet || 0)} ft`, 'success');
        st.pts = [];
        drawTemp();
        draw();
        return true;
      } catch (err) {
        App.showToast('Not saved: ' + (err.message || err), 'error');
        return false;
      } finally {
        st.busy = false;
      }
    };
    map.addListener('click', async (e) => {
      if (st.busy) return;
      if (st.mode === 'power') {
        st.busy = true;
        try {
          const c = map.getCenter();
          const res = await OdooAPI.callKw('fsm.order', 'worker_map_add_power',
            [job.id, e.latLng.lat(), e.latLng.lng(), { lat: c.lat(), lng: c.lng(), zoom: map.getZoom() }], {});
          (st.data.power = st.data.power || []).push(res.power);
          st.data.design = res.design;
          st.data.can_start = false;
          if (!job.ohl_design_id) job.ohl_design_id = [res.design.id, res.design.name];
          draw();
        } catch (err) {
          App.showToast('Not saved: ' + (err.message || err), 'error');
        }
        st.busy = false;
        return;
      }
      if (st.mode !== 'draw') return;
      st.pts.push({ lat: e.latLng.lat(), lng: e.latLng.lng() });
      drawTemp();
    });

    $('.ohm-bar').addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t || st.busy) return;
      if (t.dataset.tag) { st.tag = parseInt(t.dataset.tag, 10); bar(); return; }
      const act = t.dataset.bar;
      if (act === 'draw') { st.mode = 'draw'; st.pts = []; draw(); drawTemp(); }
      if (act === 'tag') { st.mode = 'tag'; draw(); }
      if (act === 'power') { st.mode = 'power'; draw(); }
      if (act === 'undo') { st.pts.pop(); drawTemp(); }
      if (act === 'next') await saveCurrent();
      if (act === 'done') {
        if (st.mode === 'draw' && !(await saveCurrent())) return;
        st.mode = 'view'; st.pts = []; drawTemp(); draw();
      }
      if (act === 'me') {
        const pos = await GPS.getCurrentPosition().catch(() => null);
        if (pos) map.panTo({ lat: pos.lat, lng: pos.lon });
        else App.showToast('No GPS fix', 'error');
      }
    });
    draw();
  },
};
