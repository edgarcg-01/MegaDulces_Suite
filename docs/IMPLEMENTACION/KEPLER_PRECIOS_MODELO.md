# Modelo de precios de Kepler — qué campo usar según su función

> Investigación 2026-08-24 sobre `kepler_ods` (prod) contrastada contra las réplicas locales de las 7 sucursales. Todo lo que sigue está **medido**, no supuesto. Motivo: el SKU `90042` se publicaba a $8.48 cuando su precio real es $27.96, y la causa resultó ser una lectura equivocada del campo, no un feed atrasado.

---

## 1. Resumen ejecutable

**Kepler no tiene "un precio".** Tiene cinco campos con funciones distintas, y el que la plataforma lee hoy (`kdii.c90`) es el menos confiable de todos.

| Fuente | Función real | Granularidad | ¿Viva? | Usar para |
|---|---|---|---|---|
| `kdpv_bitacora_precios` | **bitácora de cambios de precio** | sucursal × SKU × **unidad** × timestamp | ✅ hoy, las 7 sucursales | **precio de lista vigente** |
| `kdpv_prod_util` | escalera de volumen | sucursal × SKU × presentación × tier | ✅ | **precio por cantidad** |
| `kdm2.c12` | precio realmente cobrado | línea de venta | ✅ | **testigo / control** |
| `kdii.c90/c91/c92` | precio del catálogo por *posición de unidad* | sucursal × SKU | ⚠️ se queda viejo | último recurso |
| `kdik.c16` | costo | sucursal × SKU | ✅ | margen y validación |

**Regla de uso:** el precio de lista sale de la **bitácora**, la escalera de `kdpv_prod_util`, y `kdm2.c12` valida que lo publicado se parezca a lo cobrado. `kdii` sólo como respaldo cuando no hay nada más.

---

## 2. `kdii.c90/c91/c92` — el campo que estábamos leyendo mal

### El decode correcto

La documentación previa decía **`c90`=pieza, `c91`=paquete, `c92`=caja**. **Es falso.** Los tres son *slots posicionales* de la escalera de unidades del producto:

- **`c90` = precio de la UNIDAD BASE**, la que declara `c11`. Verificado: de 18,967 SKUs cuyo último cambio en la bitácora fue sobre su unidad base, **18,444 (97.2%) casan con `c90`**.
- `c91` y `c92` = precios de las unidades alternas (`c80`/`c81` y `c83`/`c84`), en el orden en que estén dadas de alta.

Qué unidad cae en qué slot **cambia por producto y por sucursal**. Medido sobre el último precio de cada unidad en la bitácora:

| unidad | filas | `==c90` | `==c91` | `==c92` |
|---|---|---|---|---|
| PZA | 8,930 | **8,515** | 3,194 | 1,288 |
| PAQ | 27,177 | **24,228** | 10,359 | 436 |
| CJA | 30,979 | 262 | **18,035** | 12,048 |

`PAQ` casa con `c90` en el 89% de los casos — porque para la mayoría de los productos de dulcería **la unidad base es el paquete, no la pieza**. Leer `c90` como "precio de pieza" y multiplicarlo o compararlo contra una pieza es el error de raíz.

Ejemplo en un solo SKU (`90042`, `c11 = PAQ`):

| suc | `c90` | `c91` | `c92` | qué es realmente |
|---|---|---|---|---|
| 02, 06 | $27.96 | $27.96 | $1,242.14 | PAQ / PAQ / CJA(48) — correcto |
| 03 (origen) | $27.96 | $1,242.14 | $0.00 | PAQ / CJA / vacío — **la escalera corrida un slot** |
| 00, 01, 04, 05 | $8.48 | $16.94 | $360.87 | plantilla, ver §5 |

### Por qué se queda viejo

`kdii` es un campo de catálogo que se sobrescribe; la bitácora es un log que se agrega. Cuando alguien cambia el precio, la bitácora **siempre** registra; `kdii` a veces conserva el valor anterior o queda estampado con una plantilla. Para `90042` la bitácora registró `PAQ = $27.96` en las **7 sucursales el 20-ago**, y sin embargo `kdii` de 00/01/04/05 sigue en $8.48.

