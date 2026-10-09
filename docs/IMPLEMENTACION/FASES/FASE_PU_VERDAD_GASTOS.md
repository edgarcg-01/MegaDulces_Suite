# Fase PU — Verdad absoluta del carril EGRESOS

> **Qué es esto.** La auditoría del lado de **gastos** del módulo Presupuestos (`/finanzas/presupuesto`),
> medida contra **producción** antes de construir herramientas encima. Pedido de Edgar, 2026-10-08:
> *«necesitamos una verdad absoluta antes de iniciar»*. Hereda **ADR-056** (lo que no se puede medir se
> DECLARA) y **ADR-066** (Fase PU).
>
> **No es un plan.** Es el estado medido. Lo que hay que construir está en §5.

**Medido:** 2026-10-08 16:13 MX · `192.168.0.222:5434/railway` (`pg-prod` de `md`) · usuario `edgar`
con `default_transaction_read_only = on` · **cero escrituras**.

**Carril hermano:** el de INGRESOS lo midió otra sesión en paralelo; sus hallazgos se citan en §4 y
están marcados como tales, no re-medidos acá.

---

## 1 · Cómo reproducirlo

Lectura directa a `pg-prod` con `PROD_DB_URL` del `.env`. **Toda afirmación de este documento tiene una
consulta detrás** — lo que no se pudo medir está en §3.

⚠️ **Acotar SIEMPRE el universo.** `analytics.expense_entries` tiene todas las familias contables; el
plan de gasto usa 12–14 `cuenta_mayor`. Comparar sin acotar da un desfase de **12×** que parece
hallazgo y es denominador sin declarar. (Pasó en esta misma auditoría, §6.)

---

## 2 · Los hechos

### 2.1 ⛔ El presupuesto de egresos no es un presupuesto: es el histórico copiado

**374 de 374 renglones de `budget.expense_plan_lines` tienen `monto = base_amount` EXACTO.**
`Σ|monto − base| = $0.00`. `growth_pct = 0.0000` en los 374, cero nulos, en los dos métodos y en los
tres ejercicios.

Y la base **es** el gasto contable realizado, verificado cuenta por cuenta contra
`analytics.expense_entries` (fuente declarada en `budget-expense-plan.service.ts:181`):

| cuenta | base del plan FY2027 | `expense_entries` ene–sep 2026 | Δ |
|---|---|---|---|
| 601 Sueldos | $31,153,775.32 | $31,153,775.32 | $0.00 |
| 602 Logística | $6,923,063.02 | $6,923,063.02 | $0.00 |
| 611 Venta | $6,529,448.74 | $6,529,448.74 | $0.00 |
| 603 Local | $5,187,149.60 | $5,187,149.60 | $0.00 |
| … (14 de 14 cuentas) | | | **Σ \| Δ \| = $0.00** |

FY2026 «prueba 2» usa la misma mecánica con otro año: su base ago–dic 2026 **es `expense_entries`
ago–dic 2025**, al centavo en los 5 meses. El motor toma el mismo mes del año completo más reciente
— **esa parte está bien hecha**; el defecto no es de dónde sale la base.

**Nadie firmó un supuesto:** `budget.expense_plan_settings` = **0 filas**.

### 2.2 ⭐⭐ Asimetría estructural: la venta se proyecta, el gasto se copia

`budget.generation_runs.assumptions` (GEN-20261008-019, `trigger: cron`) guarda **sólo supuestos de
venta**: `growth_by_channel` = ruta 8.26% · mayoreo 26.67% · preventa 51.21% · mostrador 21.05%;
`default_growth_pct` 26.67%.

Del lado del gasto: **0.0000**. ⭐ **El margen del ejercicio mejora por construcción, no por decisión
de nadie.** Cualquier «margen operativo proyectado» que salga de cruzar meta contra egreso hereda esa
asimetría.

### 2.3 El método `estacional` del GASTO es el promedio plano

