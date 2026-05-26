# Contexto del proyecto Trade Marketing (auto-cargado por Claude Code)

> Este archivo se lee en cada sesión nueva. Mantenerlo **breve, actualizado, accionable**. Si necesitás detalles, los `.md` están en `docs/IMPLEMENTACION/`.

---

## Modo de trabajo

**Single dev (Edgar)**. **TODO el trabajo se ejecuta desde este chat con Claude** — no hay onboarding para humanos, no hay equipo. Los `.md` son la memoria del proyecto entre sesiones; mantenerlos actualizados es **mandatorio** al cerrar cualquier item.

---

## Qué es el proyecto

App de **trade marketing y auditoría de ejecución en PdV** para **Mega Dulces** (distribuidora de dulces en MX), en evolución hacia **plataforma B2B integral multi-tenant** estilo yom.ai.

**Stack actual (a migrar):**
- NestJS 11 + Knex + PostgreSQL + Socket.IO + Cloudinary
- Angular 18 standalone + PrimeNG + Tailwind + Spartan UI
- Capacitor + Dexie (mobile offline embebido en `apps/view`)
- Nx monorepo + Docker + Railway
- ERP de Mega Dulces: **Kepler** (Postgres backend, confirmado)

**Estado funcional hoy:** auditoría de visitas + scoring + reports realtime. **NO toma pedidos**, NO tiene catálogo comercial, NO es multi-tenant.

---

## DECISIÓN CLAVE EN CURSO (2026-05-26)

**ADR-010**: vamos a crear una **DB Postgres nueva multi-tenant desde el origen**.
- Mega Dulces = primer tenant (`slug = 'mega_dulces'`).
- Shared DB + `tenant_id` en todas las tablas + RLS de Postgres como defense-in-depth.
- DB legacy queda en paralelo hasta cutover.
- Aplicar correcciones del audit (60 issues) directamente sobre schema limpio nuevo.

**Sprint actual:** `A.0-multitenant` (3-4 semanas). Plan detallado en [`docs/IMPLEMENTACION/FASES/FASE_A0_MULTITENANT_NEW_DB.md`](docs/IMPLEMENTACION/FASES/FASE_A0_MULTITENANT_NEW_DB.md).

**Sub-sprint A.0mt.1 ✅ COMPLETADO 2026-05-26**: nueva DB local creada con tabla `tenants`, función `current_tenant_id()`, helper TS `TenantKnexService`, tests de aislamiento pasando 8/8.

**Próximo:** Sub-sprint `A.0mt.2` — diseñar y crear todas las tablas del schema multi-tenant (users, zones, rutas, role_permissions, catalogs, stores, visits, exhibitions, captures, daily_captures, scoring_config) + índices `idx_*_tenant_id` + políticas RLS.

---

## Reglas críticas (preferencias del usuario)

### ⛔ NO hacer sin autorización explícita
- **No borrar tablas** en la DB de prod.
- **No borrar columnas** sin pedir confirmación.
- **No hacer push** ni crear PRs sin pedir.
- **No tocar CORS ni credenciales** todavía (diferido por decisión del usuario 2026-05-26 — items `[A.0bis.1-3]` BLOCKED).
- **No borrar archivos de migración aplicados** (Knex valida `knex_migrations` vs filesystem → "directory corrupt" → crash loop. Vivido en este proyecto.).

### ✅ SÍ hacer por default
- Commits locales cuando se completa un item del tracker. Convención: `feat([A.0mt.1.1]): descripción`.
- **Actualizar `01_TRACKER_PROGRESO.md` y `03_LOG_REVISIONES.md` al cerrar items**. Cambiar símbolo: ⬜ → 🔨 → 🧪 → 🚀 → ✅.
- Crear ADRs en `02_DECISIONES_ARQUITECTURA.md` cuando se toma una decisión técnica relevante.
- Migraciones nuevas: **idempotentes** (con `hasColumn` antes de `addColumn`).
- Usar `Logger` de NestJS (no `console.log`) en código nuevo.
- Tablas nuevas: **siempre con `tenant_id` UUID NOT NULL + audit fields completos**.

### Convenciones técnicas
- Naming snake_case en DB y `role_name`.
- TZ del backend: `America/Mexico_City` (helpers en `apps/api/src/shared/date/mx-date.ts`).
- Schemas Postgres: `commercial.*` (Fase B+), `analytics.*` (Fase C+).
- Para diffs de role_permissions JSONB: usar `permissions -> 'KEY' IS NULL` NO el operador `?` de JSONB (knex no lo escapa correctamente).

---

## Sistema de tracking (mantener vivo)

| Archivo | Cuándo actualizar |
|---|---|
| [`01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) | **CADA vez** que un item cambia estado (⬜→🔨→🧪→🚀→✅) |
| [`02_DECISIONES_ARQUITECTURA.md`](docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md) | Al tomar decisión técnica relevante (crear ADR) |
| [`03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md) | Al cerrar un sprint o checkpoint |
| [`AUDITORIA_BASE_INICIAL.md`](docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md) | Si aparece finding nuevo no listado |

