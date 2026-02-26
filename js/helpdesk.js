/**
 * Helpdesk module — support tickets, QR scanner, and knowledge base access.
 *
 * Entry points:
 *   Helpdesk.startBadgePolling() — called on app init, polls ticket count every 5 min
 *   Helpdesk.showHelpMenu()      — opens the help menu modal
 */
const Helpdesk = {
  _pollTimer: null,
  _activeCount: 0,
  _POLL_INTERVAL: 5 * 60 * 1000, // 5 minutes

  // ========== BADGE POLLING ==========

  /**
   * Start background polling for active ticket count.
   */
  startBadgePolling() {
    this._pollOnce();
    this._pollTimer = setInterval(() => this._pollOnce(), this._POLL_INTERVAL);
  },

  async _pollOnce() {
    if (!navigator.onLine) return;
    try {
      const count = await OdooAPI.countMyHelpdeskTickets();
      this._activeCount = count;
      this._updateBadge(count);
    } catch {
      // Non-fatal — badge stays at last known value
    }
  },

  _updateBadge(count) {
    const badge = document.getElementById('helpBadge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  },

  // ========== HELP MENU MODAL ==========

  /**
   * Show the help menu with QR scanner, knowledge base, and tickets.
   */
  showHelpMenu() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const badgeHtml = this._activeCount > 0
      ? `<span class="help-menu-ticket-badge">${this._activeCount > 99 ? '99+' : this._activeCount}</span>`
      : '';

    overlay.innerHTML = `
      <div class="modal modal-help">
        <div class="modal-header">
          <h3>Help & Resources</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body help-menu-body">
          <button class="help-menu-card" id="helpQrBtn">
            <div class="help-menu-card-icon">📷</div>
            <div class="help-menu-card-label">Scan QR Code</div>
            <div class="help-menu-card-desc">Scan equipment QR codes to open documents</div>
          </button>
          <button class="help-menu-card" id="helpKbBtn">
            <div class="help-menu-card-icon">📚</div>
            <div class="help-menu-card-label">Knowledge Base</div>
            <div class="help-menu-card-desc">Open the operations knowledge database</div>
          </button>
          <button class="help-menu-card" id="helpTicketsBtn">
            <div class="help-menu-card-icon">🎫${badgeHtml}</div>
            <div class="help-menu-card-label">Support Tickets</div>
            <div class="help-menu-card-desc">View and create helpdesk tickets</div>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#helpQrBtn').addEventListener('click', () => {
      close();
      this._showQrScanner();
    });

    overlay.querySelector('#helpKbBtn').addEventListener('click', () => {
      close();
      window.open('https://ops.oasispooltilecleaning.com', '_blank', 'noopener');
    });

    overlay.querySelector('#helpTicketsBtn').addEventListener('click', () => {
      close();
      this._showTicketsModal();
    });
  },

  // ========== QR CODE SCANNER ==========

  _showQrScanner() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-qr">
        <div class="modal-header">
          <h3>Scan QR Code</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body qr-scanner-body">
          <div id="qrStatus" class="qr-status">Starting camera…</div>
          <div class="qr-viewfinder-wrapper">
            <video id="qrVideo" class="qr-video" autoplay muted playsinline></video>
            <div class="qr-viewfinder-frame"></div>
          </div>
          <p class="qr-hint">Point camera at a QR code on equipment</p>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    let stream = null;
    let scanning = false;

    const stop = () => {
      scanning = false;
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      }
      overlay.remove();
    };

    overlay.querySelector('.modal-close').addEventListener('click', stop);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) stop(); });

    const statusEl = overlay.querySelector('#qrStatus');
    const video = overlay.querySelector('#qrVideo');

    if (!('BarcodeDetector' in window)) {
      statusEl.textContent = 'QR scanning is not supported on this browser. Try Chrome on Android.';
      statusEl.style.color = 'var(--error-color)';
      return;
    }

    const detector = new BarcodeDetector({ formats: ['qr_code'] });

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(s => {
        stream = s;
        video.srcObject = stream;
        video.play();
        statusEl.textContent = 'Scanning…';
        scanning = true;

        const scan = async () => {
          if (!scanning) return;
          try {
            const barcodes = await detector.detect(video);
            if (barcodes.length > 0) {
              const value = barcodes[0].rawValue;
              stop();
              if (/^https?:\/\//i.test(value)) {
                window.open(value, '_blank', 'noopener');
              } else {
                App.showToast('QR: ' + value, 'info');
              }
              return;
            }
          } catch { /* detection error on a frame — continue */ }
          if (scanning) requestAnimationFrame(scan);
        };

        requestAnimationFrame(scan);
      })
      .catch(err => {
        statusEl.textContent = 'Camera access denied. Please allow camera permission.';
        statusEl.style.color = 'var(--error-color)';
        console.warn('QR camera error:', err);
      });
  },

  // ========== HELPDESK TICKETS MODAL ==========

  _showTicketsModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-helpdesk">
        <div class="modal-header">
          <h3>Support Tickets</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-tabs">
          <button class="modal-tab active" data-modal-tab="list">My Tickets</button>
          <button class="modal-tab" data-modal-tab="create">+ New Ticket</button>
        </div>
        <div class="modal-body" style="padding:0;">
          <div class="modal-tab-content active" data-modal-content="list" id="ticketListPanel">
            <div class="loading"><div class="spinner"></div></div>
          </div>
          <div class="modal-tab-content" data-modal-content="create" id="ticketCreatePanel">
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    // Tab switching
    const tabs = overlay.querySelectorAll('.modal-tab');
    const contents = overlay.querySelectorAll('.modal-tab-content');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.modalTab;
        tabs.forEach(t => t.classList.toggle('active', t.dataset.modalTab === target));
        contents.forEach(c => c.classList.toggle('active', c.dataset.modalContent === target));
        if (target === 'create') this._renderCreateForm(overlay.querySelector('#ticketCreatePanel'), overlay);
      });
    });

    // Load ticket list immediately
    this._renderTicketList(overlay.querySelector('#ticketListPanel'));
  },

  async _renderTicketList(container) {
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const tickets = await OdooAPI.getMyHelpdeskTickets();
      this._activeCount = tickets.length;
      this._updateBadge(tickets.length);

      if (tickets.length === 0) {
        container.innerHTML = `
          <div class="empty-state" style="padding:var(--spacing-xl);">
            <div style="font-size:40px;opacity:0.3;">🎫</div>
            <p>No open tickets assigned to you.</p>
          </div>`;
        return;
      }

      // Group by team, preserving first-seen order
      const groups = {};
      const groupOrder = [];
      tickets.forEach(t => {
        const teamName = Array.isArray(t.team_id) ? t.team_id[1] : (t.team_id || 'No Team');
        if (!groups[teamName]) {
          groups[teamName] = [];
          groupOrder.push(teamName);
        }
        groups[teamName].push(t);
      });

      let html = '';
      groupOrder.forEach(teamName => {
        html += `<div class="helpdesk-team-header">${this._esc(teamName)}</div>`;
        groups[teamName].forEach(t => {
          const stage = Array.isArray(t.stage_id) ? t.stage_id[1] : (t.stage_id || 'Unknown');
          const priority = t.priority === '1' ? '⬆️' : t.priority === '2' ? '🔴' : '';
          const date = t.create_date
            ? new Date(t.create_date.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            : '';
          html += `
            <div class="helpdesk-ticket-row" data-ticket-id="${t.id}">
              <div class="helpdesk-ticket-title">${priority ? priority + ' ' : ''}${this._esc(t.name)}</div>
              <div class="helpdesk-ticket-meta">
                <span class="helpdesk-stage">${this._esc(stage)}</span>
                <span class="helpdesk-date">${date}</span>
              </div>
            </div>`;
        });
      });

      container.innerHTML = `<div class="helpdesk-ticket-list">${html}</div>`;

      // Open ticket in Odoo on click
      container.querySelectorAll('.helpdesk-ticket-row').forEach(row => {
        row.addEventListener('click', () => this._openTicket(row.dataset.ticketId));
      });
    } catch (err) {
      container.innerHTML = `<p style="padding:var(--spacing-md);color:var(--error-color);">Failed to load tickets. ${navigator.onLine ? '' : 'No network.'}</p>`;
    }
  },

  _openTicket(ticketId) {
    const base = CONFIG.ODOO_URL || window.location.origin;
    const url = `${base}/web#model=helpdesk.ticket&id=${ticketId}&view_type=form`;
    window.open(url, '_blank', 'noopener');
  },

  _renderCreateForm(container, modalOverlay) {
    if (container.dataset.rendered) return;
    container.dataset.rendered = '1';

    container.innerHTML = `
      <div style="padding:var(--spacing-md);">
        <div class="form-group">
          <label class="form-label">Subject <span style="color:var(--error-color)">*</span></label>
          <input type="text" id="ticketSubject" class="form-input" placeholder="Briefly describe the issue" maxlength="160">
        </div>
        <div class="form-group">
          <label class="form-label">Details</label>
          <textarea id="ticketDescription" class="form-input" rows="4"
            placeholder="Steps to reproduce, what you expected, what happened…"
            style="resize:vertical; min-height:80px;"></textarea>
        </div>
        <button class="btn btn-primary btn-block" id="ticketSubmitBtn">Submit Ticket</button>
        <div id="ticketFormStatus" style="margin-top:var(--spacing-sm);font-size:var(--font-size-small);"></div>
      </div>
    `;

    container.querySelector('#ticketSubmitBtn').addEventListener('click', async () => {
      const name = container.querySelector('#ticketSubject').value.trim();
      const description = container.querySelector('#ticketDescription').value.trim();
      const statusEl = container.querySelector('#ticketFormStatus');
      const btn = container.querySelector('#ticketSubmitBtn');

      if (!name) {
        statusEl.style.color = 'var(--error-color)';
        statusEl.textContent = 'Subject is required.';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Submitting…';
      statusEl.textContent = '';

      try {
        await OdooAPI.createHelpdeskTicket(name, description);
        statusEl.style.color = 'var(--success-color)';
        statusEl.textContent = '✓ Ticket submitted.';
        container.querySelector('#ticketSubject').value = '';
        container.querySelector('#ticketDescription').value = '';
        btn.textContent = 'Submit Another';
        btn.disabled = false;
        // Refresh badge and list
        this._pollOnce();
        // Switch back to list tab and refresh
        const listTab = modalOverlay && modalOverlay.querySelector('[data-modal-tab="list"]');
        if (listTab) {
          listTab.click();
          delete modalOverlay.querySelector('#ticketListPanel').dataset.rendered;
        }
      } catch (err) {
        statusEl.style.color = 'var(--error-color)';
        statusEl.textContent = 'Failed to submit. Try again.';
        btn.disabled = false;
        btn.textContent = 'Submit Ticket';
      }
    });
  },

  _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },
};
