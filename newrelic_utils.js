/**
 * Advanced New Relic instrumentation utilities for MCP tools
 * Provides wrappers for automatic tracing, metrics, and error handling
 */

const newrelic = require('newrelic');

/**
 * Instrument an MCP tool with advanced tracing
 * Tracks execution time, caching, API calls, and errors
 */
class MCPToolInstrument {
  constructor(toolName) {
    this.toolName = toolName;
    this.startTime = null;
    this.metrics = {
      cacheHits: 0,
      cacheMisses: 0,
      apiCalls: 0,
      apiErrors: 0,
      executionTime: 0,
    };
  }

  /**
   * Wrap tool execution with tracing
   */
  async execute(toolFunction, params = {}) {
    const transaction = newrelic.getTransaction();
    transaction.setName(`/mcp/tool/${this.toolName}`);
    
    this.startTime = Date.now();
    
    try {
      // Add custom attributes to trace
      newrelic.addCustomAttribute('mcp.tool_name', this.toolName);
      newrelic.addCustomAttribute('mcp.tool_params', JSON.stringify(params).slice(0, 255));
      newrelic.addCustomAttribute('mcp.request_started', new Date().toISOString());

      // Execute the tool
      const result = await toolFunction();

      // Track successful execution
      const executionTime = Date.now() - this.startTime;
      this.metrics.executionTime = executionTime;

      newrelic.addCustomAttribute('mcp.execution_time_ms', executionTime);
      newrelic.addCustomAttribute('mcp.status', 'success');
      newrelic.addCustomAttribute('mcp.cache_hits', this.metrics.cacheHits);
      newrelic.addCustomAttribute('mcp.cache_misses', this.metrics.cacheMisses);
      newrelic.addCustomAttribute('mcp.api_calls', this.metrics.apiCalls);

      // Record custom metric
      this._recordMetric(`mcp/tool/${this.toolName}/execution_time`, executionTime);
      this._recordMetric(`mcp/tool/${this.toolName}/cache_hits`, this.metrics.cacheHits);
      this._recordMetric(`mcp/tool/${this.toolName}/cache_misses`, this.metrics.cacheMisses);

      return result;

    } catch (error) {
      // Track error
      const executionTime = Date.now() - this.startTime;
      newrelic.noticeError(error);
      newrelic.addCustomAttribute('mcp.status', 'error');
      newrelic.addCustomAttribute('mcp.error_message', error.message);
      newrelic.addCustomAttribute('mcp.execution_time_ms', executionTime);
      newrelic.addCustomAttribute('mcp.api_errors', this.metrics.apiErrors);

      this._recordMetric(`mcp/tool/${this.toolName}/errors`, 1);
      this._recordMetric(`mcp/tool/${this.toolName}/execution_time`, executionTime);

      throw error;
    }
  }

  /**
   * Track cache operation
   */
  trackCacheOperation(hit = true) {
    if (hit) {
      this.metrics.cacheHits++;
      this._recordMetric(`mcp/cache/hits`, 1);
    } else {
      this.metrics.cacheMisses++;
      this._recordMetric(`mcp/cache/misses`, 1);
    }
  }

  /**
   * Track API call to external service
   */
  async trackAPICall(service, method, endpoint, apiCallFunction) {
    const segment = newrelic.startSegment(
      `external/${service}/${method.toUpperCase()} ${endpoint}`,
      true,
      async () => {
        this.metrics.apiCalls++;
        
        try {
          const result = await apiCallFunction();
          newrelic.addCustomAttribute(`api.${service}.calls`, this.metrics.apiCalls);
          return result;
        } catch (error) {
          this.metrics.apiErrors++;
          newrelic.addCustomAttribute(`api.${service}.errors`, this.metrics.apiErrors);
          throw error;
        }
      }
    );
    
    return segment;
  }

  /**
   * Record custom metric
   */
  _recordMetric(metricName, value) {
    try {
      newrelic.recordMetric(metricName, value);
    } catch (error) {
      console.warn(`Failed to record metric ${metricName}:`, error.message);
    }
  }

  /**
   * Record custom event for detailed analytics
   */
  recordEvent(eventType, eventData = {}) {
    try {
      newrelic.recordCustomEvent(eventType, {
        tool: this.toolName,
        timestamp: new Date().toISOString(),
        ...eventData,
      });
    } catch (error) {
      console.warn(`Failed to record event ${eventType}:`, error.message);
    }
  }
}

