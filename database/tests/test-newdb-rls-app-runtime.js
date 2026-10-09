/* eslint-disable no-console */
/**
 * `[SEC.RLS]` CANDADO — **¿qué pasaría si la app dejara de correr como superusuario?**
 *
 * ── El hecho que lo motiva, medido el 2026-10-09 ─────────────────────────────────────────
 * La API de producción se conecta como **`postgres`**, que es superusuario y tiene
 * `rolbypassrls = true`. O sea que las **401 tablas con `FORCE ROW LEVEL SECURITY`** del repo
 * **no filtran nada en runtime**: todo el RLS es documentación, no una defensa. Lo único que
 * aísla hoy es el `where tenant_id` que cada servicio escribe a mano; un servicio que lo olvide
 * no tiene red. Hoy no hay fuga ENTRE tenants porque hay **uno solo** (`mega_dulces`), así que
 * el riesgo es de futuro y de defensa en profundidad.
 *
 * ── ⭐ Cómo se mide sin pedir una credencial ──────────────────────────────────────────────
 * `SET LOCAL ROLE app_runtime` desde la sesión de `postgres` **activa el RLS de verdad**: ese
 * rol no tiene `BYPASSRLS`, así que las políticas se evalúan. Todo corre dentro de una
 * transacción que se **revierte** y sólo hace lecturas.
 *
 * ── Qué vigila ───────────────────────────────────────────────────────────────────────────
 *
 * **1. El grant.** Toda tabla con RLS que la app lee tiene que ser legible por `app_runtime`
 * **con el tenant puesto**. Si no, el día del corte esa pantalla devuelve 403 o cero. Esto
 * **falla** si hay un hueco: es un defecto de hoy, no del futuro.
 *
 * **2. ⭐⭐ PRUEBA NEGATIVA, y es la mitad del valor.** Sin tenant en sesión la misma tabla
 * tiene que devolver **cero**. Si devolviera filas, la política no está funcionando y el
 * bloque de arriba se pondría verde midiendo nada. Y al revés: un cero que no viene acompañado
 * de su control positivo no distingue «la política filtró» de «la tabla está vacía» — por eso
 * una tabla vacía se reporta **NO MEDIDO**, no ✔.
 *
 * **3. La lista de trabajo.** Las tablas con RLS que hoy se consultan desde servicios que **no**
 * usan `TenantKnexService` se enumeran: son las que romperían el día del corte. Medido:
 * **14 de 16** devolvían cero, entre ellas `catalog.products` (14,887), `commercial.stock`
 * (57,627) y `finance.findings` (157,263).
 *
 * **4. El blocker que ningún GRANT resuelve.** `REFRESH MATERIALIZED VIEW` exige **ser dueño**.
 * Las 50 matvistas son de `postgres`, así que el refresco tiene que seguir pasando por el pool
 * admin (`KNEX_NEW_DB_ADMIN`) pase lo que pase con el usuario de la app.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rls-app-runtime.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const ROL = 'app_runtime';

/**
 * Las tablas con RLS que hoy se consultan desde servicios SIN `TenantKnexService`.
 * ⚠️ Esta lista es el resultado de una medición del 2026-10-09 (grep de los 41 servicios que
 * inyectan el knex crudo, cruzado contra `pg_class.relrowsecurity`). Si alguien arregla un
 * servicio, la tabla sale de acá; si alguien agrega una consulta cruda, entra. El candado no la
 * puede derivar solo —no lee el código— así que el número de abajo es lo que la mantiene honesta.
 */
const LEIDAS_SIN_TENANT = [
  'analytics.db_health_alerts', 'catalog.products', 'commercial.abc_classification',
  'commercial.customers', 'commercial.lead_reservations', 'commercial.product_label_prices',
  'commercial.recommended_baskets', 'commercial.reorder_policy',
  'commercial.replenishment_findings', 'commercial.route_tickets', 'commercial.stock',
  'commercial.stock_movements', 'commercial.stock_reservation_lines',
  'commercial.stock_reservations', 'finance.bank_statements', 'finance.findings',
];

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

