# Fase J.8 — Migración desde repo Megadulces-Logistica

> **Objetivo**: traer features reales del repo importado `_imported/logistica/` que no estaban en J.0-J.7. Estrategia **híbrida aditiva**: se respeta multi-tenant + RLS + hook con `commercial.orders` (NO regresar a single-tenant).
>
> **Fecha inicio**: 2026-05-27
> **Fecha cierre**: 2026-05-27
> **Estado**: 🟢 CERRADA (beta scope)

---

## Contexto

El usuario importó el código fuente real de la app monolítica de logística (`_imported/logistica/`). Estado anterior (J.0-J.7) había construido un schema multi-tenant equivalente desde cero. Esta sub-fase **completa los gaps** que faltaban traer del repo:

- 3 estados extra en máquina de estados (`checklist_salida`, `checklist_llegada`, `costos_pendientes`)
- Tabla `logistics.shipment_checklists` (con `items JSONB` + respuestas)
- Tabla `logistics.shipment_photos` (Cloudinary + GPS + descripción, general purpose, no solo proof of delivery)
- 105 destinos reales con comisiones (chofer/repartidor/ayudante/km)
- 26 períodos de pago 2026 (catorcenales)
- 22 items de `config_finance` (factores por zona + costos km por vehículo + tarifas maniobra)
- Backend module `logistics-reports` con **jspdf** (decisión explícita: no Puppeteer)
- Frontend: Capacitor camera + geolocation para upload de fotos del chofer

## Decisiones tomadas (auto mode)

| # | Pregunta | Decisión |
|---|---|---|
| 1 | Estrategia | **B — Híbrido aditivo**. NO reemplazo total. |
| 2 | Mobile | **Capacitor camera + geolocation** (chofer puede capturar fotos con GPS desde teléfono) |
| 3 | State management | **Signals + services** (NO NgRx) — consistente con el resto del monorepo |
| 4 | PDF lib | **jspdf + jspdf-autotable** (no Puppeteer, evita +150MB de Chromium en docker) |
| 5 | Destinos seed | **Reales, importar** los 105 de Mega Dulces |

## Lo que YA estaba (no se toca)

Schema cubre 80% del repo origen porque J.0-J.7 ya implementó:

- ✅ `logistics.shipments` con folio EMB-YYYY-NNNNN
- ✅ `logistics.delivery_guides` con `driver_commission` + `helper1/2_commission` + `per_diem_total` + `per_diem_breakdown` JSONB
- ✅ `logistics.guide_recipients` con `proof_photo_url` + `gps_lat/lng` (proof of delivery)
- ✅ `logistics.routes` (catálogo destinos con comisiones)
- ✅ `logistics.drivers` (con `roles[]` chofer/ayudante/cargador + `user_id` link)
- ✅ `logistics.vehicles` (con status + capacidad + rendimiento)
- ✅ `logistics.payroll_periods` (catorcenas)
- ✅ `logistics.config_finance` (factores + costos km + tarifas)
- ✅ `logistics.shipment_expenses` (combustible + casetas + viáticos + etc)
- ✅ `logistics.load_details` + `logistics.unload_details` (tarifas cargadores)
- ✅ `logistics.liquidations` (calculadas por período)
- ✅ Hook `close → fulfillInTransaction` con commercial.orders (J.6.1)

## Sub-items

| Item | Descripción | Estado |
|---|---|---|
| J.8.0 | Plan doc (este archivo) | ✅ |
| J.8.1 | Schema delta: 3 estados + `shipment_checklists` + `shipment_photos` + `routes.km` decimal | ✅ |
| J.8.2 | Importer real: 96 destinos + 26 períodos + 23 config_finance | ✅ |
| J.8.3 | Extender state machine + 3 transitions service + 3 endpoints | ✅ |
| J.8.4 | Backend modules: `logistics-checklists`, `logistics-photos`, `logistics-reports` (jspdf) | ✅ |
| J.8.5 | Frontend: 3 páginas standalone + Capacitor dynamic import + nav + quick links | ✅ |
| J.8.6 | HTTP E2E test creado y agregado a regression suite (re-correr post-restart API) | ✅ |
| J.8.7 | Docs cierre (CLAUDE.md, tracker, log) | ✅ |

## Riesgos conocidos

- **Capacitor**: agrega dependencias nativas. App ya tiene Capacitor configurado (ver `apps/view/capacitor.config.ts` si existe). Si no, solo se habilita `web` y se diferra el build mobile.
- **Cloudinary**: ya está en el monorepo (Trade Marketing lo usa). Reusar credenciales.
- **State machine extendida**: shipments existentes con `programado/en_ruta/entregado/cerrado/cancelado` siguen siendo válidos. Los 3 nuevos estados son **opcionales** en el flujo (transitions condicionales).

## Hook con commercial (preservado)

El hook `shipment.close → orders.fulfillInTransaction` sigue intacto. La diferencia es que con el state machine extendido, el `cerrado` ahora puede llegar via:
- Flujo simple: `programado → en_ruta → entregado → cerrado` (idéntico a J.0-J.7)
- Flujo formal: `programado → checklist_salida → en_ruta → entregado → checklist_llegada → costos_pendientes → cerrado`

En ambos casos, al alcanzar `cerrado` se dispara el fulfill del order asociado.
