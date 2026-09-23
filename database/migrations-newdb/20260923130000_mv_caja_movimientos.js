/**
 * CG.22.3 — La bandeja de caja deja de recalcularse en cada request.
 *
 * ── El problema, MEDIDO contra prod (2026-09-22) ────────────────────────────────────────────
 * `finance.v_caja_movimientos_pendientes` tardaba **624–720 ms** en devolver 100 filas, tocando
 * **~572,000 páginas de buffer**. La pantalla hace DOS de esas consultas en secuencia (las filas
 * y el conteo de "lo que queda fuera de la ventana") más `resolverCuentas`, así que la bandeja
 * no pintaba antes de **~1.8 s** — contra el gate de aceptación de 1 s del proyecto.
 *
 * El plan lo dice sin ambigüedad:
 *
 *     Seq Scan on kdm1 d  (estimado 3,362 · REAL 610,805 filas)
 *       Filter: btrim(coalesce(c43,'')) <> 'C' AND btrim(c1) = sucursal
 *
 * Lee las **651,450 filas / 567 MB** de `kepler_ods.kdm1` para devolver 100.
 *
 * ── Dos hipótesis REFUTADAS antes de llegar acá ─────────────────────────────────────────────
 * 1. *"Falta un índice."* No: `idx_kdm1_tesoreria_c45` existe, y con `enable_seqscan = off` el
 *    plan **no cambia**. El filtro que manda es `btrim(c1) = sucursal` — columna contra columna,
 *    que ningún btree resuelve y que Postgres estima en ~0.5% cuando en realidad pasa el **94%**
 *    (de ahí el error de 181× que lo empuja a Nested Loop).
 * 2. *"El CTE `flj` está materializado y eso impide empujar el filtro de fecha."* Medido con
 *    `NOT MATERIALIZED`: sale **PEOR** — 501 ms y **el doble de páginas** (1,182,761 vs 572,639),
 *    porque inlinear hace que `flj` se evalúe dos veces. Materializar una vez ya era lo mejor.
 *
 * Conclusión: el costo es irreducible por plan. Hay que leer todo `kdm1` para poder clasificar
 * cada movimiento, y ningún filtro del consumidor baja hasta ahí.
 *
 * ── La salida, también medida ───────────────────────────────────────────────────────────────
 * La vista entera son **48,668 filas (12,237 de caja)** y calcularla completa cuesta **507 ms**.
 * O sea que se pagaban ~700 ms POR REQUEST para leer 100 filas de un conjunto que cabe entero y
 * se arma en medio segundo. Se materializa una vez por minuto y se lee por índice.
 *
 * `GOTCHAS §19` lo permite explícitamente: *"Materializar por costo sí es legítimo; el pecado es
 * materializar un valor INVENTADO, sin origen verificable en la primaria"*. Acá no se inventa
 * nada: sale de `analytics.kepler_bank_movements`, que sigue siendo la fuente canónica.
 *
 * ── Lo que NO se toca, a propósito ──────────────────────────────────────────────────────────
 * `analytics.kepler_bank_movements` tiene **5 consumidores** (bancos, caja-general, cash-ledger,
 * feed-scanner y `db-health`). La vista queda intacta; esto se agrega AL LADO y sólo la bandeja
 * se reapunta. Bancos y el feed-scanner pagan el mismo scan y podrían mudarse después — pero uno
 * por uno y con su medición, no de arrastre.
 *
 * ⚠️ FRESCURA: el matview trae `refrescado_en` en cada fila. Un matview que dejó de refrescarse
 * sirve datos viejos **sin un solo error**, y eso en una bandeja de caja se lee como "no hay
 * trabajo". El dato viaja con su edad para que la pantalla pueda declararla (ADR-056).
 *
 * @param { import("knex").Knex } knex
 */

const ORIGEN_REF = `k.sucursal || '|' || k.doc_tipo || '|' || k.folio || '|' || k.clave_banco`;
const ORIGEN_TIPO = `CASE WHEN k.signo > 0 THEN 'cobro' ELSE 'pago_proveedor' END`;

