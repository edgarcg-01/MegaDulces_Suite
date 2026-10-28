/* eslint-disable no-console */
/**
 * `[RD.93]` — **El libro contra el motor, para UNA quincena que el motor ya calculó.**
 *
 * ── Por qué no alcanza la pestaña «Libro vs motor» ────────────────────────────────────────
 * Esa pestaña (`[RD.52]`, vista `analytics.v_rd_commission_contrast`) cruza el libro YA
 * CARGADO como corrida (`origen = 'libro'`, Q1–Q20) contra una simulación del motor. Desde Q21
 * es al revés: la corrida viva la produjo el MOTOR, y el libro —el Excel que sigue armando
 * Comercial— llega después. Cargarlo como corrida no se puede (`una_viva_por_periodo`) y no
 * se debe (sería otra copia del mismo hecho). Así que esto LEE los dos y no escribe nada:
 *
 *     libro  ← el Excel, con el MISMO lector que el espejo (`lib/libro-comisiones-rd.js`)
 *     motor  ← `commercial.commission_run_lines` de la corrida viva de esa quincena, en prod
 *
 * ⭐ El veredicto es el de la vista, copiado regla por regla (migración
 * `20261008130558_rd_commission_contraste_motor.js`): ≤ $1 cuadra, ≤ 5 % difiere poco, y
 * «el motor no paga» / «sólo el motor paga» aparte porque son el acantilado del tabulador y se
 * arreglan distinto. ⚠️ Si la vista cambia su regla, esto también.
 *
 * ── Lo que NO compara, y lo declara ──────────────────────────────────────────────────────
 * ⛔ **El supervisor.** El libro le paga dos cosas distintas a dos supervisores (encabezado de
 * `cargar-libro-comisiones-rd.js`) y la deducción por persona no está cargada (`[RD.91]`,
 * decisión D3). Se imprime lado a lado, como información, sin veredicto.
 * ⚠️ **Los bonos del libro son DERIVADOS** de la venta con la regla del recibo, no leídos.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────────────────────
 *     node database/scripts/comparar-libro-motor-rd.js "<ruta>/INDICADORES RD 2026.xlsx" --q 21
 *          [--csv <salida.csv>]   una fila por ruta, para mandarla
 *          [--q-motor N]          SÓLO para el control negativo: libro de Q contra motor de N
 *
 * Controles (corridos el 2026-10-28 contra prod, con el libro del 8-oct que trae Q1–Q20):
 *   · positivo: `--q 20` cruza el libro contra su propio espejo → **10 de 10 cuadran**, total
 *     $47,264.40 = el `total_a_pagar` de la corrida de Q20.
 *   · negativo: `--q 19 --q-motor 20` → **0 de 11 cuadran**, Δ $16,617.50. Si un día sale
 *     verde, el cruce dejó de mirar.
 *   · `--q 21` con ese libro → sale con código 2: «el libro NO trae Q21».
 */
'use strict';

const fs = require('fs');
const path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env'), quiet: true });
const { resolverProd } = require('./lib/destino-prod');
const { leerLibro } = require('./lib/libro-comisiones-rd');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ANIO = 2026;
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ARCHIVO = process.argv.find((a) => /\.xlsx$/i.test(a));
const Q = Number(arg('--q'));
const Q_MOTOR = arg('--q-motor') ? Number(arg('--q-motor')) : Q;
const CSV = arg('--csv');

