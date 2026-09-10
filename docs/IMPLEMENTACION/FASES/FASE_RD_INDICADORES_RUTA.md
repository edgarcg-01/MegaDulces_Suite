# Fase RD — Indicadores de Ruta Directa

> **Estado**: 🚀 EN PROD. Las 10 migraciones aplicadas a Railway el 2026-09-08 (RD.1–RD.8), con el
> `REFRESH CONCURRENTLY` de `mv_wincaja_sales_daily` y `mv_sellout_monthly` y los datos cargados.
> Falta **redeploy de api + view y re-login** (los 4 permisos nuevos viajan en el JWT).
> Sigue ⚠️ DECLARADO: el costo del Excel (§2.3) · el residuo de monto de Canindo y las rutas
> **502/505 sin agente** (§2.4a, 🟡 parcial desde el 2026-09-09) · la ruta 321 (§2.4b).
> **Orden de trabajo fijado por Edgar**: primero verdad absoluta del dato, después backend, el
> frontend al final. Capa por capa.

Automatiza `INDICADORES RD 2026.xlsx`, el tablero manual con el que se opera y **se paga** la Ruta
Directa (RD) de Padre Hidalgo, Canindo y Morelia.

`RD` = **Ruta Directa**. La cita literal está en el seed de puestos
(`database/migrations-newdb/20260820200000_identity_departments_positions.js:43`,
`['ruta_directa', 'Ruta Directa (RD)', 40]`) y en `KEPLER_CONTABILIDAD_MODELO.md:114-116`, donde
`R.D.` y `R.V.` (Ruta Vecinal) son los dos canales de ruta, clasificados por `kdm1.c6`.
`docs/GLOSSARY.md` no los definía.

---

## 1. El workbook

13 rutas, que son **exactamente** el universo Wincaja de `WINCAJA_MODELO_OPERATIVO.md` §1:

| Sucursal madre | Rutas |
|---|---|
| `10` Padre Hidalgo (Kepler `01`) | 21, 22, 23, 26, 27, 28 |
| `32` Morelia Madero | 321, 322 |
| `50` Canindo (Kepler `06`) | 501, 502, 503, 504, 505 |

11 hojas. `CONCENTRADO DE INFORMACIÓN` es la raíz (captura 100% manual: fecha × ruta × COSTO /
SUBTOTAL / VENTA / %); de ahí cuelga todo el resto por `SUMIFS` e `INDEX/MATCH`. El libro carga
**5,838 `#DIV/0!`**, 1 `#VALUE!` y 1 `#N/A`.

| Hoja | Grano | Rol | Qué se captura a mano |
|---|---|---|---|
| `CONCENTRADO DE INFORMACIÓN` | fecha × ruta | raíz de todo el libro | **todo** |
| `CONTROL DE GASTOS RD` | 1 fila / factura | gasto de flota (1,647 filas) | PERIODO, FECHA, RUTA, FACTURA/VALE, TIPO(1-6), PROVEEDOR, DESCRIPCION, **LITROS**, TOTAL, REMOTO |
| `COMISIONES` | quincena × ruta | tabulador → comisión → **A PAGAR** | fecha + periodo |
| `FORMATO DE PAGO` | recibo | comprobante del chofer | 2 celdas (ruta, periodo) |
| `OPERACION DE LAS RUTAS` | periodo × ruta | costo/km, $/litro, km/l, % rentabilidad | **KM INICIAL / KM FINAL** |
| `RESUMEN DE OPERACION DE RUTAS` | periodo × ruta | tablero de rentabilidad | periodo + ruta |
| `FORMATO DE SUPERVISOR` | recibo | bono del supervisor | 2 celdas |
| `COSTO RD PH` / `COSTO RD CANINDO` | ruta (5 bloques, stride 38/37) | ficha de costo fijo anual → **$/km** | importes anuales |
| `HOJA DE LLENADO OBJETIVO MENSUA` / `OBJETIVO MENSUAL RD` | periodo × ruta | objetivos y bono por cumplimiento | semanal |

---

## 2. Verdad del dato — lo medido

Reconciliación celda por celda del `CONCENTRADO` contra prod: **2,446 celdas ruta×día**, 13 rutas,
2026-01-02 → 2026-09-01. Scripts en el scratchpad de la sesión; los números están en los commits
`RD.1` y `RD.2`.

| | tramo Wincaja (ene→jun/ago) · 1,974 celdas | tramo push (jul→hoy) · 312 celdas |
|---|---|---|
| **SUBTOTAL** | ✅ **98.0% exacto** · Δ −0.230% | ⚠️ 73.4% dentro de ±1% · Δ +0.251% (derivado) |
| **VENTA** | ✅ **97.2% exacto** · Δ −0.233% | ✅ **94.9% exacto** · Δ +0.009% |
| **COSTO** | ❌ 14.1% exacto · Δ +1.213% | ❌ no existe en la fuente |

**La comisión reproduce el pago al centavo**, y no depende del costo: se calcula sobre SUBTEOTAL.
Verificado en `COMISIONES` quincena 1 ruta PH 21 — SUBTOTAL Excel `228,380.02` vs plataforma
`228,380.03`; `× 5% × 80% = 9,135.20` (`L5`), `× 20% = 2,283.80` (`K5`),
`A PAGAR = 9,135.20 − 3,484.96 = 5,650.24` (`N5`).

### 2.1 ✅ RD.1 — la fecha estaba corrida un día · `20260907280000`

`wincaja.maestro_mov_almacen.fecha` es `timestamptz` con la fecha *naive* del `.mdb` (Access guarda
la fecha sin hora; la hora vive aparte en `m.hora`, texto serial). RS.12b
(`20260805240000_wincaja_maestro_fecha_date_idx.js`, una migración de **performance**) introdujo
`fecha_mx_date(ts) = (ts AT TIME ZONE 'America/Mexico_City')::date` para poder indexar por expresión,
y declaró en su propio comentario:

> *"El contenedor ya corre en TZ MX, así que `fecha::date` (sesión) == `fecha_mx_date(fecha)` fila por
> fila ⇒ business_date NO cambia."*

Falso: el `TimeZone` del Postgres de prod es `Etc/UTC` y la vista se evalúa en la DB, no en el
contenedor de la app. **Medido: 100% de las filas — 21 sucursales, 542,684 documentos de 2026.**
En la frontera de mes, **$793,080** de venta de ruta caían en el mes equivocado (abr $201,525 · may
$202,652 · jun $227,032 · jul $83,173 · ago $79,698).

Tres árbitros independientes, los tres a favor de la fecha cruda:
1. El workbook (tecleado del reporte Wincaja): SUBTOTAL casa **98.0%** contra la fecha cruda y
   **0.0%** contra `fecha_mx_date`.
