#!/usr/bin/env node
/**
 * [PQ.3.2] Calendario de compras — las reglas de revisión y la marca del día, contra base REAL.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 * `commercial.purchase_review_rules` guarda proveedor × alcance × patrón × quién revisa (anexo C
 * §10); `commercial.purchase_review_marks`, lo que quien revisa dijo de una fecha (DC14). Antes de
 * que exista la API (PQ.3.4), lo que tiene que ser verdad en la base:
 *
 *  1. **Las listas del código = los CHECK.** Alcances, patrones, corrimiento de fin de semana,
 *     resultados y motivos de `libs/contracts/src/http/purchase-calendar.contract.ts` son
 *     EXACTAMENTE los que aceptan los CHECK. Si divergen, la pantalla ofrecería algo que la base
 *     rechaza (un 500 que sólo aparece al tocar el botón).
 *  2. **Los ejemplos de Francisco entran:** el 15 y el último, corporativo; cada miércoles en
 *     Yurécuaro y cada martes en Canindo para el MISMO proveedor; cada 7 días en la zona Zamora.
 *  3. **Negativas, una por regla del CHECK** — incluida la TRAMPA del NULL: un CHECK que da NULL deja
 *     pasar la fila, así que «días de la semana» sin días, `{3,NULL}`, «días del mes» sin días ni
 *     último y «cada N días» con N nulo tienen que rebotar. Control: se demuestra en la misma base
 *     que la expresión ingenua (`cardinality(NULL) > 0`) da NULL — sin eso la negativa no probaría
 *     que el COALESCE hace falta.
 *  4. **Una regla viva por proveedor y alcance;** dada de baja (`deleted_at`), entra otra.
 *  5. **La marca del día:** «hoy no se pide» exige motivo, «otro» exige nota, la nueva fecha va
 *     después de la que tocaba, una sola marca por regla y fecha, y no hay marca sin regla.
 *  6. **Como `app_runtime`** (el rol de prod): puede insertar y dar de baja con UPDATE, NO puede
 *     borrar; y con otro tenant (RLS) no ve nada.
 *
 * Todo dentro de una transacción que se REVIERTE: no deja filas.
 * ⚠️ Sin las tablas (migración 20261120130156 sin aplicar) sale con 2 = NO MEDIDO, nunca ✔.
 * ⛔ Escribe (aunque revierta): exige `assert-safe-target`, nunca contra producción.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DST = process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW_RUNTIME o DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000aa';
const CONTRATO = path.join(__dirname, '..', '..', 'libs', 'contracts', 'src', 'http', 'purchase-calendar.contract.ts');

let ok = 0, fail = 0, nm = 0;
const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };

/** Las listas del contrato, leídas del CÓDIGO (no copiadas aquí: una copia se queda vieja). */
function listasDelContrato() {
  const src = fs.readFileSync(CONTRATO, 'utf8');
  const lista = (nombre) => {
    const m = src.match(new RegExp(`export const ${nombre}: readonly \\w+\\[\\] = \\[([^\\]]*)\\]`));
    if (!m) throw new Error(`no encontré ${nombre} en ${CONTRATO}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  };
  return {
    scope: lista('ALCANCES_REVISION'),
    pattern: lista('PATRONES_REVISION'),
    weekend_shift: lista('CORRIMIENTOS_FIN_DE_SEMANA'),
    outcome: lista('RESULTADOS_REVISION'),
    skip_reason: lista('MOTIVOS_NO_SE_PIDE'),
  };
}

require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq3-2-reglas-revision', { url: DST });

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  let dest = (await c.query('SELECT current_user u, current_database() d')).rows[0];
  console.log(`\n[PQ.3.2] reglas de revisión del calendario de compras  —  ${dest.u}@${dest.d}\n`);

  const existe = (await c.query(`SELECT to_regclass('commercial.purchase_review_rules') IS NOT NULL
                                        AND to_regclass('commercial.purchase_review_marks') IS NOT NULL ok`)).rows[0].ok;
  if (!existe) {
    NM('commercial.purchase_review_rules / _marks no existen (migración 20261120130156 sin aplicar)');
    await c.end();
    process.exit(2);
  }

  // 1. Las listas del código = los CHECK.
  const contrato = listasDelContrato();
  const defs = (await c.query(`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid IN ('commercial.purchase_review_rules'::regclass, 'commercial.purchase_review_marks'::regclass)
       AND contype = 'c'`)).rows.map((r) => r.def);
  const valoresDe = (col, defsDeCol) => [...new Set(defsDeCol.flatMap((d) => {
    // Sólo las comparaciones de ESA columna: «col = 'x'» y «col = ANY (ARRAY['x', …])».
    const out = [];
    for (const m of d.matchAll(new RegExp(`\\(?${col} = '([^']+)'::text\\)?`, 'g'))) out.push(m[1]);
    for (const m of d.matchAll(new RegExp(`${col} = ANY \\(ARRAY\\[([^\\]]+)\\]\\)`, 'g'))) out.push(...[...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    return out;
  }))].sort();
  for (const col of Object.keys(contrato)) {
    const enCheck = valoresDe(col, defs);
    if (JSON.stringify(enCheck) === JSON.stringify(contrato[col])) P(`${col}: el contrato y el CHECK aceptan lo mismo (${contrato[col].join(', ')})`);
    else F(`${col}: el contrato dice [${contrato[col]}] y el CHECK acepta [${enCheck}]`);
  }

  // Probar como el rol de prod. Si la conexión no es app_runtime pero puede volverse, se vuelve.
  if (dest.u !== 'app_runtime') {
    try { await c.query('SET ROLE app_runtime'); dest = { ...dest, u: (await c.query('SELECT current_user u')).rows[0].u }; console.log(`  ⓘ SET ROLE app_runtime (la conexión entró como otro usuario)`); }
    catch { /* se declara abajo */ }
  }
  const comoRuntime = dest.u === 'app_runtime';

  await c.query('BEGIN');
  const sp = async (nombre, fn) => {
    await c.query(`SAVEPOINT ${nombre}`);
    try { return await fn(); } finally { await c.query(`ROLLBACK TO SAVEPOINT ${nombre}`); }
  };
  const regla = (r) => c.query(`
    INSERT INTO commercial.purchase_review_rules
      (tenant_id, supplier_code, scope, zone_code, branch_code, pattern, weekdays, month_days, month_last_day,
       every_n_days, weekend_shift, out_of_cycle_until, out_of_cycle_reason, created_by, updated_by)
    VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6::smallint[], $7::smallint[], $8, $9, COALESCE($10, 'friday'), $11, $12, 'prueba', 'prueba')
    RETURNING id`, [r.supplier ?? 'PQ32-A', r.scope ?? 'corporate', r.zone ?? null, r.branch ?? null, r.pattern ?? 'weekdays',
    r.weekdays === undefined ? null : r.weekdays, r.month_days === undefined ? null : r.month_days, r.last ?? false,
    r.n ?? null, r.shift ?? null, r.until ?? null, r.reason ?? null]).then((x) => x.rows[0].id);
  const rebota = async (nombre, codigo, fn, que) => sp(nombre, async () => {
    try { await fn(); F(`entró: ${que}`); }
    catch (e) { if (e.code === codigo) P(`negativa: ${que} → ${codigo}`); else F(`${que} falló por otra cosa: ${e.code} ${e.message}`); }
  });

  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);

    // 2. Los ejemplos de Francisco entran.
    const mondelez = await regla({ supplier: 'PQ32-MON', scope: 'corporate', pattern: 'month_days', month_days: [15], last: true });
    const yur = await regla({ supplier: 'PQ32-BOT', scope: 'branch', branch: '04', pattern: 'weekdays', weekdays: [3] });
    const can = await regla({ supplier: 'PQ32-BOT', scope: 'branch', branch: '06', pattern: 'weekdays', weekdays: [2] });
    const corpBot = await regla({ supplier: 'PQ32-BOT', scope: 'corporate', pattern: 'every_n_days', n: 7 });
    const zam = await regla({ supplier: 'PQ32-ZAM', scope: 'zone', zone: 'ZAM', pattern: 'every_n_days', n: 7 });
    const soloUltimo = await regla({ supplier: 'PQ32-ULT', pattern: 'month_days', last: true, shift: 'monday' });
    if ([mondelez, yur, can, corpBot, zam, soloUltimo].every(Boolean)) {
      P('entran: el 15 y el último (corporativo) · miércoles en 04 y martes en 06 del MISMO proveedor, más su regla corporativa · cada 7 días en la zona ZAM · sólo «el último» con corrimiento al lunes');
    }
    const leida = (await c.query(`SELECT weekdays, month_days, month_last_day, weekend_shift FROM commercial.purchase_review_rules WHERE id = $1`, [mondelez])).rows[0];
    if (JSON.stringify(leida.month_days) === '[15]' && leida.month_last_day === true && leida.weekend_shift === 'friday' && leida.weekdays === null) {
      P('se lee como se guardó: month_days [15], último = sí, fin de semana → viernes por defecto (DC19)');
    } else F(`la regla se lee distinta: ${JSON.stringify(leida)}`);

    // 3. Control de la trampa del NULL: la expresión ingenua NO es falsa, es NULL.
    const trampa = (await c.query(`
      SELECT (cardinality(NULL::smallint[]) > 0) IS NULL AS a,
             (1 <= ALL ('{3,NULL}'::smallint[])) IS NULL AS b,
             ((cardinality(NULL::smallint[]) > 0) OR false) IS NULL AS c`)).rows[0];
    if (trampa.a && trampa.b && trampa.c) P('control: en esta base la expresión ingenua da NULL (no falso), así que sin el COALESCE las negativas de abajo ENTRARÍAN');
    else F(`control: la expresión ingenua no dio NULL (${JSON.stringify(trampa)}): la negativa del NULL no prueba nada`);

    // 3. Negativas de la regla.
    const CK = '23514';
    await rebota('wd_null', CK, () => regla({ supplier: 'N1', pattern: 'weekdays', weekdays: null }), '«días de la semana» SIN días (NULL)');
    await rebota('wd_vacio', CK, () => regla({ supplier: 'N2', pattern: 'weekdays', weekdays: [] }), '«días de la semana» con lista vacía');
    await rebota('wd_null_el', CK, () => regla({ supplier: 'N3', pattern: 'weekdays', weekdays: [3, null] }), '«días de la semana» {3,NULL}');
    await rebota('wd_0', CK, () => regla({ supplier: 'N4', pattern: 'weekdays', weekdays: [0] }), 'día de la semana 0 (ISO va de 1 a 7)');
    await rebota('wd_8', CK, () => regla({ supplier: 'N5', pattern: 'weekdays', weekdays: [8] }), 'día de la semana 8');
    await rebota('md_nada', CK, () => regla({ supplier: 'N6', pattern: 'month_days', month_days: null, last: false }), '«días del mes» sin días ni «el último»');
    await rebota('md_32', CK, () => regla({ supplier: 'N7', pattern: 'month_days', month_days: [32] }), 'día del mes 32');
    await rebota('md_null_el', CK, () => regla({ supplier: 'N8', pattern: 'month_days', month_days: [15, null] }), '«días del mes» {15,NULL}');
    await rebota('n_null', CK, () => regla({ supplier: 'N9', pattern: 'every_n_days', n: null }), '«cada N días» con N nulo');
    await rebota('n_0', CK, () => regla({ supplier: 'N10', pattern: 'every_n_days', n: 0 }), '«cada 0 días»');
    await rebota('mezcla', CK, () => regla({ supplier: 'N11', pattern: 'weekdays', weekdays: [3], n: 7 }), 'días de la semana Y cada N días en la misma regla');
    await rebota('wd_ultimo', CK, () => regla({ supplier: 'N12', pattern: 'weekdays', weekdays: [3], last: true }), 'días de la semana con «el último»');
    await rebota('corp_suc', CK, () => regla({ supplier: 'N13', scope: 'corporate', branch: '04', weekdays: [3] }), 'corporativo con sucursal');
    await rebota('suc_sin', CK, () => regla({ supplier: 'N14', scope: 'branch', weekdays: [3] }), 'sucursal sin sucursal');
    await rebota('zona_suc', CK, () => regla({ supplier: 'N15', scope: 'zone', zone: 'ZAM', branch: '06', weekdays: [3] }), 'zona con sucursal');
    await rebota('alcance', CK, () => regla({ supplier: 'N16', scope: 'pais', weekdays: [3] }), 'alcance desconocido «pais»');
    await rebota('corrim', CK, () => regla({ supplier: 'N17', pattern: 'month_days', month_days: [15], shift: 'sunday' }), 'corrimiento «sunday»');
    await rebota('fuera_sin', CK, () => regla({ supplier: 'N18', weekdays: [3], until: '2027-01-15' }), '«fuera de ciclo hasta» sin motivo');
    await rebota('prov_vacio', CK, () => regla({ supplier: '  ', weekdays: [3] }), 'proveedor en blanco');

    // 4. Una regla viva por proveedor y alcance; la baja libera el lugar.
    await rebota('dup', '23505', () => regla({ supplier: 'PQ32-BOT', scope: 'branch', branch: '04', pattern: 'weekdays', weekdays: [5] }), 'una SEGUNDA regla viva del mismo proveedor en la misma sucursal');
    await rebota('baja_sin_quien', CK, () => c.query(`UPDATE commercial.purchase_review_rules SET deleted_at = now() WHERE id = $1`, [yur]), 'baja sin quién la dio');
    await sp('baja', async () => {
      await c.query(`UPDATE commercial.purchase_review_rules SET deleted_at = now(), deleted_by = 'prueba', updated_by = 'prueba', updated_at = now() WHERE id = $1`, [yur]);
      const nueva = await regla({ supplier: 'PQ32-BOT', scope: 'branch', branch: '04', pattern: 'weekdays', weekdays: [5] });
      if (nueva) P('dada de baja la regla del miércoles en 04 (UPDATE, no DELETE), entra la del viernes');
    });

    // 5. La marca del día.
    const marca = (m) => c.query(`
      INSERT INTO commercial.purchase_review_marks (tenant_id, rule_id, review_date, outcome, skip_reason, postponed_to, note, created_by, updated_by)
      VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, 'prueba', 'prueba') RETURNING id`,
    [m.rule ?? can, m.date ?? '2026-11-24', m.outcome ?? 'skipped', m.reason === undefined ? 'not_needed' : m.reason, m.to ?? null, m.note ?? null]).then((x) => x.rows[0].id);
    const m1 = await marca({ rule: can, date: '2026-11-24', outcome: 'skipped', reason: 'in_quotation', to: '2026-11-26' });
    const m2 = await marca({ rule: mondelez, date: '2026-11-30', outcome: 'ordered_outside_kepler', reason: null });
    const m3 = await marca({ rule: zam, date: '2026-11-27', outcome: 'skipped', reason: 'other', note: 'el proveedor cerró por inventario' });
    if (m1 && m2 && m3) P('entran: «hoy no se pide» (en cotización) pospuesto al 26 · «se pidió fuera de Kepler» · «otro» con nota');
    await rebota('m_sin_motivo', CK, () => marca({ date: '2026-12-01', outcome: 'skipped', reason: null }), '«hoy no se pide» sin motivo');
    await rebota('m_otro_sin_nota', CK, () => marca({ date: '2026-12-02', reason: 'other', note: '  ' }), 'motivo «otro» sin nota');
    await rebota('m_motivo_malo', CK, () => marca({ date: '2026-12-03', reason: 'flojera' }), 'motivo desconocido «flojera»');
    await rebota('m_fuera_con', CK, () => marca({ date: '2026-12-04', outcome: 'ordered_outside_kepler', reason: 'blocked' }), '«se pidió fuera de Kepler» con motivo de no pedir');
    await rebota('m_pospone_atras', CK, () => marca({ date: '2026-12-05', to: '2026-12-05' }), 'posponer al MISMO día (o antes)');
    await rebota('m_resultado', CK, () => marca({ date: '2026-12-06', outcome: 'maybe' }), 'resultado desconocido «maybe»');
    await rebota('m_dup', '23505', () => marca({ rule: can, date: '2026-11-24' }), 'una SEGUNDA marca de la misma regla y fecha');
    await rebota('m_huerfana', '23503', () => marca({ rule: '00000000-0000-0000-0000-000000000001', date: '2026-12-07' }), 'una marca de una regla que no existe');

    // 6. Permisos de app_runtime y RLS.
    if (comoRuntime) {
      await rebota('borrar_regla', '42501', () => c.query(`DELETE FROM commercial.purchase_review_rules WHERE id = $1`, [zam]), 'app_runtime BORRA una regla (debe darse de baja con UPDATE)');
      await rebota('borrar_marca', '42501', () => c.query(`DELETE FROM commercial.purchase_review_marks WHERE id = $1`, [m3]), 'app_runtime BORRA una marca');
      await sp('corrige', async () => {
        const n = (await c.query(`UPDATE commercial.purchase_review_marks SET skip_reason = 'order_exists', updated_by = 'prueba', updated_at = now() WHERE id = $1`, [m1])).rowCount;
        if (n === 1) P('app_runtime corrige una marca con UPDATE');
        else F(`corregir la marca tocó ${n} filas`);
      });
      await sp('rls', async () => {
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [OTRO]);
        const n = (await c.query(`SELECT (SELECT count(*) FROM commercial.purchase_review_rules WHERE supplier_code LIKE 'PQ32-%')
                                        + (SELECT count(*) FROM commercial.purchase_review_marks) AS n`)).rows[0].n;
        if (Number(n) === 0) P('RLS: con otro tenant no se ve ninguna regla ni marca');
        else F(`RLS: otro tenant ve ${n} filas ajenas`);
        await rebota('rls_insert', '42501', () => c.query(`
          INSERT INTO commercial.purchase_review_rules (tenant_id, supplier_code, scope, pattern, weekdays, created_by, updated_by)
          VALUES ($1, 'PQ32-X', 'corporate', 'weekdays', '{3}', 'prueba', 'prueba')`, [TENANT]), 'insertar con el tenant de OTRO (WITH CHECK)');
      });
    } else {
      NM(`permisos y RLS de app_runtime: la prueba corrió como ${dest.u} y no pudo hacer SET ROLE app_runtime`);
    }
  } finally {
    await c.query('ROLLBACK');
  }

  console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
