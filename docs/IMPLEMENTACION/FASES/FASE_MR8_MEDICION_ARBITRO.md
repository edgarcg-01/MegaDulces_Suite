# MR.8.1 — Medición previa del árbitro del margen

> **Estado:** ✅ **MEDIDO — veredicto GO** · 2026-09-29
> **Qué es:** el entregable que decide si el margen se puede arbitrar, ANTES de escribir una línea
> del resolvedor. Sin esto, `[MR.8.2]` construiría sobre una hipótesis.
> **Dónde se midió:** prod real (`md` `192.168.0.222:5434/railway`), read-only, ventana **30 días**
> terminando el 2026-09-29. Ninguna consulta escribió nada.
> **Plan de fase:** `[MR.8]` — ADR-051 (enmendado), ADR-059.

---

## 0. El veredicto, primero

| # | Pregunta | Resultado | Gate |
|---|---|---|---|
| 1 | ¿El árbitro y lo publicado miden el mismo universo? | Sí, salvo **un** ítem: las rutas. Cancelados **0**, servicios **0**, cantidad cero **0** | ✅ |
| 2 | ¿Cuánto cubre `c62`? | **99.99 %** de las líneas en `U-D-10` y `U-D-12` · **1.16 %** en `U-D-8` | ⚠️ con hueco |
| 3 | ¿Contradice al álgebra? | **+4.16 pp** en mostrador; por sucursal de **+1.93** a **+5.44 pp** | ✅ |
| 4 | ¿Es un espejo? | **No.** Spread entre sucursales del mismo SKU: **3.03 pp** contra **0.0000 pp** del álgebra | ✅ |
| 5 | ¿Costo > venta (aceptación `MR.7.2`)? | **0.055 %** de las líneas contra el baseline de **7.4 %** | ✅ |
| 6 | ¿Hay recorte escondido? | **No.** Existe venta bajo costo real (peor línea **−294.8 %**) | ✅ |

**GO.** El árbitro se construye. ⛔ **Con una condición dura: el margen arbitrado NO se publica en
agregado global** — ver §4.

---

## 1. Cómo se midió (y por qué el camino importa)

El plan decía que el árbitro «no se puede consultar en vivo»: `SELECT count(*) FROM
analytics.v_erp_sales_line_units WHERE fecha >= CURRENT_DATE-7` **agota 180 s**, porque
`kepler_ods.kdm2` son 2,151 MB / 4.69 M filas y **no tiene ni un índice sobre `c32`** (la fecha del
renglón).

⭐ **Hay un camino barato que la vista no usa:** `ix_kdm1_venta_fecha ON ((c9)::date) WHERE c2='U'
AND c3='D'`. Manejando desde `kdm1` por fecha y uniendo a `kdm2` por la **PK completa de 7 columnas**
(`sucursal, c1, c2, c3, c4, c5, c6`), las mismas consultas corren en **2–8 s sobre 30 días**.

⚠️ Y **no** es el join que GOTCHAS §31 prohíbe. Lo que duplica es unir por folio con la fecha
filtrada de una sola punta; acá el join es sobre la PK **única** de `kdm1`, así que cada renglón
cuelga de exactamente un documento. Es el mismo join de 7 columnas que usa
`analytics.mv_kepler_sales_daily`.

**Consecuencia para `[MR.8.2]`:** el matview puede armarse por este camino y **probablemente no hace
falta crear un índice sobre `c32`** — hay que confirmarlo con el `EXPLAIN` del cuerpo completo a
400 días, que es lo único de la medición que queda abierto (§6).

---

## 2. Población — el bloqueante, resuelto

El riesgo era que el «delta» entre árbitro y publicado fuera en realidad el recorte de siete filtros
distintos. **Medido, seis de los siete no tiran nada:**

| filtro del publicado | líneas que tira | importe |
|---|---|---|
| cancelado (`c43 = 'C'`) | **0** | — |
| servicio (`c11 = 'SER'`) | **0** | — |
| cantidad cero | **0** | — |
| sub-almacén de ruta (`01-00N`) | **22,108** | **$2,343,922** |
| **universo del árbitro** | 396,950 | **$39,791,993** |
| **universo publicado** | 374,842 | **$37,448,071** |

El único ítem real son las rutas — y es **a favor**: la evidencia de línea existe en `kdm2` y el
publicado la deja fuera por su filtro de almacén estricto.