Rellena oct/nov/dic con `suma(ene–sep) / 9`, idéntico en los tres meses. Verificado al centavo:

| cuenta | observado (9m) | promedio | relleno (3m) |
|---|---|---|---|
| 601 | $31,153,775.32 | $3,461,530.59 | $3,461,530.59 ×3 |
| 602 | $6,923,063.02 | $769,229.22 | $769,229.22 ×3 |
| 611 | $6,529,448.74 | $725,494.30 | $725,494.30 ×3 |

⛔ Para una dulcería eso **subestima el trimestre más caro del año**, y en 601 aplana diciembre, que
lleva aguinaldo por ley.

⚠️ **ALCANCE — no generalizar.** Esto es de `budget-expense-plan`. El `estacional` de
`budget-sales-plan` **sí** varía por entidad (`seasonalIndexByEntity`): 25 de 28 grupos varían entre
periodos (medido por el carril de Ingresos). ⭐ **Por eso el hallazgo real es peor que el original: la
etiqueta `method` no carga información.** El mismo string significa dos cosas según la tabla. Quien
lea `method` y crea que sabe cómo se calculó el renglón, acierta la mitad de las veces. **Defecto de
contrato, no bug de un lado** — y emparenta con `proxy_canal`, que escribe `base_amount` NULL:
los dos son el mismo defecto, **el renglón no declara su procedencia**.

### 2.4 El ledger nunca se operó

`budget.line_movements` = **139 filas, las 139 `apertura`** ($2,065,520,047.09). Diez tipos sin una
sola fila: `reserva`, `compromiso`, `ejercido`, `pago`, `cancelacion`, `reversion`, `ampliacion`,
`reduccion`, `transferencia_in`, `transferencia_out`.

- `reserved = committed = exercised = paid = $0.00` en **el 100% de las 139 partidas**.
- Ocupación 0% y `disponible = vigente` en todas.

**Causa:** las **312 `expense_obligations` están ligadas a partida y las 312 en estado `propuesta`**.
El circuito existe entero y nadie lo autorizó una vez.

⚠️ **Corolario para quien construya el cuadre:** `available_amount` **no es columna** — se calcula en
`budget-lines.service.ts:243` con la misma resta. Verificar `vigente − (res+com+eje) = disponible` es
auditar una expresión contra sí misma: **no puede fallar**. El cuadre que SÍ puede fallar es
acumuladores contra `SUM(line_movements)` por tipo, y `vigente = original + ampliaciones −
reducciones + transferencias`.

### 2.5 Cero partidas con freno

`control_level`: **99 `informativo` + 40 `advertencia` + 0 `bloqueo`.** El default de la columna en la
migración es `'bloqueo'`; el materializador hereda `budget_expense_plan_settings.control_level`
(default `'advertencia'`). **Hoy ninguna partida puede frenar un sobregiro.** El freno está escrito
(`budget-lines.service.ts:377`, `Sobregiro bloqueado`) y apagado en todas.

⚠️ **Un `disponible` negativo NO es un bug de datos**: es el resultado legítimo de una partida en
`informativo`/`advertencia`, donde el servicio deja pasar con `warning`. Tratarlo como error de
integridad manda al contralor a Sistemas por una decisión de negocio que alguien ya tomó.

### 2.6 El presupuesto no tiene costo de mercancía

`budget.budget_lines` tiene **sólo dos `line_type`: `ingreso` (99) y `gasto` (40)**. Los tipos
`costo_ventas`, `compra_inventario`, `inversion` y `flujo` existen en el CHECK y **no tienen ni una
sola partida**.

Testigo independiente (`finance.payment_program`, ene–jul 2026, $354,486,680.75): `compra` =
**$303,802,201.44 = 85.70%** del desembolso de tesorería. Beneficiarios: de la rosa, mondelez,
ferrero, mars, hershey, bimbo.

