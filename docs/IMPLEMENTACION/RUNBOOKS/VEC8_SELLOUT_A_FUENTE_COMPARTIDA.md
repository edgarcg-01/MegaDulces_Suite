# `[VEC.8]` — Migrar el sell-out a la fuente compartida

> **Estado: escrito, NO ejecutado.** Requiere ventana fuera de horario hábil.
> Escrito el 2026-10-06, con todo medido contra prod (`md` · `pg-prod`).

## Por qué

El sell-out y la venta por ruta miden el mismo hecho del mismo ERP y **hoy se contradicen**.
Medido en septiembre-2026, sobre las rutas vecinales:

| | |
|---|---|
| venta real (`U-D-10`) | **$1,945,184.67** |
| lo que publica el sell-out | **$3,150,428.68** |
| diferencia | **$1,205,244.01 — 62%** |

La diferencia es `U-D-12`: en estas rutas **re-emite el mismo ticket de caja** (medido por línea,
mismo cliente/día/SKU/cantidad: PH 99.8%, Morelia 100% y 97.9%, **placebo 0** en las tres). Fuera
de las rutas `U-D-12` es venta genuina en el 68.5%, así que no se trata de sacarlo del universo:
se trata de **marcarlo donde es espejo**.

⚠️ **En el total de una plaza no se nota**: PH agosto da $10,557,889.02 en el sell-out contra
$10,505,404.24 del árbitro `kdm1.c16`. Coinciden porque **los dos cuentan el espejo**. *Dos
derivaciones que comparten el error se confirman entre sí.*

## Lo que ya está hecho (y no hace falta repetir)

`analytics.v_kepler_sales_lines` (`[VEC.7]` / `[VEC.7.1]`, batches 752-753) es la línea de venta
resuelta una sola vez: llave con **caja**, documento en **su** plaza, cancelados fuera, `doc_tipo`
como columna, y `canal` / `vendor_code` **carácter por carácter** los del sell-out.

⭐ **Prueba de fidelidad, ya corrida contra prod (septiembre-2026):** agregando la canónica con los
mismos filtros del sell-out (catálogo, almacén, `SER`, `qty > 0`), los **cinco canales coinciden
al centavo**:

```
credito     $282,880.69   Δ 0.00
mayoreo  $11,219,208.82   Δ 0.00
mostrador $24,675,499.72  Δ 0.00
preventa  $3,150,428.68   Δ 0.00
ruta        $226,980.47   Δ 0.00
```

Es decir: **cambiar la fuente del sell-out a la canónica no cambia ninguna cifra**. Lo único que
cambia es lo que se decida filtrar — y eso es exactamente `WHERE NOT es_refactura`.

## Lo que falta, y por qué necesita ventana

`mv_kepler_sales_daily` es una **matview**: no hay `CREATE OR REPLACE`. Cambiar su definición
obliga a `DROP ... CASCADE`, y el cierre transitivo **no son los 5 dependientes directos**:

```
15 objetos en 3 niveles · 5 de ellos matviews · 2,453 MB en total
```

Nivel 1 `mv_sales_blended`, `v_sellout_daily`, `v_price_signals`, `v_price_experiment_results`,
`v_sku_price_response` · Nivel 2 `mv_sellout_monthly`, `mv_profitability_sales_agg`,
`mv_sku_price_response`, `v_promo_agreement_sellout`, `v_sellout_vs_facturacion` · Nivel 3
`v_sales_entity`, `v_price_action`, `v_purchase_decision_signals`, `v_sellout_channel_coverage`.

⚠️ Además **ningún índice de `mv_kepler_sales_daily` es UNIQUE**, así que su refresco **no puede
ser `CONCURRENTLY`**: toma `ACCESS EXCLUSIVE` y el sell-out queda inaccesible mientras dura.

⛔ **Se descartó el atajo** de parchear `v_sellout_daily` (una vista, barata de reemplazar) para
que descuente la re-facturación: dejaría la matview con el dato inflado y a sus otros consumidores
leyéndolo. Sería **una tercera versión** de la misma verdad, que es justo lo que esta fase existe
para eliminar.

## Pasos

1. **Ventana**: fuera de horario hábil. Avisar — la venta publicada del sell-out **baja ~$1.1M/mes**
   en las plazas con ruta vecinal. No es una pérdida: es dejar de contar dos veces. Que no lo
   descubra alguien el lunes en un tablero.
