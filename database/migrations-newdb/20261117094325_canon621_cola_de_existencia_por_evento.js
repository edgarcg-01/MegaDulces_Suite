'use strict';
/**
 * `[CANON.6.21]` Oleada 8b, paso 3: el EVENTO. Cada cambio en una fuente del precio, los dos factores de caja o el costo
 * unitario anota en una cola qué SKUs tocó, y una función que drena recalcula sólo esos con
 * `analytics.recalcular_existencia` (pasos 1–2). Es lo que permitirá retirar el `REFRESH` de cada 5 minutos de
 * `existencia-aux` (paso 6): el que llama a la función al llegar el aviso es el paso 4 (API).
 *
 * Crea, sin tocar nada de lo que hay:
 *   · `analytics.llaves_sucias` — la cola. SÓLO ALTAS, con `id` creciente y SIN llave única por SKU: el que drena toma
 *     «hasta el id N» y quita repetidos él. ⛔ No es un detalle: con una llave única (`ON CONFLICT DO NOTHING`) la
 *     inserción del disparador ESPERARÍA a que el que drena confirme el borrado de esa misma llave — o sea, la ingesta
 *     esperaría hasta ~20 s detrás de un recálculo completo. Así no espera nunca. `sku = '*'` = recalcular todo.
 *   · Disparadores POR SENTENCIA (con tablas de transición) en las 13 fuentes que leen las cuatro reglas. Cada uno anota
 *     los SKUs de los renglones que entraron, salieron o cambiaron EN ALGO QUE LA REGLA LEE (la lista va por fuente,
 *     abajo): `catalog.products` cambia ~18,500 veces al día y casi nunca en esas columnas. En un cambio de clave anota
 *     la vieja Y la nueva (la prueba del paso 2 mostró que con la nueva sola queda viva la fila vieja del costo).
 *     `commercial.warehouses` y cualquier `TRUNCATE` anotan `'*'`. Avisan con `NOTIFY existencia_sucia`.
 *     ⛔ Nunca frenan la ingesta (ADR-104 §4): atrapan su propio error, lo registran en
 *     `analytics.llaves_sucias_errores` y dejan pasar la escritura.
 *   · `analytics.drenar_existencia()` (`SECURITY DEFINER`, la llamará la API): toma la cola, quita repetidos y
 *     recalcula. Recalcula TODO si hay `'*'`, si son más SKUs que el umbral, o si es la primera corrida del día (hora de
 *     México): lo único que la fecha mueve (las ventanas de 90 y 365 días) se pone al día con el primer movimiento de la
 *     mañana. Si otro ya está recalculando, contesta `ocupado` sin esperar. Si el recálculo falla, la cola queda intacta
 *     y la falla queda escrita.
 *   · `analytics.existencia_corridas` — una fila por corrida (modo, motivo, cuántas marcas y SKUs, filas escritas por
 *     tabla, milisegundos). La de cada mañana es el árbitro: cuenta lo que difería de lo guardado. Ojo al leerlo: ese
 *     número incluye lo que la fecha movió (precios que salen de la ventana de 90 días), no sólo eventos perdidos.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-17) ───────────────────────────────────────────────────────────────
 *  · La ingesta escribe `kepler_ods` por LOTE: un `INSERT … SELECT … ON CONFLICT DO UPDATE … WHERE IS DISTINCT FROM`
 *    por lote (`feeds-ingest/apply-handlers.js`) y un `DELETE … USING` por lote. El disparador corre una vez por lote y
 *    sólo ve lo que cambió de verdad. Sin suscripciones lógicas en pg-prod: los disparadores sí se disparan.
 *  · Renglones que cambian por día (contadores desde el 1-nov): `kdm2` ~85 mil, `kdm1` ~12 mil, `kdik` ~17 mil (casi
 *    todos en la existencia, no en el costo `c16`), `kdii` ~1,100, `kdpv_prod_util` ~3,100, etiquetas ~2,600,
 *    `catalog.products` ~18,300.
 *  · Precedentes del mismo patrón en prod: `tg_kdm1_bank_movement_legs` (ADR-104) y `tg_kdii_ficha_history` (PQ.59).
 *
 *   · `analytics.existencia_por_evento` — el INTERRUPTOR de los disparadores, que nacen APAGADOS (falla cerrada, como
 *     el de escritura a Kepler de PQ.20): apagado, no anotan nada y la escritura pasa igual. Lo prende el paso 4 junto
 *     con el que drena; sin él la cola sólo crecería. Apagarlo es la salida de emergencia, sin DDL ni despliegue.
 *
 * ⛔ FUERA DE HORARIO: crear un disparador toma un candado breve en tablas que la ingesta escribe cada 15 s
 *    (`lock_timeout` 5 s: si no lo obtiene, falla entera y no deja nada). Aplicarla antes del paso 4 no llena la cola
 *    (los disparadores nacen apagados).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';
const LISTA_RED = '00000000-0000-0000-0000-0000c0ffee02';
const CANAL = 'existencia_sucia';
const { MAX_POR_LLAVE } = require('./20261114124213_canon621_price_truth_por_llave.js');

/**
 * Las fuentes. `pk`: con qué se empareja el renglón viejo y el nuevo en un UPDATE. `cols`: lo que las reglas leen de
 * ella (fuera de la llave); un UPDATE que no cambia ninguna no anota nada. `skus(x)`: los SKUs de un conjunto de
 * renglones `x` (una tabla de transición o una subconsulta), como SELECT de una columna de texto.
 */
