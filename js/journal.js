/**
 * Journal module — two-way notes between PWA workers and Odoo secretary.
 * Uses mail.message with a custom "Journal" subtype that appears in Odoo chatter.
 */
const Journal = {

  /**
   * Render the journal section for a job's detail view.
   * All DOM lookups are scoped to `container` to avoid ID collisions
   * when rendered in both the Journal tab and the Journal modal.
   */
  async renderSection(jobId, container) {
    container.innerHTML = `
      <div class="journal-compose">
        <textarea class="form-input journal-input"
                  placeholder="Write a note..." rows="2"></textarea>
        <button class="btn btn-primary btn-sm journal-post-btn">Post</button>
      </div>
      <div class="journal-entries">
        <div class="loading"><div class="spinner"></div></div>
      </div>
    `;

    const input = container.querySelector('.journal-input');
    const btn = container.querySelector('.journal-post-btn');
    const entriesEl = container.querySelector('.journal-entries');

    // Bind post button
    btn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) return;

      btn.disabled = true;
      btn.textContent = 'Posting...';

      try {
        if (navigator.onLine) {
          await OdooAPI.postJournalEntry(jobId, text);
          input.value = '';
          App.showToast('Journal entry posted', 'success');
          // Refresh entries
          await this._loadEntries(jobId, entriesEl);
        } else {
          // Queue for later
          await DB.put('journalQueue', {
            temp_id: 'jq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            job_id: jobId,
            body: text,
            timestamp: new Date().toISOString(),
            synced: 0,
          });
          input.value = '';
          App.showToast('Journal entry saved — will post when online', 'info');
        }
      } catch (err) {
        App.showToast('Failed to post: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Post';
      }
    });

    // Load entries
    await this._loadEntries(jobId, entriesEl);
  },

  /**
   * Load and render journal entries from Odoo.
   */
  async _loadEntries(jobId, entriesContainer) {
    if (!entriesContainer) return;

    if (!navigator.onLine) {
      entriesContainer.innerHTML = '<p class="journal-offline">Journal entries available when online</p>';
      return;
    }

    try {
      const entries = await OdooAPI.getJournalEntries(jobId);

      if (entries.length === 0) {
        entriesContainer.innerHTML = '<p class="journal-empty">No journal entries yet</p>';
        return;
      }

      entriesContainer.innerHTML = entries.map(entry => {
        const author = Array.isArray(entry.author_id) ? entry.author_id[1] : 'Unknown';
        const date = this._formatDate(entry.create_date);
        const body = this._stripHtml(entry.body || '');
        return `
          <div class="journal-entry">
            <div class="journal-entry-header">
              <span class="journal-entry-author">${this._escapeHtml(author)}</span>
              <span class="journal-entry-date">${date}</span>
            </div>
            <div class="journal-entry-body">${this._escapeHtml(body)}</div>
          </div>`;
      }).join('');
    } catch (err) {
      console.error('Failed to load journal:', err);
      const msg = err.message || 'Unknown error';
      entriesContainer.innerHTML = `<p class="journal-empty">Could not load journal entries: ${this._escapeHtml(msg)}</p>`;
    }
  },

  /**
   * Sync any queued journal entries (called from Sync module).
   */
  async syncAll() {
    let uploaded = 0;
    let failed = 0;

    try {
      const pending = await DB.getUnsyncedItems('journalQueue');
      for (const item of pending) {
        try {
          await OdooAPI.postJournalEntry(item.job_id, item.body);
          item.synced = 1;
          await DB.put('journalQueue', item);
          uploaded++;
        } catch (err) {
          console.warn('Failed to sync journal entry:', err);
          failed++;
        }
      }
    } catch {
      // journalQueue store might not exist yet
    }

    return { uploaded, failed };
  },

  // Helpers

  _formatDate(dateStr) {
    if (!dateStr) return '';
    const iso = dateStr.replace(' ', 'T') + (dateStr.includes('Z') ? '' : 'Z');
    const d = new Date(iso);
    if (isNaN(d.getTime())) return dateStr;
    const tz = (typeof Auth !== 'undefined' && Auth.getTimezone) ? Auth.getTimezone() : undefined;
    const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    if (tz) opts.timeZone = tz;
    return d.toLocaleString([], opts);
  },

  _stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  },

  _escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  },
};
