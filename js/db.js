/**
 * IndexedDB wrapper for offline data storage.
 */
const DB = {
  _db: null,

  /**
   * Open/initialize the database.
   */
  async init() {
    if (this._db) return this._db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Jobs store
        if (!db.objectStoreNames.contains('jobs')) {
          const jobStore = db.createObjectStore('jobs', { keyPath: 'id' });
          jobStore.createIndex('scheduled_date_start', 'scheduled_date_start', { unique: false });
          jobStore.createIndex('stage_id', 'stage_id', { unique: false });
        }

        // Photos store
        if (!db.objectStoreNames.contains('photos')) {
          const photoStore = db.createObjectStore('photos', { keyPath: 'temp_id' });
          photoStore.createIndex('job_id', 'job_id', { unique: false });
          photoStore.createIndex('category', 'category', { unique: false });
          photoStore.createIndex('synced', 'synced', { unique: false });
        }

        // Time entries store
        if (!db.objectStoreNames.contains('timeEntries')) {
          const timeStore = db.createObjectStore('timeEntries', { keyPath: 'temp_id' });
          timeStore.createIndex('job_id', 'job_id', { unique: false });
          timeStore.createIndex('synced', 'synced', { unique: false });
        }

        // Status changes queue
        if (!db.objectStoreNames.contains('statusChanges')) {
          const statusStore = db.createObjectStore('statusChanges', { keyPath: 'temp_id' });
          statusStore.createIndex('job_id', 'job_id', { unique: false });
          statusStore.createIndex('synced', 'synced', { unique: false });
        }

        // Notes store
        if (!db.objectStoreNames.contains('notes')) {
          db.createObjectStore('notes', { keyPath: 'job_id' });
        }

        // Stages cache
        if (!db.objectStoreNames.contains('stages')) {
          db.createObjectStore('stages', { keyPath: 'id' });
        }

        // App state (user info, last sync, etc.)
        if (!db.objectStoreNames.contains('appState')) {
          db.createObjectStore('appState', { keyPath: 'key' });
        }

        // Journal queue (offline journal entries)
        if (!db.objectStoreNames.contains('journalQueue')) {
          const jqStore = db.createObjectStore('journalQueue', { keyPath: 'temp_id' });
          jqStore.createIndex('job_id', 'job_id', { unique: false });
          jqStore.createIndex('synced', 'synced', { unique: false });
        }

        // Materials queue (offline material entries)
        if (!db.objectStoreNames.contains('materialsQueue')) {
          const mqStore = db.createObjectStore('materialsQueue', { keyPath: 'temp_id' });
          mqStore.createIndex('job_id', 'job_id', { unique: false });
          mqStore.createIndex('synced', 'synced', { unique: false });
        }

        // Office notes queue (offline notes to office)
        if (!db.objectStoreNames.contains('officeNotes')) {
          const onStore = db.createObjectStore('officeNotes', { keyPath: 'temp_id' });
          onStore.createIndex('synced', 'synced', { unique: false });
        }

        // Expenses queue (offline expense entries with receipt images)
        if (!db.objectStoreNames.contains('expensesQueue')) {
          const eqStore = db.createObjectStore('expensesQueue', { keyPath: 'temp_id' });
          eqStore.createIndex('synced', 'synced', { unique: false });
          eqStore.createIndex('created_at', 'created_at', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this._db = event.target.result;
        resolve(this._db);
      };

      request.onerror = (event) => {
        reject(new Error('IndexedDB error: ' + event.target.error));
      };
    });
  },

  /**
   * Generic get-all from a store.
   */
  async getAll(storeName) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  /**
   * Generic get by key.
   */
  async get(storeName, key) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  /**
   * Generic put (insert or update).
   */
  async put(storeName, data) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.put(data);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  /**
   * Generic delete by key.
   */
  async delete(storeName, key) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },

  /**
   * Clear all records in a store.
   */
  async clear(storeName) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },

  /**
   * Get records by index value.
   */
  async getByIndex(storeName, indexName, value) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(value);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  // ========== JOBS ==========

  async saveJobs(jobs) {
    const db = await this.init();
    const tx = db.transaction('jobs', 'readwrite');
    const store = tx.objectStore('jobs');
    for (const job of jobs) {
      store.put(job);
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async getJobs() {
    return this.getAll('jobs');
  },

  async getJob(id) {
    return this.get('jobs', id);
  },

  // ========== STAGES ==========

  async saveStages(stages) {
    const db = await this.init();
    const tx = db.transaction('stages', 'readwrite');
    const store = tx.objectStore('stages');
    for (const stage of stages) {
      store.put(stage);
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async getStages() {
    return this.getAll('stages');
  },

  // ========== APP STATE ==========

  async getState(key) {
    const result = await this.get('appState', key);
    return result ? result.value : null;
  },

  async setState(key, value) {
    return this.put('appState', { key, value });
  },

  // ========== SYNC QUEUE ==========

  async getUnsyncedItems(storeName) {
    return this.getByIndex(storeName, 'synced', 0);
  },

  // ========== BILLING / OPTIONS CACHE (view-only offline) ==========
  // Stored in the appState store (key/value) so no schema migration is
  // needed. Written whenever the Sales/Options tab loads online, and read
  // back to render a read-only view when offline.

  async cacheSaleOrder(jobId, data) {
    return this.setState('so_' + jobId, data);
  },

  async getCachedSaleOrder(jobId) {
    return this.getState('so_' + jobId);
  },

  async cacheJobOptions(jobId, data) {
    return this.setState('opt_' + jobId, data);
  },

  async getCachedJobOptions(jobId) {
    return this.getState('opt_' + jobId);
  },

  async queueStatusChange(jobId, stageId, timestamp, gps, extraValues) {
    return this.put('statusChanges', {
      temp_id: 'sc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      job_id: jobId,
      stage_id: stageId,
      timestamp: timestamp,
      gps: gps,
      extra_values: extraValues || null,
      synced: 0,
    });
  },
};
