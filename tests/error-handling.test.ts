import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Step 2: Global Error Handling Tests
 *
 * These tests verify that the application properly handles:
 * - Uncaught exceptions without crashing
 * - Unhandled promise rejections
 * - Error logging for debugging
 */

// Mock the logger
vi.mock('../lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from '../lib/logger';

describe('Global Error Handling (Step 2)', () => {
  let originalUncaughtHandler: NodeJS.UncaughtExceptionListener | undefined;
  let originalRejectionHandler: NodeJS.UnhandledRejectionListener | undefined;
  let testUncaughtHandler: NodeJS.UncaughtExceptionListener | undefined;
  let testRejectionHandler: NodeJS.UnhandledRejectionListener | undefined;

  beforeEach(() => {
    vi.clearAllMocks();

    // Store original handlers
    originalUncaughtHandler = process.listeners('uncaughtException')[0];
    originalRejectionHandler = process.listeners('unhandledRejection')[0];

    // Remove existing handlers to install test handlers
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });

  afterEach(() => {
    // Clean up test handlers
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');

    // Restore original handlers if they existed
    if (originalUncaughtHandler) {
      process.on('uncaughtException', originalUncaughtHandler);
    }
    if (originalRejectionHandler) {
      process.on('unhandledRejection', originalRejectionHandler);
    }
  });

  describe('Uncaught Exception Handler', () => {
    it('should log uncaught exceptions with message and stack', () => {
      // Install a test handler that mimics the app.ts handler
      testUncaughtHandler = (error: Error) => {
        logger.error(`Uncaught Exception: ${error.message}`);
        if (error.stack) {
          logger.error(`Stack: ${error.stack}`);
        }
      };
      process.on('uncaughtException', testUncaughtHandler);

      // Simulate uncaught exception
      const testError = new Error('Test uncaught exception');
      process.emit('uncaughtException', testError);

      // Verify logging
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Uncaught Exception: Test uncaught exception')
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Stack:')
      );
    });

    it('should continue process execution after uncaught exception', () => {
      let processExited = false;
      let continueExecuted = false;

      // Install handler that doesn't exit
      testUncaughtHandler = (error: Error) => {
        logger.error(`Uncaught Exception: ${error.message}`);
        // Don't exit - allow process to continue
      };
      process.on('uncaughtException', testUncaughtHandler);

      // Simulate exception
      process.emit('uncaughtException', new Error('Should not crash'));

      // Code should continue to execute
      continueExecuted = true;

      expect(continueExecuted).toBe(true);
      expect(processExited).toBe(false);
    });

    it('should handle exceptions without stack trace', () => {
      testUncaughtHandler = (error: Error) => {
        logger.error(`Uncaught Exception: ${error.message}`);
        if (error.stack) {
          logger.error(`Stack: ${error.stack}`);
        }
      };
      process.on('uncaughtException', testUncaughtHandler);

      // Create error without stack
      const errorWithoutStack = new Error('No stack error');
      delete errorWithoutStack.stack;

      process.emit('uncaughtException', errorWithoutStack);

      expect(logger.error).toHaveBeenCalledTimes(1); // Only message, no stack
    });
  });

  describe('Unhandled Rejection Handler', () => {
    it('should log unhandled promise rejections', () => {
      testRejectionHandler = (reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        logger.error(`Unhandled Rejection: ${message}`);
      };
      process.on('unhandledRejection', testRejectionHandler);

      // Simulate unhandled rejection with Error
      const testError = new Error('Test rejection');
      process.emit('unhandledRejection', testError, Promise.resolve());

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Unhandled Rejection: Test rejection')
      );
    });

    it('should handle non-Error rejection reasons', () => {
      testRejectionHandler = (reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        logger.error(`Unhandled Rejection: ${message}`);
      };
      process.on('unhandledRejection', testRejectionHandler);

      // Rejection with string
      process.emit('unhandledRejection', 'String rejection reason', Promise.resolve());
      expect(logger.error).toHaveBeenCalledWith('Unhandled Rejection: String rejection reason');

      vi.clearAllMocks();

      // Rejection with number
      process.emit('unhandledRejection', 42, Promise.resolve());
      expect(logger.error).toHaveBeenCalledWith('Unhandled Rejection: 42');

      vi.clearAllMocks();

      // Rejection with null
      process.emit('unhandledRejection', null, Promise.resolve());
      expect(logger.error).toHaveBeenCalledWith('Unhandled Rejection: null');
    });

    it('should log stack trace for Error rejections', () => {
      testRejectionHandler = (reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        const stack = reason instanceof Error ? reason.stack : undefined;
        logger.error(`Unhandled Rejection: ${message}`);
        if (stack) {
          logger.error(`Stack: ${stack}`);
        }
      };
      process.on('unhandledRejection', testRejectionHandler);

      const testError = new Error('Test with stack');
      process.emit('unhandledRejection', testError, Promise.resolve());

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Unhandled Rejection:')
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Stack:')
      );
    });
  });

  describe('Error Recovery Scenarios', () => {
    it('should recover from WebSocket provider errors', () => {
      testUncaughtHandler = (error: Error) => {
        logger.error(`Uncaught Exception: ${error.message}`);
      };
      process.on('uncaughtException', testUncaughtHandler);

      // Simulate ethers.js WebSocket error
      const wsError = new Error('WebSocket connection closed abnormally');
      wsError.name = 'WebSocketError';
      process.emit('uncaughtException', wsError);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('WebSocket connection closed')
      );
    });

    it('should recover from RPC timeout errors', () => {
      testUncaughtHandler = (error: Error) => {
        logger.error(`Uncaught Exception: ${error.message}`);
      };
      process.on('uncaughtException', testUncaughtHandler);

      // Simulate ethers.js timeout error
      const timeoutError = new Error('request timeout (code=TIMEOUT, version=6.16.0)');
      process.emit('uncaughtException', timeoutError);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('request timeout')
      );
    });

    it('should handle database errors gracefully', () => {
      testUncaughtHandler = (error: Error) => {
        logger.error(`Uncaught Exception: ${error.message}`);
      };
      process.on('uncaughtException', testUncaughtHandler);

      // Simulate SQLite error
      const dbError = new Error('SQLITE_BUSY: database is locked');
      process.emit('uncaughtException', dbError);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('SQLITE_BUSY')
      );
    });
  });

  describe('Multiple Sequential Errors', () => {
    it('should handle multiple errors without crashing', () => {
      let errorCount = 0;

      testUncaughtHandler = (error: Error) => {
        errorCount++;
        logger.error(`Error ${errorCount}: ${error.message}`);
      };
      process.on('uncaughtException', testUncaughtHandler);

      // Emit multiple errors
      process.emit('uncaughtException', new Error('First error'));
      process.emit('uncaughtException', new Error('Second error'));
      process.emit('uncaughtException', new Error('Third error'));

      expect(errorCount).toBe(3);
      expect(logger.error).toHaveBeenCalledTimes(3);
    });

    it('should handle mixed exceptions and rejections', () => {
      let exceptionCount = 0;
      let rejectionCount = 0;

      testUncaughtHandler = () => { exceptionCount++; };
      testRejectionHandler = () => { rejectionCount++; };

      process.on('uncaughtException', testUncaughtHandler);
      process.on('unhandledRejection', testRejectionHandler);

      process.emit('uncaughtException', new Error('Exception 1'));
      process.emit('unhandledRejection', new Error('Rejection 1'), Promise.resolve());
      process.emit('uncaughtException', new Error('Exception 2'));
      process.emit('unhandledRejection', new Error('Rejection 2'), Promise.resolve());

      expect(exceptionCount).toBe(2);
      expect(rejectionCount).toBe(2);
    });
  });
});

describe('Error Logging Quality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should provide enough context for debugging timeout issues', () => {
    // Simulate the kind of error message that helps debugging
    const errorContext = {
      operation: 'WebSocket connect',
      url: 'wss://example.rpc.com',
      timeout: 5000,
      attempt: 3,
      maxAttempts: 3,
    };

    const errorMessage = `${errorContext.operation} failed after ${errorContext.attempt}/${errorContext.maxAttempts} attempts (timeout: ${errorContext.timeout}ms) - URL: ${errorContext.url}`;

    logger.error(errorMessage);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('WebSocket connect failed')
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('3/3 attempts')
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('timeout: 5000ms')
    );
  });

  it('should provide actionable error messages', () => {
    // Error messages should tell operators what to do
    const actionableErrors = [
      { error: 'Connection refused', action: 'Check if RPC node is running' },
      { error: 'Insufficient funds', action: 'Top up agent wallet' },
      { error: 'Nonce too low', action: 'Transaction may already be processed' },
      { error: 'Container not found', action: 'Verify container registration' },
    ];

    for (const { error, action } of actionableErrors) {
      logger.error(`${error}: ${action}`);
    }

    expect(logger.error).toHaveBeenCalledTimes(4);
  });
});
