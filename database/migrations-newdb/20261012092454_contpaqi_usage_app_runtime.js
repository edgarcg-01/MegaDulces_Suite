/**
 * `[CP.8.44]` — ⛔⛔ **El rol de la app nunca tuvo `USAGE` sobre el schema `contpaqi`.** Todo el
 * puente está muerto en producción para quien lo ejecuta, desde el día uno.
 *
 * ── Qué lo delató ───────────────────────────────────────────────────────────────────────────
 *
 * ⭐ **El latido.** `analytics.cron_runs` para `contpaqi_cuadre`, medido el 2026-10-12:
 *
 * ```
 * status: error
 * error : select ... from "contpaqi"."poliza_exports" where ...
 *         - permission denied for schema contpaqi
 * ```
 *
 * Cada 10 minutos, desde que `[CP.8.31]` registró el módulo. *El mecanismo que `[CP.8.10]`
 * construyó para medir ENTREGA funcionó exactamente como se diseñó — y nadie lo leyó.*
 *
 * ── La causa, y por qué tres migraciones no la vieron ────────────────────────────────────────
 *
 * | | qué hizo |
 * |---|---|
 * | `20261008155000` `[CP.8.1]` | creó el schema y dio privilegios **de tabla** a `app_runtime`. **Nunca `USAGE` del schema** |
 * | `20261009101500` `[CP.8.1b]` | notó que faltaba `dev_ro` y le dio `USAGE` + `SELECT`… **sólo a `dev_ro`** |
 * | `20261009122540` `[CP.8.20]` | volvió a dar `USAGE` — **otra vez sólo a `dev_ro`** |
 *
 * ⛔ **Un privilegio de tabla sin `USAGE` del schema no sirve para nada**, y es invisible desde
 * donde se suele mirar: `has_table_privilege('app_runtime', 'contpaqi.poliza_exports', 'SELECT')`
 * devuelve **`true`**. Postgres concede el privilegio sobre el objeto y niega el paso al
 * contenedor. Hay que preguntar las **dos** cosas.
 *
 * ⚠️ Y explica por qué `[CP.8.39]` —que arregló `supplier_aliases` ayer— midió *"1 tabla de 434
 * sin grant"* y la cifra era **cierta y engañosa**: al nivel de tabla faltaba una, al nivel que
 * de verdad manda faltaban **las cuatro**. *Medir la capa equivocada da un número exacto sobre
 * la pregunta equivocada.*
 *
 * ⚠️ Y `[CP.8.1]` §14.4 publica *"Grants | `app_runtime`: SELECT/INSERT/UPDATE/DELETE"* como
 * verificación en prod. Era verdad de tabla y falsa de efecto.
 *
 * ── Por qué los candados no lo vieron ───────────────────────────────────────────────────────
 *
 * Todos leen la base como `edgar`/`dev_ro`, que **sí** tiene `USAGE`. El rol que falla es el que
 * ningún candado usa. Por eso el candado del puente gana una aserción sobre `USAGE`, que es lo
 * que de verdad separa "la tabla existe" de "la app puede tocarla".
 *
 * Aditiva e idempotente. No hay secuencias ni funciones en `contpaqi` (medido), así que `USAGE`
 * del schema + los grants de tabla ya aplicados alcanzan.
 */

const ROL = 'app_runtime';

exports.up = async function up(knex) {
  const existe = await knex.raw('SELECT 1 FROM pg_roles WHERE rolname = ?', [ROL]);
  if (!existe.rows.length) {
    throw new Error(`[CP.8.44] el rol ${ROL} no existe en este destino: no es prod.`);
  }

  await knex.raw(`GRANT USAGE ON SCHEMA contpaqi TO ${ROL}`);
  // Las tablas que ya existen tenían sus grants; se repiten por si alguna entró sin ellos
  // (así entró `supplier_aliases`, ver `[CP.8.39]`).
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA contpaqi TO ${ROL}`);
  // Y las que vengan: que nadie más tenga que acordarse.
  await knex.raw(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA contpaqi
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROL}`);

  /**
   * ⛔ Freno que pregunta las DOS cosas. Preguntar sólo por la tabla es lo que dejó pasar esto
   * tres veces: `has_table_privilege` decía `true` mientras la consulta real moría.
   */
  const { rows } = await knex.raw(`
    SELECT has_schema_privilege('${ROL}', 'contpaqi', 'USAGE') AS usage_schema,
           count(*) FILTER (WHERE NOT has_table_privilege('${ROL}', c.oid, 'SELECT'))::int AS sin_select
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'contpaqi' AND c.relkind = 'r'`);
  const r = rows[0];
  if (!r || !r.usage_schema || r.sin_select !== 0) {
    throw new Error(`[CP.8.44] la defensa no quedó puesta: ${JSON.stringify(r)}`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA contpaqi REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${ROL}`);
  await knex.raw(`REVOKE USAGE ON SCHEMA contpaqi FROM ${ROL}`);
};
