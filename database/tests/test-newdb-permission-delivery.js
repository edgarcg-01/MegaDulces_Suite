'use strict';
/**
 * `[ID.29]` — Candado de REPARTO de permisos. Lo que el catalogo declara, contra lo que
 * un rol vivo concede de verdad.
 *
 * ── POR QUE EXISTE ──────────────────────────────────────────────────────────────────────
 * El enum ya lo dice en su propio encabezado -- *"declararlo en el enum no es entregarlo"*
 * (`[LC.6.2]`) -- y nada lo MEDIA. La regla estaba escrita y sin compuerta, que es la forma
 * mas cara de tener una regla: se cita en los reviews y no detiene nada.
 *
 * Ya cobro dos veces, las dos con el mismo sintoma (un modulo en produccion que nadie podia
 * abrir, descubierto por una persona dias despues):
 *
 *   · `FISCAL_PURCHASE_BOOK_VER/_GESTIONAR` (Fase LC) -- un dia en prod, cero roles.
 *   · `STORE_PRICE_CHECK_VER` (CV.24) -- el verificador de mostrador, cero roles hasta que
 *     la migracion `20260909120000` lo repartio a 7.
 *
 * Y midiendo para escribir este archivo aparecio la tercera, que llevaba **23 dias** viva:
 * `COMMERCIAL_PREVENTION_GESTIONAR` (ver `SIN_REPARTIR`).
 *
 * ── CONTRA QUE BASE MIDE, Y POR QUE ─────────────────────────────────────────────────────
 * Contra **PROD** (`FLEET_DB_URL`), a proposito. El invariante es sobre el padron que sirve
 * a la gente: verde sobre una copia local vieja es exactamente la mentira que esto viene a
 * matar (la copia trae los `role_permissions` de cuando se bajo, no los de hoy). Es
 * ESTRICTAMENTE de lectura -- cero INSERT/UPDATE/DELETE -- por eso no pasa por
 * `assertSafeTarget`, que guarda a los tests que escriben.
 * Si no se llega: **NO MEDIDO** (exit 2), nunca verde.
 *
 * ── POBLADO != FRESCO ───────────────────────────────────────────────────────────────────
 * Declara que base midio y de cuando es el `role_permissions` mas nuevo que vio. Un censo
 * sobre datos viejos sigue siendo un censo viejo, y eso se lee en pantalla.
 *
 * Cierra con la PRUEBA NEGATIVA: las tres compuertas se corren contra entradas adulteradas
 * y se exige que se pongan ROJAS. Un gate sin prueba negativa es una intencion (ADR-056).
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const REPO = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(REPO, '.env') });

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };

/**
 * Claves declaradas a proposito SIN repartir. Entrar aca exige un motivo real y un dueno:
 * la lista existe para DECLARAR una decision pendiente, no para silenciar un defecto.
 *
 * El test ademas la vigila al reves: si una de estas ya quedo repartida, exige sacarla
 * (una lista de excepciones que nadie poda deja de significar algo).
 */
const SIN_REPARTIR = {
  COMMERCIAL_PREVENTION_GESTIONAR:
    'Prevencion de perdida. El modulo (mig 20260817160000) declara SEGREGACION DE FUNCIONES: ' +
    '"quien cuenta/reconcilia NO es quien investiga". A quien le toca investigar es decision de ' +
    'negocio y NO se deriva del estado vivo -- repartirlo a ojo destruiria el control que el ' +
    'modulo existe para implementar. Hoy: direccion lo VE y nadie lo OPERA. Pendiente: Edgar.',
};

// ── El catalogo, leido de la definicion UNICA (ID.28) ────────────────────────────────────
const CATALOGO = [...fs.readFileSync(path.join(REPO, 'libs/contracts/src/authz/permissions.ts'), 'utf8')
  .matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\s*=\s*'([A-Z0-9_]+)'/gm)].map((m) => m[2]);

/**
 * Claves que GATEAN una escritura viva. Es lo que separa "permiso reservado que no bloquea
 * nada" de "cinco endpoints que nadie puede alcanzar". Se lee de los controllers reales.
 */
function clavesQueGatean() {
  const fuentes = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(f); continue; }
      if (/\.controller\.ts$/.test(e.name)) fuentes.push(f);
    }
  };
  walk(path.join(REPO, 'libs'));
  walk(path.join(REPO, 'apps/api/src'));

  const cuenta = new Map();
  for (const f of fuentes) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/@Require(?:Any)?Permissions?\(([^)]*)\)/g)) {
      for (const k of m[1].matchAll(/Permission\.([A-Z0-9_]+)/g)) {
        cuenta.set(k[1], (cuenta.get(k[1]) || 0) + 1);
      }
    }
  }
  return cuenta;
}

