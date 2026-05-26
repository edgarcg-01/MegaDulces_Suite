# Log de Revisiones

> Audit log: cada vez que se revisa código, se cierra un checkpoint, o se valida una fase completa, queda registrado aquí.
>
> Útil para: recordar qué se validó, cuándo, qué problemas se encontraron, qué decisiones se tomaron en review.

---

## Plantilla de entrada

```markdown
## YYYY-MM-DD — <Tipo: PR review / Sprint review / Phase checkpoint / Bug postmortem>

**Item revisado:** <código del item del tracker o link a PR>
**Estado al inicio:** <En progreso / En revisión>
**Estado al cierre:** <En revisión / Hecho / Devuelto a En progreso>

**Qué se revisó:**
- (lista)

**Hallazgos:**
- (lista)

**Acciones tomadas:**
- (lista)

**Siguiente paso:**
- (qué falta)
```

---

## 2026-05-26 — Inicialización del sistema de tracking

**Item revisado:** N/A (setup inicial)
**Estado:** N/A

**Qué se hizo:**
- Creado `docs/IMPLEMENTACION/` con estructura de tracking.
- Roadmap general en `00_ROADMAP_GENERAL.md` con 9 fases (A → I).
- Tracker kanban en `01_TRACKER_PROGRESO.md`.
- ADR log en `02_DECISIONES_ARQUITECTURA.md` con plantilla + 8 ADRs iniciales (1 aceptado, 6 pendientes).
- Este archivo de log de revisiones.

**Próximo paso:**
- Iniciar **Sprint A.0** — limpieza inmediata: borrar archivos `.js` duplicados, actualizar `.gitignore`, documentar setup en `README.md`, arrancar trámite WhatsApp Business.

---

## 2026-05-26 — Auditoría profunda de la base existente (Sprint A.-1)

**Item revisado:** A.-1.1 → A.-1.5 (auditoría completa)
**Estado al inicio:** No iniciado
**Estado al cierre:** ✅ Hecho

**Qué se revisó:**
- Schema de DB y 84 migraciones (`database/migrations/`).
- Backend NestJS: 85 archivos `.ts`, 17 módulos.
- Frontend Angular: ~70 componentes + servicios.
- Config/seguridad: Dockerfile, start.sh, nginx.conf, main.ts, .env, .gitignore.

**Hallazgos:** **60 issues totales**
- 🔴 **19 críticos** (vulnerabilidades + bloqueantes técnicos)
- 🟡 **25 importantes** (deuda técnica significativa)
- 🟢 **16 nice-to-have** (cosmético)

**Hallazgos críticos por dominio:**
- DB: migraciones no idempotentes, audit fields fragmentados, roles con naming inconsistente, FKs sin índices, JSONB sin validación.
- Backend: 3 god services (1399 + 788 + 379 LOC), DTOs aceptando `any`, catches silenciosos en cron, `.js` basura en git.
- Frontend: 3 mega-componentes (3047 + 1801 + 1356 LOC), 3 mega-servicios, mix signals + BehaviorSubject, sin interceptor global de errores.
- Seguridad: CORS `origin: '*'` con credentials, JWT secret con fallback inseguro, credenciales en `.env`, `console.log` con data sensible, vulnerabilidades npm HIGH (Angular XSS, NestJS path-to-regexp).

**Acciones tomadas:**
- Documento consolidado generado: `AUDITORIA_BASE_INICIAL.md`.
- Sprint A.0bis agregado al tracker con 26 items en 5 bloques de prioridad.
- ADR-004 (Kepler MSSQL) marcado como superseded → ADR-009 (Kepler Postgres con `postgres_fdw`).
- Fase B reescrita simplificada con stack Postgres-to-Postgres.

**Siguiente paso:**
- Empezar **Sprint A.0bis Bloque 1 (Seguridad inmediata)** con item `[A.0bis.1]`: cerrar CORS abierto en `main.ts`.
- Estimado para cerrar el Sprint A.0bis completo: 5-7 semanas.

---

## 2026-05-26 — Setup del modo de trabajo + decisión multi-tenant

**Tipo:** Decisión estratégica + setup de tracking
**Estado al cierre:** ✅ Configurado

**Qué se decidió:**
- **Modo de trabajo**: todo el desarrollo se hará desde este chat con Claude. No habrá onboarding para humanos. Los `.md` son la memoria entre sesiones; mantenerlos vivos es mandatorio.
- **Multi-tenancy ACEPTADO** (ADR-010): vamos a crear una DB Postgres nueva con schema multi-tenant desde el origen. Mega Dulces será el primer tenant.
- **Approach**: shared DB + `tenant_id` en todas las tablas + Postgres RLS como defense-in-depth.
- **DB legacy queda en paralelo** hasta cutover.
- **Plan correctivo del audit (Sprint A.0bis)**: gran parte se aborbe automáticamente al crear schema limpio en nueva DB.

**Qué se creó:**
- Nuevo sprint en tracker: `A.0-multitenant` con 5 sub-sprints + checkpoint (35 items).
- Plan detallado en [`FASES/FASE_A0_MULTITENANT_NEW_DB.md`](FASES/FASE_A0_MULTITENANT_NEW_DB.md).
- ADR-010 documentado.
- ADR-003 marcado como superseded por ADR-010.
- Tracker mejorado con estados granulares: ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD · ⚠️ BLOCKED · ❌ REVERTED.
- CLAUDE.md actualizado con el modo de trabajo + sprint en curso.
- INDEX.md actualizado.
- Items A.0bis.1-3 (CORS, JWT, credenciales) marcados ⚠️ BLOCKED por decisión del usuario.

**Qué se limpió:**
- Borrado `docs/ONBOARDING.md` (no aplica — todo via chat).
- Borradas carpetas vacías `docs/RUNBOOKS/`, `docs/PLANTILLAS/`, `.github/ISSUE_TEMPLATE/`.

**Siguiente paso:**
- **`[A.0mt.1.1]`** — Crear servicio Postgres nuevo en Railway (separado del actual). Es el primer item del Sprint A.0-multitenant.

---

<!-- Las siguientes entradas se agregan al revisar / cerrar items reales. -->
