#!/usr/bin/env node
'use strict';
/**
 * `[KR.13]` Operación segura de la escritura a Kepler, servidor por servidor.
 * Protocolo: docs/IMPLEMENTACION/RUNBOOKS/KEPLER_PUSH_DESPLIEGUE.md §9.
 *
 *   node database/scripts/kepler-push-ops.js revisar   --sucursal 00
 *   node database/scripts/kepler-push-ops.js listar    --sucursal 00 [--fuente ods]
 *   node database/scripts/kepler-push-ops.js deshacer  --sucursal 00 --folio-suite RQ-2026-00775 [--apply]
 *   node database/scripts/kepler-push-ops.js restaurar --archivo <respaldo.json> [--apply]
 *
 * ── Qué hace cada uno ───────────────────────────────────────────────────────────────────────
 *
 * `revisar`   Pre-vuelo, SÓLO LECTURA, con el mismo rol que va a escribir (`kepler_push`).
 *             Tres estados: OK · FALLA · NO MEDIDO. Sale con código 1 si algo FALLA.
 * `listar`    Todo documento con marca de la Suite (`RQ-`) en ese servidor, con su estado,
 *             sus hijos y si la Suite lo reconoce. SÓLO LECTURA.
 * `deshacer`  Borra UN documento que escribió la Suite. Sin `--apply` sólo dice qué haría.
 *             Con `--apply` exige `KEPLER_ADMIN_URL_NN` (el rol `kepler_push` NO puede borrar,
 *             a propósito) y antes de borrar guarda un RESPALDO exacto para `restaurar`.
 * `restaurar` Re-inserta un documento desde su respaldo. Deshace el `deshacer`.
 *
 * ── Los frenos de `deshacer` (cada uno rechaza; ninguno se puede saltar con una bandera) ─────
 *
 *  1. La marca (`c11` en compra, `c24` en traspaso) es EXACTAMENTE el folio de la Suite.
 *     Un documento que capturó una persona no tiene esa marca: nunca se toca.
 *  2. `c43 = 'N'`. Si Kepler ya lo marcó (`F`, `C`…), alguien lo procesó.
 *  3. Ningún hijo: ningún documento del servidor apunta a él por `c36`=naturaleza ·
 *     `c37`=tipo · `c38`=serie · `c39`=folio (medido: así ligan `X-A-35`→`X-A-30` y
 *     `U-D-41`→`U-D-40`; sin `c36`, 4,648 vales `X-A-40` parecerían hijos de pedidos).
 *  4. Traspaso: `c100`/`c102`/`c103` vacíos (nadie lo surtió, checó ni embarcó).
 *  5. Se revalida TODO dentro de la transacción, con el encabezado bloqueado (`FOR UPDATE`).
 *  6. Las filas borradas tienen que ser exactamente las del respaldo, o `ROLLBACK`.
 *
 * ⚠️ `--fuente ods` lee `kepler_ods` en prod en vez del servidor vivo: sirve para ensayar sin
 * acceso al ERP, pero el ODS **no siempre replica los borrados** (medido 2026-10-23: conserva 4
 * encabezados de la prueba del 13-oct que en `md_00` ya no existen). `--apply` exige `vivo`.
 *
 * ⚠️ La regla de qué variable abre qué servidor está duplicada de
 * `libs/commercial/src/lib/commercial-replenishment/kepler-servidores.ts` (este script es JS
 * plano y no importa TS). Si cambia allá, cambia acá.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const { Client } = require('pg');

// `[KR.14]` El archivo maestro (ops/prod/kepler-push-secretos.js) y las URL de superusuario,
// fuera del repo. Se leen TAMBIÉN las líneas comentadas: un servidor apagado en prod igual se
// puede revisar antes de encenderlo. Lo que ya venga del entorno o del .env no se pisa.
const DIR_SECRETOS = process.env.KEPLER_PUSH_SECRETOS || path.join(os.homedir(), 'kepler-push-secretos');
for (const nombre of ['kepler-push.env', 'kepler-admin.env']) {
  const p = path.join(DIR_SECRETOS, nombre);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^#?\s*(KEPLER_[A-Z_]+_\d{2})=(\S+)\s*$/);
    if (m && !m[2].includes('<') && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const MARCA = 'RQ-';
const DOC = {
  compra: { c2: 'X', c3: 'A', c4: '30', marca: 'c11', envFolio: 'KEPLER_REQ_TEMPLATE_FOLIO', envSerie: 'KEPLER_REQ_TEMPLATE_SERIE', limpiar: [] },
  traspaso: { c2: 'U', c3: 'D', c4: '40', marca: 'c24', envFolio: 'KEPLER_PED_TEMPLATE_FOLIO', envSerie: 'KEPLER_PED_TEMPLATE_SERIE', limpiar: ['c100', 'c102', 'c103'] },
};

// ── argumentos ─────────────────────────────────────────────────────────────────────────────
const [, , cmd, ...rest] = process.argv;
const arg = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const flag = (k) => rest.includes(`--${k}`);
const env = (k) => (process.env[k] || '').trim();

function sucursalArg() {
  const s = String(arg('sucursal') || '').trim();
  if (!/^\d{2}$/.test(s)) fin(`--sucursal debe ser de dos dígitos (00…08), llegó «${s}»`);
  return s;
}
function urlPush(s) { return env(`KEPLER_PUSH_URL_${s}`) || (s === '00' ? env('KEPLER_PUSH_URL') : ''); }
function plantilla(tipo, s) {
  const d = DOC[tipo];
  const folio = env(`${d.envFolio}_${s}`) || (s === '00' ? env(d.envFolio) || (tipo === 'compra' ? '0000424' : '') : '');
  const serie = env(`${d.envSerie}_${s}`) || (s === '00' ? env(d.envSerie) : '') || '1';
  return folio ? { serie, folio } : null;
}
function tope(s) {
  const raw = env(`KEPLER_PUSH_MAX_DIA_${s}`);
  return /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : 1;
}
function hoyMx() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
}
function fin(msg) { console.error(`⛔ ${msg}`); process.exit(2); }

/** La fuente de lectura: el servidor vivo (tabla `md.kdmX`) o el ODS (`kepler_ods.kdmX` + sucursal). */
async function abrirFuente(s, fuente) {
  if (fuente === 'ods') {
    if (!env('PROD_DB_URL')) fin('Falta PROD_DB_URL para --fuente ods');
    const c = new Client({ connectionString: env('PROD_DB_URL'), statement_timeout: 60000 });
    await c.connect(); await c.query('SET default_transaction_read_only = on');
    return { c, t: (x) => `kepler_ods.${x}`, f: (alias) => `${alias ? alias + '.' : ''}sucursal = '${s}' AND`, nombre: `kepler_ods (sucursal ${s})` };
  }
  const url = urlPush(s);
  if (!url) fin(`Falta KEPLER_PUSH_URL_${s}: no hay cómo leer el servidor ${s}`);
  const c = new Client({ connectionString: url, statement_timeout: 30000, connectionTimeoutMillis: 8000 });
  await c.connect(); await c.query('BEGIN READ ONLY');
  return { c, t: (x) => `md.${x}`, f: () => '', nombre: `servidor ${s} (vivo)` };
}

