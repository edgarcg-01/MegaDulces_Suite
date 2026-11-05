/* eslint-disable no-console */
/**
 * `[RD.110]` ¿La quincena está LISTA PARA PAGAR? — la revisión que se corre ANTES de aprobar.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────
 *
 * El 2026-11-04 Edgar suspendió D5 (FASE_RD §9.4bis): la Q22 la paga la suite el 5-nov, sin
 * las dos quincenas de control contra el libro. El automático `[RD.87]` la calcula a las 07:30
 * y la deja en BORRADOR, pero sus compuertas dejan pasar cosas que cambian lo que se deposita:
 *
 *   - la frescura pasa con que UNA ruta tenga el último día (`dataAsOf` = el máximo), y el
 *     automático sólo pide `fuente_estado = 'viva'` (3 días de tolerancia): medido el 4-nov a
 *     las 18:22, la 502 y la 504 no tenían el día y las dos salían `viva`;
 *   - la corrida es un valor CONGELADO: la venta que llega después de calcular no entra;
 *   - una ruta sin chofer en el padrón calcula una comisión que no le llega a nadie (la 505);
 *   - con D3 = opción A el supervisor se paga por fuera, pero su línea vive en la corrida y
 *     marcarla «pagada» la cubre entera (`[RD.108]`).
 *
 * Ninguna de esas cuatro da error. Ésta es la lista que una persona tendría que revisar a mano,
 * escrita para que la revise una máquina.
 *
 * ── Qué vigila ───────────────────────────────────────────────────────────────────────────
 *
 *   1. La quincena tiene UNA corrida viva (sin corrida: NO MEDIDO, todavía no se calculó).
 *   2. Cada ruta vigente tiene chofer en el padrón.
 *   3. Cada ruta vendió cada día que la empresa operó (día operado = vendió al menos la mitad
 *      de las rutas). Un día sin venta es una falta o un hueco de la fuente: el libro lo
 *      RELLENA con el promedio de las 3 semanas (VERDAD §32.6) y el motor no, así que se decide
 *      antes de aprobar, no después.
 *   4. La venta de cada línea de la corrida es la que la fuente tiene HOY (si no: recalcular con
 *      `replace`). Con su CONTROL: el mismo comparador contra la fuente sin un día TIENE que
 *      marcar — si no marca, el comparador no sirve y el verde de 4 no significa nada.
 *   5. El testigo independiente: la venta del día contra el corte de caja de la camioneta
 *      (Kepler `U-D-23`, Padre Hidalgo). Lo que difiere es AVISO; Canindo no tiene corte en el
 *      ODS y se DECLARA sin testigo, nunca verde.
 *   6. Aprobar y pagar tienen a alguien: cada llave en un rol con al menos un usuario activo.
 *   7. Lo que NO se paga desde la suite (D3 = A): el monto del supervisor, separado.
 *
 * Sólo lectura (transacción READ ONLY). Contra el CI no hay quincena real: declara NO MEDIDO.
 *
 *   ANIO=2026 QUINCENA=22 DATABASE_URL_NEW=… node database/tests/test-newdb-rd-quincena-lista-para-pagar.js
 *   (sin QUINCENA: la última que ya cerró)
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
// Almacén de la camioneta en Kepler (kdm1.c1) → ruta. Sólo Padre Hidalgo tiene corte U-D-23.
const CAMIONETA = { '01-001': '21', '01-002': '22', '01-003': '23', '01-004': '26', '01-005': '27', '01-006': '28' };

let ok = 0; let fail = 0; let nm = 0; let aviso = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };
const avisar = (label) => { aviso++; console.log(`  ⚠ AVISO · ${label}`); };
const peso = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Rutas cuya venta de la corrida no coincide con la fuente (tolerancia $1). */
function ventaMovida(lineas, fuentePorRuta) {
  return lineas
    .map((l) => ({ ruta: l.route_code, corrida: Number(l.venta), hoy: fuentePorRuta.get(l.route_code) ?? 0 }))
    .filter((x) => Math.abs(x.corrida - x.hoy) > 1);
}

