/**
 * Photos module — camera capture, gallery, IndexedDB storage, upload.
 *
 * Upload destination: Google Drive via Odoo proxy (/gdrive/upload_photo).
 * Fallback: ir.attachment on upload failure after one retry.
 *
 * Display: merges locally-pending (IndexedDB, synced=0) photos with
 * already-synced Drive thumbnails fetched from gdrive.photo.link records.
 */
const Photos = {
  _fileInput: null,
  _pendingCapture: null,    // { jobId, category, resolve, reject }
  _visibilityListener: null, // safety-net listener reference
  _CAMERA_MODE_KEY: 'photos_camera_mode',

  // ========== CAMERA MODE SETTING ==========

  /**
   * @returns {'inapp'|'picker'} — 'inapp' uses getUserMedia overlay; 'picker' uses file input.
   */
  getCameraMode() {
    return localStorage.getItem(this._CAMERA_MODE_KEY) || 'inapp';
  },

  setCameraMode(mode) {
    localStorage.setItem(this._CAMERA_MODE_KEY, mode);
    this._updateCameraModeLabels();
  },

  _updateCameraModeLabels() {
    const mode = this.getCameraMode();
    const label = mode === 'picker'
      ? '📷 Camera: File Picker'
      : '📷 Camera: In-App';
    ['cameraModeBtnList', 'cameraModeBtnDetail'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = label;
    });
  },

  /**
   * Update camera mode button labels. Called once after DOM is ready
   * and after each toggle. Event binding is handled by app.js/_bindEvents()
   * via bindMenuAction so iOS touchstart is handled correctly.
   */
  initCameraModeToggle() {
    this._updateCameraModeLabels();
  },

  /**
   * Initialize — create the hidden file input used for camera capture.
   *
   * NOTE: Do NOT set input.capture on this element. On Android, `capture`
   * forces the camera to open as a separate OS Activity, which can cause
   * Android to kill the PWA process in the background. Without `capture`,
   * both Android and iOS present a native picker that includes camera as
   * an option and keeps the browser context alive.
   */
  init() {
    if (this._fileInput) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.id = 'photoCaptureInput';
    document.body.appendChild(input);
    this._fileInput = input;

    input.addEventListener('change', (e) => this._onFileSelected(e));
  },

  /**
   * Launch the camera for a specific job and category.
   *
   * Prefers an in-app camera overlay using getUserMedia so no external OS
   * Activity is launched (avoids the Android memory-kill issue and ensures
   * a camera option is always available on Samsung devices whose file picker
   * omits it). Falls back to the file input picker if getUserMedia is
   * unavailable or permission is denied.
   *
   * @param {number} jobId
   * @param {string} category
   * @returns {Promise<object|null>} - The saved photo record, or null if cancelled.
   */
  capturePhoto(jobId, category) {
    this.init();

    if (this.getCameraMode() !== 'picker' &&
        navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      return this._captureWithInAppCamera(jobId, category);
    }
    return this._captureWithFilePicker(jobId, category);
  },

  /**
   * In-app camera overlay using getUserMedia.
   * Streams the rear camera directly in the browser — no Activity switch,
   * no memory pressure, no Samsung picker quirks.
   */
  _captureWithInAppCamera(jobId, category) {
    return new Promise((resolve, reject) => {
      const overlay = document.createElement('div');
      overlay.className = 'camera-overlay';
      overlay.innerHTML = `
        <div class="camera-container">
          <video class="camera-preview" id="cameraPreview" autoplay playsinline muted></video>
          <div class="camera-hint" id="cameraHint">Starting camera…</div>
          <div class="camera-controls">
            <button class="camera-btn camera-btn-secondary" id="cameraGalleryBtn" title="Choose from gallery">
              <span class="camera-btn-icon">🖼️</span>
              <span class="camera-btn-label">Gallery</span>
            </button>
            <button class="camera-btn camera-btn-shutter" id="cameraShutterBtn" title="Take photo" disabled>
              <span class="camera-shutter-ring"></span>
            </button>
            <button class="camera-btn camera-btn-secondary" id="cameraCloseBtn" title="Cancel">
              <span class="camera-btn-icon">✕</span>
              <span class="camera-btn-label">Cancel</span>
            </button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      let stream = null;

      const cleanup = () => {
        if (stream) {
          stream.getTracks().forEach(t => t.stop());
          stream = null;
        }
        overlay.remove();
      };

      // Start rear camera
      navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      }).then(s => {
        stream = s;
        const video = overlay.querySelector('#cameraPreview');
        video.srcObject = stream;
        video.addEventListener('playing', () => {
          overlay.querySelector('#cameraHint').style.display = 'none';
          overlay.querySelector('#cameraShutterBtn').disabled = false;
        });
      }).catch(() => {
        // Permission denied or unsupported — fall back to file picker silently
        cleanup();
        resolve(this._captureWithFilePicker(jobId, category));
      });

      // Take photo — draw directly to scaled canvases from the live video frame
      overlay.querySelector('#cameraShutterBtn').addEventListener('click', async () => {
        const video = overlay.querySelector('#cameraPreview');
        if (!video.videoWidth) return; // not ready yet

        try {
          // Full-size (max 1920px wide)
          const maxW = 1920;
          let w = video.videoWidth, h = video.videoHeight;
          if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(video, 0, 0, w, h);
          const resized = canvas.toDataURL('image/jpeg', 0.85);

          // Thumbnail (max 300px wide)
          const thumbW = 300;
          let tw = w, th = h;
          if (tw > thumbW) { th = Math.round(th * thumbW / tw); tw = thumbW; }
          const thumbCanvas = document.createElement('canvas');
          thumbCanvas.width = tw; thumbCanvas.height = th;
          thumbCanvas.getContext('2d').drawImage(video, 0, 0, tw, th);
          const thumbnail = thumbCanvas.toDataURL('image/jpeg', 0.7);

          cleanup();
          const photo = await this.savePhoto(
            jobId, resized, thumbnail, category, `photo_${Date.now()}.jpg`
          );
          resolve(photo);
        } catch (err) {
          cleanup();
          reject(err);
        }
      });

      // Gallery fallback — stop camera and use file picker instead
      overlay.querySelector('#cameraGalleryBtn').addEventListener('click', () => {
        cleanup();
        resolve(this._captureWithFilePicker(jobId, category));
      });

      // Cancel
      overlay.querySelector('#cameraCloseBtn').addEventListener('click', () => {
        cleanup();
        resolve(null);
      });
    });
  },

  /**
   * File-input picker fallback (original behavior, no `capture` attribute).
   * On most devices presents the native picker with gallery access.
   */
  _captureWithFilePicker(jobId, category) {
    this.init();

    return new Promise((resolve, reject) => {
      const pending = { jobId, category, resolve, reject };
      this._pendingCapture = pending;
      this._fileInput.value = '';

      // Safety net: Android can return the user to the app without firing
      // the `change` event (cancel, or OS killed+reloaded the page).
      let wentHidden = false;
      const onVisibility = () => {
        if (!wentHidden && document.visibilityState === 'hidden') {
          wentHidden = true;
        } else if (wentHidden && document.visibilityState === 'visible') {
          document.removeEventListener('visibilitychange', onVisibility);
          this._visibilityListener = null;
          setTimeout(() => {
            if (this._pendingCapture === pending) {
              this._pendingCapture = null;
              resolve(null);
            }
          }, 600);
        }
      };
      this._visibilityListener = onVisibility;
      document.addEventListener('visibilitychange', onVisibility);

      this._fileInput.click();
    });
  },

  /**
   * Handle file selection from the camera/picker.
   */
  async _onFileSelected(event) {
    const pending = this._pendingCapture;
    this._pendingCapture = null;

    // Clean up the visibility safety-net listener
    if (this._visibilityListener) {
      document.removeEventListener('visibilitychange', this._visibilityListener);
      this._visibilityListener = null;
    }

    const file = event.target.files && event.target.files[0];
    if (!file || !pending) {
      if (pending) pending.resolve(null);
      return;
    }

    try {
      // Use an object URL instead of reading the whole file as base64 first.
      // This avoids a large memory spike (raw Android photos can be 15-25 MB
      // in base64) — the canvas only ever holds the resized output.
      const objectUrl = URL.createObjectURL(file);
      try {
        const resized   = await this._resizeImage(objectUrl, 1920);
        const thumbnail = await this._resizeImage(objectUrl, 300);

        const photo = await this.savePhoto(
          pending.jobId,
          resized,
          thumbnail,
          pending.category,
          file.name || `photo_${Date.now()}.jpg`
        );
        pending.resolve(photo);
      } finally {
        URL.revokeObjectURL(objectUrl); // release immediately
      }
    } catch (err) {
      console.error('Photo capture error:', err);
      pending.reject(err);
    }
  },

  /**
   * Save a photo to IndexedDB.
   */
  async savePhoto(jobId, base64Data, thumbnail, category, filename) {
    const photo = {
      temp_id: 'photo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      job_id: jobId,
      category: category,
      filename: filename,
      data: base64Data,
      thumbnail: thumbnail,
      timestamp: new Date().toISOString(),
      synced: 0,
    };

    await DB.put('photos', photo);
    return photo;
  },

  /**
   * Get all photos for a job from IndexedDB.
   */
  async getPhotosForJob(jobId) {
    return DB.getByIndex('photos', 'job_id', jobId);
  },

  /**
   * Delete a photo from IndexedDB.
   */
  async deletePhoto(tempId) {
    await DB.delete('photos', tempId);
  },

  /**
   * Fetch Drive photo link records for a job (online only).
   * Returns [] on any error so callers don't need to handle it.
   */
  async _loadDrivePhotos(jobId) {
    try {
      return await OdooAPI.getDrivePhotoLinks(jobId);
    } catch (e) {
      return [];
    }
  },

  /**
   * Convert a base64 data URL to a Blob.
   */
  _base64ToBlob(dataUrl, mimeType) {
    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType || 'image/jpeg' });
  },

  /**
   * Upload a single photo to Google Drive via the Odoo proxy.
   * On failure retries once, then falls back to ir.attachment.
   */
  async uploadPhoto(photo) {
    const blob = this._base64ToBlob(photo.data, 'image/jpeg');

    // Attempt Drive upload (with one retry)
    let driveResult = null;
    let driveError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        driveResult = await OdooAPI.uploadPhotoDrive(photo.job_id, photo.category, blob, 'photo.jpg');
        break;
      } catch (err) {
        driveError = err;
        if (attempt < 2) continue;
        console.warn('Drive upload failed after retry:', err);
      }
    }

    if (driveResult) {
      photo.synced = 1;
      photo.gdrive_file_id = driveResult.gdrive_file_id || null;
      photo.gdrive_url = driveResult.gdrive_url || null;
      await DB.put('photos', photo);
      // Chatter thumbnail posted server-side by upload_photo.py
      return driveResult.gdrive_file_id;
    }

    // Drive failed — fall back to ir.attachment so the photo isn't lost.
    const driveErrMsg = (driveError && driveError.message) || 'Unknown Drive error';
    console.error('Drive upload failed, using attachment fallback. Error:', driveErrMsg);

    const rawBase64 = photo.data.includes(',') ? photo.data.split(',')[1] : photo.data;
    const attachmentId = await OdooAPI.uploadPhoto(photo.job_id, rawBase64, photo.filename, photo.category);
    photo.synced = 1;
    photo.attachment_id = attachmentId;
    photo.drive_fallback = true;
    await DB.put('photos', photo);
    // Chatter note with inline image posted server-side by worker_upload_photo_attachment
    return attachmentId;
  },

  /**
   * Upload all unsynced photos.
   */
  async syncAll() {
    const unsynced = await DB.getUnsyncedItems('photos');
    let uploaded = 0;
    let failed = 0;

    for (const photo of unsynced) {
      try {
        await this.uploadPhoto(photo);
        uploaded++;
      } catch (err) {
        console.warn('Failed to upload photo:', photo.temp_id, err);
        failed++;
      }
    }

    return { uploaded, failed };
  },

  // ------------------------------------------------------------------
  // Photo counting helpers
  // ------------------------------------------------------------------

  /**
   * Get photo counts by category for a job (local pending only).
   * Used for stage gate checks — Drive photos are already synced.
   */
  async getPhotoCountsByCategory(jobId) {
    const photos = await this.getPhotosForJob(jobId);
    const counts = {};
    for (const cat of (CONFIG.PHOTO_CATEGORIES || [])) {
      counts[cat.key] = photos.filter(p => p.category === cat.key).length;
    }
    return counts;
  },

  // ------------------------------------------------------------------
  // UI rendering
  // ------------------------------------------------------------------

  /**
   * Render a filtered photo section — only specified category keys.
   * Shows local photos (synced + pending) plus Drive-only photos from other devices.
   *
   * @param {number} jobId
   * @param {HTMLElement} container
   * @param {string[]} categoryKeys - e.g. ['equipment', 'before']
   * @param {Function} [onPhotoAdded] - callback after a photo is captured
   */
  async renderFilteredPhotoSection(jobId, container, categoryKeys, onPhotoAdded) {
    const [allLocal, drivePhotos] = await Promise.all([
      this.getPhotosForJob(jobId),
      this._loadDrivePhotos(jobId),
    ]);

    // Drive-only: photos from other devices not yet in local IndexedDB
    const localDriveIds = new Set(allLocal.filter(p => p.gdrive_file_id).map(p => p.gdrive_file_id));
    const driveOnly = drivePhotos.filter(p => !localDriveIds.has(p.gdrive_file_id));

    const categories = (CONFIG.PHOTO_CATEGORIES || []).filter(c => categoryKeys.includes(c.key));

    let html = '';
    let addedDivider = false;
    for (const cat of categories) {
      if (!addedDivider && !cat.required) {
        addedDivider = true;
        html += `<div class="photo-section-divider">
          <span class="photo-section-divider-label">Optional</span>
        </div>`;
      }

      const catPhotos = allLocal.filter(p => p.category === cat.key);
      const catDrive = driveOnly.filter(p => p.category === cat.key);
      const totalCount = catPhotos.length + catDrive.length;
      const countLabel = cat.required ? `${totalCount}/${cat.required}` : `${totalCount}`;
      const isComplete = cat.required ? totalCount >= cat.required : totalCount > 0;

      html += `
        <div class="photo-category">
          <div class="photo-category-header">
            <span class="photo-category-title">${cat.label}</span>
            <span class="photo-count ${isComplete ? 'complete' : ''}">${countLabel}</span>
          </div>
          <div class="photo-grid" id="photos_${cat.key}_grid">
            ${this._renderThumbnails(catPhotos)}
            ${this._renderDriveThumbnails(catDrive)}
            <button class="photo-add-btn" data-category="${cat.key}" data-job-id="${jobId}">
              <span class="photo-add-icon">+</span>
              <span class="photo-add-label">Add</span>
            </button>
          </div>
        </div>`;
    }

    container.innerHTML = html;
    this._bindThumbnailEvents(container, jobId, categoryKeys, onPhotoAdded, 'filtered');
  },

  /**
   * Render a read-only gallery of all photos for a job, grouped by category.
   * Merges local IndexedDB photos with Drive-only photos from other devices.
   */
  async renderAllPhotosGallery(jobId, container) {
    const [allLocal, drivePhotos, discoveryPhotos] = await Promise.all([
      this.getPhotosForJob(jobId),
      this._loadDrivePhotos(jobId),
      this._loadDiscoveryPhotos(jobId),
    ]);

    // Drive-only: photos from other devices not yet in local IndexedDB
    const localDriveIds = new Set(allLocal.filter(p => p.gdrive_file_id).map(p => p.gdrive_file_id));
    const driveOnly = drivePhotos.filter(p => !localDriveIds.has(p.gdrive_file_id));

    const categories = CONFIG.PHOTO_CATEGORIES || [];
    const lbItems = [];  // built in render order for lightbox navigation

    if (allLocal.length === 0 && driveOnly.length === 0 && discoveryPhotos.length === 0) {
      container.innerHTML = '<p style="color:var(--text-secondary); font-size:var(--font-size-small); text-align:center; padding:var(--spacing-md);">No photos captured yet.</p>';
      return;
    }

    let html = '';
    for (const cat of categories) {
      const catLocal = allLocal.filter(p => p.category === cat.key);
      const catDrive = driveOnly.filter(p => p.category === cat.key);
      if (catLocal.length === 0 && catDrive.length === 0) continue;

      const localStart = lbItems.length;
      catLocal.forEach(p => lbItems.push({ src: p.data, caption: cat.label, type: 'local', tempId: p.temp_id, synced: p.synced, jobId }));
      const driveStart = lbItems.length;
      catDrive.forEach(p => lbItems.push({ src: `https://drive.google.com/thumbnail?id=${p.gdrive_file_id}&sz=w1600`, caption: `${cat.label} · ${p.filename}`, type: 'drive', note: p.note || '', gdriveFileId: p.gdrive_file_id, orderId: jobId }));

      html += `
        <div class="photo-category photo-category-readonly">
          <div class="photo-category-header">
            <span class="photo-category-title">${cat.label}</span>
            <span class="photo-count complete">${catLocal.length + catDrive.length}</span>
          </div>
          <div class="photo-grid">
            ${this._renderThumbnails(catLocal, localStart)}
            ${this._renderDriveThumbnails(catDrive, driveStart)}
          </div>
        </div>`;
    }

    if (discoveryPhotos.length) {
      const discStart = lbItems.length;
      discoveryPhotos.forEach(p => lbItems.push({ src: `https://drive.google.com/thumbnail?id=${p.file_id}&sz=w1600`, caption: `Discovery · ${p.name}`, type: 'discovery' }));
      html += `
        <div class="photo-category photo-category-readonly">
          <div class="photo-category-header">
            <span class="photo-category-title">Discovery Assets</span>
            <span class="photo-count complete">${discoveryPhotos.length}</span>
          </div>
          <div class="photo-grid">
            ${this._renderDiscoveryThumbnails(discoveryPhotos, discStart)}
          </div>
        </div>`;
    }

    container.innerHTML = html || '<p style="color:var(--text-secondary); font-size:var(--font-size-small); text-align:center; padding:var(--spacing-md);">No photos captured yet.</p>';
    container.querySelectorAll('[data-lb-idx]').forEach(thumb => {
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        this._showLightbox(lbItems, parseInt(thumb.dataset.lbIdx, 10));
      });
    });
  },

  /**
   * Render the photo section for a job's detail view.
   * Merges local IndexedDB photos with Drive-only photos from other devices.
   */
  async renderPhotoSection(jobId, container) {
    const [allLocal, drivePhotos] = await Promise.all([
      this.getPhotosForJob(jobId),
      this._loadDrivePhotos(jobId),
    ]);

    // Drive-only: photos from other devices not yet in local IndexedDB
    const localDriveIds = new Set(allLocal.filter(p => p.gdrive_file_id).map(p => p.gdrive_file_id));
    const driveOnly = drivePhotos.filter(p => !localDriveIds.has(p.gdrive_file_id));

    const categories = CONFIG.PHOTO_CATEGORIES || [
      { key: 'before', label: 'Before Photos', required: 2 },
      { key: 'after', label: 'After Photos', required: 2 },
    ];

    const lbItems = [];
    let html = '';
    let addedDivider = false;
    for (const cat of categories) {
      if (!addedDivider && !cat.required) {
        addedDivider = true;
        html += `<div class="photo-section-divider">
          <span class="photo-section-divider-label">Optional</span>
        </div>`;
      }

      const catLocal = allLocal.filter(p => p.category === cat.key);
      const catDrive = driveOnly.filter(p => p.category === cat.key);
      const totalCount = catLocal.length + catDrive.length;
      const countLabel = cat.required ? `${totalCount}/${cat.required}` : `${totalCount}`;
      const isComplete = cat.required ? totalCount >= cat.required : totalCount > 0;

      const localStart = lbItems.length;
      catLocal.forEach(p => lbItems.push({ src: p.data, caption: cat.label, type: 'local', tempId: p.temp_id, synced: p.synced, jobId }));
      const driveStart = lbItems.length;
      catDrive.forEach(p => lbItems.push({ src: `https://drive.google.com/thumbnail?id=${p.gdrive_file_id}&sz=w1600`, caption: `${cat.label} · ${p.filename}`, type: 'drive', note: p.note || '', gdriveFileId: p.gdrive_file_id, orderId: jobId }));

      html += `
        <div class="photo-category">
          <div class="photo-category-header">
            <span class="photo-category-title">${cat.label}</span>
            <span class="photo-count ${isComplete ? 'complete' : ''}">${countLabel}</span>
          </div>
          <div class="photo-grid" id="photos_${cat.key}_grid">
            ${this._renderThumbnails(catLocal, localStart)}
            ${this._renderDriveThumbnails(catDrive, driveStart)}
            <button class="photo-add-btn" data-category="${cat.key}" data-job-id="${jobId}">
              <span class="photo-add-icon">+</span>
              <span class="photo-add-label">Add</span>
            </button>
          </div>
        </div>`;
    }

    container.innerHTML = html;
    this._bindThumbnailEvents(container, jobId, null, null, 'full', lbItems);
  },

  /**
   * Render thumbnail grid HTML for local photos.
   * lbStart: index of first item in the shared lightbox array (null = no lightbox).
   */
  _renderThumbnails(photos, lbStart) {
    return photos.map((p, i) => {
      const icon = p.synced
        ? '<span class="photo-synced-icon" title="Synced to Drive">&#10003;</span>'
        : '<span class="photo-pending-icon" title="Pending upload">&#8635;</span>';
      const lbAttr = lbStart != null ? `data-lb-idx="${lbStart + i}"` : '';
      return `
        <div class="photo-thumb photo-thumb-local" data-temp-id="${p.temp_id}" ${lbAttr}>
          <img src="${p.thumbnail}" alt="${p.category}" loading="lazy">
          ${icon}
        </div>`;
    }).join('');
  },

  /**
   * Render Drive thumbnail grid HTML for synced photos.
   * lbStart: index of first item in the shared lightbox array.
   */
  _renderDriveThumbnails(drivePhotos, lbStart) {
    return drivePhotos.map((p, i) => {
      const thumbUrl = `https://drive.google.com/thumbnail?id=${p.gdrive_file_id}&sz=w400`;
      const lbAttr = lbStart != null ? `data-lb-idx="${lbStart + i}"` : '';
      return `
        <div class="photo-thumb photo-thumb-drive" data-file-id="${p.gdrive_file_id}" title="${p.filename}" ${lbAttr}>
          <img src="${thumbUrl}" alt="${p.category}" loading="lazy">
          <span class="photo-synced-icon" title="Synced to Drive">&#10003;</span>
        </div>
      `;
    }).join('');
  },

  /**
   * Render discovery asset thumbnail HTML.
   */
  _renderDiscoveryThumbnails(items, lbStart) {
    return items.map((p, i) => {
      const thumbUrl = `https://drive.google.com/thumbnail?id=${p.file_id}&sz=w400`;
      return `
        <div class="photo-thumb photo-thumb-drive photo-thumb-discovery" data-file-id="${p.file_id}" title="${p.name}" data-lb-idx="${lbStart + i}">
          <img src="${thumbUrl}" alt="${p.name}" loading="lazy">
          <span class="photo-discovery-badge" title="Discovery Asset">&#9733;</span>
        </div>`;
    }).join('');
  },

  /**
   * Fetch discovery asset photos for a job from the server.
   * Returns [] if the gdrive_integration module isn't active or no folder found.
   */
  async _loadDiscoveryPhotos(jobId) {
    if (!navigator.onLine) return [];
    try {
      return await OdooAPI.getDiscoveryPhotos(jobId) || [];
    } catch (e) {
      return [];
    }
  },

  /**
   * Show a full-screen in-app lightbox for a list of photos.
   * items: [{ src, caption, type, tempId? }]
   *   src      — full-res URL or base64
   *   caption  — display text below image
   *   type     — 'local' | 'drive' | 'discovery'
   *   tempId   — set for local photos that can be deleted
   */
  _showLightbox(items, startIndex) {
    if (!items || !items.length) return;
    let current = Math.max(0, Math.min(startIndex, items.length - 1));

    const existing = document.getElementById('photoLightbox');
    if (existing) existing.remove();

    const multi = items.length > 1;
    const lb = document.createElement('div');
    lb.id = 'photoLightbox';
    lb.className = 'photo-lightbox';
    lb.innerHTML = `
      <div class="photo-lightbox-top">
        <span class="photo-lightbox-counter"></span>
        <button class="photo-lightbox-close">&times;</button>
      </div>
      <div class="photo-lightbox-stage">
        <button class="photo-lightbox-nav photo-lightbox-prev" ${multi ? '' : 'style="visibility:hidden"'}>&#8249;</button>
        <div class="photo-lightbox-img-wrap">
          <img class="photo-lightbox-img" src="" alt="">
          <div class="photo-lightbox-spinner">Loading…</div>
        </div>
        <button class="photo-lightbox-nav photo-lightbox-next" ${multi ? '' : 'style="visibility:hidden"'}>&#8250;</button>
      </div>
      <div class="photo-lightbox-footer">
        <div class="photo-lightbox-caption-row">
          <span class="photo-lightbox-caption"></span>
        </div>
        <div class="photo-lightbox-note-row">
          <span class="photo-lightbox-note"></span>
          <button class="photo-lightbox-note-edit" title="Edit note" style="display:none;">✏️</button>
        </div>
        <div class="photo-lightbox-note-edit-row" style="display:none;">
          <textarea class="photo-lightbox-note-input" rows="2" placeholder="Add a note..."></textarea>
          <div class="photo-lightbox-note-actions">
            <button class="photo-lightbox-note-save btn btn-primary btn-sm">Save</button>
            <button class="photo-lightbox-note-cancel btn btn-secondary btn-sm">Cancel</button>
          </div>
        </div>
        <button class="photo-lightbox-delete btn btn-danger btn-sm" style="display:none;">Delete</button>
      </div>`;
    document.body.appendChild(lb);

    const img        = lb.querySelector('.photo-lightbox-img');
    const spinner    = lb.querySelector('.photo-lightbox-spinner');
    const caption    = lb.querySelector('.photo-lightbox-caption');
    const counter    = lb.querySelector('.photo-lightbox-counter');
    const delBtn     = lb.querySelector('.photo-lightbox-delete');
    const noteEl     = lb.querySelector('.photo-lightbox-note');
    const noteEditBtn = lb.querySelector('.photo-lightbox-note-edit');
    const noteEditRow = lb.querySelector('.photo-lightbox-note-edit-row');
    const noteInput  = lb.querySelector('.photo-lightbox-note-input');
    const noteSaveBtn = lb.querySelector('.photo-lightbox-note-save');
    const noteCancelBtn = lb.querySelector('.photo-lightbox-note-cancel');

    const closeNoteEdit = () => {
      noteEditRow.style.display = 'none';
      lb.querySelector('.photo-lightbox-note-row').style.display = '';
    };

    const show = (idx) => {
      current = ((idx % items.length) + items.length) % items.length;
      const item = items[current];
      img.style.opacity = '0';
      spinner.style.display = 'block';
      img.onload  = () => { spinner.style.display = 'none'; img.style.opacity = '1'; };
      img.onerror = () => { spinner.textContent = 'Image unavailable — may require Google sign-in'; };
      img.src = item.src;
      caption.textContent = item.caption || '';
      counter.textContent = multi ? `${current + 1} / ${items.length}` : '';
      delBtn.style.display = (item.type === 'local' && item.tempId && !item.synced) ? '' : 'none';
      delBtn.dataset.tempId = item.tempId || '';
      delBtn.dataset.jobId  = item.jobId  || '';
      // Note display (drive photos only)
      const canNote = item.type === 'drive' && item.gdriveFileId;
      noteEl.textContent = item.note || (canNote ? '' : '');
      noteEl.style.display = (item.note || canNote) ? '' : 'none';
      if (!item.note && canNote) {
        noteEl.textContent = '';
        noteEl.style.fontStyle = 'italic';
        noteEl.style.opacity = '0.45';
        noteEl.textContent = 'Add a note…';
      } else if (item.note) {
        noteEl.style.fontStyle = '';
        noteEl.style.opacity = '';
        noteEl.textContent = item.note;
      }
      noteEditBtn.style.display = canNote ? '' : 'none';
      closeNoteEdit();
    };

    const close = () => {
      lb.remove();
      document.removeEventListener('keydown', onKey);
    };

    lb.querySelector('.photo-lightbox-close').addEventListener('click', close);
    lb.addEventListener('click', (e) => { if (e.target === lb || e.target.classList.contains('photo-lightbox-stage')) close(); });
    lb.querySelector('.photo-lightbox-prev').addEventListener('click', (e) => { e.stopPropagation(); show(current - 1); });
    lb.querySelector('.photo-lightbox-next').addEventListener('click', (e) => { e.stopPropagation(); show(current + 1); });

    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this photo?')) return;
      const tid = delBtn.dataset.tempId;
      const jid = parseInt(delBtn.dataset.jobId, 10);
      await this.deletePhoto(tid);
      close();
      const section = document.getElementById('photoSection');
      if (section && jid) await this.renderPhotoSection(jid, section);
      App.showToast('Photo deleted', 'success');
    });

    noteEditBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      noteInput.value = items[current].note || '';
      lb.querySelector('.photo-lightbox-note-row').style.display = 'none';
      noteEditRow.style.display = '';
      noteInput.focus();
    });

    noteCancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeNoteEdit();
    });

    noteSaveBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = items[current];
      if (!item.gdriveFileId || !item.orderId) return;
      noteSaveBtn.disabled = true;
      noteSaveBtn.textContent = 'Saving…';
      try {
        const note = noteInput.value.trim();
        await OdooAPI.updatePhotoNote(item.orderId, item.gdriveFileId, note);
        items[current] = { ...item, note };
        App.showToast('Note saved', 'success');
        closeNoteEdit();
        show(current);
      } catch (err) {
        App.showToast('Failed to save note: ' + (err.message || ''), 'error');
      } finally {
        noteSaveBtn.disabled = false;
        noteSaveBtn.textContent = 'Save';
      }
    });

    const onKey = (e) => {
      if (e.key === 'Escape')     close();
      if (e.key === 'ArrowRight') show(current + 1);
      if (e.key === 'ArrowLeft')  show(current - 1);
    };
    document.addEventListener('keydown', onKey);

    // Swipe + pinch-to-zoom
    let touchX = 0;
    let zoomScale = 1;
    let pinchDist0 = 0;
    const imgWrap = lb.querySelector('.photo-lightbox-img-wrap');

    lb.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinchDist0 = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
      } else if (e.touches.length === 1) {
        touchX = e.touches[0].clientX;
      }
    }, { passive: true });

    lb.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        if (pinchDist0 > 0) {
          zoomScale = Math.max(1, Math.min(5, zoomScale * (dist / pinchDist0)));
          img.style.transform = `scale(${zoomScale})`;
          img.style.transformOrigin = 'center center';
        }
        pinchDist0 = dist;
      }
    }, { passive: false });

    lb.addEventListener('touchend', (e) => {
      pinchDist0 = 0;
      if (e.touches.length === 0 && zoomScale <= 1.05) {
        zoomScale = 1;
        img.style.transform = '';
      }
      // Only allow swipe navigation when not zoomed
      if (zoomScale <= 1.05 && e.changedTouches.length === 1) {
        const dx = e.changedTouches[0].clientX - touchX;
        if (Math.abs(dx) > 50) show(dx < 0 ? current + 1 : current - 1);
      }
    });

    show(current);
  },

  /**
   * Bind all thumbnail and add-button events on a container.
   * lbItems: flat ordered lightbox array built during render (may be empty).
   */
  _bindThumbnailEvents(container, jobId, categoryKeys, onPhotoAdded, mode, lbItems) {
    const rerender = async (jid) => {
      if (mode === 'filtered') {
        await this.renderFilteredPhotoSection(jid, container, categoryKeys, onPhotoAdded);
      } else {
        await this.renderPhotoSection(jid, container);
      }
    };

    // Add-photo buttons
    container.querySelectorAll('.photo-add-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const cat = btn.dataset.category;
        const jid = parseInt(btn.dataset.jobId, 10);
        try {
          const photo = await this.capturePhoto(jid, cat);
          if (!photo) return;

          await rerender(jid);
          if (onPhotoAdded) onPhotoAdded();

          if (navigator.onLine) {
            App.showToast('Photo saved — uploading…', 'info');
            try {
              await this.uploadPhoto(photo);
              await rerender(jid);
              App.showToast('Photo uploaded', 'success');
            } catch (err) {
              console.warn('Immediate photo upload failed, queued for sync:', err);
              App.showToast('Photo saved — upload failed, will retry on sync', 'error');
            }
          } else {
            App.showToast('Photo saved — will upload when online', 'info');
          }
        } catch (err) {
          console.error('Photo capture error:', err);
          App.showToast('Failed to capture photo', 'error');
        }
      });
    });

    // All thumbnails with data-lb-idx → lightbox
    if (lbItems && lbItems.length) {
      container.querySelectorAll('[data-lb-idx]').forEach(thumb => {
        thumb.addEventListener('click', (e) => {
          e.stopPropagation();
          this._showLightbox(lbItems, parseInt(thumb.dataset.lbIdx, 10));
        });
      });
    }
  },


  // ------------------------------------------------------------------
  // Image processing helpers
  // ------------------------------------------------------------------

  _resizeImage(dataUrl, maxWidth) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > maxWidth) {
          h = Math.round(h * (maxWidth / w));
          w = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = dataUrl;
    });
  },
};
