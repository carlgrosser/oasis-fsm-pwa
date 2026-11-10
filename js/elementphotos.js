/**
 * Holiday Lighting: photos and counts for the trees, bushes, bush groups and runs on a job's map (Carl 2026-11-09).
 *
 * - The element sheet (tap a tree on the map, or pick one from "Still to photograph"): this season's photos and
 *   earlier seasons', 📷 Photo, and the element's own count boxes (optional; they go into the job's Actual Used
 *   draft and add up into the product totals there).
 * - After the after-install photos: "Assign to…" each new photo to a tree, bush or run (or skip: it stays a normal
 *   job photo).
 * Photos are taken and uploaded the usual way (Photos: Drive, offline queue). Assigning only adds the element to the
 * phone's photo record; it is sent to Odoo (worker_photo_element, safe to send twice) now or when there's signal.
 */
const ElementPhotos = {
  _key(jobId) { return 'oep_' + jobId; },
  _esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; },

  /** {elements: [{uid, label, kind}], photos: {uid: n}} from the map (kept on the phone for no signal). */
  async elements(job) {
    let state = null;
    if (navigator.onLine) {
      try {
        state = await OdooAPI.callKw('fsm.order', 'worker_get_design_map', [job.id], {});
        await DB.setState(this._key(job.id), state).catch(() => {});
      } catch (err) { console.warn('Map elements: using the saved copy', err); }
    }
    state = state || (await DB.getState(this._key(job.id)).catch(() => null)) || {};
    // Bushes always show how many ("B2 · front hedge · Bushes ×5"; an old single bush ×1).
    const label = (x, kind) => (x.code ? x.code + ' · ' : '') + (kind === 'bush'
      ? (x.name ? x.name + ' · ' : '') + `Bushes ×${x.count || 1}`
      : (x.label || x.name || kind) + ((x.count || 1) > 1 ? ` (×${x.count})` : ''));
    const elements = []
      .concat((state.runs || []).map(r => ({ uid: r.uid, label: `Run ${r.run_no}${r.kind ? ' · ' + r.kind : ''}`, kind: 'run' })))
      .concat((state.features || []).map(f => ({ uid: f.uid, label: label(f, f.kind), kind: f.kind })));
    // Photos taken on this phone but not sent yet count too.
    const photos = Object.assign({}, state.photos || {});
    const local = await Photos.getPhotosForJob(job.id).catch(() => []);
    local.filter(p => p.element_uid && !p.element_sent).forEach(p => { photos[p.element_uid] = (photos[p.element_uid] || 0) + 1; });
    return { elements, photos };
  },

  /** Send the photos assigned to an element (again with the Drive link once it's uploaded). */
  async flush() {
    if (!navigator.onLine) return;
    const all = await DB.getAll('photos').catch(() => []);
    // Sent now with the phone's thumbnail; again once uploaded (Drive link, or the Odoo copy when Drive is down).
    for (const p of all.filter(x => x.element_uid && (!x.element_sent || (x.synced && x.element_sent !== 'synced')))) {
      try {
        await OdooAPI.callKw('fsm.order', 'worker_photo_element', [p.job_id, {
          element_uid: p.element_uid, element_label: p.element_label || '', client_uid: p.temp_id,
          thumbnail: p.thumbnail || '', gdrive_url: p.gdrive_url || '', attachment_id: p.attachment_id || false,
          taken_at: p.taken_at || p.timestamp }], {});
        const fresh = (await DB.get('photos', p.temp_id).catch(() => null)) || p;
        fresh.element_sent = p.synced ? 'synced' : 1;
        await DB.put('photos', fresh).catch(() => {});
      } catch (err) { console.warn('Element photo not sent yet', err); }
    }
  },

  async assign(photo, element) {
    const fresh = (await DB.get('photos', photo.temp_id).catch(() => null)) || photo;
    Object.assign(fresh, { element_uid: element.uid, element_label: element.label, element_sent: 0 });
    await DB.put('photos', fresh).catch(() => {});
    this.flush().catch(() => {});
  },

  /** Take photos now and assign them all to this element. */
  async takeFor(job, element) {
    // Every photo saved while this is set belongs to the element (Photos.savePhoto stamps it), however the photo
    // sheet is closed.
    // Kept until the element's sheet closes (the camera / picker may resolve before the last photo is saved).
    Photos.elementTarget = { jobId: job.id, uid: element.uid, label: element.label, until: Date.now() + 15 * 60000 };
    const since = Date.now();
    await Photos.capturePhoto(job.id, 'after');
    const taken = (await Photos.getPhotosForJob(job.id).catch(() => [])).filter(p => p.element_uid === element.uid
      && new Date(p.timestamp).getTime() >= since);
    this.flush().catch(() => {});
    return taken.length;
  },

  // ------------------------------------------------------------------ photos already on the job, any phone
  /** Pick from the job's photos (every phone; after photos first) to tie to this element, or untie one. */
  async jobPhotoPicker(job, element, onDone) {
    if (!navigator.onLine) { App.showToast('The job\'s photos need signal', 'error'); return; }
    const overlay = document.createElement('div');
    overlay.className = 'ohu-overlay';
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); if (onDone) onDone(); };
    const draw = async () => {
      overlay.innerHTML = `<div class="ohu-head"><button class="btn btn-sm" data-x>&larr; Done</button>
          <div style="flex:1;min-width:0;"><div class="ohu-title">Use a job photo</div><div class="ohu-sub">For ${this._esc(element.label)}: tap a photo to use it, again to take it off</div></div></div>
        <div class="ohu-body"><div class="loading"><div class="spinner"></div></div></div>`;
      const photos = await Photos.loadServerPhotos(job.id);
      // This phone's photos not sent yet are offered too (tied on the phone, sent with the photo).
      const local = (await Photos.getPhotosForJob(job.id).catch(() => []))
        .filter(p => !p.synced && !p.attachment_id && !p.gdrive_file_id)
        .map(p => ({ key: 'l:' + p.temp_id, local: p, category: p.category, thumb: p.thumbnail, by: 'This phone', at: '',
          elements: p.element_uid ? [{ uid: p.element_uid, label: p.element_label || '' }] : [] }));
      const all = local.concat(photos);
      this._jobPhotos = all;
      const body = overlay.querySelector('.ohu-body');
      const label = { after: 'After', before: 'Walk-through' };
      body.innerHTML = all.length ? `<div class="oep-grid">${all.map(p => {
        const on = p.elements.some(e => e.uid === element.uid);
        return `<button class="oep-pick${on ? ' on' : ''}" data-key="${this._esc(p.key)}" data-on="${on ? 1 : 0}">
            <img src="${this._esc(p.thumb)}" alt="" loading="lazy">
            <span class="oep-cap">${this._esc(label[p.category] || p.category || 'Photo')} · ${this._esc(p.local ? 'this phone, not sent yet' : Photos.whoWhen(p))}</span>
            ${p.elements.length ? `<span class="oep-tags">${p.elements.map(e => this._esc(e.label)).join(', ')}</span>` : ''}
            ${on ? '<span class="oep-check">&#10003;</span>' : ''}</button>`;
      }).join('')}</div>` : '<div class="empty-state" style="padding:24px;">No photos on this job yet.</div>';
    };
    overlay.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.hasAttribute('data-x')) return close();
      if (t.dataset.key) {
        const untag = t.dataset.on === '1';
        const local = t.dataset.key.startsWith('l:') && (this._jobPhotos || []).find(p => p.key === t.dataset.key);
        if (local) {
          const fresh = (await DB.get('photos', local.local.temp_id).catch(() => null)) || local.local;
          Object.assign(fresh, untag ? { element_uid: null, element_label: null } : { element_uid: element.uid, element_label: element.label, element_sent: 0 });
          await DB.put('photos', fresh).catch(() => {});
          App.showToast(untag ? `Taken off ${element.label}` : `Photo of ${element.label}`, 'success');
          return draw();
        }
        try {
          await OdooAPI.callKw('fsm.order', 'worker_tag_job_photo', [job.id, t.dataset.key, element.uid, element.label, untag], {});
          App.showToast(untag ? `Taken off ${element.label}` : `Photo of ${element.label}`, 'success');
        } catch (err) { App.showToast('Not saved: ' + (err.message || err), 'error'); }
        draw();
      }
    });
    draw();
  },

  // ------------------------------------------------------------------ the element sheet: photo + count
  async sheet(job, element, onClose) {
    const overlay = document.createElement('div');
    overlay.className = 'ohu-overlay';
    overlay.innerHTML = `<div class="ohu-head"><button class="btn btn-sm" data-x>&larr; Back</button>
        <div style="flex:1;min-width:0;"><div class="ohu-title">${this._esc(element.label)}</div><div class="ohu-sub">Photos and count</div></div></div>
      <div class="ohu-body"><div class="loading"><div class="spinner"></div></div></div>`;
    document.body.appendChild(overlay);
    const body = overlay.querySelector('.ohu-body');
    const close = () => { Photos.elementTarget = null; overlay.remove(); if (onClose) onClose(); };
    const draw = async () => {
      let seasons = [];
      if (navigator.onLine) seasons = await OdooAPI.callKw('fsm.order', 'worker_element_photos', [job.id, element.uid], {}).catch(() => []);
      const local = (await Photos.getPhotosForJob(job.id).catch(() => [])).filter(p => p.element_uid === element.uid && !p.element_sent);
      // The element's count boxes, from the job's Actual Used (optional; they add up into the totals there).
      const data = typeof HolidayUsed !== 'undefined' ? await HolidayUsed.load(job.id).catch(() => null) : null;
      const draft = data ? await DB.getState(HolidayActual._draftKey(job.id)).catch(() => null) : null;
      const parts = (draft && draft.parts) || (data && data.parts) || [];
      const part = parts.find(p => p.uid === element.uid);
      // The job's season (its year; Odoo files them by the company's season).
      const season = parseInt(String(job.scheduled_date_start || new Date().toISOString()).slice(0, 4), 10);
      const strip = (photos) => photos.map(ph => `<a href="${this._esc(ph.url || '#')}" target="_blank" rel="noopener"><img class="oep-thumb" src="${this._esc(ph.thumb)}" alt=""></a>`).join('');
      body.innerHTML = `
        <div style="display:flex;gap:8px;"><button class="btn btn-primary btn-lg" style="flex:1;" data-photo>&#128247; Photo</button>
          <button class="btn btn-lg" style="flex:1;" data-jobphoto>&#128444;&#65039; Use a job photo</button></div>
        <div class="ohu-group">This season</div>
        <div class="oep-strip">${strip((seasons.find(s => s.season === season) || { photos: [] }).photos)}
          ${local.map(p => `<img class="oep-thumb" src="${this._esc(p.thumbnail)}" alt="">`).join('')}</div>
        ${seasons.filter(s => s.season !== season).map(s => `<div class="ohu-group">${s.season}</div><div class="oep-strip">${strip(s.photos)}</div>`).join('')}
        ${part ? `<div class="ohu-group">Count <span class="ohu-plan">(optional: adds up into the job's totals)</span></div>
          ${part.items.map((it, ii) => `<div class="oha-item"><div class="oha-item-label">${this._esc(it.label)}</div>
            <input class="ohu-qty" type="number" inputmode="decimal" min="0" placeholder="?" value="${it.qty === null || it.qty === undefined ? '' : it.qty}" data-q="${ii}">
            <span class="ohu-unit">${this._esc(it.unit || '')}</span></div>`).join('')}
          <button class="btn btn-success" style="width:100%;margin-top:8px;" data-count>Save the count</button>` : ''}`;
      body.onclick = async (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        if (t.hasAttribute('data-photo')) {
          const n = await this.takeFor(job, element).catch(() => 0);
          if (n) App.showToast(`${n} photo${n > 1 ? 's' : ''} of ${element.label}`, 'success');
          return draw();
        }
        if (t.hasAttribute('data-jobphoto')) return this.jobPhotoPicker(job, element, draw);
        if (t.hasAttribute('data-count') && part) {
          const base = draft || { from: data.default_from, truck_id: data.truck_id, elements: data.elements,
            house_rows: data.house_rows, swaps: data.swaps || [], parts: data.parts };
          const target = base.parts.find(p => p.uid === element.uid);
          body.querySelectorAll('[data-q]').forEach(inp => {
            target.items[+inp.dataset.q].qty = inp.value === '' ? null : Math.max(0, inp.valueAsNumber || 0);
          });
          await DB.setState(HolidayActual._draftKey(job.id), base).catch(() => {});
          App.showToast('Counted: it adds up in Actual Used. Save the count there.', 'success');
        }
      };
    };
    overlay.querySelector('[data-x]').addEventListener('click', close);
    await draw();
  },

  // ------------------------------------------------------------------ assign after the after photos
  async offerAssign(job, photos) {
    if (!photos.length) return;
    const { elements, photos: counts } = await this.elements(job);
    if (!elements.length) return;  // no map: they stay normal job photos
    const overlay = document.createElement('div');
    overlay.className = 'ohu-overlay';
    document.body.appendChild(overlay);
    let i = 0;
    const draw = () => {
      const p = photos[i];
      const sorted = elements.slice().sort((a, b) => (counts[a.uid] ? 1 : 0) - (counts[b.uid] ? 1 : 0));
      overlay.innerHTML = `<div class="ohu-head"><button class="btn btn-sm" data-x>Done</button>
          <div style="flex:1;min-width:0;"><div class="ohu-title">Assign to&hellip;</div><div class="ohu-sub">Photo ${i + 1} of ${photos.length}: which tree, bush or run? (optional)</div></div></div>
        <div class="ohu-body"><img class="oep-big" src="${this._esc(p.thumbnail)}" alt="">
          <div class="ohu-plan">Still to photograph first; 📷 = photos this season.</div>
          <div class="oha-chips">${sorted.map(el => `<button class="ohu-chip${counts[el.uid] ? '' : ' oep-todo'}" data-el="${this._esc(el.uid)}">${this._esc(el.label)}${counts[el.uid] ? ` 📷${counts[el.uid]}` : ''}</button>`).join('')}</div>
          <button class="btn btn-ghost" style="width:100%;margin-top:10px;" data-skip>Skip: a job photo</button></div>`;
    };
    const next = () => { i += 1; if (i >= photos.length) overlay.remove(); else draw(); };
    overlay.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.hasAttribute('data-x')) { overlay.remove(); return; }
      if (t.hasAttribute('data-skip')) return next();
      if (t.dataset.el) {
        const el = elements.find(x => x.uid === t.dataset.el);
        await this.assign(photos[i], el);
        counts[el.uid] = (counts[el.uid] || 0) + 1;
        App.showToast(`Photo of ${el.label}`, 'success');
        return next();
      }
    });
    draw();
  },

  /** "Still to photograph": map elements with no photo this season. */
  async stillList(job, onPick) {
    const { elements, photos } = await this.elements(job);
    const todo = elements.filter(el => !photos[el.uid]);
    const box = document.createElement('div');
    box.className = 'ohu-overlay';
    box.innerHTML = `<div class="ohu-head"><button class="btn btn-sm" data-x>&larr; Back</button>
        <div style="flex:1;min-width:0;"><div class="ohu-title">Still to photograph</div><div class="ohu-sub">${todo.length} of ${elements.length}</div></div></div>
      <div class="ohu-body">${todo.map(el => `<div style="display:flex;gap:6px;align-items:stretch;"><button class="omt-row" style="flex:1;" data-el="${this._esc(el.uid)}"><span class="omt-name">${this._esc(el.label)}</span><span class="omt-qty">&#128247;</span></button>
          <button class="btn" data-jp="${this._esc(el.uid)}" title="Use a job photo">&#128444;&#65039; Job photo</button></div>`).join('')
        || '<div class="empty-state" style="padding:24px;">Every tree, bush and run has a photo this season.</div>'}</div>`;
    document.body.appendChild(box);
    box.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.hasAttribute('data-x')) { box.remove(); return; }
      if (t.dataset.el) { box.remove(); onPick(todo.find(x => x.uid === t.dataset.el)); }
      if (t.dataset.jp) { box.remove(); this.jobPhotoPicker(job, todo.find(x => x.uid === t.dataset.jp)); }
    });
  },
};

window.addEventListener('online', () => ElementPhotos.flush().catch(() => {}));
setTimeout(() => ElementPhotos.flush().catch(() => {}), 9000);
