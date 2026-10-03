# Fase RD — Inventario de las rutas de Ruta Directa (RD.9 … RD.13)

> **Estado**: 🧪 **RD.9–RD.13 EN CÓDIGO** (2026-10-02) — migración + backend + pantalla + candado
> **18 ✓ / 0 ✗** contra prod. Falta aplicar la migración, push, redeploy y validación visual.
> La evidencia de abajo está **medida contra prod** (`pg-prod`,
> `system_identifier 7688376744939610156`) en lectura.
> Compañero de [`FASE_RD_INDICADORES_RUTA.md`](FASE_RD_INDICADORES_RUTA.md), dueña del universo de
> rutas RD, que dejó el costo **declarado como hueco** en sus §2.3 y §9.3. Esta fase lo cierra y
> agrega lo que RD nunca tuvo: **el inventario del camión**.

**El pedido, acotado por Edgar (2026-10-02):**
1. ⭐ **Lo más importante: cuánto inventario tienen**, con su **valor a costo** y su **valor a venta**.
2. **Historial** con filtro de **rango de fechas**.
3. **Si no hay inventario inicial, no importa** — se trabaja con la información existente.
4. **`RD 501`–`RD 505` sólo reciben de Canindo**; lo que aparece desde el CEDIS son traspasos de
   cuando Canindo todavía no tenía Kepler.

---

## 1. El número que se pidió, ya medido

El inventario se publica como un **cuadre**, no como un dato suelto: `cargado − vendido =
inventario`, y **la identidad cierra al centavo en las dos valuaciones** (medido: `delta` = 0.00 en
las 22 filas). Ventana completa, desde la primera carga de cada plaza.

| ruta | cargado (costo) | costo de lo vendido | **inventario a COSTO** | venta a cliente | **inventario a VENTA** | SKU +/− |
|---|---|---|---|---|---|---|
| 21 | $1,033,145 | $1,035,229 | **−$2,085** | $1,330,053 | **−$11,043** | 180 / 180 |
| 22 | $851,532 | $835,563 | **$15,969** | $1,098,907 | **$5,480** | 247 / 219 |
| 23 | $1,075,944 | $1,087,204 | **−$11,260** | $1,410,333 | **−$21,608** | 159 / 232 |
| 26 | $980,031 | $966,037 | **$13,994** | $1,256,601 | **$3,444** | 239 / 249 |
| 27 | $1,078,839 | $1,058,211 | **$20,628** | $1,351,419 | **$17,563** | 225 / 161 |
| 28 | $727,752 | $723,287 | **$4,465** | $948,905 | **−$12,244** | 218 / 253 |
| 501 | $595,108 | $554,961 | **$40,147** | $735,572 | **$34,154** | 291 / 163 |
| 502 | $537,768 | $529,290 | **$8,478** | $696,279 | **−$320** | 209 / 185 |
| 503 | $715,020 | $705,132 | **$9,888** | $932,410 | **$3,451** | 197 / 162 |
| 504 | $528,010 | $511,539 | **$16,470** | $681,743 | **$1,914** | 217 / 174 |
| 505 | $214,247 | $212,373 | **$1,874** | $284,337 | **−$9,136** | 150 / 197 |

⭐ **La respuesta de fondo: los camiones NO acumulan.** El saldo neto desde la primera carga es
**±1 a 4% de lo cargado** — venden prácticamente lo que se les carga. Eso es un hallazgo, no un
problema: dice que no hay inventario escondido en la flota.

⭐ La consulta completa corre en **664 ms** (ledger entero, 107,747 filas), dentro del gate de 1 s.
**No hace falta matvista.**

⚠️ **El inventario sale partido en "a favor" y "en contra", y no se netea en silencio.** Cada ruta
tiene 150–291 pares `(sku, unidad)` con saldo positivo y 160–253 con saldo negativo, del mismo
orden de magnitud. El negativo **no es un error de cálculo**: son SKUs que el camión ya traía antes
de que arranque la ventana (en PH la venta empieza el 29-jun y la primera carga documentada es el
15-jul). Se probó y se descartó la explicación alternativa: **no los fabrica el split de unidad** —
de los 229 SKUs negativos de la ruta 23, **sólo 1** tiene además saldo positivo en otro peldaño.

⭐ **Cobertura: 633 pares sin costo y 256 sin precio, de 8,504** (7.4% y 3.0%). El costo lo cubre el
propio embarque por construcción; lo que falta son los SKUs que el camión ya traía. Se declara en
pantalla, no se dibuja en $0.

## 2. La corroboración de la fórmula

