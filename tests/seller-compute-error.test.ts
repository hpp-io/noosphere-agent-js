import { describe, it, expect } from 'vitest';
import { classifyComputeFailure } from '../src/seller/compute-error';

describe('classifyComputeFailure', () => {
  it('container 4xx → 400 invalid_input with the container reason', () => {
    const failure = classifyComputeFailure(
      new Error('Container HTTP error 400: {"error":"audio_url host does not resolve"}'),
    );
    expect(failure).toEqual({ status: 400, error: 'invalid_input', detail: 'audio_url host does not resolve' });
  });

  it('any container 4xx counts, not just 400', () => {
    expect(classifyComputeFailure(new Error('Container HTTP error 422: {"error":"too long"}')).status).toBe(400);
  });

  it('non-JSON container body is passed through raw', () => {
    const failure = classifyComputeFailure(new Error('Container HTTP error 400: "just text"'));
    expect(failure.detail).toBe('"just text"');
  });

  it('container 5xx → 500 compute_failed, reason withheld', () => {
    const failure = classifyComputeFailure(new Error('Container HTTP error 500: {"error":"boom"}'));
    expect(failure).toEqual({ status: 500, error: 'compute_failed' });
  });

  it('non-container errors (timeout, connect) → 500 compute_failed', () => {
    expect(classifyComputeFailure(new Error('Container execution timeout after 180000ms'))).toEqual({
      status: 500,
      error: 'compute_failed',
    });
    expect(classifyComputeFailure('weird non-error')).toEqual({ status: 500, error: 'compute_failed' });
  });

  it('long details are truncated', () => {
    const failure = classifyComputeFailure(
      new Error(`Container HTTP error 400: {"error":"${'x'.repeat(1000)}"}`),
    );
    expect(failure.detail!.length).toBeLessThanOrEqual(301);
    expect(failure.detail!.endsWith('…')).toBe(true);
  });
});
