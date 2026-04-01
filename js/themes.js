/**
 * Theme engine — applies CSS custom property overrides and persists selection.
 */
const Themes = {
  STORAGE_KEY: 'fsm_theme',

  // Theme definitions — each overrides variables from variables.css
  _themes: {
    default: {
      name: 'Default',
      icon: '☀️',
      colors: {
        '--primary-color': '#0066cc',
        '--secondary-color': '#00cc66',
        '--accent-color': '#ff6600',
        '--background': '#f5f5f5',
        '--card-background': '#ffffff',
        '--text-primary': '#333333',
        '--text-secondary': '#666666',
        '--text-muted': '#999999',
        '--border-color': '#dddddd',
        '--error-color': '#e74c3c',
        '--success-color': '#27ae60',
        '--warning-color': '#f39c12',
        '--shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.1)',
        '--shadow-md': '0 2px 8px rgba(0, 0, 0, 0.12)',
        '--shadow-lg': '0 4px 16px rgba(0, 0, 0, 0.15)',
      },
    },

    dark: {
      name: 'Dark Mode',
      icon: '🌙',
      colors: {
        '--primary-color': '#4da6ff',
        '--secondary-color': '#33cc77',
        '--accent-color': '#ff8833',
        '--background': '#121212',
        '--card-background': '#1e1e1e',
        '--text-primary': '#e0e0e0',
        '--text-secondary': '#a0a0a0',
        '--text-muted': '#707070',
        '--border-color': '#333333',
        '--error-color': '#ff6b6b',
        '--success-color': '#4ecb71',
        '--warning-color': '#ffb347',
        '--shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.3)',
        '--shadow-md': '0 2px 8px rgba(0, 0, 0, 0.4)',
        '--shadow-lg': '0 4px 16px rgba(0, 0, 0, 0.5)',
        // Status colors — darkened for contrast on dark backgrounds
        '--status-scheduled': '#5ba3d9',
        '--status-dispatched': '#7dbce8',
        '--status-enroute': '#d4960f',
        '--status-arrived': '#c07028',
        '--status-progress': '#2db85f',
        '--status-complete': '#239a50',
        '--status-cancelled': '#dd4444',
      },
    },

    dusk: {
      name: 'Dusk',
      icon: '🌅',
      colors: {
        '--primary-color': '#e67e22',
        '--secondary-color': '#d35400',
        '--accent-color': '#f39c12',
        '--background': '#1a1a2e',
        '--card-background': '#242440',
        '--text-primary': '#e8e8f0',
        '--text-secondary': '#a8a8c0',
        '--text-muted': '#6a6a88',
        '--border-color': '#3a3a55',
        '--error-color': '#e74c3c',
        '--success-color': '#2ecc71',
        '--warning-color': '#f1c40f',
        '--shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.3)',
        '--shadow-md': '0 2px 8px rgba(0, 0, 0, 0.4)',
        '--shadow-lg': '0 4px 16px rgba(0, 0, 0, 0.5)',
      },
    },

    ocean: {
      name: 'Ocean',
      icon: '🌊',
      colors: {
        '--primary-color': '#0891b2',
        '--secondary-color': '#06b6d4',
        '--accent-color': '#f97316',
        '--background': '#0f172a',
        '--card-background': '#1e293b',
        '--text-primary': '#e2e8f0',
        '--text-secondary': '#94a3b8',
        '--text-muted': '#64748b',
        '--border-color': '#334155',
        '--error-color': '#f87171',
        '--success-color': '#34d399',
        '--warning-color': '#fbbf24',
        '--shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.3)',
        '--shadow-md': '0 2px 8px rgba(0, 0, 0, 0.4)',
        '--shadow-lg': '0 4px 16px rgba(0, 0, 0, 0.5)',
      },
    },

    sunset: {
      name: 'Sunset',
      icon: '🌇',
      colors: {
        '--primary-color': '#ec4899',
        '--secondary-color': '#f472b6',
        '--accent-color': '#f59e0b',
        '--background': '#fdf2f8',
        '--card-background': '#ffffff',
        '--text-primary': '#4a1942',
        '--text-secondary': '#7a4072',
        '--text-muted': '#aa70a2',
        '--border-color': '#f0d0e8',
        '--error-color': '#e74c3c',
        '--success-color': '#27ae60',
        '--warning-color': '#f39c12',
        '--shadow-sm': '0 1px 3px rgba(236, 72, 153, 0.08)',
        '--shadow-md': '0 2px 8px rgba(236, 72, 153, 0.12)',
        '--shadow-lg': '0 4px 16px rgba(236, 72, 153, 0.15)',
      },
    },

    holiday: {
      name: 'Holiday',
      icon: '🎄',
      colors: {
        '--primary-color': '#c0392b',
        '--secondary-color': '#e74c3c',
        '--accent-color': '#27ae60',
        '--background': '#1a1a1a',
        '--card-background': '#2a2a2a',
        '--text-primary': '#f0e8e0',
        '--text-secondary': '#b0a898',
        '--text-muted': '#706860',
        '--border-color': '#3a3a3a',
        '--error-color': '#e74c3c',
        '--success-color': '#27ae60',
        '--warning-color': '#f1c40f',
        '--shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.3)',
        '--shadow-md': '0 2px 8px rgba(0, 0, 0, 0.4)',
        '--shadow-lg': '0 4px 16px rgba(0, 0, 0, 0.5)',
      },
    },

    pool: {
      name: 'Pool',
      icon: '🏊',
      colors: {
        '--primary-color': '#0077b6',
        '--secondary-color': '#00b4d8',
        '--accent-color': '#48cae4',
        '--background': '#caf0f8',
        '--card-background': '#ffffff',
        '--text-primary': '#023e8a',
        '--text-secondary': '#0077b6',
        '--text-muted': '#90cdf4',
        '--border-color': '#90e0ef',
        '--error-color': '#e74c3c',
        '--success-color': '#27ae60',
        '--warning-color': '#f39c12',
        '--shadow-sm': '0 1px 3px rgba(0, 119, 182, 0.1)',
        '--shadow-md': '0 2px 8px rgba(0, 119, 182, 0.15)',
        '--shadow-lg': '0 4px 16px rgba(0, 119, 182, 0.2)',
      },
    },

    spring: {
      name: 'Spring',
      icon: '🌿',
      colors: {
        '--primary-color': '#27ae60',
        '--secondary-color': '#2ecc71',
        '--accent-color': '#f1c40f',
        '--background': '#f0f8f0',
        '--card-background': '#ffffff',
        '--text-primary': '#2c3e50',
        '--text-secondary': '#5a7a5a',
        '--text-muted': '#8aaa8a',
        '--border-color': '#c8e0c8',
        '--error-color': '#e74c3c',
        '--success-color': '#27ae60',
        '--warning-color': '#f39c12',
        '--shadow-sm': '0 1px 3px rgba(39, 174, 96, 0.08)',
        '--shadow-md': '0 2px 8px rgba(39, 174, 96, 0.12)',
        '--shadow-lg': '0 4px 16px rgba(39, 174, 96, 0.15)',
      },
    },

    summer: {
      name: 'Summer',
      icon: '☀️',
      colors: {
        '--primary-color': '#e67e22',
        '--secondary-color': '#f39c12',
        '--accent-color': '#e74c3c',
        '--background': '#fff8f0',
        '--card-background': '#ffffff',
        '--text-primary': '#5a3e28',
        '--text-secondary': '#8a6e50',
        '--text-muted': '#bda088',
        '--border-color': '#f0dcc8',
        '--error-color': '#e74c3c',
        '--success-color': '#27ae60',
        '--warning-color': '#f39c12',
        '--shadow-sm': '0 1px 3px rgba(230, 126, 34, 0.08)',
        '--shadow-md': '0 2px 8px rgba(230, 126, 34, 0.12)',
        '--shadow-lg': '0 4px 16px rgba(230, 126, 34, 0.15)',
      },
    },

    fall: {
      name: 'Fall',
      icon: '🍂',
      colors: {
        '--primary-color': '#d35400',
        '--secondary-color': '#e67e22',
        '--accent-color': '#c0392b',
        '--background': '#2c1810',
        '--card-background': '#3a2418',
        '--text-primary': '#f0e0d0',
        '--text-secondary': '#c8a888',
        '--text-muted': '#8a7060',
        '--border-color': '#4a3428',
        '--error-color': '#e74c3c',
        '--success-color': '#27ae60',
        '--warning-color': '#f1c40f',
        '--shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.3)',
        '--shadow-md': '0 2px 8px rgba(0, 0, 0, 0.4)',
        '--shadow-lg': '0 4px 16px rgba(0, 0, 0, 0.5)',
      },
    },

    winter: {
      name: 'Winter',
      icon: '❄️',
      colors: {
        '--primary-color': '#5b9bd5',
        '--secondary-color': '#7ec8e3',
        '--accent-color': '#a8d8ea',
        '--background': '#e8f0f8',
        '--card-background': '#ffffff',
        '--text-primary': '#2c3e6b',
        '--text-secondary': '#5a6e8a',
        '--text-muted': '#9aaabb',
        '--border-color': '#c8d8e8',
        '--error-color': '#e74c3c',
        '--success-color': '#27ae60',
        '--warning-color': '#f39c12',
        '--shadow-sm': '0 1px 3px rgba(91, 155, 213, 0.08)',
        '--shadow-md': '0 2px 8px rgba(91, 155, 213, 0.12)',
        '--shadow-lg': '0 4px 16px rgba(91, 155, 213, 0.15)',
      },
    },
  },

  /**
   * Initialize — apply saved theme on load.
   */
  init() {
    const saved = localStorage.getItem(this.STORAGE_KEY) || 'default';
    this.apply(saved, false);
  },

  /**
   * Apply a theme by ID.
   */
  apply(themeId, save = true) {
    const theme = this._themes[themeId];
    if (!theme) return;

    const root = document.documentElement;

    // Apply color overrides
    for (const [prop, value] of Object.entries(theme.colors)) {
      root.style.setProperty(prop, value);
    }

    // Update derived variables that reference others
    root.style.setProperty('--bg-primary', theme.colors['--card-background']);
    root.style.setProperty('--bg-secondary', theme.colors['--background']);

    // Update theme-color meta tag for browser chrome
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.colors['--primary-color']);

    this._currentTheme = themeId;

    if (save) {
      localStorage.setItem(this.STORAGE_KEY, themeId);
    }
  },

  /**
   * Get the current theme ID.
   */
  current() {
    return this._currentTheme || 'default';
  },

  /**
   * Show the theme picker modal.
   */
  showPicker() {
    // Close any open menus
    document.querySelectorAll('.menu-dropdown').forEach(d => d.style.display = 'none');

    const currentId = this.current();

    let swatchesHtml = '';
    for (const [id, theme] of Object.entries(this._themes)) {
      const isActive = id === currentId;
      const bg = theme.colors['--background'];
      const card = theme.colors['--card-background'];
      const primary = theme.colors['--primary-color'];
      const text = theme.colors['--text-primary'];

      swatchesHtml += `
        <button class="theme-option ${isActive ? 'active' : ''}" data-theme="${id}">
          <div class="theme-swatch">
            <div class="theme-swatch-bg" style="background:${bg};">
              <div class="theme-swatch-card" style="background:${card}; border-color:${primary};">
                <div class="theme-swatch-line" style="background:${primary};"></div>
                <div class="theme-swatch-line short" style="background:${text}; opacity:0.3;"></div>
              </div>
            </div>
          </div>
          <span class="theme-option-icon">${theme.icon}</span>
          <span class="theme-option-name">${theme.name}</span>
          ${isActive ? '<span class="theme-option-check">&#10003;</span>' : ''}
        </button>
      `;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-themes">
        <div class="modal-header">
          <h3>Choose Theme</h3>
          <button class="modal-close" id="themeModalClose">&times;</button>
        </div>
        <div class="modal-body">
          <div class="theme-grid">
            ${swatchesHtml}
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Bind close — defer backdrop listener to avoid mobile ghost-click
    const close = () => overlay.remove();
    overlay.querySelector('#themeModalClose').addEventListener('click', close);
    requestAnimationFrame(() => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });
    });

    // Bind theme selection
    overlay.querySelectorAll('.theme-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const themeId = btn.dataset.theme;
        this.apply(themeId);
        close();
        if (typeof App !== 'undefined') {
          App.showToast(`Theme: ${this._themes[themeId].name}`, 'success');
        }
      });
    });
  },
};
