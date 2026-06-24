/**
 * Re-backfill ROUTE_TICKET_CAPTURE para `vendedor` (+ superadmin/admin).
 *
 * Síntoma en prod (2026-06-23): el vendedor recibe **403** en
 * `POST /commercial/route-tickets/procesar` (cierre de ruta), aunque
 * `CAPTURE_TICKET_USE` (captura de exhibición) sí funciona. El mapping en
 * `ability.factory` está completo (permissionToSubject + permissionToAction +
 * AppSubject), así que el 403 viene de que el rol `vendedor` de prod tiene la key
 * `ROUTE_TICKET_CAPTURE` AUSENTE o en `false` en su `role_permissions.permissions`.
 *
 * El backfill previo `20260608150000` solo tocaba keys `IS NULL`; aquí FORZAMOS
 * `true` para `vendedor` — es su feature central, nunca debe estar en false. Esto
 * cubre tanto el caso "ausente" como "false". `superadmin`/`admin` igual (manage:all,
 * redundante pero consistente). NO toca `colaborador` (false a propósito).
 *
 * Sin filtro de tenant → corre como postgres (bypassa RLS) y arregla la fila de
 * `vendedor` de TODOS los tenants (también cubre el caso de fila de tenant distinto).
 *
 * ⚠️ Requiere **re-login del vendedor** tras aplicar: el permiso se evalúa contra
 * `role_permissions`, pero la permsCache / el JWT pueden estar tibios — re-login
 * fuerza el refresh.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const patch = JSON.stringify({ ROUTE_TICKET_CAPTURE: true });
  const result = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)`,
    { patch, roles: ['superadmin', 'admin', 'vendedor'] },
  );
  console.log(
    `[rebackfill_route_ticket_capture] ROUTE_TICKET_CAPTURE=true forzado en ${result.rowCount ?? 0} fila(s) de role_permissions.`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // No-op: quitarlo rompería el cierre de ruta del vendedor.
  console.log('[rebackfill_route_ticket_capture] down: no-op');
};
