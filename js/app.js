/**
 * Main app controller — view switching, init, toast notifications.
 */
const App = {
  _currentView: 'today', // 'today' | 'week' | 'history'
  _currentScreen: 'list', // 'list' | 'detail'

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

    // Load and display today's jobs
    await this.switchTab('today');
  },

  /** Map view keys to page titles. */
  _viewTitles: {
    today: "Today's Jobs",
    week: 'This Week',
    history: 'History',
  },

  _bindEvents() {
    // Hamburger menu
    const menuBtn = document.getElementById('menuBtn');
    const menuDropdown = document.getElementById('menuDropdown');
    if (menuBtn && menuDropdown) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = menuDropdown.style.display !== 'none';
        menuDropdown.style.display = open ? 'none' : 'block';
      });
      document.addEventListener('click', () => {
        menuDropdown.style.display = 'none';
      });
      menuDropdown.addEventListener('click', (e) => e.stopPropagation());
    }

    // View menu items (Today / This Week / History)
    document.querySelectorAll('.menu-view').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view) {
          if (menuDropdown) menuDropdown.style.display = 'none';
          this.switchTab(view);
        }
      });
    });

    // Sync button (inside menu)
    const syncBtn = document.getElementById('syncBtn');
    if (syncBtn) {
      syncBtn.addEventListener('click', () => {
        if (menuDropdown) menuDropdown.style.display = 'none';
        Sync.manualSync();
      });
    }

    // Clock button
    const clockBtn = document.getElementById('clockBtn');
    if (clockBtn) {
      clockBtn.addEventListener('click', () => {
        if (typeof TimeTracking !== 'undefined') TimeTracking.handleHeaderClick();
      });
    }

    // Logout button (inside menu)
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        if (menuDropdown) menuDropdown.style.display = 'none';
        if (confirm('Log out?')) Auth.logout();
      });
    }
  },

  /**
   * Switch between Today / Week / History tabs.
   */
  async switchTab(view) {
    this._currentView = view;
    this._currentScreen = 'list';

    // Update active state on menu view items
    document.querySelectorAll('.menu-view').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    // Update page title
    this._updatePageTitle(this._viewTitles[view] || "Today's Jobs");

    // Show list view, hide detail view
    this._showScreen('list');

    // Show loading
    const container = document.getElementById('jobList');
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    try {
      await Jobs.loadJobs(view);
      Jobs.renderJobList(container);
    } catch (err) {
      container.innerHTML = `
        <div class="alert alert-error">
          Failed to load jobs: ${Jobs._escapeHtml(err.message)}
        </div>
      `;
    }
  },

  /**
   * Show the job detail view for a specific job.
   */
  async showJobDetail(jobId) {
    this._currentScreen = 'detail';
    this._showScreen('detail');

    // Find the job to get its name for the title
    const job = Jobs._jobs.find(j => j.id === jobId);
    if (job) {
      this._updatePageTitle(job.name || 'Job Detail');
    }

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
    // Restore page title to current view name
    this._updatePageTitle(this._viewTitles[this._currentView] || "Today's Jobs");
    // Remove journal FAB
    Jobs._hideJournalFab();
  },

  /**
   * Update the page title in the bottom header bar.
   */
  _updatePageTitle(title) {
    const el = document.getElementById('pageTitle');
    if (el) el.textContent = title;
  },

  /**
   * Toggle between list and detail screens.
   */
  _showScreen(screen) {
    const listView = document.getElementById('listView');
    const detailView = document.getElementById('detailView');
    const appContent = document.querySelector('.app-content');

    if (listView) listView.classList.toggle('active', screen === 'list');
    if (detailView) detailView.classList.toggle('active', screen === 'detail');
    // Disable outer scroll & padding when in detail view (panels scroll independently)
    if (appContent) appContent.classList.toggle('detail-active', screen === 'detail');
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
