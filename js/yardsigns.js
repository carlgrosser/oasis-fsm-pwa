/**
 * Yard Signs inside the field app: the yard sign app (Odoo ohl_yardsign, /yardsigns) full screen in a frame,
 * already signed in (no second code: Odoo ys_field_app_token makes a phone for the person signed in here),
 * with a ← Back bar to the clock and jobs. A 🪧 Yard Signs tile under the clock card, and in the ☰ menu, for
 * people set up to place signs (ys_field_app_status). Opening it off the clock asks to clock on first.
 */
const YardSigns = {
  STATUS_KEY: 'ys_field_status',
  TOKEN_KEY: 'ys_field_token',
  STATUS_MS: 6 * 3600000,

  _uid() {
    const user = typeof Auth !== 'undefined' && Auth.getUser ? Auth.getUser() : null;
    return user ? user.uid : null;
  },

  /** {placer, approved} for the person signed in (kept on the phone, refreshed every few hours). */
  async status() {
    const saved = await DB.getState(this.STATUS_KEY).catch(() => null);
    const mine = saved && saved.uid === this._uid() ? saved : null;
    if (navigator.onLine && (!mine || Date.now() - mine.at > this.STATUS_MS)) {
      try {
        const res = await OdooAPI.callKw('ohl.yard.placer', 'ys_field_app_status', [], {});
        const fresh = { uid: this._uid(), at: Date.now(), placer: !!res.placer, approved: !!res.approved };
        await DB.setState(this.STATUS_KEY, fresh).catch(() => {});
        return fresh;
      } catch (err) {
        // Odoo without the yard sign module, or no signal: no tile (or the last answer).
      }
    }
    return mine || { placer: false, approved: false };
  },

  /** The tile under the clock card (only for people who place signs). */
  async renderTile(container) {
    if (!container) return;
    const st = await this.status();
    if (!st.approved || document.getElementById('ysTile')) return;
    const tile = document.createElement('button');
    tile.id = 'ysTile';
    tile.className = 'ys-tile';
    tile.innerHTML = '<span class="ys-tile-icon">&#129703;</span><span><b>Yard Signs</b><br><small>Place, check and pick up signs</small></span>';
    tile.addEventListener('click', () => this.open());
    const card = document.getElementById('clockCard');
    if (card && card.parentNode === container) card.after(tile);
    else container.insertBefore(tile, container.firstChild);
  },

  async _token(fresh) {
    const saved = await DB.getState(this.TOKEN_KEY).catch(() => null);
    if (!fresh && saved && saved.uid === this._uid() && saved.token) return saved.token;
    if (!navigator.onLine) return null;
    const res = await OdooAPI.callKw('ohl.yard.placer', 'ys_field_app_token', [navigator.userAgent || ''], {});
    if (!res || !res.ok) {
      throw new Error(res && res.error === 'pending' ? 'Your yard sign access is waiting for the office to approve it.'
        : 'You\'re not set up for yard signs yet: ask the office.');
    }
    await DB.setState(this.TOKEN_KEY, { uid: this._uid(), token: res.token, at: Date.now() }).catch(() => {});
    return res.token;
  },

  _askClockOn() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `<div class="modal" style="max-width:400px;">
          <div class="modal-header"><h3>You're not clocked on</h3></div>
          <div class="modal-body"><p style="margin:0;">Clock on before you start on yard signs?</p></div>
          <div class="modal-footer" style="display:flex;gap:8px;">
            <button class="btn" data-ys="skip">Not now</button>
            <button class="btn btn-primary" data-ys="clock">&#9654; Clock On</button></div></div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', async (e) => {
        const t = e.target.closest('[data-ys]');
        if (!t) return;
        overlay.remove();
        if (t.dataset.ys === 'clock') await TimeTracking.clockIn();
        resolve();
      });
    });
  },

  async open(fresh) {
    if (!fresh && typeof TimeTracking !== 'undefined' && !TimeTracking.isClockedIn()) await this._askClockOn();
    let token;
    try {
      token = await this._token(fresh);
    } catch (err) {
      App.showToast(err.message || String(err), 'error');
      return;
    }
    if (!token) {
      App.showToast('Yard Signs needs signal the first time you open it', 'error');
      return;
    }
    document.getElementById('ysFrame')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'ysFrame';
    overlay.className = 'ys-overlay';
    overlay.innerHTML = `<div class="ys-bar">
        <button class="btn btn-sm" data-ys="back">&larr; Clock &amp; jobs</button>
        <span class="ys-bar-title">&#129703; Yard Signs</span>
        <button class="btn btn-sm btn-ghost" data-ys="reconnect" title="Signed out? Sign in again">&#10227;</button>
      </div>
      <iframe class="ys-iframe" title="Yard Signs" allow="geolocation; camera"
        src="${CONFIG.ODOO_URL}/yardsigns/#sso=${encodeURIComponent(token)}"></iframe>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      const t = e.target.closest('[data-ys]');
      if (!t) return;
      if (t.dataset.ys === 'back') overlay.remove();
      if (t.dataset.ys === 'reconnect') { overlay.remove(); this.open(true); }
    });
  },
};

document.addEventListener('DOMContentLoaded', () => {
  ['yardSignsBtnList', 'yardSignsBtnDetail'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      document.querySelectorAll('.menu-dropdown').forEach(d => { d.style.display = 'none'; });
      YardSigns.open();
    });
  });
});
