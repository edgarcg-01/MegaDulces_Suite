# Fase PU — Presupuestos (motor de planeación y control)

> **Tesis (ADR-066, propuesto):** el presupuesto es **dato propio** (la meta autorizada); el «real»
> con que se compara es **dato derivado del ODS**. El motor **decide** el saldo (los 5 estados de la
> spec §8), el humano **autoriza**, el LLM queda **fuera** del camino del dinero. Reusa lo que la
> Fase TP ya construyó (capacidad diaria + Calendario de Pagos como consumidor) y **absorbe** el
> `budget.expense_obligations` de 2 buckets en un ledger de 5 estados. **Cero importers para el lado
> real: todo por VISTA sobre `kepler_ods` / `analytics.*` / `finance.*`.**
>
> Spec de negocio de origen: `Modulo_Presupuestos_ERP_Mega_Dulces.md` v1.1 (Dirección + revisión
> técnica de Sistemas 2026-09-17). Este plan es la mitad de ingeniería; la spec es la de negocio.

Estado: **🔨 DISEÑADO (planeación) 2026-09-17.** Sin código. Código de fase `PU` provisional
(pendiente de confirmar y de alta en el roadmap de `CLAUDE.md` + `01_TRACKER_PROGRESO.md`).

---

## Lo medido antes de diseñar (verificado en código, no supuesto)

Lo que la spec v1.0 declaró «no verificado» (§2), aquí ya se inspeccionó:

- **El módulo Presupuestos EXISTE y funciona — como alimentador, no como sistema de presupuestos.**
  Construido en **Fase TP (Calendario de Pagos, ADR-064)**:
  - Schema [`budget`](../../../database/migrations-newdb/20260914130000_budget_and_obligation_origins.js):
    `daily_capacity` (+ `daily_capacity_history`), `expense_obligations`.
  - Pantalla [`/finanzas/presupuesto`](../../../apps/view/src/app/modules/finanzas/pages/finanzas-presupuesto.component.ts):
    captura un tope de pago por fecha (con historial) + una tabla de gastos autorizados. Nada más.
  - Permisos `PRESUPUESTOS_VER/GESTIONAR` (otorgados al rol legado `coordinador_presupuestos`,
    mig `20260914150000`). Cubre **≈5 %** de la spec.
- **El modelo actual es de 2 buckets y contradice §8.1.** `budget.expense_obligations` tiene
  `reserved_amount` + `paid_amount` y el consumidor calcula
  `available = original − reserved − paid` ([`budget-expense-obligations.service.ts`](../../../libs/finance/src/lib/payment-calendar/budget-expense-obligations.service.ts):33).
  **Resta el pagado del disponible** — justo lo que §8.1 prohíbe. No hay «vigente», ni «compromiso»,
  ni «ejercido» distinto del pagado. Los 5 estados son **net-new**, no una extensión de columnas.
- **El Calendario de Pagos (TP) ya escribe `reserved_amount`/`paid_amount`** de esas obligaciones vía
  su motor de asignación (`payment_calendar_lots` / `allocations` / `allocation_items`). Cualquier
  corte del modelo debe **preservar esos saldos** — no es una tabla libre.
- **No existe presupuesto de ingresos/ventas, ni partidas con dimensiones, ni versiones/escenarios, ni
  workflow de aprobación borrador→…→cerrado, ni comparación contra real.** Todo eso es net-new.
- **El «real» ya vive en el ODS** (candidatas a verificar en Capa 2): ventas =
  `analytics.mv_kepler_sales_daily` / `analytics.sales_daily`; costo/margen = `sales_daily.cost`
  (con las salvedades de ADR-051/059 — el costo mezcla fuentes); gasto ejercido = cadena GX /
  `analytics.expense_doc_chain` / `finance.*`; bancos = `finance.bank_movements` (Fase CB); cartera =
  vista sobre `kepler_ods.kdue` (Fase CXC); pagos a proveedor = `analytics.erp_supplier_payments`
  (Fase CC). **Ninguna se copia: se lee por vista.**

---

## Reconciliación con la Fase TP (decisión de Capa 0)

No pueden coexistir dos verdades del «gasto autorizado». Dos caminos:

| Opción | Qué implica | Riesgo |
|---|---|---|
| **A — Absorber (recomendada)** | El nuevo ledger de 5 estados **es** `budget.expense_obligations` extendido: se le agregan las columnas/movimientos de vigente/compromiso/ejercido; `reserved_amount`/`paid_amount` quedan como proyección mantenida por el motor (para que TP siga leyendo su `available_amount` sin cambiar). | Migración cuidadosa; mapear el consumo del calendario a «reserva»/«compromiso». |
| **B — Reemplazar** | Tabla nueva; TP re-apunta su `UNION`/consumidor al nuevo modelo. | Toca el motor de asignación de TP (ya en prod-code); mayor superficie. |

**Recomendación: A.** El Calendario de Pagos es el consumidor natural del presupuesto de egresos; conviene
que la obligación viva en un solo lugar y que TP siga viéndola. Se decide y se fija en ADR-066.

---

## Capa 0 — Diagnóstico componente-por-componente (PU.0.4)

Estado de cada pieza de la spec. **Regla:** el *plan* (presupuesto/meta) es siempre **faltante** hoy
(no existe presupuesto de nada salvo el alimentador de egresos); lo que ya existe es el lado **real**
(por fase previa) y algunos **orígenes de obligación** (Fase TP). "Reparable" = existe pero no en la
forma que la spec pide.

### Alcance funcional (spec §3)

