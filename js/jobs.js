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
    if (cached && cached.length > 0) {
      this._stages = cached;
    }

    // Fetch fresh if online
    if (navigator.onLine) {
      try {
        const stages = await OdooAPI.getStages();
        this._stages = stages;
        await DB.saveStages(stages);
      } catch (err) {
        console.warn('Failed to fetch stages:', err);
      }
    }

    // Build lookup map
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

  _historyCompletedOffset: 0, // Pagination offset for "load more" in history
  _historyHasMore: false, // Whether there are more completed jobs to load

  /**
   * Fetch jobs from Odoo for the given date range.
   */
  async fetchJobs(view) {
    const personId = Auth.getPersonId();
    if (!personId) throw new Error('Not logged in');

    const now = new Date();
    let dateFrom, dateTo;

    if (view === 'today') {
      dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      dateTo = new Date(dateFrom);
      dateTo.setDate(dateTo.getDate() + 1);
    } else if (view === 'week') {
      dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      dateTo = new Date(dateFrom);
      dateTo.setDate(dateTo.getDate() + 7);
    } else {
      // history — handled separately
      return this._fetchHistoryJobs(personId);
    }

    const fromStr = dateFrom.toISOString().replace('T', ' ').slice(0, 19);
    const toStr = dateTo.toISOString().replace('T', ' ').slice(0, 19);

    return OdooAPI.getMyOrders(personId, fromStr, toStr);
  },

  /**
   * Fetch history jobs: overdue (uncompleted past) + completed (last 30 days).
   */
  async _fetchHistoryJobs(personId) {
    const now = new Date();
    const todayStr = now.toISOString().replace('T', ' ').slice(0, 19);

    // 30 days ago for completed jobs
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().replace('T', ' ').slice(0, 19);

    // Reset pagination
    this._historyCompletedOffset = 0;

    // Fetch both in parallel
    const [overdueJobs, completedJobs] = await Promise.all([
      OdooAPI.getOverdueOrders(personId, todayStr),
      OdooAPI.getCompletedOrders(personId, thirtyDaysAgoStr, 0),
    ]);

    // Mark overdue jobs
    overdueJobs.forEach(job => { job._isOverdue = true; });

    // Check if there might be more completed jobs
    this._historyHasMore = completedJobs.length >= CONFIG.JOBS_PER_PAGE;

    // Combine: overdue first, then completed
    return [...overdueJobs, ...completedJobs];
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
   * Load jobs — from Odoo if online, from cache if offline.
   */
  async loadJobs(view) {
    this._currentView = view || 'today';
    let jobs;

    if (navigator.onLine) {
      try {
        jobs = await this.fetchJobs(this._currentView);
        await DB.saveJobs(jobs);
        await DB.setState('lastSync', Date.now());
      } catch (err) {
        console.warn('Failed to fetch from Odoo, using cache:', err);
        jobs = await DB.getJobs();
      }
    } else {
      jobs = await DB.getJobs();
    }

    // Filter cached jobs based on current view
    if (!navigator.onLine && jobs) {
      jobs = this._filterCachedJobs(jobs, this._currentView);
    }

    this._jobs = jobs || [];
    return this._jobs;
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
      } else if (view === 'week') {
        const weekEnd = new Date(today);
        weekEnd.setDate(weekEnd.getDate() + 7);
        return start >= today && start < weekEnd;
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

    if (this._jobs.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div style="font-size: 48px; opacity: 0.3;">📋</div>
          <p>No jobs ${this._currentView === 'history' ? 'in history' : 'scheduled'}</p>
        </div>
      `;
      return;
    }

    for (const job of this._jobs) {
      const card = this._createJobCard(job);
      container.appendChild(card);
    }

    // Add "Load more" link for history view
    if (this._currentView === 'history' && this._historyHasMore) {
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

  /**
   * Create a job card DOM element.
   */
  _createJobCard(job) {
    const card = document.createElement('div');
    const stageName = this.getStageName(job.stage_id);
    const statusClass = this.getStatusClass(stageName);
    const isHistoryComplete = this._currentView === 'history' && this._isCompletedJob(job) && !job._isOverdue;

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

    if (isHistoryComplete) {
      const completedIcon = '<span class="status-icon complete" title="Completed">✓</span>';
      card.innerHTML = `
        <div class="job-card-header compact">
          <span class="job-card-customer">${this._escapeHtml(locationName)}</span>
          <span class="job-card-meta">
            <span class="job-card-time">${timeStr}</span>
            <span class="job-card-id-inline">${this._escapeHtml(job.name || '')}</span>
            ${completedIcon}
          </span>
        </div>
        <div class="job-card-address">${gateHtml}${this._escapeHtml(address)}</div>
      `;
    } else {
      card.innerHTML = `
        ${overdueHtml}
        <div class="job-card-header">
          <span class="job-card-customer">${this._escapeHtml(locationName)}</span>
          <span class="job-card-time">${timeStr}</span>
        </div>
        <div class="job-card-address">${gateHtml}${this._escapeHtml(address)}</div>
        ${cardContactHtml}
        ${notesHtml ? `<div class="job-card-divider"></div>${notesHtml}<div class="job-card-divider"></div>` : ''}
        <div class="job-card-footer">
          <span class="job-card-id">${this._escapeHtml(job.name || '')}</span>
          <div style="display:flex; align-items:center; gap:8px;">
            ${crewHtml}
            <span class="status-badge ${statusClass}">${this._escapeHtml(stageName)}</span>
          </div>
        </div>
      `;
    }

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
    let job = this._jobs.find(j => j.id === jobId);
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

    container.innerHTML = `
      <div class="detail-header">
        <button class="back-btn" id="backToList">←</button>
        <h2 style="flex:1; font-size:18px;">${this._escapeHtml(job.name || 'Job')}</h2>
        <span class="status-badge ${statusClass}">${this._escapeHtml(stageName)}</span>
      </div>

      <div class="detail-tabs" id="detailTabs">
        <button class="detail-tab active" data-tab="0">Info</button>
        <button class="detail-tab" data-tab="1">Work</button>
        <button class="detail-tab" data-tab="2">Sales</button>
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
      </div>
    `;

    // Bind back button
    document.getElementById('backToList').addEventListener('click', () => {
      App.showJobList();
    });

    // Init tab swiping
    this._initDetailTabs();

    // Bind gate code edit
    const locationId = Array.isArray(job.location_id) ? job.location_id[0] : null;
    const gateCodeRow = document.getElementById('gateCodeRow');
    if (gateCodeRow && locationId) {
      gateCodeRow.addEventListener('click', () => {
        this._showGateCodeModal(job, locationId);
      });
    }

    // Load additional worker names
    const workerCount = job.worker_count || (job.person_ids ? job.person_ids.length : 1);
    if (workerCount > 1 && job.additional_worker_ids && job.additional_worker_ids.length > 0) {
      this._loadCrewNames(job);
    }

    // Render work tab photos (stage-filtered)
    const workPhotoSection = document.getElementById('workPhotoSection');
    if (workPhotoSection) {
      const cats = this._getStagePhotoCategories(stageName);
      if (cats.length > 0) {
        Photos.renderFilteredPhotoSection(job.id, workPhotoSection, cats, () => {
          this._updateStageGate(job, stageName);
        });
      } else {
        workPhotoSection.innerHTML = '';
      }
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
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${addressForMap}`;

    const scheduledDate = this._formatScheduleDate(job.scheduled_date_start);
    const scheduledTime = this._formatScheduleTimeRange(job.scheduled_date_start, job.scheduled_date_end);

    // Gate code
    const gateCodeHtml = `<div class="detail-row gate-code-row" id="gateCodeRow">
           <span class="label">Gate Code</span>
           <span class="value">
             <span class="gate-code-value" id="gateCodeValue">${job.gate_code ? this._escapeHtml(job.gate_code) : '<em style="opacity:0.5">None</em>'}</span>
             <span class="gate-code-edit" title="Tap to edit">✏️</span>
           </span>
         </div>`;

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

    return `
      <div class="detail-section">
        <h3>${this._escapeHtml(locationName)}</h3>
        <a href="${mapUrl}" target="_blank" rel="noopener" class="map-link">
          📍 ${this._escapeHtml(fullAddress)}
        </a>
        <div class="divider"></div>
        ${gateCodeHtml}
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
        ${crewHtml}
        <div id="infoExtrasSection"${job.sale_id ? '' : ' style="display:none;"'}>
          <div class="divider"></div>
          ${saleRowHtml}
          ${gdriveRowHtml}
        </div>
      </div>
      ${this._isPreWorkStage(stageName) ? (() => {
        const sn = stageName.toLowerCase();
        const isDispatched = sn.includes('dispatch');
        if (isDispatched) {
          return `
      <div class="detail-section">
        <h3>Head to Job</h3>
        <div class="status-actions" id="infoStatusActions">
          <button class="btn btn-warning btn-block btn-lg" id="enRouteBtn" data-next-stage="En Route">
            → En Route
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
      })() : ''}`;
  },

  /**
   * Render the Work panel (tab 2) — status + stage-gated photos + materials.
   * When _showAllSteps is true, all photo categories and materials are visible
   * regardless of the current stage — useful for catch-up entry.
   */
  _renderWorkPanel(job, stageName) {
    const isPreWork = this._isPreWorkStage(stageName);
    const workflowHtml = isPreWork ? '' : this._buildWorkflowButtons(job, stageName);
    const stageCats = this._getStagePhotoCategories(stageName);
    const allCats = (CONFIG.PHOTO_CATEGORIES || []).map(c => c.key);
    const cats = this._showAllSteps ? allCats : stageCats;
    const showMaterials = this._showAllSteps ||
                          stageName.toLowerCase().includes('progress') ||
                          stageName.toLowerCase().includes('complete');

    const toggleHtml = `
      <button class="view-all-toggle${this._showAllSteps ? ' active' : ''}" id="viewAllStepsBtn">
        ${this._showAllSteps ? '&#10003; Showing All Steps' : '&#9711; Show All Steps'}
      </button>`;

    // Pre-work and not showing all: minimal message + toggle
    if (isPreWork && !this._showAllSteps) {
      return `
        <div class="detail-section">
          ${toggleHtml}
          <p style="color:var(--text-secondary); text-align:center; padding:var(--spacing-lg) 0 var(--spacing-sm);">
            Tap "En Route" on the Info tab to start this job.
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
  _getStagePhotoCategories(stageName) {
    const name = stageName.toLowerCase();
    if (name.includes('arrived')) return ['equipment_off', 'before'];
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
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const panelWidth = panels.offsetWidth;
        if (panelWidth > 0) {
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
    const workflow = CONFIG.WORKFLOW;
    const currentIdx = workflow.findIndex(s =>
      currentStageName.toLowerCase().includes(s.toLowerCase()) ||
      s.toLowerCase().includes(currentStageName.toLowerCase())
    );

    const nextIdx = currentIdx + 1;
    if (nextIdx >= workflow.length) {
      return '<p style="color:var(--text-secondary); font-size:var(--font-size-small);">Job completed</p>';
    }

    const nextStage = workflow[nextIdx];
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
    const name = stageName.toLowerCase();
    let gatedCategories = [];

    if (name.includes('arrived')) {
      gatedCategories = ['equipment_off', 'before'];
    } else if (name.includes('progress')) {
      gatedCategories = ['after'];
    } else {
      return { met: true, missing: [] };
    }

    const counts = await Photos.getPhotoCountsByCategory(job.id);
    const missing = [];

    for (const key of gatedCategories) {
      const cat = (CONFIG.PHOTO_CATEGORIES || []).find(c => c.key === key);
      if (cat && cat.required > 0 && (counts[key] || 0) < cat.required) {
        missing.push({
          category: key,
          label: cat.label,
          have: counts[key] || 0,
          need: cat.required
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

      await this.changeJobStatus(job, nextStageName);
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
        const targetStage = goingDirect ? 'En Route' : 'Dispatched';
        await this.changeJobStatus(job, targetStage);

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
          OdooAPI.sendEnRouteSms(job.id, phone, etaMinutes, smsBody).then(() => {
            App.showToast('SMS sent to customer', 'success');
            OdooAPI.postJournalEntry(job.id, 'SMS sent to ' + phone + ': ' + smsBody);
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
          window.open('https://www.google.com/maps/dir/?api=1&destination=' + addr, '_blank');
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
        await this.changeJobStatus(job, 'En Route');

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
          OdooAPI.sendEnRouteSms(job.id, phone, etaMinutes, smsBody).then(() => {
            App.showToast('SMS sent to customer', 'success');
            OdooAPI.postJournalEntry(job.id, 'SMS sent to ' + phone + ': ' + smsBody);
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
          window.open('https://www.google.com/maps/dir/?api=1&destination=' + addr, '_blank');
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
        await OdooAPI.sendEnRouteSms(job.id, phone, etaMinutes, smsBody);
        App.showToast('SMS sent to customer', 'success');
        OdooAPI.postJournalEntry(job.id, 'SMS sent to ' + phone + ': ' + smsBody);
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
    const hasAnyPhone = hasPhone || hasMobile;

    const callBtn = document.getElementById('footerCallBtn');
    const smsBtn = document.getElementById('footerSmsBtn');

    if (callBtn) {
      callBtn.classList.toggle('disabled', !hasAnyPhone);
    }
    if (smsBtn) {
      smsBtn.classList.toggle('disabled', !hasMobile);
    }
  },

  /**
   * Reset footer bar to default (no job selected).
   */
  _resetFooter() {
    this._currentJob = null;
    const callBtn = document.getElementById('footerCallBtn');
    const smsBtn = document.getElementById('footerSmsBtn');
    if (callBtn) callBtn.classList.add('disabled');
    if (smsBtn) smsBtn.classList.add('disabled');
    this._hideContactPicker();
  },

  /**
   * Show contact picker popup above phone button.
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
    const count = (hasPhone ? 1 : 0) + (hasMobile ? 1 : 0);

    if (hasMobile) {
      html += `
        <a href="tel:${this._escapeHtml(job.mobile)}" class="contact-picker-item">
          <span class="contact-picker-icon mobile">📱</span>
          <span class="contact-picker-label">Mobile</span>
          <span class="contact-picker-number">${this._escapeHtml(job.mobile)}</span>
        </a>`;
    }

    if (hasPhone) {
      html += `
        <a href="tel:${this._escapeHtml(job.phone)}" class="contact-picker-item">
          <span class="contact-picker-icon home">🏠</span>
          <span class="contact-picker-label">Phone</span>
          <span class="contact-picker-number">${this._escapeHtml(job.phone)}</span>
        </a>`;
    }

    picker.innerHTML = html;
    picker.classList.toggle('two-numbers', count === 2);
    picker.style.display = 'flex';

    // Close when clicking outside
    const closeHandler = (e) => {
      if (!picker.contains(e.target) && e.target.id !== 'footerCallBtn') {
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
   * Handle SMS button - direct SMS to mobile.
   */
  _handleSmsButton() {
    if (!this._currentJob) return;
    const mobile = this._currentJob.mobile;
    if (mobile && mobile.trim()) {
      window.location.href = 'sms:' + this._escapeHtml(mobile.trim());
    }
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
        </div>
        <div class="modal-body">
          <div class="modal-tab-content active" data-modal-content="journal" id="journalModalBody">
            <div class="loading"><div class="spinner"></div></div>
          </div>
          <div class="modal-tab-content" data-modal-content="photos" id="photosModalBody">
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

    // Tab switching
    const tabs = overlay.querySelectorAll('.modal-tab');
    const contents = overlay.querySelectorAll('.modal-tab-content');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.modalTab;
        tabs.forEach(t => t.classList.toggle('active', t.dataset.modalTab === target));
        contents.forEach(c => c.classList.toggle('active', c.dataset.modalContent === target));
      });
    });

    // Load journal content
    const journalBody = document.getElementById('journalModalBody');
    if (journalBody && typeof Journal !== 'undefined') {
      Journal.renderSection(jobId, journalBody);
    }

    // Load photos content (all categories, read-only gallery)
    const photosBody = document.getElementById('photosModalBody');
    if (photosBody && typeof Photos !== 'undefined') {
      Photos.renderAllPhotosGallery(jobId, photosBody);
    }
  },

  /**
   * Change a job's status to the named stage.
   * Stage changes are pushed to Odoo immediately (triggers backend automations).
   * GPS is captured for En Route/Arrived and sent as a follow-up if needed.
   */
  async changeJobStatus(job, stageName) {
    // En Route gate: must be clocked in
    const name = stageName.toLowerCase();
    if (name.includes('route') && typeof TimeTracking !== 'undefined') {
      const ok = await TimeTracking.ensureClockedIn();
      if (!ok) return; // user declined
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

    if (navigator.onLine) {
      // Push stage change immediately — backend automations depend on this
      await OdooAPI.updateOrderStage(job.id, stage.id, extraValues);

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

    // Auto clock-out prompt when completing a job
    if (CONFIG.AUTO_CLOCK_OUT_ON_COMPLETE && name.includes('complete') &&
        typeof TimeTracking !== 'undefined' && TimeTracking.isClockedIn()) {
      // Check if all today's jobs are now complete
      const allDone = this._jobs.every(j => {
        const sn = this.getStageName(j.stage_id);
        return this.getStatusClass(sn) === 'complete' || this.getStatusClass(sn) === 'cancelled';
      });
      if (allDone) {
        setTimeout(() => {
          if (confirm('All jobs complete. Clock off?')) {
            TimeTracking.clockOut();
          }
        }, 500);
      }
    }
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

    // Load project Google Drive photos folder
    const projectId = Array.isArray(job.project_id) ? job.project_id[0] : job.project_id;
    if (projectId && navigator.onLine) {
      OdooAPI.getProjectGdriveFolders(projectId).then(proj => {
        if (!proj || !proj.gdrive_photos_folder_id) return;
        const folderId = proj.gdrive_photos_folder_id;
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
   * Show modal to edit gate code.
   */
  _showGateCodeModal(job, locationId) {
    const currentCode = job.gate_code || '';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Update Gate Code</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Gate Code</label>
            <input type="text" class="form-input" id="gateCodeInput"
                   value="${this._escapeHtml(currentCode)}"
                   placeholder="e.g., #1234* or 5678">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="gateCodeCancel">Cancel</button>
          <button class="btn btn-primary" id="gateCodeSave">Save</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const input = document.getElementById('gateCodeInput');
    input.focus();
    input.select();

    const close = () => overlay.remove();

    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.getElementById('gateCodeCancel').addEventListener('click', close);

    document.getElementById('gateCodeSave').addEventListener('click', async () => {
      const newCode = input.value.trim();
      if (newCode === currentCode) { close(); return; }

      if (!confirm('Are you sure you want to update the gate code?')) return;

      const saveBtn = document.getElementById('gateCodeSave');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      try {
        if (navigator.onLine) {
          await OdooAPI.updateLocationGateCode(locationId, newCode);
        }
        // Update local cache
        job.gate_code = newCode;
        await DB.put('jobs', job);

        close();
        App.showToast('Gate code updated', 'success');

        // Re-render detail
        const container = document.getElementById('jobDetail');
        if (container) await this.renderJobDetail(job.id, container);
      } catch (err) {
        App.showToast('Failed to save: ' + err.message, 'error');
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
    if (this._currentView === 'week') {
      const day = d.toLocaleDateString([], this._tzOptions({ weekday: 'short' }));
      return `${day} · ${time}`;
    }
    if (this._currentView === 'history') {
      return d.toLocaleDateString([], this._tzOptions({ month: 'short', day: 'numeric' }));
    }
    return time;
  },

  _formatHistoryDate(job) {
    const raw = job.date_end || job.scheduled_date_start;
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
