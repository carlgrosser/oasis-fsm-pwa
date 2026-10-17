/**
 * Job rating and Google reviews (Odoo: oasis_reviews).
 *  - After Close Job the crew rates the job 1–5 stars (how they think the customer would rate it):
 *    5: the Google review QR code, closed with Review done or Customer not available;
 *    4: the crew chooses to ask (QR) or not;
 *    1–3: What happened? (no review), and the office gets a to-do.
 *  - Any time: the ⭐ footer button or ☰ → Google Review QR.
 * The codes are kept on the phone (they work with no signal); a rating saved without signal is sent
 * when the signal is back. Odoo: worker_get_review_codes, worker_rate_job, worker_log_review.
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

  /** Send to Odoo, or keep it for when there's signal. entry: {rate: [rating, note, status]} or {status}. */
  async _send(jobId, entry) {
    if (entry.rate) return OdooAPI.callKw('fsm.order', 'worker_rate_job', [jobId, ...entry.rate], {});
    return OdooAPI.callKw('fsm.order', 'worker_log_review', [jobId, entry.status], {});
  },

  async _save(jobId, entry) {
    if (navigator.onLine) {
      try {
        await this._send(jobId, entry);
        return;
      } catch (err) {
        console.warn('Review: not sent, kept for later', err);
      }
    }
    const pending = (await DB.getState(this.PENDING_KEY).catch(() => null)) || {};
    // A rating wins over a QR shown from the menu.
    if (!(pending[jobId] && pending[jobId].rate && !entry.rate)) pending[jobId] = entry;
    await DB.setState(this.PENDING_KEY, pending).catch(() => {});
  },

  log(jobId, status) { return this._save(jobId, { status }); },

  async flush() {
    if (!navigator.onLine) return;
    const pending = (await DB.getState(this.PENDING_KEY).catch(() => null)) || {};
    for (const id of Object.keys(pending)) {
      try {
        await this._send(parseInt(id, 10), pending[id]);
        delete pending[id];
      } catch (err) {
        console.warn('Review: still not sent for job', id, err);
      }
    }
    await DB.setState(this.PENDING_KEY, pending).catch(() => {});
  },

  /** The big QR code, full screen. endOfJob: close with Review done / Customer not available.
   *  Resolves with 'done' | 'not_available' (or 'closed' from the menu). */
  showQr(code, endOfJob) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'review-overlay';
      overlay.innerHTML = `
        <div class="review-card">
          <div class="review-company">${this._esc(code.name)}</div>
          <div class="review-stars">${this._starsHtml(5, 26, false)}</div>
          <img class="review-qr" src="${code.qr}" alt="QR code for our Google review page">
          <div class="review-ask">Point your phone's camera here to leave us a review on Google. Thank you!</div>
          ${endOfJob
            ? `<button class="btn btn-primary btn-block btn-xl" data-end="done">&#10003; Review done</button>
               <button class="btn btn-secondary btn-block" data-end="not_available" style="margin-top:10px;">Customer not available</button>`
            : '<button class="btn btn-primary btn-block btn-xl" data-end="closed">Done</button>'}
        </div>`;
      document.body.appendChild(overlay);
      // Bright and awake while the customer scans.
      let lock = null;
      if (navigator.wakeLock) navigator.wakeLock.request('screen').then(l => { lock = l; }).catch(() => {});
      overlay.addEventListener('click', (e) => {
        const t = e.target.closest('[data-end]');
        if (!t) return;
        if (lock) lock.release().catch(() => {});
        overlay.remove();
        resolve(t.dataset.end);
      });
    });
  },

  STAR_PATH: 'M12 2.5l2.9 6.2 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z',

  /** n stars as images; tappable ones carry data-star. */
  _starsHtml(filled, size, tappable) {
    return [1, 2, 3, 4, 5].map(i => `<${tappable ? 'button type="button"' : 'span'} class="review-star${i <= filled ? ' on' : ''}"
        ${tappable ? `data-star="${i}" aria-label="${i} star${i > 1 ? 's' : ''}"` : 'aria-hidden="true"'}>
        <svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="${this.STAR_PATH}"/></svg></${tappable ? 'button' : 'span'}>`).join('');
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

  /** After Close Job: rate the job, then the review (4–5) or what happened (1–3). Resolves when done. */
  async endOfJob(job) {
    let code = null;
    try {
      code = (await this.codes()).find(c => c.company_id === this._companyId(job));
    } catch (err) { /* nothing saved yet: no rating step */ }
    if (!code || !code.ask) return;
    const rating = await this._pickStars();
    if (!rating) return;
    let note = '';
    let status = false;
    if (rating <= 3) {
      note = await this._whatHappened(rating);
    } else if (rating === 4) {
      const ask = await this._askFour();
      note = ask.note;
      status = ask.ask && code.qr ? await this.showQr(code, true) : 'not_asked';
    } else if (code.qr) {
      status = await this.showQr(code, true);
    }
    await this._save(job.id, { rate: [rating, note || false, status] });
    if (rating === 5 && status) App.showToast('5 stars: nice work!', 'success');
    else if (rating <= 3) App.showToast('Thanks for telling us. The office will follow up.', 'info');
  },

  _sheet(html) {
    const overlay = document.createElement('div');
    overlay.className = 'review-overlay review-rate';
    overlay.innerHTML = `<div class="review-card">${html}</div>`;
    document.body.appendChild(overlay);
    return overlay;
  },

  /** 1–5 stars: how the crew thinks the customer would rate the job. */
  _pickStars() {
    return new Promise((resolve) => {
      let picked = 0;
      const overlay = this._sheet(`
        <div class="review-company">How would the customer rate this job?</div>
        <div class="review-hint">Your honest guess: the service and the work.</div>
        <div class="review-pick">${this._starsHtml(0, 48, true)}</div>
        <div class="review-label">&nbsp;</div>
        <button class="btn btn-primary btn-block btn-xl" data-next disabled>Next</button>
        <div class="review-safe">Honest ratings help us find problems and fix them. Nobody gets in trouble for a
          low rating.</div>`);
      const labels = ['', 'Very unhappy', 'Unhappy', 'It was OK', 'Happy', 'Very happy'];
      overlay.addEventListener('click', (e) => {
        const star = e.target.closest('[data-star]');
        if (star) {
          picked = parseInt(star.dataset.star, 10);
          overlay.querySelectorAll('[data-star]').forEach(b => b.classList.toggle('on', parseInt(b.dataset.star, 10) <= picked));
          overlay.querySelector('.review-label').textContent = labels[picked];
          overlay.querySelector('[data-next]').disabled = false;
        }
        if (e.target.closest('[data-next]') && picked) {
          overlay.remove();
          resolve(picked);
        }
      });
    });
  },

  _whatHappened(rating) {
    return new Promise((resolve) => {
      const overlay = this._sheet(`
        <div class="review-stars">${this._starsHtml(rating, 30, false)}</div>
        <div class="review-company">What happened?</div>
        <div class="review-hint">Tell us straight. You won't get in trouble: it helps the office make it right with
          the customer and fix whatever caused it.</div>
        <textarea class="review-note" rows="5" placeholder="e.g. Customer wanted the lights on the tree too; we ran out of C9s; arrived late"></textarea>
        <button class="btn btn-primary btn-block btn-xl" data-send disabled>Send to the office</button>`);
      const text = overlay.querySelector('.review-note');
      const send = overlay.querySelector('[data-send]');
      text.addEventListener('input', () => { send.disabled = text.value.trim().length < 3; });
      send.addEventListener('click', () => { overlay.remove(); resolve(text.value.trim()); });
      setTimeout(() => text.focus(), 50);
    });
  },

  _askFour() {
    return new Promise((resolve) => {
      const overlay = this._sheet(`
        <div class="review-stars">${this._starsHtml(4, 30, false)}</div>
        <div class="review-company">Ask this customer for a Google review?</div>
        <div class="review-hint">Your call. If something wasn't quite right, say what below.</div>
        <textarea class="review-note" rows="3" placeholder="Anything the office should know? (optional)"></textarea>
        <button class="btn btn-primary btn-block btn-xl" data-four="yes">&#11088; Yes, show the review code</button>
        <button class="btn btn-secondary btn-block" data-four="no" style="margin-top:10px;">Not this time</button>`);
      overlay.addEventListener('click', (e) => {
        const t = e.target.closest('[data-four]');
        if (!t) return;
        const note = overlay.querySelector('.review-note').value.trim();
        overlay.remove();
        resolve({ ask: t.dataset.four === 'yes', note });
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
      await this.showQr(code, false);
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
      if (code) this.showQr(code, false);
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