| Componente | Plan (presupuesto) | Real / insumo | Veredicto |
|---|---|---|---|
| Ventas e ingresos | faltante | `analytics.mv_kepler_sales_daily` (ODS) | **faltante** (plan); real existe |
| Costo de ventas | faltante | `analytics.sales_daily.cost` (salvedad ADR-059) | **faltante** (plan); real existe con reservas |
| Gastos operativos | `budget.expense_obligations` de 2 buckets (Fase TP) | cadena GX / `expense_doc_chain` | **reparable** → absorber a 5 estados (Capa 1) |
| Marketing | faltante | sin módulo (Fase G solo diseñada) | **faltante** |
| Compras e inventario | faltante | `commercial.purchase_orders`/`goods_receipts` (RA) | **faltante** (plan); real existe |
| Flujo de efectivo | `budget.daily_capacity` (tope/día, Fase TP) | Calendario TP + bancos CB + cartera CXC | **reparable** → falta la proyección, no la capacidad |
| Inversiones | faltante | — | **faltante** |
| Seguimiento (orig/vigente/real/proyección) | faltante | — | **faltante** (depende del ledger de Capa 1) |

### Conexiones con la suite (spec §6)

| Área | Fuente real (fase) | Estado de la fuente | Integración a Presupuestos |
|---|---|---|---|
| Ventas / PdV | `mv_kepler_sales_daily` (RS/ODS) | existe | faltante |
| Gastos | `expense_obligations` (TP) + GX comprobaciones | existe | parcial |
| Marketing | — | no existe | faltante (Capa 4 arranca con catálogo propio) |
| Contabilidad | ContPAQi `contpaqi_ledger_monthly` / `expense_doc_chain` (CP/LC) | existe | faltante |
| Ingresos contables | `analytics.contpaqi_ledger_monthly` (CP) | existe | faltante |
| Bancos y caja | `finance.bank_movements` + Caja (CB) | existe | faltante |
| Cobranza y cartera | vista sobre `kepler_ods.kdue` (CXC) | existe | faltante |
| Pagos a proveedor | `analytics.erp_supplier_payments` (CC) + `commercial.supplier_payment_obligations` (TP) | existe | parcial |
| Calendarios de pago | `finance.payment_calendar_lots` (TP) | existe | **sí** (consumidor del presupuesto) |
| Compras / Reabasto | `commercial-replenishment` (RA) | existe | faltante |
| Almacén / Inventarios | `commercial.stock` / `kepler_ods.kdik` | existe | faltante |
| Cancelados | flujo de cancelados de Finanzas | existe (verificar alcance) | faltante |
| Hallazgos / conciliación | `finance.findings` (Maat) + tareas MA | existe | faltante (reusar bandeja, no crear cola) |
| Tu trabajo | "Mi trabajo" / `/projects` (SN/OR) | existe | faltante |

**Lectura:** casi todo el lado **real** ya está construido por fases previas y se consume por vista;
lo que falta es el **plan** (el ledger presupuestario) y **cablear** cada fuente real como comparación.
Ninguna integración justifica un importer — todas son vistas o lecturas sobre tablas que ya existen.

## Principio rector técnico

1. **Plan = tabla propia; Real = vista derivada del ODS.** El presupuesto/meta es dato HITL legítimo
   (como OCR/feedback). El real **jamás** se materializa ni se importa: vista fresca sobre el ODS.
   (Regla de más peso del proyecto — `feedback_everything_derivable_from_ods`.)
2. **El motor decide el saldo; el humano autoriza; el LLM fuera del dinero** (ADR-016).
3. **Validación y registro atómicos** (una sola trx, `FOR UPDATE`) — sin sobregiro por concurrencia.
4. **Idempotencia por (evento, documento/línea)** — reintentar no vuelve a consumir saldo (como TP).
5. **«Sin datos» ≠ cero** (ADR-056): frescura y cobertura declaradas; fallas de integración visibles.
6. **Un movimiento no se borra: se revierte** con rastro (ADR-064 / §13 de la spec).
7. Todo `tenant_id NOT NULL` + RLS forzado + `TenantKnexService.run()` para queries con RLS.

---

## El plan por capas

Cada capa es **entregable y conciliable** por sí sola; ninguna espera a la siguiente para dar valor.

### Capa 0 — Reconciliación, diagnóstico y decisiones (sin features)

Es la Etapa 0 de la spec, hecha en serio.

- Inventario **componente-por-componente** de §3 y §6 marcando *existe / reparable / faltante*.
- Decidir el fork TP (Opción A vs B) y escribir **ADR-066** (plan vs real, ODS, reconciliación TP,
  qué evento reserva/compromete/ejerce por tipo de partida).
- **Verificar** (no adivinar) cada fuente «real» de la lista de arriba contra un hecho independiente
  antes de cablearla (regla `feedback_never_guess_investigate_source`).
- Contestar las decisiones **bloqueantes** de §16: **#3** (eventos de consumo por tipo de partida) y
  **#7** (fuente autorizada de ventas/costo/gasto/bancos → vistas ODS). Las demás no bloquean empezar.
- **Entregable:** ADR-066 + tabla de diagnóstico + contrato de datos. **Cero código de producto.**

### Capa 1 — Motor de egresos (MVP, el núcleo)

Reproduce la máquina de estados de la spec §8. Es el valor mínimo operativo.

- **Cabecera** mínima: ejercicio, entidad legal, moneda (MXN fijo por ahora), estado
  `borrador → en revisión → pendiente → aprobado/vigente → cerrado`. **Una** versión, **sin** escenarios.
- **Partida presupuestaria** con dimensiones **desde catálogos existentes** (sucursal, área/centro de
  costo, cuenta contable, responsable) — sin listas paralelas (spec §4).
- **Ledger de 5 estados** (net-new): `original`, `vigente` (= original ± adecuaciones autorizadas),
  y movimientos tipados: ampliación / reducción / transferencia / reserva / compromiso / ejercido /
  pago / cancelación / reversión. `disponible = vigente − reservas activas − compromisos pendientes −
  ejercido`; **pagado por separado, no se resta otra vez.** Cada transición **sustituye** el saldo
  anterior (no suma dos veces).
- **Validación atómica** anti-sobregiro; **control por concepto** (informativo/advertencia/bloqueo)
  con facultad+justificación+evidencia para excepción; **no autoaprobación**; **idempotencia** por
  (evento, documento).
- **Bandeja de autorización** + **adecuaciones** mostrando impacto en ambas partidas y en la proyección.
  No editar una versión aprobada.
