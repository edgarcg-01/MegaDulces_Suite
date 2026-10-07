# Fase WH — La venta histórica de Wincaja, de todas las sucursales

> **Pedido (Edgar, 2026-10-07):** *"necesito que agreguemos el histórico de venta de Wincaja de todas las sucursales"*.
>
> **Estado: 🔨 DISEÑADO (planeación). Sin código.** Todo lo que sigue está medido contra prod
> (`pg-prod`) y contra el espejo (`pgvector-md:/wincaja`) el **2026-10-07**, en sólo lectura.
> ADR-082 propuesto (ver §3).

---

## 0. El hallazgo que reformula el pedido

**El corpus histórico YA ESTÁ CARGADO.** No hay que ir a los `.mdb`, ni a `Z:\Salidas\Bases`, ni
copiar 22 GB por SMB: la Fase WR-hist ya replicó **~35 GB** de Access a Postgres, en la base
`wincaja` del contenedor `pgvector-md`, en schemas `hNN` (uno por sucursal):

| schema | sucursal | tamaño | `MaestroMovAlmacen` | `DetallesMovAlmacen` |
|---|---|---:|---:|---:|
| `h30` | 08 Morelia Abastos | 7,541 MB | 2,163,078 | 20,485,728 |
| `h10` | 01 Padre Hidalgo | 6,152 MB | 2,466,064 | 13,874,895 |
| `h40` | 03 8 Esquinas | 5,382 MB | 2,531,585 | 11,580,666 |
| `h50` | 06 Canindo | 3,376 MB | 986,760 | 8,424,229 |
| `h32` | 07 Morelia Madero | 2,956 MB | 1,183,600 | 5,748,309 |
| `h42` | 02 La Piedad Abastos | 2,509 MB | 1,165,876 | 4,648,917 |
| `h00` | CEDIS | 1,008 MB | 82,776 | 2,070,774 |
| `h44` | 04 Yurécuaro | 53 MB | 66,345 | 213,963 |
| `h54` | 05 Zamora Centro | 43 MB | 38,246 | 169,179 |

Más las rutas (`h20`–`h27`, `h50x`, `h51`, `h70`, `h321`, `h322`, `hcedis_b`).

⭐ **Entonces esta fase NO es de ingesta: es el tramo GOLD que falta** — de `wincaja.hNN.*` a
`analytics.sales_daily`. Ese tramo nunca se construyó, y por eso el dato existe en disco y no
existe en ninguna pantalla.

⭐⭐ **Y prod lo alcanza DIRECTO** (verificado 2026-10-07 desde `pg-prod`; ver WH.2). La base
`wincaja` vive en `md` desde `[VL.7.3]` y prod corre en `md` desde el 22-sep: son el mismo nodo, y
prod ya tiene `postgres_fdw` con un servidor foráneo funcionando contra ese host. **Por eso esto
se resuelve con una VISTA `derive-no-copy`, no con un importer** — que es la regla principal del
proyecto, y lo que la primera versión de este plan tenía mal.

⚠️ **Wincaja ya no es fuente viva.** Medido: el espejo se detuvo en el corte a Kepler de cada
sucursal (`w32` 2026-09-08 · `w30` 2026-09-18 · `w00` 2026-09-30). El corpus es **cerrado**: no
llega un ticket más. Eso vuelve segura cualquier materialización — no puede quedar rezagada.

---

## 1. Lo medido

### 1.1 El hueco, en `analytics.sales_daily` (prod, 2026-10-07)

Filas por sucursal y año. **2023 y 2024 están en CERO para todas**, y la mitad del padrón sólo
tiene 2026:

| almacén | pre-2023 | 2023 | 2024 | 2025 | 2026 | primer día real |
|---|---:|---:|---:|---:|---:|---|
| 01 Padre Hidalgo | 1 | **0** | **0** | 534,835 | 368,719 | 2025-01 |
| 02 La Piedad Abastos | 12 | **0** | **0** | 226,453 | 175,172 | 2025-01 |
| 03 8ESQ | 0 | **0** | **0** | **0** | 271,742 | 2026-01-10 |
| 04 Yurécuaro | 0 | **0** | **0** | **0** | 79,342 | 2026-01-02 |
| 05 Zamora Centro | 1 | **0** | **0** | **0** | 98,376 | 2026-01 |
| 06 Canindo | 188 | **0** | **0** | 372,470 | 272,840 | 2025-01 |
| 07 Morelia Madero | 0 | **0** | **0** | **0** | 23,600 | **2026-09-08** |
| 08 Morelia Abastos | 0 | **0** | **0** | **0** | 31,328 | **2026-09-19** |

Las cifras de «pre-2023» (1, 12, 188…) **no son historia**: son el centinela `2000-01-01` que
viene del propio Wincaja (§2.4).

### 1.2 Lo recuperable, en el espejo

Tickets de venta (`Tipo='V'`) por corte anual y sucursal:

| corte | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | CEDIS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2017 | 213,875 | 100,154 | 303,012 | — | — | 102,145 | 119,538 | 253,870 | — |
| 2018 | 215,714 | 113,867 | 288,443 | — | — | 103,010 | 124,318 | 220,110 | — |
| 2019 | 234,272 | 99,779 | 276,470 | — | — | 98,475 | 110,023 | 199,214 | 325 |
| 2020 | 237,773 | 109,315 | 248,055 | — | — | 96,491 | 79,190 | 190,150 | 894 |
| 2021 | 258,196 | 119,309 | 258,971 | — | — | 94,255 | 83,729 | 202,125 | 1,064 |
| 2022 | 269,651 | 116,559 | 272,932 | — | — | 91,741 | 110,880 | 221,572 | 1,307 |
| 2023 | 272,716 | 128,415 | 274,227 | — | — | 96,483 | 138,478 | 234,742 | 1,240 |
| 2024 | 275,379 | 128,766 | 283,498 | 10,402 | — | 99,873 | 136,587 | 215,549 | 1,479 |
| 2025 | 273,294 | 96,919 | 285,860 | 47,487 | 24,956 | 102,601 | 127,283 | 225,556 | 1,856 |
| **total** | **2,250,870** | **1,013,083** | **2,491,468** | **57,889** | **24,956** | **885,074** | **1,030,026** | **1,962,888** | 8,165 |

**≈ 9.72 millones de tickets, 2017–2025.** Yurécuaro arranca en 2024 y Zamora en 2025 porque las
tiendas son más nuevas — eso **no es un hueco**, es su historia completa.

### 1.2.bis ⚠️ «Toda la base» son 17 años; en Postgres hay 9

Barrido de **todos** los schemas `h*` (no sólo los 9 de tienda), contando cabeceras por corte:

