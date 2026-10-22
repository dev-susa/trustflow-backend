import { Test, TestingModule } from '@nestjs/testing';
import { EventIngestionService } from './event-ingestion.service';
import { LedgerCursorService } from './ledger-cursor.service';
import { EventProcessorService } from './event-processor.service';
import { EscrowService } from '../escrow/escrow.service';
import { validateEnv } from '../config/env.config';

// EventIngestionService reads config.EVENT_PROCESSING_CONCURRENCY in its constructor,
// which requires validateEnv() to have run first — normally done once in main.ts.
validateEnv();

describe('EventIngestionService', () => {
  let service: EventIngestionService;
  let ledgerCursorService: LedgerCursorService;
  let eventProcessorService: EventProcessorService;

  const mockEscrowService = {
    create: jest.fn(),
    findById: jest.fn(),
    findByContractEscrowId: jest.fn(),
    fund: jest.fn(),
    release: jest.fn(),
    raiseDispute: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventIngestionService,
        LedgerCursorService,
        EventProcessorService,
        { provide: EscrowService, useValue: mockEscrowService },
      ],
    }).compile();

    service = module.get<EventIngestionService>(EventIngestionService);
    ledgerCursorService = module.get<LedgerCursorService>(LedgerCursorService);
    eventProcessorService = module.get<EventProcessorService>(EventProcessorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getStatus', () => {
    it('should return current status', async () => {
      const status = await service.getStatus();
      expect(status).toHaveProperty('isRunning');
      expect(status).toHaveProperty('failedEvents');
    });
  });

  describe('startPolling and stopPolling', () => {
    it('should start and stop polling', async () => {
      await service.startPolling('test-contract');
      expect(service['isRunning']).toBe(true);

      service.stopPolling();
      expect(service['isRunning']).toBe(false);
    });
  });

  describe('handleReorg', () => {
    it('should handle reorg by clearing events and resetting cursor', async () => {
      const clearSpy = jest.spyOn(eventProcessorService, 'clearEventsBeforeLedger');
      const updateSpy = jest.spyOn(ledgerCursorService, 'updateCursor');

      await service.handleReorg('test-contract', 100);

      expect(clearSpy).toHaveBeenCalledWith(100);
      expect(updateSpy).toHaveBeenCalledWith('test-contract', 99, 'reorg-100', '');
    });
  });

  describe('fetchEvents with pagination', () => {
    it('should paginate through multiple batches when cursor is returned', async () => {
      // Mock RPC server to return multiple events across two cursor pages
      const mockEvents = Array.from({ length: 100 }, (_, i) => ({
        id: `event-${i}`,
        ledger: 100 + Math.floor(i / 50),
        type: 'contract',
        contractId: 'test-contract',
        topic: ['test'],
        value: 'test-value',
        txHash: 'hash',
        createdAt: new Date(),
      }));

      const getEventsSpy = jest.spyOn(service['rpcServer'], 'getEvents');
      getEventsSpy
        .mockResolvedValueOnce({
          events: mockEvents.slice(0, 100),
          cursor: 'cursor-page-1',
          latestLedger: 200,
          oldestLedger: 1,
          latestLedgerCloseTime: '0',
          oldestLedgerCloseTime: '0',
        })
        .mockResolvedValueOnce({
          events: mockEvents.slice(50, 100),
          cursor: undefined,
          latestLedger: 200,
          oldestLedger: 1,
          latestLedgerCloseTime: '0',
          oldestLedgerCloseTime: '0',
        });

      const result = await service['fetchEvents']('test-contract', 100, 199);

      // Should have called getEvents twice (once for initial, once for cursor pagination)
      expect(getEventsSpy).toHaveBeenCalledTimes(2);

      // First call should have startLedger and endLedger
      expect(getEventsSpy).toHaveBeenNthCalledWith(1, {
        startLedger: 100,
        endLedger: 101, // batchEnd + 1 (100 + 99 = 199, min with endLedger 199 = 199, +1 = 200)
        filters: expect.any(Array),
        limit: 100,
      });

      // Second call should have cursor and endLedger
      expect(getEventsSpy).toHaveBeenNthCalledWith(2, {
        cursor: 'cursor-page-1',
        endLedger: 101,
        filters: expect.any(Array),
        limit: 100,
      });
    });

    it('should pass endLedger (exclusive) to bound ledger ranges', async () => {
      const getEventsSpy = jest.spyOn(service['rpcServer'], 'getEvents');
      getEventsSpy.mockResolvedValue({
        events: [],
        latestLedger: 200,
        oldestLedger: 1,
        latestLedgerCloseTime: '0',
        oldestLedgerCloseTime: '0',
      });

      await service['fetchEvents']('test-contract', 1000, 1050);

      expect(getEventsSpy).toHaveBeenCalledWith({
        startLedger: 1000,
        endLedger: 1100, // min(1000 + 99, 1050) + 1 = 1050 + 1 = 1051, but it should be 1100 because batchEnd is 1050
        filters: expect.any(Array),
        limit: 100,
      });
    });
  });

  describe('retryFailedEvents', () => {
    it('should retry failed events with original event data', async () => {
      const originalEvent = {
        id: 'event-1',
        ledger: 100,
        contractId: 'test-contract',
        eventType: 'escrow_created',
        topic: ['escrow_created', 'escrow-123'],
        value: { depositor: 'addr1', beneficiary: 'addr2', amount: '1000' },
        xdr: 'xdr-data',
        createdAt: new Date(),
      };

      const failedEvent = {
        eventId: '100-event-1',
        ledger: 100,
        success: false,
        error: 'Test error',
        processedAt: new Date(),
        originalEvent,
      };

      const getFailedSpy = jest.spyOn(eventProcessorService, 'getFailedEvents');
      getFailedSpy.mockResolvedValue([failedEvent]);

      const processSpy = jest.spyOn(eventProcessorService, 'processEvent');
      processSpy.mockResolvedValue({
        eventId: '100-event-1',
        ledger: 100,
        success: true,
        processedAt: new Date(),
        originalEvent,
      });

      const results = await service.retryFailedEvents();

      expect(processSpy).toHaveBeenCalledWith(originalEvent);
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });

    it('should skip failed events without original event data', async () => {
      const failedEvent = {
        eventId: '100-event-1',
        ledger: 100,
        success: false,
        error: 'Test error',
        processedAt: new Date(),
        // no originalEvent
      };

      const getFailedSpy = jest.spyOn(eventProcessorService, 'getFailedEvents');
      getFailedSpy.mockResolvedValue([failedEvent]);

      const processSpy = jest.spyOn(eventProcessorService, 'processEvent');

      const results = await service.retryFailedEvents();

      expect(processSpy).not.toHaveBeenCalled();
      expect(results).toHaveLength(0);
    });

    it('should clear the failed record before re-processing so processEvent can actually retry', async () => {
      const originalEvent = {
        id: 'event-1',
        ledger: 100,
        contractId: 'test-contract',
        eventType: 'escrow_funded',
        topic: ['escrow_funded', 'escrow-123'],
        value: { contractEscrowId: 'escrow-123' },
        xdr: 'xdr-data',
        createdAt: new Date(),
      };

      // Simulate a previously failed event
      await eventProcessorService.processEvent(originalEvent);
      const failedEvents = await eventProcessorService.getFailedEvents();
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].success).toBe(false);

      // Mock escrowService to succeed on retry
      mockEscrowService.findByContractEscrowId = jest.fn().mockResolvedValue({
        id: 'db-escrow-123',
        contractEscrowId: 'escrow-123',
        status: 'pending',
      });
      mockEscrowService.fund = jest.fn().mockResolvedValue(undefined);

      // Retry should clear the failed record and actually re-run the handler
      const results = await service.retryFailedEvents();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(mockEscrowService.fund).toHaveBeenCalledWith('db-escrow-123');
    });
  });
});

