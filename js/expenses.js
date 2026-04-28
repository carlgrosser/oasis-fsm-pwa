/**
 * Expenses module — receipt scanning, perspective crop, expense form, Odoo sync.
 */
const Expenses = {
  _fileInput: null,
  _pendingCapture: null,
  _categories: null, // null = not yet fetched

  // ===== ENTRY POINT =====

  async startReceiptScan() {
    try {
      const imageDataUrl = await this._captureImage();
      if (!imageDataUrl) return;

      const croppedDataUrl = await this._showCropUI(imageDataUrl);
      if (!croppedDataUrl) return;

      await this._showExpenseForm(croppedDataUrl);
    } catch (err) {
      console.error('Receipt scan error:', err);
      App.showToast('Receipt scan failed: ' + err.message, 'error');
    }
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
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
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
        const maxW = 1920;
        let w = video.videoWidth, h = video.videoHeight;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(video, 0, 0, w, h);
        cleanup();
        resolve(c.toDataURL('image/jpeg', 0.88));
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
        const dataUrl = await this._resizeToDataUrl(objUrl, 1920);
        pending.resolve(dataUrl);
      } finally {
        URL.revokeObjectURL(objUrl);
      }
    } catch { pending.resolve(null); }
  },

  _resizeToDataUrl(src, maxW) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.88));
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

        // Draw image to canvas at display resolution
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

        // Build full-screen overlay
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
          <button class="camera-btn" id="cropDoneBtn">
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

        // Pointer Events API with setPointerCapture — the correct cross-platform
        // approach. Once a pointerdown is captured on the SVG, all subsequent
        // pointermove events are guaranteed to route to it even if the finger
        // moves outside the element's bounds, completely eliminating the
        // "drag drops after a few pixels" problem.
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
          svg.setPointerCapture(e.pointerId); // lock all events to this element
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
          resolve(result.toDataURL('image/jpeg', 0.88));
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

    // Cap at 1600px on the longer side to keep pixel loop fast
    const cap = 1600;
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

  async _showExpenseForm(receiptDataUrl) {
    // Load categories and payment methods in parallel; employee ID is already cached in Auth
    const [categories, methods] = await Promise.all([
      this._loadCategories(),
      this._getPaymentMethods(),
    ]);
    const employeeId = Auth.getEmployeeId();

    return new Promise((resolve) => {
      const today = new Date().toISOString().slice(0, 10);

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
            <span class="expense-form-title">New Expense</span>
            <button class="btn btn-primary btn-sm" id="expSubmitBtn" type="button">Save</button>
          </div>
          <div class="expense-form-body">

            <div class="expense-receipt-preview">
              <img src="${receiptDataUrl}" class="expense-receipt-img" alt="Receipt">
            </div>

            <div class="form-group">
              <label class="form-label">Amount</label>
              <div class="expense-amount-wrap">
                <span class="expense-amount-symbol">$</span>
                <input type="number" class="form-input expense-amount-input"
                       id="expAmount" placeholder="0.00" step="0.01" min="0"
                       inputmode="decimal">
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Date</label>
              <input type="date" class="form-input" id="expDate" value="${today}">
            </div>

            <div class="form-group">
              <label class="form-label">Vendor <span class="expense-optional">(optional)</span></label>
              <div class="expense-vendor-wrap">
                <input type="text" class="form-input" id="expVendorSearch"
                       placeholder="Search vendors…" autocomplete="off" autocorrect="off">
                <div class="expense-vendor-results" id="expVendorResults" style="display:none;"></div>
              </div>
              <input type="hidden" id="expVendorId">
            </div>

            <div class="form-group">
              <label class="form-label">Paid With</label>
              <div class="expense-payment-list" id="expPaymentList">
                ${paymentBtns}
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Category</label>
              <div class="expense-category-list" id="expCategoryList">
                ${categoryBtns}
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Notes <span class="expense-optional">(optional)</span></label>
              <textarea class="form-input" id="expNotes" rows="2"
                        placeholder="Additional details…"></textarea>
            </div>

          </div>
        </div>`;

      document.body.appendChild(overlay);

      // Receipt tap-to-zoom
      overlay.querySelector('.expense-receipt-img').addEventListener('click', () => {
        const lb = document.createElement('div');
        lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.93);z-index:10000;' +
          'display:flex;align-items:center;justify-content:center;touch-action:manipulation;' +
          'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ' +
          'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);';
        const lbImg = document.createElement('img');
        lbImg.src = receiptDataUrl;
        lbImg.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
        lb.appendChild(lbImg);
        lb.addEventListener('click', () => lb.remove());
        document.body.appendChild(lb);
      });

      // --- State ---
      let selectedPaymentIdx = 0;
      let selectedCategoryId = null;
      let selectedCategoryName = '';
      let selectedVendorId = null;
      let vendorTimer = null;

      // Payment method selection
      overlay.querySelectorAll('.expense-payment-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          overlay.querySelectorAll('.expense-payment-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          selectedPaymentIdx = parseInt(btn.dataset.idx, 10);
        });
      });

      // Category selection
      overlay.querySelectorAll('.expense-category-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          overlay.querySelectorAll('.expense-category-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          selectedCategoryId = parseInt(btn.dataset.id, 10);
          selectedCategoryName = btn.dataset.name;
        });
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
            if (!partners.length) {
              vendorResults.innerHTML = createRow;
            } else {
              vendorResults.innerHTML = partners.map(p =>
                `<div class="vendor-result-item" data-id="${p.id}"
                      data-name="${this._escHtml(p.name)}">${this._escHtml(p.name)}</div>`
              ).join('') + createRow;
            }
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

      // Dismiss vendor results on outside tap
      overlay.querySelector('.expense-form-body').addEventListener('touchstart', e => {
        if (!vendorResults.contains(e.target) && e.target !== vendorInput) {
          vendorResults.style.display = 'none';
        }
      }, { passive: true });

      // Close / cancel
      overlay.querySelector('#expCloseBtn').addEventListener('click', () => {
        overlay.remove(); resolve(null);
      });

      // Save
      overlay.querySelector('#expSubmitBtn').addEventListener('click', async () => {
        const amount = parseFloat(overlay.querySelector('#expAmount').value);
        if (!amount || amount <= 0) {
          App.showToast('Enter an amount', 'error'); return;
        }
        if (!selectedCategoryId) {
          App.showToast('Select a category', 'error'); return;
        }

        const activeMethod = methods[selectedPaymentIdx] || methods[0];
        const vendorName = vendorInput.value.trim();
        const expenseName = [selectedCategoryName, vendorName].filter(Boolean).join(' – ') || 'Expense';

        const expense = {
          temp_id: 'exp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          name: expenseName,
          date: overlay.querySelector('#expDate').value || today,
          price_unit: amount,
          quantity: 1,
          product_id: selectedCategoryId,
          partner_id: selectedVendorId || false,
          payment_mode: activeMethod.payment_mode,
          journal_id: activeMethod.journal_id || false,
          employee_id: employeeId || false,
          description: overlay.querySelector('#expNotes').value.trim() || false,
          receipt_b64: receiptDataUrl,
          receipt_filename: 'receipt_' + Date.now() + '.jpg',
          created_at: new Date().toISOString(),
          synced: 0,
        };

        if (CONFIG.ALLOWED_COMPANY_IDS && CONFIG.ALLOWED_COMPANY_IDS.length > 0) {
          expense.company_id = CONFIG.ALLOWED_COMPANY_IDS[0];
        }

        try {
          overlay.querySelector('#expSubmitBtn').disabled = true;
          overlay.querySelector('#expSubmitBtn').textContent = 'Saving…';
          await this._saveExpense(expense);

          if (navigator.onLine) {
            this.syncAll().catch(() => {});
          }

          overlay.remove();
          App.showToast(navigator.onLine ? 'Expense submitted' : 'Expense saved — will sync when online', 'success');
          resolve({ submitted: true });
        } catch (err) {
          overlay.querySelector('#expSubmitBtn').disabled = false;
          overlay.querySelector('#expSubmitBtn').textContent = 'Save';
          App.showToast('Failed to save: ' + err.message, 'error');
        }
      });
    });
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

        if (expenseId && expense.receipt_b64) {
          await OdooAPI.attachReceiptToExpense(
            expenseId,
            expense.receipt_b64,
            expense.receipt_filename || 'receipt.jpg'
          );
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