| corte | schemas | cabeceras | | corte | schemas | cabeceras |
|---|---:|---:|---|---|---:|---:|
| 2017 | 17 | 1,218,084 | | 2023 | 18 | 1,284,783 |
| 2018 | 22 | 1,204,320 | | 2024 | 21 | 1,289,292 |
| 2019 | 21 | 1,165,015 | | 2025 | 22 | 1,320,955 |
| 2020 | 16 | 1,072,268 | | `Actuales` | 21 | 169,115 |
| 2021 | 16 | 1,113,897 | | `Concentradas` | 4 | 356,363 |
| 2022 | 17 | 1,215,148 | | + 5 cortes con nombre propio | 1 c/u | 196,548 |

**Ningún corte anterior a 2017.** Contra la fuente (`Z:\Salidas\Bases`, medida el 2026-10-07):

- Carpetas descomprimidas: **2019–2025**, `Actuales`, `Concentradas`, `2025 12`, `2026 C`, `Cierres`.
- Comprimidos sueltos en la raíz: **`2009.7z` … `2018.7z`**, que suman **0.94 GB**.

Dos cosas que salen de ahí:

1. ⭐ **La copia en Postgres ya es MÁS completa que el share.** 2017 y 2018 ya no están
   descomprimidos allá —sólo como `.7z`— y **sí están cargados** (2.4M cabeceras entre los dos).
   El activo es la base, no la carpeta.
2. ⭐ **Lo que falta es barato.** 2009–2016 son **ocho `.7z` que pesan 0.94 GB** (los años viejos
   son chicos: `2009.7z` = 0.02 GB). No es una segunda fase: es descomprimir y volver a correr el
   mismo cargador, que ya los admite por `WINCAJA_HIST_YEARS`.

### 1.3 El dinero: MEDIDO PERO **NO ARBITRADO** ⛔

Para dimensionar se sumó `DetallesMovAlmacen.ValorVenta` de **un solo año (2023)**:

| sucursal | líneas 2023 | Σ `ValorVenta` |
|---|---:|---:|
| 01 Padre Hidalgo | 1,537,307 | $231,340,190 |
| 08 Morelia Abastos | 2,110,242 | $252,199,242 |
| 06 Canindo | 816,834 | $149,388,484 |
| 03 8 Esquinas | 1,182,597 | $58,220,876 |
| 07 Morelia Madero | 623,306 | $38,974,066 |
| 02 La Piedad Abastos | 442,337 | $26,584,780 |

⛔ **Esta cifra NO se publica como «venta recuperable» y no entra a ninguna presentación hasta
WH.0.** Da **$849.39 por ticket y $33.98 por pieza** en Padre Hidalgo — y el ticket conocido de
tienda es **~$86** ([[reference_cdrp_ticket_por_bloque]]). O `ValorVenta` trae IVA, o es el
importe de la línea a una unidad distinta de la pieza, o el `JOIN` por `Consecutivo` está
multiplicando. **Las tres hipótesis son comprobables y ninguna está comprobada.** Es exactamente
el error que ya costó caro dos veces (ADR-051, 3.3 pp de margen falso por mezclar pieza y caja;
CANON.0.1, costos 32× por leer un peldaño fijo).

---

## 2. Las siete trampas, medidas

### 2.1 ⭐⭐ Los cortes se SOLAPAN, y uno es subconjunto de otro

El corpus no es una partición: hay cortes extra con nombre propio. Medido en La Piedad, el corte
`2023-42_piedad_abastos2` (118,731 tickets) contra el corte `2023` (128,415):

- **331 días en los dos**, y **329 de esos con el conteo de tickets IDÉNTICO**
- **30 días sólo en `2023`** (el arranque de enero)
- **0 días sólo en `abastos2`**

⭐ **No es complementario: es un subconjunto.** Cargar los dos duplica 331 días de La Piedad 2023.
Lo mismo huele en `2021-32_morelia_madero_01_21` (11,794) y `2021-32_morelia_madero_dic` (26,779)
contra el `2021` de Madero (83,729), y en `2025-2025_dic` (29,697) contra el `2025` de PH.

**Cada corte extra se arbitra individualmente antes de cargarse. Ninguno entra por default.**

### 2.2 ⭐ `Actuales` y `Concentradas` NO son historia — son 2026, y ya está cargado

Medido en Padre Hidalgo: `Concentradas` = **2026-01-01 → 2026-05-31** y `Actuales` =
**2026-06-01 → 2026-06-26**. O sea el periodo corriente, que `sales_daily` **ya tiene**
(368,719 filas de 2026 en el almacén 01). Cargarlos sería duplicar el presente.

**Los dos quedan FUERA del alcance de esta fase, por definición.**

### 2.3 ⭐ El `Consecutivo` reinicia en 1 cada año

Ya documentado por WR-hist y confirmado acá: 2021 va 1..89,586 y 2025 va 1..129,760 — **tickets
distintos con el mismo número**. Por eso `_dataset` es parte obligatoria de la identidad, y por eso
el `JOIN` cabecera↔detalle **tiene que llevar `AND d._dataset = m._dataset`**. Sin esa condición el
join cruza años y multiplica las líneas en silencio.

### 2.4 El centinela `2000-01-01` viene de la fuente, y ya se filtró a prod

Todos los cortes tienen `min(Fecha) = 2000-01-01`. No es un bug del espejo: está en el Access. Y ya
llegó a prod — es el `pre-2023` de §1.1 y el `desde 2000-01-01` de los canales `wincaja_mostrador`
y `wincaja_credito`. **Se declara y se excluye por regla, no se arrastra.**

### 2.5 Hay fechas en el FUTURO

El corte `2025` de Padre Hidalgo llega a **`2029-08-03`**. Misma familia que el
`RUTA-22 → 2026-12-06` que ya vive en `sales_daily`. Una carga que no acote por arriba mete
venta en años que no existen y envenena cualquier comparativo interanual.

### 2.6 ⚠️ `Fecha` es TEXTO `MM/DD/YY`, con año de DOS dígitos

En el espejo, `Fecha` es `text` con la forma `01/14/25 00:00:00`. El parseo depende del pivote de
siglo de Postgres (00–69 → 2000s). Para 2017–2025 funciona, pero **el año autoritativo es
`_dataset` (la carpeta), que es independiente del texto**. Se parsea la fecha para el día, y se
**cuadra contra `_dataset`**: una fila cuyo año parseado no coincide con su corte es un hallazgo,
no un dato.

### 2.7 ⛔ `03`, `04` y `05` están declarados `-infinity`: su historia está excluida A PROPÓSITO

`analytics.v_branch_erp_cutover` dice, literal en su comentario: *"`-infinity` = Kepler siempre
(nunca hubo traspaso de historia)"* para las ramas `40→03`, `44→04` y `54→05`.