2. Día de la semana (rutas, ene–jun 2026): con `fecha_mx_date` las rutas **trabajaban domingo**
   (60,439 líneas) y **descansaban sábado** (105). Un reparto no descansa en sábado.
3. La mecánica de Access descrita arriba.

Arreglo: función nueva `wincaja.fecha_dia(ts) = (ts AT TIME ZONE 'UTC')::date`. **No** se reescribió
`fecha_mx_date` en su lugar — `CREATE OR REPLACE` de una función usada en un índice por expresión
deja el índice calculado con la definición vieja, y Postgres lo permite en silencio. Índices nuevos
`CONCURRENTLY` **antes** de repuntar la vista, viejos dropeados después: sin ventana sin índice, o
volvía el Seq Scan de 1.44 M filas que RS.12b existía para matar. `fecha_mx_date` queda con un
`COMMENT` que dice que corre el día; no se dropea.

Candado: `database/tests/test-newdb-wincaja-business-date.js`, en `run-all-tests.js`. Prueba negativa
corrida: **prod (sin arreglo) 3 fallas sustantivas · `.245` (con arreglo) 6 OK / 0 fallas / 2 NO
MEDIDOS**. Dos cosas salieron de correr el propio candado:
- La premisa **no** es "medianoche UTC": el offset de ingesta difiere por destino (prod medianoche
  UTC, `.245` medianoche MX). El arreglo funciona en los dos, pero la afirmación fuerte era falsa.
  Lo que se afirma ahora es lo que el arreglo necesita: campo date-only con offset fijo que no cruce
  el día UTC.
- Comparar `business_date` contra `(fecha AT TIME ZONE 'UTC')::date` es **circular** después del
  arreglo — es la misma expresión y no podría fallar nunca. Se reemplazó por la propiedad de fondo:
  que la expresión **no dependa del huso de la sesión**, que es de donde salió el defecto.
- El bloque de la matvista no puede comparar **montos** contra la vista: `mv_wincaja_sales_daily`
  lleva `JOIN products`/`JOIN warehouses` internos y es un universo más chico **por construcción**,
  así que daba rojo siempre sin medir nada. Usa el mismo árbitro de negocio.

⚠️ **Al aplicar a prod**: `REFRESH MATERIALIZED VIEW CONCURRENTLY` de `mv_wincaja_sales_daily` y
`mv_sellout_monthly`, re-correr `import-wincaja-routes-monthly.js` e
`import-canindo-routes-monthly.js`, y **re-medir `test-newdb-sellout-parity.js`**: VP.1 comparaba las
piernas Kepler y Wincaja en los cutovers de PH (`2026-06-26/29`) y Canindo (`2026-08-15`) con un día
de desfase artificial → medía un hueco/traslape que no existe, o tapaba uno que sí.

### 2.2 ✅ RD.2 — `importe` mezclaba neto y bruto · `20260907290000`

`analytics.v_route_sales_lines.importe` trae **cosas distintas según el tramo**:
- tramos Wincaja → `detalles_mov_almacen.valor_venta`, venta **SIN** impuestos;
- tramo push (`analytics.route_push_lines`: camionetas de PH desde 2026-06-29 + vecinales Kepler) →
  `mart.ventas.importe`, venta **CON** impuestos.

Probado: 312 celdas del tramo push, razón **1.0001** contra la columna VENTA del Excel. Cualquier
suma que cruce el cutover suma peras con manzanas, ~+9.9%.

**Ya afecta dinero**: `libs/commercial/.../route-promo.service.ts` usa `importe` para el umbral
`min_importe` del motor de incentivos **y** para resolver la unidad por precio (`importe/qty` contra
el precio de catálogo); `libs/logistics/.../route-adherence.service.ts:400` lo suma directo.

Por eso **`importe` no se tocó**: moverla cambiaría pagos y pantallas sin medirlo, que es
exactamente el pecado de RS.12b. En su lugar, `analytics.v_rd_route_daily` (vista, derive-no-copy)
deriva las dos formas y **rotula cuál es cuál**: `subtotal` + `subtotal_origen`, `venta` +
`venta_origen`, `costo` + `costo_status`.

**Las tasas.** En el tramo Wincaja el bruto se arma con la tasa de la **línea** (`d.iva`, `d.ieps`),
que son **PORCENTAJES** (16, 8, 0) y no montos — sumarlas no significa nada (los `896.00` que
aparecen al sumarlas son `16 × 56 líneas`). En el tramo push no hay tasa por línea y el neto se
**deriva**; se probaron las dos fuentes contra el Excel como árbitro (312 celdas):

| fuente de la tasa | escala | Δ vs Excel |
|---|---|---|
| `wincaja.articulos.iva_venta` / `ieps_venta` | porcentaje (16) | **+0.251%** ← se usa ésta |
| `catalog.products.iva_rate` / `ieps_rate` | fracción (0.16) | −2.011% |

⚠️ La escala difiere entre las dos fuentes. La primera pasada de esta medición dio −9.35% justamente
por no probar la unidad de los dos lados antes de dividir.

### 2.3 ⚠️ DECLARADO — el costo histórico de Wincaja no es estable (→ RD.3)

`COSTO` casa sólo **14.1%**. **No es un problema de fórmula**: en la **ruta 27 las tres columnas casan
al centavo** (141/150), así que el Excel copia las mismas tres expresiones que calculamos. La
diferencia está en el **valor** de `valor_costo`, y la causa está medida: el importer **reescribe
todas las líneas en cada corrida** — las 357k líneas de ruta, enero incluido, tienen `imported_at`
de hoy, un solo día distinto. Wincaja re-expresa el costo de ventas pasadas cuando se mueve su costo
promedio, y la réplica carga la re-expresión de hoy, no la que la persona vio en enero.

Descartado en el camino (todo medido contra la ruta 21, 2026-01-02, Excel `18,827.57`):
`valor_costo` `19,374.43` · `qty × costo_promedio` y `qty × ultimo_costo` `20,435.99` ·
`qty × costo_existencia` `57,201.75` · `costo/(1+ieps)` `18,391.54` · `costo/(1+iva)` `18,765.29` ·
`costo/(1+ambos)` `17,782.40` · el costo de otro día (0 de 150 con ±2 días) · un factor constante
(la razón varía 0.945–1.001 según el mix) · un segundo `source_dataset` (sólo existe `actual`).

**Consecuencia: hoy no existe un costo histórico reproducible de la venta en ruta. El margen de un
mes cerrado cambia solo, cada noche, sin que nadie toque nada.** El markup del Excel es
sospechosamente uniforme (18.1–19.3% en las 13 rutas) mientras el transaccional varía 14.9–19.2% —
las dos rutas donde coinciden (27 y 322) son justo las que casan.

**RD.3** es guardar el costo del día cuando se lee: el caso de *histórico/snapshot* que la regla #1
admite como tabla real. Hasta entonces `costo_status` lo rotula
(`erp_reexpresado_cada_corrida` / `sin_dato_en_la_fuente`) y **no se publica margen como si fuera
estable**.

