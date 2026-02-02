/**
 * Sync module — handles online/offline sync queue processing.
 * MVP version: syncs status changes when connection is restored.
 */
const Sync = {
  _isOnline: navigator.onLine,
  _isSyncing: false,
  _pendingCount: 0,
  _refreshTimer: null,

  /**
   * Initialize sync — set up online/offline listeners and auto-refresh.
   */
  init() {
    window.addEventListener('online', () => this._onOnline());
    window.addEventListener('offline', () => this._onOffline());

    // Update initial state
    this._isOnline = navigator.onLine;
    this._updateIndicator();

    // Start auto-refresh timer
    this._startAutoRefresh();

    // Check for pending items
    this._updatePendingCount();
  },

  /**
   * Connection restored.
   */
  async _onOnline() {
    this._isOnline = true;
    this._updateIndicator();
    App.showToast('Back online', 'success');

    // Process sync queue
    await this.syncAll();
  },

  /**
   * Connection lost.
   */
  _onOffline() {
    this._isOnline = false;
    this._updateIndicator();
    App.showToast('You are offline — changes will sync later', 'info');
  },

  /**
   * Process all pending sync items.
   */
  async syncAll() {
    if (this._isSyncing || !navigator.onLine) return;
    this._isSyncing = true;
    this._updateIndicator();

    try {
      await this._syncStatusChanges();
      await this._syncPhotos();
      await this._syncJournal();
      await this._syncMaterials();
      await this._syncTimeEntries();
      await this._updatePendingCount();
      App.showToast('Sync complete', 'success');
    } catch (err) {
      console.error('Sync error:', err);
      App.showToast('Sync failed — will retry', 'error');
    } finally {
      this._isSyncing = false;
      this._updateIndicator();
    }
  },

  /**
   * Sync queued status changes.
   */
  async _syncStatusChanges() {
    const pending = await DB.getUnsyncedItems('statusChanges');
    for (const item of pending) {
      try {
        const extraValues = {};
        if (item.gps) {
          extraValues.gps_enroute = item.gps;
          if (item.timestamp) {
            extraValues.gps_enroute_timestamp = item.timestamp;
          }
        }

        await OdooAPI.updateOrderStage(item.job_id, item.stage_id, extraValues);

        // Mark as synced
        item.synced = 1;
        await DB.put('statusChanges', item);
      } catch (err) {
        console.warn('Failed to sync status change:', item, err);
        // Leave unsynced for next attempt
      }
    }
  },

  /**
   * Sync queued photos.
   */
  async _syncPhotos() {
    if (typeof Photos !== 'undefined') {
      const result = await Photos.syncAll();
      if (result.uploaded > 0) {
        console.log(`Synced ${result.uploaded} photos, ${result.failed} failed`);
      }
    }
  },

  /**
   * Sync queued journal entries.
   */
  async _syncJournal() {
    if (typeof Journal !== 'undefined') {
      const result = await Journal.syncAll();
      if (result.uploaded > 0) {
        console.log(`Synced ${result.uploaded} journal entries, ${result.failed} failed`);
      }
    }
  },

  /**
   * Sync queued material entries.
   */
  async _syncMaterials() {
    if (typeof Materials !== 'undefined') {
      const result = await Materials.syncAll();
      if (result.synced > 0) {
        console.log(`Synced ${result.synced} material entries, ${result.failed} failed`);
      }
    }
  },

  /**
   * Sync queued time entries (clock in/out, lunch).
   */
  async _syncTimeEntries() {
    if (typeof TimeTracking !== 'undefined') {
      const result = await TimeTracking.syncAll();
      if (result.synced > 0) {
        console.log(`Synced ${result.synced} time entries, ${result.failed} failed`);
      }
    }
  },

  /**
   * Count pending sync items.
   */
  async _updatePendingCount() {
    try {
      const statusChanges = await DB.getUnsyncedItems('statusChanges');
      const photos = await DB.getUnsyncedItems('photos');
      const timeEntries = await DB.getUnsyncedItems('timeEntries');
      let journalCount = 0;
      try {
        const journalItems = await DB.getUnsyncedItems('journalQueue');
        journalCount = journalItems.length;
      } catch { /* store may not exist yet */ }
      let materialsCount = 0;
      try {
        const materialsItems = await DB.getUnsyncedItems('materialsQueue');
        materialsCount = materialsItems.length;
      } catch { /* store may not exist yet */ }
      this._pendingCount = statusChanges.length + photos.length + timeEntries.length + journalCount + materialsCount;
    } catch {
      this._pendingCount = 0;
    }
    this._updatePendingBadge();
  },

  /**
   * Update the online/offline/syncing indicator in the header.
   */
  _updateIndicator() {
    const badge = document.getElementById('syncBadge');
    if (!badge) return;

    if (this._isSyncing) {
      badge.className = 'sync-badge syncing';
      badge.innerHTML = '<span class="sync-dot"></span> Syncing...';
    } else if (this._isOnline) {
      badge.className = 'sync-badge online';
      badge.innerHTML = '<span class="sync-dot"></span> Online';
    } else {
      badge.className = 'sync-badge offline';
      badge.innerHTML = '<span class="sync-dot"></span> Offline';
    }
  },

  /**
   * Update the pending changes badge.
   */
  _updatePendingBadge() {
    const badge = document.getElementById('pendingBadge');
    if (!badge) return;

    if (this._pendingCount > 0) {
      badge.style.display = 'inline-flex';
      badge.textContent = this._pendingCount;
    } else {
      badge.style.display = 'none';
    }
  },

  /**
   * Manual sync trigger (sync button).
   */
  async manualSync() {
    if (!navigator.onLine) {
      App.showToast('No internet connection', 'error');
      return;
    }

    // Refresh jobs from Odoo
    try {
      await Jobs.loadJobs(Jobs._currentView);
      const container = document.getElementById('jobList');
      if (container) Jobs.renderJobList(container);
    } catch (err) {
      console.warn('Failed to refresh jobs:', err);
    }

    // Process sync queue
    await this.syncAll();
  },

  /**
   * Start auto-refresh timer.
   */
  _startAutoRefresh() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    const interval = CONFIG.AUTO_REFRESH_INTERVAL * 60 * 1000;
    this._refreshTimer = setInterval(() => {
      if (navigator.onLine && !this._isSyncing) {
        this.manualSync();
      }
    }, interval);
  },

  /**
   * Is currently online?
   */
  isOnline() {
    return this._isOnline;
  },

  /**
   * Pending sync count.
   */
  getPendingCount() {
    return this._pendingCount;
  },
};
