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

### P2 — Arqueo de relevo en cambio de turno ✅ (implementado 2026-07-08)

- `blind_counts` extendida (mig `20260708200000`): `tipo` ('cierre'|'relevo') + `cajero_entrante`. El relevo sella cuánto entregó el saliente al entrante (no compara vs el corte del día — es intra-turno). Índice único ahora incluye `tipo` (cierre y relevo coexisten).
- Regla **`handoff_sin_relevo`**: caja×mes con ≥3 cambios de cajero + faltante ≥$2k y sin arqueo de relevo (cobertura <50%) → **34 caja×mes** en la data real (suc05-caja4 abr: 23 handoffs, $32k). Ataca directamente los $320k que viven en handoffs.
- Consola: toggle **Cierre / Relevo** en el tab Arqueo ciego (+ campo cajero entrante); la tabla de recientes etiqueta el tipo y el traspaso saliente→entrante.
- Smoke: 34 caja×mes flaggeadas + relevo insert/dedup OK.

### P3 — Límite de jornada (fatiga) ✅ (implementado 2026-07-08)

- Regla **`turno_largo`**: cajero×sucursal×mes con ≥5 cortes de jornada ≥10h (el turno largo dobla la tasa de descuadre: 12% vs 6%). Señal de política/RH. KPI "Turnos ≥10h" en el Resumen.
- Data real: **16 cajero×mes**. Destapa la correlación fatiga↔pérdida en persona: TANIA YAZMIN SÁNCHEZ LEAL (suc05) — 20 turnos ≥10h en junio, $17,432 faltante (la misma con mayor faltante de la red).

### P4 — Focos (priorización dirigida) ✅ (implementado 2026-07-08)

- `ReconciliationQueryService.focos(scope: caja|cajero)` + `GET /reconciliation/focos`: ranking por faltante + señales (%exacto, %handoff, turnos≥10h) con la **palanca recomendada** derivada de la señal dominante (arqueo ciego / relevo / limitar jornada / supervisión).
- Consola: tab **Focos** con toggle caja/cajero. Data real (por caja): suc05-caja4 $70,781 (%exacto 84, %handoff 90) → Arqueo ciego; suc02-caja2 $43,041 (%handoff 87) → Arqueo de relevo. La acción se adapta a la causa.
- Con esto el supervisor ataca de arriba hacia abajo y sabe QUÉ hacer en cada foco, no solo dónde.

### P5 — Cerrar el loop: acciones + efectividad ✅ (implementado 2026-07-08)

- `reconciliation.actions` (mig `20260708220000`, RLS) + `ReconciliationActionsService`: propone una palanca anclada a un foco (sucursal/caja/cajero) + fecha de intervención + responsable; snapshotea `baseline_faltante` (30d antes). Estados propuesta→aceptada→en_curso→hecha/descartada (HITL, ADR-013).
- **Efectividad diff-in-diff** (Horus-L L3): faltante 30d antes vs 30d después en el alcance, **menos** el cambio de la red (control) → descuenta la tendencia general. `mejoro` = el alcance bajó.
- Endpoints `POST /actions`, `GET /actions` (con efectividad), `PATCH /actions/:id/status`.
- Consola: botón **Crear acción** en cada foco (pre-llena palanca según la señal dominante) + tab **Acciones** con antes/después/DiD y cambio de estado inline.
- Smoke: baseline + DiD calculados correctos (suc05-caja4 fecha simulada: alcance +$13,050 vs red −$16,320 → DiD +$29,370 = sin mejora, como se espera sin intervención real).
- **Loop completo:** detectar (9 reglas) → priorizar (focos) → intervenir (acción/palanca) → medir (DiD). Confirma o descarta que la palanca sirvió, con data.

### P6 — Cruce independiente: venta atómica vs corte ✅ (implementado 2026-07-08)

- El **techo**: P1 verifica el *contado*, P6 el *esperado*. `analytics.pos_ticket_sales` (mig `20260708240000`) + importer `import-pos-ticket-sales` agrega `md.kdm1` (venta real U/D/10) por sucursal×cajero(c67)×día → capa atómica. Regla **`venta_vs_tickets`** (plano `cruce`): compara vs el total del corte (capa agregada). |diff| ≥ $500 o **sin tickets** → flag. Ataca tickets cancelados/editados tras el cierre o corte inventado — algo que la cuadre propia de Kepler NO ve.
- Verificado: 672/683 reconcilian a ±$100 (no tautológico); **76 corte×día divergen ≥$500** (51 sin tickets — ej. todo el 09-ene suc03 con corte $50k+ y cero tickets). Descubierto: hallazgo `kdm1.c67`=cajero liga tickets al corte; `c10/c32`='CONTADO' NO separa efectivo/tarjeta (ese split solo vive en el corte) → P6 reconcilia venta TOTAL, no efectivo.
- Caveat: el match `c67` (ticket) vs `c8` (corte) puede diferir por sucursal (suc02 tiene "sin tickets" que son artefacto de mapeo) → calibra por feedback L2.
- `import-pos-ticket-sales`: $61.4M en tickets ≈ $61.3M venta_total del corte (reconcilian en agregado).

