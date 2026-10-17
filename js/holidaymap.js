/**
 * Holiday Lighting: Draw Map — the crew draws the house's runs on a photo and tags each one
 * (lights, about how many feet, clips, tag color, where). Odoo makes it the house's design
 * (worker_save_field_map), so the picking list, Actual Used plan and next season's install map
 * come from it. For houses with no design: most rehangs.
 *
 * Tap to place points along a run, then Done line. Without signal, the map is kept on the iPad
 * and sent when the signal is back.
 */
const HolidayMap = {
  PENDING_KEY: 'ohm_pending',
  MAX_SIDE: 1600,
  COLORS: ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00897b', '#f4511e', '#3949ab'],
  WHERE: ['Front gutter', 'Garage', 'Peaks', 'Porch', 'Side', 'Back', 'Fence', 'Walkway'],
  FEET: [10, 20, 30, 40, 50, 60, 80, 100],

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },

  _optsKey(jobId) { return 'ohm_opts_' + jobId; },

  async options(jobId) {
    if (navigator.onLine) {
      try {
        const opts = await OdooAPI.callKw('fsm.order', 'worker_get_map_options', [jobId], {});
        await DB.setState(this._optsKey(jobId), opts).catch(() => {});
        return opts;
      } catch (err) {
        console.warn('Draw map: options fetch failed, using the saved copy', err);
      }
    }
    return DB.getState(this._optsKey(jobId)).catch(() => null);
  },

  async prewarm(job) {
    if (!navigator.onLine || job.ohl_job_kind !== 'install' || job.ohl_design_id) return;
    await this.options(job.id).catch(() => {});
  },

  /** A photo file → JPEG data URL no bigger than MAX_SIDE, with its size. */
  _shrink(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, this.MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.8), w: canvas.width, h: canvas.height });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo')); };
      img.src = url;
    });
  },

  _lineSummary(line, opts) {
    const product = (opts.products.find(p => p.id === line.product_tmpl_id) || {}).name;
    const clip = (opts.attachments.find(a => a.id === line.attachment_id) || {}).name;
    const tag = (opts.tags.find(t => t.id === line.tag_color_id) || {}).name;
    return [product || 'Lights?', line.feet ? `${line.feet} ft` : 'ft?', clip, tag ? `${tag} tag` : '', line.location]
      .filter(Boolean).join(' · ');
  },

  async open(job) {
    const opts = await this.options(job.id);
    if (!opts) { App.showToast('Not on this iPad yet: open it once with signal', 'error'); return; }
    if (!opts.can_draw) {
      App.showToast('This job has the office\'s design: use Report a Change for anything different', 'error');
      return;
    }
    const state = { photo: null, lines: [], current: [], pattern: (opts.design && opts.design.pattern_id) || opts.default_pattern_id,
                    angle: 'Front' };
    const overlay = document.createElement('div');
    overlay.className = 'ohu-overlay';
    overlay.innerHTML = `
      <div class="ohu-head">
        <button class="btn btn-sm" data-act="close">&larr; Back</button>
        <div style="flex:1;min-width:0;"><div class="ohu-title">Draw Map</div>
          <div class="ohu-sub">${opts.design ? `Adds a photo to ${this._esc(opts.design.name)} (${opts.design.runs} runs so far)`
            : 'Photo of the house (or an old map), then tap along each run'}</div></div>
      </div>
      <div class="ohu-body ohm-body">
        <div class="ohm-pick">
          <label class="btn btn-primary btn-lg ohm-pick-btn">&#128247; Take a photo
            <input type="file" accept="image/*" capture="environment" data-photo hidden></label>
          <label class="btn btn-lg ohm-pick-btn">&#128444;&#65039; Pick a photo or old map
            <input type="file" accept="image/*" data-photo hidden></label>
        </div>
        <div class="ohm-draw" hidden>
          <div class="ohm-row">
            <span>Side:</span>
            ${['Front', 'Back', 'Left', 'Right'].map(a => `<button class="ohu-chip ohm-angle${a === 'Front' ? ' on' : ''}" data-angle="${a}">${a}</button>`).join('')}
          </div>
          <div class="ohm-row"><span>House colors:</span>
            ${opts.patterns.map(p => `<button class="ohu-chip ohm-pattern${p.id === state.pattern ? ' on' : ''}" data-pattern="${p.id}">
              ${p.colors.slice(0, 4).map(c => `<span class="ohu-swatch" style="background:${this._esc(c)}"></span>`).join('')}${this._esc(p.name)}</button>`).join('')}
          </div>
          <div class="ohm-canvas-wrap"><canvas class="ohm-canvas"></canvas></div>
          <div class="ohm-tools">
            <button class="btn btn-sm" data-act="undo">&#8630; Undo point</button>
            <button class="btn btn-primary btn-sm" data-act="done-line" disabled>Done line &rarr;</button>
          </div>
          <div class="ohm-hint">Tap along a run of lights, corner by corner, then <b>Done line</b>.</div>
          <div class="ohm-lines"></div>
        </div>
      </div>
      <div class="ohu-foot">
        <button class="btn btn-lg" data-act="close">Cancel</button>
        <button class="btn btn-primary btn-lg" data-act="send" disabled>&#10003; Send map</button>
      </div>
      <div class="ohu-add" hidden></div>`;
    document.body.appendChild(overlay);
    const $ = (s) => overlay.querySelector(s);
    const canvas = $('.ohm-canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();

    const colorOf = (i) => {
      const tag = opts.tags.find(t => t.id === (state.lines[i] || {}).tag_color_id);
      return tag ? tag.hex : this.COLORS[i % this.COLORS.length];
    };
    const draw = () => {
      if (!state.photo) return;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const lw = Math.max(3, canvas.width / 250);
      const pathOf = (pts, color, dashed) => {
        ctx.save();
        ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = lw;
        if (dashed) ctx.setLineDash([lw * 3, lw * 2]);
        ctx.beginPath();
        pts.forEach(([x, y], k) => (k ? ctx.lineTo(x * canvas.width, y * canvas.height) : ctx.moveTo(x * canvas.width, y * canvas.height)));
        ctx.stroke();
        ctx.restore();
        pts.forEach(([x, y]) => {
          ctx.beginPath(); ctx.fillStyle = color;
          ctx.arc(x * canvas.width, y * canvas.height, lw * 1.3, 0, Math.PI * 2); ctx.fill();
        });
      };
      state.lines.forEach((line, i) => {
        pathOf(line.pts, colorOf(i), false);
        const [x, y] = line.pts[0];
        const r = lw * 4;
        ctx.beginPath(); ctx.fillStyle = colorOf(i);
        ctx.arc(x * canvas.width, y * canvas.height - r * 1.4, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), x * canvas.width, y * canvas.height - r * 1.4);
      });
      if (state.current.length) pathOf(state.current, '#ffeb3b', true);
      $('[data-act="done-line"]').disabled = state.current.length < 2;
      $('[data-act="send"]').disabled = !state.lines.length;
    };
    const renderLines = () => {
      $('.ohm-lines').innerHTML = state.lines.map((line, i) => `
        <div class="ohm-line" data-i="${i}">
          <span class="ohm-num" style="background:${this._esc(colorOf(i))}">${i + 1}</span>
          <span style="flex:1;">${this._esc(this._lineSummary(line, opts))}</span>
          <button class="btn btn-sm" data-edit="${i}">Edit</button>
          <button class="btn btn-sm" data-del="${i}" aria-label="Delete run ${i + 1}">&times;</button>
        </div>`).join('');
      draw();
    };

    overlay.querySelectorAll('[data-photo]').forEach(input => input.addEventListener('change', async () => {
      if (!input.files.length) return;
      try {
        state.photo = await this._shrink(input.files[0]);
      } catch (err) {
        App.showToast(err.message, 'error');
        return;
      }
      img.onload = () => {
        canvas.width = state.photo.w; canvas.height = state.photo.h;
        $('.ohm-pick').hidden = true; $('.ohm-draw').hidden = false;
        draw();
      };
      img.src = state.photo.dataUrl;
    }));

    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      state.current.push([Math.min(Math.max(x, 0), 1), Math.min(Math.max(y, 0), 1)]);
      draw();
    });

    // The tag sheet for a run: lights, feet, clips, tag, where.
    const tagSheet = (i) => {
      const line = state.lines[i];
      const box = $('.ohu-add');
      const chips = (list, key, label, swatch) => list.map(o => `<button class="ohu-chip${line[key] === o.id ? ' on' : ''}" data-set="${key}" data-val="${o.id}">
          ${swatch && o.hex ? `<span class="ohu-swatch" style="background:${this._esc(o.hex)}"></span>` : ''}${this._esc(o[label])}</button>`).join('');
      box.innerHTML = `<div class="ohu-add-card">
          <div class="ohu-add-title">Run ${i + 1}</div>
          <div class="ohm-sec">Lights</div>${chips(opts.products, 'product_tmpl_id', 'name')}
          <div class="ohm-sec">About how many feet?</div>
          <div class="ohm-row"><input type="number" inputmode="decimal" class="ohu-qty ohm-feet" value="${line.feet || ''}" placeholder="ft">
            ${this.FEET.map(f => `<button class="ohu-chip" data-feet="${f}">${f}</button>`).join('')}</div>
          <div class="ohm-sec">Clips</div>${chips(opts.attachments, 'attachment_id', 'name')}
          ${opts.tags.length ? `<div class="ohm-sec">Tag</div>${chips(opts.tags, 'tag_color_id', 'name', true)}` : ''}
          <div class="ohm-sec">Where</div>
          <div class="ohm-row"><input type="text" class="ohu-other ohm-where" value="${this._esc(line.location || '')}" placeholder="e.g. Front gutter"></div>
          <div class="ohm-row">${this.WHERE.map(w => `<button class="ohu-chip" data-where="${this._esc(w)}">${this._esc(w)}</button>`).join('')}</div>
          <div style="margin-top:12px;display:flex;gap:8px;"><button class="btn btn-primary btn-lg" style="flex:1;" data-tag-ok>Save run</button></div>
        </div>`;
      box.hidden = false;
      box.onclick = (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        if (t.dataset.set) {
          line[t.dataset.set] = parseInt(t.dataset.val, 10);
          box.querySelectorAll(`[data-set="${t.dataset.set}"]`).forEach(b => b.classList.toggle('on', b === t));
        }
        if (t.dataset.feet) box.querySelector('.ohm-feet').value = t.dataset.feet;
        if (t.dataset.where) box.querySelector('.ohm-where').value = t.dataset.where;
        if (t.hasAttribute('data-tag-ok')) {
          line.feet = box.querySelector('.ohm-feet').valueAsNumber || 0;
          line.location = box.querySelector('.ohm-where').value.trim();
          box.hidden = true;
          renderLines();
        }
      };
    };

    $('.ohm-lines').addEventListener('click', (e) => {
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-del]');
      if (edit) tagSheet(parseInt(edit.dataset.edit, 10));
      if (del && window.confirm(`Delete run ${parseInt(del.dataset.del, 10) + 1}?`)) {
        state.lines.splice(parseInt(del.dataset.del, 10), 1);
        renderLines();
      }
    });

    overlay.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.angle) {
        state.angle = t.dataset.angle;
        overlay.querySelectorAll('.ohm-angle').forEach(b => b.classList.toggle('on', b === t));
      }
      if (t.dataset.pattern) {
        state.pattern = parseInt(t.dataset.pattern, 10);
        overlay.querySelectorAll('.ohm-pattern').forEach(b => b.classList.toggle('on', b === t));
      }
      const act = t.dataset.act;
      if (act === 'close') {
        if (state.lines.length && !window.confirm('Leave without sending this map?')) return;
        overlay.remove();
      }
      if (act === 'undo') { state.current.pop(); draw(); }
      if (act === 'done-line' && state.current.length >= 2) {
        const prev = state.lines[state.lines.length - 1] || {};
        // A new run starts with the last run's lights and clips: usually the same all around.
        state.lines.push({ pts: state.current, product_tmpl_id: prev.product_tmpl_id || null,
                           attachment_id: prev.attachment_id || null, tag_color_id: null, feet: 0, location: '' });
        state.current = [];
        renderLines();
        tagSheet(state.lines.length - 1);
      }
      if (act === 'send') {
        t.disabled = true;
        const payload = { image: state.photo.dataUrl.replace(/^data:[^;]+;base64,/, ''), lines: state.lines,
                          pattern: state.pattern, angle: state.angle };
        try {
          await this.send(job.id, payload);
          overlay.remove();
        } catch (err) {
          App.showToast('Not sent: ' + (err.message || err), 'error');
          t.disabled = false;
        }
      }
    });
  },

  async send(jobId, p) {
    if (navigator.onLine) {
      try {
        const res = await OdooAPI.callKw('fsm.order', 'worker_save_field_map',
          [jobId, p.image, p.lines, p.pattern || false, p.angle || false, false], {});
        App.showToast(`Map saved: ${res.runs} run${res.runs === 1 ? '' : 's'} on ${res.design}`, 'success');
        await DB.setState(this._optsKey(jobId), null).catch(() => {});
        return;
      } catch (err) {
        if (navigator.onLine && !/network|fetch|timeout/i.test(String(err.message || err))) throw err;
      }
    }
    const pending = (await DB.getState(this.PENDING_KEY).catch(() => null)) || {};
    (pending[jobId] = pending[jobId] || []).push(p);
    await DB.setState(this.PENDING_KEY, pending);
    App.showToast('Map kept on this iPad: it goes to the office when there\'s signal', 'success');
  },

  async flush() {
    if (!navigator.onLine) return;
    const pending = (await DB.getState(this.PENDING_KEY).catch(() => null)) || {};
    for (const id of Object.keys(pending)) {
      while (pending[id].length) {
        const p = pending[id][0];
        try {
          await OdooAPI.callKw('fsm.order', 'worker_save_field_map',
            [parseInt(id, 10), p.image, p.lines, p.pattern || false, p.angle || false, false], {});
          pending[id].shift();
        } catch (err) {
          console.warn('Draw map: still not sent for job', id, err);
          break;
        }
      }
      if (!pending[id].length) delete pending[id];
    }
    await DB.setState(this.PENDING_KEY, pending).catch(() => {});
  },
};

window.addEventListener('online', () => HolidayMap.flush().catch(() => {}));
setTimeout(() => HolidayMap.flush().catch(() => {}), 6000);
