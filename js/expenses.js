/**
 * Expenses module — receipt scanning, perspective crop, expense form, Odoo sync.
 */
const Expenses = {
  _fileInput: null,
  _pendingCapture: null,
  _categories: null, // null = not yet fetched

  // ===== ENTRY POINTS =====

  showReceiptMenu() {
    // Toggle: second tap closes the menu
    const existing = document.getElementById('expenseActionMenu');
    if (existing) { existing.remove(); return; }

    const receiptBtn = document.getElementById('receiptBtn');
    if (!receiptBtn) return;

    const menu = document.createElement('div');
    menu.id = 'expenseActionMenu';
    menu.className = 'expense-action-menu';
    menu.innerHTML = `
      <button class="expense-action-item" id="expMenuScan">
        <span class="expense-action-icon">📷</span>Scan Receipt
      </button>
      <button class="expense-action-item" id="expMenuNoReceipt">
        <span class="expense-action-icon">✏️</span>Add Without Receipt
      </button>
      <button class="expense-action-item" id="expMenuMileage">
        <span class="expense-action-icon">🚗</span>Log Mileage
      </button>
      <button class="expense-action-item" id="expMenuView">
        <span class="expense-action-icon">📋</span>View / Edit Expenses
      </button>`;
    document.body.appendChild(menu);

    // Position above the receipt button
    const btnRect = receiptBtn.getBoundingClientRect();
    menu.style.bottom = (window.innerHeight - btnRect.top + 10) + 'px';
    const left = Math.round(btnRect.left + btnRect.width / 2 - menu.offsetWidth / 2);
    menu.style.left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, left)) + 'px';

    const dismiss = (e) => {
      if (!menu.contains(e.target) && e.target !== receiptBtn) {
        menu.remove();
        document.removeEventListener('touchstart', dismiss, true);
        document.removeEventListener('click', dismiss, true);
      }
    };
    setTimeout(() => {
      document.addEventListener('touchstart', dismiss, { capture: true, passive: true });
      document.addEventListener('click', dismiss, true);
    }, 50);

    menu.querySelector('#expMenuScan').addEventListener('click', () => {
      menu.remove(); this.startReceiptScan();
    });
    menu.querySelector('#expMenuNoReceipt').addEventListener('click', () => {
      menu.remove(); this.startExpenseWithoutReceipt();
    });
    menu.querySelector('#expMenuMileage').addEventListener('click', () => {
      menu.remove(); this.startMileageExpense();
    });
    menu.querySelector('#expMenuView').addEventListener('click', () => {
      menu.remove(); this.showExpenseList();
    });
  },

  async startReceiptScan() {
    try {
      const imageDataUrl = await this._captureImage();
      if (!imageDataUrl) return;
      const croppedDataUrl = await this._showCropUI(imageDataUrl);
      if (!croppedDataUrl) return;
      await this._showExpenseForm([croppedDataUrl]);
    } catch (err) {
      console.error('Receipt scan error:', err);
      App.showToast('Receipt scan failed: ' + err.message, 'error');
    }
  },

  async startExpenseWithoutReceipt() {
    try {
      await this._showExpenseForm([]);
    } catch (err) {
      console.error('Expense form error:', err);
      App.showToast('Error: ' + err.message, 'error');
    }
  },

  async startMileageExpense() {
    try {
      await this._showMileageForm();
    } catch (err) {
      console.error('Mileage form error:', err);
      App.showToast('Error: ' + err.message, 'error');
    }
  },

  async showExpenseList() {
    let expenses = [];
    try { expenses = await DB.getAll('expensesQueue'); } catch { expenses = []; }
    expenses.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    const overlay = document.createElement('div');
    overlay.className = 'expense-overlay';
    overlay.innerHTML = `
      <div class="expense-form">
        <div class="expense-form-header">
          <button class="expense-close-btn" id="expListClose" type="button">✕</button>
          <span class="expense-form-title">My Expenses</span>
          <button class="btn btn-sm exp-sync-btn" id="expSyncNowBtn" type="button">⟳ Sync</button>
        </div>
        <div id="expSummaryBar"></div>
        <div class="expense-list-body expense-form-body"></div>
      </div>`;
    document.body.appendChild(overlay);

    const renderSummary = () => {
      const pending = expenses.filter(e => e.synced !== 1);
      const reimbursable = pending.filter(e => e.payment_mode === 'own_account');
      const total = reimbursable.reduce((s, e) => {
        const base = parseFloat(e.price_unit) || 0;
        const qty = e.expense_type === 'mileage' ? (parseFloat(e.quantity) || 1) : 1;
        return s + base * qty;
      }, 0);
      const bar = overlay.querySelector('#expSummaryBar');
      if (!pending.length) { bar.innerHTML = ''; return; }
      bar.innerHTML = `<div class="exp-summary-bar">
        <span>${pending.length} pending</span>
        ${total > 0 ? `<span>$${total.toFixed(2)} to be reimbursed</span>` : ''}
      </div>`;
    };

    const renderList = () => {
      renderSummary();
      const body = overlay.querySelector('.expense-list-body');
      if (!expenses.length) {
        body.innerHTML = '<p class="expense-hint" style="text-align:center;padding:var(--spacing-xl) var(--spacing-md);">No expenses recorded yet.</p>';
        return;
      }

      body.innerHTML = expenses.map((exp, i) => {
        const synced = exp.synced === 1;
        const isMileage = exp.expense_type === 'mileage';
        let amount = '';
        if (exp.price_unit != null) {
          const base = parseFloat(exp.price_unit);
          const qty = isMileage ? (parseFloat(exp.quantity) || 1) : 1;
          amount = `$${(base * qty).toFixed(2)}`;
        }
        const payLabel = exp.payment_mode === 'own_account'
          ? 'Out of Pocket' : (exp.journal_label || 'Company Account');
        const statusHtml = synced
          ? '<span class="exp-list-badge exp-list-synced">✓ Synced</span>'
          : '<span class="exp-list-badge exp-list-pending">⏳ Pending</span>';
        // Multi-receipt: check receipt_images first, fall back to receipt_b64
        const thumbSrc = (exp.receipt_images && exp.receipt_images.length)
          ? exp.receipt_images[0]
          : (exp.receipt_b64 || null);
        const thumbHtml = thumbSrc
          ? `<img class="exp-list-thumb" src="${thumbSrc}" alt="Receipt">`
          : `<div class="exp-list-thumb exp-list-thumb-none">${isMileage ? '🚗' : '🧾'}</div>`;
        return `
          <div class="exp-list-item${!synced ? ' exp-list-swipeable' : ''}" data-idx="${i}">
            <div class="exp-list-thumb-wrap" data-idx="${i}">${thumbHtml}</div>
            <div class="exp-list-info${!synced ? ' exp-list-info-tap' : ''}" data-idx="${i}">
              <div class="exp-list-name">${this._escHtml(exp.name || 'Expense')}</div>
              <div class="exp-list-meta">${this._escHtml(exp.date || '')}${exp.date ? ' · ' : ''}${this._escHtml(payLabel)}</div>
              <div class="exp-list-row2">${statusHtml}${amount ? `<span class="exp-list-amount">${amount}</span>` : ''}</div>
            </div>
            ${!synced
              ? `<button class="exp-list-delete" data-idx="${i}" type="button" aria-label="Delete">🗑</button>`
              : '<div style="min-width:36px;"></div>'}
          </div>`;
      }).join('');

      // Thumbnail tap-to-zoom
      body.querySelectorAll('.exp-list-thumb[src]').forEach(img => {
        img.style.cursor = 'zoom-in';
        img.addEventListener('click', () => this._showLightbox(img.src));
      });

      // Tap-to-edit pending items (tap the info area)
      body.querySelectorAll('.exp-list-info-tap').forEach(infoEl => {
        infoEl.addEventListener('click', async () => {
          const idx = parseInt(infoEl.dataset.idx, 10);
          const exp = expenses[idx];
          if (!exp || exp.synced === 1) return;
          overlay.remove();
          if (exp.expense_type === 'mileage') {
            await this._showMileageForm(exp);
          } else {
            const imgs = exp.receipt_images || (exp.receipt_b64 ? [exp.receipt_b64] : []);
            await this._showExpenseForm(imgs, exp);
          }
        });
      });

      // Delete buttons (confirm dialog)
      body.querySelectorAll('.exp-list-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          const idx = parseInt(btn.dataset.idx, 10);
          const exp = expenses[idx];
          if (!exp || !confirm(`Delete "${exp.name || 'expense'}"?`)) return;
          try {
            await DB.delete('expensesQueue', exp.temp_id);
            expenses.splice(idx, 1);
            renderList();
            if (typeof Sync !== 'undefined') Sync._updatePendingCount();
          } catch (err) {
            App.showToast('Could not delete: ' + err.message, 'error');
          }
        });
      });

      // Swipe-to-delete (left swipe past threshold)
      body.querySelectorAll('.exp-list-swipeable').forEach(itemEl => {
        let sx = 0, sy = 0, moved = false;
        itemEl.addEventListener('touchstart', e => {
          sx = e.touches[0].clientX;
          sy = e.touches[0].clientY;
          moved = false;
          itemEl.style.transition = 'none';
        }, { passive: true });
        itemEl.addEventListener('touchmove', e => {
          const dx = e.touches[0].clientX - sx;
          const dy = e.touches[0].clientY - sy;
          if (!moved && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) moved = true;
          if (moved && dx < 0) {
            itemEl.style.transform = `translateX(${Math.max(dx, -90)}px)`;
            e.preventDefault(); // prevent scroll while swiping left
          }
        }, { passive: false });
        itemEl.addEventListener('touchend', async e => {
          const dx = e.changedTouches[0].clientX - sx;
          itemEl.style.transition = 'transform 0.2s ease';
          if (moved) {
            if (dx < -70) {
              itemEl.style.transform = 'translateX(-100%)';
              const idx = parseInt(itemEl.dataset.idx, 10);
              setTimeout(async () => {
                const exp = expenses[idx];
                if (!exp) return;
                try {
                  await DB.delete('expensesQueue', exp.temp_id);
                  expenses.splice(idx, 1);
                  renderList();
                  if (typeof Sync !== 'undefined') Sync._updatePendingCount();
                } catch (err) {
                  App.showToast('Could not delete: ' + err.message, 'error');
                }
              }, 200);
            } else {
              itemEl.style.transform = '';
            }
            moved = false;
          }
        });
      });
    };

    renderList();

    overlay.querySelector('#expListClose').addEventListener('click', () => overlay.remove());

    overlay.querySelector('#expSyncNowBtn').addEventListener('click', async () => {
      if (!navigator.onLine) { App.showToast('No internet connection', 'error'); return; }
      const syncBtn = overlay.querySelector('#expSyncNowBtn');
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing…';
      try {
        const { synced, failed } = await this.syncAll();
        expenses = await DB.getAll('expensesQueue');
        expenses.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        renderList();
        if (typeof Sync !== 'undefined') Sync._updatePendingCount();
        if (failed > 0) App.showToast(`${failed} failed to sync`, 'error');
        else if (synced > 0) App.showToast(`${synced} synced`, 'success');
        else App.showToast('Nothing to sync', 'info');
      } catch (err) {
        App.showToast('Sync failed: ' + err.message, 'error');
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = '⟳ Sync';
      }
    });
  },

  // ===== CAMERA CAPTURE =====

  _captureImage() {
    this._initFileInput();
    if (
      typeof Photos !== 'undefined' &&
      Photos.getCameraMode() !== 'picker' &&
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia
    ) {
      return this._captureWithInAppCamera();
    }
    return this._captureWithFilePicker();
  },

  _captureWithInAppCamera() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'camera-overlay';
      overlay.innerHTML = `
        <div class="camera-container">
          <video class="camera-preview" id="expCamPreview" autoplay playsinline muted></video>
          <div class="camera-hint" id="expCamHint">Starting camera…</div>
          <div class="camera-controls">
            <button class="camera-btn camera-btn-secondary" id="expCamGalleryBtn" title="Gallery">
              <span class="camera-btn-icon">🖼️</span>
              <span class="camera-btn-label">Gallery</span>
            </button>
            <button class="camera-btn camera-btn-shutter" id="expCamShutterBtn" disabled>
              <span class="camera-shutter-ring"></span>
            </button>
            <button class="camera-btn camera-btn-secondary" id="expCamCancelBtn" title="Cancel">
              <span class="camera-btn-icon">✕</span>
              <span class="camera-btn-label">Cancel</span>
            </button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      let stream = null;
      const cleanup = () => {
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        overlay.remove();
      };

      navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1200 }, height: { ideal: 900 } },
        audio: false,
      }).then(s => {
        stream = s;
        const video = overlay.querySelector('#expCamPreview');
        video.srcObject = stream;
        video.addEventListener('playing', () => {
          overlay.querySelector('#expCamHint').style.display = 'none';
          overlay.querySelector('#expCamShutterBtn').disabled = false;
        });
      }).catch(() => {
        cleanup();
        resolve(this._captureWithFilePicker());
      });

      overlay.querySelector('#expCamShutterBtn').addEventListener('click', () => {
        const video = overlay.querySelector('#expCamPreview');
        if (!video.videoWidth) return;
        const maxW = 1200;
        let w = video.videoWidth, h = video.videoHeight;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(video, 0, 0, w, h);
        cleanup();
        resolve(c.toDataURL('image/jpeg', 0.72));
      });

      overlay.querySelector('#expCamGalleryBtn').addEventListener('click', () => {
        cleanup();
        resolve(this._captureWithFilePicker());
      });

      overlay.querySelector('#expCamCancelBtn').addEventListener('click', () => {
        cleanup();
        resolve(null);
      });
    });
  },

  _captureWithFilePicker() {
    this._initFileInput();
    return new Promise((resolve) => {
      this._pendingCapture = { resolve };
      this._fileInput.value = '';

      let wentHidden = false;
      const onVisibility = () => {
        if (!wentHidden && document.visibilityState === 'hidden') {
          wentHidden = true;
        } else if (wentHidden && document.visibilityState === 'visible') {
          document.removeEventListener('visibilitychange', onVisibility);
          setTimeout(() => {
            if (this._pendingCapture) { this._pendingCapture = null; resolve(null); }
          }, 600);
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      this._fileInput.click();
    });
  },

  _initFileInput() {
    if (this._fileInput) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.id = 'expenseReceiptInput';
    document.body.appendChild(input);
    this._fileInput = input;
    input.addEventListener('change', e => this._onFileSelected(e));
  },

  async _onFileSelected(e) {
    const pending = this._pendingCapture;
    this._pendingCapture = null;
    const file = e.target.files && e.target.files[0];
    if (!file || !pending) { if (pending) pending.resolve(null); return; }
    try {
      const objUrl = URL.createObjectURL(file);
      try {
        const dataUrl = await this._resizeToDataUrl(objUrl, 1200);
        pending.resolve(dataUrl);
      } finally {
        URL.revokeObjectURL(objUrl);
      }
    } catch { pending.resolve(null); }
  },

  _resizeToDataUrl(src, maxW = 1200) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = reject;
      img.src = src;
    });
  },

  // ===== PERSPECTIVE CROP UI =====

  _showCropUI(imgDataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const imgW = img.naturalWidth;
        const imgH = img.naturalHeight;

        // Fit image into available screen space (leave 100px for controls + safe area top)
        const safeTop = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0;
        const maxW = window.innerWidth;
        const maxH = Math.max(200, window.innerHeight - 100 - safeTop);
        const scale = Math.min(maxW / imgW, maxH / imgH);
        const dispW = Math.round(imgW * scale);
        const dispH = Math.round(imgH * scale);

        const canvas = document.createElement('canvas');
        canvas.width = dispW; canvas.height = dispH;
        canvas.getContext('2d').drawImage(img, 0, 0, dispW, dispH);

        // Default corners: 85% centered rectangle
        const m = 0.075;
        let corners = [
          { x: dispW * m,       y: dispH * m },
          { x: dispW * (1 - m), y: dispH * m },
          { x: dispW * (1 - m), y: dispH * (1 - m) },
          { x: dispW * m,       y: dispH * (1 - m) },
        ];
        const detected = this._detectEdges(canvas);
        if (detected) corners = detected;

        const overlay = document.createElement('div');
        overlay.className = 'crop-overlay';

        const wrap = document.createElement('div');
        wrap.className = 'crop-canvas-wrap';

        canvas.style.display = 'block';
        canvas.style.maxWidth = '100%';
        canvas.style.maxHeight = '100%';
        canvas.style.objectFit = 'contain';
        wrap.appendChild(canvas);

        // SVG for interactive crop handles
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', dispW);
        svg.setAttribute('height', dispH);
        svg.style.cssText = 'position:absolute;top:0;left:0;touch-action:none;overflow:visible;';
        wrap.appendChild(svg);

        const controls = document.createElement('div');
        controls.className = 'crop-controls';
        controls.innerHTML = `
          <button class="camera-btn" id="cropCancelBtn">
            <span class="camera-btn-icon">✕</span>
            <span class="camera-btn-label">Cancel</span>
          </button>
          <button class="camera-btn" id="cropAutoBtn">
            <span class="camera-btn-icon">⊡</span>
            <span class="camera-btn-label">Auto</span>
          </button>
          <button class="camera-btn crop-btn-primary" id="cropDoneBtn">
            <span class="camera-btn-icon">✓</span>
            <span class="camera-btn-label">Use Crop</span>
          </button>`;

        overlay.appendChild(wrap);
        overlay.appendChild(controls);
        document.body.appendChild(overlay);

        const render = () => {
          while (svg.firstChild) svg.removeChild(svg.firstChild);

          // Dark mask outside quad (evenodd rule cuts out the quad)
          const quadD = corners.map((c, i) =>
            `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`
          ).join(' ') + ' Z';
          const mask = document.createElementNS(ns, 'path');
          mask.setAttribute('d', `M0,0 L${dispW},0 L${dispW},${dispH} L0,${dispH} Z ${quadD}`);
          mask.setAttribute('fill', 'rgba(0,0,0,0.52)');
          mask.setAttribute('fill-rule', 'evenodd');
          svg.appendChild(mask);

          // Quad edge lines
          const pts = [...corners, corners[0]].map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
          const poly = document.createElementNS(ns, 'polyline');
          poly.setAttribute('points', pts);
          poly.setAttribute('fill', 'none');
          poly.setAttribute('stroke', 'rgba(255,255,255,0.9)');
          poly.setAttribute('stroke-width', '2');
          svg.appendChild(poly);

          // Corner handles
          corners.forEach((c, i) => {
            const g = document.createElementNS(ns, 'g');

            // Larger invisible touch target
            const hit = document.createElementNS(ns, 'circle');
            hit.setAttribute('cx', c.x); hit.setAttribute('cy', c.y);
            hit.setAttribute('r', 36);
            hit.setAttribute('fill', 'transparent');
            hit.setAttribute('data-corner', i);
            g.appendChild(hit);

            // Visible handle
            const circle = document.createElementNS(ns, 'circle');
            circle.setAttribute('cx', c.x); circle.setAttribute('cy', c.y);
            circle.setAttribute('r', 20);
            circle.setAttribute('fill', 'rgba(255,255,255,0.92)');
            circle.setAttribute('stroke', '#0066cc');
            circle.setAttribute('stroke-width', '3');
            g.appendChild(circle);

            svg.appendChild(g);
          });
        };

        render();

        // Pointer Events API with setPointerCapture — guarantees all subsequent
        // pointermove events route to the SVG regardless of finger position.
        let dragging = null;

        const getClosestCorner = (tx, ty) => {
          let minDist = Infinity, idx = -1;
          corners.forEach((c, i) => {
            const d = Math.hypot(c.x - tx, c.y - ty);
            if (d < minDist) { minDist = d; idx = i; }
          });
          return minDist < 80 ? idx : -1;
        };

        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        svg.addEventListener('pointerdown', e => {
          const rect = svg.getBoundingClientRect();
          const idx = getClosestCorner(e.clientX - rect.left, e.clientY - rect.top);
          if (idx < 0) return;
          dragging = idx;
          svg.setPointerCapture(e.pointerId);
          e.preventDefault();
        });

        svg.addEventListener('pointermove', e => {
          if (dragging === null || dragging < 0) return;
          const rect = svg.getBoundingClientRect();
          corners[dragging] = {
            x: clamp(e.clientX - rect.left, 0, dispW),
            y: clamp(e.clientY - rect.top, 0, dispH),
          };
          render();
        });

        svg.addEventListener('pointerup',     () => { dragging = null; });
        svg.addEventListener('pointercancel', () => { dragging = null; });

        controls.querySelector('#cropCancelBtn').addEventListener('click', () => {
          overlay.remove();
          resolve(null);
        });

        controls.querySelector('#cropAutoBtn').addEventListener('click', () => {
          const d = this._detectEdges(canvas);
          if (d) { corners = d; render(); }
          else App.showToast('Could not auto-detect edges — adjust manually', 'info');
        });

        controls.querySelector('#cropDoneBtn').addEventListener('click', () => {
          overlay.remove();
          // Map display corners → original image coordinates
          const imgCorners = corners.map(c => ({ x: c.x / scale, y: c.y / scale }));
          const result = this._applyPerspectiveTransform(img, imgCorners);
          resolve(result.toDataURL('image/jpeg', 0.72));
        });
      };
      img.src = imgDataUrl;
    });
  },

  // Scan row/column brightness to find a lighter region (receipt on dark surface).
  // Returns 4 corner points in canvas coords [TL, TR, BR, BL], or null if no clear region.
  _detectEdges(canvas) {
    const { width: w, height: h } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;

    const rowAvg = new Float32Array(h);
    const colAvg = new Float32Array(w);

    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      rowAvg[y] = s / w;
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      colAvg[x] = s / h;
    }

    // Compare center brightness to edge brightness
    const cSlice = Math.floor(h * 0.4);
    let centerBr = 0;
    for (let y = cSlice; y < h - cSlice; y++) centerBr += rowAvg[y];
    centerBr /= (h - 2 * cSlice);

    const edgeN = Math.min(12, Math.floor(h * 0.08));
    let edgeBr = 0;
    for (let y = 0; y < edgeN; y++) edgeBr += rowAvg[y] + rowAvg[h - 1 - y];
    edgeBr /= (2 * edgeN);

    if (centerBr - edgeBr < 20) return null; // insufficient contrast

    const threshold = edgeBr + (centerBr - edgeBr) * 0.28;
    const pad = Math.round(Math.min(w, h) * 0.008);

    let top = Math.floor(h * 0.075), bottom = Math.floor(h * 0.925);
    let left = Math.floor(w * 0.075), right = Math.floor(w * 0.925);

    for (let y = 0; y < h; y++) { if (rowAvg[y] > threshold) { top = y; break; } }
    for (let y = h - 1; y >= 0; y--) { if (rowAvg[y] > threshold) { bottom = y; break; } }
    for (let x = 0; x < w; x++) { if (colAvg[x] > threshold) { left = x; break; } }
    for (let x = w - 1; x >= 0; x--) { if (colAvg[x] > threshold) { right = x; break; } }

    top = Math.max(0, top - pad);
    bottom = Math.min(h - 1, bottom + pad);
    left = Math.max(0, left - pad);
    right = Math.min(w - 1, right + pad);

    if ((right - left) < w * 0.15 || (bottom - top) < h * 0.15) return null;

    return [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
  },

  // Solve 8-parameter homography H mapping srcPts[i] → dstPts[i].
  // Returns flat 9-element row-major matrix [h0..h8] with h8 = 1.
  _computeHomography(srcPts, dstPts) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const sx = srcPts[i].x, sy = srcPts[i].y;
      const dx = dstPts[i].x, dy = dstPts[i].y;
      A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
      b.push(dx);
      A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
      b.push(dy);
    }

    // Gaussian elimination with partial pivoting on the 8x8 augmented system
    const n = 8;
    const aug = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
      }
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
      const piv = aug[col][col];
      if (Math.abs(piv) < 1e-10) continue;
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const f = aug[row][col] / piv;
        for (let k = col; k <= n; k++) aug[row][k] -= f * aug[col][k];
      }
    }
    const h = aug.map((row, i) => row[n] / row[i]);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  },

  // Apply perspective transform: map the 4 corners (in image coords, order TL/TR/BR/BL)
  // to a flat rectangle. Returns a new canvas containing the corrected image.
  _applyPerspectiveTransform(img, corners) {
    const [tl, tr, br, bl] = corners;

    // Output dimensions = average of opposite edge lengths
    const topW  = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const botW  = Math.hypot(br.x - bl.x, br.y - bl.y);
    const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const rightH = Math.hypot(br.x - tr.x, br.y - tr.y);
    const rawW = Math.max(1, Math.round((topW + botW) / 2));
    const rawH = Math.max(1, Math.round((leftH + rightH) / 2));

    // Cap at 1000px on the longer side to keep pixel loop fast
    const cap = 1000;
    const capScale = Math.min(1, cap / Math.max(rawW, rawH));
    const outW = Math.round(rawW * capScale);
    const outH = Math.round(rawH * capScale);

    // Draw source image once for pixel sampling
    const srcC = document.createElement('canvas');
    srcC.width = img.naturalWidth; srcC.height = img.naturalHeight;
    srcC.getContext('2d').drawImage(img, 0, 0);
    const srcData = srcC.getContext('2d').getImageData(0, 0, srcC.width, srcC.height).data;
    const srcW = srcC.width, srcH = srcC.height;

    // Inverse homography: output pixel → source pixel
    const dstPts = [
      { x: 0, y: 0 }, { x: outW, y: 0 },
      { x: outW, y: outH }, { x: 0, y: outH },
    ];
    const H = this._computeHomography(dstPts, corners); // dst → src

    const dstC = document.createElement('canvas');
    dstC.width = outW; dstC.height = outH;
    const dstCtx = dstC.getContext('2d');
    const dstImg = dstCtx.createImageData(outW, outH);
    const buf = dstImg.data;

    for (let dy = 0; dy < outH; dy++) {
      for (let dx = 0; dx < outW; dx++) {
        const w  = H[6] * dx + H[7] * dy + H[8];
        const sx = (H[0] * dx + H[1] * dy + H[2]) / w;
        const sy = (H[3] * dx + H[4] * dy + H[5]) / w;
        const ix = Math.round(sx), iy = Math.round(sy);
        if (ix >= 0 && ix < srcW && iy >= 0 && iy < srcH) {
          const si = (iy * srcW + ix) * 4;
          const di = (dy * outW + dx) * 4;
          buf[di]     = srcData[si];
          buf[di + 1] = srcData[si + 1];
          buf[di + 2] = srcData[si + 2];
          buf[di + 3] = 255;
        }
      }
    }
    dstCtx.putImageData(dstImg, 0, 0);
    return dstC;
  },

  // ===== EXPENSE FORM =====

  // receiptImages: array of data URL strings (may be empty for no-receipt flow)
  // editingExpense: full DB record to pre-fill (null for new expense)
  async _showExpenseForm(receiptImages = [], editingExpense = null) {
    const [categories, methods] = await Promise.all([
      this._loadCategories(),
      this._getPaymentMethods(),
    ]);
    const employeeId = Auth.getEmployeeId();
    const isEditing = !!editingExpense;
    const today = new Date().toISOString().slice(0, 10);

    // Mutable image array for the multi-receipt strip
    let formImages = receiptImages.slice();

    return new Promise((resolve) => {
      const employeeWarning = !employeeId
        ? `<div class="exp-employee-warning">⚠️ No employee profile linked — expenses will sync without an employee ID.</div>`
        : '';

      const paymentBtns = methods.map((m, i) => `
        <button class="expense-payment-btn${i === 0 ? ' active' : ''}"
                data-idx="${i}" type="button">
          ${this._escHtml(m.label)}
        </button>`).join('');

      const categoryBtns = categories.length === 0
        ? '<p class="expense-hint">No expense categories found in Odoo — add products with "Can be Expensed" checked.</p>'
        : categories.map(c => `
            <button class="expense-category-btn" data-id="${c.id}"
                    data-name="${this._escHtml(c.name)}" type="button">
              ${this._escHtml(c.display_name || c.name)}
            </button>`).join('');

      const overlay = document.createElement('div');
      overlay.className = 'expense-overlay';
      overlay.innerHTML = `
        <div class="expense-form">
          <div class="expense-form-header">
            <button class="expense-close-btn" id="expCloseBtn" type="button">✕</button>
            <span class="expense-form-title">${isEditing ? 'Edit Expense' : 'New Expense'}</span>
            <button class="btn btn-primary btn-sm" id="expSubmitBtn" type="button">${isEditing ? 'Update' : 'Save'}</button>
          </div>
          ${employeeWarning}
          <div class="expense-form-body">

            <div class="exp-receipt-strip" id="expReceiptStrip"></div>

            <div class="form-group">
              <label class="form-label">Amount</label>
              <div class="expense-amount-wrap">
                <span class="expense-amount-symbol">$</span>
                <input type="number" class="form-input expense-amount-input"
                       id="expAmount" placeholder="0.00" step="0.01" min="0"
                       inputmode="decimal"
                       value="${isEditing && editingExpense.price_unit ? editingExpense.price_unit : ''}">
              </div>
              <div class="exp-amount-error" id="expAmountError" style="display:none;">Enter a valid amount greater than 0</div>
            </div>

            <div class="form-group">
              <label class="form-label">Date</label>
              <input type="date" class="form-input" id="expDate"
                     value="${isEditing ? (editingExpense.date || today) : today}">
            </div>

            <div class="form-group">
              <label class="form-label">Vendor <span class="expense-optional">(optional)</span></label>
              <div class="expense-vendor-wrap">
                <input type="text" class="form-input" id="expVendorSearch"
                       placeholder="Search vendors…" autocomplete="off" autocorrect="off"
                       value="${isEditing ? this._escHtml(editingExpense.partner_name || '') : ''}">
                <div class="expense-vendor-results" id="expVendorResults" style="display:none;"></div>
              </div>
              <input type="hidden" id="expVendorId"
                     value="${isEditing && editingExpense.partner_id ? editingExpense.partner_id : ''}">
            </div>

            <div class="form-group">
              <label class="form-label">Paid With</label>
              <div class="expense-payment-list" id="expPaymentList">
                ${paymentBtns}
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Category</label>
              <input type="text" class="form-input exp-category-search"
                     id="expCategorySearch" placeholder="Filter categories…">
              <div class="expense-category-list" id="expCategoryList">
                ${categoryBtns}
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Notes <span class="expense-optional">(optional)</span></label>
              <textarea class="form-input" id="expNotes" rows="2"
                        placeholder="Additional details…">${isEditing ? this._escHtml(editingExpense.description || '') : ''}</textarea>
            </div>

          </div>
        </div>`;

      document.body.appendChild(overlay);

      // ---- Receipt strip (multi-receipt) ----
      const renderStrip = () => {
        const strip = overlay.querySelector('#expReceiptStrip');
        strip.innerHTML = formImages.map((src, i) => `
          <div class="exp-receipt-thumb-item" data-idx="${i}">
            <img src="${src}" class="exp-receipt-thumb-img" alt="Receipt ${i + 1}">
            <button class="exp-receipt-thumb-del" data-idx="${i}" type="button" aria-label="Remove">✕</button>
          </div>`).join('') +
          `<button class="exp-receipt-add-btn" id="expReceiptAddBtn" type="button">
            <span class="exp-receipt-add-icon">+</span>
            <span class="exp-receipt-add-label">Add Photo</span>
          </button>`;

        strip.querySelectorAll('.exp-receipt-thumb-img').forEach(img => {
          img.addEventListener('click', () => this._showLightbox(img.src));
        });
        strip.querySelectorAll('.exp-receipt-thumb-del').forEach(btn => {
          btn.addEventListener('click', e => {
            e.stopPropagation();
            formImages.splice(parseInt(btn.dataset.idx, 10), 1);
            renderStrip();
          });
        });
        strip.querySelector('#expReceiptAddBtn').addEventListener('click', async () => {
          const img = await this._captureImage();
          if (img) { formImages.push(img); renderStrip(); }
        });
      };
      renderStrip();

      // ---- State ----
      let selectedPaymentIdx = 0;
      let selectedCategoryId = null;
      let selectedCategoryName = '';
      let selectedVendorId = isEditing && editingExpense.partner_id ? editingExpense.partner_id : null;
      let vendorTimer = null;

      // Pre-fill payment method when editing
      if (isEditing) {
        const pmIdx = methods.findIndex(m =>
          m.payment_mode === editingExpense.payment_mode &&
          (m.journal_id || false) === (editingExpense.journal_id || false)
        );
        if (pmIdx >= 0) selectedPaymentIdx = pmIdx;
      }

      // Payment button activation
      overlay.querySelectorAll('.expense-payment-btn').forEach((btn, i) => {
        if (i === selectedPaymentIdx) btn.classList.add('active');
        else btn.classList.remove('active');
        btn.addEventListener('click', () => {
          overlay.querySelectorAll('.expense-payment-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          selectedPaymentIdx = parseInt(btn.dataset.idx, 10);
        });
      });

      // Category selection + pre-fill when editing
      overlay.querySelectorAll('.expense-category-btn').forEach(btn => {
        if (isEditing && editingExpense.product_id && parseInt(btn.dataset.id, 10) === editingExpense.product_id) {
          btn.classList.add('active');
          selectedCategoryId = editingExpense.product_id;
          selectedCategoryName = btn.dataset.name;
        }
        btn.addEventListener('click', () => {
          overlay.querySelectorAll('.expense-category-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          selectedCategoryId = parseInt(btn.dataset.id, 10);
          selectedCategoryName = btn.dataset.name;
        });
      });

      // Category search filter
      overlay.querySelector('#expCategorySearch').addEventListener('input', e => {
        const q = e.target.value.toLowerCase().trim();
        overlay.querySelectorAll('.expense-category-btn').forEach(btn => {
          const name = (btn.dataset.name || btn.textContent).toLowerCase();
          btn.style.display = (!q || name.includes(q)) ? '' : 'none';
        });
      });

      // Amount blur validation
      const amountInput = overlay.querySelector('#expAmount');
      const amountError = overlay.querySelector('#expAmountError');
      amountInput.addEventListener('blur', () => {
        const v = parseFloat(amountInput.value);
        if (amountInput.value && (!v || v <= 0)) {
          amountInput.classList.add('input-error');
          amountError.style.display = '';
        } else {
          amountInput.classList.remove('input-error');
          amountError.style.display = 'none';
        }
      });
      amountInput.addEventListener('input', () => {
        if (amountInput.classList.contains('input-error')) {
          const v = parseFloat(amountInput.value);
          if (v && v > 0) {
            amountInput.classList.remove('input-error');
            amountError.style.display = 'none';
          }
        }
      });

      // Vendor live search
      const vendorInput = overlay.querySelector('#expVendorSearch');
      const vendorResults = overlay.querySelector('#expVendorResults');

      vendorInput.addEventListener('input', () => {
        clearTimeout(vendorTimer);
        const q = vendorInput.value.trim();
        selectedVendorId = null;
        if (q.length < 2) { vendorResults.style.display = 'none'; return; }
        vendorTimer = setTimeout(async () => {
          try {
            const partners = await OdooAPI.searchVendors(q);
            const createRow = `<div class="vendor-result-item vendor-result-create"
              data-create="1" data-name="${this._escHtml(q)}">+ Create "${this._escHtml(q)}"</div>`;
            vendorResults.innerHTML = (partners.length
              ? partners.map(p =>
                  `<div class="vendor-result-item" data-id="${p.id}"
                        data-name="${this._escHtml(p.name)}">${this._escHtml(p.name)}</div>`
                ).join('')
              : '') + createRow;
            vendorResults.style.display = '';
          } catch { vendorResults.style.display = 'none'; }
        }, 320);
      });

      vendorResults.addEventListener('click', async e => {
        const item = e.target.closest('.vendor-result-item');
        if (!item) return;
        vendorResults.style.display = 'none';
        if (item.dataset.create) {
          const name = item.dataset.name;
          try {
            const id = await OdooAPI.createVendor(name);
            selectedVendorId = id;
            vendorInput.value = name;
          } catch (err) {
            App.showToast('Could not create vendor: ' + err.message, 'error');
          }
        } else {
          selectedVendorId = parseInt(item.dataset.id, 10);
          vendorInput.value = item.dataset.name;
        }
      });

      overlay.querySelector('.expense-form-body').addEventListener('touchstart', e => {
        if (!vendorResults.contains(e.target) && e.target !== vendorInput) {
          vendorResults.style.display = 'none';
        }
      }, { passive: true });

      overlay.querySelector('#expCloseBtn').addEventListener('click', () => {
        overlay.remove(); resolve(null);
      });

      overlay.querySelector('#expSubmitBtn').addEventListener('click', async () => {
        const amount = parseFloat(amountInput.value);
        if (!amount || amount <= 0) {
          amountInput.classList.add('input-error');
          amountError.style.display = '';
          App.showToast('Enter an amount', 'error');
          return;
        }
        if (!selectedCategoryId) {
          App.showToast('Select a category', 'error');
          return;
        }

        const activeMethod = methods[selectedPaymentIdx] || methods[0];
        const vendorName = vendorInput.value.trim();
        const expenseName = [selectedCategoryName, vendorName].filter(Boolean).join(' – ') || 'Expense';

        const expense = {
          temp_id: isEditing
            ? editingExpense.temp_id
            : ('exp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
          name: expenseName,
          date: overlay.querySelector('#expDate').value || today,
          price_unit: amount,
          quantity: 1,
          product_id: selectedCategoryId,
          partner_id: selectedVendorId || false,
          partner_name: vendorName || '',
          payment_mode: activeMethod.payment_mode,
          journal_id: activeMethod.journal_id || false,
          journal_label: activeMethod.label || '',
          employee_id: employeeId || false,
          description: overlay.querySelector('#expNotes').value.trim() || false,
          receipt_images: formImages.length > 0 ? formImages : false,
          receipt_filename: 'receipt_' + Date.now() + '.jpg',
          created_at: isEditing
            ? (editingExpense.created_at || new Date().toISOString())
            : new Date().toISOString(),
          synced: 0,
        };

        if (CONFIG.ALLOWED_COMPANY_IDS && CONFIG.ALLOWED_COMPANY_IDS.length > 0) {
          expense.company_id = CONFIG.ALLOWED_COMPANY_IDS[0];
        }

        try {
          const submitBtn = overlay.querySelector('#expSubmitBtn');
          submitBtn.disabled = true;
          submitBtn.textContent = isEditing ? 'Updating…' : 'Saving…';
          await this._saveExpense(expense);

          if (navigator.onLine) {
            this.syncAll().catch(() => {});
          }

          overlay.remove();
          App.showToast(
            navigator.onLine
              ? (isEditing ? 'Expense updated' : 'Expense submitted')
              : (isEditing ? 'Expense updated — will sync when online' : 'Expense saved — will sync when online'),
            'success'
          );
          resolve({ submitted: true });
        } catch (err) {
          overlay.querySelector('#expSubmitBtn').disabled = false;
          overlay.querySelector('#expSubmitBtn').textContent = isEditing ? 'Update' : 'Save';
          App.showToast('Failed to save: ' + err.message, 'error');
        }
      });
    });
  },

  // ===== MILEAGE FORM =====

  async _showMileageForm(editingExpense = null) {
    const methods = await this._getPaymentMethods();
    const employeeId = Auth.getEmployeeId();
    const isEditing = !!editingExpense;
    const defaultRate = (CONFIG.MILEAGE_RATE || 0.67).toFixed(3);
    const mileageProductId = CONFIG.MILEAGE_PRODUCT_ID || false;
    const today = new Date().toISOString().slice(0, 10);

    return new Promise((resolve) => {
      const productWarning = !mileageProductId
        ? `<div class="exp-employee-warning exp-warning-amber">⚠️ MILEAGE_PRODUCT_ID not set in config — mileage will sync without a product category.</div>`
        : '';

      const paymentBtns = methods.map((m, i) => `
        <button class="expense-payment-btn${i === 0 ? ' active' : ''}"
                data-idx="${i}" type="button">
          ${this._escHtml(m.label)}
        </button>`).join('');

      const overlay = document.createElement('div');
      overlay.className = 'expense-overlay';
      overlay.innerHTML = `
        <div class="expense-form">
          <div class="expense-form-header">
            <button class="expense-close-btn" id="expMiClose" type="button">✕</button>
            <span class="expense-form-title">${isEditing ? 'Edit Mileage' : 'Log Mileage'}</span>
            <button class="btn btn-primary btn-sm" id="expMiSubmitBtn" type="button">${isEditing ? 'Update' : 'Save'}</button>
          </div>
          ${productWarning}
          <div class="expense-form-body">

            <div class="form-group">
              <label class="form-label">Miles</label>
              <input type="number" class="form-input" id="expMiMiles"
                     placeholder="0.0" step="0.1" min="0" inputmode="decimal"
                     value="${isEditing ? (editingExpense.quantity || '') : ''}">
            </div>

            <div class="form-group exp-mi-meta-row">
              <div class="exp-mi-rate-wrap">
                <span class="exp-mi-rate-label">Rate</span>
                <div class="expense-amount-wrap">
                  <span class="expense-amount-symbol">$</span>
                  <input type="number" class="form-input expense-amount-input exp-mi-rate-input"
                         id="expMiRate" step="0.001" min="0" inputmode="decimal"
                         value="${isEditing ? (editingExpense.price_unit || defaultRate) : defaultRate}">
                  <span class="exp-mi-per-mi">/mi</span>
                </div>
              </div>
              <div class="exp-mi-total-wrap">
                <span class="exp-mi-total-label">Total</span>
                <span class="exp-mi-total" id="expMiTotal">$0.00</span>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">From <span class="expense-optional">(optional)</span></label>
              <input type="text" class="form-input" id="expMiFrom"
                     placeholder="Starting location"
                     value="${isEditing ? this._escHtml(editingExpense.mileage_from || '') : ''}">
            </div>

            <div class="form-group">
              <label class="form-label">To <span class="expense-optional">(optional)</span></label>
              <input type="text" class="form-input" id="expMiTo"
                     placeholder="Destination"
                     value="${isEditing ? this._escHtml(editingExpense.mileage_to || '') : ''}">
            </div>

            <div class="form-group">
              <label class="form-label">Date</label>
              <input type="date" class="form-input" id="expMiDate"
                     value="${isEditing ? (editingExpense.date || today) : today}">
            </div>

            <div class="form-group">
              <label class="form-label">Paid With</label>
              <div class="expense-payment-list" id="expMiPaymentList">
                ${paymentBtns}
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Notes <span class="expense-optional">(optional)</span></label>
              <textarea class="form-input" id="expMiNotes" rows="2"
                        placeholder="Additional details…">${isEditing ? this._escHtml(editingExpense.description || '') : ''}</textarea>
            </div>

          </div>
        </div>`;

      document.body.appendChild(overlay);

      let selectedPaymentIdx = 0;
      if (isEditing) {
        const pmIdx = methods.findIndex(m =>
          m.payment_mode === editingExpense.payment_mode &&
          (m.journal_id || false) === (editingExpense.journal_id || false)
        );
        if (pmIdx >= 0) selectedPaymentIdx = pmIdx;
      }

      overlay.querySelectorAll('.expense-payment-btn').forEach((btn, i) => {
        if (i === selectedPaymentIdx) btn.classList.add('active');
        else btn.classList.remove('active');
        btn.addEventListener('click', () => {
          overlay.querySelectorAll('.expense-payment-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          selectedPaymentIdx = parseInt(btn.dataset.idx, 10);
        });
      });

      const updateTotal = () => {
        const miles = parseFloat(overlay.querySelector('#expMiMiles').value) || 0;
        const rate  = parseFloat(overlay.querySelector('#expMiRate').value) || 0;
        overlay.querySelector('#expMiTotal').textContent = '$' + (miles * rate).toFixed(2);
      };
      overlay.querySelector('#expMiMiles').addEventListener('input', updateTotal);
      overlay.querySelector('#expMiRate').addEventListener('input', updateTotal);
      updateTotal();

      overlay.querySelector('#expMiClose').addEventListener('click', () => {
        overlay.remove(); resolve(null);
      });

      overlay.querySelector('#expMiSubmitBtn').addEventListener('click', async () => {
        const miles = parseFloat(overlay.querySelector('#expMiMiles').value);
        const rate  = parseFloat(overlay.querySelector('#expMiRate').value);

        if (!miles || miles <= 0) {
          App.showToast('Enter miles driven', 'error'); return;
        }
        if (!rate || rate <= 0) {
          App.showToast('Enter a valid rate', 'error'); return;
        }

        const activeMethod = methods[selectedPaymentIdx] || methods[0];
        const fromLoc = overlay.querySelector('#expMiFrom').value.trim();
        const toLoc   = overlay.querySelector('#expMiTo').value.trim();
        const route   = [fromLoc, toLoc].filter(Boolean).join(' → ');
        const expenseName = `Mileage${route ? ' – ' + route : ''} (${miles} mi)`;

        const expense = {
          temp_id: isEditing
            ? editingExpense.temp_id
            : ('exp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
          expense_type: 'mileage',
          name: expenseName,
          date: overlay.querySelector('#expMiDate').value || today,
          price_unit: rate,
          quantity: miles,
          product_id: mileageProductId || false,
          payment_mode: activeMethod.payment_mode,
          journal_id: activeMethod.journal_id || false,
          journal_label: activeMethod.label || '',
          employee_id: employeeId || false,
          description: overlay.querySelector('#expMiNotes').value.trim() || false,
          mileage_from: fromLoc || false,
          mileage_to:   toLoc   || false,
          receipt_images: false,
          created_at: isEditing
            ? (editingExpense.created_at || new Date().toISOString())
            : new Date().toISOString(),
          synced: 0,
        };

        if (CONFIG.ALLOWED_COMPANY_IDS && CONFIG.ALLOWED_COMPANY_IDS.length > 0) {
          expense.company_id = CONFIG.ALLOWED_COMPANY_IDS[0];
        }

        try {
          const submitBtn = overlay.querySelector('#expMiSubmitBtn');
          submitBtn.disabled = true;
          submitBtn.textContent = isEditing ? 'Updating…' : 'Saving…';
          await this._saveExpense(expense);

          if (navigator.onLine) {
            this.syncAll().catch(() => {});
          }

          overlay.remove();
          App.showToast(
            navigator.onLine
              ? (isEditing ? 'Mileage updated' : 'Mileage logged')
              : (isEditing ? 'Mileage updated — will sync when online' : 'Mileage saved — will sync when online'),
            'success'
          );
          resolve({ submitted: true });
        } catch (err) {
          overlay.querySelector('#expMiSubmitBtn').disabled = false;
          overlay.querySelector('#expMiSubmitBtn').textContent = isEditing ? 'Update' : 'Save';
          App.showToast('Failed to save: ' + err.message, 'error');
        }
      });
    });
  },

  // ===== LIGHTBOX =====

  _showLightbox(src) {
    const lb = document.createElement('div');
    lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.93);z-index:10000;' +
      'display:flex;align-items:center;justify-content:center;touch-action:manipulation;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ' +
      'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);';
    const lbImg = document.createElement('img');
    lbImg.src = src;
    lbImg.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
    lb.appendChild(lbImg);
    lb.addEventListener('click', () => lb.remove());
    document.body.appendChild(lb);
  },

  // ===== PAYMENT METHODS =====

  async _getPaymentMethods() {
    const cfg = CONFIG.EXPENSE_PAYMENT_METHODS || {};
    if (cfg.mode === 'odoo') {
      try {
        const journals = await OdooAPI.getExpenseJournals();
        return [
          { label: 'Out of Pocket (Reimbursable)', payment_mode: 'own_account', journal_id: false },
          ...journals.map(j => ({ label: j.name, payment_mode: 'company_account', journal_id: j.id })),
        ];
      } catch (e) {
        console.warn('Failed to fetch expense journals, falling back to config:', e);
      }
    }
    const accounts = cfg.accounts || [];
    return accounts.length > 0
      ? accounts
      : [{ label: 'Out of Pocket (Reimbursable)', payment_mode: 'own_account', journal_id: false }];
  },

  // ===== EXPENSE CATEGORIES =====

  async _loadCategories() {
    if (this._categories !== null) return this._categories;
    try {
      this._categories = await OdooAPI.getExpenseCategories() || [];
    } catch (e) {
      console.warn('Failed to load expense categories:', e);
      this._categories = [];
    }
    return this._categories;
  },

  // ===== SAVE & SYNC =====

  async _saveExpense(expense) {
    await DB.put('expensesQueue', expense);
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready
        .then(sw => sw.sync.register('expense-upload'))
        .catch(() => {});
    }
  },

  async syncAll() {
    const pending = await DB.getUnsyncedItems('expensesQueue');
    let synced = 0, failed = 0;

    for (const expense of pending) {
      try {
        const vals = {
          name: expense.name,
          date: expense.date,
          price_unit: expense.price_unit || 0,
          quantity: expense.quantity || 1,
          product_id: expense.product_id,
          payment_mode: expense.payment_mode || 'own_account',
        };
        if (expense.partner_id)   vals.partner_id   = expense.partner_id;
        if (expense.journal_id)   vals.journal_id   = expense.journal_id;
        if (expense.employee_id)  vals.employee_id  = expense.employee_id;
        if (expense.company_id)   vals.company_id   = expense.company_id;
        if (expense.description)  vals.description  = expense.description;

        const expenseId = await OdooAPI.createExpense(vals);

        // Attach all receipt images (multi-receipt support, backward-compat with receipt_b64)
        const images = (expense.receipt_images && expense.receipt_images.length)
          ? expense.receipt_images
          : (expense.receipt_b64 ? [expense.receipt_b64] : []);

        for (let i = 0; i < images.length; i++) {
          await OdooAPI.attachReceiptToExpense(
            expenseId,
            images[i],
            `receipt_${Date.now() + i}.jpg`
          );
        }

        // Auto-submit expense sheet if configured
        if (CONFIG.EXPENSE_AUTO_SUBMIT && expenseId) {
          await OdooAPI.submitExpense(expenseId);
        }

        expense.synced = 1;
        expense.odoo_id = expenseId;
        await DB.put('expensesQueue', expense);
        synced++;
      } catch (err) {
        console.warn('Failed to sync expense:', expense.temp_id, err);
        failed++;
      }
    }

    return { synced, failed };
  },

  // ===== UTILITY =====

  _escHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  },
};
