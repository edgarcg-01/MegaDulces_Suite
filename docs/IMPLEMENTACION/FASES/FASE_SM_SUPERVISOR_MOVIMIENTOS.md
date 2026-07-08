# Fase SM — Supervisor de Movimientos (Cuadre / Reconciliación)

> **ADR-029.** Supervisor que analiza movimientos de caja (ventas de tienda), CEDIS/traspasos y movimientos de inventario, y detecta **dónde no cuadra** contra el inventario. Hermano operativo de **Maat** (finanzas) y **Horus** (ejecución). Hereda ADR-016/028: *el motor calcula el cuadre, marca los descuadres, el humano confirma la causa; el LLM fuera del cálculo.*

## Tesis

Hoy el almacén es **descriptivo** (dead-stock, días de cobertura, IRA). Falta lo **prescriptivo de control**: un motor que cruce las 3 identidades de cuadre y saque una bandeja de descuadres priorizada por $, con causa asignable y aprendizaje por feedback. Motor determinista (SQL), reusa el andamiaje de Maat.2 (detector + findings + scanner + cron + L2).

## Los 3 planos de cuadre

**P1 — Inventario (unidades).** Por SKU×sucursal×período:
```
existencia_inicial + entradas − salidas = teórica   →  vs física (conteo) / kdil-kdik
residual = merma no explicada
```
Más: completitud `Σ movimientos (kardex) = Δ existencia`.

**P2 — Caja (dinero).** Por caja×día×sucursal:
```
efectivo esperado (venta) vs efectivo contado (arqueo) = diferencia (faltante/sobrante)
```
Más: **faltantes recurrentes por cajero**; sobrantes anómalos.

**P3 — Cruce venta↔inventario↔caja.** Unidades vendidas (kdm1/kdm2 c4=10) vs salidas de kardex vs sales_daily; ticket cobrado vs precio×qty (descuento no autorizado); venta sin corte que la cubra.

## Fuentes de datos (Kepler → analytics.*, on-prem)

| Fuente Kepler | Aporta | Feed → tabla |
|---|---|---|
| **`kdpv_folio_caja`** | Arqueo POS: esperado(c15)/contado(c25)/diff(c35) por caja×día | `import-cash-cuts.js` → `analytics.cash_cuts` |
| **`kdij`** (kardex, 761k) | Ledger transaccional de movimientos (entrada/salida por SKU×folio) | `import-kardex.js` → `analytics.stock_ledger` |
| **`kdmm`** (170) | Catálogo tipo movimiento → cuenta (clasificador: venta/traspaso/merma/ajuste) | (join en el feed de kardex) |
| **`kdil`/`kdik`** | Existencia por almacén/sucursal + costo + ventas periodo | (feeds existentes) |
| **`kdm1`/`kdm2`** | Documentos ventas/compras/traspasos | `analytics.sales_daily` (existe) |
| `kdc22XX` | Corte de caja diario contable (pólizas) — vista dinero | (opcional, cruce contable) |
| `kdue`/`kduf`/`kdug` | CxC + aging — cuadre venta a crédito/cobranza | (4º plano, futuro) |

**Verdad de existencia:** por el bug `kdil.c4=0`, entre conteos la existencia teórica se calcula del kardex; el **conteo físico** (`commercial.inventory_counts`) es la verdad periódica.

## Arquitectura

`libs/reconciliation` (nueva lib, `scope:reconciliation` → platform/shared; lee analytics.*). Schema `reconciliation.*` (RLS forzado). Frontend `/almacen/cuadre`.

```
Kepler (LAN) ──importers──▶ analytics.{cash_cuts, stock_ledger}
                                    │
                    MovementReconcileService (detectores SQL, 3 planos)
                                    │
                    reconciliation.discrepancies ◀── HITL (confirmar + asignar causa)
                                    │
              bandeja /almacen/cuadre + cron nocturno + alerta WS crítica (FINANCE_NOTIFIER_PORT)
```

Aprendizaje **L2**: `rule_registry.precision_score` por feedback → auto-supresión de reglas ruidosas (redondeos de centavos) salvo `pinned`.

