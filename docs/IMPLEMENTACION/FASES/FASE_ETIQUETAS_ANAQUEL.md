# Fase Etiquetera — Etiquetas de anaquel (proyecto Tienda)

> Impresión de etiquetas de anaquel con **precio escalonado** (pieza/mayoreo/paquete/caja) para Mega Dulces. Vive en el proyecto **Tienda** (`/tienda/etiquetas`). Diseño replicado 1:1 del arte oficial de la empresa.

Estado: **🧪 implementado + verificado en prod (datos cargados en Railway)**. Falta redeploy del `view` para ver el diseño en la app desplegada.

---

## 1. Qué hace

- Arma una **cola de etiquetas** buscando en catálogo (`GET /store/labels/search`) o pegando una **lista de códigos** (SKU o barcode), con **copias por producto**.
- Imprime en **hoja Carta horizontal**, **2 etiquetas por fila (~8/hoja)**, con **línea de recorte** punteada por etiqueta (esquinas rectas, colores forzados). Impresión aislada en un **iframe** propio (Chrome no respeta `@page` inyectado por Angular en runtime).
- **Multiselect** para elegir qué renglones mostrar (mayoreo pza / paquete / mayoreo paq / caja / código de barras).
- **Precio grande dinámico** según la unidad base de venta (ver §4).

---

## 2. Tablas

### `commercial.product_label_prices`
1 fila por producto con todo lo que necesita la etiqueta. RLS forzado + grants `app_runtime` (patrón A.0mt). FK compuesta `(tenant_id, product_id) → catalog.products`. `source` `kepler|manual` (manual = override que el importer nunca pisa).

| Columna | Tipo | Significado / origen Kepler |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid NOT NULL | RLS |
| `product_id` | uuid | FK `catalog.products` |
| `content` | varchar(40) | Gramaje ("50 g") — parseado del nombre `kdii.c2` |
| `barcode` | varchar(30) | Número a imprimir (pieza) — `kdii.c7` |
| `barcode_format` | varchar(10) | `EAN13`/`UPC`/`EAN8` según longitud; `null` si es basura (no se dibuja) |
| `piece_price` | numeric(14,4) | Precio por pieza — `kdii.c90` (en granel = $/kg) |
| `wholesale_piece_min_qty` | integer | Umbral "mayoreo desde N" — `kdpv_prod_util` PZA `c4` |
| `wholesale_piece_price` | numeric(14,4) | Mayoreo por pieza c/u — `kdpv_prod_util` PZA `c7` |
| `pack_size` | integer | Piezas por paquete — `kdii.c81` |
| `pack_price` | numeric(14,4) | Precio del paquete — `kdii.c91` |
| `wholesale_pack_price` | numeric(14,4) | Mayoreo por paquete c/u — `kdpv_prod_util` PAQ `c7` |
| `box_size` | integer | Piezas por caja — `kdii.c84` |
| `box_price` | numeric(14,4) | Precio de la caja — `kdii.c92` |
| `unit_base` | varchar(8) | **Unidad base de venta** — `kdii.c11` (PZA/PAQ/KG/CJA/…). Define título + valor del precio grande. |
| `source` | varchar(12) | `kepler` \| `manual` |
| `computed_at`, `created_at`, `updated_at` | timestamptz | audit |

**Migraciones:**
- `20260709120000_commercial_product_label_prices.js` — tabla base.
- `20260709120000_commercial_product_label_unit_base.js` — columna `unit_base` (nombrada para ordenar entre `..._label_prices` y `..._ra_purchasing_flow`, y poder aplicarse sola con `migrate:up` en Railway sin arrastrar las migraciones de Compras/RA).

---

## 3. Decode Kepler (verificado vs SKU 20186)

Todo sale de 2 tablas del ERP:
- **`md.kdii`** (maestro): `c1`=código/sku, `c2`=nombre+gramaje ("…50G/8"), `c7`=barcode pieza (`c82`=paquete), `c11`=**unidad base**, `c81`=pzas/paquete, `c84`=pzas/caja, `c90`=precio pieza, `c91`=precio paquete, `c92`=precio caja.
- **`md.kdpv_prod_util`** (tiers de mayoreo): `c2`=presentación (PZA/PAQ/CJA/KG/BTO), `c4`=min_qty, `c7`=precio. PZA con min_qty>1 = mayoreo por pieza; PAQ = mayoreo por paquete.

