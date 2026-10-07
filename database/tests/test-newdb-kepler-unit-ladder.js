/* eslint-disable no-console */
/**
 * CANDADO — LA MEDIDA QUE KEPLER HACE (VK.1).
 *
 * Edgar, 2026-09-12: *"el punto no es ir conciliando o parchando, es copiar su fórmula para
 * encontrar la medida que ellos hacen; una vez con la medida, trabajar con todas las unidades."*
 *
 * ── Qué cambió de enfoque ───────────────────────────────────────────────────────────────────
 *
 * Todo lo anterior **arbitra**: ordena testigos (`kdii.c84`, la etiquetera, el override, lo
 * pagado) y elige. Eso responde *"¿cuál de mis fuentes miente menos?"*.
 *
 * Kepler **declara su conversión en cada renglón y calcula con ella**:
 *
 *     c9 (cantidad base) = c56 (cantidad vendida) × c58 (factor)
 *
 * Ésa es su fórmula. Ese factor no hay que confirmarlo con un testigo externo — se venía buscando
 * en `c62` (el costo), y por eso `U-D-8` quedó declarado "no arbitrable" cuando su unidad nunca
 * dependió del costo.
 *
 * ── Lo que este candado asegura ─────────────────────────────────────────────────────────────
 *
 *   1. La identidad de Kepler se cumple. Si dejara de cumplirse, no estaríamos leyendo su
 *      fórmula sino tres columnas sueltas, y la escalera entera sería una invención.
 *   2. La escalera tiene escalones (si todo fuera factor 1, materializarla no aportaría nada).
 *   3. Lo que publicamos reproduce su medida — y **sobre todo** que no vuelva a aparecer el
 *      defecto que abrió esto: publicar **1** donde Kepler vende por caja.
 *   4. La escalera es consistente consigo misma: el peldaño compuesto reproduce al directo.
 *
 * ⚠️ Lo ambiguo se CUENTA, no se promedia: 235 peldaños donde Kepler usó más de un factor para
 * el mismo (sku, vendida, base).
 */

