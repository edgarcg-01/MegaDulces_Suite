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
