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
      ['id', 'name', 'sequence', 'is_closed'],
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
   * Upload a photo attachment.
   */
  async uploadPhoto(orderId, base64Data, filename, category) {
    return this.create('ir.attachment', {
      name: filename,
      datas: base64Data,
      res_model: 'fsm.order',
      res_id: orderId,
      description: category,
      mimetype: 'image/jpeg',
    });
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
   */
  async clockIn(employeeId, gpsCoords, gpsAccuracy) {
    return this.callKw('hr.attendance', 'mobile_clock_in', [employeeId, gpsCoords || '', gpsAccuracy || 0], {});
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
   */
  async sendEnRouteSms(orderId, phoneNumber, etaMinutes) {
    return this.callKw('fsm.order', 'worker_send_enroute_sms',
      [orderId, phoneNumber, etaMinutes || false], {});
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
   * Get a Stripe payment link for an invoice.
   */
  async getPaymentLink(invoiceId) {
    return this.callKw('fsm.order', 'worker_get_payment_link', [invoiceId], {});
  },

  /**
   * Send a payment link via SMS.
   */
  async sendPaymentSms(invoiceId, phoneNumber) {
    return this.callKw('fsm.order', 'worker_send_payment_sms', [invoiceId, phoneNumber], {});
  },

  /**
   * Send an invoice/receipt PDF via SMS or email.
   */
  async sendDocument(invoiceId, docType, method, recipient) {
    return this.callKw('fsm.order', 'worker_send_document',
      [invoiceId, docType, method, recipient], {});
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
  async registerCheckPayment(invoiceId, checkNumber, amount) {
    return this.callKw('fsm.order', 'worker_register_check_payment', [invoiceId, checkNumber, amount], {});
  },

  /**
   * Register a manual payment (Venmo, cash, etc.).
   */
  async registerManualPayment(invoiceId, method, reference, amount) {
    return this.callKw('fsm.order', 'worker_register_manual_payment', [invoiceId, method, reference, amount], {});
  },

  /**
   * Create a change order linked to an FSM order.
   */
  async createChangeOrder(fsmOrderId, lines, reason, signatureBase64, signedByName) {
    return this.callKw('fsm.order', 'worker_create_change_order',
      [fsmOrderId, lines, reason, signatureBase64, signedByName], {});
  },
};
