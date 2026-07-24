/**
 * x402 Seller — input validation.
 *
 * Generic JSON-Schema validation (ajv) of the request body against each
 * service's `inputSchema`, BEFORE the payment challenge. Invalid input is
 * rejected with 400 so the buyer is never asked to pay for a request the
 * container could not have served. Schemas are per-service config — no
 * service-specific validation logic lives in code here.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { SellerServiceEntry } from './types';

const PATH_RE = /^\/paid\/compute\/([^/]+)$/;

/**
 * Compile a validator per service that declares an inputSchema.
 * Throws on an invalid schema so misconfig surfaces at boot, not at runtime.
 */
export function compileInputValidators(services: SellerServiceEntry[]): Map<string, ValidateFunction> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validators = new Map<string, ValidateFunction>();
  for (const svc of services) {
    if (svc.inputSchema) {
      try {
        validators.set(svc.name, ajv.compile(svc.inputSchema));
      } catch (err) {
        throw new Error(`x402Seller: service "${svc.name}" has an invalid inputSchema — ${(err as Error).message}`);
      }
    }
  }
  return validators;
}

/**
 * Express middleware that validates the body of POST /paid/compute/<name>
 * against the service's inputSchema. Mount BEFORE the payment middleware.
 */
export function inputGuard(services: SellerServiceEntry[]): RequestHandler {
  const validators = compileInputValidators(services);
  if (validators.size === 0) {
    return (_req, _res, next) => next();
  }
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') return next();
    const match = PATH_RE.exec(req.path);
    if (!match) return next();
    const validate = validators.get(match[1]);
    if (!validate) return next();

    if (validate(req.body ?? {})) return next();

    res.status(400).json({
      error: 'invalid_input',
      service: match[1],
      details: (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`.trim()),
    });
  };
}
