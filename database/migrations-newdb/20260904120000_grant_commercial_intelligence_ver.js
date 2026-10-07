/**
 * `[AUTHZ-HARD.1]` Reparte `COMMERCIAL_INTELLIGENCE_VER` — separa la superficie INTERNA de
 * inteligencia comercial de las claves que tiene el cliente B2B.
 *
 * **Por qué.** Los tableros internos de Thot (hallazgos / diagnósticos / acciones / autonomía /
 * señales agregadas) colgaban de `COMMERCIAL_ORDERS_VER` y `COMMERCIAL_CUSTOMERS_VER` — dos claves
 * que el rol `customer_b2b` tiene (las usa para su portal). Resultado: un cliente autenticado leía
 * el back-office de la operación (findings de margen, impacto $ de acciones, el kill-switch de
 * autonomía). Se movieron esas rutas a una clave propia, `COMMERCIAL_INTELLIGENCE_VER`, que el
 * cliente NO recibe.
 *
 * **A quién.** Para NO quitarle el tablero a ningún interno que hoy lo ve, se otorga la clave nueva
 * a todo rol que ya tenía cualquiera de los dos gates viejos — que es exactamente quien podía verlo
 * hasta ahora — **excepto `customer_b2b`** (el cliente) y los `retirado_*` (roles de baja). El
 * criterio no se inventa: se lee del estado vivo de los permisos. Así el cambio es neutro para el
 * interno y sólo cierra al cliente.
 *
 * A `customer_b2b` se le deja la clave en `false` EXPLÍCITO: declara la decisión (no ve inteligencia
 * interna) en vez de dejarla ausente.
 *
 * Alcance por `role_name` sin filtrar `tenant_id`: es un cambio del catálogo de roles (el seed
 * define los mismos roles por tenant), como los demás backfills de permisos.
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` (NO el operador `?`, que knex no escapa bien). Sólo
 * agrega donde falta; a quien ya lo tenga no se le pisa.
 *
 * Tras aplicarla, los afectados deben **volver a entrar**: los permisos viajan en el JWT.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const grant = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"COMMERCIAL_INTELLIGENCE_VER": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND role_name <> 'customer_b2b'
        AND permissions -> 'COMMERCIAL_INTELLIGENCE_VER' IS NULL
        AND (permissions -> 'COMMERCIAL_ORDERS_VER' = 'true'::jsonb
          OR permissions -> 'COMMERCIAL_CUSTOMERS_VER' = 'true'::jsonb)`,
  );

  // El cliente: decisión explícita en false (no ausente).
  const deny = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"COMMERCIAL_INTELLIGENCE_VER": false}'::jsonb
      WHERE role_name = 'customer_b2b'
        AND permissions -> 'COMMERCIAL_INTELLIGENCE_VER' IS NULL`,
  );

  console.log(
    `[grant_commercial_intelligence_ver] concedido a ${grant.rowCount ?? 0} rol(es) internos · `
      + `customer_b2b en false → ${deny.rowCount ?? 0}. Los afectados deben volver a entrar (JWT).`,
  );
};

/**
 * Reversa: quita la clave de todos los roles (vuelve al estado ausente).
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'COMMERCIAL_INTELLIGENCE_VER'`);
};
