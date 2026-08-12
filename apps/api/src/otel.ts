/**
 * OpenTelemetry — traces del backend (INFRA.2, ADR-043).
 *
 * DEBE importarse ANTES que cualquier otro módulo en main.ts (instrumenta al
 * cargar, igual que Sentry). Es INERTE sin `OTEL_EXPORTER_OTLP_ENDPOINT` →
 * seguro en dev/local y en cualquier entorno sin la env seteada.
 *
 * Auto-instrumenta HTTP/Express/pg/socket.io/etc. Las traces se empujan por OTLP
 * al OTel Collector (self-host en .249, ver ops/observability/). Como prod corre
 * en Railway (nube), el endpoint del collector se expone por Cloudflare Tunnel
 * detrás de Access — poné esa URL pública en OTEL_EXPORTER_OTLP_ENDPOINT.
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.<tu-dominio>   (sin /v1/traces)
 *   OTEL_SERVICE_NAME=trade-api            (o trade-worker en el worker-tier)
 */
import * as dotenv from 'dotenv';
dotenv.config();

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  // Import perezoso: si no hay endpoint, ni siquiera cargamos el SDK.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const {
    getNodeAutoInstrumentations,
  } = require('@opentelemetry/auto-instrumentations-node');
  const {
    OTLPTraceExporter,
  } = require('@opentelemetry/exporter-trace-otlp-http');
  const {
    OTLPMetricExporter,
  } = require('@opentelemetry/exporter-metrics-otlp-http');
  const {
    PeriodicExportingMetricReader,
  } = require('@opentelemetry/sdk-metrics');
  const { HostMetrics } = require('@opentelemetry/host-metrics');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const {
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
  } = require('@opentelemetry/semantic-conventions');

  const base = endpoint.replace(/\/$/, '');
  const serviceName = process.env.OTEL_SERVICE_NAME || 'trade-api';

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]:
        process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 8) || 'dev',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    // Métricas: el reader empuja cada 30s por OTLP. Sin esto NO hay métricas
    // (RAM/heap/latencia) para el dashboard — es la señal clave del OOM.
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_INTERVAL_MS) || 30_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs es muy ruidoso y no aporta a diagnosticar el OOM/latencia.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  // Métricas de host/proceso (RSS, CPU, memoria) — la señal directa del OOM.
  // Usa el MeterProvider global que dejó sdk.start(). Best-effort.
  try {
    new HostMetrics({ name: serviceName }).start();
  } catch {
    /* si falla, seguimos con traces + métricas de instrumentación */
  }

  const shutdown = () =>
    sdk
      .shutdown()
      .catch(() => undefined)
      .finally(() => undefined);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
