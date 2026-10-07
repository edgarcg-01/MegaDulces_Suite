/* eslint-disable no-console */
/**
 * CG.10c — **propone** el mapeo `cuenta de caja (Access) → concepto de Kepler`, con evidencia.
 *
 * ── Los dos caminos que se probaron y FALLARON (medidos, no descartados de oído) ───────────────
 *
 * 1) **Cruzar los movimientos por (fecha, importe) contra `analytics.expense_entries`** —el renglón
 *    contable del gasto, que sí trae `concepto`/`concepto_nombre` de Kepler—. Resultado sobre la
 *    ventana común (2025-08-07 → 2026-09-25, 15,643 gastos de Control):
 *      · fecha exacta + importe .................... 14.1%
 *      · fecha ±3d + importe ....................... 32.3%
 *      · fecha ±3d + importe + beneficiario ........ **1.0%**
 *    El derrumbe al agregar el beneficiario es la prueba de que el 32% eran **coincidencias**: dos
 *    gastos distintos del mismo día por el mismo monto. Los mapeos que salían lo confirman —
 *    `Estacionamientos → COMISIONES LOGISTICAS` con ratio 0.889, `Equipo Limpieza → PARCHADA
 *    LLANTA`, `Comisionistas Luz → BASURA`. Y todos caían en sucursal `00` (Oficinas) mientras la
 *    caja es la `20` (Comisionistas).
 *
 * 2) **Heredarlo de lo autorizado a pagar** (`budget.expense_obligations`,
 *    `finance.payment_calendar_*`, `commercial.supplier_payment_obligations`). Están **en 0 filas**
 *    en prod: el módulo existe y nadie lo ha poblado.
 *
 * 3) **`Doctos.ConceptoD`** tampoco: 3 valores distintos en 18 años, es una bandera.
 *
 * ── Lo que SÍ funciona: el nombre de la cuenta ya trae la respuesta ────────────────────────────
 *
 * Los nombres del catálogo de Control están estructurados como **`<sucursal> <concepto>`**:
 * `PHidalgo Nomina`, `Matriz Papeleria`, `Comisionistas Luz`, `8Esquinas Mant. Sucursal`. Partirlos
 * y cruzar la parte del concepto contra `analytics.v_kepler_conceptos` da coincidencias que se
 * verifican leyéndolas: `Matriz Telefono → 603-004/043 TELEFONO`, `MANIOBRAS DE DESCARGA →
 * 514-001/084 MANIOBRAS DE DESCARGA CEDIS`, `Impuesto Sobre Nomina → 763-001/046 IMPUESTO 3% SOBRE
 * SUELDO`.
 *
 * ── Por qué IDF y no contar tokens a secas ─────────────────────────────────────────────────────
 *
 * La primera versión contaba tokens compartidos y empataba `Mantenimiento Vehiculos` con
 * **`MANTENIMIENTO BAÑO`**: las dos comparten 1 de 2 tokens. El token `MANTENIMIENTO` aparece en
 * decenas de conceptos y `VEHICULO` en poquísimos, pero pesaban igual. Con IDF —el peso de un token
 * es inverso a en cuántos conceptos aparece— el token raro decide, que es el que lleva el
 * significado.
 *
 * ── Qué se escribe y qué NO ────────────────────────────────────────────────────────────────────
 *
 * Todo entra como **propuesta sin confirmar** (`source='derivado'`, `confirmed_at` NULL) y con el
 * score guardado en `support_ratio`, para que la pantalla pueda ordenar por confianza. **Nada se
 * da por bueno solo.** Bajo el umbral se escribe la cuenta SIN concepto (los dos NULL, como manda
 * el CHECK) — la pregunta declarada, no una respuesta inventada.
 *
 *   node database/scripts/propose-caja-concept-map.js                 # dry-run, imprime todo
 *   node database/scripts/propose-caja-concept-map.js --apply
 *   node database/scripts/propose-caja-concept-map.js --apply --umbral=0.7
 */
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const M = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');
const CAJA = (process.argv.find((a) => a.startsWith('--caja=')) || '').split('=')[1] || '20';
const DESDE = (process.argv.find((a) => a.startsWith('--desde=')) || '').split('=')[1] || '2026-01-01';
const UMBRAL = Number((process.argv.find((a) => a.startsWith('--umbral=')) || '').split('=')[1]) || 0.6;
const URL = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;

