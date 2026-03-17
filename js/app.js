/**
 * Main app controller — view switching, init, toast notifications.
 */
const App = {
  _currentView: 'today', // 'today' | 'history'
  _currentScreen: 'list', // 'list' | 'detail'
  _viewsLoaded: { today: false, history: false },

  /**
   * Initialize the app after login.
   */
  async init() {
    // Init IndexedDB
    await DB.init();

    // Try to restore session
    const restored = await Auth.tryRestore();
    if (!restored) {
      window.location.href = 'index.html';
      return;
    }

    // Update header with user info
    const user = Auth.getUser();
    const userEl = document.getElementById('userName');
    if (userEl) userEl.textContent = user.name || user.username;

    // Load stages
    await Jobs.loadStages();

    // Init sync
    Sync.init();

    // Init time tracking
    if (typeof TimeTracking !== 'undefined') {
      await TimeTracking.init();
    }

    // Init themes
    if (typeof Themes !== 'undefined') {
      Themes.init();
    }

    // Init camera mode toggle (per-device setting)
    if (typeof Photos !== 'undefined') {
      Photos.initCameraModeToggle();
    }

    // Start helpdesk badge polling
    if (typeof Helpdesk !== 'undefined') {
      Helpdesk.startBadgePolling();
    }

    // Bind UI events
    this._bindEvents();

    // Show admin-only menu items
    if (Auth.isAdmin()) {
      ['viewAsBtnList', 'viewAsBtnDetail'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = '';
      });
    }

    // Init list tab swiping
    this._initListTabs();

    // Load today's jobs initially
    await this._loadViewJobs('today');
  },

  /** Map view keys to page titles. */
  _viewTitles: {
    today: "Today's Jobs",
    history: 'History',
  },

  /** Map view keys to panel indices. */
  _viewIndices: { today: 0, history: 1 },
  _indexViews: ['today', 'history'],

  _bindEvents() {
    const bindMenuAction = (id, handler) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      let lastTouch = 0;
      const invoke = (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        document.querySelectorAll('.menu-dropdown').forEach(d => { d.style.display = 'none'; });
        handler();
      };
      btn.addEventListener('touchstart', (e) => {
        lastTouch = Date.now();
        invoke(e);
      }, { passive: false });
      btn.addEventListener('click', (e) => {
        if (Date.now() - lastTouch < 500) return;
        invoke(e);
      });
    };

    // Bind both menu buttons (list and detail)
    this._bindMenuButton('menuBtnList', 'menuDropdownList');
    this._bindMenuButton('menuBtnDetail', 'menuDropdownDetail');

    // Sync buttons
    ['syncBtnList', 'syncBtnDetail'].forEach(id => {
      bindMenuAction(id, () => Sync.manualSync());
    });

    // Logout buttons
    ['logoutBtnList', 'logoutBtnDetail'].forEach(id => {
      bindMenuAction(id, () => {
        if (confirm('Log out?')) Auth.logout();
      });
    });

    // Clear cache buttons
    ['clearCacheBtnList', 'clearCacheBtnDetail'].forEach(id => {
      bindMenuAction(id, () => this._clearCache());
    });

    // Theme buttons
    ['themeBtnList', 'themeBtnDetail'].forEach(id => {
      bindMenuAction(id, () => {
        if (typeof Themes !== 'undefined') Themes.showPicker();
      });
    });

    // Import settings buttons
    ['importSettingsBtnList', 'importSettingsBtnDetail'].forEach(id => {
      bindMenuAction(id, () => this._importSettings());
    });

    // View As Worker buttons
    ['viewAsBtnList', 'viewAsBtnDetail'].forEach(id => {
      bindMenuAction(id, () => this._showViewAsPicker());
    });

    // Persona exit banner button
    const personaExitBtn = document.getElementById('personaExitBtn');
    if (personaExitBtn) {
      personaExitBtn.addEventListener('click', () => this._clearPersona());
    }

    // Adjust shift buttons
    ['fixShiftBtnList', 'fixShiftBtnDetail'].forEach(id => {
      bindMenuAction(id, () => {
        if (typeof TimeTracking !== 'undefined') TimeTracking.manualAdjustShift();
      });
    });

    // Note to Office buttons
    ['noteBtnList', 'noteBtnDetail'].forEach(id => {
      bindMenuAction(id, () => {
        if (typeof TimeTracking !== 'undefined') TimeTracking.sendOfficeNote();
      });
    });

    // Time Off buttons
    ['timeOffBtnList', 'timeOffBtnDetail'].forEach(id => {
      bindMenuAction(id, () => {
        if (typeof TimeOff !== 'undefined') TimeOff.openModal();
      });
    });

    // Help button (list footer)
    const footerHelpBtn = document.getElementById('footerHelpBtn');
    if (footerHelpBtn) {
      footerHelpBtn.addEventListener('click', () => {
        if (typeof Helpdesk !== 'undefined') Helpdesk.showHelpMenu();
      });
    }

    // Timesheet button
    const timesheetBtn = document.getElementById('timesheetBtn');
    if (timesheetBtn) {
      timesheetBtn.addEventListener('click', () => {
        if (typeof Timesheet !== 'undefined') Timesheet.openModal();
      });
    }

    // Clock button
    const clockBtn = document.getElementById('clockBtn');
    if (clockBtn) {
      clockBtn.addEventListener('click', () => {
        if (typeof TimeTracking !== 'undefined') TimeTracking.handleHeaderClick();
      });
    }

    // Footer detail buttons
    const footerContactBtn = document.getElementById('footerContactBtn');
    if (footerContactBtn) {
      footerContactBtn.addEventListener('click', () => {
        if (!footerContactBtn.classList.contains('disabled')) {
          Jobs._showContactPicker();
        }
      });
    }

    const footerCameraBtn = document.getElementById('footerCameraBtn');
    if (footerCameraBtn) {
      footerCameraBtn.addEventListener('click', () => {
        if (Jobs._currentJob) {
          Jobs._showCategoryPicker();
        }
      });
    }

    const footerJournalBtn = document.getElementById('footerJournalBtn');
    if (footerJournalBtn) {
      footerJournalBtn.addEventListener('click', () => {
        if (Jobs._currentJob) {
          Jobs._showJournalModal(Jobs._currentJob.id);
        }
      });
    }

    // List tab clicks
    document.querySelectorAll('.list-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const view = tab.dataset.view;
        if (view) this.switchTab(view);
      });
    });
  },

  /**
   * Bind a menu button and its dropdown.
   */
  _bindMenuButton(btnId, dropdownId) {
    const btn = document.getElementById(btnId);
    const dropdown = document.getElementById(dropdownId);
    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = dropdown.style.display !== 'none';
      // Close all dropdowns first
      document.querySelectorAll('.menu-dropdown').forEach(d => d.style.display = 'none');
      dropdown.style.display = open ? 'none' : 'block';
    });

    document.addEventListener('click', () => {
      dropdown.style.display = 'none';
    });

    dropdown.addEventListener('click', (e) => e.stopPropagation());
  },

  /**
   * Initialize list tab swiping and scroll sync.
   */
  _initListTabs() {
    const panels = document.getElementById('listPanels');
    if (!panels) return;

    let ticking = false;
    panels.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const panelWidth = panels.offsetWidth;
        if (panelWidth > 0) {
          const idx = Math.round(panels.scrollLeft / panelWidth);
          const view = this._indexViews[idx];
          if (view && view !== this._currentView) {
            this._setActiveTab(view);
            this._loadViewJobs(view);
          }
        }
        ticking = false;
      });
    });
  },

  /**
   * Switch to a specific list tab.
   */
  async switchTab(view) {
    this._currentView = view;
    this._currentScreen = 'list';

    // Update tab UI
    this._setActiveTab(view);

    // Update title
    this._updateListTitle(this._viewTitles[view] || "Today's Jobs");

    // Scroll to panel
    const panels = document.getElementById('listPanels');
    if (panels) {
      const idx = this._viewIndices[view];
      const panelWidth = panels.offsetWidth;
      panels.scrollTo({ left: idx * panelWidth, behavior: 'smooth' });
    }

    // Show list view
    this._showScreen('list');

    // Load jobs for this view
    await this._loadViewJobs(view);
  },

  /**
   * Set the active tab visually.
   */
  _setActiveTab(view) {
    this._currentView = view;
    document.querySelectorAll('.list-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.view === view);
    });
    this._updateListTitle(this._viewTitles[view] || "Today's Jobs");
  },

  /**
   * Load jobs for a specific view if not already loaded.
   */
  async _loadViewJobs(view) {
    const containerMap = {
      today: 'jobListToday',
      history: 'jobListHistory',
    };

    const container = document.getElementById(containerMap[view]);
    if (!container) return;

    // Skip if already loaded (unless forced refresh)
    if (this._viewsLoaded[view]) return;

    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    try {
      await Jobs.loadJobs(view);
      Jobs.renderJobList(container);
      this._viewsLoaded[view] = true;
    } catch (err) {
      container.innerHTML = `
        <div class="alert alert-error">
          Failed to load jobs: ${Jobs._escapeHtml(err.message)}
        </div>
      `;
    }
  },

  /**
   * Force refresh all views.
   */
  async refreshAllViews() {
    this._viewsLoaded = { today: false, history: false };
    await this._loadViewJobs(this._currentView);
  },

  /**
   * Show the job detail view for a specific job.
   */
  async showJobDetail(jobId) {
    this._currentScreen = 'detail';
    this._showScreen('detail');

    const container = document.getElementById('jobDetail');
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    try {
      await Jobs.renderJobDetail(jobId, container);
    } catch (err) {
      container.innerHTML = `
        <div class="alert alert-error">
          Failed to load job details: ${Jobs._escapeHtml(err.message)}
        </div>
      `;
    }
  },

  /**
   * Return to the job list.
   */
  showJobList() {
    this._currentScreen = 'list';
    this._showScreen('list');
    // Reset footer bar (disable call/sms buttons)
    Jobs._resetFooter();
  },

  /**
   * Update the list title bar.
   */
  _updateListTitle(title) {
    const el = document.getElementById('listTitle');
    if (el) el.textContent = title;
  },

  /**
   * Toggle between list and detail screens.
   */
  _showScreen(screen) {
    const listView = document.getElementById('listView');
    const detailView = document.getElementById('detailView');
    const footerList = document.getElementById('footerList');
    const footerDetail = document.getElementById('footerDetail');

    if (listView) listView.classList.toggle('active', screen === 'list');
    if (detailView) detailView.classList.toggle('active', screen === 'detail');

    // Switch footer
    if (footerList) footerList.style.display = screen === 'list' ? 'flex' : 'none';
    if (footerDetail) footerDetail.style.display = screen === 'detail' ? 'flex' : 'none';
  },

  /**
   * Import PWA settings from a JSON file exported by the office app.
   */
  _importSettings() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = JSON.parse(reader.result);
          // Store QR code separately if included
          if (imported._venmo_qr_base64) {
            localStorage.setItem('pwa_venmo_qr', imported._venmo_qr_base64);
            delete imported._venmo_qr_base64;
          }
          localStorage.setItem('pwa_settings', JSON.stringify(imported));
          // Apply to live CONFIG
          const keys = [
            'VENMO_USERNAME', 'CHANGE_ORDER_THRESHOLD',
            'SMS_WEBHOOK_URL', 'ENABLE_SMS_NOTIFICATIONS', 'ODOO_URL',
            'SMS_TEMPLATE_ENROUTE', 'SMS_TEMPLATE_PAYMENT', 'SMS_TEMPLATE_RECEIPT',
            'SHLINK_BASE_URL', 'SHLINK_API_KEY', 'SHLINK_SLUG_PATTERN',
          ];
          keys.forEach(function(k) {
            if (imported[k] !== undefined) CONFIG[k] = imported[k];
          });
          this.showToast('Settings imported successfully', 'success');
        } catch (err) {
          this.showToast('Invalid settings file', 'error');
        }
      };
      reader.readAsText(file);
    });
    input.click();
  },

  /**
   * Clear all caches and reload the app.
   */
  async _clearCache() {
    if (!confirm('Clear cache and reload? This will refresh all app data.')) return;

    try {
      // Unregister service workers
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const reg of registrations) {
          await reg.unregister();
        }
      }

      // Clear all caches
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        for (const name of cacheNames) {
          await caches.delete(name);
        }
      }

      // Reload the page
      this.showToast('Cache cleared, reloading...', 'success');
      setTimeout(() => {
        window.location.reload(true);
      }, 500);
    } catch (err) {
      this.showToast('Failed to clear cache: ' + err.message, 'error');
    }
  },

  // ========== VIEW AS WORKER ==========

  async _showViewAsPicker() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:320px;">
        <div class="modal-header">
          <h3>View As Worker</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body" style="padding:0;">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const body = overlay.querySelector('.modal-body');
    try {
      const workers = await OdooAPI.getFsmWorkers();
      const realUid = Auth.getRealUser() && Auth.getRealUser().uid;
      const others  = workers.filter(w => w.uid !== realUid);

      if (others.length === 0) {
        body.innerHTML = `<p style="padding:var(--spacing-md);color:var(--text-muted);">No other workers found.</p>`;
        return;
      }

      body.innerHTML = others.map(w => `
        <div class="view-as-row" data-uid="${w.uid}" data-person-id="${w.personId}"
             data-employee-id="${w.employeeId || ''}" data-name="${this._escAttr(w.name)}">
          ${this._escHtml(w.name)}
        </div>`).join('');

      body.querySelectorAll('.view-as-row').forEach(row => {
        row.addEventListener('click', () => {
          close();
          this._setPersona({
            uid:        parseInt(row.dataset.uid),
            name:       row.dataset.name,
            personId:   parseInt(row.dataset.personId),
            employeeId: row.dataset.employeeId ? parseInt(row.dataset.employeeId) : null,
          });
        });
      });
    } catch (err) {
      body.innerHTML = `<p style="padding:var(--spacing-md);color:var(--error-color);">Failed to load workers.</p>`;
    }
  },

  async _setPersona(worker) {
    Auth.setPersona(worker);
    this._updatePersonaBanner();
    if (typeof Helpdesk !== 'undefined') {
      Helpdesk._allTickets = [];
      Helpdesk._filterTeam = null;
      Helpdesk._filterStage = null;
    }
    await this.refreshAllViews();
    this.showToast(`Viewing as ${worker.name}`, 'info');
  },

  _clearPersona() {
    Auth.clearPersona();
    this._updatePersonaBanner();
    if (typeof Helpdesk !== 'undefined') {
      Helpdesk._allTickets = [];
      Helpdesk._filterTeam = null;
      Helpdesk._filterStage = null;
    }
    this.refreshAllViews();
    this.showToast('Viewing as yourself', 'success');
  },

  _updatePersonaBanner() {
    const banner = document.getElementById('personaBanner');
    const text   = document.getElementById('personaBannerText');
    if (!banner || !text) return;
    const persona = Auth.getPersona();
    if (persona) {
      text.textContent = `👁️ Viewing as ${persona.name}`;
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
    }
  },

  _escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  _escAttr(str) {
    return String(str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  /**
   * Show a toast notification.
   */
  showToast(message, type) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type || ''}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },
};

// Handle back button on mobile
window.addEventListener('popstate', () => {
  if (App._currentScreen === 'detail') {
    App.showJobList();
  }
});

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
