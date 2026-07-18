/**
 * Billing module — Sales order viewing/editing, invoicing, and payment collection.
 *
 * Entry point: Billing.renderSalesTab(job, container)
 * Called from Jobs._renderSalesPanel() when job detail Sales tab is active.
 */
const Billing = {
  _pollTimer: null,
  _pollTimeout: null,

  // ========== MAIN ENTRY ==========

  /**
   * Render the full sales/billing tab content into a container.
   */
  async renderSalesTab(job, container) {
    if (!navigator.onLine) {
      container.innerHTML = this._offlineMessage();
      return;
    }

    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    try {
      const data = await OdooAPI.getSaleOrder(job.id);

      if (!data.has_sale_order) {
        container.innerHTML = this._noSalesOrder(job);
        return;
      }

      this._renderSalesContent(job, data, container);
    } catch (err) {
      console.error('Billing: failed to load SO', err);
      container.innerHTML = this._errorMessage(err);
    }
  },

  // ========== STATE-BASED RENDERING ==========

  /**
   * Render content based on SO/invoice state.
   */
  _renderSalesContent(job, data, container) {
    const so = data.sale_order;
    const invoices = data.invoices || [];
    const paidInvoice = invoices.find(i => i.payment_state === 'paid' || i.payment_state === 'in_payment');
    const unpaidInvoice = invoices.find(i => i.state === 'posted' && i.payment_state !== 'paid' && i.payment_state !== 'in_payment');

    if (paidInvoice) {
      // State 4: Invoice paid — show receipt options
      this._renderPaidView(job, data, paidInvoice, container);
    } else if (unpaidInvoice) {
      // State 3: Invoice exists, unpaid — show payment options
      this._renderInvoiceView(job, data, unpaidInvoice, container);
    } else {
      // State 2: SO exists, may or may not be ready for invoicing
      this._renderSOView(job, data, container);
    }
  },

  // ========== STATE 2: SO LINES VIEW ==========

  _renderSOView(job, data, container) {
    const so = data.sale_order;
    const lines = data.lines || [];
    const changeOrders = data.change_orders || [];

    const soStateName = {
      'draft': 'Quotation',
      'sent': 'Quotation Sent',
      'sale': 'Sales Order',
      'done': 'Locked',
      'cancel': 'Cancelled',
    }[so.state] || so.state;

    let html = `
      <div class="detail-section">
        <div class="billing-so-header">
          <h3>${this._esc(so.name)}</h3>
          <span class="billing-so-status">${this._esc(soStateName)}</span>
        </div>
        <div class="billing-so-total">
          Total: <strong>$${this._money(so.amount_total)}</strong>
        </div>
      </div>

      <div class="detail-section">
        <div class="billing-lines" id="billingLines">
    `;

    for (const line of lines) {
      html += this._lineItemHtml(line, so.state === 'sale');
    }

    html += '</div>';

    // Add Line button (only for confirmed SOs)
    if (so.state === 'sale') {
      html += `
        <button class="btn btn-outline btn-block btn-sm" id="addLineBtn"
                style="margin-top:var(--spacing-sm);">
          + Add Line
        </button>
      `;
    }

    html += '</div>';

    // Change orders section
    if (changeOrders.length > 0) {
      html += '<div class="detail-section"><h3>Change Orders</h3><div class="billing-change-orders">';
      for (const co of changeOrders) {
        html += `
          <div class="billing-change-order-item">
            <div>
              <strong>${this._esc(co.name)}</strong>
              <div style="font-size:var(--font-size-xs);color:var(--text-muted);">${this._esc(co.x_change_reason)}</div>
            </div>
            <div style="font-weight:600;">$${this._money(co.amount_total)}</div>
          </div>
        `;
      }
      html += '</div></div>';
    }

    // Change order threshold alert
    if (so.state === 'sale' && changeOrders.length === 0) {
      const onSiteTotal = lines
        .filter(l => l.x_added_on_site)
        .reduce((sum, l) => sum + l.price_subtotal, 0);
      if (onSiteTotal > (CONFIG.CHANGE_ORDER_THRESHOLD || 300)) {
        html += `
          <div class="detail-section">
            <div class="alert alert-info">
              On-site additions total <strong>$${this._money(onSiteTotal)}</strong> — exceeds
              $${this._money(CONFIG.CHANGE_ORDER_THRESHOLD || 300)} threshold.
              Consider creating a change order for customer approval.
            </div>
            <button class="btn btn-warning btn-block" id="createChangeOrderBtn">
              Create Change Order
            </button>
          </div>
        `;
      }
    }

    // Create Invoice / Ready to Invoice buttons
    if (so.invoice_status === 'to invoice') {
      html += `
        <div class="detail-section">
          <button class="btn btn-success btn-block btn-lg" id="createInvoiceBtn">
            Create Invoice
          </button>
          ${!so.x_ready_to_invoice ? `
            <button class="btn btn-outline btn-block btn-sm" id="readyToInvoiceBtn"
                    style="margin-top:var(--spacing-sm);">
              Mark Ready to Invoice
            </button>
          ` : `
            <div class="billing-hint" style="color:var(--success-color);font-weight:600;">
              Marked Ready for Invoicing
            </div>
          `}
        </div>
      `;
    } else if (so.invoice_status === 'no') {
      html += `
        <div class="detail-section">
          <p class="billing-hint">Nothing to invoice yet. Deliver services to enable invoicing.</p>
          ${!so.x_ready_to_invoice ? `
            <button class="btn btn-outline btn-block btn-sm" id="readyToInvoiceBtn">
              Mark Ready to Invoice
            </button>
          ` : `
            <div class="billing-hint" style="color:var(--success-color);font-weight:600;">
              Marked Ready for Invoicing
            </div>
          `}
        </div>
      `;
    }

    // SO PDF link
    html += `
      <div class="detail-section">
        <a href="${CONFIG.ODOO_URL}/report/pdf/sale.report_saleorder/${so.id}"
           target="_blank" rel="noopener" class="btn btn-outline btn-block btn-sm">
          View SO PDF
        </a>
      </div>
    `;

    container.innerHTML = html;
    this._bindSOEvents(job, data, container);
  },

  _lineItemHtml(line, editable) {
    const editBtn = editable
      ? `<button class="btn btn-sm btn-secondary so-line-edit" data-line-id="${line.id}">Edit</button>`
      : '';

    // On-site badge
    const onsiteBadge = line.x_added_on_site
      ? `<span class="so-line-onsite-badge">Added On-Site</span>`
      : '';

    // Do-not-invoice badge + toggle
    const dniClass = line.x_do_not_invoice ? ' so-line-excluded' : '';
    const dniBadge = line.x_do_not_invoice
      ? `<span class="so-line-dni-badge">Excluded</span>`
      : '';
    const dniBtn = editable
      ? `<button class="btn btn-sm so-line-dni-btn ${line.x_do_not_invoice ? 'btn-secondary' : 'btn-outline'}"
               data-line-id="${line.id}" data-dni="${line.x_do_not_invoice ? '1' : '0'}"
               title="${line.x_do_not_invoice ? 'Re-include in invoice' : 'Exclude from invoice'}">
           ${line.x_do_not_invoice ? 'Include' : 'Exclude'}
         </button>`
      : '';

    // Description (show if different from product name)
    const desc = line.description && line.description !== line.product_name
      ? `<div class="so-line-desc">${this._esc(line.description)}</div>`
      : '';

    // Qty delivered indicator (muted if excluded)
    const qtyMatch = line.x_do_not_invoice || line.qty_delivered === line.quantity;
    const qtyClass = qtyMatch ? 'so-line-qty-match' : 'so-line-qty-mismatch';
    const deliveredLabel = line.x_do_not_invoice
      ? 'Not invoiced'
      : `Delivered: ${line.qty_delivered}/${line.quantity}`;

    return `
      <div class="so-line${dniClass}" data-line-id="${line.id}">
        <div class="so-line-info">
          <div class="so-line-name">
            ${this._esc(line.product_name || line.description)}
            ${onsiteBadge}${dniBadge}
          </div>
          ${desc}
          <div class="so-line-qty-row">
            <span class="so-line-detail">
              ${line.quantity} ${this._esc(line.product_uom)} × $${this._money(line.price_unit)}
              ${line.discount ? ' (-' + line.discount + '%)' : ''}
            </span>
            <span class="${qtyClass}">${deliveredLabel}</span>
          </div>
        </div>
        <div class="so-line-right">
          <div class="so-line-price">$${this._money(line.price_subtotal)}</div>
          <div style="display:flex;gap:4px;">
            ${dniBtn}
            ${editBtn}
          </div>
        </div>
      </div>
    `;
  },

  _bindSOEvents(job, data, container) {
    // Do-not-invoice toggle buttons
    container.querySelectorAll('.so-line-dni-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const lineId = parseInt(btn.dataset.lineId, 10);
        const currentlyExcluded = btn.dataset.dni === '1';
        const newValue = !currentlyExcluded;
        btn.disabled = true;
        try {
          await OdooAPI.setDoNotInvoice(lineId, newValue);
          const line = data.lines.find(l => l.id === lineId);
          if (line) line.x_do_not_invoice = newValue;
          OdooAPI.postSystemNote(job.id,
            `Billing: Line "${line ? line.product_name : lineId}" ${newValue ? 'excluded from' : 'included in'} invoice`
          ).catch(() => {});
          await this.renderSalesTab(job, container);
        } catch (err) {
          App.showToast('Failed: ' + err.message, 'error');
          btn.disabled = false;
        }
      });
    });

    // Edit line buttons
    container.querySelectorAll('.so-line-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const lineId = parseInt(btn.dataset.lineId, 10);
        const line = data.lines.find(l => l.id === lineId);
        if (line) this._showEditLineModal(job, data, line, container);
      });
    });

    // Add line button
    const addBtn = container.querySelector('#addLineBtn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        this._showAddLineModal(job, data, container);
      });
    }

    // Create invoice button
    const invoiceBtn = container.querySelector('#createInvoiceBtn');
    if (invoiceBtn) {
      invoiceBtn.addEventListener('click', async () => {
        invoiceBtn.disabled = true;
        invoiceBtn.textContent = 'Creating Invoice...';
        try {
          const result = await OdooAPI.createInvoice(job.id);
          if (result.success) {
            App.showToast('Invoice created: ' + (result.invoice_name || ''), 'success');
            OdooAPI.postJournalEntry(job.id, `Invoice created: ${result.invoice_name || ''}`).catch(() => {});
            await this.renderSalesTab(job, container);
          }
        } catch (err) {
          App.showToast('Failed: ' + err.message, 'error');
          invoiceBtn.disabled = false;
          invoiceBtn.textContent = 'Create Invoice';
        }
      });
    }

    // Ready to Invoice button
    const readyBtn = container.querySelector('#readyToInvoiceBtn');
    if (readyBtn) {
      readyBtn.addEventListener('click', async () => {
        readyBtn.disabled = true;
        readyBtn.textContent = 'Marking...';
        try {
          await OdooAPI.setReadyToInvoice(data.sale_order.id, true);
          App.showToast('Marked ready for invoicing', 'success');
          OdooAPI.postSystemNote(job.id, 'Billing: Marked ready to invoice').catch(() => {});
          await this.renderSalesTab(job, container);
        } catch (err) {
          App.showToast('Failed: ' + err.message, 'error');
          readyBtn.disabled = false;
          readyBtn.textContent = 'Mark Ready to Invoice';
        }
      });
    }

    // Create Change Order button
    const coBtn = container.querySelector('#createChangeOrderBtn');
    if (coBtn) {
      const onSiteLines = data.lines.filter(l => l.x_added_on_site);
      coBtn.addEventListener('click', () => {
        this._showChangeOrderModal(job, data, onSiteLines, container);
      });
    }
  },

  // ========== EDIT LINE MODAL ==========

  _showEditLineModal(job, data, line, parentContainer) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Edit Line</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="billing-edit-product">${this._esc(line.product_name)}</div>
          <div class="form-group">
            <label for="editLineDesc">Description</label>
            <textarea class="form-input" id="editLineDesc" rows="2">${this._esc(line.description)}</textarea>
          </div>
          <div class="billing-edit-row">
            <div class="form-group" style="flex:1;">
              <label for="editLineQty">Ordered Qty</label>
              <input type="number" class="form-input" id="editLineQty"
                     value="${line.quantity}" min="0" step="any">
            </div>
            <div class="form-group" style="flex:1;">
              <label for="editLinePrice">Unit Price</label>
              <input type="number" class="form-input" id="editLinePrice"
                     value="${line.price_unit}" min="0" step="0.01">
            </div>
          </div>
          <div class="form-group">
            <label for="editLineDelivered">Delivered Quantity</label>
            <input type="number" class="form-input" id="editLineDelivered"
                   value="${line.qty_delivered}" min="0" step="any">
          </div>
          <div class="billing-edit-subtotal">
            Subtotal: <strong id="editLineSubtotal">$${this._money(line.price_subtotal)}</strong>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="editLineCancel">Cancel</button>
          <button class="btn btn-primary" id="editLineSave">Save</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('editLineCancel').addEventListener('click', close);

    // Live subtotal calc
    const qtyInput = document.getElementById('editLineQty');
    const priceInput = document.getElementById('editLinePrice');
    const subtotalEl = document.getElementById('editLineSubtotal');

    const updateSubtotal = () => {
      const q = parseFloat(qtyInput.value) || 0;
      const p = parseFloat(priceInput.value) || 0;
      subtotalEl.textContent = '$' + this._money(q * p);
    };
    qtyInput.addEventListener('input', updateSubtotal);
    priceInput.addEventListener('input', updateSubtotal);

    // Save
    document.getElementById('editLineSave').addEventListener('click', async () => {
      const saveBtn = document.getElementById('editLineSave');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      const values = {};
      const newQty = parseFloat(qtyInput.value);
      const newPrice = parseFloat(priceInput.value);
      const newDesc = document.getElementById('editLineDesc').value;
      const newDelivered = parseFloat(document.getElementById('editLineDelivered').value);

      if (newQty !== line.quantity) values.quantity = newQty;
      if (newPrice !== line.price_unit) values.price_unit = newPrice;
      if (newDesc !== line.description) values.description = newDesc;
      if (newDelivered !== line.qty_delivered) values.qty_delivered = newDelivered;

      if (Object.keys(values).length === 0) {
        close();
        return;
      }

      try {
        await OdooAPI.updateSaleLine(line.id, values);
        App.showToast('Line updated', 'success');
        OdooAPI.postSystemNote(job.id, `Billing: Line updated — ${line.product_name || 'item'}`).catch(() => {});
        close();

        // Check for variance — if delivered != ordered, show variance modal
        const finalQty = 'quantity' in values ? values.quantity : line.quantity;
        const finalDelivered = 'qty_delivered' in values ? values.qty_delivered : line.qty_delivered;
        if (finalDelivered !== finalQty && 'qty_delivered' in values) {
          // Reload data first
          const freshData = await OdooAPI.getSaleOrder(job.id);
          if (freshData.has_sale_order) {
            const varianceLines = freshData.lines.filter(l => l.qty_delivered !== l.quantity);
            if (varianceLines.length > 0) {
              this._showVarianceReasonModal(job, freshData, varianceLines, parentContainer);
              return;
            }
          }
        }

        await this.renderSalesTab(job, parentContainer);
      } catch (err) {
        App.showToast('Failed: ' + err.message, 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });
  },

  // ========== ADD LINE MODAL ==========

  _showAddLineModal(job, data, parentContainer) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-add-line">
        <div class="modal-header">
          <h3>Add Line</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="addLineSearch">Search Product</label>
            <input type="text" class="form-input" id="addLineSearch"
                   placeholder="Type to search products...">
          </div>
          <div id="productResults" class="billing-product-results"></div>
          <div id="addLineForm" style="display:none;">
            <div class="billing-selected-product" id="selectedProductName"></div>
            <div class="billing-edit-row">
              <div class="form-group" style="flex:1;">
                <label for="addLineQty">Quantity</label>
                <input type="number" class="form-input" id="addLineQty" value="1" min="1" step="any">
              </div>
              <div class="form-group" style="flex:1;">
                <label for="addLinePrice">Unit Price</label>
                <input type="number" class="form-input" id="addLinePrice" value="0" min="0" step="0.01">
              </div>
            </div>
            <div class="form-group">
              <label for="addLineDesc">Description (optional)</label>
              <input type="text" class="form-input" id="addLineDesc" placeholder="Override description">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="addLineCancel">Cancel</button>
          <button class="btn btn-primary" id="addLineSave" disabled>Add</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('addLineCancel').addEventListener('click', close);

    let selectedProduct = null;
    let searchTimeout = null;
    const searchInput = document.getElementById('addLineSearch');
    const resultsDiv = document.getElementById('productResults');
    const formDiv = document.getElementById('addLineForm');
    const saveBtn = document.getElementById('addLineSave');

    // Product search with debounce
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      const query = searchInput.value.trim();
      if (query.length < 2) {
        resultsDiv.innerHTML = '';
        return;
      }
      searchTimeout = setTimeout(async () => {
        try {
          resultsDiv.innerHTML = '<div class="billing-hint">Searching...</div>';
          const companyId = Array.isArray(job.company_id) ? job.company_id[0] : (job.company_id || null);
          const products = await OdooAPI.searchProducts(query, companyId);
          if (products.length === 0) {
            resultsDiv.innerHTML = '<div class="billing-hint">No products found</div>';
            return;
          }
          resultsDiv.innerHTML = products.map(p => `
            <button class="billing-product-item" data-product='${JSON.stringify(p).replace(/'/g, "&#39;")}'>
              <span class="billing-product-name">${this._esc(p.name)}</span>
              <span class="billing-product-price">$${this._money(p.price)}</span>
            </button>
          `).join('');

          resultsDiv.querySelectorAll('.billing-product-item').forEach(btn => {
            btn.addEventListener('click', () => {
              selectedProduct = JSON.parse(btn.dataset.product);
              document.getElementById('selectedProductName').textContent = selectedProduct.name;
              document.getElementById('addLinePrice').value = selectedProduct.price;
              formDiv.style.display = '';
              resultsDiv.innerHTML = '';
              searchInput.value = selectedProduct.name;
              saveBtn.disabled = false;
            });
          });
        } catch (err) {
          resultsDiv.innerHTML = '<div class="billing-hint">Search failed</div>';
        }
      }, 300);
    });

    // Save
    saveBtn.addEventListener('click', async () => {
      if (!selectedProduct) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Adding...';

      try {
        const qty = parseFloat(document.getElementById('addLineQty').value) || 1;
        const price = parseFloat(document.getElementById('addLinePrice').value) || 0;
        const desc = document.getElementById('addLineDesc').value || '';

        await OdooAPI.addSaleLine(data.sale_order.id, selectedProduct.id, qty, price, desc);
        App.showToast('Line added', 'success');
        OdooAPI.postSystemNote(job.id, `Billing: Line added — ${selectedProduct.name} × ${qty} @ $${parseFloat(price).toFixed(2)}`).catch(() => {});
        close();
        await this.renderSalesTab(job, parentContainer);
      } catch (err) {
        App.showToast('Failed: ' + err.message, 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Add';
      }
    });
  },

  // ========== VARIANCE REASON MODAL ==========

  _showVarianceReasonModal(job, data, varianceLines, parentContainer) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    let tableRows = varianceLines.map(l => `
      <tr>
        <td style="padding:6px;">${this._esc(l.product_name)}</td>
        <td style="padding:6px;text-align:center;">${l.quantity}</td>
        <td style="padding:6px;text-align:center;">${l.qty_delivered}</td>
      </tr>
    `).join('');

    overlay.innerHTML = `
      <div class="modal" style="max-width:400px;">
        <div class="modal-header">
          <h3>Variance Note</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <p style="font-size:var(--font-size-small);color:var(--text-secondary);margin-bottom:var(--spacing-sm);">
            The following lines have different delivered vs ordered quantities:
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:var(--font-size-small);margin-bottom:var(--spacing-md);">
            <tr style="background:var(--border-color);">
              <th style="padding:6px;text-align:left;">Product</th>
              <th style="padding:6px;text-align:center;">Ordered</th>
              <th style="padding:6px;text-align:center;">Delivered</th>
            </tr>
            ${tableRows}
          </table>
          <div class="form-group">
            <label for="varianceReason">Reason for variance</label>
            <textarea class="form-input" id="varianceReason" rows="3"
                      placeholder="Explain why delivered quantities differ..."></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="varianceSkip">Skip</button>
          <button class="btn btn-primary" id="varianceSubmit">Submit</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => {
      overlay.remove();
      this.renderSalesTab(job, parentContainer);
    };

    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('varianceSkip').addEventListener('click', close);

    document.getElementById('varianceSubmit').addEventListener('click', async () => {
      const submitBtn = document.getElementById('varianceSubmit');
      const reason = document.getElementById('varianceReason').value.trim();

      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';

      try {
        const details = varianceLines.map(l => ({
          product_name: l.product_name,
          ordered: l.quantity,
          delivered: l.qty_delivered,
          reason: reason,
        }));
        await OdooAPI.postVarianceNote(data.sale_order.id, details);
        App.showToast('Variance note posted', 'success');
        overlay.remove();
        await this.renderSalesTab(job, parentContainer);
      } catch (err) {
        App.showToast('Failed: ' + err.message, 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit';
      }
    });
  },

  // ========== STATE 3: INVOICE (UNPAID) VIEW ==========

  _renderInvoiceView(job, data, invoice, container) {
    const contact = data.contact || {};
    const phone = contact.mobile || contact.phone || '';

    let html = `
      <div class="detail-section">
        <div class="billing-so-header">
          <h3>${this._esc(data.sale_order.name)}</h3>
        </div>
      </div>

      <div class="detail-section">
        <div class="invoice-status unpaid">
          <div class="invoice-status-info">
            <div class="invoice-status-name">${this._esc(invoice.name)}</div>
            <div class="invoice-status-amount">Amount Due: <strong>$${this._money(invoice.amount_residual)}</strong></div>
            <div class="invoice-status-state">Status: Posted (Unpaid)</div>
          </div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Collect Payment</h3>
        <div class="billing-payment-methods" id="paymentMethods">
          <button class="billing-payment-method-btn" data-method="cash">
            <div style="font-size:24px;">&#128181;</div>
            <div>Cash</div>
          </button>
          <button class="billing-payment-method-btn" data-method="check">
            <div style="font-size:24px;">&#128221;</div>
            <div>Check</div>
          </button>
          <button class="billing-payment-method-btn" data-method="venmo">
            <div style="font-size:24px;">&#128178;</div>
            <div>Venmo/Zelle</div>
          </button>
          <button class="billing-payment-method-btn" data-method="card">
            <div style="font-size:24px;">&#128179;</div>
            <div>Card</div>
          </button>
          <button class="billing-payment-method-btn" data-method="sms">
            <div style="font-size:24px;">&#128172;</div>
            <div>Send Link</div>
          </button>
        </div>
        <div id="paymentMethodContent"></div>
      </div>

      <div class="billing-actions">
        <button class="btn btn-outline btn-block btn-sm" id="emailInvoiceBtn"
                ${!contact.email ? 'disabled title="No email on file"' : ''}>
          Email Invoice
        </button>
        <a href="${CONFIG.ODOO_URL}/report/pdf/account.report_invoice/${invoice.id}"
           target="_blank" rel="noopener" class="btn btn-outline btn-block btn-sm">
          View Invoice PDF
        </a>
      </div>

      <div id="paymentStatusArea"></div>

      ${invoice.payment_state === 'not_paid' ? `
      <div class="detail-section">
        <button class="btn btn-outline btn-block btn-sm" id="voidInvoiceBtn"
                style="color:var(--danger-color);border-color:var(--danger-color);">
          Void Invoice &amp; Return to Edit
        </button>
      </div>
      ` : ''}
    `;

    container.innerHTML = html;
    this._bindPaymentMethodEvents(job, data, invoice, phone, container);

    // Void Invoice button
    const voidBtn = container.querySelector('#voidInvoiceBtn');
    if (voidBtn) {
      voidBtn.addEventListener('click', async () => {
        if (!confirm('Void this invoice? The sales order will return to editable state.')) return;
        voidBtn.disabled = true;
        voidBtn.textContent = 'Voiding...';
        try {
          await OdooAPI.cancelInvoice(invoice.id);
          App.showToast('Invoice voided — sales order is editable again', 'success');
          OdooAPI.postJournalEntry(job.id, `Invoice ${invoice.name} voided`).catch(() => {});
          await this.renderSalesTab(job, container);
        } catch (err) {
          App.showToast('Failed: ' + err.message, 'error');
          voidBtn.disabled = false;
          voidBtn.textContent = 'Void Invoice & Return to Edit';
        }
      });
    }

    // Email Invoice via Odoo mail server
    const emailInvoiceBtn = container.querySelector('#emailInvoiceBtn');
    if (emailInvoiceBtn && contact.email) {
      emailInvoiceBtn.addEventListener('click', async () => {
        emailInvoiceBtn.disabled = true;
        emailInvoiceBtn.textContent = 'Sending...';
        try {
          await OdooAPI.sendDocument(invoice.id, 'invoice', 'email', contact.email);
          App.showToast('Invoice emailed to ' + contact.email, 'success');
          OdooAPI.postJournalEntry(job.id, `Invoice emailed to ${contact.email}`).catch(() => {});
          emailInvoiceBtn.textContent = 'Email Invoice';
        } catch (err) {
          App.showToast('Failed to send email', 'error');
          emailInvoiceBtn.textContent = 'Email Invoice';
        }
        emailInvoiceBtn.disabled = false;
      });
    }
  },

  _bindPaymentMethodEvents(job, data, invoice, phone, container) {
    const methodBtns = container.querySelectorAll('.billing-payment-method-btn');
    const contentArea = document.getElementById('paymentMethodContent');

    methodBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        // Highlight active
        methodBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const method = btn.dataset.method;
        switch (method) {
          case 'cash':
            this._showCashPaymentView(invoice, contentArea, job, container);
            break;
          case 'check':
            this._showCheckPaymentView(invoice, contentArea, job, container);
            break;
          case 'venmo':
            this._showVenmoZellePaymentView(invoice, contentArea, job, container);
            break;
          case 'card':
            this._showCardPaymentView(invoice, phone, contentArea, job, container);
            break;
          case 'sms':
            this._showSmsPaymentView(invoice, phone, contentArea, job, container);
            break;
        }
      });
    });
  },

  // ---------- Cash Payment ----------

  _showCashPaymentView(invoice, contentArea, job, parentContainer) {
    contentArea.innerHTML = `
      <div style="margin-top:var(--spacing-md);">
        <div class="form-group">
          <label for="cashAmount">Amount ($${this._money(invoice.amount_residual)} due)</label>
          <input type="number" class="form-input" id="cashAmount"
                 value="${invoice.amount_residual}" min="0" step="0.01">
        </div>
        <button class="btn btn-success btn-block" id="recordCashBtn">
          Record Cash Payment
        </button>
      </div>
    `;

    document.getElementById('recordCashBtn').addEventListener('click', async () => {
      const btn = document.getElementById('recordCashBtn');
      const amount = parseFloat(document.getElementById('cashAmount').value) || 0;

      if (amount <= 0) {
        App.showToast('Enter a valid amount', 'error');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Recording...';

      try {
        const result = await OdooAPI.registerManualPayment(invoice.id, 'Cash', '', amount);
        if (result.success) {
          App.showToast('Cash payment recorded', 'success');
          OdooAPI.postJournalEntry(job.id, `Payment collected: Cash, $${amount.toFixed(2)}`).catch(() => {});
          await this.renderSalesTab(job, parentContainer);
        }
      } catch (err) {
        App.showToast('Failed: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Record Cash Payment';
      }
    });
  },

  // ---------- Check Payment ----------

  _showCheckPaymentView(invoice, contentArea, job, parentContainer) {
    const todayStr = new Date().toISOString().slice(0, 10);

    contentArea.innerHTML = `
      <div style="margin-top:var(--spacing-md);">
        <div class="form-group">
          <label for="checkNumber">Check Number</label>
          <input type="text" class="form-input" id="checkNumber" placeholder="e.g. 1234">
        </div>
        <div class="form-group">
          <label for="checkAmount">Amount ($${this._money(invoice.amount_residual)} due)</label>
          <input type="number" class="form-input" id="checkAmount"
                 value="${invoice.amount_residual}" min="0" step="0.01">
        </div>
        <div class="form-group">
          <label for="checkDate">Check Date</label>
          <input type="date" class="form-input" id="checkDate" value="${todayStr}">
        </div>
        <button class="btn btn-success btn-block" id="recordCheckBtn">
          Record Check Payment
        </button>
      </div>
    `;

    document.getElementById('recordCheckBtn').addEventListener('click', async () => {
      const btn = document.getElementById('recordCheckBtn');
      const checkNum = document.getElementById('checkNumber').value.trim();
      const amount = parseFloat(document.getElementById('checkAmount').value) || 0;
      const checkDate = document.getElementById('checkDate').value || todayStr;

      if (!checkNum) {
        App.showToast('Enter a check number', 'error');
        return;
      }
      if (amount <= 0) {
        App.showToast('Enter a valid amount', 'error');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Recording...';

      try {
        const result = await OdooAPI.registerCheckPayment(invoice.id, checkNum, amount, checkDate);
        if (result.success) {
          App.showToast('Check payment recorded', 'success');
          OdooAPI.postJournalEntry(job.id, `Payment collected: Check #${checkNum}, $${parseFloat(amount).toFixed(2)}, date ${checkDate}`).catch(() => {});
          await this.renderSalesTab(job, parentContainer);
        }
      } catch (err) {
        App.showToast('Failed: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Record Check Payment';
      }
    });
  },

  // ---------- Venmo / Zelle Payment ----------

  _showVenmoZellePaymentView(invoice, contentArea, job, parentContainer) {
    const venmoUser = CONFIG.VENMO_USERNAME || '@OasisPoolTile';
    const zelleUser = CONFIG.ZELLE_USERNAME || '';
    const venmoQr = localStorage.getItem('pwa_venmo_qr');
    const zelleQr = localStorage.getItem('pwa_zelle_qr');

    contentArea.innerHTML = `
      <div style="margin-top:var(--spacing-md);">
        <div style="font-size:var(--font-size-base);font-weight:600;text-align:center;margin-bottom:var(--spacing-md);">
          Amount Due: $${this._money(invoice.amount_residual)}
        </div>

        ${this._payQrSection('Venmo', venmoUser, venmoQr, 'venmo', '#3d95ce', 'confirmVenmoBtn')}

        ${this._payQrSection('Zelle', zelleUser, zelleQr, 'zelle', '#6d1ed4', 'confirmZelleBtn')}
      </div>
    `;

    this._bindManualPayConfirm('confirmVenmoBtn', 'Venmo', venmoUser, invoice, job, parentContainer);
    this._bindManualPayConfirm('confirmZelleBtn', 'Zelle', zelleUser, invoice, job, parentContainer);
  },

  /** Build one QR/username card for a Venmo or Zelle payment method. */
  _payQrSection(label, username, qrData, key, color, btnId) {
    const qrHtml = qrData
      ? `<img src="${qrData}" alt="${this._esc(label)}" style="width:100%;border-radius:8px;">`
      : `<div style="font-size:64px;">&#128178;</div>
         ${username ? `<div class="billing-pay-username" style="color:${color};">${this._esc(username)}</div>` : ''}`;
    return `
      <div class="billing-pay-method" style="text-align:center;margin-bottom:var(--spacing-lg);">
        <div class="billing-pay-method-label" style="color:${color};">${this._esc(label)}</div>
        <div style="margin:var(--spacing-sm) 0;">
          <div class="billing-pay-qr">
            ${qrHtml}
          </div>
        </div>
        <button class="btn btn-success btn-block" id="${btnId}">
          ${this._esc(label)} Received - Confirm
        </button>
      </div>
    `;
  },

  /** Wire a confirm button that registers a manual Venmo/Zelle payment. */
  _bindManualPayConfirm(btnId, method, username, invoice, job, parentContainer) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const label = `${method} Received - Confirm`;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Confirming...';

      try {
        const result = await OdooAPI.registerManualPayment(
          invoice.id, method, username, invoice.amount_residual
        );
        if (result.success) {
          App.showToast(`${method} payment confirmed`, 'success');
          OdooAPI.postJournalEntry(job.id, `Payment collected: ${method}${username ? ` (${username})` : ''}, $${parseFloat(invoice.amount_residual).toFixed(2)}`).catch(() => {});
          await this.renderSalesTab(job, parentContainer);
        }
      } catch (err) {
        App.showToast('Failed: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  },

  // ---------- Card Payment ----------

  _showCardPaymentView(invoice, phone, contentArea, job, parentContainer) {
    contentArea.innerHTML = `
      <div style="margin-top:var(--spacing-md);text-align:center;">
        <div style="font-size:var(--font-size-base);font-weight:600;margin-bottom:var(--spacing-md);">
          Amount Due: $${this._money(invoice.amount_residual)}
        </div>
        <p style="font-size:var(--font-size-small);color:var(--text-secondary);margin-bottom:var(--spacing-md);">
          Opens Stripe's secure checkout page for the customer to enter their card.
        </p>
        <button class="btn btn-success btn-block btn-lg" id="collectCardBtn">
          Collect Card Payment
        </button>
      </div>
    `;

    document.getElementById('collectCardBtn').addEventListener('click', async () => {
      const btn = document.getElementById('collectCardBtn');
      btn.disabled = true;
      btn.textContent = 'Opening checkout...';

      try {
        const linkData = await OdooAPI.getPaymentLink(invoice.id);
        if (linkData.already_paid) {
          App.showToast('Invoice already paid', 'info');
          await this.renderSalesTab(job, parentContainer);
          return;
        }
        if (linkData.url) {
          window.open(linkData.url, '_blank');
          // Start polling for payment completion
          this._startPaymentPolling(job, invoice.id, parentContainer, invoice.amount_residual);
          btn.disabled = false;
          btn.textContent = 'Collect Card Payment';
        }
      } catch (err) {
        App.showToast('Failed: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Collect Card Payment';
      }
    });
  },

  // ---------- SMS Send Link ----------

  _showSmsPaymentView(invoice, phone, contentArea, job, parentContainer) {
    contentArea.innerHTML = `
      <div style="margin-top:var(--spacing-md);">
        <div class="billing-sms-input">
          <div class="form-group">
            <label for="smsPaymentPhone">Send payment link to:</label>
            <div class="billing-phone-row">
              <input type="tel" class="form-input" id="smsPaymentPhone"
                     value="${this._esc(phone)}" placeholder="(555) 123-4567">
              <button class="btn btn-primary" id="sendSmsPaymentBtn">Send SMS</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('sendSmsPaymentBtn').addEventListener('click', async () => {
      const btn = document.getElementById('sendSmsPaymentBtn');
      const phoneVal = document.getElementById('smsPaymentPhone').value.trim();
      if (!phoneVal) {
        App.showToast('Enter a phone number', 'error');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Sending...';

      try {
        const customerName = Array.isArray(job.location_id) ? job.location_id[1] : '';
        const companyName = Array.isArray(job.company_id) ? job.company_id[1] : '';
        const smsBody = renderSmsTemplate('SMS_TEMPLATE_PAYMENT', {
          customer_name: customerName,
          customer_first_name: customerName.split(' ')[0],
          amount: this._money(invoice.amount_total),
          payment_link: '{payment_link}',
          company_name: companyName,
        });
        const result = await OdooAPI.sendPaymentSms(invoice.id, phoneVal, smsBody);
        if (result.success) {
          App.showToast('Payment link sent', 'success');
          OdooAPI.postJournalEntry(job.id, 'SMS sent to ' + phoneVal + ': ' + smsBody);
          warnIfSmsMirrorFailed(result);
          this._startPaymentPolling(job, invoice.id, parentContainer, invoice.amount_residual);
        } else {
          App.showToast(result.error || 'Failed to send', 'error');
        }
      } catch (err) {
        App.showToast('Failed: ' + err.message, 'error');
      }

      btn.disabled = false;
      btn.textContent = 'Send SMS';
    });
  },

  // ========== STATE 4: PAID VIEW ==========

  _renderPaidView(job, data, invoice, container) {
    const contact = data.contact || {};
    const phone = contact.mobile || contact.phone || '';

    let html = `
      <div class="detail-section">
        <div class="billing-so-header">
          <h3>${this._esc(data.sale_order.name)}</h3>
        </div>
      </div>

      <div class="detail-section">
        <div class="invoice-status paid">
          <div class="invoice-status-info">
            <div class="invoice-status-name">${this._esc(invoice.name)}</div>
            <div class="invoice-status-amount">Amount: <strong>$${this._money(invoice.amount_total)}</strong></div>
            <div class="invoice-status-state">Status: Paid</div>
          </div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Send Receipt</h3>
        <div class="billing-actions">
          <button class="btn btn-primary btn-block" id="sendReceiptSmsBtn"
                  data-invoice-id="${invoice.id}" data-phone="${this._esc(phone)}">
            Send Receipt via SMS
          </button>
          <button class="btn btn-outline btn-block" id="sendReceiptEmailBtn"
                  data-invoice-id="${invoice.id}" data-email="${this._esc(contact.email)}">
            Email Receipt
          </button>
          <a href="${CONFIG.ODOO_URL}/report/pdf/account.report_invoice/${invoice.id}"
             target="_blank" rel="noopener" class="btn btn-outline btn-block btn-sm">
            View Receipt PDF
          </a>
        </div>
      </div>
    `;

    container.innerHTML = html;
    this._bindPaidEvents(job, data, invoice, container);
  },

  _bindPaidEvents(job, data, invoice, container) {
    const smsBtn = document.getElementById('sendReceiptSmsBtn');
    if (smsBtn) {
      smsBtn.addEventListener('click', async () => {
        const phone = smsBtn.dataset.phone;
        if (!phone) {
          App.showToast('No phone number on file', 'error');
          return;
        }
        smsBtn.disabled = true;
        smsBtn.textContent = 'Sending...';
        try {
          const customerName = Array.isArray(job.location_id) ? job.location_id[1] : '';
          const companyName = Array.isArray(job.company_id) ? job.company_id[1] : '';
          const smsBody = renderSmsTemplate('SMS_TEMPLATE_RECEIPT', {
            customer_name: customerName,
          customer_first_name: customerName.split(' ')[0],
            amount: this._money(invoice.amount_total),
            receipt_link: '{receipt_link}',
            company_name: companyName,
          });
          const response = await OdooAPI.sendDocument(invoice.id, 'receipt', 'sms', phone, smsBody);
          App.showToast('Receipt sent via SMS', 'success');
          OdooAPI.postJournalEntry(job.id, 'SMS sent to ' + phone + ': ' + smsBody);
          warnIfSmsMirrorFailed(response);
        } catch (err) {
          App.showToast('Failed: ' + err.message, 'error');
        }
        smsBtn.disabled = false;
        smsBtn.textContent = 'Send Receipt via SMS';
      });
    }

    const emailBtn = document.getElementById('sendReceiptEmailBtn');
    if (emailBtn) {
      emailBtn.addEventListener('click', async () => {
        const email = emailBtn.dataset.email;
        if (!email) {
          App.showToast('No email on file', 'error');
          return;
        }
        emailBtn.disabled = true;
        emailBtn.textContent = 'Sending...';
        try {
          await OdooAPI.sendDocument(invoice.id, 'receipt', 'email', email);
          App.showToast('Receipt sent via email', 'success');
          OdooAPI.postJournalEntry(job.id, `Receipt emailed to ${email}`).catch(() => {});
        } catch (err) {
          App.showToast('Failed: ' + err.message, 'error');
        }
        emailBtn.disabled = false;
        emailBtn.textContent = 'Email Receipt';
      });
    }
  },

  // ========== PAYMENT STATUS POLLING ==========

  _startPaymentPolling(job, invoiceId, container, invoiceAmount) {
    this._stopPolling();

    const statusArea = document.getElementById('paymentStatusArea');
    if (statusArea) {
      statusArea.innerHTML = `
        <div class="detail-section">
          <div class="billing-polling">
            <div class="spinner" style="width:20px;height:20px;"></div>
            <span>Waiting for payment...</span>
          </div>
        </div>
      `;
    }

    this._pollTimer = setInterval(async () => {
      try {
        const status = await OdooAPI.checkInvoiceStatus(invoiceId);
        if (status.payment_state === 'paid' || status.payment_state === 'in_payment') {
          this._stopPolling();
          App.showToast('Payment received!', 'success');
          const amtStr = invoiceAmount ? `$${parseFloat(invoiceAmount).toFixed(2)}` : '';
          OdooAPI.postJournalEntry(job.id, `Payment collected: Card${amtStr ? ', ' + amtStr : ''}`).catch(() => {});
          await this.renderSalesTab(job, container);
        }
      } catch (err) {
        console.warn('Payment poll failed:', err);
      }
    }, 15000);

    // Stop after 10 minutes
    this._pollTimeout = setTimeout(() => {
      this._stopPolling();
      if (statusArea) {
        statusArea.innerHTML = `
          <div class="detail-section">
            <div class="billing-hint">Payment monitoring timed out. Pull to refresh to check status.</div>
          </div>
        `;
      }
    }, 600000);
  },

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._pollTimeout) {
      clearTimeout(this._pollTimeout);
      this._pollTimeout = null;
    }
  },

  // ========== CHANGE ORDER MODAL ==========

  _showChangeOrderModal(job, data, onSiteLines, parentContainer) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    let linesHtml = onSiteLines.map(l => `
      <div style="display:flex;justify-content:space-between;padding:var(--spacing-xs) 0;border-bottom:1px solid var(--border-color);">
        <div>
          <div style="font-weight:500;">${this._esc(l.product_name)}</div>
          <div style="font-size:var(--font-size-xs);color:var(--text-muted);">
            ${l.quantity} × $${this._money(l.price_unit)}
          </div>
        </div>
        <div style="font-weight:600;">$${this._money(l.price_subtotal)}</div>
      </div>
    `).join('');

    const totalAmount = onSiteLines.reduce((s, l) => s + l.price_subtotal, 0);

    overlay.innerHTML = `
      <div class="modal" style="max-width:440px;max-height:90vh;display:flex;flex-direction:column;">
        <div class="modal-header">
          <h3>Create Change Order</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body" style="overflow-y:auto;-webkit-overflow-scrolling:touch;">
          <div style="margin-bottom:var(--spacing-md);">
            <div style="font-size:var(--font-size-small);font-weight:600;margin-bottom:var(--spacing-xs);">
              On-Site Additions
            </div>
            ${linesHtml}
            <div style="display:flex;justify-content:space-between;padding:var(--spacing-sm) 0;font-weight:700;">
              <div>Total</div>
              <div>$${this._money(totalAmount)}</div>
            </div>
          </div>

          <div class="form-group">
            <label for="coReason">Reason for Change Order</label>
            <textarea class="form-input" id="coReason" rows="3"
                      placeholder="Describe why additional work was needed..."></textarea>
          </div>

          <div class="form-group">
            <label>Customer Signature</label>
            <div class="billing-signature-container">
              <canvas id="signatureCanvas" class="billing-signature-canvas"></canvas>
              <button class="billing-signature-clear" id="clearSignature">Clear</button>
            </div>
          </div>

          <div class="form-group">
            <label for="signedByName">Printed Name</label>
            <input type="text" class="form-input" id="signedByName" placeholder="Customer's name">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="coCancel">Cancel</button>
          <button class="btn btn-warning" id="coSubmit">Create Change Order</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('coCancel').addEventListener('click', close);

    // Initialize signature pad
    const sigPad = this._renderSignaturePad('signatureCanvas');
    document.getElementById('clearSignature').addEventListener('click', () => sigPad.clear());

    // Submit
    document.getElementById('coSubmit').addEventListener('click', async () => {
      const btn = document.getElementById('coSubmit');
      const reason = document.getElementById('coReason').value.trim();
      const signedBy = document.getElementById('signedByName').value.trim();

      if (!reason) {
        App.showToast('Enter a reason for the change order', 'error');
        return;
      }
      if (sigPad.isEmpty()) {
        App.showToast('Customer signature required', 'error');
        return;
      }
      if (!signedBy) {
        App.showToast('Enter the customer\'s printed name', 'error');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Creating...';

      try {
        const lines = onSiteLines.map(l => ({
          product_id: l.product_id,
          qty: l.quantity,
          price: l.price_unit,
          description: l.description,
        }));

        const sigBase64 = sigPad.toBase64();

        const result = await OdooAPI.createChangeOrder(
          job.id, lines, reason, sigBase64, signedBy
        );

        if (result.success) {
          App.showToast(`Change order ${result.change_order_name} created`, 'success');
          OdooAPI.postJournalEntry(job.id, `Change order ${result.change_order_name} created. Reason: ${reason}. Signed by: ${signedBy}`).catch(() => {});
          close();
          await this.renderSalesTab(job, parentContainer);
        }
      } catch (err) {
        App.showToast('Failed: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Create Change Order';
      }
    });
  },

  // ========== SIGNATURE PAD ==========

  _renderSignaturePad(canvasId) {
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');

    // Scale for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    let drawing = false;
    let hasDrawn = false;
    let lastX = 0;
    let lastY = 0;

    const getPos = (e) => {
      const r = canvas.getBoundingClientRect();
      if (e.touches && e.touches.length > 0) {
        return { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top };
      }
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const start = (e) => {
      e.preventDefault();
      drawing = true;
      const pos = getPos(e);
      lastX = pos.x;
      lastY = pos.y;
    };

    const move = (e) => {
      if (!drawing) return;
      e.preventDefault();
      const pos = getPos(e);
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(pos.x, pos.y);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      lastX = pos.x;
      lastY = pos.y;
      hasDrawn = true;
    };

    const end = () => {
      drawing = false;
    };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    return {
      clear() {
        ctx.clearRect(0, 0, rect.width, rect.height);
        hasDrawn = false;
      },
      isEmpty() {
        return !hasDrawn;
      },
      toBase64() {
        // Return raw base64 without data URL prefix
        return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
      },
    };
  },

  // ========== PLACEHOLDER VIEWS ==========

  _noSalesOrder(job) {
    return `
      <div class="detail-section">
        <h3>Sales Order</h3>
        <p class="billing-hint">No sales order linked to this job.</p>
      </div>
    `;
  },

  _offlineMessage() {
    return `
      <div class="detail-section">
        <h3>Sales Order</h3>
        <p class="billing-hint">Sales data requires an internet connection.</p>
      </div>
    `;
  },

  _errorMessage(err) {
    return `
      <div class="detail-section">
        <h3>Sales Order</h3>
        <p class="billing-hint">Failed to load sales data: ${this._esc(err.message)}</p>
      </div>
    `;
  },

  // ========== HELPERS ==========

  _esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  },

  _money(val) {
    const num = parseFloat(val) || 0;
    return num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },
};
