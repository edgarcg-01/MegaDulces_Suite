'use strict';
/**
 * `[AZ.2]` — **Tres oficios distintos salen de `USUARIOS_GESTIONAR`.**
 *
 * ── Qué estaba mal ──────────────────────────────────────────────────────────
 * El permiso para **administrar personas** abría además:
 *
 *   · `/admin/db-health` + el tablero de carriles (`/cron`) → infraestructura;
 *   · `/admin/areas-gasto` → el catálogo de áreas de gasto de **Finanzas**;
 *   · `/admin/promotores` → qué promotor revisa qué marcas (**Comercial**).
 *
 * Tres oficios, tres riesgos y un solo permiso. Quien da de alta gente no
 * necesariamente tiene por qué ver el estado del motor de la base, y al revés:
 * para mirar la salud de la plataforma había que poder editar el padrón entero.
 *
 * ── Y no se podían separar aunque se quisiera ───────────────────────────────
 * Las tres pantallas existían en las rutas y en el menú pero **no en
 * `AUTHZ_TREE`**, así que en `/admin/roles` no había casilla que marcar. Un
 * permiso propio sin fila en el árbol es un permiso que nadie puede conceder.
 * Esta entrega arregla las dos mitades.
 *
 * ── Nadie pierde acceso ─────────────────────────────────────────────────────
 * Las tres claves se reparten **ancladas a `USUARIOS_GESTIONAR` leído del
 * estado VIVO**, no a una lista de roles escrita a mano. Quien hoy entra, sigue
 * entrando; lo que cambia es que de ahora en más se pueden dar por separado —
 * y, sobre todo, **quitar** por separado.
 *
 * ⚠️ Un permiso declarado en el enum NO le da acceso a nadie (`[LC.6.2]`). Por
 * eso el reparto va acá y por eso se imprime a quién le llegó.
 *
 * ⛔ Gotcha de `/admin/roles`: esa pantalla guarda el JSONB **completo**, así que
 * una clave nueva aterriza en `false` en cualquier rol que alguien salve después
 * de declararla. El backfill usa `-> 'KEY' IS NULL` (= «nunca se tocó») y
 * respeta ese `false` a propósito. Los que quedan afuera **se nombran**.
 *
 * `permissions -> 'KEY' IS NULL` y NO el operador `?` de JSONB: knex no lo
 * escapa bien.
 *
 * Aditiva e idempotente. Después: **re-login** (el frontend gatea con el JWT).
 *
 * @param { import("knex").Knex } knex
 */
const ANCLA = 'USUARIOS_GESTIONAR';
const CLAVES = [
  ['PLATFORM_HEALTH_VER', 'salud de la plataforma + carriles'],
  ['FINANCE_EXPENSE_AREAS_GESTIONAR', 'áreas de gasto (Finanzas)'],
  ['COMMERCIAL_PROMOTERS_GESTIONAR', 'promotores de marca (Comercial)'],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  const { rows: conAncla } = await knex.raw(
    `SELECT role_name FROM role_permissions
      WHERE permissions -> ? = 'true'::jsonb AND deleted_at IS NULL
      ORDER BY role_name`,
    [ANCLA],
  );
  const nombresAncla = conAncla.map((r) => r.role_name);
  console.log(`  · [AZ.2] roles con ${ANCLA} hoy: ${nombresAncla.length}` +
    (nombresAncla.length ? ` — ${nombresAncla.join(', ')}` : ''));

  for (const [KEY, que] of CLAVES) {
    const bf = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object(?, COALESCE((permissions->>?)::boolean, false))
        WHERE permissions -> ? IS NULL`,
      [KEY, ANCLA, KEY],
    );
    const { rows: conNuevo } = await knex.raw(
      `SELECT role_name FROM role_permissions
        WHERE permissions -> ? = 'true'::jsonb AND deleted_at IS NULL
        ORDER BY role_name`,
      [KEY],
    );
    const llegaron = new Set(conNuevo.map((r) => r.role_name));
    const fuera = nombresAncla.filter((r) => !llegaron.has(r));

    console.log(
      `  ✓ [AZ.2] ${KEY} (${que}): ${bf.rowCount ?? 0} fila(s) tocadas · ` +
        `${conNuevo.length} rol(es) lo tienen` +
        (conNuevo.length ? ` — ${conNuevo.map((r) => r.role_name).join(', ')}` : ''),
    );
    if (fuera.length) {
      console.log(
        `  ! [AZ.2] ${fuera.length} rol(es) con ${ANCLA} NO recibieron ${KEY} porque la clave ya ` +
          `estaba en false (guardado masivo de /admin/roles, no una decisión): ${fuera.join(', ')}.`,
      );
    }

    // Gate por clave: un permiso nuevo con cero dueños es una pantalla que nadie
    // puede abrir — el defecto que `[LC.6.2]` pagó con un módulo invisible un día entero.
    if (!conNuevo.length && nombresAncla.length) {
      throw new Error(
        `[AZ.2] ${nombresAncla.length} rol(es) tienen ${ANCLA} y NINGUNO quedó con ${KEY}: ` +
          'el reparto no surtió efecto.',
      );
    }
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  for (const [KEY] of CLAVES) {
    await knex.raw(
      `UPDATE role_permissions SET permissions = permissions - ? WHERE permissions -> ? IS NOT NULL`,
      [KEY, KEY],
    );
  }
  console.log('  ✓ [AZ.2] down: las 3 claves removidas (todo vuelve a colgar de USUARIOS_GESTIONAR).');
};
