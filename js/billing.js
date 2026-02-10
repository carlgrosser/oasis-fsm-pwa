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

    // Create Invoice button
    if (so.invoice_status === 'to invoice') {
      html += `
        <div class="detail-section">
          <button class="btn btn-success btn-block btn-lg" id="createInvoiceBtn">
            Create Invoice
          </button>
        </div>
      `;
    } else if (so.invoice_status === 'no') {
      html += `
        <div class="detail-section">
          <p class="billing-hint">Nothing to invoice yet. Deliver services to enable invoicing.</p>
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

    return `
      <div class="so-line" data-line-id="${line.id}">
        <div class="so-line-info">
          <div class="so-line-name">${this._esc(line.product_name || line.description)}</div>
          <div class="so-line-detail">
            ${line.quantity} ${this._esc(line.product_uom)} × $${this._money(line.price_unit)}
            ${line.discount ? ' (-' + line.discount + '%)' : ''}
          </div>
        </div>
        <div class="so-line-right">
          <div class="so-line-price">$${this._money(line.price_subtotal)}</div>
          ${editBtn}
        </div>
      </div>
    `;
  },

  _bindSOEvents(job, data, container) {
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
            // Reload the billing tab
            await this.renderSalesTab(job, container);
          }
        } catch (err) {
          App.showToast('Failed: ' + err.message, 'error');
          invoiceBtn.disabled = false;
          invoiceBtn.textContent = 'Create Invoice';
        }
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
              <label for="editLineQty">Quantity</label>
              <input type="number" class="form-input" id="editLineQty"
                     value="${line.quantity}" min="0" step="any">
            </div>
            <div class="form-group" style="flex:1;">
              <label for="editLinePrice">Unit Price</label>
              <input type="number" class="form-input" id="editLinePrice"
                     value="${line.price_unit}" min="0" step="0.01">
            </div>
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

      if (newQty !== line.quantity) values.quantity = newQty;
      if (newPrice !== line.price_unit) values.price_unit = newPrice;
      if (newDesc !== line.description) values.description = newDesc;

      if (Object.keys(values).length === 0) {
        close();
        return;
      }

      try {
        const result = await OdooAPI.updateSaleLine(line.id, values);
        App.showToast('Line updated', 'success');
        close();
        // Refresh
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
          const products = await OdooAPI.searchProducts(query);
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
        close();
        await this.renderSalesTab(job, parentContainer);
      } catch (err) {
        App.showToast('Failed: ' + err.message, 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Add';
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
        <div class="billing-sms-input" id="smsPhoneSection">
          <div class="form-group">
            <label for="paymentPhone">Send payment link to:</label>
            <div class="billing-phone-row">
              <input type="tel" class="form-input" id="paymentPhone"
                     value="${this._esc(phone)}" placeholder="(555) 123-4567">
              <button class="btn btn-primary" id="sendPaymentSmsBtn">Send SMS</button>
            </div>
          </div>
        </div>

        <div class="billing-actions">
          <a href="mailto:${this._esc(contact.email)}?subject=Invoice ${this._esc(invoice.name)}"
             class="btn btn-outline btn-block btn-sm">
            Email Invoice PDF
          </a>
          <a href="${CONFIG.ODOO_URL}/report/pdf/account.report_invoice/${invoice.id}"
             target="_blank" rel="noopener" class="btn btn-outline btn-block btn-sm">
            View Invoice PDF
          </a>
        </div>
      </div>

      <div id="paymentStatusArea"></div>
    `;

    container.innerHTML = html;
    this._bindInvoiceEvents(job, data, invoice, container);
  },

  _bindInvoiceEvents(job, data, invoice, container) {
    const sendBtn = document.getElementById('sendPaymentSmsBtn');
    if (sendBtn) {
      sendBtn.addEventListener('click', async () => {
        const phone = document.getElementById('paymentPhone').value.trim();
        if (!phone) {
          App.showToast('Enter a phone number', 'error');
          return;
        }

        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';

        try {
          const result = await OdooAPI.sendPaymentSms(invoice.id, phone);
          if (result.success) {
            App.showToast('Payment link sent', 'success');
            // Start polling for payment
            this._startPaymentPolling(job, invoice.id, container);
          } else {
            App.showToast(result.error || 'Failed to send', 'error');
          }
        } catch (err) {
          App.showToast('Failed: ' + err.message, 'error');
        }

        sendBtn.disabled = false;
        sendBtn.textContent = 'Send SMS';
      });
    }
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
          await OdooAPI.sendDocument(invoice.id, 'receipt', 'sms', phone);
          App.showToast('Receipt sent via SMS', 'success');
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
        } catch (err) {
          App.showToast('Failed: ' + err.message, 'error');
        }
        emailBtn.disabled = false;
        emailBtn.textContent = 'Email Receipt';
      });
    }
  },

  // ========== PAYMENT STATUS POLLING ==========

  _startPaymentPolling(job, invoiceId, container) {
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

  // ========== PLACEHOLDER VIEWS ==========

  _noSalesOrder(job) {
    const soLink = job.sale_id ? '' : '';
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