Pero el espejo tiene **2,491,468 tickets de 8 Esquinas desde 2017**. O sea: no es que no exista la
historia — es que **alguien decidió no traerla**, y esta fase revierte esa decisión. Hay que
cambiar el resolvedor, no esquivarlo (ADR-056: un primitivo copiado a mano diverge).

⚠️ Y el resolvedor ya no es consistente con los datos: `sales_daily` **sí** tiene filas
`wincaja_mostrador` para `04` (2026-01-02→02-17) y `05` (→2026-03-15) pese al `-infinity`.

---

## 3. Tesis — ADR-082 (propuesto)

> **La historia de Wincaja entra como un CANAL PROPIO del fact, con su corte declarado, su
> deduplicación arbitrada por día, y su cobertura publicada. No se mezcla con Kepler, no se
> «completa» lo que falta, y lo que no se puede arbitrar se declara.**

Lo que hace viable el plan, y está medido:

**La identidad de escritura de `analytics.sales_daily` incluye el canal:**

```sql
UNIQUE (tenant_id, product_id, warehouse_id, channel, sale_date)
```

⭐ **Eso significa que la historia Wincaja puede aterrizar al lado de Kepler sin colisionar jamás.**
El doble conteo no es un riesgo de la escritura: es un riesgo de la LECTURA, y para eso ya existe
el resolvedor `v_branch_erp_cutover` que `v_sellout_daily` y `mv_sales_blended` leen por `EXISTS`.

Corolarios:

1. **Un canal por naturaleza de venta**, reusando los que ya existen: `wincaja_mostrador`,
   `wincaja_credito`, `wincaja_ruta`, `wincaja_preventa`. **No se inventa un canal `wincaja_hist`**:
   el canal describe QUÉ venta es, no CUÁNDO se cargó.
2. **El almacén es el mismo que ya usan esos canales** (`01`,`02`,`04`,`05`,`06`,`RUTA-*`), no
   `MD-*`. Medido: así escriben hoy. Para `03`, `07` y `08` no hay precedente y hay que decidirlo.
3. **Un corte se carga sólo si está arbitrado.** El default es NO cargar.
4. **La cobertura se publica** (`Coverage` del contrato de procedencia): qué años entraron, cuáles
   no y por qué. Un año ausente se ve como ausente, nunca como cero.
5. **Carril aparte, one-shot, con latido propio.** No se mete en `run-prod-feeds.js`: es una carga
   histórica que corre por lote y termina, no un feed.

---

## 4. Sprints

### 🧪 `[WH.0]` — Arbitrar `ValorVenta` · **EJECUTADO 2026-10-07, con un hallazgo abierto**

Medido sobre `h10` corte `Actuales` (Padre Hidalgo, 2026-06-01..06-26) — elegido a propósito
**porque es una ventana que `sales_daily` ya publica**, así que sirve de placebo.

**1. ✅ `ValorVenta` es el importe del renglón SIN impuesto.** `IVA` e `IEPS` son columnas
aparte. El árbitro no es otra columna del mismo renglón sino el **margen**: contra `ValorCosto` da
**10.2 %–10.4 %**, consistente con el ~11.5 % que el negocio reporta. (Σ `ValorVenta` 14,196,781 ·
+IVA+IEPS 14,974,029 · `ValorCosto` 12,727,766.)

**2. ✅ La alarma del ticket de $849 era un artefacto de mezclar clases de documento.** Separado,
cada universo es coherente: **mostrador $235 · preventa $659 · crédito $9,936 · mayoreo
$17,182–$27,113**. El `.mdb` de una sucursal **no es un canal: son varios**.

**3. ⭐ El discriminante es `Caja`, no el prefijo del documento.** Reproduce al carril vivo al peso:

| `Caja` | crudo `h10` | canal publicado | publicado | Δ |
|---|---:|---|---:|---:|
| 70 (`F`) | $3,864,990 | `wincaja_credito` 01 | $3,864,990 | **$0** |
| 15 (`T`) | $460,364 | `wincaja_preventa` 01 | $460,364 | **$0** |
| 10·12·13·14 | $4,025,837 | `wincaja_mostrador` 01 | $4,025,133 | $704 (redondeo) |

⭐ **El placebo funcionó**: el método reproduce lo ya publicado, así que sirve para lo no publicado.

**4. ⛔ Y el residuo es el hallazgo: las cajas 98 y 99 no están publicadas en NINGÚN lado.**

| `Caja` | tickets | `ValorVenta` | por ticket |
|---|---:|---:|---:|
| 99 | 130 | $3,524,641 | $27,112.62 |
| 98 | 135 | $2,319,597 | $17,182.20 |
| | **265** | **$5,844,238** | |

**$5.84 millones en 26 días** — el **41 %** de la venta Wincaja de Padre Hidalgo en esa ventana.
Verificado que no están en otro almacén ni en otro canal: el total del almacén `01` para esa
ventana es $8,350,487 y lo explican exactamente los tres canales de la tabla de arriba.

Las dos lecturas posibles, y ninguna está comprobada:
- **(a) Exclusión deliberada**: por el tamaño del ticket son **mayoreo**, y existe un canal
  `mayoreo` ($27.3M desde 2025-12-22) que podría ser el mismo dinero por la pierna Kepler →
  publicarlas duplicaría.
- **(b) Hueco**: simplemente nunca se mapearon.

**✅ RESUELTO el 2026-10-07 — Lupita Sánchez:**

> *"la 99 era la caja que usaban para cobrar un traspaso a sucursal"*
> *"y la 98 era donde se les cobraba a las rutas directas"*

⭐⭐ **Ninguna de las dos es venta a cliente final, y las dos se venden OTRA VEZ río abajo:**

- **Caja 99 — traspaso a sucursal.** Movimiento interno. La mercancía se vuelve a vender en la
  sucursal que la recibe, donde sí hay un ticket.
- **Caja 98 — cobro a rutas directas.** Es el **surtido del camión** (el equivalente Wincaja del
  `U-D-41` de Kepler, ver [[reference_kepler_route_inventory_docs]]). Esa mercancía se vuelve a
  vender en el `.mdb` de cada ruta (`h21`, `h22`, `h23`…), que ya alimenta `wincaja_ruta`.

Así que la lectura **(a) era la correcta y el carril vivo hace bien en excluirlas** — pero por una
razón mejor que la que yo había supuesto: no es que dupliquen contra Kepler, es que **duplican
contra el eslabón siguiente de la propia Wincaja**.

**Lo que esa respuesta vale, medido en los 9 años de Padre Hidalgo:**

