'use strict';
/**
 * `[OPS-AUD.11.4]` + `[OPS-AUD.11.5]` (ADR-104) — Caja General y Bancos LEEN la tabla mantenida por
 * trigger. Fuera el `REFRESH` de cada minuto.
 *
 * ── Lo medido antes (prod, 2026-10-27) ──────────────────────────────────────────────────────
 *  · `REFRESH mv_caja_movimientos`: 4,765 corridas en 27 h, 7.5 s c/u = **35,730 s**, el 68 % de
 *    todo lo que la base gasta en refrescar. Cada corrida recorre ~651 mil renglones de `kdm1`
 *    para ~130 cambios por hora.
 *  · 11.2: la tabla `analytics.bank_movement_legs` (11.1) da **lo mismo** que la vista, fila por
 *    fila y en las dos direcciones (56,717 = 56,717; faltan 0 · sobran 0).
 *
 * ── Qué cambia ───────────────────────────────────────────────────────────────────────────────
 *  1. `analytics.kepler_bank_movements` deja de recalcular `kdm1` y lee `bank_movement_legs`.
 *     MISMAS columnas, en el mismo orden y del mismo tipo (`CREATE OR REPLACE` lo exige). Antes de
 *     reemplazarla se compara la vieja contra la nueva, fila por fila: si no dan cero, se aborta
 *     y no se toca nada.
 *  2. `analytics.mv_caja_movimientos` deja de ser materializada: pasa a VISTA con el mismo nombre
 *     y las mismas columnas (cambiarle el nombre rompería a sus 6 lectores). Ya no hay nada que
 *     refrescar. Sus dependientes (hoy `finance.v_caja_movimientos_pendientes`) se reponen con su
 *     definición VIVA, sus opciones y sus permisos, leídos del catálogo — no copiados a mano.
 *  3. El aviso a la pantalla (`NOTIFY caja_movimientos`) lo emite un trigger sobre la tabla,
 *     sólo cuando cambia una pierna de CAJA, con el MISMO payload que emitía el refresco. Se le
 *     suma la llave `suma`: `caja-autollenado.service.ts` arma su firma con `d.suma`, que el
 *     refresco nunca mandó — un importe corregido (mismo folio, otro monto) no lo despertaba.
 *
 * ⛔ ORDEN EN PROD (como el de pólizas): PRIMERO la imagen de ingesta sin el renglón `caja-mv` del
 *    crontab y sin el deployment `caja-mv-push`; DESPUÉS esta migración. Al revés, el cron de cada
 *    minuto intentaría `REFRESH` sobre una vista y fallaría cada minuto hasta el despliegue.
 *
 * ⚠️ Fuera de horario: compara la vista vieja (recorre `kdm1`, segundos) y toma candados sobre
 *    las dos vistas. Idempotente: si `mv_caja_movimientos` ya es vista, se salta el paso 2.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';
const VISTA = 'analytics.kepler_bank_movements';
const MV = 'analytics.mv_caja_movimientos';

// kb y xw: copia EXACTA de la definición vigente (20260924230000). Son catálogos chicos y cambian
// por su cuenta, así que se siguen cruzando al leer.
const KB = `
    SELECT DISTINCT ON (btrim(c1)) btrim(c1) clave, btrim(c2) nombre, btrim(c5) cta,
           CASE WHEN btrim(c5) NOT LIKE '102%' THEN 'puente'
                WHEN upper(btrim(coalesce(c3, ''))) = 'EFECTIVO' THEN 'caja'
                ELSE 'banco' END tipo
      FROM kepler_ods.kdb1 WHERE btrim(coalesce(c1,''))<>''
     ORDER BY btrim(c1), sucursal`;

const VIEW_SQL = `
  WITH kb AS (${KB}
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
  )
  SELECT '${M}'::uuid AS tenant_id,
    l.sucursal, l.doc_tipo, l.folio, l.clave_banco,
    kb.cta AS cuenta_contable, kb.nombre AS banco_nombre, kb.tipo AS tipo_cuenta,
    l.flujo, l.importe, l.signo,
    l.fecha_valor, l.fecha_captura,
    l.concepto, l.metodo, l.beneficiario,
    l.es_traspaso, l.contra_clave, l.pierna,
    xw.account_label,
    now() AS computed_at,
    l.entidad_code,
    pc.fecha_pago AS fecha_pago_sat,
    COALESCE(pc.fecha_pago, l.fecha_valor) AS fecha_efectiva
  FROM analytics.bank_movement_legs l
  LEFT JOIN kb ON kb.clave = l.clave_banco
  LEFT JOIN xw ON xw.clave = l.clave_banco
  LEFT JOIN analytics.v_kepler_payment_complement pc
    ON pc.sucursal = l.sucursal AND pc.doc_tipo = l.doc_tipo AND pc.folio = l.folio`;

// Las claves que la vista clasifica como 'caja' — la MISMA expresión de kb, no una parecida.
const CLAVES_CAJA = `SELECT z.clave FROM (${KB}) z WHERE z.tipo = 'caja'`;

const lit = (s) => (s == null ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'");

/** Columnas de una relación, en orden. */
async function columnas(knex, rel) {
  const { rows } = await knex.raw(
    `SELECT attname FROM pg_attribute WHERE attrelid = ?::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    [rel]);
  return rows.map((r) => r.attname);
}

/**
 * TODA la cadena de vistas que cuelga de `rel` (hijas, nietas…), en orden de creación, con lo que
 * un DROP … CASCADE se lleva: definición viva, opciones (`security_invoker`), comentario,
 * permisos y, si es materializada, sus índices y cuántas filas tenía.
 *
 * Medido en la base de prueba: `finance.v_caja_movimientos_pendientes` tiene a su vez a
 * `analytics.mv_caja_autofill_entidad` (materializada, CG.141). La primera versión de esta
 * migración sólo miraba un nivel, y su guarda la frenó — que es para lo que estaba.
 *
 * ⛔ Si una vista cuelga de DOS de la cadena (rombo), se aborta: el orden de creación por
 *    recorrido en profundidad no lo garantiza, y no está medido.
 */
async function capturarDependientes(knex, rel, vistos = new Set()) {
  const { rows } = await knex.raw(`
    SELECT DISTINCT dv.oid::int AS oid, dv.oid::regclass::text AS nombre, dv.relkind::text AS kind,
           pg_get_viewdef(dv.oid, true) AS def, dv.reloptions AS opciones,
           obj_description(dv.oid, 'pg_class') AS comentario
      FROM pg_depend d
      JOIN pg_rewrite rw ON rw.oid = d.objid
      JOIN pg_class dv ON dv.oid = rw.ev_class
     WHERE d.refobjid = ?::regclass AND dv.oid <> d.refobjid
     ORDER BY 2`, [rel]);
  const salida = [];
  for (const v of rows) {
    if (v.kind !== 'v' && v.kind !== 'm') throw new Error(`[OPS-AUD.11.4] ${v.nombre} (relkind ${v.kind}) depende de ${rel}: tipo no previsto. No se toca nada.`);
    if (vistos.has(v.oid)) throw new Error(`[OPS-AUD.11.4] ${v.nombre} cuelga de dos vistas de la cadena: no está medido. No se toca nada.`);
    vistos.add(v.oid);
    v.permisos = await permisos(knex, v.nombre);
    if (v.kind === 'm') {
      const [esq, nom] = v.nombre.includes('.') ? v.nombre.split('.') : ['public', v.nombre];
      v.indices = (await knex.raw(`SELECT indexdef FROM pg_indexes WHERE schemaname = ? AND tablename = ? ORDER BY indexname`, [esq, nom])).rows.map((r) => r.indexdef);
      v.filas = (await knex.raw(`SELECT count(*)::int AS n FROM ${v.nombre}`)).rows[0].n;
    }
    salida.push(v, ...(await capturarDependientes(knex, v.nombre, vistos)));
  }
  return salida;
}

/**
 * Las columnas de la caja salen de la vista, salvo las de RELOJ que una base atrasada todavía
 * tenga (`refrescado_en`, quitada en prod por 20260924180000): esas se conservan como `now()`
 * para no romper a quien las lea. Cualquier otra que no exista en la vista aborta.
 */
async function selectCaja(knex, mvCols) {
  const deVista = new Set(await columnas(knex, VISTA));
  return mvCols.map((c) => {
    if (deVista.has(c)) return `k."${c}"`;
    if (c === 'refrescado_en') return `now() AS "${c}"`;
    throw new Error(`[OPS-AUD.11.4] ${MV}.${c} no existe en ${VISTA}: no se sabe de dónde sale. No se toca nada.`);
  });
}

/** Permisos explícitos (sin los del dueño), para re-otorgarlos: no sobreviven a un DROP. */
async function permisos(knex, rel) {
  const { rows } = await knex.raw(`
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END AS rol, a.privilege_type AS priv
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE c.oid = ?::regclass AND a.grantee <> c.relowner`, [rel]);
  return rows;
}

async function otorgar(knex, rel, lista) {
  for (const p of lista) await knex.raw(`GRANT ${p.priv} ON ${rel} TO ${p.rol}`);
}

async function reponerDependientes(knex, deps) {
  for (const v of deps) {
    const con = v.opciones && v.opciones.length ? ` WITH (${v.opciones.join(', ')})` : '';
    if (v.kind === 'v') {
      await knex.raw(`CREATE VIEW ${v.nombre}${con} AS ${v.def}`);
      if (v.comentario != null) await knex.raw(`COMMENT ON VIEW ${v.nombre} IS ${lit(v.comentario)}`);
    } else {
      // ⛔ Con el tenant FIJADO (local a la transacción): la bandeja filtra `current_tenant_id()`
      // y una materializada armada sin él nace VACÍA (GOTCHAS §87.1; así nació ésta el 13-oct).
      // Es el mismo tenant con que la refresca su carril (caja-autofill-refresh.service.ts).
      const previo = (await knex.raw(`SELECT coalesce(current_setting('app.tenant_id', true), '') AS t`)).rows[0].t;
      await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
      await knex.raw(`CREATE MATERIALIZED VIEW ${v.nombre}${con} AS ${v.def}`);
      await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [previo]);
      for (const ix of v.indices) await knex.raw(ix);
      if (v.comentario != null) await knex.raw(`COMMENT ON MATERIALIZED VIEW ${v.nombre} IS ${lit(v.comentario)}`);
      const n = (await knex.raw(`SELECT count(*)::int AS n FROM ${v.nombre}`)).rows[0].n;
      if (v.filas > 0 && n === 0) throw new Error(`[OPS-AUD.11.4] ${v.nombre} tenía ${v.filas} filas y se repuso con 0: se revierte.`);
      console.log(`  · ${v.nombre}: ${v.filas} → ${n} filas, ${v.indices.length} índices`);
    }
    await otorgar(knex, v.nombre, v.permisos);
    console.log(`  · repuesta ${v.nombre} (${v.kind}, ${v.permisos.length} permisos)`);
  }
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const { rows: [pre] } = await knex.raw(`
    SELECT to_regclass('analytics.bank_movement_legs') AS legs,
           to_regclass('analytics.v_kepler_payment_complement') AS pc,
           to_regclass('${VISTA}') AS vista,
           (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('${MV}')) AS mv_kind`);
  if (!pre.vista || !pre.pc) {
    console.log('[OPS-AUD.11.4] falta la vista de tesorería o el complemento SAT — se omite.');
    return;
  }
  if (!pre.legs) throw new Error('[OPS-AUD.11.4] falta analytics.bank_movement_legs: va DESPUÉS de 20261027124906 (11.1).');

  // ── 1. kepler_bank_movements lee la tabla — sólo si la nueva da EXACTAMENTE lo mismo ────────
  const cols = (await columnas(knex, VISTA)).filter((c) => c !== 'computed_at');
  const lista = cols.map((c) => `"${c}"`).join(', ');
  await knex.raw(`CREATE TEMP VIEW _kbm_nueva AS ${VIEW_SQL}`);
  const { rows: [par] } = await knex.raw(`
    WITH v AS (SELECT ${lista} FROM ${VISTA}), n AS (SELECT ${lista} FROM _kbm_nueva)
    SELECT (SELECT count(*) FROM (SELECT * FROM v EXCEPT ALL SELECT * FROM n) a)::int AS faltan,
           (SELECT count(*) FROM (SELECT * FROM n EXCEPT ALL SELECT * FROM v) b)::int AS sobran,
           (SELECT count(*) FROM v)::int AS filas`);
  await knex.raw(`DROP VIEW _kbm_nueva`);
  console.log(`[OPS-AUD.11.4] paridad vieja vs nueva: ${par.filas} filas · faltan ${par.faltan} · sobran ${par.sobran}`);
  if (par.faltan || par.sobran) {
    throw new Error(`[OPS-AUD.11.4] la vista nueva NO da lo mismo (faltan ${par.faltan}, sobran ${par.sobran}). `
      + 'Correr analytics.bank_movement_legs_drift() y revisar bank_movement_legs_errors. No se tocó nada.');
  }
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS ${VIEW_SQL}`);
  // Ni el GRANT ni `security_invoker` sobreviven al replace (ADR-057). Se re-aplican SIEMPRE.
  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS ${lit(
    '[OPS-AUD.11.4, ADR-104] Movimientos de tesorería. Lee analytics.bank_movement_legs, que mantienen '
    + 'los triggers de kepler_ods.kdm1/kdb1 (la regla vive en analytics.kdm1_legs). Ya NO recorre kdm1. '
    + 'Catálogo kdb1, account_label y complemento SAT se cruzan al leer.')}`);

  // ── 2. mv_caja_movimientos: de materializada a vista, con sus dependientes ──────────────────
  if (pre.mv_kind === 'm') {
    const mvCols = await columnas(knex, MV);
    const mvPermisos = await permisos(knex, MV);
    const deps = await capturarDependientes(knex, MV);
    const { rows: [antes] } = await knex.raw(`SELECT count(*)::int AS n FROM ${MV}`);

    await knex.raw(`DROP MATERIALIZED VIEW ${MV} CASCADE`);
    // ⚠️ SIN `security_invoker`, a propósito: la materializada se leía con lo que guardó quien la
    // refrescaba (`postgres`, sin RLS). Con `security_invoker` un lector sin tenant fijado vería
    // otra cosa (el RLS de finance.bank_accounts vaciaría `account_label`). Expone exactamente lo
    // mismo que exponía la materializada, a los mismos roles.
    const select = await selectCaja(knex, mvCols);
    await knex.raw(`
      CREATE VIEW ${MV} AS
      SELECT ${select.join(', ')}
        FROM ${VISTA} k
       WHERE k.tipo_cuenta = 'caja'`);
    await otorgar(knex, MV, mvPermisos);
    await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);
    await knex.raw(`COMMENT ON VIEW ${MV} IS ${lit(
      '[OPS-AUD.11.4, ADR-104] Los movimientos de CAJA de analytics.kepler_bank_movements. Era una vista '
      + 'MATERIALIZADA refrescada cada minuto (35,730 s en 27 h, medido 2026-10-27); hoy es una vista '
      + 'sobre la tabla que mantienen los triggers, así que no hay nada que refrescar. Conserva el nombre '
      + 'mv_ para no romper a sus lectores. El aviso a la pantalla (NOTIFY caja_movimientos) lo emite '
      + 'el trigger tg_bml_avisa_* de analytics.bank_movement_legs.')}`);
    await reponerDependientes(knex, deps);

    const { rows: [despues] } = await knex.raw(`SELECT count(*)::int AS n FROM ${MV}`);
    // La materializada podía ir hasta un minuto atrasada: unas filas de diferencia son esperables.
    console.log(`[OPS-AUD.11.4] mv_caja_movimientos: ${antes.n} filas (materializada) → ${despues.n} (vista)`);
    if (antes.n > 0 && despues.n === 0) throw new Error('[OPS-AUD.11.4] la vista de caja quedó en 0 filas: se revierte.');
  } else {
    console.log(`[OPS-AUD.11.4] ${MV} ya no es materializada (relkind ${pre.mv_kind}) — se salta el paso 2.`);
  }

  // ── 3. El aviso a la pantalla, desde la tabla ───────────────────────────────────────────────
  // Por SENTENCIA y sólo si la sentencia tocó una pierna de caja. Mismo payload que emitía
  // `refresh-caja-matview.js` (lo leen caja-realtime y caja-autollenado), más `suma`.
  // ⚠️ Cada operación con SU sentencia: nombrar old_rows en un trigger de alta falla al prepararse.
  // ⛔ El error se atrapa: un aviso que falla NO puede tumbar la ingesta de kdm1.
  // El payload, aparte: así se puede probar (un NOTIFY dentro de una transacción revertida nunca
  // se entrega) y es UNA definición de la firma, no una por consumidor.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.caja_aviso_payloads()
    RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
      SELECT json_build_object(
               'tenant_id', l.tenant_id::text, 'filas', count(*)::int, 'max_folio', max(l.folio),
               'max_captura', max(l.fecha_captura)::text, 'suma', round(sum(l.importe), 2)::text,
               'firma', count(*)::text || '|' || coalesce(max(l.folio), '') || '|'
                        || coalesce(max(l.fecha_captura)::text, '') || '|' || coalesce(round(sum(l.importe), 2)::text, ''),
               'datos_al', now())::text
        FROM analytics.bank_movement_legs l
       WHERE l.clave_banco IN (${CLAVES_CAJA})
       GROUP BY l.tenant_id
    $fn$`);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.tg_bml_avisa_caja()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
    DECLARE toco boolean := true; p text; v_state text; v_msg text;
    BEGIN
      BEGIN
        IF TG_OP = 'INSERT' THEN
          toco := EXISTS (SELECT 1 FROM new_rows n WHERE n.clave_banco IN (${CLAVES_CAJA}));
        ELSIF TG_OP = 'DELETE' THEN
          toco := EXISTS (SELECT 1 FROM old_rows o WHERE o.clave_banco IN (${CLAVES_CAJA}));
        END IF;
        IF toco THEN
          FOR p IN SELECT analytics.caja_aviso_payloads() LOOP
            PERFORM pg_notify('caja_movimientos', p);
          END LOOP;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        INSERT INTO analytics.bank_movement_legs_errors (tabla, operacion, sqlstate, mensaje)
        VALUES ('bank_movement_legs:aviso', TG_OP, v_state, left(v_msg, 500));
      END;
      RETURN NULL;
    END $fn$`);
  const avisos = [
    ['ins', 'INSERT', 'REFERENCING NEW TABLE AS new_rows'],
    ['del', 'DELETE', 'REFERENCING OLD TABLE AS old_rows'],
    ['trn', 'TRUNCATE', ''],
  ];
  for (const [sufijo, evento, refs] of avisos) {
    await knex.raw(`DROP TRIGGER IF EXISTS tg_bml_avisa_${sufijo} ON analytics.bank_movement_legs`);
    await knex.raw(`CREATE TRIGGER tg_bml_avisa_${sufijo} AFTER ${evento} ON analytics.bank_movement_legs
      ${refs} FOR EACH STATEMENT EXECUTE FUNCTION analytics.tg_bml_avisa_caja()`);
  }
};

/**
 * Deshace los pasos 2 y 3: la caja vuelve a ser materializada (con sus dos índices) y los
 * dependientes se reponen. ⚠️ `kepler_bank_movements` SE QUEDA leyendo la tabla: da lo mismo
 * (se comprobó al subir). Para volverla a recorrer kdm1, re-aplicar el `up` de
 * 20260924230000 — y ANTES de revertir 11.1, que borra la tabla de la que esta vista depende.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const s of ['ins', 'del', 'trn']) {
    await knex.raw(`DROP TRIGGER IF EXISTS tg_bml_avisa_${s} ON analytics.bank_movement_legs`).catch(() => {});
  }
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.tg_bml_avisa_caja()`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.caja_aviso_payloads()`);

  const { rows: [k] } = await knex.raw(`SELECT (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('${MV}')) AS kind`);
  if (k.kind !== 'v') return;
  const mvCols = await columnas(knex, MV);
  const mvPermisos = await permisos(knex, MV);
  const deps = await capturarDependientes(knex, MV);
  await knex.raw(`DROP VIEW ${MV} CASCADE`);
  await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS
    SELECT ${(await selectCaja(knex, mvCols)).join(', ')} FROM ${VISTA} k WHERE k.tipo_cuenta = 'caja'`);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_caja_movimientos ON ${MV} (tenant_id, sucursal, doc_tipo, folio, clave_banco, pierna)`);
  await knex.raw(`CREATE INDEX ix_mv_caja_movimientos_bandeja ON ${MV} (tenant_id, clave_banco, fecha_valor DESC)`);
  await otorgar(knex, MV, mvPermisos);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);
  await reponerDependientes(knex, deps);
};