⚠️ **Descuadre residual declarado:** el universo publicado acá ($37,448,071) contra la pierna Kepler
de `mv_sales_blended` ($37,196,710) difiere en **$251,361 (0.67 %)**. No se aplicaron el filtro de
cutover ni los joins a `catalog.products` / `commercial.warehouses`. Está dentro de la tolerancia
que `[MR.8.4]` va a calibrar, pero **no está explicado renglón por renglón** y se declara así.

---

## 3. Cobertura de `c62`, por doctype

| doctype | qué es | líneas | con `c62` | % líneas | importe | % dinero |
|---|---|---|---|---|---|---|
| `U-D-10` | Ticket Contado Caja (**mostrador**) | 355,604 | 355,572 | **99.99 %** | $25,920,751 | **100.00 %** |
| `U-D-12` | Factura Contado No Fiscal (**mostrador**) | 8,838 | 8,832 | **99.93 %** | $1,266,856 | **99.99 %** |
| `U-D-8` | Factura Telemarketing (**mayoreo**) | 10,400 | **121** | **1.16 %** | **$10,260,464** | **0.95 %** |

Y las rutas, aparte:

| almacén | líneas | con `c62` | % | importe | margen árbitro |
|---|---|---|---|---|---|
| `01-001` … `01-006` | 22,108 | 22,108 | **100.00 %** | $2,343,922 | **15.47 – 16.60 %** |

⛔ **`U-D-8` no tiene con qué costearse, y el límite es de la fuente.** Los 121 renglones que sí
traen `c62` valen $97,231 de $10,260,464, y están repartidos entre tres sucursales (`06` 51, `01` 48,
`08` 22) — o sea que la ausencia es **uniforme**, no un problema de una plaza. Ya está declarado como
`ud8_sin_arbitro` / `irresoluble_con_la_fuente`; `[MR.8.3]` agrega el hueco gemelo del **COGS**.

---

## 4. ⛔ El sesgo: por qué el margen arbitrado NO se publica en agregado

El árbitro **ve mostrador y no ve mayoreo**. Eso no es un detalle de cobertura: es exactamente el
eje donde el margen de un distribuidor cambia más.

| tramo | venta 30 d | ¿arbitrable? |
|---|---|---|
| Kepler mostrador (`U-D-10` + `U-D-12`) | $27,187,607 | ✅ sí |
| Kepler rutas (`01-00N`) | $2,343,922 | ✅ sí |
| Kepler **mayoreo** (`U-D-8`) | **$10,260,464** | ⛔ no (`c62` vacío 98.84 %) |
| Wincaja (canales `wincaja_*`) | **$11,634,810** | ⛔ no (sin segundo testigo — §5) |
| **total `mv_sales_blended` 30 d** | **$53,654,281** | **≈55 % arbitrado** |

Publicar «el margen arbitrado de la empresa» sobre esa mezcla daría un número **sesgado hacia
arriba**, y se leería como *«el margen real era mucho mejor de lo que creíamos»*. Ése es el modo de
falla que esta fase existe para impedir.

**Regla que sale de acá, y va al `[MR.8.2]`:** el margen arbitrado se publica **por canal, con su
cobertura al lado**, o no se publica.

---

## 5. Lo que el árbitro dice donde sí mide

### 5.1 Contra el álgebra, por doctype (base **neta** de impuesto)

| doctype | venta bruta | venta neta | margen **árbitro** | margen **álgebra** | Δ |
|---|---|---|---|---|---|
| `U-D-10` | $25,923,189 | $23,757,581 | **14.91 %** | 10.75 % | **+4.16 pp** |
| `U-D-12` | $1,266,707 | $1,153,666 | **13.46 %** | 11.00 % | **+2.46 pp** |
| `U-D-8` | $97,231 | $88,794 | 10.83 % | 10.83 % | **+0.00 pp** ⚠️ |

⚠️ El `0.00` de `U-D-8` es sobre **121 renglones / $97 k**: no significa «acá el álgebra acierta»,
significa que no hay con qué opinar. Se lee como **NO MEDIDO**.

### 5.2 Por sucursal (`U-D-10`)

| suc | venta neta | árbitro | álgebra | Δ |
|---|---|---|---|---|
| 01 | $5,208,845 | 15.25 % | 10.77 % | +4.48 |
| 02 | $2,043,149 | 15.53 % | 10.89 % | +4.63 |
| 03 | $4,244,317 | **16.02 %** | 10.59 % | **+5.44** |
| 04 | $779,159 | 15.44 % | 10.98 % | +4.46 |
| 05 | $1,427,096 | **13.01 %** | 11.08 % | **+1.93** |
| 06 | $4,447,608 | 14.28 % | 10.94 % | +3.34 |
| 07 | $1,857,190 | 15.54 % | 10.62 % | +4.93 |
| 08 | $3,750,216 | 13.87 % | 10.45 % | +3.41 |