(async () => {
  const db = new Client({ connectionString: URL, statement_timeout: 240000 });
  await db.connect();
  await db.query('BEGIN READ ONLY');

  const anio = process.env.ANIO ? Number(process.env.ANIO) : null;
  const qn = process.env.QUINCENA ? Number(process.env.QUINCENA) : null;
  const { rows: [p] } = await db.query(`
    SELECT id, anio, period_no, to_char(date_from,'YYYY-MM-DD') desde, to_char(date_to,'YYYY-MM-DD') hasta
      FROM commercial.commission_periods
     WHERE tenant_id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR period_no = $2) AND ($3::int IS NULL OR anio = $3)
       AND ($2::int IS NOT NULL OR date_to < current_date)
     ORDER BY date_from DESC LIMIT 1`, [TENANT, qn, anio]);
  if (!p) {
    noMedido('la quincena', 'no hay periodo que revisar en este destino (CI: base sin datos)');
    await db.query('ROLLBACK'); await db.end();
    console.log(`\n=== ${ok} OK · ${fail} fallas · ${nm} NO MEDIDOS · ${aviso} avisos ===\n`);
    process.exit(0);
  }
  console.log(`\nQ${p.period_no}/${p.anio} · ${p.desde} → ${p.hasta}`);

  // ── 1. La corrida ──────────────────────────────────────────────────────────────────────
  console.log('\n1) La corrida');
  const { rows: corridas } = await db.query(`
    SELECT id, status, origen, total_a_pagar, to_char(created_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') creada
      FROM commercial.commission_runs
     WHERE period_id = $1 AND deleted_at IS NULL AND status <> 'anulado'`, [p.id]);
  const run = corridas[0] ?? null;
  if (!run) noMedido('la corrida', 'la quincena todavía no tiene corrida (el automático corre a las 07:30)');
  else {
    check(`una sola corrida viva (${corridas.length})`, corridas.length === 1);
    console.log(`    ${run.status} · origen ${run.origen} · creada ${run.creada} · total ${peso(run.total_a_pagar)}`);
    check('la corrida es del motor, no una copia del libro', run.origen !== 'libro', 'origen = libro');
  }

  // ── 2. El padrón ───────────────────────────────────────────────────────────────────────
  console.log('\n2) Cada ruta vigente tiene chofer');
  const { rows: padron } = await db.query(`
    SELECT route_code, chofer_nombre, chofer_user_id
      FROM commercial.commission_route_config
     WHERE tenant_id = $1 AND deleted_at IS NULL
       AND (activo_desde IS NULL OR activo_desde <= $3::date)
       AND (activo OR (activo_hasta IS NOT NULL AND activo_hasta >= $2::date))
     ORDER BY route_code`, [TENANT, p.desde, p.hasta]);
  const rutas = padron.map((r) => r.route_code);
  check(`hay rutas vigentes (${rutas.length})`, rutas.length > 0);
  const sinChofer = padron.filter((r) => !r.chofer_nombre && !r.chofer_user_id).map((r) => r.route_code);
  check(`toda ruta vigente tiene chofer (${rutas.length - sinChofer.length} de ${rutas.length})`, sinChofer.length === 0,
    `sin chofer: ${sinChofer.join(', ')} — su comisión se calcula y no le llega a nadie`);

  // ── 3. Los días ────────────────────────────────────────────────────────────────────────
  console.log('\n3) Cada ruta vendió cada día que la empresa operó');
  const { rows: ventas } = await db.query(`
    SELECT route_code, business_date::text dia, venta::float8 venta
      FROM analytics.v_rd_commission_sales
     WHERE route_code = ANY($1) AND business_date BETWEEN $2 AND $3 AND venta > 0`, [rutas, p.desde, p.hasta]);
  const rutasPorDia = new Map();
  for (const v of ventas) rutasPorDia.set(v.dia, (rutasPorDia.get(v.dia) ?? new Set()).add(v.route_code));
  const operados = [...rutasPorDia].filter(([, s]) => s.size >= rutas.length / 2).map(([d]) => d).sort();
  const faltan = [];
  for (const d of operados) for (const r of rutas) if (!rutasPorDia.get(d).has(r)) faltan.push(`${r} el ${d}`);
  check(`días operados con venta de todas las rutas (${operados.length} días, ${rutas.length} rutas)`, faltan.length === 0,
    `${faltan.length} día(s)-ruta sin venta: ${faltan.join(' · ')} — ¿falta del chofer o hueco de la fuente? `
    + 'el libro los rellena y el motor no: decidir antes de aprobar');
  if (operados.at(-1) !== p.hasta) avisar(`el último día operado es ${operados.at(-1)}, no ${p.hasta} (¿domingo o no llegó?)`);

  // ── 4. La corrida contra la fuente de HOY ──────────────────────────────────────────────
  console.log('\n4) La venta de la corrida es la que la fuente tiene hoy');
  const fuentePorRuta = new Map();
  for (const v of ventas) fuentePorRuta.set(v.route_code, (fuentePorRuta.get(v.route_code) ?? 0) + v.venta);
  const lineas = run ? (await db.query(`
    SELECT route_code, beneficiario, beneficiario_nombre, venta::float8 venta, a_pagar::float8 a_pagar, motivo_no_pago
      FROM commercial.commission_run_lines WHERE run_id = $1 AND deleted_at IS NULL`, [run.id])).rows : [];
  // ⚠️ Sólo las rutas del padrón: la corrida también lleva una línea en $0 por cada código que
  // vende y no comisiona (1V001…, VEC-PH-H: `fuera_no_es_camion`), y esas no están en `ventas`.
  // Medido al estrenar la prueba sobre Q21: compararlas daba 8 rutas «movidas» que no lo estaban.
  const choferes = lineas.filter((l) => l.beneficiario === 'chofer' && rutas.includes(l.route_code));
  // CONTROL: quitarle a la fuente el último día de una ruta TIENE que mover esa ruta.
  const control = ventas.filter((v) => v.dia === operados.at(-1))[0];
  if (control) {
    const sinUnDia = new Map(fuentePorRuta);
    sinUnDia.set(control.route_code, sinUnDia.get(control.route_code) - control.venta);
    const base = [...fuentePorRuta].map(([route_code, venta]) => ({ route_code, venta }));
    const marcadas = ventaMovida(base, sinUnDia).map((x) => x.ruta);
    check(`CONTROL: el comparador marca la ruta a la que se le quitó un día (${control.route_code})`,
      marcadas.length === 1 && marcadas[0] === control.route_code, `marcó: ${marcadas.join(', ') || 'ninguna'}`);
  } else noMedido('el control del comparador', 'no hay venta en el periodo');
  if (!run) noMedido('la corrida contra la fuente', 'no hay corrida');
  else {
    const movidas = ventaMovida(choferes, fuentePorRuta);
    check(`ninguna ruta cambió de venta desde que se calculó (${choferes.length} líneas de chofer)`, movidas.length === 0,
      movidas.map((x) => `${x.ruta}: corrida ${peso(x.corrida)} · hoy ${peso(x.hoy)}`).join(' · ')
      + ' — recalcular con replace antes de aprobar');
    const noPagan = choferes.filter((l) => !(l.a_pagar > 0));
    if (noPagan.length) avisar(`líneas de chofer en $0: ${noPagan.map((l) => `${l.route_code} (${l.motivo_no_pago ?? 'sin motivo'})`).join(', ')}`);
  }

  // ── 5. El testigo independiente ────────────────────────────────────────────────────────
  console.log('\n5) La venta del día contra el corte de caja de la camioneta');
  const { rows: cortes } = await db.query(`
    SELECT btrim(c1) alm, c9::date::text dia, sum(c16)::float8 total
      FROM kepler_ods.kdm1
     WHERE c2 = 'U' AND c3 = 'D' AND c4 = 23 AND btrim(c1) = ANY($1) AND coalesce(c43, '') <> 'C'
       AND c9 >= $2::date AND c9 < $3::date + 1
     GROUP BY 1, 2`, [Object.keys(CAMIONETA), p.desde, p.hasta]).catch(() => ({ rows: null }));
  if (!cortes) noMedido('el corte de caja', 'kepler_ods.kdm1 no está en este destino');
  else {
    const corte = new Map(cortes.map((x) => [`${CAMIONETA[x.alm]}|${x.dia}`, x.total]));
    let alPeso = 0; let conTestigo = 0; let sinTestigo = 0; const difieren = [];
    for (const v of ventas) {
      const c = corte.get(`${v.route_code}|${v.dia}`);
      if (c == null) { sinTestigo++; continue; }
      conTestigo++;
      if (Math.abs(v.venta - c) <= 1) alPeso++;
      else difieren.push(`${v.route_code} el ${v.dia}: venta ${peso(v.venta)} · corte ${peso(c)}`);
    }
    if (conTestigo === 0) noMedido('el corte de caja', 'ningún día del periodo tiene corte');
    else check(`la mayoría de los días con corte cuadran al peso (${alPeso} de ${conTestigo})`, alPeso / conTestigo >= 0.9,
      'el testigo dejó de coincidir: revisar la fuente antes de pagar');
    for (const d of difieren) avisar(d);
    if (sinTestigo) noMedido(`${sinTestigo} día(s)-ruta sin corte`, 'se pagan con la venta del motor, sin testigo independiente (Canindo no tiene corte en el ODS)');
  }

  // ── 6. Aprobar y pagar tienen a alguien ────────────────────────────────────────────────
  console.log('\n6) Cada llave llegó a una persona activa');
  for (const llave of ['COMMERCIAL_COMMISSIONS_APROBAR', 'COMMERCIAL_COMMISSIONS_PAGAR']) {
    const { rows: [r] } = await db.query(`
      SELECT count(DISTINCT rp.role_name)::int roles, count(u.id)::int personas
        FROM role_permissions rp
        LEFT JOIN identity.users u ON u.role_name = rp.role_name AND u.tenant_id = $2
             AND u.deleted_at IS NULL AND u.activo IS TRUE AND u.role_name <> 'superadmin'
       WHERE rp.permissions -> $1 = 'true'::jsonb`, [llave, TENANT]);
    check(`${llave}: ${r.roles} rol(es), ${r.personas} persona(s) activa(s) fuera de superadmin`, r.personas >= 1);
  }

  // ── 7. Lo que la suite NO paga (D3 = opción A) ─────────────────────────────────────────
  console.log('\n7) Lo que se deposita desde la suite');
  if (!run) noMedido('el monto a depositar', 'no hay corrida');
  else {
    const suma = (ls) => ls.reduce((t, l) => t + (Number(l.a_pagar) || 0), 0);
    const sup = lineas.filter((l) => l.beneficiario !== 'chofer');
    console.log(`    choferes ${peso(suma(choferes))} en ${choferes.filter((l) => l.a_pagar > 0).length} depósito(s)`);
    if (sup.length) avisar(`${sup.length} línea(s) de supervisor por ${peso(suma(sup))}: NO se depositan desde la suite (D3 = A); `
      + 'marcar la corrida «pagada» las cubre igual ([RD.108])');
  }

  await db.query('ROLLBACK');
  await db.end();
  console.log(`\n=== ${ok} OK · ${fail} fallas · ${nm} NO MEDIDOS · ${aviso} avisos ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
