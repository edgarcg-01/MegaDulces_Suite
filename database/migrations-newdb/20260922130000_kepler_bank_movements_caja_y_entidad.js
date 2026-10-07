/**
 * CG.21 — `analytics.kepler_bank_movements` gana `entidad_code` y aprende a contar las cajas.
 *
 * ── Qué cambia y por qué ─────────────────────────────────────────────────────────────────────
 *
 * 1. **`tipo_cuenta` clasificaba mal DOS de las cinco cajas.** El CASE original listaba las claves
 *    a mano — `WHEN btrim(c1) IN ('0010','0011','0040') THEN 'caja' ELSE 'banco'` — y `0030 CAJA
 *    CHICA MORELIA ABASTOS` y `0050 CAJA CHICA CANINDO` caían en `'banco'`. No fue un descuido de
 *    quien lo escribió: las tres listadas tienen `c5` con sufijo (`102-0011`, `102-0040`) y las dos
 *    ausentes tienen `102` pelado, así que **no había con qué distinguirlas por la cuenta contable**.
 *
 *    Pero `kdb1` SÍ lo declara, en una columna que nadie estaba mirando: **`c3`**, que en las
 *    cuentas de banco trae la CLABE (`002496700783014636`) y en las de caja trae literalmente la
 *    palabra `EFECTIVO`. Medido sobre las 26 filas del catálogo: 5 dicen `EFECTIVO` y son
 *    exactamente las cinco cajas; ninguna cuenta de banco la dice.
 *
 *    ⛔ Una lista de claves escrita a mano **no avisa cuando llega la sexta caja**. El criterio
 *    derivado sí. Es la misma lección que `feedback_filter_validated_on_one_branch_deletes_another`:
 *    un filtro que enumera casos borra en silencio los que nadie enumeró.
 *
 * 2. **`entidad_code` (`kdm1.c10`)** — el código de la contraparte, que la vista leía para nada y
 *    tiraba. Es la llave del acreedor (`CB013 BOTANAS PAU`, `GG015 GASTOS GENERALES CAJA CHICA
 *    MORELIA`, `GN001 NOMINA`) y del cliente/ruta del cobro (`RD 21`, `2-32-321`). Sin ella, el
 *    egreso de caja no puede resolver su cuenta contable por regla, ni el ingreso su ruta.
 *    Se AGREGA AL FINAL: `CREATE OR REPLACE VIEW` sólo admite columnas nuevas al final.
 *
 * ── Lo que NO cambia ─────────────────────────────────────────────────────────────────────────
 *
 * El crosswalk `account_label` se deja intacto (`'0011' → 'CG'` y el sufijo contra
 * `finance.bank_accounts`). Los cuatro consumidores vivos —`caja-general.service.ts:381,475,550,681`
 * y los smokes de bancos— filtran por `account_label`, nunca por `tipo_cuenta`: verificado por grep
 * antes de tocar el CASE. Reclasificar `0030`/`0050` no mueve ninguna cifra publicada hoy porque
 * **las dos tienen CERO movimientos en 180 días** (medido); el arreglo es para que el día que se
 * usen, aparezcan.
 *
 * ⚠️ Tras `CREATE OR REPLACE VIEW` hay que **re-aplicar el GRANT**: no se hereda (lección ADR-057,
 * que costó una migración entera en la Fase U).
 * ⛔ Ni un `?` en este SQL — knex se lo come como binding. Cuantificadores con `{0,1}`.
 *
 * Aditiva e idempotente. Si no hay ODS, no hay nada que derivar y se sale sin ruido.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

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
    legs.entidad AS entidad_code
  FROM legs
  LEFT JOIN kb ON kb.clave = legs.clave
  LEFT JOIN xw ON xw.clave = legs.clave`;

exports.up = async function (knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t, to_regclass('kepler_ods.kdb1') AS b`);
  if (!ods.rows[0] || !ods.rows[0].t || !ods.rows[0].b) return; // entorno sin ODS: nada que derivar

  // ── El CATÁLOGO de cajas, aparte ────────────────────────────────────────────────────────────
  //
  // Hace falta para que una caja con CERO movimientos se pueda ver. Si el selector se armara con
  // los movimientos, una caja dormida sería indistinguible de una que no existe — y ADR-056 es
  // explícito: un mapa vacío y uno completo no pueden verse igual.
  //
  // Medido a 180 días: 0011 CAJA GENERAL 9,142 docs / $98,531,597.07 · 0010 PADRE HIDALGO 1 doc ·
  // 0030 MORELIA ABASTOS, 0040 8 ESQUINAS y 0050 CANINDO **cero**. Las cinco se publican con su
  // volumen real; ninguna se dibuja como si operara.
  //
  // ⚠️ Repite el criterio `c3='EFECTIVO'` de `kepler_bank_movements`. Que no se separen lo cuida
  // una aserción del smoke (el conjunto de claves de acá == las que allá salen `tipo_cuenta='caja'`),
  // no la estructura: meter esta vista DENTRO de la otra obligaría a reescribirla entera.
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_cajas`);
  await knex.raw(`
    CREATE VIEW analytics.v_kepler_cajas AS
    SELECT DISTINCT ON (btrim(c1))
           '${M}'::uuid   AS tenant_id,
           btrim(c1)      AS clave,
           btrim(c2)      AS nombre,
           btrim(c5)      AS cuenta_contable
      FROM kepler_ods.kdb1
     WHERE btrim(coalesce(c1,'')) <> ''
       AND upper(btrim(coalesce(c3,''))) = 'EFECTIVO'
     ORDER BY btrim(c1), sucursal`);
  await knex.raw(`GRANT SELECT ON analytics.v_kepler_cajas TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_kepler_cajas IS
    'CG.21 — las cajas de efectivo que Kepler declara en kdb1 (c3=EFECTIVO). Existe para que una '
    'caja SIN movimientos se pueda ver: armar el selector con los movimientos volvería invisible '
    'a la caja dormida. Mismo criterio que analytics.kepler_bank_movements.tipo_cuenta.'`);

  const rel = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.kepler_bank_movements')`);
  if (!rel.rows[0] || rel.rows[0].relkind !== 'v') return; // la mig 20260903120000 todavía no la convirtió

  await knex.raw(`CREATE OR REPLACE VIEW analytics.kepler_bank_movements AS ${VIEW_SQL}`);
  // El GRANT NO sobrevive al replace (ADR-057).
  await knex.raw(`GRANT SELECT ON analytics.kepler_bank_movements TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.kepler_bank_movements IS
    'Vista derive-no-copy: tesorería EN VIVO desde kepler_ods.kdm1 join kdb1 (concentrador, '
    'anti-réplica c1=sucursal, excluye c43=C). CG.21: tipo_cuenta se deriva de kdb1.c3=EFECTIVO '
    '(antes era una lista de claves a mano que dejaba 0030 y 0050 como banco) y se publica '
    'entidad_code = c10, la llave del acreedor/cliente. Backup: *_snapshot_bak.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_cajas`);
  // Vuelve al CASE por lista de claves y sin entidad_code. `CREATE OR REPLACE` no puede QUITAR
  // una columna, así que hay que dropear y recrear — y volver a poner el GRANT.
  const rel = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.kepler_bank_movements')`);
  if (!rel.rows[0] || rel.rows[0].relkind !== 'v') return;
  const previo = VIEW_SQL
    .replace(`WHEN upper(btrim(coalesce(c3, ''))) = 'EFECTIVO' THEN 'caja'`, `WHEN btrim(c1) IN ('0010','0011','0040') THEN 'caja'`)
    .replace(/,\s*\n\s*legs\.entidad AS entidad_code/, '')
    .replace(/,\s*\n?\s*NULLIF\(btrim\(d\.c10::text\),''\) entidad/, '')
    .replace(/beneficiario, entidad, c45 AS clave/, 'beneficiario, c45 AS clave')
    .replace(/beneficiario, entidad, c47 AS clave/, 'beneficiario, c47 AS clave');
  await knex.raw(`DROP VIEW analytics.kepler_bank_movements`);
  await knex.raw(`CREATE VIEW analytics.kepler_bank_movements AS ${previo}`);
  await knex.raw(`GRANT SELECT ON analytics.kepler_bank_movements TO app_runtime`);
};