2. **Capturar** `pg_get_viewdef` de los 15 objetos y los `indexdef` de las 5 matviews.
   ⚠️ Pedir la definición con `SET LOCAL search_path = pg_catalog`: `pg_get_viewdef` **imprime
   según el `search_path` de quien pregunta** y sin eso los nombres salen sin calificar
   (lección de `[VEC.1]`).
3. **Medir el antes** por canal y mes, y guardarlo.
4. `DROP MATERIALIZED VIEW analytics.mv_kepler_sales_daily CASCADE`.
5. **Recrear** la matview leyendo de `analytics.v_kepler_sales_lines`, con los mismos filtros
   (catálogo, almacén, `SER`, `qty > 0`) y **`WHERE NOT es_refactura`**.
6. Recrear índices y los 15 objetos **en orden de nivel** (1 → 2 → 3).
7. Refrescar las matviews del cierre.
8. **Verificar**: los canales distintos de `preventa` deben quedar **idénticos al centavo**, y
   `preventa` debe bajar exactamente el valor de `es_refactura` del período. Cualquier otra
   diferencia significa que algo se recreó mal → revertir.
9. Correr `database/tests/test-newdb-vecinal-truth.js`: su aserción *"el sell-out y la venta por
   ruta dicen lo mismo de la vecinal"* **está en rojo a propósito** y debe pasar a verde. Es el
   criterio de aceptación de este runbook.

## Después

Con la canónica en producción como fuente del sell-out, las demás derivaciones de venta
(`erp_sale_ticket_lines`, `erp_sales_invoice_lines`, `v_seller_sales_lines`, `mv_erp_margin_daily`…)
pueden migrar una por una, cada una con su propia verificación de fidelidad. **De las 44 vistas de
`analytics` que leen `kdm1`/`kdm2`, ninguna comparte reglas con otra**: unas unen por caja y otras
no, unas excluyen cancelados y otras no. Ése es el trabajo de fondo que esta fase abre.

---

# `[VEC.11]` — Mientras el sell-out no se migre, la contradicción se DECLARA con su aritmética

> **Estado: en código, candado verde contra prod (15 ✓ / 0 ✗). Sin desplegar.** 2026-10-14.

`[VEC.8]` sigue pendiente de ventana, así que las dos cifras conviven. Hasta hoy el panel de la
vecinal lo decía en prosa —*"el sell-out sí los cuenta, y por eso publica una cifra más alta"*— sin
decir **cuál**. Una conciliación nombra los dos números y enseña la resta que los une; mientras
falte el segundo, al lector sólo le queda creer en la palabra.

`/comercial/ventas-por-ruta` publica ahora el puente completo, medido contra prod:

| | sep-2026 |
|---|---|
| lo que publica esta pantalla (`U-D-10`, cabecera `c16`) | **$1,943,014.72** |
| prorrateo del descuento por renglón | +$2,169.95 |
| telemarketing con código vecinal (`U-D-8`, venta real de otro canal) | +$107,251.22 |
| **re-factura (`U-D-12`, el espejo — no es venta)** | **+$1,097,993.16** |
| = lo que publica el sell-out, **medido en su propia tabla** | **$3,150,428.68** |
| lo que no cierra | **$0.37** |

## ⛔ Lo que costó: una identidad no se arma mezclando granos

La primera versión tomaba la re-factura y el telemarketing de `analytics.v_vecinal_no_suma`, que
agrega la **cabecera** (`c16`). El sell-out está hecho de **líneas** (`l.c13`). El puente quedó
abierto por **$2,762.84** en septiembre — y la cifra se veía razonable, que es lo peligroso.

Todos los sumandos salen ahora de `analytics.v_kepler_sales_lines`. `v_vecinal_no_suma` sigue
sirviendo para **contar documentos**; para que la resta dé cero manda la línea.

El candado lleva la **prueba negativa**: arma el puente a propósito con el grano de cabecera y
exige que **NO** cierre (medido: $4,932.79). Si algún día cerrara, los dos granos coincidirían y la
aserción quedaría vacua → reporta `NO MEDIDO`, no ✔.

## ⭐ `sellout` se LEE, no se deduce

