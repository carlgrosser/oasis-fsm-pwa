/**
 * Need to Come Back (Holiday Lighting): the crew has to go back to the house: short on material, couldn't
 * finish, something to fix, or damage we caused (that one goes through the damage report: photos and a spot
 * on the map, js/damage.js). Odoo (ohl_helpdesk: worker_report_callback) opens a ticket saying what and why,
 * on the house's callback (a Service Call job the office books; it then shows up here like any job).
 * Without signal the report waits on the phone and goes when the signal is back.
 */
const ComeBack = {
  PENDING_KEY: 'comeback_pending',
  REASONS: [
    ['material', 'Short on material', 'e.g. Need 20 ft more white socket wire for the entry way peak'],
    ['unfinished', "Couldn't finish", 'e.g. Ran out of daylight: the back roofline is left'],
    ['repair', 'Something to fix', 'e.g. 2 broken sockets on the garage run'],
    ['damage', 'Damage we caused', ''],
    ['other', 'Other', 'What needs doing'],
  ],

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },

  open(job) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" style="max-width:460px;">
        <div class="modal-header"><h3>Need to come back</h3></div>
        <div class="modal-body">
          <p style="margin:0 0 6px;">Why?</p>
          <div class="cb-reasons" style="display:flex;flex-wrap:wrap;gap:6px;">
            ${this.REASONS.map(([key, label]) => `<button class="btn btn-sm" data-cb-reason="${key}">${this._esc(label)}</button>`).join('')}
          </div>
          <textarea class="cb-note" rows="4" style="width:100%;font-size:16px;margin-top:10px;display:none;"></textarea>
          <p class="cb-help" style="margin:6px 0 0;font-size:14px;">The office books the trip back. It shows up in your jobs.</p>
        </div>
        <div class="modal-footer" style="display:flex;gap:8px;">
          <button class="btn" data-cb="cancel">Cancel</button>
          <button class="btn btn-primary" data-cb="send" disabled>Send to the office</button>
        </div></div>`;
    document.body.appendChild(overlay);
    const note = overlay.querySelector('.cb-note');
    const send = overlay.querySelector('[data-cb="send"]');
    let reason = null;
    const ready = () => { send.disabled = !reason || note.value.trim().length < 3; };
    note.addEventListener('input', ready);
    overlay.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.cbReason) {
        if (t.dataset.cbReason === 'damage') {
          // Damage: photos first, then what happened (the damage report).
          overlay.remove();
          if (typeof DamageReport === 'undefined') return;
          const unreported = await DamageReport._unreported(job.id);
          if (!unreported.length) await Photos.capturePhoto(job.id, 'damage');
          return DamageReport.open(job.id);
        }
        reason = t.dataset.cbReason;
        overlay.querySelectorAll('[data-cb-reason]').forEach(b => b.classList.toggle('btn-primary', b === t));
        const r = this.REASONS.find(x => x[0] === reason);
        note.placeholder = r ? r[2] : '';
        note.style.display = '';
        note.focus();
        ready();
        return;
      }
      if (t.dataset.cb === 'cancel') { overlay.remove(); return; }
      if (t.dataset.cb === 'send') {
        t.disabled = true;
        try {
          await this.send(job.id, reason, note.value.trim());
          overlay.remove();
        } catch (err) {
          App.showToast('Not sent: ' + (err.message || err), 'error');
          t.disabled = false;
        }
      }
    });
  },

  async send(jobId, reason, note) {
    if (!navigator.onLine) {
      await this._keep(jobId, reason, note);
      App.showToast('Saved on this phone: it goes to the office when there\'s signal', 'success');
      return;
    }
    try {
      const res = await OdooAPI.callKw('fsm.order', 'worker_report_callback', [jobId, reason, note], {});
      App.showToast(`Sent to the office (${res.callback})`, 'success');
    } catch (err) {
      // Weak signal: keep it and send it later (a refusal from Odoo shows instead).
      if (OdooAPI.isOffline(err)) {
        await this._keep(jobId, reason, note);
        App.showToast('Saved on this phone: it goes to the office when there\'s signal', 'success');
        return;
      }
      throw err;
    }
  },

  async _keep(jobId, reason, note) {
    const pending = (await DB.getState(this.PENDING_KEY).catch(() => null)) || [];
    pending.push({ jobId, reason, note, at: Date.now() });
    await DB.setState(this.PENDING_KEY, pending);
  },

  async flush() {
    if (!navigator.onLine) return;
    const pending = (await DB.getState(this.PENDING_KEY).catch(() => null)) || [];
    if (!pending.length) return;
    const left = [];
    for (const item of pending) {
      try {
        await OdooAPI.callKw('fsm.order', 'worker_report_callback', [item.jobId, item.reason, item.note], {});
      } catch (err) {
        console.warn('Need to come back: still not sent', err);
        left.push(item);
      }
    }
    await DB.setState(this.PENDING_KEY, left).catch(() => {});
  },
};

window.addEventListener('online', () => ComeBack.flush().catch(() => {}));
setTimeout(() => ComeBack.flush().catch(() => {}), 9000);