| `Caja` | tickets | `ValorVenta` 2017-2025 | por ticket |
|---|---:|---:|---:|
| 99 traspaso a sucursal | 7,153 | **$301,031,704** | $42,085 |
| 98 surtido a ruta | 11,707 | **$163,550,917** | $13,970 |
| | | **$464,582,621** | |

**$464.6 millones de doble conteo evitados, sólo en una sucursal.**

---

#### ⛔ Y al medir eso apareció el riesgo REAL de la fase: la lista blanca

Censo de cajas de Padre Hidalgo a lo largo de los nueve años: **20 cajas distintas**. La ventana
de 2026 con la que hice el placebo sólo mostraba **8**. Las que existen en la historia y **no** en
esa ventana:

| `Caja` | tickets | `ValorVenta` | vigencia |
|---|---:|---:|---|
| 19 | 51,703 | $9,821,642 | sólo 2020 |
| 17 | 32,128 | $6,399,251 | 2019–2020 |
| 18 | 6,849 | $2,055,299 | 2019–2025 |
| 16 | 4,946 | $1,742,999 | 2021–2025 |
| 11 | 2,185 | $481,470 | 2018–2025 |
| 81 · 82 | 1,082 | $369,098 | sólo 2021 |
| 72 · 96 · 71 · 01 | 79 | $79,113 | sueltas |
| | | **≈ $20,948,872** | |

⛔ **Una lista blanca de «cajas buenas» construida con la ventana de 2026 tiraría $20.9 millones de
venta real, en silencio, sólo en Padre Hidalgo.** Es exactamente
[[feedback_filter_validated_on_one_branch_deletes_another]]: un filtro validado en una ventana
borra otra sin un solo error.

**Por eso el mapa `Caja → naturaleza` es un DATO declarado (tabla), no un literal en una consulta**,
con cuatro valores — `venta_cliente` · `traspaso_interno` · `surtido_ruta` · **`sin_clasificar`** —
y **lo `sin_clasificar` NO se descarta ni se incluye: se declara con su monto** para que la
cobertura de WH.6 lo publique. Un peso que desaparece sin que nadie lo note es peor que uno mal
clasificado.

---

#### ⛔ Dos renglones envenenan $1.99 **billones**

Al poner precio a cada caja, la 15 de Padre Hidalgo devolvió **$995,263,852,035,419** —
$8,480 millones por ticket, cuando en 2026 esa misma caja da $658.

Localizado: **son DOS renglones en ~67 millones**, los dos en `h10` corte `2025`, el mismo
`Articulo` 83400 capturado dos veces (`Consecutivo` 158338 y 158439), con
`CantidadRegular = 207,502,247,423,428` y `ValorVenta = 995,263,779,541,730` cada uno. El resto de
ese año en esa caja suma $7,750,380.

Censo en las nueve sucursales (`abs(ValorVenta) > 1,000,000`): **2 renglones en `h10`** y **1 en
`h00`** de $1,464,548, que es grande pero plausible para el CEDIS y hay que revisar, no filtrar.

⭐ **Consecuencia de diseño: una cota de cordura es obligatoria y va como COMPUERTA, no como
filtro silencioso.** Dos filas de 67 millones bastan para que todo total, margen y gráfica de esta
fase sean basura. La compuerta se rompe a propósito una vez (prueba negativa) y lo que caiga fuera
de la cota se **declara con su monto y su `Consecutivo`**, no se borra.

---

---

#### ⭐⭐ AUDITORÍA (2026-10-07): el discriminante NO es la caja, es la CONTRAPARTE

Encargo de Edgar: *"genera una auditoría y descúbrelo o investiga si no está documentado"*.

**1. No está documentado en la fuente.** El `.mdb` trae una tabla **`Cajas`**, pero sólo tiene
folios y contadores: **ninguna columna de nombre o descripción**. Callejón sin salida, declarado.

**2. Sí se puede descubrir, por la contraparte (`MaestroMovAlmacen.Tercero` ⋈ `Clientes.Nombre`).**
La firma de cada caja de PH en 9 años separa sola:

| `Caja` | terceros distintos | contraparte dominante | lectura |
|---|---:|---|---|
| 12 · 13 · 14 · 19 · 17 · 18 · 16 · 11 · 81 · 82 | 83–2,310 | **en blanco** (76–98 %) | mostrador al público |
| 15 | 1,817 | el top es 1.5 % | preventa (cada ticket, otro cliente) |
| 70 | 797 | personas con nombre | crédito / facturación |
| 10 · 90 | 82 | `960` **VENTAS DE MOSTRADOR** | mostrador |
| **98** | **10** | `23` **RUTA 23** | **surtido a ruta** |
| **99** | **21** | `40` **ALMACEN 8 ESQUINAS** | **traspaso a sucursal** |

⭐ **Confirma a Lupita de forma independiente, y al peso.** El 99.5 % de la caja 98 va a
`RUTA 21/22/23/26/27/28/61`; la 99 va a `ALMACEN` de las ocho sucursales + CEDIS.

**3. ⛔ Y el residuo demuestra que clasificar POR CAJA está mal.** Medido en PH, 9 años:

| clase (por contraparte) | cobrado en caja 98/99 | cobrado en OTRA caja |
|---|---:|---:|
| surtido a ruta | 11,701 tickets · $163,517,569 | **26 · $99,840** |
| traspaso a sucursal | 7,136 · $300,888,630 | **38 · $926,371** |
| venta a cliente | **23 · $176,422** | 2,227,899 |

**64 movimientos internos ($1,026,211) se cobraron fuera de las cajas 98/99** —una regla por caja
los publicaría como venta— y **23 ventas reales ($176,422) se cobraron dentro** —una regla por caja
las borraría—. Error neto $849,789 en una sola sucursal, y en una plaza con registros más laxos
sería mayor.

⭐⭐ **Y lo más valioso: la regla por contraparte DISUELVE el problema del censo de cajas.** Ya no
hay que averiguar qué fue la caja 19, la 17, la 81… **se clasifica el TICKET, no el registro**, y
una caja que sólo existió en 2020 entra sin que nadie la haya catalogado. Los $20.9 M en riesgo de
§WH.0-4 dejan de estarlo.

**4. Generaliza.** La misma regla sobre otras dos sucursales (2017–2025, con la cota de cordura
puesta):

| sucursal | venta a cliente | traspaso interno |
|---|---:|---:|
| 03 8 Esquinas (`h40`) | 2,486,779 tickets · $445,024,088 | 1,419 · $5,397,838 |
| 06 Canindo (`h50`) | 879,897 tickets · $962,570,128 | 1,015 · $20,297,726 |

**5. ⚠️ Salvedad que NO se tapa: Canindo da CERO surtido a ruta teniendo rutas propias**
(`RUTA-501`…`505` existen y publican en `wincaja_ruta`). O su surtido se hace por otro mecanismo, o
—más probable— sus contrapartes se llaman distinto y el patrón `RUTA%` no las ve: en el propio PH
ya apareció **`RD CANINDO`**, que ese patrón no atrapa.