/** Prefijos de SUCURSAL que traen los nombres de cuenta de Control, y a qué plaza apuntan. */
const SUCURSALES = [
  ['MATRIZ', 'Matriz'], ['PHIDALGO', 'Padre Hidalgo'], ['MORELIA', 'Morelia'],
  ['COMISIONISTAS', 'Comisionistas'], ['8ESQUINAS', '8 Esquinas'],
  ['ZAMORA', 'Zamora'], ['LA PIEDAD', 'La Piedad'], ['PIEDAD', 'La Piedad'],
];

const norm = (s) => (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Palabras que no distinguen nada y sólo inflan el score. */
const STOP = new Set(['DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'A', 'EN', 'POR', 'X',
  'SUC', 'SUCURSAL', 'GRAL', 'GENERAL']);
const toks = (s) => norm(s).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));

function partirNombre(nombre) {
  const n = norm(nombre);
  for (const [pref, suc] of SUCURSALES) {
    if (n === pref) return { sucursal: suc, concepto: '' };
    if (n.startsWith(pref + ' ')) return { sucursal: suc, concepto: n.slice(pref.length + 1) };
  }
  return { sucursal: null, concepto: n };
}

(async () => {
  if (!URL) throw new Error('falta DATABASE_URL_NEW');
  const c = new Client({ connectionString: URL, statement_timeout: 300000 });
  await c.connect();
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [M]);

    const ctas = (await c.query(`
      SELECT ct.idcuenta::text AS cta, NULLIF(btrim(ct.nombrecuenta),'') AS nom,
             coalesce(m.movs,0)::int AS movs, coalesce(m.monto,0)::numeric AS monto
        FROM caja_general_ods.cuenta ct
        LEFT JOIN (
          SELECT cuenta::text AS k, count(*)::int AS movs,
                 sum(coalesce(ingreso,0)+coalesce(gasto,0)+coalesce(deposito,0))::numeric AS monto
            FROM caja_general_ods.doctos
           WHERE source_caja = $1 AND fecha >= $2 GROUP BY 1) m ON m.k = ct.idcuenta::text
       WHERE ct.source_caja = $1
       ORDER BY coalesce(m.monto,0) DESC`, [CAJA, DESDE])).rows;

    const conceptos = (await c.query(
      `SELECT sucursal, cuenta, concepto, concepto_nombre FROM analytics.v_kepler_conceptos`)).rows;

    // IDF: cuántos conceptos distintos usan cada token. Un token que está en todos no informa.
    const df = new Map();
    const tokDe = new Map();
    for (const k of conceptos) {
      const t = [...new Set(toks(k.concepto_nombre))];
      tokDe.set(k, t);
      for (const w of t) df.set(w, (df.get(w) || 0) + 1);
    }
    const N = conceptos.length;
    const idf = (w) => Math.log(N / (1 + (df.get(w) || 0)));

    const idx = new Map();
    for (const k of conceptos) for (const w of tokDe.get(k)) {
      if (!idx.has(w)) idx.set(w, []);
      idx.get(w).push(k);
    }

    const filas = [];
    for (const r of ctas) {
      const p = partirNombre(r.nom);
      const tc = [...new Set(toks(p.concepto))];
      let best = null;
      if (tc.length) {
        const pesoCaja = tc.reduce((a, w) => a + idf(w), 0) || 1;
        const cand = new Map();
        for (const w of tc) for (const k of (idx.get(w) || [])) {
          cand.set(k, (cand.get(k) || 0) + idf(w));
        }
        for (const [k, peso] of cand) {
          // ⭐ COBERTURA ASIMÉTRICA, y la asimetría es la decisión de diseño.
          //
          // La pregunta correcta es *"¿cuánto de lo que dice la cuenta de caja quedó cubierto?"*,
          // no *"¿se parecen los dos textos?"*. Con cobertura simétrica, `Comisionistas Agua` →
          // `AGUA POTABLE` sacaba **0.45** —o sea se rechazaba— sólo porque a Kepler le sobra la
          // palabra "POTABLE". Es correcto y lo estábamos tirando.
          //
          // Y el IDF sigue siendo lo que impide el error opuesto: `Mantenimiento Vehiculos` contra
          // `MANTENIMIENTO BAÑO` cubre el token `MANTENIMIENTO`, que aparece en decenas de
          // conceptos y pesa poco; el que lleva el significado (`VEHICULOS`) queda sin cubrir, así
          // que el score se hunde. Contando tokens a secas empataba.
          let score = peso / pesoCaja;
          // Penalización SUAVE por texto de más: un concepto de Kepler muy largo que cubre una
          // palabra corta de la caja es sospechoso, pero no descartable.
          const pesoK = tokDe.get(k).reduce((a, w) => a + idf(w), 0) || 1;
          if (pesoK > pesoCaja) score *= Math.max(0.75, pesoCaja / pesoK) ** 0.5;
          // Empuje chico si la sucursal del concepto coincide con la que trae el nombre.
          if (p.sucursal && norm(k.sucursal).includes(norm(p.sucursal).split(' ')[0])) score += 0.05;
          if (!best || score > best.score) best = { ...k, score: Math.min(score, 1) };
        }
      }
      filas.push({ ...r, ...p, best, acepta: !!best && best.score >= UMBRAL });
    }

    const conMov = filas.filter((r) => r.movs > 0);
    const dineroTot = conMov.reduce((a, r) => a + Number(r.monto), 0) || 1;
    const dineroOk = conMov.filter((r) => r.acepta).reduce((a, r) => a + Number(r.monto), 0);
    const aceptadas = filas.filter((r) => r.acepta).length;

    console.log(`=== CG.10c propuesta del mapa de conceptos (${APPLY ? 'APPLY' : 'DRY-RUN'}) · caja ${CAJA} · umbral ${UMBRAL} ===\n`);
    console.log(`  ${filas.length} cuentas · ${conMov.length} con movimiento desde ${DESDE}`);
    console.log(`  ${aceptadas} con propuesta sobre el umbral · cubren el ${(dineroOk / dineroTot * 100).toFixed(1)}% del dinero\n`);

    console.log('  cta        nombre de caja                → concepto Kepler propuesto           score');
    for (const r of conMov.slice(0, 24)) {
      const b = r.best;
      console.log(`  ${r.acepta ? '✔' : ' '} ${r.cta.padStart(8)} ${String(r.nom).slice(0, 28).padEnd(28)} → `
        + (b ? `${(b.cuenta + '/' + b.concepto).padEnd(13)} ${String(b.concepto_nombre).slice(0, 26).padEnd(26)} ${b.score.toFixed(2)}`
          : '(sin candidato)'));
    }

    if (!APPLY) { console.log('\n  (dry-run: no se escribió nada. Agregá --apply)'); return; }

    let prop = 0; let vacias = 0; let protegidas = 0;
    for (const r of filas) {
      const b = r.acepta ? r.best : null;
      const nota = b
        ? `derivado del nombre: "${r.nom}" -> "${b.concepto_nombre}" (IDF ${b.score.toFixed(2)}, suc ${b.sucursal})`
        : (r.best ? `mejor candidato "${r.best.concepto_nombre}" quedó en ${r.best.score.toFixed(2)}, bajo el umbral ${UMBRAL}` : 'sin candidato por nombre');
      const res = await c.query(`
        INSERT INTO finance.caja_kepler_concept_map
               (tenant_id, source_caja, legacy_cuenta, legacy_nombre, kepler_cuenta, kepler_concepto,
                support, support_ratio, source, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'derivado',$9)
        ON CONFLICT (tenant_id, source_caja, legacy_cuenta, COALESCE(sucursal,''))
        DO UPDATE SET legacy_nombre = excluded.legacy_nombre,
                      kepler_cuenta = excluded.kepler_cuenta,
                      kepler_concepto = excluded.kepler_concepto,
                      support = excluded.support,
                      support_ratio = excluded.support_ratio,
                      note = excluded.note,
                      updated_at = now()
          -- ⛔ Una fila CONFIRMADA es una decisión humana: no se pisa jamás.
          WHERE finance.caja_kepler_concept_map.confirmed_at IS NULL
        RETURNING kepler_concepto`,
      [M, CAJA, r.cta, r.nom, b ? b.cuenta : null, b ? b.concepto : null,
        r.movs, b ? Number(b.score.toFixed(3)) : null, nota]);
      if (!res.rowCount) { protegidas++; continue; }
      if (res.rows[0].kepler_concepto) prop++; else vacias++;
    }
    console.log(`\n  ${prop} con propuesta · ${vacias} declaradas sin concepto · ${protegidas} confirmadas (intactas)`);

    const cov = await c.query(`SELECT * FROM finance.v_caja_concept_map_coverage`);
    for (const r of cov.rows) {
      console.log(`  COBERTURA caja ${r.source_caja}: ${r.cuentas} cuentas · ${r.con_propuesta} con propuesta`
        + ` · ${r.sin_propuesta} sin concepto · ${r.confirmadas} confirmadas · ${r.por_confirmar} POR CONFIRMAR`);
    }
    console.log('\n  Ninguna se da por buena sola: todas salen con confirmed_at NULL y van a la bandeja HITL.');
  } finally {
    await c.end().catch(() => {});
  }
})().catch((e) => { console.error('\n💥', e.message); process.exitCode = 1; });
