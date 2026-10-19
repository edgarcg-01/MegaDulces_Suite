'use strict';
/**
 * ⭐⭐ `[CGA-A.22]` — **Los cobros de ruta dejan de viajar por cron: prod los LEE en vivo.**
 *
 * ── Qué se pide, y por qué el cron no alcanza ──────────────────────────────────────────────
 *
 * Edgar, 2026-10-19: *"no quiero nada de crons, y quiero que la información tenga una frescura
 * de menos de 2 seg"*. Con el carril de hoy el mejor caso es **10 minutos** —el periodo del cron
 * `route_collections`— y el peor es infinito, que es lo que pasó ese día: la ruta 27 entregó su
 * ticket de **\$19,939.00** y no apareció (`GOTCHAS` §87).
 *
 * ⭐ Esto no baja el lag a 2 segundos: lo baja a **cero**. Prod deja de tener una copia que hay
 * que refrescar y pasa a **leer la tabla del runner en el momento de la consulta**.
 *
 * ── Qué lo hace barato, medido el 2026-10-19 ───────────────────────────────────────────────
 *
 *     mart.cobros_ruta (runner)        173 filas · 176 kB · 24 ms leer TODO
 *     analytics.route_collections      173 filas · mismas fechas  -> idénticas, no se pierde nada
 *     dependientes                     1 solo: finance.v_caja_movimientos_pendientes
 *     la cola completa hoy             36–54 ms (13,357 filas)
 *
 * ⭐ **Y la tubería ya estaba puesta**: el servidor `runner_rutas` existe en prod desde antes,
 * con su `user mapping` a `postgres`, y **cero tablas foráneas**. Nadie lo usó nunca.
 *
 * ── Lo que cambia, y lo que NO ─────────────────────────────────────────────────────────────
 *
 * `analytics.route_collections` deja de ser TABLA y pasa a ser VISTA sobre la tabla foránea.
 * Las columnas, los nombres y el orden se conservan **exactos**, así que la vista de la cola no
 * cambia de forma — se recrea sólo porque Postgres exige soltarla para soltar la tabla.
 *
 * ⚠️ `created_at`/`updated_at` ya no existen en el origen: se emiten desde `_merged_at`, que es
 * lo que el runner sí sabe. Nadie las lee hoy (el único dependiente no las menciona), pero se
 * conservan en el contrato en vez de desaparecer en silencio.
 *
 * ── El costo, que es real y es uno ─────────────────────────────────────────────────────────
 *
 * ⚠️ **La bandeja pasa a depender de que el runner responda.** Si `pgvector-md` no contesta, la
 * consulta **da error** en vez de devolver vacío. Eso es lo CORRECTO —error ≠ vacío, ADR-056; hoy
 * un runner caído se ve como «no hay cobros nuevos», que es peor porque es silencioso— pero es
 * visible: la pantalla muestra fallo. El `connect_timeout=5` del servidor acota el peor caso.
 *
 * ⛔ **Y deja el cron sin trabajo.** `import-route-collections.js` escribiría sobre una vista y
 * fallaría cada 10 minutos. Su renglón sale de `ops/vl/crontab.feeds` **en el mismo commit**:
 * dejarlo rojo sería cambiar un carril sano por una alarma permanente que nadie lee.
 *
 * ── Dónde encaja con A.21 ──────────────────────────────────────────────────────────────────
 *
 * Esta migración mata el **tercer** salto (mart → prod, 10 min). El **segundo** (stg → mart, el
 * merge que no corrió) lo mata `[CGA-A.21]` en `runner-cobros-setup.sql`, con un disparador sobre
 * el `\copy`. Con las dos, la frescura es **el instante en que la camioneta entrega**.
 *
 * Idempotente: `IF NOT EXISTS` / `CREATE OR REPLACE`, y el `up` no hace nada si ya corrió.
 *
 * @param { import("knex").Knex } knex
 */