## SM.9 — Arqueo ciego para cajeras en Tienda (2026-07-11)

El arqueo ciego (SM.8/P1) se **expuso también en el proyecto Tienda** (`/tienda/arqueo`) para que las **cajeras** lo capturen sin darles el motor de reconciliación del supervisor. Doble superficie sobre la **misma tabla** `reconciliation.blind_counts`:
- **Cajera** (`/tienda/arqueo`): captura + historial de SU sucursal. Ve su diferencia (faltante/sobrante) pero **no** el flag de enmascaramiento de Kepler.
- **Supervisor** (`/almacen/cuadre`, tab Arqueo ciego): sin cambios — sigue viendo todo + enmascaramiento.

Implementación:
- Permisos dedicados **`STORE_ARQUEO_CAPTURAR`** / **`STORE_ARQUEO_VER`** (enum back+front, `permission-meta`, `authz-tree`). Añadidos al grupo `tienda` de `role-presets` → el rol de área **`sucursal`** los recibe.
- Backend: `StoreArqueoController` (`libs/reconciliation`) bajo `/store/arqueo` — reusa `BlindCountService`, fuerza `warehouse_code` = sucursal del usuario (`@ReqUser`), y **quita `kepler_*`** de la respuesta.
- Frontend: `TiendaArqueoComponent` + `ArqueoService` (`modules/tienda`), ruta `/tienda/arqueo` (`permissionGuard(STORE_ARQUEO_CAPTURAR)`), nav item, y **early-return** de `tienda` en `navItems` (el rol `sucursal` no tiene `REPORTES_VER_*` → sin esto el nav de tienda no renderiza).
- Migración backfill `20260711130000_grant_store_arqueo_perm.js`: operadores (sucursal + tienda legacy + admin) → CAPTURAR+VER; `prevencion_auditoria` → solo VER.

**Pendiente prod:** aplicar mig `20260711130000` + **re-login** (permisos viajan en JWT). Backend lee permisos frescos de DB (no requiere re-login); el nav/guard del frontend sí. Builds prod api+view OK.

## Estado del plan

P0 habilitado · **P1–P6 ✅** implementados y verificados contra data real. **SM.8 (prevención) CERRADA.** **SM.9 (arqueo en Tienda) ✅ 2026-07-11 (local).**

El motor corre **10 reglas** (caja_descuadre, cajero_faltante_recurrente, descuadre_no_efectivo, arqueo_no_ciego, corte_riesgo_circunstancia, arqueo_ciego_divergente, handoff_sin_relevo, turno_largo, venta_vs_tickets, merma_inventario) en 3 planos (caja/cruce/inventario). Consola `/almacen/cuadre` con 7 tabs. Ciclo completo: **detectar → priorizar (focos) → intervenir (acciones) → medir (diff-in-diff)**.

**Pendiente prod (Railway):** migs `120000/140000/160000/180000/200000/220000/240000` + importers `import-cash-cuts`/`import-pos-cashiers`/`import-pos-ticket-sales` `--apply` + `Escanear ahora` + re-login. Migs/seeds base ya aplicados por el usuario 2026-07-08. Local (5433) al día (batch 151).

**Ruta crítica:** SM.0 → SM.1 (caja) entrega valor en la primera rebanada (detecta faltantes por cajero con data real — 90 cortes ≥$50 en md_02 sola).

## SM.9 — Lazo /tienda/arqueo ↔ /almacen/cuadre (✅ local 2026-07-30)

Cierra el enlace entre la **captura de la cajera** (`/tienda/arqueo`) y la **consola del supervisor** (`/almacen/cuadre`). Antes compartían `reconciliation.blind_counts` pero el puente era **batch** (solo el `scan` nocturno/manual lo cruzaba).

- **Autolineado (instantáneo).** `BlindCountService.submit`: al capturar un `cierre` que matchea corte y diverge `≥$50`, levanta al instante el descuadre `arqueo_ciego_divergente` (UPSERT idempotente por `dedup_key`, espeja el detector). El arqueo de la cajera aparece en la bandeja del supervisor **sin esperar al cron**, crítico si Kepler enmascaró. Engine expone `ensureRule` + `upsertDiscrepancy` públicos (reusados por `scanAll`).
- **Corte malo visible.** `cashCuts` hace `leftJoin` a `blind_counts` (tipo=cierre) → columna **"Arqueo ciego"** en el tab Cortes: *sin arqueo · cuadra ciego · **corte malo Δ$** (+ incidencia)*.
- **Incidencia tipificada.** Mig `20260730120000` añade `blind_counts.incidencia_tipo` (CHECK: faltante_justificado/billete_falso/robo/error_cobro/otro). Selector en `/tienda/arqueo` (solo cierre) → viaja como evidencia del descuadre.
- **Alerta WS.** `RECON_NOTIFIER_PORT` (contracts) + `ReconNotifierBindingModule` (composition root) → alerta `recon_bad_cut` al supervisor, ruta `/almacen/cuadre` (separado del `FINANCE_NOTIFIER_PORT`/Maat que rutea a finanzas). Best-effort, fuera de la transacción.

