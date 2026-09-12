/* eslint-disable no-console */
/**
 * CANDADO — EL UxC QUE SE PUBLICA SALE DEL RESOLVEDOR, Y LO QUE NO SE PUEDE AFIRMAR VA NULL (UXC.1).
 *
 * Lo abrió Edgar señalando una celda de Sell-Out:
 *
 *     96504   RUFFLES QUESO 27G / 1   UxC = 1      <- y son 58
 *
 * ── Lo que este candado existe para impedir ─────────────────────────────────────────────────
 *
 * El número salía de `catalog.products.factor_sale`, que es **otra fuente** distinta del
 * resolvedor canónico que ADR-055 declara. Medido en prod el 2026-09-11:
 *
 *     Sell-Out publicaba 1 y el resolvedor dice >1 ....  208 productos · $4,971,338 / 90 d
 *     factor_sale difiere del resolvedor (cualquier direccion) ...  659 de 11,236
 *
 * Y el catálogo no era el único: había CUATRO consumidores con CUATRO fuentes del mismo número —
 * Sell-Out (`factor_sale`), Andén (`product_barcodes.factor`), Compras (`factor_sale` con
 * respaldo en la etiquetera) y el resolvedor.
 *
 * ⚠️ Este candado NO afirma que el resolvedor tenga razón siempre: afirma que **se publica el
 * resolvedor o no se publica nada**. El tamaño de cada desacuerdo lo vigila su propio candado.
 */

