# Mini-proyecto MI — Identidad de caja Wincaja (descuadre real por corte)

> Reconstruir, por corte, la **identidad de caja** desde Wincaja itemizado para obtener la **diferencia REAL** (faltante/sobrante) independiente del barrido "por diferencia de corte" que hoy fuerza el cuadre. Cierra lo que el arqueo ciego de SM.8 y las reglas SM.9/A+B no pueden: el descuadre que el plug oculta. Hereda ADR-016/029 (motor calcula, humano confirma, LLM fuera). Insumo previo: [`FASE_SM_ARQUEO_MODELO.md`](FASE_SM_ARQUEO_MODELO.md).

## Tesis

Wincaja itemiza cada movimiento de efectivo (ventas por pago, retiros por folio con conteo por denominación). Si amarramos esos movimientos al corte correcto, la identidad
```
fondo + Σ ventas_efvo − Σ retiros_efvo = remanente
```
da el efectivo teórico; contra el conteo físico (`wincaja.arqueos`) sale el descuadre real. Kepler solo tiene el agregado `c15` ya potencialmente cuadrado por el barrido; Wincaja tiene la materia prima para recalcularlo.

## Estado de factibilidad (de-risked 2026-07-31)

| Pieza | Estado | Evidencia |
|---|---|---|
| Corte único | ✅ `(source_branch, caja, folio)` es PK | `uniq_3 = 5706 = total` |
| Llave pago↔corte | ✅ `pagos_dia.consecutivo::int ∈ [folio_inicial_pago, folio_final_pago]` por caja | corte 7101 → ventas $174k plausible |
| Llave retiro↔corte | ✅ `retiros.folio::bigint ∈ [folio_inicial_retiro, folio_final_retiro]` por caja | corte 7101 → 29 retiros |
| Conteo físico | ✅ `arqueos` = denominación por retiro (join `branch/caja/folio`) | solo sucursales 30/32/50 |
| **La identidad se cumple** | ✅ **mediana del gap `ventas−retiros` = $0** (branch 32) | todo el efvo cobrado se retira |
| Rangos corruptos | ⚠️ ~14% de cortes con rangos gigantes (6,346 retiros / ventas >$1M single-caja) | cortes de cierre de período/consolidación |
| Fondo (dotación) | ❌ NO se captura (`dotacion_inicial` = 1 fila en toda la DB) | asumir neto ~0 (respaldado por mediana $0) o encadenar remanente previo |
| `forma_pago` | ⚠️ solo `1=Efectivo` estable entre sucursales | resolver contra `wincaja.formas_pago` para no-efvo |

**Conclusión:** viable **con saneamiento de datos**. El fracaso anterior a escala fue un bug de agrupación (por `folio` sin `caja`), no de la data. El riesgo real que queda es (1) filtrar los cortes de rango corrupto y (2) el término fondo.

## Alcance

- **Dentro:** sucursales `live_on_wincaja` con conteo físico (30 Morelia Abastos, 32 Morelia Madero, 50 Canindo) — ahí la identidad se triangula contra el arqueo.
- **Fuera (por ahora):** sucursales legacy en Kepler (10/40/44/54/42) — sin arqueo Wincaja; se cruzarían contra `c15` de Kepler vía crosswalk caja/cajero (MI.6, opcional).
- Solo **efectivo** (`forma_de_pago='1'`).

## Sprints

**MI.0 — Saneamiento del corte (GATE).**
Llave canónica `(source_branch, caja, folio)` + fecha del corte. Excluir cajas administrativas (`70`, `98`, `99`, …: pocas cortes, rangos gigantes). Regla de sanidad de rango: descartar/flaggear cortes con `n_retiros > umbral` (p.ej. 200) o `span_pago > umbral` o `ventas_single_caja > $1M`. **Gate: ≥90% de los cortes de 30/32/50 reconstruyen con `|gap|` bajo; si no, el proyecto se detiene.**

**MI.1 — Feed `analytics.wincaja_cash_identity` (migración + importer).**
Una fila por corte válido: `tenant_id, source_branch, warehouse_code, caja, cajero, folio, business_date, fondo, ventas_efvo, retiros_efvo, remanente_teorico, arqueo_fisico, diferencia_real, n_retiros, n_pagos, rango_ok`. UPSERT idempotente por `(tenant_id, source_branch, caja, folio)`. Nightly (patrón importers Wincaja). RLS + grant `app_runtime`.

