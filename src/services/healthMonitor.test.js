import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import HealthMonitor from './healthMonitor.js';

describe('healthMonitor', () => {
  let registry;
  let monitor;

  beforeEach(() => {
    registry = {
      listDevices: vi.fn(),
      getDevice: vi.fn(),
      markOffline: vi.fn(),
      markSleep: vi.fn(),
    };
    monitor = new HealthMonitor(registry);
  });

  afterEach(() => {
    monitor.stop();
  });

  describe('constructor', () => {
    it('has default timeout constants', () => {
      expect(monitor.CHECK_INTERVAL).toBe(30000);
      expect(monitor.SLEEP_TIMEOUT_MS).toBe(90000);
      expect(monitor.OFFLINE_TIMEOUT_MS).toBe(120000);
    });
  });

  describe('start / stop', () => {
    it('sets up and tears down the interval', () => {
      monitor.start();
      expect(monitor.monitorInterval).toBeTruthy();

      monitor.stop();
      expect(monitor.monitorInterval).toBeNull();
    });
  });

  describe('checkDeviceHealth', () => {
    it('marks sleeping when heartbeat older than 90s', () => {
      const now = Date.now();
      const sleepDevice = {
        deviceId: 'dev1',
        status: 'online',
        lastHeartbeat: new Date(now - 100000).toISOString(),
      };

      const conn = { ws: { readyState: 1 }, metadata: { fcmToken: null } };
      registry.listDevices.mockReturnValue([sleepDevice]);
      registry.getDevice.mockReturnValue(conn);

      monitor.checkDeviceHealth();
      expect(registry.markSleep).toHaveBeenCalledWith('dev1');
      expect(registry.markOffline).not.toHaveBeenCalled();
    });

    it('marks offline when heartbeat older than 2 min', () => {
      const now = Date.now();
      const dead = {
        deviceId: 'dev2',
        status: 'online',
        lastHeartbeat: new Date(now - 400000).toISOString(),
      };
      const conn = {
        ws: { readyState: 1, close: vi.fn() },
        metadata: { fcmToken: null },
      };
      registry.listDevices.mockReturnValue([dead]);
      registry.getDevice.mockReturnValue(conn);

      monitor.checkDeviceHealth();
      expect(registry.markOffline).toHaveBeenCalledWith('dev2');
    });

    it('detects zombie sockets (WS dead but metadata says online)', () => {
      const zombie = {
        deviceId: 'dev3',
        status: 'online',
        lastSeen: new Date().toISOString(),
      };
      const conn = { ws: null, metadata: { fcmToken: null } };
      registry.listDevices.mockReturnValue([zombie]);
      registry.getDevice.mockReturnValue(conn);

      monitor.checkDeviceHealth();
      expect(registry.markOffline).toHaveBeenCalledWith('dev3');
    });

    it('skips already-offline devices', () => {
      const offline = { deviceId: 'dev4', status: 'offline' };
      registry.listDevices.mockReturnValue([offline]);

      monitor.checkDeviceHealth();
      expect(registry.markOffline).not.toHaveBeenCalled();
      expect(registry.markSleep).not.toHaveBeenCalled();
    });
  });

  describe('getDeviceStatus', () => {
    const now = Date.now();
    it('offline when not registered', () => {
      registry.getDevice.mockReturnValue(null);
      expect(monitor.getDeviceStatus('ghost')).toEqual({
        status: 'offline',
        reason: 'not_registered',
      });
    });

    it('unknown when no heartbeat data', () => {
      registry.getDevice.mockReturnValue({ metadata: {} });
      expect(monitor.getDeviceStatus('nohb')).toEqual({
        status: 'unknown',
        reason: 'no_heartbeat_data',
      });
    });

    it('offline when heartbeat exceeds OFFLINE_TIMEOUT_MS', () => {
      registry.getDevice.mockReturnValue({
        metadata: { lastHeartbeat: new Date(now - 400000).toISOString() },
      });
      const status = monitor.getDeviceStatus('dev');
      expect(status.status).toBe('offline');
      expect(status.reason).toBe('timeout');
    });

    it('sleep when heartbeat exceeds SLEEP_TIMEOUT_MS', () => {
      registry.getDevice.mockReturnValue({
        metadata: { lastHeartbeat: new Date(now - 100000).toISOString() },
      });
      const status = monitor.getDeviceStatus('dev');
      expect(status.status).toBe('sleep');
      expect(status.reason).toBe('no_heartbeat');
    });

    it('online when heartbeat is recent', () => {
      registry.getDevice.mockReturnValue({
        metadata: { lastHeartbeat: new Date().toISOString() },
      });
      const status = monitor.getDeviceStatus('dev');
      expect(status.status).toBe('online');
    });
  });
});