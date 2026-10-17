/**
 * Google reviews: each company's review link as a big QR code the homeowner scans with their phone.
 *  - End of job (after Close Job): Show Google Review QR, or Customer not available (logged on the job);
 *  - Any time: the ⭐ footer button or ☰ → Google Review QR.
 * The codes are kept on the phone (they work with no signal); a log saved without signal is sent
 * when the signal is back. Odoo (oasis_reviews): worker_get_review_codes, worker_log_review.
 */
const Reviews = {
  KEY: 'review_codes',
  PENDING_KEY: 'review_pending',
  REFRESH_MS: 3600000,

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },

  /** [{company_id, name, url, ask, qr}] from Odoo (at most hourly), else the phone's copy. */
  async codes(force) {
    const saved = await DB.getState(this.KEY).catch(() => null);
    if (navigator.onLine && (force || !saved || Date.now() - (saved.at || 0) > this.REFRESH_MS)) {
      try {
        const list = await OdooAPI.callKw('fsm.order', 'worker_get_review_codes', [], {});
        await DB.setState(this.KEY, { at: Date.now(), list }).catch(() => {});
        return list;
      } catch (err) {
        console.warn('Review codes: fetch failed, using the saved copy', err);
      }
    }
    return (saved && saved.list) || [];
  },

  _companyId(job) {
    return Array.isArray(job.company_id) ? job.company_id[0] : job.company_id;
  },

  async log(jobId, status) {
    if (navigator.onLine) {
      try {
        await OdooAPI.callKw('fsm.order', 'worker_log_review', [jobId, status], {});
        return;
      } catch (err) {
        console.warn('Review log: not sent, kept for later', err);
      }
    }
    const pending = (await DB.getState(this.PENDING_KEY).catch(() => null)) || {};
    pending[jobId] = status;
    await DB.setState(this.PENDING_KEY, pending).catch(() => {});
  },

  async flush() {
    if (!navigator.onLine) return;
    const pending = (await DB.getState(this.PENDING_KEY).catch(() => null)) || {};
    for (const id of Object.keys(pending)) {
      try {
        await OdooAPI.callKw('fsm.order', 'worker_log_review', [parseInt(id, 10), pending[id]], {});
        delete pending[id];
      } catch (err) {
        console.warn('Review log: still not sent for job', id, err);
      }
    }
    await DB.setState(this.PENDING_KEY, pending).catch(() => {});
  },

  /** The big QR code, full screen. Resolves when the crew taps Done. */
  showQr(code) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'review-overlay';
      overlay.innerHTML = `
        <div class="review-card">
          <div class="review-company">${this._esc(code.name)}</div>
          <div class="review-stars">&#11088;&#11088;&#11088;&#11088;&#11088;</div>
          <img class="review-qr" src="${code.qr}" alt="QR code for our Google review page">
          <div class="review-ask">Point your phone's camera here to leave us a review on Google. Thank you!</div>
          <button class="btn btn-primary btn-block btn-xl" data-done>Done</button>
        </div>`;
      document.body.appendChild(overlay);
      // Bright and awake while the customer scans.
      let lock = null;
      if (navigator.wakeLock) navigator.wakeLock.request('screen').then(l => { lock = l; }).catch(() => {});
      overlay.querySelector('[data-done]').addEventListener('click', () => {
        if (lock) lock.release().catch(() => {});
        overlay.remove();
        resolve();
      });
    });
  },

  _chooser(title, bodyHtml) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" style="max-width:420px;">
        <div class="modal-header"><h3>${this._esc(title)}</h3></div>
        <div class="modal-body">${bodyHtml}</div></div>`;
    document.body.appendChild(overlay);
    return overlay;
  },

  /** After Close Job: offer the QR code, or Customer not available. Resolves when done (or nothing to ask). */
  async endOfJob(job) {
    let code = null;
    try {
      code = (await this.codes()).find(c => c.company_id === this._companyId(job) && c.ask && c.qr);
    } catch (err) { /* no codes: nothing to ask */ }
    if (!code) return;
    await new Promise((resolve) => {
      const overlay = this._chooser('⭐ Google review', `
        <p style="margin-top:0;">Happy customer? Ask them to scan the code for a quick Google review.</p>
        <button class="btn btn-primary btn-block btn-xl" data-review="show">&#11088; Show Google Review QR</button>
        <button class="btn btn-secondary btn-block" data-review="not_available" style="margin-top:10px;">Customer not available</button>`);
      overlay.addEventListener('click', async (e) => {
        const t = e.target.closest('[data-review]');
        if (!t) return;
        overlay.remove();
        if (t.dataset.review === 'show') {
          this.log(job.id, 'shown');
          await this.showQr(code);
        } else {
          this.log(job.id, 'not_available');
        }
        resolve();
      });
    });
  },

  /** Any time: the job's company, else the only one, else pick. */
  async open(job) {
    const list = (await this.codes()).filter(c => c.qr);
    if (!list.length) {
      App.showToast(navigator.onLine ? 'No Google review link set up in Odoo yet (Settings → Companies → Google Reviews)'
        : 'Open it once with signal so the codes are saved on this phone', 'error');
      return;
    }
    const mine = job && list.find(c => c.company_id === this._companyId(job));
    if (mine || list.length === 1) {
      const code = mine || list[0];
      if (job && mine) this.log(job.id, 'shown');
      await this.showQr(code);
      return;
    }
    const overlay = this._chooser('⭐ Google review: which company?', list.map(c =>
      `<button class="btn btn-block btn-lg" data-company="${c.company_id}" style="margin-bottom:10px;">${this._esc(c.name)}</button>`).join('')
      + '<button class="btn btn-secondary btn-block" data-cancel>Cancel</button>');
    overlay.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      overlay.remove();
      const code = list.find(c => String(c.company_id) === t.dataset.company);
      if (code) this.showQr(code);
    });
  },
};

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('footerReviewBtn')?.addEventListener('click', () => Reviews.open(null));
  document.getElementById('reviewBtnList')?.addEventListener('click', () => Reviews.open(null));
  document.getElementById('reviewBtnDetail')?.addEventListener('click', () =>
    Reviews.open(typeof Jobs !== 'undefined' ? Jobs._currentJob : null));
});
window.addEventListener('online', () => Reviews.flush().catch(() => {}));
setTimeout(() => { Reviews.flush().catch(() => {}); Reviews.codes().catch(() => {}); }, 7000);
