'use strict';
/**
 * CANDADO — dos migraciones no pueden compartir el mismo timestamp.
 *
 * ── QUÉ PASA CUANDO COLISIONAN ───────────────────────────────────────────────────────────
 * Knex ordena las migraciones por NOMBRE DE ARCHIVO COMPLETO, no por el timestamp. Con dos
 * archivos que arrancan igual, el desempate lo decide el resto del nombre — o sea el alfabeto,
 * o sea el azar. Y el orden de aplicación deja de ser el que pensó quien las escribió:
 *
 *     20260930120000_standard_cost_precision.js     <- se aplica ANTES
 *     20260930120000_fix_transfer_dest_cedis.js     <- ...que ésta, por la "f" contra la "s"
 *
 * Mientras las dos sean independientes no duele. El día que una dependa de la otra —una crea la
 * vista y la otra la consulta, una agrega la columna y la otra la llena— falla en prod y no en
 * local, porque en local se aplicaron en otro momento y el estado ya estaba.
 *
 * ── POR QUÉ ACÁ Y NO EN OTRO LADO ────────────────────────────────────────────────────────
 * La rama la comparten ~10 sesiones que escriben migraciones el mismo día, y el timestamp lo
 * pone la persona a mano. Medido en el árbol de trabajo el 2026-09-30: `20260930120000` tenía
 * CINCO archivos distintos y `20260929120000` otros cinco. No es un riesgo teórico, es el
 * régimen normal.
 *
 * `check-applied-migrations.js` NO cubre esto: vigila que no se EDITE una migración ya
 * aplicada, que es otro problema.
 *
 * ── ⛔ LO QUE HACE QUE ESTE CANDADO SEA DELICADO ─────────────────────────────────────────
 * El arreglo de una colisión es RENOMBRAR el archivo. Y renombrar una migración que YA se
 * aplicó en prod es peor que la colisión: la fila de `public.knex_migrations` queda apuntando
 * a un archivo que no existe, y knex aborta con "migration directory is corrupt".
 *
 * Por eso el candado no se pregunta "¿colisiona?" sino "¿colisiona algo que TODAVÍA SE PUEDE
 * RENOMBRAR?". Un archivo está CONGELADO si está en `origin/main` **o** si ya figura aplicado
 * en prod. Las colisiones entre congelados son historia: se declaran y no se tocan.
 *
 * Eso obliga a leer el ledger de prod. Si no se puede leer, el candado NO se pone verde: no
 * puede distinguir un archivo recién escrito de uno ya aplicado sin pushear, y confundirlos
 * sería recomendar justo el renombre que rompe prod.
 *
 * ── USO ──────────────────────────────────────────────────────────────────────────────────
 *   node scripts/check-migration-collisions.js              # veredicto (lee prod, sólo SELECT)
 *   node scripts/check-migration-collisions.js --solo-git   # sin prod: declara NO MEDIDO (exit 2)
 *   node scripts/check-migration-collisions.js --self-test  # la prueba negativa
 *
 * Salidas: 0 = sin colisiones accionables · 1 = hay colisión que renombrar · 2 = NO MEDIDO.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');
const { execSync } = require('child_process');
const { Client } = require('pg');

/** Sólo la base nueva: es la activa y la única cuyo ledger vive en `public.knex_migrations`. */
const DIR = 'database/migrations-newdb';
const RE_MIG = /^(\d{14})_(.+)\.js$/;

/**
 * El núcleo, puro y sin E/S, para que `--self-test` pueda ejercerlo de verdad.
 *
 * @param {string[]} archivos  nombres de archivo del directorio de migraciones
 * @param {Set<string>} congelados  los que NO se pueden renombrar (en main o aplicados)
 * @returns {{prefijo:string, miembros:string[], renombrables:string[]}[]} grupos accionables
 */
function analizar(archivos, congelados) {
  const porPrefijo = new Map();
  for (const f of archivos) {
    const m = RE_MIG.exec(f);
    if (!m) continue;
    if (!porPrefijo.has(m[1])) porPrefijo.set(m[1], []);
    porPrefijo.get(m[1]).push(f);
  }
  const grupos = [];
  for (const [prefijo, miembros] of [...porPrefijo].sort()) {
    if (miembros.length < 2) continue;
    const renombrables = miembros.filter((f) => !congelados.has(f)).sort();
    // Una colisión entre archivos todos congelados es historia: no hay nada que hacer con ella.
    if (!renombrables.length) continue;
    grupos.push({ prefijo, miembros: miembros.slice().sort(), renombrables });
  }
  return grupos;
}

/** Los nombres de archivo de migración que ya viven en una rama de git. */
function enGit(ref) {
  const salida = execSync(`git ls-tree -r --name-only ${ref} -- ${DIR}/`, { encoding: 'utf8' });
  return new Set(
    salida.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.js')).map((l) => path.basename(l)),
  );
}

