/**
 * Damage we caused (Holiday Lighting): after the crew's "Damage We Caused" photos, say what happened.
 * Odoo (ohl_helpdesk: worker_report_damage) opens a helpdesk ticket with the photos and the note, and
 * the office gets a to-do to assign the follow-up. Without signal the report waits on the phone and
 * goes when the signal is back (its photos first). Where it is: 📍 Mark on map (js/holidaymap.js), or
 * started from the map's ⚠️ Damage tool; the job's map then shows a pin with the photos.
 */
const DamageReport = {
  PENDING_KEY: 'damage_pending',

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },

  /** This job's damage photos not reported yet. */
  async _unreported(jobId) {
    const photos = await Photos.getPhotosForJob(jobId);
    return photos.filter(p => p.category === 'damage' && !p.damage_reported);
  },

  /** opts.spot {lat, lng}: where it is on the map; opts.onDone(): after it's sent or put off. */
  async open(jobId, opts) {
    opts = opts || {};
    const photos = await this._unreported(jobId);
    const done = () => { if (opts.onDone) opts.onDone(); };
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" style="max-width:460px;">
        <div class="modal-header"><h3>Damage we caused</h3></div>
        <div class="modal-body">
          <div class="damage-thumbs">${photos.slice(-6).map(p => `<img src="${p.thumbnail}" alt="">`).join('')}</div>
          <p style="margin:6px 0 4px;"><b>${photos.length} photo${photos.length === 1 ? '' : 's'}.</b> What happened?</p>
          <textarea class="damage-note" rows="4" style="width:100%;font-size:16px;"
            placeholder="e.g. Cracked a roof tile above the garage stepping off the ladder"></textarea>
          <p class="damage-spot">${opts.spot ? '&#128205; Marked on the map'
            : (typeof HolidayMap !== 'undefined' ? '<button class="btn btn-sm" data-dmg="map">&#128205; Mark where on the map</button>' : '')}</p>
          <p class="damage-safe">Thanks for reporting it. You won't get in trouble: the office follows up with the
            customer and gets it fixed.</p>
        </div>
        <div class="modal-footer" style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn" data-dmg="more">&#128247; Add more photos</button>
          <button class="btn" data-dmg="later">Later</button>
          <button class="btn btn-primary" data-dmg="send" disabled>Send to the office</button>
        </div></div>`;
    document.body.appendChild(overlay);
    const note = overlay.querySelector('.damage-note');
    const send = overlay.querySelector('[data-dmg="send"]');
    note.addEventListener('input', () => { send.disabled = note.value.trim().length < 3; });
    setTimeout(() => note.focus(), 50);
    overlay.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-dmg]');
      if (!t) return;
      if (t.dataset.dmg === 'later') {
        overlay.remove();
        App.showToast('Damage photos saved. Report it from "Damage We Caused" before you leave.', 'info');
        done();
        return;
      }
      if (t.dataset.dmg === 'map') {
        const text = note.value;
        const job = await DB.get('jobs', jobId).catch(() => null);
        if (!job) { App.showToast('Open the job first', 'error'); return; }
        overlay.remove();
        HolidayMap.open(job, null, { pickDamage: async (spot) => {
          await this.open(jobId, Object.assign({}, opts, spot ? { spot } : {}));
          const again = document.querySelector('.damage-note');
          if (again && text) { again.value = text; again.dispatchEvent(new Event('input')); }
        } });
        return;
      }
      if (t.dataset.dmg === 'more') {
        const text = note.value;
        overlay.remove();
        await Photos.capturePhoto(jobId, 'damage');
        await this.open(jobId, opts);
        // Keep what they'd already typed.
        const again = document.querySelector('.damage-note');
        if (again && text) { again.value = text; again.dispatchEvent(new Event('input')); }
        return;
      }
      if (t.dataset.dmg === 'send') {
        t.disabled = true;
        try {
          await this.send(jobId, note.value.trim(), opts.spot);
          overlay.remove();
          done();
        } catch (err) {
          App.showToast('Not sent: ' + (err.message || err), 'error');
          t.disabled = false;
        }
      }
    });
  },

  /** Upload the photos (if they aren't yet), then the report; without signal, keep it for later. */
  async send(jobId, note, spot) {
    if (!navigator.onLine) {
      await this._keep(jobId, note, spot);
      App.showToast('Saved on this phone: it goes to the office when there\'s signal', 'success');
      return;
    }
    const photos = await this._unreported(jobId);
    const ids = [];
    for (const p of photos) {
      let id = p.attachment_id;
      if (!id) {
        await Photos.uploadPhoto(p);
        const fresh = await DB.get('photos', p.temp_id);
        id = fresh && fresh.attachment_id;
      }
      if (id) ids.push(id);
    }
    const res = await OdooAPI.callKw('fsm.order', 'worker_report_damage',
      [jobId, note, ids, spot ? spot.lat : false, spot ? spot.lng : false], {});
    for (const p of photos) {
      const fresh = (await DB.get('photos', p.temp_id)) || p;
      fresh.damage_reported = true;
      await DB.put('photos', fresh);
    }
    App.showToast(`Sent to the office (${res.ticket})`, 'success');
  },

  async _keep(jobId, note, spot) {
    const pending = (await DB.getState(this.PENDING_KEY).catch(() => null)) || [];
    pending.push({ jobId, note, spot: spot || null, at: Date.now() });
    await DB.setState(this.PENDING_KEY, pending);
  },

  async flush() {
    if (!navigator.onLine) return;
    const pending = (await DB.getState(this.PENDING_KEY).catch(() => null)) || [];
    const left = [];
    for (const item of pending) {
      try {
        await this.send(item.jobId, item.note, item.spot);
      } catch (err) {
        console.warn('Damage report: still not sent', err);
        left.push(item);
      }
    }
    await DB.setState(this.PENDING_KEY, left).catch(() => {});
  },
};

window.addEventListener('online', () => DamageReport.flush().catch(() => {}));
setTimeout(() => DamageReport.flush().catch(() => {}), 8000);
