/* eslint-disable no-console */
/**
 * [AUD-DAT.20] CANDADO del ATAJO de Top Productos / Top Clientes de ruta.
 *
 * ── QUÉ PROTEGE ─────────────────────────────────────────────────────────────────────────────
 * `salesByRouteTops()` **omite las dos ramas de Wincaja** cuando la ventana pedida arranca
 * después del último día en que Wincaja vendió por ruta. Medido en prod el 2026-09-29, eso baja
 * una ventana post-corte de **3,941 ms a 195 ms**.
 *
 * Omitir una fuente es peligroso: si la cota se corre un día, se pierde venta **en silencio** —
 * la pantalla no queda vacía, queda *más chica*, y un número más chico nadie lo investiga. Este
 * candado existe para que ese silencio no sea posible.
 *
 * ── LO QUE SE VERIFICA ──────────────────────────────────────────────────────────────────────
 *  1. La cota está ACOTADA A HOY. Sin el tope, `max(business_date)` devuelve **2026-12-06**: hay
 *     una fila corrupta con fecha futura, y con ella el atajo nunca se activaría (falla barata)
 *     o —si el signo fuera al revés— omitiría meses vivos (falla cara).
 *  2. POST-CORTE el atajo es EXACTO: las 20 filas con y sin Wincaja son idénticas.
 *  3. PRUEBA NEGATIVA — PRE-CORTE el atajo CAMBIA el resultado. Sin este bloque, el número 2 se
 *     pondría verde aunque Wincaja estuviera vacía por un bug de la fuente, y el candado estaría
 *     certificando que "omitir no cambia nada" cuando la verdad sería "no hay nada que omitir".
 *  4. La decisión replica la del servicio, incluida la negativa por COBERTURA: si la ventana
 *     empieza antes del piso de la matvista (200 días), NO se omite — no hay con qué afirmar que
 *     Wincaja no aporta, y una omisión sin evidencia es una pérdida de venta.
 *
 * Lo que este candado NO cubre y se DECLARA: que el endpoint HTTP arme la respuesta con estas
 * filas es lógica de servicio; acá se fija el universo de datos, que es donde vive el riesgo.
 *
 *   DATABASE_URL_NEW=<prod o destino> node database/tests/test-newdb-route-tops-cutover.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0, fail = 0, nomedido = 0;
const pass = (m) => { ok++; console.log('  ✔', m); };
const bad = (m) => { fail++; console.log('  x FALLA:', m); };
const skip = (m) => { nomedido++; console.log('  ~ NO MEDIDO:', m); };

/** Las tres ramas, tal cual las arma el servicio. El push va PRIMERO: en un UNION los nombres de
 *  columna los pone la primera rama, y por eso `folio` lleva alias explícito. */
const RAMA_PUSH = `
  SELECT rpl.tenant_id, rpl.business_date, rpl.cliente, rpl.sku, rpl.qty, rpl.importe,
         rpl.folio AS consecutivo
    FROM analytics.route_push_lines rpl
   WHERE rpl.business_date >= $1 AND rpl.business_date <= $2 AND rpl.business_date <= CURRENT_DATE`;
const RAMA_WCJ_RUTA = `
  SELECT vl.tenant_id, vl.business_date, vl.cliente, vl.sku, vl.qty, vl.importe, vl.consecutivo
    FROM wincaja.v_sales_lines vl
   WHERE vl.sale_channel = 'ruta_venta'
     AND vl.business_date >= $1 AND vl.business_date <= $2 AND vl.business_date <= CURRENT_DATE`;
const RAMA_WCJ_VECINAL = `
  SELECT vl.tenant_id, vl.business_date, vl.cliente, vl.sku, vl.qty, vl.importe, vl.consecutivo
    FROM wincaja.v_sales_lines vl
   WHERE vl.sale_channel = 'preventa_vecinal' AND vl.source_branch = '10'
     AND vl.business_date < '2026-06-28'::date
     AND vl.business_date >= $1 AND vl.business_date <= $2 AND vl.business_date <= CURRENT_DATE`;

const topsSQL = (conWincaja) => {
  const ramas = conWincaja ? [RAMA_PUSH, RAMA_WCJ_RUTA, RAMA_WCJ_VECINAL] : [RAMA_PUSH];
  return `WITH lineas AS MATERIALIZED (${ramas.join('\n  UNION ALL')}),
     mias AS (SELECT * FROM lineas WHERE tenant_id = $3),
     p AS (SELECT 'sku'::text kind, l.sku code, round(sum(l.importe),2)::float rev,
                  round(sum(l.qty),2)::float units, 0::int tickets
             FROM mias l WHERE l.sku IS NOT NULL
            GROUP BY l.sku ORDER BY 3 DESC NULLS LAST LIMIT 10),
     c AS (SELECT 'cliente'::text kind, l.cliente code, round(sum(l.importe),2)::float rev,
                  0::float units, count(DISTINCT l.consecutivo)::int tickets
             FROM mias l WHERE l.cliente IS NOT NULL AND btrim(l.cliente) <> '' AND l.cliente <> '0001'
            GROUP BY l.cliente ORDER BY 3 DESC NULLS LAST LIMIT 10)
   SELECT * FROM p UNION ALL SELECT * FROM c`;
};

const huella = (rows) => rows
  .map((r) => [r.kind, r.code, r.rev, r.units, r.tickets].join('|')).sort().join('\n');
const dia = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