const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const MV = 'analytics.mv_kepler_unit_ladder';

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
// ⛔ Un campo ausente NO es un cero: `Number(n || 0)` convertía un alias mal escrito en 0.
const N = (n) => {
  if (n === undefined) throw new Error('N() recibió undefined: alias mal escrito (Postgres los '
    + 'devuelve en MINÚSCULAS). Un campo ausente no es un cero.');
  return Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
};

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query(`SET statement_timeout = '600s'`);
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  console.log('\n=== CANDADO: la medida que KEPLER hace (VK.1) ===\n');

  console.log('── 1. La escalera existe y tiene forma ──');
  const existe = (await q(`SELECT to_regclass('${MV}') t`))[0].t;
  check(`${MV} existe`, !!existe);
  if (!existe) {
    console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
    await c.end(); process.exit(1);
  }
  const [g] = await q(`
    SELECT count(*)::int peldanos, count(DISTINCT sku)::int skus,
           count(*) FILTER (WHERE ambiguo)::int ambiguos,
           count(*) FILTER (WHERE factor > 1)::int con_escalon,
           sum(renglones)::bigint renglones,
           sum(renglones_identidad_ok)::bigint identidad_ok
      FROM ${MV}`);
  console.log(`     ${N(g.peldanos)} peldaños sobre ${N(g.skus)} SKUs · ambiguos ${N(g.ambiguos)}`
    + ` · con factor > 1: ${N(g.con_escalon)}`);
  check('la escalera tiene volumen (no es un residuo)', g.peldanos > 1000, `${N(g.peldanos)}`);
  check('⭐ y tiene ESCALONES: hay peldaños con factor > 1',
    g.con_escalon > 100,
    `${N(g.con_escalon)} — si todo fuera 1, materializarla no aportaría nada sobre no tenerla`);

  // ── 2. ⭐⭐ LA FÓRMULA DE KEPLER ──────────────────────────────────────────────────────────
  console.log('\n── 2. ⭐⭐ La fórmula: c9 = c56 × c58 ──');
  const pct = 100 * Number(g.identidad_ok) / Number(g.renglones);
  console.log(`     se cumple en ${N(g.identidad_ok)} de ${N(g.renglones)} renglones = ${pct.toFixed(4)}%`);
  check('⭐⭐ la identidad de Kepler se cumple: estamos leyendo SU fórmula, no tres columnas sueltas',
    pct >= 99,
    `${pct.toFixed(4)}% — por debajo de 99% la escalera entera deja de ser reproducción y pasa a ser invención`);

  // ── 3. ⭐⭐ EL DEFECTO QUE ABRIÓ ESTO: publicar 1 donde Kepler vende por caja ─────────────
  console.log('\n── 3. ⭐⭐ No publicamos 1 donde Kepler vende por caja ──');
  const [p] = await q(`
    WITH pzc AS (
      SELECT sku, factor FROM ${MV} WHERE unidad_vendida='CJA' AND unidad_base='PZA'
      UNION
      SELECT a.sku, a.factor * x.factor
        FROM ${MV} a JOIN ${MV} x ON x.sku=a.sku AND x.unidad_vendida='PAQ' AND x.unidad_base='PZA'
       WHERE a.unidad_vendida='CJA' AND a.unidad_base='PAQ'
         AND NOT EXISTS (SELECT 1 FROM ${MV} z
                          WHERE z.sku=a.sku AND z.unidad_vendida='CJA' AND z.unidad_base='PZA')),
    u AS (SELECT sku, max(factor) factor FROM pzc GROUP BY 1)
    SELECT count(*)::int skus,
           count(*) FILTER (WHERE bf.box_factor::numeric = u.factor)::int coincide,
           count(*) FILTER (WHERE bf.box_factor::numeric <> u.factor)::int difiere,
           count(*) FILTER (WHERE bf.box_factor::numeric = 1 AND u.factor > 1)::int publicamos_1
      FROM u
      LEFT JOIN catalog.products pr ON pr.tenant_id=$1 AND pr.sku=u.sku AND pr.deleted_at IS NULL
      LEFT JOIN analytics.v_product_box_factor bf ON bf.tenant_id=$1 AND bf.product_id=pr.id`, [T]);
  console.log(`     ${N(p.skus)} SKUs con piezas-por-caja en Kepler · coincide ${N(p.coincide)}`
    + ` (${(100 * p.coincide / (p.skus || 1)).toFixed(2)}%) · difiere ${N(p.difiere)}`);
  check('⭐⭐ CERO SKUs donde publicamos 1 y Kepler vende por caja (el caso 96504)',
    p.publicamos_1 === 0,
    `${N(p.publicamos_1)} SKUs publican 1 mientras Kepler cobró por caja`);
  check('⭐ lo publicado reproduce la medida de Kepler en la gran mayoría',
    (100 * p.coincide / (p.skus || 1)) > 90,
    `${(100 * p.coincide / (p.skus || 1)).toFixed(2)}%`);

  // ── 4. La escalera es consistente consigo misma ──────────────────────────────────────────
  console.log('\n── 4. El peldaño compuesto reproduce al directo ──');
  const [comp] = await q(`
    WITH d AS (SELECT sku, factor FROM ${MV} WHERE unidad_vendida='CJA' AND unidad_base='PZA'),
    x AS (SELECT a.sku, a.factor*b.factor f
            FROM ${MV} a JOIN ${MV} b ON b.sku=a.sku AND b.unidad_vendida='PAQ' AND b.unidad_base='PZA'
           WHERE a.unidad_vendida='CJA' AND a.unidad_base='PAQ')
    SELECT count(*)::int con_ambos,
           count(*) FILTER (WHERE abs(d.factor - x.f) <= 0.001)::int coinciden
      FROM d JOIN x ON x.sku = d.sku`);
  if (!comp.con_ambos) {
    nomedido('la consistencia de la escalera', 'ningún SKU tiene el peldaño directo y el compuesto');
  } else {
    console.log(`     ${N(comp.con_ambos)} SKUs con los dos caminos · reproduce ${N(comp.coinciden)}`);
    check('la mayoría de los SKUs con los dos caminos son consistentes',
      comp.coinciden >= comp.con_ambos * 0.7,
      `${N(comp.coinciden)} de ${N(comp.con_ambos)} — si cayera, componer la escalera dejaría de ser válido`);
  }

  // ── 5. Lo que este candado NO mide ───────────────────────────────────────────────────────
  console.log('\n── 5. Lo que este candado no mide ──');
  console.log('     ⚠️  La escalera es lo que Kepler HIZO, no lo que debería hacer: un peldaño');
  console.log('        existe porque se aplicó en un renglón real. Donde Kepler nunca vendió un');
  console.log('        SKU en cierta unidad NO hay fila, y esa ausencia es información — pero');
  console.log('        también significa que la cobertura crece sólo si se vende.');
  console.log(`     ⚠️  ${N(g.ambiguos)} peldaños AMBIGUOS (Kepler usó más de un factor para el`);
  console.log('        mismo sku × vendida × base). Se marcan, no se promedian.');
  console.log('     ⛔ NO cubre Wincaja: por decisión de alcance (Edgar, 2026-09-12), la verdad');
  console.log('        absoluta se persigue en Kepler.');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
