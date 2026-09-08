/* eslint-disable no-console */
/**
 * P.0 — CANDADO DE PARIDAD: lo que entregamos tiene que ser lo que entrega Kepler.
 *
 * Pedido de Edgar: *"enfoquemos que kepler queda idéntico, no haya diferencia entre lo que entrega
 * Kepler y lo que entregamos nosotros."*
 *
 * Compara `analytics.sales_daily` contra la suma CRUDA de los renglones de Kepler (`kepler_ods.kdm2`)
 * por (SKU, sucursal, fecha), y parte el delta por CAUSA. No es un reporte: es la compuerta de la
 * Fase P y el antes/después que la regla del proyecto exige antes de mover un número.
 *
 * ── Tres trampas que ya produjeron una medición falsa en esta misma fase ───────────────────
 *
 *  1. ⭐ **Aislar los canales de Kepler.** Los almacenes `01/02/04/05/06` también contienen venta
 *     HISTÓRICA de Wincaja remapeada (`services/feeds-ingest/sales-daily-projection.js:75-91`
 *     mapea 10→01, 42→02, 44→04, 54→05, 50→06). Comparar esa mezcla contra Kepler infla el delta
 *     al 27% cuando el real contra el ticket es 1.6%. Filtro obligatorio: `channel NOT LIKE
 *     'wincaja_%'`.
 *  2. **Anti-réplica `btrim(c1) = sucursal`**: `kdm2` arrastra filas de OTRAS sucursales (la 03
 *     trae 112,377 renglones de la 02, $7.5M, muertos el 2026-01-07).
 *  3. **Contar los DOS lados del FULL OUTER JOIN.** La lección de U.6: una comparación que sólo
 *     mira la intersección no puede ver lo que falta. Acá lo que falta son 5,112 filas.
 *
 * ── El estado medido el 2026-09-07 (90 días, sucursales 01-06) ────────────────────────────
 *
 *     contra el TICKET (U-D-10)     cantidad 98.03%   importe 99.74%   delta $727,320
 *     contra U-D-8/10/12            cantidad 93.90%   importe 95.54%   delta $16,370,247
 *
 * Las cinco causas de la brecha, todas NUESTRAS:
 *     1  falta U-D-8  (Factura Telemarketing)          $14,151,697   mart.ventas filtra c4=10
 *     2  falta U-D-12 (Factura Cont No Fiscal)          $1,491,231
 *     3  5,112 filas que Kepler tiene y el fact no        $871,238   el SKU SÍ existe en el catálogo
 *     4  1,101 celdas multiplicadas x12                              pickPriceTier adivina el factor
 *     5  4,581 celdas divididas /2                                   conversión de 500 g a kilos
 *
 * ── ⭐ K.3 (2026-09-08): las causas 1 y 2 quedaron CERRADAS ────────────────────────────────
 *
 * `mart.ventas` pasó de `h.c4=10` a `IN (8,10,12)` — el mismo corte que
 * `analytics.mv_kepler_sales_daily`. Y con eso el UNIVERSO del candado tuvo que cambiar:
 * seguir comparando nuestro lado (que ya trae 8/10/12) contra un lado de Kepler filtrado a
 * `'10'` medía DOS POBLACIONES distintas, y el síntoma habría sido cómico — miles de celdas
 * "que publicamos y Kepler no tiene", que Kepler sí tiene, en otro doctype. El bloque 1 pasa
 * al universo completo; el mostrador queda como sonda de resolución fina, con las DOS partes
 * recortadas al mismo corte (nuestro canal `tienda` vs `c4=10 AND c10='CONTADO'`).
 *
 * Y una cuarta afirmación nueva, que es la que verifica K.3 de verdad: **nuestro canal
 * `mayoreo` tiene que ser, peso por peso, el U-D-8 de Kepler.** El total puede cuadrar con el
 * dinero en el canal equivocado — de hecho ése era el riesgo concreto: sin el `doctype` en
 * `mart.ventas`, el 100% del telemarketing caía en `credito` e inflaba el crédito publicado
 * de $10.9M a $25.5M. Un total correcto pagado con otro número falso no es paridad.
 *
 * ── El estado medido el 2026-09-08 tras K.3 (90 días, contra PROD) ────────────────────────
 *
 *     universo completo (8/10/12)   cantidad 98.01%   importe 99.74%   cobertura 98.20%
 *     mostrador (tienda vs 10+CONTADO)  cantidad 98.06%   importe 99.75%   delta $680,308
 *     mayoreo nuestro $14,462,264  vs  U-D-8 de Kepler $14,580,181  =  99.19%
 *     sólo en Kepler: 5,178 celdas $1,225,253   ·   sólo nuestras: 349 celdas $31,878
 *
 * Y la cifra publicada (`sales_daily`, canales Kepler, 90 d, TODOS los almacenes):
 *     $51,789,599  ->  $67,617,584   (+$15,827,985 · +30.6%)
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-kepler-parity.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const DIAS = Number(process.env.PARITY_DAYS || 90);

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
const N = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pct = (a, b) => (b ? (100 * a / b) : 0);

/** ⭐ El universo de VENTA de Kepler, desde K.3: 8 Telemarketing (mayoreo) · 10 Ticket · 12 no
 *  fiscal. Es el mismo corte de `mart.ventas` y de `analytics.mv_kepler_sales_daily`. Si este
 *  literal y el `IN (8,10,12)` del cargador divergen, el candado compara dos poblaciones. */
