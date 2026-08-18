import promClient from 'prom-client';

const registry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: registry });

export const metricConnectedDevices = new promClient.Gauge({
    name: 'remoteapp_connected_devices',
    help: 'Number of currently connected devices',
    registers: [registry],
});

export const metricCommandsDispatched = new promClient.Counter({
    name: 'remoteapp_commands_dispatched_total',
    help: 'Total commands dispatched',
    registers: [registry],
});

export const metricCommandsCompleted = new promClient.Counter({
    name: 'remoteapp_commands_completed_total',
    help: 'Total commands completed successfully',
    registers: [registry],
});

export const metricCommandsFailed = new promClient.Counter({
    name: 'remoteapp_commands_failed_total',
    help: 'Total commands that failed',
    registers: [registry],
});

export const metricWsMessagesSent = new promClient.Counter({
    name: 'remoteapp_ws_messages_sent_total',
    help: 'Total WebSocket messages sent',
    registers: [registry],
});

export const metricActiveConnections = new promClient.Gauge({
    name: 'remoteapp_active_connections',
    help: 'Number of active WebSocket connections',
    registers: [registry],
});

export function getMetricsContentType() {
    return registry.contentType;
}

export async function getMetrics() {
    return registry.metrics();
}

export default registry;
