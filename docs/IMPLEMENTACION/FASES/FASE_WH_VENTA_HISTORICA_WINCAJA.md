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

### ⛔ `[WH.0]` — Arbitrar `ValorVenta` · **RUTA CRÍTICA, bloquea todo lo demás**

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

### `[WH.1]` — Inventario y arbitraje de CORTES

Por cada `(sucursal, _dataset)`: días cubiertos, tickets por día, y el veredicto
`canónico | subconjunto_de_X | complementario | sin_arbitrar`. El criterio es el de §2.1 (días
exclusivos y conteo por día), aplicado a los ~15 cortes, no sólo a los tres que ya huelen.

**Entregable:** tabla `analytics.wincaja_hist_datasets` (dato propio, HITL) + el candado que
**bloquea la carga de cualquier corte `sin_arbitrar`**.

### `[WH.2]` — La vista de venta histórica (derive-no-copy sobre el espejo)

Vista por sucursal en la base `wincaja` que normaliza: `_dataset` + `Fecha` → día,
`Tipo='V'`, exclusión del centinela y de las fechas futuras, join cabecera↔detalle **con
`_dataset`**, y la unidad y el importe según lo que firme WH.0.

⚠️ **La vista vive en el espejo, no en prod**: prod no alcanza a `:5433` y el crudo pesa 35 GB.
Lo que viaja a prod es el agregado día×producto×almacén, no el renglón.

### `[WH.3]` — El puente producto: Wincaja `Articulo` → `catalog.products.id`

Es el riesgo silencioso más grande de la fase. Nueve años de catálogo incluyen SKUs que ya no
existen, renombrados y fusionados. Ya hay piezas: `import-wincaja-missing-products.js`,
`commercial.product_aliases`, `catalog.product_barcodes`.

**Regla:** lo que no casa **no se tira y no se inventa** — va a un almacén/producto declarado como
«sin identificar» con su importe, para que la cobertura de WH.6 lo pueda publicar. Un SKU perdido
que desaparece es venta que se evapora sin que nadie lo note.

### `[WH.4]` — El cargador por lote (sucursal × corte)

`import-wincaja-hist-sales.js`: lee la vista de WH.2, agrega a día×producto×almacén×canal, y hace
UPSERT contra `analytics.sales_daily` por su llave única. One-shot, idempotente, reanudable por
`(sucursal, corte)`, con latido propio (`fact_wincaja_hist_sales`) y umbral en `CRON_JOBS`.

⚠️ **Ventana:** ~9.7M tickets / ~60M líneas. Va **fuera de horario hábil** y por lotes, con la
misma regla de siempre: nada de escrituras pesadas contra prod en horario de trabajo.

### `[WH.5]` — El corte, corregido en el resolvedor

Cambiar `v_branch_erp_cutover` para `03`/`04`/`05`: de `-infinity` a su fecha real de traspaso, para
que la pierna Wincaja de esas tres entre. **Una migración, un solo lugar** — el comentario de la
vista ya advierte que copiar el corte a mano costó $1.63M de Abastos invisibles.

⛔ **Esto es lo que enciende la historia en las pantallas**, y es también lo que puede doblar la
venta si la ventana queda mal. El candado de paridad del sell-out (`test-newdb-sellout-parity.js`,
Fase VP) ya mide traslape **y hueco**: se corre antes y después, y tiene que seguir en 0.00.

### `[WH.6]` — Cobertura y procedencia en pantalla

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
- **No se sube el crudo a prod.** 35 GB de renglones no tienen consumidor; el agregado sí.
- **No entra a `run-prod-feeds.js`.** Es una carga por lote que termina, no un carril.

---

## 6. Decisiones abiertas (Edgar)

1. **¿Hasta dónde atrás?** El espejo tiene 2017–2025. Los `.7z` de **2009–2016** existen y no están
   extraídos. Mi recomendación: **cerrar 2017–2025 primero** y decidir 2009–2016 con la fase ya
   entregada — nueve años ya cubren cualquier comparativo que el negocio pida hoy.
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