const VENTA = "'8','10','12'";

/** Lo que Kepler entrega: la suma de sus propios renglones, sin tocar nada. */
const kepler = (docs) => `
  SELECT btrim(l.c8) sku, l.sucursal suc, l.c32::date d,
         sum(l.c9)  qty, sum(l.c13) imp
    FROM kepler_ods.kdm2 l
   WHERE l.c2='U' AND l.c3='D' AND btrim(l.c4::text) IN (${docs})
     AND btrim(l.c1::text) = l.sucursal::text
     AND l.c32::date > current_date - ${DIAS}
   GROUP BY 1,2,3`;

/** El MOSTRADOR de Kepler: ticket (c4=10) cobrado de contado. Es el recorte que corresponde
 *  exactamente a nuestro canal `tienda` — la única forma honesta de conservar la sonda fina
 *  del ticket ahora que nuestro lado ya trae los tres doctypes. Necesita el encabezado
 *  (`c10` = referencia de cliente) y se une por la PK completa, no por (c1,c6). */
const keplerMostrador = `
  SELECT btrim(l.c8) sku, l.sucursal suc, l.c32::date d,
         sum(l.c9) qty, sum(l.c13) imp
    FROM kepler_ods.kdm2 l
    JOIN kepler_ods.kdm1 h
      ON btrim(l.sucursal)=btrim(h.sucursal) AND btrim(l.c1)=btrim(h.c1)
     AND l.c2=h.c2 AND l.c3=h.c3 AND l.c4::int=h.c4::int
     AND l.c5::int=h.c5::int AND btrim(l.c6)=btrim(h.c6)
   WHERE l.c2='U' AND l.c3='D' AND l.c4::int=10 AND btrim(h.c10)='CONTADO'
     AND btrim(l.c1::text) = l.sucursal::text
     AND l.c32::date > current_date - ${DIAS}
   GROUP BY 1,2,3`;

/** Lo que entregamos nosotros, SÓLO por los canales que alimenta Kepler.
 *  `extra` recorta a un canal para poder comparar contra el mismo recorte del lado de Kepler. */
