/**
 * [AX-PERF.1] El anexo del CFDI deja de recalcular el resolvedor de factor de caja UNA VEZ POR
 * RENGLÓN.
 *
 * ── El síntoma que lo disparó ───────────────────────────────────────────────────────────────
 * "`/comercial/documentos` tarda demasiado en cargar los documentos PDF".
 *
 * ── La causa, leída del plan de prod (2026-09-24) ───────────────────────────────────────────
 * `analytics.erp_sales_invoice_lines` trae `box_factor` con
 * `LEFT JOIN analytics.v_product_box_factor bf ON bf.product_id = p.id`. Ese resolvedor es
 * **catálogo completo por construcción**: agrega `kepler_ods.kdii` entera (76,903 filas) y
 * `v_product_label_prices` (78,799), así que un `product_id` **no se puede empujar adentro** —
 * y a través de un LEFT JOIN, menos. El planeador lo pone del lado interno de un nested loop y
 * lo **reejecuta entero por cada renglón**:
 *
 *     factura 03UD1201-0000349, 28 renglones
 *       Materialize -> GroupAggregate  (actual ... loops=28)   Buffers: shared hit=1,184,017
 *       total de la consulta ................................ 1,620,122 paginas (~13 GB)
 *       Execution Time ..................................... 10,422 ms  para 28 filas
 *
 * O sea: el costo escala con los RENGLONES DEL DOCUMENTO, no con el catálogo. Comprobado en las
 * dos direcciones — la factura más grande de prod tiene **160 renglones** (x ~370 ms del
 * resolvedor = **59.2 s estimados**) y `pg_stat_statements` de prod tiene medido un **máximo
 * real de 65,716 ms** para esta misma consulta. Sobre **108 llamadas reales**: promedio
 * **13,776 ms** y **1,488 s (24.8 min) de CPU de prod** acumulados en una sola consulta.
 *
 * ⭐ Esto **no es un hallazgo nuevo: es la deuda que TK.6 dejó declarada con nombre** el
 * 2026-09-21 (`20260921160000_sales_invoice_lines_join_folio.js`), cuando arregló el join del
 * folio y anotó que un documento NO mejoraba porque "lo que queda es
 * `analytics.v_product_box_factor`". Aquella medición vio 2.9 s porque sus documentos de prueba
 * eran chicos; con 28 renglones son 10 s y con 160, un minuto.
 *
 * ── El premio, medido ANTES de construir nada ───────────────────────────────────────────────
 * Se corrió el cuerpo **real** de la vista (sacado de `pg_get_viewdef`, no una consulta
 * parecida) con el resolvedor reemplazado por una tabla TEMP —que es exactamente lo que un
 * matview le da al planeador— dentro de una transacción con ROLLBACK:
 *
 *     tal cual hoy .................. 10,422 ms   (1,620,122 paginas)
 *     con el resolvedor materializado     5.7 ms  ·  2a pasada 5.9 ms      ~1,830x
 *
 * Construirlo cuesta **370 ms** y son **11,267 filas**: eso es lo que paga el carril por ciclo.
 *
 * `GOTCHAS §19` lo permite explícitamente: "materializar por costo sí es legítimo; el pecado es
 * materializar un valor INVENTADO". Acá el cuerpo es literalmente `SELECT * FROM <la vista>`:
 * **no puede divergir de su definición**.
 *
 * ── ⛔ POR QUÉ NO SE TOCA EL CUERPO DE `v_product_box_factor` ───────────────────────────────
 * La tentación es `CREATE OR REPLACE VIEW v_product_box_factor AS SELECT * FROM mv_...`, que
 * daría la mejora a todos sin tocar una línea. Se descarta con medición: **7 objetos dependen
 * de ella** — `mv_kepler_sales_daily`, `v_erp_stock_on_hand`, `v_product_box_factor_consensus`,
 * `v_sales_demand_truth`, `v_warehouse_box_factor` y **`v_unit_truth`**, el resolvedor canónico
 * de unidades de ADR-057. Cambiarle el cuerpo le movería la frescura a la verdad de unidades de
 * toda la plataforma, en silencio y sin que nadie lo pidiera. La vista queda **intacta**; el
 * materializado es un objeto NUEVO y lo lee **sólo** `erp_sales_invoice_lines`.
 *
 * ── ⛔ SIN COLUMNAS DE RELOJ ────────────────────────────────────────────────────────────────
 * Verificado en prod antes de escribir esto: las 8 columnas son
 * `tenant_id, product_id, is_master_suspect, box_factor, source, unit_base, is_weight,
 * factor_unit` — ninguna es un reloj. Importa porque `REFRESH ... CONCURRENTLY` compara la FILA
 * COMPLETA con `(y.*) IS DISTINCT FROM (x.*)`: una sola columna que cambie por construcción hace
 * que el 100 % parezca distinto y termine aplicando la tabla entera — le costó a
 * `analytics.mv_caja_movimientos` **12.3 GB de WAL por día** hasta este mismo 2026-09-24.
 * La edad del dato vive en `analytics.cron_run_log`, llave `mv_existencia_aux_refresh`.
 *
 * ── ⚠️ QUÉ CAMBIA DE FRESCURA, dicho y no escondido ────────────────────────────────────────
 * El `box_factor` que imprime la **equivalencia en cajas** del anexo pasa de vivo a una foto de
 * **hasta 5 minutos** (el carril `existencia-aux` de `ops/vl/crontab.feeds:52`). Es dato
 * MAESTRO —catálogo, no transacción—, y su hermana `v_warehouse_box_factor` ya tomó esa misma
 * decisión hoy en `[EX-PERF.2]`. Si alguien corrige un override para arreglar una equivalencia
 * mal impresa, la corrección tarda un ciclo en verse.
 *
 * ── Cómo se reapunta la vista, y por qué así ────────────────────────────────────────────────
 * **No se copia el cuerpo acá.** `erp_sales_invoice_lines` ya fue redefinida por SIETE
 * migraciones; copiarlo una octava vez es exactamente como estas cosas derivan. Se lee la
 * definición VIVA del catálogo, se sustituye **un solo token** y se verifica que el contrato de
 * columnas no se movió. El candado contra el olvido está en el test: si una migración futura
 * vuelve a escribir la vista con la fuente viva, `test-newdb-anexo-box-factor-matview.js` se
 * pone ROJO en vez de dejar volver la regresión en silencio.
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_product_box_factor';
const VISTA = 'analytics.v_product_box_factor';
const LINEAS = 'analytics.erp_sales_invoice_lines';
const UX = 'ux_mv_product_box_factor';

// ⚠️ El límite de palabra final NO es decorativo: sin él este patrón también matchearía
// `analytics.v_product_box_factor_consensus`, que es OTRA vista. Como el guion bajo es carácter
// de palabra, no hay frontera entre `factor` y `_consensus` — y por eso la excluye.
const RE_VISTA = /\banalytics\.v_product_box_factor\b/g;
const RE_MV = /\banalytics\.mv_product_box_factor\b/g;

async function columnas(knex, rel) {
  const r = await knex.raw(
    `SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) AS c
       FROM information_schema.columns
      WHERE (table_schema || '.' || table_name) = ?`, [rel]);
  return r.rows[0] ? r.rows[0].c : null;
}

/** Reapunta `erp_sales_invoice_lines` de `origen` a `destino`, SIN copiar su cuerpo. */
async function reapuntar(knex, origen, destino, reOrigen, reDestino) {
  const def = (await knex.raw(`SELECT pg_get_viewdef(?::regclass, true) AS d`, [LINEAS])).rows[0].d || '';
  if ((def.match(reDestino) || []).length > 0) return 'ya-estaba'; // idempotente
  const n = (def.match(reOrigen) || []).length;
  if (n !== 1) {
    throw new Error(
      `${LINEAS} referencia ${origen} ${n} veces (se esperaba 1). No se reapunta a ciegas: `
      + 'revisá la definición viva antes de correr esta migración.');
  }
  const antes = await columnas(knex, LINEAS);
  await knex.raw(`CREATE OR REPLACE VIEW ${LINEAS} AS ${def.replace(reOrigen, destino).replace(/;\s*$/, '')}`);
  await knex.raw(`GRANT SELECT ON ${LINEAS} TO app_runtime`);
  const despues = await columnas(knex, LINEAS);
  if (antes !== despues) {
    throw new Error(`${LINEAS} cambió su contrato de columnas al reapuntar. Abortado.`);
  }
  return 'reapuntada';
}