### 2.4 ⚠️ DECLARADO — $2.78M del Excel sin ninguna fuente diaria

**160 celdas** del `CONCENTRADO` ($2,782,696 de subtotal) no tienen fuente a nivel día en la
plataforma. Dos causas, ninguna resuelta:

**(a) Canindo 501-505 desde el cutover del 2026-08-15 — 81 celdas, ~$1.77M.**
`import-canindo-routes-monthly.js` lleva esa pierna a `sales_by_route_monthly` leyendo la **réplica**
`kepler_md_06` *(así era hasta el 2026-09-10; hoy compone push + Wincaja — ver el cierre de abajo)*,
pero sólo al grano **mensual**: no hay línea diaria. Y derivarla del ODS no alcanza
hoy. Medido en `kepler_ods` (`sucursal='06'`, `c2='U' c3='D' c4=10`, join por la llave **completa**
`c1..c6` + `sucursal`, excluyendo `c8 IN ('00001','00002')`):

| ruta | días en el Excel | días en el ODS | Excel | ODS | cobertura |
|---|---|---|---|---|---|
| 501 | 27 | 3 | $468,954 | $105,457 | 22.5% |
| 502 | 25 | 12 | $489,637 | $256,922 | 52.5% |
| 503 | 27 | 2 | $612,460 | $46,294 | 7.6% |
| 504 | 27 | **0** | $462,694 | $0 | **0%** |
| 505 | 27 | **0** | $386,648 | $0 | **0%** |
| | | | **$2,420,393** | **$408,673** | **16.9%** |

El decode vigente (`c67 ~ '^500[1-9]$'`, *"confirmado con Edgar 2026-08-18"*) ya no explica el dato:
504 y 505 no aparecen en absoluto. La venta total de la sucursal 06 en agosto (`U/D/10`, todos los
`c67`) es **$2,780,204** en 4,397 docs, de los cuales `50C01`+`50C02` —que el decode llama *caja de
piso*— concentran **4,093 docs**, y `5050` —que el decode excluye como *mayoreo/transfer, a
reconciliar*— tiene 1,174 docs con `c12='30001'` en 976 de ellos. Es decir: el dinero está en la
sucursal, pero **bajo un `c67` que el decode no reconoce como ruta**.

⚠️ Se para acá y se declara, como manda la regla de fuentes: *si la fuente no alcanza para decidir,
declararlo — no improvisar*. **Necesita a Edgar**: ¿el encoding `c67` cambió después del 18-ago, o
las rutas de Canindo facturan por caja (`50C0N`)?

#### ✅ 2026-09-09 — (a) se destrabó por otro lado: el PUSH de las vans, no el decode del branch

La pregunta del `c67` quedó **sin contestar y ya no bloquea**. Las **cinco** vans de Canindo recibieron
el **agente de push** —cada camioneta corre su propio Kepler local y sube su venta al runner `.249`
cada 15 min— así que la venta llega a nivel **línea y día** sin pasar por la réplica del branch ni por
el decode de `c67`. Detalle operativo en
[`RUNBOOK_ALTA_CAMIONETA.md`](../../../database/importers/kepler/route-push/RUNBOOK_ALTA_CAMIONETA.md)
y [`INVENTARIO_Y_PLAN_RUTAS.md`](../../../database/importers/kepler/route-push/INVENTARIO_Y_PLAN_RUTAS.md) §1.5–1.6.

Agosto 2026, `analytics.v_rd_route_daily` contra las mismas celdas del Excel de la tabla de arriba:

| ruta | días (Excel 27) | SUBTOTAL Excel | plataforma | cobertura | antes (ODS) |
|---|---:|---:|---:|---:|---:|
| 501 | 26 (16 push + 10 wincaja) | $468,954 | $401,951 | **85.7%** | 22.5% |
| 502 | 25 (16 + 9) | $489,637 | $413,726 | **84.5%** | 52.5% |
| 503 | 27 (17 + 10) | $612,460 | $524,330 | **85.6%** | 7.6% |
| 504 | 26 (17 + 9) | $462,694 | $382,428 | **82.7%** | **0%** |
| 505 | 27 (18 + 9) | $386,648 | $327,110 | **84.6%** | **0%** |
| | | **$2,420,393** | **$2,049,545** | **84.7%** | **16.9%** |

Lo que esto cierra y lo que **no**:

- ✅ **Cerrado el hueco de cobertura**: los días están (25–27 de 27 en las cinco rutas, antes 0–12) y
  el monto pasó de **16.9% a 84.7%**. Ninguna ruta de Canindo queda ya sin fuente diaria.
- ⚠️ **El residuo del ~15% es SISTEMÁTICO, no un hueco por ruta.** Con tres rutas podía ser
  coincidencia; con las cinco cayendo en una banda de tres puntos (**82.7% – 85.7%**) es estructural:
  el `CONCENTRADO` captura consistentemente más que nuestro SUBTOTAL. **Ese residuo no lo explica este
  cambio** y refuerza —no resuelve— la duda de §2.3: *¿qué reporte de Wincaja se teclea?* No se dibuja
  como cerrado.

#### ✅ 2026-09-10 — el MENSUAL también: la serie se compone, la réplica sale del camino

El arreglo de arriba dejó la pierna **diaria** bien (`v_rd_route_daily` une push + Wincaja con su
columna `source`), pero el **mensual** —`analytics.sales_by_route_monthly`, que es lo que publica
`/comercial/ventas-por-ruta`— seguía resolviendo la misma llave con un `GREATEST` entre tres
universos. Dos superficies del mismo negocio contándose distinto. Medido y corregido:

- La **réplica `kepler_md_06` no arbitra nada** y sale del camino de escritura (queda de testigo en
  `reconcile-route-provenance.js`): ve 3 de 5 rutas en ventanas sueltas — es la misma tabla de
  cobertura 22.5/52.5/7.6/0/0% de §2.4a, ahora leída como veredicto sobre la **fuente**, no sobre el
  dato.
- El `GREATEST` publicaba, en el mes del cutover, **el máximo de dos mitades disjuntas en vez de su
  suma**: faltaban **$808,409** de agosto. La pantalla mostraba $1.36M contra $2.20M de julio.
- Enero–julio estaba congelado **pre RD.1** (la fecha de negocio corrida un día): Canindo fue la
  única ruta Wincaja que no se re-escribió tras aquel arreglo, porque `import-wincaja-routes-monthly`
  la excluye. Se probó re-agregando con la atribución vieja: **31 de 31 llaves al peso**.
- Frontera **medida** por ruta (último día de Wincaja + 1): 501/503 el 13-ago, 502/504/505 el 12-ago.
  Gold de Canindo **$15,815,691 → $16,544,403**; agosto **$2,167,374**, plano contra julio.

