# Fase CXP — Cuentas por Pagar (valor a "pagos" que se aplica, no de palabra)

> Convierte los hallazgos de Maat sobre pagos/compras en **acciones que alguien ejecuta**,
> los surface en un **Centro de Notificaciones** en el header, un **tablero maestro CxP**, y
> una **interfaz maestra de órdenes de compra** (el "Excel"). Hereda ADR-016/028/013
> (el motor detecta / propone, el humano aprueba, la plataforma NUNCA toca Kepler).

Estado: **🔨 EN CURSO** — CXP.0 + CXP.1 ✅ local 2026-08-05.

---

## ¿Para quién es el valor? (la persona)

| Pieza | Persona / rol | Por qué |
|---|---|---|
| **Descuento no capturado** + **pago duplicado** | **Cuentas por Pagar / Tesorería** — roles existentes `gestor_egresos`, `gestor_tesoreria` (ya tienen `FINANCE_FINDINGS_GESTIONAR` = aprueban acciones) | Deciden cuándo y cuánto se paga. Capturar el pronto-pago o frenar un doble pago es su decisión directa. |
| **Reconciliación de descuentos** + **OC maestro (Excel)** | **Compras** (comprador/gerente) — `COMPRAS_VER/GESTIONAR` | Negocian términos y viven el ciclo OC→recepción→factura. |
| **KPIs agregados** (fuga, riesgo, aging) | **Contraloría / Dirección Finanzas** | Vista de tablero. |

**Decisión:** MVP **no crea rol nuevo** — reusa `gestor_egresos`/`gestor_tesoreria` + `COMPRAS_*`.
Hoy no existe un permiso AP-específico; todo se gatea con `FINANCE_FINDINGS_GESTIONAR`
(aprobar) / `FINANCE_AI_CHAT` (ver). Diferido: `FINANCE_AP_APPROVE` si se quiere separar CxP.

---

## Cómo se conecta (una sola cadena)

```
Kepler ── pago c84 / doble pago ──► analytics.erp_supplier_payments
   │  detector (leakageGroups / detPagoDuplicado)
   ▼
finance.findings  (bandeja /finanzas/hallazgos — YA existe)
   │
   ├─ MaatActionProposerService ─► finance.proposed_actions (ACCIÓN, ligada por finding_id)
   │        ├─► 🔔 Centro de Notificaciones (bell del header)  ← WS /alerts + poll 60s
   │        ├─► 📊 Tablero maestro CxP (/finanzas/pagos-control)
   │        └─► ✅ Aprobar/Rechazar (/finanzas/hallazgos — YA existe)
   │
OC maestro "Excel": erp_goods_receipts ⋈ líneas ⋈ ajustes ⋈ pago ─► /compras/compras-360
```

---

## Plan paso a paso

### CXP.0 — Descuento/riesgo → **acción** (backend) ✅ 2026-08-05
- **0.1** ✅ `finding_id` expuesto en `POST /finance/maat/actions` y en el tool `maat_proponer_accion` (antes se perdía el link hallazgo→acción).
- **0.2** ✅ `MaatActionProposerService`: lee `finance.findings` de `descuento_no_capturado` (≥$5k) y `pago_duplicado` (≥$10k) en estado nuevo/confirmado → crea `finance.proposed_actions` (kind `revisar_hallazgo`, origen `motor`) **idempotente por finding_id** (una sola acción por hallazgo, nunca re-spamea). `@Cron 09:30 UTC` + `POST /finance/maat/actions/propose-from-findings`.
- **0.3** ✅ `approve()` mueve el hallazgo a `en_revision` (efecto ya existente para `revisar_hallazgo`). Smoke `test-newdb-action-proposer` 6/6.
- Diferido (0-bis, prospectivo "paga antes del día Y"): depende del aging de CxP (RE.3, no construido).

### CXP.1 — 🔔 Centro de Notificaciones (header) ✅ 2026-08-05
- **1.1** ✅ El bridge de compras (`purchase-adjustments-findings-bridge`) inyecta `FINANCE_NOTIFIER_PORT` (@Optional) y emite WS los **críticos nuevos** (solo si `res.inserted>0`, anti-spam) → llegan al bell. (`pago_duplicado` ya emitía vía el scanner de Maat.)
- **1.2** ✅ `NotificationsBellComponent` (standalone, en el header entre update y user-menu). Badge = hallazgos críticos + acciones por aprobar (poll 60s `findings/stats` + `actions?estado=pending_approval`, gateado por `FINANCE_AI_CHAT` para no 403). Panel: resumen finanzas + feed WS en vivo (todos los tipos) + link a la bandeja. Overlay con sombra+borde (DESIGN Operations).
- **1.3** ✅ Read-state en `localStorage` (`cxp_notif_read_at`): al abrir marca leído y apaga el pulso; el badge sigue vivo hasta resolver.

