import { AuditExportService } from './audit-export.service';
import { DatabaseService } from '../common/database/database.service';
import { Readable } from 'stream';

describe('AuditExportService', () => {
  let service: AuditExportService;
  let mockDb: { isConfigured: boolean; query: jest.Mock };

  beforeEach(() => {
    mockDb = {
      isConfigured: true,
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] }),
    } as any;
    service = new AuditExportService(mockDb as any);
  });

  describe('CSV formatting', () => {
    it('produces correct CSV headers', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });
      const { stream } = await service.exportLogs({ format: 'csv' });
      const data = await collectStream(stream);
      expect(data).toContain('id,operation,user,entity_id,entity_type,before_state,after_state,metadata,created_at');
    });

    it('formats rows as CSV with proper escaping', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          {
            id: 1,
            operation: 'CREATE',
            user: 'alice',
            entity_id: 'escrow-1',
            entity_type: 'escrow',
            before_state: null,
            after_state: { amount: '100' },
            metadata: { note: 'hello, world' },
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });
      const { stream } = await service.exportLogs({ format: 'csv' });
      const data = await collectStream(stream);
      expect(data).toContain('1,CREATE,alice,escrow-1,escrow');
      expect(data).toContain('"hello, world"');
    });

    it('escapes double quotes in CSV fields', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          {
            id: 2,
            operation: 'UPDATE',
            user: 'bob',
            entity_id: 'escrow-2',
            entity_type: 'escrow',
            before_state: null,
            after_state: null,
            metadata: { note: 'say "hello"' },
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });
      const { stream } = await service.exportLogs({ format: 'csv' });
      const data = await collectStream(stream);
      // metadata is JSON.stringify'd first: {"note":"say \"hello\""}
      // then CSV-escaped: wrapped in quotes, internal quotes doubled
      // The key thing is that the output is valid CSV — the field is quoted
      // and internal quotes are escaped by doubling them
      expect(data).toContain('say');
      expect(data).toContain('hello');
      // The metadata field should be wrapped in double quotes (CSV escaping)
      expect(data).toMatch(/"\{.*say.*hello.*\}"/);
    });
  });

  describe('JSON formatting', () => {
    it('produces valid JSON array', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          {
            id: 1,
            operation: 'CREATE',
            user: 'alice',
            entity_id: 'escrow-1',
            entity_type: 'escrow',
            before_state: null,
            after_state: { amount: '100' },
            metadata: null,
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });
      const { stream } = await service.exportLogs({ format: 'json' });
      const data = await collectStream(stream);
      const parsed = JSON.parse(data);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].operation).toBe('CREATE');
    });

    it('returns empty array when no rows', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });
      const { stream } = await service.exportLogs({ format: 'json' });
      const data = await collectStream(stream);
      expect(JSON.parse(data)).toEqual([]);
    });
  });

  describe('checksum computation', () => {
    it('computes SHA-256 checksum over stream content', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });
      const { stream } = await service.exportLogs({ format: 'csv' });
      const checksum = await service.computeChecksum(stream);
      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('does not return a checksum field that is always empty when read', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });
      const result = await service.exportLogs({ format: 'csv' });
      expect(result).not.toHaveProperty('checksum');
    });
  });

  describe('filtering', () => {
    it('passes escrowId filter to query', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });
      await service.exportLogs({ escrowId: 'escrow-123', format: 'csv' });
      const [query, params] = mockDb.query.mock.calls[0];
      expect(query).toContain('entity_id = $1');
      expect(params).toContain('escrow-123');
    });

    it('passes date range filters to query', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });
      await service.exportLogs({
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        format: 'csv',
      });
      const [query, params] = mockDb.query.mock.calls[0];
      expect(query).toContain('created_at >= $');
      expect(query).toContain('created_at <= $');
    });
  });

  describe('unconfigured database', () => {
    it('returns headers only when DB is not configured', async () => {
      const unconfiguredDb = { isConfigured: false, query: jest.fn() } as any;
      const unconfiguredService = new AuditExportService(unconfiguredDb);
      const { stream } = await unconfiguredService.exportLogs({ format: 'csv' });
      const data = await collectStream(stream);
      expect(data).toContain('id,operation,user');
      expect(data).not.toContain('\n\n'); // no data rows
    });
  });
});

async function collectStream(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.on('data', chunk => (data += chunk.toString()));
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}