- **Reconciliación TP:** el consumo del Calendario de Pagos mapea a reserva→compromiso; migrar
  `budget.expense_obligations` (Opción A).
- **Pantalla:** extiende `/finanzas/presupuesto` (partidas + movimientos + bandeja).
- **Criterios de aceptación (spec §14):** #1 (captura mensual + responsables), #3, #4, #5, #6, #7, #8,
  #11 (parcial), #18. **§8.2 debe reproducirse fila por fila** (criterio #5).

### Capa 2 — Presupuesto vs real (derivado del ODS)

Aquí aterriza el «¿cuánto se autorizó vs cuánto se ejerció?» — el corazón de la rendición de cuentas.

- **Vistas de real** (cero importers): gasto ejercido real (GX/`finance`), ventas netas
  (`mv_kepler_sales_daily`), costo/margen (`sales_daily.cost`, con salvedad ADR-059), por
  periodo/sucursal/área/cuenta. Se **verifican** antes de publicar (regla del proyecto).
- **Presupuesto de ingresos/ventas:** meta (dato propio) vs real (vista). Separar venta registrada /
  pedido abierto / cobro (spec §9).
- **Resumen ejecutivo (spec §5.1):** presupuesto vs real, ocupación, disponible; **drill-down** a la
  partida y al documento fuente; **«sin datos» declarado, no cero**; frescura y cobertura visibles.
- **KPIs (spec §10):** cumplimiento de ventas, desviación (abs y %), ocupación presupuestaria, margen
  bruto. Recalcular % desde importes consolidados (no sumar % de sucursales).
- **Criterios §14:** #9, #13 (conciliar periodo vs Contabilidad — parcial), #14, #15, #16.

### Capa 3 — Flujo de efectivo y abastecimiento

Cierra el «tener presupuesto ≠ tener liquidez» (principio de la spec §1).

- **Flujo previsto** semanal (diario donde hay fecha de cobro/pago): cobros previstos (cartera/cobranza,
  vista CXC) − pagos previstos (**Calendario de Pagos de TP** + calendarios). **Saldo mínimo proyectado**
  + alerta de insuficiencia.
- **Bancos/caja** reales (Fase CB) alimentan el flujo; **no duplican** gasto/ingreso.
- **Compras/Reabasto** (Fase RA) proyecta desembolsos e inventario; compra de mercancía **no** es gasto
  operativo automático (spec §3).
- **Anticipos, devoluciones, cancelados** (spec §8.3): liberar/revertir **solo** el efecto procedente,
  con trazabilidad. **Inversiones** separadas del gasto operativo.
- **Criterios §14:** #10, #11 (completo).

### Capa 4 — Planeación avanzada

Lo que da flexibilidad pero no bloquea operar.

- **Escenarios** (base/conservador/expansión) + **versiones** + comparación + copiar ejercicio anterior
  **sin arrastrar autorizaciones**.
- **Import/export CSV/XLSX** idempotente con **preview de impacto** antes de aplicar; no duplica al
  reintentar (spec §5.2).
- **Marketing:** catálogo de campañas + captura controlada dentro de Presupuestos + evaluación con
  **regla de atribución explícita** (ventas vinculadas no prueban incremental); aportaciones de
  proveedor separadas y condicionadas; no re-registrar descuentos ya deducidos de ventas netas (spec §9).
- **«Tu trabajo», alertas, hallazgos:** usar bandejas existentes (no colas paralelas); deduplicar por
  evento; distinguir exceso presupuestario / falta de liquidez / problema de datos; un hallazgo no se
  cierra por leído (spec §11).
- **Proyección de cierre** separada de la versión autorizada.
- **Criterios §14:** #2, #12, #17, #19.

---

## Fuentes de dato «real» (candidatas — verificar en Capa 0/2, no cablear a ciegas)

| Concepto real | Fuente candidata | Nota |
|---|---|---|
| Ventas netas / unidades | `analytics.mv_kepler_sales_daily` | ODS-derivada; ⚠️ inflado oct-2025 documentado |
| Costo de ventas / margen | `analytics.sales_daily.cost` | ⚠️ mezcla fuentes (ADR-051/059); declarar salvedad |
| Gasto ejercido real | cadena GX / `analytics.expense_doc_chain` / `finance.*` | conciliar contra Contabilidad (spec §14 #13) |
| Saldos y movimientos bancarios | `finance.bank_movements` (Fase CB) | no duplicar gasto/ingreso |
| Cartera / cobranza | vista sobre `kepler_ods.kdue` (Fase CXC) | el saldo lo manda `kdue`, no `c43/c42` |
| Pagos a proveedor | `analytics.erp_supplier_payments` (Fase CC) | multi-método (transferencia/cheque/anticipo) |
| Obligaciones de pago | `budget.expense_obligations` + `commercial.supplier_payment_obligations` + `finance.financial_commitments` (Fase TP) | ya existen |

---

## Decisiones abiertas (de la spec §16)

**Bloqueantes de código (Capa 0):** #3 (evento que reserva/compromete/ejerce por tipo de partida),
#7 (fuente autorizada de cada real — respondida arriba, falta verificar).
**Bloqueantes de activación productiva, no de diseño:** #1, #2 (piloto y facultades/suplencias), #4
(conceptos que bloquean vs advierten), #5 (base de impuestos/moneda por tipo), #6 (transferencias
entre meses / saldo no utilizado), #9, #10 (migración de documentos abiertos e histórico confiable).
**Decidida por la revisión técnica:** multi-moneda diferida (YAGNI beta); fork TP = Opción A (absorber).

---

## Gotchas del proyecto que aplican

- `TenantKnexService.run()` obligatorio para queries con RLS forzado (lección de Fase E).
- Migraciones idempotentes (`hasColumn`/`hasTable`) y **no** borrar migraciones aplicadas.
- Al agregar permisos: enum + `authz-tree` + reparto en migración (no solo declarar el enum —
  lección LC.6.2: un módulo no está entregado hasta que su permiso está **repartido** en prod).
