# Compras › Catálogo › No registrados (MOS.2)

## Problema

Cuando en el mostrador escaneaban un código que Kepler no tiene, la caja sólo decía «no está en el catálogo». No quedaba
registro: Compras no se enteraba de qué se pedía y no estaba dado de alta, ni en qué sucursal. Y si el código existía en
otra sucursal, la caja mostraba el precio de esa otra plaza como si fuera de aquí.

## Solución

- Una pestaña nueva del Catálogo, **No registrados**, con los códigos que el mostrador escaneó y Kepler no tiene en esa
  sucursal: código escaneado, SKU, producto, proveedor, sucursal, veces y última vez.
- Filtros por sucursal y proveedor, y búsqueda por SKU o nombre.
- **Sale solo de la lista** en cuanto el producto aparece en Kepler de esa sucursal. No hay botón de «ya lo registré».
- Si el código no existe en ninguna sucursal, la lista muestra lo que escribió la cajera; si después aparece en otra
  sucursal, la clave y el nombre se toman de ahí.

## Cómo se implementó

- **Sin tabla nueva ni migración.** El mostrador anota en `commercial.floor_stockouts` con los motivos que ya existían
  (`no_en_catalogo`, `no_en_sucursal`). `SQL_NO_REGISTRADOS` (`no-registrados.sql.ts`) junta las semanas, completa
  clave y nombre desde `kepler_ods.kdii` y descarta lo que ya existe en esa sucursal por clave o por cualquiera de sus
  casillas de código de barras. `kdii` se lee una sola vez (las casillas de barras no tienen índice).
- `GET /commercial/floor-stockouts/no-registrados` (permiso `COMMERCIAL_PRODUCTS_VER`, el mismo de la pestaña) y
  `PATCH /commercial/floor-stockouts/:id/descripcion` (`STORE_STOCKOUT_CAPTURAR`; sólo `no_en_catalogo`, abierto y
  dentro de 5 minutos; no suma un reporte).
- Pantalla `compras-catalogo-no-registrados.component.ts` con `app-load-state`, `p-select` y `p-table`.
- Pruebas: `floor-stockouts.no-registrados.spec.ts` corre el código real del servicio **contra una base local**, con la
  tabla creada por sus migraciones reales dentro de una transacción que se revierte (4 pruebas, 3 mutaciones de la
  consulta verificadas en rojo). Sin `NR_TEST_DB_URL` se saltan y lo dicen; en CI no corren. Más el spec de la pantalla y
  el de las pestañas.

## Por qué así

- **Que salga solo** es lo que garantiza que de verdad se registró: una marca manual se puede poner sin haberlo hecho.
- **Una sucursal sin Kepler (Wincaja) no se puede verificar**, así que sus renglones se quedan: quitarlos sería afirmar
  algo que no se vio.
- La pantalla lleva sólo lo necesario para trabajar, a pedido de quien la usa: sin textos de explicación ni indicadores.
  ⚠️ Por eso no declara la edad del dato (DESIGN §9): la lista se calcula al abrirla y el botón la vuelve a revisar.
