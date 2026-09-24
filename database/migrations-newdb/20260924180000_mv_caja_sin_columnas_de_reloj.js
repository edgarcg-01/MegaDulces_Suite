/**
 * [CG.22.4] El matview de caja se reescribía ENTERO cada minuto — por dos columnas de reloj.
 *
 * ── El síntoma ───────────────────────────────────────────────────────────────────────────────
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_caja_movimientos` corre **cada minuto** y
 * cuesta **4,582 ms de media** sobre 951 corridas (min 2,446 · max 16,521 · desvío 1,863) =
 * **4,302 s** en la ventana medida. El repo decía "0.5-2 s"; no se reproduce.
 *
 * ── La causa, y no es "12,294 filas son muchas" ──────────────────────────────────────────────
 * `REFRESH ... CONCURRENTLY` NO copia la tabla: calcula lo nuevo a una temp, hace un `FULL JOIN`
 * por el índice único y aplica **sólo lo que difiere**, comparando la FILA COMPLETA con
 * `(y.*) IS DISTINCT FROM (x.*)`.
 *
 * El matview cargaba **DOS columnas que cambian en cada pasada por construcción**:
 *   · `computed_at`   — heredada de `analytics.kepler_bank_movements` por el `SELECT k.*`
 *   · `refrescado_en` — `now()`, que agregaba la migración `20260923130000`
 *
 * Con eso el **100 % de las filas parece distinto**. Medido: el diff ve **12,294 filas cambiadas
 * y las que cambian de verdad son CERO**. O sea que `CONCURRENTLY` —que existe justamente para
 * aplicar el delta— aplicaba la tabla entera, que es su PEOR caso, y encima pagando el sobrecosto
 * del diff que un refresh normal no paga.
 *
 * El precio, medido: **12,294 DELETE + 12,294 INSERT por minuto** sobre una tabla cuyo contenido
 * de negocio crece **58-74 filas por DÍA**; **8.72 MB de WAL por refresh = 12.3 GB por día**;
 * 854 autovacuums; y los índices al **54.6×** y **417×** de su tamaño reconstruido.
 *
 * ⛔ ORDEN DE ENTREGA, Y NO ES NEGOCIABLE: primero el importer y la API, DESPUÉS esta migración.
 * `refresh-caja-matview.js` leía `max(refrescado_en)` en DOS lugares y `cash-ledger.service.ts`
 * en uno; si esta migración entra antes que ellos, el carril se rompe al minuto siguiente. Los
 * dos ya salieron en el commit anterior de [CG.22.4] y no leen más esa columna.
 *
 * ── De dónde sale ahora la edad del dato ─────────────────────────────────────────────────────
 * De `analytics.cron_run_log`, que es append-only, la escribe el trigger `trg_cron_run_log` y
 * **sólo registra estados terminales**. Verificado en prod: 1,411 filas para `mv_caja_refresh`,
 * todas `ok`; sin RLS; `app_runtime` la lee; y el índice `ix_crl_job` la resuelve en 4 páginas /
 * 0.045 ms. Si el refresh fallara una hora devuelve el último cierre bueno — "datos de hace 1 h",
 * que es información, en vez de NULL.
 *
 * ── Por qué las columnas se ENUMERAN y no va un `SELECT k.*` ─────────────────────────────────
 * Porque el `*` es justamente el que arrastró `computed_at` sin que nadie lo decidiera. La lista
 * se arma leyendo `information_schema` y excluyendo las de reloj, y el `up` **asera** que la
 * exclusión haya ocurrido: si mañana la vista base gana otra columna `now()`, esto vuelve a
 * fallar en silencio y el candado es lo único que lo diría.
 *
 * ⚠️ Un matview no admite `CREATE OR REPLACE`: hay que DROP + CREATE, y eso se lleva la vista que
 * depende de él. Por eso se recrean las dos, con sus índices, su `security_invoker` y su `GRANT`
 * explícitos — nada de eso se hereda (ADR-057, que una migración de esa misma fase ya perdió).
 *
 * ⚠️ Y se reescribe el `COMMENT ON MATERIALIZED VIEW`, que en prod sigue diciendo "507 ms" y
 * nombrando mal la llave de latido (`mv_caja_movimientos` en vez de `mv_caja_refresh`). Editar el
 * archivo de la migración vieja NO alcanza: ese texto vive en el catálogo de producción — la
 * lección de [CDRP.2.1].
 *
 * @param { import("knex").Knex } knex
 */