⛔ **Por eso el catálogo de contrapartes internas se DERIVA y se REVISA por sucursal; no se
hardcodea un regex.** Entregable: `analytics.wincaja_internal_parties` (tenant, sucursal, tercero,
nombre, clase) sembrada del catálogo `Clientes` y **revisada por una persona**, con lo no
clasificado **declarado con su monto** — nunca descartado ni incluido en silencio.

---

#### 📒 EL CATÁLOGO DE CONTRAPARTES (barrido de las 9 sucursales, 2017–2025)

Tres cosas salieron de correrlo, y **dos corrigen lo que yo había escrito**.

**A. ⭐⭐ El CEDIS es 100 % interno. No tiene venta.**

Sus **ocho** contrapartes son todas `ALMACEN *`:

| tercero | nombre | tickets | `ValorVenta` |
|---|---|---:|---:|
| 10 | ALMACEN PADRE HIDALGO | 3,568 | $386,268,956 |
| 30 | ALMACEN MORELIA ABASTOS | 1,295 | $340,440,157 |
| 50 | ALMACEN ZAMORA CANINDO | 1,047 | $239,678,078 |
| 40 | ALMACEN 8 ESQUINAS | 1,140 | $62,519,612 |
| 42 · 32 · 44 · 54 | las otras cuatro | 1,105 | $33,641,389 |
| | | **8,155** | **$1,062,548,192** |

**$1,062 millones** que, cargados como venta, serían doble conteo **puro** — el CEDIS surte, no
vende. ⛔ Y explica por qué el `00` aparece con tan pocos tickets (8,165 en 9 años): no es una
tienda floja, **es un almacén**.

**B. ⛔ Mi patrón por nombre tenía falsos positivos, y son obvios en cuanto se ven.**

`RUTA` casa dentro de **`FRUTA`**: quedaron marcados como internos ~60 clientes reales —
*FRUTAS Y VERDURAS RIVERA*, *CECY FRUTA*, *SRA FRUTA*, *FRUTA TIANGUIS*, *MARTIN MATA (FRUTA)*…—
y `ALMACEN` casa dentro de *FUMIGACIONES A GRANOS **ALMACEN**ADOS* y *COMERCIALIZADORA
**ALMACEN**ES GARCÍA*. Poco dinero (~$340 k en PH), pero marca a clientes de verdad como
movimiento interno. **El patrón tiene que ir anclado** (`^ALMACEN\b`, `^RUTA\b`, `^SUC\b`,
`^CEDIS\b`, `^[0-9]+ RUTA\b`).

**C. ⭐⭐ Y el hallazgo que cierra la salvedad de Canindo: el NOMBRE no alcanza — manda el CÓDIGO.**

Canindo daba cero surtido a ruta porque **sus rutas están registradas con el nombre de la
persona**:

| tercero | nombre en el catálogo | tickets | `ValorVenta` | es |
|---|---|---:|---:|---|
| 501 | VICTOR MANUEL ZALAPA BARRIGA | 2,092 | $24,453,433 | **RUTA-501** |
| 502 | DANIEL PADILLA ROJANO | 1,733 | $22,218,785 | **RUTA-502** |
| 503 | JOSE ZAVALA VILLALOBOS | 1,310 | $18,129,805 | **RUTA-503** |
| | | **5,135** | **$64,802,023** | |

**$64.8 millones de surtido a ruta que una regla por nombre publica como venta.** Y los códigos
`501/502/503` son exactamente los de `RUTA-501/502/503` que ya publican en `wincaja_ruta`: el
mismo dinero, dos veces.

⭐ **Es la lección ya documentada en `[VEC.0-6.2]`**, que yo volví a tropezar: *"el discriminante
tenía que ser el CÓDIGO, no el nombre: en Michoacán las rutas se llaman con el nombre de la
persona"*. Verificado que los códigos **sí** son estables entre sucursales:

- **Almacenes:** `0` · `10` · `30` · `32` · `40` · `42` · `44` · `50` · `54` — son los códigos de
  rama de Wincaja, los mismos de `v_branch_erp_cutover`.
- **Rutas:** `21`–`28` (PH) · `300` · `301` · `321` · `322` (Madero) · `501`–`505` (Canindo) · `61`.

**Regla final: el tercero es interno si su CÓDIGO está en el padrón de almacenes/rutas; el nombre
sólo sirve para proponer candidatos y para que un humano revise.** Lo que no case por código ni
por nombre anclado queda `sin_clasificar` **con su monto declarado**.

⚠️ **Quedan candidatos sin resolver que la revisión humana tiene que mirar**, el mayor:
`06_CAN` tercero **`70790` KARLA PAULINA YADEZ TREJO**, 904 tickets / **$17,344,443** a
**$19,186 por ticket** — ese ticket promedio es de ruta o de mayoreo, no de mostrador.

**WH.0 queda CERRADO** salvo esa revisión humana de contrapartes, que ya no bloquea el diseño:
bloquea la publicación de la cifra final, que es donde debe bloquear.

---

### 📋 `[WH.0]` — enunciado original

Sin esto no se carga una sola fila. Lo que hay que contestar, con evidencia independiente:

- ¿`ValorVenta` es el importe de la línea, o unitario? → cuadrar contra `MaestroMovAlmacen` y
  contra `PagosDia` del mismo día (lo cobrado es el árbitro, no otra columna del mismo renglón).
- ¿Trae IVA? → contra `IVA`/`IEPS` de la misma línea y contra el total del ticket.
- ¿En qué unidad está `CantidadRegular`? → `CantidadAuxiliar` y `UnidadVenta` existen al lado;
  la trampa de la unidad de línea de Wincaja ya está documentada
  ([[reference_wincaja_unit_line_flag_trap]]).
- **Placebo obligatorio:** correr el mismo arbitraje sobre un periodo que `sales_daily` YA tiene
  por el carril vivo (2026 de `04`/`05`, o las rutas) y comprobar que reproduce lo publicado. Si
  no reproduce lo conocido, el método está mal y no sirve para lo desconocido.

**Entregable:** una sección en [`VERDAD_ABSOLUTA.md`](../../VERDAD_ABSOLUTA.md) que diga qué
arbitra la venta histórica de Wincaja y cuánto aguanta. **Sin firma, la fase no avanza.**

### ✅ `[WH.1]` — Arbitraje de CORTES · **EJECUTADO 2026-10-07**

**1. La premisa del repo era cierta, y ahora está medida, no supuesta.** Cada carpeta-año contiene
**≥ 99.9 % de su propio año**. El residuo, cuantificado sobre las nueve sucursales:

| corte | de SU año | de otro año | centinela 2000 | futuro |
|---|---:|---:|---:|---:|
| 2017 | 1,091,021 | 0 | 1,573 | — |
| 2020 | 960,774 | **1,059** (0.11 %) | 35 | — |
| 2022 | 1,082,977 | 634 (0.06 %) | 1,029 | — |
| 2025 | 1,185,696 | 4 | 111 | **1** |
| los otros cinco | 5,479,018 | ≤ 338 c/u | ~2,400 | — |

⭐ **Consecuencia de diseño: el día de la venta sale de la FECHA parseada, no del nombre del corte.**
El `_dataset` sirve para la identidad y la deduplicación, nunca para fechar. Con ~2,000 tickets
mal ubicados si se fechara por carpeta, es barato hacerlo bien.

**2. ⭐⭐ Y la duplicación entre cortes está EXACTAMENTE acotada.** Identidad de ticket =
`(Documento, Caja, Fecha)`, sobre los cortes anuales + los de nombre propio (sin
`Actuales`/`Concentradas`):

| sucursal | filas | tickets únicos | repetidos | % |
|---|---:|---:|---:|---:|
| 00 · 03 · 04 · 05 · 06 · 08 | 5,430,440 | 5,430,440 | **0** | 0.00 |
| 01 Padre Hidalgo | 2,280,567 | 2,250,870 | 29,697 | 1.30 |
| 02 La Piedad | 1,131,814 | 1,013,084 | 118,730 | 10.49 |
| 07 Morelia Madero | 1,068,599 | 1,030,026 | 38,573 | 3.61 |
| **total** | **10,055,420** | **9,724,420** | **187,000** | 1.86 |

**Los repetidos cuadran al ticket con los cortes de nombre propio:**

- 01 → **29,697** = `2025-2025_dic` (29,697) ✔ exacto
- 07 → **38,573** = `2021-32_morelia_madero_01_21` (11,794) + `..._dic` (26,779) ✔ exacto
- 02 → **118,730** ≈ `2023-42_piedad_abastos2` (118,731) — **1 ticket de diferencia**, declarado

⭐ **Las seis sucursales sin cortes de nombre propio tienen CERO duplicación**: las carpetas
anuales son una partición limpia. Eso es lo que convierte §2.1 de sospecha en veredicto.

**3. El veredicto, y por qué NO es "borrar los cortes malos".** Lo obvio sería descartar los cinco
cortes con nombre; sería correcto hoy y frágil mañana (exige mantener una lista a mano, y pierde
el ticket huérfano de La Piedad). **La regla va por la identidad**: `DISTINCT ON (Documento, Caja,
Fecha)` prefiriendo el corte anual. Recupera exactamente los mismos 9,724,420 tickets, recoge el
huérfano solo, y no necesita que nadie mantenga nada.

⚠️ `2018-70_telemarketing_cia` y `2019-70_telemarketing_error` viven en `h70` (telemarketing), no
en las nueve de tienda → se arbitran en **WH.8** con las rutas.

---

### `[WH.1]` — enunciado original

Por cada `(sucursal, _dataset)`: días cubiertos, tickets por día, y el veredicto
`canónico | subconjunto_de_X | complementario | sin_arbitrar`. El criterio es el de §2.1 (días
exclusivos y conteo por día), aplicado a los ~15 cortes, no sólo a los tres que ya huelen.

**Entregable:** tabla `analytics.wincaja_hist_datasets` (dato propio, HITL) + el candado que
**bloquea la carga de cualquier corte `sin_arbitrar`**.

### `[WH.2]` — La vista de venta histórica (derive-no-copy **desde prod, por FDW**)

⭐ **CORREGIDO 2026-10-07 (Edgar: *"esta bd según yo ya estaba en postgres"*).** La primera versión
de este plan decía *"la vista vive en el espejo, no en prod: prod no alcanza a `:5433`"*. **Es
falso.** Era cierto cuando la réplica vivía en `.249` y prod en Railway; desde `[VL.7.3]` la base
`wincaja` se mudó a `md` y desde el 22-sep prod también corre ahí. Medido el 2026-10-07 desde
`pg-prod`:

```
psql postgresql://…@pgvector-md:5432/wincaja -c 'SELECT count(*) FROM h40."MaestroMovAlmacen" …'
→ ALCANZA, filas h40 2023 = 278,888
```

Y prod **ya tiene `postgres_fdw` con un servidor foráneo vivo** al mismo host
(`runner_rutas` → `host=pgvector-md, port=5432, dbname=kepler_consolidado`). O sea: el precedente
existe, funciona, y sólo falta un segundo servidor apuntando a `dbname=wincaja`.

⭐⭐ **Eso cambia el diseño hacia la REGLA PRINCIPAL del proyecto: esto es una VISTA
`derive-no-copy`, no un importer.** No hay `script → tabla` que agendar ni re-correr.

La vista normaliza: `_dataset` + `Fecha` → día, `Tipo='V'`, exclusión del centinela `2000-01-01` y
de las fechas futuras, join cabecera↔detalle **con `AND d._dataset = m._dataset`**, y la unidad y
el importe según lo que firme WH.0.

⚠️ **El crudo NO se copia a prod.** FDW lee donde está; los 35 GB se quedan en el espejo.

### 🚀 `[WH.2]` + `[WH.3]` — **EN PROD 2026-10-07**

**`[WH.2]` el FDW, aprovisionado y verificado.** `database/importers/wincaja/FDW-WINCAJA-HIST.sh`
(corrido por Edgar en `md`; la credencial se genera ahí y nunca toca el repo, patrón `[RD.34]`):

- servidor `wincaja_hist` → `host=pgvector-md, port=5432, dbname=wincaja, fetch_size=50000`
- **27 tablas foráneas en 9 schemas** `wincaja_hNN`
- rol `prod_wincaja_ro` acotado a SELECT sobre **3 tablas × 9 sucursales** (no las otras 67)
- ✔ prueba **positiva**: `wincaja_h40."MaestroMovAlmacen"` corte 2023 → **278,888**, el mismo
  número medido en el espejo esa mañana
- ✔ prueba **negativa**: `wincaja_h40."Cajas"` **no existe** → el alcance quedó acotado

**`[WH.3]` el padrón, aplicado como `batch 780` (0.1 s), con la identidad del clúster verificada.**
`analytics.wincaja_internal_parties`, **104 filas sembradas**:

| clase | origen | filas | tickets observados |
|---|---|---:|---:|
| `traspaso_interno` | nombre anclado | 75 | 31,935 |
| `surtido_ruta` | nombre anclado | 19 | 14,862 |
| `surtido_ruta` | **código** (el nombre no lo delata) | 8 | 8,185 |
| `sin_clasificar` | código ambiguo | **2** | 2,817 |

