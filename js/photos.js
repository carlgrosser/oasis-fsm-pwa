/**
 * Photos module — camera capture, gallery, IndexedDB storage, upload.
 *
 * Upload destination is pluggable: currently sends to ir.attachment (base Odoo).
 * Can be swapped to Google Drive once the integration module is available.
 */
const Photos = {
  _fileInput: null,
  _pendingCapture: null, // { jobId, category, resolve, reject }

  /**
   * Initialize — create the hidden file input used for camera capture.
   */
  init() {
    if (this._fileInput) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment'; // rear camera
    input.style.display = 'none';
    input.id = 'photoCaptureInput';
    document.body.appendChild(input);
    this._fileInput = input;

    input.addEventListener('change', (e) => this._onFileSelected(e));
  },

  /**
   * Launch the camera / file picker for a specific job and category.
   *
   * @param {number} jobId
   * @param {string} category - 'before' or 'after'
   * @returns {Promise<object|null>} - The saved photo record, or null if cancelled.
   */
  capturePhoto(jobId, category) {
    this.init();

    return new Promise((resolve, reject) => {
      this._pendingCapture = { jobId, category, resolve, reject };
      // Reset the input so the same file can be picked again
      this._fileInput.value = '';
      this._fileInput.click();
    });
  },

  /**
   * Handle file selection from the camera/picker.
   */
  async _onFileSelected(event) {
    const pending = this._pendingCapture;
    this._pendingCapture = null;

    const file = event.target.files && event.target.files[0];
    if (!file || !pending) {
      if (pending) pending.resolve(null);
      return;
    }

    try {
      // Read file as base64
      const base64Full = await this._readFileAsBase64(file);

      // Create a reasonably-sized version for upload (max 1920px wide)
      const resized = await this._resizeImage(base64Full, 1920);

      // Create thumbnail (max 300px wide)
      const thumbnail = await this._resizeImage(base64Full, 300);

      const photo = await this.savePhoto(
        pending.jobId,
        resized,
        thumbnail,
        pending.category,
        file.name || `photo_${Date.now()}.jpg`
      );

      pending.resolve(photo);
    } catch (err) {
      console.error('Photo capture error:', err);
      pending.reject(err);
    }
  },

  /**
   * Save a photo to IndexedDB.
   *
   * @param {number} jobId
   * @param {string} base64Data - Full-size base64 (data URL)
   * @param {string} thumbnail  - Thumbnail base64 (data URL)
   * @param {string} category   - 'before' or 'after'
   * @param {string} filename
   * @returns {Promise<object>} - The stored photo record.
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
   * Upload a single photo to Odoo (ir.attachment).
   * This method is the pluggable point — swap for Google Drive later.
   */
  async uploadPhoto(photo) {
    // Strip the data URL prefix to get raw base64 for Odoo
    const rawBase64 = photo.data.includes(',')
      ? photo.data.split(',')[1]
      : photo.data;

    const attachmentId = await OdooAPI.uploadPhoto(
      photo.job_id,
      rawBase64,
      photo.filename,
      photo.category
    );

    // Mark as synced
    photo.synced = 1;
    photo.attachment_id = attachmentId;
    await DB.put('photos', photo);

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
  // UI rendering
  // ------------------------------------------------------------------

  /**
   * Render the photo section for a job's detail view.
   *
   * @param {number} jobId
   * @param {HTMLElement} container
   */
  async renderPhotoSection(jobId, container) {
    const photos = await this.getPhotosForJob(jobId);
    const categories = CONFIG.PHOTO_CATEGORIES || [
      { key: 'before', label: 'Before Photos', required: 2 },
      { key: 'after', label: 'After Photos', required: 2 },
    ];

    let html = '';
    let addedDivider = false;
    for (const cat of categories) {
      // Insert a divider when transitioning from required to optional
      if (!addedDivider && !cat.required) {
        addedDivider = true;
        html += `<div class="photo-section-divider">
          <span class="photo-section-divider-label">Optional</span>
        </div>`;
      }

      const catPhotos = photos.filter(p => p.category === cat.key);
      const countLabel = cat.required
        ? `${catPhotos.length}/${cat.required}`
        : `${catPhotos.length}`;
      const isComplete = cat.required ? catPhotos.length >= cat.required : catPhotos.length > 0;

      html += `
        <div class="photo-category">
          <div class="photo-category-header">
            <span class="photo-category-title">${cat.label}</span>
            <span class="photo-count ${isComplete ? 'complete' : ''}">${countLabel}</span>
          </div>
          <div class="photo-grid" id="photos_${cat.key}_grid">
            ${this._renderThumbnails(catPhotos)}
            <button class="photo-add-btn" data-category="${cat.key}" data-job-id="${jobId}">
              <span class="photo-add-icon">+</span>
              <span class="photo-add-label">Add</span>
            </button>
          </div>
        </div>`;
    }

    container.innerHTML = html;

    // Bind add-photo buttons
    container.querySelectorAll('.photo-add-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const cat = btn.dataset.category;
        const jid = parseInt(btn.dataset.jobId, 10);
        try {
          const photo = await this.capturePhoto(jid, cat);
          if (photo) {
            // Re-render the section
            await this.renderPhotoSection(jid, container);
            App.showToast('Photo added', 'success');
          }
        } catch (err) {
          App.showToast('Failed to capture photo', 'error');
        }
      });
    });

    // Bind thumbnail clicks (view full size)
    container.querySelectorAll('.photo-thumb').forEach(thumb => {
      thumb.addEventListener('click', () => {
        this._showFullPhoto(thumb.dataset.tempId);
      });
    });
  },

  /**
   * Render thumbnail grid HTML for a list of photos.
   */
  _renderThumbnails(photos) {
    return photos.map(p => `
      <div class="photo-thumb" data-temp-id="${p.temp_id}">
        <img src="${p.thumbnail}" alt="${p.category}" loading="lazy">
        ${p.synced ? '<span class="photo-synced-icon">&#10003;</span>' : '<span class="photo-pending-icon">&#8635;</span>'}
      </div>
    `).join('');
  },

  /**
   * Show a full-size photo in an overlay.
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

    // Close overlay
    const close = () => overlay.remove();
    overlay.querySelector('.photo-overlay-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    // Delete photo
    overlay.querySelector('#photoDeleteBtn').addEventListener('click', async () => {
      if (confirm('Delete this photo?')) {
        await this.deletePhoto(tempId);
        close();
        // Re-render the photo section if it exists in the DOM
        const section = document.getElementById('photoSection');
        if (section) {
          await this.renderPhotoSection(photo.job_id, section);
        }
        App.showToast('Photo deleted', 'success');
      }
    });
  },

  // ------------------------------------------------------------------
  // Image processing helpers
  // ------------------------------------------------------------------

  /**
   * Read a File as a base64 data URL.
   */
  _readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  },

  /**
   * Resize an image (data URL) to a maximum width, preserving aspect ratio.
   * Returns a JPEG data URL.
   */
  _resizeImage(dataUrl, maxWidth) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;

        // Only downscale, never upscale
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