**La fórmula es correcta y es la única posible — pero no porque Kepler la publique, sino porque
Kepler NO publica ningún saldo de ruta.** Medido:

| Tabla de Kepler | Qué guarda | ¿Trae almacenes de ruta? |
|---|---|---|
| `kepler_ods.kdil` | existencia por almacén | ⛔ **NO.** Todas sus filas tienen `c1 = sucursal` |
| `kepler_ods.kdij` | kardex (movimiento valorizado) | ⛔ **NO.** 0 movimientos de ruta en 90 días |
| `kepler_ods.kdm1`/`kdm2` | documentos | ✅ **SÍ.** `01-001`…`01-006` como `kdm1.c1` |

⭐ **La existencia de una ruta no se LEE, se RECONSTRUYE.** No hay tabla que preguntar; hay
documentos que sumar.

### 2.1 Los documentos, decodificados

| Papel | Doctype | Dónde vive | Valuación |
|---|---|---|---|
| **Entrada (carga)** | `U-D-41-2` *Embarque* | almacén **madre**, `c10` = `RUTA 21`…`RUTA 28` (suc `01`) o `RD 501`…`RD 505` (suc `06`) | **al COSTO** (§2.2) |
| **Salida (venta)** | `U-D-10` *Ticket Contado* | almacén de la **ruta** (`01-00N`) | precio `c12`/`c13`; **costo `c62` total, `c63` unitario** |
| **Inicial** | `N-A-45` + `N-A-30` | almacén de la ruta | existe para **1 de 11 rutas** — no se usa (§1) |
| **Ajuste** | `N-A-20` entrada / `N-D-5` salida | almacén de la ruta | costo |
| **Retorno** | ⛔ **no existe** (§3.2) | — | — |

Comprobación del costo por línea de venta (`01-003`, 01-oct): `24 × 8.72 = 209.28 ≈ c62 209.3`;
`12 × 11.95 = 143.4 = c62`. `c63` es el costo unitario **en el peldaño cobrado** — la columna que
ADR-051 nombró como costo canónico del hecho de venta, aquí disponible por ruta.

⚠️ `kdm1.c1` **es el almacén** y el folio **no es único entre almacenes de la misma sucursal** (la
`01` tiene dos cabeceras con folio `0000001`, una de `01-006` y otra de `01`). Todo join
`kdm1 ⋈ kdm2` lleva la llave **completa** `sucursal + c1..c6`.

### 2.2 ⚠️ Hay DOS costos para la misma mercancía — y la primera medición estaba mal ponderada

La pregunta *"¿a qué valor se les carga?"* tiene dos respuestas y hay que elegir una.

**Primera medición (septiembre, por pares, sin peso):** comparando el precio unitario del embarque
contra el costo unitario de la venta, **11,175 de 12,418 pares (90.0%) con razón 1.000**, contra 37
(0.3%) que coincidían con el precio de venta. De ahí salió —correctamente— que **el embarque NO va
a precio de lista**.

⛔ **Pero "90% coinciden" era un artefacto de contar filas.** Repetida sobre el **mismo universo**
(ruta 23, misma venta, mismos días) y **pesada por dinero**:

    COGS con el costo del embarque .... $504,835
    COGS con el `c62` que el ERP escribe en la venta .... $429,848      razón 1.1744

    316 pares coinciden exacto ($134,873)   ·   326 pares el embarque está ARRIBA ($345,038)

Y la forma de la diferencia **no es un impuesto**: se probó contra los escalones 1.08 (IEPS), 1.16
(IVA) y 1.2528 (ambos) y las razones no caen ahí — van de 1.01 a 1.32, con cola. Es la misma
familia que la **Fase CE** documentó: la ficha contra el costo del documento.

⭐ *Contar filas ordena al revés que contar pesos.* La conclusión fuerte («el embarque va al costo»)
sigue en pie; el «90%» no.

### 2.2b ⭐ Cuál de los dos se eligió, y por qué

**Se valúa con el costo del EMBARQUE**, por dos razones:

1. **Es el único con el que el cuadre CIERRA.** Las tres líneas de la columna usan el mismo valor
   unitario, así que `cargado − vendido − inventario = 0` exacto. Mezclar el `c62` en el COGS y el
   embarque en el inventario rompe la identidad por la deriva, y un estado que no cierra no es un
   estado.
2. **Es la cuenta real del camión.** El camión responde por lo que su sucursal le cargó. Ése es el
   marco de responsabilidad, y es el que la pantalla publica.

