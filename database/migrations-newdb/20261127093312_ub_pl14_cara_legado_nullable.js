'use strict';
/**
 * [UB.PL.14] La columna LEGADO `cara` deja de ser obligatoria.
 *
 * -- Lo que se rompio, medido en prod el 2026-11-27 -------------------------------------------
 * [UB.PL.12] reemplazo `cara` ('nones' | 'pares' | 'unica') por `racks_modo`, que admite cinco
 * valores y puede llevar un tramo. Traspaso el contenido y cambio el indice unico. Lo que NO
 * hizo fue tocar la columna vieja, que quedo NOT NULL, sin default, y con un CHECK que solo
 * acepta sus tres valores de siempre.
 *
 * Desde entonces NINGUN camino podia insertar una cara en produccion:
 *   · derivar()      -> 500   (el boton «Configurar el croquis» / «Recoger las que faltan»)
 *   · crear()        -> 500   (dar de alta cualquier pieza del croquis)
 *   · agregarCara()  -> 500   (lo que [UB.PL.12] existia para poder hacer)
 *
 * El modulo del croquis estuvo MUERTO PARA ESCRITURA un dia entero y nadie lo vio, porque el
 * unico boton que lo dispara estaba escondido detras de `@if (!piezasDeZona().length)`. Lo
 * destapo [UB.PL.13], que volvio a hacerlo apretable: el arreglo de ayer fue lo que permitio
 * encontrar el defecto de anteayer.
 *
 * -- Por que nullable y no un valor ----------------------------------------------------------
 * Se podria seguir llenando `cara` desde `racks_modo`, pero seria MENTIR: una cara en modo
 * `rango` o `ninguno` no tiene traduccion a 'nones' | 'pares' | 'unica', y escribir 'unica' para
 * taparlo inventa un dato. `cara` es una columna en RETIRO: las 13 filas que nacieron antes del
 * traspaso conservan su valor, y las nuevas nacen NULL. Un CHECK con NULL da NULL y pasa, asi
 * que `ck_faces_cara` sigue valiendo para las que si la traen.
 *
 * ⛔ NO se borra la columna (regla 5): quitar el NOT NULL es el cambio minimo y reversible.
 *
 * ⭐ AFLOJA, no aprieta: toda fila que pasaba antes pasa ahora, asi que no necesita respaldo y
 * es compatible con la API que ya esta desplegada. Va ANTES que el codigo.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'commercial.warehouse_fixture_faces';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const { rows: antes } = await knex.raw(`
    SELECT is_nullable, count(*) OVER ()::int AS n
      FROM information_schema.columns
     WHERE table_schema = 'commercial' AND table_name = 'warehouse_fixture_faces' AND column_name = 'cara'`);
  if (!antes.length) {
    console.log('[UB.PL.14] la columna "cara" ya no existe: nada que aflojar.');
    return;
  }
  console.log(`[UB.PL.14] antes: cara is_nullable=${antes[0].is_nullable}`);

  await knex.raw(`ALTER TABLE ${TABLA} ALTER COLUMN cara DROP NOT NULL`);

  // El testigo: se le pregunta a la base como quedo, no se supone. Y se cuenta lo que hay, para
  // que quede escrito que las filas viejas NO se tocaron.
  const { rows: despues } = await knex.raw(`
    SELECT (SELECT is_nullable FROM information_schema.columns
             WHERE table_schema='commercial' AND table_name='warehouse_fixture_faces' AND column_name='cara') AS nullable,
           count(*)::int AS caras,
           count(*) FILTER (WHERE cara IS NOT NULL)::int AS con_cara
      FROM ${TABLA} WHERE deleted_at IS NULL`);
  const r = despues[0];
  if (r.nullable !== 'YES') throw new Error('[UB.PL.14] la columna "cara" sigue siendo NOT NULL');
  console.log(`[UB.PL.14] OK — cara nullable. ${r.caras} cara(s) viva(s), ${r.con_cara} conservan su valor viejo.`);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`. Se niega si ya hay filas con `cara` NULL, porque
 * volver a poner el NOT NULL con nulos adentro no se puede — y borrarlas para lograrlo seria
 * destruir caras del croquis.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows } = await knex.raw(`SELECT count(*)::int AS nulas FROM ${TABLA} WHERE cara IS NULL`);
  if (rows[0].nulas > 0) {
    throw new Error(
      `[UB.PL.14] hay ${rows[0].nulas} cara(s) con "cara" NULL: no se puede volver al NOT NULL sin borrarlas.`,
    );
  }
  await knex.raw(`ALTER TABLE ${TABLA} ALTER COLUMN cara SET NOT NULL`);
};
