/**
 * Logger Utility
 *
 * Provides consistent logging with timestamps and configurable log levels.
 * Supports both console and file-based logging with rotation.
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
  maxFileSize?: number; // Max size in bytes before rotation (default: 10MB)
  maxFiles?: number; // Max number of rotated files to keep (default: 5)
}

class Logger {
  private level: LogLevel = 'info';
  private showTimestamp: boolean = true;
  private logDir?: string;
  private maxFileSize: number = 10 * 1024 * 1024; // 10MB
  private maxFiles: number = 5;
  private currentLogFile?: string;
  private writeStream?: fs.WriteStream;

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
    if (options.maxFiles !== undefined) {
      this.maxFiles = options.maxFiles;
    }
    if (options.logDir !== undefined) {
      this.logDir = options.logDir;
      this.initFileLogging();
    }
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

      this.currentLogFile = path.join(this.logDir, 'agent.log');
      this.openWriteStream();
      console.log(`📝 File logging enabled: ${this.currentLogFile}`);
    } catch (error) {
      console.error('Failed to initialize file logging:', error);
    }
  }

  /**
   * Open write stream for current log file
   */
  private openWriteStream() {
    if (!this.currentLogFile) return;

    if (this.writeStream) {
      this.writeStream.end();
    }

    this.writeStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });
    this.writeStream.on('error', (error) => {
      console.error('Log file write error:', error);
    });
  }

  /**
   * Check and rotate log file if needed
   */
  private checkRotation() {
    if (!this.currentLogFile || !this.logDir) return;

    try {
      const stats = fs.statSync(this.currentLogFile);
      if (stats.size >= this.maxFileSize) {
        this.rotateLogFile();
      }
    } catch {
      // File doesn't exist yet, no rotation needed
    }
  }

  /**
   * Rotate log files
   */
  private rotateLogFile() {
    if (!this.currentLogFile || !this.logDir) return;

    // Close current stream
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = undefined;
    }

    // Rotate existing files
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const oldFile = path.join(this.logDir, `agent.log.${i}`);
      const newFile = path.join(this.logDir, `agent.log.${i + 1}`);
      if (fs.existsSync(oldFile)) {
        if (i === this.maxFiles - 1) {
          fs.unlinkSync(oldFile); // Delete oldest
        } else {
          fs.renameSync(oldFile, newFile);
        }
      }
    }

    // Rename current log to .1
    const rotatedFile = path.join(this.logDir, 'agent.log.1');
    if (fs.existsSync(this.currentLogFile)) {
      fs.renameSync(this.currentLogFile, rotatedFile);
    }

    // Open new stream
    this.openWriteStream();
    console.log(`📝 Log file rotated: ${rotatedFile}`);
  }

  /**
   * Write to log file
   */
  private writeToFile(message: string) {
    if (!this.writeStream || !this.logDir) return;

    this.checkRotation();
    this.writeStream.write(message + '\n');
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
      console.log(formatted, ...args);
      this.writeToFile(formatted + this.formatArgs(args));
    }
  }

  /**
   * Info level log
   */
  info(message: string, ...args: any[]) {
    if (this.shouldLog('info')) {
      const formatted = this.formatMessage('info', message);
      console.log(formatted, ...args);
      this.writeToFile(formatted + this.formatArgs(args));
    }
  }

  /**
   * Warning level log
   */
  warn(message: string, ...args: any[]) {
    if (this.shouldLog('warn')) {
      const formatted = this.formatMessage('warn', message);
      console.warn(formatted, ...args);
      this.writeToFile(formatted + this.formatArgs(args));
    }
  }

  /**
   * Error level log
   */
  error(message: string, ...args: any[]) {
    if (this.shouldLog('error')) {
      const formatted = this.formatMessage('error', message);
      console.error(formatted, ...args);
      this.writeToFile(formatted + this.formatArgs(args));
    }
  }

  /**
   * Raw log without formatting (for special cases like status display)
   */
  raw(message: string) {
    console.log(message);
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
    console.log(formatted);
    this.writeToFile(formatted);
  }

  /**
   * Close the logger (flush and close file stream)
   */
  close() {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = undefined;
    }
  }
}

// Export singleton instance
export const logger = new Logger();

// Export class for testing
export { Logger };
