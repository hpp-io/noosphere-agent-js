/**
 * Logger Utility
 *
 * Provides consistent logging with timestamps and configurable log levels.
 * Supports both console and file-based logging with daily rotation.
 *
 * Features:
 * - Daily log rotation with timestamp-based filenames (agent-YYYY-MM-DD.log)
 * - Configurable retention period (default: 7 days)
 * - Size-based rotation within the same day
 * - Automatic cleanup of old log files
 *
 * Log Levels:
 * - debug: Detailed debugging information
 * - info: General information messages
 * - warn: Warning messages
 * - error: Error messages
 */

import fs from 'fs';
import path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

interface LoggerOptions {
  level?: LogLevel;
  showTimestamp?: boolean;
  logDir?: string; // Directory for log files
  maxFileSize?: number; // Max size in bytes before intra-day rotation (default: 50MB)
  retentionDays?: number; // Number of days to keep logs (default: 7)
  logToConsole?: boolean; // Whether to log to console (default: true)
}

class Logger {
  private level: LogLevel = 'info';
  private showTimestamp: boolean = true;
  private logDir?: string;
  private maxFileSize: number = 50 * 1024 * 1024; // 50MB
  private retentionDays: number = 7;
  private logToConsole: boolean = true;
  private currentLogFile?: string;
  private currentDate?: string;
  private writeStream?: fs.WriteStream;
  private rotationCheckInterval?: ReturnType<typeof setInterval>;
  private intraDayRotationCount: number = 0;

  /**
   * Configure the logger
   */
  configure(options: LoggerOptions) {
    if (options.level !== undefined) {
      this.level = options.level;
    }
    if (options.showTimestamp !== undefined) {
      this.showTimestamp = options.showTimestamp;
    }
    if (options.maxFileSize !== undefined) {
      this.maxFileSize = options.maxFileSize;
    }
    if (options.retentionDays !== undefined) {
      this.retentionDays = options.retentionDays;
    }
    if (options.logToConsole !== undefined) {
      this.logToConsole = options.logToConsole;
    }
    if (options.logDir !== undefined) {
      this.logDir = options.logDir;
      this.initFileLogging();
    }
  }

  /**
   * Get current date string (YYYY-MM-DD)
   */
  private getCurrentDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Get log filename for a date
   */
  private getLogFileName(dateStr: string, rotationIndex: number = 0): string {
    if (rotationIndex > 0) {
      return `agent-${dateStr}.${rotationIndex}.log`;
    }
    return `agent-${dateStr}.log`;
  }