async function suite() {
  if (!env('PROD_DB_URL')) return null;
  const c = new Client({ connectionString: env('PROD_DB_URL'), statement_timeout: 30000 });
  await c.connect();
  return c;
}

// ── revisar ────────────────────────────────────────────────────────────────────────────────
async function revisar() {
  const s = sucursalArg();
  const res = [];
  const ok = (q, d) => res.push(['OK', q, d || '']);
  const falla = (q, d) => res.push(['FALLA', q, d || '']);
  const nm = (q, d) => res.push(['NO MEDIDO', q, d || '']);
  const aviso = (q, d) => res.push(['AVISO', q, d || '']);

  const url = urlPush(s);
  if (!url) { falla('variable de conexión', `falta KEPLER_PUSH_URL_${s}`); return imprimir(res); }
  let c;
  try {
    c = new Client({ connectionString: url, statement_timeout: 30000, connectionTimeoutMillis: 8000 });
    await c.connect(); await c.query('BEGIN READ ONLY');
  } catch (e) { falla('conecta', e.message); return imprimir(res); }

  const who = (await c.query(`SELECT current_database() db, current_user u`)).rows[0];
  who.db === `md_${s}` ? ok('base', `${who.db} como ${who.u}`) : falla('base', `se esperaba md_${s} y es ${who.db}`);
  if (who.u === 'postgres' || who.u === 'sa') falla('rol', `${who.u} es superusuario: la escritura debe ir con un rol propio sin UPDATE/DELETE`);

  const priv = (await c.query(`
    SELECT c.relname,
           has_table_privilege(current_user, c.oid, 'SELECT') sel, has_table_privilege(current_user, c.oid, 'INSERT') ins,
           has_table_privilege(current_user, c.oid, 'UPDATE') upd, has_table_privilege(current_user, c.oid, 'DELETE') del,
           has_table_privilege(current_user, c.oid, 'TRUNCATE') tru
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'md' AND c.relkind IN ('r','p')`)).rows;
  const ins = priv.filter((r) => r.ins).map((r) => r.relname).sort();
  const mod = priv.filter((r) => r.upd || r.del || r.tru).map((r) => r.relname).sort();
  ins.join(',') === 'kdm1,kdm2' ? ok('escribe sólo kdm1 y kdm2') : falla('escribe sólo kdm1 y kdm2', `INSERT en: ${ins.join(', ') || '(ninguna)'}`);
  mod.length === 0 ? ok('no modifica ni borra nada') : falla('no modifica ni borra nada', `UPDATE/DELETE/TRUNCATE en: ${mod.join(', ')} — REVOKE`);
  const lee = new Set(priv.filter((r) => r.sel).map((r) => r.relname));
  ['kdm1', 'kdm2'].forEach((t) => (lee.has(t) ? ok(`lee ${t}`) : falla(`lee ${t}`)));
  const temp = (await c.query(`SELECT has_database_privilege(current_user, current_database(), 'TEMPORARY') t`)).rows[0].t;
  temp ? ok('tablas temporales') : falla('tablas temporales', `GRANT TEMPORARY ON DATABASE md_${s} TO ${who.u}`);

  for (const tipo of ['compra', 'traspaso']) {
    const d = DOC[tipo];
    const p = plantilla(tipo, s);
    if (!p) { aviso(`${tipo}: APAGADA`, `sin ${d.envFolio}_${s} — ese tipo rebota, que es lo correcto si no se va a encender`); continue; }
    const h = (await c.query(
      `SELECT btrim(c11) c11, btrim(c43) c43,
              (SELECT count(*)::int FROM md.kdm2 l WHERE l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3 AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6) renglones
         FROM md.kdm1 m WHERE c1=$1 AND c2=$2 AND c3=$3 AND btrim(c4::text)=$4 AND btrim(c5::text)=$5 AND c6=$6`,
      [s, d.c2, d.c3, d.c4, p.serie, p.folio])).rows;
    if (h.length !== 1) falla(`${tipo}: plantilla ${p.serie}/${p.folio}`, 'no existe en este servidor');
    else if (!h[0].renglones) falla(`${tipo}: plantilla ${p.serie}/${p.folio}`, 'no tiene renglones de los que copiar');
    // ⛔ La plantilla de TRASPASO tiene que seguir sin procesar. Medido el 2026-10-23: la candidata
    // de `01` (`0003384`) estaba AUTORIZADO en la mañana y EMBARCADO (`c43='A'`) en la tarde —
    // un pedido vivo avanza. Clonarla haría nacer pedidos con rastros del proceso.
    else if (tipo === 'traspaso' && (h[0].c11 !== 'AUTORIZADO' || h[0].c43 !== 'N'))
      falla(`${tipo}: plantilla ${p.serie}/${p.folio}`, `ya procesada (c11=${h[0].c11} · c43=${h[0].c43}): elegir un U-D-40 AUTORIZADO con c43='N'`);
    else ok(`${tipo}: plantilla ${p.serie}/${p.folio}`, `${h[0].renglones} renglones · c11=${h[0].c11} · c43=${h[0].c43}`);
    if (tipo === 'traspaso') {
      if (!lee.has('pv_suc_ip')) falla('traspaso: lee pv_suc_ip', `GRANT SELECT ON md.pv_suc_ip TO ${who.u}`);
      else {
        const n = (await c.query(`SELECT count(*)::int n FROM md.pv_suc_ip WHERE btrim(coalesce(c7,'')) <> ''`)).rows[0].n;
        n ? ok('traspaso: pv_suc_ip', `${n} sucursales con TI###`) : falla('traspaso: pv_suc_ip', 'vacía: ningún destino resuelve');
      }
    }
  }

  const hoy = hoyMx();
  const n = (await c.query(
    `SELECT count(*)::int n FROM md.kdm1 WHERE c1=$1 AND c9::date=$2::date
        AND ((c2='X' AND c3='A' AND btrim(c4::text)='30' AND btrim(c11) LIKE $3)
          OR (c2='U' AND c3='D' AND btrim(c4::text)='40' AND btrim(c24) LIKE $3))`, [s, hoy, `${MARCA}%`])).rows[0].n;
  ok('tope diario', `${n} de ${tope(s)} usados hoy (${hoy})`);

  // Coherencia con la Suite: cada folio que la Suite cree haber escrito, ¿existe?
  const sc = await suite().catch(() => null);
  if (!sc) nm('Suite ↔ Kepler', 'sin PROD_DB_URL');
  else {
    const rs = (await sc.query(
      `SELECT folio, kepler_folio, source_type FROM commercial.purchase_requisitions
        WHERE tenant_id=$1 AND kepler_sucursal=$2 AND kepler_folio IS NOT NULL`, [TENANT, s])).rows;
    const faltan = [];
    for (const r of rs) {
      const d = DOC[r.source_type === 'branch' ? 'traspaso' : 'compra'];
      const e = (await c.query(`SELECT 1 FROM md.kdm1 WHERE c1=$1 AND c2=$2 AND c3=$3 AND btrim(c4::text)=$4 AND c6=$5 AND btrim(${d.marca})=$6`,
        [s, d.c2, d.c3, d.c4, r.kepler_folio, r.folio])).rowCount;
      if (!e) faltan.push(`${r.folio}→${r.kepler_folio}`);
    }
    faltan.length ? aviso('Suite ↔ Kepler', `la Suite apunta a documentos que no existen: ${faltan.join(', ')}`)
      : ok('Suite ↔ Kepler', `${rs.length} folios de la Suite, todos existen`);
    await sc.end();
  }
  await c.query('ROLLBACK'); await c.end();
  return imprimir(res);
}