const n = (x) => (x === null || x === undefined ? null : Number(x));
const money = (x) => (x === null ? '—' : x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const r2 = (x) => Math.round(x * 100) / 100;

/** El veredicto de `v_rd_commission_contrast`, regla por regla y en el mismo orden. */
function veredicto(lib, mot) {
  if (!mot) return 'sin_linea_del_motor';
  if (!lib) return 'solo_el_motor';
  if (lib.motivo_no_pago && mot.motivo_no_pago) return 'ninguno_paga';
  if (lib.motivo_no_pago) return 'solo_el_motor_paga';
  if (mot.motivo_no_pago) return 'el_motor_no_paga';
  const d = Math.abs(mot.a_pagar - lib.a_pagar);
  if (d <= 1) return 'cuadra';
  if (lib.a_pagar !== 0 && d <= Math.abs(lib.a_pagar) * 0.05) return 'difiere_poco';
  return 'difiere';
}

/** La causa, también la de la vista: la cobertura de días o nada — no se adivina. */
function causa(mot) {
  if (!mot) return null;
  if (mot.dias_con_venta === null || mot.dias_esperados === null) return 'cobertura_no_medida';
  if (mot.dias_con_venta < mot.dias_esperados) return 'faltan_dias_en_la_fuente';
  return 'sin_explicar';
}

(async () => {
  if (!ARCHIVO || !Number.isInteger(Q)) {
    throw new Error('uso: comparar-libro-motor-rd.js "<libro>.xlsx" --q <quincena> [--csv salida.csv]');
  }

  // ── El libro ──────────────────────────────────────────────────────────────────────────────
  const { filas } = await leerLibro(ARCHIVO);
  const trae = [...new Set(filas.map((f) => f.periodo))].sort((a, b) => a - b);
  const libro = filas.filter((f) => f.periodo === Q);
  console.log(`\n=== [RD.93] libro contra motor · Q${Q}${Q_MOTOR !== Q ? ` (motor de Q${Q_MOTOR} — CONTROL)` : ''} ===`);
  console.log(`libro: ${path.basename(ARCHIVO)} · trae Q${trae[0]}–Q${trae[trae.length - 1]} (${trae.length} quincenas con dato)`);
  if (!libro.length) {
    console.log(`\n⛔ El libro NO trae Q${Q}. No hay nada que comparar todavía: falta la versión del Excel con esa quincena.\n`);
    process.exit(2);
  }

  // ── El motor, en prod y en sólo lectura ───────────────────────────────────────────────────
  const db = await resolverProd();
  try {
    const run = (await db.raw(
      `SELECT r.id, r.status, r.origen, to_char(r.updated_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') AS calculada,
              to_char(p.date_from, 'YYYY-MM-DD') AS desde, to_char(p.date_to, 'YYYY-MM-DD') AS hasta,
              r.total_a_pagar, r.total_neto, r.gates
         FROM commercial.commission_periods p
         JOIN commercial.commission_runs r
           ON r.period_id = p.id AND r.deleted_at IS NULL AND r.status <> 'anulado'
        WHERE p.tenant_id = ? AND p.anio = ? AND p.period_no = ? AND p.deleted_at IS NULL`,
      [TENANT, ANIO, Q_MOTOR])).rows[0];
    if (!run) {
      console.log(`\n⛔ Q${Q_MOTOR} no tiene corrida viva en prod. Primero hay que calcularla («Calcular desde»).\n`);
      process.exit(2);
    }
    const ded = (run.gates || []).find((g) => g.gate === 'deduccion_configurada');
    console.log(`motor: corrida ${run.id.slice(0, 8)} · ${run.status} · origen ${run.origen} · calculada ${run.calculada} · ${run.desde} a ${run.hasta}`);
    if (ded) console.log(`       compuerta deduccion_configurada: ${ded.estado} — ${ded.detalle}`);
    if (run.origen === 'libro') {
      console.log('  ⚠️ Esta corrida ES el espejo del libro: el cruce es un CONTROL del instrumento, no un contraste.');
    }

    const lineas = (await db.raw(
      `SELECT route_code, beneficiario, beneficiario_nombre, subtotal, venta, pct_aplicado, comision, bonos,
              nomina_banco, a_pagar, motivo_no_pago, dias_con_venta, dias_esperados
         FROM commercial.commission_run_lines
        WHERE run_id = ?`, [run.id])).rows.map((l) => ({
      ...l, subtotal: n(l.subtotal), venta: n(l.venta), pct_aplicado: n(l.pct_aplicado), comision: n(l.comision),
      bonos: n(l.bonos), nomina_banco: n(l.nomina_banco), a_pagar: n(l.a_pagar),
    }));
    const chofer = new Map(lineas.filter((l) => l.beneficiario === 'chofer').map((l) => [String(l.route_code).trim(), l]));
    const supervisor = new Map();
    for (const l of lineas.filter((x) => x.beneficiario === 'supervisor')) {
      supervisor.set(String(l.route_code).trim(), (supervisor.get(String(l.route_code).trim()) || 0) + (l.comision || 0));
    }

    // ── El cruce por ruta ───────────────────────────────────────────────────────────────────
    // El universo: las rutas del libro, más las que el motor PAGA y el libro no trae. Las que
    // el motor no paga y el libro no trae (vecinales, fuera del padrón) no son de este cruce.
    const libPorRuta = new Map(libro.map((f) => [f.route_code, f]));
    const rutas = [...new Set([...libPorRuta.keys(),
      ...[...chofer.values()].filter((l) => !l.motivo_no_pago).map((l) => String(l.route_code).trim())])];
    const filasCruce = rutas.map((ruta) => {
      const lib = libPorRuta.get(ruta) || null;
      const mot = chofer.get(ruta) || null;
      const libPaga = lib && !lib.motivo_no_pago ? lib.a_pagar : 0;
      const motPaga = mot && !mot.motivo_no_pago ? mot.a_pagar : 0;
      const v = veredicto(lib, mot);
      return {
        ruta, chofer: mot?.beneficiario_nombre || '',
        venta_libro: lib?.venta ?? null, venta_motor: mot?.venta ?? null,
        pct_libro: lib?.pct_aplicado ?? null, pct_motor: mot?.pct_aplicado ?? null,
        comision_libro: lib?.comision ?? null, comision_motor: mot?.comision ?? null,
        bonos_libro: lib?.bonos ?? null, bonos_motor: mot?.bonos ?? null,
        nomina_libro: lib?.nomina_banco ?? null, nomina_motor: mot?.nomina_banco ?? null,
        paga_libro: r2(libPaga || 0), paga_motor: r2(motPaga || 0),
        delta: r2((motPaga || 0) - (libPaga || 0)),
        dias: mot && mot.dias_con_venta !== null ? `${mot.dias_con_venta}/${mot.dias_esperados ?? '?'}` : '—',
        veredicto: v,
        causa: v === 'cuadra' ? '' : (causa(mot) || ''),
      };
    }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    console.log('\nruta  | chofer               |   venta libro |   venta motor | % lib | % mot |  paga libro |  paga motor |          Δ | días  | veredicto · causa');
    for (const f of filasCruce) {
      console.log(`${f.ruta.padEnd(5)} | ${f.chofer.slice(0, 20).padEnd(20)} | ${money(f.venta_libro).padStart(13)} | ${money(f.venta_motor).padStart(13)} | `
        + `${String(f.pct_libro ?? '—').padStart(5)} | ${String(f.pct_motor ?? '—').padStart(5)} | ${money(f.paga_libro).padStart(11)} | ${money(f.paga_motor).padStart(11)} | `
        + `${money(f.delta).padStart(10)} | ${f.dias.padEnd(5)} | ${f.veredicto}${f.causa ? ` · ${f.causa}` : ''}`);
    }

    // ── El resumen, por veredicto ───────────────────────────────────────────────────────────
    const porV = new Map();
    for (const f of filasCruce) {
      const a = porV.get(f.veredicto) || { n: 0, libro: 0, motor: 0 };
      a.n += 1; a.libro += f.paga_libro; a.motor += f.paga_motor; porV.set(f.veredicto, a);
    }
    console.log('\n--- resumen (pago al chofer: comisión − nómina + bonos) ---');
    let tl = 0; let tm = 0;
    for (const [v, a] of porV) {
      tl += a.libro; tm += a.motor;
      console.log(`  ${v.padEnd(22)} ${String(a.n).padStart(3)}  libro ${money(r2(a.libro)).padStart(12)}  motor ${money(r2(a.motor)).padStart(12)}  Δ ${money(r2(a.motor - a.libro))}`);
    }
    console.log(`  ${'TOTAL'.padEnd(22)} ${String(filasCruce.length).padStart(3)}  libro ${money(r2(tl)).padStart(12)}  motor ${money(r2(tm)).padStart(12)}  Δ ${money(r2(tm - tl))}`);
    const cuadran = porV.get('cuadra')?.n || 0;
    console.log(`  ⭐ ${cuadran} de ${filasCruce.length} rutas cuadran al peso.`);

    // ── El supervisor: lado a lado, SIN veredicto ───────────────────────────────────────────
    const supLibro = libro.reduce((s, f) => s + (f.supervisor || 0), 0);
    const supMotor = [...supervisor.values()].reduce((s, x) => s + x, 0);
    console.log('\n--- supervisor (informativo: no comparable hasta resolver D3) ---');
    console.log(`  20 % del libro ${money(r2(supLibro))}  ·  comisión de supervisor del motor ${money(r2(supMotor))}`);
    console.log(`  neto de la corrida del motor: ${run.total_neto === null ? 'SIN MEDIR (falta la deducción del supervisor)' : money(n(run.total_neto))}`);

    if (CSV) {
      const cols = Object.keys(filasCruce[0]);
      const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      fs.writeFileSync(CSV, [cols.join(','), ...filasCruce.map((f) => cols.map((c) => esc(f[c])).join(','))].join('\n'));
      console.log(`\nCSV: ${CSV}`);
    }
    console.log('');
  } finally {
    await db.destroy();
  }
})().catch((e) => { console.error(`\n⛔ ${e.message}\n`); process.exit(1); });
