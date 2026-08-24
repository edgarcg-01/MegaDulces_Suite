# Documentación — Plataforma Mega Dulces

Índice de la documentación del proyecto. Empezá por arriba.

## Arranque (devs nuevos)

- [`../ONBOARDING.md`](../ONBOARDING.md) — de cero a API + frontend corriendo.
- [`../CLAUDE.md`](../CLAUDE.md) — **fuente de verdad**: contexto, fases, reglas. Se auto-carga en Claude Code.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — arquitectura de código: apps, dominios (libs), módulos, DBs, feeds.
- [`GLOSSARY.md`](GLOSSARY.md) — términos de dominio y nombres internos (Thot/Horus/Maat, Kepler, fases).
- [`GOTCHAS.md`](GOTCHAS.md) — trampas técnicas ya vividas (RLS, migraciones, permisos). **Antes de tocar DB.**

## Datos y ERP

- [`ARQUITECTURA_DATOS.md`](ARQUITECTURA_DATOS.md) — arquitectura de datos detallada (schemas, tablas, FKs, flujo, mermaid).
- [`MODELO_CANONICO_DATOS.md`](MODELO_CANONICO_DATOS.md) — fuente única por entidad, patrón anti-desync.
- [`ERP_KEPLER.md`](ERP_KEPLER.md) — decode de Kepler + pipeline `kepler_ods` (intro; detalle en `IMPLEMENTACION/ERP_KEPLER_SCHEMA.md`).

## Diseño

- [`../DESIGN.md`](../DESIGN.md) — sistema de diseño ("Mercado"). **Obligatorio antes de tocar UI.**
- `DESIGN_FOUNDATIONS.md`, `DESIGN_TABLES.md`, `DESIGN_MOTION_KPI_CARDS.md` — referencias de diseño.

## Tracking y decisiones

- [`IMPLEMENTACION/INDEX.md`](IMPLEMENTACION/INDEX.md) — mapa de toda la documentación de implementación.
- [`IMPLEMENTACION/01_TRACKER_PROGRESO.md`](IMPLEMENTACION/01_TRACKER_PROGRESO.md) — kanban en vivo.
- [`IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md`](IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md) — ADRs.
- [`IMPLEMENTACION/FASES/`](IMPLEMENTACION/) — detalle por fase.

## Setup de equipo

- [`TEAM_SETUP_ROADMAP.md`](TEAM_SETUP_ROADMAP.md) — roadmap de onboarding del equipo (1 → 3 devs).

---

> ⚠️ **Documentos históricos** (pre-pivote a plataforma B2B, ~mar-abr 2026, conservados por contexto):
> `ESPECIFICACIONES_TECNICAS.md` y la carpeta `areas/`. **No reflejan el estado actual** — usá `CLAUDE.md`.
