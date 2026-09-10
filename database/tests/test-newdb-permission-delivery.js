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
 * ── DOS PREGUNTAS, NO UNA ───────────────────────────────────────────────────────────────
 * *"¿Alguien la CONCEDE?"* y *"¿Alguien la TIENE?"* no son la misma pregunta, y yo las
 * confundi en el primer pase: reporte que prevencion de perdida "direccion la VE y nadie la
 * OPERA" -- falso, porque `direccion` tiene **0 personas activas**. Un permiso concedido a
 * un rol que nadie tiene es tan inalcanzable como uno concedido a nadie, y con la primera
 * compuerta sola, un censo de "0 huerfanas" se lee como "todo alcanzable". Por eso hay
 * dos: `[2]` y `[2b]`.
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
 * Cierra con la PRUEBA NEGATIVA: las cuatro compuertas se corren contra entradas adulteradas
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
    'modulo existe para implementar. Pendiente: Edgar.',
};

/**
 * Claves concedidas SOLO por roles que ninguna persona activa tiene. Es la segunda cara
 * del mismo invariante y la aprendi corrigiendome: el censo de arriba dio 0 huerfanas y
 * yo escribi que prevencion de perdida "direccion la VE y nadie la OPERA". Falso --
 * `direccion` tiene CERO personas activas, asi que a ese modulo **no llega nadie, ni
 * para verlo**. Un permiso concedido a un rol vacio es tan inalcanzable como uno
 * concedido a nadie, y el primer censo no sabia distinguirlos.
 */