---

## 3. `kdpv_bitacora_precios` — la fuente autoritativa

**5,267,345 filas**, desde 2025-10-12 hasta **hoy**. Es la única fuente que trae **precio + unidad + momento** juntos.

| col | contenido |
|---|---|
| `sucursal` | sucursal |
| `c1` | fecha del cambio |
| `c2` | hora (texto `HH:MM:SS.ff`) |
| `c3` | SKU |
| **`c4`** | **unidad** — `PZA`, `PAQ`, `CJA`, `KG`, `BTO`, `500`, `250`, `CUB`… |
| `c5` | nombre del producto |
| `c6` | precio **anterior** |
| `c7` | precio **nuevo** |
| `c8` | diferencia (`c7 − c6`) |
| `c9` | vacío en toda la muestra |

Actividad de los últimos 30 días — todas las sucursales vivas:

| suc | último cambio | cambios 30 d | SKUs tocados |
|---|---|---|---|
| 00 | hoy | 580 | 259 |
| 01 | hoy | 277,897 | 4,430 |
| 02 | hoy | 82,062 | 3,162 |
| 03 | hoy | 200,067 | 3,415 |
| 04 | hoy | 37,493 | 2,645 |
| 05 | hoy | 55,084 | 2,867 |
| 06 | hoy | 111,276 | 4,253 |

**Precio de lista vigente** = último `c7` por `(sucursal, SKU, unidad)` ordenando por `c1 DESC, c2 DESC`.

> Ojo: el volumen de cambios es enorme porque Kepler reescribe con redondeos de fracción de centavo (`$27.96 → $27.9644`, `c8 = $0.0044`). Para detectar cambios *reales* de precio hay que filtrar `abs(c8) >= 0.01`.

---

## 4. Las otras tres fuentes

**`kdpv_prod_util` — escalera de volumen** (293,964 filas). `c1`=SKU · `c2`=presentación · `c3`=tier 0..3 · `c4`=mínimo · `c5`=máximo · `c7`=precio. Es el mayoreo real de Kepler, por sucursal y presentación. Las listas `P1`–`P4`/`MAYOREO` de la plataforma son una copia manual de esto, congelada desde el 16-ago. El importador ya existe y está en dry-run: [`import-volume-tiers.js`](../../database/importers/kepler/import-volume-tiers.js).

**`kdm2.c12` — precio realmente cobrado.** Ninguna otra fuente dice qué se cobró. Para `90042` en 90 días: **cero líneas** al precio publicado de $8.48; el rango real fue $20.17–$27.96. Sirve como **testigo**, no como fuente — es un resultado, no una regla que puedas citar antes de vender. Filtrar `kdm1.c43 = 'N'` (vigente) y excluir los doctypes de traspaso (`U-A-50`, `U-D-6`, `U-D-13`), que se mueven **a costo** y contaminan la lectura.

**`kdik.c16` — costo.** Sirve de validación dura: un precio de venta por debajo del costo es un dato malo, no una promoción.

---

## 5. Defecto encontrado: precios de plantilla en Kepler

Hay **219 tripletas `(c90,c91,c92)` idénticas compartidas por 4 o más SKUs sin relación**, presentes en las 7 sucursales, que afectan a **1,667 SKUs**:

| `c90` | `c91` | `c92` | SKUs |
|---|---|---|---|
| $50.52 | $1,177.15 | $0.00 | 81 |
| $12.42 | $12.42 | $573.00 | 33 |
| $12.91 | $12.91 | $121.99 | 30 |
| $14.04 | $157.19 | $0.00 | 29 |
| $68.32 | $1,243.20 | $0.00 | 29 |
| **$15.25** | $172.42 | $1,836.06 | 27 |
| **$7.02** | $49.82 | $548.88 | 25 |
| $8.48 | $16.94 | $360.87 | 6 |

Un chocolate Turín, unos cerillos y un jabón no comparten precio por casualidad. **Son plantillas estampadas sobre `kdii`**, y explican los casos de `$15.25` y `$7.02` reportados antes. La bitácora de esos mismos SKUs sí trae el precio real.

