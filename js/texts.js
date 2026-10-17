/**
 * Texts with the customer, on a job.
 *
 * The worker texts the customer from the business number ("From <name>: …"),
 * sees the customer's replies (with photos) while the job's reply window is
 * open, and can save a gate code the customer sent on the job's location.
 * Texts are logged on the job in Odoo; replies also come to the crew's phones
 * as forwarded texts.
 */
const Texts = {
  _job: null,
  _phone: '',
  _timer: null,
  _sending: false,
  POLL_MS: 15000,

  /** Open the texts sheet for a job (phone: the number to text). */
  async open(job, phone) {
    this._job = job;
    this._phone = phone || '';
    this._ensureSheet();
    const sheet = document.getElementById('textsSheet');
    sheet.style.display = 'flex';
    document.body.classList.add('texts-open');
    sheet.querySelector('#textsTitle').textContent = this._customerName(job);
    sheet.querySelector('#textsThread').innerHTML = '<div class="texts-empty">Loading…</div>';
    sheet.querySelector('#textsInput').value = '';
    this._updateFrom();
    await this.refresh();
    clearInterval(this._timer);
    this._timer = setInterval(() => this.refresh(), this.POLL_MS);
  },

  close() {
    clearInterval(this._timer);
    this._timer = null;
    const sheet = document.getElementById('textsSheet');
    if (sheet) sheet.style.display = 'none';
    document.body.classList.remove('texts-open');
  },

  async refresh() {
    if (!this._job) return;
    try {
      const data = await OdooAPI.getJobTexts(this._job.id);
      this._render(data);
    } catch (err) {
      const thread = document.getElementById('textsThread');
      if (thread && !thread.querySelector('.texts-msg')) {
        thread.innerHTML = '<div class="texts-empty">Could not load the texts. Check the connection.</div>';
      }
    }
  },

  async send() {
    if (this._sending) return;
    const input = document.getElementById('textsInput');
    const text = (input.value || '').trim();
    if (!text) return;
    this._sending = true;
    const btn = document.getElementById('textsSend');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const response = await OdooAPI.sendJobText(this._job.id, this._phone, text);
      input.value = '';
      if (typeof warnIfSmsMirrorFailed === 'function') warnIfSmsMirrorFailed(response);
      await this.refresh();
    } catch (err) {
      App.showToast((err && err.message) || 'Text not sent', 'error');
    } finally {
      this._sending = false;
      btn.disabled = false;
      btn.textContent = 'Send';
    }
  },

  async saveGateCode(code) {
    try {
      await OdooAPI.saveGateCode(this._job.id, code);
      App.showToast('Gate code saved: ' + code, 'success');
      if (this._job) this._job.gate_code = code;
      await this.refresh();
    } catch (err) {
      App.showToast('Could not save the gate code', 'error');
    }
  },

  // ── Rendering ──────────────────────────────────────────────────────

  _ensureSheet() {
    if (document.getElementById('textsSheet')) return;
    const sheet = document.createElement('div');
    sheet.id = 'textsSheet';
    sheet.className = 'texts-sheet';
    sheet.style.display = 'none';
    sheet.innerHTML = `
      <div class="texts-header">
        <button class="texts-back" id="textsBack" aria-label="Back">&#8592;</button>
        <div class="texts-heading">
          <div class="texts-title" id="textsTitle"></div>
          <div class="texts-status" id="textsStatus"></div>
        </div>
      </div>
      <div class="texts-thread" id="textsThread"></div>
      <div class="texts-compose">
        <div class="texts-from" id="textsFrom"></div>
        <div class="texts-compose-row">
          <textarea id="textsInput" class="texts-input" rows="2" maxlength="1200"
                    placeholder="Text the customer…"></textarea>
          <button class="btn btn-primary texts-send" id="textsSend">Send</button>
        </div>
      </div>`;
    document.body.appendChild(sheet);
    sheet.querySelector('#textsBack').addEventListener('click', () => this.close());
    sheet.querySelector('#textsSend').addEventListener('click', () => this.send());
    sheet.querySelector('#textsThread').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-gate]');
      if (btn) this.saveGateCode(btn.dataset.gate);
    });
  },

  _render(data) {
    if (!data) return;
    if (!this._phone && data.phone) this._phone = data.phone;
    const status = document.getElementById('textsStatus');
    const w = data.window;
    if (w && w.open) {
      status.textContent = `Replies come to the crew until ${this._time(w.until)}`;
      status.className = 'texts-status open';
    } else if (w && w.closed_by_office) {
      status.textContent = 'The office has taken over this conversation';
      status.className = 'texts-status';
    } else {
      status.textContent = this._phone ? `Texting ${this._phone}` : 'No mobile number for this customer';
      status.className = 'texts-status';
    }
    const thread = document.getElementById('textsThread');
    const msgs = data.messages || [];
    if (!msgs.length) {
      thread.innerHTML = '<div class="texts-empty">No texts on this job yet.</div>';
      return;
    }
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
    thread.innerHTML = msgs.map(m => this._bubble(m, data.gate_code)).join('');
    if (atBottom || !thread.dataset.loaded) thread.scrollTop = thread.scrollHeight;
    thread.dataset.loaded = '1';
  },

  _bubble(m, currentGate) {
    const esc = (s) => this._esc(s);
    const photos = (m.photos || []).map(p =>
      `<a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.thumb)}" alt="Photo" loading="lazy"></a>`
    ).join('');
    const gate = m.gate_code && m.gate_code !== currentGate
      ? `<button class="texts-gate" data-gate="${esc(m.gate_code)}">Save gate code ${esc(m.gate_code)}</button>`
      : (m.gate_code ? `<div class="texts-gate-saved">Gate code ${esc(m.gate_code)} saved</div>` : '');
    return `
      <div class="texts-msg texts-${m.direction === 'out' ? 'out' : 'in'}">
        <div class="texts-meta">${esc(m.author)} · ${esc(this._time(m.date))}</div>
        ${m.text ? `<div class="texts-bubble">${esc(m.text)}</div>` : ''}
        ${photos ? `<div class="texts-photos">${photos}</div>` : ''}
        ${gate}
      </div>`;
  },

  _updateFrom() {
    // The server signs with the logged-in user (not an admin's persona).
    const user = (typeof Auth !== 'undefined' && Auth.getRealUser && Auth.getRealUser()) || {};
    const name = user.name || '';
    document.getElementById('textsFrom').textContent =
      `Sent from the business number${name ? ` as "From ${name}:"` : ''}`;
  },

  _customerName(job) {
    const loc = Array.isArray(job.location_id) ? job.location_id[1] : '';
    return loc || job.name || 'Customer';
  },

  /** Odoo UTC "YYYY-MM-DD HH:MM:SS" → local "Today 3:45 PM" / "Oct 16 3:45 PM". */
  _time(value) {
    if (!value) return '';
    const d = new Date(String(value).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return '';
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  },

  _esc(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  },
};
