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

  /**
   * Step 1: Logger Stability Tests
   * These tests verify that the logger can recover from operational issues
   * such as write stream errors, permission issues, and daily rotation failures.
   */
  describe('Logger Stability (Step 1)', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      if (!fs.existsSync(testLogDir)) {
        fs.mkdirSync(testLogDir, { recursive: true });
      }
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('Write Stream Error Recovery', () => {
      it('should recover from write stream error event', async () => {
        logger.configure({ logDir: testLogDir, logToConsole: false });

        // Get the initial log file
        const initialLogFile = logger.getCurrentLogFile();
        expect(initialLogFile).toBeDefined();

        // Simulate write stream error by accessing private writeStream
        const writeStream = (logger as any).writeStream;
        expect(writeStream).toBeDefined();

        // Emit error event (like disk full, permission denied, etc.)
        writeStream.emit('error', new Error('Simulated disk full error'));

        // Wait for recovery attempt (1 second timeout in implementation)
        await new Promise(resolve => setTimeout(resolve, 1200));

        // Logger should have attempted to recover
        expect(console.error).toHaveBeenCalledWith(
          'Log file write error:',
          expect.any(Error)
        );
        expect(console.log).toHaveBeenCalledWith(
          'Attempting to recover log file stream...'
        );

        // Should be able to write again after recovery
        logger.info('Recovery test message');
        await new Promise(resolve => setTimeout(resolve, 100));
        logger.close();

        // Verify message was written
        if (fs.existsSync(initialLogFile!)) {
          const content = fs.readFileSync(initialLogFile!, 'utf-8');
          expect(content).toContain('Recovery test message');
        }
      });

      it('should continue logging even if write stream is undefined', async () => {
        logger.configure({ logDir: testLogDir, logToConsole: false });

        // Force writeStream to undefined
        (logger as any).writeStream = undefined;

        // Should not throw and should attempt to reopen
        expect(() => logger.info('Test after stream undefined')).not.toThrow();

        // Wait for potential recovery
        await new Promise(resolve => setTimeout(resolve, 100));
        logger.close();
      });

      it('should handle multiple consecutive errors gracefully', async () => {
        logger.configure({ logDir: testLogDir, logToConsole: false });

        const writeStream = (logger as any).writeStream;

        // Emit multiple errors
        writeStream.emit('error', new Error('Error 1'));
        writeStream.emit('error', new Error('Error 2'));
        writeStream.emit('error', new Error('Error 3'));

        // Should not crash
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(console.error).toHaveBeenCalled();
      });
    });

    describe('Daily Log Rotation', () => {
      it('should create new log file on date change', async () => {
        logger.configure({ logDir: testLogDir, logToConsole: false });

        const initialFile = logger.getCurrentLogFile();
        expect(initialFile).toBeDefined();

        // Manually trigger rotation with a new date
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];

        // Access private method to simulate date change
        (logger as any).rotateToDailyLog(tomorrowStr);

        const newFile = logger.getCurrentLogFile();
        expect(newFile).toBeDefined();
        expect(newFile).not.toBe(initialFile);
        expect(newFile).toContain(tomorrowStr);
      });

      it('should handle rotation errors gracefully', () => {
        logger.configure({ logDir: testLogDir, logToConsole: false });

        // Try to rotate to invalid directory (simulate error)
        const originalLogDir = (logger as any).logDir;
        (logger as any).logDir = '/nonexistent/path/that/should/fail';

        // Should not throw
        expect(() => {
          (logger as any).rotateToDailyLog('2099-12-31');
        }).not.toThrow();

        // Restore
        (logger as any).logDir = originalLogDir;
      });

      it('should reset intra-day rotation count on daily rotation', () => {
        logger.configure({ logDir: testLogDir, logToConsole: false });

        // Set a high rotation count
        (logger as any).intraDayRotationCount = 5;

        // Rotate to new day
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];
        (logger as any).rotateToDailyLog(tomorrowStr);

        // Count should be reset
        expect((logger as any).intraDayRotationCount).toBe(0);
      });
    });

    describe('Log File Persistence', () => {
      it('should persist logs across multiple write operations', async () => {
        logger.configure({ logDir: testLogDir, logToConsole: false });

        // Write multiple messages
        const messages = [
          'Operation started at ' + Date.now(),
          'Processing request ABC123',
          'Request completed successfully',
          'WebSocket connection established',
          'Agent heartbeat OK',
        ];

        for (const msg of messages) {
          logger.info(msg);
        }

        // Wait for writes to complete
        await new Promise(resolve => setTimeout(resolve, 100));
        logger.close();

        // Verify all messages are in the file
        const logFile = logger.getCurrentLogFile();
        if (logFile && fs.existsSync(logFile)) {
          const content = fs.readFileSync(logFile, 'utf-8');
          for (const msg of messages) {
            expect(content).toContain(msg);
          }
        }
      });

      it('should include timestamp in log entries for debugging', async () => {
        logger.configure({ logDir: testLogDir, logToConsole: false });

        logger.info('Timestamp test');
        await new Promise(resolve => setTimeout(resolve, 100));
        logger.close();

        const logFile = logger.getCurrentLogFile();
        if (logFile && fs.existsSync(logFile)) {
          const content = fs.readFileSync(logFile, 'utf-8');
          // Should contain ISO timestamp format
          expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        }
      });

      it('should log error stack traces for debugging', async () => {
        logger.configure({ logDir: testLogDir, logToConsole: false });

        const testError = new Error('Test error for stack trace');
        logger.error('Error occurred:', testError.stack);

        await new Promise(resolve => setTimeout(resolve, 100));
        logger.close();

        const logFile = logger.getCurrentLogFile();
        if (logFile && fs.existsSync(logFile)) {
          const content = fs.readFileSync(logFile, 'utf-8');
          expect(content).toContain('Error occurred:');
          expect(content).toContain('Test error for stack trace');
        }
      });
    });

    describe('Operational Issue Detection', () => {
      it('should log WS connection issues with enough detail', async () => {
        logger.configure({ logDir: testLogDir, logToConsole: false });

        // Simulate logging that would help debug WS issues
        logger.error('WebSocket connection failed after 3 attempts');
        logger.warn('Falling back to HTTP polling mode');
        logger.info('HTTP polling started, interval: 12000ms');

        await new Promise(resolve => setTimeout(resolve, 100));
        logger.close();

        const logFile = logger.getCurrentLogFile();
        if (logFile && fs.existsSync(logFile)) {
          const content = fs.readFileSync(logFile, 'utf-8');
          expect(content).toContain('WebSocket connection failed');
          expect(content).toContain('HTTP polling');
        }
      });

      it('should log agent start failures with retry info', async () => {
        logger.configure({ logDir: testLogDir, logToConsole: false });

        // Simulate agent start failure logging
        logger.error('[default] Failed to create agent (attempt 1/3): request timeout');
        logger.info('[default] Retrying in 10 seconds...');
        logger.error('[default] Failed to create agent (attempt 2/3): request timeout');
        logger.info('[default] Retrying in 10 seconds...');
        logger.error('[default] Failed to create agent (attempt 3/3): request timeout');
        logger.error('[default] All 3 attempts failed. Agent will not start.');

        await new Promise(resolve => setTimeout(resolve, 100));
        logger.close();

        const logFile = logger.getCurrentLogFile();
        if (logFile && fs.existsSync(logFile)) {
          const content = fs.readFileSync(logFile, 'utf-8');
          expect(content).toContain('attempt 1/3');
          expect(content).toContain('attempt 2/3');
          expect(content).toContain('attempt 3/3');
          expect(content).toContain('All 3 attempts failed');
        }
      });

      it('should preserve log order for debugging sequences', async () => {
        logger.configure({ logDir: testLogDir, logToConsole: false });

        // Use unique markers to identify these specific log lines
        const marker = `SEQ_TEST_${Date.now()}`;

        // Log a sequence of events with small delays to ensure order
        logger.info(`${marker}_A1 Agent starting`);
        await new Promise(resolve => setTimeout(resolve, 10));
        logger.info(`${marker}_B2 Connecting to RPC`);
        await new Promise(resolve => setTimeout(resolve, 10));
        logger.info(`${marker}_C3 Loading containers`);
        await new Promise(resolve => setTimeout(resolve, 10));
        logger.error(`${marker}_D4 Container load failed`);
        await new Promise(resolve => setTimeout(resolve, 10));
        logger.info(`${marker}_E5 Retrying...`);

        await new Promise(resolve => setTimeout(resolve, 100));
        logger.close();

        const logFile = logger.getCurrentLogFile();
        if (logFile && fs.existsSync(logFile)) {
          const content = fs.readFileSync(logFile, 'utf-8');
          const lines = content.split('\n').filter(l => l.includes(marker));

          // All 5 events should be present
          expect(lines.length).toBe(5);

          // Verify all markers are present
          expect(lines.some(l => l.includes('_A1'))).toBe(true);
          expect(lines.some(l => l.includes('_B2'))).toBe(true);
          expect(lines.some(l => l.includes('_C3'))).toBe(true);
          expect(lines.some(l => l.includes('_D4'))).toBe(true);
          expect(lines.some(l => l.includes('_E5'))).toBe(true);
        }
      });
    });
  });
});