Detalle y regla general en [`VERDAD_ABSOLUTA.md` §4.6](../../VERDAD_ABSOLUTA.md). ⚠️ El residuo
sistemático del ~15% contra el `CONCENTRADO` (§2.3) **no lo toca esto** y sigue abierto.

**(b) Ruta 321 en jun/jul — 34 celdas, $573,693.** Se congeló en Wincaja el 2026-06-02 y el Excel
siguió capturando hasta julio. **Sigue abierto** — es un `.mdb` que dejó de copiarse.

⚠️ Mientras 502/505 no tengan agente, cualquier cifra de Canindo de agosto en adelante sale
incompleta **para esas dos rutas**. Lo que no se puede medir se **declara**, no se dibuja como cero:
`v_rd_route_daily` las devuelve con `costo_status='sin_dato_en_la_fuente'`.

---

## 3. Reglas de negocio extraídas del libro (lo que el motor tiene que replicar)

### 3.1 Tabulador de comisión — **idéntico en las 13 rutas**

| Total Venta del periodo | % |
|---|---|
| < 189,999.99 | `N/A` (no se paga) |
| 189,999.99 – 194,999.98 | **3.750%** |
| 194,999.99 – 199,999.98 | **4.250%** |
| 199,999.99 – 215,999.98 | **4.562%** |
| 215,999.99 – 399,999.99 | **5.000%** |
| ≥ 400,000 | *(el Excel no tiene rama → devuelve `FALSE` → comisión 0)* |

Base = **SUBTOTAL**. Reparto **supervisor 20% · chofer 80%**. `A PAGAR = comisión − NOMINA BANCO`.
Compuerta por **TOTAL VENTA**. Periodo = quincena de 14 días (`B96 = B95+14`, arranca `2026-01-14`,
27 periodos).

### 3.2 Bonos del chofer (por TOTAL VENTA del periodo)
Lavadas **$200** si ≥ 215,999.99 · Lonche **$800** si ≥ 239,999.99 · Chalán **$1,000** si ≥ 259,999.99.

### 3.3 Bono del supervisor — por **margen** alcanzado
`21–28: > 25% → $500` · `501: > 16.499% → $600` · `502: > 15.299%` · `503: > 14.499%` ·
`504/505: > 16.499%`. Compuerta adicional `TOTAL VENTA > 189,999`. Factor supervisor **20%**.

⚠️ Este bono depende del **margen**, y el margen depende del costo de §2.3. Con el costo del Excel el
margen lee 17–19% y las 5 rutas de Canindo pasan (`B32 = SUM(G19:G23) = 2,400`); con el
transaccional (~14%) ninguna pasaría. `[por medir: el gap se verificó en la ruta 21 (PH); falta
medirlo en 501-505]`. El bono de PH (`>25%`) es **inalcanzable** con márgenes de 17–19%.

### 3.4 Costo fijo anual por ruta → el insumo del $/km

| | 21 | 22 | 23 | 26 | 27 | 501 | 502 | 503 | 504 | 505 |
|---|---|---|---|---|---|---|---|---|---|---|
| TOTAL GF | 133,271 | 126,938 | 134,762 | 133,271 | 133,271 | 206,047 | 206,047 | 204,746 | 148,444 | 148,444 |
| TOTAL GV | 26,000 | 26,000 | 26,000 | 26,000 | 26,000 | 26,000 | 26,000 | 26,000 | 26,000 | 26,000 |
| TOTAL GA | 4,500 | 4,500 | 4,500 | 4,500 | 4,500 | 41,755 | 41,755 | 41,755 | 41,755 | 41,755 |
| **TOTAL** | **163,771** | 157,438 | 165,262 | 163,771 | 163,771 | **273,802** | 273,802 | 272,501 | 216,199 | 216,199 |
| KM base | 24,000 | 21,000 | 27,000 | 21,500 | 21,500 | 30,000 | 30,000 | 30,000 | 30,000 | 30,000 |
| **$/km** | **6.82** | 7.50 | 6.12 | 7.62 | 7.62 | **9.13** | 9.13 | 9.08 | 7.21 | 7.21 |

Prorrateos: `/52` semana · `×2` quincena · `/12` mes · `/2` semestre · `/KM base` → $/km.
Conceptos GF: placas+refrendo+verificación (2,267 en todas) · arrendamiento · pensión · GPS Telcel ·
GPS Salvador (3,500) · seguro de mercancía · seguro del vehículo · **salarios** (80,080 PH /
112,580 Canindo). **Faltan fichas de 28, 321 y 322.**

### 3.5 Catálogo de tipo de gasto (`CONTROL DE GASTOS RD`)
`1` PLACAS/ARRENDAMIENTOS/VERIFICACION · `2` ARRENDAMIENTOS/OTROS · `3` NEUMATICOS/LUBRICANTES/
BATERIAS · `4` COMBUSTIBLES · `5` SEGUROS/GPS · `6` REPARACIONES Y SERVICIOS.

---

## 4. Errores del Excel que **no** se migran

Patrón CB: **rediseñar, no migrar**. Los que mueven dinero:

| # | Hoja | Defecto | Efecto |
|---|---|---|---|
| 4.1 | `FORMATO DE SUPERVISOR` | `T25:T29` leen la col **G (Bono)** en vez de **E (Comisión)**, y `Q37=(Q34−Q35)+Q36` vuelve a sumar el bono | **doble conteo: paga 4,800 cuando el bono es 2,400** |
| 4.2 | `COMISIONES` | Ruta **322**: `T154/T155` vacías → factor supervisor vacío | el chofer cobra **100%**, el supervisor **0** |
| 4.3 | `COMISIONES` | Bloque **MORELIA corrido +1 fila** (`E153` suma la fila de rótulos) | 321/322 con el periodo equivocado |
| 4.4 | `COMISIONES` | Umbral de `A PAGAR`: `>189,999.99` en 11 rutas, **`>169,999.99` en 22 y 23** | 22 y 23 cobran en un tramo donde el resto no |
| 4.5 | `COMISIONES` | Factor del supervisor anclado a **fila fija** (`I97`,`I98`,`I126`,`I154/155`), no a la del periodo | hoy inocuo (todos 0.20); rompe en silencio al cambiar |
| 4.6 | `COMISIONES` | Tabulador **sin rama `else`** ≥ 400,000 | comisión 0 en la venta más alta. Latente (máx. observado ~$260k) |
| 4.7 | varias | `NOMINA BANCO` con **6 valores** para el mismo concepto: `3,484.96` · `5,000` · `4,413.08` · `4,260` · `4,260.80` · `3,632`/`3,200.58` | el neto depende de qué hoja se imprima |
| 4.8 | `FORMATO DE SUPERVISOR` | `B31 = SUM(G13:G17)` **excluye la ruta 28** | bono del supervisor PH subvaluado |
| 4.9 | `OBJETIVO MENSUAL RD` | VECINAL 1 y 2 **hardcodeadas** (`AL5="CUMPLIDO"` literal, `AK5=40`) → `% Bono = 0.5` fijo | **$500/ruta pagados sobre dato inventado** |
| 4.10 | `HOJA DE LLENADO` | La ruta **23** lee `BW142`/`BW11`, mitad derecha de un par fusionado, **siempre vacía** | la ruta 23 nunca puede cumplir |