✔ prueba **negativa** en prod: el `CHECK` rechaza marcar `revisado` sin autor ni fecha.

⚠️ **La lista de revisión humana son DOS renglones**, los dos en Canindo:

| sucursal | tercero | nombre | tickets |
|---|---|---|---:|
| 06 | `24` | LUIS GABRIEL ALVAREZ MOLINA | 1,302 |
| 06 | `25` | MUNICIPIO DE JACONA MICHOACAN | 1,515 |

Hasta que alguien firme, los dos quedan fuera de la venta **y declarados** — ni descartados (sería
perder venta) ni incluidos (sería doble conteo).

⚠️ **Trampa vivida al aplicar, para la próxima:** el pod abortó con *«migration directory is
corrupt»* porque prod tenía **4 migraciones aplicadas hoy por otras sesiones** cuyos archivos no
están en la imagen del pod. Se resuelve copiando esos 4 archivos al pod antes de aplicar
(`knex.migrate.list()` compara la tabla contra el DIRECTORIO, no contra `main`). Ver
[[feedback_pod_migration_list_is_relative_to_image]].

---

### 🚀 `[WH.2b]` — La vista, **EN PROD 2026-10-07** (`batch 782`)

`analytics.v_wincaja_hist_sales` — derive-no-copy sobre el FDW, con las cinco decisiones medidas
adentro (dinero sin impuesto · día de la fecha parseada · dedup por identidad · clase desde el
padrón · cordura como **veredicto, no filtro**).

**El candado: reproduce lo ya medido.** Padre Hidalgo 2023:

| clase | tickets | `valor_venta` | margen |
|---|---:|---:|---:|
| `venta_cliente` | 269,554 | $147,289,045 | **12.21 %** |
| `traspaso_interno` | 1,042 | $58,033,035 | **2.00 %** |
| `surtido_ruta` | 1,737 | $25,983,201 | **15.06 %** |
| **total** | | **$231,305,281** | |

Contra los **$231,340,190** del barrido crudo: Δ **$34,909 (0.015 %)**, explicable por el dedup y
por acotar la ventana con la FECHA en vez del nombre del corte.

⭐ **Y una corroboración que no se buscaba: el traspaso interno da 2.00 % de margen** —
prácticamente a costo, que es exactamente lo que un movimiento interno tiene que ser — contra
12.21 % de la venta. Si el padrón estuviera mal clasificando, esos tres márgenes saldrían
mezclados. **El margen valida la clasificación sin que nadie se lo haya pedido.**

**Prueba negativa, en prod:** Padre Hidalgo 2025 devuelve **1 renglón `fuera_de_rango` con
$995,263,779,541,730 A LA VISTA** y 1,488,064 renglones `ok` con $239,654,860. El veneno se
**marca**, no se borra. Y son 1 y no 2 porque el dedup colapsó el ticket duplicado: esa pieza
también quedó probada.

⚠️ **53 s y 31 s por consulta** — confirmado lo que la migración ya declaraba: **la vista NO es
interactiva**. Es la definición auditable; quien la consume es la matvista de `[WH.4]`.

---

### `[WH.3]` — El puente producto: Wincaja `Articulo` → `catalog.products.id`

Es el riesgo silencioso más grande de la fase. Nueve años de catálogo incluyen SKUs que ya no
existen, renombrados y fusionados. Ya hay piezas: `import-wincaja-missing-products.js`,
`commercial.product_aliases`, `catalog.product_barcodes`.

**Regla:** lo que no casa **no se tira y no se inventa** — va a un almacén/producto declarado como
«sin identificar» con su importe, para que la cobertura de WH.6 lo pueda publicar. Un SKU perdido
que desaparece es venta que se evapora sin que nadie lo note.

### `[WH.4]` — La materialización, **por costo, no por falta de fuente**

⭐ **CORREGIDO 2026-10-07.** La primera versión pedía un importer
(`import-wincaja-hist-sales.js`). **Con WH.2 por FDW, el importer sobra** — y un `script → tabla`
que haya que re-correr o agendar es justo lo que la regla principal del proyecto prohíbe.

Lo que queda es una **migración**, no un script: crea el servidor foráneo a `dbname=wincaja`, las
tablas foráneas, las vistas de WH.2, y una **matview** `analytics.mv_wincaja_hist_sales` agregada a
día×producto×almacén×canal.

La matview se justifica **por costo** (GOTCHAS §19: materializar por costo es legítimo; el pecado
es materializar un valor inventado): son ~60M líneas por FDW, y el pushdown de agregados sobre
`postgres_fdw` es limitado — leer eso en cada consulta está dos órdenes de magnitud por encima del
gate de 500 ms.

⭐ **Y hay un argumento que lo vuelve seguro: la historia es ESTÁTICA.** Medido el 2026-10-07, el
espejo vivo se detuvo exactamente en el corte a Kepler de cada sucursal — `w32` el **2026-09-08**,
`w30` el **2026-09-18**, `w00` el **2026-09-30** — porque **Wincaja ya no es fuente viva de nada**.
No va a llegar un ticket más. Una matview de un corpus cerrado no puede quedar rezagada.

⚠️ **Ventana:** el `REFRESH` inicial toca ~60M líneas por red. Va **fuera de horario hábil**, con la
misma regla de siempre.

De ahí, el volcado a `analytics.sales_daily` es un `INSERT … SELECT` desde la matview por su llave
única `(tenant_id, product_id, warehouse_id, channel, sale_date)`. Idempotente por construcción.

### `[WH.5]` — El corte, corregido en el resolvedor

Cambiar `v_branch_erp_cutover` para `03`/`04`/`05`: de `-infinity` a su fecha real de traspaso, para
que la pierna Wincaja de esas tres entre. **Una migración, un solo lugar** — el comentario de la
vista ya advierte que copiar el corte a mano costó $1.63M de Abastos invisibles.

⛔ **Esto es lo que enciende la historia en las pantallas**, y es también lo que puede doblar la
venta si la ventana queda mal. El candado de paridad del sell-out (`test-newdb-sellout-parity.js`,
Fase VP) ya mide traslape **y hueco**: se corre antes y después, y tiene que seguir en 0.00.

### `[WH.6]` — Cobertura y procedencia en pantalla

> **Para qué sirve todo esto, en palabras de Edgar (2026-10-07):** *"más que nada para métricas y
> gráficas que importan bastante a la hora de hacer una compra"*. El consumidor concreto es el
> globo **«Venta por mes»** de `/compras/pedido` (`[RA-PRO.65]`), que hoy enseña trece meses con la
> serie **«año anterior» vacía** y el prorrateo 60/40 en `—`.