### CXP.2 — 📊 Tablero maestro CxP (`/finanzas/pagos-control`) ✅ 2026-08-05
- Backend `GET /finance/pagos/control` (finance puro): agrega lo que el motor YA computó — fuga (descuento_no_capturado), riesgo doble pago (pago_duplicado, con críticos), facturas duplicadas, DPO + top proveedores por regla + acciones HITL pendientes + reconciliación de descuento por canal (pago c84 / nota comercial).
- Frontend Operations (`surf-page` + `MetricStrip` + `card-premium`): 4 KPIs, top proveedores por riesgo, acciones por aprobar con link a la bandeja. Nav item "Cuentas por pagar" (FINANCE_AI_CHAT).

### CXP.3 — 📋 OC maestro "como el Excel" (`/compras/compras-360`) ✅ 2026-08-05
- Backend `GET /commercial/purchase-adjustments/compras-360`: fila = recepción/factura (`erp_goods_receipts`, con `oc_folio`/`vale_folio`) + ajuste **ligado exacto** por `entrada_folio` (agregado, join 1:0..1 no infla) + neto. Filtros: search, sucursal, rango fecha, con_ajuste, paginación, `all` (export ≤5000). Smoke `test-newdb-compras-360` 4/4 (8,373 recepciones / $427M).
- Frontend grid denso + filtros + `MetricStrip` de totales + detalle `p-dialog` que reusa `forEntrada` (ajustes exacto/proveedor+fecha) + export CSV. Nav item "Compras 360".
- Diferido: pago per-fila (join proveedor+fecha muy débil → solo en detalle), espejo `analytics.erp_purchase_orders` de X-A-35 (filas a nivel OC), export xlsx server-side.

### CXP.4 — 💵 Costo neto (landed cost) → RA ✅ 2026-08-05
- Backend `GET /commercial/purchase-adjustments/landed-cost`: por proveedor, costo real = compras − descuento efectivo (pago c84 + notas comerciales). `rate=desc/compras`, `costo_neto`, flag `anomalo` (rate>20% = probable devolución/error, no solo descuento — HITL). Filtros min_compras/search.
- Frontend `/compras/costo-neto` (Operations): tabla bruto→descuento→%→neto + KPIs + nota. Le dice al comprador que su costo real es ~rate% menor que la lista → **reabasto con el costo verdadero**. Nav "Costo neto". Smoke `test-newdb-landed-cost` 5/5 (313 prov / $427M compras / **5.91%** tasa efectiva / 6 anómalos).
- Diferido (opt-in): reescribir el $ del sugerido de RA con `costo × (1−rate)` (cambio de math del motor — requiere aprobación).

### #3 — Cruce del descuento con CB / ContPAQi — ⏸️ posición honesta
- La **validación del descuento** (¿es real / no doble-contado?) YA se entrega con datos limpios: flag `ambos` en la reconciliación (proveedor usa pago+nota → posible solapamiento) + flag `anomalo` en costo neto (tasa>20%).
- El cruce **a nivel banco (CB)** y **libros fiscales (ContPAQi)** requiere la reconciliación de EGRESOS banco↔pago↔póliza, que hoy es heurística/no existe limpia (solo hay `libros-vs-operacion` de INGRESOS, CP.4). Por "verificar antes de mostrar" NO se construye un join débil aquí — queda como fase siguiente real (CxP × CB × ContPAQi egresos).

---

## Prerequisito operativo
- **Redeploy del api** (pendiente de sesiones previas): reconciliación/fuga dan $0 con el api stale; el bell y el tablero leen esos mismos endpoints. Ver [[reference_railway_api_stale_deploys]]. Sembrar hallazgos directo entrega valor sin esperar el redeploy.
- **Rotar la credencial** de prod expuesta.

## Decisiones abiertas (con default)
- Tablero CxP en `/finanzas/pagos-control` **[default]** vs `/compras/tablero`.
- OC maestro centrado en recepción **[default, rápido]** vs espejo de OC X-A-35 (completo, +1 importer).
