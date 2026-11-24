/**
 * Sync module — handles online/offline sync queue processing.
 * MVP version: syncs status changes when connection is restored.
 */
const Sync = {
  _isOnline: navigator.onLine,
  _isSyncing: false,
  _pendingCount: 0,
  _refreshTimer: null,
  OTHER_QUEUES: ['otc_pending', 'oha_pending', 'ohu_pending', 'ohf_pending', 'omt_pending', 'damage_pending', 'comeback_pending', 'review_pending'],

  STORES: ['statusChanges', 'photos', 'timeEntries', 'journalQueue', 'materialsQueue', 'officeNotes', 'expensesQueue', 'wrapupQueue'],
  _retryMs: 15000,
  _retryAt: 0,

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

    // Check for pending items, and keep the "Waiting to send" count fresh (round 3: no badge while offline).
    this._updatePendingCount();
    setInterval(() => this._updatePendingCount(), 5000);
    setInterval(() => this._retry(), 5000);
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
   * Something is waiting (or the signal was weak): ask Odoo for a sign of life, in the background, and send when it
   * answers. Weak signal never fires the browser's "online" event, so things waited for the next refresh (30 min).
   * Backs off to 5 minutes when nothing gets through.
   */
  async _retry() {
    if (this._isSyncing || this._probing || !navigator.onLine || Date.now() < this._retryAt) return;
    if (document.visibilityState !== 'visible') return;
    if (!this._pendingCount && !OdooAPI.isWeak()) { this._retryMs = 15000; return; }
    this._probing = true;
    try {
      const status = await OdooAPI.checkSession();
      if (status === 'valid') {
        OdooAPI.clearWeak();
        const before = this._pendingCount;
        if (before) await this.syncAll(true);
        this._retryMs = this._pendingCount < before || !this._pendingCount ? 15000 : Math.min(this._retryMs * 2, 300000);
      } else {
        this._retryMs = Math.min(this._retryMs * 2, 120000);
      }
    } finally {
      this._probing = false;
      this._retryAt = Date.now() + this._retryMs;
    }
  },

  /** The holiday screens' own queues. */
  async _syncOthers() {
    const all = [
      typeof HolidayFlow !== 'undefined' && (() => HolidayFlow.flush()),
      typeof HolidayFlow !== 'undefined' && (() => HolidayFlow.flushTally()),
      typeof HolidayActual !== 'undefined' && (() => HolidayActual.flush()),
      typeof HolidayUsed !== 'undefined' && (() => HolidayUsed.flush()),
      typeof TakedownCheck !== 'undefined' && (() => TakedownCheck.flush()),
      typeof MyTruck !== 'undefined' && (() => MyTruck.flush()),
      typeof Reviews !== 'undefined' && (() => Reviews.flush()),
    ].filter(Boolean);
    for (const send of all) {
      if (OdooAPI.noSignal()) return;
      await send().catch(err => console.warn('Sync: a queue was not sent', err));
    }
  },

  /** Damage and come-back reports go with their photos. */
  async _syncReports() {
    for (const send of [
      typeof DamageReport !== 'undefined' && (() => DamageReport.flush()),
      typeof ComeBack !== 'undefined' && (() => ComeBack.flush()),
    ].filter(Boolean)) {
      await send().catch(err => console.warn('Sync: a report was not sent', err));
    }
  },

  /**
   * Process all pending sync items: the small ones first, photos last (they used to hold up everything behind them).
   */
  async syncAll(quiet) {
    if (this._isSyncing || !navigator.onLine) return;
    this._isSyncing = true;
    this._updateIndicator();

    try {
      for (const step of ['_syncTimeEntries', '_syncStatusChanges', '_syncOthers', '_syncWrapups', '_syncJournal',
        '_syncMaterials', '_syncOfficeNotes', '_syncReports', '_syncPhotos', '_syncExpenses']) {
        await this[step]();
        if (OdooAPI.noSignal()) break;  // lost it again: the rest waits
      }
      await this._updatePendingCount();
      if (!quiet) App.showToast(this._pendingCount ? 'Some items still wait to be sent' : 'Sync complete', this._pendingCount ? 'info' : 'success');
    } catch (err) {
      console.error('Sync error:', err);
      if (!quiet) App.showToast('Sync failed — will retry', 'error');
    } finally {
      this._isSyncing = false;
      this._updateIndicator();
    }
  },

  /**
   * Sync queued status changes.
   */
  async _syncStatusChanges() {
    const pending = (await DB.getUnsyncedItems('statusChanges'))
      .sort((x, y) => String(x.timestamp).localeCompare(String(y.timestamp)));
    for (const item of pending) {
      try {
        // Already done, or further along (the office, a crew-mate, this phone later on): a late "En Route" must not
        // reopen it (FO1021, Nov 2026: Completed, then back to En Route two days later).
        const late = Date.now() - new Date(String(item.timestamp).replace(' ', 'T') + 'Z').getTime() > 60000;
        if (late && await this._isBehind(item)) {
          item.synced = 1;
          item.skipped = 'the job was already further along';
          await DB.put('statusChanges', item);
          continue;
        }
        const extraValues = item.extra_values ? { ...item.extra_values } : {};
        if (item.gps && !extraValues.gps_enroute) {
          extraValues.gps_enroute = item.gps;
        }
        if (item.timestamp && !extraValues.gps_enroute_timestamp && extraValues.gps_enroute) {
          extraValues.gps_enroute_timestamp = item.timestamp;
        }

        await OdooAPI.updateOrderStage(item.job_id, item.stage_id, extraValues);

        // Mark as synced
        item.synced = 1;
        await DB.put('statusChanges', item);
      } catch (err) {
        console.warn('Failed to sync status change:', item, err);
        if (OdooAPI.isOffline(err)) return;  // in order, later
      }
    }
  },

  /** The job in Odoo is closed, or past the stage this queued change would set. Throws with no signal. */
  async _isBehind(item) {
    const rows = await OdooAPI.read('fsm.order', [item.job_id], ['stage_id']);
    const now = rows && rows[0] && rows[0].stage_id && Jobs.getStage(rows[0].stage_id[0]);
    const want = Jobs.getStage(item.stage_id);
    if (!now || !want || now.id === want.id) return false;
    return !!now.is_closed || (now.sequence || 0) > (want.sequence || 0);
  },

  /**
   * Sync queued Close Job / early wrap-ups (jobs closed with no signal).
   */
  async _syncWrapups() {
    let pending = [];
    try {
      pending = await DB.getUnsyncedItems('wrapupQueue');
    } catch { return; /* store may not exist yet */ }
    for (const item of pending) {
      try {
        if (item.type === 'early') {
          await OdooAPI.submitEarlyWrapup(item.order_id, item.data);
        } else {
          await OdooAPI.submitWrapup(item.order_id, item.data);
        }
        item.synced = 1;
        await DB.put('wrapupQueue', item);
      } catch (err) {
        console.warn('Failed to sync wrap-up:', item, err);
        if (OdooAPI.isOffline(err)) return;
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
      if (result.failed > 0 && !result.offline) {
        App.showToast(`${result.failed} photo(s) failed to upload — will retry on next sync`, 'error');
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
   * Sync queued office notes.
   */
  async _syncOfficeNotes() {
    if (typeof TimeTracking !== 'undefined') {
      const result = await TimeTracking.syncOfficeNotes();
      if (result.synced > 0) {
        console.log(`Synced ${result.synced} office notes, ${result.failed} failed`);
      }
    }
  },

  async _syncExpenses() {
    if (typeof Expenses !== 'undefined') {
      const result = await Expenses.syncAll();
      if (result.synced > 0) {
        console.log(`Synced ${result.synced} expenses, ${result.failed} failed`);
      }
      if (result.failed > 0) {
        App.showToast(`${result.failed} expense(s) failed to sync — will retry`, 'error');
      }
    }
  },

  /**
   * Count pending sync items.
   */
  async _updatePendingCount() {
    let count = 0;
    for (const store of this.STORES) {
      count += await DB.countUnsynced(store).catch(() => 0);
    }
    // The holiday screens, My Truck, damage, come-backs and reviews keep their own queues on the phone.
    for (const key of this.OTHER_QUEUES) {
      try {
        const q = await DB.getState(key);
        if (Array.isArray(q)) count += q.length;
        else if (q && typeof q === 'object') count += Object.keys(q).length;
      } catch { /* nothing kept */ }
    }
    this._pendingCount = count;
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
      badge.textContent = `Waiting to send (${this._pendingCount})`;
      badge.title = 'Saved on this phone; sent when there is signal';
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
      // Manual sync = "get me ready" — force a prewarm of today's AND the
      // upcoming (next-scheduled-day) jobs' sale order + options so everything
      // is offline-ready right now, bypassing the normal throttle.
      if (Jobs._currentView === 'today') {
        const jobs = (Jobs._jobs || []).concat(Jobs._upcomingJobs || []);
        Jobs.prewarmJobData(jobs, { force: true });
      }
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
