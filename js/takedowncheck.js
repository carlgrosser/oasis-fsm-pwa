/**
 * Holiday Lighting: the takedown's closing check (Carl 2026-11-09). One screen, one tap when everything is fine.
 *  - Strands: this season's strands per item (the install's count, never the quote): "✓ All came down", or how many
 *    need replacing (those go to the Repair bin and leave the kit).
 *  - Before next season: broken bulbs (colour), cut wire, bad clips, a note, a photo: kept on the house's kit and
 *    shown at prep and on next year's install.
 * Odoo: worker_get_takedown_check / worker_save_takedown_check (done once, safe to send twice). Offline: queued.
 */
const TakedownCheck = {
  PENDING_KEY: 'otc_pending',
  _key(jobId) { return 'otc_' + jobId; },
  _esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; },

  async _pending() { return (await DB.getState(this.PENDING_KEY).catch(() => null)) || {}; },

  async flush() {
    if (!navigator.onLine) return;
    const pending = await this._pending();
    for (const id of Object.keys(pending)) {
      try {
        await OdooAPI.callKw('fsm.order', 'worker_save_takedown_check', [parseInt(id, 10), pending[id]], {});
        delete pending[id];
      } catch (err) { console.warn('Takedown check not sent yet', err); }
    }
    await DB.setState(this.PENDING_KEY, pending).catch(() => {});
  },

  async _save(job, payload) {
    if (navigator.onLine) {
      try { return await OdooAPI.callKw('fsm.order', 'worker_save_takedown_check', [job.id, payload], {}); } catch (err) {
        if (navigator.onLine && !OdooAPI.isOffline(err)) throw err;
      }
    }
    const pending = await this._pending();
    pending[job.id] = payload;
    await DB.setState(this.PENDING_KEY, pending);
    return { queued: true };
  },

  _photo(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  },

  async open(job, onClose) {
    let data = null;
    if (navigator.onLine) {
      data = await OdooAPI.callKw('fsm.order', 'worker_get_takedown_check', [job.id], {}).catch(() => null);
      if (data) await DB.setState(this._key(job.id), data).catch(() => {});
    }
    data = data || (await DB.getState(this._key(job.id)).catch(() => null)) || { strands: [], bulbs: [], prep: [] };
    const st = { bad: {}, picks: [], note: '', photo: null };
    const overlay = document.createElement('div');
    overlay.className = 'ohu-overlay';
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); if (onClose) onClose(); };
    const PICKS = { bulbs: 'Broken bulbs', wire: 'Cut wire', clips: 'Bad clips' };
    const draw = () => {
      overlay.innerHTML = `<div class="ohu-head"><button class="btn btn-sm" data-x>&larr; Back</button>
          <div style="flex:1;min-width:0;"><div class="ohu-title">Takedown check</div><div class="ohu-sub">Strands, and anything to fix before next season</div></div></div>
        <div class="ohu-body">
          <button class="btn btn-success btn-lg" style="width:100%;" data-allgood>&#10003; All came down, nothing to fix</button>
          ${data.done ? '<div class="ohu-plan" style="margin-top:6px;">Already checked.</div>' : ''}
          ${data.strands.length ? `<div class="ohu-group">Strands this season</div>
            ${data.strands.map(s => `<div class="oha-item"><div class="oha-item-label">${this._esc(s.label)}<div class="ohu-plan">${s.qty} went up · how many need replacing?</div></div>
              <input class="ohu-qty" type="number" inputmode="numeric" min="0" placeholder="0" value="${st.bad[s.product_id] || ''}" data-bad="${s.product_id}"></div>`).join('')}` : ''}
          <div class="ohu-group">Before next season <span class="ohu-plan">(optional)</span></div>
          <div class="oha-chips">${Object.entries(PICKS).map(([k, l]) => `<button class="ohu-chip" data-pick="${k}">&#65291; ${l}</button>`).join('')}</div>
          ${st.picks.map((p, i) => `<div class="oha-item"><div class="oha-item-label">${PICKS[p.kind]}
              ${p.kind === 'bulbs' && data.bulbs.length ? `<select class="ohu-other" data-pcolor="${i}">${data.bulbs.map(b => `<option value="${b.id}" ${b.id === p.product_id ? 'selected' : ''}>${this._esc(b.name)}</option>`).join('')}</select>` : ''}</div>
              <input class="ohu-qty" type="number" inputmode="numeric" min="0" placeholder="?" value="${p.qty || ''}" data-pqty="${i}">
              <button class="btn btn-sm btn-ghost" data-pdel="${i}" aria-label="Remove">&#10005;</button></div>`).join('')}
          <textarea class="ohu-other" rows="2" placeholder="Note for next season, e.g. gutter clip loose on the garage" data-note>${this._esc(st.note)}</textarea>
          <label class="btn" style="display:block;text-align:center;">&#128247; ${st.photo ? 'Photo taken (retake)' : 'Photo'}<input type="file" accept="image/*" capture="environment" data-photo hidden></label>
          ${data.prep.length ? `<div class="ohu-plan" style="margin-top:8px;">Already on the list: ${data.prep.map(p => this._esc(p.text)).join(' · ')}</div>` : ''}
          <button class="btn btn-primary btn-lg" style="width:100%;margin-top:12px;" data-save>Save the check</button>
        </div>`;
    };
    const read = () => {
      overlay.querySelectorAll('[data-bad]').forEach(i => { st.bad[i.dataset.bad] = Math.max(0, i.valueAsNumber || 0); });
      overlay.querySelectorAll('[data-pqty]').forEach(i => { st.picks[+i.dataset.pqty].qty = Math.max(0, i.valueAsNumber || 0); });
      overlay.querySelectorAll('[data-pcolor]').forEach(i => { st.picks[+i.dataset.pcolor].product_id = parseInt(i.value, 10); });
      const n = overlay.querySelector('[data-note]'); if (n) st.note = n.value;
    };
    const send = async (payload, btn) => {
      if (btn) btn.disabled = true;
      try {
        const res = await this._save(job, payload);
        App.showToast(res.queued ? 'Saved on this phone: it goes when there\'s signal' : 'Takedown check saved', 'success');
        close();
      } catch (err) {
        App.showToast('Not saved: ' + (err.message || err), 'error');
        if (btn) btn.disabled = false;
      }
    };
    overlay.addEventListener('change', async (e) => {
      if (e.target.matches('[data-photo]') && e.target.files[0]) {
        read();
        st.photo = await this._photo(e.target.files[0]).catch(() => null);
        draw();
      }
    });
    overlay.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      read();
      if (t.hasAttribute('data-x')) return close();
      if (t.hasAttribute('data-allgood')) return send({}, t);
      if (t.dataset.pick) {
        st.picks.push({ kind: t.dataset.pick, qty: null, product_id: t.dataset.pick === 'bulbs' && data.bulbs[0] ? data.bulbs[0].id : false });
        return draw();
      }
      if (t.dataset.pdel) { st.picks.splice(+t.dataset.pdel, 1); return draw(); }
      if (t.hasAttribute('data-save')) {
        send({
          strands: Object.entries(st.bad).filter(([, n]) => n > 0).map(([pid, n]) => ({ product_id: parseInt(pid, 10), bad: n })),
          picks: st.picks.filter(p => p.qty || p.kind), note: st.note.trim(), photo: st.photo || false,
        }, t);
      }
    });
    draw();
  },
};

window.addEventListener('online', () => TakedownCheck.flush().catch(() => {}));
setTimeout(() => TakedownCheck.flush().catch(() => {}), 9500);
