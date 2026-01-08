/**
 * Logger Utility
 *
 * Provides consistent logging with timestamps and configurable log levels.
 *
 * Log Levels:
 * - debug: Detailed debugging information
 * - info: General information messages
 * - warn: Warning messages
 * - error: Error messages
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

class Logger {
  private level: LogLevel = 'info';
  private showTimestamp: boolean = true;

  /**
   * Configure the logger
   */
  configure(options: { level?: LogLevel; showTimestamp?: boolean }) {
    if (options.level !== undefined) {
      this.level = options.level;
    }
    if (options.showTimestamp !== undefined) {
      this.showTimestamp = options.showTimestamp;
    }
  }

  /**
   * Get current log level
   */
  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Format timestamp
   */
  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Check if should log at given level
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  /**
   * Format message with timestamp
   */
  private formatMessage(level: string, message: string): string {
    if (this.showTimestamp) {
      return `[${this.formatTimestamp()}] [${level.toUpperCase()}] ${message}`;
    }
    return `[${level.toUpperCase()}] ${message}`;
  }

  /**
   * Debug level log
   */
  debug(message: string, ...args: any[]) {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message), ...args);
    }
  }

  /**
   * Info level log
   */
  info(message: string, ...args: any[]) {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message), ...args);
    }
  }

  /**
   * Warning level log
   */
  warn(message: string, ...args: any[]) {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message), ...args);
    }
  }

  /**
   * Error level log
   */
  error(message: string, ...args: any[]) {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message), ...args);
    }
  }

  /**
   * Raw log without formatting (for special cases like status display)
   */
  raw(message: string) {
    console.log(message);
  }

  /**
   * Log with custom prefix (no level, just timestamp)
   */
  log(prefix: string, message: string) {
    if (this.showTimestamp) {
      console.log(`[${this.formatTimestamp()}] ${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }
}

// Export singleton instance
export const logger = new Logger();

// Export class for testing
export { Logger };
