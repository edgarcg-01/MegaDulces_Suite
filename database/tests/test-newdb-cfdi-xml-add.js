/* eslint-disable no-console */
/**
 * `[LC.20]` — Candado del XML que el feed del ADD copia a `fiscal.cfdis.xml`.
 *
 *   1. `uuidDelXml` lee el UUID del timbre, y devuelve null sin timbre (prueba negativa);
 *   2. ⭐ contra el ADD real + prod, SÓLO LECTURA (`completarXml` con `apply: false`): de los 30
 *      recibidos más nuevos sin XML, cada uno tiene su documento y el UUID del timbre es el de la fila;
 *   3. ⛔ prueba negativa: el XML de una factura NO valida contra el UUID de otra — la comparación
 *      que protege de pegar un documento ajeno sí puede decir que no;
 *   4. el feed llama `completarXml` y la base de contenido sale de `DatabaseDirectory`.
 *
 * Sin ADD alcanzable (CI) se declara NO MEDIDO. No escribe en ningún lado.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { Client } = require('pg');
const { uuidDelXml, traerXml, completarXml } = require(path.join(ROOT, 'database', 'importers', 'contpaqi', 'add-xml.js'));
const { classify } = require('./_lib/assert-safe-target');

const MEGA = '00000000-0000-0000-0000-00000000d01c';
let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};
const noMedido = (label) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${label}`); };

(async () => {
  console.log('\n[1] El UUID del timbre');
  const u = '1C170000-0000-4000-8000-000000000001';
  check(uuidDelXml(`<cfdi:Comprobante><cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="${u.toLowerCase()}" /></cfdi:Complemento></cfdi:Comprobante>`) === u,
    'lee el UUID del TimbreFiscalDigital (y lo normaliza a mayúsculas)');
  check(uuidDelXml('<cfdi:Comprobante Total="10"/>') === null, '⛔ sin timbre devuelve null — no inventa un UUID');

  const url = process.env.DATABASE_URL_NEW;
  if (url && classify(url).kind === 'local') { await completoLocal(url); return fin(); }

  console.log('\n[2] Contra el ADD real y prod (sólo lectura)');
  if (!url || classify(url).kind !== 'prod') { noMedido('destino no es prod: los CFDI y el ADD reales sólo existen ahí'); return fin(); }
  let sql;
  try { sql = require('mssql'); } catch { noMedido('sin el driver mssql'); return fin(); }
  const fuente = fs.readFileSync(path.join(ROOT, 'database', 'importers', 'contpaqi', 'import-contpaqi-cfdis.js'), 'utf8');
  const pwd = process.env.CONTPAQI_SQL_PASSWORD
    || (fuente.match(/password:\s*process\.env\.CONTPAQI_SQL_PASSWORD\s*\|\|\s*'([^']*)'/) || [])[1];
  const cfg = (database) => ({
    server: process.env.CONTPAQI_SQL_HOST || '192.168.0.35', user: process.env.CONTPAQI_SQL_USER || 'platform_ro', password: pwd, database,
    options: { instanceName: process.env.CONTPAQI_SQL_INSTANCE || 'COMPAC', encrypt: false, trustServerCertificate: true },
    connectionTimeout: 15000, requestTimeout: 120000,
  });
  let dir;
  try {
    const p = await new sql.ConnectionPool(cfg('DB_Directory')).connect();
    dir = (await p.request().query(`SELECT TOP 1 DB_DocumentsContent AS content FROM DatabaseDirectory
      WHERE RFC = '${process.env.CONTPAQI_RFC || 'LOGL851014AQ5'}' ORDER BY Syncronized DESC`)).recordset[0];
    await p.close();
  } catch (e) { noMedido(`el ADD no responde desde aquí (${e.message.slice(0, 80)})`); return fin(); }
  const poolXml = await new sql.ConnectionPool(cfg(dir.content)).connect();
  const pg = new Client({ connectionString: url });
  await pg.connect();
  await pg.query('SET default_transaction_read_only = on');
  try {
    const r = await completarXml(pg, poolXml, { tenant: MEGA, rol: 'recibidas', tipos: ['I', 'E'], limite: 30, apply: false });
    if (!r.pedidas) noMedido('no hay recibidos sin XML (¿ya se completaron todos?)');
    else {
      check(r.sin_contenido === 0 && r.uuid_distinto === 0 && r.guardadas === r.pedidas,
        `⭐ ${r.pedidas} recibidos sin XML: ${r.guardadas} con su documento y el mismo UUID · ${r.sin_contenido} sin contenido · ${r.uuid_distinto} con otro UUID`);
    }

    console.log('\n[3] Prueba negativa: un documento ajeno no pasa');
    const { rows } = await pg.query(
      `SELECT uuid, stored_ref FROM fiscal.cfdis WHERE tenant_id = $1 AND source = 'contpaqi_add' AND rol = 'recibidas'
          AND stored_ref IS NOT NULL ORDER BY fecha DESC LIMIT 2`, [MEGA]);
    const xs = await traerXml(poolXml, rows.map((x) => x.stored_ref));
    const xmlA = xs.get(String(rows[0].stored_ref).toUpperCase());
    check(xmlA && uuidDelXml(xmlA) === rows[0].uuid.toUpperCase() && uuidDelXml(xmlA) !== rows[1].uuid.toUpperCase(),
      `⛔ el XML de ${rows[0].uuid.slice(0, 8)}… valida contra su fila y NO contra la de ${rows[1].uuid.slice(0, 8)}…`);
  } finally {
    await pg.end();
    await poolXml.close();
  }

  console.log('\n[4] El feed lo usa');
  check(/require\('\.\/add-xml'\)/.test(fuente) && /completarXml\(pg, poolXml/.test(fuente) && /DB_DocumentsContent AS content/.test(fuente),
    'import-contpaqi-cfdis.js completa el XML desde la base de contenido que dice DatabaseDirectory (leído del fuente)');
  return fin();
})().catch((e) => { console.log(`  ✗ excepción: ${e && e.message}`); fail += 1; fin(); });

/**
 * Destino LOCAL (`pruebas-db`): el SQL de Postgres de `completarXml` contra una base real —el
 * cursor, el «sólo donde falta», el UPDATE—, con el ADD como doble (no existe en el CI). Siembra
 * en `fiscal.cfdis` con UUID de prueba y los borra al final.
 */
