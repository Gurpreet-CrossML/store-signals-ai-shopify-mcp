// exports.config = {
//   app_name: ['Store Signal MCP Tools'],
//   license_key: process.env.NEW_RELIC_LICENSE_KEY,
//   logging: {
//     level: 'info'
//   },
//   allow_all_headers: true,
//   attributes: {
//     exclude: ['request.headers.cookie', 'request.headers.authorization']
//   }
// };
exports.config = {
  // ============================================
  // Application Identity
  // ============================================
  app_name: ['Store Signals MCP Server'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  
  // ============================================
  // Transaction & Request Tracing
  // ============================================
  transaction_tracer: {
    enabled: true,
    trace_threshold: 0.1, // ms - capture all transactions slower than 100ms
    record_sql: 'obfuscated', // Obfuscate SQL for security
    top_n: 10, // Track top 10 slowest transactions
  },

  // ============================================
  // Distributed Tracing (for cross-service)
  // ============================================
  distributed_tracing: {
    enabled: true,
  },

  // ============================================
  // Error Collection & Reporting
  // ============================================
  error_collector: {
    enabled: true,
    ignore_codes: [404, 401], // Don't track these HTTP errors
    capture_events: true,
    max_sample_size: 250,
  },

  // ============================================
  // Custom Events & Attributes
  // ============================================
  custom_insights_events: {
    enabled: true,
    max_samples_stored: 5000,
  },

  // ============================================
  // Logging (forwarding to New Relic Logs)
  // ============================================
  application_logging: {
    enabled: true,
    forwarding: {
      enabled: true,
      max_samples_stored: 10000,
    },
    local_decorating: {
      enabled: true,
    },
    metrics: {
      enabled: true,
    },
  },

  // ============================================
  // Logging Configuration
  // ============================================
  logging: {
    level: 'info',
    filepath: process.env.NEW_RELIC_LOG || 'newrelic.log',
  },

  // ============================================
  // Security & Headers
  // ============================================
  allow_all_headers: true,
  attributes: {
    enabled: true,
    include: ['*'],
    exclude: [
      'request.headers.cookie',
      'request.headers.authorization',
      'request.headers.x-api-key',
      'request.headers.x-auth-token',
      'request.parameters.password',
      'request.parameters.token',
      'request.parameters.api_key',
    ],
  },

  // ============================================
  // Performance Monitoring
  // ============================================
  slow_sql: {
    enabled: true,
    threshold: 500, // ms
  },

  // ============================================
  // High Security Mode (Optional)
  // ============================================
  high_security: process.env.NEW_RELIC_HIGH_SECURITY === 'true' || false,

  // ============================================
  // Cross Application Tracing (Legacy)
  // ============================================
  cross_application_tracer: {
    enabled: true,
  },

  // ============================================
  // Thread Profiling
  // ============================================
  thread_profiler: {
    enabled: true,
  },

  // ============================================
  // Instrumenting Built-in Modules
  // ============================================
  plugins: {
    express: { enabled: true },
    cors: { enabled: true },
    http: { enabled: true },
    https: { enabled: true },
    redis: { enabled: true },
    mongodb: { enabled: true },
    mysql: { enabled: true },
    postgres: { enabled: true },
    mongoose: { enabled: true },
    nodemailer: { enabled: true },
  },

  // ============================================
  // Development Mode
  // ============================================
  developer_mode: process.env.NODE_ENV === 'development' || false,
};