Kepler **NO guarda imagen** de barcode, solo el número → se genera con JsBarcode; simbología por longitud (13→EAN13, 12→UPC, 8→EAN8; ~1,831 con basura → sin barcode).

---

## 4. Unidad de venta → precio grande dinámico

Distribución del catálogo (`kdii.c11`): **PAQ ~76% · PZA ~20% · KG ~2%** (granel) + anomalías (unidad=número) + otras (CJA/SER/BTO/CUB). Solo ~1,431 SKUs venden por pieza; casi todos por paquete/caja.

El título y valor del precio grande **"Precio por ___"** siguen la unidad base:

| `unit_base` | Título | Valor |
|---|---|---|
| PZA | Precio por **pieza** | `piece_price` (c90) |
| PAQ | Precio por **paquete** | `pack_price` (c91) |
| KG | Precio por **kg** | `piece_price` (c90 = $/kg en granel) |
| CJA | Precio por **caja** | `box_price` (c92) |
| BTO/CUB/otras/anomalías | bote/cubeta/pieza | c90 |

**Gramaje:** parseado del nombre (`kdii.c2`); el regex cubre `50G/8`, `5K`/`20K` (K=kg), `5KGS`, `2OZ`, `500ML`, `1LT`, **`5 LITROS`/`1LITRO`** (alternativas largas antes que las de 1 letra para que `LITROS`/`KILOGRAMOS` ganen sobre `l`/`k`). **4,148 productos (51.8%) con gramaje; 0 misses recuperables** (verificado 2026-07-09 vs data prod: todo nombre con peso parseable lo tiene). El resto (~48%) es sin peso real: dulces por pieza/conteo (`/6 /24 /30`), promos ("X = GRATIS Y"), artículos de fiesta (velas, bolsas, palitos, pelotas). El label oculta `content` cuando está vacío. Refresco directo contra prod (recompute desde `catalog.products.nombre`, respeta `source='manual'`).

---

## 5. Arquitectura

- **Importer:** `database/importers/kepler/import-label-data.js` — lee `kdii` + `kdpv_prod_util` → upsert. `KEPLER_URL` (default `md_03` :5433; prod = maestra) + `DATABASE_URL_NEW` (destino). Idempotente; NUNCA pisa `source='manual'`.
- **Backend:** `libs/commercial/commercial-labels` — `GET /store/labels/search`, `POST /store/labels/resolve` (batch, dedup por producto). `TenantKnexService.run()` (RLS). Permiso **dedicado `STORE_LABELS_VER`** (proyecto Tienda, separado de `STORE_LIVE_VER`). Ruta bajo `/store/*` para cohesión con Tienda aunque el código viva en libs/commercial. Wireado en `AppModule` (toggle `ENABLE_MULTITENANT`).
- **Permiso/roles:** `STORE_LABELS_VER` (enum back+front, `permission-meta`, `authz-tree`, seed). Rol acotado **`etiquetas_tienda`** = SOLO ese permiso (ej. usuario `rodrigo_ortiz`). Los 7 roles de tienda que tenían etiquetas vía `STORE_LIVE_VER` reciben `STORE_LABELS_VER` (mig `20260709120000_grant_store_labels_perm`, `migrate:up` sin arrastrar RA). `/tienda` redirige a `live` o `etiquetas` según permiso (`storeLiveMatch` CanMatchFn); card en `/projects` con ambos permisos. **Prod: requiere re-login.**
- **Frontend:** `apps/view/.../tienda/`
  - `pages/tienda-etiquetas.component.ts` — cola, búsqueda debounced, carga masiva, multiselect (PrimeNG), simulación de hoja Carta, impresión por iframe aislado (landscape 3-up, `@page letter landscape`, color forzado).
  - `components/label.component.ts` — la etiqueta **82×35 mm** (`ViewEncapsulation.None`, clases `etq-*`), barcode con JsBarcode (dep npm `jsbarcode`, en `allowedCommonJsDependencies`), auto-ajuste del nombre al header, precio grande dinámico (`bigUnit`).
  - Ruta `/tienda/etiquetas` + nav "Etiquetas" (`permissionGuard(STORE_LIVE_VER)`).