  /**
   * Initialize file logging
   */
  private initFileLogging() {
    if (!this.logDir) return;

    try {
      // Create log directory if it doesn't exist
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }

      this.currentDate = this.getCurrentDateString();
      this.intraDayRotationCount = this.findLatestRotationIndex(this.currentDate);
      this.currentLogFile = path.join(this.logDir, this.getLogFileName(this.currentDate, this.intraDayRotationCount));
      this.openWriteStream();

      // Setup daily rotation check (every minute)
      this.rotationCheckInterval = setInterval(() => {
        this.checkDailyRotation();
      }, 60000);

      // Cleanup old logs on startup
      this.cleanupOldLogs();

      console.log(`📝 File logging enabled: ${this.currentLogFile}`);
      console.log(`   Retention: ${this.retentionDays} days, Max size: ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
    } catch (error) {
      console.error('Failed to initialize file logging:', error);
    }
  }

  /**
   * Find the latest rotation index for a given date
   */
  private findLatestRotationIndex(dateStr: string): number {
    if (!this.logDir) return 0;

    let index = 0;
    while (true) {
      const fileName = this.getLogFileName(dateStr, index + 1);
      const filePath = path.join(this.logDir, fileName);
      if (fs.existsSync(filePath)) {
        index++;
      } else {
        break;
      }
    }
    return index;
  }

  /**
   * Open write stream for current log file
   */
  private openWriteStream() {
    if (!this.currentLogFile) return;

    if (this.writeStream) {
      try {
        this.writeStream.end();
      } catch {
        // Ignore errors when closing old stream
      }
    }

    try {
      this.writeStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });
      this.writeStream.on('error', (error) => {
        console.error('Log file write error:', error);
        // Try to recover by reopening the stream
        this.writeStream = undefined;
        setTimeout(() => {
          if (!this.writeStream && this.currentLogFile) {
            console.log('Attempting to recover log file stream...');
            this.openWriteStream();
          }
        }, 1000);
      });
    } catch (error) {
      console.error('Failed to open log file stream:', error);
      this.writeStream = undefined;
    }
  }

  /**
   * Check if daily rotation is needed
   */
  private checkDailyRotation() {
    const newDate = this.getCurrentDateString();
    if (newDate !== this.currentDate) {
      this.rotateToDailyLog(newDate);
    }
  }

  /**
   * Rotate to a new daily log file
   */
  private rotateToDailyLog(newDate: string) {
    if (!this.logDir) return;

    try {
      // Close current stream
      if (this.writeStream) {
        try {
          this.writeStream.end();
        } catch {
          // Ignore errors when closing old stream
        }
        this.writeStream = undefined;
      }

      // Update to new date
      this.currentDate = newDate;
      this.intraDayRotationCount = 0;
      this.currentLogFile = path.join(this.logDir, this.getLogFileName(newDate));

      // Open new stream
      this.openWriteStream();
      console.log(`📝 Daily log rotation: ${this.currentLogFile}`);

      // Cleanup old logs
      this.cleanupOldLogs();
    } catch (error) {
      console.error('Failed to rotate daily log:', error);
    }
  }

  /**
   * Check and rotate log file if size exceeded
   */
  private checkSizeRotation() {
    if (!this.currentLogFile || !this.logDir) return;

    try {
      const stats = fs.statSync(this.currentLogFile);
      if (stats.size >= this.maxFileSize) {
        this.rotateIntraDay();
      }
    } catch {
      // File doesn't exist yet, no rotation needed
    }
  }

  /**
   * Rotate within the same day (size-based)
   */
  private rotateIntraDay() {
    if (!this.currentLogFile || !this.logDir || !this.currentDate) return;

    // Close current stream
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = undefined;
    }

    // Increment rotation count and create new file
    this.intraDayRotationCount++;
    this.currentLogFile = path.join(this.logDir, this.getLogFileName(this.currentDate, this.intraDayRotationCount));

    // Open new stream
    this.openWriteStream();
    console.log(`📝 Intra-day log rotation: ${this.currentLogFile}`);
  }

  /**
   * Cleanup log files older than retention period
   */
  private cleanupOldLogs() {
    if (!this.logDir) return;

    try {
      const files = fs.readdirSync(this.logDir);
      const now = new Date();
      const cutoffDate = new Date(now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000);

      for (const file of files) {
        // Match agent-YYYY-MM-DD.log or agent-YYYY-MM-DD.N.log pattern
        const match = file.match(/^agent-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.log$/);
        if (match) {
          const fileDate = new Date(match[1]);
          if (fileDate < cutoffDate) {
            const filePath = path.join(this.logDir, file);
            fs.unlinkSync(filePath);
            console.log(`🗑️  Deleted old log: ${file}`);
          }
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old logs:', error);
    }
  }

  /**
   * Write to log file
   */
  private writeToFile(message: string) {
    if (!this.logDir) return;

    // Check for daily rotation
    this.checkDailyRotation();
    // Check for size rotation
    this.checkSizeRotation();

    // If stream is not available, try to reopen it
    if (!this.writeStream) {
      this.openWriteStream();
    }

    // Write to stream if available
    if (this.writeStream) {
      try {
        this.writeStream.write(message + '\n');
      } catch (error) {
        console.error('Error writing to log file:', error);
        this.writeStream = undefined;
      }
    }
  }

  /**
   * Get current log level
   */
  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Get current log file path
   */
  getCurrentLogFile(): string | undefined {
    return this.currentLogFile;
  }

  /**
   * Get log directory
   */
  getLogDir(): string | undefined {
    return this.logDir;
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
   * Format args for file output
   */
  private formatArgs(args: any[]): string {
    if (args.length === 0) return '';
    return ' ' + args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
  }

  /**
   * Debug level log
   */
  debug(message: string, ...args: any[]) {
    if (this.shouldLog('debug')) {
      const formatted = this.formatMessage('debug', message);
      if (this.logToConsole) {
        console.log(formatted, ...args);
      }
      this.writeToFile(formatted + this.formatArgs(args));
    }
  }

  /**
   * Info level log
   */
  info(message: string, ...args: any[]) {
    if (this.shouldLog('info')) {
      const formatted = this.formatMessage('info', message);
      if (this.logToConsole) {
        console.log(formatted, ...args);
      }
      this.writeToFile(formatted + this.formatArgs(args));
    }
  }

  /**
   * Warning level log
   */
  warn(message: string, ...args: any[]) {
    if (this.shouldLog('warn')) {
      const formatted = this.formatMessage('warn', message);
      if (this.logToConsole) {
        console.warn(formatted, ...args);
      }
      this.writeToFile(formatted + this.formatArgs(args));
    }
  }

  /**
   * Error level log
   */
  error(message: string, ...args: any[]) {
    if (this.shouldLog('error')) {
      const formatted = this.formatMessage('error', message);
      if (this.logToConsole) {
        console.error(formatted, ...args);
      }
      this.writeToFile(formatted + this.formatArgs(args));
    }
  }

  /**
   * Raw log without formatting (for special cases like status display)
   */
  raw(message: string) {
    if (this.logToConsole) {
      console.log(message);
    }
    this.writeToFile(message);
  }

  /**
   * Log with custom prefix (no level, just timestamp)
   */
  log(prefix: string, message: string) {
    let formatted: string;
    if (this.showTimestamp) {
      formatted = `[${this.formatTimestamp()}] ${prefix} ${message}`;
    } else {
      formatted = `${prefix} ${message}`;
    }
    if (this.logToConsole) {
      console.log(formatted);
    }
    this.writeToFile(formatted);
  }

  /**
   * Close the logger (flush and close file stream)
   */
  close() {
    if (this.rotationCheckInterval) {
      clearInterval(this.rotationCheckInterval);
      this.rotationCheckInterval = undefined;
    }
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = undefined;
    }
  }

  /**
   * List all log files
   */
  listLogFiles(): { name: string; size: number; date: string }[] {
    if (!this.logDir) return [];

    try {
      const files = fs.readdirSync(this.logDir);
      return files
        .filter(f => f.match(/^agent-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/))
        .map(name => {
          const filePath = path.join(this.logDir!, name);
          const stats = fs.statSync(filePath);
          const match = name.match(/^agent-(\d{4}-\d{2}-\d{2})/);
          return {
            name,
            size: stats.size,
            date: match ? match[1] : '',
          };
        })
        .sort((a, b) => b.date.localeCompare(a.date));
    } catch {
      return [];
    }
  }
}

// Export singleton instance
export const logger = new Logger();

// Export class for testing
export { Logger };
