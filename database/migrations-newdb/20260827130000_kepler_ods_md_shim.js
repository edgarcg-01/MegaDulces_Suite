/**
 * CDC.8 — esquema `md` de vistas sobre `kepler_ods`: el shim que permite repointear los importers
 * al ODS **sin tocarles el SQL**.
 *
 * EL PROBLEMA. 18 de los 55 pasos del nightly abren una conexión POR SUCURSAL a los réplicas
 * locales (`:5433/kepler_md_XX`) y consultan `md.kdm1`, `md.kdm2`, `md.kdud`… con el esquema `md`
 * hardcodeado. Todo eso ya está en prod, en `kepler_ods`, que el CDC WAL mantiene al momento — pero
 * repointearlos significaría reescribir el SQL de cada uno (y el de `import-stock-movements`, el
 * único ya repointeado, son 60 líneas de decode).
 *
 * LA IDEA. `kepler_ods.<t>` contiene la copia de CADA rama con una columna `sucursal` que dice de
 * quién es. Entonces `WHERE sucursal = X` **reconstruye la DB de la sucursal X tal cual**, incluidas
 * las réplicas cruzadas que los importers ya filtran con su propio `c1=$1`. Con una vista por tabla
 * filtrada por la sucursal de la SESIÓN, un importer sólo cambia "abrir una conexión por sucursal"
 * por "setear un GUC por sucursal": su SQL queda **byte-idéntico**.
 *
 *   -- antes:  conexión a :5433/kepler_md_03   +   SELECT … FROM md.kdm1 WHERE c1='03'
 *   -- ahora:  SET app.kepler_sucursal='03'    +   SELECT … FROM md.kdm1 WHERE c1='03'   (mismo SQL)
 *
 * VERIFICADO ANTES DE ESCRIBIRLO (2026-08-27, prod vs réplicas LAN): de 14 tablas comparadas, 10
 * dan Δ=0 EXACTO (`kduv`, `kdil`, `kdik`, `kdig`, `kdpv_folio_caja`, `doctype`, `kdc22607`, `kdb1`…).
 * Las otras 4 tenían residuo de DELETEs y duplicados por el corrimiento de timestamps: se
 * reconciliaron (CDC.7/7b) y hoy el dry-run dice "sin residuo".
 *
 * FILTRO SARGABLE, no `btrim`. La columna `sucursal` está impecable —0 filas con espacios, largo
 * exacto 2, 7 valores— y el índice de la PK **arranca con `sucursal`**, así que la igualdad plana usa
 * el índice. Con `btrim(sucursal)` cada query haría scan completo.
 *
 * FALLA CERRADA A PROPÓSITO. Si nadie seteó el GUC, `current_setting('app.kepler_sucursal', true)`
 * devuelve NULL y `sucursal = NULL` da **0 filas**. Es el modo de falla correcto: un consumidor que
 * se olvide de fijar la sucursal recibe nada, no las 7 copias sumadas (que es justo el doble conteo
 * que el `c1=$1` de los importers existe para evitar).
 *
 * `md.refresh_shim()` recrea las vistas y devuelve cuántas. Existe porque el ODS gana tablas solo:
 * cada mes aparece un `kdc2YYMM` nuevo, y sin refresh los feeds contables repointeados se quedarían
 * sin vista. Los importers la llaman al arrancar (es idempotente y barata).
 *
 * Reversible (`down` tira el esquema). Idempotente.
 * @param { import("knex").Knex } knex
 */

const FN = `
CREATE OR REPLACE FUNCTION md.refresh_shim(force boolean DEFAULT false) RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE t record; n integer := 0;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'kepler_ods' AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'sucursal'
                      AND a.attnum > 0 AND NOT a.attisdropped)
       -- Por default sólo crea las que FALTAN: así llamarla en cada corrida de un importer cuesta
       -- ~0 (una query al catálogo) en vez de 225 DDL con lock. El parámetro force recrea todo.
       AND (force OR to_regclass('md.' || quote_ident(c.relname)) IS NULL)
     ORDER BY c.relname
  LOOP
    -- DROP+CREATE en vez de CREATE OR REPLACE: si a una tabla del ODS le aparece una columna,
    -- el REPLACE falla con 42P16 ("cannot change name/type of view column"). Una vista no
    -- guarda datos y la migración corre en transacción, así que no hay ventana visible.
    EXECUTE format('DROP VIEW IF EXISTS md.%I', t.relname);
    EXECUTE format(
      'CREATE VIEW md.%I AS SELECT * FROM kepler_ods.%I WHERE sucursal = current_setting(%L, true)',
      t.relname, t.relname, 'app.kepler_sucursal');
    EXECUTE format('GRANT SELECT ON md.%I TO app_runtime', t.relname);
    n := n + 1;
  END LOOP;
  RETURN n;
END $fn$;`;

exports.up = async function (knex) {
  // Sin ODS no hay nada que espejar (DB nueva / orden de migraciones).
  const ods = await knex.raw(`SELECT 1 FROM pg_namespace WHERE nspname='kepler_ods'`);
  if (!ods.rows.length) return;

  await knex.raw(`CREATE SCHEMA IF NOT EXISTS md`);
  await knex.raw(`COMMENT ON SCHEMA md IS
    'Shim de lectura: una vista por tabla de kepler_ods, filtrada por sucursal = current_setting(''app.kepler_sucursal''). Reproduce la DB de una sucursal Kepler para que los importers puedan leer del ODS sin cambiar su SQL. Sin el GUC seteado devuelve 0 filas (falla cerrada). Refrescar con SELECT md.refresh_shim() cuando el ODS gane tablas (ej. el kdc2YYMM de cada mes).'`);
  await knex.raw(FN);
  const r = await knex.raw(`SELECT md.refresh_shim(true) AS n`);
  await knex.raw(`GRANT USAGE ON SCHEMA md TO app_runtime`);
  await knex.raw(`GRANT EXECUTE ON FUNCTION md.refresh_shim(boolean) TO app_runtime`);
  // eslint-disable-next-line no-console
  console.log(`  [CDC.8] esquema md: ${r.rows[0].n} vistas sobre kepler_ods`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP SCHEMA IF EXISTS md CASCADE`);
};