exports.up = async function (knex) {
  const reg = await knex.raw(`SELECT to_regclass(?) AS t`, [VISTA]);
  if (!reg.rows[0] || !reg.rows[0].t) return; // entorno sin esa vista: nada que derivar

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV} CASCADE`);
  // El cuerpo es la vista, tal cual. Cero copia de lógica = cero divergencia posible.
  await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS SELECT * FROM ${VISTA}`);
  // ⚠️ El UNIQUE no es decorativo: sin él `REFRESH ... CONCURRENTLY` no está permitido, y sin
  // CONCURRENTLY el refresh toma un lock exclusivo que deja la pantalla EN BLANCO mientras corre.
  // Medido en prod antes de elegir la llave: 11,267 filas, 0 duplicadas por (tenant, producto).
  await knex.raw(`CREATE UNIQUE INDEX ${UX} ON ${MV} (tenant_id, product_id)`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);

  // Candado: un materializado corto no da error, da renglones "sin factor" que la pantalla
  // imprime como si no hubiera equivalencia en cajas. Si no cuadra con su vista, falla acá.
  const chk = await knex.raw(
    `SELECT (SELECT count(*) FROM ${MV}) AS m, (SELECT count(*) FROM ${VISTA}) AS v`);
  const { m, v } = chk.rows[0];
  if (Number(v) > 0 && Number(m) !== Number(v)) {
    throw new Error(`${MV} quedó con ${m} filas y ${VISTA} tiene ${v}. No se materializa a medias.`);
  }

  if ((await knex.raw(`SELECT to_regclass(?) AS t`, [LINEAS])).rows[0].t) {
    await reapuntar(knex, VISTA, MV, RE_VISTA, RE_MV);
  }

  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
    'AX-PERF.1 - copia materializada de analytics.v_product_box_factor, POR COSTO (GOTCHAS 19). '
    'Medido 2026-09-24 en prod: erp_sales_invoice_lines reejecutaba ese resolvedor UNA VEZ POR '
    'RENGLON (loops=28 sobre una factura de 28 lineas, 1,620,122 paginas, 10,422 ms). '
    'pg_stat_statements: 108 llamadas reales, promedio 13,776 ms, maximo 65,716 ms. Con esta '
    'copia la misma consulta da 5.7 ms. La VISTA no se toca: tiene 7 dependientes, entre ellos '
    'v_unit_truth (resolvedor canonico de unidades, ADR-057). Solo la lee erp_sales_invoice_lines. '
    'Sin columnas de reloj a proposito; la edad sale de analytics.cron_run_log, llave '
    'mv_existencia_aux_refresh (carril existencia-aux, cada 5 min).'`);
};

exports.down = async function (knex) {
  // Primero se devuelve la vista a la fuente VIVA y recién después se borra el materializado:
  // al revés, el CASCADE del DROP se llevaría `erp_sales_invoice_lines` por delante.
  const hayLineas = (await knex.raw(`SELECT to_regclass(?) AS t`, [LINEAS])).rows[0].t;
  const hayMv = (await knex.raw(`SELECT to_regclass(?) AS t`, [MV])).rows[0].t;
  if (hayLineas && hayMv) await reapuntar(knex, MV, VISTA, RE_MV, RE_VISTA);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV} CASCADE`);
};