Y los que rompen el tablero: `OPERACION!K5` (COSTO FIJO X KM) hace `SUMIF(E5,"21",$B$8)` leyendo la
**columna PERIODO de su propia hoja** → **$/km = 1** en vez de 6.82–9.13 · las fichas
`COSTO RD PH/CANINDO` **no alimentan nada** (su col `O` de $/km no se referencia desde ninguna
parte) · `RESUMEN` tiene la matriz `% DE UTILIDAD` con el mapeo ruta→columna **barajado desde la
fila 132** (503 y 504 apuntan a la misma columna: periodo 2 devuelve `0.1850188151` para ambas) →
utilidad bruta mal en **6 rutas × 25 de 26 periodos** · el bloque `W:AA` de `RESUMEN` está
**desplazado 2 columnas** → `COSTO DE LA OPERACION = 0` en toda la hoja (periodo 1:
`W293 = Y293 = 315,629.69`, `X293 = 0`) · SUMIFS que cubren `$3:$235` cuando la tabla llega a 287 →
periodos 22-26 truncados · `J157 = SUMIFS(#REF!,…)`.

**Tres maestros de choferes y ninguno concuerda** (ruta 27: `Mariano Martinez Patlan` en `FORMATO DE
PAGO` vs `ANGEL ALBERTO VAZQUEZ MEJIA` —el supervisor— en `COSTO RD PH`); RFC/CURP/NSS de la **322
idénticos a la 321**; **VINs duplicados** (PH 26=PH 27, CAN 504=505, CAN 503=**PH 22**). Las hojas
10-11 son de **2021**, con calendario de 28 días y supervisores que ya no existen → no se migran.

---

## 5. Lo que ya existe (reusar, no rehacer)

| Pieza | Objeto / archivo | Filas en prod |
|---|---|---|
| Venta por ruta a nivel línea | `analytics.v_route_sales_lines` (`20260831120000`) | ✅ |
| Venta por ruta mensual | `analytics.sales_by_route_monthly` | 23 rutas, ene→sep 2026 |
| **Feeds de ruta INTRADÍA (~1h)** | `run-prod-feeds.js:101-108` — `import-route-push-monthly`, `import-route-push-lines`, `import-kepler-vecinal-routes` | ✅ fresco a ~1h |
| **Dead-man de frescura propio** | `db-health.service.ts:444-456` — key `route_sales`, warn 3h / crit 8h, filtra `WIN-%` | ✅ |
| Reporte y endpoints RR | `salesByRoute()`, `salesByRouteDetail()`, `routeClosureReconciliation()` en `commercial-analytics.service.ts` | ✅ |
| Tool de LLM | `thot_sales_by_route` en `thot-tools.service.ts:500-536` | ✅ |
| Pantalla | `comercial-ventas-por-ruta.component.ts` + tab en `reports-tabs.ts` | ✅ |
| **Cockpit ruta×día con km/L y $/km** | `fleet-productivity.service.ts::cockpitForDay(date, fleet='route')` | ✅ (LTV.19) |
| Km por vehículo×día (GPS) | `logistics.vehicle_day_summary` | 1,281 · **sólo desde 2026-07-27** |
| Catálogo de las 13 rutas | `wincaja.branches (is_route)` + `commercial.warehouses (kind='truck')` | ✅ |
| Choferes | `logistics.drivers` + `/logistica/staff` | 56 |
| Parámetros financieros | `logistics.config_finance` + CRUD en `logistics-config.service.ts:122-190` | 26 |
| Odómetro check-in/out | `logistics.vehicle_usage_logs` | **0** 🔴 |
| Combustible por vehículo | `logistics.fuel_transactions` | **0** 🔴 |
| Captura por ruta con OCR | `commercial.route_tickets` | **5** 🔴 |
| Metas de venta (BI.9) | `commercial.sales_targets`, `scope ∈ {total,branch,channel}` | **no está en prod** |

**El dato del workbook no está duplicado en ningún lado: las tablas diseñadas para alojarlo están
vacías.** Carga limpia, sin conflicto de migración. El GPS sólo da km **desde 2026-07-27**; el Excel
trae odómetro desde enero → se complementan.

**Esto cierra LTV.2.** `FASE_LTV_VALOR_FLOTA.md:137-173` diseñó *"Costo real y ROI por
entrega/ruta/cliente"* —`$/entrega`, costo-por-km, margen por ruta— y su bloqueo declarado
(`:171-173`) es *"hoy `fuel_transactions` puede estar vacía"*. **Está vacía (0 filas, medido).** El
workbook es ese dato faltante.

**No existe** (verificado con grep): nivel `'route'` en el Motor de Rentabilidad · `scope='route'` en
`sales_targets` · tabulador de comisiones **de venta** · gastos con categorías neumáticos/seguros/
tenencia/verificación · `analytics.delivery_cost_daily`.

---

## 6. Plan

| Sprint | Qué | Estado |
|---|---|---|
| **RD.1** | Arreglar la fecha de negocio de Wincaja + candado | ✅ `20260907280000` (local; prod pendiente) |
| **RD.2** | `analytics.v_rd_route_daily` — venta por ruta×día con procedencia | ✅ `20260907290000` (local; prod pendiente) |
| **RD.0** | Este documento + `GLOSSARY` + ADR + tracker | 🔨 |
| **RD.6** | Motor de comisiones: escalas versionadas en DB + corrida persistida (borrador→aprobado→pagado) | ✅ `20260908120000/120100/120200` |
| **RD.4** | Gasto de flota: `logistics.route_expenses` + catálogo + importer + captura web + permisos | ✅ `20260908130000/130100` |
| **RD.3** | Snapshot del costo (cierra §2.3) — `analytics.route_cost_snapshot` + `v_route_cost_resolved` | ✅ `20260908140000` |
| **RD.5** | Odómetro + costo fijo + `analytics.v_route_operation_period` | ✅ `20260908160000` |
| **RD.7** | Objetivo por ruta: `'route'` en `commercial.sales_targets` | ✅ `20260908170000` |
| **RD.8** | Pantalla `/comercial/comisiones` (tab "Comisiones RD") | ✅ |
| **RD.2b** | Cerrar el hueco de Canindo (§2.4a) — **destrabado por el push de las vans, no por el decode**: las **5** con línea diaria, cobertura de agosto **16.9% → 84.7%**, hueco runner-vs-plataforma **$0**. Queda el residuo **sistemático** del ~15% (las 5 rutas en banda 82.7–85.7%), que es §2.3, no un hueco de fuente | ✅ 2026-09-09 |
| **RD.2c** | El puente runner→plataforma perdía a toda van nueva (watermark **global** en `import-route-push-lines.js`): **$1,266,037** parados sin ningún error. Watermark **por ruta** + detección de **hueco frontal** que converge | ✅ 2026-09-09 |