exports.up = async function (knex) {
  const v = await knex.raw(`SELECT to_regclass('analytics.kepler_bank_movements') AS t`);
  if (!v.rows[0] || !v.rows[0].t) return; // entorno sin la vista de tesorería: nada que derivar

  // ── 1. El corte de caja, materializado ────────────────────────────────────────────────────
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_caja_movimientos CASCADE`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_caja_movimientos AS
    SELECT k.*, now() AS refrescado_en
      FROM analytics.kepler_bank_movements k
     WHERE k.tipo_cuenta = 'caja'`);

  // ⚠️ El UNIQUE no es decorativo: sin él `REFRESH ... CONCURRENTLY` no está permitido, y sin
  // CONCURRENTLY el refresh toma un lock exclusivo que deja la bandeja en blanco mientras corre.
  // La llave es la de tesorería medida en CG.21: el folio COLISIONA entre X-A-45, X-D-26 y
  // X-D-60, así que `doc_tipo` va adentro. `pierna` desempata las dos patas de un traspaso.
  await knex.raw(`
    CREATE UNIQUE INDEX ux_mv_caja_movimientos
      ON analytics.mv_caja_movimientos (tenant_id, sucursal, doc_tipo, folio, clave_banco, pierna)`);

  // El acceso que hace la bandeja: por caja y por fecha descendente.
  await knex.raw(`
    CREATE INDEX ix_mv_caja_movimientos_bandeja
      ON analytics.mv_caja_movimientos (tenant_id, clave_banco, fecha_valor DESC)`);

  await knex.raw(`GRANT SELECT ON analytics.mv_caja_movimientos TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_caja_movimientos IS
    'CG.22.3 - corte de caja de analytics.kepler_bank_movements, materializado por COSTO (GOTCHAS 19). '
    'Medido: la vista tardaba 624-720 ms por request tocando ~572k paginas; armarla entera cuesta 507 ms. '
    'La refresca el carril cada minuto (job_key mv_caja_movimientos en analytics.cron_runs). '
    'refrescado_en viaja en cada fila: un matview que dejo de refrescarse sirve datos viejos sin error.'`);

  // ── 2. La bandeja pasa a leer del materializado ───────────────────────────────────────────
  //
  // Mismo contrato, misma llave, mismos filtros: lo ÚNICO que cambia es de dónde sale `k`.
  // Se agrega `refrescado_en` al final — `CREATE OR REPLACE VIEW` sólo sabe APPEND, y acá
  // igual se recrea entera porque cambia el FROM.
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
           k.importe                                                   AS monto,
           k.refrescado_en
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

  // ⚠️ El GRANT y el `security_invoker` NO se heredan al recrear una vista — lección de ADR-057,
  // que una migración de esa misma fase perdió y sólo detectó la aserción de metadata.
  await knex.raw(`GRANT SELECT ON finance.v_caja_movimientos_pendientes TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW finance.v_caja_movimientos_pendientes IS
    'CG.21/CG.22.3 - movimientos de CAJA que Kepler ya registro y el libro todavia no aplico, los dos '
    'signos. Lee de analytics.mv_caja_movimientos (materializado por costo). Llave origen_ref = '
    'sucursal|doc_tipo|folio|clave_banco: el folio COLISIONA entre X-A-45, X-D-26 y X-D-60, medido.'`);

  // ── 3. Candado: que el materializado no nazca vacío sin que nadie se entere ────────────────
  //
  // Un matview vacío no da error: da una bandeja vacía, que se lee como "no hay trabajo". Si la
  // proporción contra la vista viva no cuadra, la migración FALLA acá y no deja el engaño puesto.
  const chk = await knex.raw(`
    SELECT (SELECT count(*) FROM analytics.mv_caja_movimientos)                             AS mv,
           (SELECT count(*) FROM analytics.kepler_bank_movements WHERE tipo_cuenta='caja')  AS viva`);
  const { mv, viva } = chk.rows[0];
  if (Number(viva) > 0 && Number(mv) !== Number(viva)) {
    throw new Error(
      `mv_caja_movimientos quedó con ${mv} filas y la vista viva tiene ${viva}. `
      + 'Un matview que no cuadra con su origen sirve una bandeja falsa sin un solo error.',
    );
  }
};

exports.down = async function (knex) {
  // Se devuelve la vista a leer directo de la vista viva: más lenta, pero correcta y sin depender
  // de que alguien refresque. Un `down` que deje la bandeja apuntando a un matview huérfano sería
  // peor que no tener `down`.
  await knex.raw(`DROP VIEW IF EXISTS finance.v_caja_movimientos_pendientes`);
  await knex.raw(`
    CREATE VIEW finance.v_caja_movimientos_pendientes
      WITH (security_invoker = true) AS
    SELECT k.tenant_id, k.clave_banco, k.banco_nombre AS caja_nombre, k.sucursal, k.doc_tipo, k.folio,
           ${ORIGEN_REF} AS origen_ref,
           CASE WHEN k.signo > 0 THEN 'ingreso' ELSE 'gasto' END AS tipo,
           ${ORIGEN_TIPO} AS origen_tipo,
           k.fecha_valor, k.fecha_captura, k.entidad_code, k.beneficiario, k.concepto, k.metodo,
           k.importe AS monto
      FROM analytics.kepler_bank_movements k
     WHERE k.tenant_id = current_tenant_id()
       AND k.tipo_cuenta = 'caja' AND k.signo <> 0 AND k.es_traspaso = false AND k.importe > 0
       AND NOT EXISTS (
             SELECT 1 FROM finance.cash_ledger l
              WHERE l.tenant_id = k.tenant_id AND l.origen_tipo = ${ORIGEN_TIPO}
                AND l.origen_ref = ${ORIGEN_REF} AND l.deleted_at IS NULL AND l.estado <> 'cancelado')`);
  await knex.raw(`GRANT SELECT ON finance.v_caja_movimientos_pendientes TO app_runtime`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_caja_movimientos CASCADE`);
};
