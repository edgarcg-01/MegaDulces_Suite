'use strict';
/**
 * `[IDG.3]` — Las vistas de compatibilidad de `public.*` dejan de apagar el RLS.
 *
 * ── El agujero ───────────────────────────────────────────────────────────────
 * Las 23 vistas de `public.<tabla>` son shims del cutover de schemas (`identity`,
 * `trade`, `catalog`, ...). Pertenecen a `postgres` y NO llevaban
 * `security_invoker`, así que bajo el default de Postgres el RLS de la tabla base
 * se evalúa como el **dueño de la vista** — que es superusuario y está exento.
 * Resultado: la vista devuelve TODOS los tenants.
 *
 * Medido en prod antes de esta migración, como `app_runtime`, sin tenant en sesión:
 *
 *     SELECT count(*) FROM identity.users;  -->     0    (RLS filtra)
 *     SELECT count(*) FROM public.users;    -->   125    3 tenants, 123 hashes bcrypt
 *
 * Y `app_runtime` tenía SELECT + INSERT + UPDATE + DELETE sobre ellas. El código
 * de la app las nombra en 180 lugares, entre ellos dos lookups por `username`
 * —que NO es único global: el UNIQUE es `(tenant_id, username)`— y tres
 * escrituras, una de ellas de `password_hash`.
 *
 * ── Por qué esto y no migrar los 180 call sites ──────────────────────────────
 * Son 23 sentencias contra 180 ediciones, y cierran el agujero para todos los
 * call sites de una vez, presentes y futuros. La limpieza del `public.` en el
 * código queda como higiene, ya sin urgencia de seguridad.
 *
 * ── Por qué NO rompe nada (medido, no supuesto) ──────────────────────────────
 * `security_invoker` sólo cambia el comportamiento de un lector que NO esté
 * exento de RLS, o sea `app_runtime`. Se revisaron los 3 caminos:
 *
 *   1. Los 55 reads vía `trx('public.X')` dentro de `TenantKnexService.run()`
 *      corren con `SET LOCAL app.tenant_id` → ya tienen tenant, devuelven las
 *      mismas filas. Pasan de "por casualidad correctos" a "correctos".
 *   2. De los 30 reads que corren FUERA de transacción (`this.knex(...)`, sin
 *      `SET LOCAL`), **28 son `public.tenants`** (el patrón "enumerar tenants
 *      activos" de cada cron) y su tabla base `identity.tenants` **no tiene
 *      RLS** → no-op.
 *   3. Los 2 restantes (`missed-visit-engine`, `route-balance`, ambos sobre
 *      `public.daily_assignments`) inyectan `KNEX_CONNECTION`, que es el pool
 *      `postgres` **exento de RLS** → no-op también.
 *
 * Y no rompe por permisos: se verificó que las 22 tablas base ya tienen SELECT
 * para `app_runtime` (y DML completo salvo `catalog.products_top_sellers`, que
 * es de sólo lectura). Sin ese grant, `security_invoker` daría "permission
 * denied" — es la trampa clásica de este cambio.
 *
 * Los ~20 importers de `database/importers/` que leen estas vistas conectan con
 * `DATABASE_URL_NEW` (rol `postgres`) → siguen viendo todo, sin cambio.
 *
 * ── Lo que NO hace esta migración ────────────────────────────────────────────
 * NO le quita a `app_runtime` el INSERT/UPDATE/DELETE sobre las vistas. Ese
 * REVOKE exige mover antes las tres escrituras de
 * `commercial-customers.service.ts` a `identity.users`, o el portal B2B deja de
 * poder crear accesos. Va en su propia migración después de ese cambio.
 *
 * ── La excepción: `public.products_active` ───────────────────────────────────
 * Queda FUERA, y no por precaución sino porque se midió que se rompe. No es un
 * shim sobre una tabla: es `SELECT ... FROM products_active`, que resuelve a
 * `inventory.products_active`, que a su vez llega a la tabla FORÁNEA
 * `erp.productos_activos` del servidor FDW `mega_dulces_srv`. Hoy la vista corre
 * como su dueño `postgres`, cuyo user mapping conecta; con `security_invoker`
 * pasaría a correr como `app_runtime`, que tiene fila de user mapping pero la
 * conexión falla:
 *
 *     sin tenant  products_active  ->  ERROR 08001 could not connect to server "mega_dulces_srv"
 *
 * Cambiarla sería canjear un agujero que nadie usa por una vista rota:
 * `public.products_active` tiene **cero consumidores** en el repo (los ~10 hits
 * de `products_active` en el código son de `inventory.products_active`, que es
 * otra relación y no pasa por acá). Se habilita cuando se arregle el user
 * mapping de `app_runtime` para ese servidor, o cuando la vista se retire.
 *
 * Requiere Postgres >= 15 (prod corre 18.6). Aditiva e idempotente; el `down`
 * la revierte con `RESET`.
 *
 * @param { import("knex").Knex } knex
 */

