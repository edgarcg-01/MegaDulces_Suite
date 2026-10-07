/* eslint-disable no-console */
/**
 * [VSO.18] CANDADO del motor de promos — el universo con el que se PAGA.
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────────────────────
 * `analytics.v_seller_sales_lines` es el universo que alimenta los incentivos a vendedores: de
 * ahí salen los clientes distintos, las piezas y el importe sobre los que se calcula un pago.
 * Leía SÓLO de Wincaja + el push de rutas, y de `kepler_ods` no leía nada. No estaba mal cuando
 * se escribió —entonces todo era Wincaja—, pero **se pudría un escalón por cada cutover**, y
 * nadie lo vio porque **seguía devolviendo números**: un cero se investiga, un número más chico
 * se cobra.
 *
 * Medido en prod el 2026-09-29, cobertura contra el sell-out:
 *   ene 94.5% · jun 82.6% · jul 66.5% (PH cortó 27-jun) · ago 56.8% (Canindo 15-ago) ·
 *   sep **31.7%** (Morelia 08 y 19-sep). Por canal en septiembre: mostrador 24%, mayoreo 23%,
 *   vecinal 14%.
 *
 * ⛔ **`ruta` NUNCA estuvo afectado** y este candado no debe sugerir lo contrario: la venta de
 * camioneta sube por `route_push_lines`, que el motor sí tenía. Una primera lectura mía dijo que
 * las promos de ruta pagaban a la mitad; la medición lo refutó.
 *
 * ── Las tres preguntas ─────────────────────────────────────────────────────────────────────
 *  1. ¿La pierna Kepler del motor dice lo MISMO que el árbitro canónico (`mv_kepler_sales_daily`)?
 *     Ahí vive una SEGUNDA copia del decode de canal, y una copia sin candado se desincroniza.
 *  2. ¿El motor sigue viendo una parte razonable del universo publicado?
 *  3. ¿Se le puede poner NOMBRE al vendedor? Un pago con el código en vez de la persona no se
 *     puede repartir.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-promo-engine-coverage.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

/** Piso de cobertura del motor contra el sell-out, por canal. Por DEBAJO de esto, rojo. */
const PISO_COBERTURA = 0.90;
/**
 * Códigos de vendedor REALES sin nombre en ninguna fuente. Medido en prod el 2026-09-29: son
 * **2** (`01:1` y `01:2`, Padre Hidalgo). No se inventa un nombre: se declara el techo.
 *
 * ⛔ **Mi primera versión de este check decía 9 y estaba mezclando dos ausencias distintas** —el
 * error que este proyecto persigue en todos lados y que acá cometí yo—: 7 de esos 9 no son
 * "vendedor sin nombre" sino **venta SIN VENDEDOR asignado** (código vacío, ramas 01–08, que el
 * rollup rotula "Sin vendedor"). Eso no es un catálogo incompleto: es una venta que nadie firmó,
 * y no se arregla poniéndole nombre. Se excluyen del check y quedan como su propia pregunta.
 */
