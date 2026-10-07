# Migraciones escritas que todavía NO pueden aplicarse

Knex **no mira esta carpeta** (`knexfile-newdb.js` apunta sólo a `migrations-newdb/`).
Un archivo acá está terminado pero **frenado por un dato que no cuadra**, no por un error
de código. Se vuelve a `migrations-newdb/` **sin cambiarle el nombre** en cuanto su
condición se cumpla, y se aplica con `apply-one-migration-prod.js` como cualquier otra.

Por qué existe esta carpeta: el despliegue es por commit y la compuerta de migraciones
frena a TODO el equipo ante una migración pendiente. Dejar acá la que no puede entrar es
lo que permite que el resto de la fila avance, sin borrar el trabajo de nadie.

---

## `20261006230000_rd_route_photo_fdw.js` — `[RD.34]`

**Qué falta:** que la **ruta 502** cuadre. Su propio candado la frena:

    [RD.34] ruta 502: el ancla NO ancla. declarado=48440.4 publicado=47377.32

Son **$1,063.08 = 2.19 %** contra una tolerancia del **1 %**. Medido dos veces en corridas
separadas, con **los mismos números al centavo**: no es transitorio. Las otras **7 rutas
pasan** (21, 22, 23, 26, 27, 28, 501).

**Lo que NO es:** no es el FDW. La infraestructura quedó montada y funcionando en prod
(`FDW-RUNNER.sh` corrido el 2026-10-06): rol `prod_fdw_ro` de sólo lectura, servidor
foráneo `runner_rutas` y la tabla `runner.existencias_ruta`, que responde **10 camiones,
3,067 renglones**. Al volver a aplicarla no hay que montar nada de nuevo.

**Por qué sacarla no regresa nada —medido en prod antes de moverla:**

* `analytics.v_rd_route_ledger` **ya existe** con exactamente las columnas que el código
  usa (`route_no, sku, unidad, qty, costo_doc, venta_doc, costo_erp, clase`);
* la clase `conteo` **ya está viva**: 342 filas, y las tres clases (`carga, conteo, venta`)
  existen hoy. Lo que esta migración cambia es de **dónde** sale ese conteo —la foto del
  runner en vez de la fuente actual—, no si existe;
* **ningún archivo TypeScript lee `v_rd_route_photo`**: 0 referencias en `libs/` y `apps/`.

O sea que la pantalla de inventario de ruta sigue mostrando lo mismo que mostraba.

**Para devolverla:** cuadrar la 502, `git mv` de vuelta a `migrations-newdb/`, y aplicarla.
⚠️ Ojo al diagnosticar: la migración hace `REFRESH MATERIALIZED VIEW CONCURRENTLY` de
`mv_rd_route_ledger` y `mv_rd_route_unit_value` **antes** del candado, y al fallar se
revierte. Leer esas matvistas después de una corrida fallida muestra el estado VIEJO —
lo intenté y me dio cifras que no son las que el candado evalúa (ruta 21: 7,965 contra
los 41,544 que reportó). Hay que reproducir el refresh para ver lo que el candado ve.