**Orden** (jerarquía de importancia, decidida con Edgar): capa de datos primero (RD.1 ✅, RD.2 ✅),
después **RD.6** ✅ porque es el que reemplaza trabajo que se paga y **no depende de ningún hueco**,
luego RD.4 y RD.3, y el frontend al final (RD.8).

### RD.6 — lo medido

Alimentado con el SUBTOTAL/VENTA del **propio Excel**, el motor reproduce **163 de 163** celdas
periodo×ruta **al centavo**, en las cinco columnas: % del tabulador, comisión del chofer, parte del
supervisor, nómina de banco y `A PAGAR`. La aritmética no está en duda.

End-to-end contra la venta derivada del ERP baja a **72%**, y esa diferencia es del **dato**, no del
motor — tramo push con subtotal derivado (±1%), las 40 celdas que el Excel parchea a mano y las 160
sin fuente diaria (§2.2 y §2.4). Se separaron a propósito las dos mediciones para poder afirmar cuál
de las dos cosas falla.

Confirmó además la elección de nómina de banco de §4.7: **3,484.96** en PH/Morelia y **5,000** en
Canindo son los valores de la hoja `COMISIONES`, la que produce `A PAGAR`. Los otros cuatro valores
del libro no reproducen el pago.

Candado `test-newdb-rd-commissions.js`: **34 OK / 0 fallas / 0 NO MEDIDOS**. Cada corrección de §4
tiene ahí su prueba negativa (una venta de $400,000 paga 5% y no cero; $175,000 no paga; la 505
queda sin chofer declarado y no inventado; el permiso llegó a un rol y a pocos).

⚠️ **Pendiente de modelar**: la deducción del supervisor es **por persona y agregada** sobre sus
rutas (`COMISIONES!K95 = 4,260`, otro de los seis valores de nómina), no por ruta. La línea de
supervisor trae hoy la *contribución* de cada ruta con `nomina_banco = 0`; el neto por persona lo
arma quien consuma. No se reparte la deducción entre rutas para no inventar una regla que el Excel
no tiene.

### Verificación

| Sprint | Cómo se comprueba |
|---|---|
| RD.1 | Revenue por mes×ruta antes/después; el delta es sólo el día. Prueba negativa del día de la semana. `test-newdb-sellout-parity.js` con traslape y hueco **medidos** |
| RD.2 | La tabla de §2 — SUBTOTAL 98.0% / VENTA 97.2% exactos contra 1,974 celdas del workbook |
| RD.4 | `Σ TOTAL` y `Σ LITROS` del importer == los `SUMIFS` del Excel por ruta y por tipo (`Z7 = 507,341.34` para COMBUSTIBLES es el ancla). Re-run idempotente = 0 filas nuevas |
| RD.5 | `cost_per_km` vs los `$/km` de §3.4 (6.82–9.13). Cobertura de `km_source` **en pantalla** |
| RD.6 | `A PAGAR` del motor vs el Excel, ruta por ruta y periodo por periodo; cada diferencia apuntando a un ítem de §4 |

**Un gate sin prueba negativa es una intención**: cada compuerta (umbral de comisión, RLS, permiso)
se rompe a propósito una vez y se verifica el rojo.

---

## 7. Lo entregado, con su medición

| Sprint | Qué quedó | Cómo se comprobó |
|---|---|---|
| **RD.1** | `wincaja.fecha_dia()` + índices nuevos + candado | 542,684 docs corridos un día. Prod (sin arreglo) 3 fallas · `.245` (con) 6 OK / 2 NO MEDIDOS |
| **RD.2** | `analytics.v_rd_route_daily` con `subtotal_origen` / `venta_origen` / `costo_status` | SUBTOTAL **98.0%** exacto · VENTA **97.2%** · 2,286 celdas |
| **RD.6** | 7 tablas de comisión + motor + `/comercial/comisiones` | **163/163 al centavo** con el input del Excel · candado **34/34** |
| **RD.4** | `logistics.route_expenses` + catálogo + importer + captura web | **782 filas, $848,610.04, 34,718.24 lts** al centavo contra la columna cruda · idempotente 782→782 · candado **16/16** |
| **RD.3** | `analytics.route_cost_snapshot` + `v_route_cost_resolved` | 2,446 observaciones del Excel cargadas ($35,212,581) · el resolvedor declara `solo_captura` en las 2,446 |
| **RD.5** | `logistics.route_odometer` + `v_route_operation_period` + costo fijo en `config_finance` | `$/km` **6.12–9.13** exacto contra la columna que el libro no consumía (el Excel da **1**) · 160/175 lecturas en banda · `costo_status` declara 16 sin ficha |
| **RD.7** | `scope='route'` en `commercial.sales_targets` | migración idempotente; el `down()` se niega si hay metas de ruta |
| **RD.8** | `/comercial/comisiones`, tab "Comisiones RD" | `nx build view` OK |

**Migraciones**: 8, todas aplicadas en `.245`. **Builds** api + view verdes. **Candados** en la
suite: 3 archivos nuevos, 56 aserciones.

### Lo que se corrigió del Excel, y lo que costaba

| Defecto del libro | Efecto que tenía | Estado |
|---|---|---|
| Tabulador sin rama `else` sobre $400,000 | comisión **cero** en la venta más alta | corregido + prueba negativa |
| Umbral `169,999.99` sólo en rutas 22 y 23 | esas dos cobraban en un tramo donde el resto no | un solo umbral |
| Factor del supervisor anclado a fila fija | todos los periodos usaban el factor de uno | vive en la escala |
| Ruta 322 sin factor de supervisor | el chofer cobraba el **100%** | config por ruta |
| `NOMINA BANCO` con **6 valores** | el neto dependía de qué hoja se imprimiera | uno por zona, y los 163/163 lo confirman |
| Ruta 28 fuera del rango del bono | bono del supervisor PH subvaluado | alcance por config |
| `OPERACION!K5` → `$/km = 1` | `COSTO POR KM` y `% RENTABILIDAD` mal en todo el tablero | derivado de la ficha |
| `Z7` suma rutas 24/25/300/301 inexistentes | subdeclaraba el combustible **$332,000** | el árbitro es la columna cruda |
| `RESUMEN`: matriz `%` barajada desde la fila 132 | utilidad bruta mal en 6 rutas × 25 de 26 periodos | la hoja no se migró |
| `RESUMEN`: bloque `W:AA` desplazado 2 columnas | `COSTO DE LA OPERACION = 0` en toda la hoja | la hoja no se migró |
| `OBJETIVO MENSUAL`: `"CUMPLIDO"` hardcodeado | **$500/ruta pagados sobre dato inventado** | no se migró |

