'use strict';
/**
 * `[UB.PL.1]` — **La pieza existe**: `commercial.warehouse_fixtures`, una fila por mueble real del
 * almacén (anaquel de pasillo, cabecera, isla, caja…) con su forma y su lugar en el croquis.
 * `warehouse_bins` gana `fixture_id` para colgar cada ubicación de su pieza.
 *
 * ── Por qué (Edgar, 2026-11-26) ─────────────────────────────────────────────────────────────
 * «arreglemos esto de raíz, desde que se genera la captura masiva» + «hagamos que todo sea
 * configurable, para poder moldear correctamente el croquis o planograma de la sucursal».
 *
 * La captura sólo sabe generar el producto cartesiano `pasillos × racks × niveles`, así que todo
 * lo que no es un pasillo tiene que robarse una letra de pasillo. El dato no podía decir la verdad.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-26) ────────────────────────────────────────
 *  · Padre Hidalgo: **315** ubicaciones con formato — 255 de anaquel (A, B, C) y **60 cabeceras
 *    dadas de alta como «pasillos» D a H**: el 19 % del catálogo miente sobre lo que es.
 *  · **0 de 9** almacenes tienen croquis: no existe la tabla, ni la columna, ni el concepto.
 *  · **51 asignaciones vivas** en 40 productos cuelgan de esas ubicaciones: no se tocan.
 *
 * ⚠️ La posición vive en la PIEZA y no en cada ubicación a propósito: una cabecera son 6 filas de
 * `warehouse_bins` y repetir su x/y en las seis obliga a mantenerlas iguales a mano (D3 del anexo).
 *
 * ⛔ Esta migración **no cambia un solo código de ubicación** (D1) y **no toca `bin_assignments`**.
 * Crea una tabla y una columna; el llenado de las piezas de Padre Hidalgo va en `[UB.PL.2]`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'commercial.warehouse_fixtures';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('commercial').hasTable('warehouse_fixtures'))) {
    await knex.schema.withSchema('commercial').createTable('warehouse_fixtures', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable().defaultTo(knex.raw('public.current_tenant_id()'));
      t.uuid('warehouse_id').notNullable();
      // El croquis es por almacén Y zona (D5): bodega y tienda son plantas distintas.
      t.specificType('zona', 'char(1)').notNullable();
      // 'anaquel' | 'cabecera' | 'isla' | 'caja' | 'mostrador' — el catálogo vive en contracts y se
      // valida ahí; acá sólo se exige que no venga vacío, para que un tipo nuevo no pida migración.
      t.string('tipo', 24).notNullable();
      /** La letra que la pieza ya usa en el código de sus ubicaciones. NULL = no genera códigos. */
      t.specificType('pasillo', 'char(1)').nullable();
      t.smallint('racks').notNullable().defaultTo(1);
      t.smallint('niveles').notNullable().defaultTo(1);
      // El croquis es TOPOLOGICO, no a escala: fila y columna dicen qué está junto a qué, no metros.
      t.smallint('fila').nullable();
      t.smallint('columna').nullable();
      t.integer('orden').nullable();
      t.string('label', 120).nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by').nullable();
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by').nullable();
      t.timestamp('deleted_at', { useTz: true }).nullable();
      t.uuid('deleted_by').nullable();
    });
  }

  // Una letra de pasillo no puede estar en dos piezas vivas de la misma zona del mismo almacén:
  // es lo que hoy obliga a inventar letras y lo que haría que dos piezas generen el mismo código.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS commercial_fixtures_pasillo_unico
      ON ${TABLA} (tenant_id, warehouse_id, zona, pasillo)
      WHERE deleted_at IS NULL AND pasillo IS NOT NULL`);
  // Dos piezas tampoco pueden ocupar la misma celda del croquis.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS commercial_fixtures_celda_unica
      ON ${TABLA} (tenant_id, warehouse_id, zona, fila, columna)
      WHERE deleted_at IS NULL AND fila IS NOT NULL AND columna IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS commercial_fixtures_almacen ON ${TABLA} (tenant_id, warehouse_id, zona)`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS commercial_warehouse_fixtures_tenant_id_composite ON ${TABLA} (tenant_id, id)`);

  // La ubicación cuelga de su pieza. NULL mientras no se derive: nada se rompe si falta (UB.PL.2).
  if (!(await knex.schema.withSchema('commercial').hasColumn('warehouse_bins', 'fixture_id'))) {
    await knex.schema.withSchema('commercial').alterTable('warehouse_bins', (t) => {
      t.uuid('fixture_id').nullable();
    });
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS commercial_bins_fixture ON commercial.warehouse_bins (tenant_id, fixture_id)`);

  // RLS como toda tabla con tenant_id (ADR-010).
  await knex.raw(`ALTER TABLE ${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='commercial' AND tablename='warehouse_fixtures' AND policyname='warehouse_fixtures_tenant') THEN
        CREATE POLICY warehouse_fixtures_tenant ON ${TABLA}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);

  // Los mismos permisos que ya tiene warehouse_bins: si la API puede leer una, puede leer la otra.
  //
  // ⛔⛔ Se pregunta con `has_table_privilege`, NO con `information_schema.role_table_grants`.
  // Medido en prod el 2026-11-26: `information_schema` lista UN solo rol sobre `warehouse_bins`
  // (`dev_ro`, SELECT) y **`app_runtime` —el rol con el que corre la API— no aparece**, aunque
  // puede leerla y escribirla. Copiar desde ahí habría dejado la tabla nueva sin acceso para la
  // API, y el módulo habría fallado en prod con un error de permisos que no se ve en ninguna
  // prueba. `has_table_privilege` sí ve el privilegio venga de donde venga (grupo, PUBLIC, dueño).
  await knex.raw(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT rolname,
                      has_table_privilege(rolname, 'commercial.warehouse_bins', 'SELECT') AS leer,
                      has_table_privilege(rolname, 'commercial.warehouse_bins', 'INSERT') AS escribir
                 FROM pg_roles WHERE rolcanlogin
      LOOP
        IF r.escribir THEN
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.warehouse_fixtures TO %I', r.rolname);
        ELSIF r.leer THEN
          EXECUTE format('GRANT SELECT ON commercial.warehouse_fixtures TO %I', r.rolname);
        END IF;
      END LOOP;
    END $$`);

  // Y se COMPRUEBA, no se supone: si la API no puede leer la tabla que acabamos de crear, la
  // migración falla acá y no cuando alguien abra la pantalla en prod.
  const apiLee = await knex.raw(`
    SELECT coalesce(bool_and(has_table_privilege(rolname, 'commercial.warehouse_fixtures', 'SELECT')), true) AS ok
      FROM pg_roles
     WHERE rolcanlogin AND has_table_privilege(rolname, 'commercial.warehouse_bins', 'SELECT')`);
  if (apiLee.rows?.[0]?.ok === false) {
    throw new Error('[UB.PL.1] alguien que lee warehouse_bins NO puede leer warehouse_fixtures: revisá los GRANT antes de seguir');
  }

  const n = await knex(TABLA).count({ n: '*' }).first();
  console.log(`[UB.PL.1] commercial.warehouse_fixtures lista · ${n?.n ?? 0} pieza(s) · warehouse_bins.fixture_id agregada`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la columna y la tabla. No toca ninguna ubicación. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.commercial_bins_fixture`);
  if (await knex.schema.withSchema('commercial').hasColumn('warehouse_bins', 'fixture_id')) {
    await knex.schema.withSchema('commercial').alterTable('warehouse_bins', (t) => t.dropColumn('fixture_id'));
  }
  await knex.schema.withSchema('commercial').dropTableIfExists('warehouse_fixtures');
  console.log('[UB.PL.1] revertido: sin warehouse_fixtures y sin warehouse_bins.fixture_id');
};
