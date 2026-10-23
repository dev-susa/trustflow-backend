import { IpfsPinningService } from './ipfs-pinning.service';
import { IpfsPinProvider, PinProviderName } from './providers/ipfs-provider.interface';
import { ProviderHealthService } from './provider-health.service';

/** A provider whose pin takes a fixed time, so the recorded latency has a known target. */
class DelayedPinProvider extends IpfsPinProvider {
  readonly name = PinProviderName.PINATA;
  readonly isConfigured = true;

  constructor(
    private readonly delayMs: number,
    private readonly failPin = false,
  ) {
    super();
  }

  async pin(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, this.delayMs));
    if (this.failPin) throw new Error('pin refused');
  }

  async unpin(): Promise<void> {}

  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

const CONTENT = Buffer.from('latency test content').toString('base64');

/** The `[providerName, latencyMs]` arguments of a health-recording mock's first call. */
function firstHealthCall(mock: jest.Mock): [string, number] {
  return mock.mock.calls[0] as [string, number];
}

function buildService(provider: IpfsPinProvider) {
  const providerHealth = {
    recordPinSuccess: jest.fn().mockResolvedValue(undefined),
    recordPinFailure: jest.fn().mockResolvedValue(undefined),
  };
  // Runs the wrapped call directly, so the test measures only the provider's own delay.
  const circuitBreakerService = {
    execute: (_name: string, fn: () => Promise<unknown>) => fn(),
  };
  const webhookService = { dispatch: jest.fn().mockResolvedValue(undefined) };

  const service = new IpfsPinningService(
    [provider],
    webhookService as never,
    circuitBreakerService as never,
    null,
    undefined,
    providerHealth as unknown as ProviderHealthService,
  );
  return { service, providerHealth };
}

describe('IpfsPinningService provider latency (#801)', () => {
  it('records the measured pin time on success, not a constant', async () => {
    const { service, providerHealth } = buildService(new DelayedPinProvider(120));

    await service.pinContent({ content: CONTENT, replicationFactor: 1 } as never);

    expect(providerHealth.recordPinSuccess).toHaveBeenCalledTimes(1);
    const [name, latencyMs] = firstHealthCall(providerHealth.recordPinSuccess);
    expect(name).toBe(PinProviderName.PINATA);
    expect(latencyMs).toBeGreaterThanOrEqual(100);
    expect(latencyMs).not.toBe(5000);
  });

  it('records a latency that tracks the provider speed', async () => {
    const fast = buildService(new DelayedPinProvider(10));
    const slow = buildService(new DelayedPinProvider(200));

    await fast.service.pinContent({ content: CONTENT, replicationFactor: 1 } as never);
    await slow.service.pinContent({ content: CONTENT, replicationFactor: 1 } as never);

    const fastMs = firstHealthCall(fast.providerHealth.recordPinSuccess)[1];
    const slowMs = firstHealthCall(slow.providerHealth.recordPinSuccess)[1];
    expect(slowMs).toBeGreaterThan(fastMs);
  });

  it('records the time spent before a failed pin, not a constant', async () => {
    const { service, providerHealth } = buildService(new DelayedPinProvider(120, true));

    await expect(
      service.pinContent({ content: CONTENT, replicationFactor: 1 } as never),
    ).resolves.toBeDefined();

    expect(providerHealth.recordPinFailure).toHaveBeenCalledTimes(1);
    const [name, latencyMs] = firstHealthCall(providerHealth.recordPinFailure);
    expect(name).toBe(PinProviderName.PINATA);
    expect(latencyMs).toBeGreaterThanOrEqual(100);
    expect(latencyMs).not.toBe(5000);
  });
});