Builds api+view OK. Smoke DB verde: join liga arqueo→corte (diff_real $500, incidencia robo, divergente=true) + UPSERT idempotente por `dedup_key`.

**Pendiente prod:** mig `20260730120000` a Railway + redeploy api+view + re-login.

## SM.10 — El arqueo de la cajera, ciego de verdad + alcance real (✅ local 2026-08-27)

Tres huecos que quedaron abiertos en SM.9, los tres en `/tienda/arqueo`.

**1. El ciego dejaba de serlo al primer guardado.** `StoreArqueoController` quitaba los `kepler_*` pero seguía devolviendo `esperado` y `diff_real`, y la pantalla los revelaba ("Guardar y **revelar diferencia**"). Con la diferencia en la mano el esperado se despeja (`esperado = contado + diferencia`), y como `submit` es un **UPSERT** por `(sucursal, caja, fecha, cajero, tipo)`, la cajera podía recapturar "ajustando" hasta cuadrar — que es exactamente el mecanismo detrás del 73 % de cortes exactos al centavo de SM.7. Ahora:

- el backend **no manda los campos**: `proyectar()` los quita salvo `RECONCILIATION_VER` (o admin de plataforma). Se ocultan `esperado` y `diff_real` **juntos**, a propósito;
- el `submit` de la cajera responde lo mínimo (`tipo`, `total_contado`, `reveal:false`); se quitó también `ambiguous`, que filtraba que hay más de un corte en su caja;
- el **autolineado SM.9 no cambia**: el descuadre se levanta igual en la bandeja del supervisor + WS. Ocultar el número a la cajera no es dejar de detectarlo.

**2. El alcance venía de la ficha, no del alcance** (`[ID.4]`, ADR-050). Vivía acá el fail-OPEN `user?.warehouse_code || query.warehouse_code`. Ahora la lectura va por `ScopeService.readParam()` (`warehouse_codes[]`) y la escritura por `assertCanWrite` → **403** al capturar fuera, no un filtro que se salta mandando otro `warehouse_code` en el body. Se puede expresar "la 01 y la 03" con un `user_scopes` `listed`; con una sola sucursal el comportamiento es idéntico al de antes. `BlindCountService.list` acepta `warehouse_codes` (`[]` → cero filas, no 403: un historial vacío es una respuesta legítima).

**3. Las flechas del pad sumaban billetes.** El conteo usaba `p-inputnumber`, cuyo spinner incrementa con ↑/↓ — una flecha de más cambia el conteo de una denominación sin que la cajera lo note, y eso es un descuadre fabricado por la UI. Pasó a input de texto con navegación propia: **↑ sube, ↓/Enter bajan**, el foco selecciona lo que hay y sólo entran dígitos.

Además: `DataScopeService` en el front (`GET /users/me/scope`, cacheado — primer consumidor del alcance desde la UI) alimenta el selector de sucursal, la columna Sucursal del historial cuando hay más de una, y el empty-state "tu usuario no tiene sucursal asignada".

**Verificado.** Smoke `http-store-arqueo-test.js` **28/28** contra `platform_test` (afirma la AUSENCIA de las claves, no su valor: un `esperado: null` seguiría siendo un contrato que filtra) + contraste con un supervisor sembrado que sí las recibe + el faltante de $2,000 que la cajera no vio y la bandeja sí registró. Builds api+view verdes. Padrón: las **27 cajeras** (`rol cajero`) resuelven `own` con sucursal asignada → nadie pierde acceso; y ese rol **sólo** tiene los permisos de arqueo (sin `STORE_ANALYTICS_VER` ni `STORE_LIVE_VER`), así que no hay otra pantalla por donde ver la venta.

**Pendiente prod:** migs **`20260826120000` + `20260826121000`** (alcance) en Railway — sin ellas `ScopeService` no tiene de dónde leer — + redeploy api+view. **No requiere re-login** (el alcance no viaja en el JWT).

**Decisión abierta (Edgar):** `auxiliar_tienda` (3 usuarios) captura arqueo y tiene `STORE_ANALYTICS_VER` pero no `RECONCILIATION_VER` → con este cambio deja de ver la diferencia en el arqueo, pero puede ver la venta en Análisis. O se le quita la analítica, o se lo trata como supervisor.

## SM.11 — El arqueo de Kepler, jalado del ODS + firma del que cuenta (✅ local 2026-08-27)

Para que el arqueo ciego sirva hace falta contra qué compararlo. Esto trae ese lado.

### Qué ES el arqueo de Kepler (verificado sobre 3,048 cortes cerrados del ODS)