function imprimir(res) {
  for (const [e, q, d] of res) console.log(`${e.padEnd(9)} ${q}${d ? ` — ${d}` : ''}`);
  const f = res.filter((r) => r[0] === 'FALLA').length;
  console.log(f ? `\n⛔ ${f} FALLA(S): no se enciende este servidor.` : '\n✔ Sin fallas.');
  process.exitCode = f ? 1 : 0;
}

// ── listar ─────────────────────────────────────────────────────────────────────────────────
async function listar() {
  const s = sucursalArg();
  const F = await abrirFuente(s, arg('fuente') || 'vivo');
  const rows = (await F.c.query(`
    SELECT btrim(m.c2)||'-'||btrim(m.c3)||'-'||btrim(m.c4::text) doc, btrim(m.c5::text) serie, m.c6 folio,
           m.c9::date fecha, btrim(CASE WHEN m.c2='X' THEN m.c11 ELSE m.c24 END) folio_suite, btrim(m.c43) c43, m.c16 total,
           (SELECT count(*)::int FROM ${F.t('kdm2')} l WHERE ${F.f('l')} l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3 AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6) renglones,
           (SELECT count(*)::int FROM ${F.t('kdm1')} h WHERE ${F.f('h')} h.c1=m.c1 AND btrim(h.c36)=btrim(m.c3)
               AND btrim(h.c37::text)=btrim(m.c4::text) AND btrim(h.c38::text)=btrim(m.c5::text) AND h.c39=m.c6) hijos
      FROM ${F.t('kdm1')} m
     WHERE ${F.f('m')} m.c1=$1
       AND ((m.c2='X' AND m.c3='A' AND btrim(m.c4::text)='30' AND btrim(m.c11) LIKE $2)
         OR (m.c2='U' AND m.c3='D' AND btrim(m.c4::text)='40' AND btrim(m.c24) LIKE $2))
     ORDER BY m.c9, m.c6`, [s, `${MARCA}%`])).rows;
  console.log(`Documentos con marca de la Suite en ${F.nombre}: ${rows.length}`);
  if (rows.length) console.table(rows);
  await F.c.end();
}

