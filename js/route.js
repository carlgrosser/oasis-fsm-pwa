/**
 * The day's route (Carl 2026-11-16): storm days bring many service calls, all "morning". The crew sees the
 * day's stops on a map, puts them in the order that makes the best drive (Best route from where the phone is,
 * tapping the pins in order, or up / down), and saves it: everyone on the crew then sees the jobs in that
 * order. Customers' windows don't change.
 */
const RouteMap = {
  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },

  /** A route button for a day's jobs (2 or more), put before the first card of that day. */
  renderButton(container, jobs, label) {
    const list = (jobs || []).filter(j => !j._appt);
    if (list.length < 2) return null;
    const card = document.createElement('div');
    card.className = 'route-card';
    card.innerHTML = `<button class="btn btn-secondary btn-block route-btn">&#128506; ${this._esc(label)} &middot; ${list.length} stops</button>`;
    card.querySelector('button').addEventListener('click', () => this.open(list, label));
    container.appendChild(card);
    return card;
  },

  _others: null,     // { ts, list } the overdue service calls on others, fetched at most once a minute
  _OTHERS_TTL: 60000,

  /**
   * Service calls from earlier days not finished, on someone else (or nobody): anyone on a crew may take one;
   * it's theirs, today (Carl 2026-11-16). A placeholder now, filled when the list comes.
   */
  renderOthers(container) {
    const box = document.createElement('div');
    box.className = 'route-others';
    container.appendChild(box);
    const personId = (typeof Auth !== 'undefined') && Auth.getPersonId();
    if (!personId || !navigator.onLine) return;
    const fill = (list) => {
      if (!list || !list.length) { box.innerHTML = ''; return; }
      box.innerHTML = `<details class="route-others-box"><summary>⚠️ Overdue service calls on others · ${list.length}</summary>
        ${list.map(j => `<div class="route-other" data-id="${j.id}">
            <div class="route-what"><b>${this._esc(j.customer)}</b>${j.go_first ? ' <span class="go-first-badge">⭐ GO FIRST</span>' : ''}
              <div class="text-muted small">${this._esc([j.city, j.what].filter(Boolean).join(' · '))}</div>
              <div class="text-muted small">${this._esc(j.name)} · from ${this._esc(j.since)} · on ${this._esc(j.who)}</div></div>
            <button class="btn btn-sm btn-primary" data-act="take">Take it</button>
          </div>`).join('')}</details>`;
      box.querySelectorAll('[data-act="take"]').forEach(btn => btn.addEventListener('click', async () => {
        const row = btn.closest('.route-other');
        btn.disabled = true;
        try {
          const res = await OdooAPI.callKw('fsm.order', 'worker_take_overdue', [personId, Number(row.dataset.id)], {});
          if (!res.ok) { App.showToast(res.reason || 'Not taken.', 'error'); btn.disabled = false; return; }
          App.showToast('Taken: it\'s on your Today.', 'success');
          this._others = null;
          await Jobs.loadJobs('today');
          const list = document.getElementById('jobListToday');
          if (list) Jobs.renderJobList(list);
        } catch (err) {
          App.showToast((err && err.message) || 'Not taken.', 'error');
          btn.disabled = false;
        }
      }));
    };
    if (this._others && Date.now() - this._others.ts < this._OTHERS_TTL) { fill(this._others.list); return; }
    OdooAPI.callKw('fsm.order', 'worker_overdue_others', [personId], {})
      .then(list => { this._others = { ts: Date.now(), list }; fill(list); })
      .catch(() => {});  // an Odoo without it: nothing to show
  },

  /** Google's encoded polyline -> [{lat, lng}]. */
  _decode(str) {
    const out = [];
    let index = 0, lat = 0, lng = 0;
    while (index < (str || '').length) {
      for (const which of [0, 1]) {
        let result = 0, shift = 0, b;
        do {
          b = str.charCodeAt(index++) - 63;
          result |= (b & 0x1f) << shift;
          shift += 5;
        } while (b >= 0x20);
        const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
        if (which === 0) lat += delta; else lng += delta;
      }
      out.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return out;
  },

  _here() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null), { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 });
    });
  },

  async open(jobs, label) {
    const overlay = document.createElement('div');
    overlay.className = 'ohu-overlay ohm-overlay route-overlay';
    overlay.innerHTML = `
      <div class="ohu-head">
        <button class="btn btn-sm" data-act="close">&larr; Back</button>
        <div style="flex:1;min-width:0;"><div class="ohu-title">${this._esc(label)}</div>
          <div class="ohu-sub">Loading&hellip;</div></div>
      </div>
      <div class="ohm-map route-map"></div>
      <div class="route-bar"></div>
      <div class="route-list"></div>`;
    document.body.appendChild(overlay);
    const $ = (s) => overlay.querySelector(s);
    const close = () => overlay.remove();
    $('[data-act="close"]').addEventListener('click', close);
    if (!navigator.onLine) {
      $('.ohu-sub').textContent = '';
      $('.route-map').innerHTML = '<div class="empty-state" style="padding:24px;"><p>The route needs signal.</p></div>';
      return;
    }
    let data;
    try {
      data = await OdooAPI.callKw('fsm.order', 'worker_day_route', [jobs.map(j => j.id)], {});
      await HolidayMap._loadGoogle(data.maps_key);
    } catch (err) {
      $('.ohu-sub').textContent = '';
      $('.route-map').innerHTML = `<div class="empty-state" style="padding:24px;"><p>${this._esc((err && err.message) || 'The map didn\'t load.')}</p></div>`;
      return;
    }
    this._run(overlay, data, close);
  },

  _run(overlay, data, close) {
    const $ = (s) => overlay.querySelector(s);
    const stops = data.stops || [];
    const byId = new Map(stops.map(s => [s.id, s]));
    const state = {
      order: stops.map(s => s.id),
      saved: stops.map(s => s.id).join(','),
      tapping: null,  // ids tapped so far, in "Tap in order"
      line: null,     // the drive along the streets (Google), or null while it loads: straight lines
      info: '',
      here: null,
      removed: [],    // taken off the route (back to their time order when saved)
    };
    // The drive along the streets for the order as it is now (after each change, once things settle).
    let lineTimer = null;
    let lineAsk = 0;
    const refreshLine = () => {
      clearTimeout(lineTimer);
      lineTimer = setTimeout(async () => {
        const ask = ++lineAsk;
        try {
          const res = await OdooAPI.callKw('fsm.order', 'worker_route_line', [state.order],
            { lat: state.here ? state.here.lat : null, lng: state.here ? state.here.lng : null });
          if (ask !== lineAsk || state.tapping) return;
          state.line = res.polyline ? this._decode(res.polyline) : null;
          if (res.minutes) state.info = `About ${res.minutes} min, ${res.miles} mi${state.here ? ' from here' : ''}`;
          render();
        } catch (e) { /* straight lines stay */ }
      }, 500);
    };
    const placed = stops.filter(s => s.lat || s.lng);
    const map = new google.maps.Map($('.route-map'), {
      mapTypeId: 'roadmap', disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy',
      clickableIcons: false,
    });
    const bounds = new google.maps.LatLngBounds();
    placed.forEach(s => bounds.extend({ lat: s.lat, lng: s.lng }));
    if (placed.length) map.fitBounds(bounds, 48);
    const markers = new Map();
    let path = null;
    let hereMarker = null;

    const draw = () => {
      const order = state.tapping ? state.tapping.concat(state.order.filter(id => !state.tapping.includes(id))) : state.order;
      markers.forEach(m => m.setMap(null));
      markers.clear();
      order.forEach((id, i) => {
        const s = byId.get(id);
        if (!s || !(s.lat || s.lng)) return;
        const picked = !state.tapping || state.tapping.includes(id);
        const m = new google.maps.Marker({
          map, position: { lat: s.lat, lng: s.lng },
          label: { text: picked ? String(i + 1) : '?', color: '#fff', fontWeight: 'bold' },
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 14,
                  fillColor: !picked ? '#9e9e9e' : s.go_first ? '#e65100' : s.overdue ? '#c62828' : '#1565c0',
                  fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
          title: `${s.customer} (${s.name})`,
        });
        m.addListener('click', () => {
          if (!state.tapping) return;
          if (!state.tapping.includes(id)) state.tapping.push(id);
          if (state.tapping.length === order.length) {
            state.order = state.tapping.slice();
            state.tapping = null;
            state.line = null;
            state.info = '';
            refreshLine();
          }
          render();
        });
        markers.set(id, m);
      });
      if (path) path.setMap(null);
      const pts = state.line || [state.here].concat(order.map(id => byId.get(id)))
        .filter(s => s && (s.lat || s.lng)).map(s => ({ lat: s.lat, lng: s.lng }));
      path = new google.maps.Polyline({ map, path: pts, strokeColor: '#1565c0', strokeOpacity: state.line ? 0.8 : 0.5,
                                        strokeWeight: state.line ? 5 : 3 });
      if (state.here && !hereMarker) {
        hereMarker = new google.maps.Marker({ map, position: state.here, title: 'You',
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#43a047', fillOpacity: 1,
                  strokeColor: '#fff', strokeWeight: 2 } });
      }
    };

    const render = () => {
      const changed = state.order.join(',') !== state.saved || state.removed.length > 0;
      const missing = stops.filter(s => !(s.lat || s.lng)).length;
      $('.ohu-sub').textContent = state.tapping
        ? `Tap the stops in the order you'll drive (${state.tapping.length} of ${stops.length})`
        : (state.info || `${stops.length} stops${missing ? ` · ${missing} not on the map` : ''}`);
      $('.route-bar').innerHTML = state.tapping
        ? `<button class="btn btn-secondary" data-act="tap-cancel">Cancel</button>`
        : `${data.can_optimize ? '<button class="btn btn-primary" data-act="best">Best route</button>' : ''}
           <button class="btn btn-secondary" data-act="tap">Tap in order</button>
           <button class="btn ${changed ? 'btn-success' : 'btn-secondary'}" data-act="save" ${changed ? '' : 'disabled'}>Save order</button>`;
      $('.route-list').innerHTML = state.order.map((id, i) => {
        const s = byId.get(id);
        return `<div class="route-stop" data-id="${id}">
            <span class="route-num">${i + 1}</span>
            <div class="route-what"><b>${this._esc(s.customer)}</b> <span class="text-muted">${this._esc(s.name)}${s.when ? ' · ' + this._esc(s.when) : ''}</span>
              ${s.overdue ? `<div class="small" style="color:#c62828;font-weight:600;">Overdue from ${this._esc(s.overdue)} · do today</div>` : ''}
              <div class="text-muted small">${this._esc(s.address)}${(s.lat || s.lng) ? '' : ' · not on the map'}</div></div>
            <button class="btn btn-sm ${s.go_first ? 'route-first-on' : ''}" data-act="first" aria-label="Go first"
              title="${s.go_first ? 'Go first (tap to clear)' : 'Make this a Go first stop'}">${s.go_first ? '⭐' : '☆'}</button>
            <button class="btn btn-sm" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Earlier">&#9650;</button>
            <button class="btn btn-sm" data-act="down" ${i === state.order.length - 1 ? 'disabled' : ''} aria-label="Later">&#9660;</button>
            <button class="btn btn-sm" data-act="remove" aria-label="Take off the route" title="Take off the route">&#10005;</button>
          </div>`;
      }).join('');
      draw();
    };

    overlay.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'up' || act === 'down') {
        const id = Number(btn.closest('.route-stop').dataset.id);
        const i = state.order.indexOf(id);
        const j = act === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= state.order.length) return;
        [state.order[i], state.order[j]] = [state.order[j], state.order[i]];
        state.line = null;
        state.info = '';
        render();
        refreshLine();
      } else if (act === 'remove') {
        const id = Number(btn.closest('.route-stop').dataset.id);
        state.order = state.order.filter(x => x !== id);
        state.removed.push(id);
        state.line = null;
        state.info = '';
        render();
        refreshLine();
      } else if (act === 'first') {
        const id = Number(btn.closest('.route-stop').dataset.id);
        const s = byId.get(id);
        btn.disabled = true;
        try {
          const res = await OdooAPI.callKw('fsm.order', 'worker_set_go_first', [id, !s.go_first], {});
          s.go_first = res.go_first;
          App.showToast(s.go_first ? 'Go first: Best route starts with it.' : 'No longer Go first.', 'success');
        } catch (err) {
          App.showToast((err && err.message) || 'Not changed.', 'error');
        }
        render();
      } else if (act === 'tap') {
        state.tapping = [];
        render();
      } else if (act === 'tap-cancel') {
        state.tapping = null;
        render();
      } else if (act === 'best') {
        btn.disabled = true;
        $('.ohu-sub').textContent = 'Finding the best route…';
        state.here = state.here || await this._here();
        try {
          const best = await OdooAPI.callKw('fsm.order', 'worker_best_route', [state.order],
            { lat: state.here ? state.here.lat : null, lng: state.here ? state.here.lng : null });
          state.order = best.ids;
          const lines = best.polylines || (best.polyline ? [best.polyline] : []);
          state.line = lines.length ? [].concat(...lines.map(l => this._decode(l))) : null;
          state.info = `Best route: about ${best.minutes} min, ${best.miles} mi${state.here ? ' from here' : ''}`
            + (best.missing && best.missing.length ? ` · not on the map (last): ${best.missing.join(', ')}` : '');
        } catch (err) {
          App.showToast((err && err.message) || 'No route from Google.', 'error');
        }
        render();
      } else if (act === 'save') {
        btn.disabled = true;
        try {
          await OdooAPI.callKw('fsm.order', 'worker_set_route', [state.order], { removed_ids: state.removed });
          state.saved = state.order.join(',');
          state.removed = [];
          App.showToast('Route saved: the crew sees the jobs in this order.', 'success');
          if (typeof Jobs !== 'undefined') {
            // The Today list in the new order: overdue ones on the route are today's now (the server moved them).
            Jobs._overdueService = (Jobs._overdueService || []).filter(j => !state.order.includes(j.id));
            Jobs._historyFetchCache = null;
            await Jobs.loadJobs('today').catch(() => {});
            const list = document.getElementById('jobListToday');
            if (list) Jobs.renderJobList(list);
          }
        } catch (err) {
          App.showToast((err && err.message) || 'Not saved.', 'error');
        }
        render();
      }
    });
    render();
    this._here().then(here => { state.here = state.here || here; refreshLine(); });
  },
};