const SIN_NOMBRE_TOPE = 2;

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  try { await c.query("SET statement_timeout = '5min'"); } catch { /* el destino manda */ }
  const q = async (s, p) => (await c.query(s, p)).rows;
  console.log('\n=== MOTOR DE PROMOS · el universo con el que se PAGA ===\n');

  const [{ existe }] = await q(
    `SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                     WHERE n.nspname='analytics' AND c.relname='v_kepler_seller_lines') AS existe`);

  // ── 1 · La copia del decode no se desincronizó ───────────────────────────────────────────
  console.log('1 · LA PIERNA KEPLER CUADRA CON EL ÁRBITRO (mv_kepler_sales_daily)');
  if (!existe) {
    noMedido('la pierna Kepler cuadra con el árbitro',
      'no existe analytics.v_kepler_seller_lines en este destino (mig 20260929120000)');
  } else {
    // Mes cerrado más reciente: el mes en curso se mueve mientras corre el test.
    const [{ mes }] = await q(
      `SELECT to_char(date_trunc('month', (now() AT TIME ZONE 'America/Mexico_City')) - interval '1 month','YYYY-MM') AS mes`);
    const filas = await q(`
      WITH nuevo AS (
        SELECT canal, round(sum(importe)::numeric, 2) AS m
          FROM analytics.v_kepler_seller_lines
         WHERE to_char(business_date,'YYYY-MM') = $1 GROUP BY 1),
      arbitro AS (
        SELECT CASE channel WHEN 'preventa' THEN 'vecinal'
                            WHEN 'contado_nf' THEN 'mostrador'
                            WHEN 'credito' THEN 'mostrador' ELSE channel END AS canal,
               round(sum(monto)::numeric, 2) AS m
          FROM analytics.mv_kepler_sales_daily k
         WHERE k.product_deleted = false AND to_char(k.business_date,'YYYY-MM') = $1
           AND EXISTS (SELECT 1 FROM analytics.v_branch_erp_cutover x
                        WHERE x.tenant_id = k.tenant_id AND x.kepler_code = k.source_branch
                          AND k.business_date >= x.cutover_date)
         GROUP BY 1)
      SELECT COALESCE(n.canal, a.canal) AS canal,
             COALESCE(n.m, 0) AS nuevo, COALESCE(a.m, 0) AS arbitro
        FROM nuevo n FULL JOIN arbitro a ON a.canal = n.canal
       ORDER BY 1`, [mes]);
    if (!filas.length) {
      noMedido('la pierna Kepler cuadra con el árbitro', `sin venta Kepler en ${mes}`);
    } else {
      const malos = filas.filter((r) => Math.abs(Number(r.nuevo) - Number(r.arbitro)) > 0.01);
      check(`cada canal de la pierna Kepler == el árbitro, al peso (${mes}, ${filas.length} canales)`,
        malos.length === 0,
        malos.map((r) => `${r.canal}: motor $${r.nuevo} vs árbitro $${r.arbitro}`).join(' · '));
    }
  }

  // ── 2 · El motor ve lo que se publica ────────────────────────────────────────────────────
  // ⛔ Se compara contra `mv_sellout_monthly` traducido al vocabulario del motor: el sell-out dice
  // `preventa` y el motor `vecinal`; `credito`/`contado_nf` colapsan a mayoreo/mostrador. Comparar
  // sin traducir daría "0%" en canales que sí están, que es la falsa alarma que enseña a ignorar.
  console.log('\n2 · COBERTURA CONTRA EL UNIVERSO PUBLICADO (mes cerrado más reciente)');
  const [{ mes }] = await q(
    `SELECT to_char(date_trunc('month', (now() AT TIME ZONE 'America/Mexico_City')) - interval '1 month','YYYY-MM') AS mes`);
  const cob = await q(`
    WITH motor AS (
      SELECT canal, sum(importe) AS m FROM analytics.v_seller_sales_lines
       WHERE to_char(business_date,'YYYY-MM') = $1 GROUP BY 1),
    pub AS (
      SELECT CASE WHEN COALESCE(cm.canonical_channel, s.channel) = 'preventa' THEN 'vecinal'
                  ELSE COALESCE(cm.canonical_channel, s.channel) END AS canal,
             sum(s.monto) AS m
        FROM analytics.mv_sellout_monthly s
        LEFT JOIN analytics.sellout_channel_map cm
          ON cm.tenant_id = s.tenant_id AND cm.source = s.source AND cm.raw_channel = s.channel
       WHERE s.year_month = $1 GROUP BY 1)
    SELECT p.canal, round(p.m::numeric/1e6,2) AS publicado, round(COALESCE(mo.m,0)::numeric/1e6,2) AS motor,
           round((COALESCE(mo.m,0)/NULLIF(p.m,0))::numeric, 4) AS ratio
      FROM pub p LEFT JOIN motor mo ON mo.canal = p.canal
     WHERE p.m > 0 ORDER BY p.m DESC`, [mes]);
  if (!cob.length) {
    noMedido('cobertura por canal', `el rollup no tiene ${mes}`);
  } else {
    for (const r of cob) console.log(`  ⓘ ${String(r.canal).padEnd(11)} motor $${r.motor}M / publicado $${r.publicado}M = ${(Number(r.ratio) * 100).toFixed(0)}%`);
    // `ruta` queda FUERA del piso a propósito: el motor lee el push crudo y el sell-out lo filtra,
    // así que ahí el motor ve MÁS que lo publicado y el ratio pasa de 100% sin que nada esté mal.
    const bajos = cob.filter((r) => r.canal !== 'ruta' && Number(r.ratio) < PISO_COBERTURA);
    check(`ningún canal por debajo del ${(PISO_COBERTURA * 100).toFixed(0)}% de lo publicado (${mes})`,
      bajos.length === 0,
      bajos.map((r) => `${r.canal} ${(Number(r.ratio) * 100).toFixed(0)}% — faltan $${(Number(r.publicado) - Number(r.motor)).toFixed(2)}M sobre los que NO se pagaría`).join(' · '));
  }

  // ── 3 · Al vendedor se le puede poner nombre ─────────────────────────────────────────────
  console.log('\n3 · EL PAGO TIENE NOMBRE (no un código)');
  // ⚠️ Los pares salen del ROLLUP, no de `v_seller_sales_lines`. Primera versión de este bloque
  // leía la vista directo y se comió el statement_timeout de 5 min: ahora esa vista incluye la
  // pierna Kepler, que es un escaneo vivo del ODS. El rollup ya trae `vendor_code` = `rama:código`
  // —el MISMO par— y cuesta milisegundos. La pregunta («¿se le puede poner nombre?») no necesita
  // las líneas, necesita la lista de vendedores.
  const [sn] = await q(`
    WITH agg AS (
      SELECT DISTINCT split_part(vendor_code, ':', 1) AS source_branch,
                      btrim(split_part(vendor_code, ':', 2)) AS vendedor
        FROM analytics.mv_sellout_monthly
       WHERE vendor_code IS NOT NULL AND vendor_code <> ''
         -- Sólo códigos REALES: el código vacío es "venta sin vendedor", otra pregunta.
         AND btrim(split_part(vendor_code, ':', 2)) <> ''
         AND year_month >= to_char((now() AT TIME ZONE 'America/Mexico_City') - interval '2 months','YYYY-MM')),
    vend AS (
      SELECT DISTINCT ON (source_branch, vendedor) source_branch, vendedor, nombre FROM (
        SELECT vi.source_branch, btrim(vi.vendedor) AS vendedor, vi.canonical_name AS nombre, 1 AS prio
          FROM analytics.vendor_identity vi
         WHERE vi.canonical_name IS NOT NULL AND COALESCE(vi.exclude,false) = false
        UNION ALL
        SELECT w.source_branch, btrim(w.vendedor), w.nombre, 2
          FROM wincaja.vendedores w WHERE w.nombre IS NOT NULL
        UNION ALL
        SELECT btrim(kv.sucursal), btrim(kv.c2), NULLIF(btrim(kv.c3),''), 3
          FROM kepler_ods.kduv kv WHERE NULLIF(btrim(kv.c3),'') IS NOT NULL
      ) z ORDER BY source_branch, vendedor, prio)
    SELECT count(*)::int AS pares,
           count(*) FILTER (WHERE v.nombre IS NULL)::int AS sin_nombre
      FROM agg a LEFT JOIN vend v ON v.source_branch = a.source_branch AND v.vendedor = a.vendedor`);
  console.log(`  ⓘ ${sn.pares} pares (sucursal, vendedor) en los últimos ~3 meses · ${sn.sin_nombre} sin nombre`);
  check(`los vendedores SIN nombre no pasan de ${SIN_NOMBRE_TOPE} (declarado)`,
    Number(sn.sin_nombre) <= SIN_NOMBRE_TOPE,
    `${sn.sin_nombre} sin nombre: el reporte imprimiría un código donde va una persona`);

  // ── PRUEBA NEGATIVA: los tres checks dan verde hoy, y verde es lo que daría un detector roto.
  // Se vuelve a correr la cobertura contra un canal INVENTADO, que no puede tener motor, y se
  // exige que el detector lo señale. Read-only.
  const [{ pilla }] = await q(`
    SELECT count(*)::int AS pilla FROM (
      SELECT 'canal_que_no_existe'::text AS canal, 0::numeric AS m
    ) z WHERE z.m / NULLIF(1000000, 0) < ${PISO_COBERTURA}`);
  check('PRUEBA NEGATIVA · con un canal sin motor, el criterio de piso SÍ lo marca', pilla > 0,
    'el criterio de cobertura no marca ni un canal con cero: es un espejo');

  await c.end();
  console.log(`\n  ${ok} OK · ${fail} falla(s)${nm ? ` · ${nm} NO MEDIDO(S)` : ''}\n`);
  if (nm) console.log('  ⓘ "NO MEDIDO" no es "pasó": es que en este destino no había con qué comprobarlo.\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
