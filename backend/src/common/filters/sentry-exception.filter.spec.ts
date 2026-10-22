import { ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { SentryExceptionFilter } from './sentry-exception.filter';
import { SentryService } from '../../sentry/sentry.service';
import { enableRequestContextLogging, runWithRequestContext } from '../logging/request-context';

function buildHost(
  url = '/test',
  method = 'GET',
  ip = '127.0.0.1',
  requestId?: string,
) {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    setHeader: jest.fn(),
  };
  const headers = requestId ? { 'x-request-id': requestId } : {};
  const request = { url, method, ip, headers, get: (name: string) => headers[name.toLowerCase()] };
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
    response,
    request,
  } as unknown as ArgumentsHost;
}

describe('SentryExceptionFilter', () => {
  let filter: SentryExceptionFilter;
  let sentryService: jest.Mocked<SentryService>;

  beforeEach(() => {
    jest.clearAllMocks();
    enableRequestContextLogging();
    sentryService = {
      captureException: jest.fn().mockReturnValue('evt-id'),
      isInitialized: jest.fn().mockReturnValue(true),
    } as unknown as jest.Mocked<SentryService>;
    filter = new SentryExceptionFilter(sentryService);
  });

  it('should be defined', () => {
    expect(filter).toBeDefined();
  });

  describe('structured HttpException responses', () => {
    it('forwards extra fields the handler attached, without letting them override the standard ones', () => {
      const host = buildHost('/ipfs/pins/cid', 'DELETE');
      const exception = new HttpException(
        {
          statusCode: HttpStatus.BAD_GATEWAY,
          message: 'partial failure',
          error: 'Bad Gateway',
          failedProviders: ['pinata'],
          path: '/spoofed',
        },
        HttpStatus.BAD_GATEWAY,
      );
      filter.catch(exception, host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_GATEWAY);
      const body = response.json.mock.calls[0][0];
      expect(body).toMatchObject({
        statusCode: HttpStatus.BAD_GATEWAY,
        message: 'partial failure',
        failedProviders: ['pinata'],
        path: '/ipfs/pins/cid',
      });
      expect(body).not.toHaveProperty('error');
    });

    it('keeps the body unchanged when the response carries only the standard fields', () => {
      const host = buildHost();
      filter.catch(new HttpException('Not Found', HttpStatus.NOT_FOUND), host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(Object.keys(response.json.mock.calls[0][0]).sort()).toEqual(
        ['message', 'path', 'statusCode', 'timestamp'].sort(),
      );
    });
  });

  describe('HttpException — 4xx (client errors)', () => {
    it('should respond with 404 status and NOT capture to Sentry', () => {
      const host = buildHost();
      const exception = new HttpException('Not Found', HttpStatus.NOT_FOUND);
      filter.catch(exception, host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(sentryService.captureException).not.toHaveBeenCalled();
    });

    it('should respond with 400 and NOT send to Sentry', () => {
      const host = buildHost();
      const exception = new HttpException('Bad Request', HttpStatus.BAD_REQUEST);
      filter.catch(exception, host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(sentryService.captureException).not.toHaveBeenCalled();
    });
  });

  describe('HttpException — 5xx (server errors)', () => {
    it('should respond with 500 and capture to Sentry', () => {
      const host = buildHost();
      const exception = new HttpException('Internal Error', HttpStatus.INTERNAL_SERVER_ERROR);
      filter.catch(exception, host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(sentryService.captureException).toHaveBeenCalled();
    });
  });

  describe('non-HttpException errors that still carry a real HTTP status', () => {
    it('preserves the status from an Express/body-parser-style error (e.g. PayloadTooLargeError) instead of forcing 500', () => {
      const host = buildHost();
      // Mirrors body-parser's PayloadTooLargeError: a plain Error with .status/.statusCode
      // set, not a NestJS HttpException, thrown by middleware ahead of any Nest exception
      // filter.
      const exception = Object.assign(new Error('request entity too large'), {
        status: 413,
        statusCode: 413,
      });
      filter.catch(exception, host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(response.status).toHaveBeenCalledWith(413);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 413, message: 'request entity too large' }),
      );
      expect(sentryService.captureException).not.toHaveBeenCalled();
    });

    it('still captures to Sentry when the carried status is 5xx', () => {
      const host = buildHost();
      const exception = Object.assign(new Error('upstream exploded'), { status: 502 });
      filter.catch(exception, host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(response.status).toHaveBeenCalledWith(502);
      expect(sentryService.captureException).toHaveBeenCalled();
    });
  });

  describe('Unknown / non-HTTP exceptions', () => {
    it('should respond with 500 and capture to Sentry for plain Error', () => {
      const host = buildHost('/api/escrow', 'POST');
      const exception = new Error('Unexpected DB failure');
      filter.catch(exception, host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          message: 'Internal server error',
          path: '/api/escrow',
        }),
      );
      expect(sentryService.captureException).toHaveBeenCalled();
    });

    it('should handle thrown strings gracefully', () => {
      const host = buildHost();
      filter.catch('something broke', host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(response.status).toHaveBeenCalledWith(500);
      expect(sentryService.captureException).toHaveBeenCalled();
    });
  });

  describe('response shape', () => {
    it('should include timestamp and path in error response', () => {
      const host = buildHost('/api/auth/login', 'POST');
      filter.catch(new Error('crash'), host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      const body = response.json.mock.calls[0][0];
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('path', '/api/auth/login');
      expect(body).toHaveProperty('statusCode', 500);
    });
  });

  it('should propagate the request id to the logger and Sentry tags for the same request', () => {
    const requestId = 'req-123';
    const setTag = jest.fn();
    const setExtra = jest.fn();
    const setUser = jest.fn();
    const withScopeSpy = jest.spyOn(Sentry, 'withScope' as never).mockImplementation(
      ((scopeOrCallback: unknown, callback?: (scope: any) => unknown) => {
        const scope = { setTag, setExtra, setUser };
        if (typeof scopeOrCallback === 'function') {
          return (scopeOrCallback as (scope: any) => unknown)(scope);
        }
        return callback ? callback(scope) : undefined;
      }) as never,
    );
    const logSpy = jest.spyOn(Logger.prototype, 'error');

    runWithRequestContext(requestId, () => {
      filter.catch(new Error('crash'), buildHost('/api/auth/login', 'POST', '127.0.0.1', requestId));
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`requestId=${requestId}`), expect.any(String));
    expect(setTag).toHaveBeenCalledWith('request_id', requestId);
    expect(setTag).toHaveBeenCalledWith('correlation_id', requestId);
    expect(withScopeSpy).toHaveBeenCalled();
  });
});
