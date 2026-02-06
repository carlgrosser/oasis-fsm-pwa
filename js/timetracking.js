/**
 * Time Tracking module — clock on/off and lunch breaks.
 * Integrates with hr_attendance_gps Odoo module via mobile API methods.
 */
const TimeTracking = {
  _status: 'out',        // 'out' | 'in' | 'break'
  _attendanceId: null,
  _clockInTime: null,
  _lunchStartTime: null,
  _timerInterval: null,
  _autoClockOutPromptActive: false,

  /**
   * Initialize time tracking state.
   * Fetches current attendance from Odoo or restores from local DB.
   */
  async init() {
    const employeeId = Auth.getEmployeeId();
    if (!employeeId) {
      this._renderHeaderButton();
      return;
    }

    // Try to restore state from Odoo
    if (navigator.onLine) {
      try {
        const att = await OdooAPI.getCurrentAttendance(employeeId);
        if (att && att.attendance_id) {
          this._attendanceId = att.attendance_id;
          this._clockInTime = att.check_in ? this._parseOdooDatetime(att.check_in) : new Date();

          if (att.lunch_start && !att.lunch_end) {
            this._status = 'break';
            this._lunchStartTime = this._parseOdooDatetime(att.lunch_start);
            this._startLunchTimer();
          } else {
            this._status = 'in';
          }
          await this._saveState();
        } else {
          this._status = 'out';
          this._attendanceId = null;
          await this._saveState();
        }
      } catch (err) {
        console.warn('Failed to fetch attendance, restoring from cache:', err);
        await this._restoreState();
      }
    } else {
      await this._restoreState();
    }

    this._renderHeaderButton();
  },

  /**
   * Clock in — capture GPS and create attendance.
   */
  async clockIn() {
    const employeeId = Auth.getEmployeeId();
    if (!employeeId) {
      App.showToast('No employee profile linked. Contact admin.', 'error');
      return false;
    }

    let gpsCoords = '';
    let gpsAccuracy = 0;
    if (typeof GPS !== 'undefined') {
      const pos = await GPS.getQuickPosition();
      if (pos) {
        gpsCoords = GPS.formatCoords(pos);
        gpsAccuracy = pos.accuracy || 0;
      }
    }

    if (navigator.onLine) {
      try {
        const result = await OdooAPI.clockIn(employeeId, gpsCoords, gpsAccuracy);
        if (result && result.success) {
          this._attendanceId = result.attendance_id;
          this._clockInTime = new Date();
          this._status = 'in';
          await this._saveState();
          this._renderHeaderButton();
          App.showToast('Clocked on', 'success');
          await this._maybePromptAutoClockOut();
          return true;
        } else {
          const errMsg = (result && result.error) || 'Clock on failed';
          App.showToast(errMsg, 'error');
          return false;
        }
      } catch (err) {
        App.showToast('Clock on failed: ' + err.message, 'error');
        return false;
      }
    } else {
      // Queue for sync
      await DB.put('timeEntries', {
        temp_id: 'te_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        action: 'clock_in',
        employee_id: employeeId,
        gps: gpsCoords,
        gps_accuracy: gpsAccuracy,
        timestamp: new Date().toISOString(),
        synced: 0,
      });
      this._clockInTime = new Date();
      this._status = 'in';
      await this._saveState();
      this._renderHeaderButton();
      App.showToast('Clocked on (will sync when online)', 'info');
      await this._maybePromptAutoClockOut();
      return true;
    }
  },

  /**
   * Clock out — capture GPS and close attendance.
   */
  async clockOut() {
    let gpsCoords = '';
    let gpsAccuracy = 0;
    if (typeof GPS !== 'undefined') {
      const pos = await GPS.getQuickPosition();
      if (pos) {
        gpsCoords = GPS.formatCoords(pos);
        gpsAccuracy = pos.accuracy || 0;
      }
    }

    if (navigator.onLine && this._attendanceId) {
      try {
        const result = await OdooAPI.clockOut(this._attendanceId, gpsCoords, gpsAccuracy);
        if (result && result.success) {
          this._stopLunchTimer();
          this._status = 'out';
          this._attendanceId = null;
          this._clockInTime = null;
          this._lunchStartTime = null;
          await this._saveState();
          this._renderHeaderButton();
          App.showToast('Clocked off', 'success');
          await this._maybePromptAutoClockOut();
          return true;
        } else {
          const errMsg = (result && result.error) || 'Clock off failed';
          App.showToast(errMsg, 'error');
          return false;
        }
      } catch (err) {
        App.showToast('Clock off failed: ' + err.message, 'error');
        return false;
      }
    } else if (!this._attendanceId) {
      // No attendance ID — force reset state
      this._stopLunchTimer();
      this._status = 'out';
      this._clockInTime = null;
      this._lunchStartTime = null;
      await this._saveState();
      this._renderHeaderButton();
      App.showToast('Clocked off', 'success');
      await this._maybePromptAutoClockOut();
      return true;
    } else {
      // Queue for sync
      await DB.put('timeEntries', {
        temp_id: 'te_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        action: 'clock_out',
        attendance_id: this._attendanceId,
        employee_id: Auth.getEmployeeId(),
        gps: gpsCoords,
        gps_accuracy: gpsAccuracy,
        timestamp: new Date().toISOString(),
        synced: 0,
      });
      this._stopLunchTimer();
      this._status = 'out';
      this._attendanceId = null;
      this._clockInTime = null;
      this._lunchStartTime = null;
      await this._saveState();
      this._renderHeaderButton();
      App.showToast('Clocked off (will sync when online)', 'info');
      await this._maybePromptAutoClockOut();
      return true;
    }
    return false;
  },

  /**
   * Start lunch break.
   */
  async startLunch() {
    let gpsCoords = '';
    if (typeof GPS !== 'undefined') {
      const pos = await GPS.getQuickPosition();
      if (pos) gpsCoords = GPS.formatCoords(pos);
    }

    if (navigator.onLine && this._attendanceId) {
      try {
        const result = await OdooAPI.startLunch(this._attendanceId, gpsCoords);
        if (result && result.success) {
          this._status = 'break';
          this._lunchStartTime = new Date();
          this._startLunchTimer();
          await this._saveState();
          this._renderHeaderButton();
          App.showToast('Lunch break started', 'success');
          return true;
        } else {
          const errMsg = (result && result.error) || 'Failed to start break';
          App.showToast(errMsg, 'error');
          return false;
        }
      } catch (err) {
        App.showToast('Failed to start break: ' + err.message, 'error');
        return false;
      }
    } else {
      await DB.put('timeEntries', {
        temp_id: 'te_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        action: 'start_lunch',
        attendance_id: this._attendanceId,
        employee_id: Auth.getEmployeeId(),
        gps: gpsCoords,
        timestamp: new Date().toISOString(),
        synced: 0,
      });
      this._status = 'break';
      this._lunchStartTime = new Date();
      this._startLunchTimer();
      await this._saveState();
      this._renderHeaderButton();
      App.showToast('Lunch break started (will sync when online)', 'info');
      return true;
    }
    return false;
  },

  /**
   * End lunch break.
   */
  async endLunch() {
    if (navigator.onLine && this._attendanceId) {
      try {
        const result = await OdooAPI.endLunch(this._attendanceId);
        if (result && result.success) {
          this._status = 'in';
          this._stopLunchTimer();
          this._lunchStartTime = null;
          await this._saveState();
          this._renderHeaderButton();
          App.showToast('Lunch break ended', 'success');
          return true;
        } else {
          const errMsg = (result && result.error) || 'Failed to end break';
          App.showToast(errMsg, 'error');
          return false;
        }
      } catch (err) {
        App.showToast('Failed to end break: ' + err.message, 'error');
        return false;
      }
    } else {
      await DB.put('timeEntries', {
        temp_id: 'te_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        action: 'end_lunch',
        attendance_id: this._attendanceId,
        employee_id: Auth.getEmployeeId(),
        timestamp: new Date().toISOString(),
        synced: 0,
      });
      this._status = 'in';
      this._stopLunchTimer();
      this._lunchStartTime = null;
      await this._saveState();
      this._renderHeaderButton();
      App.showToast('Lunch break ended (will sync when online)', 'info');
      return true;
    }
    return false;
  },

  /**
   * Ensure the worker is clocked in before proceeding.
   * Shows a prompt if not clocked in. Returns true if clocked in.
   */
  async ensureClockedIn() {
    if (this._status === 'in' || this._status === 'break') return true;
    if (!Auth.getEmployeeId()) return true; // skip gate if no employee record

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal">
          <div class="modal-header">
            <h3>Clock On Required</h3>
            <button class="modal-close">&times;</button>
          </div>
          <div class="modal-body">
            <p>You must be clocked on before going en route. Clock on now?</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="clockGateNo">No</button>
            <button class="btn btn-success" id="clockGateYes">Clock On</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const close = (result) => {
        overlay.remove();
        resolve(result);
      };

      overlay.querySelector('.modal-close').addEventListener('click', () => close(false));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });
      document.getElementById('clockGateNo').addEventListener('click', () => close(false));
      document.getElementById('clockGateYes').addEventListener('click', async () => {
        const btn = document.getElementById('clockGateYes');
        btn.disabled = true;
        btn.textContent = 'Clocking on...';
        const success = await this.clockIn();
        close(success);
      });
    });
  },

  /**
   * Show the clock off dialog — Lunch Break or Clock Off.
   */
  showClockOffDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Clock Off</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div style="display:flex; flex-direction:column; gap:var(--spacing-sm);">
            <button class="btn btn-warning btn-block btn-lg" id="clockLunchBtn">Lunch Break</button>
            <button class="btn btn-danger btn-block btn-lg" id="clockOffBtn">Clock Off</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();

    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    document.getElementById('clockLunchBtn').addEventListener('click', async () => {
      const btn = document.getElementById('clockLunchBtn');
      btn.disabled = true;
      btn.textContent = 'Starting break...';
      document.getElementById('clockOffBtn').disabled = true;
      await this.startLunch();
      close();
    });

    document.getElementById('clockOffBtn').addEventListener('click', async () => {
      const btn = document.getElementById('clockOffBtn');
      btn.disabled = true;
      btn.textContent = 'Clocking off...';
      document.getElementById('clockLunchBtn').disabled = true;
      await this.clockOut();
      close();
    });
  },

  /**
   * Handle the header clock button click.
   */
  async handleHeaderClick() {
    if (this._status === 'out') {
      await this.clockIn();
    } else if (this._status === 'in') {
      this.showClockOffDialog();
    } else if (this._status === 'break') {
      await this.endLunch();
    }
  },

  /**
   * Render the header clock button based on current status.
   */
  _renderHeaderButton() {
    const btn = document.getElementById('clockBtn');
    const timer = document.getElementById('lunchTimer');
    if (!btn) return;

    btn.style.display = '';

    if (this._status === 'out') {
      btn.className = 'clock-btn state-out';
      btn.textContent = 'Clock On';
      if (timer) timer.style.display = 'none';
    } else if (this._status === 'in') {
      btn.className = 'clock-btn state-in';
      btn.textContent = 'Clock Off';
      if (timer) timer.style.display = 'none';
    } else if (this._status === 'break') {
      btn.className = 'clock-btn state-break';
      btn.textContent = 'End Break';
      if (timer) timer.style.display = '';
    }
  },

  // ========== LUNCH TIMER ==========

  _startLunchTimer() {
    this._stopLunchTimer();
    this._updateLunchTimer();
    this._timerInterval = setInterval(() => this._updateLunchTimer(), 1000);
  },

  _stopLunchTimer() {
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
    const timer = document.getElementById('lunchTimer');
    if (timer) timer.style.display = 'none';
  },

  _updateLunchTimer() {
    const timer = document.getElementById('lunchTimer');
    if (!timer || !this._lunchStartTime) return;

    const elapsed = Math.floor((Date.now() - this._lunchStartTime.getTime()) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    timer.textContent = mins + ':' + String(secs).padStart(2, '0');
    timer.style.display = '';
  },

  // ========== STATE PERSISTENCE ==========

  async _saveState() {
    await DB.setState('attendance', {
      status: this._status,
      attendanceId: this._attendanceId,
      clockInTime: this._clockInTime ? this._clockInTime.toISOString() : null,
      lunchStartTime: this._lunchStartTime ? this._lunchStartTime.toISOString() : null,
    });
  },

  async _restoreState() {
    const state = await DB.getState('attendance');
    if (state) {
      this._status = state.status || 'out';
      this._attendanceId = state.attendanceId || null;
      this._clockInTime = state.clockInTime ? new Date(state.clockInTime) : null;
      this._lunchStartTime = state.lunchStartTime ? new Date(state.lunchStartTime) : null;
      if (this._status === 'break' && this._lunchStartTime) {
        this._startLunchTimer();
      }
    }
  },

  // ========== AUTO CLOCK-OUT CORRECTION ==========

  async _maybePromptAutoClockOut() {
    if (!navigator.onLine) return false;
    if (!Auth.getEmployeeId()) return false;
    if (this._autoClockOutPromptActive) return false;

    try {
      const pending = await OdooAPI.getPendingAutoClockOut(Auth.getEmployeeId());
      if (!pending || !pending.attendance_id) return false;
      return await this._showAutoClockOutPrompt(pending);
    } catch (err) {
      console.warn('Failed to check auto clock-out status:', err);
      return false;
    }
  },

  async manualAdjustShift() {
    if (!navigator.onLine) {
      App.showToast('Go online to update shift time.', 'error');
      return false;
    }
    const employeeId = Auth.getEmployeeId();
    if (!employeeId) {
      App.showToast('No employee profile linked. Contact admin.', 'error');
      return false;
    }
    if (this._autoClockOutPromptActive) return false;

    try {
      const pending = await OdooAPI.getLastShiftForAdjustment(employeeId);
      if (!pending || !pending.attendance_id) {
        App.showToast('No shift found to update for today.', 'info');
        return false;
      }
      return await this._showManualShiftAdjustPrompt(pending);
    } catch (err) {
      App.showToast('Unable to load shift for update.', 'error');
      return false;
    }
  },

  _showAutoClockOutPrompt(pending) {
    const checkIn = this._parseOdooDatetime(pending.check_in);
    const autoOut = this._parseOdooDatetime(pending.check_out);
    const dateLabel = checkIn ? checkIn.toLocaleDateString() : '';
    const defaultTime = autoOut ? autoOut.toTimeString().slice(0, 5) : '17:00';

    this._autoClockOutPromptActive = true;
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal">
          <div class="modal-header">
            <h3>Finish Time Needed</h3>
            <button class="modal-close">&times;</button>
          </div>
          <div class="modal-body">
            <p>You forgot to clock off on ${dateLabel}. What time did your shift end?</p>
            <div style="margin-top: var(--spacing-sm);">
              <label for="autoClockOutTime" style="display:block; margin-bottom:6px;">End Time</label>
              <input id="autoClockOutTime" type="time" class="form-input" value="${defaultTime}" />
              <p style="margin-top:8px; font-size: 0.9em; color: var(--color-muted);">
                We auto clocked you out at ${autoOut ? autoOut.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'end of day'}.
              </p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="autoClockOutSkip">Skip</button>
            <button class="btn btn-success" id="autoClockOutSave">Save</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const close = (result) => {
        this._autoClockOutPromptActive = false;
        overlay.remove();
        resolve(result);
      };

      const handleSave = async () => {
        const input = document.getElementById('autoClockOutTime');
        const timeVal = input ? input.value : '';
        if (!timeVal || !checkIn) {
          App.showToast('Please enter an end time.', 'error');
          return;
        }
        const [hh, mm] = timeVal.split(':').map((n) => parseInt(n, 10));
        const endLocal = new Date(
          checkIn.getFullYear(),
          checkIn.getMonth(),
          checkIn.getDate(),
          isNaN(hh) ? 0 : hh,
          isNaN(mm) ? 0 : mm,
          0
        );
        if (endLocal < checkIn) {
          App.showToast('End time cannot be before check-in.', 'error');
          return;
        }
        if (endLocal > new Date()) {
          App.showToast('End time cannot be in the future.', 'error');
          return;
        }

        const btn = document.getElementById('autoClockOutSave');
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Saving...';
        }

        const result = await OdooAPI.correctAutoClockOut(pending.attendance_id, endLocal.toISOString());
        if (result && result.success) {
          App.showToast('Shift end time updated', 'success');
          close(true);
          setTimeout(() => this._maybePromptAutoClockOut(), 0);
        } else {
          const errMsg = (result && result.error) || 'Failed to update shift end time';
          App.showToast(errMsg, 'error');
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Save';
          }
        }
      };

      overlay.querySelector('.modal-close').addEventListener('click', () => close(false));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });
      document.getElementById('autoClockOutSkip').addEventListener('click', () => close(false));
      document.getElementById('autoClockOutSave').addEventListener('click', handleSave);
    });
  },

  _showManualShiftAdjustPrompt(pending) {
    const checkIn = this._parseOdooDatetime(pending.check_in);
    const checkOut = this._parseOdooDatetime(pending.check_out);
    const dateLabel = checkIn ? checkIn.toLocaleDateString() : '';
    const defaultTime = checkOut
      ? checkOut.toTimeString().slice(0, 5)
      : new Date().toTimeString().slice(0, 5);

    this._autoClockOutPromptActive = true;
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal">
          <div class="modal-header">
            <h3>Update Shift End</h3>
            <button class="modal-close">&times;</button>
          </div>
          <div class="modal-body">
            <p>Update your shift end time for ${dateLabel}.</p>
            <div style="margin-top: var(--spacing-sm);">
              <label for="manualShiftEndTime" style="display:block; margin-bottom:6px;">End Time</label>
              <input id="manualShiftEndTime" type="time" class="form-input" value="${defaultTime}" />
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="manualShiftCancel">Cancel</button>
            <button class="btn btn-success" id="manualShiftSave">Save</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const close = (result) => {
        this._autoClockOutPromptActive = false;
        overlay.remove();
        resolve(result);
      };

      const handleSave = async () => {
        const input = document.getElementById('manualShiftEndTime');
        const timeVal = input ? input.value : '';
        if (!timeVal || !checkIn) {
          App.showToast('Please enter an end time.', 'error');
          return;
        }
        const [hh, mm] = timeVal.split(':').map((n) => parseInt(n, 10));
        const endLocal = new Date(
          checkIn.getFullYear(),
          checkIn.getMonth(),
          checkIn.getDate(),
          isNaN(hh) ? 0 : hh,
          isNaN(mm) ? 0 : mm,
          0
        );
        if (endLocal < checkIn) {
          App.showToast('End time cannot be before check-in.', 'error');
          return;
        }
        if (endLocal > new Date()) {
          App.showToast('End time cannot be in the future.', 'error');
          return;
        }

        const btn = document.getElementById('manualShiftSave');
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Saving...';
        }

        const result = await OdooAPI.adjustShiftEnd(pending.attendance_id, endLocal.toISOString());
        if (result && result.success) {
          App.showToast('Shift end time updated', 'success');
          if (this._attendanceId && this._attendanceId === pending.attendance_id) {
            this._stopLunchTimer();
            this._status = 'out';
            this._attendanceId = null;
            this._clockInTime = null;
            this._lunchStartTime = null;
            await this._saveState();
            this._renderHeaderButton();
          }
          close(true);
        } else {
          const errMsg = (result && result.error) || 'Failed to update shift end time';
          App.showToast(errMsg, 'error');
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Save';
          }
        }
      };

      overlay.querySelector('.modal-close').addEventListener('click', () => close(false));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });
      document.getElementById('manualShiftCancel').addEventListener('click', () => close(false));
      document.getElementById('manualShiftSave').addEventListener('click', handleSave);
    });
  },

  // ========== SYNC ==========

  /**
   * Sync queued time entries (called from Sync module).
   */
  async syncAll() {
    let synced = 0;
    let failed = 0;

    try {
      const pending = await DB.getUnsyncedItems('timeEntries');
      for (const item of pending) {
        try {
          if (item.action === 'clock_in') {
            const result = await OdooAPI.clockIn(item.employee_id, item.gps || '', item.gps_accuracy || 0);
            if (result && result.attendance_id) {
              // Update local state with the real attendance ID
              this._attendanceId = result.attendance_id;
              await this._saveState();
            }
          } else if (item.action === 'clock_out') {
            if (item.attendance_id) {
              await OdooAPI.clockOut(item.attendance_id, item.gps || '', item.gps_accuracy || 0);
            }
          } else if (item.action === 'start_lunch') {
            if (item.attendance_id) {
              await OdooAPI.startLunch(item.attendance_id, item.gps || '');
            }
          } else if (item.action === 'end_lunch') {
            if (item.attendance_id) {
              await OdooAPI.endLunch(item.attendance_id);
            }
          }
          item.synced = 1;
          await DB.put('timeEntries', item);
          synced++;
        } catch (err) {
          console.warn('Failed to sync time entry:', err);
          failed++;
        }
      }
    } catch {
      // timeEntries store might not exist yet
    }

    return { synced, failed };
  },

  // ========== HELPERS ==========

  getStatus() { return this._status; },
  isClockedIn() { return this._status === 'in' || this._status === 'break'; },
  getAttendanceId() { return this._attendanceId; },

  _parseOdooDatetime(dateStr) {
    if (!dateStr) return null;
    const iso = dateStr.replace(' ', 'T') + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z');
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  },
};
