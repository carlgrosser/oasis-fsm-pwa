/**
 * Job Wrap-Up Controller
 *
 * Handles two flows:
 *   WrapUp.show(job)       — Full wrap-up for completed jobs. Gathers resolution,
 *                            return-trip flag, payment status, and office note.
 *                            Triggered by the big banner button above the tabs.
 *
 *   WrapUp.showEarly(job)  — Simplified wrap-up for in-progress jobs. Only asks
 *                            about payment. Triggered from the Info tab.
 *
 * Both flows end with a clock-off prompt offering:
 *   • Clock Off (with optional "clock all workers off")
 *   • Stay clocked in (another job / after-work duties)
 */
const WrapUp = {

  _currentJob: null,
  _PLACEMENT_KEY: 'wrapup_btn_placement',

  // ── Placement Setting ───────────────────────────────────────────────────────

  /** @returns {'above_tabs'|'above_footer'} */
  getPlacement() {
    return localStorage.getItem(this._PLACEMENT_KEY) || 'above_tabs';
  },

  /** @param {'above_tabs'|'above_footer'} val */
  setPlacement(val) {
    localStorage.setItem(this._PLACEMENT_KEY, val);
    this._updatePlacementMenuLabels();
  },

  /** Update both menu button labels to reflect the current setting. */
  _updatePlacementMenuLabels() {
    const placement = this.getPlacement();
    const label = placement === 'above_footer'
      ? '📌 Wrap-Up Btn: Above Footer'
      : '📌 Wrap-Up Btn: Above Tabs';
    ['wrapupPlacementBtnList', 'wrapupPlacementBtnDetail'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = label;
    });
  },

  /**
   * Bind the placement toggle menu items. Called once after DOM is ready.
   * Toggling re-renders the current job detail to move the button.
   */
  init() {
    this._updatePlacementMenuLabels();

    ['wrapupPlacementBtnList', 'wrapupPlacementBtnDetail'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => {
        const next = this.getPlacement() === 'above_tabs' ? 'above_footer' : 'above_tabs';
        this.setPlacement(next);

        // Re-render the current job detail if one is open so the button moves
        if (typeof Jobs !== 'undefined' && Jobs._currentJobId) {
          const container = document.getElementById('jobDetail');
          if (container) Jobs.renderJobDetail(Jobs._currentJobId, container);
        }
      });
    });
  },


  // ── Full Wrap-Up ────────────────────────────────────────────────────────────

  /**
   * Show the full wrap-up modal for a job that is already in a completed stage.
   * @param {Object} job - fsm.order data object
   */
  async show(job) {
    this._currentJob = job;

    const customerName = Array.isArray(job.location_id) ? job.location_id[1] : (job.location_id || '');
    const workerCount = job.worker_count || 1;
    const timeOnSite = this._calcTimeOnSite();
    const existingResolution = (job.resolution || '').trim();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-wrapup">
        <div class="modal-header">
          <h3>Job Wrap-Up</h3>
          <button class="modal-close" id="wrapupClose">&times;</button>
        </div>
        <div class="modal-body modal-body-scroll">

          <!-- Auto-filled context -->
          <div class="wrapup-context">
            <div class="wrapup-job-name">${this._esc(job.name || 'Job')}</div>
            <div class="wrapup-meta">
              <span>${this._esc(customerName)}</span>
              ${timeOnSite ? `<span class="wrapup-time">· ${timeOnSite} on site</span>` : ''}
            </div>
          </div>

          <!-- Job Complete / Needs Return Trip -->
          <div class="wrapup-field">
            <label class="wrapup-label">Job Status</label>
            <div class="toggle-pair" id="jobStatusToggle">
              <button class="toggle-btn active" data-val="complete">✓ Job Complete</button>
              <button class="toggle-btn" data-val="return_trip">↩ Needs Return Trip</button>
            </div>
          </div>

          <!-- Return trip notes (conditional) -->
          <div class="wrapup-field" id="returnTripField" style="display:none;">
            <label class="wrapup-label">What's needed for the return visit?</label>
            <textarea class="form-input" id="returnTripNote" rows="2"
              placeholder="Parts to order, remaining scope, customer request…"></textarea>
          </div>

          <!-- Payment not collected -->
          <div class="wrapup-field">
            <label class="wrapup-check-label">
              <input type="checkbox" id="paymentNotCollected" disabled>
              <span>Payment not collected</span>
            </label>
            <div class="wrapup-payment-status" id="paymentStatusInfo">
              <span class="wrapup-status-loading">Checking payment status…</span>
            </div>
          </div>

          <!-- Payment reasons (conditional) -->
          <div class="wrapup-payment-reasons" id="paymentNotice" style="display:none;">
            <p class="wrapup-payment-notice-text">⚠ Enter details in the Sales tab or select reason below.</p>
            <label class="wrapup-check-label"><input type="checkbox" id="payReasonHome"> No one home</label>
            <label class="wrapup-check-label"><input type="checkbox" id="payReasonNotRequired"> No payment required</label>
            <label class="wrapup-check-label"><input type="checkbox" id="payReasonRefused"> Payment refused</label>
            <label class="wrapup-check-label"><input type="checkbox" id="payReasonOther"> Other</label>
            <div id="payReasonOtherField" style="display:none; margin-top:var(--spacing-xs);">
              <textarea class="form-input" id="paymentFollowupNote" rows="2"
                placeholder="Explain…"></textarea>
            </div>
          </div>

          <!-- Resolution -->
          <div class="wrapup-field">
            <label class="wrapup-label">
              What was done? <span class="wrapup-nudge">(quick note about job)</span>
            </label>
            <textarea class="form-input" id="wrapupResolution" rows="3"
              placeholder="Describe the work completed…">${this._esc(existingResolution)}</textarea>
          </div>

          <!-- Note to Office (hidden behind toggle) -->
          <div class="wrapup-field">
            <button class="btn btn-outline btn-sm wrapup-office-toggle-btn" id="wrapupOfficeToggleBtn" type="button">
              + Note to Office
            </button>
            <div id="wrapupOfficeNoteWrap" style="display:none; margin-top:var(--spacing-xs);">
              <textarea class="form-input" id="wrapupOfficeNote" rows="2"
                placeholder="Internal note for billing or dispatch…"></textarea>
            </div>
          </div>

        </div>
        <div class="modal-footer wrapup-footer">
          <button class="btn btn-primary btn-block btn-lg" id="wrapupSubmitBtn">
            Wrap It Up!
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    this._bindFullModal(overlay, job, workerCount);
    this._loadPaymentStatus(job, overlay);
  },

  _bindFullModal(overlay, job, workerCount) {
    // Close button
    overlay.querySelector('#wrapupClose').addEventListener('click', () => overlay.remove());

    // Job status toggle
    const toggleBtns = overlay.querySelectorAll('#jobStatusToggle .toggle-btn');
    const returnTripField = overlay.querySelector('#returnTripField');
    toggleBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        toggleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        returnTripField.style.display = btn.dataset.val === 'return_trip' ? '' : 'none';
      });
    });

    // Payment not collected toggle
    const payCheck = overlay.querySelector('#paymentNotCollected');
    const payNotice = overlay.querySelector('#paymentNotice');
    payCheck.addEventListener('change', () => {
      payNotice.style.display = payCheck.checked ? '' : 'none';
    });

    // "Other" reason → show text field
    overlay.querySelector('#payReasonOther').addEventListener('change', e => {
      overlay.querySelector('#payReasonOtherField').style.display = e.target.checked ? '' : 'none';
    });

    // Note to Office toggle
    overlay.querySelector('#wrapupOfficeToggleBtn').addEventListener('click', () => {
      const wrap = overlay.querySelector('#wrapupOfficeNoteWrap');
      const isHidden = wrap.style.display === 'none';
      wrap.style.display = isHidden ? '' : 'none';
      overlay.querySelector('#wrapupOfficeToggleBtn').textContent = isHidden ? '− Note to Office' : '+ Note to Office';
    });

    // Submit
    overlay.querySelector('#wrapupSubmitBtn').addEventListener('click', async () => {
      const jobComplete = overlay.querySelector('#jobStatusToggle .toggle-btn.active').dataset.val === 'complete';
      const paymentNotCollected = payCheck.checked;

      // Collect payment reasons
      const reasons = [];
      if (overlay.querySelector('#payReasonHome')?.checked) reasons.push('No one home');
      if (overlay.querySelector('#payReasonNotRequired')?.checked) reasons.push('No payment required');
      if (overlay.querySelector('#payReasonRefused')?.checked) reasons.push('Payment refused');
      const otherText = overlay.querySelector('#paymentFollowupNote')?.value.trim() || '';
      if (overlay.querySelector('#payReasonOther')?.checked) {
        reasons.push(otherText ? `Other: ${otherText}` : 'Other');
      }

      const data = {
        job_complete:            jobComplete,
        return_trip_note:        overlay.querySelector('#returnTripNote').value.trim(),
        payment_not_collected:   paymentNotCollected,
        payment_followup_note:   reasons.join('; '),
        resolution:              overlay.querySelector('#wrapupResolution').value.trim(),
        office_note:             overlay.querySelector('#wrapupOfficeNote')?.value.trim() || '',
      };

      overlay.querySelector('#wrapupSubmitBtn').disabled = true;
      overlay.querySelector('#wrapupSubmitBtn').textContent = 'Submitting…';

      await this._submitFull(overlay, job, workerCount, data);
    });
  },

  async _submitFull(overlay, job, workerCount, data) {
    let gps = '';
    let gpsAccuracy = 0;
    if (typeof GPS !== 'undefined') {
      const pos = await GPS.getQuickPosition();
      if (pos) {
        gps = GPS.formatCoords(pos);
        gpsAccuracy = pos.accuracy || 0;
      }
    }

    if (navigator.onLine) {
      try {
        const result = await OdooAPI.submitWrapup(job.id, { ...data, gps, gps_accuracy: gpsAccuracy });
        overlay.remove();

        if (result.already_submitted) {
          App.showToast(`Wrap-up already submitted by ${result.submitted_by || 'another worker'}.`, 'info');
          this._showClockOffPrompt(job, workerCount, 0, gps, gpsAccuracy);
        } else {
          this._showClockOffPrompt(job, workerCount, result.clocked_out_count, gps, gpsAccuracy);
        }
      } catch (err) {
        App.showToast('Wrap-up failed: ' + err.message, 'error');
        const btn = overlay.querySelector('#wrapupSubmitBtn');
        if (btn) { btn.disabled = false; btn.textContent = 'Wrap It Up!'; }
      }
    } else {
      // Queue for offline sync
      await DB.put('wrapupQueue', {
        temp_id: 'wu_' + Date.now(),
        order_id: job.id,
        type: 'full',
        data: { ...data, gps, gps_accuracy: gpsAccuracy },
        timestamp: new Date().toISOString(),
        synced: 0,
      });
      overlay.remove();
      App.showToast('Wrap-up saved — will sync when online.', 'info');
      this._showClockOffPrompt(job, workerCount, 0, gps, gpsAccuracy);
    }
  },

  // ── Early Wrap-Up ───────────────────────────────────────────────────────────

  /**
   * Show the early wrap-up modal for in-progress jobs.
   * Captures reason for leaving early, payment status, and an optional note to office.
   * @param {Object} job - fsm.order data object
   */
  async showEarly(job) {
    this._currentJob = job;
    const workerCount = job.worker_count || 1;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Early Wrap-Up</h3>
          <button class="modal-close" id="earlyWrapupClose">&times;</button>
        </div>
        <div class="modal-body">
          <div class="wrapup-field">
            <label class="wrapup-label">Reason for early wrap-up</label>
            <textarea class="form-input" id="earlyWrapupReason" rows="2"
              placeholder="Why are you leaving before the job is complete?"></textarea>
          </div>

          <div class="wrapup-field">
            <label class="wrapup-label">Was payment collected?</label>
            <div class="toggle-trio" id="earlyPaymentToggle">
              <button class="toggle-btn" data-val="collected">✓ Collected</button>
              <button class="toggle-btn" data-val="not_collected">✕ Not Collected</button>
              <button class="toggle-btn active" data-val="na">N/A</button>
            </div>
            <div id="earlyPaymentNoteField" style="display:none; margin-top:var(--spacing-sm);">
              <textarea class="form-input" id="earlyPaymentNote" rows="2"
                placeholder="Reason or follow-up plan…"></textarea>
            </div>
          </div>

          <div class="wrapup-field">
            <label class="wrapup-label">
              Note to Office
              <span class="wrapup-nudge">(optional)</span>
            </label>
            <textarea class="form-input" id="earlyOfficeNote" rows="2"
              placeholder="Internal note for billing or dispatch…"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary btn-block btn-lg" id="earlyWrapupSubmitBtn">
            Submit
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Close button
    overlay.querySelector('#earlyWrapupClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    // Toggle
    const toggleBtns = overlay.querySelectorAll('#earlyPaymentToggle .toggle-btn');
    const noteField = overlay.querySelector('#earlyPaymentNoteField');
    toggleBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        toggleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        noteField.style.display = btn.dataset.val === 'not_collected' ? '' : 'none';
      });
    });

    // Submit
    overlay.querySelector('#earlyWrapupSubmitBtn').addEventListener('click', async () => {
      const status = overlay.querySelector('#earlyPaymentToggle .toggle-btn.active').dataset.val;
      const earlyData = {
        early_wrapup_reason: overlay.querySelector('#earlyWrapupReason').value.trim(),
        payment_status:      status,
        payment_note:        overlay.querySelector('#earlyPaymentNote')?.value.trim() || '',
        office_note:         overlay.querySelector('#earlyOfficeNote').value.trim(),
      };

      overlay.querySelector('#earlyWrapupSubmitBtn').disabled = true;
      overlay.querySelector('#earlyWrapupSubmitBtn').textContent = 'Submitting…';

      let gps = '';
      let gpsAccuracy = 0;
      if (typeof GPS !== 'undefined') {
        const pos = await GPS.getQuickPosition();
        if (pos) { gps = GPS.formatCoords(pos); gpsAccuracy = pos.accuracy || 0; }
      }

      if (navigator.onLine) {
        try {
          await OdooAPI.submitEarlyWrapup(job.id, { ...earlyData, gps, gps_accuracy: gpsAccuracy });
          overlay.remove();
          this._showClockOffPrompt(job, workerCount, 0, gps, gpsAccuracy);
        } catch (err) {
          App.showToast('Wrap-up failed: ' + err.message, 'error');
          const btn = document.querySelector('#earlyWrapupSubmitBtn');
          if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
        }
      } else {
        await DB.put('wrapupQueue', {
          temp_id: 'wu_' + Date.now(),
          order_id: job.id,
          type: 'early',
          data: { ...earlyData, gps, gps_accuracy: gpsAccuracy },
          timestamp: new Date().toISOString(),
          synced: 0,
        });
        overlay.remove();
        App.showToast('Wrap-up saved — will sync when online.', 'info');
        this._showClockOffPrompt(job, workerCount, 0, gps, gpsAccuracy);
      }
    });
  },

  // ── Clock-Off Prompt ────────────────────────────────────────────────────────

  /**
   * Show the clock-off decision prompt after a successful wrap-up.
   * @param {Object} job
   * @param {number} workerCount - total workers on the job (for checkbox label)
   * @param {number} alreadyClockedOut - workers the server already clocked out
   * @param {string} gps
   * @param {number} gpsAccuracy
   */
  _showClockOffPrompt(job, workerCount, alreadyClockedOut, gps, gpsAccuracy) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const showClockAllOff = workerCount > 1 && alreadyClockedOut === 0;
    const clockAllLabel = workerCount > 1
      ? `Clock all ${workerCount} workers off this job`
      : 'Clock off';

    overlay.innerHTML = `
      <div class="modal modal-clockoff">
        <div class="modal-header">
          <h3>✓ Wrap-Up Submitted</h3>
        </div>
        <div class="modal-body">
          ${alreadyClockedOut > 0
            ? `<p class="clockoff-note">${alreadyClockedOut} worker${alreadyClockedOut !== 1 ? 's' : ''} clocked off.</p>`
            : ''}
          ${showClockAllOff ? `
          <label class="wrapup-check-label" style="margin-bottom:var(--spacing-md);">
            <input type="checkbox" id="clockAllOffCheck" checked>
            <span>${this._esc(clockAllLabel)}</span>
          </label>` : ''}
        </div>
        <div class="modal-footer wrapup-footer">
          <button class="btn btn-primary btn-block btn-xl" id="clockOffBtn">
            Clock Off
          </button>
          <button class="btn btn-secondary btn-block" id="keepClockedInBtn">
            I Have Another Job / After-Work Duties
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Clock Off
    overlay.querySelector('#clockOffBtn').addEventListener('click', async () => {
      const clockAll = showClockAllOff && overlay.querySelector('#clockAllOffCheck')?.checked;
      overlay.remove();
      await this._handleClockOff(job, clockAll, gps, gpsAccuracy);
    });

    // Stay clocked in
    overlay.querySelector('#keepClockedInBtn').addEventListener('click', () => {
      overlay.remove();
      App.showToast('Still clocked in. Good luck on the next one!', 'info');
    });
  },

  async _handleClockOff(job, clockAll, gps, gpsAccuracy) {
    // Clock out all workers on the job via a dedicated server call
    if (clockAll && navigator.onLine) {
      try {
        await OdooAPI.clockOutJobWorkers(job.id, gps, gpsAccuracy);
      } catch (err) {
        console.warn('WrapUp: clock-out-all failed', err);
      }
    }

    // Clock out the submitting worker via the standard TimeTracking flow
    // (handles online/offline, updates client state)
    if (typeof TimeTracking !== 'undefined') {
      await TimeTracking.clockOut();
    }
  },

  // ── Utilities ───────────────────────────────────────────────────────────────

  /**
   * Fetch payment status from the Sales tab data and pre-populate the
   * "Payment not collected" checkbox accordingly.
   *
   * Paid / in-payment  → checkbox unchecked, green status line
   * Posted + unpaid    → checkbox checked, notice shown, amber status line
   * No invoice / no SO → checkbox enabled but unchecked, no status line
   */
  async _loadPaymentStatus(job, overlay) {
    const checkbox = overlay.querySelector('#paymentNotCollected');
    const statusInfo = overlay.querySelector('#paymentStatusInfo');
    const payNotice = overlay.querySelector('#paymentNotice');

    if (!job.sale_id) {
      // No sales order — nothing to check
      statusInfo.innerHTML = '';
      checkbox.disabled = false;
      return;
    }

    try {
      const data = await OdooAPI.getSaleOrder(job.id);
      const invoices = (data && data.invoices) || [];

      const paid = invoices.find(i =>
        i.payment_state === 'paid' || i.payment_state === 'in_payment'
      );
      const unpaid = invoices.find(i =>
        i.state === 'posted' &&
        i.payment_state !== 'paid' &&
        i.payment_state !== 'in_payment'
      );

      if (paid) {
        statusInfo.innerHTML =
          `<span class="wrapup-status-paid">✓ Invoice paid — ${this._esc(paid.name || '')}</span>`;
        checkbox.checked = false;
        checkbox.disabled = false;
      } else if (unpaid) {
        const due = unpaid.amount_residual != null
          ? ` · $${Number(unpaid.amount_residual).toFixed(2)} due`
          : '';
        statusInfo.innerHTML =
          `<span class="wrapup-status-unpaid">⚠ Invoice unpaid${due} — ${this._esc(unpaid.name || '')}</span>`;
        checkbox.checked = true;
        checkbox.disabled = false;
        payNotice.style.display = '';
      } else {
        // No posted invoices yet
        statusInfo.innerHTML = '';
        checkbox.checked = false;
        checkbox.disabled = false;
      }
    } catch (_) {
      // Fetch failed — leave checkbox enabled, no status line
      statusInfo.innerHTML = '';
      checkbox.disabled = false;
    }
  },

  /** Calculate how long the current worker has been clocked in today (rough). */
  _calcTimeOnSite() {
    try {
      if (typeof TimeTracking !== 'undefined' && TimeTracking._clockInTime) {
        const mins = Math.round((Date.now() - TimeTracking._clockInTime.getTime()) / 60000);
        if (mins < 60) return `${mins}m`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
      }
    } catch (_) {}
    return '';
  },

  _esc(v) {
    return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },
};

// Bind placement toggle once DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => WrapUp.init());
} else {
  WrapUp.init();
}
