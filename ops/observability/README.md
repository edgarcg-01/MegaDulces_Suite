# Observabilidad + uptime (self-hosted en .249)

## Uptime Kuma — usalo ya

Monitorea la URL pública de Railway y te avisa cuando se cae.

```bash
docker compose -f ops/observability/docker-compose.yml up -d uptime-kuma
```

1. Abrí `http://localhost:3001`, creá el usuario admin.
2. Add New Monitor → tipo HTTP(s) → URL = `https://<tu-app>.railway.app/api/health` → intervalo 60s.
3. Settings → Notifications → WhatsApp/Telegram/Email para las alertas.

## Error tracking

**Ahora (prod en Railway): usá Sentry SaaS free tier.** Railway (nube) no alcanza
un GlitchTip en tu LAN. Creá un proyecto en [sentry.io](https://sentry.io) (free:
5K eventos/mes), copiá los DSN (uno para el API Node, uno para Angular) y seteálos
como env en Railway (`SENTRY_DSN`) + en el build de Angular (`view` environment).
El SDK ya está wireado en el código (inerte sin DSN).

**Después (prod on-prem): GlitchTip.** Mismo SDK, solo cambiás el DSN al de GlitchTip.

```bash
# generá el secret y el dominio primero (ver .env.example)
export GLITCHTIP_SECRET_KEY=$(openssl rand -hex 32)
docker compose -f ops/observability/docker-compose.yml up -d gt-postgres gt-redis glitchtip-migrate glitchtip-web glitchtip-worker
```

Abrí `http://localhost:8000`, creá la cuenta + organización + proyecto, y usá ese DSN.

---

## Métricas + logs + traces — stack LGTM (INFRA.2, ADR-043)

Grafana + Loki (logs) + Tempo (traces) + Prometheus (métricas) + OTel Collector (ingest), self-host en `.249`. Es lo que deja de debuggear el OOM a ciegas.

```bash
# Opcional: password admin de Grafana (default 'admin')
export GRAFANA_ADMIN_PASSWORD=<algo>
docker compose -f ops/observability/grafana-stack.yml up -d
```

- Grafana: `http://localhost:3300` (datasources Loki/Tempo/Prometheus ya provisionados).
- El collector recibe OTLP en `:4318` (http) / `:4317` (grpc).

### El punto LAN→nube (igual que GlitchTip)

Prod corre en **Railway (nube)** y NO alcanza `.249`. Como OTLP es **push** (sale del API), solo hay que exponer el **endpoint del collector** hacia afuera. Usá tu `cloudflared` (ya tenés `cloudflared-config.yml`):

1. En `cloudflared-config.yml` agregá un ingress: `otel.<tu-dominio>` → `http://localhost:4318`.
2. Protegé esa ruta con **Cloudflare Access** + un token de servicio para el API (no dejarla abierta).
3. En Railway (API y worker) seteá:
   ```
   OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.<tu-dominio>
   OTEL_SERVICE_NAME=trade-api          # trade-worker en el worker-tier
   LOG_JSON=true                        # logs JSON pino (feed a Loki)
   LOG_LEVEL=info
   ```

Sin `OTEL_EXPORTER_OTLP_ENDPOINT` el API no emite traces (inerte). Sin `LOG_JSON=true` los logs siguen en el formato clásico de Nest. Ambos son opt-in → prod no cambia hasta que los prendas.

> **Feeds/worker on-prem** (corren en `.249`, misma LAN): apuntá `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` directo, sin túnel.

### Qué ver primero (para el OOM)

- **Prometheus**: `process_resident_memory_bytes`, heap de Node, latencia p95 por ruta.
- **Loki**: filtrá por `level=error` y por `trace_id` (cada log lleva el trace_id del span activo → click salta a Tempo).
- Armá una alerta de RAM > umbral = el precursor del ECONNRESET/502.