/** El ledger real de prod, con la compuerta de identidad puesta ANTES de creerle una fila. */
async function aplicadasEnProd() {
  const url = process.env.DATABASE_URL_NEW_PROD || process.env.PROD_DB_URL
    || (process.env.DATABASE_URL_NEW && process.env.NODE_ENV === 'production' ? process.env.DATABASE_URL_NEW : null);
  if (!url) {
    return { error: 'no hay URL de prod (definí PROD_DB_URL en tu .env — 192.168.0.222:5434/railway)' };
  }
  const local = /localhost|127\.0\.0\.1|192\.168\./.test(url);
  const c = new Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  try {
    await c.connect();
    // Un candado que lee la base equivocada es PEOR que no tener candado: se ve verde.
    // Mismo identificador que usan `apply-one-migration-prod.js` y `check-applied-migrations.js`.
    const ESPERADO = process.env.PROD_CLUSTER_ID || '7688376744939610156';
    const { rows: [id] } = await c.query(
      'select (select system_identifier from pg_control_system())::text as id, current_database() as db',
    );
    if (id.id !== ESPERADO) {
      return { error: `destino equivocado: clúster ${id.id} (base "${id.db}"), se esperaba ${ESPERADO}` };
    }
    // ⛔ `public.` explícito. El search_path arranca en `identity` y esa tabla no es la buena.
    const { rows } = await c.query('SELECT name FROM public.knex_migrations');
    return { nombres: new Set(rows.map((r) => r.name)) };
  } catch (e) {
    return { error: e.message };
  } finally {
    await c.end().catch(() => { /* ya estaba cerrada */ });
  }
}

/**
 * ⛔ `medido` NO es decorativo. Sin el ledger de prod, un archivo fuera de `origin/main` puede ser
 * uno recién escrito (renombrable) o uno ya aplicado y sin pushear (renombrarlo rompe el ledger).
 * Son indistinguibles, así que en ese modo NINGUNO se etiqueta "RENOMBRAR": se declara la duda.
 * Lo encontré corriendo el propio candado: en --solo-git le decía RENOMBRAR a
 * `20260930150000_analytics_price_experiment_results.js`, que está aplicada en prod.
 */
function imprimirGrupos(grupos, congeladosConocidos, medido) {
  for (const g of grupos) {
    console.error(`\n   ✗ ${g.prefijo} — ${g.miembros.length} archivos comparten este timestamp:`);
    for (const f of g.miembros) {
      const marca = congeladosConocidos.has(f)
        ? 'congelada     '
        : (medido ? 'RENOMBRAR     ' : 'SIN CLASIFICAR');
      console.error(`        ${marca}  ${f}`);
    }
  }
}

// ── La prueba negativa. Un gate sin ella es una intención. ────────────────────────────────
if (process.argv.includes('--self-test')) {
  let fallas = 0;
  const ck = (etiqueta, cond) => {
    if (cond) { console.log(`  ✔ ${etiqueta}`); } else { fallas++; console.log(`  ✖ ${etiqueta}`); }
  };
  console.log('\n=== self-test de check-migration-collisions ===\n');

  // 1. Dos archivos NUEVOS con el mismo timestamp: tiene que salir ROJO.
  ck('dos migraciones nuevas con el mismo timestamp salen ROJAS',
    analizar(['20260930120000_a.js', '20260930120000_b.js'], new Set()).length === 1);

  // 2. Una nueva que choca con una ya congelada: ROJO, y la renombrable es SÓLO la nueva.
  const g2 = analizar(
    ['20260930120000_vieja.js', '20260930120000_nueva.js'],
    new Set(['20260930120000_vieja.js']),
  );
  ck('una nueva que choca con una congelada sale ROJA', g2.length === 1);
  ck('…y señala como renombrable SÓLO la nueva',
    g2.length === 1 && g2[0].renombrables.length === 1 && g2[0].renombrables[0] === '20260930120000_nueva.js');

  // 3. ⭐ El caso que hace peligroso a este candado: dos CONGELADAS que chocan. Es historia
  //    ya aplicada; marcarla en rojo empujaría a renombrar una migración viva.
  ck('dos congeladas que chocan NO se reportan (renombrarlas rompe el ledger de prod)',
    analizar(
      ['20260930120000_x.js', '20260930120000_y.js'],
      new Set(['20260930120000_x.js', '20260930120000_y.js']),
    ).length === 0);

  // 4. Timestamps distintos: verde.
  ck('timestamps distintos salen VERDES',
    analizar(['20260930120000_a.js', '20260930130000_b.js'], new Set()).length === 0);

  // 5. Un archivo que no parece migración no participa ni rompe el parseo.
  ck('un archivo que no es migración se ignora sin romper',
    analizar(['README.md', 'sin-timestamp.js', '20260930120000_a.js'], new Set()).length === 0);

  // 6. ⭐ REGRESIÓN (PR #192, 2026-09-30). Una rama 37 commits atrás no tiene EN DISCO la
  //    migración que otra sesión ya mergeó a main. Si el universo es sólo el disco, el grupo
  //    queda con un miembro y el candado da VERDE — en el escenario exacto para el que existe.
  //    El universo tiene que ser disco ∪ main, porque la colisión aparece al MERGEAR.
  const dsk = ['20260929180000_la_mia.js'];
  const mn = ['20260929180000_de_otra_sesion.js'];
  ck('[el bug] mirando SÓLO el disco, la rama atrasada no ve la colisión',
    analizar(dsk, new Set(mn)).length === 0);
  ck('[el fix] con el universo disco ∪ main la ve, y sólo la mía es renombrable',
    (() => {
      const g = analizar([...dsk, ...mn], new Set(mn));
      return g.length === 1 && g[0].renombrables.length === 1
        && g[0].renombrables[0] === '20260929180000_la_mia.js';
    })());

  console.log(fallas ? `\n  ${fallas} falla(s)\n` : '\n  self-test OK\n');
  process.exit(fallas ? 1 : 0);
}

