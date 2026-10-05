'use strict';
/**
 * `[RD.29.3]` — **El comentario de la columna también decía 40,000.**
 *
 * `[RD.29.2]` movió el tope a 80,000 en los datos, pero el `COMMENT ON COLUMN` que `[RD.29]`
 * dejó en producción sigue diciendo *«Semilla 40000»*. Un comentario de schema es lo que lee el
 * que inspecciona la base, y corregir el archivo de la migración **no alcanza**: el texto vive
 * en el catálogo de Postgres, no en el repo.
 *
 * ⭐ Es exactamente la lección de `[CDRP.2.1]`: una medición persistida en un `COMMENT` de prod
 * envejece sin avisar, y nadie la revisa porque no está en ningún diff. Va migración aparte
 * porque es el único lugar donde se puede cambiar.
 *
 * Se aprovecha para dejar escrito lo que el número significa hoy, medido al aplicarlo: con
 * 80,000 **no se dispara ninguna de las 11** — el camión más cargado es la 501 con $53,171, el
 * 66 % del tope. Es un techo de **prevención**, no un detector de lo que ya pasó, y que hoy
 * nadie lo cruce es el estado deseado.
 */

exports.up = async function up(knex) {
  await knex.raw(`
    COMMENT ON COLUMN commercial.warehouses.inventory_max_mxn IS $$[RD.29] Tope de inventario del
    camion, en pesos AL COSTO. NULL = sin tope declarado (la pantalla lo dice, no asume default).
    Valor 80000, puesto por el negocio y NO medido ([RD.29.2] lo corrigio desde los 40000 que
    sembro [RD.29]). Medido al aplicarlo: ninguna de las 11 rutas lo pasa -- la mas cargada es la
    501 con 53,171, el 66% del tope. Es un techo de PREVENCION, no un detector de lo ya ocurrido:
    que nadie lo cruce es el estado deseado, no una senal de que la medida sobre.$$`);
};

exports.down = async function down(knex) {
  await knex.raw(`COMMENT ON COLUMN commercial.warehouses.inventory_max_mxn IS NULL`);
};
