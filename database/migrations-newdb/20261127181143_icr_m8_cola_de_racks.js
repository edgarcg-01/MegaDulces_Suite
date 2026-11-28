'use strict';
/**
 * `[ICR.M8]` — **Un rack tiene un solo dueño a la vez**: la cola de toma de rack del conteo
 * físico (`commercial.inventory_count_rack_state`) y el **orden de recorrido** del catálogo de
 * racks (`commercial.warehouse_aisles.walk_sequence`).
 *
 * Es §4 del acta del 2026-11-27 con Edgar, escrita en la base. El contador entra, el sistema le
 * entrega **el siguiente rack libre en orden de recorrido** bloqueado a su nombre, cuenta, marca
 * «terminé este rack» y recibe el siguiente. **No hay duplicados por construcción** y **no hay
 * racks olvidados**: todos están en la cola, incluido el montón «sin rack», que es un rack más y
 * va el último.
 *
 * ── Lo medido antes, en pg-prod, sólo lectura (2026-11-27, `system_identifier` 7688376744939610156)
 *
 *  · `commercial.warehouse_aisles`: **4 filas**, las 4 de Padre Hidalgo. **Yurécuaro tiene 0** —
 *    sus racks los dan de alta el lunes 30, y el piloto es el martes 1-dic con 2,024 artículos.
 *  · ⛔ **Las 4 tienen `grid_row = 0` y `grid_col = 0`**, o sea que hoy **no existe ningún orden**
 *    entre racks: ni de recorrido ni de dibujo. `inventory-team.service.ts` ya ordena por
 *    `(grid_row, grid_col)` y sobre estos datos eso es un empate de cuatro: el orden lo decide
 *    Postgres. Por eso la columna nueva, y por eso el desempate explícito por `code` e `id`.
 *  · `commercial.inventory_count_assignments`: 21 filas, con `aisle_id`. El **reparto** por
 *    pasillo ya está construido entero (PA.3) — lo que falta, y es lo único que agrega esta
 *    migración, es el **estado** (libre / tomado por quién / terminado) y el **orden**.
 *  · 1 folio abierto (`INV-2026-00011`, Padre Hidalgo) y 11 filas de bitácora. No hay un solo
 *    conteo en curso que esta migración pueda interrumpir.
 *  · `commercial.warehouse_bins`: 476 ubicaciones, 472 con `pick_sequence`. Es **otro catálogo,
 *    más fino**, y esta migración NO lo toca: el martes se trabaja por rack, no por ubicación.
 *
 * ── ⭐ Dónde vive la exclusividad: en la BASE, no en un `if`
 *
 * Dos personas pueden apretar «dame el siguiente» en el mismo milisegundo. Eso se resuelve con
 * **dos** mecanismos, los dos acá:
 *
 *  1. **`commercial_inv_rack_state_unica`**, único sobre `(tenant_id, count_id, aisle_id, pass)`
 *     con `NULLS NOT DISTINCT`: hay **una sola fila** por rack y vuelta — incluido el montón «sin
 *     rack», cuyo `aisle_id` es NULL —, así que el dueño es una columna de una fila única. Dos
 *     dueños a la vez son imposibles de representar.
 *  2. El servicio reclama con `FOR UPDATE ... SKIP LOCKED` sobre esa fila: el segundo que llega
 *     **no espera** al primero, se lleva la siguiente libre. Sin `SKIP LOCKED` la cola se
 *     serializa y con 2,024 artículos y varias personas eso se siente.
 *
 * Y el `CHECK ck_rack_state_dueno_coherente` cierra el tercer agujero: `taken` sin dueño, o un
 * dueño en una fila `free`, no se pueden escribir. Un estado que no se puede escribir no hay que
 * acordarse de validarlo.
 *
 * ── `held_by`: quién ya estuvo en este rack, que es lo que hace real la segunda vuelta
 *
 * §4.6: *«cuando un rack cierra su primera vuelta entra a la cola de la segunda, y el sistema
 * **nunca** se lo da a quien lo contó la primera vez»*. El arreglo guarda a **todos** los que
 * pasaron por el rack en esa vuelta —el que lo tomó, el que lo retomó tras un relevo y el que se
 * unió al final (§4.6)—, no sólo al último. Con una sola columna `holder_id` un relevo dejaría
 * al primero invisible y podría tocarle la segunda vuelta de lo que él mismo contó, que es
 * exactamente lo que el doble conteo ciego existe para impedir.
 *
 * ⚠️ `release` **no limpia `held_by` a propósito**: lo capturado se queda (vive en la bitácora,
 * que esta migración no toca) y la persona liberada sigue contando como «ya estuvo acá».
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'commercial.inventory_count_rack_state';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. El orden de recorrido del catálogo de racks ──────────────────────────────────────────
  //
  // ⛔ Nace NULL en las 4 filas que existen y **no se rellena con nada derivado**: el orden en que
  // se camina un almacén sólo lo sabe quien lo camina. Un orden inventado por código de rack se
  // vería igual de legítimo que uno medido, y la cola entregaría racks en un orden que nadie pidió
  // sin que se note. La consulta desempata con `NULLS LAST, code, id`, así que sin la columna
  // puesta la cola sigue siendo **estable y completa** — nada más que no está ordenada por el
  // recorrido real.
  if (!(await knex.schema.withSchema('commercial').hasColumn('warehouse_aisles', 'walk_sequence'))) {
    await knex.schema.withSchema('commercial').alterTable('warehouse_aisles', (t) => {
      t.integer('walk_sequence').nullable();
    });
  }
  await knex.raw(
    `COMMENT ON COLUMN commercial.warehouse_aisles.walk_sequence IS '[ICR.M8] Orden de RECORRIDO: qué rack se camina primero. Lo captura quien camina el almacén; NULL = sin definir, va al final de la cola desempatando por code. No es grid_row/grid_col, que son para DIBUJAR el mapa (medido 2026-11-27: las 4 filas tienen grid 0,0, o sea que no ordenan nada).'`,
  );

  // ── 2. El estado de cada rack en cada vuelta de cada folio ──────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('inventory_count_rack_state'))) {
    await knex.schema.withSchema('commercial').createTable('inventory_count_rack_state', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('count_id')
        .notNullable()
        .references('id')
        .inTable('commercial.inventory_counts')
        .onDelete('CASCADE');
      // ⭐ NULL = el montón «sin rack». No es una ausencia de dato: es un rack más, el último de
      // la cola, y alguien tiene que cerrarlo — si no, lo no contado ahí nunca se puede declarar
      // faltante (§4.1). Por eso el índice único va con NULLS NOT DISTINCT.
      t.uuid('aisle_id')
        .nullable()
        .references('id')
        .inTable('commercial.warehouse_aisles')
        .onDelete('CASCADE');
      t.smallint('pass').notNullable().defaultTo(1);
      t.string('status', 8).notNullable().defaultTo('free');
      t.uuid('holder_id').nullable();
      t.timestamp('taken_at', { useTz: true }).nullable();
      t.timestamp('finished_at', { useTz: true }).nullable();
      t.uuid('finished_by').nullable();
      t.timestamp('released_at', { useTz: true }).nullable();
      t.uuid('released_by').nullable();
      t.text('release_reason').nullable();
      // Todos los que pasaron por este rack en esta vuelta (dueño, relevo y quien se unió).
      t.specificType('held_by', 'uuid[]').notNullable().defaultTo(knex.raw(`'{}'::uuid[]`));
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by').nullable();
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by').nullable();
    });
  }

  await knex.raw(`
    ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ck_rack_state_status;
    ALTER TABLE ${TABLA} ADD CONSTRAINT ck_rack_state_status
      CHECK (status IN ('free','taken','done'));
    ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ck_rack_state_pass;
    ALTER TABLE ${TABLA} ADD CONSTRAINT ck_rack_state_pass CHECK (pass BETWEEN 1 AND 3);
    -- ⛔⛔ La regla madre, escrita como física: un rack TOMADO tiene dueño, y uno libre o
    -- terminado no lo tiene. Un estado intermedio no se puede escribir, así que no hay que
    -- acordarse de validarlo en ningún camino de inserción.
    ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ck_rack_state_dueno_coherente;
    ALTER TABLE ${TABLA} ADD CONSTRAINT ck_rack_state_dueno_coherente CHECK (
      (status = 'taken' AND holder_id IS NOT NULL AND taken_at IS NOT NULL)
      OR (status <> 'taken' AND holder_id IS NULL)
    );
    -- Terminado quiere decir que alguien lo cerró y cuándo. Sin eso, «terminado» sería una
    -- palabra y no un hecho con autor.
    ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ck_rack_state_terminado_con_autor;
    ALTER TABLE ${TABLA} ADD CONSTRAINT ck_rack_state_terminado_con_autor CHECK (
      status <> 'done' OR (finished_at IS NOT NULL AND finished_by IS NOT NULL)
    );
  `);

  // ⛔⛔ `NULLS NOT DISTINCT`: sin eso, cada «sin rack» sería una fila nueva (NULL <> NULL) y el
  // montón tendría tantos dueños como veces se pidiera. Es el mismo modo de fallar que ya cerró
  // `commercial_inv_assign_unique`. Postgres 15+; prod corre 18.6 (medido).
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS commercial_inv_rack_state_unica
      ON ${TABLA} (tenant_id, count_id, aisle_id, pass) NULLS NOT DISTINCT`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_commercial_inv_rack_state_cola
      ON ${TABLA} (tenant_id, count_id, status, pass)`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_commercial_inv_rack_state_dueno
      ON ${TABLA} (tenant_id, holder_id) WHERE holder_id IS NOT NULL`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS commercial_inventory_count_rack_state_tenant_id_composite
      ON ${TABLA} (tenant_id, id)`);

  await knex.raw(`ALTER TABLE ${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${TABLA}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON ${TABLA}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);

  await knex.raw(`
    COMMENT ON TABLE ${TABLA} IS '[ICR.M8] La cola de toma de rack del conteo físico: UNA fila por (folio, rack, vuelta). aisle_id NULL = el montón «sin rack», que es un rack más y va el último. status free/taken/done; el dueño vive en holder_id y la unicidad de la fila es lo que impide dos dueños. held_by = todos los que pasaron por el rack en esa vuelta, y es lo que impide que la segunda vuelta caiga en quien hizo la primera.'`);
  await knex.raw(
    `COMMENT ON COLUMN ${TABLA}.held_by IS '[ICR.M8] Todos los que tomaron, retomaron o se unieron a este rack en esta vuelta. NO se limpia al liberar: lo capturado se queda y la persona sigue contando como «ya estuvo acá».'`,
  );
  await knex.raw(
    `COMMENT ON COLUMN ${TABLA}.release_reason IS '[ICR.M8] Por qué el supervisor le quitó el rack a quien lo tenía (se fue, se le murió el teléfono, le tocó uno enorme). Lo capturado NO se borra.'`,
  );

  // ── Los permisos ────────────────────────────────────────────────────────────────────────────
  // ⛔⛔ Se pregunta con `has_table_privilege`, NO con `information_schema.role_table_grants`: ese
  // catálogo no lista a `app_runtime` (el rol de la API) y copiar de ahí dejaría al módulo
  // desplegado y sin poder leer su propia tabla (regla 20).
  //
  // El espejo es `inventory_count_assignments`: quien puede repartir racks tiene que poder verlos
  // y tomarlos. Acá sí hace falta UPDATE (tomar, terminar, liberar son UPDATEs).
  await knex.raw(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN SELECT rolname,
                      has_table_privilege(rolname, 'commercial.inventory_count_assignments', 'SELECT') AS leer,
                      has_table_privilege(rolname, 'commercial.inventory_count_assignments', 'INSERT') AS escribir
                 FROM pg_roles WHERE rolcanlogin
      LOOP
        IF r.leer THEN EXECUTE format('GRANT SELECT ON ${TABLA} TO %I', r.rolname); END IF;
        IF r.escribir THEN EXECUTE format('GRANT INSERT, UPDATE, DELETE ON ${TABLA} TO %I', r.rolname); END IF;
      END LOOP;
    END $$;
  `);

  // ⭐ El testigo: se le pregunta a la base cómo quedó, no se supone. Si el rol de la API puede
  // repartir racks y no puede tomarlos, el módulo se despliega y no produce una sola fila.
  const { rows: acl } = await knex.raw(
    `SELECT rolname FROM pg_roles
      WHERE rolcanlogin
        AND has_table_privilege(rolname, 'commercial.inventory_count_assignments', 'SELECT')
        AND NOT has_table_privilege(rolname, '${TABLA}', 'SELECT')`);
  if (acl.length) {
    throw new Error(`[ICR.M8] estos roles leen el reparto y NO la cola de racks: ${acl.map((r) => r.rolname).join(', ')}`);
  }

  // ⚠️ **Sin backfill, a propósito.** Las filas de la cola las crea el servicio al abrirla
  // (`ensureQueue`, idempotente con ON CONFLICT DO NOTHING), no esta migración: Yurécuaro da de
  // alta sus racks el lunes 30 y un backfill de hoy los dejaría fuera de la cola del martes sin
  // que nadie se entere. Lo que se crea al abrir refleja el catálogo del momento.
  const { rows: estado } = await knex.raw(
    `SELECT (SELECT count(*)::int FROM commercial.warehouse_aisles) AS racks,
            (SELECT count(*)::int FROM commercial.warehouse_aisles WHERE walk_sequence IS NOT NULL) AS con_orden,
            (SELECT count(*)::int FROM ${TABLA}) AS filas_de_cola`);
  const e = estado[0];
  console.log(
    `[ICR.M8] OK — ${e.racks} rack(s) en el catálogo, ${e.con_orden} con orden de recorrido, ${e.filas_de_cola} fila(s) de cola (las crea el servicio al abrir el folio).`,
  );
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la tabla y la columna de orden. Nada más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TABLE IF EXISTS ${TABLA}`);
  if (await knex.schema.withSchema('commercial').hasColumn('warehouse_aisles', 'walk_sequence')) {
    await knex.schema
      .withSchema('commercial')
      .alterTable('warehouse_aisles', (t) => t.dropColumn('walk_sequence'));
  }
};
