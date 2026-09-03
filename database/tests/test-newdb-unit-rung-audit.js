/* eslint-disable no-console */
/**
 * U.1 — CANDADO del detector de PELDAÑO CRUZADO (`analytics.v_unit_rung_audit`).
 *
 * La clase de error que vigila: dos magnitudes que se multiplican viven en peldaños distintos de la
 * escalera de unidades y nada declara el peldaño de cada una. El caso que la destapó: `20555`
 * publicaba $4,982,228 — 6,753 KILOS valuados a $737.78, el precio del BULTO de 18 kg.
 *
 * El detector, en una línea:  display_bf  ==  caja_cost / pagado
 *   · almacenes Kepler  -> `pagado` = `replenishment_plan.real_buy_cost`
 *   · almacenes Wincaja -> `pagado` = `wincaja.v_stock.costo_promedio` (su costo por SU unidad)
 *
 * Lo que este test existe para que NO vuelva:
 *   1. que el grupo sano se degrade en silencio (si alguien mueve un divisor, la razón mediana
 *      del OK se corre y acá explota);
 *   2. que un SKU nuevo entre a x1/x2 sin que nadie lo vea;
 *   3. que el detector se rompa y devuelva "todo ok" (por eso hay 3 SKUs TESTIGO con veredicto
 *      esperado — incluido uno que debe salir OK aunque tenga el divisor raro).
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-unit-rung-audit.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  console.log('\n=== U.1 · detector de peldaño cruzado ===\n');

  // ── 1. Es VISTA (derive-no-copy) y expone el contrato ──────────────────────────────────────
  const rel = (await c.query(
    `SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.v_unit_rung_audit')`)).rows[0];
  check('v_unit_rung_audit existe', !!rel);
  check('es VISTA, no tabla copiada', rel && rel.relkind === 'v', rel ? `relkind=${rel.relkind}` : 'ausente');

  const cols = (await c.query(`SELECT column_name FROM information_schema.columns
     WHERE table_schema='analytics' AND table_name='v_unit_rung_audit'`)).rows.map((r) => r.column_name);
  for (const col of ['tenant_id', 'warehouse_id', 'product_id', 'sku', 'arbitro', 'display_bf',
    'display_bf_esperado', 'razon', 'caja_cost', 'pagado', 'valor_publicado', 'valor_arbitrado',
    'veredicto', 'es_granel', 'con_override', 'factor_partido', 'factor_source']) {
    check(`expone ${col}`, cols.includes(col));
  }

  // ── 2. El veredicto es un vocabulario cerrado ──────────────────────────────────────────────
  const vocab = (await c.query(`SELECT DISTINCT veredicto FROM analytics.v_unit_rung_audit
     WHERE tenant_id=$1`, [T])).rows.map((r) => r.veredicto).sort();
  const permitido = ['ok', 'x1_inflada', 'x2_deflactada', 'z_no_arbitrable'];
  check('sin veredictos fuera del vocabulario', vocab.every((v) => permitido.includes(v)), vocab.join(','));

  // ── 3. Los DOS árbitros están en uso — si uno desaparece, la mitad del catálogo queda ciega ─
  const arb = (await c.query(`SELECT arbitro, count(*)::int n FROM analytics.v_unit_rung_audit
     WHERE tenant_id=$1 GROUP BY 1`, [T])).rows;
  const kep = arb.find((r) => r.arbitro === 'kepler_compra');
  const wcj = arb.find((r) => r.arbitro === 'wincaja_costo');
  check('el árbitro de Kepler cubre sus almacenes', kep && kep.n > 5000, kep ? `n=${kep.n}` : 'ausente');
  check('el árbitro de Wincaja cubre los suyos', wcj && wcj.n > 2000, wcj ? `n=${wcj.n}` : 'ausente');

  // ── 4. EL CANDADO PRINCIPAL: el grupo sano no se degrada ───────────────────────────────────
  // Si alguien cambia un divisor en el pipeline, la razón mediana del OK se corre y acá se ve.
  // Medido 2026-09-03: 1.016 (Kepler) y 1.080 (Wincaja). El 1.08 de Wincaja es el IVA 8%.
  const sano = (await c.query(`SELECT
      count(*)::int n,
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY razon)::numeric, 3) AS mediana
    FROM analytics.v_unit_rung_audit WHERE tenant_id=$1 AND veredicto='ok'`, [T])).rows[0];
  const total = (await c.query(`SELECT count(*)::int n FROM analytics.v_unit_rung_audit
     WHERE tenant_id=$1`, [T])).rows[0];
  const pctSano = 100 * sano.n / Math.max(total.n, 1);
  console.log(`\n  sano: ${sano.n}/${total.n} = ${pctSano.toFixed(1)}% · razón mediana ${sano.mediana}\n`);
  check('el 94% del catálogo sigue sano', pctSano >= 92, `${pctSano.toFixed(1)}%`);
  check('la razón mediana del grupo sano se mantiene en [0.9, 1.15]',
    Number(sano.mediana) >= 0.9 && Number(sano.mediana) <= 1.15, `mediana=${sano.mediana}`);

  // ── 5. Y los dos valuados del grupo sano coinciden — es la validación del método ────────────
  const cuadre = (await c.query(`SELECT
      round(sum(valor_publicado)::numeric,0) AS pub,
      round(sum(valor_arbitrado)::numeric,0) AS arb
    FROM analytics.v_unit_rung_audit WHERE tenant_id=$1 AND veredicto='ok'`, [T])).rows[0];
  const gap = Math.abs(Number(cuadre.arb) - Number(cuadre.pub)) / Math.max(Number(cuadre.pub), 1);
  check('en el grupo sano los dos valuados difieren < 12% (piso de ruido medido: 4.5%)',
    gap < 0.12, `${money(cuadre.pub)} vs ${money(cuadre.arb)} = ${(gap * 100).toFixed(1)}%`);

  // ── 6. TESTIGOS por (SKU, ALMACÉN) — que el detector no se rompa devolviendo "todo ok" ─────
  // ⚠️ El grano importa: **el peldaño es propiedad de (SKU, almacén), no del SKU.** `20555` está
  // en KILOS en las sucursales Kepler (pagado $44.31 = el kilo) y en BULTOS en el almacén Wincaja
  // `00` (costo_promedio $796.80 = el bulto). Por eso el testigo se fija por almacén: una versión
  // anterior de este test usaba LIMIT 1, agarraba la fila de Wincaja y daba falso verde.
  //
  // `57009` es el contraejemplo que DEBE salir OK aunque su divisor parezca raro (stock en cubetas,
  // demanda en kilos: el suf=20 es legítimo). Una "corrección" uniforme del suf habría pedido
  // $2.59M/mes contra $132k/mes de venta real.
  const testigos = [
    { sku: '20555', wh: '01', esperado: 'x1_inflada', porque: 'Kepler: kilos valuados a precio de bulto' },
    { sku: '20555', wh: '00', esperado: 'ok', porque: 'Wincaja: ahí sí son bultos' },
    { sku: '57009', wh: '06', esperado: 'ok', porque: 'stock en cubetas: el divisor 1 es correcto' },
    // `99380` es el testigo del otro lado: en Kepler el divisor es c84=144 (unidades base por caja)
    // sobre un stock que está en PAQUETES (lo pagado = $143.54 = caja/12) → razón exacta 12.0000.
    // Y en MD-30 sale OK con razón 1.0000, porque ahí ADR-055 usa factor_venta=12 y acierta. Los dos
    // juntos prueban que el detector distingue "el divisor está mal" de "el divisor está bien".
    { sku: '99380', wh: '01', esperado: 'x2_deflactada', porque: 'Kepler divide por 144 lo que va entre 12' },
    { sku: '99380', wh: 'MD-30', esperado: 'ok', porque: 'Wincaja: factor_venta=12 acierta (ADR-055)' },
  ];
  for (const t of testigos) {
    const r = (await c.query(`SELECT veredicto, round(razon::numeric,3) razon, arbitro
      FROM analytics.v_unit_rung_audit
     WHERE tenant_id=$1 AND sku=$2 AND warehouse_code=$3`, [T, t.sku, t.wh])).rows[0];
    if (!r) { skip++; console.log(`  ~ ${t.sku}@${t.wh} sin existencia hoy (skip) — ${t.porque}`); continue; }
    check(`testigo ${t.sku}@${t.wh} → ${t.esperado} (${t.porque})`,
      r.veredicto === t.esperado, `dio ${r.veredicto}, razón ${r.razon}, árbitro ${r.arbitro}`);
  }

  // ── 6b. Y el corolario: un SKU puede tener veredictos distintos entre almacenes ────────────
  // Si esto llegara a 0, alguien colapsó el grano a producto y el detector perdió resolución.
  const mixto = (await c.query(`SELECT count(*)::int n FROM (
      SELECT sku FROM analytics.v_unit_rung_audit WHERE tenant_id=$1
       GROUP BY sku HAVING count(DISTINCT veredicto) > 1) z`, [T])).rows[0];
  check('hay SKUs con veredicto distinto entre almacenes (el grano es producto × almacén)',
    mixto.n > 0, `n=${mixto.n}`);

  // ── 7. `factor_partido` señala el estado que produjo los 15 auto-seed de granel ────────────
  // suf>1 con bf=1 = el factor quedó en la columna que SÓLO consume la demanda. Debe seguir
  // detectándose, y debe concentrarse en x1 (que es el daño que produce).
  const fp = (await c.query(`SELECT
      count(*) FILTER (WHERE factor_partido)::int                            AS partidos,
      count(*) FILTER (WHERE factor_partido AND veredicto='x1_inflada')::int AS partidos_x1,
      count(*) FILTER (WHERE factor_partido AND es_granel)::int              AS partidos_granel
    FROM analytics.v_unit_rung_audit WHERE tenant_id=$1`, [T])).rows[0];
  check('sigue detectando el factor partido (suf>1 ∧ bf=1)', fp.partidos > 20, `n=${fp.partidos}`);
  check('los partidos se concentran en x1, que es el daño que producen',
    fp.partidos_x1 >= fp.partidos * 0.5, `${fp.partidos_x1}/${fp.partidos} en x1`);

  // ── 8. El tamaño del problema no crece en silencio ─────────────────────────────────────────
  // Medido 2026-09-03: x1 = 95 SKUs / $10.05M publicado · x2 = 202 SKUs / $536k.
  // Si crece mucho, o alguien rompió un divisor o entró un lote de overrides mal puestos.
  const marc = (await c.query(`SELECT veredicto,
      count(DISTINCT sku)::int skus,
      round(sum(valor_publicado)::numeric,0) AS pub,
      round(sum(valor_arbitrado)::numeric,0) AS arb
    FROM analytics.v_unit_rung_audit WHERE tenant_id=$1 AND veredicto <> 'ok'
    GROUP BY 1 ORDER BY 1`, [T])).rows;
  for (const m of marc) {
    console.log(`  ${m.veredicto}: ${m.skus} SKUs · publica ${money(m.pub)} · árbitro dice ${money(m.arb)}`);
  }
  const x1 = marc.find((m) => m.veredicto === 'x1_inflada');
  const x2 = marc.find((m) => m.veredicto === 'x2_deflactada');
  check('x1 sigue siendo un subconjunto acotado (no todo el catálogo)',
    !x1 || (x1.skus > 10 && x1.skus < 400), x1 ? `skus=${x1.skus}` : 'sin x1');
  check('x2 sigue siendo un subconjunto acotado',
    !x2 || x2.skus < 600, x2 ? `skus=${x2.skus}` : 'sin x2');

  // ── 9. ⛔ Ningún marcado sin identidad: el triage necesita saber a quién preguntarle ────────
  const ciegos = (await c.query(`SELECT count(*)::int n FROM analytics.v_unit_rung_audit
     WHERE tenant_id=$1 AND veredicto <> 'ok'
       AND (sku IS NULL OR warehouse_code IS NULL OR arbitro IS NULL)`, [T])).rows[0];
  check('todo marcado trae SKU, almacén y árbitro', ciegos.n === 0, `n=${ciegos.n}`);

  // ── 10. El divisor nunca es 0 (dividir por él es la operación central) ─────────────────────
  const div = (await c.query(`SELECT count(*)::int n FROM analytics.v_unit_rung_audit
     WHERE tenant_id=$1 AND (display_bf IS NULL OR display_bf < 1)`, [T])).rows[0];
  check('ningún display_bf NULL ni < 1', div.n === 0, `n=${div.n}`);

  console.log(`\n=== ${ok} OK · ${fail} FAIL${skip ? ` · ${skip} skip` : ''} ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
