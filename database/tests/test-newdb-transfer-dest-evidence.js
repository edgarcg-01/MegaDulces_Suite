/* eslint-disable no-console */
/**
 * [DM.11e] CANDADO del destino de traspasos — que un envío no se le acredite a quien no es.
 *
 * ── QUÉ PASÓ ────────────────────────────────────────────────────────────────────────────────
 * `analytics.transfer_dest_map` decía `TI000 "CENTRO DE DISTRIBUCIÓN ( CEDIS)" -> 8ESQ`, así que
 * en `/almacen/movimientos` los envíos al CEDIS aparecían como recibidos por 8ESQ.
 *
 * Lo puso el auto-ligado `[DM.11d]`, que ata `dest_code -> almacén` por **verdad de recepción**:
 * parea salida con recepción por `folio`+`serie` dentro de 15 días y se queda con el que más
 * gana. Dos cosas lo rompen a la vez:
 *   1. la recepción del CEDIS **no vive en `analytics.stock_movements`** — todos sus pareos son
 *      espurios;
 *   2. los folios son **secuencia por sucursal**, así que se parean entre sucursales distintas
 *      por pura coincidencia.
 *
 * Medido en prod el 2026-09-30, a nivel DOCUMENTO: **15 envíos, 13 sin recepción, 2 pareados con
 * 8ESQ = 13 % de evidencia** — y eso alcanzó, porque el ganador salía de
 * `DISTINCT ON (dest_code) ... ORDER BY n DESC`, sin mínimo ni dominancia. Costo: **15
 * documentos · 5,476 piezas · $123,454.08** en 120 días.
 *
 * ── LO QUE SE VERIFICA ──────────────────────────────────────────────────────────────────────
 *  1. NINGÚN destino contradice su propia etiqueta. Es el invariante general: si el ERP dice que
 *     el destino se llama CEDIS, el almacén ligado tiene que ser el CEDIS. Atrapa esta familia
 *     entera, no sólo el caso que ya conocemos.
 *  2. PRUEBA NEGATIVA con CONTROL POSITIVO: el detector marca el par histórico
 *     `TI000 -> 8ESQ` y **no** marca `TI002 -> 8ESQ`, que es legítimo. Sin el control, un
 *     detector que marcara todo se vería igual de verde.
 *  3. La evidencia real de `TI000` está por debajo del 60 % que el importer ahora exige — o sea
 *     que el umbral está calibrado contra el caso que de verdad falló, no contra un número
 *     elegido de memoria.
 *
 *   DATABASE_URL_NEW=<prod o destino> node database/tests/test-newdb-transfer-dest-evidence.js
 *   DEEP=1 … → además mide la evidencia de TODOS los TI% (tarda ~30 s)
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0, fail = 0, nomedido = 0;
const pass = (m) => { ok++; console.log('  ✔', m); };
const bad = (m) => { fail++; console.log('  x FALLA:', m); };
const skip = (m) => { nomedido++; console.log('  ~ NO MEDIDO:', m); };

/** El umbral que aplica `import-stock-movements.js` en su auto-ligado. */
const UMBRAL = 0.60;

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
// Palabras que describen el TIPO de destino, no CUÁL es: no distinguen nada.
const RELLENO = new Set(['SUCURSAL', 'TRASPASO', 'ALMACEN', 'CENTRO', 'DISTRIBUCION', 'DE', 'DEL',
  'LA', 'EL', 'LOS', 'LAS', 'Y']);

/**
 * ¿La etiqueta del ERP y el almacén ligado hablan del mismo lugar?
 *
 * ⚠️ Compara por PREFIJO DE 3, no de 5. Con 5 el detector daba FALSO POSITIVO en el caso más
 * común del catálogo: "SUCURSAL 8 ESQUINAS" produce el token "ESQUINAS", cuyo prefijo de 5 es
 * "ESQUI" y el almacén se llama "8ESQ" — o sea que marcaba como contradicción el vínculo
 * legítimo. Lo atrapó el bloque 2 de este mismo archivo, que es para lo que existe: un detector
 * que marca todo se ve igual de verde que uno que discrimina.
 */
const concuerdan = (label, whCode, whName) => {
  const destino = norm(`${whCode} ${whName}`).replace(/[^A-Z0-9 ]/g, ' ');
  const tokens = norm(label).replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/)
    .filter((t) => t.length >= 3 && !RELLENO.has(t));
  if (!tokens.length) return null; // sin nada distintivo que comparar → no se juzga
  return tokens.some((t) => destino.includes(t.slice(0, 3)));
};