| Columna | Significado | Confianza |
|---|---|---|
| `c15` | efectivo **esperado** | ✅ |
| `c25` | efectivo **contado** — el arqueo | ✅ como dato, ⚠️ como hecho |
| `c35` | **diferencia** (`c15 − c25`) | ✅ **3048/3048** coherentes |
| `c48` | efectivo retirado | ✅ monto (604 valores distintos) |
| `c43` | **billetes** | ✅ poblado en 2,901/3,051 (rectificado 2026-09-02) |
| `c44` | **monedas** | ✅ poblado en 2,807/3,051 (rectificado 2026-09-02) |
| `c45` | otros — **NO** es efectivo contado | ⚠️ no sumar al arqueo |
| `c46`/`c47` | límites/parámetros | ⚠️ 42 y 44 valores distintos en 3,048 filas → **no son montos** |
| `c49` | ≈ `c15` — **no** es la venta total (venta = `c15+c16+c17`) | ✅ (ya corregido en SM.7) |

Dos cosas que hay que tener presentes al comparar:

1. **`c25` no es un conteo físico verificado, es un número declarado.** El **74.5%** de los cortes cierra con `c25` idéntico a `c15` al centavo. Comparar nuestro arqueo ciego contra `c25` mide *contra qué se declaró*; compararlo contra `c15` mide el hueco real. Por eso `compare()` usa `c15` como esperado y guarda `c25`/`c35` solo para levantar el flag `kepler_enmascaro`.
2. **Kepler no guarda denominaciones**, solo el total. El detalle pieza por pieza vive en `wincaja.arqueos` (3 sucursales) y en `reconciliation.blind_counts`. La comparación es **total contra total**.

**Rectificación (2026-09-02).** Una versión previa de esta tabla daba `c43/c44/c45` por no confiables porque su suma reproducía `c25` en apenas 428/3048 cortes. El análisis estaba mal armado: metía `c45` en la suma y exigía tolerancia de centavos. La identidad que sí cierra es

    c43 (billetes) + c44 (monedas) + c48 (retirado) = c25 (contado)   → 63.6%

porque lo que queda en el cajón al cerrar es lo contado **menos** las sangrías del turno. Ejemplo real: `590 + 67 + 9,000 = 9,657` contra un contado de `9,657.16`. En la sucursal 04, que no registra retiros así, cuadra directo (48% exacto, desvío mediano $16.68). Cuando no cierra, el hueco suele ser un número redondo ($9,000) = un retiro que no quedó en `c48`, lo que sirve como chequeo de coherencia del corte.

Lo que Kepler efectivamente **no** tiene sigue siendo el conteo **por denominación** (cuántos billetes de $500): eso vive solo en `wincaja.arqueos` (3 sucursales) y en el nuestro. Corrección aplicada a `KEPLER_TABLAS_COMPLETO.md` y a la cabecera del importer.

### Cómo se jala: `load-cash-cuts-from-ods.js`

Hermano de `import-cash-cuts.js` — **misma tabla destino, misma llave de conflicto**, otra fuente: `kepler_ods.kdpv_folio_caja`, que el CDC ya replica **dentro de la misma base** que el destino. Consecuencias: un solo UPSERT en SQL (no viajan filas por la red), corre desde cualquier lado (Railway incluido, no solo la máquina de feeds), y la frescura es la del CDC en vez de la del último nightly. El importer de LAN queda como respaldo para sucursales que el ODS no cubra.

Detalles que el SQL tiene que respetar: `DISTINCT ON (sucursal, caja, fecha, folio)` porque el CDC puede reemitir la misma fila y el `ON CONFLICT` reventaría con *"cannot affect row a second time"*; `handoff` **no** se lista (es `GENERATED ALWAYS`); y el corte ABIERTO (`c10='1800-01-01'`, montos en cero) no es un arqueo — se filtra.

Cargado en `platform_test`: **3,044 cortes**, 6 sucursales, oct-2024 → ago-2026, 248 con descuadre declarado ≥$50 y **$509,869** de diferencias acumuladas.

### La firma: el arqueo queda a nombre de quien lo hace

El `username` **es** el código de cajero de Kepler. Verificado contra los cortes reales: `upper(username) = upper(cash_cuts.cajero_cierre)` liga a cada cajera con los suyos — `10c02`→48, `42dmar`→204, `40ammv`→172, `54tysl`→120. Es además la llave con la que `compare()` encuentra el turno.

- **El backend estampa `cajero_code`** desde el usuario autenticado. A la cajera se le **impone** el suyo: firmar un conteo de efectivo a nombre de otra persona no es un campo de formulario. El supervisor sí puede capturar por alguien (relevo, cajera sin acceso al sistema) y, si no dice nada, queda a su nombre.
- El autofill del front dejó de estar gateado por tener sucursal propia — de ahí que el campo apareciera **vacío** al entrar con un rol global — y para la cajera se muestra fijo, no como input.
- `captured_by` sigue guardando el username tal cual (auditoría de quién tecleó), separado de `cajero_code` (a quién se le imputa el turno).

Smoke `http-store-arqueo-test.js` **30/30**: manda un `cajero_code` falseado y verifica que la fila quede a nombre de quien captura. La prueba se auto-refuerza — si el backend respetara el body, el motor no encontraría el turno y el paso del autolineado se caería solo.

