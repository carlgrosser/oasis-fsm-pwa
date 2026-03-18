/**
 * Odoo JSON-RPC API wrapper.
 * All calls go through /web/dataset/call_kw or /jsonrpc.
 */
const OdooAPI = {
  _requestId: 0,
  _sessionId: null,

  /**
   * Detect missing server-side custom method errors.
   */
  _isMissingMethodError(err) {
    const msg = String(err && err.message ? err.message : '').toLowerCase();
    return msg.includes('unknown method') ||
           msg.includes('object has no attribute') ||
           msg.includes('worker_get_') ||
           msg.includes('worker_create_');
  },

  /**
   * Set the session ID for authenticated requests.
   */
  setSession(sessionId) {
    this._sessionId = sessionId;
  },

  /**
   * Low-level JSON-RPC call.
   */
  async rpc(url, params) {
    this._requestId++;
    const fullUrl = CONFIG.ODOO_URL + url;

    const headers = {
      'Content-Type': 'application/json',
    };

    const body = {
      jsonrpc: '2.0',
      id: this._requestId,
      method: 'call',
      params: params,
    };

    const resp = await fetch(fullUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: CONFIG.ODOO_URL ? 'include' : 'same-origin',
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }

    const data = await resp.json();

    if (data.error) {
      const msg = data.error.data?.message || data.error.message || 'Unknown Odoo error';
      const err = new Error(msg);
      err.odooError = data.error;
      throw err;
    }

    return data.result;
  },

  /**
   * Authenticate with Odoo. Returns session info.
   */
  async authenticate(login, password) {
    const result = await this.rpc('/web/session/authenticate', {
      db: CONFIG.ODOO_DB,
      login: login,
      password: password,
    });

    if (!result.uid) {
      throw new Error('Authentication failed: invalid credentials');
    }

    this._sessionId = result.session_id;
    return result;
  },

  /**
   * Check if current session is still valid.
   */
  async checkSession() {
    try {
      const result = await this.rpc('/web/session/get_session_info', {});
      return result && result.uid !== false;
    } catch (e) {
      return false;
    }
  },

  /**
   * Build the context object with multi-company support.
   */
  _getContext(extra) {
    const ctx = {};
    if (CONFIG.ALLOWED_COMPANY_IDS && CONFIG.ALLOWED_COMPANY_IDS.length > 0) {
      ctx.allowed_company_ids = CONFIG.ALLOWED_COMPANY_IDS;
    }
    return Object.assign(ctx, extra || {});
  },

  /**
   * Call a model method via call_kw.
   */
  async callKw(model, method, args, kwargs) {
    const kw = kwargs || {};
    kw.context = this._getContext(kw.context);
    return this.rpc('/web/dataset/call_kw', {
      model: model,
      method: method,
      args: args || [],
      kwargs: kw,
    });
  },

  /**
   * Search and read records.
   */
  async searchRead(model, domain, fields, opts) {
    const options = opts || {};
    const kwargs = {};
    if (options.limit) kwargs.limit = options.limit;
    if (options.offset) kwargs.offset = options.offset;
    if (options.order) kwargs.order = options.order;
    return this.callKw(model, 'search_read', [domain, fields], kwargs);
  },

  /**
   * Read specific record IDs.
   */
  async read(model, ids, fields) {
    return this.callKw(model, 'read', [ids, fields], {});
  },

  /**
   * Write (update) records.
   */
  async write(model, ids, values) {
    return this.callKw(model, 'write', [ids, values], {});
  },

  /**
   * Create a record.
   */
  async create(model, values) {
    return this.callKw(model, 'create', [values], {});
  },

  /**
   * Get FSM stages (for mapping stage_id to stage name).
   */
  async getStages() {
    return this.searchRead(
      'fsm.stage',
      [],
      ['id', 'name', 'sequence', 'is_closed', 'company_id'],
      { order: 'sequence asc' }
    );
  },

  /**
   * Get the full list of FSM order fields to fetch.
   */
  _getOrderFields() {
    const fields = [...CONFIG.FSM_ORDER_FIELDS];
    if (CONFIG.CUSTOM_MODULE_INSTALLED) {
      fields.push(...CONFIG.FSM_ORDER_EXTRA_FIELDS);
    }
    return fields;
  },

  /**
   * Fetch FSM orders for the current user.
   */
  async getMyOrders(personId, dateFrom, dateTo) {
    const domain = [
      '|', '|',
      ['person_id', '=', personId],
      ['person_ids', 'in', [personId]],
      ['additional_worker_ids', 'in', [personId]],
      ['scheduled_date_start', '>=', dateFrom],
      ['scheduled_date_start', '<=', dateTo],
    ];

    return this.searchRead(
      'fsm.order',
      domain,
      this._getOrderFields(),
      { order: 'scheduled_date_start asc', limit: CONFIG.JOBS_PER_PAGE }
    );
  },

  /**
   * Fetch uncompleted orders scheduled before today (overdue jobs).
   * No date limit - these should always be visible until completed.
   */
  async getOverdueOrders(personId, beforeDate) {
    const domain = [
      '|', '|',
      ['person_id', '=', personId],
      ['person_ids', 'in', [personId]],
      ['additional_worker_ids', 'in', [personId]],
      ['stage_id.is_closed', '=', false],
      ['scheduled_date_start', '<', beforeDate],
    ];

    return this.searchRead(
      'fsm.order',
      domain,
      this._getOrderFields(),
      { order: 'scheduled_date_start desc', limit: 100 }
    );
  },

  /**
   * Fetch completed orders for history view.
   * @param {number} personId
   * @param {string} dateFrom - ISO date string
   * @param {number} offset - for pagination (load more)
   */
  async getCompletedOrders(personId, dateFrom, offset = 0) {
    const domain = [
      '|', '|',
      ['person_id', '=', personId],
      ['person_ids', 'in', [personId]],
      ['additional_worker_ids', 'in', [personId]],
      ['stage_id.is_closed', '=', true],
      '|',
      ['date_end', '>=', dateFrom],
      ['write_date', '>=', dateFrom],
    ];

    return this.searchRead(
      'fsm.order',
      domain,
      this._getOrderFields(),
      { order: 'date_end desc', limit: CONFIG.JOBS_PER_PAGE, offset }
    );
  },

  /**
   * Update an FSM order's stage.
   */
  async updateOrderStage(orderId, stageId, extraValues) {
    const values = { stage_id: stageId, ...(extraValues || {}) };
    // OCA fieldservice blocks direct writes to the Completed stage;
    // bypass_order_completed_stage context allows it.
    return this.callKw('fsm.order', 'write', [[orderId], values], {
      context: { bypass_order_completed_stage: true },
    });
  },

  /**
   * Upload a photo attachment using the FSM naming convention (FSM####_category_n.jpg).
   * The sequential number is calculated server-side to stay consistent with Drive uploads.
   */
  async uploadPhoto(orderId, base64Data, filename, category) {
    return this.callKw('fsm.order', 'worker_upload_photo_attachment', [orderId, base64Data, category], {});
  },

  /**
   * Get the fsm.person ID for the current user.
   * OCA fieldservice uses delegation inheritance (fsm.person -> res.partner),
   * so we match via the partner_id linked to the user account.
   */
  async getMyPersonId(userId, userPartnerId) {
    // Primary: match fsm.person whose partner_id matches the user's partner
    if (userPartnerId) {
      const byPartner = await this.searchRead(
        'fsm.person',
        [['partner_id', '=', userPartnerId]],
        ['id', 'name'],
        { limit: 1 }
      );
      if (byPartner.length > 0) return byPartner[0];
    }

    // Fallback: check if any fsm.person has this user in user_ids
    const byUser = await this.searchRead(
      'fsm.person',
      [['user_ids', 'in', [userId]]],
      ['id', 'name'],
      { limit: 1 }
    );
    if (byUser.length > 0) return byUser[0];

    return null;
  },

  /**
   * Fetch all FSM workers with their linked user/employee IDs.
   * Returns [{ personId, name, uid, employeeId }] sorted by name.
   */
  async getFsmWorkers() {
    const persons = await this.searchRead(
      'fsm.person', [], ['id', 'name', 'partner_id'], { order: 'name asc', limit: 100 }
    );
    if (!persons.length) return [];

    const partnerIds = persons
      .map(p => Array.isArray(p.partner_id) ? p.partner_id[0] : p.partner_id)
      .filter(Boolean);

    const users = await this.searchRead(
      'res.users',
      [['partner_id', 'in', partnerIds], ['active', '=', true]],
      ['id', 'partner_id'],
      { limit: 100 }
    );
    const partnerToUid = {};
    users.forEach(u => {
      const pid = Array.isArray(u.partner_id) ? u.partner_id[0] : u.partner_id;
      if (pid) partnerToUid[pid] = u.id;
    });

    const uids = users.map(u => u.id);
    const userToEmployee = {};
    if (uids.length) {
      const employees = await this.searchRead(
        'hr.employee', [['user_id', 'in', uids]], ['id', 'user_id'], { limit: 100 }
      );
      employees.forEach(e => {
        const uid = Array.isArray(e.user_id) ? e.user_id[0] : e.user_id;
        if (uid) userToEmployee[uid] = e.id;
      });
    }

    return persons.map(p => {
      const partnerId = Array.isArray(p.partner_id) ? p.partner_id[0] : p.partner_id;
      const uid = partnerId ? partnerToUid[partnerId] : null;
      return { personId: p.id, name: p.name, uid, employeeId: uid ? (userToEmployee[uid] || null) : null };
    }).filter(w => w.uid);
  },

  // ========== MATERIALS ==========

  /**
   * Get material config for an FSM order (based on its categories).
   */
  async getMaterialConfig(orderId) {
    return this.callKw('fsm.order', 'get_material_config', [[orderId]], {});
  },

  /**
   * Save material usage for an FSM order.
   */
  async saveMaterials(orderId, lines) {
    return this.callKw('fsm.order', 'save_materials', [[orderId], lines], {});
  },

  /**
   * Update gate code on an fsm.location.
   */
  async updateLocationGateCode(locationId, gateCode) {
    return this.write('fsm.location', [locationId], { gate_code: gateCode });
  },

  /**
   * Read fsm.person names by IDs (for multi-worker display).
   */
  async readPersonNames(ids) {
    if (!ids || ids.length === 0) return [];
    return this.read('fsm.person', ids, ['id', 'name']);
  },

  /**
   * Get partner details (for customer contact info).
   */
  async getPartner(partnerId) {
    const partners = await this.read('res.partner', [partnerId], [
      'name', 'phone', 'mobile', 'email', 'street', 'street2',
      'city', 'state_id', 'zip', 'country_id'
    ]);
    return partners.length > 0 ? partners[0] : null;
  },

  /**
   * Get Google Drive folder IDs linked to a project.
   * Used to surface the customer photos folder on the Info tab.
   */
  async getProjectGdriveFolders(projectId) {
    const results = await this.read('project.project', [projectId], [
      'id', 'gdrive_photos_folder_id',
    ]);
    return results.length > 0 ? results[0] : null;
  },

  /**
   * Get location details.
   */
  async getLocation(locationId) {
    const locations = await this.read('fsm.location', [locationId], [
      'name', 'street', 'street2', 'city', 'state_id', 'zip',
      'phone', 'partner_id', 'direction', 'ref'
    ]);
    return locations.length > 0 ? locations[0] : null;
  },

  // ========== TIME OFF ==========

  /**
   * Fetch current worker's time off requests.
   * @param {string|false} stateFilter - 'pending' | 'approved' | 'refused' | false
   */
  async getMyTimeOffRequests(stateFilter = false) {
    try {
      return await this.callKw('hr.leave', 'worker_get_my_time_off_requests', [stateFilter], {});
    } catch (err) {
      if (!this._isMissingMethodError(err)) throw err;

      // Backward-compatibility fallback for servers without worker_* methods:
      // read own requests directly from hr.leave.
      const employeeId = (typeof Auth !== 'undefined' && Auth.getEmployeeId) ? Auth.getEmployeeId() : null;
      if (!employeeId) return [];

      const domain = [['employee_id', '=', employeeId]];
      if (stateFilter === 'pending') {
        domain.push(['state', 'in', ['confirm', 'validate1']]);
      } else if (stateFilter === 'approved') {
        domain.push(['state', '=', 'validate']);
      } else if (stateFilter === 'refused') {
        domain.push(['state', '=', 'refuse']);
      }

      const rows = await this.searchRead(
        'hr.leave',
        domain,
        ['id', 'employee_id', 'holiday_status_id', 'state', 'name',
         'request_date_from', 'request_date_to', 'date_from', 'date_to', 'number_of_days'],
        { order: 'date_from desc', limit: 200 }
      );

      return (rows || []).map(r => {
        const employeeIdVal = Array.isArray(r.employee_id) ? r.employee_id[0] : r.employee_id;
        const employeeName = Array.isArray(r.employee_id) ? r.employee_id[1] : '';
        const leaveTypeId = Array.isArray(r.holiday_status_id) ? r.holiday_status_id[0] : r.holiday_status_id;
        const leaveTypeName = Array.isArray(r.holiday_status_id) ? r.holiday_status_id[1] : '';
        const dateFrom = r.date_from || (r.request_date_from ? (r.request_date_from + ' 00:00:00') : false);
        const dateTo = r.date_to || (r.request_date_to ? (r.request_date_to + ' 23:59:59') : false);
        return {
          id: r.id,
          employee_id: employeeIdVal,
          employee_name: employeeName,
          date_from: dateFrom,
          date_to: dateTo,
          leave_type: leaveTypeName || '',
          leave_type_id: leaveTypeId || false,
          state: r.state,
          notes: r.name || '',
          number_of_days: r.number_of_days || 0,
        };
      });
    }
  },

  /**
   * Fetch available leave types for worker requests.
   */
  async getWorkerLeaveTypes() {
    try {
      return await this.callKw('hr.leave', 'worker_get_leave_types', [], {});
    } catch (err) {
      if (!this._isMissingMethodError(err)) throw err;

      // Backward compatibility with older server code.
      try {
        return await this.callKw('hr.leave', 'office_get_leave_types', [], {});
      } catch (err2) {
        if (!this._isMissingMethodError(err2)) throw err2;
      }

      const rows = await this.searchRead('hr.leave.type', [], ['id', 'name'], { order: 'name asc' });
      return (rows || []).map(r => ({ id: r.id, name: r.name || '' }));
    }
  },

  /**
   * Create a time off request for the logged-in worker.
   */
  async createMyTimeOff(leaveTypeId, dateFrom, dateTo, notes) {
    try {
      return await this.callKw(
        'hr.leave',
        'worker_create_my_time_off',
        [leaveTypeId, dateFrom, dateTo, notes || false],
        {}
      );
    } catch (err) {
      if (!this._isMissingMethodError(err)) throw err;

      // Compatibility fallback: use office_create_time_off with current worker person_id.
      const personId = (typeof Auth !== 'undefined' && Auth.getPersonId) ? Auth.getPersonId() : null;
      if (!personId) {
        return { success: false, error: 'Unable to resolve your worker profile.' };
      }

      try {
        return await this.callKw(
          'hr.leave',
          'office_create_time_off',
          [personId, leaveTypeId, dateFrom, dateTo, notes || false],
          {}
        );
      } catch (fallbackErr) {
        // If office_create_time_off exists but the server rejects the request
        // (for example overlapping dates), return that real validation error.
        if (!this._isMissingMethodError(fallbackErr)) {
          return {
            success: false,
            error: (fallbackErr && fallbackErr.message) || 'Failed to create time off request.'
          };
        }

        // Final compatibility fallback for servers missing both custom methods.
        // Try creating directly on hr.leave for the current employee.
        const employeeId = (typeof Auth !== 'undefined' && Auth.getEmployeeId) ? Auth.getEmployeeId() : null;
        if (employeeId) {
          try {
            const leaveId = await this.create('hr.leave', {
              employee_id: employeeId,
              holiday_status_id: leaveTypeId,
              request_date_from: dateFrom ? dateFrom.slice(0, 10) : false,
              request_date_to: dateTo ? dateTo.slice(0, 10) : false,
              name: notes || false,
            });

            // If allowed, move to confirmed so it appears pending for approval.
            try {
              await this.callKw('hr.leave', 'action_confirm', [[leaveId]], {});
            } catch {
              // Some ACLs do not allow this; the leave still exists in draft.
            }

            return { success: true, leave_id: leaveId };
          } catch (directErr) {
            return {
              success: false,
              error: (directErr && directErr.message) ||
                     'Failed to create time off request on this server.'
            };
          }
        }

        return {
          success: false,
          error: 'Server is missing worker time-off APIs. Ask admin to update fieldservice_dispatch.'
        };
      }
    }
  },

  // ========== JOURNAL ==========

  /**
   * Get journal entries for an FSM order.
   * Calls a server-side method that handles subtype resolution in Python.
   */
  async getJournalEntries(orderId) {
    return this.callKw('fsm.order', 'get_journal_entries', [[orderId]], {});
  },

  /**
   * Post a journal entry to an FSM order's chatter.
   * Calls a server-side method that handles subtype resolution in Python.
   */
  async postJournalEntry(orderId, body) {
    return this.callKw('fsm.order', 'post_journal_entry', [[orderId], body], {});
  },

  /**
   * Get system notes (internal log notes) for an FSM order.
   */
  async getSystemNotes(orderId) {
    return this.callKw('fsm.order', 'get_system_notes', [[orderId]], {});
  },

  /**
   * Post an internal system note to an FSM order's chatter.
   * Used for automated activity logging (stage changes, photos, billing, etc).
   * Fire-and-forget safe — errors are non-fatal.
   */
  async postSystemNote(orderId, body) {
    return this.callKw('fsm.order', 'post_system_note', [[orderId], body], {});
  },

  // ========== ATTENDANCE / TIME TRACKING ==========

  /**
   * Get the hr.employee ID for a user.
   */
  async getEmployeeId(userId) {
    const employees = await this.searchRead(
      'hr.employee',
      [['user_id', '=', userId]],
      ['id', 'name'],
      { limit: 1 }
    );
    return employees.length > 0 ? employees[0] : null;
  },

  /**
   * Get the current open attendance record for an employee.
   */
  async getCurrentAttendance(employeeId) {
    return this.callKw('hr.attendance', 'mobile_get_current_attendance', [employeeId], {});
  },

  /**
   * Get the latest auto-clocked-out attendance that needs correction.
   */
  async getPendingAutoClockOut(employeeId) {
    return this.callKw('hr.attendance', 'mobile_get_pending_auto_clock_out', [employeeId], {});
  },

  /**
   * Get today's latest attendance for manual adjustment.
   */
  async getLastShiftForAdjustment(employeeId) {
    return this.callKw('hr.attendance', 'mobile_get_last_shift_for_adjustment', [employeeId], {});
  },

  /**
   * Clock in — create attendance record with GPS.
   * @param {string|null} payCategory - 'production' | 'hourly_pay' | null (defaults to employee's pay type)
   */
  async clockIn(employeeId, gpsCoords, gpsAccuracy, payCategory) {
    const args = [employeeId, gpsCoords || '', gpsAccuracy || 0];
    if (payCategory) args.push(payCategory);
    return this.callKw('hr.attendance', 'mobile_clock_in', args, {});
  },

  /**
   * Clock out — close attendance record with GPS.
   */
  async clockOut(attendanceId, gpsCoords, gpsAccuracy) {
    return this.callKw('hr.attendance', 'mobile_clock_out', [attendanceId, gpsCoords || '', gpsAccuracy || 0], {});
  },

  /**
   * Start lunch break.
   */
  async startLunch(attendanceId, gpsCoords) {
    return this.callKw('hr.attendance', 'mobile_start_lunch', [attendanceId, gpsCoords || ''], {});
  },

  /**
   * End lunch break.
   */
  async endLunch(attendanceId) {
    return this.callKw('hr.attendance', 'mobile_end_lunch', [attendanceId], {});
  },

  /**
   * Correct an auto clock-out time.
   */
  async correctAutoClockOut(attendanceId, endTimeIso) {
    return this.callKw('hr.attendance', 'mobile_correct_auto_clock_out', [attendanceId, endTimeIso], {});
  },

  /**
   * Manually set or adjust shift end time.
   */
  async adjustShiftEnd(attendanceId, endTimeIso) {
    return this.callKw('hr.attendance', 'mobile_adjust_shift_end', [attendanceId, endTimeIso], {});
  },

  /**
   * Adjust shift start (clock-on) time.
   */
  async adjustShiftStart(attendanceId, startTimeIso) {
    return this.callKw('hr.attendance', 'mobile_adjust_shift_start', [attendanceId, startTimeIso], {});
  },

  /**
   * Adjust lunch return (lunch end) time.
   */
  async adjustLunchEnd(attendanceId, lunchEndIso) {
    return this.callKw('hr.attendance', 'mobile_adjust_lunch_end', [attendanceId, lunchEndIso], {});
  },

  /**
   * Get attendance history for an employee within a date range.
   */
  async getAttendanceHistory(employeeId, dateFrom, dateTo) {
    return this.callKw('hr.attendance', 'mobile_get_attendance_history', [employeeId, dateFrom, dateTo], {});
  },

  /**
   * Get current and previous pay period hours summary for the employee.
   */
  async getPayPeriodSummary(employeeId) {
    return this.callKw('hr.attendance', 'mobile_get_pay_period_summary', [employeeId], {});
  },

  /**
   * Set (override) the pay category on a completed attendance record.
   * Only HR managers can call this successfully.
   */
  async setPayCategory(attendanceId, payCategory) {
    return this.callKw('hr.attendance', 'mobile_set_pay_category', [attendanceId, payCategory], {});
  },

  /**
   * Submit a timesheet change request on an attendance record.
   */
  async requestTimesheetChange(attendanceId, changes, reason) {
    return this.callKw('hr.attendance', 'mobile_request_timesheet_change', [attendanceId, changes, reason], {});
  },

  /**
   * Send a note to the office Discuss channel.
   */
  async sendOfficeNote(employeeId, body) {
    return this.callKw('hr.attendance', 'mobile_send_office_note', [employeeId, body], {});
  },

  // ========== ETA ==========

  /**
   * Get driving ETA from worker's GPS to job location.
   */
  async getEta(orderId, gpsCoords) {
    return this.callKw('fsm.order', 'worker_get_eta', [orderId, gpsCoords], {});
  },

  // ========== EN ROUTE SMS ==========

  /**
   * Send an SMS to the customer notifying that the technician is en route.
   * If message is provided, the server uses it as-is instead of its own template.
   */
  async sendEnRouteSms(orderId, phoneNumber, etaMinutes, message) {
    const kwargs = message ? { message: message } : {};
    return this.callKw('fsm.order', 'worker_send_enroute_sms',
      [orderId, phoneNumber, etaMinutes || false], kwargs);
  },

  // ========== BILLING ==========

  /**
   * Get the sales order linked to an FSM order.
   */
  async getSaleOrder(fsmOrderId) {
    return this.callKw('fsm.order', 'worker_get_sale_order', [fsmOrderId], {});
  },

  /**
   * Update a sales order line (qty, price, description).
   */
  async updateSaleLine(lineId, values) {
    return this.callKw('fsm.order', 'worker_update_sale_line', [lineId, values], {});
  },

  /**
   * Add a new line to a sales order.
   */
  async addSaleLine(saleOrderId, productId, quantity, priceUnit, description) {
    return this.callKw('fsm.order', 'worker_add_sale_line',
      [saleOrderId, productId, quantity, priceUnit, description], {});
  },

  /**
   * Search products for adding to a sales order.
   */
  async searchProducts(query) {
    return this.callKw('fsm.order', 'worker_search_products', [query], {});
  },

  /**
   * Create an invoice from an FSM order's sales order.
   */
  async createInvoice(fsmOrderId) {
    return this.callKw('fsm.order', 'worker_create_invoice', [fsmOrderId], {});
  },

  /**
   * Void an unpaid posted invoice so the SO can be edited and re-invoiced.
   */
  async cancelInvoice(invoiceId) {
    return this.callKw('fsm.order', 'worker_cancel_invoice', [invoiceId], {});
  },

  /**
   * Get a Stripe payment link for an invoice.
   */
  async getPaymentLink(invoiceId) {
    return this.callKw('fsm.order', 'worker_get_payment_link', [invoiceId], {});
  },

  /**
   * Send a payment link via SMS.
   * If message is provided, the server uses it as-is instead of its own template.
   */
  async sendPaymentSms(invoiceId, phoneNumber, message) {
    const kwargs = message ? { message: message } : {};
    return this.callKw('fsm.order', 'worker_send_payment_sms', [invoiceId, phoneNumber], kwargs);
  },

  /**
   * Send an invoice/receipt PDF via SMS or email.
   * If message is provided, the server uses it as-is instead of its own template.
   */
  async sendDocument(invoiceId, docType, method, recipient, message) {
    const kwargs = message ? { message: message } : {};
    return this.callKw('fsm.order', 'worker_send_document',
      [invoiceId, docType, method, recipient], kwargs);
  },

  /**
   * Check invoice payment status (for polling).
   */
  async checkInvoiceStatus(invoiceId) {
    return this.callKw('fsm.order', 'worker_check_invoice_status', [invoiceId], {});
  },

  /**
   * Update delivered quantity on a SO line.
   */
  async updateDeliveredQty(lineId, qtyDelivered) {
    return this.callKw('fsm.order', 'worker_update_delivered_qty', [lineId, qtyDelivered], {});
  },

  /**
   * Accept as quoted — set delivered = ordered for all lines.
   */
  async acceptAsQuoted(saleOrderId) {
    return this.callKw('fsm.order', 'worker_accept_as_quoted', [saleOrderId], {});
  },

  /**
   * Post variance note to SO chatter.
   */
  async postVarianceNote(saleOrderId, varianceDetails) {
    return this.callKw('fsm.order', 'worker_post_variance_note', [saleOrderId, varianceDetails], {});
  },

  /**
   * Set ready-to-invoice flag on SO.
   */
  async setReadyToInvoice(saleOrderId, ready) {
    return this.callKw('fsm.order', 'worker_set_ready_to_invoice', [saleOrderId, ready], {});
  },

  /**
   * Register a check payment on an invoice.
   */
  async registerCheckPayment(invoiceId, checkNumber, amount, paymentDate) {
    const kwargs = paymentDate ? { payment_date: paymentDate } : {};
    return this.callKw('fsm.order', 'worker_register_check_payment', [invoiceId, checkNumber, amount], kwargs);
  },

  /**
   * Register a manual payment (Venmo, cash, etc.).
   */
  async registerManualPayment(invoiceId, method, reference, amount) {
    return this.callKw('fsm.order', 'worker_register_manual_payment', [invoiceId, method, reference, amount], {});
  },

  /**
   * Set or clear the do-not-invoice flag on a sale order line.
   */
  async setDoNotInvoice(lineId, value) {
    return this.callKw('fsm.order', 'worker_set_do_not_invoice', [lineId, value], {});
  },

  /**
   * Count completed jobs assigned to this worker with an unpaid invoice.
   */
  async getBillingStates(personId) {
    return this.callKw('fsm.order', 'worker_get_billing_states', [personId], {});
  },

  /**
   * Create a change order linked to an FSM order.
   */
  async createChangeOrder(fsmOrderId, lines, reason, signatureBase64, signedByName) {
    return this.callKw('fsm.order', 'worker_create_change_order',
      [fsmOrderId, lines, reason, signatureBase64, signedByName], {});
  },

  // ========== OPTIONS (sale_optional_buckets) ==========

  /**
   * Fetch optional items for the sale order linked to an FSM order.
   * Returns bucketed/sectioned structure for the Options tab.
   */
  async getJobOptions(fsmOrderId) {
    return this.callKw('fsm.order', 'worker_get_options', [fsmOrderId], {});
  },

  /**
   * Add a proposed optional item to the current job's sale order.
   */
  async addOptionToOrder(fsmOrderId, optionLineId) {
    return this.callKw('fsm.order', 'worker_add_option_to_order', [fsmOrderId, optionLineId], {});
  },

  /**
   * Mark a proposed optional item as declined.
   */
  async declineOption(fsmOrderId, optionLineId) {
    return this.callKw('fsm.order', 'worker_decline_option', [fsmOrderId, optionLineId], {});
  },

  /**
   * Create a new FSM order + sale order from selected optional items.
   * Used when customer accepts additional work on-site that needs a separate job.
   */
  async createFsmFromOptions(fsmOrderId, optionLineIds, notes) {
    return this.callKw('fsm.order', 'worker_create_fsm_from_options',
      [fsmOrderId, optionLineIds, notes || ''], {});
  },

  // ========== PWA SETTINGS ==========

  /**
   * Fetch PWA settings from Odoo system parameters.
   * Returns a dict of CONFIG keys to values (only keys that are set).
   */
  async getPwaSettings() {
    return this.callKw('fsm.order', 'worker_get_pwa_settings', [], {});
  },

  // ========== HELPDESK ==========

  /**
   * Fetch active helpdesk tickets assigned to the current user.
   * Uses OCA helpdesk_mgmt model (helpdesk.ticket / helpdesk.ticket.stage).
   */
  async getMyHelpdeskTickets(limit = 100) {
    const uid = Auth.getUser() && Auth.getUser().uid;
    if (!uid) return [];
    return this.searchRead(
      'helpdesk.ticket',
      ['|', ['user_id', '=', uid], ['create_uid', '=', uid]],
      ['name', 'stage_id', 'priority', 'create_date', 'partner_id', 'team_id'],
      { limit }
    );
  },

  /**
   * Count active helpdesk tickets assigned to the current user (for badge).
   */
  async countMyHelpdeskTickets() {
    const uid = Auth.getUser() && Auth.getUser().uid;
    if (!uid) return 0;
    return this.callKw('helpdesk.ticket', 'search_count',
      [[['user_id', '=', uid], ['stage_id.closed', '=', false]]],
      {}
    );
  },

  /**
   * Create a new helpdesk ticket assigned to the current user.
   */
  async createHelpdeskTicket(name, description) {
    const uid = Auth.getUser() && Auth.getUser().uid;
    const vals = { name, user_id: uid };
    if (description) vals.description = description;
    return this.callKw('helpdesk.ticket', 'create', [vals], {});
  },

  // ========== GOOGLE DRIVE ==========

  /**
   * Read the Drive folder IDs for an FSM order.
   * Returns { photosFolderId, documentsFolderId, diagramsFolderId, otherFolderId, rootFolderId, effectiveFolderId }
   */
  async getOrderFolderIds(orderId) {
    const orders = await this.read('fsm.order', [orderId], ['id', 'project_id', 'gdrive_effective_folder_id']);
    if (!orders.length) return null;
    const order = orders[0];
    const projectId = Array.isArray(order.project_id) ? order.project_id[0] : order.project_id;
    if (!projectId) {
      return { effectiveFolderId: order.gdrive_effective_folder_id || null };
    }
    const projects = await this.read('project.project', [projectId], [
      'gdrive_folder_id', 'gdrive_photos_folder_id',
      'gdrive_documents_folder_id', 'gdrive_diagrams_folder_id', 'gdrive_other_folder_id',
    ]);
    if (!projects.length) return { effectiveFolderId: order.gdrive_effective_folder_id || null };
    const p = projects[0];
    return {
      effectiveFolderId:   order.gdrive_effective_folder_id || null,
      photosFolderId:      p.gdrive_photos_folder_id || null,
      documentsFolderId:   p.gdrive_documents_folder_id || null,
      diagramsFolderId:    p.gdrive_diagrams_folder_id || null,
      otherFolderId:       p.gdrive_other_folder_id || null,
      rootFolderId:        p.gdrive_folder_id || null,
    };
  },

  /**
   * Fetch discovery asset photos from Google Drive for a job.
   * Returns [{ file_id, name, view_url, folder_name }] or [].
   */
  async getDiscoveryPhotos(orderId) {
    return this.callKw('fsm.order', 'worker_get_discovery_photos', [orderId], {});
  },

  /**
   * Fetch documents from the Drive Documents folder for a job.
   * Returns [{ file_id, name, mime_type, view_url, modified_time }] or [].
   */
  async getJobDocuments(orderId) {
    return this.callKw('fsm.order', 'worker_get_documents', [orderId], {});
  },

  /**
   * Fetch all gdrive.photo.link records for an FSM order.
   */
  async getDrivePhotoLinks(orderId) {
    return this.searchRead(
      'gdrive.photo.link',
      [['order_id', '=', orderId]],
      ['id', 'order_id', 'category', 'filename', 'gdrive_file_id', 'gdrive_url', 'uploaded_at', 'deletion_requested'],
      { order: 'uploaded_at asc', limit: 200 }
    );
  },

  /**
   * Upload a photo to Google Drive via the Odoo proxy.
   * Accepts a Blob (binary image data).
   */
  async uploadPhotoDrive(orderId, category, blob, filename) {
    const formData = new FormData();
    formData.append('order_id', orderId);
    formData.append('category', category);
    formData.append('file', blob, filename || 'photo.jpg');

    const url = (CONFIG.ODOO_URL || '') + '/gdrive/upload_photo';
    const resp = await fetch(url, {
      method: 'POST',
      body: formData,
      credentials: CONFIG.ODOO_URL ? 'include' : 'same-origin',
    });

    if (!resp.ok) throw new Error(`Drive upload failed: HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || 'Drive upload failed');
    return data;
  },

  // ── Job Wrap-Up ───────────────────────────────────────────────────────────

  /**
   * Submit a full job wrap-up (post-completion).
   * @param {number} orderId
   * @param {Object} data - { job_complete, return_trip_note, payment_not_collected,
   *                          payment_followup_note, resolution, office_note,
   *                          gps, gps_accuracy }
   * @returns {Promise<{success, already_submitted, submitted_by, clocked_out_count}>}
   */
  async submitWrapup(orderId, data) {
    return this.callKw('fsm.order', 'submit_wrapup', [orderId, data], {});
  },

  /**
   * Submit an early wrap-up (job still in-progress).
   * @param {number} orderId
   * @param {Object} data - { payment_status, payment_note, gps, gps_accuracy }
   * @returns {Promise<{success, clocked_out_count}>}
   */
  async submitEarlyWrapup(orderId, data) {
    return this.callKw('fsm.order', 'submit_early_wrapup', [orderId, data], {});
  },

  /**
   * Clock out all workers currently clocked in on a job.
   * Called from the clock-off prompt when "Clock All Workers Off" is checked.
   * @param {number} orderId
   * @param {string} gps
   * @param {number} gpsAccuracy
   * @returns {Promise<number>} count of attendance records closed
   */
  async clockOutJobWorkers(orderId, gps, gpsAccuracy) {
    return this.callKw('fsm.order', 'clock_out_workers_for_job',
      [orderId, gps || '', gpsAccuracy || 0], {});
  },

  async reopenJob(orderId) {
    return this.callKw('fsm.order', 'reopen_job', [orderId], {});
  },
};