⚠️ El `c62` **no se tira**: viaja como `cogs_erp`, **línea de contraste rotulada**, nunca sumada ni
promediada con la columna de costo. La diferencia entre ambos (para la ruta 23, ~$75,000 en la
ventana) es ella misma una cifra que alguien debería mirar: es la brecha entre lo que la sucursal
le cobra al camión y lo que el ERP dice que costó la mercancía.

### 2.3 El mapeo ruta ↔ almacén, verificado al centavo

No se tomó del `ROUTE_MAP` del importer: se **probó** cruzando la venta diaria del almacén contra la
del carril push, que son dos capturas independientes del mismo hecho.

| almacén Kepler | ruta | 15-sep, ODS | 15-sep, push |
|---|---|---|---|
| `01-001` | **21** | $21,649.28 | $21,649.28 |
| `01-002` | **22** | $16,477.58 | $16,477.58 |
| `01-003` | **23** | $27,067.96 | $27,067.96 |
| `01-004` | **26** | — (hueco) | $19,823.26 |
| `01-005` | **27** | $28,041.74 | $28,041.74 |
| `01-006` | **28** | $16,044.96 | $16,044.96 |

Exacto en 5 de 6; el 6º es un **hueco del ODS**, no un desacuerdo (§3.3).

### 2.4 ✅ El CEDIS no carga rutas — confirmado

Edgar lo dijo y la medición lo confirma. Filtrando el doctype correcto (`U-D-41`), en toda la
historia el CEDIS emitió **un solo embarque a una ruta**: `RD 502`, **$23,263, el 11-ago-2026** —
tres días **antes** del cutover de Canindo a Kepler (14-ago). Todo lo demás sale de la sucursal `06`.

⚠️ **Esto corrige una versión anterior de este documento**, que reportaba 112 documentos y $1.68M
desde el CEDIS y lo marcaba como riesgo de doble conteo. La consulta que lo sostenía **no filtraba
el doctype**, así que sumaba el pedido `U-D-40` junto con el embarque `U-D-41` y duplicaba. *Una
medición sin el filtro del doctype no mide el hecho, mide la familia.*

⇒ **Regla**: la carga de `RD 5xx` se lee sólo del emisor `06`; el documento del CEDIS se excluye por
fecha (anterior al cutover) y se declara.

---

## 3. Lo que hay que saber antes de construir

### 3.1 ✅ Sin inventario inicial — resuelto por decisión

El ancla sólo existe para `01-006` (ruta 28), del 26-jun-2026, $47,597. **Edgar autorizó trabajar
sin ancla.** La consecuencia operativa está medida en §1.1 y se publica, no se esconde: la ventana
arranca en la **primera carga** de cada plaza y el saldo se rotula `sin_ancla`.

⚠️ **La ventana arranca en la primera CARGA, no en la primera venta.** Arrancar en la venta mete
dos semanas de salidas sin su entrada y hunde el saldo artificialmente.

### 3.2 ⚠️ No existe documento de retorno

Se buscó el papel con el que el camión regresa mercancía y **no hay ninguno**. Los `U-A-50` que
recibe el almacén `01` vienen de `TI000` (CEDIS) y de otras sucursales; **ni uno de una ruta**. Las
notas de crédito `U-A-21`/`U-A-25` vienen de clientes (`C10xx`).

Es consistente con un camión de inventario rodante. No bloquea el entregable, pero significa que
**lo que baje del camión sin papel queda sumando en el saldo positivo**. Es una de las cosas que el
número va a revelar.

### 3.3 ⛔ La venta tiene dos capturas y la del ODS cubre menos de la mitad

Sobre la **ventana completa** (desde la primera carga), la copia que la sucursal tiene del mismo
ticket cubre esto del carril push:

| ruta | días ODS | días push | venta ODS | venta push | **cobertura** |
|---|---|---|---|---|---|
| 21 | 30 | 67 | $590,514 | $1,330,053 | **44.4%** |
| 22 | 33 | 68 | $523,149 | $1,098,907 | **47.6%** |
| 23 | 32 | 68 | $655,173 | $1,410,333 | **46.5%** |
| 26 | 29 | 67 | $538,964 | $1,256,601 | **42.9%** |
| 27 | 32 | 67 | $673,414 | $1,351,419 | **49.8%** |
| 28 | 25 | 62 | $396,713 | $948,905 | **41.8%** |

⚠️ **Le faltan DÍAS, no dinero**: la venta por día coincide entre las dos fuentes ($19,852 contra
$19,684 en la ruta 21). Una medición anterior de este documento reportó 81–90% porque miraba una
ventana más corta — *otra ventana, otra afirmación*.