**Pendiente prod:** correr `load-cash-cuts-from-ods.js --apply` contra Railway (requiere que `kepler_ods.kdpv_folio_caja` esté replicada ahí) y decidir si reemplaza al `import-cash-cuts` del nightly o convive.

### El desglose por denominación no existe en ningún ERP (cerrado 2026-09-02)

Pregunta recurrente: *"¿por qué no jalás el arqueo del corte pieza por pieza —$500 × 4, $200 × 3— como lo hace Wincaja?"*. Se agotó la búsqueda, con método, y la respuesta es que **ese dato no se genera en ningún sistema**. Queda escrito para no volver a buscarlo.

**Kepler — tres pruebas independientes, todas negativas:**

1. **Barrido por forma del dato.** Se recorrieron las **1,275 columnas numéricas** de `KP_CONCENTRADA` (242 tablas con datos, incluidas las 3 de más de 2M de filas) buscando cualquier columna cuyos valores distintos fueran todos denominaciones mexicanas. Aparecieron 3 y ninguna es arqueo: `kdpv_descuxq.c5` (descuento por cantidad), `kduv.c5` (zonas de vendedor), `kdvtamano.c6` (tamaño de empresa).
2. **Persecución del monto.** Un desglose guardado como *11 columnas de cantidades* (17, 1, 1, 2…) no lo encuentra el barrido anterior, porque las cantidades no parecen nada. Así que se persiguió el **total del corte**: `$59,995.54` aparece en **una sola columna de toda la base**, `kdpv_folio_caja.c25`. Si existiera una tabla de detalle, su fila padre cargaría ese total. No existe.
3. **Conteo de columnas.** `kdpv_folio_caja` tiene exactamente 50 columnas (`c1`–`c49` + `sucursal`), todas identificadas. No hay lugar físico donde meter 11 conteos.

**Wincaja — sí tiene denominaciones, pero NO del corte.** Leído en vivo del `.mdb` de Morelia Abastos: la tabla `Arqueos` (`Consecutivo, Folio, Caja, Denominacion, Cantidad`) parece el arqueo soñado, pero **su `Folio` no existe en `Cortes`** — ata a **`Retiros`**. Verificado con el folio 88036 caja 32:

    500 × 15 + 200 × 4 + 100 × 22 + 50 × 12 + 20 × 10 = 11,300
    Retiros.Folio 88036 → Monto 11,300 · Observacion 'BILLETE'

O sea: Wincaja desglosa **cada sangría**, no el corte. (Lo confirma la vista `v_cash_denomination`, que trae `dotacion_inicial` y `por_diferencia_corte` — columnas de `Retiros`.) Y de todos modos no cubriría estas tiendas: Padre Hidalgo dejó de escribir en Wincaja el **26/06/2026** y su tabla `Arqueos` está **vacía**; La Piedad Abastos tiene el `.mdb` congelado en enero de 2024.

**Consecuencia.** Para una tienda en Kepler, la tabla `$500 × 4 = $2,000` solo puede salir de que **alguien abra el cajón y cuente** — que es exactamente `reconciliation.blind_counts`. No es una integración pendiente: es el trabajo que el arqueo ciego existe para capturar. Un turno marcado "solo Kepler" es un turno que nadie contó, y ninguna fuente lo va a llenar por detrás.

## SM.12–SM.19 — El arqueo como acto, no como formulario (✅ local 2026-08-27 → 2026-09-02)

Ocho ajustes que comparten una sola idea: **el turno lo declara Kepler y el efectivo lo cuenta una persona**. Todo lo que la app puede dejar que alguien escriba a mano es una superficie para que el número salga distinto del hecho.

- **SM.12 — nada de lo que identifica el turno se teclea.** Sucursal, caja, fecha y cajero llegan del corte de Kepler y son de solo lectura. `anclarAlTurno()` exige `cash_cut_folio`: caja y fecha se toman del turno, no del body. La captura **se habilita únicamente cuando Kepler ya pidió el corte** — el ERP dice cuándo toca, la app no inventa el momento.
- **SM.12.1 — el cuadre se ve completo.** En pantalla conviven el total de Kepler y el nuestro, que es el que vale, con la diferencia entre ambos.
- **SM.13 — cajas abiertas en vivo (solo encargadas).** Qué cajas están cobrando ahora y cuánto llevan vendido, leído del ODS (`kdm1`). La ventana es de 2 días, no "hoy": con `= hoy` la pantalla mostraba 0 mientras había 14 sesiones abiertas arrastradas del día anterior. Cruce `caja` con `c5::bigint::text` — el `numeric` contra `text` fallaba en silencio.
- **SM.14 — historial por cajera y por quien validó.**
- **SM.15 — todo en vivo, sin elegir fechas del pasado.** La pantalla va a la par de Kepler: cuando el ERP pide el corte, la app lo pide.
- **SM.16 — no se puede saltar la fila.** `exigirElMasViejo()` rechaza capturar un cierre si hay uno anterior pendiente. El supervisor está exento (relevos, correcciones).
- **SM.17 — aviso antes del corte.** La hora de corte tiene patrón: dos picos (mediodía y cierre), distintos por sucursal, con IQR de ±7–13 min en el de cierre. Se calcula la mediana por caja y modo, y la pantalla avisa que se acerca. Cuando la dispersión es grande el pronóstico no se muestra: un aviso que falla seguido deja de leerse.
- **SM.18 — el desglose de Kepler.** `c43` billetes / `c44` monedas, ahora sí bien decodificados (ver rectificación arriba), comparados contra nuestro conteo pieza por pieza. Se agregó un chequeo `kepler_desglose_cuadra` = `|billetes + monedas + retirado − contado| < 1`.
- **SM.19 — tarjetas por persona + ticket de 80 mm.** El historial dejó de ser una tabla de eventos: una tarjeta por cajera (iniciales, cortes, días, faltantes/sobrantes) con sus turnos desplegables — fecha, caja, horario, duración — y el desglose por denominación adentro. Cada corte se imprime en **formato ticket térmico** (`ticket-arqueo.ts`): 80 mm de papel pero maquetado a **72 mm**, que es el área imprimible real, en monoespaciada de 32 columnas y con dos firmas (cajera / encargada). La cajera ve solo sus propias tarjetas y sin nada del cuadre — un "faltante acumulado" sobre un único arqueo **es** la diferencia de ese arqueo, así que a ella también se le quitan los agregados.


