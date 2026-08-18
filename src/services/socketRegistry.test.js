import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { socketRegistry } from './socketRegistry.js';

describe('socketRegistry', () => {
  beforeEach(() => {
    socketRegistry.devices.clear();
    socketRegistry.pendingOfflineTimers.clear();
  });

  describe('register', () => {
    it('registers a new device and sets status to online', () => {
      const mockWs = { OPEN: 1, readyState: 1, close: vi.fn() };
      socketRegistry.register('dev1', mockWs, { model: 'Pixel 7' });

      const device = socketRegistry.getDevice('dev1');
      expect(device).toBeDefined();
      expect(device.metadata.status).toBe('online');
      expect(device.metadata.model).toBe('Pixel 7');
      expect(device.ws).toBe(mockWs);
    });

    it('replaces existing WS on re-register', () => {
      const oldWs = { OPEN: 1, readyState: 1, close: vi.fn() };
      const newWs = { OPEN: 1, readyState: 1, close: vi.fn() };

      socketRegistry.register('dev2', oldWs);
      socketRegistry.register('dev2', newWs);

      const device = socketRegistry.getDevice('dev2');
      expect(device.ws).toBe(newWs);
      expect(oldWs.close).toHaveBeenCalled();
    });
  });

  describe('markOffline', () => {
    it('sets status to offline and nullifies ws', () => {
      const mockWs = { OPEN: 1, readyState: 1, close: vi.fn() };
      socketRegistry.register('dev3', mockWs);
      socketRegistry.markOffline('dev3');

      const device = socketRegistry.getDevice('dev3');
      expect(device.metadata.status).toBe('offline');
      expect(device.ws).toBeNull();
    });
  });

  describe('markSleep', () => {
    it('sets status to sleep', () => {
      const mockWs = { OPEN: 1, readyState: 1, close: vi.fn() };
      socketRegistry.register('dev4', mockWs);
      socketRegistry.markSleep('dev4');

      const device = socketRegistry.getDevice('dev4');
      expect(device.metadata.status).toBe('sleep');
    });
  });

  describe('deleteDevice', () => {
    it('removes the device entirely', () => {
      const mockWs = { OPEN: 1, readyState: 1, close: vi.fn() };
      socketRegistry.register('dev5', mockWs);
      const removed = socketRegistry.deleteDevice('dev5');

      expect(removed).toBe(true);
      expect(socketRegistry.getDevice('dev5')).toBeUndefined();
      expect(socketRegistry.getDeviceCount()).toBe(0);
    });

    it('returns false for non-existent device', () => {
      expect(socketRegistry.deleteDevice('ghost')).toBe(false);
    });
  });

  describe('getDeviceCount', () => {
    it('reflects current device count', () => {
      const ws = { OPEN: 1, readyState: 1, close: vi.fn() };
      expect(socketRegistry.getDeviceCount()).toBe(0);

      socketRegistry.register('a', ws);
      expect(socketRegistry.getDeviceCount()).toBe(1);

      socketRegistry.register('b', ws);
      expect(socketRegistry.getDeviceCount()).toBe(2);

      socketRegistry.deleteDevice('a');
      expect(socketRegistry.getDeviceCount()).toBe(1);
    });
  });

  describe('listDevices', () => {
    it('lists all registered devices', () => {
      const ws = { OPEN: 1, readyState: 1, close: vi.fn() };
      socketRegistry.register('devA', ws, { model: 'Pixel 8' });
      socketRegistry.register('devB', ws, { model: 'Pixel 9' });

      const list = socketRegistry.listDevices();
      expect(list).toHaveLength(2);
      expect(list.find(d => d.deviceId === 'devA')).toBeDefined();
      expect(list.find(d => d.deviceId === 'devB')).toBeDefined();
    });

    it('auto-fixes stale online status when WS is dead', () => {
      const ws = { OPEN: 1, readyState: 1, close: vi.fn() };
      socketRegistry.register('ghost', ws);
      ws.readyState = 3;

      const list = socketRegistry.listDevices();
      const ghost = list.find(d => d.deviceId === 'ghost');
      expect(ghost.status).toBe('offline');
    });
  });

  describe('isOnline', () => {
    it('returns true when WS is OPEN', () => {
      const ws = { OPEN: 1, readyState: 1, close: vi.fn() };
      socketRegistry.register('dev', ws);
      expect(socketRegistry.isOnline('dev')).toBe(true);
    });

    it('returns false when WS is not OPEN', () => {
      const ws = { OPEN: 1, readyState: 3, close: vi.fn() };
      socketRegistry.register('dev', ws);
      expect(socketRegistry.isOnline('dev')).toBe(false);
    });

    it('returns false for unknown device', () => {
      expect(!!socketRegistry.isOnline('nobody')).toBe(false);
    });
  });

  describe('getOnlineDevices', () => {
    it('returns only devices with live WS', () => {
      const live = { OPEN: 1, readyState: 1, close: vi.fn() };
      const dead = { OPEN: 1, readyState: 3, close: vi.fn() };

      socketRegistry.register('live', live);
      socketRegistry.register('dead', dead);

      const online = socketRegistry.getOnlineDevices();
      expect(online).toHaveLength(1);
      expect(online[0].deviceId).toBe('live');
    });
  });

  describe('updateMetadata', () => {
  it('merges metadata for an existing device', () => {
      const ws = { OPEN: 1, readyState: 1, close: vi.fn() };
      socketRegistry.register('dev', ws, { model: 'Old' });
      socketRegistry.updateMetadata('dev', { model: 'New', battery: 99 });

      const device = socketRegistry.getDevice('dev');
      expect(device.metadata.model).toBe('New');
      expect(device.metadata.battery).toBe(99);
    });
  });

  describe('pendingOffline timers', () => {
  it('setPendingOffline stores and cancelPendingOffline removes timer', () => {
      const timer = setTimeout(() => {}, 99999);
      socketRegistry.setPendingOffline('timerdev', timer);
      expect(socketRegistry.pendingOfflineTimers.has('timerdev')).toBe(true);

      socketRegistry.cancelPendingOffline('timerdev');
      expect(socketRegistry.pendingOfflineTimers.has('timerdev')).toBe(false);
    });
  });
});