- **Diseño:** 82×35 mm (era 115×40 hasta 2026-09-07, ver §8), sin iconos, letra grande, verde `hsl(141,76%,16%)` + amarillo `#f6c400`, **naranja de marca `#F05A28` (`--brand-700` sunset)** en SKU y números de piezas, brote de 2 hojas. Prototipo desechable en la raíz: `etiqueta-preview.html`.

---

## 6. Estado prod (Railway)

- ✅ Tablas creadas (`migrate:up` — solo las de etiquetas, Batch 95 + 97; **las migraciones RA quedaron pendientes a propósito**).
- ✅ **8,013 filas cargadas** desde el mirror `md_03` (verificado SKU 20186: 50 g, UPC, pieza $8.66, mayoreo $7.68, paquete 8/$66.06, caja 112/$860.60).
- ⏳ **Pendiente:** redeploy del `view` (cambios de diseño están en `origin/main`) + re-correr el importer on-prem contra Kepler vivo para refrescar precios (agendar).

---

## 8. La etiqueta baja a 82×35 mm — 15 por hoja (2026-09-07)

Disparador: *"necesito reducir el tamaño de la etiqueta"*. Edgar fijó el alto en **35 mm** y eligió el ancho tras ver el cálculo.

**Medida anterior, medida:** 115 × 40 mm. Adentro, banda del nombre 7.8 mm · cuerpo 32.2 (30 útiles) · columna izquierda 54 · gap 2 · derecha 55 · precio 16 mm de letra · franja "por pieza" 5.2 · celda de precio de tier 20 · código de barras 5.4 mm de alto × 85% de su columna.

**Por qué 82 y no 100.** En Carta horizontal con margen de 8 mm quedan **263 × 200 mm útiles**, y cada etiqueta lleva su margen de recorte. Los saltos son **umbrales, no una curva**: bajar de 115 a 100 mm no cambia nada (siguen 2 columnas y 8 por hoja). El umbral de la 3ª columna está en ~82.6 mm de ancho y el de la 5ª fila en 35 mm de alto. A **82 × 35** entran **3 × 5 = 15 por hoja**, contra 8: casi la mitad de papel por etiqueta.

**Y la pantalla mentía sobre el tamaño.** El encabezado del componente, el texto de la página y el comentario de la función de impresión decían *"tamaño físico 100×40 mm"* mientras el CSS imprimía **115** — 15 mm más ancho que el material que declaraba usar. Se corrigieron las dos cosas a la vez.

**Lo que se re-proporcionó** (respetando el reparto original 54:55): izquierda **38** · gap 1.6 · derecha **39.4** · padding 1.5 → 82 exactos. Banda 6.8 mm, precio 11.5 mm de arranque, franja 4.4, celda de tier 16, y los tres auto-encogidos (`fitHead`/`fitPrice`/`fitAmts`) arrancan y pisan proporcionalmente.

**El código de barras es lo único con mínimo físico**: un EAN-13 pide ~29.83 mm de ancho al 80% de magnificación. Pasa de 85% a **100%** de su columna (39.4 mm) y conserva 5 mm de alto.

⚠️ **El margen de recorte baja de 2.5 a 2 mm por TOLERANCIA, no por estética.** A 2.5 la huella mide 87 × 40 y cinco filas dan **200 mm contra 200 disponibles**: cero holgura, y cualquier redondeo de subpíxel manda la 5ª fila a la hoja siguiente — 12 aquí y 3 allá, **gastando más papel que antes** y sin que nadie entienda por qué. A 2 mm sobran 5 mm en cada eje.

