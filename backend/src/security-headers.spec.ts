import express from 'express';
import helmet from 'helmet';
import request from 'supertest';

describe('security headers', () => {
  it('adds Helmet headers to responses', async () => {
    const app = express();
    app.use(helmet());
    app.get('/health', (_req, res) => res.sendStatus(200));

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  });
});