const SRV = 'runner_rutas';
const FT = 'analytics.ft_cobros_ruta';
const TBL = 'analytics.route_collections';
const PEND = 'finance.v_caja_movimientos_pendientes';
const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** La vista de la cola, textual como `pg_get_viewdef` la devolvió el 2026-10-19 (con `ruta`). */
const DEF_PENDIENTES = `SELECT k.tenant_id,
    k.clave_banco,
    k.banco_nombre AS caja_nombre,
    k.sucursal,
    k.doc_tipo,
    k.folio,
    (((((k.sucursal || '|'::text) || k.doc_tipo) || '|'::text) || k.folio) || '|'::text) || k.clave_banco AS origen_ref,
        CASE
            WHEN k.signo > 0 THEN 'ingreso'::text
            ELSE 'gasto'::text
        END AS tipo,
        CASE
            WHEN k.signo > 0 THEN 'cobro'::text
            ELSE 'pago_proveedor'::text
        END AS origen_tipo,
    k.fecha_valor,
    k.fecha_captura,
    k.entidad_code,
    k.beneficiario,
    k.concepto,
    k.metodo,
    k.importe AS monto,
    NULL::text AS ruta
   FROM analytics.mv_caja_movimientos k
  WHERE k.tenant_id = current_tenant_id() AND k.signo <> 0 AND k.es_traspaso = false AND k.importe > 0::numeric AND NOT (EXISTS ( SELECT 1
           FROM finance.cash_ledger l
          WHERE l.tenant_id = k.tenant_id AND l.origen_tipo =
                CASE
                    WHEN k.signo > 0 THEN 'cobro'::text
                    ELSE 'pago_proveedor'::text
                END AND l.origen_ref = ((((((k.sucursal || '|'::text) || k.doc_tipo) || '|'::text) || k.folio) || '|'::text) || k.clave_banco) AND l.deleted_at IS NULL AND l.estado <> 'cancelado'::text))
UNION ALL
 SELECT r.tenant_id,
    '0011'::text AS clave_banco,
    'CAJA GENERAL'::text AS caja_nombre,
    r.almacen AS sucursal,
    'U-A-5'::text AS doc_tipo,
    r.cobro_folio AS folio,
    ((r.almacen || '|U-A-5|'::text) || r.cobro_folio) || '|0011'::text AS origen_ref,
    'ingreso'::text AS tipo,
    'cobro'::text AS origen_tipo,
    r.fecha AS fecha_valor,
    r.fecha AS fecha_captura,
    'CONTADO'::text AS entidad_code,
    'CONTADO'::text AS beneficiario,
    string_agg(DISTINCT COALESCE(r.referencia, r.folio_corte), ' · '::text) AS concepto,
    NULL::text AS metodo,
    sum(r.importe) AS monto,
    string_agg(DISTINCT r.truck, ' · '::text) AS ruta
   FROM analytics.route_collections r
  WHERE r.tenant_id = current_tenant_id() AND r.cuenta = '0011'::text AND NOT (EXISTS ( SELECT 1
           FROM finance.cash_ledger l
          WHERE l.tenant_id = r.tenant_id AND l.origen_tipo = 'cobro'::text AND l.origen_ref = (((r.almacen || '|U-A-5|'::text) || r.cobro_folio) || '|0011'::text) AND l.deleted_at IS NULL AND l.estado <> 'cancelado'::text))
  GROUP BY r.tenant_id, r.almacen, r.cobro_folio, r.fecha`;

