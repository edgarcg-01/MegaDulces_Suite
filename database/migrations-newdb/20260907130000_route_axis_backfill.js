'use strict';
/**
 * `[IDG.9.5]` — El eje ruta queda poblado, con la forma que la realidad tiene.
 *
 * Viene de la investigación de `[IDG.9]` (2026-09-07), que invalidó la premisa
 * del plan original ("poblar `users.route_id` y girar `route` a `own`"):
 * **persona→ruta NO es una función**. En `trade.daily_assignments` vigentes hay
 * 20 personas con 1 ruta, 5 con 2, 1 con 4 y 1 con 5 (hasta 6 en las capturas de
 * 90d). Una sola columna UUID no puede representar eso.
 *
 * Lo que esta migración hace, por POBLACIÓN y no global:
 *
 *   A. **Single-ruta → `users.route_id`.** Backfill de las 15 personas activas
 *      que trabajan exactamente UNA ruta y tienen la columna en NULL. El valor
 *      sale de `daily_assignments`, que es la fuente operativa (el stock del
 *      vendedor ya sale de ahí, no de `users.route_id`).
 *
 *   B. **Multi-ruta de campo → `user_scopes.route = listed`.** Los 4 que de
 *      verdad cubren varias rutas (`maria_rocha` 4 · `victor_zalapa`,
 *      `rvmad01`, `rvmad02` 2 cada uno) reciben la LISTA. `identity.user_scopes`
 *      ya soportaba `mode='listed'` con `values[]` desde `[ID.1]`, así que no
 *      hace falta tabla nueva. No entran acá `superoot` (god-mode: su alcance es
 *      `all` de todos modos) ni los 2 `supervisor_ventas` (supervisan equipos de
 *      14 y 6 personas: su eje es el equipo, no la ruta).
 *
 * ── Lo que esta migración NO hace, y por qué ─────────────────────────────────
 *
 *   · **NO gira `role_scopes.route` de `all` a `own`.** Ya existe un gate que lo
 *     prohíbe —`database/tests/test-newdb-scope-axis.js` §7— mientras haya gente
 *     de eje ruta sin ruta asignada, y después de este backfill siguen quedando
 *     los 8 `promotor_ruta` que **nunca entraron** (`last_login_at IS NULL`): no
 *     tienen asignaciones porque nunca trabajaron. Eso se resuelve dándolos de
 *     baja, no inventándoles una ruta. Además hoy el giro sería inerte: **nadie
 *     consume la dimensión `route`** del `ScopeService` (verificado; los 3 hits
 *     de `'route'` en logistics son `applyFleetFilter`, tipo de vehículo).
 *
 *   · **NO toca los 37 overrides `warehouse = all`.** Es OTRA dimensión, y la
 *     dependencia que el plan afirmaba ("con el eje ruta cerrado se pueden
 *     recortar") era falsa: `warehouse` tiene **6 consumidores vivos** y
 *     **ninguno de los 37 tiene `warehouse_code`**, así que quitarles el
 *     override los manda a `warehouse: own` sin valor = `WHERE false` = no ven
 *     nada. Recortarlos exige antes decidir qué sucursal les toca.
 *
 *   · **NO resuelve la contradicción de `rvph01`**: su ficha dice la ruta cuyo
 *     nombre coincide con su username (`RVPH01`) y su asignación dice `RUTA 21`.
 *     El repo ya documenta la dualidad `ruta_NN` vs `01NN` en Piedad/PH
 *     (`reference_ph_routes_ruta_nn_vs_01nn`), así que pisar el dato a favor de
 *     una de las dos formas sería adivinar. Se reporta y se deja.
 *
 * Aditiva: nadie pierde acceso. `values` van en la llave canónica de la
 * dimensión (`trade.catalogs.id::text`, ver `scope.types.ts`). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** Roles cuyo eje NO es la ruta aunque tengan asignaciones. */
const EJE_NO_RUTA = ['superadmin', 'admin', 'supervisor_ventas', 'supervisor'];

