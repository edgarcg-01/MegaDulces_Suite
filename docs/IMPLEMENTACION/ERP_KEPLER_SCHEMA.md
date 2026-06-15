# ERP Kepler — esquema descifrado (referencia)

> Mega Dulces corre **Kepler** (ERP retail/distribución MX). El esquema está **ofuscado a propósito**: tablas `kdXX`, **todas las columnas `c1, c2, c3…`**, sin nombres ni comentarios. Este doc captura el mapeo inferido **desde los datos** — difícil de re-derivar, mantener vivo.

## El dump

- `database/BACKUP.sql` (228 MB) = `pg_dump` **custom-format gzip** de la DB `md_03`, schema `md`. 329 tablas, 1452 entradas TOC.
- **Restaurar** (no es texto plano — datos en binario): `pg_restore -h localhost -p 5433 -U postgres -d md_03 --no-owner --no-privileges -j 4 database/BACKUP.sql` (crear `md_03` antes). Postgres local: contenedor Docker en `localhost:5433`, user `postgres`/`superoot`.
- Trae **2 sucursales con stock: `02` (corte dic-2025, vieja) y `03` (jun-2026, VIVA)**.

## Tablas clave descifradas

| Tabla | Qué es | Columnas (inferidas) |
|---|---|---|
| **`kdii`** | Maestro de productos (9,249) | `c1`=SKU · `c2`=nombre · `c7`=código de barras (EAN) · `c8`=clave familia · c13–c19 numéricos en 0 (precios NO viven acá) |
| **`kdil`** | Existencia/acumulados por sucursal | `c1`=sucursal · `c3`=SKU · **`c9`=existencia actual** · `c8`=cantidad alterna (¿acumulado/máximo?) · `c6`/`c7`=última compra/venta |
| **`kdik`** | Valuación de inventario por sucursal | `c1`=sucursal · `c2`=SKU · `c6`=existencia · `c9`=valor a costo → **costo unitario = c9/c6** (validado: Agua $2.52, Kinder $11.28 — realistas) |
| `kdm1` / `kdm2` | Encabezados (200 cols) / detalle (70 cols, 1.26M filas) de documentos: compras, ventas y **ajustes de inventario** | — |
| `kdpv_bitacora_precios` | Bitácora de cambios de precio (1.3M filas) | — |

**No hay tabla de conteo físico dedicada.** Kepler registra la toma física como un **documento de ajuste** en `kdm1/kdm2` (sin sesión/folio persistido). La **Fase I sí persiste** folio + conteos + varianza — un superset auditable de lo que hace el ERP.

## Join a nuestra plataforma

**`kdii.c1` == `public.products.sku`** (mismo esquema de códigos — nuestro catálogo vino de este Kepler). Mapeo por SKU dentro del tenant Mega Dulces. Overlap sucursal 03: **3,936/4,066 (97%)**; los 130 sin match son SKUs que no están en nuestro catálogo (ej. BOING).

Relación con `productos_activos`: ese sync (DATABASE_URL_REMOTE_SNAPSHOT, 6,489 SKUs) es la **vista limpia** sobre este mismo Kepler. Este dump crudo aporta lo que la vista no expone: barcode, clave familia, bitácora de precios, las dos sucursales.

## Importer de stock

`database/importers/kepler/import-kepler-stock.js` — lee Kepler (kdil existencia + kdik costo) de una sucursal y puebla `commercial.stock`.

- Dry-run por defecto (imprime match/sin-match + muestra de validación); `--apply` escribe.
- Args: `--branch 03` · `--warehouse KEPLER-03` · `--exist-col c9`.
- Join por SKU; idempotente (upsert por tenant+warehouse+product).
- **Aplicado 2026-06-15**: sucursal 03 → almacén **KEPLER-03** (creado), **3,936 SKUs / 1,127,490 unidades**. La Fase I ya puede contar contra stock real.

## Pendiente / ideas

- Confirmar con ancla real si `kdil.c9` es la existencia exacta (costos realistas lo respaldan; falta 1 SKU verificado contra la tienda).
- Los 130 SKUs sin match: decidir si se crean en el catálogo o se ignoran.
- Write-back: mapear el formato de ajuste de `kdm1/kdm2` si se quiere que la reconciliación de Fase I genere el documento de ajuste en Kepler.