const SIN_PERSONAS = {
  COMMERCIAL_PREVENTION_VER:
    'Mismo caso que su hermana _GESTIONAR: su unica via es `direccion`, que hoy tiene 0 ' +
    'personas activas. El modulo de perdida no lo alcanza NADIE. Se resuelve con la misma ' +
    'decision de segregacion de funciones. Pendiente: Edgar.',
  HR_ATTENDANCE_CHECAR:
    'Fase CH.1: su unica via es `checador_kiosco`, que quedo con 0 cuentas a proposito -- la ' +
    'cuenta `checador.03` se borro porque se creo la credencial ANTES que su pantalla, y ' +
    '`[CH.0.10]` sigue bloqueada por una decision de datos (`hr.*` vacio en prod). El rol y el ' +
    'permiso se conservan: son el primitivo, no el defecto.',
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
 * Las cuatro compuertas, como FUNCION PURA. Que sean puras es lo que hace posible la prueba
 * negativa: se las alimenta con entradas adulteradas y tienen que ponerse rojas.
 */
function evaluar(catalogo, vivo, gatean, permitidas, porRol, rolesConGente, sinPersonas) {
  const nadieMenciona = catalogo.filter((k) => !vivo.has(k));
  const nadieConcede = catalogo.filter((k) => {
    const v = vivo.get(k);
    return v && v.conTrue === 0 && gatean.has(k) && !permitidas[k];
  });
  const fueraDeCatalogo = [...vivo.keys()].filter((k) => !catalogo.includes(k));
  // Concedida, pero sólo por roles que nadie tiene → nadie la alcanza igual.
  const sinNadieQueLaTenga = [...(porRol || new Map()).entries()]
    .filter(([k, roles]) => roles.length > 0
      && roles.every((r) => !rolesConGente.has(r))
      && !(sinPersonas || {})[k])
    .map(([k]) => k);
  return { nadieMenciona, nadieConcede, fueraDeCatalogo, sinNadieQueLaTenga };
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

  // Qué roles conceden cada clave, y qué roles tiene alguien de verdad. Sin esto, "0
  // huérfanas" se lee como "todo alcanzable" y no es lo mismo.
  const { rows: filasRol } = await c.query(`
    SELECT e.key, array_agg(DISTINCT rp.role_name) AS roles
      FROM identity.role_permissions rp, jsonb_each(rp.permissions) e
     WHERE rp.deleted_at IS NULL AND rp.role_name NOT LIKE 'retirado%' AND e.value = 'true'::jsonb
     GROUP BY e.key`);
  const { rows: filasGente } = await c.query(`
    SELECT DISTINCT ur.role_name
      FROM identity.user_roles ur
      JOIN identity.users u ON u.id = ur.user_id AND u.tenant_id = ur.tenant_id
     WHERE u.deleted_at IS NULL AND u.status = 'active'`);
  await c.end();

  const porRol = new Map(filasRol.map((f) => [f.key, f.roles]));
  const rolesConGente = new Set(filasGente.map((f) => f.role_name));
  const vivo = new Map(rows.map((r) => [r.key, { conTrue: Number(r.con_true), conFalse: Number(r.con_false) }]));
  const gatean = clavesQueGatean();

  // ── 0. PISO ──────────────────────────────────────────────────────────────────────────
  // ID.28 ya enseno que una comparacion entre dos conjuntos vacios se pone verde sola.
  console.log('[0] Piso -- ningun conjunto vacio se lee como coincidencia');
  ok(CATALOGO.length > 100, `catalogo parseado: ${CATALOGO.length} claves`);
  ok(vivo.size > 100, `claves mencionadas por algun rol vivo: ${vivo.size}`);
  ok(gatean.size > 20, `claves que gatean una escritura: ${gatean.size}`);

  ok(rolesConGente.size > 10, `roles que alguien activo tiene de verdad: ${rolesConGente.size}`);

  const r = evaluar(CATALOGO, vivo, gatean, SIN_REPARTIR, porRol, rolesConGente, SIN_PERSONAS);

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

  // ── 2b. Concedida a un rol que NADIE tiene = inalcanzable igual ──────────────────────
  // La compuerta [2] mira si alguien la concede. Esta mira si alguien la TIENE. Las dos
  // hacen falta: con [2] sola, "0 huerfanas" se lee como "todo alcanzable" y no es lo
  // mismo -- fue exactamente mi error al reportar prevencion de perdida.
  console.log('\n[2b] Alcance real -- un rol vacio no alcanza nada');
  for (const k of r.sinNadieQueLaTenga) {
    console.log(`      ${k}: solo por ${(porRol.get(k) || []).join(', ')} -- 0 personas activas`);
  }
  ok(r.sinNadieQueLaTenga.length === 0,
    r.sinNadieQueLaTenga.length === 0
      ? 'toda clave concedida la tiene alguna persona activa (o esta declarada)'
      : `${r.sinNadieQueLaTenga.length} clave(s) cuya unica via es un rol que nadie tiene`);

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
  const noExisten = [...Object.keys(SIN_REPARTIR), ...Object.keys(SIN_PERSONAS)]
    .filter((k) => !CATALOGO.includes(k));
  ok(noExisten.length === 0,
    noExisten.length === 0
      ? 'ninguna declarada quedo fuera del catalogo'
      : `las listas nombran claves que ya no existen: ${noExisten.join(', ')}`);
  // Misma poda para la 2a lista: una clave que ya llego a alguien deja de ser excepcion.
  const yaTienenGente = Object.keys(SIN_PERSONAS)
    .filter((k) => (porRol.get(k) || []).some((rol) => rolesConGente.has(rol)));
  ok(yaTienenGente.length === 0,
    yaTienenGente.length === 0
      ? `las ${Object.keys(SIN_PERSONAS).length} de SIN_PERSONAS siguen sin una sola persona`
      : `sacar de SIN_PERSONAS (ya hay quien las tenga): ${yaTienenGente.join(', ')}`);

  // ── 5. Lo que se DECLARA, con nombre ─────────────────────────────────────────────────
  const soloFalse = CATALOGO.filter((k) => vivo.get(k) && vivo.get(k).conTrue === 0);
  console.log('\n[5] Declarado (no es falla, es deuda con nombre)');
  if (!soloFalse.length && !Object.keys(SIN_PERSONAS).length) console.log('      (ninguna)');
  for (const k of soloFalse) {
    const g = gatean.get(k) || 0;
    console.log(`      · ${k} -- en false en ${vivo.get(k).conFalse} rol(es), gatea ${g} escritura(s)`);
    if (SIN_REPARTIR[k]) console.log(`        motivo: ${SIN_REPARTIR[k]}`);
    else if (!g) console.log('        sin escrituras gateadas: reservado, no bloquea nada hoy');
  }
  for (const k of Object.keys(SIN_PERSONAS)) {
    console.log(`      · ${k} -- concedida por ${(porRol.get(k) || []).join(', ')}, 0 personas activas`);
    console.log(`        motivo: ${SIN_PERSONAS[k]}`);
  }

  // ── 6. PRUEBA NEGATIVA ───────────────────────────────────────────────────────────────
  // Las tres compuertas, rotas a proposito. Si alguna sigue verde con la entrada adulterada,
  // este archivo es decorativo.
  console.log('\n[6] Prueba negativa -- las compuertas rotas a proposito tienen que dar ROJO');
  const falsa = 'PERMISO_QUE_NADIE_REPARTIO_XYZ';
  const n1 = evaluar([...CATALOGO, falsa], vivo, gatean, SIN_REPARTIR, porRol, rolesConGente, SIN_PERSONAS);
  ok(n1.nadieMenciona.includes(falsa), '[1] detecta una clave del catalogo que ningun rol menciona');

  const vivoRoto = new Map(vivo);
  const victima = [...gatean.keys()].find((k) => vivo.get(k)?.conTrue > 0);
  vivoRoto.set(victima, { conTrue: 0, conFalse: 3 });
  const n2 = evaluar(CATALOGO, vivoRoto, gatean, SIN_REPARTIR, porRol, rolesConGente, SIN_PERSONAS);
  ok(n2.nadieConcede.includes(victima), `[2] detecta que ${victima} gatea escrituras y nadie lo concede`);

  const vivoSucio = new Map(vivo);
  vivoSucio.set('CLAVE_BASURA_QUE_NO_EXISTE', { conTrue: 1, conFalse: 0 });
  const n3 = evaluar(CATALOGO, vivoSucio, gatean, SIN_REPARTIR, porRol, rolesConGente, SIN_PERSONAS);
  ok(n3.fueraDeCatalogo.includes('CLAVE_BASURA_QUE_NO_EXISTE'), '[3] detecta una clave del padron fuera del catalogo');

  // [2b]: se vacia de gente el (los) rol(es) que conceden una clave sana y tiene que caer.
  const sana = [...porRol.entries()].find(([k, roles]) =>
    roles.length > 0 && roles.every((rol) => rolesConGente.has(rol)) && !SIN_PERSONAS[k]);
  const genteRota = new Set([...rolesConGente].filter((rol) => !sana[1].includes(rol)));
  const n5 = evaluar(CATALOGO, vivo, gatean, SIN_REPARTIR, porRol, genteRota, SIN_PERSONAS);
  ok(n5.sinNadieQueLaTenga.includes(sana[0]),
    `[2b] detecta que ${sana[0]} queda sin una sola persona si se vacian ${sana[1].join('/')}`);

  const n4 = evaluar(CATALOGO, vivo, gatean, {}, porRol, rolesConGente, {});
  ok(n4.nadieConcede.length > r.nadieConcede.length && n4.sinNadieQueLaTenga.length > r.sinNadieQueLaTenga.length,
    `sin las listas de declaradas las compuertas [2] y [2b] caen en rojo (${n4.nadieConcede.length} vs ${r.nadieConcede.length} y ${n4.sinNadieQueLaTenga.length} vs ${r.sinNadieQueLaTenga.length}): las listas TAPAN algo real, no estan de adorno`);

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} pass · ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  if (esFaltaDeAcceso(e)) noMedido(`no se pudo llegar al padron -- ${e.message}`);
  console.error('\nFALLA:', e.message);
  process.exit(1);
});
