import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      upsert: vi.fn(() => Promise.resolve({ error: null })),
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
          })),
        })),
        order: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
        })),
      })),
      update: vi.fn(() => ({
        eq: vi.fn(() => Promise.resolve({ error: null })),
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
});