⇒ **La salida se toma de `analytics.route_push_lines`** (cada camioneta sube su venta al runner
cada 15 min). Trae `sku`, `qty`, **`unidad`**, `importe` y `precio_unitario`. Usar la copia del ODS
duplicaría el inventario con venta que no vio.

⭐ Y el **costo no hace falta pedírselo a la venta**: sale del embarque. El `c62` del ODS queda como
línea de contraste (§2.2b), que es justamente lo que su cobertura parcial le permite ser.

### 3.4 ✅ Las unidades coinciden entre carga y venta

Vocabulario del lado carga: `PAQ` 27,714 · `PZA` 11,048 · `KG` 3,578 · `500` 193 · `CJA` 39 ·
`250` 29 · `CUB` 13 · `400` 1, más **67 líneas con unidad vacía**. El lado venta usa el mismo
vocabulario. El balance va por `(sku, unidad)` sin conversión, que es lo que evita el pecado de
ADR-055; las líneas sin unidad se excluyen y **se cuentan en pantalla**.

### 3.5 ⚠️ Alcance: 11 rutas, no 13

| familia | carga (`U-D-41`) | venta (push) | inventario |
|---|---|---|---|
| PH `21, 22, 23, 26, 27, 28` | ✅ desde suc `01`, 15-jul | ✅ | ✅ |
| Canindo `501–505` | ✅ desde suc `06`, 14-ago | ✅ | ✅ |
| Morelia `321, 322` | ⛔ no hay embarque | ⛔ | ⛔ **fuera**, se declara |
| Vecinales `1V001–1V004` | ⛔ no hay embarque | ✅ | ⛔ fuera — venden del almacén madre, no son camión con stock |

### 3.6 ✅ Rendimiento: cabe sin materializar

El balance completo de las 11 rutas (carga desde el ODS ⋈ venta del push, agrupado por sku y unidad,
valuado a costo y a precio) corre en **598 ms**. **No hace falta matvista.**

⚠️ Esto **corrige** una versión anterior de este documento, que concluía lo contrario a partir de un
estudio SKU×SKU de la razón carga/costo que tardó 59.6 s. Ese estudio es una **validación de una
sola vez** (§2.2), no la consulta de entrega. *Medir la consulta parecida, no la real, es el error
que el propio repo ya tiene documentado.*

---

## 4. El plan, y lo entregado

| # | Sprint | Qué entrega | Estado |
|---|---|---|---|
| **RD.9** | **Resolvedor de ruta** | `analytics.v_rd_route_identity` — las 11 rutas con sus cinco nombres (`RUTA 23` destino · `01-003` almacén · `23` route_code · `00023` en `c12` · `RUTA-23` en `commercial.warehouses`), plaza y **primera carga DERIVADA** | ✅ mig `20261003120000` |
| **RD.10** | **Ledger + el cuadre** | `analytics.v_rd_route_ledger` al grano `(ruta, fecha, clase, sku, unidad)` + `GET /commercial/analytics/route-inventory` con las dos columnas cerrando | ✅ mig + `commercial-analytics` |
| **RD.11** | **Historial por rango** | Los mismos renglones acotados a `[from, to]`; sin rango = toda la ventana | ✅ mismo endpoint |
| **RD.12** | **Costo con veredicto** | `cogs_erp` como línea de contraste rotulada + `veredicto` por SKU (`ok` / `negativo_sin_ancla` / `sin_costo` / `sin_precio`) | ✅ |
| **RD.13** | **Pantalla** | `/comercial/inventario-ruta` (tab en Reportes): conmutador **costo ↔ venta**, rango de fechas, cuadre en pantalla, detalle por SKU, cobertura y declaraciones visibles | ✅ |
| — | **Candado** | `database/tests/test-newdb-rd-route-inventory.js` en la regresión: **18 ✓ / 0 ✗ / 1 no medido** | ✅ |

**Permiso**: reusa `COMMERCIAL_ROUTE_SALES_VER` — es la misma operación mirada del otro lado.
**Sin permisos nuevos ⇒ sin re-login.**

**Diferido, ya no bloquea**: el conteo físico del camión (sería el ancla que convierte el saldo en
existencia absoluta).

### 4.1 Lo que NO se va a hacer, y por qué

- **No se toca `analytics.stock_movements` ni su importer.** Quitarle el filtro `c1 = sucursal`
  traería de vuelta las réplicas cruzadas a `/almacen/movimientos`, que está en producción (§5.1).