- Un gate sin **prueba negativa** es una intención: romper el bloqueo de sobregiro a propósito una vez.
- Un primitivo genérico (bandeja de hallazgos, frescura, versión de regla) no cierra la fase hasta
  vivir en `libs/` compartido o quedar declarado como deuda con nombre (ADR-056).
- Español México, tuteo; naming DB snake_case English; TZ `America/Mexico_City`.

---

## Criterios de cierre de la fase (spec §303)

El módulo se considera operativo cuando **una transacción completa recorre solicitud → autorización →
compromiso → ejecución → pago → conciliación con saldos correctos y responsables identificables**, y
el ejemplo de aceptación §8.2 se reproduce exacto. Eso lo cubren las Capas 1→3; la Capa 4 es
enriquecimiento.

---

## Fase PV — Presupuesto de Ventas estructurado (hijo de PU · ADR-068)

El workbook manual `indicadores 2018 - VENTAS.csv` como **molde de estructura** (no de datos) para armar
los presupuestos de venta **forward**. Ejes: entidad (sucursal/canal/ruta) × calendario **13×4** × meta,
con crecimiento (CREC=YoY) y participación (PART=mezcla). El "real" se **puentea** al sell-out diario
(`analytics.v_sellout_daily`), nunca se recalcula; cero importers. Detalle de decisiones en **ADR-068**.

Estructura **medida del CSV** (no adivinada): 52 semanas S01-52 → 13 periodos de 4 semanas P1-13 →
**Q1=P1-3 · Q2=P4-6 · Q3=P7-9 · Q4=P10-12 · QF=P13** (verificado: `QF == P13` al peso; Q4 no incluye P13).

- **PV.1 ✅** `analytics.v_retail_calendar` — calendario 13×4 (vista pura sobre `generate_series`, sin
  tenant/RLS). Ancla declarada/confirmable: semana lun-dom, S01=primer lunes on/after 1-ene, fiscal_year=año
  calendario, bordes clampados. Smoke DB-direct 13/13.
- **PV.2 ✅** `analytics.v_sales_entity` — 23 entidades hoja medidas del sell-out (mostrador×6, credito×6,
  preventa×5, ruta×6). `entity_key = channel:warehouse_code`, rutas con route_code+zona. Smoke 7/7.
- **PV.3 ✅ (backend)** `budget.sales_plan_lines` (meta entidad×periodo, RLS forzado) + `BudgetSalesPlanService`
  (generateFromHistory: meta = real año anterior × (1+growth), sin base → no crea fila; upsert manual). Única
  verdad de la meta. Smoke 12/12.
- **PV.4 ✅ (backend)** `BudgetSalesComparisonService` — pivote meta vs real + CREC + PART + cumplimiento;
  real del `v_sellout_daily` rolado por el calendario (mismo dato canónico, bucketeado a periodo). «Sin
  datos»≠cero, frescura declarada. Smoke 8/8.
- **PV.5 🔨** `BudgetSalesController` + vista "Presupuesto de ventas" en `/presupuesto` (answer-first,
  metric-strip/freshness-pill, selector de periodo, pivote con subtotales por canal + Total, diálogos generar/
  capturar). Builds+check:templates verdes. **Verificación HTTP pendiente por infra** (API :3334 stale + creds).

**Pendiente global PV:** verificación HTTP (ADR-044) tras restart de la API; migraciones (`v_retail_calendar`,
`v_sales_entity`, `budget.sales_plan_lines`) a prod; push + redeploy. Declarado no construido: vecinal a grano
sucursal×preventa (no ruta vecinal individual); proyección plan→`commercial.sales_targets` para unificar el
"vs objetivo" del Análisis; confirmar el ancla de semana con negocio.

---

## Fase PVA — Automatización del armado (hijo de PV · ADR-069)

Automatizar el armado "bajo los dos parámetros" (CREC=crecimiento, PART=participación): el **sistema propone**
el presupuesto completo desde la historia y el humano **solo ajusta**. Variables externas "ninguna en teoría"
(override manual = válvula de escape). Decisiones en **ADR-069**. ⚠️ La data viva arranca ~fin 2025 → la calidad
de la propuesta **rampa con la historia**; se declara la cobertura, «sin datos»≠cero.

- **PVA.1 ✅ (backend)** `budget.sales_plan_settings` (mig `20260918140000`): crecimiento por canal + método,
  la única perilla del humano. `proposeGrowth` = YoY del par de años más reciente sobre periodos apareados, con
  **guard de rampa** (≥4 periodos o cae a default — mató un +2951 % por 2025 parcial) + escalera canal→global→
  default + cobertura declarada.
- **PVA.2 ✅ (backend)** `proposePlan` relleno híbrido de las 299 celdas: base real→`base×(1+crec)`; sin base→
  `anual_proyectado × estacionalidad` (índice jerárquico entidad→canal→global, shrinkage, suma 1); sin señal→no
  crea fila y lo declara. Nunca pisa `manual`. Mig `20260918150000` amplía el CHECK `method` con `estacional`.
  Smoke DB-direct **10/10**.
- **PVA.3 ✅ (backend)** `BudgetSalesIndicatorsService`: CREC/PART por compañía/canal/entidad × año (histórico)
  + meta-vs-real — bloques de consolidación del workbook. DB-direct: PART 100 %/año, mix 2026 mostrador 76 %.
- **PVA.4 🔨** UI: sub-tabs Plan | Indicadores; «Proponer plan del año» (crecimiento propuesto por canal editable
  + cobertura); badge de origen por celda; tira de cobertura; tabla de indicadores. Builds+templates verdes.
- **PVA.5 🔨** ADR-069 + docs. **Verificación HTTP (ADR-044) pendiente por infra** (API sin rutas PVA aún + creds).

**Pendiente global PVA:** verificación HTTP; migraciones `sales_plan_settings` + CHECK `estacional` a prod;
push + redeploy. Declarado no construido: variables externas (por decisión del usuario), proyección plan→sales_targets.

---

## Fase PVR — Conciliación sell-out ↔ facturación (documentada · ADR-071)

