/* eslint-disable no-console */
/**
 * `[PQ.3.1]` — La propuesta del ERP para el calendario de compras (`commercial.v_purchase_calendar_proposal`,
 * mig 20261110015037). Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_CALENDARIO_COMPRAS.md`.
 *
 * El SQL NO se copia: se importa de la migración (`exports.SQL.cuerpo`), así que lo que se prueba es lo
 * que se aplica.
 *
 *   A · SINTÉTICO — corre en cualquier Postgres (también la base vacía del CI, que no tiene Kepler):
 *       el cuerpo de la vista sobre un `VALUES` con casos armados. La ronda se acota desde su INICIO
 *       (4 d junta, 5 d separa; una compra diaria de 60 días son 12 rondas pegadas = compra continua,
 *       no «una compra»), la cancelada no cuenta, la ventana de 365 d con su frontera exacta, la mediana
 *       par (17.5 → 18), las sucursales propias (TI) fuera, el otro tenant invisible y SIN
 *       `app.tenant_id` 0 filas.
 *   B · PRUEBA NEGATIVA — ocho mutantes del SQL real; cada uno TIENE que poner rojo al bloque A. Si un
 *       mutante pasa, el bloque A es decorativo. No se cubre: «hoy» en UTC en vez de la hora de México
 *       (sólo se distingue de 18:00 a 24:00; DECLARADO, no probado).
 *   C · REAL — sólo si `analytics.erp_purchase_orders` existe Y tiene OC en la ventana (prod, SÓLO
 *       LECTURA; la base del CI la tiene vacía → NO MEDIDO, no rojo): invariantes sobre
 *       todos los proveedores, < 500 ms, un CRUCE contra otra implementación (la regla recalculada en JS
 *       desde las OC crudas) y `supplier_record` contra `catalog.suppliers` leído aparte, con su mutante.
 *       Si la vista ya está aplicada, paridad vista = cuerpo.
 *
 *   node database/tests/test-newdb-calendario-compras-propuesta.js
 */
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');
const mig = require('../migrations-newdb/20261110015037_pq3_1_calendario_compras_propuesta.js');

const { cuerpo, JUNTA_DIAS, MIN_RONDAS, VENTANA_DIAS, HOY, SUCURSAL_PROPIA } = mig.SQL;
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000b2';
const URL = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;

const fallos = [];
let ok = 0;
const chk = (cond, msg) => { if (cond) ok++; else fallos.push(msg); };