Se podría calcular aplicándole a la canónica los filtros del sell-out (catálogo, almacén, `SER`,
`qty > 0`) — y da $1,870,983.49 contra los $1,870,983.60 de la canónica cruda, o sea que esos
filtros valen **$0.11**. Pero una derivación que comparte el origen con lo que quiere comprobar
**se confirma sola**; es la misma trampa de PH-agosto que este runbook documenta arriba. El destino
se lee de `analytics.mv_kepler_sales_daily`.

## ⭐ `por_refrescar`: el día en curso NO es descuadre

La matvista del sell-out es **nocturna**. La venta de hoy ya está en la vista viva y todavía no en
ella. Medido el 2026-10-14: **$91,111.90** — todo el "hueco" del rango de 45 días era eso, y sin
separarlo se habría leído como error. Día por día, los cerrados cuadran al centavo (Δ máx $0.04).

Residuo medido en cuatro períodos: agosto **$0.05** · septiembre **$0.37** · 45 días **$0.48** ·
julio **$327.84** sobre $1.79 M (0.018 %) — el único que no cierra, y por eso el panel lo declara
en vez de repartirlo entre los sumandos.

---

# `[VEC.12]` — La ruta vecinal responde "¿y el dinero?" en SU detalle

La pestaña **Depósito** de una ruta vecinal declaraba que esa ruta no deposita en la caja fuerte y
mandaba a leer el panel de arriba. La pregunta de quien abre una ruta es *"ésta, ¿entregó?"*, y
remitir a otro lado la deja sin responder donde se hace. Ahora muestra **sus cajas** con el arqueo:
día, caja, rutas que comparten esa caja, venta vecinal, **% de la caja**, efectivo y estado.

⛔ El grano sigue siendo la **caja**, nunca la ruta — una caja mezcla rutas y mostrador. Por eso la
columna de porcentaje: sólo con 100 el descuadre es atribuible a la vecinal. Sin ella el número
invita a culpar al que pasa.

---

# Dónde vive la vecinal (verificado contra prod, 2026-10-14)

Pedido de Edgar: *"todo lo de vecinal debe salir de una base normalizada, con su FK y PK, nada de
imports ni tablas copia, para mantener la frescura"*. Medido:

| objeto | tipo | |
|---|---|---|
| `v_kepler_vecinal_sales_docs` | vista | grano ticket, `total` = `c16` |
| `v_kepler_vecinal_sales_lines` | vista | grano línea (join **con la caja**) |
| `v_kepler_vecinal_monthly` | vista | rollup mensual |
| `v_vecinal_conciliacion` | vista | la venta contra el arqueo |
| `v_vecinal_no_suma` | vista | lo que lleva código vecinal y no es venta de esa caja |
| `mv_kepler_vecinal_monthly` | **matvista** 88 kB | la única copia — ver abajo |

**Cero tablas y cero importers.** `import-kepler-vecinal-routes.js` está retirado y su rollup en
`sales_by_route_monthly` **se excluye a propósito** (quedó con un monto 2.07× el real y, como sube
con `GREATEST`, nunca baja: no se corrige re-corriéndolo, se corrige dejando de leerlo).

## La única copia, y por qué sigue ahí

`mv_kepler_vecinal_monthly` la lee la matriz de la pantalla. **No es una tabla de importer**: no
tiene escritor propio, tiene **PK UNIQUE** (`tenant_id, warehouse_code, route_no, month`) y por eso
refresca `CONCURRENTLY` cada 30 min, con **latido verde** (`analytics_refresh`, `ok`).

Medido el 2026-10-14 contra la vista viva: **$0.00 de rezago** en agosto, septiembre y octubre, con
el mismo conteo de tickets. Existe por tiempo, no por comodidad:

```
vista viva .......................... 1,319 / 1,462 / 1,701 ms   (gate 1,000 ms)
la copia ................................................ 5 ms
```

⛔ **Quitarla hoy rompe la pantalla.** Se prototipó una equivalente más rápida (`kduv` normalizado
una vez en vez de un nested loop por documento): **978 / 1,159 ms, 61 de 61 filas idénticas** — una
mejora del 30 % que **sigue por encima del gate**. El plan lo explica: el costo que queda es el
`LEFT JOIN LATERAL` por documento contra `kepler_ods.kdm2` (5.2 M filas, 2.4 GB).

**Para retirar la copia hace falta primero que la vista viva baje del gate**, y eso es trabajo con
migración (índices sobre `kepler_ods.kduv` por las expresiones `btrim`, y una reescritura del
lateral). Hasta entonces la copia se queda, declarada, con PK y con latido.

