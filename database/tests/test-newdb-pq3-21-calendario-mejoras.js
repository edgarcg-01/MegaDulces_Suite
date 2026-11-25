/**
 * `[PQ.3.15]` `[PQ.3.21]` `[PQ.3.22]` Las mejoras del Calendario de compras que pidieron los usuarios (anexo C §10.12),
 * contra una base REAL y con el payload de la pantalla (CLAUDE.md regla 13: estas escrituras no están probadas hasta
 * ejercerlas contra Postgres).
 *
 * Carga con ts-node el MISMO `purchase-calendar.repo.ts` que usa la API y lo corre como `app_runtime` con el tenant
 * puesto (RLS y GRANT de producción). Todo en UNA transacción que se revierte: la migración 20261124133043 (su `up()`
 * real), las sucursales y zonas que falten, y la llave de marcar de dos personas de prueba.
 *
 * Qué afirma:
 *  1. La migración: las tres columnas y el CHECK aceptan EXACTAMENTE lo que acepta el contrato (negativas: cada 4
 *     semanas, cada 2 sin ancla, ancla sin cadencia, mensual + cada N, cadencia en «días del mes» → 23514).
 *  2. Varias zonas en una captura (DC28): UNA regla por zona, con el mismo patrón y la cadencia; repetir la captura las
 *     REEMPLAZA (mismos ids, no duplica). Varias sucursales, igual.
 *  3. ⛔ NEGATIVA: si quien define no alcanza UNO de los lugares, no se escribe NINGUNO (se revisa antes de escribir).
 *  4. La cadencia viaja de ida y vuelta: el calendario devuelve `week_interval`, `week_anchor` (YYYY-MM-DD) y `month_week`.
 *  5. El responsable (DC30): con la llave de marcar y escribiendo en TODAS las sucursales de la regla, se guarda y el
 *     calendario lo nombra; sin la llave, o sin ver uno de los lugares, se rechaza en llano y no se escribe nada; sin
 *     el alcance resuelto por el servicio, falla (no se supone «todas»). `leerPosiblesResponsables` trae a quien tiene
 *     la llave efectiva (también por ajuste personal) y deja fuera a quien no.
 *
 * ⛔ Escribe (y revierte): no corre contra producción (`assertSafeTarget`). A mano, con `DATABASE_URL_NEW` a una base local.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq3-21-calendario-mejoras');
const { noMedido, correr } = require('./_lib/no-medido');
const RAIZ = path.resolve(__dirname, '..', '..');
let R;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  R = require(path.join(RAIZ, 'libs/commercial/src/lib/purchase-calendar/purchase-calendar.repo.ts'));
} catch (e) {
  noMedido(`no se pudo cargar el repositorio con ts-node: ${e.message}`);
}
const knex = require('knex')(require('../knexfile-newdb.js').development);
const migBase = require('../migrations-newdb/20261120130156_pq3_2_reglas_de_revision_compras.js');
const migCadencia = require('../migrations-newdb/20261124133043_pq3_15_cadencia_dias_de_la_semana.js');
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const LLAVE = 'COMPRAS_CALENDARIO_GESTIONAR';
let ok = 0;
let ko = 0;
const nm = 0;
const check = (desc, cond, detalle) => {
  if (cond) { ok += 1; console.log(`  ✓ ${desc}`); }
  else { ko += 1; console.log(`  ✗ ${desc}${detalle !== undefined ? `  → ${JSON.stringify(detalle)}` : ''}`); }
};
/** Corre `fn` en un SAVEPOINT; devuelve el error (o null) y deja la transacción usable. */
async function errorDe(trx, fn) {
  await trx.raw('SAVEPOINT sp_m');
  try { await fn(); await trx.raw('RELEASE SAVEPOINT sp_m'); return null; } catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT sp_m'); return e; }
}