(async () => {
  const db = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    const t = (await db.query(`SELECT id FROM public.tenants WHERE slug = 'mega_dulces' LIMIT 1`)).rows[0];
    if (!t) { console.log('sin tenant mega_dulces: nada que medir'); process.exitCode = 0; return; }
    const T = t.id;
    // `wincaja.v_sales_lines` filtra por `current_setting('app.tenant_id')`: sin esto devuelve 0
    // filas y TODO el candado se pondría verde midiendo el vacío.
    await db.query('SELECT set_config($1,$2,false)', ['app.tenant_id', T]);

    // ── 1. La cota está acotada a hoy ───────────────────────────────────────────────────────
    console.log('\n[1] La cota de Wincaja no puede salir del futuro');
    const c = (await db.query(
      `SELECT to_char(max(business_date) FILTER (
                WHERE venta_origen = 'derivado_tasa_linea' AND venta > 0
                  AND business_date <= CURRENT_DATE),'YYYY-MM-DD') AS acotada,
              to_char(max(business_date) FILTER (
                WHERE venta_origen = 'derivado_tasa_linea' AND venta > 0),'YYYY-MM-DD') AS sin_tope,
              to_char(min(business_date),'YYYY-MM-DD') AS piso,
              to_char(CURRENT_DATE,'YYYY-MM-DD') AS hoy
         FROM analytics.mv_rd_route_daily_200d WHERE tenant_id = $1`, [T])).rows[0];
    const { acotada, sin_tope: sinTope, piso, hoy } = c;
    if (!acotada) { skip('Wincaja no tiene ni un día de venta de ruta en la ventana de la matvista.'); }
    else if (acotada <= hoy) pass(`la cota acotada es ${acotada} y no supera a hoy (${hoy}).`);
    else bad(`la cota acotada es ${acotada}, POSTERIOR a hoy (${hoy}) — el tope a CURRENT_DATE no está aplicando.`);

    if (sinTope && acotada && sinTope > hoy) {
      pass(`sin el tope la cota sería ${sinTope} (futuro): el guard tiene dientes, no es decorativo.`);
    } else if (sinTope && acotada && sinTope === acotada) {
      skip('hoy no hay filas con fecha futura: el guard no se puede ejercer contra un caso real.');
    } else if (!sinTope) {
      skip('no hay cota que comparar.');
    }

    // ── 2. POST-CORTE el atajo es exacto ────────────────────────────────────────────────────
    console.log('\n[2] Después del corte, omitir Wincaja da el MISMO resultado');
    if (!acotada) { skip('sin cota no hay ventana post-corte que probar.'); }
    else {
      const desde = dia(acotada, 1);
      if (desde > hoy) skip(`la cota (${acotada}) es de hoy o después: no hay ventana post-corte.`);
      else {
        const con = (await db.query(topsSQL(true), [desde, hoy, T])).rows;
        const sin = (await db.query(topsSQL(false), [desde, hoy, T])).rows;
        if (!con.length) skip(`no hay venta de ruta entre ${desde} y ${hoy}.`);
        else if (huella(con) === huella(sin)) {
          pass(`${desde}..${hoy}: ${con.length} filas idénticas con y sin las ramas de Wincaja.`);
        } else {
          bad(`${desde}..${hoy}: omitir Wincaja CAMBIA el resultado — el atajo estaría perdiendo venta.`);
        }
      }
    }

    // ── 3. PRUEBA NEGATIVA: antes del corte, omitir SÍ cambia ───────────────────────────────
    console.log('\n[3] Prueba negativa: antes del corte el atajo estaría MAL');
    if (!acotada) { skip('sin cota no hay ventana pre-corte que probar.'); }
    else {
      const desde = dia(acotada, -29);
      const con = (await db.query(topsSQL(true), [desde, acotada, T])).rows;
      const sin = (await db.query(topsSQL(false), [desde, acotada, T])).rows;
      if (!con.length) skip(`no hay venta de ruta entre ${desde} y ${acotada}.`);
      else if (huella(con) !== huella(sin)) {
        pass(`${desde}..${acotada}: omitir Wincaja cambia el resultado — por eso la cota NO puede ser incondicional.`);
      } else {
        bad(`${desde}..${acotada}: omitir Wincaja NO cambia nada ni siquiera dentro de su propio período. `
          + 'O Wincaja dejó de traer líneas de ruta (defecto de la fuente) o el bloque 2 se está '
          + 'poniendo verde midiendo el vacío.');
      }
    }

    // ── 4. La decisión, con su negativa por cobertura ───────────────────────────────────────
    console.log('\n[4] La decisión del servicio: cuándo se omite y cuándo no');
    const decide = (from) => {
      const cubierta = !!piso && from >= piso;
      return cubierta && (acotada === null || from > acotada);
    };
    if (!piso) { skip('la matvista no tiene piso: no se puede evaluar la cobertura.'); }
    else {
      const casos = [];
      if (acotada && dia(acotada, 1) <= hoy) casos.push([dia(acotada, 1), true, 'arranca después del corte']);
      if (acotada && acotada >= piso) casos.push([acotada, false, 'arranca el día del corte']);
      casos.push([dia(piso, -1), false, 'arranca antes del piso de la matvista (sin evidencia)']);
      let malos = 0;
      for (const [from, esperado, nota] of casos) {
        const got = decide(from);
        if (got === esperado) console.log(`     · ${from} → ${got ? 'omite' : 'lee las 3 ramas'} (${nota}) ✔`);
        else { malos++; console.log(`     · ${from} → ${got ? 'omite' : 'lee las 3 ramas'} pero se esperaba lo contrario (${nota}) ✘`); }
      }
      if (malos) bad(`${malos} de ${casos.length} decisiones no coinciden con la regla del servicio.`);
      else pass(`las ${casos.length} decisiones coinciden, incluida la negativa por falta de cobertura.`);
    }

    console.log(`\n=== ${ok} OK · ${fail} FALLAS · ${nomedido} NO MEDIDOS ===`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
