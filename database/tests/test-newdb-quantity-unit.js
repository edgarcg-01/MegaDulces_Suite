/* eslint-disable no-console */
/**
 * CANDADO — UNA CANTIDAD QUE NO DICE SU UNIDAD NO ES UN DATO, ES UN NÚMERO (VU.1).
 *
 * Edgar, 2026-09-12: *"¿ya tenemos una verdad absoluta en todo lugar donde se muevan unidades,
 * existencias y ventas?"*.
 *
 * ── Qué vigila ──────────────────────────────────────────────────────────────────────────────
 *
 * Este candado NO mide un número de negocio: mide una FORMA. Y existe porque la forma es
 * justamente lo que se erosiona sin que nadie lo note — una columna de cantidad nueva se agrega en
 * cualquier migración, en cualquier fase, y nadie la ve hasta que alguien le presta una unidad.
 *
 *   1. ⭐ El censo de "cantidad sin unidad al lado" **no crece**. Es un trinquete: el baseline
 *      está medido, y una tabla nueva con cantidad y sin unidad lo pone rojo.
 *   2. Las tres columnas del sello existen en las tablas de captura y son **nullables sin default**
 *      — la ausencia de unidad tiene que poder existir como ausencia (ADR-056).
 *   3. ⭐⭐ El histórico NO se rellenó. Si un día las filas viejas aparecen con `qty_unit`, alguien
 *      convirtió una ignorancia medible en una afirmación falsa.
 *   4. PRUEBA NEGATIVA: el censo tiene que ENCONTRAR tablas sin unidad. Si diera cero, no es que
 *      el problema se resolvió — es que la consulta dejó de mirar.
 *
 * ⛔ Lo que NO mide: que el valor escrito en `qty_unit` sea el correcto. Eso lo tiene que arbitrar
 * el dinero o el ERP, y se hace por tabla cuando esa tabla tenga volumen.
 */

const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

// ⭐ Baseline MEDIDO contra prod el 2026-09-12, no estimado. Puede BAJAR (se corrigen tablas),
// nunca subir. Una tabla nueva con cantidad y sin unidad rompe esto a propósito.
//
// ⚠️ Arrancó en 12 y bajó a 10 al sellar `vendor_sale_lines` y `stock_movements`
// (`order_lines` ya contaba como "declara" por un falso positivo: su columna `unit_price`).
// Una medición anterior mía había dicho **22**, y estaba inflada: la regex de cantidad incluía
// `counted|contado|conteo` y agarraba `counted_at`/`counted_by`, que son fecha y usuario.
const BASELINE_SIN_UNIDAD = 10;

