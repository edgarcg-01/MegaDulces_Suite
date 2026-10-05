/**
 * [IG.15] EL TESTIGO FISCAL DEL INGRESO, FACTURA POR FACTURA.
 *
 * Hasta hoy el ingreso solo se podia contrastar contra el TOTAL MENSUAL de la balanza fiscal.
 * Con los 258,920 CFDI emitidos cargados ([IG.14.1]) el cruce baja al documento, y esta vista es
 * el resolvedor unico: una fila por CFDI emitido, con su documento de Kepler y su VEREDICTO.
 *
 * -- LA LLAVE: LA SERIE DEL CFDI TRAE EL DOCUMENTO DE KEPLER ADENTRO ------------------------
 * Las series con forma `NNUGttss` -01UD0801, 02UD0501, 06UD0801- decodifican a
 * (sucursal, grupo, tipo, subtipo) de kdm1, y el folio del CFDI es el folio del documento.
 * Medido en septiembre-2026: 2,812 de 2,812 encuentran su documento. 100%.
 *
 * -- ⛔ Y LO QUE UNA MUESTRA DE UN MES ESCONDE ----------------------------------------------
 * Ese 100% es sobre el subconjunto que YA decodifica. Sobre 2026 completo, 16,492 CFDI por
 * $302,514,642.64 -el 74% del dinero- traen series de UNA o DOS LETRAS (B, BT, FD, F, AT, A, H,
 * J, C, I) que no decodifican a nada de Kepler.
 *
 * ⭐ No es un defecto, y lo confirma una fuente independiente: esas series son las plazas que
 * TODAVIA VENDIAN EN WINCAJA, y cada una muere exactamente en su fecha de corte, que
 * `analytics.v_branch_erp_cutover` tiene registrada:
 *
 *     serie A / AT   ultima factura 2026-06   sucursal 01   corte 2026-06-27
 *     serie F / FD   ultima factura 2026-08   sucursal 06   corte 2026-08-15
 *     serie B/BT/H   sigue viva   sucursales 07 y 08   corte 2026-09-08 y 09-19
 *
 * O sea que Kepler no tiene esa factura porque la plaza no vendia en Kepler. El veredicto es
 * `fuera_de_kepler`, se DECLARA con su monto, y NO cuenta como falla. Y hay un corolario
 * comprobable: a medida que la migracion termina -el CEDIS corto el 2026-09-30- la cobertura
 * converge sola.
 *
 * -- LOS CINCO VEREDICTOS, Y POR QUE NO SON TRES -------------------------------------------
 *     cuadra            documento encontrado y el importe coincide al centavo
 *     difiere_importe   encontrado, el importe NO coincide    (2026: 1,304 / $83.4M)
 *     ambiguo           MAS DE UN documento con la misma llave (2026: 505 / $16.0M)
 *     sin_documento     la serie decodifica y Kepler no lo tiene (2026: 6 / $11.7k)
 *     fuera_de_kepler   la plaza vendia en Wincaja en esa fecha  (2026: 18,835 / $305.8M)
 *
 * Juntar `fuera_de_kepler` con `sin_documento` seria el error de siempre: una ausencia de la
 * fuente y una ausencia de alcance se leen igual y se arreglan distinto.
 *
 * ⚠️ `ambiguo` no se resuelve eligiendo uno. El LATERAL cuenta y no abanica: una fila de la
 * vista = un CFDI, siempre. Si se dejara el JOIN plano, 505 CFDIs traerian mas de una fila y
 * cualquier suma saldria inflada -- es la trampa del folio no unico, que este repo ya pago
 * cuatro veces (XA2001, kdm5, UD13, y el cruce bancario).
 *
 * -- ⚠️⚠️ ESTADO REAL EN PROD, LEER ANTES DE TOCAR ------------------------------------------
 * Prod tiene esta migracion REGISTRADA (batch 715, 2026-10-05) pero con el cuerpo de UN SOLO
 * lateral, que es el que se aplico primero. La version de DOS laterales que esta aca abajo -la
 * que separa el grupo D del A para que cada indice parcial sea alcanzable- NO entro: su
 * CREATE OR REPLACE quedo encolado pidiendo ACCESS EXCLUSIVE detras de un SELECT largo sobre la
 * misma vista, y se termino a mano.
 *
 * Como es CREATE OR REPLACE, es idempotente: para que entre basta correr su up() de nuevo. Lo que
 * NO se hizo, y es el requisito: medir que la vista entre bajo la compuerta de 1 s. Con un lateral
 * UN MES tardaba 113,778 ms, asi que la vista EXISTE, es correcta y NO esta publicada en ninguna
 * pantalla a proposito -- cablearla sin medirla seria repetir lo que [IG.12] acabo de pagar.
 *
 * ⛔ Y la leccion de operacion, que costo 45 minutos de candado: matar el `ssh` NO mata el proceso
 * que corre dentro del pod. Dos `node -e` quedaron vivos con su transaccion, el CREATE OR REPLACE
 * hizo cola pidiendo exclusivo, y en Postgres la cola es FIFO: todo LECTOR nuevo de esa vista se
 * formo detras del escritor. Se limpio terminando las sesiones desde dentro del pod, con guarda
 * por nombre de objeto para no tocar nada ajeno. Un `kill` en el pod no alcanza: el exec corre con
 * otro UID.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = `
CREATE OR REPLACE VIEW analytics.v_cfdi_emitido_match AS
WITH c AS (
  SELECT f.tenant_id, f.uuid, f.serie, f.folio, f.fecha, f.tipo_comprobante,
         f.total, f.subtotal, f.receptor_rfc, f.receptor_nombre, f.estatus_sat,
         CASE WHEN f.serie ~ '^[0-9]{2}U[A-Z][0-9]{4}$' THEN substring(f.serie, 1, 2) END AS k_sucursal,
         CASE WHEN f.serie ~ '^[0-9]{2}U[A-Z][0-9]{4}$' THEN substring(f.serie, 4, 1) END AS k_grupo,
         CASE WHEN f.serie ~ '^[0-9]{2}U[A-Z][0-9]{4}$' THEN substring(f.serie, 5, 2)::int END AS k_tipo,
         CASE WHEN f.serie ~ '^[0-9]{2}U[A-Z][0-9]{4}$' THEN substring(f.serie, 7, 2)::int END AS k_sub
    FROM fiscal.cfdis f
   WHERE f.rol = 'emitidas' AND f.tipo_comprobante IN ('I', 'E')
)
SELECT c.tenant_id, c.uuid, c.serie, c.folio, c.fecha, c.tipo_comprobante,
       c.total, c.subtotal, c.receptor_rfc, c.receptor_nombre, c.estatus_sat,
       c.k_sucursal, c.k_grupo, c.k_tipo, c.k_sub,
       CASE WHEN c.k_sucursal IS NULL THEN NULL
            ELSE 'U' || c.k_grupo || lpad(c.k_tipo::text, 2, '0') || lpad(c.k_sub::text, 2, '0')
       END                                                        AS k_doctype,
       CASE WHEN c.k_grupo = 'A' THEN da.docs ELSE dd.docs END    AS docs_kepler,
       CASE WHEN c.k_grupo = 'A' THEN da.doc_total ELSE dd.doc_total END AS doc_total,
       CASE WHEN c.k_grupo = 'A' THEN da.cliente_code ELSE dd.cliente_code END AS doc_cliente_code,
       CASE WHEN (CASE WHEN c.k_grupo = 'A' THEN da.docs ELSE dd.docs END) = 1
            THEN round(c.total - (CASE WHEN c.k_grupo = 'A' THEN da.doc_total ELSE dd.doc_total END), 2)
       END                                                        AS delta,
       CASE
         WHEN c.k_sucursal IS NULL                        THEN 'fuera_de_kepler'
         WHEN coalesce(CASE WHEN c.k_grupo = 'A' THEN da.docs ELSE dd.docs END, 0) = 0 THEN 'sin_documento'
         WHEN (CASE WHEN c.k_grupo = 'A' THEN da.docs ELSE dd.docs END) > 1 THEN 'ambiguo'
         WHEN abs(c.total - (CASE WHEN c.k_grupo = 'A' THEN da.doc_total ELSE dd.doc_total END)) < 0.02 THEN 'cuadra'
         ELSE 'difiere_importe'
       END                                                        AS veredicto
  FROM c
  -- (IG.15) DOS LATERALES, UNO POR GRUPO, CADA UNO CON SU LITERAL. No es estilo: kdm1 tiene
  -- indices PARCIALES -ix_kdm1_venta_doc con WHERE c2='U' AND c3='D', ix_kdm1_abono_doc con
  -- c3='A'- y el planner solo usa un indice parcial si puede PROBAR su condicion. Con
  -- k.c3 = c.k_grupo (una variable del lado de afuera) no la puede probar, asi que los
  -- ignoraba los dos: UN SOLO MES tardaba 113,778 ms. Con el literal adentro, cada rama
  -- alcanza el suyo. El reparto medido en 2026: grupo D son 13,259 documentos y $134.2M
  -- (94.5% y 99.6%); el A son 774 notas por $601k.
  LEFT JOIN LATERAL (
         SELECT count(*)::int AS docs, max(k.c16::numeric) AS doc_total, max(btrim(k.c10)) AS cliente_code
           FROM kepler_ods.kdm1 k
          WHERE c.k_grupo = 'D' AND k.c2 = 'U' AND k.c3 = 'D'
            AND btrim(k.sucursal) = c.k_sucursal
            AND k.c4::int = c.k_tipo AND k.c5::int = c.k_sub AND btrim(k.c6) = c.folio
       ) dd ON true
  LEFT JOIN LATERAL (
         SELECT count(*)::int AS docs, max(k.c16::numeric) AS doc_total, max(btrim(k.c10)) AS cliente_code
           FROM kepler_ods.kdm1 k
          WHERE c.k_grupo = 'A' AND k.c2 = 'U' AND k.c3 = 'A'
            AND btrim(k.sucursal) = c.k_sucursal
            AND k.c4::int = c.k_tipo AND k.c5::int = c.k_sub AND btrim(k.c6) = c.folio
       ) da ON true`;

exports.up = async function up(knex) {
  await knex.raw(VISTA);
  // ⛔ ADR-057: CREATE OR REPLACE VIEW no hereda security_invoker ni los GRANT. Ya costo una vez.
  await knex.raw('ALTER VIEW analytics.v_cfdi_emitido_match SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_cfdi_emitido_match TO app_runtime');
  await knex.raw('GRANT SELECT ON analytics.v_cfdi_emitido_match TO dev_ro');

  // Se comprueba, no se supone: una vista que existe y no devuelve nada se ve igual de sana.
  const { rows: [v] } = await knex.raw(`
    SELECT count(*)::int AS filas,
           count(DISTINCT uuid)::int AS cfdis,
           count(*) FILTER (WHERE veredicto = 'cuadra')::int AS cuadran
      FROM analytics.v_cfdi_emitido_match
     WHERE fecha >= date_trunc('year', now())`);
  if (!v || v.filas === 0) {
    throw new Error('v_cfdi_emitido_match no devuelve filas del ejercicio: revisar que fiscal.cfdis tenga rol=emitidas');
  }
  if (v.filas !== v.cfdis) {
    throw new Error(
      `la vista ABANICA: ${v.filas} filas para ${v.cfdis} CFDIs. Una fila = un CFDI o cualquier `
      + 'suma que se publique sale inflada.');
  }
  const { rows: [m] } = await knex.raw(`
    SELECT has_table_privilege('app_runtime','analytics.v_cfdi_emitido_match','SELECT') AS app,
           (SELECT reloptions::text FROM pg_class WHERE oid = 'analytics.v_cfdi_emitido_match'::regclass) AS opts`);
  if (!m.app) throw new Error('la vista quedo sin GRANT para app_runtime');
  if (!m.opts || !m.opts.includes('security_invoker=true')) {
    throw new Error('la vista quedo sin security_invoker: ADR-057 otra vez');
  }
  console.log(`  ✓ v_cfdi_emitido_match · ${v.cfdis} CFDIs del ejercicio · ${v.cuadran} cuadran · una fila por CFDI`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_cfdi_emitido_match');
};