(async () => {
  const db = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    const t = (await db.query(`SELECT id FROM public.tenants WHERE slug = 'mega_dulces' LIMIT 1`)).rows[0];
    if (!t) { console.log('sin tenant mega_dulces: nada que medir'); process.exitCode = 0; return; }
    const T = t.id;
    await db.query('SELECT set_config($1,$2,false)', ['app.tenant_id', T]);

    // ── 1. Ningún destino contradice su etiqueta ────────────────────────────────────────────
    console.log('\n[1] El almacén ligado no puede contradecir la etiqueta del ERP');
    const mapa = (await db.query(
      `SELECT dm.dest_code, dm.dest_label, w.code, w.name
         FROM analytics.transfer_dest_map dm
         JOIN commercial.warehouses w ON w.id = dm.warehouse_id
        WHERE dm.tenant_id = $1 AND w.code NOT ILIKE 'RUTA%'
        ORDER BY dm.dest_code`, [T])).rows;
    if (!mapa.length) { skip('no hay ningún dest_code ligado a un almacén.'); }
    else {
      // ⚠️ La aserción DURA es sobre los `TI%`: ahí la etiqueta del ERP nombra una sucursal y la
      // contradicción es inequívoca. El resto del mapa son códigos de CLIENTE ligados a un
      // almacén; que "NO TOCAR ANTONIO VILLA" apunte a La Piedad puede ser el lugar donde ese
      // cliente recibe, no un error — se REPORTA para revisión humana, no se falla.
      const evalua = (r) => ({ r, v: concuerdan(r.dest_label, r.code, r.name) });
      const tis = mapa.filter((r) => /^TI/i.test(r.dest_code)).map(evalua);
      const otros = mapa.filter((r) => !/^TI/i.test(r.dest_code)).map(evalua);
      const malosTi = tis.filter((x) => x.v === false);
      const juzgados = tis.filter((x) => x.v !== null).length;
      if (!juzgados) skip('ningún TI% tiene etiqueta distintiva que comparar.');
      else if (malosTi.length) {
        malosTi.slice(0, 8).forEach(({ r }) => console.log(`     · ${r.dest_code} "${r.dest_label}" → ${r.code} ${r.name}`));
        bad(`${malosTi.length} de ${juzgados} traspasos entre sucursales apuntan a un almacén que su propia etiqueta desmiente.`);
      } else {
        pass(`los ${juzgados} traspasos entre sucursales concuerdan con su almacén.`);
      }
      const sospechosos = otros.filter((x) => x.v === false);
      if (sospechosos.length) {
        console.log(`     (para revisión humana, NO falla: ${sospechosos.length} código(s) de cliente ligados a un almacén que su etiqueta no menciona)`);
        sospechosos.slice(0, 5).forEach(({ r }) => console.log(`        ${r.dest_code} "${r.dest_label}" → ${r.code} ${r.name}`));
      }
    }

    // ── 2. Prueba negativa con control positivo ─────────────────────────────────────────────
    console.log('\n[2] Prueba negativa: el detector distingue, no marca todo');
    const malo = concuerdan('CENTRO DE DISTRIBUCIÓN ( CEDIS)', '03', '8ESQ');       // el bug histórico
    const bueno = concuerdan('TRASPASO 8 ESQUINAS', '03', '8ESQ');                  // legítimo
    if (malo === false && bueno === true) {
      pass('marca el par histórico TI000→8ESQ y NO marca TI002→8ESQ (tiene dientes y discrimina).');
    } else if (malo !== false) {
      bad('el detector NO marca el par que causó el incidente: es utilería.');
    } else {
      bad('el detector marca TI002→8ESQ, que es correcto: daría falsos positivos sobre todo el mapa.');
    }

    // ── 3. El umbral está calibrado contra el caso real ─────────────────────────────────────
    console.log('\n[3] La evidencia de TI000 queda por debajo del umbral del importer');
    const ev = async (destCode) => (await db.query(
      `WITH ship AS (
         SELECT DISTINCT folio, doc_serie, warehouse_id, doc_date
           FROM analytics.stock_movements
          WHERE tenant_id=$1 AND doc_code='TrsfShip' AND dest_code=$2
            AND doc_date >= CURRENT_DATE - 365),
       par AS (
         SELECT r.warehouse_id rcv_wh FROM ship s
          LEFT JOIN LATERAL (
            SELECT rr.warehouse_id FROM analytics.stock_movements rr
             WHERE rr.tenant_id=$1 AND rr.doc_code='TrsfRcv' AND rr.parent_group='41'
               AND rr.parent_folio=s.folio AND coalesce(rr.parent_serie,'')=coalesce(s.doc_serie,'')
               AND rr.warehouse_id <> s.warehouse_id
               AND rr.doc_date >= s.doc_date AND rr.doc_date <= s.doc_date + 15
             GROUP BY rr.warehouse_id) r ON true)
       SELECT count(*)::int envios,
              coalesce(max(n),0)::int mejor
         FROM par LEFT JOIN LATERAL (
           SELECT count(*)::int n FROM par p2 WHERE p2.rcv_wh = par.rcv_wh AND par.rcv_wh IS NOT NULL
         ) q ON true`, [T, destCode])).rows[0];

    const e0 = await ev('TI000');
    if (!Number(e0.envios)) { skip('no hay envíos a TI000 en el último año.'); }
    else {
      const pct = Number(e0.mejor) / Number(e0.envios);
      console.log(`     TI000: ${e0.envios} envíos · mejor candidato ${e0.mejor} pareos · ${(pct * 100).toFixed(0)} % de evidencia`);
      if (pct < UMBRAL) {
        pass(`${(pct * 100).toFixed(0)} % está por debajo del ${(UMBRAL * 100).toFixed(0)} % que exige el auto-ligado: hoy no lo ligaría.`);
      } else {
        bad(`${(pct * 100).toFixed(0)} % supera el umbral: el auto-ligado volvería a atar el CEDIS a otro almacén.`);
      }
    }

    if (process.env.DEEP === '1') {
      console.log('\n[3b] Evidencia de todos los TI% (DEEP)');
      const codes = (await db.query(
        `SELECT DISTINCT dest_code FROM analytics.transfer_dest_map
          WHERE tenant_id=$1 AND dest_code ILIKE 'TI%' ORDER BY 1`, [T])).rows;
      for (const { dest_code } of codes) {
        const e = await ev(dest_code);
        const pct = Number(e.envios) ? Number(e.mejor) / Number(e.envios) : 0;
        console.log(`     ${dest_code}: ${e.envios} envíos · ${(pct * 100).toFixed(0)} %`);
      }
      pass('evidencia de todos los TI% reportada.');
    } else {
      skip('la evidencia de TODOS los TI% tarda ~30 s (un LATERAL por envío): corre con DEEP=1.');
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