**Verificado** renderizando una hoja completa con el CSS **extraído del propio fuente** (no copiado) en puppeteer: etiqueta **82.0 × 34.9 mm**, **3 por fila × 5 filas = 15**, sin desbordes. ⚠️ **La primera pasada del chequeo dio verde y estaba mal**: medía `scrollWidth` del texto del precio, pero el recorte lo hace el `overflow:hidden` de la caja amarilla, así que el texto siempre "cabe" — un precio de 4 cifras salía cortado y el chequeo lo aprobaba. Corregido midiendo la CAJA. (Con el auto-encogido del componente, `$1,333.60` baja de 11.5 a 8.5 mm y entra completo.)

**Candado `apps/view/src/app/modules/tienda/etiqueta-hoja.spec.ts` (9/9).** El tamaño de la etiqueta vive en el CSS, cuántas caben en una constante, y la medida rotulada en el texto de la pantalla: los tres podían desincronizarse sin que nada falle, y de hecho lo estaban. El gate comprueba la aritmética completa (medida → huella → columnas × filas → `PER_SHEET`), que **el rótulo diga la verdad**, que el margen de recorte sea el mismo en la simulación y en las dos rutas de impresión, que sobren ≥3 mm en cada eje, que las columnas más el padding sumen el ancho exacto, y que el barcode conserve su mínimo. Prueba negativa verificada bajando `PER_SHEET` a 12: **2 rojos**.

**Pendiente:** validación visual en pantalla + una impresión de prueba para confirmar el corte, y redeploy de `view`.

---

## 9. El número que "a veces se ve más chico", y el mayoreo legible (2026-09-07)

Disparador: *"últimamente existe un bug que en ocasiones el número se ve más chico, ¿dónde está el error? … también el apartado de mayoreo con esta reducción quedó ilegible, hay que darle más tamaño, haciendo bold en el precio y reduciendo un poco el tamaño del precio unitario normal"*.

### El bug: el tamaño lo decidía una medición hecha en el momento equivocado

`fitPrice()` encoge el precio midiendo su ancho. **Si mide antes de que la tipografía definitiva esté usable, mide con la fallback** —que tiene otro ancho— y el tamaño que deja queda mal en la dirección de esa fallback. Medido, mismo precio y misma caja, cambiando sólo la fuente con la que se mide:

| midiendo con | ancho vs Anton | un precio de 4 cifras queda en |
|---|---|---|
| **Anton** (la que imprime) | — | 9.00 mm |
| **Impact** (Windows) | +5…8% | 8.50 mm |
| **Helvetica** (iPad / Android) | **+13…21%** | **7.50 mm** ← 17% más chico |
| **Arial Narrow** | −1…7% | 9.25 mm (y al llegar Anton se **recorta**) |

**Por qué era intermitente:** el componente ya hacía `document.fonts.ready.then(() => this.layout())`, y no alcanza. Las familias llegan por un `@import` a `fonts.googleapis.com` **dentro del CSS del propio componente**, así que mientras esa hoja no baja **no existe ningún `@font-face`**: no hay carga pendiente, `fonts.ready` resuelve al instante y el layout mide con la fallback. Depende de si la CSS de Google estaba en caché → a veces sí y a veces no. Y encima **el re-layout vivía sólo en `ngAfterViewInit`**: toda etiqueta creada por un cambio de input —que es exactamente cómo las crea la etiquetera al armar la cola— se quedaba con la medida equivocada para siempre.

**Segunda mitad del bug:** si la caja todavía no tenía ancho (`clientWidth` 0), `avail` salía **negativo** y el bucle corría hasta el piso → el precio quedaba en **4.5 mm**, la versión dramática de "se ve más chico".

**Arreglo:** `FUENTES_USABLES`, una promesa memoizada por app que espera a que las tres familias estén **realmente usables** (`fonts.load` + `fonts.check`, tope de 3 s) y re-ajusta desde **los dos** hooks. Si no llegan —equipo sin internet— se sigue midiendo con la fallback, que ahí es lo **correcto**: es la que va a imprimir. Más la guarda de "sin medida no se encoge".

### El mayoreo: de 3.7 mm a 5.4 mm

