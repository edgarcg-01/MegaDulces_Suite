# Fase C — Sales Intelligence ampliado

**Duración estimada:** 6-8 semanas
**Objetivo:** extender el panel actual al "Command Center" — mix de productos expuestos, mapa geo, alertas en tiempo real.

> ⚠️ **Stub — completar antes de iniciar**. Los sprints están en `01_TRACKER_PROGRESO.md` sección "Backlog Fase C". Detallar plan específico aquí cuando se cierre Fase B.

---

## Pre-requisitos

- ✅ Fase A cerrada.
- ⚪ Fase B opcional (la data viene del módulo de auditoría existente, no del ERP).

## Resumen de sprints

| Sprint | Tema | Semanas |
|---|---|---|
| C.0 | Modelo `exhibition_products` | 2 |
| C.1 | Capa analítica (schema `analytics.*`) | 2 |
| C.2 | Endpoints Command Center | 1 |
| C.3 | Frontend con mapa + drill-down | 3 |
| C.4 | Alertas en tiempo real | 1 |
| C.5 | Checkpoint | — |

## Entregables clave

- Tabla `exhibition_products` poblándose en cada captura.
- Schema `analytics.*` con tablas pre-agregadas.
- Endpoints `/command-center/*` sub-100ms.
- Frontend nuevo: `/dashboard/command-center` con mapa Leaflet.
- Sistema de alertas via WS namespace `/alerts`.

## Dependencias

- Lib `libs/shared-domain-types` (Fase A).
- Queue BullMQ (Fase A) — refrescos de tablas analíticas son jobs.
- Sentry (Fase A) — capturar errores en jobs.

## Referencias en doc maestro

`PLAN_PLATAFORMA_B2B.md` sección 3 — Fase 1 detallada con sprints 1-5.