---

## 8. Pendiente operativo (prod)

Las 8 migraciones están **sólo en `.245`**. Para llevarlo a prod:

1. **Push** de los commits de RD (van locales).
2. **Aplicar las 8 migraciones** una por una (`apply-one-migration-prod.js`), no `migrate:latest`:
   hay migraciones de otros devs pendientes allá.
3. **Después de RD.1, obligatorio**: `REFRESH MATERIALIZED VIEW CONCURRENTLY` de
   `analytics.mv_wincaja_sales_daily` y `analytics.mv_sellout_monthly`; re-correr
   `import-wincaja-routes-monthly.js` e `import-canindo-routes-monthly.js`; y **re-medir**
   `test-newdb-sellout-parity.js` — VP.1 comparaba las piernas Kepler/Wincaja en los cutovers con un
   día de desfase artificial, así que medía un hueco que no existe o tapaba uno que sí.
4. **Correr los cargadores** (leen el workbook, así que van desde una máquina que lo tenga):
   `import-route-expenses.js --apply` · `snapshot-route-cost.js --excel --apply` · el del odómetro.
5. **Agendar** `snapshot-route-cost.js --erp --apply` (diario). Es lo que empieza a medir la deriva
   del costo; sin eso RD.3 queda con una sola fuente.
6. **Redeploy** api + view y **re-login**: los 4 permisos nuevos viajan en el JWT.

---

## 9. Dudas abiertas

Ordenadas por lo que bloquean. Ninguna detuvo la construcción — todo lo que dependía de ellas quedó
**declarado** en el dato, no dibujado como cero.

### 9.0 Respuestas del negocio — 2026-09-09

| # | Respuesta | Qué implica |
|---|---|---|
| **9.4** comisiones | ✅ **Aceptar la corrección** | El motor publica su cifra; la primera corrida **va a diferir del Excel** en 22/23, 322, 28 y en cualquier periodo sobre $400,000. Es lo que ya hace: **nada que construir**, queda autorizado a correr |
| **9.9** objetivo mensual | ✅ **Se rehace** | Los tres KPIs de trade se reconstruyen sobre el **calendario quincenal** (27 periodos), no sobre los 13 de 28 días de 2021. **Sprint nuevo** |
| **9.7** odómetro · **9.8** gastos sin tipo | ✅ **Se corrige desde la UI y se captura manual** | ⚠️ **Esa UI no existe todavía**: hay `logistics-route-expenses.service.ts` pero **ningún componente** en `apps/view`. Es el trabajo que esta respuesta desbloquea, no algo ya disponible |
| **9.10** maestros de choferes | ✅ **Hacer que concuerden** | El maestro sembrado ya es coherente (el "conflicto" de la 27 eran chofer y **supervisor**, dos roles). Falta **una sola celda**: el chofer de la **505** |
| **9.3** costo oficial | 🟡 **"Puede ser variable y cambia"** | Confirma el diseño: la vista devuelve **las dos cifras y su brecha, sin elegir**. Sigue abierto **qué usa el margen publicado** — y de eso cuelga el bono del supervisor de Canindo (§3.3) |
| **9.5** deducción del supervisor | ⏸️ **No inventar; queda como duda** | Se mantiene como está: contribución por ruta con `nomina_banco = 0` y el neto sumado en el pie |
| **9.1** POS de Canindo | ⏸️ **"No lo sé"** | Sigue abierta. Ya no bloquea la venta de ruta (el push la rodeó); sí impide separar la venta de **piso** |
| **9.2** Morelia · **9.6** fichas 321/322 | ⏸️ **FUERA DE ALCANCE por decisión** | *"Por el momento no hablemos nada relacionado a 321 y 322."* Los $573,693 de jun–jul y la serie de esas dos rutas quedan **congelados a propósito**, no olvidados. §9.6 se reduce a la **ruta 28** |

> 📌 Leí *"322 y 231"* como **322 y 321** (no existe una ruta 231; 321/322 son el par de Morelia).
> Si la intención era otra, corregir acá.

### 9.1 ⛔ Canindo: ¿por qué el ERP dejó de distinguir la ruta del mostrador?

**Bloquea** ~$1.77M de agosto en adelante, y con eso la comisión de 501-505 de esos periodos.

El catálogo `kduv` de la sucursal 06 **sí tiene** los cinco vendedores de ruta (`00501` Victor Zalapa
… `00505` Francico Martinez). Pero de los **6,194 documentos** de venta (`U/D/10`) desde el 13-ago,
**uno solo** los usa: 4,911 dicen `c12='30001'` = *SUCURSAL CANINDO PISO* y 1,282 vienen en blanco. El
dinero está en `c67 = 50C01` ($1.26M) y `50C02` ($1.29M), las cajas de piso.

O el POS de Canindo dejó de pedir el vendedor al facturar en ruta, o el encoding `c67` cambió después
del 2026-08-18 (cuando se confirmó `c67 ~ '^500[1-9]$'`). **No es un problema de decodificación: el
detalle por ruta no existe en la fuente.** El arreglo es operativo, no técnico.

> ✅ **2026-09-09 — el arreglo operativo llegó, y la pregunta sigue sin contestar (ya sin bloquear).**
> Se instaló el **agente de push** en las **cinco** vans: cada camioneta sube la venta de **su propio
> Kepler local** al runner, así que el detalle por ruta ya no depende de que el POS central capture el
> vendedor. Cobertura de agosto **16.9% → 84.7%** (§2.4a), hueco runner-vs-plataforma **$0**.
> Lo que queda no es este hueco sino el **residuo sistemático del ~15%**, que pertenece a §9.3/§2.3.
> La pregunta de por qué el POS dejó de distinguir ruta de mostrador **sigue abierta** y vale la pena
> contestarla: mientras no se conteste, la venta de piso de Canindo tampoco se puede separar.

### 9.2 ⛔ Morelia 321/322: ¿de dónde teclea la persona lo que nosotros no tenemos?

**Bloquea** $573,693 de jun–jul, y la serie de esas dos rutas hacia adelante.

Los 13 `.mdb` de ruta en `Z:\Salidas\Bases\Actuales` están congelados, y la fecha de 321/322
—**02-jul-2026**— es exactamente donde se corta nuestro dato. Para PH (09-jul) y Canindo (15-17 ago)
el congelamiento es correcto porque migraron al push y a Kepler. **321/322 no migraron a nada y siguen
vendiendo**: la persona teclea de la máquina viva de la ruta mientras la plataforma lee una copia
parada. Necesitan fuente viva — el patrón agente-POS que ya está documentado como superior al copiado
por SMB.