/**
 * Vistas excluidas a propósito, con el motivo al lado. La exclusión es una LISTA
 * y no un `catch` que sigue de largo: si una vista nueva se rompe, tiene que
 * fallar la migración y obligar a decidir, no quedarse afuera en silencio.
 */
const EXCLUIDAS = {
  products_active: 'encadena a la tabla foránea erp.productos_activos (FDW mega_dulces_srv): app_runtime no puede conectar (08001). Cero consumidores en el repo.',
};

/** Enumera las vistas de `public` en vez de listarlas a mano: así no se puede omitir una. */
async function vistasDePublic(knex) {
  const { rows } = await knex.raw(`
    SELECT c.relname,
           (c.reloptions::text[] @> ARRAY['security_invoker=true']) AS ya_esta
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'v'
     ORDER BY c.relname`);
  return rows;
}

exports.up = async function up(knex) {
  const version = (await knex.raw('SHOW server_version_num')).rows[0].server_version_num;
  if (Number(version) < 150000) {
    throw new Error(
      `security_invoker requiere Postgres >= 15 y este servidor es ${version}. Abortando.`,
    );
  }

  const vistas = await vistasDePublic(knex);
  if (!vistas.length) {
    console.log('  No hay vistas en `public` — nada que hacer.');
    return;
  }

  let aplicadas = 0;
  for (const v of vistas) {
    if (EXCLUIDAS[v.relname]) {
      console.log(`  ~ public.${v.relname} EXCLUIDA: ${EXCLUIDAS[v.relname]}`);
      continue;
    }
    if (v.ya_esta) {
      console.log(`  = public.${v.relname} ya tenía security_invoker`);
      aplicadas++;
      continue;
    }
    // El identificador viene de `pg_class`, no de input externo.
    await knex.raw(`ALTER VIEW public."${v.relname}" SET (security_invoker = true)`);
    console.log(`  ✓ public.${v.relname}`);
    aplicadas++;
  }

  // ── Gate de calidad ────────────────────────────────────────────────────────
  // Una vista encadenada (`products_active` se apoya en `products`, no en una
  // tabla) sólo respeta el RLS si TODAS las de la cadena son invoker. Como acá
  // se recorre `public` completo, quedan las dos — pero se verifica, porque el
  // día que alguien agregue una vista nueva encima el olvido es silencioso.
  const faltan = (await vistasDePublic(knex)).filter(
    (v) => !v.ya_esta && !EXCLUIDAS[v.relname],
  );
  if (faltan.length) {
    throw new Error(
      `Quedaron vistas sin security_invoker y sin motivo declarado: ${faltan
        .map((v) => v.relname)
        .join(', ')}. Agregala a EXCLUIDAS con el motivo, o arreglá por qué no toma la opción.`,
    );
  }
  console.log(
    `  ${aplicadas} de ${vistas.length} vistas de public.* evalúan RLS como el invocador ` +
      `(${Object.keys(EXCLUIDAS).length} excluida con motivo).`,
  );
};

exports.down = async function down(knex) {
  for (const v of await vistasDePublic(knex)) {
    if (EXCLUIDAS[v.relname]) continue;
    await knex.raw(`ALTER VIEW public."${v.relname}" RESET (security_invoker)`);
  }
  console.log('  Revertido: las vistas de public.* vuelven a evaluar RLS como su dueño.');
};
