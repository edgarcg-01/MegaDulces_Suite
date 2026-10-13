/**
 * `[CP.8.39]` — `contpaqi.supplier_aliases` nació SIN RLS y SIN grant. Las dos cosas.
 *
 * La creó `20261010104218` (`[CP.8.36]`, prod batch 878) con `tenant_id NOT NULL` y **ninguna**
 * de las dos defensas que sus tres tablas hermanas sí tienen. Medido en prod el 2026-10-12:
 *
 * ```
 * account_rules      rls=t  forzado=t  politicas=1   app_runtime: SELECT/INSERT/UPDATE/DELETE
 * poliza_exports     rls=t  forzado=t  politicas=1   app_runtime: SELECT/INSERT/UPDATE/DELETE
 * supplier_accounts  rls=t  forzado=t  politicas=1   app_runtime: SELECT/INSERT/UPDATE/DELETE
 * supplier_aliases   rls=f  forzado=f  politicas=0   app_runtime: NADA   <-- ésta
 * ```
 *
 * ⛔ **El grant es el que rompe funcionalidad, no el RLS.** `[CP.8.37]` puso una pantalla que
 * escribe en esta tabla y `ContpaqiArmadoService` la lee en cada armado. Sin `GRANT`, conectando
 * como `app_runtime` (7 conexiones vivas en prod), la lectura tira `42501 permission denied` — y
 * el `try/catch` del servicio la confunde con *"la tabla no existe en este destino"* y **degrada
 * en silencio al padrón sin alias**. O sea: la mitad de `[CP.8.36]` y toda `[CP.8.37]` no
 * funcionarían, y el log diría un motivo falso. (El `catch` se parte en el mismo commit.)
 *
 * ⚠️ **Y una lección de medición:** el primer sondeo usó `information_schema.role_table_grants`,
 * que **filtra por el privilegio de quien lee** — desde `edgar` devolvía "ningún grant" para las
 * CUATRO tablas, lo que habría convertido un defecto real en un falso positivo de cuatro. Lo
 * correcto es `has_table_privilege(rol, tabla, priv)`, que no filtra. Es la misma trampa que
 * `[CP.8.1]` §14.3 ya había pagado con `information_schema.tables`.
 *
 * ⚠️ Esta migración **no edita** la 878 (ya aplicada): editarla no la volvería a correr y dejaría
 * el archivo diciendo algo que esa corrida no hizo. Misma regla que `20261009101500`.
 *
 * ⛔ Lo que esta migración NO arregla y se declara: en este prod la API corre mayormente como
 * `postgres` (superusuario), y un superusuario **salta el RLS**. O sea que la política que se
 * crea acá es defensa en profundidad para el día que eso cambie, no un candado efectivo hoy.
 * Ese hueco es de plataforma y tiene su propio dueño.
 *
 * Aditiva e idempotente: se puede correr dos veces.
 */

const TABLA = 'contpaqi.supplier_aliases';
const POLITICA = 'tenant_isolation';

exports.up = async function up(knex) {
  const { rows: existe } = await knex.raw(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'contpaqi' AND table_name = 'supplier_aliases'`);
  if (!existe[0] || existe[0].n !== 1) {
    throw new Error(
      '[CP.8.39] `contpaqi.supplier_aliases` no existe en este destino: falta aplicar 20261010104218 primero.');
  }

  await knex.raw(`ALTER TABLE ${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${POLITICA} ON ${TABLA}`);
  await knex.raw(`
    CREATE POLICY ${POLITICA} ON ${TABLA}
      USING (tenant_id = current_tenant_id())
      WITH CHECK (tenant_id = current_tenant_id())`);

  // El mismo juego que la tabla hermana `supplier_accounts`: el servicio lee, y `[CP.8.37]` escribe.
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLA} TO app_runtime`);
  // `dev_ro` ya lo traía por el ALTER DEFAULT PRIVILEGES de `20261009101500`; explícito igual,
  // porque heredar un privilegio no es lo mismo que declararlo.
  await knex.raw(`GRANT SELECT ON ${TABLA} TO dev_ro`);

  /**
   * ⛔ Freno de verdad, no de forma: se comprueba el estado FINAL con los catálogos que no
   * filtran por privilegio. Una migración que termina en verde sin haber dejado la defensa
   * puesta es exactamente lo que produjo este arreglo.
   */
  const { rows } = await knex.raw(`
    SELECT c.relrowsecurity AS rls,
           c.relforcerowsecurity AS forzado,
           (SELECT count(*)::int FROM pg_policies p
             WHERE p.schemaname = 'contpaqi' AND p.tablename = 'supplier_aliases') AS politicas,
           has_table_privilege('app_runtime', '${TABLA}', 'SELECT') AS ar_select,
           has_table_privilege('app_runtime', '${TABLA}', 'INSERT') AS ar_insert,
           has_table_privilege('app_runtime', '${TABLA}', 'UPDATE') AS ar_update,
           has_table_privilege('dev_ro',      '${TABLA}', 'SELECT') AS dev_select
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'contpaqi' AND c.relname = 'supplier_aliases'`);
  const r = rows[0];
  if (!r || !r.rls || !r.forzado || r.politicas !== 1
      || !r.ar_select || !r.ar_insert || !r.ar_update || !r.dev_select) {
    throw new Error(
      `[CP.8.39] la defensa no quedó puesta: ${JSON.stringify(r)}`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP POLICY IF EXISTS ${POLITICA} ON ${TABLA}`);
  await knex.raw(`ALTER TABLE ${TABLA} NO FORCE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${TABLA} DISABLE ROW LEVEL SECURITY`);
  await knex.raw(`REVOKE ALL ON ${TABLA} FROM app_runtime`);
};