const porProducto = (filtro = '') => (x) => `SELECT btrim((p.sku)::text) FROM ${x} r JOIN catalog.products p ON p.id = r.product_id${filtro ? ` WHERE ${filtro}` : ''}`;
const FUENTES = [
  { corto: 'kdm2', tabla: 'kepler_ods.kdm2', pk: ['sucursal', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'], cols: ['c8', 'c9', 'c11', 'c12'],
    // Sólo las líneas de venta (U-D) entran al precio; los peldaños leen otras, pero se refrescan de noche.
    skus: (x) => `SELECT btrim(r.c8) FROM ${x} r WHERE r.c2 = 'U' AND r.c3 = 'D'` },
  { corto: 'kdm1', tabla: 'kepler_ods.kdm1', pk: ['sucursal', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'], cols: ['c9', 'c43'],
    // El encabezado no trae SKU: los de sus líneas. Llegue antes o después que ellas, alguno de los dos lo anota.
    skus: (x) => `SELECT btrim(m2.c8) FROM ${x} r JOIN kepler_ods.kdm2 m2 ON m2.sucursal = r.sucursal AND m2.c1 = r.c1
             AND m2.c2 = r.c2 AND m2.c3 = r.c3 AND m2.c4 = r.c4 AND m2.c5 = r.c5 AND m2.c6 = r.c6 WHERE r.c2 = 'U' AND r.c3 = 'D'` },
  { corto: 'kdii', tabla: 'kepler_ods.kdii', pk: ['sucursal', 'c1'],
    cols: ['c11', 'c77', 'c78', 'c79', 'c80', 'c81', 'c83', 'c84', 'c87', 'c88', 'c89', 'c90', 'c91', 'c92'],
    skus: (x) => `SELECT btrim(r.c1) FROM ${x} r` },
  { corto: 'kdik', tabla: 'kepler_ods.kdik', pk: ['sucursal', 'c1', 'c2'], cols: ['c16'], skus: (x) => `SELECT btrim(r.c2) FROM ${x} r` },
  { corto: 'kdpv_prod_util', tabla: 'kepler_ods.kdpv_prod_util', pk: ['sucursal', 'c1', 'c2', 'c3'], cols: ['c7'], skus: (x) => `SELECT btrim(r.c1) FROM ${x} r` },
  { corto: 'kdpv_prov_prod', tabla: 'kepler_ods.kdpv_prov_prod', pk: ['sucursal', 'c1', 'c2'], cols: ['c4', 'c8', 'c9', 'c10'], skus: (x) => `SELECT btrim(r.c2) FROM ${x} r` },
  { corto: 'products', tabla: 'catalog.products', pk: ['id'], cols: ['tenant_id', 'sku', 'deleted_at', 'is_promo', 'cost_base', 'factor_sale'],
    skus: (x) => `SELECT btrim((r.sku)::text) FROM ${x} r` },
  { corto: 'product_label_prices', tabla: 'commercial.product_label_prices', pk: ['id'], cols: ['tenant_id', 'product_id', 'sucursal', 'piece_price', 'box_size'],
    skus: porProducto() },
  { corto: 'product_unit_overrides', tabla: 'commercial.product_unit_overrides', pk: ['id'], cols: ['tenant_id', 'product_id', 'box_factor', 'deleted_at'],
    skus: porProducto() },
  { corto: 'product_box_factor', tabla: 'analytics.product_box_factor', pk: ['tenant_id', 'product_id'], cols: ['box_factor'], skus: porProducto() },
  { corto: 'product_prices', tabla: 'commercial.product_prices', pk: ['id'], cols: ['tenant_id', 'product_id', 'price_list_id', 'price', 'deleted_at'],
    // Sólo la lista RED entra al precio.
    skus: porProducto(`r.price_list_id = '${LISTA_RED}'::uuid`) },
  { corto: 'articulos', tabla: 'wincaja.articulos', pk: ['tenant_id', 'source_branch', 'source_dataset', 'articulo'], cols: ['factor_venta', 'unidad_venta'],
    skus: (x) => `SELECT btrim(r.articulo) FROM ${x} r WHERE r.source_dataset = 'actual'` },
  { corto: 'warehouses', tabla: 'commercial.warehouses', pk: ['id'], cols: ['tenant_id', 'code', 'kepler_code', 'wincaja_source_branch', 'deleted_at'],
    // Un almacén cambia la regla de todos: recalcular todo.
    skus: (x) => `SELECT '*'::text FROM ${x} r` },
];
const OPS = [
  ['ins', 'INSERT', 'REFERENCING NEW TABLE AS new_rows'],
  ['upd', 'UPDATE', 'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows'],
  ['del', 'DELETE', 'REFERENCING OLD TABLE AS old_rows'],
  ['trn', 'TRUNCATE', ''],
];

/** El cuerpo del disparador de una fuente. */
function funcionDisparador(f) {
  const pkIgual = f.pk.map((c) => `o.${c} = n.${c}`).join(' AND ');
  const mismo = `(${f.cols.map((c) => `o.${c}`).join(', ')}) IS NOT DISTINCT FROM (${f.cols.map((c) => `n.${c}`).join(', ')})`;
  const cambiaron = (de, contra, a, b) => `(SELECT ${a}.* FROM ${de} ${a} WHERE NOT EXISTS (SELECT 1 FROM ${contra} ${b} WHERE ${pkIgual} AND ${mismo}))`;
  const anota = (sel) => `INSERT INTO analytics.llaves_sucias (sku, fuente)
          SELECT DISTINCT x.k, '${f.corto}' FROM (${sel}) x(k) WHERE COALESCE(x.k, '') <> ''`;
  return `
    CREATE OR REPLACE FUNCTION analytics.tg_existencia_${f.corto}()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $fn$
    DECLARE v_n integer := 0; v_state text; v_msg text;
    BEGIN
      BEGIN
        -- Falla cerrada: apagado (o sin renglón), no anota nada.
        IF NOT EXISTS (SELECT 1 FROM analytics.existencia_por_evento WHERE encendida) THEN RETURN NULL; END IF;
        IF TG_OP = 'TRUNCATE' THEN
          INSERT INTO analytics.llaves_sucias (sku, fuente) VALUES ('*', '${f.corto}');
          v_n := 1;
        ELSIF TG_OP = 'INSERT' THEN
          ${anota(f.skus('new_rows'))};
          GET DIAGNOSTICS v_n = ROW_COUNT;
        ELSIF TG_OP = 'DELETE' THEN
          ${anota(f.skus('old_rows'))};
          GET DIAGNOSTICS v_n = ROW_COUNT;
        ELSE
          -- Sólo lo que cambió en algo que las reglas leen; de un cambio de clave, la vieja y la nueva.
          ${anota(`${f.skus(cambiaron('new_rows', 'old_rows', 'n', 'o'))} UNION ALL ${f.skus(cambiaron('old_rows', 'new_rows', 'o', 'n'))}`)};
          GET DIAGNOSTICS v_n = ROW_COUNT;
        END IF;
        IF v_n > 0 THEN PERFORM pg_notify('${CANAL}', ''); END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        INSERT INTO analytics.llaves_sucias_errores (tabla, operacion, sqlstate, mensaje)
        VALUES ('${f.tabla}', TG_OP, v_state, left(v_msg, 500));
      END;
      RETURN NULL;
    END
    $fn$`;
}

/** Medianoche de hoy en México, como timestamptz. */
const INICIO_DEL_DIA = `(date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') AT TIME ZONE 'America/Mexico_City')`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.llaves_sucias (
      id          bigserial PRIMARY KEY,
      tenant_id   uuid NOT NULL DEFAULT '${M}'::uuid,
      sku         text NOT NULL,
      fuente      text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`COMMENT ON TABLE analytics.llaves_sucias IS
    '[CANON.6.21] Cola de SKUs por recalcular en las tablas de existencia-aux. Sólo altas, sin llave única por SKU (así '
    'la ingesta nunca espera al que drena); la escriben SÓLO los disparadores tg_existencia_*; la vacía '
    'analytics.drenar_existencia. sku = ''*'' = recalcular todo.'`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.llaves_sucias_errores (
      id          bigserial PRIMARY KEY,
      tenant_id   uuid NOT NULL DEFAULT '${M}'::uuid,
      tabla       text NOT NULL,
      operacion   text NOT NULL,
      sqlstate    text,
      mensaje     text,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`COMMENT ON TABLE analytics.llaves_sucias_errores IS
    '[CANON.6.21] Lo que un disparador tg_existencia_* no pudo anotar. El disparador nunca frena la ingesta (ADR-104 §4): '
    'deja pasar la escritura y lo deja aquí. El recálculo completo de cada mañana lo corrige; una fila aquí = un hueco con nombre.'`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.existencia_corridas (
      id          bigserial PRIMARY KEY,
      tenant_id   uuid NOT NULL DEFAULT '${M}'::uuid,
      modo        text NOT NULL CHECK (modo IN ('llave', 'completo', 'error')),
      motivo      text,
      marcas      integer,
      llaves      integer,
      resultado   jsonb,
      mensaje     text,
      ms          integer,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_existencia_corridas_modo ON analytics.existencia_corridas (modo, created_at DESC)`);
  await knex.raw(`COMMENT ON TABLE analytics.existencia_corridas IS
    '[CANON.6.21] Una fila por corrida de analytics.drenar_existencia: modo (llave/completo/error), motivo (cola, '
    'primero_del_dia, marca_total, umbral), marcas tomadas de la cola, SKUs distintos, filas escritas por tabla y ms. '
    'La completa de cada mañana es el árbitro: cuenta lo que difería de lo guardado (incluye lo que la fecha movió).'`);

  // ── El interruptor: APAGADO. Lo prende el paso 4, junto con el que drena (sin él la cola sólo crecería). ─────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.existencia_por_evento (
      tenant_id   uuid PRIMARY KEY DEFAULT '${M}'::uuid,
      encendida   boolean NOT NULL DEFAULT false,
      nota        text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`INSERT INTO analytics.existencia_por_evento (tenant_id, encendida, nota)
    VALUES ('${M}', false, 'Instalado apagado por 20261117094325: lo prende el paso 4 de la oleada 8b junto con el que drena.')
    ON CONFLICT (tenant_id) DO NOTHING`);
  await knex.raw(`COMMENT ON TABLE analytics.existencia_por_evento IS
    '[CANON.6.21] Interruptor de los disparadores tg_existencia_*. Falla cerrada: apagado o sin renglón, no anotan nada '
    '(la escritura de la fuente pasa igual). Apagarlo es la salida de emergencia sin DDL; prenderlo sin quien drene sólo llena la cola.'`);

  // ── Los disparadores ────────────────────────────────────────────────────────────────────────────────────────────
  for (const f of FUENTES) {
    const { rows: [r] } = await knex.raw(`SELECT to_regclass('${f.tabla}') IS NOT NULL AS hay`);
    if (!r.hay) { console.log(`[CANON.6.21] falta ${f.tabla} — sin disparador (entorno sin esa fuente).`); continue; }
    // Que existan las columnas que el disparador lee: un hueco aquí se volvería un error en cada escritura.
    const { rows: faltan } = await knex.raw(`
      SELECT c FROM unnest(ARRAY[${[...f.pk, ...f.cols].map((c) => `'${c}'`).join(', ')}]) c
       WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = '${f.tabla}'::regclass AND a.attname = c AND NOT a.attisdropped)`);
    if (faltan.length) throw new Error(`[CANON.6.21] ${f.tabla} no tiene ${faltan.map((x) => x.c).join(', ')}: el disparador fallaría en cada escritura`);
    await knex.raw(funcionDisparador(f));
    await knex.raw(`REVOKE ALL ON FUNCTION analytics.tg_existencia_${f.corto}() FROM PUBLIC`);
    for (const [sufijo, evento, ref] of OPS) {
      await knex.raw(`DROP TRIGGER IF EXISTS tg_exs_${sufijo} ON ${f.tabla}`);
      await knex.raw(`CREATE TRIGGER tg_exs_${sufijo} AFTER ${evento} ON ${f.tabla} ${ref}
        FOR EACH STATEMENT EXECUTE FUNCTION analytics.tg_existencia_${f.corto}()`);
    }
  }

  // ── El que drena ────────────────────────────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.drenar_existencia()
    RETURNS TABLE (modo text, motivo text, marcas integer, llaves integer, objeto text, insertadas integer,
                   actualizadas integer, borradas integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    SET jit = off
    AS $fn$
    #variable_conflict use_column
    DECLARE v_t0 timestamptz := clock_timestamp(); v_hasta bigint; v_marcas integer := 0; v_todo boolean := false;
            v_skus text[]; v_modo text; v_motivo text; v_res jsonb := '[]'::jsonb; r record; v_state text; v_msg text;
    BEGIN
      -- Uno a la vez; si otro ya recalcula, no se espera: lo que quede en la cola lo toma la siguiente corrida.
      IF NOT pg_try_advisory_xact_lock(hashtext('analytics.recalcular_existencia')) THEN
        modo := 'ocupado'; RETURN NEXT; RETURN;
      END IF;
      BEGIN
        -- Hasta el último id visible. Lo que se confirme después (aunque tenga un id menor) se queda para la siguiente.
        SELECT max(s.id) INTO v_hasta FROM analytics.llaves_sucias s;
        WITH t AS (DELETE FROM analytics.llaves_sucias s WHERE s.id <= v_hasta RETURNING s.sku)
        SELECT count(*)::integer, COALESCE(bool_or(t.sku = '*'), false), array_agg(DISTINCT t.sku) FILTER (WHERE t.sku <> '*')
          INTO v_marcas, v_todo, v_skus FROM t;
        IF v_todo THEN
          v_motivo := 'marca_total';
        ELSIF NOT EXISTS (SELECT 1 FROM analytics.existencia_corridas c
                           WHERE c.modo = 'completo' AND c.created_at >= ${INICIO_DEL_DIA}) THEN
          v_motivo := 'primero_del_dia';
        ELSIF v_marcas = 0 THEN
          modo := 'vacio'; RETURN NEXT; RETURN;
        ELSIF cardinality(v_skus) > ${MAX_POR_LLAVE} THEN
          v_motivo := 'umbral';
        ELSE
          v_motivo := 'cola';
        END IF;
        v_modo := CASE WHEN v_motivo = 'cola' THEN 'llave' ELSE 'completo' END;
        FOR r IN SELECT * FROM analytics.recalcular_existencia(CASE WHEN v_modo = 'llave' THEN v_skus END) LOOP
          v_res := v_res || jsonb_build_object('objeto', r.objeto, 'insertadas', r.insertadas,
                                               'actualizadas', r.actualizadas, 'borradas', r.borradas);
          modo := v_modo; motivo := v_motivo; marcas := v_marcas; llaves := COALESCE(cardinality(v_skus), 0);
          objeto := r.objeto; insertadas := r.insertadas; actualizadas := r.actualizadas; borradas := r.borradas;
          RETURN NEXT;
        END LOOP;
        INSERT INTO analytics.existencia_corridas (modo, motivo, marcas, llaves, resultado, ms)
        VALUES (v_modo, v_motivo, v_marcas, COALESCE(cardinality(v_skus), 0), v_res,
                (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer);
      EXCEPTION WHEN OTHERS THEN
        -- Se deshace la toma de la cola (las marcas siguen ahí) y la falla queda escrita.
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        INSERT INTO analytics.existencia_corridas (modo, motivo, marcas, llaves, mensaje, ms)
        VALUES ('error', v_motivo, v_marcas, COALESCE(cardinality(v_skus), 0), v_state || ' ' || left(v_msg, 500),
                (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer);
        modo := 'error'; motivo := v_motivo; marcas := v_marcas; llaves := COALESCE(cardinality(v_skus), 0);
        objeto := NULL; insertadas := NULL; actualizadas := NULL; borradas := NULL;
        RETURN NEXT;
      END;
    END
    $fn$`);
  await knex.raw(`REVOKE ALL ON FUNCTION analytics.drenar_existencia() FROM PUBLIC`);
  await knex.raw(`COMMENT ON FUNCTION analytics.drenar_existencia() IS
    '[CANON.6.21] Toma la cola analytics.llaves_sucias, quita repetidos y llama a recalcular_existencia: por llave, o '
    'todo si hay ''*'', si pasan del umbral o si es la primera corrida del día (hora de México). ocupado = otro recalcula; '
    'vacio = nada que hacer; error = la cola quedó intacta y la falla está en analytics.existencia_corridas.'`);

  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT ON analytics.llaves_sucias, analytics.llaves_sucias_errores, analytics.existencia_corridas,
          analytics.existencia_por_evento TO app_runtime;
        GRANT EXECUTE ON FUNCTION analytics.drenar_existencia() TO app_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
        GRANT SELECT ON analytics.llaves_sucias, analytics.llaves_sucias_errores, analytics.existencia_corridas,
          analytics.existencia_por_evento TO dev_ro;
      END IF;
    END $$`);

  const { rows: [g] } = await knex.raw(`
    SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') AS sin_rol,
           CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
             has_function_privilege('app_runtime', 'analytics.drenar_existencia()', 'EXECUTE')
             AND has_table_privilege('app_runtime', 'analytics.existencia_corridas', 'SELECT')
             AND NOT has_table_privilege('app_runtime', 'analytics.llaves_sucias', 'INSERT')
             AND NOT has_table_privilege('app_runtime', 'analytics.llaves_sucias', 'DELETE')
             AND NOT has_table_privilege('app_runtime', 'analytics.existencia_por_evento', 'UPDATE')
           END AS ok`);
  if (!g.sin_rol && !g.ok) throw new Error('[CANON.6.21] los permisos de app_runtime no quedaron como se declara');
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const f of FUENTES) {
    const { rows: [r] } = await knex.raw(`SELECT to_regclass('${f.tabla}') IS NOT NULL AS hay`);
    if (r.hay) for (const [sufijo] of OPS) await knex.raw(`DROP TRIGGER IF EXISTS tg_exs_${sufijo} ON ${f.tabla}`);
    await knex.raw(`DROP FUNCTION IF EXISTS analytics.tg_existencia_${f.corto}()`);
  }
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.drenar_existencia()`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.existencia_corridas`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.existencia_por_evento`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.llaves_sucias_errores`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.llaves_sucias`);
};

exports.FUENTES = FUENTES;
exports.CANAL = CANAL;
