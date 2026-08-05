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

### CXP.2 — 📊 Tablero maestro CxP (`/finanzas/pagos-control`) ⬜
- Backend `GET /finance/pagos/control` (agregado): fuga total + top proveedores, riesgo doble pago (total/count/críticos), reconciliación (canal pago/nota/ambos), próximos vencimientos (DPO por ahora).
- Frontend Operations: tira de KPIs + tablas top + links a hallazgos/acciones. Nav item bajo `finanzasNavItems`.

### CXP.3 — 📋 OC maestro "como el Excel" (`/compras/compras-360`) ⬜
- Row = recepción/factura (`analytics.erp_goods_receipts`, trae `oc_folio`/`vale_folio`/proveedor/monto/fechas) ⋈ líneas ⋈ ajustes (`entrada_folio`→`factura_ref`→`proveedor+fecha`) ⋈ pago (`proveedor_code`+fecha, best-effort).
- Backend `GET /compras/compras-360` con filtros (proveedor/sucursal/fecha/estado con-sin factura/pago/diferencia) + export xlsx.
- Frontend grid denso master-detail (SidePeek) Operations.
- Opcional CXP.3.3: espejo `analytics.erp_purchase_orders(_lines)` de X-A-35 (shape ya lo lee `import-in-transit.js`) si se quieren filas a nivel OC.

---

## Prerequisito operativo
- **Redeploy del api** (pendiente de sesiones previas): reconciliación/fuga dan $0 con el api stale; el bell y el tablero leen esos mismos endpoints. Ver [[reference_railway_api_stale_deploys]]. Sembrar hallazgos directo entrega valor sin esperar el redeploy.
- **Rotar la credencial** de prod expuesta.

## Decisiones abiertas (con default)
- Tablero CxP en `/finanzas/pagos-control` **[default]** vs `/compras/tablero`.
- OC maestro centrado en recepción **[default, rápido]** vs espejo de OC X-A-35 (completo, +1 importer).
