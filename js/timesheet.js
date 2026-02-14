/**
 * Timesheet module.
 * Provides weekly attendance history viewing and change request submission.
 */
const Timesheet = {
  _initialized: false,
  _weekStart: null,
  _weekEnd: null,
  _records: [],

  init() {
    if (this._initialized) return;
    this._initialized = true;
    this._bindEvents();
  },

  async openModal() {
    this.init();
    const modal = document.getElementById('timesheetModal');
    if (!modal) return;
    modal.style.display = 'flex';
    this._setCurrentWeek();
    await this._loadHistory();
  },

  closeModal() {
    const modal = document.getElementById('timesheetModal');
    if (modal) modal.style.display = 'none';
  },

  _bindEvents() {
    const modal = document.getElementById('timesheetModal');
    const closeBtn = document.getElementById('timesheetClose');
    const closeBtnFooter = document.getElementById('timesheetCloseBtn');
    const prevBtn = document.getElementById('timesheetPrev');
    const nextBtn = document.getElementById('timesheetNext');

    closeBtn?.addEventListener('click', () => this.closeModal());
    closeBtnFooter?.addEventListener('click', () => this.closeModal());
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) this.closeModal();
    });

    prevBtn?.addEventListener('click', () => {
      this._weekStart.setDate(this._weekStart.getDate() - 7);
      this._weekEnd.setDate(this._weekEnd.getDate() - 7);
      this._updateWeekLabel();
      this._loadHistory();
    });

    nextBtn?.addEventListener('click', () => {
      this._weekStart.setDate(this._weekStart.getDate() + 7);
      this._weekEnd.setDate(this._weekEnd.getDate() + 7);
      this._updateWeekLabel();
      this._loadHistory();
    });
  },

  _setCurrentWeek() {
    const now = new Date();
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1; // Monday start
    this._weekStart = new Date(now);
    this._weekStart.setDate(now.getDate() - diff);
    this._weekStart.setHours(0, 0, 0, 0);

    this._weekEnd = new Date(this._weekStart);
    this._weekEnd.setDate(this._weekStart.getDate() + 6);
    this._weekEnd.setHours(23, 59, 59, 999);

    this._updateWeekLabel();
  },

  _updateWeekLabel() {
    const label = document.getElementById('timesheetWeekLabel');
    if (!label) return;
    const opts = { month: 'short', day: 'numeric' };
    const startStr = this._weekStart.toLocaleDateString(undefined, opts);
    const endStr = this._weekEnd.toLocaleDateString(undefined, opts);
    label.textContent = startStr + ' – ' + endStr;
  },

  _formatDateParam(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  },

  async _loadHistory() {
    const listEl = document.getElementById('timesheetList');
    if (!listEl) return;

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      listEl.innerHTML = '<div class="timesheet-empty">Go online to view timesheet</div>';
      this._updateTotal();
      return;
    }

    listEl.innerHTML = '<div class="timesheet-loading">Loading...</div>';

    try {
      const empId = typeof Auth !== 'undefined' ? Auth.getEmployeeId() : null;
      if (!empId) {
        listEl.innerHTML = '<div class="timesheet-empty">Not logged in</div>';
        return;
      }

      const dateFrom = this._formatDateParam(this._weekStart);
      const dateTo = this._formatDateParam(this._weekEnd);
      const res = await OdooAPI.getAttendanceHistory(empId, dateFrom, dateTo);

      if (!res || !res.success) {
        listEl.innerHTML = '<div class="timesheet-empty">' + this._esc(res?.error || 'Failed to load') + '</div>';
        this._records = [];
        this._updateTotal();
        return;
      }

      this._records = res.records || [];
      this._renderList();
      this._updateTotal();
    } catch (err) {
      listEl.innerHTML = '<div class="timesheet-empty">Error loading timesheet</div>';
      this._records = [];
      this._updateTotal();
    }
  },

  _renderList() {
    const listEl = document.getElementById('timesheetList');
    if (!listEl) return;

    if (!this._records.length) {
      listEl.innerHTML = '<div class="timesheet-empty">No shifts this week</div>';
      return;
    }

    let html = '';
    for (const rec of this._records) {
      const checkIn = this._parseOdooDt(rec.check_in);
      const checkOut = rec.check_out ? this._parseOdooDt(rec.check_out) : null;
      const dayName = checkIn ? checkIn.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '--';
      const inTime = checkIn ? this._formatTime(checkIn) : '--';
      const outTime = checkOut ? this._formatTime(checkOut) : 'Open';
      const hours = (rec.worked_hours || 0).toFixed(1);

      let statusHtml = '';
      if (rec.auto_clock_out) {
        statusHtml = '<span class="timesheet-card-status status-warning">Auto Clock Out</span>';
      } else if (rec.needs_review && !rec.manager_approved) {
        statusHtml = '<span class="timesheet-card-status status-pending">Pending Review</span>';
      } else if (rec.manager_approved) {
        statusHtml = '<span class="timesheet-card-status status-approved">Approved</span>';
      }

      let lunchHtml = '';
      if (rec.lunch_start || rec.lunch_end) {
        const ls = rec.lunch_start ? this._formatTime(this._parseOdooDt(rec.lunch_start)) : '--';
        const le = rec.lunch_end ? this._formatTime(this._parseOdooDt(rec.lunch_end)) : '--';
        lunchHtml = '<div class="timesheet-card-lunch">Lunch: ' + ls + ' – ' + le + '</div>';
      }

      let reasonHtml = '';
      if (rec.adjustment_reason) {
        reasonHtml = '<div class="timesheet-card-reason">' + this._esc(rec.adjustment_reason) + '</div>';
      }

      const clickable = checkOut ? ' onclick="Timesheet._showChangeRequestModal(' + rec.id + ')"' : '';

      html += '<div class="timesheet-card"' + clickable + '>'
        + '<div class="timesheet-card-top">'
        + '<span class="timesheet-card-day">' + this._esc(dayName) + '</span>'
        + statusHtml
        + '</div>'
        + '<div class="timesheet-card-times">'
        + '<span>' + inTime + ' → ' + outTime + '</span>'
        + '<span class="timesheet-card-hours">' + hours + ' hrs</span>'
        + '</div>'
        + lunchHtml
        + reasonHtml
        + '</div>';
    }

    listEl.innerHTML = html;
  },

  _updateTotal() {
    const totalEl = document.getElementById('timesheetTotal');
    if (!totalEl) return;
    const sum = this._records.reduce((acc, r) => acc + (r.worked_hours || 0), 0);
    totalEl.textContent = 'Total: ' + sum.toFixed(1) + ' hrs';
  },

  _showChangeRequestModal(attendanceId) {
    const rec = this._records.find(r => r.id === attendanceId);
    if (!rec) return;

    const checkIn = this._parseOdooDt(rec.check_in);
    const checkOut = rec.check_out ? this._parseOdooDt(rec.check_out) : null;
    const lunchEnd = rec.lunch_end ? this._parseOdooDt(rec.lunch_end) : null;

    const inVal = checkIn ? this._toTimeInputValue(checkIn) : '';
    const outVal = checkOut ? this._toTimeInputValue(checkOut) : '';
    const leVal = lunchEnd ? this._toTimeInputValue(lunchEnd) : '';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '2100';

    overlay.innerHTML = '<div class="modal modal-timesheet-change">'
      + '<div class="modal-header"><h3>Request Change</h3>'
      + '<button class="modal-close" id="tsChangeClose">&times;</button></div>'
      + '<div class="modal-body">'
      + '<div class="form-group"><label>Clock In</label>'
      + '<input type="time" class="form-input" id="tsChangeIn" value="' + inVal + '"></div>'
      + '<div class="form-group"><label>Clock Out</label>'
      + '<input type="time" class="form-input" id="tsChangeOut" value="' + outVal + '"></div>'
      + (rec.lunch_end ? '<div class="form-group"><label>Lunch End</label>'
        + '<input type="time" class="form-input" id="tsChangeLunch" value="' + leVal + '"></div>' : '')
      + '<div class="form-group"><label>Reason *</label>'
      + '<textarea class="form-input" id="tsChangeReason" rows="2" placeholder="Why does this need to change?"></textarea></div>'
      + '</div>'
      + '<div class="modal-footer">'
      + '<button class="btn btn-secondary" id="tsChangeCancel">Cancel</button>'
      + '<button class="btn btn-primary" id="tsChangeSubmit">Submit</button>'
      + '</div></div>';

    document.body.appendChild(overlay);

    const close = () => { overlay.remove(); };
    overlay.querySelector('#tsChangeClose').addEventListener('click', close);
    overlay.querySelector('#tsChangeCancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#tsChangeSubmit').addEventListener('click', async () => {
      const reason = (overlay.querySelector('#tsChangeReason')?.value || '').trim();
      if (!reason) {
        this._toast('Please enter a reason', 'error');
        return;
      }

      const changes = {};
      const newIn = overlay.querySelector('#tsChangeIn')?.value;
      const newOut = overlay.querySelector('#tsChangeOut')?.value;
      const newLunch = overlay.querySelector('#tsChangeLunch')?.value;

      if (newIn && newIn !== inVal) {
        changes.check_in = this._buildDatetime(checkIn, newIn);
      }
      if (newOut && newOut !== outVal) {
        changes.check_out = this._buildDatetime(checkOut || checkIn, newOut);
      }
      if (newLunch && newLunch !== leVal) {
        changes.lunch_end = this._buildDatetime(lunchEnd || checkIn, newLunch);
      }

      if (!Object.keys(changes).length) {
        this._toast('No changes made', 'error');
        return;
      }

      const submitBtn = overlay.querySelector('#tsChangeSubmit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';

      try {
        const res = await OdooAPI.requestTimesheetChange(attendanceId, changes, reason);
        if (res && res.success) {
          this._toast('Change request submitted');
          close();
          await this._loadHistory();
        } else {
          this._toast(res?.error || 'Failed to submit', 'error');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit';
        }
      } catch (err) {
        this._toast('Error submitting request', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit';
      }
    });
  },

  // --- Helpers ---

  _parseOdooDt(str) {
    if (!str) return null;
    const s = str.replace(' ', 'T');
    const d = new Date(s + 'Z'); // Odoo stores UTC
    return isNaN(d.getTime()) ? null : d;
  },

  _formatTime(dt) {
    if (!dt) return '--';
    return dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  },

  _toTimeInputValue(dt) {
    if (!dt) return '';
    return String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
  },

  _buildDatetime(refDate, timeStr) {
    // Combine the date portion of refDate with the new time, output as Odoo UTC string
    const parts = timeStr.split(':');
    const d = new Date(refDate.getTime());
    d.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
    // Convert back to UTC string — refDate was already displayed in local, so d is local
    const utc = new Date(d.getTime());
    const y = utc.getUTCFullYear();
    const mo = String(utc.getUTCMonth() + 1).padStart(2, '0');
    const dy = String(utc.getUTCDate()).padStart(2, '0');
    const h = String(utc.getUTCHours()).padStart(2, '0');
    const mi = String(utc.getUTCMinutes()).padStart(2, '0');
    const se = String(utc.getUTCSeconds()).padStart(2, '0');
    return y + '-' + mo + '-' + dy + ' ' + h + ':' + mi + ':' + se;
  },

  _esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  },

  _toast(msg, type) {
    // Reuse app-level toast if available
    if (typeof App !== 'undefined' && App.toast) {
      App.toast(msg, type);
      return;
    }
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const t = document.createElement('div');
    t.className = 'toast' + (type === 'error' ? ' toast-error' : '');
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  },
};
