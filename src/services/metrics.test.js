import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('prom-client', () => {
  const Registry = vi.fn(function () {
    this.contentType = 'text/plain';
    this.metrics = vi.fn(() => Promise.resolve('# metrics'));
  });
  Registry.prototype = {
    contentType: 'text/plain',
    metrics: vi.fn(() => Promise.resolve('# metrics')),
  };

  return {
    default: {
      Registry,
      collectDefaultMetrics: vi.fn(),
      Gauge: vi.fn((config) => ({ ...config, inc: vi.fn(), set: vi.fn(), dec: vi.fn() })),
      Counter: vi.fn((config) => ({ ...config, inc: vi.fn() })),
    },
  };
});

describe('metrics', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('exports all metric counters and gauges', async () => {
    const mod = await import('./metrics.js');
    expect(mod.metricConnectedDevices).toBeDefined();
    expect(mod.metricCommandsDispatched).toBeDefined();
    expect(mod.metricCommandsCompleted).toBeDefined();
    expect(mod.metricCommandsFailed).toBeDefined();
    expect(mod.metricWsMessagesSent).toBeDefined();
    expect(mod.metricActiveConnections).toBeDefined();
  });

  it('getMetricsContentType returns text/plain', async () => {
    const { getMetricsContentType } = await import('./metrics.js');
    expect(getMetricsContentType()).toBe('text/plain');
  });

  it('getMetrics returns a string', async () => {
    const { getMetrics } = await import('./metrics.js');
    const res = await getMetrics();
    expect(typeof res).toBe('string');
  });

  it('default export is a Registry instance', async () => {
    const { default: registry } = await import('./metrics.js');
    expect(registry).toBeDefined();
  });
});