**Estados granulares por item:**
- ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD · ⚠️ BLOCKED · ❌ REVERTED

---

## Roadmap rápido

| Fase | Tema | Estado |
|---|---|---|
| A.-1 | Auditoría base | ✅ Hecho (2026-05-26) |
| **A.0-multitenant** | **Nueva DB multi-tenant** | **🔥 En curso** |
| A.0bis | Plan correctivo audit (post-multitenant) | ⏸️ Espera A.0mt |
| A.1-A.7 | Fundaciones (Sentry, Pino, Redis, CI, etc.) | ⏸️ Espera A.0mt |
| B | Integración Kepler ERP (Postgres) | ⏸️ |
| C | Sales Intelligence ampliado | ⏸️ |
| D | Catálogo + Portal B2B + Pedidos | ⏸️ |
| E | Remote Manager (televenta) | ⏸️ |
| F | WhatsApp Bot conversacional | ⏸️ |
| G | Growth (campañas + promociones) | ⏸️ |
| H | Fintech (wallet) | ⏸️ |
| I | ML credit risk + WS scaling | ⏸️ |

Detalle de cada fase en [`docs/IMPLEMENTACION/FASES/`](docs/IMPLEMENTACION/FASES/).

---

## Documentación clave

| Archivo | Para qué |
|---|---|
| [`docs/IMPLEMENTACION/INDEX.md`](docs/IMPLEMENTACION/INDEX.md) | Mapa de toda la documentación |
| [`docs/IMPLEMENTACION/00_ROADMAP_GENERAL.md`](docs/IMPLEMENTACION/00_ROADMAP_GENERAL.md) | Vista de pájaro 9 fases |
| [`docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) | Kanban en vivo |
| [`docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md`](docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md) | 10 ADRs |
| [`docs/IMPLEMENTACION/03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md) | Historial de checkpoints |
| [`docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md`](docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md) | 60 findings del código actual |
| [`docs/IMPLEMENTACION/FASES/FASE_A0_MULTITENANT_NEW_DB.md`](docs/IMPLEMENTACION/FASES/FASE_A0_MULTITENANT_NEW_DB.md) | **Sprint actual** detallado |
| [`docs/PLAN_PLATAFORMA_B2B.md`](docs/PLAN_PLATAFORMA_B2B.md) | Visión completa (29KB, solo leer al planear features grandes) |

---

## Datos del entorno

- **Service ID Railway**: `69f64078-1678-40f4-a266-a18b61a20cde` (cache mounts `id=s/<service>-<target>`).
- **DB legacy (actual prod)**: Postgres en Railway (host `switchback.proxy.rlw...`, accesible via `.env` local).
- **DB nueva multi-tenant**: ✅ Creada local en `192.168.0.245:5432/postgres_platform` con Postgres 18.4. Pendiente migrar a Railway (Sprint A.0mt.5 cutover).
- **Primer tenant**: `mega_dulces` con UUID `00000000-0000-0000-0000-00000000d01c`.
- **WhatsApp BSP**: pendiente decidir (ADR-006).
- **LLM provider**: pendiente decidir (ADR-007, recomendado Claude Haiku 4.5).
- **Partner fintech**: pendiente identificar (ADR-008).

---

## ADRs vigentes (resumen)

- **ADR-001** ✅ Tracking via markdown en repo (no Linear/Jira).
- **ADR-002** ✅ Orden de fases: limitaciones primero.
- **ADR-003** ❌ Superseded by ADR-010.
- **ADR-004** ❌ Superseded by ADR-009.
- **ADR-005** ⏳ Stack mobile (Ionic vs RN) — decidir en Sprint D.2.1.
- **ADR-006** ⏳ WhatsApp BSP — pendiente.
- **ADR-007** ⏳ LLM provider — pendiente.
- **ADR-008** ⏳ Partner fintech — pendiente.
- **ADR-009** ✅ Integración Kepler vía Postgres + `postgres_fdw`.
- **ADR-010** ✅ Multi-tenancy aceptado: shared DB + `tenant_id` desde DB nueva.

---

## Notas de operación con Claude

- **Auto mode** activo → avanzar sin pausas largas, tomar decisiones razonables.
- **Tickets/commits**: `feat([A.0mt.1.1]): descripción`. Código va entre brackets, viene del tracker.
- **Al cerrar item**: marcar `[x]` + cambiar símbolo a ✅ + fecha de cierre.
- **Al cerrar sprint**: entry en `03_LOG_REVISIONES.md` con resumen + lessons learned.
- **Finding nuevo no listado**: agregar a `AUDITORIA_BASE_INICIAL.md` con código nuevo.