/**
 * Las tres compuertas, como FUNCION PURA. Que sean puras es lo que hace posible la prueba
 * negativa: se las alimenta con entradas adulteradas y tienen que ponerse rojas.
 */
function evaluar(catalogo, vivo, gatean, permitidas) {
  const nadieMenciona = catalogo.filter((k) => !vivo.has(k));
  const nadieConcede = catalogo.filter((k) => {
    const v = vivo.get(k);
    return v && v.conTrue === 0 && gatean.has(k) && !permitidas[k];
  });
  const fueraDeCatalogo = [...vivo.keys()].filter((k) => !catalogo.includes(k));
  return { nadieMenciona, nadieConcede, fueraDeCatalogo };
}

(async () => {
  const url = process.env.PERM_DELIVERY_URL || process.env.FLEET_DB_URL || process.env.DATABASE_URL_NEW;
  if (!url) noMedido('no hay FLEET_DB_URL ni DATABASE_URL_NEW en .env');

  const c = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    statement_timeout: 30000,
  });
  try {
    await c.connect();
  } catch (e) {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo llegar al padron -- ${e.message}`);
    throw e;
  }

  // ── Procedencia: que base es esta, y de cuando es lo que trae ─────────────────────────
  const { rows: quien } = await c.query('SELECT current_database() AS db, version() AS v');
  const { rows: frescura } = await c.query(`
    SELECT count(*)::int AS roles, max(updated_at) AS ultimo
      FROM identity.role_permissions
     WHERE deleted_at IS NULL AND role_name NOT LIKE 'retirado%'`);
  console.log(`\n  base: ${quien[0].db} · pg ${quien[0].v.split(' ')[1]}`);
  console.log(`  padron: ${frescura[0].roles} roles vivos · role_permissions mas nuevo: ${frescura[0].ultimo || '(nunca)'}`);
  console.log('  (poblado != fresco: el censo vale lo que valga esa fecha)\n');

  const { rows } = await c.query(`
    SELECT e.key,
           count(*) FILTER (WHERE e.value = 'true'::jsonb)  AS con_true,
           count(*) FILTER (WHERE e.value = 'false'::jsonb) AS con_false
      FROM identity.role_permissions rp, jsonb_each(rp.permissions) e
     WHERE rp.deleted_at IS NULL AND rp.role_name NOT LIKE 'retirado%'
     GROUP BY e.key`);
  await c.end();

  const vivo = new Map(rows.map((r) => [r.key, { conTrue: Number(r.con_true), conFalse: Number(r.con_false) }]));
  const gatean = clavesQueGatean();

  // ── 0. PISO ──────────────────────────────────────────────────────────────────────────
  // ID.28 ya enseno que una comparacion entre dos conjuntos vacios se pone verde sola.
  console.log('[0] Piso -- ningun conjunto vacio se lee como coincidencia');
  ok(CATALOGO.length > 100, `catalogo parseado: ${CATALOGO.length} claves`);
  ok(vivo.size > 100, `claves mencionadas por algun rol vivo: ${vivo.size}`);
  ok(gatean.size > 20, `claves que gatean una escritura: ${gatean.size}`);

  const r = evaluar(CATALOGO, vivo, gatean, SIN_REPARTIR);

  // ── 1. Toda clave del catalogo la MENCIONA alguien ────────────────────────────────────
  console.log('\n[1] Reparto -- ninguna clave del catalogo es invisible para todos los roles');
  ok(r.nadieMenciona.length === 0,
    r.nadieMenciona.length === 0
      ? 'las 0 claves huerfanas'
      : `${r.nadieMenciona.length} clave(s) que NINGUN rol menciona (modulo entregado e inalcanzable): ${r.nadieMenciona.join(', ')}`);

  // ── 2. Toda clave que gatea una escritura la CONCEDE alguien ─────────────────────────
  console.log('\n[2] Alcance -- lo que gatea una escritura tiene que ser alcanzable');
  for (const k of r.nadieConcede) {
    console.log(`      ${k}: gatea ${gatean.get(k)} escritura(s) y ningun rol lo concede`);
  }
  ok(r.nadieConcede.length === 0,
    r.nadieConcede.length === 0
      ? 'toda clave que gatea una escritura la concede al menos un rol (o esta declarada)'
      : `${r.nadieConcede.length} clave(s) gatean escrituras que nadie puede alcanzar`);

  // ── 3. Nada en la DB fuera del catalogo ──────────────────────────────────────────────
  console.log('\n[3] Deriva -- el padron no inventa claves');
  ok(r.fueraDeCatalogo.length === 0,
    r.fueraDeCatalogo.length === 0
      ? 'ninguna clave del padron esta fuera del catalogo'
      : `${r.fueraDeCatalogo.length} clave(s) en la DB que el catalogo no conoce: ${r.fueraDeCatalogo.join(', ')}`);

  // ── 4. La lista de excepciones no se pudre ───────────────────────────────────────────
  console.log('\n[4] Higiene de la lista de declaradas');
  const yaRepartidas = Object.keys(SIN_REPARTIR).filter((k) => (vivo.get(k)?.conTrue || 0) > 0);
  ok(yaRepartidas.length === 0,
    yaRepartidas.length === 0
      ? `las ${Object.keys(SIN_REPARTIR).length} declaradas siguen sin repartir (la lista dice la verdad)`
      : `sacar de SIN_REPARTIR (ya estan repartidas): ${yaRepartidas.join(', ')}`);
  const noExisten = Object.keys(SIN_REPARTIR).filter((k) => !CATALOGO.includes(k));
  ok(noExisten.length === 0,
    noExisten.length === 0
      ? 'ninguna declarada quedo fuera del catalogo'
      : `SIN_REPARTIR nombra claves que ya no existen: ${noExisten.join(', ')}`);

  // ── 5. Lo que se DECLARA, con nombre ─────────────────────────────────────────────────
  const soloFalse = CATALOGO.filter((k) => vivo.get(k) && vivo.get(k).conTrue === 0);
  console.log('\n[5] Declarado (no es falla, es deuda con nombre)');
  if (!soloFalse.length) console.log('      (ninguna)');
  for (const k of soloFalse) {
    const g = gatean.get(k) || 0;
    console.log(`      · ${k} -- en false en ${vivo.get(k).conFalse} rol(es), gatea ${g} escritura(s)`);
    if (SIN_REPARTIR[k]) console.log(`        motivo: ${SIN_REPARTIR[k]}`);
    else if (!g) console.log('        sin escrituras gateadas: reservado, no bloquea nada hoy');
  }

  // ── 6. PRUEBA NEGATIVA ───────────────────────────────────────────────────────────────
  // Las tres compuertas, rotas a proposito. Si alguna sigue verde con la entrada adulterada,
  // este archivo es decorativo.
  console.log('\n[6] Prueba negativa -- las compuertas rotas a proposito tienen que dar ROJO');
  const falsa = 'PERMISO_QUE_NADIE_REPARTIO_XYZ';
  const n1 = evaluar([...CATALOGO, falsa], vivo, gatean, SIN_REPARTIR);
  ok(n1.nadieMenciona.includes(falsa), '[1] detecta una clave del catalogo que ningun rol menciona');

  const vivoRoto = new Map(vivo);
  const victima = [...gatean.keys()].find((k) => vivo.get(k)?.conTrue > 0);
  vivoRoto.set(victima, { conTrue: 0, conFalse: 3 });
  const n2 = evaluar(CATALOGO, vivoRoto, gatean, SIN_REPARTIR);
  ok(n2.nadieConcede.includes(victima), `[2] detecta que ${victima} gatea escrituras y nadie lo concede`);

  const vivoSucio = new Map(vivo);
  vivoSucio.set('CLAVE_BASURA_QUE_NO_EXISTE', { conTrue: 1, conFalse: 0 });
  const n3 = evaluar(CATALOGO, vivoSucio, gatean, SIN_REPARTIR);
  ok(n3.fueraDeCatalogo.includes('CLAVE_BASURA_QUE_NO_EXISTE'), '[3] detecta una clave del padron fuera del catalogo');

  const n4 = evaluar(CATALOGO, vivo, gatean, {});
  ok(n4.nadieConcede.length > r.nadieConcede.length,
    `sin la lista de declaradas la compuerta [2] cae en rojo (${n4.nadieConcede.length} vs ${r.nadieConcede.length}): la lista TAPA algo real, no esta de adorno`);

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} pass · ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  if (esFaltaDeAcceso(e)) noMedido(`no se pudo llegar al padron -- ${e.message}`);
  console.error('\nFALLA:', e.message);
  process.exit(1);
});