exports.up = async function up(knex) {
  const { rows: tenants } = await knex.raw(
    'SELECT id, slug FROM identity.tenants WHERE activo IS NOT FALSE',
  );

  for (const t of tenants) {
    // ── A. Single-ruta → users.route_id ──────────────────────────────────────
    // Sólo donde la columna está en NULL: si ya tiene un valor y contradice a la
    // asignación, se deja y se reporta. Pisar un dato puesto a mano es
    // exactamente el error que `feedback_declare_missing...` describe.
    const a = await knex.raw(
      `WITH una AS (
         SELECT d.user_id, (array_agg(DISTINCT d.route_id))[1] AS rid
           FROM trade.daily_assignments d
          WHERE d.tenant_id = ? AND d.deleted_at IS NULL AND d.route_id IS NOT NULL
          GROUP BY d.user_id
         HAVING count(DISTINCT d.route_id) = 1)
       UPDATE identity.users u
          SET route_id = una.rid, updated_at = now()
         FROM una
        WHERE u.id = una.user_id AND u.tenant_id = ?
          AND u.activo AND u.deleted_at IS NULL
          AND u.route_id IS NULL
          -- La ruta tiene que existir en el catalogo de rutas: la FK apunta a
          -- trade.catalogs entera, que tambien tiene zonas, giros, etc.
          -- (sin acentos graves aca dentro: cortan el template literal)
          AND EXISTS (SELECT 1 FROM trade.catalogs cat
                       WHERE cat.tenant_id = ? AND cat.id = una.rid
                         AND cat.catalog_id = 'rutas' AND cat.deleted_at IS NULL)`,
      [t.id, t.id, t.id],
    );
    if (a.rowCount) console.log(`  ✓ ${t.slug}: route_id poblado en ${a.rowCount} persona(s) de una sola ruta.`);

    // ── B. Multi-ruta de campo → user_scopes.route = listed ─────────────────
    const { rows: multi } = await knex.raw(
      `SELECT d.user_id, u.username,
              array_agg(DISTINCT d.route_id::text) AS rutas
         FROM trade.daily_assignments d
         JOIN identity.users u ON u.id = d.user_id AND u.tenant_id = d.tenant_id
        WHERE d.tenant_id = ? AND d.deleted_at IS NULL AND d.route_id IS NOT NULL
          AND u.activo AND u.deleted_at IS NULL
          AND lower(u.role_name) <> ALL (?)
          AND EXISTS (SELECT 1 FROM trade.catalogs cat
                       WHERE cat.tenant_id = d.tenant_id AND cat.id = d.route_id
                         AND cat.catalog_id = 'rutas' AND cat.deleted_at IS NULL)
        GROUP BY d.user_id, u.username
       HAVING count(DISTINCT d.route_id) > 1`,
      [t.id, EJE_NO_RUTA],
    );

    for (const m of multi) {
      await knex.raw(
        `INSERT INTO identity.user_scopes (tenant_id, user_id, dimension, mode, values, nota)
         VALUES (?, ?, 'route', 'listed', ?, ?)
         ON CONFLICT (tenant_id, user_id, dimension)
         DO UPDATE SET mode = 'listed', values = EXCLUDED.values, nota = EXCLUDED.nota, updated_at = now()`,
        [
          t.id,
          m.user_id,
          m.rutas,
          `[IDG.9.5] Cubre ${m.rutas.length} rutas: una sola columna route_id no puede representarlo. Derivado de daily_assignments vigentes.`,
        ],
      );
      console.log(`  ✓ ${t.slug}: ${m.username} → route listed (${m.rutas.length} rutas).`);
    }

    // ── Reporte: la contradicción que NO se toca ─────────────────────────────
    const { rows: contra } = await knex.raw(
      `WITH una AS (
         SELECT d.user_id, (array_agg(DISTINCT d.route_id))[1] AS rid
           FROM trade.daily_assignments d
          WHERE d.tenant_id = ? AND d.deleted_at IS NULL AND d.route_id IS NOT NULL
          GROUP BY d.user_id HAVING count(DISTINCT d.route_id) = 1)
       SELECT u.username, ficha.value AS en_ficha, asig.value AS en_asignacion
         FROM una
         JOIN identity.users u ON u.id = una.user_id AND u.tenant_id = ? AND u.activo
         LEFT JOIN trade.catalogs ficha ON ficha.tenant_id = ? AND ficha.id = u.route_id
         LEFT JOIN trade.catalogs asig  ON asig.tenant_id  = ? AND asig.id  = una.rid
        WHERE u.route_id IS NOT NULL AND u.route_id <> una.rid`,
      [t.id, t.id, t.id, t.id],
    );
    for (const x of contra) {
      console.log(
        `  ! ${x.username}: la ficha dice "${x.en_ficha}" y la asignación "${x.en_asignacion}". ` +
          'Sin tocar — requiere decidir cuál manda.',
      );
    }
  }

  // ── Cierre: cuánto falta para poder girar route a `own` ───────────────────
  //
  // ⚠️ Se mide por ROL, no por `positions.scope_axis`. La primera versión de
  // este cierre filtraba `p.scope_axis = 'ruta'` y devolvía **0 pendientes** —
  // un verde falso: `scope_axis` resuelve a 'ruta' en **cero** usuarios activos
  // (116 de 120 tienen un puesto sin eje declarado y 48 no tienen puesto). El
  // conteo salía 0 por vacuidad, no porque el eje estuviera resuelto, y el
  // mensaje habría dicho "ya se puede girar".
  const { rows: gate } = await knex.raw(
    `SELECT count(*)::int AS pendientes
       FROM identity.users u
      WHERE u.activo AND u.deleted_at IS NULL
        AND lower(u.role_name) IN ('promotor_ruta', 'vendedor_ruta')
        AND u.route_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM identity.user_scopes us
                         WHERE us.tenant_id = u.tenant_id AND us.user_id = u.id
                           AND us.dimension = 'route' AND us.mode IN ('listed', 'all'))`,
  );
  const { rows: cob } = await knex.raw(
    `SELECT count(*)::int AS activos,
            count(*) FILTER (WHERE p.scope_axis IS NULL)::int AS puesto_sin_eje
       FROM identity.users u
       LEFT JOIN identity.positions p ON p.tenant_id = u.tenant_id AND p.code = u.position_code
      WHERE u.activo AND u.deleted_at IS NULL`,
  );
  console.log(
    `  Gate de route:own (test-newdb-scope-axis §7): quedan ${gate[0].pendientes} persona(s) ` +
      'con rol de ruta y sin ruta. NO se gira todavía.',
  );
  console.log(
    `  NO MEDIDO por eje declarado: ${cob[0].puesto_sin_eje} de ${cob[0].activos} activos tienen ` +
      'un puesto sin `scope_axis`, así que cualquier conteo filtrado por ese campo sale 0 por vacuidad.',
  );
};

exports.down = async function down(knex) {
  await knex.raw(`DELETE FROM identity.user_scopes WHERE dimension = 'route' AND nota LIKE '[IDG.9.5]%'`);
  console.log(
    '  Overrides de `route` retirados. `users.route_id` NO se limpia: el dato es correcto ' +
      'y borrarlo perdería información que ya estaba en daily_assignments.',
  );
};
