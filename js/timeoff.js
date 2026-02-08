/**
 * Worker time off module.
 * Provides self-service leave request creation and status tracking.
 */
const TimeOff = {
  _initialized: false,
  _filter: 'pending',
  _requests: [],
  _leaveTypes: [],

  init() {
    if (this._initialized) return;
    this._initialized = true;
    this._bindEvents();
    this._setDefaultDates();
  },

  async openModal() {
    this.init();
    const modal = document.getElementById('timeOffModal');
    if (!modal) return;
    modal.style.display = 'flex';
    const multiDayEl = document.getElementById('timeOffMultiDay');
    if (multiDayEl) multiDayEl.checked = false;
    this._setDefaultDates();
    this._toggleMultiDay(false);

    await Promise.all([
      this._loadLeaveTypes(),
      this._loadRequests(this._filter),
    ]);
  },

  closeModal() {
    const modal = document.getElementById('timeOffModal');
    if (modal) modal.style.display = 'none';
  },

  _bindEvents() {
    const modal = document.getElementById('timeOffModal');
    const closeBtn = document.getElementById('timeOffClose');
    const cancelBtn = document.getElementById('timeOffCancel');
    const refreshBtn = document.getElementById('timeOffRefreshBtn');
    const submitBtn = document.getElementById('timeOffSubmit');
    const filterWrap = document.getElementById('timeOffFilters');
    const multiDayEl = document.getElementById('timeOffMultiDay');
    const fromEl = document.getElementById('timeOffDateFrom');

    closeBtn?.addEventListener('click', () => this.closeModal());
    cancelBtn?.addEventListener('click', () => this.closeModal());

    modal?.addEventListener('click', (e) => {
      if (e.target === modal) this.closeModal();
    });

    refreshBtn?.addEventListener('click', () => this._loadRequests(this._filter));
    submitBtn?.addEventListener('click', () => this._submitRequest());

    filterWrap?.addEventListener('click', (e) => {
      const btn = e.target.closest('.timeoff-worker-filter');
      if (!btn) return;
      document.querySelectorAll('.timeoff-worker-filter').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      this._filter = btn.dataset.filter || 'pending';
      this._loadRequests(this._filter);
    });

    multiDayEl?.addEventListener('change', () => {
      this._toggleMultiDay(!!multiDayEl.checked);
    });

    fromEl?.addEventListener('change', () => {
      if (multiDayEl && multiDayEl.checked) {
        this._setEndDateFromStart(true);
      }
    });
  },

  async _loadLeaveTypes() {
    const select = document.getElementById('timeOffLeaveType');
    if (!select) return;

    try {
      this._leaveTypes = await OdooAPI.getWorkerLeaveTypes();
      if (!this._leaveTypes || this._leaveTypes.length === 0) {
        select.innerHTML = '<option value="">No leave types available</option>';
        return;
      }
      select.innerHTML = '<option value="">Select type...</option>' + this._leaveTypes.map((t) =>
        `<option value="${t.id}">${this._esc(t.name)}</option>`
      ).join('');
    } catch (err) {
      select.innerHTML = '<option value="">Failed to load leave types</option>';
      this._toast('Failed to load leave types', 'error');
    }
  },

  async _loadRequests(filter) {
    const list = document.getElementById('timeOffList');
    if (!list) return;

    list.innerHTML = '<div class="timeoff-worker-loading">Loading requests...</div>';

    try {
      const stateFilter = filter === 'all' ? false : filter;
      this._requests = await OdooAPI.getMyTimeOffRequests(stateFilter);
      this._renderList(this._requests);
      this._updateSummary();
    } catch (err) {
      list.innerHTML = '<div class="timeoff-worker-empty">Failed to load requests</div>';
      this._toast('Failed to load requests', 'error');
    }
  },

  _renderList(requests) {
    const list = document.getElementById('timeOffList');
    if (!list) return;

    if (!requests || requests.length === 0) {
      list.innerHTML = '<div class="timeoff-worker-empty">No requests found</div>';
      return;
    }

    list.innerHTML = requests.map((r) => {
      const type = this._esc(r.leave_type || 'Time Off');
      const stateLabel = this._stateLabel(r.state);
      const stateClass = this._stateClass(r.state);
      const dateRange = `${this._formatDate(r.date_from)} to ${this._formatDate(r.date_to)}`;
      const days = r.number_of_days ? `${r.number_of_days} day${r.number_of_days === 1 ? '' : 's'}` : '';
      const notes = r.notes ? `<div class="timeoff-worker-notes">${this._esc(r.notes)}</div>` : '';

      return `<div class="timeoff-worker-card">
        <div class="timeoff-worker-card-top">
          <span class="timeoff-worker-type">${type}</span>
          <span class="timeoff-worker-status ${stateClass}">${stateLabel}</span>
        </div>
        <div class="timeoff-worker-date">${dateRange}</div>
        ${days ? `<div class="timeoff-worker-days">${days}</div>` : ''}
        ${notes}
      </div>`;
    }).join('');
  },

  _updateSummary() {
    const pendingEl = document.getElementById('timeOffPendingCount');
    const upcomingEl = document.getElementById('timeOffUpcomingCount');
    if (!pendingEl || !upcomingEl) return;

    const pendingCount = this._requests.filter((r) =>
      r.state === 'confirm' || r.state === 'validate1'
    ).length;

    const now = new Date();
    const upcomingCount = this._requests.filter((r) => {
      if (r.state !== 'validate' || !r.date_to) return false;
      const end = new Date(r.date_to.replace(' ', 'T') + 'Z');
      return end >= now;
    }).length;

    pendingEl.textContent = String(pendingCount);
    upcomingEl.textContent = String(upcomingCount);
  },

  async _submitRequest() {
    const leaveTypeEl = document.getElementById('timeOffLeaveType');
    const fromEl = document.getElementById('timeOffDateFrom');
    const toEl = document.getElementById('timeOffDateTo');
    const multiDayEl = document.getElementById('timeOffMultiDay');
    const notesEl = document.getElementById('timeOffNotes');
    const submitBtn = document.getElementById('timeOffSubmit');

    if (!leaveTypeEl || !fromEl || !toEl || !notesEl || !submitBtn) return;
    if (!navigator.onLine) {
      this._toast('Go online to submit time off requests', 'error');
      return;
    }

    const leaveTypeId = parseInt(leaveTypeEl.value, 10);
    const dateFrom = fromEl.value;
    const isMultiDay = multiDayEl && multiDayEl.checked;
    const dateTo = isMultiDay ? toEl.value : dateFrom;
    const notes = notesEl.value.trim();

    if (!leaveTypeId) {
      this._toast('Select a leave type', 'error');
      return;
    }
    if (!dateFrom) {
      this._toast('Select a date', 'error');
      return;
    }
    if (isMultiDay && !dateTo) {
      this._toast('Select an end date', 'error');
      return;
    }
    if (isMultiDay && dateFrom > dateTo) {
      this._toast('Start date must be before end date', 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      const result = await OdooAPI.createMyTimeOff(
        leaveTypeId,
        dateFrom + ' 00:00:00',
        dateTo + ' 23:59:59',
        notes || false
      );

      if (result && result.success) {
        this._toast('Time off request submitted', 'success');
        notesEl.value = '';
        this._filter = 'pending';
        this._setFilterButton('pending');
        await this._loadRequests(this._filter);
      } else {
        const errMsg = (result && result.error) ? result.error : 'Failed to submit request';
        this._toast(errMsg, 'error');
      }
    } catch (err) {
      this._toast('Failed to submit request: ' + (err.message || err), 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Request';
    }
  },

  _setFilterButton(filter) {
    document.querySelectorAll('.timeoff-worker-filter').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });
  },

  _setDefaultDates() {
    const fromEl = document.getElementById('timeOffDateFrom');
    const toEl = document.getElementById('timeOffDateTo');
    if (!fromEl || !toEl) return;

    if (!fromEl.value) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      fromEl.value = tomorrow.toISOString().slice(0, 10);
    }
    if (!toEl.value) {
      toEl.value = this._addDays(fromEl.value, 1) || fromEl.value;
    }
  },

  _toggleMultiDay(enabled) {
    const wrap = document.getElementById('timeOffEndDateWrap');
    const fromLabel = document.getElementById('timeOffDateFromLabel');

    if (wrap) wrap.style.display = enabled ? '' : 'none';
    if (fromLabel) fromLabel.textContent = enabled ? 'Start Date' : 'Date';

    if (enabled) {
      this._setEndDateFromStart(true);
    }
  },

  _setEndDateFromStart(force) {
    const fromEl = document.getElementById('timeOffDateFrom');
    const toEl = document.getElementById('timeOffDateTo');
    if (!fromEl || !toEl || !fromEl.value) return;

    const suggested = this._addDays(fromEl.value, 1);
    if (!suggested) return;

    if (force || !toEl.value || toEl.value <= fromEl.value) {
      toEl.value = suggested;
    }
  },

  _addDays(dateStr, days) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return '';
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  },

  _stateLabel(state) {
    const labels = {
      draft: 'Draft',
      confirm: 'Pending',
      validate1: 'Pending',
      validate: 'Approved',
      refuse: 'Refused',
      cancel: 'Cancelled',
    };
    return labels[state] || state || 'Unknown';
  },

  _stateClass(state) {
    if (state === 'confirm' || state === 'validate1') return 'status-pending';
    if (state === 'validate') return 'status-approved';
    if (state === 'refuse' || state === 'cancel') return 'status-refused';
    return 'status-draft';
  },

  _formatDate(dt) {
    if (!dt) return '--';
    const d = new Date(dt.replace(' ', 'T') + 'Z');
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  },

  _toast(msg, type) {
    if (typeof App !== 'undefined' && App.showToast) {
      App.showToast(msg, type || 'info');
      return;
    }
    console.log(msg);
  },

  _esc(str) {
    if (!str) return '';
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  },
};
