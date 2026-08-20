/**
 * x402 Seller — input validation.
 *
 * Generic JSON-Schema validation (ajv) of the request body against each
 * service's `inputSchema`. Only requests that carry a payment header are
 * validated: rejecting a paid attempt with 400 spares the buyer from signing
 * for a request the container could not have served, while an unpaid request
 * must fall through to the payment gate so it gets the 402 challenge —
 * discovery probes send an empty body and read the price/metadata off that
 * 402, so a 400 here would delist the service's price. Schemas are
 * per-service config — no service-specific validation logic lives in code.
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
    // Unpaid request → let the payment gate answer with the 402 challenge.
    if (!req.header('payment-signature') && !req.header('x-payment')) return next();

    if (validate(req.body ?? {})) return next();

    res.status(400).json({
      error: 'invalid_input',
      service: match[1],
      details: (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`.trim()),
    });
  };
}