→ **«Meta de ventas − egreso vigente» NO es un margen.** Es opex sobre venta.

### 2.7 FY2027 está duplicado, y los tres ejercicios son borrador

| FY | Nombre | Estado | Creado |
|---|---|---|---|
| 2026 | `prueba 2` | borrador | 2026-10-08 |
| 2027 | `Presupuesto 2027` | borrador | 2026-10-07 13:07 |
| 2027 | `PRUEBA ciclo ledger — no usar` | borrador | 2026-10-07 19:40 |

Los dos de FY2027 tienen **la misma huella** `md5` sobre `(concept, line_type, vigente_amount)`:
`12e0cfab4891f2e3`, 47 partidas cada uno. **Todo agregado por `fiscal_year` publica el doble:**

| | agrupado por año | real |
|---|---|---|
| Gasto FY2027 | $149,704,381.64 | **$74,852,190.82** |
| Ingreso FY2027 | $1,209,550,232.42 | **$604,775,116.21** |
| Obligaciones FY2027 | $149,618,183.14 | **$74,809,091.57** |

⛔ **El cron del autopiloto corre sobre los tres**, incluido el que se llama «no usar».
**Hoy el filtro seguro es por `budget_id`, nunca por `fiscal_year`.**

### 2.8 Dos ausencias que se leen como cero

- **10 celdas (cuenta, mes) sin renglón**: la cuenta `612` sólo existe en marzo y junio. Una ausencia
  suma `$0.00` en cualquier agregado sin marcar nada.
- **FY2026 publica $32,425,843.06 como presupuesto ANUAL y son 5 meses.** `period_month = NULL` en las
  12 partidas, pero su importe **es exactamente la suma de ago–dic**. Quien lo lea como año
  subestima ~58%.

### 2.9 Dos cuentas de tecnología

`605 GASTO EN TECNOLOGIA` ($1,147,589.24) y `613 GASTOS EN TECNOLOGIA` ($533,603.88). **Son dos
cuentas distintas del catálogo**, no un concepto mal escrito dos veces. Suman $1,681,193.12. El
catálogo viene de Kepler → el arreglo es allá (ADR-040), no acá.

---

## 3 · Lo que NO se puede concluir (trampas declaradas)

### 3.1 ⛔ `payment_program` y `expense_entries` son universos distintos

Cruzar `payment_program.tipo='gasto'` ($23,352,862.33 en 7m → $40.03M anualizado) contra el OPEX
presupuestado ($74,852,190.82) da **187%** y parece sobre-presupuestación. **Es falso.**

`payment_program` es **TESORERÍA** (lo que sale del banco; la nómina no va por ahí — `c10 LIKE 'C%'`
es proveedor de compra, nómina es `GN`). `expense_entries` es **CONTABLE** por `cuenta_mayor` 6xx e
incluye 601 Sueldos. Prueba: Sueldos solos son ~$3.46M/mes y **todo** el bucket `gasto` de tesorería
son $3.34M/mes.

### 3.2 ⛔ Los umbrales de los encargos no son medibles como están

- **«Sueldos > 45% / > 40% del gasto total»** — hay **al menos tres briefs en circulación** y el umbral
  difiere entre ellos (45% en el encargo del Comité, 40% en el del Contralor; mismo sujeto, mismo
  denominador). Y aunque se fijara: como `plan == base`, el **55.49%** medido *es la participación
  histórica realizada*, no una decisión presupuestal. Alarmarse ahí es alarmarse del termómetro.
  → Por **ADR-076** va a `analytics.kpi_thresholds` con dueño, o el estado es `sin_meta`.
- **«Gastos logísticos proporcionales al crecimiento del canal Ruta»** — compara participación sobre
  el GASTO contra participación sobre el CRECIMIENTO DE LA META: **no son conmensurables**, y
  logística sirve a los cuatro canales. Además la atribución partida↔canal **no existe en el dato**:
  `budget-comparison.service.ts` la declara explícitamente como no construida.
