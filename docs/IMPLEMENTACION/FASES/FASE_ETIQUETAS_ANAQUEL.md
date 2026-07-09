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

**Gramaje:** parseado del nombre (`kdii.c2`); el regex cubre `50G/8`, `5K`/`20K` (K=kg), `5KGS`, `2OZ`, `500ML`, `1LT`. ~4,110 productos con gramaje; el resto son sin peso real (servilletas, vasos, conteos `/12`, granel sin número, promos).

---

## 5. Arquitectura

- **Importer:** `database/importers/kepler/import-label-data.js` — lee `kdii` + `kdpv_prod_util` → upsert. `KEPLER_URL` (default `md_03` :5433; prod = maestra) + `DATABASE_URL_NEW` (destino). Idempotente; NUNCA pisa `source='manual'`.
- **Backend:** `libs/commercial/commercial-labels` — `GET /store/labels/search`, `POST /store/labels/resolve` (batch, dedup por producto). `TenantKnexService.run()` (RLS). Permiso reusado **`STORE_LIVE_VER`** (sin backfill a prod). Ruta bajo `/store/*` para cohesión con Tienda aunque el código viva en libs/commercial. Wireado en `AppModule` (toggle `ENABLE_MULTITENANT`).
- **Frontend:** `apps/view/.../tienda/`
  - `pages/tienda-etiquetas.component.ts` — cola, búsqueda debounced, carga masiva, multiselect (PrimeNG), simulación de hoja Carta, impresión por iframe aislado (landscape 2-up, `@page letter landscape`, color forzado).
  - `components/label.component.ts` — la etiqueta 115×40 mm (`ViewEncapsulation.None`, clases `etq-*`), barcode con JsBarcode (dep npm `jsbarcode`, en `allowedCommonJsDependencies`), auto-ajuste del nombre al header, precio grande dinámico (`bigUnit`).
  - Ruta `/tienda/etiquetas` + nav "Etiquetas" (`permissionGuard(STORE_LIVE_VER)`).
- **Diseño:** 115×40 mm, sin iconos, letra grande, verde `hsl(141,76%,16%)` + amarillo `#f6c400`, rojo `#cc2222` en SKU y números de piezas, brote de 2 hojas. Prototipo desechable en la raíz: `etiqueta-preview.html`.

---

## 6. Estado prod (Railway)

- ✅ Tablas creadas (`migrate:up` — solo las de etiquetas, Batch 95 + 97; **las migraciones RA quedaron pendientes a propósito**).
- ✅ **8,013 filas cargadas** desde el mirror `md_03` (verificado SKU 20186: 50 g, UPC, pieza $8.66, mayoreo $7.68, paquete 8/$66.06, caja 112/$860.60).
- ⏳ **Pendiente:** redeploy del `view` (cambios de diseño están en `origin/main`) + re-correr el importer on-prem contra Kepler vivo para refrescar precios (agendar).

---

## 7. Diferido / futuro

- ZPL/térmica nativa (hoy impresión a color por navegador).
- Ocultar automáticamente el renglón "Paquete" cuando el precio grande ya es "por paquete".
- Editor de plantillas / múltiples plantillas.
- Poblar gramaje desde un campo estructurado si Kepler llega a exponerlo (hoy se parsea del nombre).
