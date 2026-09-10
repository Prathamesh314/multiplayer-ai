/**
 * Centralized logging utility with automatic secret masking
 * Prevents sensitive data from appearing in logs
 */

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

interface LogContext {
  [key: string]: any;
}

// List of sensitive keys that should be masked in logs
const SENSITIVE_KEYS = [
  'password',
  'token',
  'secret',
  'jwt',
  'auth',
  'authorization',
  'api_key',
  'apikey',
  'api_secret',
  'apisecret',
  'private_key',
  'privatekey',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'session',
  'cookie',
  'credentials',
  'mongodb_uri',
  'postgres_password',
  'redis_url',
  'cloudinary_api_secret',
  'cloudinary_api_key',
];

// Patterns to detect in URLs or connection strings
const SENSITIVE_PATTERNS = [
  /mongodb:\/\/[^:]+:([^@]+)@/gi, // MongoDB connection string with password
  /postgres:\/\/[^:]+:([^@]+)@/gi, // PostgreSQL connection string with password
  /redis:\/\/[^:]+:([^@]+)@/gi, // Redis connection string with password
  /:[a-zA-Z0-9_-]{20,}/g, // Long strings after colons (likely tokens)
  /Bearer\s+[a-zA-Z0-9._-]+/gi, // Bearer tokens
  /[a-zA-Z0-9_-]{32,}/g, // Long alphanumeric strings (likely secrets)
];

class Logger {
  private static instance: Logger;
  private logLevel: LogLevel = LogLevel.INFO;
  private enableColors: boolean = true;

  private constructor() {
    // Set log level from environment
    const envLogLevel = process.env.LOG_LEVEL?.toUpperCase();
    if (envLogLevel && Object.values(LogLevel).includes(envLogLevel as LogLevel)) {
      this.logLevel = envLogLevel as LogLevel;
    }

    // Disable colors in production or if NO_COLOR is set
    if (process.env.NODE_ENV === 'production' || process.env.NO_COLOR) {
      this.enableColors = false;
    }
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Mask sensitive data in objects, strings, and nested structures
   */
  private maskSensitiveData(data: any): any {
    if (data === null || data === undefined) {
      return data;
    }

    // Handle strings
    if (typeof data === 'string') {
      return this.maskSensitiveString(data);
    }

    // Handle arrays
    if (Array.isArray(data)) {
      return data.map(item => this.maskSensitiveData(item));
    }

    // Handle objects
    if (typeof data === 'object') {
      const masked: any = {};
      for (const [key, value] of Object.entries(data)) {
        const lowerKey = key.toLowerCase();
        
        // Check if key is sensitive
        const isSensitive = SENSITIVE_KEYS.some(sensitiveKey => 
          lowerKey.includes(sensitiveKey)
        );

        if (isSensitive) {
          masked[key] = '***REDACTED***';
        } else if (typeof value === 'string') {
          masked[key] = this.maskSensitiveString(value);
        } else {
          masked[key] = this.maskSensitiveData(value);
        }
      }
      return masked;
    }

    return data;
  }

  /**
   * Mask sensitive patterns in strings (URLs, tokens, etc.)
   */
  private maskSensitiveString(str: string): string {
    let masked = str;

    // Apply pattern-based masking
    for (const pattern of SENSITIVE_PATTERNS) {
      masked = masked.replace(pattern, (match) => {
        // For connection strings, keep the protocol and host visible
        if (match.includes('://')) {
          const parts = match.split('@');
          if (parts.length > 1) {
            return match.split(':')[0] + '://***:***@';
          }
        }
        // For other patterns, check length to avoid masking short strings
        if (match.length > 20) {
          return '***REDACTED***';
        }
        return match;
      });
    }

    return masked;
  }

  /**
   * Format log message with timestamp and level
   */
  private formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const maskedContext = context ? this.maskSensitiveData(context) : null;
    
    let logMessage = `[${timestamp}] [${level}] ${message}`;
    
    if (maskedContext && Object.keys(maskedContext).length > 0) {
      logMessage += ` | Context: ${JSON.stringify(maskedContext)}`;
    }
    
    return logMessage;
  }

  /**
   * Apply colors to log messages (only in development)
   */
  private colorize(level: LogLevel, message: string): string {
    if (!this.enableColors) {
      return message;
    }

    const colors = {
      [LogLevel.DEBUG]: '\x1b[36m', // Cyan
      [LogLevel.INFO]: '\x1b[32m',  // Green
      [LogLevel.WARN]: '\x1b[33m',  // Yellow
      [LogLevel.ERROR]: '\x1b[31m', // Red
    };

    const reset = '\x1b[0m';
    return `${colors[level]}${message}${reset}`;
  }

  /**
   * Check if current log level allows logging
   */
  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const requestedLevelIndex = levels.indexOf(level);
    return requestedLevelIndex >= currentLevelIndex;
  }

  /**
   * Log debug messages
   */
  public debug(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      const formatted = this.formatMessage(LogLevel.DEBUG, message, context);
      console.log(this.colorize(LogLevel.DEBUG, formatted));
    }
  }

  /**
   * Log info messages
   */
  public info(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.INFO)) {
      const formatted = this.formatMessage(LogLevel.INFO, message, context);
      console.log(this.colorize(LogLevel.INFO, formatted));
    }
  }

  /**
   * Log warning messages
   */
  public warn(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.WARN)) {
      const formatted = this.formatMessage(LogLevel.WARN, message, context);
      console.warn(this.colorize(LogLevel.WARN, formatted));
    }
  }

  /**
   * Log error messages
   */
  public error(message: string, error?: Error | unknown, context?: LogContext): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      const errorContext = { ...context };
      
      if (error instanceof Error) {
        errorContext.error = {
          message: this.maskSensitiveString(error.message),
        };
      } else if (error) {
        errorContext.error = this.maskSensitiveString(String(error));
      }

      const formatted = this.formatMessage(LogLevel.ERROR, message, errorContext);
      console.error(this.colorize(LogLevel.ERROR, formatted));
    }
  }

  /**
   * Log HTTP request
   */
  public logRequest(method: string, path: string, context?: LogContext): void {
    this.info(`${method} ${path}`, context);
  }

  /**
   * Log HTTP response
   */
  public logResponse(method: string, path: string, statusCode: number, duration?: number): void {
    const context: LogContext = { statusCode };
    if (duration) {
      context.duration = `${duration}ms`;
    }
    this.info(`${method} ${path} - ${statusCode}`, context);
  }

  /**
   * Log database query (with timing)
   */
  public logQuery(query: string, duration?: number): void {
    const context: LogContext = {};
    if (duration) {
      context.duration = `${duration}ms`;
    }
    // Mask any potential sensitive data in query
    const maskedQuery = this.maskSensitiveString(query);
    this.debug(`Database Query: ${maskedQuery}`, context);
  }

  /**
   * Set log level dynamically
   */
  public setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }
}

// Export singleton instance
export const logger = Logger.getInstance();

// Export convenience functions
export const log = {
  debug: (message: string, context?: LogContext) => logger.debug(message, context),
  info: (message: string, context?: LogContext) => logger.info(message, context),
  warn: (message: string, context?: LogContext) => logger.warn(message, context),
  error: (message: string, error?: Error | unknown, context?: LogContext) => 
    logger.error(message, error, context),
  request: (method: string, path: string, context?: LogContext) => 
    logger.logRequest(method, path, context),
  response: (method: string, path: string, statusCode: number, duration?: number) => 
    logger.logResponse(method, path, statusCode, duration),
  query: (query: string, duration?: number) => logger.logQuery(query, duration),
};