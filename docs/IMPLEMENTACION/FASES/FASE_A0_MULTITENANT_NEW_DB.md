# Fase A.0-multitenant — Nueva DB Postgres con multi-tenancy desde origen

**Duración estimada:** 3-4 semanas (single dev, todo via Claude/chat)
**Objetivo:** crear una DB nueva limpia con schema multi-tenant desde el origen. Mega Dulces será el primer tenant. La DB actual sigue sirviendo prod hasta el cutover.

> **Why ahora**: Es más barato aplicar las 19 correcciones críticas del audit sobre un schema limpio nuevo que sobre el legacy con su deuda técnica acumulada. Además habilita el modelo SaaS multi-tenant que la visión propuesta requiere.

---

## Pre-requisitos

- ✅ ADR-010 aceptado (multi-tenancy shared DB + tenant_id, DB nueva).
- ✅ Auditoría base completa (`AUDITORIA_BASE_INICIAL.md`).
- [ ] Servicio Postgres nuevo aprovisionado en Railway (próxima acción).
- [ ] Acceso al DATABASE_URL legacy para script de migración de data.

---

## Decisiones arquitectónicas tomadas en este sprint

### D1. Identificación del tenant en cada request

**Decisión:** `tenant_id` viaja **en el JWT** (cargado al login desde tabla `users.tenant_id`).

**Cómo:** `JwtPayload` extendido con `tenant_id`. Un `TenantContextInterceptor` global lo extrae y lo guarda en `AsyncLocalStorage` (CLS) para que cualquier service Knex pueda acceder sin pasarlo por argumentos.

### D2. Filtro automático por tenant

**Decisión:** wrapper sobre Knex `knex.withTenant()` que aplica `WHERE tenant_id = ?` automáticamente a todas las queries.

**Backup defense:** Postgres **Row-Level Security (RLS)** activado en cada tabla — políticas que filtran por `current_setting('app.tenant_id')`. Si el código tiene bug, RLS bloquea.

### D3. Naming de tenants

**Decisión:** `tenants.slug` único, snake_case, máx 50 chars, ej: `mega_dulces`, `bimbo_norte`. El UUID es el FK interno.

### D4. Migraciones nuevas obligan `tenant_id`

**Decisión:** convención del proyecto — **cada tabla nueva** debe incluir `tenant_id` UUID NOT NULL con FK a `tenants(id)`. Sin excepciones excepto tablas "globales del sistema" (lista en sección "Tablas globales" abajo).

---

## Schema inicial de la nueva DB

### Tablas globales (sin `tenant_id`)

Estas viven fuera del modelo multi-tenant porque son metadata del sistema:

| Tabla | Propósito |
|---|---|
| `tenants` | Lista de organizaciones. PK. |
| `system_audit_log` | Audit log a nivel sistema (cross-tenant). |
| `knex_migrations` | Knex internal. |
| `knex_migrations_lock` | Knex internal. |
| `pg_*` (system catalogs) | Postgres internal. |

### Tablas multi-tenant (con `tenant_id`)

Todas las demás tablas. Esquema mínimo común:

```sql
CREATE TABLE <nombre> (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- ... columnas específicas
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id),
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES users(id)
);

CREATE INDEX idx_<tabla>_tenant_id ON <nombre>(tenant_id);
CREATE INDEX idx_<tabla>_tenant_active ON <nombre>(tenant_id) WHERE deleted_at IS NULL;

-- RLS
ALTER TABLE <nombre> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <nombre>
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

### Lista de tablas a recrear (vs legacy)

Audit del legacy detectó 30+ tablas. Las que migran al nuevo schema agrupadas por dominio:

**Identidad & permisos:**
- `tenants` (NUEVA — global)
- `users` (con `tenant_id`)
- `role_permissions` (con `tenant_id` — cada tenant define sus propios roles)
- `zones` (con `tenant_id`)
- `rutas` (con `tenant_id`)

**Catálogos del negocio:**
- `catalogs` (con `tenant_id`)
- `planograma_marcas` (con `tenant_id`)
- `planograma_productos` (con `tenant_id`)

**Operación en campo:**
- `stores` (con `tenant_id`)
- `daily_assignments` (con `tenant_id`)
- `visits` (con `tenant_id`)
- `exhibitions` (con `tenant_id`)
- `exhibition_photos` (con `tenant_id`)
- `daily_captures` (con `tenant_id`)
- `captures` (con `tenant_id`)

**Scoring:**
- `scoring_config` (con `tenant_id` — cada tenant tiene su scoring)

**Tablas a NO migrar** (aceptamos perderlas, son legado sin uso):
- Validar caso por caso en Sprint A.0-multitenant.2 (audit de uso real).

---

## Sprints

### Sprint A.0-multitenant.1 — Aprovisionamiento + schema base (5 días)

**Objetivo:** DB nueva levantada con tabla `tenants` + plumbing básico.

- [ ] **[A.0mt.1.1]** ⬜ Crear servicio Postgres nuevo en Railway (separado de la actual)
- [ ] **[A.0mt.1.2]** ⬜ Variable de entorno `DATABASE_URL_NEW` en API (no reemplaza la actual aún)
- [ ] **[A.0mt.1.3]** ⬜ Knexfile extendido con segunda conexión `newDb`
- [ ] **[A.0mt.1.4]** ⬜ Primera migración: tabla `tenants` + UUID extension + seed con Mega Dulces
- [ ] **[A.0mt.1.5]** ⬜ Helper `setTenantContext(trx, tenantId)` que setea `SET LOCAL app.tenant_id`
- [ ] **[A.0mt.1.6]** ⬜ Test: insertar row con tenant_id y validar que se lee solo con contexto correcto

### Sprint A.0-multitenant.2 — Schema completo + RLS (1-1.5 sem)

**Objetivo:** todas las tablas creadas con audit fields completos + RLS activado.

- [ ] **[A.0mt.2.1]** ⬜ Diseño detallado del schema (revisar cada tabla legacy + decidir qué se incluye)
- [ ] **[A.0mt.2.2]** ⬜ Migración: tablas core (`users`, `zones`, `rutas`, `role_permissions`)
- [ ] **[A.0mt.2.3]** ⬜ Migración: tablas catálogos (`catalogs`, `planograma_*`)
- [ ] **[A.0mt.2.4]** ⬜ Migración: tablas operación (`stores`, `daily_assignments`, `visits`, `exhibitions`, `exhibition_photos`)
- [ ] **[A.0mt.2.5]** ⬜ Migración: tablas capturas (`captures`, `daily_captures`)
- [ ] **[A.0mt.2.6]** ⬜ Migración: scoring (`scoring_config`)
- [ ] **[A.0mt.2.7]** ⬜ Migración: índices `idx_*_tenant_id` en todas las tablas
- [ ] **[A.0mt.2.8]** ⬜ Migración: políticas RLS en todas las tablas
- [ ] **[A.0mt.2.9]** ⬜ Seed inicial: rol superadmin + usuario superoot con `tenant_id = mega_dulces`
- [ ] **[A.0mt.2.10]** ⬜ Tests RLS: verificar que tenant A no puede leer data de tenant B

### Sprint A.0-multitenant.3 — Integración NestJS (1 sem)

**Objetivo:** API puede operar contra la nueva DB con tenant context automático.

- [ ] **[A.0mt.3.1]** ⬜ `TenantContextInterceptor` global que extrae `tenant_id` del JWT
- [ ] **[A.0mt.3.2]** ⬜ `AsyncLocalStorage` para propagar tenant context en async chains
- [ ] **[A.0mt.3.3]** ⬜ Wrapper `KnexTenantService` que setea `app.tenant_id` en cada transacción
- [ ] **[A.0mt.3.4]** ⬜ JWT extendido con `tenant_id` + actualizar `auth.service`
- [ ] **[A.0mt.3.5]** ⬜ Login multi-tenant: validar credenciales contra el tenant correcto
- [ ] **[A.0mt.3.6]** ⬜ Endpoint admin `POST /admin/tenants` (crear tenant nuevo)
- [ ] **[A.0mt.3.7]** ⬜ Tests de integración: 2 tenants distintos, cada uno solo ve su data

### Sprint A.0-multitenant.4 — Migración de data legacy → nueva DB (1 sem)

**Objetivo:** copiar data de Mega Dulces de la DB legacy a la nueva, asignándole `tenant_id`.

- [ ] **[A.0mt.4.1]** ⬜ Script `migrate-legacy-to-newdb.ts` con dry-run mode
- [ ] **[A.0mt.4.2]** ⬜ Migración tablas independientes (`zones`, `catalogs`)
- [ ] **[A.0mt.4.3]** ⬜ Migración `users` + `role_permissions`
- [ ] **[A.0mt.4.4]** ⬜ Migración `stores` + `rutas` + `daily_assignments`
- [ ] **[A.0mt.4.5]** ⬜ Migración `visits` + `exhibitions` + `exhibition_photos`
- [ ] **[A.0mt.4.6]** ⬜ Migración `captures` + `daily_captures`
- [ ] **[A.0mt.4.7]** ⬜ Migración `scoring_config`
- [ ] **[A.0mt.4.8]** ⬜ Validación post-migración: conteos por tabla, spot-check de 50 visitas históricas
- [ ] **[A.0mt.4.9]** ⬜ Generar reporte de migración: qué se migró, qué se descartó, qué falló

### Sprint A.0-multitenant.5 — Cutover plan (3 días)

**Objetivo:** plan de switch del API de DB legacy → DB nueva.

- [ ] **[A.0mt.5.1]** ⬜ Documentar plan de cutover paso a paso (`RUNBOOKS/CUTOVER_NEW_DB.md` — crear)
- [ ] **[A.0mt.5.2]** ⬜ Validar API contra DB nueva en staging por 1 semana
- [ ] **[A.0mt.5.3]** ⬜ Snapshot final de DB legacy (backup)
- [ ] **[A.0mt.5.4]** ⬜ Sync delta (data nueva entre el primer migrate y ahora)
- [ ] **[A.0mt.5.5]** ⬜ Cutover: cambiar `DATABASE_URL` en prod → nueva DB. Sin downtime aceptable.
- [ ] **[A.0mt.5.6]** ⬜ Monitoreo 24h post-cutover (Sentry, métricas Railway)
- [ ] **[A.0mt.5.7]** ⬜ Marcar DB legacy como `read-only` por 30 días, luego archivar

### Checkpoint Sprint A.0-multitenant

- [ ] **[A.0mt.6.1]** ⬜ Toda la data de Mega Dulces en nueva DB con `tenant_id` poblado
- [ ] **[A.0mt.6.2]** ⬜ API operando contra nueva DB en prod
- [ ] **[A.0mt.6.3]** ⬜ Tests de aislamiento entre tenants pasando
- [ ] **[A.0mt.6.4]** ⬜ ADR-010 actualizado con realidad final del approach
- [ ] **[A.0mt.6.5]** ⬜ Entry de cierre en `03_LOG_REVISIONES.md`

---

## Plan correctivo del audit re-evaluado

**Importante**: muchos de los 19 críticos del audit (`AUDITORIA_BASE_INICIAL.md`) se resuelven AUTOMÁTICAMENTE al crear la DB nueva limpia:

| Finding del audit | Cómo se resuelve en DB nueva |
|---|---|
| 1.1 — Migraciones no idempotentes | Convención: nuevas migraciones SIEMPRE con `hasColumn` |
| 1.2 — Roles con naming inconsistente | Seeds reescritos con snake_case |
| 1.3 — `captures` sin audit fields | Tabla nueva con audit completo |
| 1.4 — `visits` sin audit fields | Tabla nueva con audit completo |
| 1.5 — FKs sin índices | Índices en `tenant_id` + FKs desde el inicio |
| 1.6 — JSONB sin validación | Schemas Zod en `libs/shared-domain-types` |
| 1.7 — Inconsistencia `captured_by_username` vs `user_id` | Solo `user_id` (FK), sin string redundante |
| 1.8 — `daily_assignments` audit incompleto | Audit completo desde origen |
| 1.10 — `role_permissions` sin `created_by` | Audit completo desde origen |
| 1.11 — Compound unique inconsistente | Reglas claras al crear |
| 1.13 — Permisos LOG_* huérfanos | No se incluyen en el seed nuevo |

Tras Sprint A.0-multitenant, el audit residual sobre código backend/frontend (findings 2.x, 3.x, 4.x) se aborda en Sprint A.0bis (ya planeado), pero **gran parte del trabajo de DB queda absorbido aquí**.

---

## Entregables al cierre

- ✅ DB Postgres nueva en Railway con schema multi-tenant.
- ✅ Tabla `tenants` con Mega Dulces como primer registro.
- ✅ Todas las tablas con `tenant_id` + RLS policies + audit fields completos.
- ✅ API operando contra la nueva DB con `TenantContextInterceptor`.
- ✅ Tests de aislamiento (tenant A ≠ tenant B).
- ✅ Data legacy migrada con `tenant_id` poblado.
- ✅ DB legacy en modo backup read-only.
- ✅ Audit del schema legacy queda absorbido en nueva DB limpia.

---

## Métricas de éxito

- **Aislamiento entre tenants 100%**: tests automatizados deben demostrar 0 fugas.
- **Performance**: queries con `tenant_id` index deben ser ≤ a las queries legacy.
- **Zero data loss**: validación post-migración con conteos por tabla.
- **Boot time API**: similar al actual (< 25s).
- **Tiempo de cutover**: < 5 minutos (acepta downtime breve).

---

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Data loss en migración legacy → nueva | Dry-run + validación de conteos + spot checks antes de cutover. Snapshot pre-cutover. |
| RLS rompe queries complejas existentes | Tests exhaustivos antes de cutover. Plan de rollback si falla. |
| Performance peor que legacy | Benchmark antes/después. Tuning de índices si necesario. |
| Bugs en `TenantContextInterceptor` exponen data cross-tenant | RLS como defense-in-depth + tests obligatorios. |
| Cutover requiere downtime largo | Plan de delta sync + ventana de mantenimiento programada. |
| Foto de Cloudinary referencias rompen | Validar que public_id sigue válido post-migración. |

---

## Stack y herramientas

- **DB**: Postgres en Railway (servicio nuevo, separado del actual).
- **Connection**: Knex con dos pools — legacy + new. Knexfile actualizado.
- **Tenant context**: `cls-hooked` o `AsyncLocalStorage` nativo (Node 18+).
- **RLS**: Postgres nativo (sin extensiones extras).
- **Migración de data**: scripts TypeScript con Knex, validación con Zod, dry-run mode.

---

## Cuándo se considera cerrado

Sprint A.0-multitenant cerrado cuando:
1. Todos los items de los 5 sub-sprints marcados ✅.
2. API en prod opera contra nueva DB por al menos 7 días sin issues.
3. Tests de aislamiento entre tenants pasan en CI.
4. Entry de cierre en `03_LOG_REVISIONES.md` con métricas finales.

Después de cerrarlo, se sigue con **Sprint A.0bis (correctivos del audit)** — pero gran parte ya estará resuelta por construcción.
