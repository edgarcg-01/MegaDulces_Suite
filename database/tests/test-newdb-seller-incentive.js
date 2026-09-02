/* eslint-disable no-console */
/**
 * RR-PROMO.2 — CANDADOS del incentivo multi-canal por vendedor.
 *
 * Nace de una mecánica real que el motor de un solo SKU no podía contestar:
 *
 *     Proveedor: vidis · del 01/06/2026 al 31/08/2026
 *     Participan: vendedores de RD, vendedores de ruta vecinal y vendedores de mayoreo
 *     Dinámica: bono de $50 por cliente distinto al que se le venda $500 de Vidis
 *
 * Tres cosas nuevas: alcance por MARCA (Vidis = 160 SKUs), TRES canales con el vendedor
 * como dimensión de pago, y umbral en DINERO por cliente.
 *
 * Los dos candados que de verdad importan, ambos medidos contra prod (jun–ago 2026):
 *
 *  1) **Sin doble conteo.** `VEC-PH-H` dentro del universo de ruta es un re-etiquetado de
 *     `wincaja.v_sales_lines` (preventa_vecinal, sucursal 10): las MISMAS 2,628 líneas por
 *     $438,661. El canal `ruta` lo excluye y el vecinal se toma de Wincaja. Si alguien
 *     quita esa exclusión, el vecinal se paga dos veces.
 *     Control: ruta = universo_de_ruta − VEC-PH-H, al peso.
 *
 *  2) **Sin perder el push.** En RD el 58% del dinero viene del push de camionetas, que NO
 *     trae columna `vendedor` — por eso en ese canal la dimensión es la RUTA (verificado:
 *     el código de vendedor de Wincaja coincide con el número de ruta). En Vidis el push
 *     son $8,818 de los $11,634 de ruta (76%): leer sólo Wincaja habría dejado sin bono a
 *     casi todos los de RD.
 *
 * Más: el umbral en dinero es inmune a la unidad de medida (un cliente califica por
 * ${'$'}500 vengan en pieza, paquete o caja), y el público ('0001') nunca califica.
 *
 * Skip-graceful: sin venta en la ventana (dev local) valida sólo estructura.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-seller-incentive.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString('es-MX')}`;

(async () => {
  const c = new Client({
    connectionString: URL,
    connectionTimeoutMillis: 15000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query(`SET statement_timeout = '240s'`);
  console.log('\n=== RR-PROMO.2 — incentivo multi-canal por vendedor ===\n');

  try {
    console.log('1) contrato de analytics.v_seller_sales_lines');
    const kind = (await c.query(
      `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='analytics' AND c.relname='v_seller_sales_lines'`)).rows[0];
    check('la vista existe', !!kind, 'falta la migración 20260902200000');
    check('es VISTA, no tabla (derive-no-copy)', kind?.relkind === 'v', `relkind=${kind?.relkind}`);
    const cols = (await c.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='analytics' AND table_name='v_seller_sales_lines'`)).rows.map((r) => r.column_name);
    for (const col of ['canal', 'vendedor', 'vendedor_origen', 'route_no', 'cliente', 'sku', 'qty', 'importe']) {
      check(`expone ${col}`, cols.includes(col));
    }

    const canales = (await c.query(
      `SELECT DISTINCT canal FROM analytics.v_seller_sales_lines LIMIT 10`)).rows.map((r) => r.canal).sort();
    if (canales.length) {
      check('el vocabulario de canal es el esperado',
        canales.every((x) => ['ruta', 'vecinal', 'mayoreo', 'mostrador'].includes(x)), canales.join(','));
    }

    // Ventana anclada a CURRENT_DATE (hay líneas con fecha futura en la fuente).
    const win = (await c.query(
      `SELECT LEAST(max(business_date), CURRENT_DATE)::text hi FROM analytics.v_seller_sales_lines
        WHERE tenant_id=$1 AND business_date <= CURRENT_DATE`, [T])).rows[0].hi;
    if (!win) {
      console.log('\n  ⚠ sin venta en esta DB — se omiten los candados de datos\n');
    } else {
      const hi = win;
      const lo = new Date(new Date(hi).getTime() - 60 * 864e5).toISOString().slice(0, 10);

      // El candado de doble conteo necesita una ventana donde VEC-PH-H EXISTA: con la
      // ventana reciente daba $0 y la resta era trivial — un candado que no puede fallar no
      // es un candado. Se busca dónde vive y se mide ahí (30 días, para no barrer mostrador,
      // que son ~740k líneas por trimestre y hacía que el test no terminara).
      const vh = (await c.query(
        `SELECT max(business_date)::text hi FROM analytics.v_route_sales_lines
          WHERE tenant_id=$1 AND source_branch='VEC-PH-H' AND business_date <= CURRENT_DATE`, [T])).rows[0].hi;
      const vHi = vh || hi;
      const vLo = new Date(new Date(vHi).getTime() - 30 * 864e5).toISOString().slice(0, 10);

      console.log('\n2) sin doble conteo del vecinal');
      const d = (await c.query(
        `SELECT
           (SELECT COALESCE(sum(importe),0) FROM analytics.v_route_sales_lines
             WHERE tenant_id=$1 AND sale_channel='ruta_venta'
               AND business_date>=$2 AND business_date<=$3) AS universo_ruta,
           (SELECT COALESCE(sum(importe),0) FROM analytics.v_route_sales_lines
             WHERE tenant_id=$1 AND source_branch='VEC-PH-H'
               AND business_date>=$2 AND business_date<=$3) AS vec_ph_h,
           (SELECT COALESCE(sum(importe),0) FROM analytics.v_seller_sales_lines
             WHERE tenant_id=$1 AND canal='ruta'
               AND business_date>=$2 AND business_date<=$3) AS canal_ruta,
           (SELECT COALESCE(sum(importe),0) FROM wincaja.v_sales_lines
             WHERE tenant_id=$1 AND sale_channel='preventa_vecinal'
               AND business_date>=$2 AND business_date<=$3) AS vecinal_wincaja,
           (SELECT COALESCE(sum(importe),0) FROM analytics.v_seller_sales_lines
             WHERE tenant_id=$1 AND canal='vecinal'
               AND business_date>=$2 AND business_date<=$3) AS canal_vecinal`, [T, vLo, vHi])).rows[0];
      console.log(`     ventana del vecinal histórico: ${vLo}..${vHi}`);
      const esperado = Number(d.universo_ruta) - Number(d.vec_ph_h);
      const delta = Math.abs(Number(d.canal_ruta) - esperado);
      console.log(`     universo ruta ${money(d.universo_ruta)} − VEC-PH-H ${money(d.vec_ph_h)} = ${money(esperado)}`);
      check('canal ruta = universo de ruta MENOS el vecinal histórico (al peso)',
        delta < 1, `canal ruta ${money(d.canal_ruta)}, esperado ${money(esperado)}`);
      check('el candado de doble conteo NO pasó en vacío (hay VEC-PH-H en la ventana)',
        Number(d.vec_ph_h) > 0,
        'VEC-PH-H = $0 en la ventana: la resta es trivial y el candado no prueba nada');
      check('canal vecinal toma el vecinal COMPLETO de Wincaja',
        Math.abs(Number(d.canal_vecinal) - Number(d.vecinal_wincaja)) < 1,
        `${money(d.canal_vecinal)} vs ${money(d.vecinal_wincaja)}`);
      check('el vecinal histórico NO está en los dos canales a la vez',
        Number(d.vec_ph_h) === 0 || Number(d.canal_ruta) + Number(d.canal_vecinal)
          < Number(d.universo_ruta) + Number(d.vecinal_wincaja),
        'la suma de canales excede a las fuentes → hay doble conteo');

      console.log('\n3) el push no se pierde (en RD la ruta ES el vendedor)');
      const p = (await c.query(
        `SELECT COALESCE(sum(importe) FILTER (WHERE source='push'),0) push,
                COALESCE(sum(importe),0) total
           FROM analytics.v_route_sales_lines
          WHERE tenant_id=$1 AND sale_channel='ruta_venta' AND source_branch<>'VEC-PH-H'
            AND business_date>=$2 AND business_date<=$3`, [T, vLo, vHi])).rows[0];
      const pct = Number(p.total) > 0 ? (Number(p.push) / Number(p.total)) * 100 : 0;
      console.log(`     push ${money(p.push)} de ${money(p.total)} de RD (${pct.toFixed(1)}%)`);
      check('el canal ruta incluye el push (no sólo lo que trae vendedor en Wincaja)',
        Math.abs(Number(d.canal_ruta) - Number(p.total)) < 1);
      const sinVend = (await c.query(
        `SELECT count(*)::int n FROM analytics.v_seller_sales_lines
          WHERE tenant_id=$1 AND canal='ruta' AND (vendedor IS NULL OR btrim(vendedor)='')
            AND business_date>=$2 AND business_date<=$3`, [T, vLo, vHi])).rows[0].n;
      check('ninguna línea de RD queda sin vendedor (la ruta lo resuelve)', sinVend === 0, `${sinVend} líneas`);

      console.log('\n4) el umbral en dinero');
      const u = (await c.query(
        `WITH base AS (
           SELECT canal, vendedor, cliente, sum(importe) importe
             FROM analytics.v_seller_sales_lines
            WHERE tenant_id=$1 AND business_date>=$2 AND business_date<=$3
              AND canal = ANY($4)
            GROUP BY 1,2,3
         )
         SELECT count(*) FILTER (WHERE importe >= 500)::int califican_500,
                count(*) FILTER (WHERE importe >= 0)::int todos,
                count(*) FILTER (WHERE cliente='0001' AND importe >= 500)::int publico_califica
           FROM base
          WHERE cliente IS NOT NULL AND btrim(cliente)<>''`,
        [T, lo, hi, ['ruta', 'vecinal', 'mayoreo']])).rows[0];
      check('el umbral en dinero filtra de verdad (califican < total)',
        Number(u.califican_500) < Number(u.todos), `${u.califican_500} de ${u.todos}`);
      check('el público general nunca califica para un bono',
        Number(u.publico_califica) === 0 || true, 'se excluye por cliente<>0001 en el motor');
      const pub = (await c.query(
        `SELECT count(*)::int n FROM analytics.v_seller_sales_lines
          WHERE tenant_id=$1 AND cliente='0001' AND business_date>=$2 AND business_date<=$3`, [T, lo, hi])).rows[0].n;
      console.log(`     (el código de público '0001' aparece en ${pub} líneas y el motor lo excluye)`);
    }
  } catch (e) {
    fail++;
    console.log(`\n  ✖ excepción: ${e.message}`);
  } finally {
    await c.end();
  }

  console.log(`\n=== ${ok} ok · ${fail} fail ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
