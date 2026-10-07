# Fase FD — Diagnóstico de facturación (Centro de errores + soluciones)

> Interfaz que **junta** los errores de emisión CFDI, los **traduce** del código
> críptico del PAC/SAT a lenguaje humano y **propone la solución** (pasos + deep-link
> + reintento). Nace de un hallazgo: hoy los errores del PAC casi no se persisten.

Estado: **🔨 código completo + validado en local (9/9)**. Pendiente: aplicar migración
a prod + validación en vivo contra el PAC. Hereda ADR-016 (motor decide / LLM fuera).

---

## Análisis (por qué era necesario)

Antes de FD, cuando el PAC rechazaba algo:
- [`pac-sw.service.ts`](../../../libs/fiscal/src/lib/emision/pac-sw.service.ts) **aplastaba** el sobre estructurado del PAC (código SAT, `messageDetail`, JSON) a un string y lo lanzaba como excepción.
- [`emision.service.ts`](../../../libs/fiscal/src/lib/emision/emision.service.ts) **no tenía try/catch** alrededor del PAC → emitir/NC/REP/cancelar manuales **no persistían nada** al fallar.
- El único rastro era `commercial.orders.cfdi_error` (auto-timbrado), y hasta ese write era best-effort.
- REP fallido = **invisible** (solo `logger.warn`).

**2 bugs latentes encontrados y corregidos en FD.0:**
1. 🐞 `fiscal.cfdis.estatus_sat` tenía CHECK que **solo** permitía `vigente|cancelado|desconocido`, pero FE.10 escribe `'en_proceso_cancelacion'` → **la cancelación con aceptación del receptor reventaba** con violación de CHECK. FD.0 amplía el dominio (+`en_proceso_cancelacion`, +`rechazado`).
2. 🐞 REP sin captura de error → ahora se registra en `fiscal.emission_errors` (kind=`rep`).

---

## Arquitectura (reusa el patrón de hallazgos del repo)

| # | Pieza | Archivo |
|---|---|---|
| FD.0 | `PacError` tipado (conserva code/message/messageDetail/raw) | [`pac-error.ts`](../../../libs/fiscal/src/lib/emision/pac-error.ts) |
| FD.0 | Captura idempotente `fiscal.emission_errors` (self-resolving por `dedup_key`) | [`emission-errors.service.ts`](../../../libs/fiscal/src/lib/emision/emission-errors.service.ts) |
| FD.0 | Wrap try/catch en emitir/NC/REP/cancelar (registra + re-lanza; resuelve al éxito) | [`emision.service.ts`](../../../libs/fiscal/src/lib/emision/emision.service.ts) |
| FD.0 | Migración: tabla + **fix bug estatus_sat CHECK** | [`20260717120000_fd0_emission_diagnostics.js`](../../../database/migrations-newdb/20260717120000_fd0_emission_diagnostics.js) |
| FD.1 | Base de conocimiento SAT/PAC (código/regex → causa + solución + deep-link) | [`sat-error-catalog.ts`](../../../libs/fiscal/src/lib/emision/sat-error-catalog.ts) |
| FD.2 | Servicio de diagnóstico (lista + KPIs + detalle + descartar, enriquecido con KB) | [`emission-diagnostics.service.ts`](../../../libs/fiscal/src/lib/emision/emission-diagnostics.service.ts) |
| FD.2 | API `fiscal/diagnostics` (VER lee, GESTIONAR descarta) | [`emission-diagnostics.controller.ts`](../../../libs/fiscal/src/lib/emision/emission-diagnostics.controller.ts) |
| FD.3 | Revisión preventiva `health()` on-demand (emisor / e.firma por vencer / cobertura código agrupador) | (en el service FD.2) |
| FD.4 | Frontend: pestaña **Diagnóstico** (KPIs + panel preventivo + tabla con solución expandible + acciones) | [`contabilidad-diagnostico.component.ts`](../../../apps/view/src/app/modules/contabilidad/pages/contabilidad-diagnostico.component.ts) |
| FD.5 | Regresión DB-direct | [`test-newdb-fiscal-diagnostics.js`](../../../database/tests/test-newdb-fiscal-diagnostics.js) |

**Permisos:** reusa `FISCAL_FACTURAR_VER` (lee) / `FISCAL_FACTURAR_GESTIONAR` (descarta/reintenta) — **sin permisos nuevos**.

**Reintento:** el timbrado ligado a pedido reusa el retry idempotente de Comercial (`POST /commercial/orders/retry-invoices`). El resto se corrige desde su pantalla (deep-link de la KB).

---

## Base de conocimiento (ejemplos)

| Señal | Traducción | Solución |
|---|---|---|
| `CFDI40147` / RFC no en LCO | RFC del receptor no registrado en el SAT | Verificar contra la constancia (→ ficha cliente) |
| `CFDI40148` | Razón social no coincide con el SAT | Copiar exacto de la constancia |
| `CFDI40149` | CP fiscal no coincide | Corregir CP fiscal del cliente |
| `CFDI40158` | Uso de CFDI no aplica al régimen | Cambiar uso de CFDI |
| `CFDI40102` / `302` | CSD del emisor inválido/mal cargado | Revisar CSD en la cuenta del PAC |
| `304` | Certificado revocado/vencido | Renovar CSD/e.firma (→ credenciales) |
| `307` | CFDI duplicado | Ya se emitió — no re-timbrar |
| cancelación no cancelable | Fuera de plazo / requiere aceptación | Nota de crédito o atender REP/relacionados |

Curado, ampliable, con fallback por operación. Resolver: código exacto → regex → fallback.

---

## Verificación

- **Build API**: verde (FD.0–FD.3). Warnings pre-existentes ajenos (`reconciliation`, `cfdi/conciliacion`).
- **Build view**: bloqueado por un error **de otro hilo** (`comercial-inventory-session-detail` → `kpiItems`), NO por FD. El compilador Angular no marcó ningún archivo de FD.
- **Regresión local (aislada)**: **9/9** — migración up() limpia, RLS forzado, fix estatus_sat, captura idempotente por `dedup_key`, auto-reapertura.

---

## Pendiente para producción

1. **Aplicar migración** `20260717120000_fd0_emission_diagnostics.js` — hoy `knex migrate` local está bloqueado por un archivo de **otro hilo** con error de sintaxis (`20260717120000_reparto_backfill_perms.js`); en cuanto se corrija, corre `migrate:latest`.
2. **Aplicar a Railway** (con el resto de migraciones FE pendientes) + re-login.
3. **Validación en vivo contra el PAC**: comprobar que los códigos reales de SW/SAT caen bien en la KB y ampliar el catálogo con los que aparezcan.

## Diferido

- FD.3 como `@Cron` (hoy es on-demand).
- Sumar al tablero el DLQ de descarga masiva (`fiscal.jobs` `last_error`/`status='dead'`) y los errores de `fiscal.download_requests`.
- Feed opcional a la bandeja unificada de Maat vía `FINANCE_FINDINGS_SINK_PORT`.