*(Colateral del mismo listado: `42 PIEDAD ABASTOS.MDB` no se toca desde **enero de 2024**.)*

### 9.3 El costo: ¿cuál de las dos cifras es la oficial, y desde cuándo?

`analytics.route_cost_snapshot` ya guarda las 2,446 observaciones del workbook como `excel_captura` —
el único registro **contemporáneo** que existe para ene–ago 2026. Lo que la réplica tiene hoy ya está
re-expresado y no hay forma de recuperar lo que decía en enero.

La vista devuelve **las dos cifras y su brecha, sin elegir**, porque sin árbitro externo elegir sería
inventar. La duda es de negocio: ¿el margen publicado usa la captura (lo que el negocio creyó) o el
transaccional (lo que el ERP dice hoy)? ¿Y desde qué fecha el snapshot pasa a ser la cifra oficial?

### 9.4 Comisiones: ¿se acepta la corrección o se replica el comportamiento viejo?

El motor corrige diez defectos, así que **la primera corrida va a diferir del Excel** en los periodos
afectados: las rutas 22 y 23 en el tramo 169,999.99–189,999.99, la 322 (su supervisor ahora cobra), la
28 en el bono, y cualquier periodo sobre $400,000. En la Fase CB se decidió **rediseñar, no migrar** —
es la recomendación, pero es plata de gente y la decisión no es técnica.

### 9.5 La deducción del supervisor no está modelada

Es por **persona** y agregada sobre sus rutas (`COMISIONES!K95 = 4,260`, un séptimo valor de nómina),
no por ruta. Hoy la línea de supervisor trae la *contribución* de cada ruta con `nomina_banco = 0` y el
neto se suma en el pie de la tabla. No se repartió entre rutas para no inventar una regla que el Excel
no tiene. Falta decidir la forma: ¿una línea por supervisor con su deducción, o el neto se calcula
fuera del motor?

### 9.6 Fichas de costo fijo para 28, 321 y 322

No existen en el libro. `costo_status` sale `sin_ficha_de_costo` en 16 periodo×ruta y el `$/km` queda
`NULL`, no cero. Hacen falta el TOTAL GASTO anual y el KM base de esas tres rutas.

### 9.7 El odómetro tiene dígitos mal tecleados

15 de 175 lecturas, **en pares que se cancelan**: `205095 → 23174`, o sea `223174` con el 2 comido; lo
mismo en r23, r501 y r504. Se rotulan con `km_status` y no se corrigen — poner el dígito que falta
sería inventar la lectura. ¿Se corrigen a mano desde la UI, o se recapturan del odómetro real?

### 9.8 Cinco gastos sin tipo y uno incoherente

5 filas entraron como `0 · SIN CLASIFICAR`: cuatro *parecen* gasolina y una "CAMBIOS DE MUELLES"
*parece* reparación, y parecer no alcanza. Y una fila tipada `1 · PLACAS/ARRENDAMIENTOS` trae 16.74
litros. Se reclasifican desde la captura web.

### 9.9 El objetivo mensual: ¿se rehace o se retira?

Las hojas 10-11 son de **2021**, con calendario de 13 periodos de 28 días (incompatible con las 27
quincenas del resto del libro), supervisores que ya no existen, y bloques donde el cumplimiento está
**hardcodeado** (`AL5="CUMPLIDO"` literal) pagando $500 por ruta sobre un dato inventado. No se
migraron. `scope='route'` habilita un objetivo de **monto** por ruta y mes, que es cosa distinta: falta
decidir si los tres KPIs de trade (visitas / desarrollo de marcas / volumen de compra) se rehacen sobre
el calendario quincenal o se retiran.

### 9.10 Tres maestros de choferes y ninguno concuerda

Ruta 27: `Mariano Martinez Patlan` en `FORMATO DE PAGO` vs `ANGEL ALBERTO VAZQUEZ MEJIA` —el
supervisor— en `COSTO RD PH`. Las 501-505 son cinco nombres distintos en cada hoja. Se sembró el de
`FORMATO DE PAGO` (el recibo de pago) y la 505 quedó en `NULL` porque su celda está vacía. Falta el
maestro bueno, e idealmente el `user_id` de `identity.users` para no terminar con un cuarto.

*(Y RFC/CURP/NSS de la ruta **322 son idénticos a los de la 321**; los VINs se repiten entre PH 26/27,
CAN 504/505, y CAN 503 = PH 22.)*

#### ✅ 2026-09-09 — decisión: *"hagamos que concuerden"*. Medido contra prod, son 3 piezas

Lo primero: **el conflicto que este item describía no era un conflicto.** En la ruta 27,
`Mariano Martinez Patlan` es el **chofer** y `ANGEL ALBERTO VAZQUEZ MEJIA` el **supervisor** — dos
roles, no dos versiones del mismo nombre. El maestro sembrado ya los tiene bien separados. Lo que sí
hay, medido contra `logistics.drivers`:

| pieza | estado | qué falta |
|---|---|---|
| **Choferes** | **10 de 12** casan **exacto** por nombre | Los 2 que no son **321 y 322** → fuera de alcance por decisión. Dentro del alcance vigente falta **una sola celda: el chofer de la 505** |
| **Supervisores** | **1 de 3** existe en `logistics.drivers` | ⚠️ **`ANGEL ALBERTO VAZQUEZ MEJIA` y `EDUARDO LOPEZ SAINZ` NO están en el maestro de personal.** El doc nunca lo había medido. Hay que darlos de alta o averiguar por qué faltan |
| **Liga a `identity.users`** | **0 de 56** drivers tienen `user_id` | `commission_route_config` ya trae `chofer_user_id`/`supervisor_user_id` **vacías**, pero la cadena está rota **un eslabón antes**: aunque las llenáramos, `logistics.drivers.user_id` es NULL en todos. Llegar a `identity.users` es trabajo aparte |

⚠️ **El chofer de la 505 no se rellena por inferencia.** El candidato es
`FRANCISCO DE JESUS MARTINEZ RAZO`: está en `logistics.drivers` con rol **`chofer`**, `kduv` de la
sucursal 06 lo lista como `00505 Francico Martinez`, y el inventario del push anota el vendedor de esa
van como *"Francisco"*. **Pero es también el supervisor de las cinco rutas de Canindo en el maestro.**
O trae ruta además de supervisar, o son dos personas con el mismo nombre de pila. Es **una pregunta de
una línea**, no una deducción — y el push no ayuda: `mart.ventas_enriched` **no trae columna de
vendedor**.

📌 **Que concuerden por construcción, no por copia**: el arreglo de fondo es que
`commission_route_config` apunte por **`driver_id`** a `logistics.drivers` en vez de cargar el nombre
como texto. Mientras sea texto copiado, vuelven a divergir en la siguiente captura — es la regla del
proyecto de derivar y no copiar, aplicada al maestro de personas.