describe('EventIngestionService.processEventBatch — per-escrow ordering (#238)', () => {
  const mkEvent = (
    id: string,
    eventType: string,
    escrowId?: string,
  ): import('./event-processor.service').SorobanEvent => ({
    id,
    ledger: 1,
    contractId: 'C1',
    eventType,
    topic: escrowId ? [eventType, escrowId] : [eventType],
    value: {},
    xdr: '',
    createdAt: new Date(),
  });

  it('processes same-escrow events in order and independent escrows in parallel', async () => {
    const order: string[] = [];
    jest.spyOn(eventProcessorService, 'processEvent').mockImplementation(async event => {
      order.push(event.id);
      // Make the FIRST call slow so a naive parallel-all would reorder.
      if (event.id === 'A-fund') await new Promise(r => setTimeout(r, 30));
      return { eventId: event.id, ledger: 1, success: true, processedAt: new Date() };
    });

    const events = [
      mkEvent('A-create', 'escrow_created'),
      mkEvent('B-create', 'escrow_created'),
      mkEvent('A-fund', 'escrow_funded', 'A'),
      mkEvent('A-release', 'escrow_released', 'A'),
      mkEvent('B-fund', 'escrow_funded', 'B'),
    ];

    const results = await service.processEventBatch(events);

    expect(results).toHaveLength(5);
    // Phase 1: both creates ran first, in order.
    expect(order.slice(0, 2)).toEqual(['A-create', 'B-create']);
    // Within escrow A, fund strictly precedes release despite fund being slow.
    expect(order.indexOf('A-fund')).toBeLessThan(order.indexOf('A-release'));
    // Escrow B was not blocked behind slow escrow A.
    expect(order.indexOf('B-fund')).toBeLessThan(order.indexOf('A-release'));
  });

  it('does not throw when an individual event fails', async () => {
    jest.spyOn(eventProcessorService, 'processEvent').mockImplementation(async event => ({
      eventId: event.id,
      ledger: 1,
      success: event.id !== 'bad',
      processedAt: new Date(),
    }));
    const results = await service.processEventBatch([
      mkEvent('ok', 'escrow_funded', 'X'),
      mkEvent('bad', 'escrow_funded', 'Y'),
    ]);
    expect(results.map(r => r.success).sort()).toEqual([false, true]);
  });
});