**Cuánto de eso arregla esta fase, medido en Padre Hidalgo:**

| | SKUs |
|---|---:|
| activos que **venden hoy** y **no tienen con qué comparar** (su serie de año anterior está muda) | **1,352** |
| …de ésos, los que **sí tienen historia en Wincaja** → recuperan la comparación | **698 (51.6 %)** |
| …los que **no** la tienen: son productos nuevos, su gráfica está muda **con razón** | 654 |

⭐ **Más de la mitad de las gráficas mudas se arreglan. La otra mitad está muda con razón** — y eso
también hay que decirlo, no esconderlo.

⛔ **Y ahí está el defecto que esta fase tiene que corregir en la pantalla.** El globo dice hoy
**«sin venta registrada el año anterior»** en los dos casos, y **no son el mismo caso**:

- **No vendió** → afirmación medida. Correcta.
- **No hay historia cargada** → *no se midió*, y decir «no vendió» es afirmar un cero que nadie
  comprobó. Es exactamente ADR-056 sobre la pantalla en la que más cuesta: la de decidir una compra.

**Ejemplo real, de la captura que lo disparó:** SKU **95775** (*EST GOM PELAFRUT MANGO 800GR /
KALU*) en 01 Padre Hidalgo. Su serie de año anterior está vacía, y **está bien**: el producto se dio
de alta en el catálogo el **2026-06-29**, dos días después de que PH migrara a Kepler, y **no existe
en el espejo de Wincaja** (0 renglones en 9 años). Para ese SKU la fase no aporta nada — y la
pantalla debería decir *«producto nuevo: no hay año anterior»*, no *«sin venta registrada»*.

**Entregable de WH.6:** cada serie histórica viaja con su cobertura (`Coverage` del contrato de
procedencia) y la pantalla distingue **tres** estados, no dos: *vendió X · no vendió · no hay
historia para este producto/sucursal*.

Que las pantallas que ya consumen el fact (sell-out, `/comercial/ventas-por-ruta`, Command Center,
Rentabilidad) **declaren** desde cuándo hay historia por sucursal. Hoy un comparativo 2024 vs 2025
devuelve cero para 2024 y se lee como «vendimos cero», no como «no hay dato».

### `[WH.7]` — Reconciliación contra un árbitro externo

Cuadrar la venta histórica cargada contra algo que no sea Wincaja: la balanza de ContPAQi
(`analytics.contpaqi_ledger_monthly`) por mes y sucursal. Es el único testigo independiente que
cubre 2017–2025. Lo que no cuadre se declara con monto.

### `[WH.8]` — Las rutas y el CEDIS

`h20`–`h27`, `h50x`, `h51`, `h70`, `h321`, `h322` y `h00`. Se separan a propósito: las rutas tienen
su propia trampa de unidad y de caja ya documentada (`[VEC.0-6.2]`, la vecinal publicaba 2.07×), y
el CEDIS son 8,165 tickets en nueve años — no es venta de mostrador.

**MVP = WH.0 → WH.6.** WH.7 y WH.8 después.

---

## 5. Lo que NO se hace, y por qué

- **No se tocan los `.mdb` ni `Z:\Salidas\Bases`.** El corpus ya está en Postgres (§0). Volver al
  origen sería repetir 72 minutos de copia y 22 GB para llegar al mismo lugar.
- **No se cargan `Actuales` ni `Concentradas`** (§2.2): son 2026 y ya están.
- **No se inventa un canal `wincaja_hist`**: el canal dice qué venta es, no cuándo se cargó.
- **No se "rellena" lo que falta.** Yurécuaro no tiene 2017 porque la tienda no existía; eso se
  declara, no se interpola.
- **No se sube el crudo a prod.** 35 GB de renglones no tienen consumidor; FDW los lee donde están.
- **No entra a `run-prod-feeds.js`, y tampoco se escribe un importer** (ver WH.4 corregido): con
  prod leyendo el espejo por FDW, esto es una vista derivada con una materialización por costo.
- **No se reactiva nada de Wincaja.** Medido: el espejo vivo se detuvo en el corte a Kepler de cada
  sucursal (la última, el CEDIS, el **2026-09-30**). Wincaja es un **acervo**, no una fuente.

---

## 6. Decisiones abiertas (Edgar)

1. ✅ **RESUELTA (Edgar, 2026-10-07): «con los 9 son suficientes».** El alcance de esta fase es
   **2017–2025**. Los ocho años de 2009–2016 **no entran**.
   ⚠️ **Y por eso se declara, no se olvida:** esos ocho años existen **sólo** como `2009.7z` …
   `2016.7z` (0.94 GB) en `Z:\Salidas\Bases`. Nadie los tiene en Postgres, y el share ya demostró
   que se vacía (2017 y 2018 ya no están descomprimidos allá). **No se borran**; si algún día se
   quieren, entran con el mismo cargador vía `WINCAJA_HIST_YEARS`, sin código nuevo.
   Cualquier pantalla que publique «desde cuándo hay historia» tiene que decir **2017**, no
   insinuar que antes no hubo venta.
2. **¿A qué almacén va la historia de `03`, `07` y `08`?** Los otros cinco ya tienen precedente
   medido (escriben al mismo código que Kepler). Estos tres no tienen ni una fila Wincaja hoy.
3. **El corte de `03`/`04`/`05`** (§2.7): hay que fijar la fecha real de traspaso de cada una.
   Es un dato del negocio, no se puede derivar sin riesgo (el comentario del resolvedor advierte
   que en Piedad las piernas se traslapan 9 meses).
4. **Los dos huecos ya documentados y sin dueño**: rama 30 el 2026-09-18 ($418,721.65) y rama 10
   del 2026-06-27 al 06-30 ($916,629.73). Esta fase los puede cerrar de paso, si se autoriza.
5. **La ventana de carga.** ~60M líneas contra prod: hay que acordar noche o fin de semana.

---

## 7. Referencias

- [`FASE_WR_WINCAJA_REPLICA.md`](FASE_WR_WINCAJA_REPLICA.md) — el espejo crudo y el carril vivo.
- [`FASE_W_WINCAJA.md`](FASE_W_WINCAJA.md) · [`FASE_WP_WINCAJA_POSTGRES.md`](FASE_WP_WINCAJA_POSTGRES.md)
- [`VERDAD_ABSOLUTA.md`](../../VERDAD_ABSOLUTA.md) — ADR-059, dónde debe quedar lo que firme WH.0.
- [`UNIDADES_DE_MEDIDA.md`](../../UNIDADES_DE_MEDIDA.md) — ADR-057, el resolvedor de unidad.
- `analytics.v_branch_erp_cutover` (mig `20260923120000`) — el resolvedor del corte.
