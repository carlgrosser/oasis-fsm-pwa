const CONFIG = {
  // ODOO CONNECTION
  // For local dev: set to '' to use the proxy (server.py), or the full URL for direct browser requests.
  // For production (hosted on same domain or with CORS): use the full Odoo URL.
  ODOO_URL: 'https://www.oasispooltilecleaning.com',
  ODOO_DB: 'odoo18_prod',

  // FEATURES
  REQUIRE_SIGNATURE_ON_COMPLETE: false,

  // PHOTO CATEGORIES
  PHOTO_CATEGORIES: [
    { key: 'equipment', label: 'Equipment is Off', required: 1 },
    { key: 'before', label: 'Before Photos', required: 2 },
    { key: 'after', label: 'After Photos', required: 2 },
    { key: 'problem_areas', label: 'Problem Areas', required: 0 },
    { key: 'other', label: 'Other', required: 0 },
  ],
  ENABLE_SMS_NOTIFICATIONS: false,
  SMS_WEBHOOK_URL: '',

  // TIME TRACKING
  ENABLE_BREAKS: true,
  AUTO_CLOCK_IN_ON_START: true,
  AUTO_CLOCK_OUT_ON_COMPLETE: true,

  // MATERIALS — configured in Odoo via Field Service > Configuration > Material Config

  // UI
  JOBS_PER_PAGE: 50,
  AUTO_REFRESH_INTERVAL: 30, // minutes
  SYNC_RETRY_ATTEMPTS: 3,

  // GPS
  GPS_ACCURACY_THRESHOLD: 100,  // meters
  GPS_TIMEOUT: 30000,           // milliseconds

  // INDEXEDDB
  DB_NAME: 'fsm_pwa',
  DB_VERSION: 4,

  // MULTI-COMPANY: list all company IDs this user should see orders from
  ALLOWED_COMPANY_IDS: [1, 2],  // 1=Oasis Pool Tile Cleaning, 2=Oasis Holiday Lighting

  // FSM ORDER FIELDS TO FETCH
  // Base fields that exist in standard OCA fieldservice
  FSM_ORDER_FIELDS: [
    'name', 'location_id', 'stage_id',
    'scheduled_date_start', 'scheduled_date_end',
    'person_id', 'person_ids', 'sale_id', 'category_ids',
    'description', 'todo', 'request_early',
    'date_start', 'date_end',
    'company_id', 'street', 'street2', 'city',
    'state_name', 'phone', 'mobile', 'stage_name'
  ],

  // Extra fields added by fieldservice_multi_worker / fieldservice_gate_code modules
  FSM_ORDER_EXTRA_FIELDS: [
    'gate_code',
    'additional_worker_ids', 'worker_count', 'is_multi_worker_job',
    'gps_enroute', 'gps_enroute_timestamp',
    'photo_count_before', 'photo_count_after', 'photos_complete',
    'project_id',
    'wrapup_submitted', 'resolution',
  ],

  // Set to true after installing the custom Odoo modules
  CUSTOM_MODULE_INSTALLED: true,

  // SMS TEMPLATES
  SMS_TEMPLATE_ENROUTE: 'Hi {customer_first_name}, {tech_first_name} from {company_name} is on the way! Estimated arrival: {eta} minutes.',
  SMS_TEMPLATE_PAYMENT: 'Hi {customer_first_name}, here is your payment link for ${amount}: {payment_link}',
  SMS_TEMPLATE_RECEIPT: 'Hi {customer_first_name}, your receipt from {company_name} for ${amount} is ready: {receipt_link}',

  // SHLINK URL SHORTENER
  SHLINK_BASE_URL: '',
  SHLINK_API_KEY: '',
  SHLINK_SLUG_PATTERN: '{so_number}',

  // BILLING
  VENMO_USERNAME: '@OasisPoolTile',
  CHANGE_ORDER_THRESHOLD: 300,

  // STAGE NAME MAPPING (update if your Odoo uses different stage names)
  STAGES: {
    SCHEDULED: 'New',
    DISPATCHED: 'Dispatched',
    ENROUTE: 'En Route',
    ARRIVED: 'Arrived',
    IN_PROGRESS: 'In Progress',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled'
  },

  // STATUS WORKFLOW ORDER
  WORKFLOW: ['New', 'Dispatched', 'En Route', 'Arrived', 'In Progress', 'Completed'],
};

// Apply any saved PWA settings from localStorage (populated via JSON import)
(function() {
  try {
    const raw = localStorage.getItem('pwa_settings');
    if (!raw) return;
    const saved = JSON.parse(raw);
    const keys = [
      'VENMO_USERNAME', 'CHANGE_ORDER_THRESHOLD',
      'SMS_WEBHOOK_URL', 'ENABLE_SMS_NOTIFICATIONS', 'ODOO_URL',
      'SMS_TEMPLATE_ENROUTE', 'SMS_TEMPLATE_PAYMENT', 'SMS_TEMPLATE_RECEIPT',
      'SHLINK_BASE_URL', 'SHLINK_API_KEY', 'SHLINK_SLUG_PATTERN',
    ];
    keys.forEach(function(k) {
      if (saved[k] !== undefined && saved[k] !== '') CONFIG[k] = saved[k];
    });
  } catch (e) {
    console.warn('Failed to load pwa_settings from localStorage:', e);
  }
})();

/**
 * Render an SMS template by replacing {variable} placeholders with values.
 * Returns the composed string, or null if the template is empty.
 */
function renderSmsTemplate(templateKey, vars) {
  const template = CONFIG[templateKey];
  if (!template) return null;
  return template.replace(/\{(\w+)\}/g, function(match, key) {
    return vars[key] !== undefined ? vars[key] : match;
  });
}