⭐ **La tabla se lee de arriba abajo en una columna y de golpe se entiende la fase:** el álgebra
mete a las ocho sucursales en una banda de **0.63 pp** (10.45 – 11.08 %); el árbitro las abre a
**3.01 pp** (13.01 – 16.02 %). El «spread por sucursal» que MR.5.10 publicó como hallazgo era
artefacto del método, y el desempeño real estaba tapado debajo.

### 5.3 Anti-espejo (ADR-059 R5)

Sobre 249 SKUs vendidos en ≥2 sucursales con ≥$5,000 de venta en cada una:

| | mediana del spread de margen entre sucursales |
|---|---|
| **árbitro** | **3.0310 pp** — 210 de 249 SKUs con spread > 1 pp |
| **álgebra** | **0.0000 pp** — ninguno |

Es la prueba de que el árbitro no es el markup con otro nombre. Un margen definido como
`m/(1+m/100)` **no puede** tener spread entre almacenes, pase lo que pase con el precio; el árbitro
lo tiene.

### 5.4 Aceptación `MR.7.2` y anti-recorte

| medida | resultado |
|---|---|
| líneas con `cogs > venta_neta` | **201 de 364,575 = 0.055 %** (baseline documentado: **7.4 %**) |
| dinero implicado | $8,670 |
| **`min(margen_línea) < 0`** | **TRUE** — peor línea **−294.8 %** |

El tercer renglón es el que importa: **hay venta bajo costo real**, así que nadie puso un piso
(`LEAST(cogs, importe)`) para pasar el gate. Un árbitro donde nadie vende nunca bajo costo está
recortado.

**El residuo, enumerado:**

| bucket | líneas | venta neta | COGS |
|---|---|---|---|
| a) costo > 3× venta (escalera sospechosa) | **5** | $1,222 | $4,773 |
| b) costo > venta (venta bajo costo plausible) | 196 | $28,236 | $33,355 |
| c) sano | 364,374 | $24,970,925 | $21,255,640 |

⭐ Y **`sin_q_vendida = 0` y `sin_factor = 0` en los tres buckets**: `c56` y `c58` están poblados en
el 100 % de este universo. El hueco `sin_escalera` que el plan anticipaba **no existe acá** — el
peldaño viene declarado en la línea.

---

## 6. La corrección que hizo falta: el impuesto

La primera versión del plan `[MR.8]` afirmó que «el denominador está limpio» porque `c13 = c12 × c9`
y la cabecera `kdm1.c16` cuadra al peso con la suma de renglones. **El razonamiento no probaba eso:**
que la cabecera iguale a la suma de líneas es compatible con que las líneas ya traigan el impuesto.

`docs/ERP_KEPLER.md:436-439` ya lo tenía escrito, y medido en una rebanada de `U-D-10`:

| `c17` (IVA) | `c18` (IEPS) | líneas | importe |
|---|---|---|---|
| 0 | **−8** | 5,268 | $391,429 |
| **−16** | 0 | 2,450 | $145,124 |
| 0 | 0 | 1,788 | $83,127 |

**El 81 % de las líneas lleva impuesto en el importe.** Costear un `c62` neto contra un `c13` bruto
infla el margen: en esa misma rebanada, **22.61 % sobre base bruta contra 15.96 % sobre base neta**
— 6.65 pp de aire. Todas las cifras de este documento están sobre **base neta por renglón**:

```
importe_neto = c13 / (1 + abs(c17)/100 + abs(c18)/100)
```

Es exacto y por línea: no hace falta prorratear el `c14`/`c15` del encabezado.

**Tres reglas que van al resolvedor:**
1. El árbitro calcula sobre base **neta**.
2. El **`%` publicado no se re-basa**: `cost = revenue/(1+markup)` es invariante de escala, el
   impuesto se cancela y el margen algebraico no sufre esto. Por eso el defecto era invisible.
3. ⛔ **Los pesos no se restan entre bases distintas.** `delta_amount = delta_pp/100 ×
   venta_publicada`, nunca `margen_publicado − margen_arbitrado` (uno bruto, otro neto).

⚠️ **Hallazgo aparte, sin medir a escala:** entonces la **venta** que publica la pantalla incluye
IVA e IEPS. En la rebanada el impuesto es el **7.9 %** del importe. El margen `%` no se mueve por
esto, pero el KPI «Venta 30 días» sí está por encima de la venta neta. **Queda abierto.**

