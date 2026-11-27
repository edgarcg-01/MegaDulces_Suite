'use strict';
/**
 * `[UB.PL.12]` — **la cara se CONFIGURA desde la pantalla**: cuántas tiene un mueble y qué racks
 * lleva cada una dejan de salir del tipo y pasan a ser dato editable.
 *
 * ── Lo medido antes, en prod, sólo lectura (2026-11-26) ─────────────────────────────────────
 *  · `commercial.warehouse_fixture_faces`: 13 caras de 9 piezas, **0 colocadas**. Nada que migrar
 *    se pierde, porque nadie configuró un croquis todavía.
 *  · Las 13 nacieron derivadas: 8 de anaqueles (nones y pares) y 5 de cabeceras (una sola).
 *
 * ⭐ **Por qué.** Hasta aquí el código decidía: un anaquel tiene dos caras repartidas por par/non,
 * porque así es Padre Hidalgo. Pero eso es UNA forma de armar un pasillo, no la única, y fijarla
 * obliga a cada tienda a parecerse a aquélla. Edgar lo pidió textual: *«que sea 100% libre de
 * acomodar el croquis a gustos, si un pasillo tiene pares y nones, si una cabecera tiene una frente
 * a ella, todas las preguntas que me hiciste que se puedan resolver desde interfaz»*.
 *
 * Lo que la pantalla va a poder contestar, y antes no:
 *   · cuántas caras tiene este mueble (hasta cuatro: una isla se ve por los cuatro costados);
 *   · qué racks lleva cada cara — `nones`, `pares`, `todos`, un `rango`, o `ninguno`;
 *   · cómo se llama la cara, si tiene nombre propio.
 *
 * ⛔ `ninguno` es el que abre la puerta a lo que no guarda códigos: un refrigerador, una caja, una
 * columna. Van al croquis **para ubicarse**, y decir que guardan racks sería mentir.
 *
 * Idempotente. No toca ninguna ubicación ni ningún código.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'commercial.warehouse_fixture_faces';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const tiene = (col) => knex.schema.withSchema('commercial').hasColumn('warehouse_fixture_faces', col);

  if (!(await tiene('slot'))) {
    await knex.schema.withSchema('commercial').alterTable('warehouse_fixture_faces', (t) => {
      t.smallint('slot').nullable();
    });
  }
  if (!(await tiene('racks_modo'))) {
    await knex.schema.withSchema('commercial').alterTable('warehouse_fixture_faces', (t) => {
      t.string('racks_modo', 8).nullable();
      t.smallint('rack_desde').nullable();
      t.smallint('rack_hasta').nullable();
      t.string('label', 80).nullable();
    });
  }

  // ── El traspaso: lo que la columna vieja `cara` decía, dicho en los campos nuevos ───────────
  // `nones`/`pares` se conservan tal cual; `unica` pasa a `todos`, que es lo que significaba — la
  // cara se lleva el mueble entero. El `slot` sale del orden de creación dentro de cada pieza.
  if (await tiene('cara')) {
    const { rowCount } = await knex.raw(`
      UPDATE ${TABLA} f
         SET racks_modo = CASE WHEN f.cara IN ('nones','pares') THEN f.cara ELSE 'todos' END
       WHERE f.racks_modo IS NULL`);
    console.log(`[UB.PL.12] caras traspasadas desde la columna "cara": ${rowCount ?? 0}`);
  }
  const { rowCount: conSlot } = await knex.raw(`
    WITH numeradas AS (
      SELECT id, row_number() OVER (PARTITION BY fixture_id ORDER BY created_at, id) AS n
        FROM ${TABLA} WHERE deleted_at IS NULL
    )
    UPDATE ${TABLA} f SET slot = n.n FROM numeradas n WHERE n.id = f.id AND f.slot IS NULL`);
  console.log(`[UB.PL.12] caras numeradas: ${conSlot ?? 0}`);

  await knex.raw(`ALTER TABLE ${TABLA} ALTER COLUMN slot SET NOT NULL`);
  await knex.raw(`ALTER TABLE ${TABLA} ALTER COLUMN racks_modo SET NOT NULL`);

  await knex.raw(`
    ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ck_faces_slot;
    ALTER TABLE ${TABLA} ADD CONSTRAINT ck_faces_slot CHECK (slot BETWEEN 1 AND 4);
    ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ck_faces_racks_modo;
    ALTER TABLE ${TABLA} ADD CONSTRAINT ck_faces_racks_modo
      CHECK (racks_modo IN ('nones','pares','todos','rango','ninguno'));
    -- Un tramo necesita sus dos extremos y en orden; cualquier otro modo no los lleva.
    ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ck_faces_rango_entero;
    ALTER TABLE ${TABLA} ADD CONSTRAINT ck_faces_rango_entero CHECK (
      (racks_modo = 'rango' AND rack_desde IS NOT NULL AND rack_hasta IS NOT NULL AND rack_desde <= rack_hasta)
      OR (racks_modo <> 'rango' AND rack_desde IS NULL AND rack_hasta IS NULL)
    );
  `);

  // La identidad de una cara dentro de su pieza pasa a ser el slot, no el modo: dos caras del mismo
  // mueble PUEDEN llevar el mismo tipo de racks (dos tramos distintos, por ejemplo).
  await knex.raw(`DROP INDEX IF EXISTS commercial.commercial_faces_una_por_pieza`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS commercial_faces_slot_unico
      ON ${TABLA} (tenant_id, fixture_id, slot) WHERE deleted_at IS NULL`);

  // ⭐ El testigo: toda cara viva tiene que haber quedado con su modo y su slot. Si algo no se
  // traspasó, se dice acá y no cuando alguien abra la pantalla y vea una cara sin nombre.
  const { rows } = await knex.raw(`
    SELECT count(*)::int AS caras,
           count(*) FILTER (WHERE racks_modo IS NULL OR slot IS NULL)::int AS a_medias,
           count(*) FILTER (WHERE racks_modo = 'todos')::int AS de_una_cara,
           count(*) FILTER (WHERE racks_modo IN ('nones','pares'))::int AS de_pasillo
      FROM ${TABLA} WHERE deleted_at IS NULL`);
  const r = rows[0];
  if (Number(r.a_medias) > 0) throw new Error(`[UB.PL.12] ${r.a_medias} cara(s) quedaron sin modo o sin slot`);
  console.log(`[UB.PL.12] OK — ${r.caras} cara(s): ${r.de_pasillo} de pasillo (nones/pares), ${r.de_una_cara} de una sola cara.`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: las columnas nuevas y su índice. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.commercial_faces_slot_unico`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS commercial_faces_una_por_pieza
      ON ${TABLA} (tenant_id, fixture_id, cara) WHERE deleted_at IS NULL`);
  for (const c of ['ck_faces_slot', 'ck_faces_racks_modo', 'ck_faces_rango_entero']) {
    await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ${c}`);
  }
  await knex.schema.withSchema('commercial').alterTable('warehouse_fixture_faces', (t) => {
    t.dropColumn('slot');
    t.dropColumn('racks_modo');
    t.dropColumn('rack_desde');
    t.dropColumn('rack_hasta');
    t.dropColumn('label');
  });
};