Al reducir la etiqueta bajé la celda del monto de 20 a 16 mm, y el auto-encogido horizontal dejaba el monto de mayoreo en **~3.7 mm**: ilegible. Se reparte distinto el ancho, **ya no 54:55** como el original: el precio unitario cede **4.4 mm** a la columna de los tiers (34 / 43.4), su arranque baja de 11.5 a **10 mm**, la celda del monto sube a **22 mm** y el monto a **5.4 mm**.

**El "bold" no se puede hacer con `font-weight`:** Bebas Neue no tiene bold real y el navegador no la sintetiza — medido, `font-weight:700` daba **el mismo ancho al píxel**, o sea ningún cambio visible. El peso va por **trazo óptico** (`-webkit-text-stroke`), más grueso en las filas de mayoreo, que además llevan **chip amarillo de marca** (el mismo de la caja del precio grande, para que se lean como pareja). Los rótulos se acortaron —"Mayoreo 3+ cajas" en vez de "Mayoreo desde 3 cajas:"— porque **el rótulo era lo que se comía el ancho**, y sin eso el monto grande no cabía.

### Y de paso, un recorte silencioso que ya existía

El bloque de tiers no tenía ajuste **vertical**: con 4 renglones el contenido medía **100 px contra 92 de caja ya en la etiqueta de 115×40**, y el 4º tier se perdía tapado por el `overflow:hidden`. Nuevo `fitTiers()` baja el tamaño de todos los montos **por igual** (para que sigan alineados) hasta que quepan, y corre **antes** del ajuste por celda.

**Dimensionado con el dato:** de los **9,013 productos** con precios de etiqueta, **76.1% tiene 2 renglones** de tier, 11.3% uno, 7.1% tres y **sólo 2.0% cuatro**. Resultado medido: 1, 2 y 3 tiers imprimen a **5.4 mm** (94.5% de los productos) y los de 4 bajan a 4.0 mm — **sin recortes y sin rótulos partidos en ningún caso**.

⚠️ **Sexta vez en este repo:** un **acento grave dentro de un comentario CSS** parte el template literal y el compilador tira `Failed to resolve styles at position 1 to a string`. Lo peor es que **ts-jest no lo detecta** (no hace el análisis estático de Angular), así que los 81 tests salían verdes con el build roto. El spec ahora también prohíbe acentos graves en el bloque de estilos.

**Candado extendido a 16 casos** (`etiqueta-hoja.spec.ts`): que el arranque del CSS y el del TS sean el mismo número (verificado en rojo poniéndolos en 12 vs 10), que no se vuelva a colgar el re-layout de `fonts.ready` a secas, que el re-ajuste esté en los dos hooks, las dos guardas de "sin medida no se encoge", que `fitTiers` corra antes de `fitAmts`, y que el monto de mayoreo tenga más trazo y su chip.

---

## 10. Maximizar la etiqueta y la jerarquía de la unidad (2026-09-08)

Disparador: *"verifica si podemos maximizar el uso de la etiqueta. realiza un análisis BI y si falta darle más jerarquía algún apartado"*.

### El desperdicio, medido

**La caja del precio nunca se llenaba.** `fitPrice` sólo *encogía* desde 10 mm y **nunca crecía**: el número usaba **57% del alto** de su caja (31.7 × 14.4 mm) siempre, y **46% del área**. Con **78.2%** del catálogo en precios de 2 dígitos y 9.1% de 1 dígito, ~87% podía crecer 17-47%.

**El bloque de renglones quedaba vacío.** Renglones que se imprimen **de verdad** (replicando los getters contra los 9,013 productos — contar columnas de la tabla sobreestima: da 73.7% donde lo real es 78.4%): **0 renglones 5.0% · 1 renglón 14.6% · 2 renglones 78.4% · 3 renglones 1.9%**. Aire: **21.2 mm** (32% de la etiqueta) sin renglones, 13.7 con uno, **5.9 con dos**. → **98% de las etiquetas dejaba ≥5.9 mm de aire.**

⚠️ **`scrollHeight` no puede medir ese aire.** Con `justify-content:center` nunca baja de `clientHeight`: reporta 0 donde hay 5.9 mm, y tampoco ve el desborde por el borde de arriba. Se mide por **extensión de los hijos** (`altoTiers`). Para encoger era un defecto tolerado; para crecer y repartir el sobrante sería un recorte.