---

## 7. Hipótesis que se cayeron en esta medición

### 7.1 ⛔ «El costo por renglón de Kepler no sirve para costear la venta»

`FASE_MR_COSTO_Y_UNIDAD` §3 lo descartó con `1 − SUM(c62·cant)/SUM(importe) = −261.79 %` y 7.4 % de
líneas con costo > venta. **Era un error de unidad en la medición, no un defecto de la fuente.**
`c62` es el costo de **una unidad del peldaño vendido** (`c62 = u1_cost × c58`), y se multiplicaba
por la cantidad **base** `c9` — que es `c56 × c58`. Sobrecuenta exactamente por el factor; por eso
el p99 de costo/venta daba 15.2, que es un factor de caja.

| multiplicando | margen | líneas costo > venta |
|---|---|---|
| `c62 × c9` (base) | **−388.57 %** | 763 de 9,505 (8.03 %) |
| `c62 × c56` (peldaño vendido) | **+15.96 %** | **1 de 9,505 (0.01 %)** |

### 7.2 ⛔ «`kdm2.c26` puede ser un atajo que evita la escalera»

`ERP_KEPLER.md:437` lo documenta como «el costo del renglón» y nadie lo había medido. Está poblado
(9,447 de 9,505) y su **mediana** contra `c62` es **1.0002** — es casi el mismo valor — pero
`Σ c26 × c56` da **−133.61 %** de margen: tiene colas que revientan la suma. **No es atajo.**

### 7.3 ⛔ «Wincaja puede tener árbitro propio con `valor_costo / cantidad_regular`»

Lo proponía la primera versión del plan. Es **exactamente lo que ya se publica**
(`mv_sales_blended.cost` ← `mv_wincaja_sales_daily.costo` ← `v_sales_lines.costo` ←
`detalles_mov_almacen.valor_costo`), y `Σ(valor_costo/qty × qty) = Σ valor_costo`. Arbitrarlo
consigo mismo es el espejo de `VERDAD_ABSOLUTA` §9.10.

A Wincaja **no le falta costo — le falta un segundo testigo**. Se declara
(`wincaja_costo_sin_testigo`, $11.63 M/30 d), no se fabrica.

### 7.4 ⛔ «Agregado dentro de 1 pp del ~12 % de Wincaja» como criterio de aceptación

Es la trampa `VERDAD_ABSOLUTA` §6.3: compara dos poblaciones con sucursales, canales y mezcla
distintas. Y Wincaja tiene **6.3 pp de spread interno** medido (`wincaja_ruta` 16.15 % vs
`wincaja_credito` 9.89 %). Un umbral de ±1 pp sobre eso es una coincidencia, no una prueba. Se
reemplaza por **comparación por SKU emparejado**, reportada como banda declarada, nunca como
compuerta de CI.

---

## 8. La llave del matview — resuelta, y no era la obvia

⛔ **La llave candidata del plan COLISIONA.** `(sucursal, almacén, doctype, folio, línea, fecha)`
da **34,375 colisiones** sobre 1,952,681 filas a 400 días. Sin llave única no hay
`REFRESH CONCURRENTLY`, y el matview dejaría la pantalla leyendo vacío durante cada refresh.

**Lo que falta es `c5` — la caja.** Con ella:

| llave | filas | llaves distintas | colisiones |
|---|---|---|---|
| sin `c5` | 1,952,681 | 1,918,306 | **34,375** |
| **con `c5`** | 1,952,732 | 1,952,732 | **0** |

Y las colisiones son exactamente lo que el proyecto ya tiene documentado: el **mismo folio y la
misma línea en cajas distintas**. En los cuatro buckets, el número de cajas distintas es **igual**
al número de filas colisionadas (2 filas → 2 cajas, 3 → 3, 4 → 4, 5 → 5). No es duplicación: es que
el folio se recicla por caja.

⭐ **Consecuencia directa para `[MR.8.2]`:** `analytics.v_erp_sales_line_units` **no expone `c5`**
(sus columnas de identidad son `sucursal, almacen_erp, doctype, folio, linea, fecha`). Un matview
construido sobre esa vista **no puede tener índice único**. O se le agrega `c5` en su propia
migración `CREATE OR REPLACE`, o el matview se arma directo desde `kdm1 ⋈ kdm2`.

**Llave definitiva:** `(tenant_id, sucursal, almacen_erp, doctype, caja, folio, linea)`, con sonda
`COUNT(*) = COUNT(DISTINCT …)` y `throw` dentro del `up` de la migración.