const SCHEMAS = `('commercial','inventory','analytics','catalog','logistics','trade')`;
const RX_QTY = `'^(quantity|qty|cantidad|units|counted_qty|conteo|piezas|cajas)([_a-z]+)?$'`;
const RX_UNIT = `'^(unit|unidad|uom|unit_kind|base_label|rung_factor|qty_unit|unit_sale|unit_base)([_a-z]+)?$'`;

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query(`SET statement_timeout = '300s'`);
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  console.log('\n=== CANDADO: la unidad viaja con la cantidad (VU.1) ===\n');

  // ── 1. El censo, y el trinquete ───────────────────────────────────────────────────────────
  console.log('── 1. ⭐ Censo: tablas con cantidad y SIN unidad al lado ──');
  const CENSO = `
    WITH qty AS (
      SELECT ic.table_schema AS sch, ic.table_name AS tab
        FROM information_schema.columns ic
        JOIN pg_class pc ON pc.relname = ic.table_name
        JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = ic.table_schema
       WHERE ic.table_schema IN ${SCHEMAS} AND pc.relkind = 'r'
         AND ic.column_name ~ ${RX_QTY}
       GROUP BY 1, 2),
    uni AS (
      SELECT ic.table_schema AS sch, ic.table_name AS tab
        FROM information_schema.columns ic
       WHERE ic.table_schema IN ${SCHEMAS} AND ic.column_name ~ ${RX_UNIT}
       GROUP BY 1, 2)
    SELECT qty.sch, qty.tab, (uni.tab IS NOT NULL) AS declara
      FROM qty LEFT JOIN uni ON uni.sch = qty.sch AND uni.tab = qty.tab`;
  const censo = await q(CENSO);
  const sin = censo.filter((r) => !r.declara);
  const con = censo.filter((r) => r.declara);
  console.log(`     ${censo.length} tablas con columna de cantidad · declaran unidad ${con.length}`
    + ` · SIN unidad ${sin.length} (baseline ${BASELINE_SIN_UNIDAD})`);
  if (sin.length) {
    console.log(`     sin unidad: ${sin.map((r) => `${r.sch}.${r.tab}`).slice(0, 12).join(' · ')}`
      + (sin.length > 12 ? ` … y ${sin.length - 12} más` : ''));
  }
  check('⭐ el censo de cantidad-sin-unidad NO crece (trinquete)',
    sin.length <= BASELINE_SIN_UNIDAD,
    `${sin.length} contra un baseline de ${BASELINE_SIN_UNIDAD}: entró una tabla nueva con una `
    + 'cantidad y sin decir en qué unidad está. Agregarle el sello de `quantity-unit.contract.ts`, '
    + 'o si de verdad no aplica, bajar el baseline con el motivo escrito');
  if (sin.length < BASELINE_SIN_UNIDAD) {
    console.log(`     ⬇️  bajó a ${sin.length}: actualizar BASELINE_SIN_UNIDAD en este archivo.`);
  }

  // ⭐ PRUEBA NEGATIVA — el censo tiene que estar viendo algo.
  check('⭐ PRUEBA NEGATIVA: el censo encuentra tablas (no se quedó ciego)',
    censo.length > 20,
    `sólo ${censo.length} tablas con columna de cantidad en seis schemas: la regex dejó de matchear`);

  // ── 2. El sello existe donde un humano captura ────────────────────────────────────────────
  console.log('\n── 2. Las tres columnas del sello, y que admitan ausencia ──');
  const sello = await q(`
    SELECT table_name AS tab, column_name AS col, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'commercial'
       AND table_name IN ('order_lines','vendor_sale_lines','stock_movements')
       AND column_name IN ('qty_unit','qty_factor','qty_factor_source')
     ORDER BY 1, 2`);
  if (!sello.length) {
    nomedido('el sello de unidad', 'las columnas no existen todavía — correr la migración VU.1');
  } else {
    console.log(`     ${sello.length} de 9 columnas presentes`);
    check('las 9 columnas del sello existen', sello.length === 9, `${sello.length}`);
    const obligatorias = sello.filter((r) => r.is_nullable === 'NO' || r.column_default !== null);
    check('⭐ las 9 son NULLABLES y sin default: la ausencia se puede DECLARAR',
      obligatorias.length === 0,
      obligatorias.map((r) => `${r.tab}.${r.col}`).join(', ')
      + ' — una unidad obligatoria se rellena sola, y un relleno es una afirmación que nadie hizo');
  }

  // ── 3. El histórico sigue sin rellenar ────────────────────────────────────────────────────
  console.log('\n── 3. ⭐⭐ El histórico NO se rellenó con un default ──');
  if (!sello.length) {
    nomedido('el histórico', 'el sello todavía no existe');
  } else {
    for (const tab of ['order_lines', 'vendor_sale_lines', 'stock_movements']) {
      const [r] = await q(`
        SELECT count(*)::int filas,
               count(*) FILTER (WHERE qty_unit IS NOT NULL)::int con_unidad,
               count(DISTINCT qty_unit)::int rotulos
          FROM commercial.${tab}`);
      console.log(`     commercial.${tab}: ${r.filas} filas · con unidad ${r.con_unidad}`
        + ` · ${r.rotulos} rótulos distintos`);
      // ⚠️ Que HAYA filas con unidad no es malo: significa que el escritor nuevo ya sella. Lo malo
      // seria que las TENGAN TODAS de golpe, que es la firma de un UPDATE masivo de relleno.
      if (r.filas > 0 && r.con_unidad === r.filas && r.rotulos === 1) {
        check(`commercial.${tab}: el histórico no fue rellenado en bloque`,
          false,
          `las ${r.filas} filas traen el MISMO rótulo: firma de un UPDATE de relleno sobre `
          + 'historia que nadie registró (ADR-056)');
      } else {
        check(`commercial.${tab}: sin firma de relleno masivo`, true);
      }
    }
  }

  // ── 4. ⭐ La conversión del servidor: cobertura Y capacidad de RECHAZO ────────────────────
  //
  // `resolverUnidadCaptura` (commercial-orders) convierte una captura en CAJA a la unidad base y
  // **rechaza** cuando el resolvedor no puede afirmar el factor. Las dos mitades importan: si
  // convirtiera todo, el guard no estaría discriminando; si rechazara todo, la función sería
  // inútil. Este bloque mide las dos contra el mismo predicado que usa el servicio.
  console.log('\n── 4. ⭐ Captura en CAJA: cuánto convierte y cuánto RECHAZA ──');
  const conv = await q(`
    WITH vta AS (
      SELECT product_id, sum(monto) m FROM analytics.v_sellout_daily
       WHERE tenant_id = $1 AND business_date >= current_date - 90 AND channel <> 'traspaso'
       GROUP BY 1)
    SELECT (bf.product_id IS NOT NULL
            AND bf.source <> 'default'
            AND COALESCE(bf.is_master_suspect, false) = false
            AND bf.box_factor::numeric > 1) AS convierte,
           count(*)::int productos,
           round(sum(COALESCE(vta.m, 0))::numeric, 0) AS venta_90d
      FROM catalog.products p
      LEFT JOIN analytics.v_product_box_factor bf
             ON bf.tenant_id = p.tenant_id AND bf.product_id = p.id
      LEFT JOIN vta ON vta.product_id = p.id
     WHERE p.tenant_id = $1 AND p.deleted_at IS NULL
     GROUP BY 1`, [T]);
  const si = conv.find((r) => r.convierte === true) || { productos: 0, venta_90d: 0 };
  const no = conv.find((r) => r.convierte === false) || { productos: 0, venta_90d: 0 };
  const totalV = Number(si.venta_90d) + Number(no.venta_90d);
  const pct = totalV > 0 ? (100 * Number(si.venta_90d) / totalV) : 0;
  console.log(`     convierte ${si.productos} productos ($${Number(si.venta_90d).toLocaleString('en-US')})`
    + ` · RECHAZA ${no.productos} ($${Number(no.venta_90d).toLocaleString('en-US')})`);
  console.log(`     el dinero cubierto por la conversión es ${pct.toFixed(1)}%`);
  check('⭐ la conversión sirve: cubre la mayor parte del dinero',
    pct > 60,
    `${pct.toFixed(1)}% — si cae, capturar en caja deja de ser una opción real y la pantalla `
    + 'tiene que volver a pedir la unidad base');
  check('⭐ PRUEBA NEGATIVA: y RECHAZA de verdad (el guard discrimina)',
    Number(no.productos) > 0,
    'cero rechazos: el guard dejó de exigir afirmación y está convirtiendo también donde el '
    + 'resolvedor no sostiene el factor — que es meter una pieza donde se pidió una caja');

  // ── 5. Lo que este candado NO mide ────────────────────────────────────────────────────────
  console.log('\n── 5. Lo que este candado no mide ──');
  console.log('     ⛔ Que el VALOR de qty_unit sea el correcto. Eso lo arbitra el dinero o el ERP,');
  console.log('        y se hace por tabla cuando esa tabla tenga volumen.');
  console.log('     ⚠️  El censo es por NOMBRE de columna: una cantidad llamada de otra forma se le');
  console.log('        escapa, y una columna llamada `unit_price` le cuenta como "declara unidad".');
  console.log('        Es un piso, no un techo.');
  console.log('     ⬜ Fuera de alcance por medición: `commercial.stock` (63,583) y `stock_lots`');
  console.log('        (68,843) son ESPEJO del ERP y la verdad absoluta manda NO leerlos (§5).');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
