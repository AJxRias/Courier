import client from "prom-client";

/** One registry per gateway instance so several nodes can run in one test process. */
export function createMetrics(nodeId: string) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ node: nodeId });
  if (!process.env.VITEST) client.collectDefaultMetrics({ register: registry });

  return {
    registry,
    connections: new client.Gauge({
      name: "courier_connections",
      help: "Authenticated WebSocket connections on this node",
      registers: [registry],
    }),
    messages: new client.Counter({
      name: "courier_messages_total",
      help: "Send requests by outcome",
      labelNames: ["result"] as const,
      registers: [registry],
    }),
    sendDuration: new client.Histogram({
      name: "courier_send_duration_seconds",
      help: "Time from receiving a send frame to acking it (persist + outbox)",
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers: [registry],
    }),
    fanoutLag: new client.Histogram({
      name: "courier_fanout_lag_seconds",
      help: "Time from message creation (DB clock) to this node writing it to sockets",
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
    framesOut: new client.Counter({
      name: "courier_frames_out_total",
      help: "Frames written to sockets",
      labelNames: ["type"] as const,
      registers: [registry],
    }),
    syncs: new client.Counter({
      name: "courier_sync_requests_total",
      help: "Gap-repair / catch-up requests served",
      registers: [registry],
    }),
    disconnects: new client.Counter({
      name: "courier_disconnects_total",
      help: "Connections closed, by reason",
      labelNames: ["reason"] as const,
      registers: [registry],
    }),
    rateLimited: new client.Counter({
      name: "courier_rate_limited_total",
      help: "Frames rejected by rate limits",
      labelNames: ["kind"] as const,
      registers: [registry],
    }),
    outboxSwept: new client.Counter({
      name: "courier_outbox_swept_total",
      help: "Outbox rows re-published by the sweeper (fast-path publish missed)",
      registers: [registry],
    }),
    busReconnects: new client.Counter({
      name: "courier_bus_reconnects_total",
      help: "Redis subscriber reconnects (each triggers a client cursor refresh)",
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