## SM.20 — El corte de Kepler llega solo (✅ local 2026-09-02)

Edgar lo dijo en una línea: *"no debe existir ninguno sin arquear, Kepler lo genera, solo jálalo."* Al ir a verificarlo aparecieron **dos** cosas distintas debajo de esa frase, y conviene no confundirlas porque una era un bug y la otra es la tesis de toda la fase.

### 1. El bug: había cortes que Kepler generó y nosotros no jalamos

`analytics.cash_cuts` se llenaba **corriendo un CLI a mano**. Medido el 2026-09-02 sobre los últimos 30 días: el ODS tenía 515 cortes cerrados con dinero y nuestra tabla 499. Los **20 que faltaban** eran todos de la sucursal 02, con montos de $23,513 / $46,676 / $34,395 — más de $300k de efectivo declarado que la pantalla no mostraba. Y no los mostraba como *pendientes*: no los mostraba en absoluto, que es peor, porque un turno ausente no se persigue.

Un dato que llega cuando alguien se acuerda de correr un script no es un dato. Como el origen (`kepler_ods.kdpv_folio_caja`) vive en **la misma base** que el destino, jalar el corte es un UPSERT de una sentencia: no viajan filas por la red, no depende de la máquina de feeds y cuesta milisegundos. Así que ahora se jala solo, por dos caminos que se cubren entre sí:

- **`CashCutsSyncService`** con `@Cron` cada 10 min (la frescura pasa a ser la del CDC, minutos).
- **Sync perezoso al abrir la pantalla**: `GET /store/arqueo/por-cajera` sincroniza antes de leer. Es best-effort a propósito — si el ODS está caído la pantalla muestra lo que ya había, en vez de romperse.

El scope lo decide `commercial.warehouses` con un `JOIN` interno: un corte del ODS es del tenant dueño de esa sucursal, no de quien corra el job. El CLI se queda para backfills largos y para sucursales que el ODS no cubra.

**Lo que el filtro deja fuera, y solo eso:** la caja **abierta** (Kepler la marca `c10 = 1800-01-01` — es una caja en operación, no un arqueo) y el turno que abrió y cerró en cero sin un peso (32 en 30 días, todos de segundos: aperturas fallidas). El corte descuadrado entra siempre; es justamente el que interesa.

Smoke nuevo `test-newdb-cash-cuts-sync.js` **3/3**, y la aserción que importa es una sola: **cero cortes de Kepler sin espejo nuestro**. Se verificó que falla cuando debe — borrando una fila a mano el test la reporta con nombre y monto ($18,430.50) en vez de callarse.

### 2. La tesis: "sin arquear" era una etiqueta que mentía

La otra mitad no era un bug sino una palabra mal elegida. La pantalla marcaba `SIN ARQUEAR` y decía *"nadie contó el efectivo"* en turnos donde Kepler **sí** traía su cifra (contado, billetes, monedas, retirado) — la fila ni siquiera estaba vacía, mostraba esos números justo debajo del cartel.

Kepler genera **su** arqueo. Lo que falta en esos turnos es **nuestro conteo físico**. Son cosas distintas y llamarlas igual borra el hallazgo que sostiene la fase: el **74.6%** de los cortes de Kepler cierra al centavo exacto contra el esperado, algo imposible en un conteo físico real. `c25` es un número **declarado**, no verificado.

Entonces no se renombró a "arqueado" —eso habría dado por bueno un conteo que nadie hizo— sino a lo que es:

