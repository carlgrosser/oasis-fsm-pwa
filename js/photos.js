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
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        driveResult = await OdooAPI.uploadPhotoDrive(photo.job_id, photo.category, blob, 'photo.jpg');
        break;
      } catch (err) {
        if (attempt === 2) {
          console.warn('Drive upload failed after retry, falling back to attachment:', err);
        }
      }
    }

    if (driveResult) {
      photo.synced = 1;
      photo.gdrive_file_id = driveResult.gdrive_file_id || null;
      photo.gdrive_url = driveResult.gdrive_url || null;
      await DB.put('photos', photo);
      OdooAPI.postSystemNote(photo.job_id, `Photo uploaded: ${photo.category}`).catch(() => {});
      return driveResult.gdrive_file_id;
    }

    // Fallback: store as ir.attachment with a flag for later migration
    const rawBase64 = photo.data.includes(',') ? photo.data.split(',')[1] : photo.data;
    const attachmentId = await OdooAPI.uploadPhoto(photo.job_id, rawBase64, photo.filename, photo.category);
    photo.synced = 1;
    photo.attachment_id = attachmentId;
    photo.drive_fallback = true;
    await DB.put('photos', photo);
    OdooAPI.postSystemNote(photo.job_id, `Photo uploaded: ${photo.category}`).catch(() => {});
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
    const [allLocal, drivePhotos] = await Promise.all([
      this.getPhotosForJob(jobId),
      this._loadDrivePhotos(jobId),
    ]);

    // Drive-only: photos from other devices not yet in local IndexedDB
    const localDriveIds = new Set(allLocal.filter(p => p.gdrive_file_id).map(p => p.gdrive_file_id));
    const driveOnly = drivePhotos.filter(p => !localDriveIds.has(p.gdrive_file_id));

    const categories = CONFIG.PHOTO_CATEGORIES || [];

    if (allLocal.length === 0 && driveOnly.length === 0) {
      container.innerHTML = '<p style="color:var(--text-secondary); font-size:var(--font-size-small); text-align:center; padding:var(--spacing-md);">No photos captured yet.</p>';
      return;
    }

    let html = '';
    for (const cat of categories) {
      const catPhotos = allLocal.filter(p => p.category === cat.key);
      const catDrive = driveOnly.filter(p => p.category === cat.key);
      if (catPhotos.length === 0 && catDrive.length === 0) continue;

      const totalCount = catPhotos.length + catDrive.length;
      html += `
        <div class="photo-category photo-category-readonly">
          <div class="photo-category-header">
            <span class="photo-category-title">${cat.label}</span>
            <span class="photo-count complete">${totalCount}</span>
          </div>
          <div class="photo-grid">
            ${this._renderThumbnails(catPhotos)}
            ${this._renderDriveThumbnails(catDrive)}
          </div>
        </div>`;
    }

    container.innerHTML = html || '<p style="color:var(--text-secondary); font-size:var(--font-size-small); text-align:center; padding:var(--spacing-md);">No photos captured yet.</p>';
    container.querySelectorAll('.photo-thumb-local').forEach(thumb => {
      thumb.addEventListener('click', () => this._showFullPhoto(thumb.dataset.tempId));
    });
    this._bindDriveThumbEvents(container);
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
    this._bindThumbnailEvents(container, jobId, null, null, 'full');
  },

  /**
   * Render thumbnail grid HTML for local photos (both synced and pending).
   * Uses local base64 thumbnails to avoid Drive auth issues.
   */
  _renderThumbnails(photos) {
    return photos.map(p => {
      const icon = p.synced
        ? '<span class="photo-synced-icon" title="Synced to Drive">&#10003;</span>'
        : '<span class="photo-pending-icon" title="Pending upload">&#8635;</span>';
      return `
        <div class="photo-thumb photo-thumb-local" data-temp-id="${p.temp_id}">
          <img src="${p.thumbnail}" alt="${p.category}" loading="lazy">
          ${icon}
        </div>`;
    }).join('');
  },

  /**
   * Render Drive thumbnail grid HTML for synced photos.
   */
  _renderDriveThumbnails(drivePhotos) {
    return drivePhotos.map(p => {
      const thumbUrl = `https://drive.google.com/thumbnail?id=${p.gdrive_file_id}&sz=w400`;
      return `
        <div class="photo-thumb photo-thumb-drive" data-drive-url="${p.gdrive_url}" data-file-id="${p.gdrive_file_id}" title="${p.filename}">
          <img src="${thumbUrl}" alt="${p.category}" loading="lazy">
          <span class="photo-synced-icon" title="Synced to Drive">&#10003;</span>
        </div>
      `;
    }).join('');
  },

  /**
   * Bind all thumbnail and add-button events on a container.
   */
  _bindThumbnailEvents(container, jobId, categoryKeys, onPhotoAdded, mode) {
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

          // Show thumbnail immediately (pending indicator)
          await rerender(jid);
          if (onPhotoAdded) onPhotoAdded();

          // Attempt immediate upload in background while online
          if (navigator.onLine) {
            App.showToast('Photo saved — uploading…', 'info');
            try {
              await this.uploadPhoto(photo);
              // Re-render to flip pending → synced checkmark
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

    // Drive thumbnails — open in new tab
    this._bindDriveThumbEvents(container);

    // Local pending thumbnails — show overlay
    container.querySelectorAll('.photo-thumb-local').forEach(thumb => {
      thumb.addEventListener('click', () => this._showFullPhoto(thumb.dataset.tempId));
    });
  },

  /**
   * Bind Drive thumbnail click events — opens Drive URL in new tab.
   */
  _bindDriveThumbEvents(container) {
    container.querySelectorAll('.photo-thumb-drive').forEach(thumb => {
      thumb.addEventListener('click', () => {
        const url = thumb.dataset.driveUrl;
        if (url) window.open(url, '_blank');
      });
    });
  },

  /**
   * Show a full-size local photo in an overlay with delete option.
   */
  async _showFullPhoto(tempId) {
    const photo = await DB.get('photos', tempId);
    if (!photo) return;

    const overlay = document.createElement('div');
    overlay.className = 'photo-overlay';
    overlay.innerHTML = `
      <div class="photo-overlay-header">
        <span>${photo.category} - ${new Date(photo.timestamp).toLocaleString()}</span>
        <button class="photo-overlay-close">&times;</button>
      </div>
      <div class="photo-overlay-body">
        <img src="${photo.data}" alt="${photo.category}">
      </div>
      <div class="photo-overlay-actions">
        <button class="btn btn-danger btn-sm" id="photoDeleteBtn">Delete Photo</button>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.photo-overlay-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#photoDeleteBtn').addEventListener('click', async () => {
      if (confirm('Delete this photo?')) {
        await this.deletePhoto(tempId);
        close();
        const section = document.getElementById('photoSection');
        if (section) await this.renderPhotoSection(photo.job_id, section);
        App.showToast('Photo deleted', 'success');
      }
    });
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