### Tamaño del poblado inicial

| | |
|---|---|
| ventana 400 días | 2025-10-03 → 2026-09-29 |
| líneas | **1,952,732** |
| importe | $156,815,221 |

⚠️ El importe de 400 días ($156.8 M) **no es 13× el de 30 días** ($39.8 M) porque las sucursales
entraron a Kepler de forma escalonada (`v_branch_erp_cutover`): los meses viejos tienen mucho menos
volumen Kepler. No es una anomalía.

⚠️ **La medición corre sobre un blanco móvil:** el conteo dio 1,952,681 / 1,952,727 / 1,952,732 en
tres corridas seguidas. El CDC del ODS escribe cada 15 s. La diferencia es de ~50 filas y no cambia
ninguna conclusión, pero el candado tiene que tolerarlo (no comparar conteos exactos entre consultas
separadas).

---

## 8bis. Lo que queda abierto

| # | Qué | Bloquea |
|---|---|---|
| A | **`EXPLAIN (ANALYZE, BUFFERS)` del cuerpo COMPLETO del matview a 400 días** — las consultas de esta medición tardan 5–17 s con los joins mínimos; falta medirlo con la escalera y el resto de las columnas, y decidir la ventana de poblado | `[MR.8.2]` |
| C | Explicar renglón por renglón el descuadre de **$251,361 (0.67 %)** entre el universo medido acá y la pierna Kepler de `mv_sales_blended` | `[MR.8.4]` (calibra el umbral) |
| D | La pierna de **rutas** de `mv_sales_blended` vale $4.83 M/30 d y los `01-00N` de `kdm2` valen $2.34 M. **No es 1:1** y no se investigó: la pierna sale de `sales_daily`, no del ODS. No se afirma que las rutas estén arbitradas hasta cerrar esto | `[MR.8.2]` |
| E | La **venta publicada incluye impuesto** (§6). Medirlo a escala y decidir qué se hace | — |

---

## 9. Cómo reproducir

Todo con `psql`/`pg` contra `DATABASE_URL_NEW`, read-only. El patrón de todas las consultas:

```sql
-- Maneja desde kdm1 por fecha (ix_kdm1_venta_fecha) y une por la PK COMPLETA de 7 columnas.
FROM kepler_ods.kdm1 h
JOIN kepler_ods.kdm2 l
  ON l.sucursal=h.sucursal AND l.c1=h.c1 AND l.c2=h.c2 AND l.c3=h.c3
 AND l.c4=h.c4 AND l.c5=h.c5 AND l.c6=h.c6
WHERE h.c2='U' AND h.c3='D'
  AND h.c9::date BETWEEN CURRENT_DATE-30 AND CURRENT_DATE
  AND btrim(h.c4::text) IN ('8','10','12')
  AND COALESCE(NULLIF(btrim(h.c43),''),'') <> 'C'
```

- **universo publicado**: agregar `AND btrim(l.c1)=btrim(l.sucursal)`
- **rutas**: cambiar a `AND btrim(l.c1) <> btrim(l.sucursal)`
- **COGS del árbitro**: `c62 × COALESCE(c56, c9)` — **nunca** `c62 × c9`
- **venta**: `c13 / (1 + abs(c17)/100 + abs(c18)/100)` — **nunca** `c13` pelado
- **margen del álgebra** (para contrastar): `1 − Σ(c13/(1+markup_pct/100)) / Σ c13`

---

## Referencias

- Plan de fase `[MR.8]` — el capítulo del margen en `docs/VERDAD_ABSOLUTA.md`
- [`FASE_MR_COSTO_Y_UNIDAD.md`](FASE_MR_COSTO_Y_UNIDAD.md) — el diagnóstico de 2026-08-31 que esta
  medición corrige en dos puntos (§7.1 y el estado de `MR.7.1`, que `U.5` cerró y el doc no marcó)
- [`FASE_MR_DICCIONARIO_MARGEN.md`](FASE_MR_DICCIONARIO_MARGEN.md) — ⚠️ su §2.1 afirma que el COGS
  es «el costo que registró el punto de venta», y eso es falso para el 69 % de la venta
- `docs/VERDAD_ABSOLUTA.md` §4 (el decode de `c55`–`c58`/`c62`), §9.10 (el espejo), §6.3 (comparar
  dos poblaciones)
- `docs/ERP_KEPLER.md:436-439` — `c17`/`c18` son las tasas de impuesto del renglón
