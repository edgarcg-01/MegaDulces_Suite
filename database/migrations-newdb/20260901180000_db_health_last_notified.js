/**
 * DBH.3 — `last_notified_at` en `analytics.db_health_alerts`.
 *
 * Es lo único que hace posible el recordatorio sin spamear. El scanner corre cada 5 minutos: sin
 * esta columna, "avisar mientras siga abierta" sería un correo cada 5 min (288 al día por alerta),
 * y "avisar sólo al abrir" sería un correo único que se pierde — exactamente lo que ya pasó con el
 * toast por WebSocket, que se emite sólo en la transición y dejó `wincaja_branch_stale` **20 días
 * en critical sin que nadie se enterara**.
 *
 * Con la marca, la política es: un correo al abrir (o al escalar warn→critical), y después uno cada
 * 24 h mientras la alerta siga abierta. NULL = todavía no se avisó.
 *
 * Aditiva e idempotente (`hasColumn`). No toca datos existentes ni el CHECK de `status`.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.withSchema('analytics').hasTable('db_health_alerts');
  if (!hasTable) return; // entorno sin la tabla (pre-deploy): la crea su propia migración

  const has = await knex.schema.withSchema('analytics').hasColumn('db_health_alerts', 'last_notified_at');
  if (!has) {
    await knex.schema.withSchema('analytics').alterTable('db_health_alerts', (t) => {
      t.timestamp('last_notified_at', { useTz: true });
    });
    await knex.raw(`COMMENT ON COLUMN analytics.db_health_alerts.last_notified_at IS
      'DBH.3 — ultimo aviso por correo enviado por esta alerta. NULL = nunca se aviso. Gobierna el recordatorio de 24h del scanner.'`);
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.withSchema('analytics').hasTable('db_health_alerts');
  if (!hasTable) return;
  const has = await knex.schema.withSchema('analytics').hasColumn('db_health_alerts', 'last_notified_at');
  if (has) {
    await knex.schema.withSchema('analytics').alterTable('db_health_alerts', (t) => {
      t.dropColumn('last_notified_at');
    });
  }
};