- chip **`solo Kepler`** en vez de `SIN ARQUEAR`, con tooltip *"Kepler declaró este corte; nadie contó el efectivo a ciegas"*;
- la fila **siempre muestra un monto** (el de Kepler cuando el nuestro no existe), así ningún turno se ve vacío;
- el detalle dice *"cifra **declarada** al cerrar el corte, sin conteo físico a ciegas"*;
- KPI y filtro pasan a **"sin conteo físico"**;
- el ticket de 80 mm imprime el bloque **`ARQUEO DECLARADO EN KEPLER`** con su advertencia, en vez del desglose por denominación que no existe — para que el papel no pueda usarse como comprobante de un conteo que nadie hizo.

**A la cajera se le sigue ocultando el monto** (SM.10): ve que su corte quedó sin contar, no cuánto declaró Kepler. Publicarle ese número sería darle el esperado por la puerta de atrás.

**Pendiente prod:** redeploy api+view. No requiere migración ni re-login.

## SM.21–SM.23 — Que el arqueo OCURRA, y que cubra el dinero completo (✅ local 2026-09-03)

### SM.21 — El corte sin contar deja de ser invisible

76 de 78 cortes sin conteo físico no es un dato que falte jalar: es trabajo que no se hizo. `CashCountSlaService` manda los vencidos a `reconciliation.discrepancies` con la regla `arqueo_no_realizado` — a la bandeja que el encargado ya abre, no a una cola nueva que nadie mira. **45 min** = aviso; **12 h** = crítico y `arqueo_no_verificable`, porque pasado eso el efectivo ya se depositó y el corte queda sin verificar de forma permanente: el hallazgo no se apaga, sube. `GET /cumplimiento` puso el número a la vista: **1% de los cortes con conteo físico, $5.8M sin verificar**.

### SM.22 — El ticket, el idioma y el orden

- El ticket pasó de resumen a **arqueo completo**: turno, duración, aviso de cambio de cajera, billetes/monedas por separado, tarjeta/transferencia/venta, observaciones con motivo y nota, firmas con fecha y hora, folio del arqueo. Se imprime **en la captura**, no en el historial: antes había que salir a buscar el corte, o sea firmar el respaldo media hora después del conteo.
- **La app le hablaba a las cajeras en voseo argentino** ("tenés", "avisale", "contá"). Son de Michoacán y Guanajuato; en la pantalla donde se sella efectivo, la confianza en la herramienta es parte del control. Barrido completo del módulo Tienda y de los mensajes de error del backend.
- El **orden de los turnos** lo decidía la posición en el arreglo (`i > 0`), no la fecha: salía accionable el corte del 02/09 con el del 01/09 bloqueado detrás. Y **SM.16 impedía CORREGIR** un conteo ya hecho, dejando congelada una cifra que la cajera sabe equivocada.

### SM.23 — El aviso, el retiro, y el faltante inventado

**El programa no avisaba.** El turno esperaba en la pantalla y si la cajera no la abría no se enteraba. La única alerta que salía sola era al supervisor, a los 45 minutos. Ahora el aviso le llega esté donde esté (barra fija en la raíz + notificación del navegador con la pestaña oculta), por un **room personal** del gateway `/store` — un aviso que no es tuyo se ignora, y a los dos días se ignoran todos.

**El disparador de los $15,000 (decode nuevo).** Edgar lo describió y el ERP lo confirmó: `kdpv_folio_caja.c46` es el **límite de efectivo en caja** (en suc 01 vale exactamente $15,000, el valor más común: 206 de ~318 cortes) y `c47` el tope duro. Cuando la caja junta el límite, Kepler pide sacar el dinero y **sube `c48` en el turno ABIERTO** — verificado en vivo: suc 01 caja 1 con `c48 = 15,000.00` contra `c46 = 15,000.00`, sin cerrar.

**Corrige un modelo equivocado:** SM.17 predecía el corte por HORA con la mediana histórica de cada caja. El disparador **no es el reloj, es el monto** — por eso algunas cajas daban dispersiones de ±210 min.

**Dónde está el dinero, medido sobre 919 cortes:** el cajón se queda bajo el límite en el **89%** de los casos (promedio $8,977) mientras el contado promedia **$27,564** y lo retirado $18,148. O sea que **el 63–81% del efectivo sale en sangrías** y contar solo al cierre verifica un tercio.

`blind_counts.tipo` acepta `retiro` (mig `20260903170000`; el rollback falla a propósito si ya hay retiros capturados). La detección es **stateless**: compara `c48` contra la suma de lo contado, sin guardar "último visto".

### El faltante inventado (bug latente que encontró este trabajo)

`diff_real = esperado − total_contado` **estaba mal** y nadie lo había visto: el `esperado` de Kepler es de TODO el turno e incluye el efectivo que ya salió en sangrías, mientras que el conteo del cierre es solo del cajón. Con los promedios reales —esperado $27,564 contra un cajón de $8,977— **acusaba a una cajera honesta de $18,587 de faltante**. Pasó desapercibido porque los dos únicos arqueos capturados eran de datos sembrados con retiro cero.

La identidad correcta cierra el turno entero:

    Σ retiros contados + cajón contado = esperado

