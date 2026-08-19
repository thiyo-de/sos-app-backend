import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory Supabase mock. `store` persists across module reloads (simulates a
// real database surviving a server restart), `store.gate` lets a test pause
// every DB op to interleave async work, and `log` records what was executed.
const { store, log, createClient } = vi.hoisted(() => {
  const store = new Map();
  store.gate = null;
  const log = { upserts: [], updates: [], deletes: [], selects: [] };
  let nextId = 1;

  function createClient() {
    return { from: t => mkBuilder(t) };
  }

  function filterValue(filters, col) {
    const f = filters.find(x => x[0] === col && !Array.isArray(x[1]));
    return f ? f[1] : undefined;
  }

  function inValue(filters, col) {
    const f = filters.find(x => x[0] === col && Array.isArray(x[1]));
    return f ? f[1] : undefined;
  }

  function mkBuilder(table) {
    const filters = [];
    let op = null;
    let payload = null;
    let opts = null;

    const api = {
      eq(col, val) { filters.push([col, val]); return api; },
      in(col, vals) { filters.push([col, vals]); return api; },
      lt(col, val) { filters.push([col, val]); return api; },
      order() { return api; },
      limit() { return api; },
      select() { if (op === null) op = 'select'; return api; },
      update(p) { op = 'update'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      insert(p) { op = 'insert'; payload = p; return api; },
      upsert(p, o) { op = 'upsert'; payload = p; opts = o || null; return api; },
      then(res, rej) { return exec().then(res, rej); },
      catch(rej) { return exec().catch(rej); },
      finally(fn) { return exec().finally(fn); },
    };

    function exec() {
      const run = () => {
        if (op === 'upsert') {
          log.upserts.push({ table, payload, opts });
          const rows = Array.isArray(payload) ? payload : [payload];
          for (const r of rows) {
            const key = `${table}:${r.device_id}:${r.event_uuid ?? ''}`;
            if (store.has(key)) {
              if (!(opts && opts.ignoreDuplicates)) {
                store.set(key, { ...store.get(key), ...r });
              }
            } else {
              store.set(key, { id: nextId++, ...r });
            }
          }
          return Promise.resolve({ data: [], error: null });
        }
        if (op === 'update') {
          log.updates.push({ table, payload, filters: filters.slice() });
          const key = `${table}:${filterValue(filters, 'device_id')}:${filterValue(filters, 'event_uuid')}`;
          const row = store.get(key);
          if (row) {
            Object.assign(row, payload);
            return Promise.resolve({ data: [{ id: row.id }], error: null });
          }
          return Promise.resolve({ data: [], error: null });
        }
        if (op === 'delete') {
          log.deletes.push({ table, filters: filters.slice() });
          const dev = filterValue(filters, 'device_id');
          const inUuids = inValue(filters, 'event_uuid');
          if (dev) {
            for (const k of [...store.keys()]) {
              if (!k.startsWith(`${table}:${dev}:`)) continue;
              if (inUuids) {
                const row = store.get(k);
                if (!row || !inUuids.includes(row.event_uuid)) continue;
              }
              store.delete(k);
            }
          }
          return Promise.resolve({ error: null });
        }
        if (op === 'select') {
          log.selects.push({ table, filters: filters.slice() });
          const dev = filterValue(filters, 'device_id');
          const inUuids = inValue(filters, 'event_uuid');
          const data = [...store.entries()]
            .filter(([k, row]) => {
              if (!k.startsWith(`${table}:${dev}:`)) return false;
              if (inUuids && !inUuids.includes(row.event_uuid)) return false;
              return true;
            })
            .map(([, row]) => row);
          return Promise.resolve({ data, error: null });
        }
        if (op === 'insert') {
          return Promise.resolve({ error: null });
        }
        return Promise.resolve({ data: [], error: null });
      };
      return store.gate ? store.gate.then(run) : run();
    }

    return api;
  }

  return {
    store,
    log,
    createClient,
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient,
}));

vi.mock('../config.js', () => ({
  config: {
    supabase: { url: 'http://test-url', key: 'test-key', enabled: true },
  },
}));

function resetStore() {
  store.clear();
  store.gate = null;
  log.upserts.length = 0;
  log.updates.length = 0;
  log.deletes.length = 0;
  log.selects.length = 0;
}

describe('database service', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetStore();
    // The mocked config object is shared across the file, so a test that flips
    // `enabled` for its own scope must be reset here or later tests would see
    // supabase disabled.
    const { config } = await import('../config.js');
    config.supabase.enabled = true;
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
    const { config } = await import('../config.js');
    config.supabase.enabled = false;
    vi.resetModules();
    const { getUserDevices } = await import('./database.js');
    const result = await getUserDevices('test-user');
    expect(result).toEqual([]);
  });

  it('returns empty array from getAllDevices when supabase null', async () => {
    const { config } = await import('../config.js');
    config.supabase.enabled = false;
    vi.resetModules();
    const { getAllDevices } = await import('./database.js');
    const result = await getAllDevices();
    expect(result).toEqual([]);
  });

  it('returns false from claimDevice when supabase null', async () => {
    const { config } = await import('../config.js');
    config.supabase.enabled = false;
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
    const mod = await import('./database.js');

    // Reveal arrives BEFORE the event row is persisted → mock update() finds
    // nothing, so the reveal is held in pending_reveals (persistent).
    const updated = await mod.updateActivityReveal('dev1', [
      { uuid: 'evt-1', text: 'danielraj12', partial: false },
    ]);
    expect(updated).toBe(0);
    expect(store.has('pending_reveals:dev1:evt-1')).toBe(true);

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

    // The held reveal must be applied to the written row and the hold removed.
    const row = store.get('activity_events:dev1:evt-1');
    expect(row).toBeDefined();
    expect(row.text_revealed).toBe('danielraj12');
    expect(row.reveal_partial).toBe(false);
    expect(store.has('pending_reveals:dev1:evt-1')).toBe(false);
  });

  it('survives a server restart (pending reveals are DB-backed, not in-memory)', async () => {
    const mod = await import('./database.js');
    await mod.updateActivityReveal('dev1', [
      { uuid: 'evt-9', text: 'secret42', partial: true },
    ]);
    expect(store.has('pending_reveals:dev1:evt-9')).toBe(true);

    // Simulate a redeploy: a fresh module instance starts with zero memory.
    vi.resetModules();
    const mod2 = await import('./database.js');
    const ok = await mod2.saveActivityEvents('dev1', [
      { uuid: 'evt-9', type: 'text_changed', app: 'x', text: '•••••', isPassword: true },
    ]);
    expect(ok).toBe(true);

    const row = store.get('activity_events:dev1:evt-9');
    expect(row.text_revealed).toBe('secret42');
    expect(row.reveal_partial).toBe(true);
    expect(store.has('pending_reveals:dev1:evt-9')).toBe(false);
  });

  it('direct reveal update applies immediately when the row already exists', async () => {
    const mod = await import('./database.js');
    await mod.saveActivityEvents('dev1', [
      { uuid: 'evt-3', type: 'text_changed', app: 'x', text: '•••' },
    ]);

    const updated = await mod.updateActivityReveal('dev1', [
      { uuid: 'evt-3', text: 'abc', partial: false },
    ]);
    expect(updated).toBe(1);
    const row = store.get('activity_events:dev1:evt-3');
    expect(row.text_revealed).toBe('abc');
    expect(store.has('pending_reveals:dev1:evt-3')).toBe(false);
  });

  it('serializes clear with in-flight saves (no resurrection)', async () => {
    const mod = await import('./database.js');

    let release;
    store.gate = new Promise(r => { release = r; });

    const saveP = mod.saveActivityEvents('dev1', [
      { uuid: 'e1', type: 'text_changed', app: 'x', text: 'a' },
    ]);
    const clearP = mod.deleteActivityEventsFromDB('dev1');

    release();
    await Promise.all([saveP, clearP]);
    store.gate = null;

    // Save committed first, then the clear ran after it — the row is gone.
    expect(store.has('activity_events:dev1:e1')).toBe(false);
  });

  it('device delete also purges pending reveals', async () => {
    const mod = await import('./database.js');
    await mod.updateActivityReveal('dev1', [
      { uuid: 'evt-5', text: 'x', partial: false },
    ]);
    expect(store.has('pending_reveals:dev1:evt-5')).toBe(true);

    await mod.deleteDeviceFromDB('dev1');
    expect(store.has('pending_reveals:dev1:evt-5')).toBe(false);
    expect(store.has('activity_events:dev1:evt-5')).toBe(false);
  });

  it('carries reveal fields supplied directly on the event', async () => {
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
    const row = store.get('activity_events:dev1:evt-2');
    expect(row.text_revealed).toBe('abc');
    expect(row.reveal_partial).toBe(true);
  });
});