**MI.2 — Fondo / remanente.**
Resolver el término fondo: (a) confirmar neto ~0 (la mediana $0 lo respalda) y tratarlo como 0 con tolerancia, o (b) encadenar el remanente del corte previo de la misma caja como fondo del siguiente. Validar contra los cortes que ya cuadran.

**MI.3 — Reglas SM sobre el feed.**
- `descuadre_real_wincaja`: `|diferencia_real| ≥ umbral` (el faltante/sobrante que el barrido ocultó). Plano Caja.
- `retiro_plug`: barrido `por_diferencia_corte` cuyo monto ≈ `diferencia_real` → enmascaramiento confirmado (liga la regla SM.9/A al hueco real).
Ambas idempotentes, con `causa_probable` y feedback L2 (auto-supresión por precisión).

**MI.4 — Triangulación con arqueo físico (30/32/50).**
`diferencia_real` (ventas−retiros) cruzada contra el conteo por denominación → doble confirmación del hueco. Marca cortes donde el arqueo tampoco es confiable (regla `retiro_conteo_mismatch` ya existente).

**MI.5 — Drill-down en `/almacen/cuadre`.**
Por corte: la secuencia `fondo → ventas efvo → cada retiro (con motivo) → arqueo → diferencia real`. Reusa la bandeja de Descuadres + un panel de detalle del corte.

**MI.6 — (opcional) Crosswalk Wincaja↔Kepler.**
Mapa caja/cajero Wincaja↔Kepler para las sucursales legacy; cruzar `diferencia_real` (donde exista) o al menos `ventas_efvo` contra `c15` de Kepler. Mini-proyecto de mapeo aparte.

## Schema propuesto (`analytics.wincaja_cash_identity`)

```sql
CREATE TABLE analytics.wincaja_cash_identity (
  tenant_id        uuid NOT NULL,
  source_branch    text NOT NULL,
  warehouse_code   text,              -- de wincaja.branches
  caja             text NOT NULL,
  folio            text NOT NULL,     -- corte (único con caja+branch)
  cajero           text,
  business_date    date NOT NULL,     -- fecha_corte (pagos_dia no tiene fecha usable)
  fondo            numeric DEFAULT 0,
  ventas_efvo      numeric NOT NULL,  -- Σ pagos_dia forma=1 en rango consecutivo
  retiros_efvo     numeric NOT NULL,  -- Σ retiros forma=1 en rango folio
  arqueo_fisico    numeric,           -- Σ denominación (solo 30/32/50)
  diferencia_real  numeric NOT NULL,  -- ventas + fondo − retiros − remanente
  n_pagos          int, n_retiros int,
  rango_ok         boolean NOT NULL,  -- pasó la sanidad de MI.0
  computed_at      timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, source_branch, caja, folio)
);
-- RLS forzado + policy tenant_isolation + GRANT app_runtime (convención A.0mt).
```

## Gate / fail-fast

MI.0 es el gate. Si tras el saneamiento **<90%** de los cortes de 30/32/50 reconstruyen con `|gap|` por debajo del umbral, la data no soporta la identidad y el proyecto se detiene con lo aprendido documentado (las 2 reglas SM.9 ya entregan valor).

## Riesgos / preguntas abiertas

1. **Fondo real** — el mayor unknown. Mitigación: la mediana $0 sugiere neto ~0; validar por encadenamiento.
2. **Por qué hay rangos corruptos** — ¿cortes de cierre de período? ¿re-aperturas? Entender antes de filtrar a ciegas.
3. **`pagos_dia` sin fecha** — el corte aporta `business_date`; los pagos se atan por consecutivo, no por fecha.
4. **Cobertura** — la triangulación con arqueo solo en 3 sucursales; el resto se queda en ventas-vs-retiros sin conteo físico.

## Estimación

MI.0+MI.1 (feed validado) = la rebanada de valor: entrega la `diferencia_real` por corte para 30/32/50. MI.2–MI.5 iteran. MI.6 es un mini-proyecto de mapeo aparte. Sin código aún — este doc es el plan.