Y lo que no se contó **se declara aparte**, no se mezcla con el faltante: `retiros_sin_verificar` + `cobertura`. Un faltante real y "no lo contamos" son cosas distintas y no pueden sumar al mismo número. Verificado con el escenario real (esperado $20,000, $15,000 en sangrías, $5,000 en el cajón): `diff_real` pasa de **$15,000 inventados** a **$0**, con cobertura 25% sin contar los retiros y 100% contándolos.

### El turno abierto que cruzó la medianoche

La ventana de "solo hoy" (SM.21) se llevó por delante el turno **abierto** de ayer: la cajera lo sigue trabajando y no le aparecía nada. Es la "caja arrastrada" que el tablero ya vigila aparte — y en staging era la caja 1 de suc 01, con $15,000 retirados sin contar y sin nadie a quien pedírselo. Ahora el turno abierto entra siempre; la ventana solo acota los cerrados.

### ⛔ Pendiente que NO es código: 16 códigos de Kepler sin usuario

**114 cortes por $3,035,115** cuyos turnos no le aparecen a nadie en la pantalla de captura, porque el código de cajera del ERP no existe como usuario. `turnosPendientes` filtra por `upper(c8) = username`, así que sin usuario no hay a quién mostrárselo ni a quién avisarle.

| Código | Sucursal | Cortes | Efectivo |
|---|---|---|---|
| `50C01` · `50C02` · `5050` · `5001` · `5002` · `5003` · `50C06` | Canindo | 43 | $1,580,880 |
| `10AUX` · `21VUO` · `22EFM` · `23JHO` · `26VHGH` · `27MMP` · `28MEVL` | Padre Hidalgo | 57 | $1,087,295 |
| `42MIDR` · `42BODGA` | La Piedad Abastos | 14 | $366,940 |

Los `2xXXX` de Padre Hidalgo son las **rutas** (21, 22, 23, 26, 27, 28) y los `50xx` son **Canindo**. Se resuelve dando de alta usuarios con el código exacto de Kepler como username — no necesita código.

## SM.25 — La fila del historial se abre a su respaldo (✅ local 2026-09-04)

"Arqueos recientes" mostraba un total y nada más: `$1,888.00` y a confiar. Para
validar hace falta ver **cómo se llegó a ese número** y **qué más hizo esa
persona** — y las dos cosas vivían en otra pantalla, así que la encargada firmaba
sin abrirla.

Cada fila **se despliega** (`p-table` + `pRowToggler`, `dataKey="id"`) a dos bloques:

1. **Nuestro conteo contra lo que Kepler declara.** El desglose pieza por pieza
   (`$1000 × 1 = $1,000.00` … total, más el corte billetes/monedas) al lado de los
   tres renglones del ERP — billetes, monedas, retirado — y su contado declarado.
   El conteo por denominación **es la única evidencia** de cómo se armó el total:
   Kepler no lo tiene (verificado sobre las 307 tablas del catálogo), existe solo
   porque la cajera lo capturó. Se marcan las dos incoherencias que ya calculaba el
   backend y nadie veía: `billetes + monedas + retirado ≠ contado` (suele ser un
   retiro que nadie registró) y el corte que **Kepler dio por cuadrado** mientras
   nuestro conteo dice otra cosa.
2. **Sus cortes y arqueos, últimos 30 días.** Sale de `GET /por-cajera` con filtro
   de cajero, así que arranca de los **cortes de Kepler** — no de nuestros arqueos —
   y por eso incluye los turnos que **nadie contó**, que son los que hay que
   perseguir. Cada renglón: fecha, caja, folio, horario del turno, si tiene arqueo
   (y a qué hora se capturó) o `sin arqueo`, el contado y la diferencia. Cierra con
   la cobertura real (`N de M cortes con arqueo (X%) · K sin contar`). El corte de la
   fila abierta va **marcado**: en una lista de 30 no se sabría cuál se está mirando.

**Sigue siendo ciego.** El bloque de Kepler y la columna Diferencia se renderizan
solo con `revela` (`RECONCILIATION_VER`): los billetes y monedas del ERP **suman el
contado declarado**, así que mostrarlos a la cajera es mostrarle el esperado en
partes. El endpoint `/por-cajera` ya proyecta ciego del lado del backend — la UI
espeja esa regla, no la sostiene sola.

**Se carga al desplegar, no antes** (§17 INP): son 30 días de cortes por persona y
la pantalla arranca con una cajera contando billetes de pie, no auditando. El estado
se cachea por **persona×sucursal**, así que abrir y cerrar tres arqueos de la misma
cajera es **una sola llamada**; el error trae su botón de reintento.

Sin código de cajero la fila lo dice y no llama a nada. Un `relevo` o un `retiro`
no compara contra el corte (es intra-turno, el corte todavía no existe) y el bloque
lo explica en vez de pintar guiones.

**Sin backend nuevo:** `GET /store/arqueo` ya devolvía `denominaciones[]`,
`nuestro_billetes/monedas`, `kepler_billetes/monedas/retirado` y
`kepler_desglose_cuadra/faltante`. Estaba todo en la respuesta y la tabla lo tiraba.

**Pendiente prod:** redeploy view. No requiere migración ni re-login.

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
