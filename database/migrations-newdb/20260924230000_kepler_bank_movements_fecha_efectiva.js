/**
 * [CB.49] `fecha_efectiva`: UNA sola fecha para conciliar, en la vista que todos leen.
 *
 * CB.48 metió la fecha real del complemento de pago SAT… **sólo en `runMatchTreasury`**, y eso
 * dejó el módulo desincronizado: el conciliador casaba el cobro y la pestaña **Cuadre**, que arma
 * su propio pareo con su propio pool filtrado por `fecha_valor`, seguía mostrándolo como si no
 * existiera. El caso que lo destapó (doc `UA0701-0000214`, $6,784.00) figuraba **casado en la
 * base y «En ContPAQi» en pantalla**, a la vez.
 *
 * La causa no es ese pool: son **once** consultas de `finance-bank.service.ts` que acotan
 * `analytics.kepler_bank_movements` por `fecha_valor`. Arreglarlas de a una es garantizar que la
 * doceava vuelva a desincronizarse. El resolvedor sube a la vista, que es donde ya viven los
 * demás (ADR-056: un primitivo no cierra hasta vivir en el lugar compartido).
 *
 *   fecha_efectiva = COALESCE(fecha del complemento SAT, fecha valor de la póliza)
 *
 * Medido en prod real (`md`, cluster 7688376744939610156) el 2026-09-24: **153 cobros** tienen la
 * póliza en un mes distinto al del pago real, y **124 de ellos ($1,769,114) SÍ tienen su depósito
 * en el banco el día del pago** — el Cuadre los mostraba como inexistentes.
 *
 * ⚠️ **`fecha_valor` NO cambia de significado, y es a propósito.** Sigue siendo la fecha de la
 * PÓLIZA, porque así está asentado en contabilidad: quien cuadre contra los libros (balanza,
 * ContPAQi) la necesita tal cual. Y la vista la consumen también Caja General, `mv_caja_movimientos`
 * y `db-health`, que no tienen por qué moverse. Se AGREGAN dos columnas al final —
 * `CREATE OR REPLACE` sólo lo permite al final— y cada consumidor elige con cuál trabaja:
 *
 *   · concilia contra el BANCO  → `fecha_efectiva`  (el dinero se movió ese día)
 *   · cuadra contra los LIBROS  → `fecha_valor`     (la contabilidad lo asentó ese día)
 *
 * El candado `test-newdb-bank-fecha-efectiva.js` verifica que las pestañas vean el MISMO universo.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

// Igual que la definición vigente (mig 20260922130000) + el LEFT JOIN al complemento y las dos
// columnas nuevas AL FINAL. Se copia entera y no se parchea la existente: una vista se reemplaza
// completa, y dejar la fuente a la vista evita el "¿cuál era la versión buena?" de la próxima vez.
const VIEW_SQL = `
  WITH kb AS (
    SELECT DISTINCT ON (btrim(c1)) btrim(c1) clave, btrim(c2) nombre, btrim(c5) cta,
           CASE WHEN btrim(c5) NOT LIKE '102%' THEN 'puente'
                WHEN upper(btrim(coalesce(c3, ''))) = 'EFECTIVO' THEN 'caja'
                ELSE 'banco' END tipo
      FROM kepler_ods.kdb1 WHERE btrim(coalesce(c1,''))<>''
     ORDER BY btrim(c1), sucursal
  ),
  xw AS (
    SELECT kb.clave,
      COALESCE(
        (SELECT ba.account_label FROM finance.bank_accounts ba WHERE ba.tenant_id='${M}'::uuid AND ba.account_label=kb.clave LIMIT 1),
        CASE WHEN kb.clave='0011' THEN 'CG' END,
        (SELECT ba.account_label FROM finance.bank_accounts ba WHERE ba.tenant_id='${M}'::uuid AND length(ba.account_label)>=3
           AND kb.clave LIKE '%'||ba.account_label AND kb.clave<>ba.account_label ORDER BY length(ba.account_label) DESC LIMIT 1)
      ) AS account_label
    FROM kb
  ),
  flj AS (
    SELECT btrim(d.c1::text) suc,
           btrim(d.c2::text)||'-'||btrim(d.c3::text)||'-'||btrim(d.c4::text) dt,
           btrim(d.c6::text) folio, d.c9::date fval, d.c68::date fcap,
           round(coalesce(NULLIF(regexp_replace(d.c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) importe,
           NULLIF(btrim(d.c24::text),'') concepto, NULLIF(btrim(d.c31::text),'') metodo,
           NULLIF(btrim(d.c32::text),'') beneficiario, btrim(d.c45::text) c45, NULLIF(btrim(d.c47::text),'') c47,
           NULLIF(btrim(d.c10::text),'') entidad,
           CASE btrim(d.c2::text)||'-'||btrim(d.c3::text)||'-'||btrim(d.c4::text)
             WHEN 'U-A-5' THEN 'entrada' WHEN 'U-A-25' THEN 'entrada' WHEN 'X-A-45' THEN 'entrada'
             WHEN 'X-D-26' THEN 'salida' WHEN 'X-D-25' THEN 'salida' WHEN 'X-D-60' THEN 'salida' WHEN 'X-D-10' THEN 'salida'
             WHEN 'N-A-26' THEN 'traspaso'
             ELSE CASE WHEN btrim(d.c31::text)='Cob' THEN 'entrada'
                       WHEN btrim(d.c31::text) IN ('Tra','Che','Ant') THEN 'salida' ELSE 'otro' END
           END flujo
      FROM kepler_ods.kdm1 d
     WHERE btrim(d.c1::text)=d.sucursal::text
       AND btrim(coalesce(d.c43::text,'')) <> 'C'
       AND btrim(d.c45::text) IN (SELECT clave FROM kb)
  ),
  legs AS (
    SELECT suc, dt, folio, fval, fcap, importe, concepto, metodo, beneficiario, entidad, c45 AS clave,
           CASE WHEN flujo='traspaso' THEN 'traspaso' ELSE flujo END AS flujo,
           CASE WHEN flujo='traspaso' THEN -1 WHEN flujo='entrada' THEN 1 WHEN flujo='salida' THEN -1 ELSE NULL END AS signo,
           (flujo='traspaso') AS es_traspaso,
           CASE WHEN flujo='traspaso' THEN c47 ELSE NULL END AS contra,
           CASE WHEN flujo='traspaso' THEN 'origen' ELSE 'mov' END AS pierna
      FROM flj
    UNION ALL
    SELECT suc, dt, folio, fval, fcap, importe, concepto, metodo, beneficiario, entidad, c47 AS clave,
           'traspaso' AS flujo, 1 AS signo, true AS es_traspaso, c45 AS contra, 'destino' AS pierna
      FROM flj WHERE flujo='traspaso' AND c47 IS NOT NULL AND c47 IN (SELECT clave FROM kb)
  )
  SELECT '${M}'::uuid AS tenant_id,
    legs.suc AS sucursal, legs.dt AS doc_tipo, legs.folio, legs.clave AS clave_banco,
    kb.cta AS cuenta_contable, kb.nombre AS banco_nombre, kb.tipo AS tipo_cuenta,
    legs.flujo, legs.importe, legs.signo::smallint AS signo,
    legs.fval AS fecha_valor, legs.fcap AS fecha_captura,
    legs.concepto, legs.metodo, legs.beneficiario,
    legs.es_traspaso, legs.contra AS contra_clave, legs.pierna,
    xw.account_label,
    now() AS computed_at,
    legs.entidad AS entidad_code,
    -- ── CB.49, columnas nuevas (al final: CREATE OR REPLACE no admite otra posición) ──
    -- La fecha que el propio Kepler timbró al SAT como día del pago. NULL = este documento no
    -- tiene complemento, que es el caso del 98% de la cobranza (el CEDIS factura PUE y el SAT
    -- sólo exige complemento en pago diferido). NULL aquí significa "no aplica", no "se perdió".
    pc.fecha_pago AS fecha_pago_sat,
    -- El día en que el dinero se movió de verdad. Es la que hay que usar para cruzar contra un
    -- estado de cuenta; fecha_valor (sin acentos graves acá: este SQL vive dentro de un template
    -- literal y un backtick lo cierra, ver GOTCHAS) sirve para cruzar contra los libros.
    COALESCE(pc.fecha_pago, legs.fval) AS fecha_efectiva
  FROM legs
  LEFT JOIN kb ON kb.clave = legs.clave
  LEFT JOIN xw ON xw.clave = legs.clave
  -- El complemento es único por (sucursal, doc_tipo, folio) — verificado, 3,370 filas y 3,370
  -- llaves — así que este join NO multiplica, ni siquiera en las dos piernas de un traspaso.
  LEFT JOIN analytics.v_kepler_payment_complement pc
    ON pc.sucursal = legs.suc AND pc.doc_tipo = legs.dt AND pc.folio = legs.folio`;

exports.up = async function up(knex) {
  const hay = await knex.raw(`SELECT to_regclass('analytics.v_kepler_payment_complement') r`);
  if (!hay.rows[0].r) {
    // Sin el complemento no hay nada que resolver. No se falla: la migración que lo crea
    // (20260924190000) corre antes en un `latest` limpio, y en un entorno sin ODS no hay ninguna.
    console.log('[CB.49] falta analytics.v_kepler_payment_complement — se omite.');
    return;
  }
  await knex.raw(`CREATE OR REPLACE VIEW analytics.kepler_bank_movements AS ${VIEW_SQL}`);
  // Ni el GRANT ni `security_invoker` sobreviven al replace (ADR-057). Se re-aplican SIEMPRE.
  await knex.raw(`ALTER VIEW analytics.kepler_bank_movements SET (security_invoker = true)`).catch(() => {});
  await knex.raw(`GRANT SELECT ON analytics.kepler_bank_movements TO app_runtime`);
  await knex.raw(`COMMENT ON COLUMN analytics.kepler_bank_movements.fecha_efectiva IS
    'CB.49 — el día en que el dinero se movió: fecha del complemento de pago SAT si existe, si no la de la póliza. USARLA para cruzar contra un estado de cuenta. Para cuadrar contra los LIBROS (balanza, ContPAQi) va fecha_valor, que es la de la póliza y no cambió.'`);
};

exports.down = async function down(knex) {
  // Quitar columnas exige DROP + CREATE; se deja la vista como estaba en 20260922130000.
  // No se hace acá para no duplicar por tercera vez las 60 líneas de esa definición: revertir
  // es re-correr aquella migración, que sí la tiene entera.
  console.log('[CB.49] down: re-aplicá 20260922130000_kepler_bank_movements_caja_y_entidad.js');
};