---

# `[VEC.15]` — La conciliación que cierra a centavos, y el único hueco que queda

> Edgar, 2026-10-15: *"¿ya tenemos una conciliación de las ventas de vecinal con Kepler, que no
> haya ninguna diferencia?"*. **Sí — y acá está la identidad, con su excepción nombrada.**

## La identidad

```
Σ kdm2.c13  =  kdm1.c16  +  c13 × (1 + (c14 + c15) / (c16 − c14 − c15))
   líneas       cabecera      descuento BRUTEADO a la tasa del documento
```

Medido contra prod (2026-10-15), venta vecinal `U-D-10`:

| mes | documentos | residuo | docs que no cierran |
|---|---:|---:|---:|
| julio | 1,689 | **$0.06** | 0 |
| septiembre | 2,553 | **$0.70** | 1 |
| octubre | 1,371 | **$0.02** | 0 |
| **últimos 60 días (candado)** | **4,720** | **$0.74** | **1** |

Eso es redondeo, no descuadre.

## ⭐ Cómo apareció: el patrón estaba en las filas INCORRECTAS

El puente de `[VEC.11]` tenía un renglón rotulado *«prorrateo del descuento»* que **nadie había
demostrado** — era el nombre que se le puso a una diferencia. Al mirar los **22 documentos de
sep-2026 que no cuadraban**, en **todos** la diferencia excedía al descuento por un factor de
**1.07–1.10**:

```
suc 07 · 2V003 · 18-sep · folio 0000513
  cabecera 4,767.01   líneas 4,914.44   dif 147.43   descuento(c13) 135.26
  147.43 / 135.26 = 1.0900
```

`ERP_KEPLER` §2.6 ya lo tenía decodificado y el puente no lo estaba usando: **`c13` está SIN
impuesto y el total está CON impuesto.** El factor no es constante (1.07–1.10) porque cada ticket
mezcla tasas — por eso se brutea con la tasa **de ese documento**, no con un 16% fijo.

⚠️ El candado lleva la **prueba negativa**: con el descuento tal cual (`c13`, sin brutear) el
residuo salta de **$0.74 a $406.70**. Si las dos fórmulas dieran lo mismo, la corrección no
estaría probando nada y la aserción reporta `NO MEDIDO`, no ✔.

## ⛔ El único hueco: el 17-ago-2026, y es MÁS GRANDE que la vecinal

Agosto no cierra: **28 documentos, $26,016.13**. No es la fórmula — es que ese día la ingesta de
`kdm2` llegó incompleta a las sucursales **02 y 05**. Y al medir el día entero, el hueco excede a
esta fase:

| sucursal | canal | docs | sin renglones | venta sin renglones |
|---|---|---:|---:|---:|
| 02 | mostrador / otro | 307 | **118** | $17,051.82 |
| 02 | vecinal | 20 | 18 | $10,692.43 |
| 05 | mostrador / otro | 182 | 25 | $3,740.78 |
| 05 | vecinal | 16 | 6 | $13,548.25 |
| | | | **167** | **$45,033.28** |

**Sólo el 54% es vecinal.** Los otros doctypes del mismo día también: `U-D-5` 18 de 25 en la 02,
`U-D-40` 4 de 4. Y los días **15, 16, 18 y 19 tienen CERO** documentos sin renglones en `U-D-10`
— o sea que es un día, no un régimen.

⭐ **Cualquier pantalla que sume renglones subdeclara ese día**: el sell-out, los productos más
vendidos, el margen. No es un problema de la vecinal; la vecinal fue el **detector**.

⚠️ **Lo que NO está establecido**: si las líneas existen en la réplica de la sucursal y no
llegaron al ODS, o si Kepler tampoco las tiene. Eso se decide mirando la réplica de `02`/`05`, y
no se hizo. Se declara en vez de nombrar la causa.

El candado **excluye ese día explícitamente** (`sucursal IN ('02','05') AND día = 2026-08-17`) para
que la identidad se pueda vigilar sin que un incidente viejo la deje roja para siempre — pero la
exclusión está escrita a la vista, con su monto, no escondida en un umbral.

---

# `[VEC.16]` — El hueco del 17-ago investigado: Kepler SÍ tiene las líneas, y nadie puede reponerlas

> Edgar, 2026-10-15: *"investigalo"*. **Resultado: no es Kepler, es la ingesta — y el agujero no
> es ese día, es que no existe forma de reparar un hueco de más de 3 días.**