(async () => {
  const soloGit = process.argv.includes('--solo-git');
  const raiz = path.resolve(__dirname, '..');
  const enDisco = fs.readdirSync(path.join(raiz, DIR)).filter((f) => f.endsWith('.js'));

  let enMain;
  try {
    enMain = enGit('origin/main');
  } catch (e) {
    console.error(`⛔ NO MEDIDO: no se pudo leer origin/main (${e.message.split('\n')[0]}).`);
    process.exit(2);
  }

  /**
   * ⭐ El universo es DISCO ∪ origin/main, no sólo el disco.
   *
   * Medido el 2026-09-30 con el PR #192: su rama estaba 37 commits atrás, así que las dos
   * migraciones `20260929180000_*` que ya viven en main NO estaban en su árbol. La suya, con ese
   * mismo prefijo, quedaba sola en su grupo y el candado daba VERDE — justo en el escenario para
   * el que existe, una rama que no vio lo que otra sesión mergeó mientras tanto.
   *
   * Mirar sólo el disco mide la rama contra sí misma. La colisión aparece al MERGEAR, así que el
   * universo tiene que incluir lo que hay en main aunque el checkout no lo tenga bajado.
   */
  const archivos = [...new Set([...enDisco, ...enMain])].sort();

  if (soloGit) {
    // Sin prod no se puede distinguir "recién escrita" de "aplicada y sin pushear". Se DECLARA.
    const grupos = analizar(archivos, enMain);
    if (!grupos.length) {
      console.log(`✓ ${archivos.length} migraciones · ninguna colisión fuera de origin/main.`);
      process.exit(0);
    }
    console.error(`\n⛔ NO MEDIDO — ${grupos.length} grupo(s) con timestamp repetido y al menos un`);
    console.error('   archivo fuera de origin/main. Sin consultar prod NO se puede saber cuál de');
    console.error('   ellos ya está aplicado, y renombrar uno aplicado deja el ledger apuntando a');
    console.error('   un archivo inexistente ("migration directory is corrupt").');
    imprimirGrupos(grupos, enMain, false);
    console.error('\n   Corré sin --solo-git para el veredicto.\n');
    process.exit(2);
  }

  const prod = await aplicadasEnProd();
  if (prod.error) {
    console.error(`\n⛔ NO MEDIDO — no se pudo leer el ledger de prod: ${prod.error}`);
    console.error('   Este candado NO se reporta verde sin esa lectura: sin ella confundiría una');
    console.error('   migración recién escrita con una ya aplicada, y recomendaría el renombre que');
    console.error('   rompe prod. Usá --solo-git si querés el análisis parcial, declarado como tal.\n');
    process.exit(2);
  }

  const congelados = new Set([...enMain, ...prod.nombres]);
  const grupos = analizar(archivos, congelados);

  if (!grupos.length) {
    console.log(`✓ ${archivos.length} migraciones · ${congelados.size} congeladas (en main o aplicadas).`);
    console.log('  Ninguna colisión de timestamp entre archivos todavía renombrables.');
    process.exit(0);
  }

  const aRenombrar = grupos.reduce((n, g) => n + g.renombrables.length, 0);
  console.error(`\n⛔ ${grupos.length} colisión(es) de timestamp · ${aRenombrar} archivo(s) a renombrar`);
  imprimirGrupos(grupos, congelados, true);
  console.error('\n   Knex ordena por nombre COMPLETO: con el mismo timestamp el orden lo decide el');
  console.error('   alfabeto. Renombrá los marcados RENOMBRAR con un timestamp libre (el minuto');
  console.error('   siguiente alcanza). Los marcados "congelada" NO se tocan: ya están en main o');
  console.error('   aplicados en prod, y renombrarlos rompe el ledger.\n');
  process.exit(1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
