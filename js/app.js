/**
 * Main app controller — view switching, init, toast notifications.
 */
const App = {
  _currentView: 'today', // 'today' | 'week' | 'history'
  _currentScreen: 'list', // 'list' | 'detail'
  _viewsLoaded: { today: false, week: false, history: false },

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

    // Bind UI events
    this._bindEvents();

    // Init list tab swiping
    this._initListTabs();

    // Load today's jobs initially
    await this._loadViewJobs('today');
  },

  /** Map view keys to page titles. */
  _viewTitles: {
    today: "Today's Jobs",
    week: 'This Week',
    history: 'History',
  },

  /** Map view keys to panel indices. */
  _viewIndices: { today: 0, week: 1, history: 2 },
  _indexViews: ['today', 'week', 'history'],

  _bindEvents() {
    // Bind both menu buttons (list and detail)
    this._bindMenuButton('menuBtnList', 'menuDropdownList');
    this._bindMenuButton('menuBtnDetail', 'menuDropdownDetail');

    // Sync buttons
    ['syncBtnList', 'syncBtnDetail'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', () => Sync.manualSync());
    });

    // Logout buttons
    ['logoutBtnList', 'logoutBtnDetail'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', () => {
        if (confirm('Log out?')) Auth.logout();
      });
    });

    // Clock button
    const clockBtn = document.getElementById('clockBtn');
    if (clockBtn) {
      clockBtn.addEventListener('click', () => {
        if (typeof TimeTracking !== 'undefined') TimeTracking.handleHeaderClick();
      });
    }

    // Footer detail buttons
    const footerCallBtn = document.getElementById('footerCallBtn');
    if (footerCallBtn) {
      footerCallBtn.addEventListener('click', () => {
        if (!footerCallBtn.classList.contains('disabled')) {
          Jobs._showContactPicker();
        }
      });
    }

    const footerSmsBtn = document.getElementById('footerSmsBtn');
    if (footerSmsBtn) {
      footerSmsBtn.addEventListener('click', () => {
        if (!footerSmsBtn.classList.contains('disabled')) {
          Jobs._handleSmsButton();
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
      week: 'jobListWeek',
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
    this._viewsLoaded = { today: false, week: false, history: false };
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
