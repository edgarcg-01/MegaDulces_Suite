# Bóveda de secretos — Infisical self-host (INFRA.1)

> ADR-043. Fuente de verdad de los secretos, self-host en **`.249`**. Los secretos no salen de tu infra. Reemplaza el `.env` suelto + las env vars sueltas de Railway.

## Por qué

Hoy los secretos de prod viven en `.env` (local, no trackeado ✅) y en las env vars de Railway (sin versionado, sin rotación, sin auditoría de acceso). Ya hubo un incidente de creds expuestos. Infisical centraliza, versiona, audita y sincroniza.

## Levantar (en .249)

```bash
# 1. Generar los secretos del propio stack
openssl rand -hex 16   # → INFISICAL_ENCRYPTION_KEY
openssl rand -hex 32   # → INFISICAL_AUTH_SECRET
openssl rand -hex 24   # → INFISICAL_DB_PASSWORD

# 2. Crear ops/secrets/.env (al lado del compose; NO commitear — ya cubierto por .gitignore raíz)
cat > ops/secrets/.env <<EOF
INFISICAL_DB_PASSWORD=<el de arriba>
INFISICAL_ENCRYPTION_KEY=<el de arriba>
INFISICAL_AUTH_SECRET=<el de arriba>
INFISICAL_SITE_URL=http://localhost:8222
EOF

# 3. Up
docker compose -f ops/secrets/docker-compose.yml up -d
```

UI en `http://localhost:8222` → crear cuenta admin → org → proyecto **`trade-marketing`** con environments `dev` / `staging` / `prod`.

## Cargar los secretos

Migrar las llaves de tu `.env` (ver inventario en [`FASE_INFRA`](../../docs/IMPLEMENTACION/FASES/FASE_INFRA_WORKER_TIER.md) → Apéndice INFRA.1). **Rotá al cargar** los que estuvieron expuestos:
- Sin downtime (rotar ya): `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `GROQ_API_KEY`, `MAPBOX_TOKEN`, `DENUE_TOKEN`, `MAGNI_PASS`, `SW_TOKEN`, tokens WhatsApp, `S3_*`, `STORE_INGEST_KEY` (por par: ambos lados).
- DB passwords: por par (crear rol/pass nuevo → cambiar env → revocar viejo).
- `JWT_SECRET`: ⚠️ rotarlo cierra todas las sesiones → coordinar ventana + avisar re-login.

## Cómo lee Railway los secretos (el punto importante)

Railway (nube) **NO alcanza** un Infisical en tu LAN. Dos caminos:

**(a) Sync push desde .249 — recomendado.** Infisical es la fuente de verdad; un job (Jenkins o cron en `.249`) empuja los secretos a las env vars de Railway con el CLI:
```bash
infisical run --env=prod --projectId=<id> -- \
  railway variables set --service <api> --skip-deploys <KEY>=<VALUE> ...
# o usar la integración nativa Infisical → Railway (Integrations en la UI)
```
Railway sigue leyendo de sus env vars normales; no acopla el boot a la disponibilidad de `.249`.

**(b) Runtime pull vía Cloudflare Tunnel.** Exponer el API de Infisical por tu `cloudflared` detrás de Access y que el runtime lo lea en boot con `@infisical/sdk`. Más "puro" pero acopla el arranque de prod a que `.249` + el túnel estén arriba. **No recomendado para el path del dinero.**

> Para el **worker-tier** (INFRA.3) y los **feeds on-prem** (que sí corren en `.249`) el pull directo a Infisical local es trivial (misma LAN) — ahí Infisical brilla.

## Estado

- ✅ Compose + runbook (este archivo) — INFRA.1.
- ⬜ **Tu acción**: `up -d` en `.249` + crear proyecto + cargar/rotar secretos + configurar el sync a Railway (camino a).
