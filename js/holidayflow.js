/**
 * Holiday Lighting job flow (Odoo ohl_dispatch: worker_get_field_flow, worker_set_field_step,
 * worker_tally, worker_ok_to_bill).
 *
 *  - Next step card at the top of the job: the one thing to do now, with Skip (a reason, never locked)
 *    and the SOP; during the install a quick bar (Map, magnetic clip tally, Photo).
 *  - Finish tab: every step with what's done / skipped, OK to bill, field payment only if needed.
 *  - Map & Count tab: map, picking list, Actual Used, Report a Change, Add Items, the tally.
 *  - Close Job asks for the required steps first (do them or skip with a reason).
 * The steps (order, required) come from Odoo (Holiday Lighting → Configuration → Field Steps).
 * Kept on the phone for no signal; ticks and skips made without signal go when it's back.
 */
const HolidayFlow = {
  PENDING_KEY: 'ohf_pending',
  SKIP_REASONS: ['Had to move on', 'Customer asked us not to', 'Weather', 'Not needed here'],
  MAGNETS: 'magnetic_clips',

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },

  isHoliday(job) {
    const company = job && (Array.isArray(job.company_id) ? job.company_id[0] : job.company_id);
    return !!company && company === CONFIG.HOLIDAY_COMPANY_ID
      && ['install', 'takedown', 'greenery', 'consult'].includes(job.ohl_job_kind);
  },

  /** A design visit (presite, consultation, follow-up): photos, measuring, notes; no lights, no count. */
  isVisit(job) {
    return this.isHoliday(job) && job.ohl_job_kind === 'consult';
  },

  _key(jobId) { return 'ohf_' + jobId; },

  /** Photo kinds whose step was skipped on the Next step card (the stage button's photo check honors it). */
  skippedPhotoCats(job) {
    const data = job && this._data && this._data[job.id];
    if (!data || !data.steps) return [];
    return data.steps.filter(s => s.skipped && (s.type === 'photos_before' || s.type === 'photos_after'))
      .map(s => (s.type === 'photos_before' ? 'before' : 'after'));
  },

  /** The job's flow from Odoo (kept on the phone), with ticks / skips made offline applied on top. */
  async load(job, fresh) {
    let data = null;
    if (navigator.onLine) {
      try {
        data = await OdooAPI.callKw('fsm.order', 'worker_get_field_flow', [job.id], {});
        await DB.setState(this._key(job.id), data).catch(() => {});
      } catch (err) {
        console.warn('Field flow: live fetch failed, using the saved copy', err);
      }
    }
    if (!data) data = await DB.getState(this._key(job.id)).catch(() => null);
    if (!data) return null;
    // Photos just taken may still be uploading: count the ones on the phone too.
    if (typeof Photos !== 'undefined' && Photos.getPhotoCountsByCategory) {
      const counts = await Photos.getPhotoCountsByCategory(job.id).catch(() => ({}));
      for (const s of data.steps) {
        const cat = s.type === 'photos_before' ? 'before' : s.type === 'photos_after' ? 'after' : null;
        if (cat && (counts[cat] || 0) >= 2 && !s.done) {
          s.done = true;
          s.skipped = false;
          s.detail = `${counts[cat]} photos`;
        }
      }
    }
    const pending = ((await DB.getState(this.PENDING_KEY).catch(() => null)) || []).filter(p => p.jobId === job.id);
    for (const p of pending) {
      const step = data.steps.find(s => s.code === p.code);
      if (step) Object.assign(step, { done: p.state === 'done', skipped: p.state === 'skipped', reason: p.reason || '' });
    }
    this._data = this._data || {};
    this._data[job.id] = data;
    return data;
  },

  async flush() {
    if (!navigator.onLine) return;
    const pending = (await DB.getState(this.PENDING_KEY).catch(() => null)) || [];
    const left = [];
    for (const p of pending) {
      try {
        await OdooAPI.callKw('fsm.order', 'worker_set_field_step', [p.jobId, p.code, p.state, p.reason || false], {});
      } catch (err) {
        left.push(p);
      }
    }
    await DB.setState(this.PENDING_KEY, left).catch(() => {});
  },

  async setStep(job, code, state, reason) {
    const data = this._data && this._data[job.id];
    const step = data && data.steps.find(s => s.code === code);
    if (step) Object.assign(step, { done: state === 'done', skipped: state === 'skipped', reason: reason || '' });
    if (navigator.onLine) {
      try {
        const res = await OdooAPI.callKw('fsm.order', 'worker_set_field_step', [job.id, code, state, reason || false], {});
        if (data) data.steps = res.steps;
        await DB.setState(this._key(job.id), data).catch(() => {});
        return;
      } catch (err) {
        if (!OdooAPI.isOffline(err)) throw err;
      }
    }
    const pending = ((await DB.getState(this.PENDING_KEY).catch(() => null)) || []).filter(p => !(p.jobId === job.id && p.code === code));
    pending.push({ jobId: job.id, code, state, reason });
    await DB.setState(this.PENDING_KEY, pending);
    await DB.setState(this._key(job.id), data).catch(() => {});
  },

  // ---------------------------------------------------------------- Where the job is
  _stage(job) {
    const name = (typeof Jobs !== 'undefined' ? Jobs.getStageName(job.stage_id) : '') || '';
    const n = name.toLowerCase();
    if (n.includes('complete') || n.includes('closed') || job.wrapup_submitted) return 'done';
    if (n.includes('progress')) return 'work';
    if (n.includes('arrived')) return 'arrival';
    if (n.includes('route')) return 'enroute';
    return 'pre';
  },

  _open(steps) { return steps.filter(s => !s.done && !s.skipped); },

  /** The step the crew should do now (null: none for this stage). */
  _nextStep(job, data) {
    const stage = this._stage(job);
    if (stage === 'arrival') return this._open(data.steps.filter(s => s.phase === 'arrival'))[0] || { code: '_start', name: 'Start the install', type: '_start' };
    if (stage === 'work') {
      const open = this._open(data.steps.filter(s => s.phase !== 'arrival' && s.type !== 'rating'));
      return open[0] || { code: '_close', name: 'Close Job', type: '_close', help: 'Then the job rating and the Google review.' };
    }
    return null;
  },

  // ---------------------------------------------------------------- The top of the job
  topHtml(job) {
    if (!this.isHoliday(job)) return '';
    return '<div id="ohfTop" class="ohf-top"></div>';
  },

  async bind(job) {
    const top = document.getElementById('ohfTop');
    if (!top) return;
    this._job = job;
    const data = await this.load(job);
    if (!data) { top.innerHTML = ''; return; }
    this._renderTop(job, data, top);
    this.renderFinish(job);
    this.renderMapCount(job);
  },

  _renderTop(job, data, top) {
    const stage = this._stage(job);
    const next = this._nextStep(job, data);
    const all = data.steps.filter(s => s.type !== 'rating');
    const doneN = all.filter(s => s.done || s.skipped).length;
    const sop = '<button class="btn btn-sm ohf-sop" data-ohf="sop">&#128216; SOP</button>';
    let card = '';
    const visit = this.isVisit(job);
    if (stage === 'pre' && visit) {
      card = `<div class="ohf-card"><div class="ohf-card-head"><span class="ohf-label">Next</span></div>
          <div class="ohf-title">Head to the visit</div>
          <div class="ohf-help">${this._esc(job.ohl_visit_label || '')}${job.ohl_visit_label ? '. ' : ''}Tap when you set off (you can text the customer your ETA).</div>
          <div class="ohf-actions"><button class="btn btn-primary btn-lg" data-ohf="enroute">&#128666; Leaving now</button></div></div>`;
    } else if (stage === 'enroute' && visit) {
      card = `<div class="ohf-card"><div class="ohf-card-head"><span class="ohf-label">Next</span></div>
          <div class="ohf-title">On the way</div>
          <div class="ohf-help">Tap Arrived when you get there. Then photos of the house.</div>
          <div class="ohf-actions"><button class="btn btn-primary btn-lg" data-ohf="arrived">&#128205; Arrived</button></div></div>`;
    } else if (stage === 'pre') {
      card = `<div class="ohf-card"><div class="ohf-card-head"><span class="ohf-label">Next</span>${sop}</div>
          <div class="ohf-title">Head to the job</div>
          <div class="ohf-help">Tap when you set off (you can text the customer your ETA). On arrival: A-frame signs and the walk-through.</div>
          <div class="ohf-actions"><button class="btn btn-primary btn-lg" data-ohf="enroute">&#128666; Leaving now</button></div></div>`;
    } else if (stage === 'enroute') {
      card = `<div class="ohf-card"><div class="ohf-card-head"><span class="ohf-label">Next</span>${sop}</div>
          <div class="ohf-title">On the way</div>
          <div class="ohf-help">Tap Arrived when you get there. Then the A-frame signs and the walk-through.</div>
          <div class="ohf-actions"><button class="btn btn-primary btn-lg" data-ohf="arrived">&#128205; Arrived</button></div></div>`;
    } else if (stage === 'done') {
      card = `<div class="ohf-card ohf-done"><div class="ohf-card-head"><span class="ohf-label">&#10003; Job closed</span>${sop}</div>
          <div class="ohf-help">${this._esc(data.bill && data.bill.state === 'scheduled' ? 'The balance is charged to the card on file tomorrow morning.' : '')}</div></div>`;
    } else if (next) {
      const action = this._actionLabel(next);
      card = `<div class="ohf-card"><div class="ohf-card-head"><span class="ohf-label">Next · ${doneN} of ${all.length} done</span>${sop}</div>
          <div class="ohf-title">${this._esc(next.name)}</div>
          ${next.help ? `<div class="ohf-help">${this._esc(next.help)}</div>` : ''}
          ${next.detail ? `<div class="ohf-detail">${this._esc(next.detail)}</div>` : ''}
          <div class="ohf-actions">
            <button class="btn btn-primary btn-lg" data-ohf-do="${this._esc(next.code)}">${action}</button>
            ${next.code.startsWith('_') ? '' : `<button class="btn btn-ghost" data-ohf-skip="${this._esc(next.code)}">Skip…</button>`}
          </div></div>`;
    }
    const magnets = (data.tally && data.tally[this.MAGNETS]) || 0;
    const quick = stage === 'work' && visit ? `<div class="ohf-quick">
        ${job.ohl_design_id ? '<button class="btn" data-ohf="map">&#128506;&#65039; Design</button>' : ''}
        <button class="btn" data-ohf="photo">&#128247; Photo</button></div>` : stage === 'work' ? `<div class="ohf-quick">
        <button class="btn" data-ohf="map">&#128506;&#65039; Map</button>
        <div class="ohf-tally"><span>&#129522; Magnets <b id="ohfMagnets">${magnets}</b></span>
          <button class="btn btn-sm" data-ohf-tally="1">+1</button><button class="btn btn-sm" data-ohf-tally="5">+5</button></div>
        <button class="btn" data-ohf="photo">&#128247;</button></div>` : '';
    top.innerHTML = this._gateHtml(job, stage) + card + quick;
    top.onclick = (e) => this._onClick(job, e);
  },

  /** Install gate, warn only: the agreement or deposit isn't done. The crew calls the office first. */
  _gateHtml(job, stage) {
    if (stage === 'done' || job.ohl_job_kind === 'takedown') return '';
    const missing = [];
    if (job.ohl_agreement_state === 'sent') missing.push('agreement not signed');
    if (job.ohl_deposit_state === 'requested') missing.push('deposit not paid');
    if (!missing.length) return '';
    return `<div class="ohf-gate">&#9888;&#65039; ${this._esc(missing.join(' · '))}. Call the office before you start.</div>`;
  },

  _actionLabel(step) {
    return {
      tick: '&#10003; Done', photos_before: '&#128247; Take photos', photos_after: '&#128247; Take photos',
      used: '&#9989; Count', map: '&#128506;&#65039; Open the map', bill: '&#128179; OK to bill',
      rating: '&#11088; Rate', _start: '&#9654; Start install', _close: '&#10003; Close Job',
    }[step.type] || 'Do it';
  },

  async _onClick(job, e) {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.ohf === 'sop') return this.openSop(job);
    if (t.dataset.ohf === 'enroute') return Jobs._showEnRouteModal(job);
    if (t.dataset.ohf === 'arrived') {
      t.disabled = true;
      try {
        if (await Jobs.changeJobStatus(job, 'Arrived')) {
          const container = document.getElementById('jobDetail');
          if (container) Jobs.renderJobDetail(job.id, container);
          return;
        }
      } catch (err) {
        App.showToast('Could not mark Arrived: ' + err.message, 'error');
      }
      t.disabled = false;
      return;
    }
    if (t.dataset.ohf === 'map' && typeof HolidayMap !== 'undefined') return HolidayMap.open(job);
    if (t.dataset.ohf === 'photo') return document.getElementById('footerCameraBtn')?.click();
    if (t.dataset.ohfTally) return this.tally(job, parseInt(t.dataset.ohfTally, 10));
    if (t.dataset.ohfDo) return this.doStep(job, t.dataset.ohfDo);
    if (t.dataset.ohfSkip) return this.skipStep(job, t.dataset.ohfSkip);
    if (t.dataset.ohfUndo) {
      await this.setStep(job, t.dataset.ohfUndo, false);
      return this.refresh(job);
    }
  },

  async refresh(job) {
    const data = await this.load(job);
    const top = document.getElementById('ohfTop');
    if (data && top) this._renderTop(job, data, top);
    this.renderFinish(job);
    this.renderMapCount(job);
  },

  async tally(job, delta) {
    const data = this._data && this._data[job.id];
    const el = document.getElementById('ohfMagnets');
    if (data) {
      data.tally = data.tally || {};
      data.tally[this.MAGNETS] = Math.max(0, (data.tally[this.MAGNETS] || 0) + delta);
      if (el) el.textContent = data.tally[this.MAGNETS];
      document.querySelectorAll('.ohf-magnets-count').forEach(x => { x.textContent = data.tally[this.MAGNETS]; });
      await DB.setState(this._key(job.id), data).catch(() => {});
    }
    // Each tap has an id: sent again after a lost answer, the server counts it once.
    const tapId = 't' + Date.now() + Math.random().toString(36).slice(2, 7);
    try {
      const tally = await OdooAPI.callKw('fsm.order', 'worker_tally', [job.id, this.MAGNETS, delta, tapId], {});
      if (data) data.tally = tally;
    } catch (err) {
      const pending = (await DB.getState('ohf_tally_pending').catch(() => null)) || [];
      pending.push({ jobId: job.id, delta, tapId });
      await DB.setState('ohf_tally_pending', pending).catch(() => {});
    }
  },

  async flushTally() {
    if (!navigator.onLine) return;
    const pending = (await DB.getState('ohf_tally_pending').catch(() => null)) || [];
    const left = [];
    for (const p of pending) {
      try { await OdooAPI.callKw('fsm.order', 'worker_tally', [p.jobId, this.MAGNETS, p.delta, p.tapId || false], {}); } catch (e) { left.push(p); }
    }
    await DB.setState('ohf_tally_pending', left).catch(() => {});
  },

  // ---------------------------------------------------------------- Doing a step
  async doStep(job, code) {
    const data = this._data && this._data[job.id];
    const step = data && data.steps.find(s => s.code === code);
    const type = step ? step.type : code;
    const after = () => this.refresh(job);
    if (code === '_start') {
      const btn = document.getElementById('nextStageBtn');
      if (btn && btn.disabled && typeof Jobs !== 'undefined') await Jobs._updateStageGate(job, btn.dataset.nextStage);
      if (!btn) {
        App.showToast('Open the Work tab to start the install', 'error');
      } else if (btn.disabled) {
        App.showToast('Photos are still needed first: take them, or tick "Bypass photo requirement" below', 'error');
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        btn.click();
      }
      return;
    }
    if (code === '_close' || type === 'rating') { if (typeof WrapUp !== 'undefined') WrapUp.show(job); return; }
    if (type === 'tick') { await this.setStep(job, code, 'done'); return after(); }
    if (type === 'photos_before' || type === 'photos_after') {
      await Photos.capturePhoto(job.id, type === 'photos_before' ? 'before' : 'after');
      // The Work tab's photo section and the stage gate follow, and so does the card.
      const detail = document.getElementById('jobDetail');
      if (detail && typeof Jobs !== 'undefined') await Jobs.renderJobDetail(job.id, detail);
      else await after();
      return;
    }
    if (type === 'used' && typeof HolidayUsed !== 'undefined') return HolidayUsed.open(job, after);
    if (type === 'map' && typeof HolidayMap !== 'undefined') return HolidayMap.open(job, after);
    if (type === 'bill') return this.okToBill(job);
  },

  skipStep(job, code) {
    const data = this._data && this._data[job.id];
    const step = data && data.steps.find(s => s.code === code);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" style="max-width:420px;">
        <div class="modal-header"><h3>Skip: ${this._esc(step ? step.name : code)}</h3></div>
        <div class="modal-body">
          <p style="margin-top:0;">Why? (The office sees it, so they can follow up.)</p>
          ${this.SKIP_REASONS.map(r => `<button class="ohu-chip" data-reason="${this._esc(r)}">${this._esc(r)}</button>`).join('')}
          <input type="text" class="form-input ohf-reason" placeholder="Or say why" style="width:100%;margin-top:8px;">
        </div>
        <div class="modal-footer"><button class="btn" data-x>Cancel</button>
          <button class="btn btn-primary" data-ok disabled>Skip it</button></div></div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.ohf-reason');
    const ok = overlay.querySelector('[data-ok]');
    input.addEventListener('input', () => { ok.disabled = !input.value.trim(); });
    return new Promise((resolve) => {
      overlay.addEventListener('click', async (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        if (t.dataset.reason) { input.value = t.dataset.reason; ok.disabled = false; return; }
        if (t.hasAttribute('data-x')) { overlay.remove(); resolve(false); return; }
        if (t.hasAttribute('data-ok')) {
          overlay.remove();
          try {
            await this.setStep(job, code, 'skipped', input.value.trim());
          } catch (err) {
            App.showToast('Not saved: ' + (err.message || err), 'error');
          }
          await this.refresh(job);
          resolve(true);
        }
      });
    });
  },

  okToBill(job) {
    const data = this._data && this._data[job.id];
    const bill = (data && data.bill) || {};
    if (!navigator.onLine) { App.showToast('OK to bill needs signal (it makes the invoice)', 'error'); return; }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" style="max-width:440px;">
        <div class="modal-header"><h3>Job complete, OK to bill?</h3></div>
        <div class="modal-body">
          <p style="margin-top:0;">The lights match the order (and anything added on site), the job is done.</p>
          <p class="ohf-help">${bill.card ? `The balance is charged to the card on file (ending ${this._esc(bill.card)}) tomorrow morning, if everything checks out.`
            : 'No card on file: the office follows up on the balance.'}</p>
          <textarea class="form-input ohf-bill-note" rows="2" style="width:100%;" placeholder="Anything the office should know (optional)"></textarea>
        </div>
        <div class="modal-footer"><button class="btn" data-x>Not yet</button>
          <button class="btn btn-primary" data-ok>&#10003; OK to bill</button></div></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.hasAttribute('data-x')) { overlay.remove(); return; }
      if (t.hasAttribute('data-ok')) {
        t.disabled = true;
        try {
          const res = await OdooAPI.callKw('fsm.order', 'worker_ok_to_bill', [job.id, overlay.querySelector('.ohf-bill-note').value.trim() || false], {});
          overlay.remove();
          App.showToast(res.state === 'scheduled' ? `Invoice ${res.invoice}: the card is charged tomorrow morning` : 'OK to bill: nothing left to charge', 'success');
          await this.refresh(job);
        } catch (err) {
          App.showToast('Not done: ' + (err.message || err), 'error');
          t.disabled = false;
        }
      }
    });
  },

  async openSop(job) {
    const data = (this._data && this._data[job.id]) || (await this.load(job));
    const overlay = document.createElement('div');
    overlay.className = 'ohu-overlay';
    overlay.innerHTML = `<div class="ohu-head"><button class="btn btn-sm" data-x>&larr; Back</button>
        <div style="flex:1;"><div class="ohu-title">&#128216; SOP</div></div></div>
      <div class="ohu-body ohf-sop-body">${(data && data.sop) || '<p>No SOP written yet (Odoo: Settings → Holiday Lighting).</p>'}</div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('[data-x]').addEventListener('click', () => overlay.remove());
  },

  // ---------------------------------------------------------------- Finish tab
  _phaseTitle: { arrival: 'On arrival', work: 'During the job', finish: 'Before leaving' },

  renderFinish(job) {
    const box = document.getElementById('ohfFinish');
    const data = this._data && this._data[job.id];
    if (!box || !data) return;
    const row = (s) => {
      const state = s.done ? '<span class="ohf-st ok">&#10003;</span>' : s.skipped ? '<span class="ohf-st skip">&#8631;</span>' : '<span class="ohf-st todo">&#9675;</span>';
      const sub = s.skipped ? `Skipped: ${this._esc(s.reason)}` : this._esc(s.detail || (s.required ? '' : 'optional'));
      // Done: a tick can be undone; a count, the map or photos can be opened again to change or add.
      const reopen = { used: 'Edit', map: 'Edit', photos_before: '+ Photos', photos_after: '+ Photos' }[s.type];
      const act = s.done
        ? (s.type === 'tick' ? `<button class="btn btn-sm btn-ghost" data-ohf-undo="${this._esc(s.code)}">Undo</button>`
          : reopen ? `<button class="btn btn-sm btn-ghost" data-ohf-do="${this._esc(s.code)}">${reopen}</button>` : '')
        : `<button class="btn btn-sm" data-ohf-do="${this._esc(s.code)}">${this._actionLabel(s)}</button>
           ${s.skipped ? '' : `<button class="btn btn-sm btn-ghost" data-ohf-skip="${this._esc(s.code)}">Skip</button>`}`;
      return `<div class="ohf-row">${state}<div class="ohf-row-main"><div>${this._esc(s.name)}</div>
          ${sub ? `<div class="ohf-row-sub">${sub}</div>` : ''}</div><div class="ohf-row-act">${act}</div></div>`;
    };
    let html = '';
    for (const phase of ['arrival', 'work', 'finish']) {
      const steps = data.steps.filter(s => s.phase === phase);
      if (!steps.length) continue;
      html += `<div class="ohf-phase">${this._phaseTitle[phase]}</div>${steps.map(row).join('')}`;
    }
    const bill = data.bill || {};
    const billState = { scheduled: `Charged to the card on file tomorrow morning${bill.card ? ` (ending ${this._esc(bill.card)})` : ''}`,
      hold: 'On hold (office)', charged: 'Charged', office: `The office follows up: ${this._esc(bill.note)}`, nothing: 'Nothing left to charge' }[bill.state];
    html += billState ? `<div class="ohf-billstate">&#128179; ${bill.invoice ? this._esc(bill.invoice) + ': ' : ''}${billState}</div>` : '';
    box.innerHTML = html;
    box.onclick = (e) => this._onClick(job, e);
  },

  // ---------------------------------------------------------------- Map & Count tab
  renderMapCount(job) {
    const box = document.getElementById('ohfMapCount');
    const data = this._data && this._data[job.id];
    if (!box) return;
    if (this.isVisit(job)) {
      box.innerHTML = job.ohl_design_id
        ? `<div class="ohf-grid"><button class="ohf-tile" data-mc="map"><span>&#128506;&#65039;</span>Design</button></div>
           <div class="ohf-help">Measure on the design, or put the measurements in the Close Job notes.</div>`
        : '<div class="ohf-help">No design yet: put the measurements in the Close Job notes.</div>';
      box.onclick = (e) => {
        const t = e.target.closest('button');
        if (t && t.dataset.mc === 'map' && typeof HolidayMap !== 'undefined') HolidayMap.open(job, () => this.refresh(job));
      };
      return;
    }
    const magnets = (data && data.tally && data.tally[this.MAGNETS]) || 0;
    const sheet = job.ohl_design_id ? 'Picking List' : 'Rehang Sheet';
    const install = job.ohl_job_kind === 'install';
    box.innerHTML = `<div class="ohf-grid">
        <button class="ohf-tile" data-mc="map"><span>&#128506;&#65039;</span>Map</button>
        <button class="ohf-tile" data-mc="sheet"><span>&#128196;</span>${sheet}</button>
        ${install ? '<button class="ohf-tile" data-mc="used"><span>&#9989;</span>Actual Used</button>' : ''}
        <button class="ohf-tile" data-mc="change"><span>&#9998;&#65039;</span>Report a Change</button>
        ${install ? '<button class="ohf-tile" data-mc="add"><span>&#10133;</span>Add Items</button>' : ''}
      </div>
      ${install ? `<div class="ohf-tally ohf-tally-big"><span>&#129522; Magnetic clips so far: <b class="ohf-magnets-count">${magnets}</b></span>
        <button class="btn btn-sm" data-mc-tally="-1">&minus;1</button><button class="btn btn-sm" data-mc-tally="1">+1</button>
        <button class="btn btn-sm" data-mc-tally="5">+5</button></div>` : ''}`;
    box.onclick = (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.mcTally) return this.tally(job, parseInt(t.dataset.mcTally, 10));
      const act = t.dataset.mc;
      if (act === 'map' && typeof HolidayMap !== 'undefined') HolidayMap.open(job, () => this.refresh(job));
      if (act === 'sheet' && typeof InstallMap !== 'undefined') InstallMap.open(job);
      if (act === 'used' && typeof HolidayUsed !== 'undefined') HolidayUsed.open(job, () => this.refresh(job));
      if (act === 'change' && typeof HolidayCrew !== 'undefined') HolidayCrew.openChange(job);
      if (act === 'add' && typeof HolidayCrew !== 'undefined') HolidayCrew.openAddItems(job);
    };
  },

  // ---------------------------------------------------------------- Before Close Job
  /** Required steps not done: do them or skip them (with a reason). Resolves true to go on to Close Job. */
  async beforeClose(job) {
    const data = await this.load(job);
    if (!data) return true;
    const open = this._open(data.steps.filter(s => s.required && s.type !== 'rating'));
    if (!open.length) return true;
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const draw = () => {
        const still = this._open(this._data[job.id].steps.filter(s => s.required && s.type !== 'rating'));
        overlay.innerHTML = `<div class="modal" style="max-width:460px;">
            <div class="modal-header"><h3>Before you close the job</h3></div>
            <div class="modal-body">
              ${still.length ? still.map(s => `<div class="ohf-row"><span class="ohf-st todo">&#9675;</span>
                  <div class="ohf-row-main">${this._esc(s.name)}</div>
                  <div class="ohf-row-act"><button class="btn btn-sm" data-do="${this._esc(s.code)}">${this._actionLabel(s)}</button>
                  <button class="btn btn-sm btn-ghost" data-skip="${this._esc(s.code)}">Skip</button></div></div>`).join('')
                : '<p>&#10003; All set.</p>'}
            </div>
            <div class="modal-footer" style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn" data-x>Back to the job</button>
              ${still.length ? '<button class="btn btn-ghost" data-skipall>Skip the rest: had to move on</button>' : ''}
              <button class="btn btn-primary" data-go ${still.length ? 'disabled' : ''}>Close Job</button>
            </div></div>`;
      };
      draw();
      document.body.appendChild(overlay);
      overlay.addEventListener('click', async (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        if (t.hasAttribute('data-x')) { overlay.remove(); resolve(false); return; }
        if (t.hasAttribute('data-go')) { overlay.remove(); resolve(true); return; }
        if (t.hasAttribute('data-skipall')) {
          for (const s of this._open(this._data[job.id].steps.filter(x => x.required && x.type !== 'rating'))) {
            await this.setStep(job, s.code, 'skipped', 'Had to move on');
          }
          overlay.remove();
          await this.refresh(job);
          resolve(true);
          return;
        }
        if (t.dataset.skip) {
          overlay.style.display = 'none';
          await this.skipStep(job, t.dataset.skip);
          overlay.style.display = '';
          draw();
          return;
        }
        if (t.dataset.do) {
          overlay.remove();
          resolve(false);
          this.doStep(job, t.dataset.do);
        }
      });
    });
  },
};

window.addEventListener('online', () => { HolidayFlow.flush().catch(() => {}); HolidayFlow.flushTally().catch(() => {}); });
setTimeout(() => { HolidayFlow.flush().catch(() => {}); HolidayFlow.flushTally().catch(() => {}); }, 9000);
