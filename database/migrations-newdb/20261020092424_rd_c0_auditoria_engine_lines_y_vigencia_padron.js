'use strict';
/**
 * `[RD.73.1]` — **Los dos huecos de estructura que encontró la revisión de C0 (2026-10-20).**
 *
 * La revisión de las tres capas salió **sólida**: RLS forzado en las 9 tablas, 36 constraints
 * entre FK y CHECK, índices naturales en todas, las 20 corridas cuadran al centavo contra la
 * suma de sus líneas y cero huérfanos. Quedaron **dos** cosas, y las dos son de forma, no de
 * dato.
 *
 * ── 1. `commission_engine_lines` era la ÚNICA de las nueve sin audit fields ────────────────
 *
 * Medido: sin `created_at`, `updated_at`, `created_by`, `updated_by`, y **sin FK a
 * `tenant_id`** (las otras ocho la tienen). Viola la regla dura de `CLAUDE.md` — *«tablas
 * nuevas: `tenant_id` UUID NOT NULL + audit fields completos»*.
 *
 * Tenía `computed_at`, que **no es lo mismo**: dice *cuándo* se calculó y no *quién lo mandó
 * calcular*. Y esta tabla la llena un botón (`POST /contrast/run`) que cuesta ~4 minutos de
 * lectura contra prod: saber quién lo apretó es justamente lo que se va a querer preguntar.
 *
 * ⛔ **NO se le agrega `deleted_at`/`deleted_by`, a propósito.** `CommissionContrastService`
 * escribe con `DELETE … WHERE (tenant_id, period_id)` + `INSERT`: reemplaza el periodo entero,
 * con borrado FÍSICO. Un `deleted_at` ahí sería una columna que **ningún consumidor filtra**, y
 * esa es la forma de crear el defecto de mañana: alguien la usa, la fila sigue apareciendo, y
 * el contraste publica una línea que creía borrada. *Una columna de borrado lógico sin lector
 * es peor que no tenerla.*
 *
 * ── 2. `commission_route_config` no podía decir DESDE CUÁNDO una ruta dejó de comisionar ───
 *
 * ⛔⛔ Lo destapó `[RD.71.1]`: la 321 dejó de ser Ruta Directa el **2026-07-15** (su último pago
 * en el libro), pero el padrón sólo sabe decir `activo = false` — **sin fecha**. Así que la
 * fecha tuvo que escribirse dentro de un texto libre, donde ninguna consulta la puede usar.
 * La escala SÍ tiene vigencia (`[RD.66]`, `valid_from`/`valid_to`) y
 * `commission_beneficiary_config` TAMBIÉN (`valid_from`/`valid_to`). El padrón de rutas era el
 * único sin ella.
 *
 * ⭐ **Se agrega `activo_hasta`, NO un par `valid_from`/`valid_to`.** La diferencia no es
 * cosmética:
 *
 *   · Una vigencia de verdad implica **N filas por ruta** (una por periodo de vigencia), y hay
 *     un índice `commission_route_config_natural_unique (tenant_id, route_code)` que lo
 *     prohíbe — con razón: `v_rd_commission_universe` hace `LEFT JOIN cfg … ON route_code`, y
 *     su propio comentario advierte que una segunda fila **multiplica la ruta, que en esa vista
 *     significa cobrarla dos veces**. Pasar a N filas obliga a revisar los nueve consumidores.
 *   · `activo_hasta` da **el hecho que falta —la fecha— sin tocar la cardinalidad**. Es
 *     aditivo, ningún consumidor cambia, y deja la vigencia completa como deuda con nombre para
 *     el día que de verdad haga falta reconstruir el padrón a una fecha pasada.
 *
 * ⚠️ **Lo que `activo_hasta` NO resuelve, y hay que decirlo:** no permite responder *«¿cómo era
 * el padrón el 2026-03-01?»*. Para eso haría falta la vigencia real. Hoy esa pregunta no la
 * hace nadie, porque la historia que importa ya está congelada en `commission_run_lines`.
 *
 * Idempotente: `hasColumn` antes de cada `addColumn`, y la FK sólo si no existe.
 *
 * @param { import("knex").Knex } knex
 */