Esto se arregla **en Kepler** — la plataforma no corrige al ERP. Lo que sí corresponde del lado nuestro es **no propagarlas**.

---

## 6. Defecto encontrado: `kdii` de la sucursal 03 desincronizada en el ODS

Comparando fila por fila el origen (réplica local) contra `kepler_ods.kdii`:

| suc | origen | ODS | iguales | **difieren** | sólo origen | sólo ODS |
|---|---|---|---|---|---|---|
| 00 | 9,503 | 9,524 | 9,414 | 89 | 0 | 21 |
| 01 | 9,499 | 9,521 | 9,498 | 1 | 0 | 22 |
| 02 | 9,504 | 9,525 | 9,502 | 2 | 0 | 21 |
| **03** | **9,249** | **9,523** | **6,789** | **2,444** | **16** | **290** |
| 04 | 9,502 | 9,523 | 9,498 | 4 | 0 | 21 |
| 05 | 9,500 | 9,521 | 9,500 | 0 | 0 | 21 |
| 06 | 9,489 | 9,493 | 9,487 | 2 | 0 | 4 |

**El 26% del catálogo de precios de la sucursal 03 está desincronizado**, más 290 filas en el ODS que ya no existen en el origen. Las otras seis están sanas. Es un hueco del CDC específico de esa rama (su base se llama `md_03`, no `kepler_md_03` como las demás — vale revisar si el carril la trata distinto).

---

## 7. Qué usar, según para qué

| Necesito… | Fuente | Cómo |
|---|---|---|
| Precio de lista de un SKU en una sucursal | `kdpv_bitacora_precios` | último `c7` por `(sucursal, SKU, c4)` con `abs(c8) >= 0.01` |
| Precio por cantidad | `kdpv_prod_util` | el más barato con `c4 <= qty`, por sucursal y presentación |
| Saber qué unidad es la que se cobra | `kdii.c11` | y su precio está en `c90` (97.2%) |
| Validar que un precio es creíble | `kdik.c16` + `kdm2.c12` | rechazar `precio < costo` y `precio` sin líneas cobradas cerca |
| Detectar plantillas | `kdii` | tripleta `(c90,c91,c92)` compartida por ≥4 SKUs |

**Lo que no se debe hacer nunca:** colapsar las 7 sucursales en un número con una moda. Kepler tiene un precio por sucursal, y aplastarlo obliga a inventar un desempate. Cuando la plantilla está en más sucursales que el dato bueno — como en `90042`, 4 contra 2 — la moda elige la plantilla y le asigna la confianza máxima.

---

## 8. Consecuencias para la plataforma

1. **`repoint-catalog-prices.js` lee `c90` asumiendo pieza.** Con `c11 = PAQ` en la mayoría del catálogo, el supuesto es incorrecto de origen.
2. **Falta la dimensión sucursal.** `commercial.product_prices` tiene una fila por `(price_list, product)`; Kepler tiene una por `(sucursal, SKU, unidad)`. El mecanismo para reflejarlo ya existe y está sin usar: `customers.default_price_list_id`.
3. **Faltan validaciones.** Hoy el único control es el piso anti-promo `c90 > 0.05`. Con dos reglas más — *precio ≥ costo* y *precio ≥ 0.9 × su escalón de volumen* — los 159 productos publicados bajo costo no se habrían escrito.
4. **`P1`–`P4`/`MAYOREO` son una copia congelada** de `kdpv_prod_util` del 16-ago, y `MAYOREO` además tiene `min_qty = 1`, por lo que el descuento más profundo aplica desde una pieza. Ver [`03_LOG_REVISIONES.md`](03_LOG_REVISIONES.md).

---

## 9. Verificado con

Todos los números de este documento salen de consultas sobre `kepler_ods` en prod y las réplicas locales `:5433`, el 2026-08-24. Documentos relacionados: [`ERP_KEPLER_SCHEMA.md`](ERP_KEPLER_SCHEMA.md), [`KEPLER_CATALOGO_TABLAS.md`](KEPLER_CATALOGO_TABLAS.md), [`FASE_RA`](FASES/FASE_RA_REABASTECIMIENTO.md).
