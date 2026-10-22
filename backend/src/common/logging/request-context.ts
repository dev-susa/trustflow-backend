import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

interface RequestContextValue {
  requestId: string;
  request?: Request;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContextValue>();

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_LOG_PATTERN = /requestId=/i;

function getHeaderValue(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}

export function getRequestId(request?: Partial<Request>): string {
  if (!request) {
    return requestContextStorage.getStore()?.requestId ?? `req_${randomUUID()}`;
  }

  const headerValue = getHeaderValue(
    typeof request.get === 'function' ? request.get(REQUEST_ID_HEADER) : request.headers?.[REQUEST_ID_HEADER],
  );

  if (headerValue) {
    return headerValue;
  }

  return requestContextStorage.getStore()?.requestId ?? `req_${randomUUID()}`;
}

export function runWithRequestContext<T>(requestId: string, callback: () => T): T {
  return requestContextStorage.run({ requestId }, callback);
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingRequestId = getHeaderValue(
    typeof req.get === 'function' ? req.get(REQUEST_ID_HEADER) : req.headers?.[REQUEST_ID_HEADER],
  );
  const requestId = incomingRequestId ?? `req_${randomUUID()}`;

  req.headers[REQUEST_ID_HEADER] = requestId;
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);

  requestContextStorage.run({ requestId, request: req }, () => next());
}

export function enableRequestContextLogging(): void {
  const loggerPrototype = Logger.prototype as Logger & {
    __requestContextLoggingEnabled?: boolean;
  };

  if (loggerPrototype.__requestContextLoggingEnabled) {
    return;
  }

  const methods = ['log', 'error', 'warn', 'debug', 'verbose'] as const;

  for (const methodName of methods) {
    const originalMethod = Logger.prototype[methodName] as (...args: unknown[]) => void;

    Logger.prototype[methodName] = function (...args: unknown[]) {
      const requestId = requestContextStorage.getStore()?.requestId;
      const [firstArg] = args;

      if (typeof firstArg === 'string' && requestId && !REQUEST_ID_LOG_PATTERN.test(firstArg)) {
        args[0] = `[requestId=${requestId}] ${firstArg}`;
      }

      return originalMethod.apply(this, args);
    };
  }

  loggerPrototype.__requestContextLoggingEnabled = true;
}
