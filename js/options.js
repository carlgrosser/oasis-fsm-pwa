/**
 * Options module — display and action on optional sale order items in the field.
 *
 * Shows items from sale_optional_buckets grouped by their bucket/section hierarchy.
 * Workers can:
 *   - Add an option to the current job's sale order (one tap)
 *   - Decline an option
 *   - Select multiple options and create a new FSM order for them
 *
 * Entry point: Options.renderSection(job, container)
 * Called from Jobs.renderJobDetail() when the Options tab is loaded.
 */
const Options = {
  // Set of option_line_ids checked for "new job" flow
  _selectedForNewJob: new Set(),

  // ========== ENTRY POINT ==========

  // True while rendering from cache offline — suppresses action controls.
  _readOnly: false,

  async renderSection(job, container) {
    this._selectedForNewJob.clear();

    // Online: fetch live, cache for offline, render the interactive view.
    // On a weak-signal failure, fall through to the cached read-only view.
    if (navigator.onLine) {
      container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      try {
        const data = await OdooAPI.getJobOptions(job.id);
        DB.cacheJobOptions(job.id, data).catch(() => {}); // cache for offline (non-fatal)
        this._readOnly = false;

        if (!data.has_options) {
          container.innerHTML = `
            <div class="empty-state">
              <p>No optional items for this job.</p>
            </div>`;
          return;
        }
        this._render(job, data, container);
        return;
      } catch (err) {
        console.warn('Options: live fetch failed, falling back to cache', err);
        // fall through to cache
      }
    }

    // Offline (or fetch failed): render last-synced options read-only.
    const cached = await DB.getCachedJobOptions(job.id).catch(() => null);
    if (cached && cached.has_options) {
      this._readOnly = true;
      this._render(job, cached, container);
    } else if (cached && !cached.has_options) {
      container.innerHTML = `
        <div class="empty-state">
          <p>No optional items for this job.</p>
        </div>`;
    } else {
      container.innerHTML = `
        <div class="empty-state">
          <p>Options unavailable offline — not yet synced for this job.</p>
        </div>`;
    }
  },

  // ========== RENDERING ==========

  _render(job, data, container) {
    const items = data.items || [];
    const proposedCount = data.proposed_count || 0;

    let html = '';

    if (this._readOnly) {
      html += `
        <div class="alert alert-info" style="margin-bottom:var(--spacing-sm);">
          📴 Offline — showing last-synced options. Reconnect to add or decline items.
        </div>`;
    }

    if (proposedCount > 0) {
      html += `
        <div class="options-banner">
          <span>${proposedCount} pending option${proposedCount !== 1 ? 's' : ''} — review with customer</span>
        </div>`;
    }

    // Walk the flat ordered list and emit bucket/section/product HTML
    let i = 0;
    while (i < items.length) {
      const item = items[i];

      if (item.display_type === 'line_bucket') {
        // Bucket header — contains everything until the next bucket
        html += `<div class="options-bucket">
          <div class="options-bucket-header">${this._esc(item.name)}</div>`;
        i++;
        while (i < items.length && items[i].display_type !== 'line_bucket') {
          html += this._renderItem(items[i]);
          i++;
        }
        html += '</div>';

      } else {
        html += this._renderItem(item);
        i++;
      }
    }

    // Floating bar for "Create New Job" — shown when items are checked.
    // Omitted offline: creating a job needs the server.
    if (!this._readOnly) {
      html += `
        <div class="options-new-job-bar" id="optionsNewJobBar" style="display:none;">
          <button class="btn btn-primary btn-block" id="optionsCreateNewJobBtn">
            Create New Job &mdash; <span id="optionsNewJobCount">0</span> item(s)
          </button>
        </div>`;
    }
    html += `<div style="height: 16px;"></div>`;

    container.innerHTML = html;
    if (!this._readOnly) {
      this._bindEvents(job, container);
    }
  },

  _renderItem(item) {
    if (item.display_type === 'line_section') {
      return `<div class="options-section-header">${this._esc(item.name)}</div>`;
    }
    if (item.display_type === 'line_note') {
      return `<div class="options-note">${this._esc(item.name)}</div>`;
    }
    // Product line
    return this._renderProductLine(item);
  },

  _renderProductLine(item) {
    const state = item.state || 'proposed';
    const isProposed = state === 'proposed' && !item.is_expired;
    const isAdded    = state === 'added';
    const isDeclined = state === 'declined';
    const isExpired  = item.is_expired;

    const stateClass = isAdded ? 'option-added'
      : isDeclined ? 'option-declined'
      : isExpired  ? 'option-expired'
      : '';

    const price = item.price_unit
      ? '$' + parseFloat(item.price_unit).toFixed(2)
        + (item.qty && item.qty !== 1 ? ` &times; ${item.qty}` : '')
      : '';
    const subtotal = item.subtotal && item.subtotal !== item.price_unit
      ? ' = $' + parseFloat(item.subtotal).toFixed(2)
      : '';

    let actionsHtml = '';
    if (isProposed && this._readOnly) {
      // Offline: no actions, just indicate the item is available.
      actionsHtml = `<div class="option-state-badge">Available — reconnect to add</div>`;
    } else if (isProposed) {
      actionsHtml = `
        <div class="option-actions">
          <label class="option-new-job-label">
            <input type="checkbox"
                   class="option-new-job-check"
                   data-id="${item.id}"
                   data-name="${this._esc(item.description || item.name)}">
            New Job
          </label>
          <button class="btn btn-sm btn-success btn-option-add" data-id="${item.id}">
            + Add to Order
          </button>
          <button class="btn btn-sm btn-secondary btn-option-decline" data-id="${item.id}">
            Decline
          </button>
        </div>`;
    } else if (isAdded) {
      actionsHtml = `<div class="option-state-badge option-state-added">&#10003; Added to Order</div>`;
    } else if (isDeclined) {
      actionsHtml = `<div class="option-state-badge option-state-declined">Declined</div>`;
    } else if (isExpired) {
      actionsHtml = `<div class="option-state-badge option-state-expired">Expired</div>`;
    }

    return `
      <div class="option-line ${stateClass}" data-id="${item.id}">
        <div class="option-line-info">
          <div class="option-line-name">${this._esc(item.description || item.name)}</div>
          ${price ? `<div class="option-line-price">${price}${subtotal}</div>` : ''}
        </div>
        ${actionsHtml}
      </div>`;
  },

  // ========== EVENT BINDING ==========

  _bindEvents(job, container) {
    // Add to current order
    container.querySelectorAll('.btn-option-add').forEach(btn => {
      btn.addEventListener('click', () => this._handleAdd(job, parseInt(btn.dataset.id, 10)));
    });

    // Decline
    container.querySelectorAll('.btn-option-decline').forEach(btn => {
      btn.addEventListener('click', () => this._handleDecline(job, parseInt(btn.dataset.id, 10)));
    });

    // New-job checkboxes
    container.querySelectorAll('.option-new-job-check').forEach(chk => {
      chk.addEventListener('change', () => this._updateNewJobBar(container));
    });

    // Create New Job button
    const createBtn = document.getElementById('optionsCreateNewJobBtn');
    if (createBtn) {
      createBtn.addEventListener('click', () => this._showNewJobModal(job, container));
    }
  },

  _updateNewJobBar(container) {
    const checked = [...container.querySelectorAll('.option-new-job-check:checked')];
    this._selectedForNewJob = new Set(checked.map(c => parseInt(c.dataset.id, 10)));

    const bar   = document.getElementById('optionsNewJobBar');
    const count = document.getElementById('optionsNewJobCount');
    if (bar)   bar.style.display   = checked.length > 0 ? 'block' : 'none';
    if (count) count.textContent   = checked.length;
  },

  // ========== ACTIONS ==========

  async _handleAdd(job, optionLineId) {
    const btn = document.querySelector(`.btn-option-add[data-id="${optionLineId}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '…'; }

    try {
      const result = await OdooAPI.addOptionToOrder(job.id, optionLineId);
      if (result.success) {
        this._updateBadge(result.proposed_count);
        // Refresh both tabs
        const optContainer = document.getElementById('optionsTabContent');
        if (optContainer) await this.renderSection(job, optContainer);
        const salesContent = document.getElementById('salesTabContent');
        if (salesContent && typeof Billing !== 'undefined') {
          Billing.renderSalesTab(job, salesContent);
        }
      } else {
        if (btn) { btn.disabled = false; btn.textContent = '+ Add to Order'; }
        this._toast('Could not add option: ' + (result.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = '+ Add to Order'; }
      this._toast('Error: ' + err.message, 'error');
    }
  },

  async _handleDecline(job, optionLineId) {
    const lineEl = document.querySelector(`.option-line[data-id="${optionLineId}"]`);
    const name = lineEl ? lineEl.querySelector('.option-line-name')?.textContent : 'this option';
    if (!confirm(`Decline "${name}"?`)) return;

    const btn = document.querySelector(`.btn-option-decline[data-id="${optionLineId}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '…'; }

    try {
      const result = await OdooAPI.declineOption(job.id, optionLineId);
      if (result.success) {
        this._updateBadge(result.proposed_count);
        const optContainer = document.getElementById('optionsTabContent');
        if (optContainer) await this.renderSection(job, optContainer);
      } else {
        if (btn) { btn.disabled = false; btn.textContent = 'Decline'; }
        this._toast('Could not decline: ' + (result.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Decline'; }
      this._toast('Error: ' + err.message, 'error');
    }
  },

  // ========== NEW JOB MODAL ==========

  _showNewJobModal(job, container) {
    const selectedIds = [...this._selectedForNewJob];
    if (selectedIds.length === 0) return;

    // Collect names from checked checkboxes
    const selectedNames = selectedIds.map(id => {
      const chk = container.querySelector(`.option-new-job-check[data-id="${id}"]`);
      return chk ? chk.dataset.name : `Option #${id}`;
    });

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="modal modal-options-new-job">
        <div class="modal-header">
          <h3>Create New Job</h3>
          <button class="modal-close" id="optionsNewJobClose">&times;</button>
        </div>
        <div class="modal-body">
          <p style="margin-bottom: var(--spacing-sm); font-size: var(--font-size-small);
                     color: var(--text-secondary);">
            The following items will be added to a new work order at the same location:
          </p>
          <ul class="options-new-job-list">
            ${selectedNames.map(n => `<li>${this._esc(n)}</li>`).join('')}
          </ul>
          <div class="form-group" style="margin-top: var(--spacing-md);">
            <label for="optionsNewJobNotes">Notes for office (optional)</label>
            <textarea class="form-input" id="optionsNewJobNotes" rows="3"
              placeholder="e.g. Customer confirmed, schedule ASAP"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="optionsNewJobCancel">Cancel</button>
          <button class="btn btn-primary" id="optionsNewJobConfirm">Create New Job</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const closeModal = () => overlay.remove();
    overlay.querySelector('#optionsNewJobClose').addEventListener('click', closeModal);
    overlay.querySelector('#optionsNewJobCancel').addEventListener('click', closeModal);

    overlay.querySelector('#optionsNewJobConfirm').addEventListener('click', async () => {
      const notes = overlay.querySelector('#optionsNewJobNotes').value.trim();
      const confirmBtn = overlay.querySelector('#optionsNewJobConfirm');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Creating…';

      try {
        const result = await OdooAPI.createFsmFromOptions(job.id, selectedIds, notes);
        closeModal();

        if (result.success) {
          this._toast(
            `New job ${this._esc(result.new_fsm_name)} created (${this._esc(result.new_so_name)})`,
            'success'
          );
          this._updateBadge(null); // will be recalculated on next load
          const optContainer = document.getElementById('optionsTabContent');
          if (optContainer) await this.renderSection(job, optContainer);
        } else {
          this._toast('Failed to create new job: ' + (result.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        closeModal();
        this._toast('Error: ' + err.message, 'error');
      }
    });
  },

  // ========== HELPERS ==========

  /**
   * Update the Options tab badge (proposed count).
   * @param {number|null} count - null means clear/hide badge
   */
  _updateBadge(count) {
    const badge = document.getElementById('optionsTabBadge');
    if (!badge) return;
    if (count === null || count === undefined || count <= 0) {
      badge.style.display = 'none';
    } else {
      badge.textContent = count;
      badge.style.display = '';
    }
  },

  _toast(message, type) {
    // Reuse the app's toast if available
    if (typeof App !== 'undefined' && App.showToast) {
      App.showToast(message, type);
      return;
    }
    // Fallback
    const container = document.getElementById('toastContainer');
    if (!container) { alert(message); return; }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type || 'info'}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  },

  _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
};
