/**
 * Holiday Lighting: the job's design on the Google satellite map (phones first).
 *
 * - A job with a design: its runs (numbers, tag colors, start points, feet). While the design is
 *   Ready for Install the crew tags runs, sets start points and where, and adds runs (a run added
 *   to the office's design flags it for the office).
 * - A rehang (no design): Draw run: tap the corners of each run on the satellite map, then tag
 *   it. Odoo makes it the house's design (lengths from the lines), so next season has a map.
 *
 * Needs signal (Google's map); the Picking List sheet is the no-signal copy.
 * Odoo: worker_get_design_map, worker_map_save_run, worker_map_delete_run, worker_map_set_colors.
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

  async _run(job, overlay, data) {
    const $ = (s) => overlay.querySelector(s);
    const g = window.google.maps;
    const st = { data, mode: 'view', drawPts: [], drawLine: null, shapes: [] };
    let center = data.center;
    if (!center || !(center.lat || center.lng)) {
      const pos = await GPS.getCurrentPosition().catch(() => null);
      center = pos ? { lat: pos.lat, lng: pos.lon } : { lat: 38.58157, lng: -121.4944 };
    }
    const map = new g.Map($('.ohm-map'), {
      center, zoom: data.zoom || 20, heading: data.heading || 0, tilt: 0, mapTypeId: 'satellite',
      gestureHandling: 'greedy', clickableIcons: false, disableDefaultUI: true, zoomControl: true,
      rotateControl: false, keyboardShortcuts: false,
    });

    const editable = () => (st.data.design ? st.data.design.editable : st.data.can_start);
    const ownRun = (run) => !st.data.design || st.data.design.field || run.added_on_site;
    const colorOf = (run, i) => run.tag || this.COLORS[i % this.COLORS.length];
    const sub = () => {
      const d = st.data.design;
      const runs = st.data.runs || [];
      const tagged = runs.filter(r => r.tag_status === 'actual').length;
      if (!d) return st.data.can_start ? 'No design yet: tap Draw run and tap each corner of a run' : 'No design, and no house record: ask the office';
      return `${d.name}${d.field ? ' (drawn on site)' : ''} · ${runs.length} run${runs.length === 1 ? '' : 's'} · ${tagged} tagged${d.editable ? '' : ' · locked'}`;
    };

    const clear = () => { st.shapes.forEach(s => s.setMap(null)); st.shapes = []; };
    const draw = () => {
      clear();
      (st.data.runs || []).forEach((run, i) => {
        const path = (run.geometry || []).map(([lng, lat]) => ({ lat, lng }));
        if (path.length < 2) return;
        const color = colorOf(run, i);
        const line = new g.Polyline({ map, path, strokeColor: color, strokeWeight: 6, strokeOpacity: 0.95,
                                      clickable: st.mode === 'view', zIndex: 2 });
        line.addListener('click', () => runSheet(run));
        const halo = new g.Polyline({ map, path, strokeColor: '#000', strokeWeight: 10, strokeOpacity: 0.35, clickable: false, zIndex: 1 });
        const start = path[Math.min(run.start_index || 0, path.length - 1)];
        const num = new g.Marker({ map, position: start, clickable: st.mode === 'view', zIndex: 3,
          label: { text: String(run.run_no), color: '#000', fontWeight: '700', fontSize: '13px' },
          icon: { path: g.SymbolPath.CIRCLE, scale: 12, fillColor: color, fillOpacity: 1, strokeColor: '#000', strokeWeight: 2 } });
        num.addListener('click', () => runSheet(run));
        st.shapes.push(line, halo, num);
      });
      (st.data.power || []).forEach(p => {
        if (!(p.lat || p.lng)) return;
        st.shapes.push(new g.Marker({ map, position: { lat: p.lat, lng: p.lng }, clickable: false, title: p.label,
          label: { text: p.has_timer ? '⏱' : '⚡', fontSize: '14px' },
          icon: { path: g.SymbolPath.CIRCLE, scale: 10, fillColor: '#fff', fillOpacity: 0.9, strokeColor: '#000', strokeWeight: 1 } }));
      });
      $('.ohu-sub').textContent = sub();
      bar();
    };

    const bar = () => {
      const b = $('.ohm-bar');
      if (st.mode === 'draw') {
        b.innerHTML = `<div class="ohm-hint">Tap each corner of the run, in order. ${st.drawPts.length} point${st.drawPts.length === 1 ? '' : 's'}.</div>
          <div class="ohm-btns"><button class="btn" data-bar="undo">&#8630; Undo</button>
          <button class="btn" data-bar="cancel">Cancel</button>
          <button class="btn btn-primary" data-bar="done" ${st.drawPts.length < 2 ? 'disabled' : ''}>Done</button></div>`;
        return;
      }
      const d = st.data.design;
      b.innerHTML = `<div class="ohm-btns">
          ${editable() ? '<button class="btn btn-primary" data-bar="draw">&#9999;&#65039; Draw run</button>' : ''}
          ${d && d.field ? '<button class="btn" data-bar="colors">&#127912; Colors</button>' : ''}
          <button class="btn" data-bar="me">&#128205; Me</button></div>
        ${(st.data.runs || []).length ? '<div class="ohm-hint">Tap a run to tag it or set its start.</div>' : ''}`;
    };

    const save = async (values) => {
      const c = map.getCenter();
      const res = await OdooAPI.callKw('fsm.order', 'worker_map_save_run',
        [job.id, values, { lat: c.lat(), lng: c.lng(), zoom: map.getZoom() }], {});
      st.data.design = res.design;
      st.data.can_start = false;
      const runs = st.data.runs || (st.data.runs = []);
      const i = runs.findIndex(r => r.uid === res.run.uid);
      if (i >= 0) runs[i] = res.run; else runs.push(res.run);
      job.ohl_design_id = job.ohl_design_id || [res.design.id, res.design.name];
      draw();
      return res.run;
    };

    // ------------------------------------------------ The run sheet: tag, start, where (and lights, clips)
    const runSheet = (run) => {
      if (st.mode !== 'view') return;
      const box = $('.ohu-add');
      const canEdit = editable();
      const own = ownRun(run);
      const pick = { tag_color_id: run.tag_id || false, product_tmpl_id: run.product_tmpl_id || false,
                     attachment_id: run.attachment_id || false, start_index: run.start_index || 0 };
      const corners = (run.geometry || []).length;
      const chips = (list, key, label, swatch) => list.map(o => `<button class="ohu-chip${pick[key] === o.id ? ' on' : ''}" data-set="${key}" data-val="${o.id}">
          ${swatch ? `<span class="ohu-swatch" style="background:${this._esc(o.hex)}"></span>` : ''}${this._esc(o[label])}</button>`).join('');
      box.innerHTML = `<div class="ohu-add-card">
          <div class="ohu-add-title">Run ${this._esc(run.run_no)} · ${Math.round(run.feet || 0)} ft${run.product ? ' · ' + this._esc(run.product) : ''}</div>
          ${run.attachment ? `<div class="ohm-hint">Clips: ${this._esc(run.attachment)}</div>` : ''}
          ${canEdit ? `
          ${st.data.tags.length ? `<div class="ohm-sec">Tag</div>${chips(st.data.tags, 'tag_color_id', 'name', true)}` : ''}
          ${corners > 2 || corners === 2 ? `<div class="ohm-sec">Start (plug end)</div>
            <div class="ohm-row"><button class="ohu-chip" data-start="-1">&#9664;</button>
              <span class="ohm-start">corner ${pick.start_index + 1} of ${corners}</span>
              <button class="ohu-chip" data-start="1">&#9654;</button></div>` : ''}
          <div class="ohm-sec">Where</div>
          <input type="text" class="ohu-other ohm-where" value="${this._esc(run.location || '')}" placeholder="e.g. Front gutter">
          <div class="ohm-row">${this.WHERE.map(w => `<button class="ohu-chip" data-where="${this._esc(w)}">${this._esc(w)}</button>`).join('')}</div>
          ${own ? `<div class="ohm-sec">Lights</div>${chips(st.data.products, 'product_tmpl_id', 'name')}
                   <div class="ohm-sec">Clips</div>${chips(st.data.attachments, 'attachment_id', 'name')}` : ''}
          <div class="ohm-btns" style="margin-top:12px;">
            ${own ? '<button class="btn" data-run="delete">Delete run</button>' : ''}
            <button class="btn" data-run="cancel">Close</button>
            <button class="btn btn-primary" data-run="save">Save</button></div>`
          : '<div class="ohm-btns" style="margin-top:12px;"><button class="btn" data-run="cancel">Close</button></div>'}
        </div>`;
      box.hidden = false;
      // Show where the start is while choosing it.
      let startMark = null;
      const showStart = () => {
        if (startMark) startMark.setMap(null);
        const p = (run.geometry || [])[pick.start_index];
        if (p) startMark = new g.Marker({ map, position: { lat: p[1], lng: p[0] }, zIndex: 5,
          icon: { path: g.SymbolPath.CIRCLE, scale: 8, fillColor: '#fff', fillOpacity: 1, strokeColor: '#e53935', strokeWeight: 4 } });
        const label = box.querySelector('.ohm-start');
        if (label) label.textContent = `corner ${pick.start_index + 1} of ${corners}`;
      };
      if (canEdit) showStart();
      const close = () => { box.hidden = true; if (startMark) startMark.setMap(null); };
      box.onclick = async (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        if (t.dataset.set) {
          const v = parseInt(t.dataset.val, 10);
          pick[t.dataset.set] = pick[t.dataset.set] === v ? false : v;
          box.querySelectorAll(`[data-set="${t.dataset.set}"]`).forEach(x => x.classList.toggle('on', parseInt(x.dataset.val, 10) === pick[t.dataset.set]));
        }
        if (t.dataset.start) {
          pick.start_index = (pick.start_index + parseInt(t.dataset.start, 10) + corners) % corners;
          showStart();
        }
        if (t.dataset.where) box.querySelector('.ohm-where').value = t.dataset.where;
        if (t.dataset.run === 'cancel') close();
        if (t.dataset.run === 'delete' && window.confirm(`Delete run ${run.run_no}?`)) {
          try {
            await OdooAPI.callKw('fsm.order', 'worker_map_delete_run', [job.id, run.uid], {});
            st.data.runs = st.data.runs.filter(r => r.uid !== run.uid);
            close(); draw();
          } catch (err) { App.showToast('Not deleted: ' + (err.message || err), 'error'); }
        }
        if (t.dataset.run === 'save') {
          t.disabled = true;
          const values = { uid: run.uid, tag_color_id: pick.tag_color_id, start_index: pick.start_index,
                           location: box.querySelector('.ohm-where').value.trim() };
          if (own) Object.assign(values, { product_tmpl_id: pick.product_tmpl_id, attachment_id: pick.attachment_id });
          try {
            await save(values);
            close();
            App.showToast(`Run ${run.run_no} saved`, 'success');
          } catch (err) {
            App.showToast('Not saved: ' + (err.message || err), 'error');
            t.disabled = false;
          }
        }
      };
    };

    const colorsSheet = () => {
      const box = $('.ohu-add');
      const current = st.data.design && st.data.design.pattern_id;
      box.innerHTML = `<div class="ohu-add-card"><div class="ohu-add-title">House colors (C7 / C9)</div>
          ${st.data.patterns.map(p => `<button class="ohu-chip${p.id === current ? ' on' : ''}" data-pattern="${p.id}">
            ${p.colors.slice(0, 4).map(c => `<span class="ohu-swatch" style="background:${this._esc(c)}"></span>`).join('')}${this._esc(p.name)}</button>`).join('')}
          <div class="ohm-btns" style="margin-top:12px;"><button class="btn" data-close-sheet>Close</button></div></div>`;
      box.hidden = false;
      box.onclick = async (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        if (t.hasAttribute('data-close-sheet')) { box.hidden = true; return; }
        if (t.dataset.pattern) {
          try {
            await OdooAPI.callKw('fsm.order', 'worker_map_set_colors', [job.id, parseInt(t.dataset.pattern, 10)], {});
            st.data.design.pattern_id = parseInt(t.dataset.pattern, 10);
            box.hidden = true;
            App.showToast('Colors saved', 'success');
          } catch (err) { App.showToast('Not saved: ' + (err.message || err), 'error'); }
        }
      };
    };

    // ------------------------------------------------ Drawing a run
    const redrawTemp = () => {
      if (st.drawLine) st.drawLine.setMap(null);
      st.drawLine = new g.Polyline({ map, path: st.drawPts, strokeColor: '#ffeb3b', strokeWeight: 5, clickable: false, zIndex: 4,
        icons: [{ icon: { path: g.SymbolPath.CIRCLE, scale: 4, fillColor: '#ffeb3b', fillOpacity: 1, strokeColor: '#000', strokeWeight: 1 }, offset: '0', repeat: '0' }] });
      st.drawDots = (st.drawDots || []).filter(m => { m.setMap(null); return false; });
      st.drawPts.forEach(p => st.drawDots.push(new g.Marker({ map, position: p, clickable: false, zIndex: 4,
        icon: { path: g.SymbolPath.CIRCLE, scale: 6, fillColor: '#ffeb3b', fillOpacity: 1, strokeColor: '#000', strokeWeight: 2 } })));
      bar();
    };
    const endDraw = () => {
      st.mode = 'view';
      if (st.drawLine) st.drawLine.setMap(null);
      (st.drawDots || []).forEach(m => m.setMap(null));
      st.drawPts = [];
      draw();
    };
    map.addListener('click', (e) => {
      if (st.mode !== 'draw') return;
      st.drawPts.push({ lat: e.latLng.lat(), lng: e.latLng.lng() });
      redrawTemp();
    });
    $('.ohm-bar').addEventListener('click', async (e) => {
      const t = e.target.closest('[data-bar]');
      if (!t) return;
      const act = t.dataset.bar;
      if (act === 'draw') { st.mode = 'draw'; draw(); redrawTemp(); }
      if (act === 'undo') { st.drawPts.pop(); redrawTemp(); }
      if (act === 'cancel') endDraw();
      if (act === 'colors') colorsSheet();
      if (act === 'me') {
        const pos = await GPS.getCurrentPosition().catch(() => null);
        if (pos) map.panTo({ lat: pos.lat, lng: pos.lon });
        else App.showToast('No GPS fix', 'error');
      }
      if (act === 'done' && st.drawPts.length >= 2) {
        t.disabled = true;
        const geometry = st.drawPts.map(p => [p.lng, p.lat]);
        try {
          const run = await save({ geometry });
          endDraw();
          App.showToast(`Run ${run.run_no}: ${Math.round(run.feet || 0)} ft`, 'success');
          runSheet(run);
        } catch (err) {
          App.showToast('Not saved: ' + (err.message || err), 'error');
          t.disabled = false;
        }
      }
    });
    draw();
  },
};