- **«Ocupación vs mes del año»** — `ocupacion = (res+com+eje)/vigente`, **no** «ejercido». Una partida
  al 90% con 85% reservado no gastó: apartó. Y la regla lineal (50% a mitad de año) choca con
  `period_month` y con la estacionalidad real de una dulcería.

### 3.3 No medido

- Por qué el motor elige `estacional` para unas cuentas y `historico_ajustado` para otras.
- Si las 2 cuentas extra de FY2027 (14 vs 12) explican parte del corrimiento de participaciones.
- Nada del lado de Ingresos: es otro carril.

---

## 4 · Dictamen

**El presupuesto de egresos no es inviable ni riesgoso: todavía no existe.** Es el gasto contable
realizado, copiado al centavo, con el Q4 aplanado y etiquetado `estacional`.

Puesto junto al carril de Ingresos (medición de la otra sesión, citada no re-medida), **son
enfermedades opuestas**:

| | **Gasto** | **Venta** |
|---|---|---|
| Trazabilidad | 374/374 al centavo · **0** con base NULL · no existe `proxy_canal` | **$197,160,564 = 24.5% del FY2026** con `base_amount` NULL (`proxy_canal`) |
| Crecimiento | **0.0000** en los 374 | 8.26% – 51.21% por canal |
| Veredicto | **honesto e inerte** | **ambicioso y en parte inventado** |
| Arreglo | que **alguien firme un crecimiento** | que `proxy_canal` **no pueda publicarse sin declarar que no tiene base** |

Y el Q4 falta por los dos lados, por mecanismos distintos: el gasto lo rellena con el promedio plano,
la venta deja P11–P13 en $0.00. ⭐ **No hay un solo ejercicio en prod que sirva como base para
construir herramientas encima.**

⛔ **Construir el Contralor sobre esto da un reporte incapaz de emitir un rojo verdadero**, que emite
verdes por vacío. Es peor que no tenerlo.

---

## 5 · Qué construir, en orden

1. **Identidad del ejercicio** — bandera `is_test` (precedente `[MS.7.12]`) + que el autopiloto **no
   corra** sobre pruebas. Hoy mantiene vivo uno llamado «no usar».
2. **Declarar los tres estados del renglón** — `observado` / `rellenado_promedio` / `ausente`. Hoy los
   tres suman igual (ADR-056).
3. **Renombrar `estacional`** a lo que hace (`promedio_plano`) o hacerlo estacional de verdad. **No
   las dos cosas.** Y que `method` signifique lo mismo en las dos tablas.
4. **Exigir supuesto de gasto firmado** antes de materializar partidas. Con `expense_plan_settings`
   vacía, el motor publica el pasado como si fuera un plan.
5. **Candado de cuadre acumuladores ↔ `line_movements`**, escrito **antes** del primer `reserva` real,
   con prueba negativa. Un gate sin prueba negativa es una intención.

Los cinco son deterministas, SQL puro, sin LLM (ADR-016), y ninguno toca Ventas.

---

## 6 · Lección de método

Las tres fallas de medición encontradas hoy entre los dos carriles **no las detectó ninguna relectura
del código**: las detectó **un bloque de la misma corrida contradiciendo a otro**. Es la misma lección
que `[IC.0]` pagó en septiembre — verificar una vista contra sí misma pasa bugs en verde.

⚠️ Y una propia, para que no se repita: en esta auditoría comparé la base del plan contra
`expense_entries` **sin acotar a las cuentas del plan** y salió un desfase de 12× que parecía
hallazgo. Lo detectó el bloque siguiente de la misma corrida. **Un denominador sin declarar produce
un hallazgo falso en la primera consulta, incluso cuando el que consulta acaba de escribir la
advertencia.**

⭐ **Regla que adoptamos los dos carriles: que cada corrida traiga su propio testigo adentro.**
