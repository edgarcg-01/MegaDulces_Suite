/**
 * [VP.3.1] `analytics.master_data_history` — el log de cambios de los DATOS MAESTROS (ADR-056).
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * Es la mitad de la queja que originó la fase VP: *"no manejamos logs de cambios"*. Medido contra
 * el repo el 2026-09-05: **cero** historial para precio, costo, punto de reorden, precio de etiqueta
 * y factor de caja. Los ~11 importers que escriben esas tablas hacen UPSERT ciego — **cero** setean
 * `updated_by` (la columna existe en 3 de 4 y MIENTE: conserva el valor viejo mientras el precio
 * cambia) y **cero** conservan el valor anterior.
 *
 * El caso que lo hace caro: `import-computed-reorder.js` e `import-network-reorder.js` pisan **nueve
 * columnas de política de golpe** (mínimo, reorden, máximo, lead time, safety stock, nivel de
 * servicio, ABC, XYZ, CV). Si mañana el punto de reorden de un SKU pasa de 40 a 12 y dispara una
 * requisición equivocada, hoy **no hay forma de saber que era 40** — ni cuándo cambió, ni cuál de las
 * dos corridas lo escribió.
 *
 * ── POR QUÉ ES UNA TABLA Y NO VIOLA §32 ──────────────────────────────────────────────────
 * `GOTCHAS.md` §32 prohíbe COPIAR una tabla. Esto no es una copia: es un **hecho nuevo** —el evento
 * de cambio— que no existe en ninguna otra parte y no se puede derivar de nada (la primaria sólo
 * conserva el estado actual). §32 admite explícitamente tabla real para "histórico/snapshots".
 *
 * ── FORMA: una fila por CAMBIO, con el diff en JSONB ──────────────────────────────────────
 * Se evaluó una fila por (campo, valor_anterior, valor_nuevo) y se descartó por dos razones:
 *   · **volumen** — 9 columnas × ~9,800 SKUs de política daría ~88k filas por corrida nocturna
 *     contra ~9,800;
 *   · **el evento es uno** — las 9 columnas las escribió UNA pasada del importer; partirlo en 9
 *     filas pierde que fueron la misma decisión.
 * El diff en JSONB conserva las dos cosas y se consulta igual de bien:
 *     `WHERE tabla='commercial.reorder_policy' AND diff -> 'reorder_point' IS NOT NULL`
 * ⚠️ Usar `diff -> 'campo' IS NOT NULL`, **NO** el operador `?` de JSONB: knex no lo escapa bien
 * (regla vieja del proyecto, ver CLAUDE.md → convenciones técnicas).
 *
 * ── EL TRIGGER NO SE TRAGA ERRORES ───────────────────────────────────────────────────────
 * A propósito, y es distinto del criterio de `cron-heartbeat.js` (que nunca lanza). Un latido que
 * se pierde cuesta una alarma; una **historia** que se pierde en silencio te deja una tabla
 * incompleta que se lee igual que una completa — exactamente el modo de falla de esta fase entera
 * (`analytics.customer_receivables` vacía en prod porque su importer nunca corrió, y nadie lo notó).
 * Si no se puede registrar el cambio, el cambio no pasa.
 *
 * Por eso el `tenant_id` sale de **la fila** (`NEW.tenant_id`), no de `current_tenant_id()`: los
 * importers corren como `postgres` sin sesión de tenant, y colgar la auditoría de un GUC que ellos
 * no setean habría tumbado los feeds la primera noche. Las 4 tablas lo traen — verificado.
 *
 * @param { import("knex").Knex } knex
 */

/**
 * Qué se vigila. Sólo columnas que MUEVEN DINERO o una decisión: no interesa auditar `updated_at`.
 * Los nombres se verificaron contra `information_schema` antes de escribirlos; una columna que no
 * exista sería un hueco mudo (el trigger nunca la vería), así que `up()` los valida y aborta.
 */
