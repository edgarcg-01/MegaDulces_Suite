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

## 7. Diferido / futuro

- ZPL/térmica nativa (hoy impresión a color por navegador).
- Ocultar automáticamente el renglón "Paquete" cuando el precio grande ya es "por paquete".
- Editor de plantillas / múltiples plantillas.
- Poblar gramaje desde un campo estructurado si Kepler llega a exponerlo (hoy se parsea del nombre).
