import { EventDedupService } from './event-dedup.service';

// Mirrors LOCAL_MAX_ENTRIES in event-dedup.service.ts, which is not exported.
const LOCAL_MAX_ENTRIES = 1000;

/** The fallback cache is private; tests read it to check the cap directly. */
function localCache(service: EventDedupService): Map<string, number> {
  return (service as unknown as { local: Map<string, number> }).local;
}

describe('EventDedupService local fallback cap (#732)', () => {
  it('never lets the local cache grow past LOCAL_MAX_ENTRIES', async () => {
    const service = new EventDedupService(null);

    for (let i = 0; i < LOCAL_MAX_ENTRIES + 500; i += 1) {
      await service.claim(`event-${i}`);
      expect(localCache(service).size).toBeLessThanOrEqual(LOCAL_MAX_ENTRIES);
    }
  });

  it('evicts the oldest entries first, so an evicted id is treated as new', async () => {
    const service = new EventDedupService(null);

    for (let i = 0; i < LOCAL_MAX_ENTRIES + 1; i += 1) {
      await service.claim(`event-${i}`);
    }

    // event-0 was the oldest and has been evicted, so it is claimed as new again.
    expect(await service.claim('event-0')).toBe(true);
    // The newest entry is still cached, so it is still a duplicate.
    expect(await service.claim(`event-${LOCAL_MAX_ENTRIES}`)).toBe(false);
  });
});