const VIGILADAS = {
  'commercial.product_prices': ['price', 'tax_rate', 'min_qty'],
  'commercial.product_label_prices': [
    'piece_price', 'wholesale_piece_price', 'pack_price', 'wholesale_pack_price',
    'box_price', 'box_size', 'barcode',
  ],
  'commercial.reorder_policy': [
    'min_stock', 'reorder_point', 'max_stock', 'lead_time_days', 'safety_stock',
    'service_level', 'abc_class', 'xyz_class',
  ],
  'catalog.products': [
    'nombre', 'barcode', 'factor_sale', 'factor_purchase',
    'cost_base', 'cost_with_tax', 'cost_per_case',
  ],
};

exports.up = async function (knex) {
  // `CREATE TRIGGER` toma ACCESS EXCLUSIVE sobre la tabla. Es un cambio de catálogo (milisegundos,
  // no reescribe filas), pero si alguna transacción larga la tiene tomada, esta migración se
  // encolaría — y TODO escritor posterior se encola detrás. Con `lock_timeout` falla rápido y se
  // reintenta, en vez de congelar los feeds. Lección de la aplicación de las migs de la Fase LC.
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. La tabla ────────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('analytics').hasTable('master_data_history'))) {
    await knex.raw(`
      CREATE TABLE analytics.master_data_history (
        id          bigserial PRIMARY KEY,
        tenant_id   uuid        NOT NULL,
        tabla       text        NOT NULL,
        pk          text        NOT NULL,
        op          text        NOT NULL,
        diff        jsonb       NOT NULL,
        db_role     text        NOT NULL,
        actor       text,
        changed_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT mdh_op_valido  CHECK (op IN ('UPDATE','DELETE')),
        CONSTRAINT mdh_diff_no_vacio CHECK (diff <> '{}'::jsonb)
      )`);

    // "¿qué le pasó a ESTE registro?" — el drill-down desde una pantalla.
    await knex.raw(`CREATE INDEX ix_mdh_registro ON analytics.master_data_history
      (tenant_id, tabla, pk, changed_at DESC)`);
    // "¿qué se movió anoche?" — la lectura cronológica, para explicar un número que cambió.
    await knex.raw(`CREATE INDEX ix_mdh_cronologico ON analytics.master_data_history
      (tenant_id, changed_at DESC)`);

    await knex.raw(`GRANT SELECT, INSERT ON analytics.master_data_history TO app_runtime`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE analytics.master_data_history_id_seq TO app_runtime`);
    // Sin UPDATE ni DELETE a propósito: una historia que se puede editar no es una historia.

    await knex.raw(`COMMENT ON TABLE analytics.master_data_history IS
      'VP.3.1 (ADR-056) — log de cambios de datos maestros (precio, costo, reorden, etiqueta). Una fila por CAMBIO con el diff en JSONB. La escribe el trigger analytics.log_master_data_change(); app_runtime sólo puede INSERT/SELECT: no se edita ni se borra.'`);
    await knex.raw(`COMMENT ON COLUMN analytics.master_data_history.db_role IS
      'current_user del escritor. Distingue la app (app_runtime) del importer (postgres) sin necesidad de que nadie lo declare.'`);
    await knex.raw(`COMMENT ON COLUMN analytics.master_data_history.actor IS
      'Quien dice ser el escritor, vía SET app.actor. NULL = no lo declaró (VP.3.2 lo cablea en los importers). Nunca se infiere.'`);
  }

  // ── 2. La función ──────────────────────────────────────────────────────────────────────
  // Genérica: recibe las columnas a vigilar por TG_ARGV, así una tabla nueva se suma con un
  // CREATE TRIGGER y sin tocar plpgsql.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.log_master_data_change()
    RETURNS TRIGGER AS $$
    DECLARE
      j_old  jsonb;
      j_new  jsonb;
      d      jsonb := '{}'::jsonb;
      col    text;
      fila   jsonb;
      t_id   uuid;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        j_old := to_jsonb(OLD); j_new := '{}'::jsonb; fila := j_old;
      ELSE
        j_old := to_jsonb(OLD); j_new := to_jsonb(NEW); fila := j_new;
      END IF;

      FOREACH col IN ARRAY TG_ARGV LOOP
        -- IS DISTINCT FROM y no <>: con NULL de un lado, <> da NULL y el cambio se perdería.
        IF (j_old -> col) IS DISTINCT FROM (j_new -> col) THEN
          d := d || jsonb_build_object(col, jsonb_build_object(
                 'antes', j_old -> col, 'despues', j_new -> col));
        END IF;
      END LOOP;

      -- Sin cambio en lo vigilado no hay nada que contar. Un UPDATE no-op (los importers los hacen
      -- por miles) no debe dejar rastro: ensuciaría la historia y escondería los cambios de verdad.
      IF d = '{}'::jsonb THEN RETURN NULL; END IF;

      t_id := (fila ->> 'tenant_id')::uuid;
      IF t_id IS NULL THEN
        RAISE EXCEPTION 'master_data_history: % sin tenant_id en la fila — no se puede auditar el cambio', TG_TABLE_NAME
          USING ERRCODE = '23502';
      END IF;

      INSERT INTO analytics.master_data_history (tenant_id, tabla, pk, op, diff, db_role, actor)
      VALUES (
        t_id,
        TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
        fila ->> 'id',
        TG_OP,
        d,
        current_user,
        NULLIF(current_setting('app.actor', true), '')
      );
      RETURN NULL;  -- AFTER trigger: el valor de retorno se ignora
    END;
    $$ LANGUAGE plpgsql;

    COMMENT ON FUNCTION analytics.log_master_data_change() IS
    'VP.3.1 — AFTER UPDATE/DELETE. Compara las columnas de TG_ARGV y escribe UNA fila en analytics.master_data_history con el diff. NO se traga errores: si no se puede registrar el cambio, el cambio no pasa (una historia incompleta se lee igual que una completa).';
  `);

  // ── 3. Los triggers, y el candado de que las columnas EXISTEN ─────────────────────────
  for (const [tabla, cols] of Object.entries(VIGILADAS)) {
    const [schema, name] = tabla.split('.');
    // Una columna mal escrita sería un hueco MUDO: el trigger no la vería nunca y la historia
    // saldría incompleta sin que nada falle. Se valida contra el catálogo antes de crear nada.
    const { rows } = await knex.raw(
      `SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=?`,
      [schema, name],
    );
    const existentes = new Set(rows.map((r) => r.column_name));
    const faltantes = cols.filter((c) => !existentes.has(c));
    if (!existentes.size) {
      // La tabla no existe en este destino (base parcial) — se omite, no se inventa.
      // eslint-disable-next-line no-console
      console.log(`  [VP.3.1] ${tabla} no existe en este destino — se omite el trigger.`);
      continue;
    }
    if (faltantes.length) {
      throw new Error(
        `[VP.3.1] ${tabla}: columnas vigiladas inexistentes → ${faltantes.join(', ')}. `
        + 'Corregir VIGILADAS: una columna que no existe es un hueco mudo en la historia.',
      );
    }
    const args = cols.map((c) => `'${c}'`).join(', ');
    await knex.raw(`
      DROP TRIGGER IF EXISTS trg_master_data_history ON ${tabla};
      CREATE TRIGGER trg_master_data_history
        AFTER UPDATE OR DELETE ON ${tabla}
        FOR EACH ROW
        EXECUTE FUNCTION analytics.log_master_data_change(${args});
    `);
  }
};

exports.down = async function (knex) {
  for (const tabla of Object.keys(VIGILADAS)) {
    await knex.raw(`DROP TRIGGER IF EXISTS trg_master_data_history ON ${tabla}`).catch(() => {});
  }
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.log_master_data_change()`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.master_data_history`);
};
