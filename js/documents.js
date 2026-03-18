/**
 * Documents module — multi-section Drive viewer for a job.
 *
 * Sections:
 *   Project Photos   — files from the Drive Project Photos folder
 *   Discovery Assets — files from the Drive Discovery Assets folder
 *   Documents        — files from the Drive Documents folder
 *   Maps             — (placeholder, coming soon)
 *
 * All three file sections use the same docs-file-item grid structure so the
 * global grid/list toggle (☰ / ⊞) in the modal header applies uniformly.
 *
 * Opened via the 📄 footer button on the job detail view.
 */
const Documents = {

  async showPanel(job) {
    const existing = document.getElementById('documentsModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'documentsModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal modal-documents">
        <div class="modal-header">
          <h3>Files &amp; Media</h3>
          <button class="docs-view-toggle" id="docsViewToggle" title="Toggle view">&#9776;</button>
          <button class="modal-close" id="documentsClose">&times;</button>
        </div>
        <div class="modal-body" id="documentsBody">

          <div class="docs-section" id="docsProjectPhotos">
            <div class="docs-section-header">
              <span class="docs-section-title">Project Photos</span>
              <span class="docs-section-count" id="docsPhotosCount"></span>
            </div>
            <div class="docs-section-body" id="docsPhotosBody">
              <div class="loading"><div class="spinner"></div></div>
            </div>
          </div>

          <div class="docs-section" id="docsDiscovery">
            <div class="docs-section-header">
              <span class="docs-section-title">Discovery Assets</span>
              <span class="docs-section-count" id="docsDiscoveryCount"></span>
            </div>
            <div class="docs-section-body" id="docsDiscoveryBody">
              <div class="loading"><div class="spinner"></div></div>
            </div>
          </div>

          <div class="docs-section" id="docsDocuments">
            <div class="docs-section-header">
              <span class="docs-section-title">Documents</span>
              <span class="docs-section-count" id="docsDocsCount"></span>
            </div>
            <div class="docs-section-body" id="docsDocsBody">
              <div class="loading"><div class="spinner"></div></div>
            </div>
          </div>

          <div class="docs-section" id="docsMaps">
            <div class="docs-section-header">
              <span class="docs-section-title">Maps</span>
            </div>
            <div class="docs-section-body">
              <p class="docs-empty">Coming soon.</p>
            </div>
          </div>

        </div>
      </div>`;

    document.body.appendChild(modal);
    modal.querySelector('#documentsClose').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    // Global grid / list toggle — controls all sections at once
    const body = modal.querySelector('#documentsBody');
    modal.querySelector('#docsViewToggle').addEventListener('click', (e) => {
      e.stopPropagation();
      body.classList.toggle('list-view');
      e.currentTarget.innerHTML = body.classList.contains('list-view') ? '&#8984;' : '&#9776;';
    });

    // Load all sections in parallel
    this._loadProjectPhotos(job, modal);
    this._loadDiscovery(job, modal);
    this._loadDocuments(job, modal);
  },

  // ── Shared file-grid renderer ────────────────────────────────────────────────

  /**
   * Render a docs-file-grid from a list of {file_id, name, mime_type, view_url, modified_time}.
   * Returns { html, lbItems } where lbItems is the lightbox array for image files.
   */
  _renderGrid(files) {
    const images = files.filter(f => (f.mime_type || 'image/').startsWith('image/'));
    const others = files.filter(f => !(f.mime_type || 'image/').startsWith('image/'));

    const lbItems = images.map(f => ({
      src:  `https://drive.google.com/thumbnail?id=${f.file_id}&sz=w1600`,
      caption: f.name,
      type: 'drive',
    }));

    const html = `
      <div class="docs-file-grid">
        ${images.map((f, i) => `
          <div class="docs-file-item" data-lb-idx="${i}">
            <div class="docs-file-item-thumb">
              <img src="https://drive.google.com/thumbnail?id=${f.file_id}&sz=w400"
                   alt="${this._esc(f.name)}" loading="lazy"
                   onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
              <div class="docs-file-item-fallback" style="display:none">${this._icon(f.mime_type)}</div>
            </div>
            <div class="docs-file-item-info">
              <span class="docs-file-item-name">${this._esc(f.name)}</span>
              <span class="docs-file-item-meta">${this._esc(this._meta(f))}</span>
            </div>
          </div>`).join('')}
        ${others.map(f => `
          <a class="docs-file-item" href="${f.view_url}" target="_blank" rel="noopener">
            <div class="docs-file-item-thumb docs-file-item-icon-thumb">
              <span>${this._icon(f.mime_type)}</span>
            </div>
            <div class="docs-file-item-info">
              <span class="docs-file-item-name">${this._esc(f.name)}</span>
              <span class="docs-file-item-meta">${this._esc(this._meta(f))}</span>
            </div>
          </a>`).join('')}
      </div>`;

    return { html, lbItems };
  },

  _bindGrid(container, lbItems) {
    if (!lbItems.length) return;
    container.querySelectorAll('[data-lb-idx]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        Photos._showLightbox(lbItems, parseInt(el.dataset.lbIdx, 10));
      });
    });
  },

  // ── Project Photos ───────────────────────────────────────────────────────────

  async _loadProjectPhotos(job, modal) {
    const body  = modal.querySelector('#docsPhotosBody');
    const count = modal.querySelector('#docsPhotosCount');

    if (!navigator.onLine) {
      body.innerHTML = '<p class="docs-empty">Available when online.</p>';
      return;
    }

    try {
      const files = await OdooAPI.getProjectPhotos(job.id);

      if (!files || files.length === 0) {
        count.textContent = '';
        body.innerHTML = '<p class="docs-empty">No photos in the Project Photos folder.</p>';
        return;
      }

      count.textContent = files.length;
      const { html, lbItems } = this._renderGrid(files);
      body.innerHTML = html;
      this._bindGrid(body, lbItems);

    } catch (err) {
      body.innerHTML = `<p class="docs-empty">Could not load photos: ${this._esc(err.message || '')}</p>`;
    }
  },

  // ── Discovery Assets ─────────────────────────────────────────────────────────

  async _loadDiscovery(job, modal) {
    const body  = modal.querySelector('#docsDiscoveryBody');
    const count = modal.querySelector('#docsDiscoveryCount');

    if (!navigator.onLine) {
      body.innerHTML = '<p class="docs-empty">Available when online.</p>';
      return;
    }

    try {
      const items = await Photos._loadDiscoveryPhotos(job.id);

      if (!items || items.length === 0) {
        count.textContent = '';
        body.innerHTML = '<p class="docs-empty">No discovery assets found.</p>';
        return;
      }

      count.textContent = items.length;

      // Normalise to the same shape as _renderGrid expects
      const files = items.map(p => ({
        file_id:       p.file_id,
        name:          p.name,
        mime_type:     'image/jpeg',
        view_url:      p.view_url || '',
        modified_time: '',
      }));

      const { html, lbItems } = this._renderGrid(files);
      body.innerHTML = html;
      this._bindGrid(body, lbItems);

    } catch (err) {
      body.innerHTML = `<p class="docs-empty">Could not load discovery assets: ${this._esc(err.message || '')}</p>`;
    }
  },

  // ── Documents ────────────────────────────────────────────────────────────────

  async _loadDocuments(job, modal) {
    const body  = modal.querySelector('#docsDocsBody');
    const count = modal.querySelector('#docsDocsCount');

    if (!navigator.onLine) {
      body.innerHTML = '<p class="docs-empty">Available when online.</p>';
      return;
    }

    try {
      const files = await OdooAPI.getJobDocuments(job.id);

      if (!files || files.length === 0) {
        count.textContent = '';
        body.innerHTML = '<p class="docs-empty">No documents in the project Documents folder.</p>';
        return;
      }

      count.textContent = files.length;
      const { html, lbItems } = this._renderGrid(files);
      body.innerHTML = html;
      this._bindGrid(body, lbItems);

    } catch (err) {
      body.innerHTML = `<p class="docs-empty">Could not load documents: ${this._esc(err.message || '')}</p>`;
    }
  },

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _meta(f) {
    const parts = [this._typeLabel(f.mime_type)];
    if (f.modified_time) {
      const d = new Date(f.modified_time);
      if (!isNaN(d)) parts.push(d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }));
    }
    return parts.join(' · ');
  },

  _typeLabel(mime) {
    if (!mime) return 'File';
    if (mime.startsWith('image/'))                                             return 'Image';
    if (mime.includes('pdf'))                                                  return 'PDF';
    if (mime.includes('spreadsheet') || mime.includes('excel'))               return 'Spreadsheet';
    if (mime.includes('presentation') || mime.includes('powerpoint'))         return 'Presentation';
    if (mime.includes('document') || mime.includes('word'))                   return 'Document';
    if (mime.includes('video'))                                                return 'Video';
    if (mime.includes('audio'))                                                return 'Audio';
    return 'File';
  },

  _icon(mimeType) {
    if (!mimeType) return '📎';
    if (mimeType.startsWith('image/'))                                         return '🖼️';
    if (mimeType.includes('pdf'))                                              return '📄';
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel'))       return '📊';
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📑';
    if (mimeType.includes('document') || mimeType.includes('word'))           return '📝';
    if (mimeType.includes('text'))                                             return '📃';
    if (mimeType.includes('video'))                                            return '🎬';
    if (mimeType.includes('audio'))                                            return '🎵';
    if (mimeType.includes('zip') || mimeType.includes('compressed'))          return '🗜️';
    return '📎';
  },

  _esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  },
};
