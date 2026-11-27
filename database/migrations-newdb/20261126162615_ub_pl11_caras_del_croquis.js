'use strict';
/**
 * `[UB.PL.11]` — **la CARA es lo que se acomoda**: `commercial.warehouse_fixture_faces`, una fila
 * por cada frente de cada mueble, con su celda (`fila`, `columna`) y hacia dónde mira.
 *
 * ── Lo medido antes, en prod, sólo lectura (2026-11-26) ─────────────────────────────────────
 *  · `commercial.warehouse_fixtures`: 9 piezas (8 de Padre Hidalgo, 1 de CEDIS), **0 acomodadas**.
 *    O sea que no hay un solo croquis configurado que esta migración pueda arruinar.
 *  · Padre Hidalgo, zona T: pasillos A (racks 01–22), B (01–22), C (01–18) con nones y pares, y
 *    D–H de 2 racks (las cabeceras). Los tres pasillos grandes pueden ser corredores separados o
 *    corredores que **comparten mueble**, y los dos casos producen EXACTAMENTE los mismos códigos.
 *
 * ⭐ **Por qué una cara y no la pieza.** `[UB.PL.8]` colocaba la pieza entera con sus dos frentes ya
 * pegados uno enfrente del otro, y eso decidía por el usuario: daba por hecho que una letra es un
 * **corredor**. Un anaquel que vive ENTRE dos pasillos tiene sus dos caras en letras distintas, así
 * que no se podía decir. Lo planteó Edgar («¿y si los anaqueles están entre pasillos?») y, al
 * ofrecerle elegir entre los dos modelos, contestó que no: **«que todo pueda ser configurable»**.
 *
 * Con la cara como unidad, los tres casos salen sin elegir ninguno:
 *   · isla con pasillo de los dos lados → las dos caras de la letra, en filas distintas, enfrentadas;
 *   · mueble entre dos corredores      → dos caras de letras distintas en la MISMA celda;
 *   · anaquel contra pared             → una sola cara en la celda.
 *
 * ⛔ El índice `commercial_faces_celda_unica` es la física escrita en la base: en una celda no puede
 * haber **dos caras mirando al mismo lado**. Un mueble tiene un frente por lado.
 *
 * ⭐ **Cada cara mira hacia uno de CUATRO lados** (arriba, abajo, izquierda, derecha), y no dos,
 * porque los pasillos no siempre corren en horizontal: el croquis real de Padre Hidalgo —que mandó
 * Edgar el 2026-11-26— tiene los anaqueles **en vertical**, con los corredores entre ellos, así que
 * ahí las caras miran a izquierda y derecha. Con dos direcciones el dibujo habría salido girado 90°
 * respecto de la tienda, que es la clase de error que nadie reporta: simplemente deja de usarse.
 *
 * Las caras se **derivan** de las piezas que ya existen (una o dos según el tipo), sin lugar: nadie
 * decide por la tienda dónde está cada mueble. No toca ninguna ubicación ni ningún código.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'commercial.warehouse_fixture_faces';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('commercial').hasTable('warehouse_fixture_faces'))) {
    await knex.schema.withSchema('commercial').createTable('warehouse_fixture_faces', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('fixture_id').notNullable().references('id').inTable('commercial.warehouse_fixtures').onDelete('CASCADE');
      // ⚠️ `warehouse_id` y `zona` viven TAMBIÉN acá, repetidos de la pieza, y no es un descuido: un
      // índice único no puede cruzar dos tablas, y la regla «una celda, un frente por lado» tiene
      // que valer por almacén y zona. El servicio los escribe desde la pieza, nunca de un parámetro.
      t.uuid('warehouse_id').notNullable();
      t.string('zona', 1).notNullable();
      t.string('cara', 8).notNullable();
      // El croquis es TOPOLOGICO: la celda dice qué está junto a qué, no cuántos metros mide.
      t.smallint('fila').nullable();
      t.smallint('columna').nullable();
      t.string('mira', 8).nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by').nullable();
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by').nullable();
      t.timestamp('deleted_at', { useTz: true }).nullable();
      t.uuid('deleted_by').nullable();
    });
  }

  await knex.raw(`
    ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ck_faces_cara;
    ALTER TABLE ${TABLA} ADD CONSTRAINT ck_faces_cara CHECK (cara IN ('nones','pares','unica'));
    ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ck_faces_zona;
    ALTER TABLE ${TABLA} ADD CONSTRAINT ck_faces_zona CHECK (zona IN ('T','B'));
    ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ck_faces_mira;
    ALTER TABLE ${TABLA} ADD CONSTRAINT ck_faces_mira CHECK (mira IS NULL OR mira IN ('arriba','abajo','izquierda','derecha'));
    -- ⭐ O está colocada del todo o no lo está: media colocación no se puede dibujar, y una fila
    -- con celda pero sin dirección se leería como un mueble sin frente.
    ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ck_faces_colocada_entera;
    ALTER TABLE ${TABLA} ADD CONSTRAINT ck_faces_colocada_entera CHECK (
      (fila IS NULL AND columna IS NULL AND mira IS NULL)
      OR (fila IS NOT NULL AND columna IS NOT NULL AND mira IS NOT NULL
          AND fila BETWEEN 1 AND 40 AND columna BETWEEN 1 AND 60)
    );
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS commercial_faces_una_por_pieza
      ON ${TABLA} (tenant_id, fixture_id, cara) WHERE deleted_at IS NULL`);
  // ⛔ La física, escrita en la base: en una celda no puede haber dos caras mirando al mismo lado.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS commercial_faces_celda_unica
      ON ${TABLA} (tenant_id, warehouse_id, zona, fila, columna, mira)
      WHERE deleted_at IS NULL AND fila IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS commercial_faces_almacen ON ${TABLA} (tenant_id, warehouse_id, zona)`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS commercial_warehouse_fixture_faces_tenant_id_composite ON ${TABLA} (tenant_id, id)`);

  await knex.raw(`ALTER TABLE ${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${TABLA}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON ${TABLA}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);

  // ── Los permisos ────────────────────────────────────────────────────────────────────────────
  // ⛔⛔ Se pregunta con `has_table_privilege`, NO con `information_schema.role_table_grants`: ese
  // catálogo no lista a `app_runtime` (el rol de la API) y copiar de ahí dejaría al módulo
  // desplegado y sin poder leer su propia tabla.
  await knex.raw(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN SELECT rolname,
                      has_table_privilege(rolname, 'commercial.warehouse_fixtures', 'SELECT') AS leer,
                      has_table_privilege(rolname, 'commercial.warehouse_fixtures', 'INSERT') AS escribir
                 FROM pg_roles WHERE rolcanlogin
      LOOP
        IF r.leer THEN EXECUTE format('GRANT SELECT ON ${TABLA} TO %I', r.rolname); END IF;
        IF r.escribir THEN EXECUTE format('GRANT INSERT, UPDATE, DELETE ON ${TABLA} TO %I', r.rolname); END IF;
      END LOOP;
    END $$;
  `);

  // ── Las caras se DERIVAN de las piezas que ya existen, sin lugar ────────────────────────────
  // Un anaquel de pasillo tiene dos (nones y pares); todo lo demás, una sola. Nadie decide acá
  // dónde está cada mueble: eso sólo lo sabe quien mira la tienda.
  const { rows: creadas } = await knex.raw(`
    WITH caras AS (
      -- ⚠️ El unnest va FUERA del CASE, en un LATERAL: Postgres no admite una función que
      -- devuelve conjunto dentro de un CASE. El CASE elige el arreglo; el LATERAL lo abre.
      -- El tipo "anaquel" es el único con dos frentes, igual que dosFrentes en el contrato.
      -- ⛔ Sin comillas invertidas acá adentro: cortan el template literal y el archivo deja de
      -- parsear. Lo cazó check:sql-backticks al empujar; el control barato es un require() del
      -- archivo, que ninguna compuerta de tipos hace porque las migraciones no se compilan.
      SELECT f.id AS fixture_id, f.tenant_id, f.warehouse_id, f.zona, c.cara
        FROM commercial.warehouse_fixtures f
        CROSS JOIN LATERAL unnest(
          CASE WHEN f.tipo = 'anaquel' THEN ARRAY['nones','pares'] ELSE ARRAY['unica'] END
        ) AS c(cara)
       WHERE f.deleted_at IS NULL
    )
    INSERT INTO ${TABLA} (tenant_id, fixture_id, warehouse_id, zona, cara)
    SELECT c.tenant_id, c.fixture_id, c.warehouse_id, c.zona, c.cara
      FROM caras c
     WHERE NOT EXISTS (
       SELECT 1 FROM ${TABLA} x
        WHERE x.fixture_id = c.fixture_id AND x.cara = c.cara AND x.deleted_at IS NULL)
    RETURNING id`);
  console.log(`[UB.PL.11] caras derivadas en esta corrida: ${creadas.length}`);

  // ⭐ El testigo: se le pregunta a la base cómo quedó, no se supone. Cada pieza viva tiene que
  // tener sus caras — una o dos según el tipo— y ninguna de más.
  const { rows: control } = await knex.raw(`
    SELECT count(*)::int AS piezas,
           sum(CASE WHEN f.tipo = 'anaquel' THEN 2 ELSE 1 END)::int AS caras_esperadas,
           (SELECT count(*)::int FROM ${TABLA} WHERE deleted_at IS NULL) AS caras_reales
      FROM commercial.warehouse_fixtures f WHERE f.deleted_at IS NULL`);
  const c = control[0];
  if (Number(c.piezas) > 0 && Number(c.caras_esperadas) !== Number(c.caras_reales)) {
    throw new Error(`[UB.PL.11] ${c.piezas} piezas esperaban ${c.caras_esperadas} caras y hay ${c.caras_reales}`);
  }
  console.log(`[UB.PL.11] OK — ${c.piezas} pieza(s), ${c.caras_reales} cara(s), 0 colocadas (las coloca quien mira la tienda).`);

  // El rol de la API tiene que poder leerla: si no, el módulo se despliega y no produce una fila.
  const { rows: acl } = await knex.raw(
    `SELECT rolname FROM pg_roles
      WHERE rolcanlogin
        AND has_table_privilege(rolname, 'commercial.warehouse_fixtures', 'SELECT')
        AND NOT has_table_privilege(rolname, '${TABLA}', 'SELECT')`);
  if (acl.length) {
    throw new Error(`[UB.PL.11] estos roles leen las piezas y NO sus caras: ${acl.map((r) => r.rolname).join(', ')}`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la tabla. No toca ninguna pieza ni ninguna ubicación. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TABLE IF EXISTS ${TABLA}`);
};