(async () => {
  const db = new Client({
    connectionString: URL, statement_timeout: 120000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;

  console.log('\n[SEC.RLS] ¿qué pasaría si la app dejara de correr como superusuario?');
  const [{ db: base, usr, super_, bypass }] = await q(`
    select current_database() db, current_user usr,
           (select rolsuper from pg_roles where rolname = current_user) super_,
           (select rolbypassrls from pg_roles where rolname = current_user) bypass`);
  console.log(`  destino: ${base} · usuario ${usr}${super_ ? ' (SUPERUSUARIO' : ''}${bypass ? ', salta RLS)' : super_ ? ')' : ''}\n`);

  // ── 0. El estado de hoy, dicho en voz alta ─────────────────────────────────────────────
  console.log('— 0. el estado de hoy —');
  const [{ rls, forzadas }] = await q(`
    select count(*)::int rls, count(*) filter (where relforcerowsecurity)::int forzadas
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and c.relrowsecurity
       and n.nspname not in ('pg_catalog','information_schema')`);
  console.log(`     ${rls} tablas con RLS · ${forzadas} forzadas`);
  const [{ n: tenants }] = await q('select count(*)::int n from tenants');
  console.log(`     ${tenants} tenant(s) — con uno solo, el bypass no filtra ENTRE tenants hoy`);
  if (bypass) {
    console.log(`     ⛔ el usuario de esta conexión salta el RLS: esas ${forzadas} políticas no se evalúan`);
  }

  const [{ existe }] = await q(
    `select count(*)::int existe from pg_roles where rolname = $1 and not rolbypassrls and not rolsuper`, [ROL]);
  check(`existe el rol ${ROL} y NO salta el RLS`, existe === 1,
    'sin ese rol no hay a dónde mover la app');
  if (existe !== 1) {
    await db.end();
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
    process.exit(1);
  }

  // ── 1. El experimento, en transacción revertida ────────────────────────────────────────
  console.log(`\n— 1. ⭐ con SET ROLE ${ROL} el RLS se evalúa de verdad —`);
  await db.query('BEGIN');
  // ⛔ `SET ROLE` sólo lo puede hacer un superusuario o un miembro del rol. Desde una máquina
  // de dev con un rol de sólo lectura esto falla, y entonces el experimento NO SE PUEDE correr.
  // Se DECLARA en vez de ponerse rojo: un test que no pudo medir no es un test que falló.
  try {
    await db.query('SAVEPOINT probe');
    await db.query(`SET LOCAL ROLE ${ROL}`);
    await db.query('ROLLBACK TO SAVEPOINT probe');
  } catch (e) {
    await db.query('ROLLBACK');
    noMedido('el experimento completo', `esta sesión no puede hacer SET ROLE ${ROL} (${e.code}): hace falta superusuario o ser miembro del rol`);
    await db.end();
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ NO MEDIDO\n`);
    process.exit(fail === 0 ? 0 : 1);
  }
  const cuenta = async (t) => {
    try { const r = await db.query(`select count(*)::int n from ${t}`); return r.rows[0].n; }
    catch (e) { return `ERR:${e.code}`; }
  };

  const rompen = [];
  const vacias = [];
  const sinGrant = [];
  for (const t of LEIDAS_SIN_TENANT) {
    await db.query('RESET ROLE');
    const base_ = await cuenta(t);

    await db.query('SAVEPOINT a');
    await db.query(`SET LOCAL ROLE ${ROL}`);
    const sinTenant = await cuenta(t);
    await db.query('ROLLBACK TO SAVEPOINT a');

    await db.query('SAVEPOINT b');
    await db.query('SELECT set_config($1, $2, true)', ['app.tenant_id', TENANT]);
    await db.query(`SET LOCAL ROLE ${ROL}`);
    const conTenant = await cuenta(t);
    await db.query('ROLLBACK TO SAVEPOINT b');

    if (typeof conTenant === 'string') { sinGrant.push(`${t} (${conTenant})`); continue; }
    // ⛔ Una tabla vacía no distingue «la política filtró» de «no había nada»: NO MEDIDO.
    if (base_ === 0) { vacias.push(t); continue; }
    if (sinTenant === 0) rompen.push(t);
  }
  await db.query('RESET ROLE');
  await db.query('ROLLBACK');

  // ── 2. El grant: lo que falla HOY, no en el futuro ─────────────────────────────────────
  console.log('\n— 2. el grant: ¿puede leerlas con el tenant puesto? —');
  check(`${ROL} puede leer las ${LEIDAS_SIN_TENANT.length - vacias.length} tablas con datos`,
    sinGrant.length === 0,
    sinGrant.length ? `sin permiso: ${sinGrant.join(', ')}` : '');

  // ── 3. ⭐⭐ La prueba negativa ──────────────────────────────────────────────────────────
  console.log('\n— 3. ⭐⭐ PRUEBA NEGATIVA: sin tenant tiene que dar CERO —');
  const medibles = LEIDAS_SIN_TENANT.length - vacias.length - sinGrant.length;
  if (medibles > 0) {
    check(`la política filtra de verdad (${rompen.length} de ${medibles} dan cero sin tenant)`,
      rompen.length === medibles,
      rompen.length !== medibles
        ? `${medibles - rompen.length} devolvieron filas SIN tenant: su política no está funcionando`
        : '');
  } else {
    noMedido('la política', 'ninguna tabla de la lista tiene datos que medir');
  }
  for (const t of vacias) noMedido(t, 'la tabla está vacía: un cero no prueba que la política filtre');

  // ── 4. La lista de trabajo ─────────────────────────────────────────────────────────────
  console.log('\n— 4. lo que rompería el día del corte —');
  console.log(`     ${rompen.length} tabla(s) con RLS se consultan desde servicios SIN TenantKnexService:`);
  for (const t of rompen) console.log(`       · ${t}`);
  console.log('     El arreglo no es un GRANT: esos servicios (casi todos @Cron) tienen que correr');
  console.log('     dentro de un scope de tenant. El patrón ya existe en el repo (Fase D.4).');

  // ── 5. El blocker que ningún GRANT resuelve ────────────────────────────────────────────
  console.log('\n— 5. REFRESH MATERIALIZED VIEW exige SER DUEÑO, no un grant —');
  const dueños = await q(`
    select pg_get_userbyid(c.relowner) dueno, count(*)::int n
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'm' group by 1 order by 2 desc`);
  for (const d of dueños) console.log(`     ${d.n} matvista(s) de ${d.dueno}`);
  const deApp = dueños.find((d) => d.dueno === ROL)?.n ?? 0;
  const total = dueños.reduce((a, d) => a + d.n, 0);
  check(`el refresco NO puede depender de ${ROL} (${total - deApp} de ${total} matvistas son de otro dueño)`,
    true, 'tiene que seguir pasando por el pool admin KNEX_NEW_DB_ADMIN');

  await db.end();
  console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ NO MEDIDO\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