### El análisis BI: qué merece la jerarquía

De **`analytics.v_erp_sales_line_units`** (creada el 2026-09-07 y **sin ningún consumidor hasta ahora**), mostrador `U-D-10` sin rutas, 30 días = **266,495 renglones / $18.75M**:

| qué unidad compra el cliente | renglones | importe | | cantidad por renglón | renglones | importe |
|---|---|---|---|---|---|---|
| **unidad BASE** | **92.8%** | **79.9%** | | **1-2 (precio firme)** | **86.6%** | **71.4%** |
| peldaño PAQ | 5.3% | 9.1% | | 3-9 (umbral "3+") | 11.6% | **22.7%** |
| peldaño CJA | 1.5% | 7.6% | | 10+ (umbral "10+") | 1.3% | **5.3%** |

1. **El precio base es el número que importa**: lo paga el 86.6% de los renglones. Merece ser el más grande — y usaba 57% de su caja.
2. **El mayoreo mueve el 28% del dinero** con 13% de los renglones. Merece presencia real.
3. ⭐ **Al apartado que le faltaba jerarquía es la UNIDAD del precio.** `unit_base` es **PAQ en 73.5%** del catálogo de etiquetas: el número grande es **el precio de un PAQUETE en 3 de cada 4 etiquetas**, y el cliente compra exactamente esa unidad en el 92.8% de los renglones. Estaba rotulada con letra de **2.7 mm**, la más chica del bloque. Leer el número sin su unidad es el error más caro de este repo (ADR-055).
4. El mayoreo dominante es **por paquete** (83.7% de los productos) — el realce ya iba al renglón correcto. `pack_price` sólo existe en 4.4%.
5. ⚠️ Los **"522 productos con mayoreo más caro"** que aparecen a primera vista son **artefacto de unidad**: 413 son base=PZA comparada contra un mayoreo de paquete. Con la comparación limpia (base=PAQ, 6,441 productos) son **105**, y los getters ya los ocultaban. El descuento real: **mediana 7.9%, p90 9.8%**.

### Lo que cambió

| | antes | después | Δ |
|---|---|---|---|
| precio (ponderado por catálogo) | 9.87 mm | **12.06 mm** | **+22.2%** |
| llenado de la caja del precio | ancho 81% · alto 57% · **área 46%** | ancho 98% · alto 79% · **área 78%** | **+32 pp** |
| · 1 dígito (9.1%) | 10.00 | **14.85** | +48.5% |
| · 2 dígitos (78.2%) | 9.86 | **12.02** | +21.9% |
| · 3 dígitos (12.3%) | 9.87 | 10.36 | +5.0% |
| palabra de la unidad | 2.70 mm | **4.20 mm** | **+56%** |
| monto de renglón | 5.12 mm | **6.28 mm** | **+22.7%** |
| aire en la columna derecha | 7.73 mm | **4.32 mm** | −44% |
| alto del código de barras | 5.00 mm | **8.05 mm** | **+61%** |
| precio solapando el brote | 140 de 177 filas | **0** | resuelto |
| realces de mayoreo sin descuento | 87 realces | **69** (−18) | |
| jerarquía violada (monto > 70% del precio) | 5 | **1** | |

**Decisiones de Edgar:** el aire va al precio **y** al mayoreo · la unidad gana jerarquía por **franja más grande** (no pegada al número, para no robarle ancho) · el **brote sale a la banda del nombre**, en amarillo · el sobrante va al **código de barras**, hasta 12 mm.

**Por qué el brote tenía que moverse** — el techo del precio lo pone el **ancho** en el 90% de los casos, pero el alto muerde cuando la franja crece. Medido, ponderado por catálogo: con la franja a 6.2 mm, el brote **fuera** de la caja da **+17.4%** y **dentro** da **−0.1%**. Con la franja elegida, dejarlo adentro anulaba el trabajo completo. La guarda no está cableada: `fitPrice` **mide** si hay un obstáculo absoluto en la caja, así que hoy sale 0 sola y mañana protege al número si alguien mete una insignia ahí.

**Y dos correcciones de verdad, no de layout:**

