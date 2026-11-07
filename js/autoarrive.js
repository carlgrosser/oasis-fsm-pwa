/**
 * Auto Arrived: with the app open and the worker clocked on, today's job whose address they're at (within about
 * 150 m, by GPS) is marked Arrived by itself, as if they had tapped it, with an Undo for a few seconds.
 * Checked once the jobs and the clock have loaded, when the app comes back to the front, and every minute while
 * it's open; a phone's GPS only works with the app on screen. Once a job has been tried (or undone) it's left alone for the rest of the session.
 */
const AutoArrive = {
  RADIUS_M: 150,
  _coords: {},   // fsm.location id → [lat, lng], or null when it has none
  _done: {},     // job id → true once tried
  _busy: false,

  init() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.check();
    });
    setInterval(() => this.check(), 60000);
    setTimeout(() => this.check(), 5000);
  },

  /** Today's jobs not yet at Arrived in their flow (New, Dispatched, En Route…). */
  _candidates() {
    const today = Jobs._dayKey(new Date().toISOString().replace('T', ' ').slice(0, 19));
    return (Jobs._allJobs || []).filter(job => {
      if (this._done[job.id] || !Array.isArray(job.location_id)) return false;
      if (Jobs._dayKey(job.scheduled_date_start) !== today) return false;
      const flow = Jobs._workflowFor(job).map(s => s.toLowerCase());
      const arrived = flow.findIndex(s => s.includes('arrived'));
      const stage = Jobs.getStageName(job.stage_id).toLowerCase();
      const at = flow.findIndex(s => s === stage || stage.includes(s) || s.includes(stage));
      return arrived > 0 && at >= 0 && at < arrived;
    });
  },

  async _loadCoords(jobs) {
    const missing = [...new Set(jobs.map(j => j.location_id[0]))].filter(id => !(id in this._coords));
    if (!missing.length || !navigator.onLine) return;
    try {
      const rows = await OdooAPI.searchRead('fsm.location', [['id', 'in', missing]],
        ['partner_latitude', 'partner_longitude']);
      missing.forEach(id => { this._coords[id] = null; });
      rows.forEach(r => {
        if (r.partner_latitude || r.partner_longitude) this._coords[r.id] = [r.partner_latitude, r.partner_longitude];
      });
    } catch (err) {
      console.warn('AutoArrive: no job locations', err);
    }
  },

  _meters(a, b) {
    const rad = (d) => d * Math.PI / 180;
    const dLat = rad(b[0] - a[0]);
    const dLng = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  },

  async check() {
    if (this._busy || document.visibilityState !== 'visible') return;
    if (typeof TimeTracking === 'undefined' || !TimeTracking.isClockedIn() || typeof GPS === 'undefined') return;
    const jobs = this._candidates();
    if (!jobs.length) return;
    this._busy = true;
    try {
      await this._loadCoords(jobs);
      const pos = await GPS.getCurrentPosition();
      if (!pos || pos.accuracy > 200) return;   // a rough fix could put them at the wrong house
      const here = [pos.lat, pos.lon];
      let best = null;
      for (const job of jobs) {
        const at = this._coords[job.location_id[0]];
        if (!at) continue;
        const d = this._meters(here, at);
        if (d <= this.RADIUS_M + Math.min(pos.accuracy, 100) && (!best || d < best.d)) best = { job, d };
      }
      if (!best) return;
      const job = best.job;
      this._done[job.id] = true;
      const before = Jobs.getStageName(job.stage_id);
      if (await Jobs.changeJobStatus(job, 'Arrived')) {
        this._refresh(job);
        this._announce(job, before);
      }
    } catch (err) {
      console.warn('AutoArrive failed:', err);
    } finally {
      this._busy = false;
    }
  },

  _refresh(job) {
    if (Jobs._currentJobId === job.id) {
      const detail = document.getElementById('jobDetail');
      if (detail) Jobs.renderJobDetail(job.id, detail);
    }
    const list = document.getElementById('jobListToday');
    if (list) Jobs.renderJobList(list);
  },

  /** "Arrived at Smith" with Undo, for a few seconds. */
  _announce(job, before) {
    const name = Array.isArray(job.location_id) ? job.location_id[1] : (job.name || 'the job');
    const bar = document.createElement('div');
    bar.className = 'autoarrive-bar';
    bar.innerHTML = `<span>&#128205; Arrived at ${Jobs._escapeHtml(name)}</span><button type="button">Undo</button>`;
    document.body.appendChild(bar);
    const timer = setTimeout(() => bar.remove(), 10000);
    bar.querySelector('button').addEventListener('click', async () => {
      clearTimeout(timer);
      bar.remove();
      try {
        await Jobs.changeJobStatus(job, before);
        this._refresh(job);
        App.showToast(`Back to ${before}`, 'info');
      } catch (err) {
        App.showToast('Could not undo: ' + err.message, 'error');
      }
    });
  },
};
