'use strict';
/**
 * `[IDG.9.8]` — Un día de cobertura NO es la ruta de alguien.
 *
 * Corrige el backfill de `[IDG.9.5]`. Esa migración tomó como ruta de la persona
 * la única ruta que aparecía en sus asignaciones vigentes. La regla es correcta
 * para 17 de 19 casos —gente con 2 a 6 días asignados y hasta 129 capturas en
 * esa misma ruta— pero es **demasiado laxa** en el borde: una sola fila de
 * asignación, de un solo día, sin ninguna captura, también contaba como "una
 * sola ruta".
 *
 * Lo destapó el caso `rvph01`, que Edgar resolvió a favor de la ficha: su
 * asignación a `RUTA 21` era **una fila de un solo día** (14-jul) con **una
 * captura** ese mismo día. Una cobertura puntual, no su ruta. Su columna ya
 * tenía valor así que el backfill no lo tocó, pero la misma forma sí afectó a
 * dos personas cuya columna estaba en NULL:
 *
 *   · `juan_lopez` → `RUTA 22`: 1 día, 0 capturas. Y `enrique_fuentes` tiene esa
 *     misma ruta con 6 días y **65 capturas** — o sea RUTA 22 es de Enrique y
 *     Juan la cubrió una vez.
 *   · `ramon_rodriguez` → `502`: 1 día, 0 capturas. Es `superadmin`, así que su
 *     alcance es `all` de todos modos y el valor era cosmético.
 *
 * Dejarlos escritos es lo que `feedback_declare_missing_never_disguise_default`
 * describe: un valor que **parece** dato y es una coincidencia. Se revierten a
 * NULL, que es la verdad («no sabemos su ruta»), y vuelven a contar como
 * pendientes del gate de `route: own` — que es donde deben contar.
 *
 * ── El umbral ────────────────────────────────────────────────────────────────
 * Se borra el `route_id` cuando la evidencia es **≤1 día de asignación Y 0
 * capturas** en esa ruta. Con 2+ días, o con al menos una captura, se conserva:
 * `benjamin_alonso` tiene 1 sola fila pero 1 captura en su ruta, y eso ya es
 * ejecución, no plan.
 *
 * NO inventa el valor correcto para nadie: sólo retira el que no se sostiene.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const { rows: debiles } = await knex.raw(`
    WITH ev AS (
      SELECT u.tenant_id, u.id, u.username, u.role_name,
             (SELECT cat.value FROM trade.catalogs cat
               WHERE cat.tenant_id = u.tenant_id AND cat.id = u.route_id) AS ruta,
             (SELECT count(DISTINCT d.day_of_week) FROM trade.daily_assignments d
               WHERE d.tenant_id = u.tenant_id AND d.user_id = u.id
                 AND d.route_id = u.route_id AND d.deleted_at IS NULL) AS dias,
             (SELECT count(*) FROM trade.daily_captures dc
               WHERE dc.tenant_id = u.tenant_id AND dc.user_id = u.id
                 AND dc.route_id = u.route_id) AS capturas
        FROM identity.users u
       WHERE u.route_id IS NOT NULL AND u.activo AND u.deleted_at IS NULL)
    SELECT * FROM ev
      WHERE dias <= 1 AND capturas = 0
        -- EXCEPCIÓN confirmada por Edgar: cuando el nombre de la ruta ES el
        -- username, la ficha manda aunque no haya ni una asignación. Es el caso
        -- de rvph01 (ruta RVPH01) y rvph02 (ruta RVPH02): son promotoras
        -- pendientes de capacitación, así que NO tienen asignaciones ni capturas
        -- todavía — y eso no vuelve falso su dato. Sin esta excepción este
        -- umbral les borraba el route_id que Edgar acababa de validar.
        AND upper(replace(ruta, ' ', '')) <> upper(username)
      ORDER BY username`);

  if (!debiles.length) {
    console.log('  Ningún route_id se sostiene sólo en un día de cobertura — nada que corregir.');
    return;
  }

  for (const d of debiles) {
    console.log(
      `  ~ ${d.username} (${d.role_name}): route_id "${d.ruta}" con ${d.dias} día(s) y ` +
        `${d.capturas} captura(s) → se retira. Un día de cobertura no es su ruta.`,
    );
  }

  const upd = await knex.raw(
    `UPDATE identity.users SET route_id = NULL, updated_at = now() WHERE id = ANY(?)`,
    [debiles.map((d) => d.id)],
  );
  console.log(`  ✓ ${upd.rowCount} route_id retirado(s).`);

  // Gate: que no quede ninguno apoyado en evidencia de un solo día.
  const { rows: resto } = await knex.raw(`
    SELECT count(*)::int AS n FROM identity.users u
     WHERE u.route_id IS NOT NULL AND u.activo AND u.deleted_at IS NULL
       AND (SELECT count(DISTINCT d.day_of_week) FROM trade.daily_assignments d
             WHERE d.tenant_id = u.tenant_id AND d.user_id = u.id
               AND d.route_id = u.route_id AND d.deleted_at IS NULL) <= 1
       AND (SELECT count(*) FROM trade.daily_captures dc
             WHERE dc.tenant_id = u.tenant_id AND dc.user_id = u.id
               AND dc.route_id = u.route_id) = 0
       -- Misma excepción que arriba, o este gate tumba la migración por los dos
       -- casos que Edgar validó (ruta cuyo nombre es el username).
       AND upper(replace((SELECT cat.value FROM trade.catalogs cat
                           WHERE cat.tenant_id = u.tenant_id AND cat.id = u.route_id), ' ', ''))
           <> upper(u.username)`);
  if (resto[0].n > 0) throw new Error(`Quedan ${resto[0].n} route_id con evidencia de un solo día.`);

  const { rows: est } = await knex.raw(`
    SELECT count(*)::int AS con_ruta,
           count(*) FILTER (
             WHERE upper(replace((SELECT cat.value FROM trade.catalogs cat
                                   WHERE cat.tenant_id = u.tenant_id AND cat.id = u.route_id), ' ', ''))
                   = upper(u.username))::int AS por_convencion
      FROM identity.users u
     WHERE u.route_id IS NOT NULL AND u.activo AND u.deleted_at IS NULL`);
  console.log(
    `  Quedan ${est[0].con_ruta} persona(s) con route_id: ` +
      `${est[0].con_ruta - est[0].por_convencion} con evidencia operativa (2+ días o capturas) y ` +
      `${est[0].por_convencion} por la convención nombre-de-ruta = username, que aún no trabajaron.`,
  );
};

exports.down = async function down() {
  console.log(
    '  down() no repone los valores: eran coincidencias de un día. Reponerlos es volver a ' +
      'disfrazar una cobertura puntual como la ruta de la persona.',
  );
};
