import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let commandDispatcher;

beforeEach(async () => {
  vi.resetModules();

  vi.doMock('./socketRegistry.js', () => ({
    socketRegistry: {
      getDevice: vi.fn(),
      listDevices: vi.fn(() => []),
    },
  }));

  vi.doMock('./database.js', () => ({}));

  vi.doMock('./metrics.js', () => ({
    metricCommandsDispatched: { inc: vi.fn() },
    metricCommandsCompleted: { inc: vi.fn() },
    metricCommandsFailed: { inc: vi.fn() },
  }));

  vi.doMock('fs', () => ({
    existsSync: vi.fn(() => false),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => JSON.stringify({})),
  }));

  const mod = await import('./commandDispatcher.js');
  commandDispatcher = mod.commandDispatcher;
});

afterEach(() => {
  commandDispatcher.teardown();
});

describe('commandDispatcher', () => {
  describe('generateCommandId', () => {
    it('generates unique IDs', () => {
      const id1 = commandDispatcher.generateCommandId();
      const id2 = commandDispatcher.generateCommandId();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^cmd_\d+_\d+$/);
    });

    it('IDs are monotonically increasing', () => {
      const ids = Array.from({ length: 5 }, () => commandDispatcher.generateCommandId());
      const nums = ids.map(id => parseInt(id.split('_')[2], 10));
      nums.forEach((n, i) => {
        if (i > 0) expect(n).toBeGreaterThan(nums[i - 1]);
      });
    });
  });

  describe('markDelivered', () => {
    it('adds commandId to delivered set', () => {
      commandDispatcher.markDelivered('cmd-123');
      expect(commandDispatcher.deliveredCommandIds.has('cmd-123')).toBe(true);
    });

    it('prunes oldest entries when set exceeds max', () => {
      commandDispatcher.deliveredCommandIds.clear();
      for (let i = 0; i < commandDispatcher.MAX_DELIVERED_HISTORY; i++) {
        commandDispatcher.deliveredCommandIds.add(`cmd-${i}`);
      }
      commandDispatcher.markDelivered('fixed-key');
      expect(commandDispatcher.deliveredCommandIds.size).toBeLessThanOrEqual(
        commandDispatcher.MAX_DELIVERED_HISTORY
      );
      expect(commandDispatcher.deliveredCommandIds.has('fixed-key')).toBe(true);
    });
  });

  describe('_sweepStaleCommands', () => {
    it('does not sweep commands before their configured timeout window expires', () => {
      const reject = vi.fn();
      const timeout = setTimeout(() => {}, 120000);

      commandDispatcher.pendingCommands.set('cmd-long', {
        reject,
        timeout,
        timeoutMs: 120000,
        sentAt: Date.now() - 70000,
      });

      commandDispatcher._sweepStaleCommands();

      expect(commandDispatcher.pendingCommands.has('cmd-long')).toBe(true);
      expect(reject).not.toHaveBeenCalled();
      clearTimeout(timeout);
    });

    it('sweeps commands after their configured timeout window expires', () => {
      const reject = vi.fn();
      const timeout = setTimeout(() => {}, 30000);

      commandDispatcher.pendingCommands.set('cmd-stale', {
        reject,
        timeout,
        timeoutMs: 30000,
        sentAt: Date.now() - 40000,
      });

      commandDispatcher._sweepStaleCommands();

      expect(commandDispatcher.pendingCommands.has('cmd-stale')).toBe(false);
      expect(reject).toHaveBeenCalledOnce();
    });
  });

  describe('getScheduled', () => {
    it('returns empty array for unknown device', () => {
      expect(commandDispatcher.getScheduled('ghost')).toEqual([]);
    });

    it('stores and returns scheduled commands', () => {
      const cmds = [{ id: 's1', action: 'screenshot', payload: {} }];
      commandDispatcher.scheduledCommands.set('dev-test', cmds);
      expect(commandDispatcher.getScheduled('dev-test')).toBe(cmds);
    });
  });

  describe('cancelAllScheduled', () => {
    it('removes all scheduled for a device', () => {
      const cmds = [{ id: 's1' }, { id: 's2' }];
      commandDispatcher.scheduledCommands.set('dev-x', cmds);
      expect(commandDispatcher.cancelAllScheduled('dev-x')).toBe(true);
      expect(commandDispatcher.getScheduled('dev-x')).toEqual([]);
    });

    it('returns false when no scheduled exist', () => {
      expect(commandDispatcher.cancelAllScheduled('empty')).toBe(false);
    });
  });

  describe('cancelScheduled', () => {
    it('cancels a single scheduled command by id', () => {
      const cmds = [{ id: 'c1' }, { id: 'c2' }];
      commandDispatcher.scheduledCommands.set('dev', cmds);
      expect(commandDispatcher.cancelScheduled('dev', 'c1')).toBe(true);
      expect(commandDispatcher.getScheduled('dev')).toEqual([{ id: 'c2' }]);
    });

    it('returns false for unknown device', () => {
      expect(commandDispatcher.cancelScheduled('ghost', 'c1')).toBe(false);
    });

    it('returns false for unknown command id', () => {
      const cmds = [{ id: 'c1' }];
      commandDispatcher.scheduledCommands.set('dev', cmds);
      expect(commandDispatcher.cancelScheduled('dev', 'missing')).toBe(false);
    });
  });
});