const RELOJ = ['computed_at', 'refrescado_en'];
const ORIGEN_REF = `k.sucursal || '|' || k.doc_tipo || '|' || k.folio || '|' || k.clave_banco`;
const ORIGEN_TIPO = `CASE WHEN k.signo > 0 THEN 'cobro' ELSE 'pago_proveedor' END`;

exports.up = async function up(knex) {
  const v = await knex.raw(`SELECT to_regclass('analytics.kepler_bank_movements') AS t`);
  if (!v.rows[0] || !v.rows[0].t) return; // entorno sin la vista de tesorería: nada que derivar

  await knex.raw(`SET lock_timeout = '5s'`);

  // ── Las columnas, ENUMERADAS y sin las de reloj ──────────────────────────────────────────
  const { rows: cols } = await knex.raw(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='analytics' AND table_name='kepler_bank_movements'
      ORDER BY ordinal_position`);
  const nombres = cols.map((c) => c.column_name);
  const quedan = nombres.filter((n) => !RELOJ.includes(n));
  const sacadas = nombres.filter((n) => RELOJ.includes(n));
  if (!sacadas.length) {
    throw new Error(
      'analytics.kepler_bank_movements ya no trae ninguna columna de reloj de las esperadas '
      + `(${RELOJ.join(', ')}). O alguien la cambió, o esta migración ya no aplica: revisar ANTES `
      + 'de seguir, porque el diff de CONCURRENTLY depende de que no quede ninguna.');
  }
  console.log(`  · se excluyen del matview: ${sacadas.join(', ')} (quedan ${quedan.length} columnas)`);
  const lista = quedan.map((n) => `k."${n}"`).join(', ');

  // ── 1. El matview, sin relojes ───────────────────────────────────────────────────────────
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_caja_movimientos CASCADE`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_caja_movimientos AS
    SELECT ${lista}
      FROM analytics.kepler_bank_movements k
     WHERE k.tipo_cuenta = 'caja'`);

  // ⚠️ El UNIQUE no es decorativo: sin él `REFRESH ... CONCURRENTLY` no está permitido. La llave
  // es la de tesorería medida en CG.21 — el folio COLISIONA entre X-A-45, X-D-26 y X-D-60, así
  // que `doc_tipo` va adentro, y `pierna` desempata las dos patas de un traspaso.
  await knex.raw(`
    CREATE UNIQUE INDEX ux_mv_caja_movimientos
      ON analytics.mv_caja_movimientos (tenant_id, sucursal, doc_tipo, folio, clave_banco, pierna)`);
  await knex.raw(`
    CREATE INDEX ix_mv_caja_movimientos_bandeja
      ON analytics.mv_caja_movimientos (tenant_id, clave_banco, fecha_valor DESC)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_caja_movimientos TO app_runtime`);

  // ⛔ EL CANDADO QUE JUSTIFICA TODO ESTO: que no quede NINGUNA columna de reloj. Si quedara una,
  // el refresh volvería a reescribir la tabla entera y nadie se enteraría — no falla, sólo cuesta.
  const { rows: post } = await knex.raw(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='analytics' AND table_name='mv_caja_movimientos'
        AND column_name = ANY(?)`, [RELOJ]);
  if (post.length) {
    throw new Error(`El matview quedó con columnas de reloj: ${post.map((r) => r.column_name).join(', ')}. `
      + 'REFRESH CONCURRENTLY va a seguir reescribiendo las 12,294 filas cada minuto.');
  }

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_caja_movimientos IS
    'CG.22.3/CG.22.4 - corte de caja de analytics.kepler_bank_movements, materializado por COSTO '
    '(GOTCHAS 19). La refresca el carril caja-mv cada minuto; su job_key es **mv_caja_refresh** '
    '(la migracion 20260923130000 decia mv_caja_movimientos y estaba MAL). '
    '[CG.22.4 2026-09-24] SIN columnas de reloj a proposito: computed_at y refrescado_en cambiaban '
    'en cada pasada, asi que REFRESH CONCURRENTLY veia el 100 por ciento de las filas como '
    'distintas y reescribia la tabla entera -- 12,294 DELETE+INSERT por minuto para 0 cambios '
    'reales, 8.72 MB de WAL por refresh = 12.3 GB por dia. La edad del dato sale de '
    'analytics.cron_run_log (job_key mv_caja_refresh, status ok), no de una columna. '
    'Medido: el refresh costaba 4,582 ms de media sobre 951 corridas, NO los 0.5-2 s del repo.'`);

  // ── 2. La bandeja, sin `refrescado_en` ───────────────────────────────────────────────────
  // Verificado antes de sacarla: `movimientosPendientes` selecciona 14 columnas POR NOMBRE y
  // `refrescado_en` no está entre ellas. La columna no tenía un solo lector.
  await knex.raw(`DROP VIEW IF EXISTS finance.v_caja_movimientos_pendientes`);
  await knex.raw(`
    CREATE VIEW finance.v_caja_movimientos_pendientes
      WITH (security_invoker = true) AS
    SELECT k.tenant_id,
           k.clave_banco,
           k.banco_nombre                                              AS caja_nombre,
           k.sucursal,
           k.doc_tipo,
           k.folio,
           ${ORIGEN_REF}                                               AS origen_ref,
           CASE WHEN k.signo > 0 THEN 'ingreso' ELSE 'gasto' END       AS tipo,
           ${ORIGEN_TIPO}                                              AS origen_tipo,
           k.fecha_valor,
           k.fecha_captura,
           k.entidad_code,
           k.beneficiario,
           k.concepto,
           k.metodo,
           k.importe                                                   AS monto
      FROM analytics.mv_caja_movimientos k
     WHERE k.tenant_id = current_tenant_id()
       AND k.signo <> 0
       AND k.es_traspaso = false
       AND k.importe > 0
       AND NOT EXISTS (
             SELECT 1
               FROM finance.cash_ledger l
              WHERE l.tenant_id   = k.tenant_id
                AND l.origen_tipo = ${ORIGEN_TIPO}
                AND l.origen_ref  = ${ORIGEN_REF}
                AND l.deleted_at IS NULL
                AND l.estado <> 'cancelado')`);

  // ⚠️ El GRANT y el `security_invoker` NO se heredan al recrear una vista — ADR-057.
  await knex.raw(`GRANT SELECT ON finance.v_caja_movimientos_pendientes TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW finance.v_caja_movimientos_pendientes IS
    'CG.21/CG.22.3 - movimientos de CAJA que Kepler ya registro y el libro todavia no aplico, los dos '
    'signos. Lee de analytics.mv_caja_movimientos (materializado por costo). Llave origen_ref = '
    'sucursal|doc_tipo|folio|clave_banco: el folio COLISIONA entre X-A-45, X-D-26 y X-D-60, medido. '
    '[CG.22.4] Ya NO expone refrescado_en: no tenia lectores y forzaba la reescritura del matview.'`);

  // ── 3. Que el materializado no nazca vacío sin que nadie se entere ───────────────────────
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int AS filas FROM analytics.mv_caja_movimientos`);
  if (!n.filas) {
    throw new Error('analytics.mv_caja_movimientos quedó con 0 filas: eso no es un refresh exitoso.');
  }
  console.log(`  ✓ mv_caja_movimientos: ${n.filas} filas, sin columnas de reloj.`);
  console.log('  ⚠️ El siguiente REFRESH CONCURRENTLY debería aplicar ~0 filas. Comprobarlo con '
    + 'pg_stat_user_tables: n_tup_del de mv_caja_movimientos tiene que dejar de crecer 12,294/min.');
};

/** Vuelve a la forma de `20260923130000`: con `refrescado_en` y la vista leyéndola. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_caja_movimientos CASCADE`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_caja_movimientos AS
    SELECT k.*, now() AS refrescado_en
      FROM analytics.kepler_bank_movements k
     WHERE k.tipo_cuenta = 'caja'`);
  await knex.raw(`
    CREATE UNIQUE INDEX ux_mv_caja_movimientos
      ON analytics.mv_caja_movimientos (tenant_id, sucursal, doc_tipo, folio, clave_banco, pierna)`);
  await knex.raw(`
    CREATE INDEX ix_mv_caja_movimientos_bandeja
      ON analytics.mv_caja_movimientos (tenant_id, clave_banco, fecha_valor DESC)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_caja_movimientos TO app_runtime`);
  console.log('[mv_caja_sin_columnas_de_reloj] down: la vista finance.v_caja_movimientos_pendientes '
    + 'hay que reponerla re-aplicando 20260923130000 — se la llevó el CASCADE.');
};
