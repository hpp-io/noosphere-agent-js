import { describe, it, expect, vi } from 'vitest';
import { inputGuard, compileInputValidators } from '../src/seller/validate-input';
import type { SellerServiceEntry } from '../src/seller/types';

const base: SellerServiceEntry = {
  name: 'llm', containerId: '0xabc', settlement: 'direct',
  network: 'eip155:181228', x402Price: '10000', schemes: ['exact'],
};

const withSchema = (schema: Record<string, unknown>): SellerServiceEntry => ({
  ...base,
  inputSchema: schema,
});

function run(guard: ReturnType<typeof inputGuard>, method: string, path: string, body: unknown) {
  const req: any = { method, path, body };
  const res: any = {
    statusCode: 200, body: undefined,
    status(c: number) { res.statusCode = c; return res; },
    json(b: unknown) { res.body = b; return res; },
  };
  const next = vi.fn();
  guard(req, res, next);
  return { res, next };
}

describe('compileInputValidators', () => {
  it('compiles only services that declare an inputSchema', () => {
    const v = compileInputValidators([base, withSchema({ type: 'object', required: ['prompt'] })]);
    expect(v.has('llm')).toBe(true);
    expect(v.size).toBe(1);
  });

  it('throws on an invalid schema', () => {
    expect(() => compileInputValidators([withSchema({ type: 'not-a-real-type' })]))
      .toThrow(/invalid inputSchema/);
  });
});

describe('inputGuard', () => {
  const schema = {
    type: 'object',
    required: ['prompt'],
    properties: { prompt: { type: 'string' }, model: { type: 'string' } },
    additionalProperties: false,
  };

  it('passes valid input to the payment layer (next)', () => {
    const guard = inputGuard([withSchema(schema)]);
    const { res, next } = run(guard, 'POST', '/paid/compute/llm', { prompt: 'hi' });
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('rejects invalid input with 400 BEFORE payment', () => {
    const guard = inputGuard([withSchema(schema)]);
    const { res, next } = run(guard, 'POST', '/paid/compute/llm', { model: 'x' }); // missing prompt
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_input');
    expect(res.body.service).toBe('llm');
    expect(res.body.details.join(' ')).toMatch(/prompt/);
  });

  it('rejects unknown properties when additionalProperties is false', () => {
    const guard = inputGuard([withSchema(schema)]);
    const { res, next } = run(guard, 'POST', '/paid/compute/llm', { prompt: 'hi', foo: 1 });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('passes through services without an inputSchema', () => {
    const guard = inputGuard([base]);
    const { res, next } = run(guard, 'POST', '/paid/compute/llm', { anything: true });
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('ignores non-paid paths and non-POST methods', () => {
    const guard = inputGuard([withSchema(schema)]);
    const a = run(guard, 'GET', '/paid/compute/llm', {});
    expect(a.next).toHaveBeenCalled();
    const b = run(guard, 'POST', '/api/health', {});
    expect(b.next).toHaveBeenCalled();
    const c = run(guard, 'POST', '/paid/compute/other', {}); // no validator for 'other'
    expect(c.next).toHaveBeenCalled();
  });
});