## 1. Kepler tiene las líneas

Consultada la réplica de la sucursal (`pgvector-md`, `kepler_md_02` / `kepler_md_05`, schema `md`),
17-ago-2026, venta `U-D-10`:

| | docs | **sin líneas** | venta |
|---|---:|---:|---:|
| `kepler_md_02` mostrador | 307 | **0** | $64,484.88 |
| `kepler_md_02` vecinal | 20 | **0** | $12,186.31 |
| `kepler_md_05` mostrador | 182 | **0** | $59,588.87 |
| `kepler_md_05` vecinal | 16 | **0** | $32,451.47 |

**Cero documentos sin renglones**, y las cabeceras coinciden **al centavo** con el ODS — mismos
documentos, mismo dinero. O sea: el ERP registró todo y el ODS perdió los renglones en el camino.

## 2. Es un día, no un régimen

Barrido del ODS por sucursal y mes (`U-D-10`, jul→oct):

```
sucursal 02 ── jul: sin huecos · ago: 17-ago -> 136/327 docs · $27,744.25 · sep: sin huecos · oct: sin huecos
sucursal 05 ── jul: sin huecos · ago: 17-ago ->  31/198 docs · $17,289.03 · sep: sin huecos · oct: sin huecos
```

**167 documentos · $45,033.28**, todo el mismo día. Y alcanza a otros doctypes de esas plazas
(`U-D-5` 18 de 25 en la 02, `U-D-40` 4 de 4), no sólo a la venta.

## 3. ⛔⛔ Lo que de verdad importa: nadie puede reponerlo

Hay dos reconciliadores, y **ninguno de los dos puede cerrar este hueco**:

| modo | ventana | ¿repone? |
|---|---|---|
| ventana (lo que corre en prod: `--days=3 --watch=900`) | **3 días** | **sí** |
| `--full` (barrido del backlog) | todo | **NO** — `faltan = FULL ? [] : …`, es sólo-DELETE |

Verificado en el despliegue (`ops/k3s/22-ods-reconcile.deployment.yaml`, líneas 41/43) y en el
código (`reconcile-ods-window.js`, el comentario lo dice: *"`--full` no repone (sería re-ship
masivo sobre tablas de millones)"*).

⭐ **O sea que la ventana de reparación del ODS es de 3 días.** Lo que se pierda y no se detecte
dentro de ese plazo queda invisible para siempre — no por olvido, por diseño. Este incidente lleva
**59 días** así, y se encontró de casualidad: la conciliación vecinal de `[VEC.15]` fue el
detector, no la víctima.

⚠️ Y el costo no es la vecinal: **toda pantalla que sume renglones subdeclara ese día** — el
sell-out, los más vendidos, el margen. La cabecera sí está, así que los totales de venta están
bien; lo que falta es el desglose.

## 4. ✅ REPARADO — 968 renglones repuestos, verificado contra prod

Autorizado por Edgar el 2026-10-15. Corrido **dentro del pod de ingesta** (`ods-reconcile`, que es
donde vive `ODS_SOURCE_BASE`), no desde la máquina de trabajo.

⚠️ `feeds-cron` **no sirve**: no tiene esa variable y el script aborta con un error que nombra
`DATABASE_URL_NEW` — leerlo rápido hace pensar que falta el destino, cuando lo que falta es el
ORIGEN.

**Primero en seco**, que es inocuo y dimensiona:

```
suc 02 · kdm2 · 60d ──  local 141,212 · faltan 828 · sobran 0
suc 05 · kdm2 · 60d ──  local  70,125 · faltan 140 · sobran 0
```

**Cero sobrantes**: no había nada que borrar, era puro faltante. Después con `--apply`:

```bash
node database/importers/kepler/reconcile-ods-window.js --branch=02 --tables=kdm2 --days=60 --apply
node database/importers/kepler/reconcile-ods-window.js --branch=05 --tables=kdm2 --days=60 --apply
```

→ **828 + 140 = 968 filas repuestas.**

### La verificación, contra prod y no contra el reporte del script

| | antes | después |
|---|---:|---:|
| documentos sin renglones el 17-ago | **167** | **0** |
| venta sin renglones ese día | **$45,033.28** | **$0.00** |
| residuo de la identidad en agosto | **$26,016.13** | **$0.05** |
| documentos de agosto que no cierran | **4** | **0** |

