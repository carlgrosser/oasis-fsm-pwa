/**
 * Documents module — shows files from the Google Drive Documents folder
 * linked to the current job's project.
 *
 * Opened via the middle footer button on the job detail view.
 */
const Documents = {

  /**
   * Open the Documents panel for a job.
   */
  async showPanel(job) {
    const existing = document.getElementById('documentsModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'documentsModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal modal-documents">
        <div class="modal-header">
          <h3>Documents</h3>
          <button class="modal-close" id="documentsClose">&times;</button>
        </div>
        <div class="modal-body">
          <div id="documentsList" class="documents-list">
            <div class="loading"><div class="spinner"></div></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);

    modal.querySelector('#documentsClose').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    await this._load(job, modal.querySelector('#documentsList'));
  },

  async _load(job, listEl) {
    if (!navigator.onLine) {
      listEl.innerHTML = '<p class="documents-empty">Documents available when online.</p>';
      return;
    }

    try {
      const files = await OdooAPI.getJobDocuments(job.id);

      if (!files || files.length === 0) {
        listEl.innerHTML = '<p class="documents-empty">No documents found in the project Documents folder.</p>';
        return;
      }

      listEl.innerHTML = files.map(f => `
        <a class="document-item" href="${f.view_url}" target="_blank" rel="noopener">
          <span class="document-item-icon">${this._icon(f.mime_type)}</span>
          <span class="document-item-name">${this._esc(f.name)}</span>
          <span class="document-item-arrow">›</span>
        </a>`).join('');

    } catch (err) {
      listEl.innerHTML = `<p class="documents-empty">Could not load documents: ${this._esc(err.message || '')}</p>`;
    }
  },

  _icon(mimeType) {
    if (!mimeType) return '📎';
    if (mimeType.includes('pdf'))                          return '📄';
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) return '📊';
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint'))                       return '📑';
    if (mimeType.includes('document') || mimeType.includes('word') || mimeType.includes('text'))    return '📝';
    if (mimeType.includes('image'))                        return '🖼️';
    if (mimeType.includes('video'))                        return '🎬';
    if (mimeType.includes('audio'))                        return '🎵';
    if (mimeType.includes('zip') || mimeType.includes('compressed')) return '🗜️';
    return '📎';
  },

  _esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  },
};
