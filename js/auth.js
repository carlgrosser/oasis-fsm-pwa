/**
 * Authentication module.
 * Handles login, logout, session persistence, and user context.
 */
const Auth = {
  _session: null,
  _user: null,
  _personId: null,
  _employeeId: null,
  _timezone: null,
  _persona: null,   // { uid, name, personId, employeeId } when impersonating, else null

  /**
   * Get stored session from localStorage.
   */
  getStoredSession() {
    try {
      const data = localStorage.getItem('fsm_session');
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  /**
   * Store session to localStorage.
   */
  _storeSession(sessionData) {
    localStorage.setItem('fsm_session', JSON.stringify(sessionData));
  },

  /**
   * Clear stored session.
   */
  _clearSession() {
    localStorage.removeItem('fsm_session');
    this._session = null;
    this._user = null;
    this._personId = null;
    this._employeeId = null;
    this._timezone = null;
  },

  /**
   * Login with username and password.
   * Returns { success, error, user }.
   */
  async login(username, password, remember) {
    try {
      const result = await OdooAPI.authenticate(username, password);

      if (!result || !result.uid) {
        return { success: false, error: 'Invalid username or password' };
      }

      // Get fsm.person for this user (match via partner_id from session)
      const person = await OdooAPI.getMyPersonId(result.uid, result.partner_id);
      if (!person) {
        return {
          success: false,
          error: 'No field service worker profile found for this user. Contact your administrator.'
        };
      }

      this._session = result;
      this._user = {
        uid: result.uid,
        name: result.name || result.username,
        username: username,
        partnerId: result.partner_id,
      };
      this._personId = person.id;

      // Get hr.employee for attendance tracking
      const employee = await OdooAPI.getEmployeeId(result.uid);
      this._employeeId = employee ? employee.id : null;

      // Capture user timezone from Odoo session context
      const userTz = (result.user_context && result.user_context.tz) || null;
      this._timezone = userTz;

      const sessionData = {
        sessionId: result.session_id,
        uid: result.uid,
        name: result.name || result.username,
        username: username,
        partnerId: result.partner_id,
        personId: person.id,
        personName: person.name,
        employeeId: this._employeeId,
        timezone: userTz,
        timestamp: Date.now(),
      };

      if (remember) {
        this._storeSession(sessionData);
      }

      // Also save to IndexedDB for offline reference
      await DB.setState('currentUser', sessionData);

      // Fetch latest PWA settings from Odoo (non-fatal)
      await this._fetchAndApplySettings();

      return { success: true, user: sessionData };
    } catch (err) {
      const rawMsg = (err && err.message) ? err.message : '';
      // TODO(PWA-AUTH-LEAK-001): Remove detailed server errors and revert to generic codes/messages.
      const sanitizeError = (msg) => {
        if (!msg) return '';
        // Collapse whitespace and remove obvious stack-ish separators to reduce sensitive leakage.
        const cleaned = msg
          .replace(/[\r\n\t]+/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .replace(/\bTraceback\b.*$/i, ''); // trim python traceback tail if present
        // Cap length to avoid dumping internal details.
        return cleaned.trim().slice(0, 160);
      };

      const errMsg = sanitizeError(rawMsg);
      let message = errMsg ? `Server error: ${errMsg}` : 'Connection failed. Check your internet and try again.';
      if (rawMsg.includes('Authentication failed') || rawMsg.includes('Invalid')) {
        message = 'Invalid username or password';
      } else if (rawMsg.includes('fetch') || rawMsg.includes('network')) {
        message = 'Cannot connect to server. Check your internet connection.';
      }
      return { success: false, error: message };
    }
  },

  /**
   * Try to restore a previous session.
   * Returns true if session is valid.
   */
  async tryRestore() {
    const stored = this.getStoredSession();
    if (!stored) return false;

    this._user = {
      uid: stored.uid,
      name: stored.name,
      username: stored.username,
      partnerId: stored.partnerId,
    };
    this._personId = stored.personId;
    this._employeeId = stored.employeeId || null;
    this._timezone = stored.timezone || null;

    // If we're online, verify the session is still valid
    if (navigator.onLine) {
      try {
        const valid = await OdooAPI.checkSession();
        if (!valid) {
          // Session expired — try to re-authenticate if we have credentials
          // For now, just clear and require re-login
          this._clearSession();
          return false;
        }
        // Refresh PWA settings from Odoo (non-fatal)
        await this._fetchAndApplySettings();
        return true;
      } catch {
        // Network error — assume session might be OK (offline mode)
        return true;
      }
    }

    // Offline — trust the stored session
    return true;
  },

  /**
   * Logout — clear session and redirect.
   */
  async logout() {
    try {
      if (navigator.onLine) {
        await OdooAPI.rpc('/web/session/destroy', {});
      }
    } catch {
      // Ignore logout errors
    }
    this._clearSession();
    await DB.setState('currentUser', null);
    window.location.href = 'index.html';
  },

  /**
   * Fetch PWA settings from Odoo and apply to CONFIG + localStorage.
   * Non-fatal: errors are logged but do not block login.
   */
  async _fetchAndApplySettings() {
    try {
      const settings = await OdooAPI.getPwaSettings();
      if (settings && typeof settings === 'object') {
        // Handle Venmo QR image separately (not a CONFIG key)
        if (settings._venmo_qr_base64) {
          localStorage.setItem('pwa_venmo_qr', settings._venmo_qr_base64);
          delete settings._venmo_qr_base64;
        }
        // Apply to live CONFIG object
        for (const [key, value] of Object.entries(settings)) {
          if (key in CONFIG) {
            CONFIG[key] = value;
          }
        }
        // Persist to localStorage so they survive page reloads
        localStorage.setItem('pwa_settings', JSON.stringify(settings));
      }
    } catch (err) {
      console.warn('Failed to fetch PWA settings from server:', err);
    }
  },

  /**
   * Get current user info (returns persona when impersonating).
   */
  getUser() {
    if (this._persona) return { uid: this._persona.uid, name: this._persona.name };
    return this._user;
  },

  /**
   * Get the real logged-in user (ignores persona). Used for admin checks.
   */
  getRealUser() {
    return this._user;
  },

  /**
   * Get the fsm.person ID (returns persona's when impersonating).
   */
  getPersonId() {
    return this._persona ? this._persona.personId : this._personId;
  },

  /**
   * Get the hr.employee ID (returns persona's when impersonating).
   */
  getEmployeeId() {
    return this._persona ? this._persona.employeeId : this._employeeId;
  },

  /** Set impersonation persona. Pass null to clear. */
  setPersona(persona) {
    this._persona = persona;
  },

  clearPersona() {
    this._persona = null;
  },

  getPersona() {
    return this._persona;
  },

  /**
   * Get the user's timezone from Odoo (e.g. 'America/Phoenix').
   */
  getTimezone() {
    return this._timezone;
  },

  /**
   * Check if user is logged in.
   */
  isLoggedIn() {
    return this._user !== null && this._personId !== null;
  },
};
