# Runbook — Rotación de secretos de producción

> **Gate del onboarding de equipo.** Los secretos de prod estuvieron expuestos (hardcodeados en el repo
> y/o pegados en chats) y **nunca se rotaron** (>1 mes). Invitar devs al repo = darles todos los secretos
> vía el historial de git. **Rotar TODO antes de invitar a nadie.** Después, purgar el historial
> ([`SECURITY_PURGE_HISTORY.md`](SECURITY_PURGE_HISTORY.md)).
>
> Este doc lista **qué** rotar (nombres, NUNCA valores). Los valores viven solo en Railway / el vault.

## Orden correcto

1. **Rotar cada secreto** (esta checklist) → actualizar en Railway + `.env` local + on-prem donde aplique.
2. **Redeploy** de la API (y worker si aplica) para que tome los valores nuevos.
3. **Re-login** de todos los usuarios (el `JWT_SECRET` nuevo invalida los tokens viejos).
4. **Purgar el historial** de AMBOS repos (`origin`=Trade_marketing, `logistica`=Megadulces-Logistica).
5. **Recién ahí, invitar a los devs.**

## Checklist de rotación

Marcá cada uno al rotar + actualizar en Railway. **Prioridad 🔴 primero.**

### Credenciales de base de datos
- [ ] 🔴 **DB nueva multi-tenant** — password del rol `postgres` (`trolley.proxy.rlwy.net`). Rotar en Railway (addon Postgres) → actualizar `DATABASE_URL_NEW` + `DATABASE_URL_NEW_RUNTIME`.
- [ ] 🔴 **`APP_RUNTIME_PASSWORD`** — rol `app_runtime` (el que usa la app en runtime, respeta RLS). `ALTER ROLE app_runtime WITH PASSWORD '...'` + actualizar `DATABASE_URL_NEW_RUNTIME`.
- [ ] 🔴 **DB legacy** (`switchback.proxy.rlwy.net`) — actualizar `DATABASE_URL` / `RAILWAY_DATABASE_URL`.
- [ ] 🔴 **Vector DB** (`acela.proxy.rlwy.net`) — actualizar `VECTOR_DATABASE_URL`.
- [ ] 🟠 **on-prem `superoot`** (LAN `192.168.0.245` + docker `:5433`) — LAN-only, menor severidad. Decidir: rotar en las DBs on-prem o scrubbear los ~40 fallbacks a env puro.

### Auth / firma
- [ ] 🔴 **`JWT_SECRET`** — firma los tokens de admin. **Crítico.** Al rotar, TODAS las sesiones se invalidan → todos re-login.
- [ ] 🔴 **`FISCAL_CRYPTO_KEY`** — ⚠️ **NO rotar a ciegas.** Encripta datos fiscales en DB; rotar requiere **migración de re-encriptado** (desencriptar con la vieja, re-encriptar con la nueva). Planear aparte.

### API keys de terceros
- [ ] 🔴 **`ANTHROPIC_API_KEY`** — regenerar en console.anthropic.com.
- [ ] 🟠 **`VOYAGE_API_KEY`** — dash.voyageai.com.
- [ ] 🟠 **`GROQ_API_KEY`** — console.groq.com.
- [ ] 🟠 **`MAPBOX_TOKEN`** — account.mapbox.com.
- [ ] 🟠 **`NEO4J_PASSWORD`** — consola Neo4j / on-prem.
- [ ] 🟠 **`STORE_INGEST_KEY`** — clave compartida máquina-a-máquina (poller on-prem ↔ API). Rotar en Railway **y** en el `.env` del poller on-prem (deben coincidir).
- [ ] 🟠 **`DENUE_TOKEN`** — INEGI.
- [ ] 🟠 **`MAGNI_USER` / `MAGNI_PASS`** — cuenta GPS MagniTracking (compartida — coordinar).
- [ ] 🟠 **Cloudinary** (`CLOUDINARY_API_KEY` / `_API_SECRET`) — dashboard Cloudinary.
- [ ] 🟠 **S3 / Tigris** (`S3_ACCESS_KEY` / `S3_SECRET_KEY`) — Railway bucket.
- [ ] 🟠 **WhatsApp** (`WHATSAPP_ACCESS_TOKEN` / `_APP_SECRET` / `_VERIFY_TOKEN`) — Meta.
- [ ] 🟠 **VAPID** (web-push) — regenerar par de llaves.
- [ ] 🟠 **`SENTRY_DSN`** — rotar proyecto si se considera sensible (bajo riesgo).

## Post-rotación
- [ ] `.env` local actualizado con TODOS los valores nuevos.
- [ ] Variables de entorno de Railway actualizadas (API + worker).
- [ ] Redeploy verificado (la app arranca y conecta con los valores nuevos).
- [ ] Todos re-login (por el `JWT_SECRET` nuevo).
- [ ] Historial purgado en ambos repos ([`SECURITY_PURGE_HISTORY.md`](SECURITY_PURGE_HISTORY.md)).
- [ ] **Regla a futuro:** NUNCA pegar env/secretos en el chat; NUNCA hardcodear (siempre `process.env`, sin fallback con secreto).