async function completoLocal(url) {
  console.log('\n[2L] Modo completo (destino local): dos pasadas del relleno');
  const pg = new Client({ connectionString: url });
  await pg.connect();
  const KEY = 'candado_lc20';
  const dia = 86_400_000;
  const filas = [
    // [uuid, stored_ref, días atrás, ¿el ADD tiene contenido?]
    ['1C200000-0000-4000-8000-000000000001', '2C200000-0000-4000-8000-000000000001', 3, true],
    ['1C200000-0000-4000-8000-000000000002', '2C200000-0000-4000-8000-000000000002', 400, true],
    ['1C200000-0000-4000-8000-000000000003', '2C200000-0000-4000-8000-000000000003', 500, false], // archivada a disco
    ['1C200000-0000-4000-8000-000000000004', '2C200000-0000-4000-8000-000000000004', 600, true],
  ];
  const xmlDe = (u) => `<cfdi:Comprobante xmlns:cfdi="x"><cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="y" UUID="${u}"/></cfdi:Complemento></cfdi:Comprobante>`;
  const porRef = new Map(filas.filter((f) => f[3]).map((f) => [f[1], xmlDe(f[0])]));
  const pedidas = [];
  const addFalso = {
    request: () => ({
      query: async (q) => {
        const gs = [...q.matchAll(/'([0-9A-F-]{36})'/g)].map((m) => m[1]);
        pedidas.push(...gs);
        return { recordset: gs.filter((g) => porRef.has(g)).map((g) => ({ g, Content: porRef.get(g) })) };
      },
    }),
  };
  const limpiar = async () => {
    await pg.query(`DELETE FROM fiscal.cfdis WHERE tenant_id = $1 AND uuid = ANY ($2)`, [MEGA, filas.map((f) => f[0])]);
    await pg.query(`DELETE FROM analytics.feed_watermarks WHERE tenant_id = $1 AND feed_key = $2`, [MEGA, `${KEY}_xml`]);
  };
  try {
    await limpiar();
    for (const [u, ref, dias] of filas) {
      await pg.query(
        `INSERT INTO fiscal.cfdis (tenant_id, uuid, tipo_comprobante, fecha, emisor_rfc, total, rol, source, stored_ref)
         VALUES ($1, $2, 'T', $3, 'LCX170101AAA', 1, 'recibidas', 'contpaqi_add', $4)`, [MEGA, u, new Date(Date.now() - dias * dia), ref]);
    }
    // El universo de la prueba son SÓLO las filas sembradas: el destino local puede traer otras.
    const soloNuestras = async (lim) => {
      const r = await completarXml(pg, addFalso, { tenant: MEGA, rol: 'recibidas', tipos: ['T'], limite: lim, apply: true, feedKey: KEY });
      return r;
    };
    // Pasada 1, límite 2: la reciente (tramo 1) + la de hace 400 días (histórico).
    const p1 = await soloNuestras(2);
    const { rows: g1 } = await pg.query(`SELECT uuid, xml IS NOT NULL AS tiene FROM fiscal.cfdis WHERE tenant_id = $1 AND uuid = ANY ($2) ORDER BY uuid`, [MEGA, filas.map((f) => f[0])]);
    check(g1[0].tiene && g1[1].tiene && !g1[2].tiene && !g1[3].tiene,
      `pasada 1: la reciente y la de hace 400 días guardadas (${p1.guardadas}/${p1.pedidas}), las más viejas todavía no`);
    const c1 = p1.cursor;
    // Pasada 2: el cursor sigue hacia atrás — la archivada se pide y queda sin contenido; la de 600 días se guarda.
    pedidas.length = 0;
    const p2 = await soloNuestras(2);
    const { rows: g2 } = await pg.query(`SELECT uuid, xml FROM fiscal.cfdis WHERE tenant_id = $1 AND uuid = ANY ($2) ORDER BY uuid`, [MEGA, filas.map((f) => f[0])]);
    check(!g2[2].xml && g2[3].xml && p2.sin_contenido >= 1, `pasada 2: la de 600 días guardada, la archivada cuenta como sin contenido (${p2.sin_contenido})`);
    check(c1 && p2.cursor && new Date(p2.cursor) < new Date(c1), `el cursor sólo baja (${c1?.slice(0, 10)} → ${p2.cursor?.slice(0, 10)})`);
    // Pasada 3: ⛔ la archivada NO se vuelve a pedir (era el defecto de «las N más nuevas sin XML»).
    pedidas.length = 0;
    await soloNuestras(2);
    check(!pedidas.includes(filas[2][1]), '⛔ pasada 3: la archivada no se vuelve a pedir al ADD');
    check(g2[0].xml && g2[0].xml.includes(filas[0][0]), 'lo guardado es el documento de ESA fila (su UUID adentro)');
  } finally {
    await limpiar();
    await pg.end();
  }
}

function fin() {
  console.log(`\n${fail === 0 ? '✅' : '❌'} LC.20 XML desde el ADD: ${ok} ✓ / ${fail} ✗${nm ? ` · ${nm} NO MEDIDO` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
}
