import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { generateKeyPairSync } from 'crypto';
import { AddressInfo } from 'net';
import { ArweaveArchiveService } from './arweave-archive.service';
import { DisputeSaga, DisputeStep, DisputeVerdict } from './dispute.types';
import { validateEnv } from '../config/env.config';

describe('ArweaveArchiveService', () => {
  let server: Server;
  let baseUrl: string;
  let jwk: Record<string, string>;
  let jwt: string;
  let captured: CapturedRequest[];
  let failUpload: boolean;
  let originalJwt: string | undefined;
  let originalUploadUrl: string | undefined;

  beforeEach(async () => {
    validateEnv();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ArweaveArchiveService],
    }).compile();

  beforeAll(async () => {
    originalJwt = process.env.ARWEAVE_JWT;
    originalUploadUrl = process.env.ARWEAVE_UPLOAD_URL;

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
    jwt = JSON.stringify(jwk);

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        // Arweave's client fetches an anchor and a price before signing.
        if (req.method === 'GET' && req.url === '/tx_anchor') {
          res.end('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
          return;
        }
        if (req.method === 'GET' && req.url?.startsWith('/price/')) {
          res.end('0');
          return;
        }
        if (req.method === 'POST' && req.url === '/tx') {
          captured.push({ method: req.method, url: req.url, headers: req.headers, body });
          if (failUpload) {
            res.statusCode = 500;
            res.end('upload rejected');
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          const { id } = JSON.parse(body) as { id: string };
          res.end(JSON.stringify({ id }));
          return;
        }
        res.statusCode = 404;
        res.end('not found');
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (originalJwt === undefined) delete process.env.ARWEAVE_JWT;
    else process.env.ARWEAVE_JWT = originalJwt;
    if (originalUploadUrl === undefined) delete process.env.ARWEAVE_UPLOAD_URL;
    else process.env.ARWEAVE_UPLOAD_URL = originalUploadUrl;
    resetEnvConfig();
  });

  beforeEach(() => {
    captured = [];
    failUpload = false;
    mockMetrics.increment.mockClear();
  });

  afterEach(() => {
    resetEnvConfig();
  });

  it('keeps simulated mode when Arweave is not configured', async () => {
    setArweaveEnv(undefined, undefined);
    const service = new ArweaveArchiveService(mockMetrics as never);

    await expect(service.archiveDispute(mockSaga)).resolves.toBeUndefined();
  });

  it('signs and uploads a real transaction to ARWEAVE_UPLOAD_URL', async () => {
    setArweaveEnv(jwt, baseUrl);
    const service = new ArweaveArchiveService(mockMetrics as never);

    const txId = await service.archiveDispute(mockSaga);

    expect(txId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(captured).toHaveLength(1);

    const uploaded = JSON.parse(captured[0].body) as {
      id: string;
      signature: string;
      tags: Array<{ name: string; value: string }>;
    };
    expect(uploaded.id).toBe(txId);
    expect(uploaded.signature).toEqual(expect.any(String));
    expect(uploaded.signature.length).toBeGreaterThan(0);
    expect(captured[0].headers['content-type']).toContain('application/json');

    const decodedTags = Object.fromEntries(
      uploaded.tags.map(tag => [
        Buffer.from(tag.name, 'base64').toString(),
        Buffer.from(tag.value, 'base64').toString(),
      ]),
    );
    expect(decodedTags['App-Name']).toBe('TrustFlow');
    expect(decodedTags['Saga-Id']).toBe(mockSaga.sagaId);

    expect(mockMetrics.increment).toHaveBeenCalledWith('arweave_archive_success_total', {
      result: 'success',
    });

    it('reports oversized archives accurately and passes the full payload to the uploader', async () => {
      const upload = jest
        .fn<Promise<string>, [string | Buffer, Array<[string, string]>]>()
        .mockResolvedValue('arweave-test-tx');
      const uploader = { upload };
      Object.defineProperty(service, 'uploader', { value: uploader });
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();
      const saga: DisputeSaga = {
        ...mockSaga,
        stepHistory: Array.from({ length: 1500 }, () => ({
          step: DisputeStep.VOTING,
          startedAt: '2026-10-17T00:00:00.000Z',
          error: 'x'.repeat(80),
        })),
        votes: Array.from({ length: 1500 }, () => ({
          jurorAddress: `G${'A'.repeat(55)}`,
          vote: 'depositor',
          castAt: '2026-10-17T00:00:00.000Z',
        })),
      };

      await service.archiveDispute(saga);

      expect(upload).toHaveBeenCalledTimes(1);
      const payloadArgument = upload.mock.calls[0]?.[0];
      if (typeof payloadArgument !== 'string') {
        throw new Error('Expected the archive uploader to receive a JSON string.');
      }
      const payload = payloadArgument;
      expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(256 * 1024);
      const parsedPayload = JSON.parse(payload) as {
        stepHistory: unknown[];
        votes: unknown[];
      };
      expect(parsedPayload.stepHistory).toHaveLength(1500);
      expect(parsedPayload.votes).toHaveLength(1500);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('passing the full payload to the uploader without truncation'),
      );
    });

    it('measures the archive size in UTF-8 bytes rather than JavaScript characters', async () => {
      const upload = jest
        .fn<Promise<string>, [string | Buffer, Array<[string, string]>]>()
        .mockResolvedValue('arweave-test-tx');
      const uploader = { upload };
      Object.defineProperty(service, 'uploader', { value: uploader });
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();
      const saga = { ...mockSaga, compensationReason: '🚀'.repeat(70_000) };

      await service.archiveDispute(saga);

      const payloadArgument = upload.mock.calls[0]?.[0];
      if (typeof payloadArgument !== 'string') {
        throw new Error('Expected the archive uploader to receive a JSON string.');
      }
      const payload = payloadArgument;
      expect(payload.length).toBeLessThan(256 * 1024);
      expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(256 * 1024);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/bytes, above the recommended 256 KiB/),
      );
    });
  });
});