// ── deshacer ───────────────────────────────────────────────────────────────────────────────
async function leerDocumento(c, t, f, s, d, folio) {
  return (await c.query(
    `SELECT btrim(c5::text) serie, c6, btrim(${d.marca}) marca, btrim(c43) c43, c16 total,
            ${d.limpiar.length ? d.limpiar.map((x) => `btrim(coalesce(${x},''))`).join(`||`) : `''`} AS responsables
       FROM ${t('kdm1')} WHERE ${f()} c1=$1 AND c2=$2 AND c3=$3 AND btrim(c4::text)=$4 AND c6=$5`,
    [s, d.c2, d.c3, d.c4, folio])).rows;
}
async function hijosDe(c, t, f, s, d, serie, folio) {
  return (await c.query(
    `SELECT btrim(c2)||'-'||btrim(c3)||'-'||btrim(c4::text)||' '||c6 AS doc FROM ${t('kdm1')}
      WHERE ${f()} c1=$1 AND btrim(c36)=$2 AND btrim(c37::text)=$3 AND btrim(c38::text)=$4 AND c39=$5`,
    [s, d.c3, d.c4, serie, folio])).rows.map((r) => r.doc);
}
function frenos(doc, folioSuite, d, hijos) {
  const no = [];
  if (doc.marca !== folioSuite) no.push(`la marca ${d.marca} dice «${doc.marca}», no «${folioSuite}»: NO lo escribió la Suite`);
  if (doc.c43 !== 'N') no.push(`c43='${doc.c43}': Kepler ya lo procesó o canceló`);
  if (hijos.length) no.push(`tiene hijos: ${hijos.join(', ')}`);
  if (doc.responsables) no.push('ya tiene quién surtió/checó/embarcó');
  return no;
}