Se investigó usar el workbook 2018-2026 como base histórica y/o mover el real a facturación. **Medido:** el
workbook no reconcilia (TLMKT infla PH/Canindo 3-22×) y ninguna fuente Kepler llega a 2018 → **workbook
descartado**. La familia-4 contable es 70% **fletes** ($368M en 401-002); el producto real en cta 401 ≈ $150M
y el **sell-out ≈ 72% del bruto facturado** para mostrador/credito/ruta (~118-138%), con **preventa anómala**
(asiento lumpy jul-ago 2026 en 401-003).

**Decisión (ADR-071):** el real del presupuesto **sigue siendo el sell-out**; la conciliación con la cta 401
se deja **documentada, no aplicada**.

- **PVR.1 🔨** `analytics.v_sellout_vs_facturacion` (mig `20260918190000`) — canal×mes: sell-out vs facturación
  (401 producto, sin fletes), Δ, ratio, status. Cero importer. Aplicada+verificada en dev.
- **PVR.2 🔨** `getReconciliation()` + `GET finance/budget/sales-reconciliation` — agrega a grano ANUAL (donde
  reconcilia) + detalle mensual (lumpy, declarado) + notas.
- **PVR.3 🔨** UI pestaña «Conciliación» en `/presupuesto`. Builds+check:templates verdes.

**Pendiente:** verificación HTTP; mig `v_sellout_vs_facturacion` a prod; push + redeploy. Declarado: reconcilia
anual (mensual lumpy); preventa anomalía; fletes fuera; sin ajuste/reescala (el sell-out sigue siendo el real).

## Fase PVT — Proyección del plan → metas de Análisis (unificación · ADR-072)

El sub-módulo Análisis ya renderiza un «vs objetivo» mensual desde `commercial.sales_targets`. El plan de ventas
vive al grano ENTIDAD × PERIODO 13×4. Esta fase **puentea** los dos: proyecta la meta del plan a metas mensuales
en `sales_targets` para que el objetivo de Análisis salga del presupuesto, sin recaptura.

**Decisión (ADR-072):** el plan es la única verdad; los targets mensuales son un **artefacto derivado idempotente**
(upsert-only, sin borrar). Reparto periodo→mes **proporcional a los días** (vía `v_retail_calendar`).

- **PVT.1 ✅** `BudgetSalesPlanService.projectToSalesTargets(budgetId)` — reparte cada `meta_amount` a meses por
  conteo de días; agrega a las 4 escalas del contrato (total `''` / channel canal / branch 01-06 / route NN);
  upsert por natural key `(tenant_id, scope, scope_key, year_month)`. Cero importer, cero tabla nueva.
- **PVT.2 ✅** endpoint `POST finance/budget/budgets/:id/sales-plan/project-targets` (`PRESUPUESTOS_GESTIONAR`) +
  botón «Proyectar a Análisis» en `/presupuesto` (pestaña Plan). Builds api+view + check:templates verdes.
- **PVT.3 ✅** smoke DB-direct `test-newdb-sales-plan-project-targets.js` (10/10): calendario 13×4 cubre el año
  (365 días), reparto por días **sin pérdida** (Σ meses de un periodo == meta), **invariante de conservación**
  (Σ meses del scope total == Σ plan, ±$0.10), escalas branch/route correctas, y el **upsert real** a
  `commercial.sales_targets` corre (cross-schema, ON CONFLICT).

**Pendiente:** verificación HTTP (ADR-044); push + redeploy (sin migración: usa vistas/tabla ya existentes).
**Declarado:** una entidad retirada por completo del plan puede dejar su target obsoleto (upsert-only); Análisis
hoy pinta total+branch (channel/route escritos para UI futura).

## Fase PVG — Presupuesto de GASTOS auto-propuesto desde egresos (ADR-073)

Cierra el pedido del ejercicio del lado de gastos: «casi nada se llena desde acá». El presupuesto de gastos se
**auto-propone** desde los egresos de Kepler (`analytics.expense_entries`), análogo a PVA para ventas. Grano
medido: **cuenta mayor** (siempre poblada; `dpto`/`concepto` ralos → descartados como eje). Familia 6 (gasto
operativo) por default (configurable). Cero importer (deriva del fact), cero tabla de datos nueva.

**Decisión (ADR-073):** la propuesta vive en una **rejilla propia** re-ejecutable, separada del libro mayor de
5 estados (que no se pisa a ciegas). La materialización a partidas `budget_lines` queda declarada, no construida.

- **PVG.1 ✅** `budget.expense_plan_settings` (mig `20260918200000`) — perillas: `proposal_families` (default
  `["6"]`), `default_growth_pct`, `growth_by_account`, `by_sucursal`, `control_level`. RLS forzado, FK a budgets.
- **PVG.2 ✅** `budget.expense_plan_lines` (mig `20260918210000`) — rejilla cuenta × sucursal × mes; `method`
  historico_ajustado|estacional|manual; natural key `(tenant,budget,account_code,sucursal,year_month)`. RLS forzado.
- **PVG.3 ✅** `BudgetExpensePlanService`: `proposeExpenseGrowth` (YoY por cuenta sobre meses apareados, guard
  `MIN_PAIRED_MONTHS=4`, escalera cuenta→global→default; base neta cargo−abono), `proposeExpensePlan` (relleno
  híbrido: base×crec `historico_ajustado`; cuenta recurrente ≥6 meses `estacional`; esporádica → sólo sus meses),
  `getSettings/upsertSettings`, `upsertLine/deleteLine`. + `BudgetExpenseController` (endpoints `expense-plan`,
  `expense-plan/settings`, `expense-plan/propose-growth`, `expense-plan/propose`, `expense-plan/line`;
  PRESUPUESTOS_VER/GESTIONAR). Registrado en `finance-budget.module`. `nx build api` verde.
- **PVG.4 ✅** UI en `/presupuesto` vista «Gasto operativo»: sección «Presupuesto propuesto» (tabla cuenta mayor ×
  Σ anual + origen + total) + botón «Proponer gastos del año» + diálogo (crecimiento sugerido, familias,
  por-sucursal, overwrite) + tira de cobertura. `nx build view`+`check:templates` verdes.