correr(async () => {
  console.log('\n[PQ.3.15][PQ.3.21][PQ.3.22] Mejoras del Calendario de compras — el repositorio real, como app_runtime\n');
  const trx = await knex.transaction();
  try {
    if ((await trx.raw('show transaction_read_only')).rows[0].transaction_read_only === 'on') noMedido('la conexión es de sólo lectura');
    if (!(await trx('identity.tenants').where({ id: TENANT }).first('id'))) noMedido(`no existe el tenant ${TENANT}`);
    if (!(await trx.schema.withSchema('commercial').hasTable('purchase_review_rules'))) await migBase.up(trx);
    await migCadencia.up(trx);
    await migCadencia.up(trx); // idempotente: la segunda vez no hace nada ni truena

    // Sucursales con zona como en prod (las que falten): La Piedad 01–04, Zamora 05–06, Morelia 07–08.
    const SUC = [['01', 'Padre Hidalgo', 'La Piedad'], ['02', 'La Piedad Abastos', 'La Piedad'], ['03', '8 Esquinas', 'La Piedad'],
      ['04', 'Yurécuaro', 'La Piedad'], ['05', 'Zamora Centro', 'Zamora'], ['06', 'Canindo', 'Zamora'], ['07', 'Morelia Madero', 'Morelia'], ['08', 'Morelia Abastos', 'Morelia']];
    for (const [code, name, zona] of SUC) {
      const w = await trx('commercial.warehouses').where({ tenant_id: TENANT, code }).first('id', 'purchase_zone');
      if (!w) await trx('commercial.warehouses').insert({ tenant_id: TENANT, code, name, kepler_code: code, purchase_zone: zona, kind: 'central', active: true });
      else if (!w.purchase_zone) await trx('commercial.warehouses').where({ id: w.id }).update({ purchase_zone: zona });
    }

    const provs = await trx('catalog.suppliers as s').where({ 's.tenant_id': TENANT }).whereNull('s.deleted_at').whereNotNull('s.code')
      .whereRaw(`btrim(s.code) <> ''`)
      .whereRaw(`NOT EXISTS (SELECT 1 FROM commercial.purchase_review_rules r WHERE r.tenant_id = s.tenant_id AND r.supplier_code = s.code AND r.deleted_at IS NULL)`)
      .orderBy('s.code').limit(4).select('s.code', 's.name');
    if (provs.length < 4) noMedido('la base no tiene 4 proveedores vivos sin regla en catalog.suppliers');
    const [P, P2, P3, P4] = provs;

    // Tres personas activas: la que define, una responsable con la llave por ajuste personal, y una SIN la llave.
    const gente = await trx('identity.users').where({ tenant_id: TENANT, activo: true }).whereNull('deleted_at').whereNotNull('nombre')
      .orderBy('username').limit(3).select('id', 'nombre', 'username', 'role_name');
    if (gente.length < 3) noMedido('la base no tiene 3 personas activas con nombre');
    const [DEF, RESP, SIN] = gente;
    await trx('identity.user_permissions').where({ tenant_id: TENANT }).whereIn('user_id', [RESP.id, SIN.id]).where({ permission_key: LLAVE }).del();
    await trx('identity.user_permissions').insert({ tenant_id: TENANT, user_id: RESP.id, permission_key: LLAVE, allow: true, nota: 'prueba PQ.3.22' });
    await trx('identity.user_permissions').insert({ tenant_id: TENANT, user_id: SIN.id, permission_key: LLAVE, allow: false, nota: 'prueba PQ.3.22' });
    const quien = { userId: DEF.id, username: DEF.username ?? null, escribe: null };

    // ── 1 · La migración: lo que el CHECK acepta y rechaza (como postgres, antes de cambiar de rol) ──────────────
    const cols = (await trx.raw(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'commercial'
                                  AND table_name = 'purchase_review_rules' AND column_name IN ('week_interval', 'week_anchor', 'month_week') ORDER BY 1`)).rows;
    check('la migración agrega week_anchor (date), week_interval y month_week (smallint)',
      JSON.stringify(cols.map((c) => `${c.column_name}:${c.data_type}`)) === JSON.stringify(['month_week:smallint', 'week_anchor:date', 'week_interval:smallint']), cols);
    const fila = (extra) => ({ tenant_id: TENANT, supplier_code: 'PQ321-CHK', scope: 'corporate', pattern: 'weekdays', weekdays: [2], created_by: DEF.id, updated_by: DEF.id, ...extra });
    const RECHAZOS = [
      ['cada 4 semanas', { week_interval: 4, week_anchor: '2026-11-24' }],
      ['cada 2 semanas sin «a partir del»', { week_interval: 2 }],
      ['«a partir del» sin cadencia', { week_anchor: '2026-11-24' }],
      ['mensual y cada N a la vez', { week_interval: 2, week_anchor: '2026-11-24', month_week: 1 }],
      ['mensual fuera de 1–5', { month_week: 6 }],
      ['cadencia en «días del mes»', { pattern: 'month_days', weekdays: null, month_days: [15], month_week: 1 }],
    ];
    for (const [que, extra] of RECHAZOS) {
      const e = await errorDe(trx, () => trx('commercial.purchase_review_rules').insert(fila(extra)));
      check(`el CHECK rechaza ${que} (23514)`, e?.code === '23514', e?.code || 'entró');
    }
    for (const [que, extra] of [['cada 6 semanas con ancla', { week_interval: 6, week_anchor: '2026-11-24' }], ['el último del mes', { month_week: 5 }]]) {
      const e = await errorDe(trx, async () => {
        await trx('commercial.purchase_review_rules').insert(fila(extra));
        await trx('commercial.purchase_review_rules').where({ tenant_id: TENANT, supplier_code: 'PQ321-CHK' }).del();
      });
      check(`el CHECK acepta ${que}`, e === null, e?.message);
    }

    // Desde aquí, como la API en producción.
    await trx.raw('SET LOCAL ROLE app_runtime');
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
    const hoy = await R.hoyMx(trx);
    const sucursales = await R.leerSucursales(trx);
    const zonas = [...new Set(sucursales.map((s) => s.zona_code).filter(Boolean))];
    if (zonas.length < 2) noMedido(`la base sólo tiene ${zonas.length} zona(s) en analytics.v_branch_zone tras sembrar`);
    const [Z1, Z2] = zonas.sort();
    const suc = (z) => sucursales.filter((s) => s.zona_code === z).map((s) => s.branch_code);
    const reglasDe = async (code) => trx('commercial.purchase_review_rules').where({ tenant_id: TENANT, supplier_code: code }).whereNull('deleted_at')
      .orderBy(['zone_code', 'branch_code']).select('id', 'scope', 'zone_code', 'branch_code', 'weekdays', 'week_interval', 'month_week',
        'reviewer_user_id', trx.raw(`to_char(week_anchor, 'YYYY-MM-DD') AS week_anchor`));

    // ── 2 · Varias zonas: una regla por zona, mismo patrón y cadencia; repetir reemplaza ─────────────────────────
    const captura = { supplier_code: P.code, scope: 'zone', zone_codes: [Z1, Z2], pattern: 'weekdays', weekdays: [2], week_interval: 2, week_anchor: hoy };
    const r1 = await R.guardarRegla(trx, TENANT, quien, captura);
    const f1 = await reglasDe(P.code);
    check(`${Z1} y ${Z2}, martes cada 2 semanas: DOS reglas creadas, una por zona, con la cadencia y la ancla`,
      r1.reglas.length === 2 && r1.reglas.every((x) => x.accion === 'creada') && JSON.stringify(r1.reglas.map((x) => x.lugar)) === JSON.stringify([Z1, Z2])
      && f1.length === 2 && f1.every((x) => x.scope === 'zone' && x.branch_code === null && Number(x.week_interval) === 2 && x.week_anchor === hoy
        && JSON.stringify((x.weekdays || []).map(Number)) === '[2]') && JSON.stringify(f1.map((x) => x.zone_code)) === JSON.stringify([Z1, Z2]),
      { r1, f1 });
    const r1b = await R.guardarRegla(trx, TENANT, quien, { ...captura, week_interval: null, week_anchor: null, month_week: 1 });
    const f1b = await reglasDe(P.code);
    check('repetir la captura con «una vez al mes» las REEMPLAZA (mismos ids, sin duplicar) y limpia la cadencia anterior',
      r1b.reglas.every((x) => x.accion === 'actualizada') && JSON.stringify(r1b.reglas.map((x) => x.id)) === JSON.stringify(r1.reglas.map((x) => x.id))
      && f1b.length === 2 && f1b.every((x) => x.week_interval === null && x.week_anchor === null && Number(x.month_week) === 1), { r1b, f1b });
    const S2 = suc(Z1).slice(0, 2);
    const r2 = await R.guardarRegla(trx, TENANT, quien, { supplier_code: P2.code, scope: 'branch', branch_codes: S2, pattern: 'weekdays', weekdays: [4] });
    check(`varias sucursales (${S2.join(', ')}): una regla por sucursal`,
      r2.reglas.length === 2 && JSON.stringify((await reglasDe(P2.code)).map((x) => x.branch_code)) === JSON.stringify(S2), r2);
    const eVacia = await errorDe(trx, () => R.guardarRegla(trx, TENANT, quien, { supplier_code: P2.code, scope: 'zone', zone_codes: [], pattern: 'weekdays', weekdays: [1] }));
    check('sin ninguna zona marcada → invalida «Elige al menos una zona.»', e2s(eVacia) === 'invalida:Elige al menos una zona.', e2s(eVacia));

    // ── 3 · ⛔ NEGATIVA: un lugar fuera del alcance de quien define → no se escribe NINGUNO ─────────────────────────
    // SIN savepoint a propósito: con uno, el rollback borraría la regla de Z1 aunque se hubiera escrito y la prueba no
    // distinguiría «se revisó antes» de «se escribió y se deshizo». El error es de la Suite (no de Postgres): la
    // transacción sigue viva y lo escrito antes del error seguiría ahí.
    const deZ1 = { userId: DEF.id, username: DEF.username ?? null, escribe: suc(Z1) };
    let eMedia = null;
    try { await R.guardarRegla(trx, TENANT, deZ1, { supplier_code: P3.code, scope: 'zone', zone_codes: [Z1, Z2], pattern: 'weekdays', weekdays: [1] }); }
    catch (e) { eMedia = e; }
    check(`quien sólo escribe en ${Z1} y marca ${Z1} y ${Z2}: fuera_de_alcance y NINGUNA regla escrita (ni la de ${Z1})`,
      eMedia?.tipo === 'fuera_de_alcance' && (await reglasDe(P3.code)).length === 0, { e: e2s(eMedia), filas: await reglasDe(P3.code) });

    // ── 4 · La cadencia de ida y vuelta por el calendario ───────────────────────────────────────────────────────
    await R.guardarRegla(trx, TENANT, quien, { supplier_code: P3.code, scope: 'corporate', pattern: 'weekdays', weekdays: [5], week_interval: 6, week_anchor: hoy });
    const reglas = await R.leerReglas(trx, TENANT);
    const de3 = reglas.find((x) => x.supplier_code === P3.code);
    const de1 = reglas.filter((x) => x.supplier_code === P.code);
    check('leerReglas devuelve la cadencia: cada 6 semanas con su ancla YYYY-MM-DD; las de zona, «una vez al mes» (el primero)',
      !!de3 && Number(de3.week_interval) === 6 && de3.week_anchor === hoy && de3.month_week === null
      && de1.length === 2 && de1.every((x) => Number(x.month_week) === 1 && x.week_interval === null), { de3, de1 });
    const eCad = await errorDe(trx, () => R.guardarRegla(trx, TENANT, quien, { supplier_code: P4.code, scope: 'corporate', pattern: 'weekdays', weekdays: [1], week_interval: 4, week_anchor: hoy }));
    check('cada 4 semanas se rechaza en llano ANTES de Postgres', e2s(eCad) === 'invalida:La cadencia es cada semana, cada 2, 3 o 6 semanas, o una vez al mes.', e2s(eCad));

    // ── 5 · El responsable ─────────────────────────────────────────────────────────────────────────────────────
    const posibles = await R.leerPosiblesResponsables(trx, TENANT);
    check(`leerPosiblesResponsables trae a ${RESP.username} (llave por ajuste personal) y deja fuera a ${SIN.username} (llave negada)`,
      posibles.some((p) => p.user_id === RESP.id) && !posibles.some((p) => p.user_id === SIN.id), posibles.map((p) => p.user_id));
    const S1 = suc(Z1)[0];
    const resp1 = { userId: RESP.id, escribe: [S1] };
    const rR = await R.guardarRegla(trx, TENANT, quien, { supplier_code: P4.code, scope: 'branch', branch_codes: [S1], pattern: 'weekdays', weekdays: [3], reviewer_user_id: RESP.id }, resp1);
    const filaR = (await reglasDe(P4.code))[0];
    check(`${RESP.username}, que escribe en ${S1}, queda como responsable de la regla de ${S1}`,
      rR.accion === 'creada' && filaR?.reviewer_user_id === RESP.id, filaR);
    const enCal = (await R.leerReglas(trx, TENANT)).find((x) => x.id === rR.id);
    check('el calendario nombra al responsable (reviewer_name)', enCal?.reviewer_name === RESP.nombre, enCal && enCal.reviewer_name);
    const antes = (await reglasDe(P4.code)).length;
    const eNoVe = await errorDe(trx, () => R.guardarRegla(trx, TENANT, quien,
      { supplier_code: P4.code, scope: 'zone', zone_codes: [Z1], pattern: 'weekdays', weekdays: [3], reviewer_user_id: RESP.id }, resp1));
    check(`⛔ NEGATIVA: el mismo, de la zona ${Z1} entera (no ve todas sus sucursales) → invalida «… no ve …», sin escribir`,
      eNoVe?.tipo === 'invalida' && /no ve/.test(eNoVe.message) && (await reglasDe(P4.code)).length === antes, e2s(eNoVe));
    const eSinLlave = await errorDe(trx, () => R.guardarRegla(trx, TENANT, quien,
      { supplier_code: P4.code, scope: 'corporate', pattern: 'weekdays', weekdays: [3], reviewer_user_id: SIN.id }, { userId: SIN.id, escribe: null }));
    check(`⛔ NEGATIVA: ${SIN.username} sin la llave de marcar → invalida «no tiene permiso de marcar»`,
      eSinLlave?.tipo === 'invalida' && /no tiene permiso de marcar/.test(eSinLlave.message), e2s(eSinLlave));
    const eSinAlcance = await errorDe(trx, () => R.guardarRegla(trx, TENANT, quien,
      { supplier_code: P4.code, scope: 'corporate', pattern: 'weekdays', weekdays: [3], reviewer_user_id: RESP.id }));
    check('⛔ NEGATIVA: sin el alcance del responsable resuelto por el servicio, falla (no supone «todas»)',
      !!eSinAlcance && !eSinAlcance.tipo && /sin alcance resuelto/.test(eSinAlcance.message), e2s(eSinAlcance));
    const eNoExiste = await errorDe(trx, () => R.guardarRegla(trx, TENANT, quien,
      { supplier_code: P4.code, scope: 'corporate', pattern: 'weekdays', weekdays: [3], reviewer_user_id: '00000000-0000-0000-0000-000000000001' }));
    check('una persona que no existe → invalida «no existe o ya no está activa»', eNoExiste?.tipo === 'invalida' && /no existe/.test(eNoExiste.message), e2s(eNoExiste));
  } finally {
    await trx.rollback();
    await knex.destroy();
  }
  console.log(`\n  ${ok} ✓ · ${ko} ✗ · ${nm} ○ NO MEDIDO`);
  if (ko) process.exit(1);
});

/** Un error, en una línea comparable: «tipo:mensaje». */
function e2s(e) {
  return e ? `${e.tipo ?? e.code ?? 'error'}:${e.message}` : 'sin error';
}