- **`mayoreoMin` ya no inventa el umbral.** Era `wholesale_piece_min_qty || 3`: la etiqueta **afirmaba** "Mayoreo 3+" sin dato (y convertía un 0 o un 1 en 3). Medido: hoy **0 productos** disparan ese default, así que no cambia ninguna etiqueta — es el candado. Y el mayoreo **sin umbral real no se imprime** (17 productos imprimían "Mayoreo" pelado, sin decir desde cuántos): la etiqueta declara un precio que la caja va a cobrar, y un mayoreo sin condición de cantidad fabrica una discusión en el mostrador.
- **El realce exige descuento.** 265 productos imprimían chip amarillo + trazo grueso —la señal visual de oferta— sobre un precio materialmente igual (<1%). El renglón **no se oculta** (el precio sí es más bajo, y esconderlo sorprendería a quien compare contra la pantalla): pierde el realce.

### Verificación

**Arnés permanente `scripts/etiqueta-geometria.js` + corpus congelado `scripts/fixtures/etiqueta-corpus.json`** (177 filas estratificadas por dígitos × renglones × `unit_base`, con los extremos con nombre). Congelado a propósito: el antes y el después se miden sobre las **mismas filas** — si se re-consulta, un cambio de precio entre corridas se lee como efecto del rediseño. El CSS y las constantes se **extraen del fuente**, y el arnés deriva su comportamiento de qué constantes existen, así que la misma herramienta produce las dos columnas.

**Casos límite DECLARADOS**, no pintados de verde (ADR-056): `01001` GLOBO PARA 120KG (base $18,345, caja **$342,299.99** — 6 cifras no caben en la celda de 22 mm ni al piso de 2.4 mm) y tres promos con **79-83 caracteres** de nombre (`00422`, `59325`, `62253`) que no entran en 78 mm ni al piso de 2.3. Los cuatro estaban igual antes; el arnés los lista y se pone **rojo si aparece un sku nuevo** en cualquiera de esas banderas.

**Candado de 16 → 27 aserciones.** Negativas verificadas: `MONTO_MAX_MM` a 8 (rompe la jerarquía del 70%) · techo fijo sin `FUENTES_OK` · mover sólo el `padding` sin el `inset` — **rojo las tres**. Las nuevas cubren el anti-trinquete, que el aire no se mida con `scrollHeight`, que la guarda del precio se **mida**, el orden de los seis ajustes, el lockstep de la reserva, la jerarquía de la unidad (≥1.5× el rótulo de renglón y sin `text-transform`, porque `bigUnit.word` puede ser "500 g"), que ningún umbral se invente y que el realce exija descuento.

⚠️ **El arnés reimplementa los bucles del componente**, así que puede dar verde estando mal — es el mismo modo de falla que ya se pagó en ETQ.3. Falta la pata que no puedo correr yo: **contrastar contra la app en el navegador** (los dev servers son de Edgar) y **una hoja impresa en papel** con el barcode leído a 5 y a 12 mm.

⚠️ **Séptima vez con el acento grave**: esta vez fue en un comentario del *template*, y `npm run check:templates` la atrapó al instante — por eso el plan exige correrlo tras cada edición, no al final.

**Fuera de alcance, con motivo:** ⛔ **no se fabricó un "$ por pieza"** para llenar el hueco, que era lo más tentador (73.5% de los heros son precio de paquete). Con base=PAQ el paquete **no** está en `pack_size`: dividir por un factor que no se confía e imprimirlo en una etiqueta física es exactamente la clase de error de ADR-055. Para el 5% sin renglones la respuesta honesta es código de barras más grande y blanco centrado (`is-solo`).

**Pendiente:** validación visual en el navegador, una impresión de prueba, y redeploy de `view`.

---

## 7. Diferido / futuro

- ZPL/térmica nativa (hoy impresión a color por navegador).
- Ocultar automáticamente el renglón "Paquete" cuando el precio grande ya es "por paquete".
- Editor de plantillas / múltiples plantillas.
- Poblar gramaje desde un campo estructurado si Kepler llega a exponerlo (hoy se parsea del nombre).
