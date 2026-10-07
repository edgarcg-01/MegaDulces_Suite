/**
 * `[SV.2]` — El supervisor de ventas puede ver la venta de SUS rutas.
 *
 * ── Lo que se midió antes de escribir esto (prod, 2026-10-06) ───────────────────────────
 * `COMMERCIAL_ROUTE_SALES_VER` gatea `/comercial/ventas-por-ruta`, que ya existe y responde en
 * 7 ms. Lo tienen hoy:
 *
 *   superadmin (8) · telemarketing (4) · compras (2) · compras_operaciones (2) ·
 *   credito_cobranza (2) · direccion (2) · marketing (2) · finanzas (1) ·
 *   jefe_marketing (1) · **repartidor (1)**
 *
 * ⭐ Y **no** lo tiene `supervisor_ventas` — las 5 cuentas (4 personas) que responden por esas
 * rutas. Un repartidor puede ver la venta por ruta y el supervisor de ventas no. No falta la
 * pantalla: falta que la pueda abrir quien responde por el número. Mismo patrón que `[VEC.0]`.
 *
 * ⛔ **El patrón `-> 'KEY' IS NULL` acá sería un NO-OP.** La clave ya existe en
 * `supervisor_ventas` con el valor **`false` explícito** — residuo de guardar el mapa completo
 * desde `/admin/roles`, que deja en `false` toda clave nueva del enum. Es exactamente la causa
 * de `[LC.6.2]` y `[IC.23]`. Por eso el UPDATE busca "no está en true", no "no está la clave".
 *
 * ── Qué NO hace esta migración, a propósito ─────────────────────────────────────────────
 * No toca `identity.role_scopes`. El eje `route` está en `all` para **43 de 49 roles** con la
 * nota "[ID.3] default materializado del comportamiento vigente": nunca fue una decisión, fue
 * la única opción antes de que existiera `users.route_id`. Cambiarlo acá movería el alcance de
 * 43 roles de un plumazo. El recorte a "mis rutas" se hace por DERIVACIÓN desde el organigrama
 * (`supervisorRouteCodesSql`), que es dato vivo y no una lista que se desincroniza.
 *
 * No toca `supervisor` (la otra cuenta, 1 persona, `claudia_mata`): tiene **0 reportes**, así
 * que la pantalla le saldría vacía y un permiso que abre una pantalla vacía es ruido. Queda
 * declarado, no repartido.
 */
exports.up = async function (knex) {
  const CLAVE = 'COMMERCIAL_ROUTE_SALES_VER';
  const ROL = 'supervisor_ventas';

  // Pre-vuelo: el estado vivo, para que el log diga qué se encontró y no sólo qué se hizo.
  const { rows: antes } = await knex.raw(
    `SELECT role_name,
            coalesce((permissions ->> ?)::bool::text, '(clave ausente)') AS valor
       FROM identity.role_permissions
      WHERE role_name = ?`,
    [CLAVE, ROL],
  );
  if (!antes.length) {
    console.log(`  [SV.2] el rol ${ROL} no tiene fila en role_permissions — nada que hacer`);
    return;
  }
  console.log(`  [SV.2] antes · ${ROL}: ${CLAVE} = ${antes[0].valor}`);

  const { rowCount } = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = jsonb_set(permissions, ARRAY[?::text], 'true'::jsonb, true),
            updated_at  = now()
      WHERE role_name = ?
        AND coalesce((permissions ->> ?)::bool, false) IS NOT TRUE`,
    [CLAVE, ROL, CLAVE],
  );
  console.log(`  [SV.2] filas tocadas: ${rowCount}`);

  // ── Candado 1: tocó exactamente al rol previsto y a nadie más ───────────────────────
  const { rows: ahora } = await knex.raw(
    `SELECT count(*)::int AS roles
       FROM identity.role_permissions
      WHERE (permissions ->> ?)::bool IS TRUE`,
    [CLAVE],
  );
  console.log(`  [SV.2] roles con ${CLAVE}: ${ahora[0].roles}`);

  const { rows: ok } = await knex.raw(
    `SELECT (permissions ->> ?)::bool AS v FROM identity.role_permissions WHERE role_name = ?`,
    [CLAVE, ROL],
  );
  if (ok[0]?.v !== true) {
    throw new Error(`[SV.2] ${ROL} sigue sin ${CLAVE} después del UPDATE`);
  }

  // ── Candado 2: PRUEBA NEGATIVA ──────────────────────────────────────────────────────
  // Que el UPDATE no haya tocado otra clave del mismo JSONB. `jsonb_set` es quirúrgico, pero
  // una compuerta sin prueba negativa es una intención: se comprueba que una clave vecina
  // conocida sigue valiendo lo mismo que antes.
  const { rows: vecina } = await knex.raw(
    `SELECT (permissions ->> 'REPORTES_VER_EQUIPO')::bool AS v
       FROM identity.role_permissions WHERE role_name = ?`,
    [ROL],
  );
  if (vecina[0]?.v !== true) {
    throw new Error(
      '[SV.2] REPORTES_VER_EQUIPO dejó de ser true en ' + ROL + ': el jsonb_set tocó de más',
    );
  }
  console.log('  [SV.2] prueba negativa OK — la clave vecina REPORTES_VER_EQUIPO sigue en true');

  // ── Declarado, no repartido ─────────────────────────────────────────────────────────
  const { rows: huerfanos } = await knex.raw(
    `SELECT s.username, count(u.id)::int AS reportes
       FROM identity.users s
       LEFT JOIN identity.users u ON u.supervisor_id = s.id AND u.deleted_at IS NULL
      WHERE s.deleted_at IS NULL AND s.role_name = ?
      GROUP BY 1 HAVING count(u.id) = 0`,
    [ROL],
  );
  if (huerfanos.length) {
    console.log(
      `  [SV.2] ◻ DECLARADO — ${huerfanos.length} cuenta(s) de ${ROL} sin equipo: ` +
        huerfanos.map((h) => h.username).join(', ') +
        '. La pantalla les va a salir vacía hasta que se les declare el equipo.',
    );
  }
  console.log('  [SV.2] ⚠️ los permisos viajan en el JWT: hace falta re-login.');
};

/**
 * Revierte SÓLO lo que esta migración puede probar que puso: la clave vuelve a `false` en
 * `supervisor_ventas`, no se borra. Borrarla la dejaría "ausente", que es un estado distinto
 * del que había antes (`false` explícito) y rompería el diagnóstico de la próxima sesión.
 */
exports.down = async function (knex) {
  const { rowCount } = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = jsonb_set(permissions, ARRAY['COMMERCIAL_ROUTE_SALES_VER'], 'false'::jsonb, true),
            updated_at  = now()
      WHERE role_name = 'supervisor_ventas'`,
  );
  console.log(`  [SV.2] down: ${rowCount} fila(s) de vuelta a false`);
};