const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
// ⛔ `Number(n || 0)` convierte un campo INEXISTENTE en 0. Paso el 2026-09-11: una consulta
// aliaseaba `sin_testigo_NO_escribir` y Postgres devuelve `sin_testigo_no_escribir` (baja a
// minusculas los identificadores sin comillas); el helper dibujo 1,479 como CERO y por poco
// se decide sobre ese cero. Un campo ausente NO es un cero -- se grita.
const N = (n) => {
  if (n === undefined) throw new Error('N() recibio undefined: nombre de columna mal escrito '
    + '(Postgres devuelve los alias en MINUSCULAS). Un campo ausente no es un cero.');
  return Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
};

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query(`SET statement_timeout = '300s'`);
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  console.log('\n=== CANDADO: el UxC publicado sale del resolvedor (UXC.1) ===\n');

  // ── 1. La vista existe y es del grano correcto ───────────────────────────────────────────
  console.log('── 1. El resolvedor de consenso ──');
  const existe = (await q(`SELECT to_regclass('analytics.v_product_box_factor_consensus') t`))[0].t;
  check('analytics.v_product_box_factor_consensus existe', !!existe);
  if (!existe) {
    console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
    await c.end(); process.exit(1);
  }

  const [g] = await q(`
    SELECT count(*)::int productos,
           count(*) FILTER (WHERE veredicto = 'consenso')::int consenso,
           count(*) FILTER (WHERE veredicto = 'difiere_entre_plazas')::int difieren,
           count(*) FILTER (WHERE veredicto = 'sin_testigo')::int sin_testigo,
           count(*) FILTER (WHERE box_factor_publicable IS NOT NULL)::int publicables
      FROM analytics.v_product_box_factor_consensus WHERE tenant_id = $1`, [T]);
  console.log(`     ${N(g.productos)} productos · consenso ${N(g.consenso)}`
    + ` · difieren ${N(g.difieren)} · sin testigo ${N(g.sin_testigo)}`);

  // ── 2. ⭐⭐ EL INVARIANTE: no se publica un número sin consenso ───────────────────────────
  console.log('\n── 2. ⭐⭐ No se publica un número sin consenso ──');
  const [mal] = await q(`
    SELECT count(*)::int n FROM analytics.v_product_box_factor_consensus
     WHERE tenant_id = $1 AND box_factor_publicable IS NOT NULL AND veredicto <> 'consenso'`, [T]);
  check('⭐⭐ ninguna fila publica un factor sin consenso entre plazas',
    mal.n === 0, `${N(mal.n)} filas publican un número que las plazas contradicen`);
  check('⭐ y el recíproco: todo consenso publica su número',
    g.publicables === g.consenso, `publicables ${N(g.publicables)} vs consenso ${N(g.consenso)}`);

  // ── 3. ⛔ PRUEBA NEGATIVA: `default` no es un voto ────────────────────────────────────────
  console.log('\n── 3. ⛔ PRUEBA NEGATIVA: `default` es ausencia, no opinión ──');
  const [cd] = await q(`
    SELECT count(*)::int n FROM (
      SELECT product_id FROM analytics.v_warehouse_box_factor WHERE tenant_id = $1
       GROUP BY product_id HAVING count(DISTINCT box_factor) > 1) z`, [T]);
  check('⭐ excluir `default` MUERDE: contarlo da más desacuerdos de los que la vista declara',
    cd.n > g.difieren,
    `contándolo ${N(cd.n)} vs declarados ${N(g.difieren)} — si fueran iguales, la exclusión sería decorativa`);
  console.log(`     (contar 'default' fabricaría ${N(cd.n - g.difieren)} desacuerdos que no existen)`);

  // ── 4. El caso que abrió el reporte ───────────────────────────────────────────────────────
  console.log('\n── 4. El caso que abrió el reporte ──');
  const caso = await q(`
    SELECT p.sku, v.box_factor_publicable AS publicable, v.veredicto, v.source,
           v.plazas_con_testigo, p.factor_sale
      FROM analytics.v_product_box_factor_consensus v
      JOIN catalog.products p ON p.id = v.product_id AND p.tenant_id = v.tenant_id
     WHERE v.tenant_id = $1 AND p.sku = '96504' AND p.deleted_at IS NULL`, [T]);
  if (!caso.length) {
    nomedido('el SKU 96504', 'ya no está en el catálogo activo');
  } else {
    const k = caso[0];
    console.log(`     96504: publicable ${k.publicable} (${k.veredicto}, ${k.source},`
      + ` ${k.plazas_con_testigo} plazas) · factor_sale del catálogo: ${k.factor_sale}`);
    check('⭐ 96504 RUFFLES QUESO 27G publica 58, no 1', Number(k.publicable) === 58,
      `publica ${k.publicable}`);
    // ⭐⭐ Esta aserción cambió de sentido el 2026-09-11, y el cambio es el punto.
    //
    // Nació diciendo "el catálogo TODAVIA dice 1" — o sea vigilaba que el bug siguiera ahí,
    // porque el arreglo de ese momento (UXC.1) sólo apuntaba la PANTALLA al resolvedor y dejaba
    // la columna mintiendo. Edgar lo llamó por su nombre: "no quiero parches, quiero una verdad
    // absoluta". VA.3 elimino la segunda verdad — `factor_sale` se escribio con el valor del
    // arbitro en las 854 filas con testigo — asi que ahora la aserción vigila lo contrario: que
    // el catalogo y el arbitro digan LO MISMO. Si vuelven a separarse, alguien escribio un
    // factor que el arbitro contradice.
    check('⭐⭐ el catálogo y el árbitro dicen LO MISMO para 96504 (VA.3, ya no hay dos verdades)',
      Number(k.factor_sale) === Number(k.publicable),
      `catálogo ${k.factor_sale} vs árbitro ${k.publicable} — volvieron a divergir`);
    const [pag] = await q(`
      SELECT sc.units_per_box::numeric upb FROM analytics.v_supplier_cost_ladder sc
       WHERE sc.sku = '96504'`);
    if (!pag || pag.upb == null) {
      nomedido('el testigo pagado de 96504', 'no hay escalera de costo del proveedor para ese SKU');
    } else {
      check('⭐ y lo PAGADO al proveedor confirma esas 58 (testigo independiente del ERP)',
        Math.abs(Number(pag.upb) - 58) <= 0.6, `lo pagado da ${Number(pag.upb).toFixed(2)}`);
    }
  }

  // ── 5. ⭐ El testigo independiente: lo PAGADO al proveedor ────────────────────────────────
  console.log('\n── 5. ⭐ El testigo independiente (lo pagado al proveedor) ──');
  const [w] = await q(`
    SELECT count(*)::int con_testigo,
           count(*) FILTER (WHERE abs(sc.units_per_box - v.box_factor_publicable) <= 0.6)::int confirma,
           count(*) FILTER (WHERE abs(sc.units_per_box - v.box_factor_publicable) > 0.6)::int contradice
      FROM analytics.v_product_box_factor_consensus v
      JOIN catalog.products p ON p.id = v.product_id AND p.tenant_id = v.tenant_id
      JOIN analytics.v_supplier_cost_ladder sc ON sc.sku = p.sku
     WHERE v.tenant_id = $1 AND v.box_factor_publicable IS NOT NULL
       AND sc.units_per_box IS NOT NULL AND p.deleted_at IS NULL`, [T]);
  const pctConf = w.con_testigo ? (100 * w.confirma / w.con_testigo) : 0;
  console.log(`     ${N(w.con_testigo)} publicados con testigo pagado · confirma ${N(w.confirma)}`
    + ` (${pctConf.toFixed(1)}%) · contradice ${N(w.contradice)}`);
  check('la mayoría de lo publicado coincide con lo que se le pagó al proveedor',
    pctConf > 70, `${pctConf.toFixed(1)}%`);
  check('⛔ y queda contradicción DECLARADA (si diera 0, el testigo sería un espejo — ADR-059 R5)',
    w.contradice > 0, 'cero contradicciones: revisar si el testigo discrimina');

  // ── 6. ⭐⭐ Sell-Out ya no lee `catalog.products.factor_sale` ─────────────────────────────
  console.log('\n── 6. ⭐⭐ Sell-Out dejó de leer la fuente equivocada ──');
  const fs = require('fs');
  const path = require('path');
  const SRV = path.resolve(__dirname, '..', '..',
    'libs/commercial/src/lib/commercial-analytics/commercial-analytics.service.ts');
  const EXP = path.resolve(__dirname, '..', '..',
    'libs/commercial/src/lib/commercial-analytics/sell-out-export.service.ts');
  if (!fs.existsSync(SRV)) {
    nomedido('el cableado de Sell-Out', 'no se encontró commercial-analytics.service.ts');
  } else {
    const src = fs.readFileSync(SRV, 'utf8');
    check('⭐⭐ Sell-Out lee `v_product_box_factor_consensus`',
      src.includes('v_product_box_factor_consensus'));
    const rastro = (src.match(/uxc:\s*[rp]\.factor_sale/g) || []).length;
    check('⭐ y ya NO arma el `uxc` con `factor_sale` en el pivote ni por vendedor',
      rastro === 0, `quedan ${rastro} sitios leyendo factor_sale para el uxc`);
    const exp = fs.readFileSync(EXP, 'utf8');
    check('⭐ el EXPORT (Excel + HTML/PDF) también pasa por el resolvedor',
      exp.includes('uxcCelda'), 'el export seguiría imprimiendo el valor crudo');
    // ⚠️ Se mide sobre CÓDIGO, no sobre prosa: la primera versión de esta aserción hacía grep de
    // `prod.uxc ?? ''` y se ponía roja por el COMENTARIO que cita el código viejo. Una aserción
    // por texto se deja engañar por su propia documentación.
    const sinComentarios = exp
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const mudos = (sinComentarios.match(/=\s*prod\.uxc \?\? ''/g) || []).length
      + (sinComentarios.match(/\$\{p\.uxc \?\? ''\}/g) || []).length;
    check('⛔ y una celda vacía del export ya no es MUDA: declara el motivo',
      mudos === 0, `${mudos} sitios imprimen un blanco sin decir por qué`);
  }

  // ── 7. Lo que este candado NO mide ───────────────────────────────────────────────────────
  console.log('\n── 7. Lo que este candado no mide ──');
  console.log('     ⚠️  NO afirma que el resolvedor acierte: afirma que se publica el resolvedor');
  console.log('        o no se publica nada. Los desacuerdos con lo pagado quedan declarados.');
  console.log('     ⚠️  Cubre Sell-Out (pivote + por vendedor + export) y Salidas. NO cubre');
  console.log('        Compras ni Andén: van en su propio commit, con su propio antes/después.');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