## Schema (SM.0 — `20260707170000_reconciliation_schema.js`)

- `reconciliation.rule_registry` — detectores (plano, params editables, precision_score, pinned/suppressed).
- `reconciliation.discrepancies` — bandeja: plano, severity, status, entity jsonb (sucursal/caja/cajero/sku), esperado/observado/diferencia, importe, causa_probable/confirmada, evidencia, dedup_key (idempotente).
- `reconciliation.discrepancy_feedback` — verdict + causa asignada (dataset L2).

## Sprints

| # | Entrega | Estado | Depende |
|---|---|---|---|
| **SM.0** | Schema `reconciliation.*` + lib skeleton + perms + rule_registry | 🔨 schema hecho | — |
| **SM.1** | F1 caja (`import-cash-cuts`) + detector P2 + bandeja mínima (máx señal, rápido) | ⬜ | SM.0 |
| **SM.2** | F2 kardex (`import-kardex`) → `stock_ledger` + detector P1 (merma + completitud) | ⬜ | SM.0 |
| **SM.3** | Cruces P3 (venta↔inventario↔caja) | ⏸️ DIFERIDO — sin señal limpia (Kepler calcula venta/inv/caja juntos = tautológico; descuento-línea no existe). Reabre con fuente independiente. | SM.1, SM.2 |
| **SM.4** | Frontend `/almacen/cuadre` (KPIs + bandeja densa + evidencia + HITL) | ⬜ | SM.1+ |
| **SM.5** | Cron nocturno + L2 + alerta WS crítica | ⬜ | SM.3 |
| **SM.6** | Consola read-all: tabs Resumen/Cortes/Movimientos/Descuadres (data cruda + KPIs) | ✅ 2026-07-08 | SM.4 |
| **SM.7** | Desglose completo del corte + nombres + filtros | ✅ 2026-07-08 | SM.6 |

## SM.7 — Anatomía del corte (por qué cuadra o no) — ✅ 2026-07-08

Desciframiento en vivo de `md.kdpv_folio_caja` (686 cortes md_03 + 2178 red completa). Un corte enfrenta **esperado (sistema) vs contado (arqueo)** por forma de pago: efectivo `c15/c25/c35`, tarjeta `c16/c26/c36`, transferencia `c17/c27/c37`. Además `c43/c44/c45` = desglose del arqueo (billetes/monedas/otros), `c48` = efectivo retirado, `c49` ≈ efectivo esperado (**NO** venta total).

**Hallazgos que reencuadran el módulo:**
1. **Arqueo no ciego (crítico):** 1456 de 1993 cortes de monto alto (**73%**) cierran con contado idéntico al esperado **al centavo** — imposible en un conteo físico real. El descuadre bajo NO significa caja sana; significa que el arqueo no se hace a ciegas. → regla `arqueo_no_ciego` (cajero×mes ≥90% exacto): **49 hallazgos**.
2. **Descuadre no-efectivo invisible:** tarjeta/transferencia también descuadran y no se miraba. → regla `descuadre_no_efectivo` (c36/c37): **73 cortes**.
3. **Bug de venta:** `total_venta` mapeaba c49 (≈solo efectivo). Venta real = c15+c16+c17. Corregido en `venta_total`: **$61.3M** real vs $54.2M viejo (−$7.1M subestimado).

**Integrado:**
- Migración `20260708120000_cash_cuts_desglose` (+7 columnas idempotentes + backfill `venta_total`).
- Importer `import-cash-cuts` lee c36/c37/c43/c44/c45/c48 + calcula `venta_total`; SSL condicional por host (local sin SSL).
- 2 reglas nuevas en `MovementReconcileService` (`descuadre_no_efectivo`, `arqueo_no_ciego`).
- Query service: cortes con desglose + flag `cuadre_exacto`; overview con `pct_exacto`/`descuadre_no_efectivo`/venta real; movimientos con **nombre de producto** (join `public.products`); nombre de **sucursal** ya presente.
- Consola: Resumen con KPI arqueo-no-ciego + nota; Cortes master-detail (formas de pago + desglose arqueo) + filtros de fecha; Movimientos con producto + filtros de fecha.