async function deshacer() {
  const s = sucursalArg();
  const folioSuite = String(arg('folio-suite') || '').trim();
  if (!folioSuite.startsWith(MARCA)) fin(`--folio-suite debe empezar con ${MARCA}`);
  const fuente = arg('fuente') || 'vivo';
  const apply = flag('apply');
  if (apply && fuente !== 'vivo') fin('--apply sólo contra el servidor vivo');

  const sc = await suite();
  if (!sc) fin('Falta PROD_DB_URL: hace falta la Suite para saber qué documento es');
  const r = (await sc.query(
    `SELECT id, estado, source_type, kepler_sucursal, kepler_folio FROM commercial.purchase_requisitions WHERE tenant_id=$1 AND folio=$2`,
    [TENANT, folioSuite])).rows[0];
  if (!r) fin(`La Suite no tiene la requisición ${folioSuite}`);
  const tipo = arg('tipo') || (r.source_type === 'branch' ? 'traspaso' : 'compra');
  const d = DOC[tipo]; if (!d) fin(`--tipo inválido: ${tipo}`);
  const folio = String(arg('kepler-folio') || r.kepler_folio || '').trim();
  if (!folio) fin(`${folioSuite} no tiene kepler_folio en la Suite; pasá --kepler-folio si sabés cuál es`);
  if (r.kepler_folio && r.kepler_sucursal !== s) fin(`La Suite dice que ${folioSuite} salió a la sucursal ${r.kepler_sucursal}, no a ${s}`);

  const F = await abrirFuente(s, fuente);
  const docs = await leerDocumento(F.c, F.t, F.f, s, d, folio);
  console.log(`${folioSuite} · ${tipo} · ${F.nombre} · folio Kepler ${folio} · Suite: ${r.estado}, kepler_folio=${r.kepler_folio || '∅'}`);
  if (docs.length !== 1) { await F.c.end(); await sc.end(); fin(docs.length ? `${docs.length} documentos con ese folio (series distintas): resolver a mano` : 'No existe en Kepler: nada que deshacer'); }
  const doc = docs[0];
  const hijos = await hijosDe(F.c, F.t, F.f, s, d, doc.serie, folio);
  const no = frenos(doc, folioSuite, d, hijos);
  if (no.length) { no.forEach((x) => console.log(`⛔ ${x}`)); await F.c.end(); await sc.end(); fin('No se deshace.'); }
  console.log(`✔ Frenos superados: marca correcta, c43='N', sin hijos${d.limpiar.length ? ', sin responsables' : ''}. Total ${doc.total}.`);
  await F.c.end();
  if (!apply) { await sc.end(); console.log('\n(ensayo) Con --apply se respaldaría y borraría este documento.'); return; }

  const admin = env(`KEPLER_ADMIN_URL_${s}`);
  if (!admin) fin(`Falta KEPLER_ADMIN_URL_${s}: kepler_push no puede borrar, a propósito`);
  const k = new Client({ connectionString: admin, statement_timeout: 30000, connectionTimeoutMillis: 8000 });
  await k.connect();
  const key = [s, d.c2, d.c3, d.c4, doc.serie, folio];
  const W = `c1=$1 AND c2=$2 AND c3=$3 AND btrim(c4::text)=$4 AND btrim(c5::text)=$5 AND c6=$6`;
  try {
    await k.query('BEGIN');
    // Revalidar con el encabezado bloqueado: entre el ensayo y ahora alguien pudo procesarlo.
    const again = (await k.query(`SELECT btrim(${d.marca}) marca, btrim(c43) c43,
        ${d.limpiar.length ? d.limpiar.map((x) => `btrim(coalesce(${x},''))`).join('||') : `''`} AS responsables
        FROM md.kdm1 WHERE ${W} FOR UPDATE`, key)).rows;
    if (again.length !== 1) throw new Error('el documento cambió o desapareció entre el ensayo y el borrado');
    const no2 = frenos(again[0], folioSuite, d, await hijosDe(k, (x) => `md.${x}`, () => '', s, d, doc.serie, folio));
    if (no2.length) throw new Error(no2.join(' · '));

    // Respaldo EXACTO: el JSON de Postgres como texto, sin pasar por números de JS.
    const h = (await k.query(`SELECT row_to_json(t)::text j FROM md.kdm1 t WHERE ${W}`, key)).rows.map((x) => x.j);
    const l = (await k.query(`SELECT row_to_json(t)::text j FROM md.kdm2 t WHERE ${W} ORDER BY c7`, key)).rows.map((x) => x.j);
    const dir = arg('respaldo-dir') || path.join(os.homedir(), 'kepler-push-respaldos');
    fs.mkdirSync(dir, { recursive: true });
    const archivo = path.join(dir, `${s}_${d.c2}${d.c3}${d.c4}_${folio}_${folioSuite}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const fd = fs.openSync(archivo, 'wx');
    fs.writeSync(fd, JSON.stringify({ sucursal: s, tipo, folio_suite: folioSuite, kepler_folio: folio, serie: doc.serie, kdm1: h, kdm2: l, respaldado: new Date().toISOString() }, null, 1));
    fs.fsyncSync(fd); fs.closeSync(fd);
    console.log(`Respaldo: ${archivo} (1 encabezado, ${l.length} renglones)`);

    const b2 = await k.query(`DELETE FROM md.kdm2 WHERE ${W}`, key);
    const b1 = await k.query(`DELETE FROM md.kdm1 WHERE ${W}`, key);
    if (b1.rowCount !== 1 || b2.rowCount !== l.length) throw new Error(`se iban a borrar ${b1.rowCount}+${b2.rowCount} filas y el respaldo tiene 1+${l.length}`);
    await k.query('COMMIT');
    console.log(`✔ Borrado en Kepler ${s}: 1 encabezado, ${b2.rowCount} renglones.`);

    const u = await sc.query(
      `UPDATE commercial.purchase_requisitions
          SET kepler_sucursal=NULL, kepler_folio=NULL, kepler_pushed_at=NULL,
              kepler_error=$4
        WHERE tenant_id=$1 AND folio=$2 AND kepler_sucursal=$3 AND kepler_folio=$5`,
      [TENANT, folioSuite, s, `Deshecho en Kepler ${new Date().toISOString()} (respaldo ${path.basename(archivo)})`, folio]);
    if (u.rowCount === 1) console.log('✔ La Suite ya no lo da por escrito: se puede reintentar desde la ficha.');
    else console.log(`⚠️ La Suite NO se actualizó (${u.rowCount} filas). Si apuntaba a este documento, limpiar kepler_folio a mano.`);
  } catch (e) {
    await k.query('ROLLBACK').catch(() => undefined);
    console.error(`⛔ ROLLBACK, Kepler quedó como estaba: ${e.message}`);
    process.exitCode = 1;
  } finally { await k.end(); await sc.end(); }
}

// ── restaurar ──────────────────────────────────────────────────────────────────────────────
async function restaurar() {
  const archivo = arg('archivo'); if (!archivo) fin('--archivo <respaldo.json>');
  const R = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  const s = R.sucursal; const d = DOC[R.tipo];
  console.log(`${R.folio_suite} · ${R.tipo} · servidor ${s} · folio ${R.kepler_folio} · ${R.kdm2.length} renglones`);
  if (!flag('apply')) { console.log('(ensayo) Con --apply se re-insertaría.'); return; }
  const admin = env(`KEPLER_ADMIN_URL_${s}`); if (!admin) fin(`Falta KEPLER_ADMIN_URL_${s}`);
  const k = new Client({ connectionString: admin, statement_timeout: 30000 });
  await k.connect();
  try {
    await k.query('BEGIN');
    const ya = await k.query(`SELECT 1 FROM md.kdm1 WHERE c1=$1 AND c2=$2 AND c3=$3 AND btrim(c4::text)=$4 AND btrim(c5::text)=$5 AND c6=$6`,
      [s, d.c2, d.c3, d.c4, R.serie, R.kepler_folio]);
    if (ya.rowCount) throw new Error('ese folio ya existe en Kepler (¿otro documento lo tomó?): no se pisa');
    for (const j of R.kdm1) await k.query(`INSERT INTO md.kdm1 SELECT * FROM json_populate_record(NULL::md.kdm1, $1::json)`, [j]);
    for (const j of R.kdm2) await k.query(`INSERT INTO md.kdm2 SELECT * FROM json_populate_record(NULL::md.kdm2, $1::json)`, [j]);
    await k.query('COMMIT');
    console.log('✔ Restaurado en Kepler.');
  } catch (e) {
    await k.query('ROLLBACK').catch(() => undefined);
    console.error(`⛔ ROLLBACK: ${e.message}`); process.exitCode = 1; await k.end(); return;
  }
  await k.end();
  const sc = await suite();
  if (!sc) { console.log('⚠️ Sin PROD_DB_URL: re-ligar la Suite a mano.'); return; }
  const u = await sc.query(
    `UPDATE commercial.purchase_requisitions SET kepler_sucursal=$3, kepler_folio=$4, kepler_pushed_at=now(), kepler_error=NULL
      WHERE tenant_id=$1 AND folio=$2 AND kepler_folio IS NULL`, [TENANT, R.folio_suite, s, R.kepler_folio]);
  console.log(u.rowCount === 1 ? '✔ La Suite vuelve a apuntar al documento.' : '⚠️ La Suite ya tenía otro folio (¿se reintentó?): revisar a mano, hay DOS documentos.');
  await sc.end();
}

const CMDS = { revisar, listar, deshacer, restaurar };
if (!CMDS[cmd]) fin(`Uso: kepler-push-ops.js <${Object.keys(CMDS).join('|')}> …  (ver cabecera)`);
CMDS[cmd]().catch((e) => { console.error(`⛔ ${e.message}`); process.exit(1); });
