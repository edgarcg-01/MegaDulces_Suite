/* eslint-disable no-console */
/**
 * Smoke FKJ — `finance.kepler_accounts` como VISTA derive-no-copy (mig 20260826190000).
 *
 * Afirma tres cosas que el patrón "tabla → vista" puede romper:
 *   1) que sea vista y no tabla (si alguien re-materializa, esto lo caza);
 *   2) PARIDAD contra el snapshot congelado `kepler_accounts_snapshot_bak` — el derive tiene que
 *      dar exactamente lo mismo que daba el importer, campo por campo;
 *   3) el FILTRO DE TENANT. La tabla tenía RLS forzada y su lector no filtra tenant; una vista no
 *      hereda RLS, así que el filtro vive dentro. Sin `app.tenant_id` la vista debe dar 0 filas
 *      INCLUSO como superusuario (a quien la RLS no aplicaría) — eso prueba que el filtro es real.
 *
 *   node database/tests/test-newdb-kepler-accounts-view.js
 *   DATABASE_URL_NEW=<prod> node database/tests/test-newdb-kepler-accounts-view.js
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const MEGA = '00000000-0000-0000-0000-00000000d01c';

let ok = 0; const fallos = [];
const chk = (cond, msg) => { cond ? ok++ : fallos.push(msg); };
const norm = (v) => (v === null || v === undefined ? '' : String(v).trim());

(async () => {
  const db = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false,
    statement_timeout: 120000,
  });
  await db.connect();
  console.log('\n=== Smoke FKJ — finance.kepler_accounts es vista en vivo ===\n');

  const rk = (await db.query(`SELECT relkind FROM pg_class WHERE oid = to_regclass('finance.kepler_accounts')`)).rows[0];
  if (!rk) {
    console.log('SKIP — finance.kepler_accounts no existe en esta DB.');
    await db.end(); process.exit(0);
  }
  if (rk.relkind !== 'v') {
    console.log(`SKIP — todavía es '${rk.relkind}', falta la migración 20260826190000 en esta DB.`);
    await db.end(); process.exit(0);
  }
  chk(true, '');
  console.log('  relkind = v (vista)');

  // 3) tenant: sin setting → 0 filas; con setting → filas. Se prueba ANTES de leer datos.
  await db.query(`RESET app.tenant_id`).catch(() => {});
  const sinTenant = (await db.query(`SELECT count(*)::int n FROM finance.kepler_accounts`)).rows[0].n;
  chk(sinTenant === 0, `sin app.tenant_id la vista devolvió ${sinTenant} filas (debería ser 0)`);
  await db.query(`SET app.tenant_id = '${MEGA}'`);
  const vista = (await db.query(`SELECT cuenta, cuenta_nombre, cuenta_mayor, cuenta_mayor_nombre, es_mayor, sucursal_ref
                                   FROM finance.kepler_accounts ORDER BY cuenta`)).rows;
  chk(vista.length > 0, 'con app.tenant_id la vista devolvió 0 filas');
  console.log(`  tenant: sin setting=${sinTenant} filas · con setting=${vista.length} filas`);

  // Contrato de columnas: el consumidor (CB.13) selecciona 5 y el tipo del front espera 8.
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='finance' AND table_name='kepler_accounts' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
  for (const c of ['tenant_id', 'cuenta', 'cuenta_nombre', 'cuenta_mayor', 'cuenta_mayor_nombre', 'es_mayor', 'sucursal_ref', 'computed_at']) {
    chk(cols.includes(c), `falta la columna '${c}' en la vista (rompe el contrato con el importer)`);
  }

  // 2) paridad contra el snapshot congelado, si la migración dejó backup.
  const bak = (await db.query(`SELECT to_regclass('finance.kepler_accounts_snapshot_bak') t`)).rows[0].t;
  if (!bak) {
    console.log('  (sin snapshot_bak en esta DB — salto la paridad)');
  } else {
    const prev = (await db.query(`SELECT cuenta, cuenta_nombre, cuenta_mayor, cuenta_mayor_nombre, es_mayor
      FROM finance.kepler_accounts_snapshot_bak WHERE tenant_id=$1 ORDER BY cuenta`, [MEGA])).rows;
    if (!prev.length) {
      console.log('  (snapshot_bak vacío — salto la paridad)');
    } else {
      const vm = new Map(vista.map((r) => [norm(r.cuenta), r]));
      const pm = new Map(prev.map((r) => [norm(r.cuenta), r]));
      const soloBak = [...pm.keys()].filter((k) => !vm.has(k));
      const soloVista = [...vm.keys()].filter((k) => !pm.has(k));
      const distintos = [...pm.keys()].filter((k) => vm.has(k)).filter((k) => {
        const a = pm.get(k), b = vm.get(k);
        return norm(a.cuenta_nombre) !== norm(b.cuenta_nombre)
          || norm(a.cuenta_mayor) !== norm(b.cuenta_mayor)
          || norm(a.cuenta_mayor_nombre) !== norm(b.cuenta_mayor_nombre)
          || Boolean(a.es_mayor) !== Boolean(b.es_mayor);
      });
      chk(soloBak.length === 0, `${soloBak.length} cuentas estaban en el snapshot y la vista no las trae (ej: ${soloBak.slice(0, 3).join(', ')})`);
      chk(soloVista.length === 0, `${soloVista.length} cuentas nuevas en la vista que el snapshot no tenía (ej: ${soloVista.slice(0, 3).join(', ')})`);
      console.log(`  paridad vs snapshot: ${prev.length} filas · solo-snapshot=${soloBak.length} solo-vista=${soloVista.length} distintas=${distintos.length}`);

      // Toda diferencia tiene que estar EXPLICADA: solo se admite en cuentas renombradas en Kepler
      // (>1 nombre en la fuente), y ahí la vista debe traer el nombre del mes más reciente — el
      // importer usaba MAX() alfabético, que da distinto según el collation de la DB.
      for (const k of distintos) {
        const cta = pm.get(k).cuenta;
        const src = (await db.query(`SELECT cuenta_nombre, anio_mes FROM analytics.ledger_monthly
          WHERE tenant_id=$1 AND sucursal='00' AND cuenta=$2 AND cuenta_nombre IS NOT NULL
          ORDER BY anio_mes COLLATE "C" DESC`, [MEGA, cta])).rows;
        const nombres = new Set(src.map((r) => norm(r.cuenta_nombre)));
        const vigente = src.length ? norm(src[0].cuenta_nombre) : '';
        chk(nombres.size > 1,
          `cuenta ${cta} difiere del snapshot pero la fuente tiene un solo nombre → diferencia NO explicada`);
        chk(norm(vm.get(k).cuenta_nombre) === vigente,
          `cuenta ${cta}: la vista trae "${norm(vm.get(k).cuenta_nombre)}" y el nombre vigente (${src[0] && src[0].anio_mes}) es "${vigente}"`);
        chk(norm(pm.get(k).cuenta_mayor) === norm(vm.get(k).cuenta_mayor),
          `cuenta ${cta}: cambió el MAYOR (${norm(pm.get(k).cuenta_mayor)} → ${norm(vm.get(k).cuenta_mayor)}), eso no lo explica un rename`);
        console.log(`    ${cta}: renombrada en Kepler (${nombres.size} nombres) — snapshot "${norm(pm.get(k).cuenta_nombre)}" → vista "${norm(vm.get(k).cuenta_nombre)}" (vigente ${src[0] && src[0].anio_mes})`);
      }
    }
  }

  // Costo: el lector real (CB.13) hace ILIKE + ORDER BY + LIMIT. Si la vista lo vuelve lento, avisa.
  const t0 = Date.now();
  await db.query(`SELECT cuenta, cuenta_nombre, cuenta_mayor, cuenta_mayor_nombre, es_mayor
    FROM finance.kepler_accounts WHERE (cuenta ILIKE $1 OR cuenta_nombre ILIKE $1)
    ORDER BY cuenta LIMIT 60`, ['%102%']);
  const ms = Date.now() - t0;
  chk(ms < 3000, `la búsqueda del lector tardó ${ms}ms (>3s: el derive dejó de ser barato)`);
  console.log(`  búsqueda del lector (ILIKE '%102%' limit 60): ${ms}ms`);

  // es_mayor tiene que ser coherente: cuenta == cuenta_mayor.
  const inc = (await db.query(`SELECT count(*)::int n FROM finance.kepler_accounts
    WHERE es_mayor <> (cuenta = cuenta_mayor)`)).rows[0].n;
  chk(inc === 0, `${inc} filas con es_mayor incoherente respecto de cuenta = cuenta_mayor`);

  console.log(`\n${fallos.length ? '❌' : '✅'} ${ok} aserciones OK${fallos.length ? `, ${fallos.length} fallas:` : ''}`);
  fallos.forEach((f) => console.log('   - ' + f));
  await db.end();
  process.exit(fallos.length ? 1 : 0);
})().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