const TAG = '[rd_c0_auditoria_engine_lines_y_vigencia_padron]';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. Audit fields en commission_engine_lines ───────────────────────────────────────────
  const tiene = async (col) => knex.schema.withSchema('commercial').hasColumn('commission_engine_lines', col);

  if (!(await tiene('created_at'))) {
    await knex.schema.withSchema('commercial').alterTable('commission_engine_lines', (t) => {
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.uuid('updated_by');
    });
    console.log(`${TAG} audit fields agregados a commission_engine_lines`);
  }

  // La FK de tenant que tienen las otras ocho. La tabla está vacía, así que no hay que validar
  // nada preexistente — pero el `NOT VALID` + `VALIDATE` sería lo correcto si tuviera filas.
  //
  // ⚠️ La guarda va por NOMBRE de constraint, no por el texto de `pg_get_constraintdef`. La
  // primera versión buscaba `LIKE '%identity.tenants%'` y **no era idempotente**: Postgres
  // omite el esquema cuando está en el `search_path`, así que el texto cambia según quién
  // corra la migración y la segunda pasada reventaba con «already exists». Lo cazó la prueba
  // de correrla dos veces — que es justo para lo que está.
  const { rows: [fk] } = await knex.raw(
    `SELECT 1 AS x FROM pg_constraint
      WHERE conrelid = 'commercial.commission_engine_lines'::regclass
        AND conname  = 'commission_engine_lines_tenant_fk'`);
  if (!fk) {
    await knex.raw(
      `ALTER TABLE commercial.commission_engine_lines
         ADD CONSTRAINT commission_engine_lines_tenant_fk
         FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    console.log(`${TAG} FK de tenant_id agregada`);
  }

  // ── 2. `activo_hasta` en el padrón de rutas ──────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasColumn('commission_route_config', 'activo_hasta'))) {
    await knex.schema.withSchema('commercial').alterTable('commission_route_config', (t) => {
      t.date('activo_hasta');
    });
    await knex.raw(`COMMENT ON COLUMN commercial.commission_route_config.activo_hasta IS
      'RD.73.1 - el ultimo dia en que esta ruta comisiono como Ruta Directa. NULL = sigue
vigente, o se apago sin registrar la fecha (caso viejo). No es una vigencia completa: no
permite reconstruir el padron a una fecha pasada, porque eso exigiria N filas por ruta y el
indice natural (tenant_id, route_code) lo prohibe a proposito -- una segunda fila multiplica la
ruta en v_rd_commission_universe, que ahi significa cobrarla dos veces.'`);
    console.log(`${TAG} activo_hasta agregada a commission_route_config`);
  }

  // ── 3. Rellenar la fecha que `[RD.71.1]` tuvo que escribir en prosa ──────────────────────
  //
  // `[RD.71.1]` (marca 20261020090646) corre ANTES que ésta, así que cuando apagó la 321 y la
  // 322 la columna todavía no existía y la fecha quedó dentro del texto de `notes`. Acá se
  // pasa a su columna, que es donde una consulta la puede usar.
  //
  // ⛔ El 2026-07-15 NO es inventado: es el `date_to` de la quincena 14, el último periodo en
  // que el libro les pagó (321: $3,390; 322: $0 por `bajo_umbral`). De la Q15 en adelante
  // ninguna de las dos tiene renglón.
  //
  // Las tres guardas del WHERE importan: sólo esas dos rutas, sólo si YA están apagadas (si
  // `[RD.71.1]` no corrió, esto no inventa una baja) y sólo si nadie puso la fecha antes.
  const { rowCount: fechadas } = await knex.raw(
    `UPDATE commercial.commission_route_config
        SET activo_hasta = DATE '2026-07-15', updated_at = now()
      WHERE route_code = ANY(ARRAY['321','322']::text[])
        AND NOT activo AND activo_hasta IS NULL AND deleted_at IS NULL`);
  console.log(`${TAG} activo_hasta fechada en ${fechadas} ruta(s)`);

  // Control: las nueve tablas con audit fields completos (salvo el deleted_at declarado arriba).
  const { rows: [t] } = await knex.raw(
    `SELECT count(*) FILTER (WHERE col = 'created_at')::int AS con_created,
            count(DISTINCT tabla)::int AS tablas
       FROM (SELECT table_name AS tabla, column_name AS col
               FROM information_schema.columns
              WHERE table_schema = 'commercial' AND table_name LIKE 'commission%') s`);
  console.log(`${TAG} ${t.con_created} de ${t.tablas} tablas con created_at`);
  if (t.con_created !== t.tablas) {
    throw new Error(`${TAG} quedaron ${t.tablas - t.con_created} tabla(s) sin created_at`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE commercial.commission_engine_lines
                    DROP CONSTRAINT IF EXISTS commission_engine_lines_tenant_fk`);
  await knex.schema.withSchema('commercial').alterTable('commission_engine_lines', (t) => {
    t.dropColumn('created_at'); t.dropColumn('updated_at');
    t.dropColumn('created_by'); t.dropColumn('updated_by');
  });
  await knex.schema.withSchema('commercial').alterTable('commission_route_config', (t) => {
    t.dropColumn('activo_hasta');
  });
};
