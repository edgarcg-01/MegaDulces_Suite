/**
 * SM.36 — Reparte `STORE_ARQUEO_RUTA_CAPTURAR`.
 *
 * El permiso nace con el modulo y hay que repartirlo en la MISMA entrega: un
 * modulo nuevo no esta entregado hasta que su clave esta en `role_permissions`,
 * no solo declarada en el enum. Sin esto, la pantalla existe en prod y no la
 * abre nadie salvo `superadmin`/`admin` por `ALL_PERMS` (la lecccion de LC.6.2,
 * que costo que el Libro de Compras viviera dias inalcanzable).
 *
 * ── A quien, y por que NO se calca al hermano
 *
 * Aca el criterio NO se deriva del permiso vecino: el pedido fue explicito
 * —"solo las encargadas de tienda y auxiliares de encargadas"— y calcar
 * `STORE_ARQUEO_CAPTURAR` seria desobedecerlo. Medido en prod el 2026-09-20, esa
 * clave la tienen **5 roles**: `auxiliar_tienda`, `cajero`, `encargado_tienda`,
 * `piso_tienda` y `superadmin`. Recibir el efectivo que entrega un vendedor de
 * ruta es acto de encargada, no de mostrador, asi que `cajero` y `piso_tienda`
 * quedan FUERA a proposito.
 *
 * Por eso la lista es literal y corta: `encargado_tienda` (5 personas activas) y
 * `auxiliar_tienda` (3). Si manana hay que sumar a alguien, se hace desde
 * `/admin/roles`, que es donde vive esa decision.
 *
 * ⚠️ NO se toca `STORE_ARQUEO_VER`: ver los arqueos ya lo tiene quien debe, y
 * este permiso es de CAPTURA. El listado de rutas se acota ademas por la
 * sucursal del usuario, o sea que tener la clave no alcanza para ver las rutas
 * de otra tienda.
 *
 * Idempotente y no destructivo: `permissions -> 'KEY' IS NULL` — **NO** el
 * operador `?` de JSONB, que knex no escapa bien. Solo agrega donde la clave
 * falta, asi que si alguien ya la puso en `false` a mano no se le pisa.
 *
 * Alcance por `role_name` sin filtrar `tenant_id`, igual que el resto de los
 * backfills de permisos: es un cambio del catalogo de roles.
 *
 * Despues de aplicarla, las 8 personas tienen que **volver a entrar**: los
 * permisos viajan dentro del JWT y el token ya emitido no los trae.
 *
 * @param { import("knex").Knex } knex
 */
const ROLES = ['encargado_tienda', 'auxiliar_tienda'];

exports.up = async function up(knex) {
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"STORE_ARQUEO_RUTA_CAPTURAR": true}'::jsonb
      WHERE role_name = ANY(?)
        AND role_name NOT LIKE 'retirado%'
        AND permissions -> 'STORE_ARQUEO_RUTA_CAPTURAR' IS NULL`,
    [ROLES],
  );

  /**
   * Prueba de que el reparto sirvio de algo. Un UPDATE que toca 0 filas es
   * exactamente lo que se ve cuando el rol se llama distinto de lo que este
   * archivo supone — y se leeria igual que "ya estaba puesto". Se DECLARA.
   */
  const { rows } = await knex.raw(
    `SELECT role_name FROM role_permissions
      WHERE role_name = ANY(?) AND permissions -> 'STORE_ARQUEO_RUTA_CAPTURAR' = 'true'::jsonb
      ORDER BY role_name`,
    [ROLES],
  );
  const conPermiso = rows.map((r) => r.role_name);
  const faltan = ROLES.filter((r) => !conPermiso.includes(r));

  console.log(
    `[grant_arqueo_ruta_encargadas] ${res.rowCount ?? 0} fila(s) actualizada(s) · `
    + `con el permiso: [${conPermiso.join(', ') || 'NINGUNO'}]`
    + (faltan.length ? ` · ⚠️ SIN el permiso (rol inexistente o puesto en false a mano): [${faltan.join(', ')}]` : '')
    + '. Las personas afectadas deben volver a entrar (el JWT trae los permisos).',
  );
};

/**
 * No-op, igual que el resto de los backfills de permisos del repo: revocarlo
 * dejaria a las encargadas sin poder recibir el efectivo de las rutas, y un
 * rollback de esquema no deberia apagar una pantalla en uso. Para quitarlo, se
 * hace desde `/admin/roles`.
 */
exports.down = async function down() {
  console.log('[grant_arqueo_ruta_encargadas] down: no-op');
};