- **No se toca `v_route_sales_lines.importe`.** Mueve pagos de comisiones (fase RD §2.2).
- **No se crea tabla de inventario de ruta.** Es derivable del ODS y del push en 598 ms → vista
  (regla #1 del proyecto).
- **No se netea el positivo contra el negativo** (§1.1).

### 4.2 Verificación — qué prueba cada sprint

| Sprint | Candado |
|---|---|
| RD.9 | Las 11 rutas resuelven en los cinco vocabularios o la fila se declara incompleta. **Negativa**: un nombre inventado no resuelve |
| RD.10 | Σ carga de la vista == Σ por `dest_code` de `analytics.stock_movements` por ruta y mes — dos implementaciones distintas del mismo hecho (§5.1). Anti-duplicación: una cabecera por `(sucursal, c1..c6)`. La tabla de §1 reproducida |
| RD.11 | El historial de un rango que cubre toda la ventana == el saldo de RD.10, al centavo |
| RD.12 | La tabla de §2.2 reproducida. **Negativa**: forzar el precio de lista como costo tiene que poner el candado en rojo |
| RD.13 | `<1 s` medido con `Buffers` sobre la consulta real. El contador de pares `sin_precio` y de líneas sin unidad, **en pantalla** |

---

## 5. De dónde sacan hoy los datos las dos pantallas relacionadas

### 5.1 `/almacen/movimientos`

`AlmacenMovimientosService` → `GET /commercial/movements/{summary,aggregate,lines,document,…}` →
`CommercialMovementsService` → **`analytics.stock_movements`** (más `analytics.transfer_dest_map`
para rotular el destino), que puebla `database/importers/kepler/import-stock-movements.js` leyendo
`kepler_ods.kdm1 ⋈ kdm2` server-side.

⛔ **No puede mostrar la ruta, por construcción.** El importer trae `WHERE btrim(h.c1) =
btrim(h.sucursal)` para des-duplicar las réplicas cruzadas del ODS; pero `c1` **es el almacén**, así
que el filtro tira todo almacén que no sea el principal. Medido: **0 filas** de almacén de ruta en
90 días.

⭐ **Y sin embargo la carga YA ESTÁ ahí**, del lado del emisor, con el destino rotulado — lo que la
vuelve el **árbitro independiente** del candado de RD.10:

| `dest_code` | líneas | importe (ago–oct) |
|---|---|---|
| `RUTA 21` | 4,012 | $789,954 |
| `RUTA 23` | 4,553 | $832,133 |
| `RUTA 27` | 3,515 | $843,520 |

(`RUTA 23`: $832,133 contra $832,134 de la cabecera cruda.)

### 5.2 `/comercial/ventas-por-ruta`

`ComercialService` → `GET /commercial/analytics/sales-by-route` → `CommercialAnalyticsService`: la
**matriz** lee `analytics.sales_by_route_monthly` (rollup mensual); el **detalle** va en vivo sobre
`analytics.v_route_sales_lines`; el bloque diario usa `analytics.mv_rd_route_daily_200d`.

⛔ **No tiene costo.** Últimos 60 días: de las 15 rutas con venta por el carril `push`, **0 días**
traen costo (`costo_status = 'sin_dato_en_la_fuente'`). ⭐ La causa es la ruta del dato: el push lee
la venta del Kepler local de cada camioneta y **ese extracto no sube las columnas de costo**. El
costo existe en la copia de la sucursal (`c62`/`c63`) y, para el inventario, en el embarque.

---

## 6. Evidencia — cómo reproducir

Todo con `PROD_DB_URL` (lectura), verificando primero `system_identifier`. Anclas:

- **carga**: `kepler_ods.kdm1` con `c2='U' c3='D' c4=41` y `c10` en `'RUTA %'`/`'RD %'`; emisor `01`
  para PH y `06` para Canindo; línea en `kdm2` por la llave completa, excluyendo `c11` en
  (`'SER'`, vacío). Ventana desde 2026-07-15 (PH) / 2026-08-14 (Canindo);
- **venta**: `analytics.route_push_lines` por `route_no`, con `unidad` y `precio_unitario`;
- **saldo**: `FULL OUTER JOIN` por `(route_no, sku, unidad)`; costo unitario = `Σc13/Σc9` de la
  carga; precio unitario = `Σimporte/Σqty` de la venta;
- **el costo de la carga es el costo**: join por `(sku, unidad)` entre la carga y `c63` de la venta
  del mismo mes y ruta;
- **`kdil`/`kdij` sin rutas**: agrupar por `(sucursal, c1)` y por `(sucursal, c19)`.