Control: septiembre quedó **idéntico** ($0.70 de residuo, 1 documento) — la reparación movió lo
que debía y nada más.

⛔ **Y se retiró la exclusión del candado.** `test-newdb-vecinal-conciliacion.js` excluía
explícitamente ese día; ahora corre sin exclusión y pasa: **4,755 de 4,756 documentos, residuo
$0.75**. *Una exclusión que sobrevive a su causa deja al candado ciego justo donde ya falló una vez.*

## 5. ⛔ Lo que esto NO arregló

La reparación cierra **este** hueco. No cierra el que lo hizo posible:

- **La ventana de reparación del ODS sigue siendo de 3 días.** El modo que repone corre con
  `--days=3`; el `--full` que mira todo **no repone**. Un hueco que no se detecte en 72 h vuelve a
  ser permanente. Éste se encontró a los **59 días**, y por casualidad.
- **No se estableció la causa**: por qué el 17-ago se perdieron esas 968 filas (el CDC, el shipper,
  un reinicio). El latido de ese día no se revisó.
- **Sólo se barrieron dos ramas y `U-D-10`.** Las otras seis ramas y los demás doctypes **no se
  revisaron**, y con una ventana de 3 días cualquier hueco viejo que haya ahí es igual de invisible.

---

# `[VEC.17]` — El barrido completo: no era un día, el ODS pierde filas en 7 de 9 ramas

> Edgar, 2026-10-15: *"sí, barrelo"*. Barrido en seco de **9 ramas × 5 tablas de movimiento ×
> 60 días**, con el propio reconciliador (compara ODS contra réplica de sucursal).

## Filas ausentes en el ODS

| suc | `kdm1` | `kdm2` | `kdij` | `kdue` | `kdpord` |
|---|---:|---:|---:|---:|---:|
| 00 | 0 | 487 | 38 | 111 | 3 |
| 01 | 1 | 1 | **547** | **524** | 232 |
| 02 | 0 | **0** ✅ | 0 | 39 | 0 |
| 03 | 6 | 307 | **569** | 150 | 0 |
| 04 | 0 | 0 | 0 | 0 | 0 |
| 05 | 0 | **0** ✅ | 144 | 38 | 15 |
| 06 | 0 | 33 | 0 | 5 | 3 |
| 07 | 0 | 0 | 2 | 0 | 0 |
| 08 | 0 | 15 | 0 | 0 | 235 |
| **Σ** | **7** | **843** | **1,300** | **867** | **488** |

**3,505 filas ausentes** en 60 días, en **7 de 9 ramas**.

## Lo que dice la tabla

- ⭐ **`kdij` es el peor con 1,300** — y el kardex es lo que **valúa el inventario**. `kdue` con
  **867** es la **cartera**. O sea que el hueco no es un detalle de venta: toca dinero por cobrar
  y capital en piso.
- ✅ **`02` y `05` en `kdm2` quedaron en CERO**: la reparación de `[VEC.16]` se sostiene.
- ⭐⭐ **`04` y `07` están impecables en las cinco tablas.** Eso es lo que convierte al resto en
  defecto y no en «así es esto»: el carril **puede** no perder nada.
- `01` tiene **39 sobrantes** en `kdm2` (filas en el ODS que ya no están en origen). Eso es otra
  cosa —borrados no propagados— y sí tiene quien lo atienda: el `--delete-sobrantes` nocturno.
  **Lo que no tiene quien lo atienda es el faltante.**

⚠️ **`01/kdm2` necesitó `--max-old-space-size=2048`**: con el heap por default el proceso muere
por OOM y el barrido imprime *«sin salida»*, que se lee como «no hay nada». Es la rama más grande
(480,137 filas en la ventana). Un barrido que se queda sin memoria **no reporta cero: no reporta**.

## ⛔ La causa del 17-ago NO es establecible, y ahora se sabe por qué

`analytics.cron_run_log` (690,648 filas) **no cubre agosto**: salta del **31-jul al 02-sep**, y
sólo se puebla de verdad desde el **07-sep**. No hay telemetría del período, así que por qué se
perdieron esas 968 filas no se puede responder con lo que hay.

⭐ Eso cierra el círculo: **el hueco duró 59 días porque no había ni quién lo repusiera (ventana
de 3 días) ni quién lo registrara (sin log).**
