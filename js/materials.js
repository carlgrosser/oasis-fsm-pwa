/**
 * Materials module — configurable material usage tracking per job.
 * Loads material config from Odoo based on the order's categories,
 * renders quantity steppers, and saves usage back to Odoo.
 */
const Materials = {
  _config: [],      // material config for current job [{product_tmpl_id, product_name, uom_label, variants: [{product_id, variant_name, current_qty}]}]
  _currentJobId: null,

  /**
   * Render the materials section for a job.
   * Hides the wrapper if no materials are configured for this job's categories.
   */
  async renderSection(jobId, container) {
    this._currentJobId = jobId;
    const wrapper = document.getElementById('materialsWrapper');

    try {
      await this._loadConfig(jobId);
    } catch (err) {
      console.warn('Failed to load material config:', err);
      // If offline and no config cached, hide section
      if (wrapper) wrapper.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    if (this._config.length === 0) {
      if (wrapper) wrapper.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    // Show the section
    if (wrapper) wrapper.style.display = '';
    this._renderForm(jobId, container);
  },

  /**
   * Load material config from Odoo for this order.
   */
  async _loadConfig(jobId) {
    if (navigator.onLine) {
      this._config = await OdooAPI.getMaterialConfig(jobId);
    } else {
      // Offline: try to load from cached state
      const cached = await DB.getState('materials_config_' + jobId);
      this._config = cached || [];
    }

    // Cache config for offline use
    if (this._config.length > 0) {
      await DB.setState('materials_config_' + jobId, this._config);
    }
  },

  /**
   * Render quantity stepper form for each material.
   */
  _renderForm(jobId, container) {
    let html = '<div class="materials-form">';

    for (const mat of this._config) {
      const isSingle = mat.variants.length === 1 && !mat.variants[0].variant_name;
      if (isSingle) {
        const v = mat.variants[0];
        const qty = v.current_qty || 0;
        html += `
          <div class="materials-row" data-product-id="${v.product_id}">
            <span class="materials-label">${this._escapeHtml(mat.product_name)}</span>
            <div class="materials-stepper">
              <button class="materials-btn materials-minus" type="button">-</button>
              <input type="number" class="materials-qty" value="${qty}" min="0" step="1" inputmode="numeric">
              <button class="materials-btn materials-plus" type="button">+</button>
              <span class="materials-unit">${this._escapeHtml(mat.uom_label)}</span>
            </div>
          </div>
        `;
      } else {
        html += `<div class="materials-group">`;
        html += `<div class="materials-group-header">${this._escapeHtml(mat.product_name)} <span class="materials-unit-header">${this._escapeHtml(mat.uom_label)}</span></div>`;
        for (const v of mat.variants) {
          const qty = v.current_qty || 0;
          html += `
            <div class="materials-row materials-variant-row" data-product-id="${v.product_id}">
              <span class="materials-label">${this._escapeHtml(v.variant_name)}</span>
              <div class="materials-stepper">
                <button class="materials-btn materials-minus" type="button">-</button>
                <input type="number" class="materials-qty" value="${qty}" min="0" step="1" inputmode="numeric">
                <button class="materials-btn materials-plus" type="button">+</button>
              </div>
            </div>
          `;
        }
        html += `</div>`;
      }
    }

    html += `
        <button class="btn btn-primary btn-block materials-save" type="button">
          Save Materials
        </button>
      </div>
    `;

    container.innerHTML = html;
    this._bindEvents(jobId, container);
  },

  /**
   * Bind stepper +/- buttons and save button.
   */
  _bindEvents(jobId, container) {
    // Plus/minus buttons
    container.querySelectorAll('.materials-row').forEach(row => {
      const input = row.querySelector('.materials-qty');
      row.querySelector('.materials-minus').addEventListener('click', () => {
        const val = parseInt(input.value, 10) || 0;
        if (val > 0) input.value = val - 1;
      });
      row.querySelector('.materials-plus').addEventListener('click', () => {
        const val = parseInt(input.value, 10) || 0;
        input.value = val + 1;
      });
    });

    // Save button
    container.querySelector('.materials-save').addEventListener('click', () => {
      this._save(jobId, container);
    });
  },

  /**
   * Collect values and save to Odoo (or queue for offline sync).
   */
  async _save(jobId, container) {
    const saveBtn = container.querySelector('.materials-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    const lines = [];
    container.querySelectorAll('.materials-row').forEach(row => {
      const productId = parseInt(row.dataset.productId, 10);
      const qty = parseFloat(row.querySelector('.materials-qty').value) || 0;
      lines.push({ product_id: productId, quantity: qty });
    });

    try {
      if (navigator.onLine) {
        await OdooAPI.saveMaterials(jobId, lines);
        App.showToast('Materials saved', 'success');

        // Build a summary of non-zero lines for the system log
        const nonZero = lines.filter(l => l.quantity > 0);
        if (nonZero.length > 0) {
          // Build a product ID → name map from the loaded config
          const nameMap = {};
          for (const mat of this._config) {
            for (const v of mat.variants) {
              const label = mat.variants.length === 1 && !v.variant_name
                ? mat.product_name
                : `${mat.product_name} (${v.variant_name})`;
              nameMap[v.product_id] = label;
            }
          }
          const summary = nonZero
            .map(l => `${nameMap[l.product_id] || l.product_id}: ${l.quantity}`)
            .join(', ');
          OdooAPI.postSystemNote(jobId, `Materials saved — ${summary}`).catch(() => {});
        }
      } else {
        // Queue for sync
        await DB.put('materialsQueue', {
          temp_id: 'mat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          job_id: jobId,
          lines: lines,
          synced: 0,
        });
        App.showToast('Materials saved offline — will sync later', 'info');
      }

      // Update cached config with new quantities
      for (const line of lines) {
        for (const mat of this._config) {
          const v = mat.variants.find(v => v.product_id === line.product_id);
          if (v) { v.current_qty = line.quantity; break; }
        }
      }
      await DB.setState('materials_config_' + jobId, this._config);
    } catch (err) {
      console.error('Failed to save materials:', err);
      App.showToast('Failed to save materials: ' + err.message, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Materials';
    }
  },

  /**
   * Sync queued material entries. Called from Sync module.
   */
  async syncAll() {
    let synced = 0;
    let failed = 0;

    try {
      const pending = await DB.getUnsyncedItems('materialsQueue');
      for (const item of pending) {
        try {
          await OdooAPI.saveMaterials(item.job_id, item.lines);
          item.synced = 1;
          await DB.put('materialsQueue', item);
          synced++;
        } catch (err) {
          console.warn('Failed to sync material entry:', item, err);
          failed++;
        }
      }
    } catch (err) {
      // Store may not exist yet
      console.warn('Materials sync error:', err);
    }

    return { synced, failed };
  },

  _escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  },
};