const nuestro = (extra = '') => `
  SELECT p.sku, w.kepler_code suc, s.sale_date d,
         sum(s.units) qty, sum(s.revenue) imp,
         max(s.rung_factor) rf, bool_or(s.rung_mixed) mix
    FROM analytics.sales_daily s
    JOIN catalog.products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
    JOIN commercial.warehouses w ON w.tenant_id=s.tenant_id AND w.id=s.warehouse_id
   WHERE s.tenant_id='${T}'::uuid AND s.sale_date > current_date - ${DIAS}
     AND w.kepler_code IS NOT NULL AND s.channel NOT LIKE 'wincaja_%'
     ${extra}
   GROUP BY 1,2,3`;

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query("SET statement_timeout = '1200s'");
  console.log(`\n=== P.0 · PARIDAD con Kepler (${DIAS} días, sucursales 01-06) ===\n`);

  if (!(await c.query(`SELECT to_regclass('kepler_ods.kdm2') AS t`)).rows[0].t) {
    nomedido('kepler_ods.kdm2 no existe en este destino', 'la paridad sólo se puede medir contra el ODS');
    console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
    await c.end(); process.exit(0);
  }

  // ── 1. El UNIVERSO COMPLETO de venta: la pregunta que hizo Edgar ⭐ ────────────────────────
  // Antes de K.3 este bloque comparaba sólo el ticket, porque era lo único que el fact traía.
  // Ahora el fact trae los tres doctypes, así que la comparación honesta es contra los tres.
  console.log('── 1. ⭐ El universo completo de venta (U-D-8 + U-D-10 + U-D-12) ──');
  const t = (await c.query(`
    WITH kep AS (${kepler(VENTA)}), nos AS (${nuestro()})
    SELECT count(*) FILTER (WHERE k.sku IS NOT NULL AND n.sku IS NOT NULL)::int ambos,
           count(*) FILTER (WHERE k.sku IS NOT NULL AND n.sku IS NOT NULL AND abs(n.qty-k.qty)<=0.01)::int qty_ok,
           count(*) FILTER (WHERE k.sku IS NOT NULL AND n.sku IS NOT NULL AND abs(n.imp-k.imp)<=0.05)::int imp_ok,
           round(sum(k.imp)::numeric,0) imp_kep, round(sum(n.imp)::numeric,0) imp_nos,
           count(*) FILTER (WHERE n.sku IS NULL)::int solo_kep,
           round(sum(k.imp) FILTER (WHERE n.sku IS NULL)::numeric,0) imp_solo_kep,
           count(*) FILTER (WHERE k.sku IS NULL)::int solo_nos,
           round(sum(n.imp) FILTER (WHERE k.sku IS NULL)::numeric,0) imp_solo_nos
      FROM kep k FULL OUTER JOIN nos n ON n.sku=k.sku AND n.suc=k.suc AND n.d=k.d`)).rows[0];
  const qP = pct(t.qty_ok, t.ambos); const iP = pct(t.imp_ok, t.ambos);
  console.log(`     celdas en ambos: ${N(t.ambos)}`);
  console.log(`     CANTIDAD idéntica: ${N(t.qty_ok)} (${qP.toFixed(2)}%)`);
  console.log(`     IMPORTE  idéntico: ${N(t.imp_ok)} (${iP.toFixed(2)}%)`);
  console.log(`     totales: Kepler ${money(t.imp_kep)}  ·  nosotros ${money(t.imp_nos)}  ·  delta ${money(Number(t.imp_kep) - Number(t.imp_nos))}`);
  check('la CANTIDAD del universo completo coincide con Kepler (≥ 97%)', qP >= 97, `${qP.toFixed(2)}%`);
  check('el IMPORTE del universo completo coincide con Kepler (≥ 99%)', iP >= 99, `${iP.toFixed(2)}%`);
  const cobertura = pct(Number(t.imp_nos), Number(t.imp_kep));
  console.log(`     cobertura del dinero: ${cobertura.toFixed(2)}%`);
  // Piso 97% = lo medido el 2026-09-08 tras K.3 (98.20%), con margen. Antes de K.3 los dos
  // doctypes ausentes eran $16,071,965 de los $60,952,255 que Kepler entrega en 90 d — 26.4%
  // del dinero fuera del fact.
  check('⭐ K.3 — publicamos al menos el 97% del dinero que Kepler entrega', cobertura >= 97,
    `${cobertura.toFixed(2)}% · antes de K.3 faltaban $16,071,965 de $60,952,255 = 26.4% del dinero`);

  // ── 1b. El MOSTRADOR: la sonda de resolución fina, los dos lados al mismo recorte ──────────
  console.log('\n── 1b. El mostrador (nuestro canal `tienda` vs U-D-10 de contado) ──');
  const m = (await c.query(`
    WITH kep AS (${keplerMostrador}), nos AS (${nuestro("AND s.channel = 'tienda'")})
    SELECT count(*) FILTER (WHERE k.sku IS NOT NULL AND n.sku IS NOT NULL)::int ambos,
           count(*) FILTER (WHERE k.sku IS NOT NULL AND n.sku IS NOT NULL AND abs(n.qty-k.qty)<=0.01)::int qty_ok,
           count(*) FILTER (WHERE k.sku IS NOT NULL AND n.sku IS NOT NULL AND abs(n.imp-k.imp)<=0.05)::int imp_ok,
           round(sum(k.imp)::numeric,0) imp_kep, round(sum(n.imp)::numeric,0) imp_nos
      FROM kep k FULL OUTER JOIN nos n ON n.sku=k.sku AND n.suc=k.suc AND n.d=k.d`)).rows[0];
  const mq = pct(m.qty_ok, m.ambos); const mi = pct(m.imp_ok, m.ambos);
  console.log(`     celdas en ambos: ${N(m.ambos)} · CANTIDAD ${mq.toFixed(2)}% · IMPORTE ${mi.toFixed(2)}%`);
  console.log(`     totales: Kepler ${money(m.imp_kep)}  ·  nosotros ${money(m.imp_nos)}  ·  delta ${money(Number(m.imp_kep) - Number(m.imp_nos))}`);
  check('el IMPORTE del mostrador sigue casi idéntico (≥ 99.5%)', mi >= 99.5, `${mi.toFixed(2)}%`);

  // ── 2. Los dos lados: lo que falta y lo que sobra ⭐ ───────────────────────────────────────
  console.log('\n── 2. Los DOS lados (una comparación que sólo mira la intersección no ve lo que falta) ──');
  console.log(`     sólo en Kepler:  ${N(t.solo_kep)} celdas ${money(t.imp_solo_kep)}`);
  console.log(`     sólo nuestras:   ${N(t.solo_nos)} celdas ${money(t.imp_solo_nos)}`);
  check('⭐ no publicamos venta que Kepler NO tiene (≤ 500 celdas)', t.solo_nos <= 500,
    `${N(t.solo_nos)} celdas ${money(t.imp_solo_nos)}`);
  // Hoy 5,178 celdas / $1,225,253 (medido tras K.3). Es el objetivo de K.4: el SKU SÍ existe en
  // el catálogo y la fila simplemente no llega al fact. Creció en dinero, no en celdas, porque
  // ahora entre las que faltan hay renglones de U-D-8/12.
  check('la venta que Kepler tiene y nosotros no, no crece (≤ 6,000 celdas — hoy 5,178)',
    t.solo_kep <= 6000, `${N(t.solo_kep)} celdas ${money(t.imp_solo_kep)}`);

  // ── 3. La brecha por CAUSA — es lo que convierte esto en instrumento ──────────────────────
  console.log('\n── 3. La CANTIDAD que difiere, partida por causa ──');
  for (const r of (await c.query(`
    WITH kep AS (${kepler(VENTA)}), nos AS (${nuestro()})
    SELECT CASE WHEN abs(n.qty-k.qty)<=0.01 THEN 'IDÉNTICA'
                WHEN COALESCE(n.rf,1) > 1   THEN 'el importer MULTIPLICÓ (rung_factor>1)'
                WHEN n.mix                  THEN 'peldaño mezclado'
                WHEN n.qty < k.qty          THEN 'convertimos a una unidad MAYOR (p.ej. 500 g -> kg)'
                ELSE                             'otra' END causa,
           count(*)::int celdas,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY n.qty/NULLIF(k.qty,0))::numeric,3) razon
      FROM kep k JOIN nos n ON n.sku=k.sku AND n.suc=k.suc AND n.d=k.d
     GROUP BY 1 ORDER BY celdas DESC`)).rows) {
    console.log(`     ${String(r.causa).padEnd(46)} ${N(r.celdas).padStart(7)} celdas · razón nuestra/Kepler ${r.razon}`);
  }

  // ── 4. ⭐ K.3 — el dinero llegó, y llegó al CANAL correcto ─────────────────────────────────
  // Hasta K.3 este bloque medía una brecha y afirmaba que siguiera medida (P.2 pendiente).
  // Ya entró, así que la afirmación se da vuelta: los dos doctypes tienen que estar DENTRO, y
  // U-D-8 tiene que estar en `mayoreo` — no escondido en `credito`, que era el riesgo real.
  console.log('\n── 4. ⭐ K.3 — los doctypes que faltaban, y el canal donde aterrizan ──');
  const porDoc = (await c.query(`
    SELECT btrim(l.c4::text) doc, count(*)::int renglones, round(sum(l.c13)::numeric,0) imp
      FROM kepler_ods.kdm2 l
     WHERE l.c2='U' AND l.c3='D' AND btrim(l.c1::text)=l.sucursal::text
       AND l.c32::date > current_date - ${DIAS} AND btrim(l.c4::text) IN (${VENTA})
     GROUP BY 1 ORDER BY imp DESC`)).rows;
  const kepDe = (doc) => Number((porDoc.find((r) => r.doc === doc) || {}).imp || 0);
  for (const r of porDoc) console.log(`     Kepler U-D-${String(r.doc).padEnd(3)} ${N(r.renglones).padStart(7)} renglones · ${money(r.imp)}`);

  const nCanal = (await c.query(`
    SELECT s.channel, round(sum(s.revenue)::numeric,0) imp
      FROM analytics.sales_daily s
      JOIN commercial.warehouses w ON w.tenant_id=s.tenant_id AND w.id=s.warehouse_id
     WHERE s.tenant_id='${T}'::uuid AND s.sale_date > current_date - ${DIAS}
       AND w.kepler_code IS NOT NULL AND s.channel NOT LIKE 'wincaja_%'
     GROUP BY 1 ORDER BY 2 DESC`)).rows;
  console.log('     nuestros canales:');
  for (const r of nCanal) console.log(`       ${String(r.channel).padEnd(10)} ${money(r.imp)}`);

  const may = Number((nCanal.find((r) => r.channel === 'mayoreo') || {}).imp || 0);
  const k8 = kepDe('8');
  const may8 = pct(may, k8);
  console.log(`     ⭐ mayoreo nuestro ${money(may)}  vs  U-D-8 de Kepler ${money(k8)}  ->  ${may8.toFixed(2)}%`);
  check('⭐ K.3 — U-D-8 (Telemarketing) aterriza en el canal `mayoreo`, no en `credito`',
    may8 >= 95 && may8 <= 105,
    `${may8.toFixed(2)}% — si da ~0, el doctype no llegó a mart.ventas y el telemarketing se está publicando como crédito`);
  check('⛔ el canal `mayoreo` existe y no está vacío', may > 0, `${money(may)}`);

  // ── 5. Lo que este candado NO mide, declarado ─────────────────────────────────────────────
  console.log('\n── 5. Lo que este candado no mide ──');
  console.log('     ⚠️  Sólo las sucursales de Kepler (01-06). Wincaja no tiene un renglón crudo');
  console.log('        comparable: su unidad sale del catálogo, no de la línea.');
  console.log('     ⚠️  Sólo `sales_daily`. El sell-out lee `mv_kepler_sales_daily`; desde K.3 usan');
  console.log('        el MISMO corte (8/10/12), pero siguen difiriendo en el costo (el fact lo');
  console.log('        fabrica con markup) y en el vendedor (el fact no lo trae) — ADR-051.');
  console.log('     ⚠️  El bloque 1b no puede recortar nuestro lado a U-D-12: `sales_daily` no lleva');
  console.log('        el doctype, y U-D-12 comparte el canal `credito` con el crédito de U-D-10.');
  console.log('        Lo que sí se puede aislar es `mayoreo` = U-D-8, y eso es el bloque 4.');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
