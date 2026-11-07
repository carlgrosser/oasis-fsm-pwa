/**
 * Notifications on the worker's phone, and the clock-off reminder they bring.
 *  - The Today list shows a card to turn notifications on (an iPhone needs the app added to the home screen
 *    first). Once allowed, the phone is subscribed (oasis_timeclock oasis.worker.push) on every start.
 *  - Odoo pushes "Still clocked on?" 30 minutes after they should have been back at the shop. Tapping it opens
 *    app.html#clockoff/<shift>/<time back at the shop>, and this offers Clock off at that time, now, or another.
 */
const WorkerPush = {
  _DISMISS_KEY: 'workerPushCardDismissed',

  supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  },

  /** An iPhone outside the home-screen app: Safari gives no notifications there. */
  _iosBrowser() {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    return ios && !standalone;
  },

  /** On every start: re-subscribe when allowed (the phone may have a new address); open a reminder. */
  async init(timeTrackingReady) {
    if (this.supported() && Notification.permission === 'granted') this.subscribe().catch(() => {});
    navigator.serviceWorker?.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-url' && e.data.url) this._openHash(new URL(e.data.url).hash);
    });
    window.addEventListener('hashchange', () => this._openHash(location.hash));
    if (location.hash.startsWith('#clockoff/')) {
      try { await timeTrackingReady; } catch (e) { /* cached state */ }
      this._openHash(location.hash);
    }
  },

  async subscribe() {
    const reg = await navigator.serviceWorker.ready;
    const key = await OdooAPI.callKw('oasis.worker.push', 'worker_push_key', [], {});
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: this._keyBytes(key) });
    }
    const device = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Phone';
    await OdooAPI.callKw('oasis.worker.push', 'worker_push_subscribe', [sub.toJSON(), device], {});
    return true;
  },

  async enable() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      App.showToast('Notifications are off for this app (phone settings)', 'error');
      return false;
    }
    try {
      await this.subscribe();
      App.showToast('Notifications are on', 'success');
      return true;
    } catch (err) {
      App.showToast('Could not turn notifications on: ' + (err.message || err), 'error');
      return false;
    }
  },

  _keyBytes(base64) {
    const padded = (base64 + '='.repeat((4 - base64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  },

  /** The Today list's card: turn notifications on (until done or dismissed). */
  renderCard(container) {
    if (!container || !this.supported() && !this._iosBrowser()) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem(this._DISMISS_KEY) === '1'; } catch (e) { /* private mode */ }
    const permission = this.supported() ? Notification.permission : 'default';
    if (dismissed || permission === 'granted') return;
    const card = document.createElement('div');
    card.className = 'push-card';
    const x = '<button type="button" class="push-card-x" aria-label="Dismiss">&times;</button>';
    if (this._iosBrowser()) {
      card.innerHTML = `<div><b>&#128276; Clock-off reminders</b><br>To get them on iPhone: tap Share, then Add to Home
        Screen, and open the app from there.</div>${x}`;
    } else if (permission === 'denied') {
      card.innerHTML = `<div><b>&#128276; Clock-off reminders are blocked</b><br>Allow notifications for this app in the
        phone's settings (Chrome: the lock by the address, Notifications) to get them.</div>${x}`;
    } else {
      card.innerHTML = `<div><b>&#128276; Get a reminder if you forget to clock off</b><br>A notification on this phone
        when you're still clocked on after your last job.</div><button type="button" class="btn btn-primary push-card-on">Turn on</button>${x}`;
    }
    card.querySelector('.push-card-on')?.addEventListener('click', async () => {
      if (await this.enable()) card.remove();
    });
    card.querySelector('.push-card-x').addEventListener('click', () => {
      try { localStorage.setItem(this._DISMISS_KEY, '1'); } catch (e) { /* private mode */ }
      card.remove();
    });
    container.insertBefore(card, container.firstChild);
  },

  /** #clockoff/<shift id>/<time back at the shop, ms>: offer to clock off then. */
  _openHash(hash) {
    const m = /^#clockoff\/(\d+)\/(\d+)/.exec(hash || '');
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    this.showClockOffAt(new Date(Number(m[2])));
  },

  showClockOffAt(at) {
    if (typeof TimeTracking === 'undefined' || !TimeTracking.isClockedIn()) {
      App.showToast("You're already clocked off", 'info');
      return;
    }
    const clockedOn = TimeTracking._clockInTime;
    if (!(at instanceof Date) || isNaN(at) || (clockedOn && at <= clockedOn) || at > new Date()) {
      TimeTracking.showClockOffDialog();
      return;
    }
    const label = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header"><h3>Still clocked on</h3><button class="modal-close">&times;</button></div>
        <div class="modal-body">
          <p>Back at the shop around <b>${label}</b> (your last job, then the drive back)?</p>
          <div style="display:flex; flex-direction:column; gap:var(--spacing-sm);">
            <button class="btn btn-danger btn-block btn-lg" data-off="at">Clock off at ${label}</button>
            <button class="btn btn-block" data-off="now">Clock off now</button>
            <button class="btn btn-block" data-off="other">Another time&hellip;</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', async (e) => {
      if (e.target === overlay) return close();
      const pick = e.target.closest('[data-off]');
      if (!pick) return;
      overlay.querySelectorAll('button').forEach(b => { b.disabled = true; });
      if (pick.dataset.off === 'at') {
        await TimeTracking.clockOut({ atTime: at.toISOString(), skipEtaQuestion: true });
      } else if (pick.dataset.off === 'now') {
        await TimeTracking.clockOut();
      } else {
        close();
        TimeTracking.showClockOffDialog();
        return;
      }
      close();
    });
  },
};