/** La vista que reemplaza a la tabla. Mismas columnas, mismo orden. */
const DEF_ROUTE = `
 SELECT '${TENANT}'::uuid AS tenant_id,
    f.truck, f.almacen, f.cobro_folio, f.fecha, f.cuenta, f.doc_tipo, f.folio_corte,
    f.importe, f.referencia,
    f._merged_at AS created_at,
    f._merged_at AS updated_at
   FROM ${FT} f`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);

  const [{ relkind }] = (await knex.raw(
    `SELECT relkind FROM pg_class WHERE oid = '${TBL}'::regclass`)).rows;
  if (relkind === 'v') {
    console.log('[A.22] route_collections ya es vista. Nada que hacer.');
    return;
  }

  // ── Guarda 1: el servidor FDW y su mapping existen. Sin esto la tabla foránea se crea
  // igual y falla recién al leerla — o sea en la pantalla, no acá.
  const [{ n: srv }] = (await knex.raw(
    `SELECT count(*)::int n FROM pg_foreign_server WHERE srvname = ?`, [SRV])).rows;
  if (!srv) throw new Error(`[A.22] no existe el servidor FDW ${SRV}. ABORTA.`);

  await knex.raw(`IMPORT FOREIGN SCHEMA mart LIMIT TO (cobros_ruta)
                    FROM SERVER ${SRV} INTO analytics`).catch(async (e) => {
    // `IMPORT FOREIGN SCHEMA` trae el nombre original; si ya estaba, seguimos.
    if (!/already exists/i.test(e.message)) throw e;
  });
  // El nombre importado es `analytics.cobros_ruta`; se renombra para que se lea como lo que es.
  await knex.raw(`ALTER FOREIGN TABLE IF EXISTS analytics.cobros_ruta RENAME TO ft_cobros_ruta`)
    .catch(() => { /* ya renombrada en una corrida anterior */ });

  // ── Guarda 2: la tabla foránea RESPONDE y trae al menos lo que la tabla local ya tenía.
  // Un origen que contesta menos filas que la copia es una pérdida, no una migración.
  const [{ n: remotas }] = (await knex.raw(`SELECT count(*)::int n FROM ${FT}`)).rows;
  const [{ n: locales }] = (await knex.raw(`SELECT count(*)::int n FROM ${TBL}`)).rows;
  if (remotas < locales) {
    throw new Error(`[A.22] el runner tiene ${remotas} filas y la copia local ${locales}.`
      + ' Cambiar a la vista PERDERÍA filas. ABORTA.');
  }

  // ⛔ Postgres exige soltar el dependiente para soltar la tabla. Se recrea TEXTUAL.
  await knex.raw(`DROP VIEW IF EXISTS ${PEND}`);
  await knex.raw(`DROP TABLE ${TBL}`);
  await knex.raw(`CREATE VIEW ${TBL} AS ${DEF_ROUTE}`);
  await knex.raw(`CREATE VIEW ${PEND} AS ${DEF_PENDIENTES}`);

  // Los GRANT no sobreviven a un DROP: sin esto las compuertas que leen prod quedan ciegas.
  await knex.raw(`GRANT SELECT ON ${TBL} TO dev_ro`);
  await knex.raw(`GRANT SELECT ON ${PEND} TO dev_ro`);

  // ⛔ El carril deja de existir, así que su latido también. Si se dejara, `analytics.cron_runs`
  // tendría para siempre un `route_collections` con fecha de hoy congelada — un carril fantasma
  // que cualquier tablero de salud de feeds pintaría como rancio sin que nadie pueda arreglarlo.
  // Verificado el 2026-10-19: ningún componente lee ese `job_key`, así que borrarlo no apaga
  // ninguna pantalla. Un carril retirado se retira; no se deja en verde ni en rojo.
  const { rowCount: latidos } = await knex.raw(
    `DELETE FROM analytics.cron_runs WHERE job_key = 'route_collections'`);

  const [{ n: final }] = (await knex.raw(`SELECT count(*)::int n FROM ${TBL}`)).rows;
  console.log(`[A.22] route_collections ahora es VISTA sobre el runner · ${locales} -> ${final} filas`
    + ` · ${latidos} latido(s) de cron retirado(s)`);
};

/**
 * Vuelve a la TABLA y la repuebla desde el runner, para no dejar prod sin el dato.
 * ⚠️ No restaura el cron: eso vive en `ops/vl/crontab.feeds` y se revierte ahí.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);
  await knex.raw(`DROP VIEW IF EXISTS ${PEND}`);
  await knex.raw(`DROP VIEW IF EXISTS ${TBL}`);
  await knex.raw(`CREATE TABLE ${TBL} (
      tenant_id uuid NOT NULL, truck text, almacen text, cobro_folio text, fecha date,
      cuenta text, doc_tipo text, folio_corte text, importe numeric, referencia text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
  await knex.raw(`CREATE UNIQUE INDEX route_collections_pkey ON ${TBL} (tenant_id, truck, cobro_folio, folio_corte)`);
  await knex.raw(`CREATE INDEX ix_route_collections_fecha ON ${TBL} (tenant_id, fecha)`);
  await knex.raw(`CREATE INDEX ix_route_collections_corte ON ${TBL} (tenant_id, folio_corte)`);
  await knex.raw(`INSERT INTO ${TBL} (tenant_id, truck, almacen, cobro_folio, fecha, cuenta,
                     doc_tipo, folio_corte, importe, referencia, created_at, updated_at)
                  SELECT '${TENANT}'::uuid, truck, almacen, cobro_folio, fecha, cuenta,
                         doc_tipo, folio_corte, importe, referencia, _merged_at, _merged_at
                    FROM ${FT}`).catch(() => { /* sin runner, la tabla queda vacía y se declara */ });
  await knex.raw(`CREATE VIEW ${PEND} AS ${DEF_PENDIENTES}`);
  await knex.raw(`GRANT SELECT ON ${TBL} TO dev_ro`);
  await knex.raw(`GRANT SELECT ON ${PEND} TO dev_ro`);
};
