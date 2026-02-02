/**
 * GPS utility — wraps navigator.geolocation with promise-based API.
 * Never blocks workflow: returns null if unavailable or denied.
 */
const GPS = {

  /**
   * Get current position as {lat, lon, accuracy}.
   * Returns null if geolocation is unavailable, denied, or times out.
   */
  getCurrentPosition() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        console.warn('Geolocation not available');
        resolve(null);
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
        },
        (err) => {
          console.warn('Geolocation error:', err.message);
          resolve(null);
        },
        {
          enableHighAccuracy: true,
          timeout: CONFIG.GPS_TIMEOUT,
          maximumAge: 60000, // accept a fix up to 1 minute old
        }
      );
    });
  },

  /**
   * Get a quick GPS fix with a short timeout (3 seconds).
   * Used when we want GPS but can't afford to wait long.
   */
  getQuickPosition() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(null);
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
        },
        () => resolve(null),
        {
          enableHighAccuracy: false,
          timeout: 3000,
          maximumAge: 120000, // accept a fix up to 2 minutes old
        }
      );
    });
  },

  /**
   * Format a position object as "lat,lon" string for Odoo.
   */
  formatCoords(pos) {
    if (!pos) return null;
    return `${pos.lat},${pos.lon}`;
  },

  /**
   * Check if accuracy is within the configured threshold.
   */
  isAccurate(pos) {
    if (!pos) return false;
    return pos.accuracy <= CONFIG.GPS_ACCURACY_THRESHOLD;
  },
};
