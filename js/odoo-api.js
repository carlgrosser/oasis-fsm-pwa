/**
 * Odoo JSON-RPC API wrapper.
 * All calls go through /web/dataset/call_kw or /jsonrpc.
 */
const OdooAPI = {
  _requestId: 0,
  _sessionId: null,

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
    return this.callKw(model, 'search_read', [domain, fields], {
      limit: options.limit || 0,
      offset: options.offset || 0,
      order: options.order || '',
    });
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
   * Fetch completed orders for history view.
   */
  async getCompletedOrders(personId, dateFrom) {
    const domain = [
      '|', '|',
      ['person_id', '=', personId],
      ['person_ids', 'in', [personId]],
      ['additional_worker_ids', 'in', [personId]],
      ['stage_id.is_closed', '=', true],
      ['date_end', '>=', dateFrom],
    ];

    return this.searchRead(
      'fsm.order',
      domain,
      this._getOrderFields(),
      { order: 'date_end desc', limit: CONFIG.JOBS_PER_PAGE }
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
};
