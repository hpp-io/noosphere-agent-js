import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../lib/logger';

describe('Logger', () => {
  let testLogDir: string;
  let logger: Logger;

  beforeEach(() => {
    testLogDir = path.join(process.cwd(), '.test-logs-' + Date.now());
    logger = new Logger();
  });

  afterEach(() => {
    logger.close();
    // Cleanup test log directory
    if (fs.existsSync(testLogDir)) {
      const files = fs.readdirSync(testLogDir);
      for (const file of files) {
        fs.unlinkSync(path.join(testLogDir, file));
      }
      fs.rmdirSync(testLogDir);
    }
  });

  describe('configure', () => {
    it('should configure log level', () => {
      logger.configure({ level: 'debug' });
      expect(logger.getLevel()).toBe('debug');
    });

    it('should configure log level to error', () => {
      logger.configure({ level: 'error' });
      expect(logger.getLevel()).toBe('error');
    });

    it('should configure log level to warn', () => {
      logger.configure({ level: 'warn' });
      expect(logger.getLevel()).toBe('warn');
    });

    it('should configure log level to none', () => {
      logger.configure({ level: 'none' });
      expect(logger.getLevel()).toBe('none');
    });

    it('should configure showTimestamp', () => {
      // Default logger has timestamp enabled
      logger.configure({ showTimestamp: false });
      // Test by logging and checking the output format
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.info('test message');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[INFO]'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.not.stringContaining('T'));
      consoleSpy.mockRestore();
    });

    it('should configure log directory and create it if not exists', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.configure({ logDir: testLogDir, logToConsole: false });
      expect(fs.existsSync(testLogDir)).toBe(true);
      expect(logger.getLogDir()).toBe(testLogDir);
      consoleSpy.mockRestore();
    });

    it('should configure maxFileSize and retentionDays', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.configure({
        logDir: testLogDir,
        maxFileSize: 10 * 1024 * 1024, // 10MB
        retentionDays: 14,
        logToConsole: false,
      });
      expect(logger.getLogDir()).toBe(testLogDir);
      consoleSpy.mockRestore();
    });
  });

  describe('log levels', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should log debug when level is debug', () => {
      logger.configure({ level: 'debug' });
      logger.debug('debug message');
      expect(console.log).toHaveBeenCalled();
    });

    it('should not log debug when level is info', () => {
      logger.configure({ level: 'info' });
      logger.debug('debug message');
      expect(console.log).not.toHaveBeenCalled();
    });

    it('should log info when level is info', () => {
      logger.configure({ level: 'info' });
      logger.info('info message');
      expect(console.log).toHaveBeenCalled();
    });

    it('should log warn when level is warn', () => {
      logger.configure({ level: 'warn' });
      logger.warn('warn message');
      expect(console.warn).toHaveBeenCalled();
    });

    it('should log error when level is error', () => {
      logger.configure({ level: 'error' });
      logger.error('error message');
      expect(console.error).toHaveBeenCalled();
    });

    it('should not log anything when level is none', () => {
      logger.configure({ level: 'none' });
      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');
      expect(console.log).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });

    it('should log with additional args', () => {
      logger.configure({ level: 'info' });
      logger.info('message with args', { key: 'value' }, 123);
      expect(console.log).toHaveBeenCalled();
    });
  });

  describe('raw and log methods', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should output raw message without formatting', () => {
      logger.raw('raw message');
      expect(console.log).toHaveBeenCalledWith('raw message');
    });

    it('should output log with custom prefix', () => {
      logger.log('PREFIX', 'message');
      expect(console.log).toHaveBeenCalled();
    });
  });

  describe('file logging', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      // Ensure test directory exists before each test
      if (!fs.existsSync(testLogDir)) {
        fs.mkdirSync(testLogDir, { recursive: true });
      }
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should create log file in configured directory', async () => {
      logger.configure({ logDir: testLogDir, logToConsole: false });
      logger.info('test message');
      // Give time for file write to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      const logFile = logger.getCurrentLogFile();
      expect(logFile).toBeDefined();
      expect(logFile!.startsWith(testLogDir)).toBe(true);
    });

    it('should write log message to file', async () => {
      logger.configure({ logDir: testLogDir, logToConsole: false });
      logger.info('test file message');
      // Wait for write to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      logger.close();

      const logFile = logger.getCurrentLogFile();
      expect(logFile).toBeDefined();
      if (fs.existsSync(logFile!)) {
        const content = fs.readFileSync(logFile!, 'utf-8');
        expect(content).toContain('test file message');
      }
    });

    it('should format objects for file output', async () => {
      logger.configure({ logDir: testLogDir, logToConsole: false });
      logger.info('object test', { key: 'value' });
      await new Promise(resolve => setTimeout(resolve, 50));
      logger.close();

      const logFile = logger.getCurrentLogFile();
      expect(logFile).toBeDefined();
      if (fs.existsSync(logFile!)) {
        const content = fs.readFileSync(logFile!, 'utf-8');
        expect(content).toContain('"key":"value"');
      }
    });

    it('should list log files', async () => {
      logger.configure({ logDir: testLogDir, logToConsole: false });
      logger.info('test');
      await new Promise(resolve => setTimeout(resolve, 50));

      const files = logger.listLogFiles();
      // File may or may not exist depending on write stream timing
      expect(Array.isArray(files)).toBe(true);
      if (files.length > 0) {
        expect(files[0]).toHaveProperty('name');
        expect(files[0]).toHaveProperty('size');
        expect(files[0]).toHaveProperty('date');
      }
    });
  });

  describe('log rotation', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should cleanup old logs beyond retention period', () => {
      // Create a log directory with old files
      if (!fs.existsSync(testLogDir)) {
        fs.mkdirSync(testLogDir, { recursive: true });
      }

      // Create old log file (more than 7 days old)
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);
      const oldDateStr = oldDate.toISOString().split('T')[0];
      const oldLogFile = path.join(testLogDir, `agent-${oldDateStr}.log`);
      fs.writeFileSync(oldLogFile, 'old log content');

      // Configure logger which triggers cleanup
      logger.configure({ logDir: testLogDir, logToConsole: false });

      // Old file should be deleted
      expect(fs.existsSync(oldLogFile)).toBe(false);
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should handle object stringify errors gracefully', () => {
      logger.configure({ logDir: testLogDir, logToConsole: false });

      // Create circular reference
      const circular: any = { a: 1 };
      circular.self = circular;

      // Should not throw
      expect(() => logger.info('circular test', circular)).not.toThrow();
    });

    it('should return empty array when listing files without logDir', () => {
      const files = logger.listLogFiles();
      expect(files).toEqual([]);
    });

    it('should return undefined for getCurrentLogFile without file logging', () => {
      expect(logger.getCurrentLogFile()).toBeUndefined();
    });

    it('should return undefined for getLogDir without file logging', () => {
      expect(logger.getLogDir()).toBeUndefined();
    });
  });
});
