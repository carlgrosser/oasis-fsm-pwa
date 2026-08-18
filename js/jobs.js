/**
 * Jobs module — fetch, cache, display, and manage FSM orders.
 */
const Jobs = {
  _stages: [],       // cached FSM stages
  _stageMap: {},     // id → stage object
  _jobs: [],         // current job list
  _currentView: 'today',

  /**
   * Load stages from Odoo (or cache).
   */
  async loadStages() {
    // Try cache first
    const cached = await DB.getStages();
    const haveCache = cached && cached.length > 0;
    if (haveCache) {
      this._stages = cached;
    }
    this._buildStageMap();

    if (!navigator.onLine) return;

    // Refresh from Odoo. When we already have a cached copy, do it in the
    // background so a weak signal can't stall launch. Only block on the
    // network for the very first load, when we have nothing to show yet.
    const refresh = async () => {
      try {
        const stages = await OdooAPI.getStages();
        this._stages = stages;
        this._buildStageMap();
        await DB.saveStages(stages);
      } catch (err) {
        console.warn('Failed to fetch stages:', err);
      }
    };

    if (haveCache) {
      refresh(); // fire-and-forget
    } else {
      await refresh();
    }
  },

  /** Rebuild the id → stage lookup map from this._stages. */
  _buildStageMap() {
    this._stageMap = {};
    for (const s of this._stages) {
      this._stageMap[s.id] = s;
    }
  },

  /**
   * Get stage info by ID.
   */
  getStage(stageId) {
    // stageId from Odoo is often [id, name] tuple
    const id = Array.isArray(stageId) ? stageId[0] : stageId;
    return this._stageMap[id] || null;
  },

  /**
   * Get stage name from stage_id field value.
   */
  getStageName(stageId) {
    if (Array.isArray(stageId)) return stageId[1];
    const stage = this._stageMap[stageId];
    return stage ? stage.name : 'Unknown';
  },

  /**
   * Map a stage name to a CSS class suffix.
   */
  getStatusClass(stageName) {
    const name = (stageName || '').toLowerCase();
    if (name.includes('dispatch')) return 'dispatched';
    if (name.includes('route')) return 'enroute';
    if (name.includes('arrived')) return 'arrived';
    if (name.includes('progress')) return 'progress';
    if (name.includes('complete') || name.includes('done') || name.includes('closed')) return 'complete';
    if (name.includes('cancel')) return 'cancelled';
    return 'scheduled'; // default for new/scheduled
  },

  _allJobs: [],       // full unfiltered list (for client-side search)
  _searchQuery: '',   // current search string

  /**
   * Apply search filter against _allJobs, update _jobs, re-render current container.
   */
  applySearch(query) {
    this._searchQuery = (query || '').trim().toLowerCase();
    if (!this._searchQuery) {
      this._jobs = this._allJobs.slice();
    } else {
      this._jobs = this._allJobs.filter(j => {
        const customer = Array.isArray(j.location_id) ? j.location_id[1] : (j.location_id || '');
        const address = [j.street, j.city].filter(Boolean).join(' ');
        const name = j.name || '';
        const haystack = (customer + ' ' + address + ' ' + name).toLowerCase();
        return haystack.includes(this._searchQuery);
      });
    }
    const listId = this._currentView === 'today' ? 'jobListToday' : 'jobListHistory';
    const container = document.getElementById(listId);
    if (container) this.renderJobList(container);
  },

  _historyCompletedOffset: 0, // Pagination offset for "load more" in history
  _historyHasMore: false, // Whether there are more completed jobs to load
  _upcomingJobs: [], // Jobs on the next scheduled day (shown below today's jobs)
  _overdueCount: 0,      // Overdue jobs count (for today banner)
  _notClosedCount: 0,    // Completed-but-not-wrapped-up count (for today banner, excludes overdue)
  // Invoicing is the office's job — techs are not shown or counted on it.
  // Payment collection still is theirs (they take Venmo/cash/check on site),
  // so the Unpaid tag stays.
  _unpaidIds: new Set(),      // IDs of closed jobs with unpaid posted invoice

  /**
   * Fetch jobs from Odoo for the given date range.
   */
  async fetchJobs(view) {
    const personId = Auth.getPersonId();
    if (!personId) throw new Error('Not logged in');

    const now = new Date();

    if (view === 'today') {
      const dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dateTo = new Date(dateFrom);
      dateTo.setDate(dateTo.getDate() + 1);
      const fromStr = dateFrom.toISOString().replace('T', ' ').slice(0, 19);
      const toStr = dateTo.toISOString().replace('T', ' ').slice(0, 19);
      return OdooAPI.getMyOrders(personId, fromStr, toStr);
    } else {
      // history — handled separately
      return this._fetchHistoryJobs(personId);
    }
  },

  /**
   * Fetch jobs on the next calendar day (after today) that has any scheduled jobs.
   * Returns all jobs on that day, or [] if nothing is scheduled in the next 14 days.
   */
  async fetchUpcomingJobs(personId) {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const lookAheadEnd = new Date(tomorrow);
    lookAheadEnd.setDate(lookAheadEnd.getDate() + 13); // 14 days total

    const fromStr = tomorrow.toISOString().replace('T', ' ').slice(0, 19);
    const toStr = lookAheadEnd.toISOString().replace('T', ' ').slice(0, 19);

    const jobs = await OdooAPI.getMyOrders(personId, fromStr, toStr);
    if (!jobs || jobs.length === 0) return [];

    // Find the earliest scheduled date among returned jobs
    const firstDate = this._parseOdooDatetime(jobs[0].scheduled_date_start);
    if (!firstDate) return [];

    // Return only jobs that fall on the same calendar day as the first job
    const firstDay = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
    const nextDay = new Date(firstDay);
    nextDay.setDate(nextDay.getDate() + 1);

    return jobs.filter(job => {
      const d = this._parseOdooDatetime(job.scheduled_date_start);
      return d && d >= firstDay && d < nextDay;
    });
  },

  // Cache for the overdue/completed base fetch — the today banner counts and
  // the History tab need the same two lists, and workers typically open
  // History right after seeing the banner.
  _historyFetchCache: null,        // { ts, overdueJobs, completedJobs }
  _HISTORY_CACHE_TTL: 60000,       // ms

  /**
   * Fetch the overdue (uncompleted past) and completed (last 30 days) job
   * lists, with a short cache shared by fetchHistoryCounts and
   * _fetchHistoryJobs. Invalidated on stage changes and job reopen.
   */
  async _fetchHistoryBase(personId) {
    const cached = this._historyFetchCache;
    if (cached && Date.now() - cached.ts < this._HISTORY_CACHE_TTL) {
      return cached;
    }

    const now = new Date();
    // Use local midnight so today's jobs don't bleed into overdue
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayStr = todayMidnight.toISOString().replace('T', ' ').slice(0, 19);

    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().replace('T', ' ').slice(0, 19);

    const [overdueJobs, completedJobs] = await Promise.all([
      OdooAPI.getOverdueOrders(personId, todayStr),
      OdooAPI.getCompletedOrders(personId, thirtyDaysAgoStr, 0),
    ]);

    this._historyFetchCache = { ts: Date.now(), overdueJobs, completedJobs };
    return this._historyFetchCache;
  },

  /**
   * Fetch counts of overdue and not-closed jobs for the today banner.
   * Overdue = uncompleted jobs scheduled before today — the work never got
   *   finished, and only the assigned tech can advance the stage.
   * Not closed = completed-stage jobs where wrapup_submitted is false — the
   *   work is done but the wrap-up (photos/signature/resolution) is missing.
   * Invoicing state is deliberately absent: that belongs to the office.
   */
  async fetchHistoryCounts(personId) {
    const { overdueJobs, completedJobs } = await this._fetchHistoryBase(personId);

    // getBillingStates requires a module upgrade — catch independently so
    // overdue/not-closed counts still work if the method isn't installed yet.
    let billingStates = { unpaid_ids: [] };
    try {
      billingStates = await OdooAPI.getBillingStates(personId);
    } catch (e) { /* module not yet upgraded */ }

    const overdueCount = overdueJobs.length;
    const notClosedCount = completedJobs.filter(j => !j.wrapup_submitted).length;
    const unpaidIds = new Set(billingStates.unpaid_ids || []);
    return { overdueCount, notClosedCount, unpaidIds };
  },

  /**
   * Fetch history jobs: overdue (uncompleted past) + completed (last 30 days).
   */
  async _fetchHistoryJobs(personId) {
    // Reset pagination
    this._historyCompletedOffset = 0;

    const { overdueJobs, completedJobs } = await this._fetchHistoryBase(personId);

    // Mark overdue jobs
    overdueJobs.forEach(job => { job._isOverdue = true; });

    // Check if there might be more completed jobs
    this._historyHasMore = completedJobs.length >= CONFIG.JOBS_PER_PAGE;

    // Separate completed jobs: not-closed float to top alongside overdue, fully-closed go below divider
    const notClosedCompleted = completedJobs.filter(j => !j.wrapup_submitted);
    const closedCompleted = completedJobs.filter(j => j.wrapup_submitted);

    return [...overdueJobs, ...notClosedCompleted, ...closedCompleted];
  },

  /**
   * Load more completed history jobs (pagination).
   */
  async loadMoreHistory() {
    const personId = Auth.getPersonId();
    if (!personId) return [];

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().replace('T', ' ').slice(0, 19);

    this._historyCompletedOffset += CONFIG.JOBS_PER_PAGE;
    const moreJobs = await OdooAPI.getCompletedOrders(personId, thirtyDaysAgoStr, this._historyCompletedOffset);

    this._historyHasMore = moreJobs.length >= CONFIG.JOBS_PER_PAGE;

    // Append to current jobs list
    this._jobs = [...this._jobs, ...moreJobs];
    return moreJobs;
  },

  /**
   * Load jobs — cache-first.
   *
   * Renders instantly from the IndexedDB cache, then (if online) refreshes
   * from Odoo. Pass `onRefresh` to be called after a successful background
   * refresh so the caller can re-render with fresh data; without it, the
   * network refresh is awaited (used by manual sync / post-action reloads).
   *
   * On weak signal the network refresh times out (see CONFIG.RPC_TIMEOUT_MS)
   * and the cached data simply stays on screen — the app never hangs.
   */
  async loadJobs(view, onRefresh) {
    this._currentView = view || 'today';

    // 1) Instant render from cache (filtered client-side for this view).
    const cached = await DB.getJobs();
    const hadCache = !!(cached && cached.length > 0);
    this._applyJobs(this._filterCachedJobs(cached || [], this._currentView));
    // Counts/upcoming aren't cached — they populate on the network refresh.
    this._upcomingJobs = [];
    this._overdueCount = 0;
    this._notClosedCount = 0;
    this._unpaidIds = new Set();

    // 2) Offline → cache is all we have.
    if (!navigator.onLine) return this._jobs;

    // 3) Refresh from Odoo. The server applies the view's domain, so its
    //    result is used as-is (no client-side re-filter).
    const doRefresh = async () => {
      try {
        const personId = Auth.getPersonId();
        // Fetch jobs + upcoming in one group; billing states separately so
        // a missing server method doesn't break the whole job load.
        const upcomingPromise = this._currentView === 'today' && personId
          ? this.fetchUpcomingJobs(personId)
          : Promise.resolve([]);
        const countsPromise = personId
          ? this.fetchHistoryCounts(personId).catch(() => null)
          : Promise.resolve(null);

        const [fetchedJobs, upcoming, counts] = await Promise.all([
          this.fetchJobs(this._currentView),
          upcomingPromise,
          countsPromise,
        ]);
        this._upcomingJobs = this._currentView === 'today' ? (upcoming || []) : [];
        this._overdueCount = counts ? (counts.overdueCount || 0) : 0;
        this._notClosedCount = counts ? (counts.notClosedCount || 0) : 0;
        this._unpaidIds = counts ? (counts.unpaidIds || new Set()) : new Set();

        // Attach each job's profile before caching, so the photo gate, stage
        // flow and section visibility all work offline too.
        await this._attachProfiles(fetchedJobs.concat(this._upcomingJobs || []));

        await DB.saveJobs(fetchedJobs);
        await DB.setState('lastSync', Date.now());
        this._applyJobs(fetchedJobs);
        if (onRefresh) onRefresh();

        // Prewarm the offline cache (throttled internally): pre-fetch each
        // job's sale order + options so they're viewable offline even if the
        // tech never opened them on signal. Covers today's jobs AND the
        // upcoming/next-scheduled-day jobs (what the Today view shows as
        // "tomorrow"), since techs often review the next day's work offline.
        if (this._currentView === 'today') {
          const prewarmJobs = fetchedJobs.concat(this._upcomingJobs || []);
          this.prewarmJobData(prewarmJobs); // fire-and-forget
        }
      } catch (err) {
        // Timeout or network error — keep whatever we rendered from cache.
        console.warn('Failed to refresh jobs from Odoo, using cache:', err);
      }
    };

    // Background-refresh only when we had cache to show AND a callback to
    // re-render with. Otherwise await so the caller gets fresh data (or, on
    // first-ever launch, we wait rather than flash an empty state).
    if (onRefresh && hadCache) {
      doRefresh();
    } else {
      await doRefresh();
    }
    return this._jobs;
  },

  /**
   * Apply a job array to the working set, respecting any active search filter.
   */
  _applyJobs(jobs) {
    this._allJobs = jobs || [];
    if (this._searchQuery) {
      this.applySearch(this._searchQuery);
    } else {
      this._jobs = this._allJobs.slice();
    }
  },

  /**
   * Prewarm the offline cache for a set of jobs by fetching each one's sale
   * order + options and storing them, so the Sales/Options tabs are viewable
   * offline without the tech having opened each job on signal first.
   *
   * Runs sequentially (gentle on the server), in the background, and bails the
   * moment we drop offline. Throttled via lastPrewarm so it fires once at
   * login and at most every CONFIG.PREWARM_MIN_INTERVAL_MS afterwards. Pass
   * { force: true } to skip the throttle (e.g. manual sync).
   */
  async prewarmJobData(jobs, opts) {
    const force = !!(opts && opts.force);
    if (!navigator.onLine || !Array.isArray(jobs) || jobs.length === 0) return;
    if (this._prewarming) return; // don't overlap runs

    if (!force) {
      const last = await DB.getState('lastPrewarm').catch(() => null);
      const interval = CONFIG.PREWARM_MIN_INTERVAL_MS || 1800000;
      if (last && (Date.now() - last) < interval) return; // prewarmed recently
    }

    this._prewarming = true;
    let cached = 0;
    try {
      for (const job of jobs) {
        if (!navigator.onLine) break; // stop if we lose connectivity mid-run
        try {
          const so = await OdooAPI.getSaleOrder(job.id);
          await DB.cacheSaleOrder(job.id, so);
        } catch { /* skip this job's SO */ }
        try {
          const options = await OdooAPI.getJobOptions(job.id);
          await DB.cacheJobOptions(job.id, options);
        } catch { /* skip this job's options */ }
        cached++;
      }
      if (cached > 0) {
        await DB.setState('lastPrewarm', Date.now());
        console.log(`Prewarmed offline billing/options cache for ${cached} job(s)`);
      }
    } finally {
      this._prewarming = false;
    }
  },

  /**
   * Filter cached jobs for the requested view.
   */
  _filterCachedJobs(jobs, view) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    return jobs.filter(job => {
      const start = this._parseOdooDatetime(job.scheduled_date_start);
      if (!start) return false;

      if (view === 'today') {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        return start >= today && start < tomorrow;
      } else {
        // history
        return this._isCompletedJob(job);
      }
    });
  },

  /**
   * Render the job list into a container element.
   */
  renderJobList(container) {
    container.innerHTML = '';

    if (this._currentView === 'history') {
      this._renderHistoryList(container);
      return;
    }

    // Today view — history alert banner. Only work the tech can actually
    // clear: unfinished jobs and missing wrap-ups. Invoicing is the office's.
    if (this._overdueCount > 0 || this._notClosedCount > 0) {
      const parts = [];
      if (this._overdueCount > 0) parts.push(`${this._overdueCount} job${this._overdueCount !== 1 ? 's' : ''} overdue`);
      if (this._notClosedCount > 0) parts.push(`${this._notClosedCount} not closed`);

      const banner = document.createElement('div');
      banner.className = 'history-alert-banner';
      banner.innerHTML = `
        <span class="history-alert-text">&#9888; You have ${parts.join(', ')}. View history to resolve.</span>
        <button class="history-alert-btn">History &rsaquo;</button>
      `;
      banner.querySelector('.history-alert-btn').addEventListener('click', () => {
        App.switchTab('history');
      });
      container.appendChild(banner);
    }

    // Today view — today's jobs + upcoming section
    if (this._jobs.length === 0 && this._upcomingJobs.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div style="font-size: 48px; opacity: 0.3;">📋</div>
          <p>No jobs scheduled</p>
        </div>
      `;
      return;
    }

    for (const job of this._jobs) {
      container.appendChild(this._createJobCard(job));
    }

    if (this._upcomingJobs.length > 0) {
      const firstDate = this._parseOdooDatetime(this._upcomingJobs[0].scheduled_date_start);
      const dateLabel = firstDate
        ? firstDate.toLocaleDateString([], this._tzOptions({ weekday: 'long', month: 'long', day: 'numeric' }))
        : 'Upcoming';

      const divider = document.createElement('div');
      divider.className = 'jobs-section-divider';
      divider.innerHTML = `<span class="jobs-section-label">Upcoming &middot; ${dateLabel}</span>`;
      container.appendChild(divider);

      for (const job of this._upcomingJobs) {
        container.appendChild(this._createJobCard(job));
      }
    }

    // Drive-time info boxes + badge bars (async fill once config loads)
    if (typeof DriveInfo !== 'undefined') {
      DriveInfo.apply(container, this._jobs, this._upcomingJobs).catch(() => {});
    }
  },

  /**
   * Render history list with a section divider between overdue/open and completed jobs.
   */
  _renderHistoryList(container) {
    if (this._jobs.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div style="font-size: 48px; opacity: 0.3;">📋</div>
          <p>No jobs in history</p>
        </div>
      `;
      return;
    }

    let completedDividerAdded = false;

    for (const job of this._jobs) {
      const isCompleted = this._isCompletedJob(job) && !job._isOverdue && job.wrapup_submitted;

      if (isCompleted && !completedDividerAdded) {
        completedDividerAdded = true;
        const divider = document.createElement('div');
        divider.className = 'jobs-section-divider';
        divider.innerHTML = `<span class="jobs-section-label">Completed</span>`;
        container.appendChild(divider);
      }

      container.appendChild(this._createJobCard(job));
    }

    if (this._historyHasMore) {
      const loadMoreDiv = document.createElement('div');
      loadMoreDiv.className = 'load-more-container';
      loadMoreDiv.innerHTML = `
        <button class="load-more-btn" id="loadMoreHistory">
          📥 Load older completed jobs
        </button>
      `;
      container.appendChild(loadMoreDiv);

      document.getElementById('loadMoreHistory').addEventListener('click', async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Loading...';
        try {
          await this.loadMoreHistory();
          this.renderJobList(container);
        } catch (err) {
          App.showToast('Failed to load more jobs', 'error');
          e.target.disabled = false;
          e.target.textContent = '📥 Load older completed jobs';
        }
      });
    }
  },

  // ========== JOB PROFILES ==========

  /**
   * Fetch and attach `_profile` to each job. Silent no-op if the server has
   * no profiles for them — _profileFor then falls back to CONFIG.
   */
  async _attachProfiles(jobs) {
    const list = (jobs || []).filter(j => j && j.id);
    if (!list.length) return;

    // Freshly fetched job objects never carry _profile, and these are about to
    // be written over the IndexedDB cache. If the profile RPC fails (session
    // hiccup, module mid-upgrade) getJobProfiles returns {} — so carry the
    // last known profile across rather than blanking it, which offline would
    // silently re-gate a job whose template hides photos.
    let cachedById = {};
    try {
      const cached = await DB.getJobs();
      for (const c of (cached || [])) {
        if (c && c._profile) cachedById[c.id] = c._profile;
      }
    } catch { /* no cache to carry over */ }

    const profiles = await OdooAPI.getJobProfiles(list.map(j => j.id)) || {};
    for (const job of list) {
      const fresh = profiles[job.id] || profiles[String(job.id)];
      const carried = cachedById[job.id];
      if (fresh) job._profile = fresh;
      else if (carried) job._profile = carried;
    }
  },

  /**
   * The effective job profile, falling back to the behaviour that was
   * hardcoded before fieldservice_job_profile existed. Every caller goes
   * through here so an instance without the module behaves exactly as before.
   */
  _profileFor(job) {
    if (job && job._profile) return job._profile;
    const req = key => {
      const cat = (CONFIG.PHOTO_CATEGORIES || []).find(c => c.key === key);
      return cat ? (cat.required || 0) : 0;
    };
    return {
      photos: {
        mode: 'required',
        equipment: req('equipment'),
        before: req('before'),
        after: req('after'),
      },
      materials: { mode: 'optional' },
      resolution: { mode: 'optional' },
      gate_stages: ['Arrived', 'In Progress'],
      workflow: CONFIG.WORKFLOW,
    };
  },

  /** Case-insensitive loose match used throughout for stage names. */
  _stageMatches(a, b) {
    const x = (a || '').toLowerCase().trim();
    const y = (b || '').toLowerCase().trim();
    if (!x || !y) return false;
    return x.includes(y) || y.includes(x);
  },

  /**
   * Photo categories that BLOCK advancing past a stage. Distinct from
   * _getStagePhotoCategories, which is what the Work tab displays — a stage
   * can offer more categories than it gates on (e.g. In Progress shows
   * problem areas and other, but only After photos hold the job up).
   */
  _gateCategoriesForStage(stageName) {
    const name = (stageName || '').toLowerCase();
    if (name.includes('arrived')) return ['equipment', 'before'];
    if (name.includes('progress')) return ['after'];
    // A stage the app has no category mapping for. It was configured as
    // photo-gated, so gating on nothing would silently ignore the setting —
    // hold it against every category the profile actually requires instead.
    return ['equipment', 'before', 'after'];
  },

  // ========== CALLBACK / TROUBLE TICKET HELPERS ==========

  /**
   * True when this job is a callback — either it resolves a trouble ticket or
   * it carries the callback FSM category (is_callback is computed server-side
   * from both). Falls back to ticket_id alone on instances that predate the
   * fieldservice_helpdesk_link upgrade.
   */
  _isCallbackJob(job) {
    return !!(job.is_callback || job.ticket_id);
  },

  /**
   * Card-sized ticket label, e.g. "#1042 · Lights out on north eave".
   * `ticket_id` arrives as [id, display_name] and helpdesk_mgmt builds that as
   * "<number> - <subject>", so normalise it into the same shape either way and
   * truncate — the ribbon is one line on a phone.
   */
  _ticketRef(job) {
    const cached = this._ticketCache[job.id] || job._ticket;
    let label;
    if (cached && cached.number) {
      label = '#' + cached.number + (cached.name ? ' · ' + cached.name : '');
    } else if (Array.isArray(job.ticket_id)) {
      label = '#' + String(job.ticket_id[1] || '').replace(/^\s*(\S+)\s*-\s*/, '$1 · ');
    } else {
      return '';
    }
    return label.length > 44 ? label.slice(0, 43) + '…' : label;
  },

  /**
   * Estimated time on site as a short string ("1h", "45m", "2h 30m").
   * Prefers scheduled_duration (hours); falls back to the scheduled window.
   */
  _formatDuration(job) {
    let hours = Number(job.scheduled_duration) || 0;
    if (!hours && job.scheduled_date_start && job.scheduled_date_end) {
      const start = new Date(job.scheduled_date_start.replace(' ', 'T') + 'Z');
      const end = new Date(job.scheduled_date_end.replace(' ', 'T') + 'Z');
      const ms = end.getTime() - start.getTime();
      if (ms > 0) hours = ms / 3600000;
    }
    if (!hours || hours <= 0) return '';
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  },

  // Ticket payloads keyed by order id, populated when a job detail is opened.
  _ticketCache: {},

  /**
   * Create a job card DOM element.
   */
  _createJobCard(job) {
    const card = document.createElement('div');
    card.dataset.jobId = job.id;
    const stageName = this.getStageName(job.stage_id);
    const statusClass = this.getStatusClass(stageName);
    const isHistoryComplete = this._currentView === 'history' && this._isCompletedJob(job) && !job._isOverdue && job.wrapup_submitted;

    card.className = `job-card status-${statusClass}${isHistoryComplete ? ' compact' : ''}`;
    card.dataset.jobId = job.id;

    // Location name from location_id [id, name]
    const locationName = Array.isArray(job.location_id)
      ? job.location_id[1]
      : (job.location_id || 'Unknown Location');

    // Build address from direct fields on fsm.order
    const addressParts = [job.street, job.city, job.state_name].filter(Boolean);
    const address = addressParts.join(', ') || locationName;

    // Format time — context-aware per view
    const timeStr = isHistoryComplete
      ? this._formatHistoryDate(job)
      : this._formatCardTime(job.scheduled_date_start);

    // Multi-worker indicator
    const crewCount = job.person_ids ? job.person_ids.length : 1;
    const crewHtml = crewCount > 1
      ? `<span class="crew-badge">👥 ${crewCount}</span>`
      : '';

    // Gate code indicator
    const gateHtml = job.gate_code
      ? '<span class="gate-code-hint" title="Gate code available">🔑</span>'
      : '';

    // Overdue indicator for past uncompleted jobs
    const overdueHtml = job._isOverdue
      ? '<span class="overdue-badge" title="Needs completion">⚠️ OVERDUE</span>'
      : '';

    // Callback / trouble-ticket ribbon. Callbacks are short maintenance visits
    // that read very differently from a full install, so they get their own
    // stripe at the top of the card rather than a footer chip.
    const callbackHtml = this._isCallbackJob(job)
      ? `<div class="callback-ribbon">🎫 CALLBACK${job.ticket_id ? ` · ${this._escapeHtml(this._ticketRef(job))}` : ''}</div>`
      : '';

    // Estimated duration — the whole point of flagging callbacks is that a
    // 1h ticket visit sits next to 4-8h installs on the same list.
    const durationStr = this._formatDuration(job);
    const durationHtml = durationStr
      ? `<span class="job-card-duration" title="Estimated time on site">⏱ ${durationStr}</span>`
      : '';

    // "Open / Not Closed" badge logic:
    //   History tab — any non-closed job
    //   Today tab   — job date is older than today (any stage), OR today + completed stage
    //   Week tab    — never (future-dated jobs)
    let showNotClosed = false;
    if (!job.wrapup_submitted) {
      if (this._currentView === 'history') {
        showNotClosed = true;
      } else if (this._currentView === 'today') {
        const jobStart = job.scheduled_date_start ? new Date(job.scheduled_date_start) : null;
        if (jobStart) {
          const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
          const tomorrowMidnight = new Date(todayMidnight.getTime() + 86400000);
          const isPast = jobStart < todayMidnight;
          const isToday = jobStart >= todayMidnight && jobStart < tomorrowMidnight;
          showNotClosed = isPast || (isToday && statusClass === 'complete');
        }
      }
    }
    const notClosedHtml = showNotClosed ? '<span class="not-closed-badge">Open / Not Closed</span>' : '';

    // Contact info on card (simple text with SMS link for mobile)
    let cardContactHtml = '';
    const cardHasMobile = job.mobile && job.mobile.trim();
    const cardHasPhone = job.phone && job.phone.trim();

    if (cardHasMobile || cardHasPhone) {
      const parts = [];
      if (cardHasMobile) {
        const escapedMobile = this._escapeHtml(job.mobile);
        parts.push(`<span class="card-contact-item">📱 ${escapedMobile}</span>`);
      }
      if (cardHasPhone) {
        const escapedPhone = this._escapeHtml(job.phone);
        parts.push(`<span class="card-contact-item">🏠 ${escapedPhone}</span>`);
      }
      cardContactHtml = `<div class="job-card-contact">${parts.join('<span class="card-contact-sep">|</span>')}</div>`;
    }

    // Instructions (todo) and Notes (description) - shown separately
    const rawTodo = job.todo ? this._stripHtml(job.todo) : '';
    const rawDesc = job.description ? this._stripHtml(job.description) : '';

    let notesHtml = '';
    if (rawTodo) {
      const truncTodo = rawTodo.length > 100 ? rawTodo.slice(0, 100) + '...' : rawTodo;
      notesHtml += `<div class="job-card-field"><span class="job-card-field-label">Instructions:</span> ${this._escapeHtml(truncTodo)}</div>`;
    }
    if (rawDesc) {
      const truncDesc = rawDesc.length > 100 ? rawDesc.slice(0, 100) + '...' : rawDesc;
      notesHtml += `<div class="job-card-field"><span class="job-card-field-label">Notes:</span> ${this._escapeHtml(truncDesc)}</div>`;
    }

    const isHistory = this._currentView === 'history';
    const unpaidTagHtml = isHistory && this._unpaidIds.has(job.id)
      ? '<span class="job-billing-tag unpaid-tag">Unpaid</span>'
      : '';

    if (isHistoryComplete) {
      const completedIcon = '<span class="status-icon complete" title="Completed">✓</span>';
      card.innerHTML = `
        ${callbackHtml}
        ${notClosedHtml}
        <div class="job-card-header compact">
          <span class="job-card-customer">${this._escapeHtml(locationName)}</span>
          <span class="job-card-meta">
            <span class="job-card-time">${timeStr}</span>
            <span class="job-card-id-inline">${this._escapeHtml(job.name || '')}</span>
            ${unpaidTagHtml}
            ${completedIcon}
          </span>
        </div>
        <div class="job-card-address">${gateHtml}${this._escapeHtml(address)}</div>
      `;
    } else {
      card.innerHTML = `
        ${callbackHtml}
        ${overdueHtml}
        ${notClosedHtml}
        <div class="job-card-header">
          <span class="job-card-customer">${this._escapeHtml(locationName)}</span>
          <span class="job-card-time">${timeStr}${durationHtml}</span>
        </div>
        <div class="job-card-address">${gateHtml}${this._escapeHtml(address)}</div>
        ${cardContactHtml}
        ${notesHtml ? `<div class="job-card-divider"></div>${notesHtml}<div class="job-card-divider"></div>` : ''}
        <div class="job-card-footer">
          <span class="job-card-id">${this._escapeHtml(job.name || '')}</span>
          <div style="display:flex; align-items:center; gap:8px;">
            ${crewHtml}
            <span class="status-badge ${statusClass}">${this._escapeHtml(stageName)}</span>
            ${unpaidTagHtml}
          </div>
        </div>
      `;
    }

    if (callbackHtml) card.classList.add('is-callback');

    card.addEventListener('click', () => {
      App.showJobDetail(job.id);
    });

    return card;
  },

  // ========== DETAIL VIEW — Tabbed Layout ==========

  _currentJobId: null,
  _pendingTabSwitch: null,
  _showAllSteps: false,

  /**
   * Render a single job's detail view with swipeable tabs.
   */
  async renderJobDetail(jobId, container) {
    let job = this._jobs.find(j => j.id === jobId)
      || this._upcomingJobs.find(j => j.id === jobId);
    if (!job) {
      job = await DB.getJob(jobId);
    }
    if (!job) {
      container.innerHTML = '<div class="empty-state"><p>Job not found</p></div>';
      return;
    }

    // Reset "show all steps" mode when navigating to a different job
    if (this._currentJobId !== job.id) {
      this._showAllSteps = false;
    }
    this._currentJobId = job.id;
    const stageName = this.getStageName(job.stage_id);
    const statusClass = this.getStatusClass(stageName);

    const isComplete = statusClass === 'complete';
    const wrapupPlacement = (typeof WrapUp !== 'undefined') ? WrapUp.getPlacement() : 'above_tabs';
    const showInlineBanner = isComplete && wrapupPlacement === 'above_tabs';

    container.innerHTML = `
      <div class="detail-header">
        <button class="back-btn" id="backToList">←</button>
        <h2 style="flex:1; font-size:18px;">${this._escapeHtml(job.name || 'Job')}</h2>
        <span class="status-badge ${statusClass}">${this._escapeHtml(stageName)}</span>
      </div>

      ${showInlineBanner ? (job.wrapup_submitted ? `
      <div class="close-job-banner closed" id="closeJobBanner">
        <span class="job-closed-label">✓ Job Closed</span>
        <button class="btn btn-sm job-closed-edit-btn" id="closeJobEditBtn">Edit</button>
        <button class="btn btn-sm job-reopen-btn" id="closeJobReopenBtn">Reopen</button>
      </div>` : `
      <div class="close-job-banner" id="closeJobBanner">
        <button class="btn btn-close-job btn-block btn-xl" id="closeJobBtn">Close Job</button>
      </div>`) : ''}

      ${(isComplete || statusClass === 'cancelled' || job.wrapup_submitted) ? '' : `
      ${job.cancel_requested ? `
      <div class="cancel-request-banner" id="cancelRequestBanner"
           style="margin:8px 12px;padding:10px 12px;border-radius:6px;
                  background:#fff4e5;border:1px solid #e0a800;color:#7a5200;">
        <div style="font-weight:600;margin-bottom:4px;">Cancel request sent</div>
        <div style="font-size:14px;">
          ${this._escapeHtml(this._cancelRequestSummary(job))}
          The office will confirm — keep the job on your list until they do.
        </div>
        <button class="btn btn-sm" id="withdrawCancelBtn"
                style="margin-top:8px;">Withdraw Request</button>
      </div>` : ''}
      <div class="visit-planning-actions" style="display:flex;gap:8px;padding:8px 12px;">
        <button class="btn btn-sm" id="rescheduleVisitBtn" style="flex:1;">Reschedule</button>
        <button class="btn btn-sm" id="continueAnotherDayBtn" style="flex:1;">Continue Another Day</button>
        ${job.cancel_requested ? '' : `
        <button class="btn btn-sm" id="requestCancelBtn" style="flex:1;">Can't Do This Job</button>`}
      </div>`}

      <div class="detail-tabs" id="detailTabs">
        <button class="detail-tab active" data-tab="0">Info</button>
        <button class="detail-tab" data-tab="1">Work</button>
        <button class="detail-tab" data-tab="2">Sales</button>
        <button class="detail-tab" data-tab="3">Options <span class="options-tab-badge" id="optionsTabBadge" style="display:none;"></span></button>
      </div>

      <div class="detail-panels" id="detailPanels">
        <div class="detail-panel" data-panel="0">
          ${this._renderInfoPanel(job, stageName)}
        </div>
        <div class="detail-panel" data-panel="1">
          ${this._renderWorkPanel(job, stageName)}
        </div>
        <div class="detail-panel" data-panel="2">
          ${this._renderSalesPanel(job)}
        </div>
        <div class="detail-panel" data-panel="3">
          <div id="optionsTabContent"></div>
        </div>
      </div>
    `;

    // Bind back button
    document.getElementById('backToList').addEventListener('click', () => {
      App.showJobList();
    });

    // Bind Close Job / Edit Closed Job buttons (visible when job is complete)
    const closeJobBtn = document.getElementById('closeJobBtn');
    if (closeJobBtn && typeof WrapUp !== 'undefined') {
      closeJobBtn.addEventListener('click', () => WrapUp.show(job));
    }
    const closeJobEditBtn = document.getElementById('closeJobEditBtn');
    if (closeJobEditBtn && typeof WrapUp !== 'undefined') {
      closeJobEditBtn.addEventListener('click', () => WrapUp.show(job, true));
    }
    const closeJobReopenBtn = document.getElementById('closeJobReopenBtn');
    if (closeJobReopenBtn) {
      closeJobReopenBtn.addEventListener('click', () => this._reopenJob(job));
    }

    // Bind early wrap-up button (Info tab, in-progress stages)
    const earlyWrapupBtn = document.getElementById('earlyWrapupBtn');
    if (earlyWrapupBtn && typeof WrapUp !== 'undefined') {
      earlyWrapupBtn.addEventListener('click', () => WrapUp.showEarly(job));
    }

    // Bind visit-planning action buttons
    const rescheduleBtn = document.getElementById('rescheduleVisitBtn');
    if (rescheduleBtn) {
      rescheduleBtn.addEventListener('click', () => this._showRescheduleModal(job));
    }
    const continueBtn = document.getElementById('continueAnotherDayBtn');
    if (continueBtn) {
      continueBtn.addEventListener('click', () => this._showContinueAnotherDayModal(job));
    }
    const requestCancelBtn = document.getElementById('requestCancelBtn');
    if (requestCancelBtn) {
      requestCancelBtn.addEventListener('click', () => this._showCantDoJobModal(job));
    }
    const withdrawCancelBtn = document.getElementById('withdrawCancelBtn');
    if (withdrawCancelBtn) {
      withdrawCancelBtn.addEventListener('click', () => this._withdrawCancelRequest(job));
    }

    // Init tab swiping
    this._initDetailTabs();

    // Gate code is now shown/edited as part of the contact details
    const locationId = Array.isArray(job.location_id) ? job.location_id[0] : null;

    // Bind contact info edit
    const contactEditRow = document.getElementById('contactEditRow');
    if (contactEditRow) {
      contactEditRow.addEventListener('click', () => {
        this._showContactModal(job);
      });
    }

    // Lazy-load the customer email for the Info tab (not a field on fsm.order)
    this._loadInfoEmail(job, locationId);

    // Lazy-load the trouble ticket for callback jobs
    if (this._isCallbackJob(job)) this._loadTicketPanel(job);

    // Load additional worker names
    const workerCount = job.worker_count || (job.person_ids ? job.person_ids.length : 1);
    if (workerCount > 1 && job.additional_worker_ids && job.additional_worker_ids.length > 0) {
      this._loadCrewNames(job);
    }

    // Render work tab photos (stage-filtered)
    const workPhotoSection = document.getElementById('workPhotoSection');
    if (workPhotoSection) {
      const cats = this._getStagePhotoCategories(stageName, job);
      if (cats.length > 0) {
        Photos.renderFilteredPhotoSection(job.id, workPhotoSection, cats, () => {
          this._updateStageGate(job, stageName);
        });
      } else {
        workPhotoSection.innerHTML = '';
      }
    }

    // Earlier-steps photos (collapsed) — load on first expand
    const earlierSteps = document.getElementById('earlierStepsSection');
    if (earlierSteps) {
      let earlierLoaded = false;
      earlierSteps.addEventListener('toggle', () => {
        if (!earlierSteps.open || earlierLoaded) return;
        earlierLoaded = true;
        const target = document.getElementById('earlierPhotoSection');
        const earlierCats = (earlierSteps.dataset.cats || '').split(',').filter(Boolean);
        if (target && earlierCats.length) {
          Photos.renderFilteredPhotoSection(job.id, target, earlierCats);
        }
      });
    }

    // Render materials section
    const materialsSection = document.getElementById('materialsSection');
    if (materialsSection && typeof Materials !== 'undefined') {
      Materials.renderSection(job.id, materialsSection);
    }

    // Render billing/sales tab (async)
    if (typeof Billing !== 'undefined') {
      const salesContent = document.getElementById('salesTabContent');
      if (salesContent) {
        Billing.renderSalesTab(job, salesContent);
      }
    }

    // Lazy-load Options tab — only when the panel is first scrolled to
    if (typeof Options !== 'undefined') {
      let optionsLoaded = false;
      const optionsContent = document.getElementById('optionsTabContent');
      if (optionsContent) {
        const panels = document.getElementById('detailPanels');
        const loadOptions = () => {
          if (!optionsLoaded) {
            optionsLoaded = true;
            Options.renderSection(job, optionsContent);
          }
        };

        // Also load badge count eagerly (lightweight — just proposed_count).
        // Online: fetch live; offline: read it from the cached options.
        if (navigator.onLine) {
          OdooAPI.getJobOptions(job.id).then(data => {
            // Cache here too, so just opening a job online (which always fires
            // this) makes its options viewable offline — the tech needn't have
            // scrolled to the Options tab first.
            DB.cacheJobOptions(job.id, data).catch(() => {});
            if (data && data.proposed_count > 0) {
              Options._updateBadge(data.proposed_count);
            }
          }).catch(() => {});
        } else {
          DB.getCachedJobOptions(job.id).then(data => {
            if (data && data.proposed_count > 0) {
              Options._updateBadge(data.proposed_count);
            }
          }).catch(() => {});
        }

        // Load full options when panel 3 becomes visible
        if (panels) {
          const onScroll = () => {
            const panelWidth = panels.offsetWidth;
            if (panelWidth > 0) {
              const idx = Math.round(panels.scrollLeft / panelWidth);
              if (idx === 3) {
                loadOptions();
                panels.removeEventListener('scroll', onScroll);
              }
            }
          };
          panels.addEventListener('scroll', onScroll);
        }
      }
    }

    // Bind stage gate (checks photos, enables/disables next-stage button)
    this._bindStageGate(job, stageName);

    // Bind En Route button on Info tab (pre-work stage only)
    this._bindEnRouteButton(job);

    // Bind Send ETA SMS button on Work tab (En Route stage)
    this._bindEnRouteSmsButton(job);

    // Update footer bar for this job
    this._updateFooter(job);

    // Auto-switch to pending tab (set before re-render)
    if (this._pendingTabSwitch !== null) {
      this._switchToTab(this._pendingTabSwitch);
      this._pendingTabSwitch = null;
    }

    // Bind Sales Order row click → navigate to Sales tab
    const infoSaleRow = document.getElementById('infoSaleRow');
    if (infoSaleRow) {
      infoSaleRow.addEventListener('click', () => {
        this._switchToTab(2);
      });
    }

    // Bind "Show All Steps" toggle
    const viewAllBtn = document.getElementById('viewAllStepsBtn');
    if (viewAllBtn) {
      viewAllBtn.addEventListener('click', () => {
        this._showAllSteps = !this._showAllSteps;
        this._pendingTabSwitch = 1;
        const c = document.getElementById('jobDetail');
        this.renderJobDetail(job.id, c);
      });
    }

    // Lazy-load Info panel extras: SO total + customer GDrive photos folder
    this._loadInfoExtras(job);
  },

  /**
   * Check if job is in a "pre-work" stage where En Route button shows on Info tab.
   */
  _isPreWorkStage(stageName) {
    const name = stageName.toLowerCase();
    return name.includes('new') || name.includes('scheduled') || name.includes('dispatch');
  },

  /**
   * Render the Info panel (tab 1).
   */
  _renderInfoPanel(job, stageName) {
    const locationName = Array.isArray(job.location_id) ? job.location_id[1] : (job.location_id || 'No location');
    const addressParts = [job.street, job.city, job.state_name].filter(Boolean);
    const fullAddress = addressParts.join(', ') || locationName;
    const addressForMap = encodeURIComponent(fullAddress);
    const _isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const mapUrl = _isIOS ? `maps://?q=${addressForMap}` : `geo:0,0?q=${addressForMap}`;

    const scheduledDate = this._formatScheduleDate(job.scheduled_date_start);
    const scheduledTime = this._formatScheduleTimeRange(job.scheduled_date_start, job.scheduled_date_end);

    // Gate code — a contact detail row; edited via the contact modal
    const gateCodeHtml = `<div class="detail-row">
           <span class="label">Gate Code</span>
           <span class="value">${job.gate_code ? this._escapeHtml(job.gate_code) : '<em style="opacity:0.5">None</em>'}</span>
         </div>`;

    // Contact rows shown under the address. Email is always shown (lazy-loaded
    // after render — it isn't a field on fsm.order); phone/mobile only when set.
    const emailContactHtml = `
        <div class="detail-row">
          <span class="label">Email</span>
          <span class="value" id="infoEmailValue"><em style="opacity:0.5">…</em></span>
        </div>`;
    const phoneContactHtml = job.phone ? `
        <div class="detail-row">
          <span class="label">Phone</span>
          <span class="value"><a href="tel:${this._escapeHtml(job.phone)}">${this._escapeHtml(job.phone)}</a></span>
        </div>` : '';
    const mobileContactHtml = job.mobile ? `
        <div class="detail-row">
          <span class="label">Mobile</span>
          <span class="value"><a href="tel:${this._escapeHtml(job.mobile)}">${this._escapeHtml(job.mobile)}</a></span>
        </div>` : '';
    const contactRowsHtml = emailContactHtml + phoneContactHtml + mobileContactHtml;

    // Crew
    const primaryWorker = Array.isArray(job.person_id) ? job.person_id[1] : '';
    const workerCount = job.worker_count || (job.person_ids ? job.person_ids.length : 1);
    let crewHtml = '';
    if (primaryWorker) {
      crewHtml = `
        <div class="detail-row">
          <span class="label">Assigned</span>
          <span class="value">
            <div class="crew-stack" id="crewStack">
              <div>${this._escapeHtml(primaryWorker)}</div>
              ${workerCount > 1 ? '<div class="crew-list-note" id="crewLoading">Loading crew...</div>' : ''}
            </div>
          </span>
        </div>`;
    }

    // Instructions (todo field)
    const todoText = job.todo ? this._stripHtml(job.todo) : '';
    const todoHtml = todoText ? `
        <div class="detail-row">
          <span class="label">Instructions</span>
          <span class="value">${this._escapeHtml(todoText)}</span>
        </div>` : '';

    // Notes (description field)
    const descText = job.description ? this._stripHtml(job.description) : '';
    const descHtml = descText ? `
        <div class="detail-row">
          <span class="label">Notes</span>
          <span class="value">${this._escapeHtml(descText)}</span>
        </div>` : '';

    // Sales order row — tappable, navigates to Sales tab; total loaded lazily
    const saleName = Array.isArray(job.sale_id) ? job.sale_id[1] : '';
    const saleRowHtml = job.sale_id ? `
        <div class="detail-row info-sale-row" id="infoSaleRow">
          <span class="label">Sales Order</span>
          <span class="value">
            ${this._escapeHtml(saleName)}<span class="info-sale-total" id="infoSaleTotal"></span>
          </span>
          <span class="info-row-arrow">›</span>
        </div>` : '';

    // Customer photos from Google Drive — hidden until project folder is loaded lazily
    const gdriveRowHtml = `
        <div class="detail-row" id="infoGdriveRow" style="display:none;">
          <span class="label">Customer Photos</span>
          <span class="value">
            <a href="" id="infoGdriveLink" target="_blank" rel="noopener" class="info-gdrive-link">
              📷 View in Google Drive ›
            </a>
          </span>
        </div>`;

    // Early Wrap-Up button — shown for in-progress stages (not pre-work, not complete/cancelled)
    const sc = this.getStatusClass(stageName);
    const showEarlyWrapup = !this._isPreWorkStage(stageName) && sc !== 'complete' && sc !== 'cancelled';
    const earlyWrapupHtml = showEarlyWrapup ? `
      <div class="detail-section wrapup-early-section">
        <button class="btn btn-outline btn-block" id="earlyWrapupBtn">
          Early Wrap-Up
        </button>
      </div>` : '';

    // Pre-work action (Head to Job / Start Job) — rendered above the customer
    // info card so the primary action is the first thing on the Info tab.
    const preWorkHtml = this._isPreWorkStage(stageName) ? (() => {
      const sn = stageName.toLowerCase();
      const isDispatched = sn.includes('dispatch');
      if (isDispatched) {
        // Whatever this job type does after Dispatched — normally En Route,
        // but a template may skip straight to Arrived. The En Route button
        // opens the ETA/customer-text modal, which only makes sense when the
        // worker is actually setting off; any other next stage gets a plain
        // advance button instead.
        const wf = this._workflowFor(job);
        const idx = wf.findIndex(s => this._stageMatches(stageName, s));
        const nextStage = (idx !== -1 && wf[idx + 1]) ? wf[idx + 1] : 'En Route';
        const isEnRouteNext = this._stageMatches(nextStage, 'En Route');
        return `
      <div class="detail-section">
        <h3>Head to Job</h3>
        <div class="status-actions" id="infoStatusActions">
          <button class="btn btn-warning btn-block btn-lg"
                  id="${isEnRouteNext ? 'enRouteBtn' : 'preWorkAdvanceBtn'}"
                  data-next-stage="${this._escapeHtml(nextStage)}">
            → ${this._escapeHtml(nextStage)}
          </button>
        </div>
      </div>`;
      }
      return `
      <div class="detail-section">
        <h3>Start Job</h3>
        <div class="status-actions" id="infoStatusActions">
          <button class="btn btn-primary btn-block btn-lg" id="startJobBtn">
            Start Job
          </button>
        </div>
      </div>`;
    })() : '';

    // Trouble-ticket card — rendered as a shell and filled by _loadTicketPanel
    // once the ticket is fetched, so the Info tab paints immediately (and still
    // paints offline, where the fetch just leaves the shell hidden).
    const ticketHtml = this._isCallbackJob(job) ? `
      <div class="detail-section ticket-section" id="infoTicketSection">
        <div class="ticket-section-head">
          <h3>🎫 Trouble Ticket</h3>
          <span class="ticket-stage-chip" id="ticketStageChip"></span>
        </div>
        <div id="ticketSectionBody">
          <p class="ticket-loading">Loading ticket…</p>
        </div>
      </div>` : '';

    return `
      ${earlyWrapupHtml}
      ${ticketHtml}
      ${preWorkHtml}
      <div class="detail-section">
        <div class="info-name-row" style="display:flex;align-items:center;justify-content:space-between;gap:var(--spacing-sm);">
          <h3 style="margin:0;">${this._escapeHtml(locationName)}</h3>
          <span class="gate-code-edit" id="contactEditRow" title="Edit contact info" style="cursor:pointer;white-space:nowrap;">✏️ Edit</span>
        </div>
        <a href="${mapUrl}" target="_blank" rel="noopener" class="map-link">
          📍 ${this._escapeHtml(fullAddress)}
        </a>
        ${gateCodeHtml}
        ${contactRowsHtml}
        ${descHtml}
        ${todoHtml}
        <div class="divider"></div>
        <div class="detail-row">
          <span class="label">Scheduled</span>
          <span class="value">
            <div>${scheduledDate}</div>
            <div>${scheduledTime}</div>
          </span>
        </div>
        ${(() => {
          const dur = this._formatDuration(job);
          return dur ? `
        <div class="detail-row">
          <span class="label">Est. Time</span>
          <span class="value">⏱ ${dur}</span>
        </div>` : '';
        })()}
        ${crewHtml}
        <div id="infoExtrasSection"${job.sale_id ? '' : ' style="display:none;"'}>
          <div class="divider"></div>
          ${saleRowHtml}
          ${gdriveRowHtml}
        </div>
      </div>`;
  },

  /**
   * Render the Work panel (tab 2) — status + stage-gated photos + materials.
   * When _showAllSteps is true, all photo categories and materials are visible
   * regardless of the current stage — useful for catch-up entry.
   */
  _renderWorkPanel(job, stageName) {
    const prof = this._profileFor(job);
    const isPreWork = this._isPreWorkStage(stageName);
    const workflowHtml = isPreWork ? '' : this._buildWorkflowButtons(job, stageName);
    const stageCats = this._getStagePhotoCategories(stageName, job);
    // "Show all steps" must still respect a template that hides photos —
    // otherwise the toggle would resurrect a section the profile removed.
    const allCats = prof.photos.mode === 'hidden'
      ? []
      : (CONFIG.PHOTO_CATEGORIES || []).map(c => c.key);
    const cats = this._showAllSteps ? allCats : stageCats;
    const showMaterials = prof.materials.mode !== 'hidden' && (
                          this._showAllSteps ||
                          stageName.toLowerCase().includes('progress') ||
                          stageName.toLowerCase().includes('complete'));

    const toggleHtml = `
      <button class="view-all-toggle${this._showAllSteps ? ' active' : ''}" id="viewAllStepsBtn">
        ${this._showAllSteps ? '&#10003; Showing All Steps' : '&#9711; Show All Steps'}
      </button>`;

    // Pre-work and not showing all: minimal message + toggle. Name the button
    // this job's flow actually shows, which may not be "En Route".
    if (isPreWork && !this._showAllSteps) {
      const wf = this._workflowFor(job);
      const idx = wf.findIndex(s => this._stageMatches(stageName, s));
      const nextLabel = (idx !== -1 && wf[idx + 1])
        ? wf[idx + 1]
        : (this._clockInStageFor(job, false) || 'En Route');
      return `
        <div class="detail-section">
          ${toggleHtml}
          <p style="color:var(--text-secondary); text-align:center; padding:var(--spacing-lg) 0 var(--spacing-sm);">
            Tap "${this._escapeHtml(nextLabel)}" on the Info tab to start this job.
          </p>
        </div>`;
    }

    // Send ETA SMS section (only when En Route)
    const isEnRoute = stageName.toLowerCase().includes('route');
    const enRouteSmsHtml = isEnRoute ? `
      <div class="detail-section" id="enRouteSmsSection">
        <h3>Notify Customer</h3>
        <div style="display:flex;gap:8px;align-items:center;">
          <span>ETA:</span>
          <input type="number" id="enRouteSmsEta" class="form-input" min="5" max="180" step="5" placeholder="min" style="width:70px;">
          <button class="btn btn-secondary" id="enRouteSmsBtn">Send ETA SMS</button>
        </div>
      </div>` : '';

    // Earlier-step photos (equipment/before) stay reachable after moving to
    // In Progress — collapsed by default so the current step stays the focus.
    // Gated on the profile like stageCats/allCats — otherwise a template with
    // photos hidden still gets a collapsible "Earlier Steps" block that both
    // shows and uploads photos, resurrecting the section the profile removed.
    const earlierCats = (prof.photos.mode !== 'hidden'
      && !this._showAllSteps
      && stageName.toLowerCase().includes('progress'))
      ? ['equipment', 'before']
      : [];

    return `
      <div class="detail-section">
        ${toggleHtml}
        ${!isPreWork ? `
        <h3 style="margin-top:var(--spacing-md);">Status</h3>
        <div class="status-actions" id="statusActions">
          ${workflowHtml}
        </div>` : ''}
      </div>
      ${enRouteSmsHtml}
      ${cats.length > 0 ? `
      <div class="detail-section">
        <h3>Photos</h3>
        <div id="workPhotoSection">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>` : ''}
      ${earlierCats.length > 0 ? `
      <details class="detail-section earlier-steps-section" id="earlierStepsSection" data-cats="${earlierCats.join(',')}">
        <summary class="earlier-steps-summary">
          <span class="earlier-steps-title">📷 Earlier Steps — Equipment &amp; Before Photos</span>
          <span class="earlier-steps-chevron">›</span>
        </summary>
        <div id="earlierPhotoSection">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </details>` : ''}
      <div id="stageGateStatus"></div>
      <div class="stage-gate-bypass" id="stageGateBypass" style="display:none;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" id="bypassCheck">
          <span style="font-size:var(--font-size-small);">Bypass photo requirement</span>
        </label>
        <textarea class="form-input" id="bypassReason"
                  placeholder="Explain why photos could not be taken..."
                  rows="2" style="display:none; margin-top:var(--spacing-sm);"></textarea>
      </div>
      <div class="detail-section" id="materialsWrapper" style="${showMaterials ? '' : 'display:none;'}">
        <h3>Materials Used</h3>
        <div id="materialsSection">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>`;
  },

  /**
   * Render the Sales panel (tab 3) — billing, invoicing, payments.
   * If Billing module is loaded, it renders async into a placeholder.
   * Otherwise falls back to a static SO PDF link.
   */
  _renderSalesPanel(job) {
    if (typeof Billing !== 'undefined') {
      return `<div id="salesTabContent">
        <div class="loading"><div class="spinner"></div></div>
      </div>`;
    }
    // Fallback: static SO link
    const saleOrderLink = this._buildSaleOrderLink(job);
    return `
      <div class="detail-section">
        <h3>Sales Order</h3>
        ${saleOrderLink || '<p style="color:var(--text-secondary); font-size:var(--font-size-small);">No sales order linked to this job.</p>'}
      </div>`;
  },

  /**
   * Get photo category keys relevant to the current stage.
   */
  _getStagePhotoCategories(stageName, job) {
    // A template with photos hidden gets no photo sections at all.
    if (job && this._profileFor(job).photos.mode === 'hidden') return [];
    const name = stageName.toLowerCase();
    if (name.includes('arrived')) return ['equipment', 'before'];
    if (name.includes('progress')) return ['after', 'problem_areas', 'other'];
    return [];
  },

  // ========== TAB MANAGEMENT ==========

  /**
   * Initialize tab bar click handlers and scroll-snap sync.
   */
  _initDetailTabs() {
    const tabs = document.getElementById('detailTabs');
    const panels = document.getElementById('detailPanels');
    if (!tabs || !panels) return;

    // Tab click → scroll to panel
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.detail-tab');
      if (!btn) return;
      const idx = parseInt(btn.dataset.tab, 10);
      this._switchToTab(idx);
    });

    // Scroll sync → update active tab
    let ticking = false;
    panels.addEventListener('scroll', () => {
      if (ticking || (typeof App !== 'undefined' && App._suppressScrollSync)) return;
      ticking = true;
      requestAnimationFrame(() => {
        const panelWidth = panels.offsetWidth;
        if (panelWidth > 0 && !(typeof App !== 'undefined' && App._suppressScrollSync)) {
          const idx = Math.round(panels.scrollLeft / panelWidth);
          this._setActiveTab(idx);
        }
        ticking = false;
      });
    });
  },

  /**
   * Programmatically switch to a tab by index.
   */
  _switchToTab(index) {
    const panels = document.getElementById('detailPanels');
    if (!panels) return;
    const panelWidth = panels.offsetWidth;
    panels.scrollTo({ left: index * panelWidth, behavior: 'smooth' });
    this._setActiveTab(index);
  },

  /**
   * Update the active tab indicator.
   */
  _setActiveTab(index) {
    const tabs = document.querySelectorAll('.detail-tab');
    tabs.forEach((t, i) => t.classList.toggle('active', i === index));
  },

  // ========== STAGE-GATED WORKFLOW ==========

  /**
   * Build workflow status buttons for a job.
   */
  _buildWorkflowButtons(job, currentStageName) {
    const workflow = this._workflowFor(job);
    const currentIdx = workflow.findIndex(s =>
      this._stageMatches(currentStageName, s));

    // The job sits on a stage its template's flow doesn't include (someone
    // moved it in Odoo, or the flow changed under it). Fall back to the next
    // stage in the app's built-in order rather than stranding the worker with
    // no button at all.
    if (currentIdx === -1) {
      const base = CONFIG.WORKFLOW;
      const baseIdx = base.findIndex(s => this._stageMatches(currentStageName, s));
      // The stage is in neither the job's flow nor the built-in order — an
      // On Hold / Needs Parts kind of stage. Offering a button here would mean
      // guessing, and slicing from -1 would offer the FIRST stage, rewinding
      // the job. Show nothing and let the office move it.
      if (baseIdx === -1) return '';
      const nextFromBase = base
        .slice(baseIdx + 1)
        .find(s => workflow.some(w => this._stageMatches(w, s)));
      if (!nextFromBase) {
        return '<p style="color:var(--text-secondary); font-size:var(--font-size-small);">Job completed</p>';
      }
      return this._nextStageButtonHtml(nextFromBase);
    }

    const nextIdx = currentIdx + 1;
    if (nextIdx >= workflow.length) {
      return '<p style="color:var(--text-secondary); font-size:var(--font-size-small);">Job completed</p>';
    }

    return this._nextStageButtonHtml(workflow[nextIdx]);
  },

  /**
   * The stage flow for a job: its template's, else the app's built-in order.
   *
   * Returned as-is — the server already sorts by fsm.stage.sequence, which is
   * the only ordering that knows about stages this app has never heard of. An
   * earlier version re-sorted against CONFIG.WORKFLOW and ranked unknown
   * stages last, which pushed any custom intermediate stage past Completed and
   * silently skipped it.
   */
  _workflowFor(job) {
    const configured = this._profileFor(job).workflow;
    return (configured && configured.length) ? configured : CONFIG.WORKFLOW;
  },

  /**
   * The stage at which this job's flow should clock the worker on.
   *
   * Normally the first working stage (En Route in the default flow). When the
   * worker sets off from somewhere other than the shop and the office allows
   * it, the gate moves to Arrived so the drive isn't paid. Derived from the
   * job's own flow rather than the literal name "En Route" — a template that
   * skips it would otherwise never clock anyone in, and the job would be
   * worked with no attendance record and no payroll time.
   */
  _clockInStageFor(job, remoteStart) {
    const working = this._workflowFor(job)
      .filter(s => !this._isPreWorkStage(s) && !this._stageMatches(s, 'Completed'));
    if (!working.length) return null;
    if (remoteStart) {
      return working.find(s => s.toLowerCase().includes('arrived')) || working[0];
    }
    return working[0];
  },

  _nextStageButtonHtml(nextStage) {
    const btnClass = nextStage.toLowerCase().includes('complete') ? 'btn-success' :
                     nextStage.toLowerCase().includes('route') ? 'btn-warning' :
                     'btn-primary';

    return `<button class="btn ${btnClass} btn-block btn-lg" id="nextStageBtn" data-next-stage="${this._escapeHtml(nextStage)}">
      → ${this._escapeHtml(nextStage)}
    </button>`;
  },

  /**
   * Check if photo requirements are met for the gated stage transition.
   * Returns { met: boolean, missing: [{category, label, have, need}] }
   */
  async _checkPhotoGate(job, stageName) {
    const prof = this._profileFor(job);

    // Hidden or optional photos never block, whatever the stage.
    if (prof.photos.mode !== 'required') return { met: true, missing: [] };

    // Only the stages this job type gates on hold anything up.
    const gateStages = prof.gate_stages || [];
    if (!gateStages.some(s => this._stageMatches(stageName, s))) {
      return { met: true, missing: [] };
    }

    const gatedCategories = this._gateCategoriesForStage(stageName);
    if (!gatedCategories.length) return { met: true, missing: [] };

    const counts = await Photos.getPhotoCountsByCategory(job.id);
    const missing = [];

    for (const key of gatedCategories) {
      const need = prof.photos[key] || 0;
      if (need <= 0) continue;
      const have = counts[key] || 0;
      if (have < need) {
        const cat = (CONFIG.PHOTO_CATEGORIES || []).find(c => c.key === key);
        missing.push({
          category: key,
          label: cat ? cat.label : key,
          have,
          need,
        });
      }
    }

    return { met: missing.length === 0, missing };
  },

  /**
   * Update the gate status UI (called after photo capture or on load).
   */
  async _updateStageGate(job, stageName) {
    const nextBtn = document.getElementById('nextStageBtn');
    const bypassSection = document.getElementById('stageGateBypass');
    const bypassCheck = document.getElementById('bypassCheck');
    const gateStatus = document.getElementById('stageGateStatus');
    if (!nextBtn) return;

    const gate = await this._checkPhotoGate(job, stageName);

    if (gate.met) {
      nextBtn.disabled = false;
      if (gateStatus) gateStatus.innerHTML = '';
      if (bypassSection) bypassSection.style.display = 'none';
    } else {
      // Only disable if bypass not active
      if (!bypassCheck || !bypassCheck.checked) {
        nextBtn.disabled = true;
      }
      const missingHtml = gate.missing.map(m =>
        `<div class="gate-missing">${this._escapeHtml(m.label)}: ${m.have}/${m.need}</div>`
      ).join('');
      if (gateStatus) gateStatus.innerHTML = `
        <div class="stage-gate-info">
          <p>Required photos before proceeding:</p>
          ${missingHtml}
        </div>`;
      if (bypassSection) bypassSection.style.display = '';
    }
  },

  /**
   * Bind the stage gate bypass UI and the next-stage button.
   */
  async _bindStageGate(job, stageName) {
    const nextBtn = document.getElementById('nextStageBtn');
    if (!nextBtn) return;

    const bypassCheck = document.getElementById('bypassCheck');
    const bypassReason = document.getElementById('bypassReason');

    // Initial gate check
    await this._updateStageGate(job, stageName);

    // Bypass checkbox logic
    if (bypassCheck) {
      bypassCheck.addEventListener('change', () => {
        if (bypassCheck.checked) {
          bypassReason.style.display = '';
          bypassReason.focus();
        } else {
          bypassReason.style.display = 'none';
          nextBtn.disabled = true;
        }
      });
    }

    if (bypassReason) {
      bypassReason.addEventListener('input', () => {
        if (bypassCheck && bypassCheck.checked) {
          nextBtn.disabled = !bypassReason.value.trim();
        }
      });
    }

    // Next-stage button click
    nextBtn.addEventListener('click', async () => {
      const nextStageName = nextBtn.dataset.nextStage;

      // If completing, show materials popup first
      if (nextStageName.toLowerCase().includes('complete')) {
        this._showMaterialsModal(job, async () => {
          await this._proceedWithStatusChange(job, nextStageName, nextBtn, bypassCheck, bypassReason);
        });
        return;
      }

      await this._proceedWithStatusChange(job, nextStageName, nextBtn, bypassCheck, bypassReason);
    });
  },

  /**
   * Proceed with the status change (extracted for materials modal callback).
   */
  async _proceedWithStatusChange(job, nextStageName, nextBtn, bypassCheck, bypassReason) {
    nextBtn.disabled = true;
    nextBtn.textContent = 'Updating...';

    try {
      // If bypassing, post journal entry first with stage-specific label
      if (bypassCheck && bypassCheck.checked && bypassReason && bypassReason.value.trim()) {
        const reason = bypassReason.value.trim();
        // Determine bypass label based on which stage we're advancing to
        const bypassLabel = nextStageName.toLowerCase().includes('progress')
          ? '[EQUIPMENT/BEFORE PHOTO BYPASS]'
          : '[AFTER PHOTO BYPASS]';
        const entry = `${bypassLabel} ${reason}`;
        if (navigator.onLine) {
          await OdooAPI.postJournalEntry(job.id, entry);
        } else {
          await DB.put('journalQueue', {
            temp_id: 'jq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            job_id: job.id,
            body: entry,
            timestamp: new Date().toISOString(),
            synced: 0,
          });
        }
      }

      const changed = await this.changeJobStatus(job, nextStageName);
      if (!changed) {
        // Worker declined the clock-in prompt — nothing happened
        nextBtn.disabled = false;
        nextBtn.textContent = '→ ' + nextStageName;
        return;
      }
      App.showToast('Status updated', 'success');

      // Determine which tab to switch to after re-render
      const newStageName = this.getStageName(job.stage_id);
      if (newStageName.toLowerCase().includes('complete')) {
        this._pendingTabSwitch = 2; // Sales tab
      } else {
        this._pendingTabSwitch = 1; // Work tab
      }

      // Re-render
      const container = document.getElementById('jobDetail');
      await this.renderJobDetail(job.id, container);
    } catch (err) {
      App.showToast('Failed to update: ' + err.message, 'error');
      nextBtn.disabled = false;
      nextBtn.textContent = '→ ' + nextStageName;
    }
  },

  /**
   * Show materials modal before completing a job.
   */
  async _showMaterialsModal(job, onComplete) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-materials">
        <div class="modal-header">
          <h3>Materials Used</h3>
        </div>
        <div class="modal-body" id="materialsModalBody">
          <div class="loading"><div class="spinner"></div></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="materialsSkipBtn">Skip</button>
          <button class="btn btn-primary" id="materialsDoneBtn">Save & Complete</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const body = document.getElementById('materialsModalBody');
    const skipBtn = document.getElementById('materialsSkipBtn');
    const doneBtn = document.getElementById('materialsDoneBtn');

    // Load materials form into modal
    if (typeof Materials !== 'undefined') {
      await Materials.renderSection(job.id, body);
      // Hide the save button in the form since we have modal buttons
      const formSaveBtn = body.querySelector('.materials-save');
      if (formSaveBtn) formSaveBtn.style.display = 'none';
    } else {
      body.innerHTML = '<p>Materials tracking not available.</p>';
    }

    // Skip button - just complete without saving materials
    skipBtn.addEventListener('click', () => {
      overlay.remove();
      onComplete();
    });

    // Save & Complete button - save materials then complete
    doneBtn.addEventListener('click', async () => {
      doneBtn.disabled = true;
      doneBtn.textContent = 'Saving...';

      try {
        // Trigger materials save
        if (typeof Materials !== 'undefined') {
          const saveBtn = body.querySelector('.materials-save');
          if (saveBtn) {
            // Manually trigger save logic
            await Materials._save(job.id, body);
          }
        }
        overlay.remove();
        onComplete();
      } catch (err) {
        App.showToast('Failed to save materials: ' + err.message, 'error');
        doneBtn.disabled = false;
        doneBtn.textContent = 'Save & Complete';
      }
    });
  },

  /**
   * Bind the Start Job button (New stage) and En Route button (Dispatched stage).
   */
  _bindEnRouteButton(job) {
    // "Start Job" button — shown when job is New
    const startJobBtn = document.getElementById('startJobBtn');
    if (startJobBtn) {
      startJobBtn.addEventListener('click', () => {
        this._showStartJobModal(job);
      });
    }

    // "En Route" button — shown when job is Dispatched
    const enRouteBtn = document.getElementById('enRouteBtn');
    if (enRouteBtn) {
      enRouteBtn.addEventListener('click', () => {
        this._showEnRouteModal(job);
      });
    }

    // Same slot, but for a template whose flow skips En Route — no ETA text,
    // just advance to whatever its next stage is.
    const advanceBtn = document.getElementById('preWorkAdvanceBtn');
    if (advanceBtn) {
      advanceBtn.addEventListener('click', async () => {
        const target = advanceBtn.dataset.nextStage;
        advanceBtn.disabled = true;
        advanceBtn.textContent = 'Updating…';
        try {
          const changed = await this.changeJobStatus(job, target);
          if (changed) {
            const container = document.getElementById('jobDetail');
            if (container) this.renderJobDetail(job.id, container);
            return;
          }
          // false means the worker declined the clock-in prompt — a deliberate
          // cancel, not a failure. Say nothing, same as _proceedWithStatusChange.
        } catch (err) {
          App.showToast('Could not update the job status: ' + err.message, 'error');
        }
        advanceBtn.disabled = false;
        advanceBtn.textContent = '→ ' + target;
      });
    }
  },

  /**
   * Auto-fill an ETA input by getting GPS and calling the backend.
   * Non-blocking — fills the input when ready, doesn't hold up the modal.
   */
  _autoFillEta(jobId, inputId) {
    if (typeof GPS === 'undefined') return;
    GPS.getQuickPosition().then(pos => {
      if (!pos) return;
      const coords = GPS.formatCoords(pos);
      return OdooAPI.getEta(jobId, coords);
    }).then(result => {
      if (!result || !result.eta_minutes) return;
      const input = document.getElementById(inputId);
      if (input) input.value = result.eta_minutes;
    }).catch(err => {
      console.warn('Auto ETA failed:', err);
    });
  },

  /**
   * Show Start Job popup with SMS and "going straight to job?" checkboxes.
   */
  _showStartJobModal(job) {
    const phone = (job.mobile && job.mobile.trim()) || (job.phone && job.phone.trim());
    const hasPhone = !!phone;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:360px;">
        <div class="modal-header">
          <h3>Start Job</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <label style="display:flex;align-items:center;gap:var(--spacing-sm);padding:var(--spacing-sm) 0;cursor:pointer;${hasPhone ? '' : 'opacity:0.4;pointer-events:none;'}">
            <input type="checkbox" id="startJobSms" ${hasPhone ? 'checked' : 'disabled'}>
            <span style="font-size:var(--font-size-small);">Send notification SMS to customer</span>
          </label>
          ${hasPhone ? `
          <div id="startJobEtaRow" style="margin-left:28px;margin-top:-4px;margin-bottom:var(--spacing-sm);">
            <div style="font-size:var(--font-size-xs);color:var(--text-muted);">To: ${this._escapeHtml(phone)}</div>
            <div style="display:flex;align-items:center;gap:var(--spacing-xs);margin-top:var(--spacing-xs);">
              <span style="font-size:var(--font-size-xs);color:var(--text-secondary);">ETA:</span>
              <input type="number" id="startJobEta" class="form-input" value="" min="5" max="180" step="5"
                     style="width:60px;padding:4px 6px;font-size:var(--font-size-xs);text-align:center;" placeholder="—">
              <span style="font-size:var(--font-size-xs);color:var(--text-secondary);">minutes</span>
            </div>
          </div>` : ''}
          <label style="display:flex;align-items:center;gap:var(--spacing-sm);padding:var(--spacing-sm) 0;cursor:pointer;">
            <input type="checkbox" id="startJobDirect" checked>
            <span style="font-size:var(--font-size-small);">Going straight to job?</span>
          </label>
          <label style="display:flex;align-items:center;gap:var(--spacing-sm);padding:var(--spacing-sm) 0;cursor:pointer;">
            <input type="checkbox" id="startJobNav" checked>
            <span style="font-size:var(--font-size-small);">Launch Navigation?</span>
          </label>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="startJobCancel">Cancel</button>
          <button class="btn btn-primary" id="startJobConfirm">Go</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Auto-calculate ETA from GPS
    if (hasPhone) this._autoFillEta(job.id, 'startJobEta');

    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('startJobCancel').addEventListener('click', close);

    // Toggle ETA row visibility when SMS checkbox changes
    const startJobSms = document.getElementById('startJobSms');
    const startJobEtaRow = document.getElementById('startJobEtaRow');
    if (startJobSms && startJobEtaRow) {
      startJobSms.addEventListener('change', () => {
        startJobEtaRow.style.display = startJobSms.checked ? '' : 'none';
      });
    }

    document.getElementById('startJobConfirm').addEventListener('click', async () => {
      const sendSms = document.getElementById('startJobSms').checked;
      const goingDirect = document.getElementById('startJobDirect').checked;
      const etaInput = document.getElementById('startJobEta');
      const etaMinutes = (sendSms && etaInput) ? (parseInt(etaInput.value, 10) || null) : null;
      const confirmBtn = document.getElementById('startJobConfirm');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Updating...';

      try {
        // "Going straight there" means jumping to whatever this job's flow
        // does after Dispatched — usually En Route, but a template may skip
        // it. Hardcoding the name would push the job onto a stage its own
        // flow excludes.
        const wf = this._workflowFor(job);
        const dispatchedIdx = wf.findIndex(s => this._stageMatches(s, 'Dispatched'));
        const afterDispatched = (dispatchedIdx !== -1 && wf[dispatchedIdx + 1])
          ? wf[dispatchedIdx + 1]
          : (this._clockInStageFor(job, false) || 'En Route');
        const targetStage = goingDirect ? afterDispatched : 'Dispatched';
        const changed = await this.changeJobStatus(job, targetStage);
        if (!changed) {
          // Worker declined the clock-in prompt — don't SMS or navigate
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Go';
          return;
        }

        // Send SMS in background (don't block)
        if (sendSms && hasPhone) {
          const techName = Array.isArray(job.person_id) ? job.person_id[1] : '';
          const customerName = Array.isArray(job.location_id) ? job.location_id[1] : '';
          const companyName = Array.isArray(job.company_id) ? job.company_id[1] : '';
          const smsBody = renderSmsTemplate('SMS_TEMPLATE_ENROUTE', {
            customer_name: customerName,
            customer_first_name: customerName.split(' ')[0],
            tech_name: techName,
            tech_first_name: techName.split(' ')[0],
            eta: etaMinutes || '30',
            company_name: companyName,
          });
          OdooAPI.sendEnRouteSms(job.id, phone, etaMinutes, smsBody).then(response => {
            App.showToast('SMS sent to customer', 'success');
            OdooAPI.postJournalEntry(job.id, 'SMS sent to ' + phone + ': ' + smsBody);
            warnIfSmsMirrorFailed(response);
          }).catch(err => {
            console.warn('En route SMS failed:', err);
            App.showToast('SMS failed to send', 'error');
          });
        }

        // Launch navigation if checked
        const launchNav = document.getElementById('startJobNav');
        if (launchNav && launchNav.checked) {
          const addressParts = [job.street, job.city, job.state_name].filter(Boolean);
          const addr = encodeURIComponent(addressParts.join(', '));
          const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
          window.location.href = isIOS ? `maps://?daddr=${addr}&dirflg=d` : `geo:0,0?q=${addr}`;
        }

        App.showToast('Status updated', 'success');
        close();

        if (goingDirect) {
          this._pendingTabSwitch = 1; // Work tab
        }
        // If not going direct (Dispatched), stay on Info tab — no tab switch

        const container = document.getElementById('jobDetail');
        await this.renderJobDetail(job.id, container);
      } catch (err) {
        App.showToast('Failed to update: ' + err.message, 'error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Go';
      }
    });
  },

  /**
   * Show En Route popup (from Dispatched) with SMS checkbox.
   */
  _showEnRouteModal(job) {
    const phone = (job.mobile && job.mobile.trim()) || (job.phone && job.phone.trim());
    const hasPhone = !!phone;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:360px;">
        <div class="modal-header">
          <h3>En Route</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <label style="display:flex;align-items:center;gap:var(--spacing-sm);padding:var(--spacing-sm) 0;cursor:pointer;${hasPhone ? '' : 'opacity:0.4;pointer-events:none;'}">
            <input type="checkbox" id="enRouteSms" ${hasPhone ? 'checked' : 'disabled'}>
            <span style="font-size:var(--font-size-small);">Send notification SMS to customer</span>
          </label>
          ${hasPhone ? `
          <div id="enRouteEtaRow" style="margin-left:28px;">
            <div style="font-size:var(--font-size-xs);color:var(--text-muted);">To: ${this._escapeHtml(phone)}</div>
            <div style="display:flex;align-items:center;gap:var(--spacing-xs);margin-top:var(--spacing-xs);">
              <span style="font-size:var(--font-size-xs);color:var(--text-secondary);">ETA:</span>
              <input type="number" id="enRouteEta" class="form-input" value="" min="5" max="180" step="5"
                     style="width:60px;padding:4px 6px;font-size:var(--font-size-xs);text-align:center;" placeholder="—">
              <span style="font-size:var(--font-size-xs);color:var(--text-secondary);">minutes</span>
            </div>
          </div>` : ''}
          <label style="display:flex;align-items:center;gap:var(--spacing-sm);padding:var(--spacing-sm) 0;cursor:pointer;">
            <input type="checkbox" id="enRouteNav" checked>
            <span style="font-size:var(--font-size-small);">Launch Navigation?</span>
          </label>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="enRouteCancel">Cancel</button>
          <button class="btn btn-warning" id="enRouteConfirm">En Route</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Auto-calculate ETA from GPS
    if (hasPhone) this._autoFillEta(job.id, 'enRouteEta');

    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('enRouteCancel').addEventListener('click', close);

    // Toggle ETA row visibility when SMS checkbox changes
    const enRouteSmsCheck = document.getElementById('enRouteSms');
    const enRouteEtaRow = document.getElementById('enRouteEtaRow');
    if (enRouteSmsCheck && enRouteEtaRow) {
      enRouteSmsCheck.addEventListener('change', () => {
        enRouteEtaRow.style.display = enRouteSmsCheck.checked ? '' : 'none';
      });
    }

    document.getElementById('enRouteConfirm').addEventListener('click', async () => {
      const sendSms = document.getElementById('enRouteSms').checked;
      const etaInput = document.getElementById('enRouteEta');
      const etaMinutes = (sendSms && etaInput) ? (parseInt(etaInput.value, 10) || null) : null;
      const confirmBtn = document.getElementById('enRouteConfirm');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Updating...';

      try {
        const changed = await this.changeJobStatus(job, 'En Route');
        if (!changed) {
          // Worker declined the clock-in prompt — don't SMS or navigate
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'En Route';
          return;
        }

        if (sendSms && hasPhone) {
          const techName = Array.isArray(job.person_id) ? job.person_id[1] : '';
          const customerName = Array.isArray(job.location_id) ? job.location_id[1] : '';
          const companyName = Array.isArray(job.company_id) ? job.company_id[1] : '';
          const smsBody = renderSmsTemplate('SMS_TEMPLATE_ENROUTE', {
            customer_name: customerName,
            customer_first_name: customerName.split(' ')[0],
            tech_name: techName,
            tech_first_name: techName.split(' ')[0],
            eta: etaMinutes || '30',
            company_name: companyName,
          });
          OdooAPI.sendEnRouteSms(job.id, phone, etaMinutes, smsBody).then(response => {
            App.showToast('SMS sent to customer', 'success');
            OdooAPI.postJournalEntry(job.id, 'SMS sent to ' + phone + ': ' + smsBody);
            warnIfSmsMirrorFailed(response);
          }).catch(err => {
            console.warn('En route SMS failed:', err);
            App.showToast('SMS failed to send', 'error');
          });
        }

        // Launch navigation if checked
        const launchNav = document.getElementById('enRouteNav');
        if (launchNav && launchNav.checked) {
          const addressParts = [job.street, job.city, job.state_name].filter(Boolean);
          const addr = encodeURIComponent(addressParts.join(', '));
          const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
          window.location.href = isIOS ? `maps://?daddr=${addr}&dirflg=d` : `geo:0,0?q=${addr}`;
        }

        App.showToast('Status updated', 'success');
        close();

        this._pendingTabSwitch = 1; // Work tab
        const container = document.getElementById('jobDetail');
        await this.renderJobDetail(job.id, container);
      } catch (err) {
        App.showToast('Failed to update: ' + err.message, 'error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'En Route';
      }
    });
  },

  /**
   * Bind the Send ETA SMS button on the Work tab (En Route stage).
   */
  _bindEnRouteSmsButton(job) {
    const btn = document.getElementById('enRouteSmsBtn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      const phone = (job.mobile && job.mobile.trim()) || (job.phone && job.phone.trim());
      if (!phone) {
        App.showToast('No phone number on file', 'error');
        return;
      }

      const etaInput = document.getElementById('enRouteSmsEta');
      const etaMinutes = etaInput ? (parseInt(etaInput.value, 10) || null) : null;

      btn.disabled = true;
      btn.textContent = 'Sending...';

      try {
        const techName = Array.isArray(job.person_id) ? job.person_id[1] : '';
        const customerName = Array.isArray(job.location_id) ? job.location_id[1] : '';
        const companyName = Array.isArray(job.company_id) ? job.company_id[1] : '';
        const smsBody = renderSmsTemplate('SMS_TEMPLATE_ENROUTE', {
          customer_name: customerName,
          customer_first_name: customerName.split(' ')[0],
          tech_name: techName,
          tech_first_name: techName.split(' ')[0],
          eta: etaMinutes || '30',
          company_name: companyName,
        });
        const response = await OdooAPI.sendEnRouteSms(job.id, phone, etaMinutes, smsBody);
        App.showToast('SMS sent to customer', 'success');
        OdooAPI.postJournalEntry(job.id, 'SMS sent to ' + phone + ': ' + smsBody);
        warnIfSmsMirrorFailed(response);
      } catch (err) {
        console.warn('En route SMS failed:', err);
        App.showToast('SMS failed to send', 'error');
      }

      btn.disabled = false;
      btn.textContent = 'Send ETA SMS';
    });
  },

  // ========== FOOTER BAR ==========

  _currentJob: null, // Track current job for footer actions

  /**
   * Update footer bar state for the current job.
   */
  _updateFooter(job) {
    this._currentJob = job;
    const hasPhone = job.phone && job.phone.trim();
    const hasMobile = job.mobile && job.mobile.trim();
    const hasAnyContact = hasPhone || hasMobile;

    const contactBtn = document.getElementById('footerContactBtn');
    if (contactBtn) {
      contactBtn.classList.toggle('disabled', !hasAnyContact);
    }

    // Above-footer wrap-up bar (placement B)
    const aboveFooterBar = document.getElementById('wrapupAboveFooterBar');
    const footerWrapupBtn = document.getElementById('footerWrapupBtn');
    const detailView = document.getElementById('detailView');
    const stageName = this.getStageName(job.stage_id);
    const isComplete = this.getStatusClass(stageName) === 'complete';
    const wrapupPlacement = (typeof WrapUp !== 'undefined') ? WrapUp.getPlacement() : 'above_tabs';
    const showAboveFooter = isComplete && wrapupPlacement === 'above_footer';

    if (aboveFooterBar) {
      aboveFooterBar.style.display = showAboveFooter ? '' : 'none';
      if (showAboveFooter && typeof WrapUp !== 'undefined') {
        if (job.wrapup_submitted) {
          aboveFooterBar.innerHTML = `
            <div class="close-job-banner closed">
              <span class="job-closed-label">✓ Job Closed</span>
              <button class="btn btn-sm job-closed-edit-btn" id="footerEditClosedBtn">Edit</button>
              <button class="btn btn-sm job-reopen-btn" id="footerReopenBtn">Reopen</button>
            </div>`;
          document.getElementById('footerEditClosedBtn')?.addEventListener('click', () => WrapUp.show(job, true));
          document.getElementById('footerReopenBtn')?.addEventListener('click', () => this._reopenJob(job));
        } else {
          aboveFooterBar.innerHTML = `
            <button class="btn btn-close-job btn-block btn-xl" id="footerCloseJobBtn">Close Job</button>`;
          document.getElementById('footerCloseJobBtn')?.addEventListener('click', () => WrapUp.show(job));
        }
      }
    }
    if (detailView) {
      detailView.classList.toggle('wrapup-above-footer', showAboveFooter);
    }
  },

  /**
   * Reopen a previously closed job (clears wrapup_submitted on the server).
   */
  async _reopenJob(job) {
    if (!confirm('Remove the Closed status from this job?')) return;
    try {
      await OdooAPI.reopenJob(job.id);
      this._historyFetchCache = null;
      // Update local state so the banner re-renders without a full sync
      job.wrapup_submitted = false;
      const idx = this._jobs.findIndex(j => j.id === job.id);
      if (idx >= 0) this._jobs[idx].wrapup_submitted = false;
      // Re-render job detail
      const container = document.getElementById('jobDetail');
      if (container) this.renderJobDetail(job.id, container);
      App.showToast('Job reopened.', 'info');
    } catch (err) {
      App.showToast('Reopen failed: ' + err.message, 'error');
    }
  },

  /**
   * Reset footer bar to default (no job selected).
   */
  _resetFooter() {
    this._currentJob = null;
    const contactBtn = document.getElementById('footerContactBtn');
    if (contactBtn) contactBtn.classList.add('disabled');
    this._hideContactPicker();
    this._hideSmsPicker();
    this._hideCategoryPicker();

    // Hide above-footer wrap-up bar when leaving job detail
    const aboveFooterBar = document.getElementById('wrapupAboveFooterBar');
    if (aboveFooterBar) aboveFooterBar.style.display = 'none';
    document.getElementById('detailView')?.classList.remove('wrapup-above-footer');
  },

  /**
   * Show contact picker popup above contact button.
   * Options: Call Mobile, Call Phone, Send SMS.
   */
  _showContactPicker() {
    if (!this._currentJob) return;

    const job = this._currentJob;
    const hasPhone = job.phone && job.phone.trim();
    const hasMobile = job.mobile && job.mobile.trim();

    if (!hasPhone && !hasMobile) return;

    const picker = document.getElementById('contactPicker');
    if (!picker) return;

    let html = '';

    if (hasMobile) {
      html += `
        <a href="tel:${this._escapeHtml(job.mobile)}" class="contact-picker-item">
          <span class="contact-picker-icon mobile">📱</span>
          <span class="contact-picker-label">Call Mobile</span>
          <span class="contact-picker-number">${this._escapeHtml(job.mobile)}</span>
        </a>`;
    }

    if (hasPhone) {
      html += `
        <a href="tel:${this._escapeHtml(job.phone)}" class="contact-picker-item">
          <span class="contact-picker-icon home">🏠</span>
          <span class="contact-picker-label">Call Phone</span>
          <span class="contact-picker-number">${this._escapeHtml(job.phone)}</span>
        </a>`;
    }

    if (hasMobile) {
      html += `
        <button class="contact-picker-item" id="contactPickerSmsBtn">
          <span class="contact-picker-icon sms">💬</span>
          <span class="contact-picker-label">Send SMS</span>
          <span class="contact-picker-number">${this._escapeHtml(job.mobile)}</span>
        </button>`;
    }

    picker.innerHTML = html;
    picker.style.display = 'flex';

    // SMS button → show SMS template picker
    const smsBtn = picker.querySelector('#contactPickerSmsBtn');
    if (smsBtn) {
      smsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._hideContactPicker();
        this._showSmsPicker(job.mobile.trim());
      });
    }

    // Close when clicking outside
    const closeHandler = (e) => {
      if (!picker.contains(e.target) && e.target.id !== 'footerContactBtn') {
        this._hideContactPicker();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 10);
  },

  /**
   * Hide contact picker popup.
   */
  _hideContactPicker() {
    const picker = document.getElementById('contactPicker');
    if (picker) picker.style.display = 'none';
  },

  /**
   * Show SMS template picker — second popup after tapping Send SMS.
   * Options: ETA notification, Payment link, Custom (device SMS app).
   */
  _showSmsPicker(phone) {
    const picker = document.getElementById('smsPicker');
    if (!picker || !this._currentJob) return;

    const job = this._currentJob;
    const firstName = (() => {
      const loc = Array.isArray(job.location_id) ? job.location_id[1] : '';
      return (loc || 'Customer').split(' ')[0];
    })();

    picker.innerHTML = `
      <div class="sms-picker-header">
        <button class="sms-picker-back" id="smsPickerBack">&#8592;</button>
        <span class="sms-picker-title">SMS to ${this._escapeHtml(firstName)}</span>
      </div>
      <button class="sms-picker-option" id="smsOptEta">
        <span class="sms-picker-option-icon">📍</span>
        <span>ETA Notification</span>
      </button>
      <div class="sms-eta-form" id="smsEtaForm" style="display:none;">
        <label for="smsEtaMinutes">ETA:</label>
        <input type="number" id="smsEtaMinutes" min="5" max="180" step="5" placeholder="30">
        <span style="font-size:var(--font-size-xs);color:var(--text-secondary);">min</span>
        <button class="sms-eta-send" id="smsEtaSend">Send</button>
      </div>
      <button class="sms-picker-option" id="smsOptPayment">
        <span class="sms-picker-option-icon">💳</span>
        <span>Payment Link</span>
      </button>
      <button class="sms-picker-option muted" id="smsOptOther">
        <span class="sms-picker-option-icon">💬</span>
        <span>Custom (open SMS app)</span>
      </button>
    `;

    picker.style.display = 'flex';

    // Back → re-open contact picker
    picker.querySelector('#smsPickerBack').addEventListener('click', (e) => {
      e.stopPropagation();
      this._hideSmsPicker();
      this._showContactPicker();
    });

    // ETA: toggle inline form
    picker.querySelector('#smsOptEta').addEventListener('click', () => {
      const form = picker.querySelector('#smsEtaForm');
      if (form) form.style.display = form.style.display === 'none' ? 'flex' : 'none';
    });

    // ETA: send
    picker.querySelector('#smsEtaSend').addEventListener('click', async () => {
      const etaInput = picker.querySelector('#smsEtaMinutes');
      const eta = parseInt(etaInput && etaInput.value, 10) || 30;
      const sendBtn = picker.querySelector('#smsEtaSend');
      sendBtn.disabled = true;
      sendBtn.textContent = '…';

      const techName = Array.isArray(job.person_id) ? job.person_id[1] : '';
      const customerName = Array.isArray(job.location_id) ? job.location_id[1] : '';
      const companyName = Array.isArray(job.company_id) ? job.company_id[1] : '';
      const smsBody = renderSmsTemplate('SMS_TEMPLATE_ENROUTE', {
        customer_name: customerName,
        customer_first_name: customerName.split(' ')[0],
        tech_name: techName,
        tech_first_name: techName.split(' ')[0],
        eta: eta,
        company_name: companyName,
      });

      try {
        const response = await OdooAPI.sendEnRouteSms(job.id, phone, eta, smsBody);
        OdooAPI.postJournalEntry(job.id, 'SMS sent to ' + phone + ': ' + smsBody);
        App.showToast('ETA SMS sent', 'success');
        warnIfSmsMirrorFailed(response);
        this._hideSmsPicker();
      } catch (err) {
        App.showToast('SMS failed to send', 'error');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
      }
    });

    // Payment Link
    picker.querySelector('#smsOptPayment').addEventListener('click', async () => {
      const btn = picker.querySelector('#smsOptPayment');
      btn.disabled = true;
      btn.querySelector('span:last-child').textContent = 'Loading…';

      try {
        const data = await OdooAPI.getSaleOrder(job.id);
        const invoices = (data && data.invoices) || [];
        const invoice = invoices.find(i =>
          i.state === 'posted' && i.payment_state !== 'paid' && i.payment_state !== 'in_payment'
        );
        if (!invoice) {
          App.showToast('No unpaid invoice found', 'error');
          btn.disabled = false;
          btn.querySelector('span:last-child').textContent = 'Payment Link';
          return;
        }

        // {payment_link} is substituted server-side with the invoice's
        // portal link (view + pay online)
        const customerName = Array.isArray(job.location_id) ? job.location_id[1] : '';
        const smsBody = renderSmsTemplate('SMS_TEMPLATE_PAYMENT', {
          customer_name: customerName,
          customer_first_name: customerName.split(' ')[0],
          amount: (invoice.amount_residual || 0).toFixed(2),
          payment_link: '{payment_link}',
        });

        const response = await OdooAPI.sendPaymentSms(invoice.id, phone, smsBody);
        OdooAPI.postJournalEntry(job.id, 'Payment SMS sent to ' + phone);
        App.showToast('Payment link sent', 'success');
        warnIfSmsMirrorFailed(response);
        this._hideSmsPicker();
      } catch (err) {
        App.showToast('Failed to send payment link', 'error');
        btn.disabled = false;
        btn.querySelector('span:last-child').textContent = 'Payment Link';
      }
    });

    // Other — open device SMS app
    picker.querySelector('#smsOptOther').addEventListener('click', () => {
      this._hideSmsPicker();
      window.location.href = 'sms:' + encodeURIComponent(phone);
    });

    // Close when clicking outside
    const closeHandler = (e) => {
      if (!picker.contains(e.target) && e.target.id !== 'footerContactBtn') {
        this._hideSmsPicker();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 10);
  },

  /**
   * Hide SMS template picker popup.
   */
  _hideSmsPicker() {
    const picker = document.getElementById('smsPicker');
    if (picker) picker.style.display = 'none';
  },

  /**
   * Show category picker popup above camera button.
   * Lets the tech capture a photo in any category at any time.
   */
  _showCategoryPicker() {
    if (!this._currentJob) return;

    const picker = document.getElementById('categoryPicker');
    if (!picker) return;

    const categories = CONFIG.PHOTO_CATEGORIES || [];
    const jobId = this._currentJob.id;

    const html = categories.map(cat => `
      <button class="contact-picker-item" data-category="${cat.key}">
        <span class="contact-picker-icon">📷</span>
        <span class="contact-picker-label">${this._escapeHtml(cat.label)}</span>
      </button>
    `).join('');

    picker.innerHTML = html;
    picker.style.display = 'flex';

    // Bind category buttons
    picker.querySelectorAll('[data-category]').forEach(btn => {
      btn.addEventListener('click', async () => {
        this._hideCategoryPicker();
        const category = btn.dataset.category;
        try {
          const photo = await Photos.capturePhoto(jobId, category);
          if (photo) {
            App.showToast('Photo saved', 'success');
            // Refresh work photo section if visible
            const workSection = document.getElementById('workPhotoSection');
            if (workSection) {
              const stageName = this.getStageName(this._currentJob.stage_id);
              const cats = this._getStagePhotoCategories(stageName, this._currentJob);
              if (cats.length > 0) {
                Photos.renderFilteredPhotoSection(jobId, workSection, cats, () => {
                  this._updateStageGate(this._currentJob, stageName);
                });
              }
            }
          }
        } catch (err) {
          App.showToast('Failed to capture photo', 'error');
        }
      });
    });

    // Close when clicking outside
    const closeHandler = (e) => {
      if (!picker.contains(e.target) && e.target.id !== 'footerCameraBtn') {
        this._hideCategoryPicker();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 10);
  },

  /**
   * Hide category picker popup.
   */
  _hideCategoryPicker() {
    const picker = document.getElementById('categoryPicker');
    if (picker) picker.style.display = 'none';
  },

  /**
   * Open journal as a modal overlay.
   */
  _showJournalModal(jobId) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-journal">
        <div class="modal-header">
          <h3>Journal & Photos</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-tabs">
          <button class="modal-tab active" data-modal-tab="journal">Journal</button>
          <button class="modal-tab" data-modal-tab="photos">Photos</button>
          <button class="modal-tab" data-modal-tab="system">System</button>
        </div>
        <div class="modal-body">
          <div class="modal-tab-content active" data-modal-content="journal" id="journalModalBody">
            <div class="loading"><div class="spinner"></div></div>
          </div>
          <div class="modal-tab-content" data-modal-content="photos" id="photosModalBody">
            <div class="loading"><div class="spinner"></div></div>
          </div>
          <div class="modal-tab-content" data-modal-content="system" id="systemModalBody">
            <div class="loading"><div class="spinner"></div></div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    // Tab switching — load content lazily on first activation
    const tabs = overlay.querySelectorAll('.modal-tab');
    const contents = overlay.querySelectorAll('.modal-tab-content');
    const loaded = { journal: false, photos: false, system: false };

    const loadTab = (target) => {
      if (target === 'journal' && !loaded.journal) {
        loaded.journal = true;
        const body = document.getElementById('journalModalBody');
        if (body && typeof Journal !== 'undefined') Journal.renderSection(jobId, body);
      } else if (target === 'photos' && !loaded.photos) {
        loaded.photos = true;
        const body = document.getElementById('photosModalBody');
        if (body && typeof Photos !== 'undefined') Photos.renderAllPhotosGallery(jobId, body);
      } else if (target === 'system' && !loaded.system) {
        loaded.system = true;
        const body = document.getElementById('systemModalBody');
        if (body && typeof Journal !== 'undefined') Journal.renderSystemTab(jobId, body);
      }
    };

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.modalTab;
        tabs.forEach(t => t.classList.toggle('active', t.dataset.modalTab === target));
        contents.forEach(c => c.classList.toggle('active', c.dataset.modalContent === target));
        loadTab(target);
      });
    });

    // Load journal content immediately (default tab)
    loadTab('journal');
  },

  // ── Visit Planning modals ─────────────────────────────────────────────────

  _formatDateTimeLocal(odooDateStr) {
    if (!odooDateStr) return '';
    // Odoo gives 'YYYY-MM-DD HH:MM:SS' UTC. Convert to local datetime-local input.
    const utcStr = odooDateStr.replace(' ', 'T') + 'Z';
    const d = new Date(utcStr);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` +
           `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  _localToOdooDateTime(localStr) {
    if (!localStr) return '';
    // 'YYYY-MM-DDTHH:MM' (local) → 'YYYY-MM-DD HH:MM:SS' (UTC for Odoo).
    const d = new Date(localStr);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
           `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
  },

  _showRescheduleModal(job) {
    const currentStart = this._formatDateTimeLocal(job.scheduled_date_start);
    const duration = job.scheduled_duration || 0;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:480px;">
        <div class="modal-header">
          <h3>Reschedule Visit</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <label style="display:block;margin-bottom:8px;">
            <span style="font-weight:600;">New Start</span>
            <input type="datetime-local" id="rescheduleStart" value="${currentStart}"
                   style="width:100%;padding:8px;font-size:16px;" />
          </label>
          <label style="display:block;margin-bottom:8px;">
            <span style="font-weight:600;">Duration (hours)</span>
            <input type="number" step="0.25" min="0" id="rescheduleDuration"
                   value="${duration}"
                   style="width:100%;padding:8px;font-size:16px;" />
          </label>
          <label style="display:block;margin-bottom:8px;">
            <input type="checkbox" id="rescheduleResetStage" checked />
            Reset stage to Scheduled (uncheck if work has already started)
          </label>
          <label style="display:block;margin-bottom:8px;">
            <input type="checkbox" id="rescheduleNotifyCustomer" />
            Text the customer the new date
          </label>
          <label style="display:block;margin-bottom:12px;">
            <span style="font-weight:600;">Reason</span>
            <textarea id="rescheduleReason" rows="3"
                      style="width:100%;padding:8px;font-size:16px;"
                      placeholder="Why are we rescheduling?"></textarea>
          </label>
          <div id="rescheduleConflicts" style="display:none;color:#a00;
               background:#fee;padding:8px;border-radius:4px;margin-bottom:8px;
               white-space:pre-wrap;font-size:14px;"></div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-block" id="rescheduleCancelBtn"
                    style="flex:1;">Cancel</button>
            <button class="btn btn-block btn-primary" id="rescheduleApplyBtn"
                    style="flex:1;">Apply</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.querySelector('#rescheduleCancelBtn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#rescheduleApplyBtn').addEventListener('click', async () => {
      const startLocal = overlay.querySelector('#rescheduleStart').value;
      const durHrs = parseFloat(overlay.querySelector('#rescheduleDuration').value) || 0;
      const reason = overlay.querySelector('#rescheduleReason').value || '';
      const resetStage = overlay.querySelector('#rescheduleResetStage').checked;
      const notifyCustomer = overlay.querySelector('#rescheduleNotifyCustomer').checked;
      if (!startLocal || durHrs <= 0) {
        App.showToast('Pick a start time and a duration greater than zero.', 'error');
        return;
      }
      const newStartOdoo = this._localToOdooDateTime(startLocal);
      const startD = new Date(startLocal);
      const endD = new Date(startD.getTime() + durHrs * 3600 * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      const newEndOdoo = `${endD.getUTCFullYear()}-${pad(endD.getUTCMonth()+1)}` +
        `-${pad(endD.getUTCDate())} ${pad(endD.getUTCHours())}:` +
        `${pad(endD.getUTCMinutes())}:00`;
      try {
        const res = await OdooAPI.workerRescheduleOrder(
          job.id, newStartOdoo, newEndOdoo, reason, resetStage, notifyCustomer,
        );
        if (!res || !res.ok) {
          if (res && res.error === 'conflict') {
            const lines = (res.conflicts || []).map(c =>
              `• ${c.name} — ${c.scheduled_date_start} → ${c.scheduled_date_end}` +
              ` (${c.person_name || 'unassigned'})`
            ).join('\n');
            const cd = overlay.querySelector('#rescheduleConflicts');
            cd.textContent = `Schedule conflict — the assigned crew has overlapping job(s):\n\n${lines}\n\nPick a different time, or contact the office.`;
            cd.style.display = 'block';
            return;
          }
          App.showToast('Reschedule failed: ' + (res && res.error || 'unknown error'), 'error');
          return;
        }
        close();
        if (res.notify_error) {
          App.showToast('Rescheduled, but the customer text failed: ' +
            res.notify_error, 'error');
        } else {
          App.showToast(res.customer_notified
            ? 'Visit rescheduled — customer texted'
            : 'Visit rescheduled', 'success');
        }
        await Jobs.loadJobs(Jobs._currentView || 'today');
      } catch (err) {
        App.showToast('Reschedule failed: ' + (err.message || err), 'error');
      }
    });
  },

  _cancelRequestSummary(job) {
    const reason = Array.isArray(job.cancel_request_reason_id)
      ? job.cancel_request_reason_id[1] : '';
    const note = job.cancel_request_note || '';
    return [reason, note].filter(Boolean).join(' — ') + (reason || note ? '.' : '');
  },

  /**
   * "Can't Do This Job" — the field worker's escape hatch. Offers the two
   * legitimate outcomes side by side: move it (reschedule, applies straight
   * away) or kill it (cancel *request*, which the office must approve). A
   * worker can never close a job outright from here.
   */
  _showCantDoJobModal(job) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:480px;">
        <div class="modal-header">
          <h3>Can't Do This Job</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <p style="margin:0 0 12px 0;color:#555;">
            Moving it to another day is usually the fastest fix. Ask the office
            to cancel only if the work isn't happening at all.
          </p>
          <button class="btn btn-block" id="cantDoRescheduleBtn"
                  style="margin-bottom:8px;">Move to Another Day</button>
          <button class="btn btn-block" id="cantDoCancelBtn">Ask Office to Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#cantDoRescheduleBtn').addEventListener('click', () => {
      close();
      this._showRescheduleModal(job);
    });
    overlay.querySelector('#cantDoCancelBtn').addEventListener('click', () => {
      close();
      this._showCancelRequestModal(job);
    });
  },

  async _showCancelRequestModal(job) {
    let reasons = [];
    try {
      reasons = await OdooAPI.getCancelReasons();
    } catch (err) {
      App.showToast('Could not load cancellation reasons: ' +
        (err.message || err), 'error');
      return;
    }
    if (!reasons.length) {
      App.showToast('No cancellation reasons are set up — call the office.', 'error');
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:480px;">
        <div class="modal-header">
          <h3>Ask Office to Cancel</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <p style="margin:0 0 12px 0;color:#555;">
            This sends a request to the office. The job stays on your list
            until they confirm.
          </p>
          <label style="display:block;margin-bottom:8px;">
            <span style="font-weight:600;">Reason</span>
            <select id="cancelReasonSelect"
                    style="width:100%;padding:8px;font-size:16px;">
              <option value="">— Pick a reason —</option>
              ${reasons.map(r => `<option value="${r.id}"
                data-requires-note="${r.requires_note ? '1' : '0'}">
                ${this._escapeHtml(r.name)}</option>`).join('')}
            </select>
          </label>
          <label style="display:block;margin-bottom:12px;">
            <span style="font-weight:600;">What happened?
              <span id="cancelNoteRequired" style="color:#a00;display:none;">*</span>
            </span>
            <textarea id="cancelRequestNote" rows="3"
                      style="width:100%;padding:8px;font-size:16px;"
                      placeholder="Anything the office needs to know"></textarea>
          </label>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-block" id="cancelRequestBackBtn"
                    style="flex:1;">Back</button>
            <button class="btn btn-block btn-primary" id="cancelRequestSendBtn"
                    style="flex:1;">Send Request</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.querySelector('#cancelRequestBackBtn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const select = overlay.querySelector('#cancelReasonSelect');
    const noteStar = overlay.querySelector('#cancelNoteRequired');
    const noteRequired = () => {
      const opt = select.selectedOptions[0];
      return !!(opt && opt.dataset.requiresNote === '1');
    };
    select.addEventListener('change', () => {
      noteStar.style.display = noteRequired() ? '' : 'none';
    });

    overlay.querySelector('#cancelRequestSendBtn').addEventListener('click', async () => {
      const reasonId = parseInt(select.value, 10);
      const note = overlay.querySelector('#cancelRequestNote').value.trim();
      if (!reasonId) {
        App.showToast('Pick a reason first.', 'error');
        return;
      }
      if (noteRequired() && !note) {
        App.showToast('That reason needs a short explanation.', 'error');
        return;
      }
      try {
        const res = await OdooAPI.workerRequestCancel(job.id, reasonId, note);
        if (!res || !res.ok) {
          const msg = {
            already_cancelled: 'This job is already cancelled.',
            already_requested: 'A cancel request is already pending.',
            note_required: 'That reason needs a short explanation.',
          }[res && res.error] || (res && res.error) || 'unknown error';
          App.showToast('Request failed: ' + msg, 'error');
          return;
        }
        close();
        App.showToast('Cancel request sent to the office', 'success');
        await Jobs.loadJobs(Jobs._currentView || 'today');
      } catch (err) {
        App.showToast('Request failed: ' + (err.message || err), 'error');
      }
    });
  },

  async _withdrawCancelRequest(job) {
    if (!confirm('Withdraw your cancel request and keep this job?')) return;
    try {
      const res = await OdooAPI.workerWithdrawCancelRequest(job.id);
      if (!res || !res.ok) {
        App.showToast('Could not withdraw the request.', 'error');
        return;
      }
      App.showToast('Cancel request withdrawn', 'success');
      await Jobs.loadJobs(Jobs._currentView || 'today');
    } catch (err) {
      App.showToast('Could not withdraw: ' + (err.message || err), 'error');
    }
  },

  _showContinueAnotherDayModal(job) {
    // Default to tomorrow at the same start time.
    const baseStart = job.scheduled_date_start
      ? new Date(job.scheduled_date_start.replace(' ', 'T') + 'Z')
      : new Date();
    const tomorrow = new Date(baseStart.getTime() + 24 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const defaultLocal = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth()+1)}-` +
      `${pad(tomorrow.getDate())}T${pad(tomorrow.getHours())}:${pad(tomorrow.getMinutes())}`;
    const duration = job.scheduled_duration || 4;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:480px;">
        <div class="modal-header">
          <h3>Continue on Another Day</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <p style="margin:0 0 12px 0;color:#666;">
            Creates a new visit for the next day. This visit stays as-is —
            you can still close it out for today's work.
          </p>
          <label style="display:block;margin-bottom:8px;">
            <span style="font-weight:600;">Next Visit Start</span>
            <input type="datetime-local" id="continueStart" value="${defaultLocal}"
                   style="width:100%;padding:8px;font-size:16px;" />
          </label>
          <label style="display:block;margin-bottom:8px;">
            <span style="font-weight:600;">Duration (hours)</span>
            <input type="number" step="0.25" min="0" id="continueDuration"
                   value="${duration}"
                   style="width:100%;padding:8px;font-size:16px;" />
          </label>
          <label style="display:block;margin-bottom:12px;">
            <span style="font-weight:600;">Reason / Note</span>
            <textarea id="continueReason" rows="3"
                      style="width:100%;padding:8px;font-size:16px;"
                      placeholder="What's left to finish?"></textarea>
          </label>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-block" id="continueCancelBtn"
                    style="flex:1;">Cancel</button>
            <button class="btn btn-block btn-primary" id="continueApplyBtn"
                    style="flex:1;">Create Next Visit</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.querySelector('#continueCancelBtn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#continueApplyBtn').addEventListener('click', async () => {
      const startLocal = overlay.querySelector('#continueStart').value;
      const durHrs = parseFloat(overlay.querySelector('#continueDuration').value) || 0;
      const reason = overlay.querySelector('#continueReason').value || '';
      if (!startLocal || durHrs <= 0) {
        App.showToast('Pick a start time and a duration greater than zero.', 'error');
        return;
      }
      const startOdoo = this._localToOdooDateTime(startLocal);
      try {
        const res = await OdooAPI.workerCreateNextVisit(
          job.id, startOdoo, durHrs, reason,
        );
        if (!res || !res.ok) {
          App.showToast('Failed to create next visit: ' + (res && res.error || 'unknown'), 'error');
          return;
        }
        close();
        App.showToast(`Next visit created: ${res.new_order_name}`, 'success');
        await Jobs.loadJobs(Jobs._currentView || 'today');
      } catch (err) {
        App.showToast('Failed: ' + (err.message || err), 'error');
      }
    });
  },

  /**
   * Change a job's status to the named stage.
   * Stage changes are pushed to Odoo immediately (triggers backend automations).
   * GPS is captured for En Route/Arrived and sent as a follow-up if needed.
   * @returns {boolean} false if the worker declined the clock-in prompt
   *                    (no change was made), true otherwise.
   */
  async changeJobStatus(job, stageName) {
    const name = stageName.toLowerCase();

    // Clock-on gate. Normally at En Route; when the worker leaves from a
    // custom origin (not the shop) and the office setting allows it, the
    // gate moves to Arrived instead.
    if (typeof DriveInfo !== 'undefined') {
      try { await DriveInfo.ensureReady(); } catch (e) { /* default gating */ }
    }
    const remoteStart = typeof DriveInfo !== 'undefined' && DriveInfo.isRemoteStart();
    const clockInStage = this._clockInStageFor(job, remoteStart);
    if (clockInStage && this._stageMatches(stageName, clockInStage)
        && typeof TimeTracking !== 'undefined') {
      const ok = await TimeTracking.ensureClockedIn(); // no-op if already on
      if (!ok) return false; // user declined
    }

    // Find the stage ID for this name, preferring the job's company
    const jobCompanyId = Array.isArray(job.company_id) ? job.company_id[0] : job.company_id;
    const nameMatch = s =>
      s.name.toLowerCase() === stageName.toLowerCase() ||
      s.name.toLowerCase().includes(stageName.toLowerCase()) ||
      stageName.toLowerCase().includes(s.name.toLowerCase());
    const companyMatch = s =>
      !s.company_id || s.company_id === false ||
      (Array.isArray(s.company_id) ? s.company_id[0] : s.company_id) === jobCompanyId;

    // Prefer stage matching both name and company; fall back to name-only
    const stage = this._stages.find(s => nameMatch(s) && companyMatch(s))
      || this._stages.find(s => nameMatch(s));

    if (!stage) {
      throw new Error('Stage not found: ' + stageName);
    }

    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const extraValues = {};

    // If completing, stamp completion time for history filtering
    if (name.includes('complete')) {
      extraValues.date_end = timestamp;
    }

    // Determine if we need GPS for this stage
    const needsGps = name.includes('route') || name.includes('arrived');

    // Try to get a quick GPS fix (non-blocking, 3s timeout)
    let gpsCoords = null;
    if (needsGps && typeof GPS !== 'undefined') {
      const pos = await GPS.getQuickPosition();
      if (pos) {
        gpsCoords = GPS.formatCoords(pos);
        if (name.includes('route')) {
          extraValues.gps_enroute = gpsCoords;
          extraValues.gps_enroute_timestamp = timestamp;
        }
      }
    }

    // Stage changes affect overdue/not-closed lists
    this._historyFetchCache = null;

    if (navigator.onLine) {
      // Push stage change immediately — backend automations depend on this
      await OdooAPI.updateOrderStage(job.id, stage.id, extraValues);

      // Log stage change to System tab (fire-and-forget)
      const workerName = (typeof Auth !== 'undefined' && Auth.getUser()) ? Auth.getUser().name : '';
      const stageNote = workerName
        ? `Stage changed to "${stage.name}" by ${workerName}`
        : `Stage changed to "${stage.name}"`;
      OdooAPI.postSystemNote(job.id, stageNote).catch(() => {});

      // If we didn't get GPS yet but need it, capture in background and follow up
      if (needsGps && !gpsCoords && typeof GPS !== 'undefined') {
        GPS.getCurrentPosition().then(pos => {
          if (pos) {
            const coords = GPS.formatCoords(pos);
            const gpsValues = { gps_enroute: coords, gps_enroute_timestamp: timestamp };
            OdooAPI.write('fsm.order', [job.id], gpsValues).catch(err => {
              console.warn('GPS follow-up write failed:', err);
            });
          }
        });
      }

      // Update local cache
      job.stage_id = [stage.id, stage.name];
      await DB.put('jobs', job);
    } else {
      // Queue for sync — include GPS if we got it
      await DB.queueStatusChange(job.id, stage.id, timestamp, gpsCoords, extraValues);
      // Update local cache optimistically
      job.stage_id = [stage.id, stage.name];
      await DB.put('jobs', job);
    }

    // Note: the clock-off prompt happens at Close Job (WrapUp._showClockOffPrompt),
    // not here — completing the stage is when invoicing starts, too early to ask.

    return true;
  },

  /**
   * Lazy-load extras for the Info panel: SO total and customer GDrive photos folder.
   * Fire-and-forget — updates DOM elements when data arrives.
   */
  _loadInfoExtras(job) {
    // Load SO total and update the info row
    if (job.sale_id && navigator.onLine) {
      OdooAPI.getSaleOrder(job.id).then(data => {
        const totalEl = document.getElementById('infoSaleTotal');
        if (totalEl && data && data.has_sale_order) {
          const amt = parseFloat(data.sale_order.amount_total) || 0;
          const formatted = amt.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          totalEl.textContent = ' — $' + formatted;
        }
      }).catch(() => {});
    }

    // Load Google Drive folder link for this order
    if (navigator.onLine) {
      OdooAPI.getOrderFolderIds(job.id).then(folders => {
        if (!folders || !folders.effectiveFolderId) return;
        const folderId = folders.effectiveFolderId;
        const row = document.getElementById('infoGdriveRow');
        const link = document.getElementById('infoGdriveLink');
        const section = document.getElementById('infoExtrasSection');
        if (row) row.style.display = '';
        if (link) link.href = 'https://drive.google.com/drive/folders/' + folderId;
        if (section) section.style.display = '';
      }).catch(() => {});
    }
  },

  /**
   * Load and display additional worker names in the crew list.
   */
  async _loadCrewNames(job) {
    const crewStack = document.getElementById('crewStack');
    const crewLoading = document.getElementById('crewLoading');
    if (!crewStack) return;

    const ids = job.additional_worker_ids;

    // Try cached names first (stored on the job object after first successful fetch)
    if (job._cachedCrewNames && job._cachedCrewNames.length > 0) {
      if (crewLoading) crewLoading.remove();
      for (const name of job._cachedCrewNames) {
        const div = document.createElement('div');
        div.textContent = name;
        crewStack.appendChild(div);
      }
      return;
    }

    if (!navigator.onLine) {
      if (crewLoading) crewLoading.textContent = `+${ids.length} more`;
      return;
    }

    try {
      const persons = await OdooAPI.readPersonNames(ids);
      if (crewLoading) crewLoading.remove();
      // Cache names on the job object so subsequent renders don't re-fetch
      job._cachedCrewNames = persons.map(p => p.name);
      for (const p of persons) {
        const div = document.createElement('div');
        div.textContent = p.name;
        crewStack.appendChild(div);
      }
    } catch (err) {
      console.warn('Failed to load crew names:', err);
      if (crewLoading) crewLoading.textContent = `+${ids.length} more`;
    }
  },

  /**
   * Fill the Info tab's Email row. Email isn't a field on fsm.order, so it's
   * read from the location on demand (and cached on the job for re-renders).
   */
  async _loadInfoEmail(job, locationId) {
    const el = document.getElementById('infoEmailValue');
    if (!el) return;
    const none = '<em style="opacity:0.5">None</em>';

    let email = job.email;
    if (email === undefined) {
      if (!locationId || !navigator.onLine) { el.innerHTML = none; return; }
      try {
        const rows = await OdooAPI.read('fsm.location', [locationId], ['email']);
        email = (rows && rows[0] && rows[0].email) || '';
        job.email = email;
      } catch {
        el.innerHTML = none;
        return;
      }
    }

    el.innerHTML = email
      ? `<a href="mailto:${this._escapeHtml(email)}">${this._escapeHtml(email)}</a>`
      : none;
  },

  // ========== TROUBLE TICKET PANEL (Info tab) ==========

  /**
   * Fetch and render the trouble ticket for a callback job. Cached per order
   * so the panel survives a re-render (and stays readable offline once seen).
   */
  async _loadTicketPanel(job) {
    const section = document.getElementById('infoTicketSection');
    if (!section) return;

    let ticket = this._ticketCache[job.id];
    if (!ticket && navigator.onLine) {
      try {
        ticket = await OdooAPI.getJobTicket(job.id);
        if (ticket && ticket.id) {
          this._ticketCache[job.id] = ticket;
          // Persist alongside the job so the panel works offline next time.
          job._ticket = ticket;
          DB.put('jobs', job).catch(() => {});
        }
      } catch {
        ticket = null;
      }
    }
    if (!ticket) ticket = job._ticket;

    if (!ticket || !ticket.id) {
      // A callback by category with no ticket attached — drop the shell rather
      // than leave a permanent "Loading…" on the tab.
      section.remove();
      return;
    }
    this._ticketCache[job.id] = ticket;
    this._renderTicketBody(job, ticket);
  },

  _renderTicketBody(job, ticket) {
    const body = document.getElementById('ticketSectionBody');
    const chip = document.getElementById('ticketStageChip');
    if (!body) return;

    if (chip) {
      chip.textContent = ticket.stage_name || '';
      chip.className = 'ticket-stage-chip' + (ticket.closed ? ' closed' : '');
    }

    const ref = ticket.number ? `#${this._escapeHtml(ticket.number)}` : '';
    const prio = ticket.priority === '3' ? '🔴 Urgent'
      : ticket.priority === '2' ? '🟠 High'
      : ticket.priority === '1' ? '🔵 Low' : '';

    const metaBits = [
      ticket.team_name && this._escapeHtml(ticket.team_name),
      ticket.category_name && this._escapeHtml(ticket.category_name),
      prio,
    ].filter(Boolean).join(' · ');

    const tagsHtml = (ticket.tags || []).length
      ? `<div class="ticket-tags">${ticket.tags.map(t => `<span class="ticket-tag">${this._escapeHtml(t)}</span>`).join('')}</div>`
      : '';

    const descHtml = ticket.description
      ? `<div class="ticket-desc">${this._escapeHtml(ticket.description)}</div>`
      : '';

    const resolutionHtml = ticket.resolution
      ? `<div class="ticket-resolution"><span class="ticket-resolution-label">Resolution</span>${this._escapeHtml(ticket.resolution)}</div>`
      : '';

    // Other jobs hanging off the same ticket — the office may have split a
    // callback across two visits, and the ticket can't close until all are done.
    const others = (ticket.orders || []).filter(o => !o.is_current);
    const siblingsHtml = others.length
      ? `<div class="ticket-siblings">
           <span class="ticket-siblings-label">Also on this ticket</span>
           ${others.map(o => `<div class="ticket-sibling${o.is_closed ? ' done' : ''}">${o.is_closed ? '✓' : '○'} ${this._escapeHtml(o.name)} — ${this._escapeHtml(o.stage)}</div>`).join('')}
         </div>`
      : '';

    let actionHtml = '';
    if (ticket.closed) {
      actionHtml = `<div class="ticket-closed-note">✓ Ticket closed (${this._escapeHtml(ticket.stage_name)})</div>`;
    } else if (!ticket.can_close) {
      actionHtml = `<div class="ticket-blocked-note">Ticket can't be closed until the other jobs on it are finished.</div>
        <button class="btn btn-outline btn-sm btn-block" id="ticketNoteBtn">Add Ticket Note</button>`;
    } else {
      actionHtml = `<button class="btn btn-outline btn-block" id="ticketResolveBtn">Resolve Ticket</button>`;
    }

    body.innerHTML = `
      <div class="ticket-title">${ref ? `<span class="ticket-ref">${ref}</span>` : ''}${this._escapeHtml(ticket.name)}</div>
      ${metaBits ? `<div class="ticket-meta">${metaBits}</div>` : ''}
      ${tagsHtml}
      ${descHtml}
      ${resolutionHtml}
      ${siblingsHtml}
      <div class="ticket-actions">${actionHtml}</div>
    `;

    const resolveBtn = document.getElementById('ticketResolveBtn');
    if (resolveBtn) {
      resolveBtn.addEventListener('click', () => this._showResolveTicketModal(job, ticket));
    }
    const noteBtn = document.getElementById('ticketNoteBtn');
    if (noteBtn) {
      noteBtn.addEventListener('click', () => this._showResolveTicketModal(job, ticket, true));
    }
  },

  /**
   * Resolve-ticket modal. `noteOnly` drops the stage picker for the case where
   * the ticket still has other open jobs — the worker can record what they did
   * without being told "you can't close this".
   */
  _showResolveTicketModal(job, ticket, noteOnly = false) {
    if (!navigator.onLine) {
      App.showToast('Resolving a ticket needs a connection', 'error');
      return;
    }

    const stages = ticket.close_stages || [];
    const defaultStage = ticket.default_close_stage_id || (stages[0] && stages[0].id);
    const stageOptions = stages.map(s =>
      `<option value="${s.id}"${s.id === defaultStage ? ' selected' : ''}>${this._escapeHtml(s.name)}</option>`
    ).join('');

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>${noteOnly ? 'Add Ticket Note' : 'Resolve Ticket'}</h3>
          <button class="modal-close" id="resolveTicketClose">&times;</button>
        </div>
        <div class="modal-body">
          <div class="ticket-modal-subject">
            ${ticket.number ? `<span class="ticket-ref">#${this._escapeHtml(ticket.number)}</span>` : ''}
            ${this._escapeHtml(ticket.name)}
          </div>
          <div class="form-group">
            <label class="form-label">What fixed it?</label>
            <textarea class="form-input" id="resolveTicketText" rows="4"
              placeholder="Describe the repair so the office can answer the customer…">${this._escapeHtml(ticket.resolution || job.resolution || '')}</textarea>
          </div>
          ${noteOnly || !stages.length ? '' : `
          <div class="form-group">
            <label class="form-label">Close ticket as</label>
            <select class="form-input" id="resolveTicketStage">${stageOptions}</select>
          </div>`}
          ${noteOnly ? '<p class="ticket-blocked-note">Other jobs on this ticket are still open, so it stays open for now.</p>' : ''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary btn-block" id="resolveTicketSubmit">
            ${noteOnly ? 'Save Note' : 'Resolve Ticket'}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#resolveTicketClose').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#resolveTicketSubmit').addEventListener('click', async () => {
      const btn = overlay.querySelector('#resolveTicketSubmit');
      const text = overlay.querySelector('#resolveTicketText').value.trim();
      const stageSel = overlay.querySelector('#resolveTicketStage');
      const stageId = (!noteOnly && stageSel) ? parseInt(stageSel.value, 10) : false;

      if (!text) {
        App.showToast('Add a short note about what was done', 'error');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const res = await OdooAPI.resolveJobTicket(job.id, text, stageId);
        if (!res || !res.ok) {
          App.showToast((res && res.error) || 'Could not update the ticket', 'error');
          btn.disabled = false;
          btn.textContent = noteOnly ? 'Save Note' : 'Resolve Ticket';
          return;
        }
        close();
        App.showToast(res.closed ? 'Ticket resolved' : 'Ticket note saved', 'success');
        // Re-fetch so the panel reflects the new stage/resolution.
        delete this._ticketCache[job.id];
        delete job._ticket;
        this._loadTicketPanel(job);
      } catch (err) {
        App.showToast('Could not update the ticket: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = noteOnly ? 'Save Note' : 'Resolve Ticket';
      }
    });
  },

  /**
   * Show modal to edit customer contact info (address, phone, mobile, email).
   * Loads current values from the server, then writes changes back via a
   * method that diffs and logs an audit note to the order journal and the
   * customer record. Requires a connection (the audit log is server-side).
   */
  async _showContactModal(job) {
    if (!navigator.onLine) {
      App.showToast('Contact edits need a connection', 'error');
      return;
    }

    let data;
    try {
      data = await OdooAPI.getContact(job.id);
    } catch (err) {
      App.showToast('Could not load contact: ' + err.message, 'error');
      return;
    }

    const stateOptions = ['<option value="">— State —</option>']
      .concat((data.states || []).map(s =>
        `<option value="${s.id}"${s.id === data.state_id ? ' selected' : ''}>${this._escapeHtml(s.name)}</option>`
      )).join('');

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Edit Contact Info</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Gate Code</label>
            <input type="text" class="form-input" id="cGateCode" value="${this._escapeHtml(data.gate_code || '')}">
          </div>
          <div class="form-group">
            <label>Email</label>
            <input type="email" class="form-input" id="cEmail" value="${this._escapeHtml(data.email)}">
          </div>
          <div class="form-group">
            <label>Mobile</label>
            <input type="tel" class="form-input" id="cMobile" value="${this._escapeHtml(data.mobile)}">
          </div>
          <div class="form-group">
            <label>Phone</label>
            <input type="tel" class="form-input" id="cPhone" value="${this._escapeHtml(data.phone)}">
          </div>
          <div class="form-group">
            <label>Street</label>
            <input type="text" class="form-input" id="cStreet" value="${this._escapeHtml(data.street)}">
          </div>
          <div class="form-group">
            <label>Street 2</label>
            <input type="text" class="form-input" id="cStreet2" value="${this._escapeHtml(data.street2)}">
          </div>
          <div class="form-group">
            <label>City</label>
            <input type="text" class="form-input" id="cCity" value="${this._escapeHtml(data.city)}">
          </div>
          <div class="form-group">
            <label>State</label>
            <select class="form-input" id="cState">${stateOptions}</select>
          </div>
          <div class="form-group">
            <label>ZIP</label>
            <input type="text" class="form-input" id="cZip" inputmode="numeric" value="${this._escapeHtml(data.zip)}">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="contactCancel">Cancel</button>
          <button class="btn btn-primary" id="contactSave">Save</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('contactCancel').addEventListener('click', close);

    document.getElementById('contactSave').addEventListener('click', async () => {
      const stateVal = document.getElementById('cState').value;
      const changes = {
        street: document.getElementById('cStreet').value.trim(),
        street2: document.getElementById('cStreet2').value.trim(),
        city: document.getElementById('cCity').value.trim(),
        state_id: stateVal ? parseInt(stateVal, 10) : false,
        zip: document.getElementById('cZip').value.trim(),
        phone: document.getElementById('cPhone').value.trim(),
        mobile: document.getElementById('cMobile').value.trim(),
        email: document.getElementById('cEmail').value.trim(),
        gate_code: document.getElementById('cGateCode').value.trim(),
      };

      const saveBtn = document.getElementById('contactSave');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      try {
        const res = await OdooAPI.updateContact(job.id, changes);
        if (res && res.changed === false) {
          close();
          App.showToast('No changes to save', 'info');
          return;
        }

        // Update local cache with the authoritative new values
        const c = (res && res.contact) || {};
        job.street = c.street || '';
        job.street2 = c.street2 || '';
        job.city = c.city || '';
        job.state_name = c.state_name || '';
        job.phone = c.phone || '';
        job.mobile = c.mobile || '';
        job.email = c.email || '';
        job.gate_code = c.gate_code || '';
        try { await DB.put('jobs', job); } catch { /* cache best-effort */ }

        close();
        App.showToast('Contact info updated', 'success');

        const container = document.getElementById('jobDetail');
        if (container) await this.renderJobDetail(job.id, container);
      } catch (err) {
        App.showToast('Failed to save: ' + (err.message || 'error'), 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });
  },

  /**
   * Build a link to the Sales Order PDF if the job has a linked sale order.
   */
  _buildSaleOrderLink(job) {
    if (!job.sale_id) return '';
    const saleId = Array.isArray(job.sale_id) ? job.sale_id[0] : job.sale_id;
    const saleName = Array.isArray(job.sale_id) ? job.sale_id[1] : 'Sales Order';
    if (!saleId) return '';
    const url = CONFIG.ODOO_URL + '/report/pdf/sale.report_saleorder/' + saleId;
    return `<a href="${url}" target="_blank" rel="noopener" class="btn btn-outline btn-block">📄 ${this._escapeHtml(saleName)}</a>`;
  },

  // ========== HELPERS ==========

  /**
   * Parse an Odoo datetime string as UTC.
   * Odoo returns "2026-01-31 08:00:00" which is UTC but has no indicator.
   * We normalize it to ISO 8601 so the browser interprets it correctly.
   */
  _parseOdooDatetime(dateStr) {
    if (!dateStr) return null;
    // "2026-01-31 08:00:00" → "2026-01-31T08:00:00Z"
    const iso = dateStr.replace(' ', 'T') + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z');
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  },

  /**
   * Get timezone options for Intl formatting.
   * Uses the Odoo user's timezone so times match what Odoo displays.
   */
  _tzOptions(extra) {
    const tz = (typeof Auth !== 'undefined' && Auth.getTimezone) ? Auth.getTimezone() : null;
    const opts = Object.assign({}, extra || {});
    if (tz) opts.timeZone = tz;
    return opts;
  },

  _formatScheduledTime(dateStr) {
    const d = this._parseOdooDatetime(dateStr);
    if (!d) return '';
    return d.toLocaleTimeString([], this._tzOptions({ hour: 'numeric', minute: '2-digit' }));
  },

  /**
   * Format time for job cards — context-aware per current view.
   * Today: "8:00 AM"
   * Week: "Mon · 8:00 AM"
   * History: "Jan 28"
   */
  _formatCardTime(dateStr) {
    const d = this._parseOdooDatetime(dateStr);
    if (!d) return '';
    const time = d.toLocaleTimeString([], this._tzOptions({ hour: 'numeric', minute: '2-digit' }));
    if (this._currentView === 'history') {
      return d.toLocaleDateString([], this._tzOptions({ month: 'short', day: 'numeric' }));
    }
    // For non-today dates (e.g. upcoming jobs shown on the today panel), include the weekday
    const now = new Date();
    const isToday = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    if (!isToday) {
      const day = d.toLocaleDateString([], this._tzOptions({ weekday: 'short' }));
      return `${day} · ${time}`;
    }
    return time;
  },

  _formatHistoryDate(job) {
    // Use scheduled date (when the job was booked), not wrap-up/close date
    const raw = job.scheduled_date_start || job.date_end;
    const d = this._parseOdooDatetime(raw);
    if (!d) return '';
    const now = new Date();
    const opts = d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
    return d.toLocaleDateString([], this._tzOptions(opts));
  },

  _isCompletedJob(job) {
    // Primary: stage map (if loaded)
    const stage = this.getStage(job.stage_id);
    if (stage && stage.is_closed === true) return true;
    // Fallback: stage name from record payload
    const nameFromJob = job.stage_name || (Array.isArray(job.stage_id) ? job.stage_id[1] : '');
    if (nameFromJob) {
      return this.getStatusClass(nameFromJob) === 'complete';
    }
    // Last fallback: job has a completion timestamp
    if (job.date_end) return true;
    const stageName = this.getStageName(job.stage_id);
    return this.getStatusClass(stageName) === 'complete';
  },

  _formatDateTime(dateStr) {
    const d = this._parseOdooDatetime(dateStr);
    if (!d) return '';
    return d.toLocaleDateString([], this._tzOptions({ month: 'short', day: 'numeric' })) +
      ' ' + d.toLocaleTimeString([], this._tzOptions({ hour: 'numeric', minute: '2-digit' }));
  },

  /**
   * Format the date part of a schedule: "Monday, February 2"
   */
  _formatScheduleDate(startStr) {
    const start = this._parseOdooDatetime(startStr);
    if (!start) return '';
    return start.toLocaleDateString([], this._tzOptions({
      weekday: 'long', month: 'long', day: 'numeric'
    }));
  },

  /**
   * Format the time range of a schedule: "8:00 AM - 12:00 PM"
   */
  _formatScheduleTimeRange(startStr, endStr) {
    const start = this._parseOdooDatetime(startStr);
    if (!start) return '';
    const startTime = start.toLocaleTimeString([], this._tzOptions({
      hour: 'numeric', minute: '2-digit'
    }));
    const end = this._parseOdooDatetime(endStr);
    if (!end) return startTime;
    const endTime = end.toLocaleTimeString([], this._tzOptions({
      hour: 'numeric', minute: '2-digit'
    }));
    return `${startTime} - ${endTime}`;
  },

  _stripHtml(html) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.textContent || div.innerText || '').trim();
  },

  _escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  },
};
