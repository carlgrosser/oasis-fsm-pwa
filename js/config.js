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
    { key: 'equipment_off', label: 'Equipment is Off', required: 1 },
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
  DB_VERSION: 3,

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
  ],

  // Set to true after installing the custom Odoo modules
  CUSTOM_MODULE_INSTALLED: true,

  // STAGE NAME MAPPING (update if your Odoo uses different stage names)
  STAGES: {
    SCHEDULED: 'New',
    ENROUTE: 'En Route',
    ARRIVED: 'Arrived',
    IN_PROGRESS: 'In Progress',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled'
  },

  // STATUS WORKFLOW ORDER
  WORKFLOW: ['New', 'En Route', 'Arrived', 'In Progress', 'Completed'],
};