- **PVG.5 🧪** smoke DB-direct `test-newdb-expense-plan.js` **10/10** (egresos sintéticos en rollback): neto
  cargo−abono, YoY +9.17% sobre 12 meses apareados, guard de esporádico → default, cobertura
  27 histórico / 0 estacional / 9 sin señal, esporádico deja 9 meses SIN fila, manual respetado.

**Pendiente:** verificación HTTP (ADR-044); migs `20260918200000`/`210000` a prod; push + redeploy.
**Declarado, no construido:** materialización rejilla→`budget_lines` (puente al ledger de 5 estados y al
presupuesto-vs-real §16.3); overrides de crecimiento por cuenta en UI (hoy vía settings); familias 5/7/1 off
por default (5=compras es dominio de RA, 1=capex, 7=financieros).

## Fase PR — Reestructura a interfaz AUTOMÁTICA (ADR-074)

Reformulación completa de las interfaces bajo el objetivo «casi 100% automatizado»: la página arranca en el
resultado automático; lo manual queda para los supuestos anuales (un panel) y la autorización. La captura
manual se **retira** (segura porque en la misma fase se construye la materialización plan→ledger).

- **PR.1 🧪** Materialización plan→ledger. `BudgetMaterializeService.materialize` (sales_plan_lines→ingreso,
  expense_plan_lines→gasto; `source='plan'`/`source_ref` idempotente; partida con consumo se ajusta por
  movimiento ampliar/reducir con clamp, nunca UPDATE ciego). Auto al aprobar + `POST budgets/:id/materialize`.
  Mig `20260918220000` (source/source_ref + índice único parcial). Smoke `test-newdb-budget-materialize` **14/14**.
- **PR.2 🧪** Capacidad auto-propuesta desde el flujo (cobranza CXC esperada ÷ días hábiles); `GET capacity/propose`
  + `POST capacity/confirm`. «Sin CXC» se declara. Sin migración.
- **PR.3 🧪** Obligaciones recurrentes auto-generadas del plan (estado `propuesta`, `authorized_by` NULL) +
  autorización en lote (`POST expenses/from-plan`, `POST expenses/authorize`). Mig `20260918230000` (status
  `propuesta` + authorized_by nullable + source/source_ref). El flujo y el Calendario **excluyen** `propuesta`.
- **PR.4 🧪** Resumen «Resultado» = plan ventas − plan gastos, mes y anual (`GET budgets/:id/resultado`, derivado).
- **PR.5 🧪** UI reestructurada: nav en grupos «armar» (Ejercicio·Ventas·Gastos·Flujo/Resultado·Campañas) +
  «programación de pagos» (Capacidad·Obligaciones); panel «Supuestos del año»; proponer de un clic; partidas
  read-only materializadas; Resultado en Flujo; capacidad propose/confirm; obligaciones generar/autorizar;
  **captura manual retirada** (6 diálogos + botones eliminados); proyección a Análisis automática al aprobar.
- **PR.2/3/4 smoke** `test-newdb-budget-automations` **14/14** (capacidad conservación · obligaciones
  propuesta→autorizar→exclusión · resultado ingresos−egresos). Builds api+view+check:templates verdes.

**Pendiente:** verificación HTTP (ADR-044); migs `20260918220000`/`230000` a prod; push + redeploy.
**Declarado (trade-off):** retirar el «Meta» por celda quita la válvula de escape de ADR-069 (corregir una celda
obliga a re-proponer). Reversible si estorba.

---

## Fase PVI — Integridad del supuesto de VENTAS (auditoría PU.VI · 2026-10-08)

⚠️ **ADR pendiente de número** — asignar contra `02_DECISIONES_ARQUITECTURA.md` antes de citarlo.
No se reserva uno acá a propósito: ADR-052 ya estuvo **triple-ocupado** y ADR-048 colisionó con CxC.

Auditoría de ingresos pedida por Edgar (*«necesitamos una verdad absoluta antes de iniciar… antes de
crear todas nuestras herramientas»*), corrida **read-only contra prod** el 2026-10-08 dentro del pod
`api-75c847b79b-cvqpl`. Hermana del carril de GASTOS (ledger/egresos) y del de TESORERÍA, que
midieron en paralelo. **Verdades completas en [`VERDAD_ABSOLUTA.md` §24](../../VERDAD_ABSOLUTA.md).**

**El veredicto, en una línea:** el plan proyecta **+26.67 %** sobre un negocio comparable que se
**contrae 2.95 %**; el crecimiento que el motor cree ver es **cobertura del propio pipeline**
entrando al fact. **$0 de los $604,775,116 de meta** descansan sobre un crecimiento defendible.

| canal | % meta | presupuestado | real comparable | veredicto |
|---|---:|---:|---:|---|
| mostrador | 58.46 % | +21.05 % | **−2.82 %** | ⛔ signo invertido |
| mayoreo | 28.10 % | +26.67 % | **−9.36 %** | ⛔ signo invertido |
| preventa | 4.60 % | +51.21 % | +18.62 % | ⛔ desviado 32.6 pp |
| ruta | 8.84 % | +8.26 % | **+13.98 %** | ⚠️ **subestimado** |

⭐ **Dos ejercicios con defectos OPUESTOS, y ninguno sirve de base:** el FY2026 cubre los 13 periodos
con forma de año correcta pero **24.5 % de su meta es `proxy_canal` fabricado**; el FY2027 tiene
importes honestos pero **le faltan P11/P12/P13** (27.37 % del año en FY2025).

### El plan

- **PVI.0 ⬜ Recomputar los supuestos (sin código, ruta crítica).** Los `sales_plan_settings` del
  ejercicio vivo son de las **00:16 Z**; el fix del canal canónico (§23, mig `20261007202137`)
  entró a prod a las **14:15 Z** y los supuestos **nunca se recomputaron**. Volver a correr
  `proposeGrowth` + `proposePlan`. **Prueba negativa obligatoria:** si `mayoreo` vuelve a dar
  **exactamente** el `default_growth_pct`, su YoY sigue sin poder calcularse y hay una segunda
  causa — no se da por arreglado.