/**
 * Higher-order function to automatically instrument MCP tools
 * Usage: const instrumentedTool = instrumentMCPTool('search_products', searchProductsFunction)
 */
function instrumentMCPTool(toolName, toolFunction) {
  return async function instrumentedToolHandler(...args) {
    const instrument = new MCPToolInstrument(toolName);
    
    return instrument.execute(
      () => toolFunction(...args),
      args[0] // First argument usually contains params
    );
  };
}

/**
 * Instrument GraphQL queries
 */
function instrumentGraphQLQuery(queryName, queryFunction) {
  return async function instrumentedGraphQL(...args) {
    const segment = newrelic.startSegment(
      `graphql/${queryName}`,
      true,
      async () => {
        try {
          const startTime = Date.now();
          const result = await queryFunction(...args);
          const executionTime = Date.now() - startTime;

          newrelic.addCustomAttribute(`graphql.query`, queryName);
          newrelic.addCustomAttribute(`graphql.execution_time_ms`, executionTime);
          newrelic.recordMetric(`graphql/query/${queryName}/execution_time`, executionTime);

          return result;
        } catch (error) {
          newrelic.noticeError(error);
          newrelic.recordMetric(`graphql/query/${queryName}/errors`, 1);
          throw error;
        }
      }
    );
    return segment;
  };
}

/**
 * Instrument REST API calls (like callShopifyApi)
 */
function instrumentRESTCall(service, method, path, apiCallFunction) {
  return async function instrumentedRESTCall(...args) {
    const segment = newrelic.startSegment(
      `external/${service}/${method.toUpperCase()} ${path}`,
      true,
      async () => {
        const startTime = Date.now();
        
        try {
          const result = await apiCallFunction(...args);
          const executionTime = Date.now() - startTime;

          newrelic.addCustomAttribute(`http.method`, method);
          newrelic.addCustomAttribute(`http.url`, path);
          newrelic.addCustomAttribute(`http.status_code`, result?.status || 200);
          newrelic.addCustomAttribute(`http.execution_time_ms`, executionTime);

          newrelic.recordMetric(`http/external/${service}/execution_time`, executionTime);
          newrelic.recordMetric(`http/external/${service}/requests`, 1);

          return result;
        } catch (error) {
          newrelic.noticeError(error);
          newrelic.recordMetric(`http/external/${service}/errors`, 1);
          throw error;
        }
      }
    );
    return segment;
  };
}

/**
 * Instrument cache operations (Redis, in-memory, etc.)
 */
function instrumentCacheOperation(cacheKey, operation) {
  return async function instrumentedCache(...args) {
    const segment = newrelic.startSegment(`cache/${operation}`, true, async () => {
      const startTime = Date.now();
      
      try {
        const result = await arguments.callee.fn(...args);
        const executionTime = Date.now() - startTime;

        newrelic.addCustomAttribute(`cache.key`, cacheKey);
        newrelic.addCustomAttribute(`cache.operation`, operation);
        newrelic.addCustomAttribute(`cache.execution_time_ms`, executionTime);
        newrelic.recordMetric(`cache/${operation}/execution_time`, executionTime);

        return result;
      } catch (error) {
        newrelic.noticeError(error);
        newrelic.recordMetric(`cache/${operation}/errors`, 1);
        throw error;
      }
    });
    return segment;
  };
}

/**
 * Helper to add breadcrumbs for tracing complex operations
 */
function addBreadcrumb(message, metadata = {}) {
  try {
    newrelic.recordCustomEvent('Breadcrumb', {
      message,
      timestamp: new Date().toISOString(),
      ...metadata,
    });
  } catch (error) {
    console.warn('Failed to add breadcrumb:', error.message);
  }
}

/**
 * Track business metrics (e.g., product searches, conversions)
 */
function trackBusinessMetric(metricName, value = 1, attributes = {}) {
  try {
    newrelic.recordMetric(`business/${metricName}`, value);
    newrelic.recordCustomEvent('BusinessMetric', {
      metric: metricName,
      value,
      timestamp: new Date().toISOString(),
      ...attributes,
    });
  } catch (error) {
    console.warn(`Failed to track business metric ${metricName}:`, error.message);
  }
}

module.exports = {
  MCPToolInstrument,
  instrumentMCPTool,
  instrumentGraphQLQuery,
  instrumentRESTCall,
  instrumentCacheOperation,
  addBreadcrumb,
  trackBusinessMetric,
};