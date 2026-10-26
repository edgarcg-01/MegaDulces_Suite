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
- [`FLUJO_COMPRAS_PEDIDO.md`](FLUJO_COMPRAS_PEDIDO.md) — el **flujo** de la compra: `/compras/pedido` → requisición → aprobación → Kepler, comparado con la cadena del ERP (`X-A-30`→`X-A-35`→`X-A-40`→XA2001). No el motor del sugerido.
- [`FLUJO_COMPRA_A_PAGO.md`](FLUJO_COMPRA_A_PAGO.md) — el flujo **completo, de la compra al pago**: pedido → requisición → OC → vale → orden de entrada → aplica (nace la deuda) → factura y notas → obligación → calendario → autorización → pago → póliza → conciliación. Quién, en qué sistema, qué documento, cuánto se liga cada tramo y qué está roto, medido contra prod (2026-10-26).
- [`FLUJO_VENTA_A_COBRO.md`](FLUJO_VENTA_A_COBRO.md) — el espejo: **de la venta al cobro**, por canal (mostrador, vecinal, ruta directa, telemarketing, portal) → deuda → cobro → cartera → efectivo, depósito y conciliación → contabilidad. Medido contra prod (2026-10-26). Re-medir: `node database/scripts/medir-flujo-venta-a-cobro.js` (y `medir-flujo-compra-a-pago.js` para el otro).
- [`PROCEDIMIENTOS/COMPRAS/`](PROCEDIMIENTOS/COMPRAS/README.md) — **un procedimiento oficial por cada paso** de ese flujo (9 fichas: responsable, controles, evidencia medida, qué hacer cuando falla) + el diseño de qué documento debería emitir cada paso.

## Diseño

- [`../DESIGN.md`](../DESIGN.md) — sistema de diseño ("Mercado"). **Obligatorio antes de tocar UI.**
- `DESIGN_FOUNDATIONS.md`, `DESIGN_TABLES.md`, `DESIGN_MOTION_KPI_CARDS.md` — referencias de diseño.
- `DESIGN_TENDENCIAS_2026.md` (estético) y `DESIGN_TECNOLOGIA_2026.md` (técnico: plataforma web, responsividad, tooling, agentic UX) — investigación del estado del arte.

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