/** Suma días a 'YYYY-MM-DD' en UTC (sin zona: las fechas del ERP son días, no instantes). */
function masDias(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dif = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5;
const mediana = (g) => {
  if (!g.length) return null;
  const s = [...g].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Los casos: [tenant, clave, desfase en días respecto de hoy (MX), sucursal, folio, estatus]. */
const CASOS = [
  // P1 · 4 rondas a 30 d; la 1a junta 3 OC (-100, -99, -97: dentro de 4 d desde -100) y la última 2.
  [MEGA, 'ZZT_P1', -100, '00', 'P1a', 'F'], [MEGA, 'ZZT_P1', -99, '01', 'P1b', 'F'], [MEGA, 'ZZT_P1', -97, '02', 'P1c', 'F'],
  [MEGA, 'ZZT_P1', -70, '00', 'P1d', 'F'], [MEGA, 'ZZT_P1', -40, '00', 'P1e', 'R'],
  [MEGA, 'ZZT_P1', -10, '00', 'P1f', 'N'], [MEGA, 'ZZT_P1', -9, '01', 'P1g', 'N'],
  // P2 · frontera desde el INICIO: -46 está a 4 d de -50 (junta), -41 a 9 d (abre) → 2 rondas.
  [MEGA, 'ZZT_P2', -50, '00', 'P2a', 'F'], [MEGA, 'ZZT_P2', -46, '00', 'P2b', 'F'], [MEGA, 'ZZT_P2', -41, '00', 'P2c', 'F'],
  // P3 · la cancelada no cuenta: con ella serían 4 rondas (propuesto); sin ella, 3 (pocas compras).
  [MEGA, 'ZZT_P3', -90, '00', 'P3a', 'C'], [MEGA, 'ZZT_P3', -60, '00', 'P3b', 'F'],
  [MEGA, 'ZZT_P3', -30, '00', 'P3c', 'F'], [MEGA, 'ZZT_P3', -1, '00', 'P3d', 'N'],
  // P4 · ventana: -400 queda fuera y +3 (futuro) también → 1 ronda.
  [MEGA, 'ZZT_P4', -400, '00', 'P4a', 'F'], [MEGA, 'ZZT_P4', -200, '00', 'P4b', 'F'], [MEGA, 'ZZT_P4', 3, '00', 'P4c', 'N'],
  // P5 · otro tenant: no se ve con el tenant de Mega Dulces.
  [OTRO, 'ZZT_P5', -100, '00', 'P5a', 'F'], [OTRO, 'ZZT_P5', -70, '00', 'P5b', 'F'],
  [OTRO, 'ZZT_P5', -40, '00', 'P5c', 'F'], [OTRO, 'ZZT_P5', -10, '00', 'P5d', 'F'],
  // P6 · mediana par: intervalos 10, 15, 20, 25 → 17.5 → propone 18.
  [MEGA, 'ZZT_P6', -100, '06', 'P6a', 'F'], [MEGA, 'ZZT_P6', -90, '06', 'P6b', 'F'], [MEGA, 'ZZT_P6', -75, '06', 'P6c', 'F'],
  [MEGA, 'ZZT_P6', -55, '06', 'P6d', 'F'], [MEGA, 'ZZT_P6', -30, '06', 'P6e', 'F'],
  // P9 · frontera exacta de la ventana: hoy−365 queda FUERA; sólo cuenta -100 → 1 ronda.
  [MEGA, 'ZZT_P9', -VENTANA_DIAS, '00', 'P9a', 'F'], [MEGA, 'ZZT_P9', -100, '00', 'P9b', 'F'],
  // P10 · clave de sucursal propia (traspaso interno): no entra aunque tenga 4 rondas.
  [MEGA, 'TI003', -100, '00', 'P10a', 'F'], [MEGA, 'TI003', -70, '00', 'P10b', 'F'],
  [MEGA, 'TI003', -40, '00', 'P10c', 'F'], [MEGA, 'TI003', -10, '00', 'P10d', 'F'],
];
// P8 · compra diaria 60 días (-70 … -11): 12 rondas pegadas de 5 días = compra continua, sin ciclo.
for (let d = -70; d <= -11; d++) CASOS.push([MEGA, 'ZZT_P8', d, d % 2 ? '00' : '01', `P8_${-d}`, 'F']);
// P7 · sin clave de proveedor: no entra (va aparte porque la clave es NULL).
const SIN_CLAVE = `('${MEGA}'::uuid, NULL::text, 'SIN CLAVE', ${HOY} - 5, '00', 'P7a', 'F')`;

function fuenteSintetica() {
  const filas = CASOS.map(([t, c, d, s, f, e]) =>
    `('${t}'::uuid, '${c}'::text, 'PROV ${c}'::text, ${HOY} + (${d}), '${s}'::text, '${f}'::text, '${e}'::text)`);
  filas.push(SIN_CLAVE);
  return `(SELECT * FROM (VALUES ${filas.join(',\n')})
            AS v(tenant_id, proveedor_code, proveedor_nombre, doc_date, sucursal, folio, estatus))`;
}

/** Corre un cuerpo y devuelve sus filas con fechas como texto. */
async function correr(db, sqlCuerpo) {
  return (await db.query(`
    SELECT supplier_code, supplier_name, supplier_record, proposal_status, rounds_12m, order_days_12m,
           cycle_days_median::float AS mediana, cycle_days_proposed,
           last_order_date::text AS last_order_date, last_round_date::text AS last_round_date,
           next_date_proposed::text AS next_date_proposed, last_round_orders, branches_12m
      FROM (${sqlCuerpo}) x ORDER BY supplier_code`)).rows;
}

/** Las aserciones del bloque A sobre un resultado. Devuelve la lista de fallas (no toca `fallos`). */
function asercionesA(rows, hoy) {
  const f = [];
  const by = Object.fromEntries(rows.map((r) => [r.supplier_code, r]));
  const p1 = by.ZZT_P1;
  if (!p1) f.push('P1 no salió');
  else {
    if (p1.rounds_12m !== 4) f.push(`P1: ${p1.rounds_12m} rondas (esperaba 4: -100/-99/-97 es UNA)`);
    if (p1.order_days_12m !== 7) f.push(`P1: ${p1.order_days_12m} días con OC (esperaba 7)`);
    if (p1.mediana !== 30 || p1.cycle_days_proposed !== 30) f.push(`P1: mediana ${p1.mediana} / ciclo ${p1.cycle_days_proposed} (esperaba 30 / 30)`);
    if (p1.proposal_status !== 'propuesto') f.push(`P1: estado ${p1.proposal_status}`);
    if (p1.last_round_date !== masDias(hoy, -10)) f.push(`P1: última ronda ${p1.last_round_date} (esperaba ${masDias(hoy, -10)})`);
    if (p1.last_order_date !== masDias(hoy, -9)) f.push(`P1: última OC ${p1.last_order_date} (esperaba ${masDias(hoy, -9)})`);
    if (p1.next_date_proposed !== masDias(hoy, 20)) f.push(`P1: próxima ${p1.next_date_proposed} (esperaba ${masDias(hoy, 20)})`);
    const ult = (p1.last_round_orders || []).map((o) => `${o.sucursal}/${o.folio}`).join(',');
    if (ult !== '00/P1f,01/P1g') f.push(`P1: última ronda trae «${ult}» (esperaba 00/P1f,01/P1g)`);
    if ((p1.branches_12m || []).join(',') !== '00,01,02') f.push(`P1: sucursales ${p1.branches_12m}`);
    if (p1.supplier_record !== 'sin_ficha') f.push(`P1: supplier_record ${p1.supplier_record} (clave inventada: esperaba sin_ficha)`);
  }
  const p2 = by.ZZT_P2;
  if (!p2 || p2.rounds_12m !== 2) f.push(`P2: ${p2 && p2.rounds_12m} rondas (esperaba 2: a 4 d del inicio junta, a 9 d abre)`);
  else {
    if (p2.proposal_status !== 'pocas_compras') f.push(`P2: estado ${p2.proposal_status}`);
    if (p2.cycle_days_proposed !== null || p2.next_date_proposed !== null) f.push('P2: con menos de 4 rondas no debe proponer ciclo ni fecha');
    if (p2.mediana !== 9) f.push(`P2: mediana ${p2.mediana} (esperaba 9)`);
  }
  const p3 = by.ZZT_P3;
  if (!p3 || p3.rounds_12m !== 3) f.push(`P3: ${p3 && p3.rounds_12m} rondas (esperaba 3: la cancelada no cuenta)`);
  else if (p3.proposal_status !== 'pocas_compras' || p3.cycle_days_proposed !== null || p3.next_date_proposed !== null) {
    f.push(`P3: con 3 rondas salió ${p3.proposal_status} / ciclo ${p3.cycle_days_proposed} (esperaba pocas_compras sin ciclo: el mínimo es ${MIN_RONDAS})`);
  }
  const p4 = by.ZZT_P4;
  if (!p4 || p4.rounds_12m !== 1) f.push(`P4: ${p4 && p4.rounds_12m} rondas (esperaba 1: fuera de ${VENTANA_DIAS} d y el futuro no cuentan)`);
  else if (p4.proposal_status !== 'una_compra' || p4.mediana !== null) f.push(`P4: estado ${p4.proposal_status}, mediana ${p4.mediana}`);
  if (by.ZZT_P5) f.push('P5: se ve un proveedor de OTRO tenant');
  const p6 = by.ZZT_P6;
  if (!p6 || p6.mediana !== 17.5 || p6.cycle_days_proposed !== 18) f.push(`P6: mediana ${p6 && p6.mediana} / propuesto ${p6 && p6.cycle_days_proposed} (esperaba 17.5 / 18)`);
  if (rows.some((r) => r.supplier_code === null)) f.push('P7: entró una OC sin clave de proveedor');
  const p8 = by.ZZT_P8;
  if (!p8) f.push('P8 no salió');
  else {
    if (p8.rounds_12m !== 12) f.push(`P8: compra diaria de 60 días dio ${p8.rounds_12m} rondas (esperaba 12: la ronda se acota desde su INICIO)`);
    if (p8.proposal_status !== 'compra_continua') f.push(`P8: estado ${p8.proposal_status} (esperaba compra_continua)`);
    if (p8.cycle_days_proposed !== null || p8.next_date_proposed !== null) f.push('P8: una compra continua no publica ciclo ni fecha');
    if (p8.order_days_12m !== 60) f.push(`P8: ${p8.order_days_12m} días con OC (esperaba 60)`);
    if ((p8.last_round_orders || []).length !== 5) f.push(`P8: la última ronda trae ${(p8.last_round_orders || []).length} OC (esperaba 5: -15 … -11)`);
  }
  const p9 = by.ZZT_P9;
  if (!p9 || p9.rounds_12m !== 1) f.push(`P9: ${p9 && p9.rounds_12m} rondas (esperaba 1: hoy−${VENTANA_DIAS} queda FUERA)`);
  if (by.TI003) f.push('P10: entró una sucursal propia (TI003) como proveedor');
  if (rows.length !== 7) f.push(`salieron ${rows.length} proveedores (esperaba 7: P1, P2, P3, P4, P6, P8, P9)`);
  return f;
}

/** La regla, recalculada en JS desde las OC crudas: OTRA implementación de la misma definición. */
function reglaJs(dias) {
  const inicios = [];
  let ini = null;
  for (const d of dias) if (ini === null || dif(ini, d) > JUNTA_DIAS) { ini = d; inicios.push(d); }
  const gaps = inicios.slice(1).map((d, i) => dif(inicios[i], d));
  return { rondas: inicios.length, med: mediana(gaps) };
}

(async () => {
  if (!URL) noMedido('falta DATABASE_URL_NEW');
  const db = new Client({ connectionString: URL, statement_timeout: 120000 });
  try { await db.connect(); } catch (e) {
    if (esFaltaDeAcceso(e)) noMedido(`sin acceso a la base (${e.code || e.message})`);
    throw e;
  }
  console.log(`\n=== [PQ.3.1] propuesta del calendario de compras (ronda ≤ ${JUNTA_DIAS} d desde su inicio, ${MIN_RONDAS}+ rondas) ===\n`);
  const pre = (await db.query(`SELECT to_regprocedure('public.current_tenant_id()') AS fn, to_regclass('catalog.suppliers') AS sup,
                                      ${HOY}::text AS hoy`)).rows[0];
  if (!pre.fn || !pre.sup) noMedido('falta public.current_tenant_id() o catalog.suppliers en esta base');
  const hoy = pre.hoy;

  // ── A · sintético ──────────────────────────────────────────────────────────────────────────
  // Sin tenant = cadena VACÍA, no `RESET`: el usuario de lectura de prod trae `app.tenant_id` por
  // defecto en su rol, y `RESET` lo restaura (medido 2026-11-10: la prueba dio 5 filas «sin tenant»).
  const sinTenantSql = `SELECT set_config('app.tenant_id', '', false)`;
  await db.query(sinTenantSql);
  const sinTenant = await correr(db, cuerpo(fuenteSintetica()));
  chk(sinTenant.length === 0, `A: sin app.tenant_id salieron ${sinTenant.length} filas (debe fallar CERRADO: 0)`);
  await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [MEGA]);
  const filasA = await correr(db, cuerpo(fuenteSintetica()));
  const fa = asercionesA(filasA, hoy);
  fa.forEach((m) => fallos.push(`A: ${m}`));
  if (!fa.length) ok++;
  console.log(`  A · sintético: ${filasA.length} proveedores, ${fa.length} fallas · sin tenant: ${sinTenant.length} filas`);

  // ── B · prueba negativa: cada mutante TIENE que fallar el bloque A ─────────────────────────
  const original = cuerpo(fuenteSintetica());
  const corte = `dias[i + 1] - inicio > ${JUNTA_DIAS}`;
  const mutantes = [
    ['cuenta las canceladas', original.replace(`AND f.estatus <> 'C'`, '')],
    ['frontera ≥ en vez de >', original.replace(corte, `dias[i + 1] - inicio >= ${JUNTA_DIAS}`)],
    ['ronda ENCADENADA (contra el día anterior)', original.replace(corte, `dias[i + 1] - dias[i] > ${JUNTA_DIAS}`)],
    ['sin ventana de días', original.replace(`AND f.doc_date > ${HOY} - ${VENTANA_DIAS}`, '')],
    ['ventana ≥ en vez de >', original.replace(`f.doc_date > ${HOY} - ${VENTANA_DIAS}`, `f.doc_date >= ${HOY} - ${VENTANA_DIAS}`)],
    ['sin excluir sucursales propias', original.replace(`AND f.proveedor_code !~ ${SUCURSAL_PROPIA}`, '')],
    [`mínimo de ${MIN_RONDAS - 1} rondas`, original.split(`r.rounds_12m >= ${MIN_RONDAS}`).join(`r.rounds_12m >= ${MIN_RONDAS - 1}`)],
    ['sin filtro de tenant', original.replace(`f.tenant_id = public.current_tenant_id()`, 'true')],
  ];
  for (const [nombre, sqlMut] of mutantes) {
    if (sqlMut === original) { fallos.push(`B: el mutante «${nombre}» no cambió el SQL (¿se movió el texto?)`); continue; }
    const fm = asercionesA(await correr(db, sqlMut), hoy);
    chk(fm.length > 0, `B: el mutante «${nombre}» pasó el bloque A: esa regla no está probada`);
    console.log(`  B · mutante «${nombre}»: ${fm.length ? `ROJO (${fm[0]})` : '⚠ VERDE'}`);
  }

  // ── C · real (sólo lectura) ────────────────────────────────────────────────────────────────
  const fuente = (await db.query(`SELECT to_regclass('analytics.erp_purchase_orders') AS t,
                                         to_regclass('commercial.v_purchase_calendar_proposal') AS v`)).rows[0];
  // La base del CI SÍ tiene la vista fuente (y aplica la migración), pero vacía: sin OC no hay con
  // qué comparar, y eso es NO MEDIDO, no rojo (medido en el CI del PR #522, 2026-11-10).
  const ocsEnVentana = fuente.t ? (await db.query(`
    SELECT count(*)::int AS n FROM analytics.erp_purchase_orders
     WHERE tenant_id = $1 AND doc_date > ${HOY} - ${VENTANA_DIAS} AND doc_date <= ${HOY}`, [MEGA])).rows[0].n : 0;
  if (!fuente.t) {
    console.log('\n  ⓘ C · NO MEDIDO — esta base no tiene analytics.erp_purchase_orders (sin réplica de Kepler).');
  } else if (ocsEnVentana === 0) {
    console.log(`\n  ⓘ C · NO MEDIDO — analytics.erp_purchase_orders existe pero no tiene OC en los últimos ${VENTANA_DIAS} días`
      + ` (base sin datos del ERP)${fuente.v ? '; la vista sí está aplicada' : ''}: no hay con qué comparar.`);
  } else {
    const t0 = Date.now();
    const reales = await correr(db, cuerpo('analytics.erp_purchase_orders'));
    const ms = Date.now() - t0;
    chk(reales.length > 0, 'C: la propuesta real salió vacía');
    chk(ms < 500, `C: la propuesta tardó ${ms} ms (regla: > 500 ms no funciona)`);
    const malas = reales.filter((r) => {
      const prop = r.proposal_status === 'propuesto';
      const ult = r.last_round_orders || [];
      return r.rounds_12m < 1 || r.order_days_12m < r.rounds_12m
        || (prop !== (r.cycle_days_proposed !== null))
        || (prop && r.next_date_proposed !== masDias(r.last_round_date, r.cycle_days_proposed))
        || (prop && r.next_date_proposed <= r.last_order_date)
        || (r.proposal_status === 'compra_continua' && r.rounds_12m < MIN_RONDAS)
        || !ult.length || ult.some((o) => o.fecha < r.last_round_date || dif(r.last_round_date, o.fecha) > JUNTA_DIAS)
        || r.last_order_date < r.last_round_date
        || !(r.branches_12m || []).length
        || new RegExp(SUCURSAL_PROPIA.slice(1, -1)).test(r.supplier_code)
        || !['ficha_viva', 'ficha_borrada', 'sin_ficha'].includes(r.supplier_record);
    });
    chk(malas.length === 0, `C: ${malas.length} proveedores rompen un invariante (ej: ${malas.slice(0, 3).map((r) => r.supplier_code).join(', ')})`);

    // Cruce contra OTRA implementación: la regla recalculada en JS desde las OC crudas.
    const crudas = (await db.query(`
      SELECT proveedor_code AS c, doc_date::text AS d FROM analytics.erp_purchase_orders
       WHERE tenant_id = $1 AND estatus <> 'C' AND proveedor_code IS NOT NULL AND proveedor_code !~ ${SUCURSAL_PROPIA}
         AND doc_date > ${HOY} - ${VENTANA_DIAS} AND doc_date <= ${HOY}
       GROUP BY 1, 2 ORDER BY 1, 2`, [MEGA])).rows;
    const porProv = new Map();
    for (const { c, d } of crudas) { if (!porProv.has(c)) porProv.set(c, []); porProv.get(c).push(d); }
    let distintos = 0; const ejemplos = [];
    for (const r of reales) {
      const js = reglaJs(porProv.get(r.supplier_code) || []);
      if (js.rondas !== r.rounds_12m || (js.med === null ? r.mediana !== null : Math.abs(js.med - r.mediana) > 0.05)) {
        distintos++; if (ejemplos.length < 3) ejemplos.push(`${r.supplier_code} SQL ${r.rounds_12m}/${r.mediana} JS ${js.rondas}/${js.med}`);
      }
    }
    chk(porProv.size === reales.length, `C: el JS ve ${porProv.size} proveedores y el SQL ${reales.length}`);
    chk(distintos === 0, `C: ${distintos} proveedores con rondas o mediana distintas entre SQL y JS (${ejemplos.join(' · ')})`);

    // supplier_record contra catalog.suppliers leído APARTE (y su mutante: viva ↔ borrada).
    const fichas = new Map((await db.query(`SELECT code, deleted_at IS NOT NULL AS borrada FROM catalog.suppliers
                                             WHERE tenant_id = $1 AND code = ANY($2)`, [MEGA, reales.map((r) => r.supplier_code)])).rows
      .map((x) => [x.code, x.borrada ? 'ficha_borrada' : 'ficha_viva']));
    const discrepa = (rs) => rs.filter((r) => (fichas.get(r.supplier_code) || 'sin_ficha') !== r.supplier_record);
    chk(discrepa(reales).length === 0, `C: ${discrepa(reales).length} proveedores con supplier_record distinto de catalog.suppliers`);
    const mutFicha = cuerpo('analytics.erp_purchase_orders').replace(`WHEN s.deleted_at IS NULL THEN 'ficha_viva'`, `WHEN s.deleted_at IS NOT NULL THEN 'ficha_viva'`);
    const ficharojo = mutFicha !== cuerpo('analytics.erp_purchase_orders') && discrepa(await correr(db, mutFicha)).length > 0;
    chk(ficharojo, 'C: el mutante «viva ↔ borrada» pasó el cruce de supplier_record');

    const cuenta = (k, v) => reales.filter((r) => r[k] === v).length;
    console.log(`  C · real: ${reales.length} proveedores en ${ms} ms · propuesto ${cuenta('proposal_status', 'propuesto')}`
      + ` · compra_continua ${cuenta('proposal_status', 'compra_continua')} · pocas_compras ${cuenta('proposal_status', 'pocas_compras')}`
      + ` · una_compra ${cuenta('proposal_status', 'una_compra')}`);
    console.log(`           ficha viva ${cuenta('supplier_record', 'ficha_viva')} · ficha BORRADA ${cuenta('supplier_record', 'ficha_borrada')}`
      + ` · sin ficha ${cuenta('supplier_record', 'sin_ficha')} · cruce SQL↔JS: ${distintos} distintos · supplier_record vs catálogo:`
      + ` ${discrepa(reales).length} distintos (mutante ${ficharojo ? 'ROJO' : '⚠ VERDE'})`);

    if (fuente.v) {
      const vista = (await db.query(`SELECT supplier_code, rounds_12m, cycle_days_proposed, next_date_proposed::text AS n
                                       FROM commercial.v_purchase_calendar_proposal ORDER BY supplier_code`)).rows;
      const firma = (rs) => rs.map((r) => `${r.supplier_code}|${r.rounds_12m}|${r.cycle_days_proposed}|${r.n ?? r.next_date_proposed}`).join('\n');
      chk(firma(vista) === firma(reales), 'C: la vista aplicada no dice lo mismo que el cuerpo de la migración');
      await db.query(sinTenantSql);
      const vSin = (await db.query(`SELECT count(*)::int AS n FROM commercial.v_purchase_calendar_proposal`)).rows[0].n;
      chk(vSin === 0, `C: la vista aplicada da ${vSin} filas sin app.tenant_id`);
      console.log(`  C · vista aplicada: paridad con el cuerpo ${firma(vista) === firma(reales) ? 'OK' : 'DISTINTA'} · sin tenant ${vSin} filas`);
    } else {
      console.log('  ⓘ la vista todavía no está aplicada en esta base: se probó el cuerpo de la migración.');
    }
  }

  await db.end();
  console.log(`\n  ${ok} verificaciones OK · ${fallos.length} fallas`);
  if (fallos.length) { fallos.forEach((m) => console.log(`  ❌ ${m}`)); process.exit(1); }
  console.log('  ✅ [PQ.3.1] propuesta del calendario de compras');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