**Cajero por nombre ✅:** `analytics.pos_cashiers` (mig `20260708140000`) + importer `import-pos-cashiers` une `kdpv_gerentes` (códigos prefijados `40VMC`/`54TYSL`) + `kdpv_kdku` (cortos `02`/`01JZICO`), escopeado por sucursal. **742 cajeros, 100% de cortes resueltos.** Join en cortes/overview/4 detectores → los hallazgos nombran al culpable (ej. TANIA YAZMIN SÁNCHEZ LEAL $57k). Acentos con mojibake WIN1252 del ERP (cosmético). Codes basura (`123`) caen a fallback = código.

**Pendiente prod (Railway):** aplicar migs `20260708120000` + `20260708140000` + `20260708160000` + re-correr `import-cash-cuts --apply` + `import-pos-cashiers --apply` + `Escanear ahora`. Las tablas base SM ya están en prod; local (5433) quedó al día en esta sesión (batch 146).

## SM.7b — ¿Cuándo y en qué circunstancia? (deducción sobre 2178 cortes) — ✅ 2026-07-08

Perfil de riesgo del descuadre (7.5% de cortes con |diff|≥$50, hora sacada de Kepler c6/c11):

- **Día:** lunes (11.4%) y sábado (8.5%) — extremos de la semana concentran el faltante ($83k / $88k). Mié-vie sanos (~5%).
- **Hora de cierre:** el $ del faltante se concentra en el cierre de **15:00 ($133k)** y **18:00 ($52k)** — cambios de turno.
- **Duración del turno:** **>10h → 12%** de descuadre vs **6%** normal. Driver medido más limpio.
- **Cambio de cajero (abre≠cierra):** **82%** de cortes, **$320k de $379k** del faltante. Circunstancia dominante.
- **Cajas calientes:** suc02-caja2 (17.9%), suc02-caja1 (16%), suc05-caja4/5 (12%+).
- **Tendencia:** al alza en 2026 (~$70k faltante/mes abr-jun). Sin efecto quincena.

**Deducción:** máximo riesgo = **lunes/sábado, turno >10h, cierre en cambio de turno (15/18h), caja que cambió de manos**, en las cajas calientes. **Caveat:** es la punta del iceberg — el 73% cuadra exacto (arqueo no ciego), así que el descuadre visible aflora donde cuadrar artificialmente fue más difícil.

**Integrado:** ingesta de `hora_apertura`/`hora_cierre`/`duracion_horas`/`handoff` (mig `20260708160000` + importer) + regla `corte_riesgo_circunstancia` (cambio de cajero + turno ≥10h + cuadre exacto + monto ≥$5k → **154 cortes** de $50-65k a auditar a mano). Detalle del corte en la consola muestra horario + circunstancia.

## SM.8 — Plan de prevención (cómo evitar que siga pasando)

Causa raíz encadenada: **arqueo no ciego** (habilita) → **handoff sin arqueo de relevo** (difumina responsabilidad) → **turnos largos** (fatiga) → **sin loop de accountability** (no se corrige). Plan por fases, cada una medible:

| Fase | Acción | Ataca | Cómo se mide |
|---|---|---|---|
| **P0 — Confirmar** | Correr scan + poblar bandeja. Piloto de **arqueo ciego** en 1 sucursal (contar ANTES de ver el esperado) 2-4 sem. | Valida que el 73% exacto enmascara. | Tasa de descuadre real del piloto vs 7.5% base. Si sube → confirmado. |
| **P1 — Arqueo ciego** (palanca #1) | Kepler no lo fuerza → forzarlo en NUESTRA capa: captura de arqueo (desglose de billetes + foto, sellada con timestamp) **antes** de mostrar el esperado; supervisor compara vs c25. | El habilitador. | `arqueo_no_ciego` baja de 49 hallazgos; % cuadre-exacto cae. |
| **P2 — Arqueo de relevo** | Corte intermedio obligatorio en cambio de turno → responsabilidad limpia por persona. | El 82% / $320k de handoff. | `corte_riesgo_circunstancia` baja; faltante por handoff cae. |
| **P3 — Límite de jornada** | Alertar/limitar turnos >10h (política RH + flag automático). | El +6pp de fatiga. | % cortes >10h; su tasa de descuadre. |
| **P4 — Foco puntos calientes** | Supervisión dirigida (rotación, doble arqueo, cámara) a suc02-caja1/2, suc05-caja4/5 y top cajeros. | La concentración. | Tasa por caja/cajero intervenido. |
| **P5 — Cerrar el loop** | Bandeja HITL → acción propuesta (ADR-013 `proposed_actions`) → responsable → seguimiento. Ritual semanal. Efectividad **diff-in-diff** (Horus-L L3): caja intervenida vs control. | La tendencia creciente. | ¿Baja la tasa en las cajas intervenidas vs no? |
| **P6 — Cruce independiente** (reabre SM.3) | Reconstruir venta-efectivo del turno desde tickets POS (`kdm1.c10` forma de pago) como fuente **independiente** del esperado de Kepler. | Fraude que manipula el **esperado**, no solo el conteo. | Diferencia esperado-Kepler vs venta-efectivo reconstruida. |

**Secuencia crítica:** P0 confirma → P1 (arqueo ciego) es la de mayor impacto y sin ella P4/P5 miden ruido. P6 es el techo (ataca manipulación del esperado, no solo del contado).

### P1 — Arqueo ciego ✅ (implementado 2026-07-08)

- `reconciliation.blind_counts` (mig `20260708180000`, RLS forzado): captura del conteo físico por denominación (MXN 1000…0.5) + total server-computed + timestamp sellado + captured_by.
- `BlindCountService.submit()`: guarda y **recién ahí revela** la comparación vs el esperado de Kepler (flujo ciego por diseño). `.list()` = historial con comparación.
- Endpoints: `POST /reconciliation/blind-counts` (GESTIONAR), `GET /reconciliation/blind-counts` (VER).
- Regla **`arqueo_ciego_divergente`**: `|esperado − contado_ciego| ≥ umbral`. **Crítico** cuando Kepler reportó el corte cuadrado (`|c35|<50`) → **enmascaramiento confirmado**.
- Consola: tab **Arqueo ciego** — pad de denominaciones (no muestra el esperado hasta guardar) + revelación de la diferencia real + historial.
- Smoke E2E: corte real exacto de Kepler ($121,961, diff 0) + arqueo ciego −$800 → la regla destapa faltante real $800 con `ENMASCARÓ=true`.
- **Uso P0 (piloto):** capturar el arqueo ciego en 1 sucursal durante 2-4 sem y comparar la tasa real vs el 7.5% base. Si sube → confirma que el 73% exacto enmascara.
- Pendiente prod: mig `20260708180000` + seed de la regla (la crea `ensureRules` en el primer scan).

**Ruta crítica:** SM.0 → SM.1 (caja) entrega valor en la primera rebanada (detecta faltantes por cajero con data real — 90 cortes ≥$50 en md_02 sola).

## Gotchas (bakeados)

- `kdil.c4=0` → existencia teórica del kardex; conteo físico = verdad periódica.
- DBs Kepler **arrastran réplicas** de otras sucursales → filtrar `c1`/sucursal propia.
- Feeds **on-prem** (leen LAN 192.168.x, escriben Railway por proxy). No en Railway.
- `TenantKnexService.run()` obligatorio (RLS). TZ `America/Mexico_City`.
- Umbral de caja (~$50) para no ahogarse en redondeos de centavos.
- Permiso nuevo (`RECONCILIATION_VER`/`_GESTIONAR`) → backfill migration + re-login (no llega solo del seed).

## Deferred

- P4 cuadre de crédito/cobranza (CxC `kdue/kduf/kdug`).
- Write-back de ajustes a Kepler (solo lectura por ahora).
- ML de anomalías (Isolation Forest) — gate por volumen de feedback, igual que Maat/Horus.