- **PVI.1 ⬜ Pareo por ENTIDAD con cobertura de periodos** ⭐ *lo que cierra el defecto de fondo*.
  Hoy `yoy` exige `e.a > 0 && e.b > 0` sobre el **agregado del canal**
  (`budget-sales-plan.service.ts:283`), así que una plaza que nace en el año nuevo infla sin
  contraparte y una base de $230,601 contra $39 M **parea**. Cambiar a: entidad comparable = venta
  en **≥ N de los periodos cerrados en AMBOS años**; las no comparables se **declaran**, no se
  promedian ni se descartan en silencio. **Prueba negativa:** `mostrador:03` tiene que quedar
  **EXCLUIDO**; si entra, el gate es un no-op y se lee igual que «no hay contaminación».
- **PVI.2 ⬜ `proxy_canal` no puede publicar sin declarar que no tiene base.** Hoy escribe
  `base_amount` **NULL** y reparte **el mismo importe a cada entidad del canal** sin mirar su
  tamaño: **$197,160,564** sobre 8 entidades cuya historia real suma **$19,063,383** (10.3×;
  `mayoreo:05` recibe 2,860× lo suyo). Dos caminos: (a) escribir el proxy en `base_amount` con su
  origen explícito, o (b) bloquear el método y caer a `sin_base_declarado`. **Lo que no puede
  seguir** es que una meta inventada se vea igual que una medida.
- **PVI.3 ⬜ Persistir el `basis` del supuesto.** `proposeGrowth` calcula
  `yoy_paired | global | default` + `paired_periods` y **los tira**: `growth_by_channel` guarda
  números pelados. Sin eso nadie puede auditar un supuesto sin recomputarlo — y fue lo único que
  delató a `mayoreo` (26.67 % = el `default` al decimal). Hereda ADR-056 (el número carga con qué
  se calculó).
- **PVI.4 ⬜ El hueco del Q4 — decisión de negocio, no técnica.** 99 renglones (33 entidades ×
  P11/P12/P13) en `sin_base_declarado` con meta **$0.00**. En FY2025 esos tres periodos valieron
  **$166,571,225 = 27.37 %** del año, y son los más fuertes. O se proyectan, o el ejercicio
  **declara que cubre 10 de 13 periodos**. ⛔ Lo que no se puede es publicarlo como si fuera un año.
  ⚠️ Cae en **el mismo trimestre** que el relleno plano del lado del gasto: es un solo defecto
  estructural visto de dos lados, no dos.
- **PVI.5 ⬜ Desambiguar `method`.** `estacional` significa **índice por entidad con fallback al
  canal** en ventas y **promedio plano** en gastos. El mismo string, dos cálculos. Renombrar uno de
  los dos; es defecto de contrato, no bug de ninguno.
- **PVI.6 ⬜ Limpieza.** (a) Borrar el FY2027 **duplicado** (dos ejercicios byte a byte, timestamps
  a 1 s) — agregado por `fiscal_year` publica **$1,209,550,232** en vez de $604,775,116. (b) Filtrar
  la basura de fecha del rollup (6 filas en FY2014/2020/2024, **$40,292**).
- **PVI.7 ⬜ El COGS en el presupuesto — decisión de negocio.** `budget.budget_lines` sólo tiene
  `ingreso` y `gasto`; `costo_ventas`, `compra_inventario`, `inversion` y `flujo` existen en el
  CHECK con **cero** filas. Por eso meta − egreso da **87.62 %** contra un margen medido de
  **11.87 %**. **Sin esto no hay margen ni viabilidad que dictaminar** (pregunta 4 del encargo).
- **PVI.8 ⬜ El candado.** Test que compara, por canal, el crecimiento **publicado** contra el
  **comparable**, y se pone rojo pasados N pp. Con **control positivo del propio detector**: un
  umbral que nunca dispara se lee igual que «no hay desviación». Patrón de
  `test-newdb-branch-cutover.js`.

**MVP = PVI.1 → PVI.3 → *redeploy* → PVI.0.** ⛔ El orden importa y el que escribí primero estaba invertido:
recomputar los supuestos ANTES de desplegar PVI.1 los recalcula con el pareo por canal todavía roto —
`mayoreo` mejoraría y `mostrador` quedaría en +21.46 % en vez de −2.82 %, dando el ejercicio por corregido
con el número equivocado del canal que carga el 58.46 % de la meta. Sin esos tres, cualquier herramienta que se construya encima
hereda un supuesto refutado.

**Pendiente humano (no es código):** asignar el ADR · decidir el Q4 (PVI.4) · decidir el COGS
(PVI.7) · **fijar los umbrales en `analytics.kpi_thresholds`** — hay **tres encargos en circulación**
con cifras distintas para la misma regla, y un umbral escrito en un prompt no tiene versión ni dueño
y **se bifurca cada vez que se escribe un encargo**.

**Declarado, no construido:** la reconstrucción de «meta defendible» (mi primer intento dio
$748,059,625 y quedó **refutado** — usaba un global contaminado por la misma cobertura). Proyectar
2027 exige decidir antes PVI.1 y PVI.4; no se dibuja una cifra mientras tanto.

---

## PVI.17 — Presupuestos EMITE a la torre de control (2026-10-09) 🧪

**El pedido.** Del usuario: qué herramientas darle a Dirección General *«considerando que ésta es su
torre de control»*.

**La respuesta medida: no hace falta un tablero nuevo.** Por ADR-076 la torre directiva es «Mi
trabajo» (`/projects`, ADR-061) y un tablero aparte sería la 12ª landing. ⛔ Y antes de construir
nada hay que decir lo que la medición dice: **un tablero sobre un instrumento que nadie operó
publica ceros honestos.** Medido en prod el 2026-10-09:

| | |
|---|---|
| ejercicios | 3, los 3 `borrador` (uno es el duplicado `is_test`) |
| `status = 'pendiente'` | **0** — nadie mandó nada a firmar |
| obligaciones | **156 `propuesta` · $74,809,091.57**, la más vieja del 07-oct |
| `line_movements` | 139, **todos `apertura`** — reservado/comprometido/ejercido/pagado en **$0** |
| `costo_ventas` | **0 partidas en los 3** ⇒ ninguno puede declarar un resultado |
| `growth_provenance` | **NULL en los 3** (≠ «sin respaldo»: la columna nunca se escribió) |

⭐ **Dirección ya puede aprobar y no tiene nada que aprobar.** `PRESUPUESTOS_APROBAR` se repartió el
09-oct (**batch 867**, `public.knex_migrations`) a `direccion` y `superadmin`.

**Lo que se construyó: la emisión, no un mirador.**

- **Dos bandejas** en el registro de «Mi trabajo» (`libs/trade/.../me-work.ts`):
  `presupuesto-ejercicios` y `presupuesto-obligaciones`. ⭐ **Dos y no una**: con un solo contador
  las 156 obligaciones se comen al 0 de los ejercicios, y ese 0 es el que dice que nadie envió un
  presupuesto a firmar. Es el mismo criterio por el que `[TES.17]` publica `por_cola[]`.
- **No mide de nuevo nada.** `[TES.17]` ya había construido `PendingApprovalsService`; el defecto no
  era que faltara la cola sino **dónde vivía** — sólo dentro de `/presupuesto`, o sea obligando a
  entrar al módulo para enterarse de que hay algo que firmar.
- **El desglose** de la cola de ejercicios dice **qué le falta a cada uno** para poder firmarse:
  `falta Costo de ventas · 4 supuestos de crecimiento sin procedencia registrada`. Son las otras
  dos señales del diagnóstico, entregadas en el momento en que cambian una decisión.
- **Migración `20261009164933`**: responsabilidad `finanzas.presupuesto` repartida a los puestos
  `direccion` (firma) y `jefe_finanzas` (prepara y vigila). ⛔ `[SN.30]` filtra las bandejas **por
  responsabilidad, no por permiso**: sin esta fila las dos colas son invisibles para todos, en
  silencio.

### Dos primitivos suben a `libs/` (ADR-056)

1. **`obligacionNoEsDePruebaSql` / `ejercicioNoEsDePruebaSql`** (`libs/platform-core`, junto a
   `branchKeySql`). ⛔ **Y por una razón que cobró el mismo día:** esta sesión midió y publicó
   «312 obligaciones por $149,618,183.14» como un hecho, a un commit de cablearlo a la portada de
   Dirección. Es **el doble exacto** — el duplicado `is_test` es copia byte a byte, así que el error
   no deja rastro. Lo atrapó otra sesión, que tenía el filtro adentro de su servicio. *Dos
   definiciones de la misma cola es cómo nacen los dos números.*
2. **`TIPOS_LEDGER` / `LADOS_NECESARIOS` / `resumenEjercicioPendiente`** (`libs/contracts`). Nacieron
   en `apps/view` para una pantalla; hoy las lee también `libs/trade`, que no puede importar de
   `apps/view`. Si el módulo dijera «falta el costo de ventas» y la portada dijera otra cosa, el que
   hace clic no encuentra lo que le dijeron.

### ⛔⛔ Hallazgo: `budget.expense_obligations.authorized_at` miente

```
authorized_at  NOT NULL DEFAULT now()   ← no puede valer NULL jamás
312 de 312 filas llena · 312 de 312 todavía en status 'propuesta'
authorized_by vacío en las 312 · authorized_at = created_at en 312 de 312
```

Es una marca de creación con el nombre de una autorización. Quien derive «cuántas están
autorizadas» de `authorized_at IS NOT NULL` obtiene el **100 %**. La bandeja declara `cierre: null`
⇒ `cerradas_30d: null` («esta fuente no puede contestarlo»), **nunca 0** («nadie cerró ninguna»). La
hermana de `budgets` sí sirve: nullable y sin default, verificado contra el esquema. **El arreglo de
fondo —que la transición escriba fecha y autor— queda declarado, no hecho.**

### ⛔ Dos protecciones que hoy NO se pueden medir, y se declaran

Corridas las mutaciones contra prod: **sin el predicado da 312** (rojo, la que importa). Pero
`JOIN` en vez de `NOT EXISTS` da **156 igual** —hay 0 obligaciones sin partida— y `= false` en vez de
`IS NOT TRUE` da **2 igual** —hay 0 nulos—. Esas dos se vigilan por la **forma** del SQL emitido, y el
spec lo dice. *Un gate que no puede fallar con los datos de hoy se declara, no se presenta como verde.*

### ⚠️ El texto dice «sin procedencia registrada», nunca «sin respaldo»

`growth_provenance` en NULL significa que la fila es anterior a `[PVI.3]` **o** que el autopiloto no
pasó todavía — no que alguien haya decidido a dedo. Convertir una columna vacía en una acusación es
afirmar lo que no se midió. El spec lo vigila explícitamente.

**Verificado:** contracts 520/520 (15 nuevas, **mutado a rojo 2/15** contando los ceros) · finance
7/7 (**mutado a rojo dos veces**, 4/7 y 3/7) · view 44/44 sin cambio tras el traslado ·
`check:templates-types` verde en las 4 apps · smoke `me-context` **298 OK**.

**Falta:** aplicar `20261009164933` a prod **antes** del deploy · redeploy api+view · **re-login**
(la responsabilidad viaja en el contexto) · validación visual.

**⭐ Pendiente humano, y es lo que decide si esto sirve:** que **alguien que no sea Dirección prepare
el presupuesto**. Hoy `PRESUPUESTOS_GESTIONAR` prepara y aprueba a la vez, y lo tienen las mismas 2
personas que firman — mientras siga así, cualquier bandeja les muestra su propio trabajo. La
migración ya le da visibilidad a `jefe_finanzas`; **darle `PRESUPUESTOS_GESTIONAR` es la decisión que
falta**, y se toma desde `/admin/roles`. (Declarado en el log de la migración: `jesus_carrillo`
recibe la responsabilidad pero su rol `finanzas_operativo` no tiene ni `PRESUPUESTOS_VER`.)
