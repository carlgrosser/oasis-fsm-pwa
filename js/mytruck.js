/**
 * My truck (Odoo ohl_dispatch: worker_my_truck, worker_truck_action, worker_truck_items).
 *
 * What's on my truck and what's short of what it should carry. Something used up or missing:
 *   say how many are left, then  Take from the garage · I bought it (receipt → expense + on the truck) · Ask the office.
 * Kept on the phone for no signal; actions wait in a queue (each with its own id, never done twice).
 */
const MyTruck = {
  KEY: 'omt_data',
  TRUCK_KEY: 'oha_truck',  // shared with Actual Used: the same truck
  PENDING_KEY: 'omt_pending',

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },
  _uid() { return 'mt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },

  async load(truckId) {
    if (navigator.onLine) {
      try {
        const data = await OdooAPI.callKw('fsm.order', 'worker_my_truck', [truckId || false], {});
        await DB.setState(this.KEY, data).catch(() => {});
        if (data.truck_id) await DB.setState(this.TRUCK_KEY, data.truck_id).catch(() => {});
        return data;
      } catch (err) {
        if (!OdooAPI.isOffline(err)) throw err;
      }
    }
    const saved = await DB.getState(this.KEY).catch(() => null);
    return saved ? Object.assign({}, saved, { offline: true }) : null;
  },

  async _pending() { return (await DB.getState(this.PENDING_KEY).catch(() => null)) || []; },

  async flush() {
    if (!navigator.onLine) return;
    const pending = await this._pending();
    if (!pending.length) return;
    const left = [];
    for (const p of pending) {
      try {
        await OdooAPI.callKw('fsm.order', 'worker_truck_action', [p.truck_id, p.action, p.product_id || false, p.qty || 0,
          p.left === undefined ? null : p.left, p.receipt || null, p.uid], {});
      } catch (err) {
        if (OdooAPI.isOffline(err)) left.push(p);
        else App.showToast('My truck: not done: ' + (err.message || err), 'error');
      }
    }
    await DB.setState(this.PENDING_KEY, left).catch(() => {});
    if (left.length < pending.length) App.showToast('My truck: sent to the office', 'success');
  },

  async act(entry) {
    entry.uid = entry.uid || this._uid();
    if (navigator.onLine) {
      try {
        return await OdooAPI.callKw('fsm.order', 'worker_truck_action', [entry.truck_id, entry.action, entry.product_id || false,
          entry.qty || 0, entry.left === undefined ? null : entry.left, entry.receipt || null, entry.uid], {});
      } catch (err) {
        if (!OdooAPI.isOffline(err)) throw err;
      }
    }
    const pending = await this._pending();
    pending.push(entry);
    await DB.setState(this.PENDING_KEY, pending);
    return { queued: true, message: 'Saved on this phone: it goes when there\'s signal' };
  },

  /** A photo as base64 JPEG, at most 1600 px. */
  _photo(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', 0.8).split(',')[1]);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  },

  async open() {
    const overlay = document.createElement('div');
    overlay.className = 'ohu-overlay';
    overlay.innerHTML = `<div class="ohu-head"><button class="btn btn-sm" data-x>&larr; Back</button>
        <div style="flex:1;min-width:0;"><div class="ohu-title">&#128666; My truck</div><div class="ohu-sub">Loading&hellip;</div></div></div>
      <div class="ohu-body"></div><div class="ohu-add" hidden></div>`;
    document.body.appendChild(overlay);
    const $ = (s) => overlay.querySelector(s);
    let data = null;
    const savedTruck = await DB.getState(this.TRUCK_KEY).catch(() => null);
    const draw = () => {
      if (!data) {
        $('.ohu-sub').textContent = '';
        $('.ohu-body').innerHTML = '<div class="empty-state" style="padding:24px;">Not on this phone yet: open it once with signal.</div>';
        return;
      }
      const rows = (data.rows || []).slice().sort((a, b) => (b.short > 0) - (a.short > 0) || (b.on_list - a.on_list));
      $('.ohu-sub').innerHTML = data.offline ? 'No signal: what the phone saved last' : data.has_list
        ? (data.short ? `<b style="color:#c62828;">${data.short} short</b> of what it should carry` : '&#10003; Everything it should carry')
        : 'What the app thinks is on it';
      $('.ohu-body').innerHTML = `
        <div class="oha-trucks">${(data.trucks || []).map(t => `<button class="ohu-chip${t.id === data.truck_id ? ' on' : ''}" data-truck="${t.id}">${this._esc(t.name)}</button>`).join('')
          || '<span class="ohu-plan">No trucks set up yet: ask the office.</span>'}</div>
        ${data.truck_id ? '' : '<div class="empty-state" style="padding:16px;">Which truck are you on? Tap it.</div>'}
        ${rows.map((r, i) => `<button class="omt-row${r.short > 0 ? ' short' : r.on_list ? ' ok' : ''}" data-row="${data.rows.indexOf(r)}">
            <span class="omt-name">${this._esc(r.name)}</span>
            <span class="omt-qty">${this._esc(r.has_text || r.has)}${r.should_text ? `<span class="omt-should">should carry ${this._esc(r.should_text)}</span>` : ''}
              ${r.short > 0 ? `<span class="omt-short">short ${this._esc(r.short_text)}</span>` : ''}
              ${r.waiting_text ? `<span class="omt-should">${this._esc(r.waiting_text)}</span>` : ''}</span></button>`).join('')}
        ${data.truck_id ? '<button class="btn oha-add-btn" data-other>&#10133; Something not on the list</button>' : ''}
        <div class="ohu-plan" style="margin-top:10px;">Tap anything used up or missing.</div>`;
    };
    try { data = await this.load(savedTruck); } catch (err) { App.showToast('My truck: ' + (err.message || err), 'error'); }
    draw();

    const sheet = (item) => {
      const box = $('.ohu-add');
      const packs = (item.packs || []).filter(p => p.qty > 1).sort((a, b) => a.qty - b.qty);
      const pack = packs[0] || null;
      // Both boxes count in the same pack (bags, spools), with the units in small text (round 3 F-22).
      const per = pack ? pack.qty : 1;
      const hasPacks = Math.max(0, (item.has || 0) / per);
      const round2 = (n) => Math.round(n * 100) / 100;
      let left = round2(hasPacks);
      let qty = item.short > 0 ? (pack ? Math.ceil(item.short / pack.qty) : Math.ceil(item.short)) : 1;
      let mode = null;
      const unitWord = pack ? pack.name : (item.unit || 'each');
      const render = () => {
        const units = pack ? qty * pack.qty : qty;
        box.innerHTML = `<div class="ohu-add-card"><div class="ohu-add-title">${this._esc(item.name)}</div>
          <div class="oha-item"><div class="oha-item-label">How many are left on the truck (${this._esc(unitWord)})?<div class="ohu-plan"><span data-left-units>${pack ? `= ${round2(left * per)} ${this._esc(item.unit || '')} · ` : ''}</span>the app thought ${this._esc(item.has_text || item.has)}</div></div>
            <button class="ohu-btn" data-l="-1">&minus;</button><input class="ohu-qty" type="number" inputmode="decimal" min="0" step="any" value="${left}" data-left>
            <button class="ohu-btn" data-l="1">+</button></div>
          <div class="oha-item"><div class="oha-item-label">How many to get (${this._esc(unitWord)})${pack ? `<div class="ohu-plan" data-qty-units>= ${units} ${this._esc(item.unit || '')}</div>` : ''}</div>
            <button class="ohu-btn" data-q="-1">&minus;</button><input class="ohu-qty" type="number" inputmode="decimal" min="0" value="${qty}" data-qty>
            <button class="ohu-btn" data-q="1">+</button></div>
          ${mode === 'bought' ? `<div class="omt-receipt">
              <label class="btn" style="display:block;text-align:center;">&#128247; Receipt photo<input type="file" accept="image/*" capture="environment" data-photo hidden></label>
              <div class="ohu-plan" data-photo-ok>${this._photoData ? '&#10003; Photo taken' : 'Take a photo of the receipt'}</div>
              <input class="ohu-other" type="text" placeholder="Store" data-store>
              <input class="ohu-other" type="number" inputmode="decimal" placeholder="Receipt total $" data-total>
              <input class="ohu-other" type="date" value="${typeof localDate === 'function' ? localDate() : new Date().toISOString().slice(0, 10)}" data-date>
              <div class="oha-chips"><button class="ohu-chip on" data-paid="own">My money (pay me back)</button><button class="ohu-chip" data-paid="company">Company card</button></div>
              <button class="btn btn-primary btn-lg" style="width:100%;" data-send="bought">Send receipt</button></div>` : `
          <div class="omt-actions">
            <button class="btn btn-primary btn-lg" data-send="garage">&#127968; Take from the garage${item.garage ? ` <small>(${item.garage} there)</small>` : ''}</button>
            <button class="btn btn-lg" data-mode="bought">&#129534; I bought it</button>
            <button class="btn btn-lg" data-send="office">&#128222; Ask the office</button>
            <button class="btn btn-ghost" data-send="used_up">Just mark what's left</button>
          </div>`}
          <div style="margin-top:10px;"><button class="btn" data-cancel>Cancel</button></div></div>`;
      };
      this._photoData = null;
      let paid = 'own';
      render();
      box.hidden = false;
      box.onclick = async (e) => {
        const t = e.target.closest('button');
        const read = () => {
          const l = box.querySelector('[data-left]'); if (l) left = Math.max(0, l.valueAsNumber || 0);
          const q = box.querySelector('[data-qty]'); if (q) qty = Math.max(0, q.valueAsNumber || 0);
        };
        if (!t) return;
        read();
        if (t.hasAttribute('data-cancel')) { box.hidden = true; box.onclick = null; return; }
        if (t.dataset.l) { left = Math.max(0, left + parseInt(t.dataset.l, 10)); return render(); }
        if (t.dataset.q) { qty = Math.max(0, qty + parseInt(t.dataset.q, 10)); return render(); }
        if (t.dataset.mode) { mode = t.dataset.mode; return render(); }
        if (t.dataset.paid) { paid = t.dataset.paid; box.querySelectorAll('[data-paid]').forEach(b => b.classList.toggle('on', b === t)); return; }
        if (t.dataset.send) {
          const action = t.dataset.send;
          const leftUnits = round2(left * per);
          const entry = { truck_id: data.truck_id, action, product_id: item.product_id, qty: pack ? qty * pack.qty : qty,
            left: left !== round2(hasPacks) ? leftUnits : undefined };
          if (action === 'used_up') entry.left = leftUnits;
          if (action === 'bought') {
            const total = parseFloat(box.querySelector('[data-total]').value || '0');
            if (!this._photoData) { App.showToast('Take the receipt photo first', 'error'); return; }
            if (!(total > 0)) { App.showToast('Enter the receipt total', 'error'); return; }
            entry.receipt = { image: this._photoData, total, store: box.querySelector('[data-store]').value.trim(),
              date: box.querySelector('[data-date]').value, paid_with: paid };
          }
          t.disabled = true;
          try {
            const res = await this.act(entry);
            App.showToast(res.message || 'Done', 'success');
            box.hidden = true; box.onclick = null;
            if (res.truck) { data = res.truck; await DB.setState(this.KEY, data).catch(() => {}); }
            draw();
          } catch (err) {
            App.showToast('Not done: ' + (err.message || err), 'error');
            t.disabled = false;
          }
        }
      };
      // A typed number counts at once (round 5 F-01): the "= N units" lines follow as you type.
      box.oninput = (e) => {
        if (e.target.matches('[data-left]')) {
          left = Math.max(0, e.target.valueAsNumber || 0);
          const u = box.querySelector('[data-left-units]');
          if (u && pack) u.textContent = `= ${round2(left * per)} ${item.unit || ''} · `;
        }
        if (e.target.matches('[data-qty]')) {
          qty = Math.max(0, e.target.valueAsNumber || 0);
          const u = box.querySelector('[data-qty-units]');
          if (u && pack) u.textContent = `= ${qty * pack.qty} ${item.unit || ''}`;
        }
      };
      box.onchange = async (e) => {
        if (e.target.matches('[data-photo]') && e.target.files[0]) {
          this._photoData = await this._photo(e.target.files[0]).catch(() => null);
          const ok = box.querySelector('[data-photo-ok]');
          if (ok) ok.innerHTML = this._photoData ? '&#10003; Photo taken' : 'That photo didn\'t work: try again';
        }
      };
    };

    const pickOther = async () => {
      const box = $('.ohu-add');
      box.hidden = false;
      box.innerHTML = `<div class="ohu-add-card"><div class="ohu-add-title">Which item?</div>
          <input class="ohu-other" type="search" placeholder="e.g. c9 warm, clips" data-q>
          <div data-results class="oha-chips"></div><div style="margin-top:10px;"><button class="btn" data-cancel>Cancel</button></div></div>`;
      const input = box.querySelector('[data-q]');
      let timer = null;
      const search = async () => {
        const res = box.querySelector('[data-results]');
        if (!navigator.onLine) { res.innerHTML = '<span class="ohu-plan">Needs signal</span>'; return; }
        const typed = input.value.trim();
        const items = await OdooAPI.callKw('fsm.order', 'worker_truck_items', [typed], {}).catch(() => []);
        // Not in the catalogue (zip ties, a cord): add it as a new item; the office checks new items.
        const exact = items.some(p => p.name.toLowerCase() === typed.toLowerCase());
        res.innerHTML = (items.map(p => `<button class="ohu-chip" data-p="${p.id}">${this._esc(p.name)}</button>`).join('') || '<span class="ohu-plan">Nothing found</span>')
          + (typed.length >= 2 && !exact ? `<button class="ohu-chip" data-new>&#65291; Add "${this._esc(typed)}" as a new item</button>` : '');
        res.onclick = async (e) => {
          if (e.target.closest('[data-new]')) {
            try {
              const p = await OdooAPI.callKw('fsm.order', 'worker_truck_new_item', [typed], {});
              App.showToast(`${p.name} added: the office checks new items`, 'success');
              sheet({ product_id: p.id, name: p.name, unit: p.unit, packs: p.packs, has: 0, short: 0 });
            } catch (err) { App.showToast('Not added: ' + (err.message || err), 'error'); }
            return;
          }
          const b = e.target.closest('[data-p]');
          if (!b) return;
          const p = items.find(x => String(x.id) === b.dataset.p);
          sheet({ product_id: p.id, name: p.name, unit: p.unit, packs: p.packs, has: 0, short: 0 });
        };
      };
      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 300); });
      box.onclick = (e) => { if (e.target.closest('[data-cancel]')) { box.hidden = true; box.onclick = null; } };
      input.focus();
      search();
    };

    overlay.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t || t.closest('.ohu-add')) return;
      if (t.hasAttribute('data-x')) { overlay.remove(); return; }
      if (t.dataset.truck) {
        try { data = await this.load(parseInt(t.dataset.truck, 10)); draw(); } catch (err) { App.showToast(err.message || String(err), 'error'); }
        return;
      }
      if (t.dataset.row) return sheet(data.rows[parseInt(t.dataset.row, 10)]);
      if (t.hasAttribute('data-other')) return pickOther();
    });
  },
};

document.addEventListener('DOMContentLoaded', () => {
  ['myTruckBtnList', 'myTruckBtnDetail'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      document.querySelectorAll('.menu-dropdown').forEach(d => { d.style.display = 'none'; });
      MyTruck.open();
    });
  });
});
window.addEventListener('online', () => MyTruck.flush().catch(() => {}));
setTimeout(() => MyTruck.flush().catch(() => {}), 7000);
