/**
 * TC.5a (ADR-026) — Feedback loop de Thot Chat. Agrega 👍/👎 y `promoted` a la
 * bitácora para cosechar buenos intercambios como ejemplos verificados (TC.4a).
 * Aditiva, idempotente (guarda hasTable + hasColumn).
 *
 * @param { import("knex").Knex } knex
 */
/**
 * ⚠️ [VP.5.3] CUERPO CORREGIDO — el original tenía un `async` en el callback de `alterTable`.
 *
 * El schema builder de knex es **síncrono**: un callback `async` devuelve una promesa en su primer
 * `await` —antes de llamar a ningún `t.columna()`— así que knex armaba el `ALTER TABLE` **vacío** y,
 * cuando los `await` resolvían, `t.smallint()` corría sobre una transacción ya cerrada.
 *
 * En prod eso fue un **no-op silencioso**: la migración quedó registrada como aplicada sin agregar
 * nada, el chat de Thot tronó al leer una columna inexistente, y tardó **tres semanas** en notarse
 * — hasta `20260724150000_thot_chat_log_feedback_fix.js`, que agregó las columnas con el patrón
 * correcto y dejó escrito el diagnóstico.
 *
 * Lo que nadie arregló fue ESTE archivo, y por eso la cadena de migraciones **no se podía
 * reproducir desde cero**: sobre Node 24 el mismo defecto ya no falla en silencio, revienta con
 * `Transaction query already complete` y frena todo en la migración 187 de 642. Se encontró al
 * levantar el sustrato de CI (VP.5.3).
 *
 * Corregirlo es seguro y no reescribe historia: en toda base existente ya está en el ledger y no se
 * vuelve a correr; en una base nueva ahora sí agrega las columnas, y el hotfix posterior es
 * idempotente, así que no choca. El patrón correcto —`hasColumn` AFUERA, callback SÍNCRONO— es el
 * que ese hotfix estableció.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const esquema = () => knex.schema.withSchema('commercial');
  if (!(await esquema().hasTable('thot_chat_log'))) return;

  if (!(await esquema().hasColumn('thot_chat_log', 'feedback'))) {
    await esquema().alterTable('thot_chat_log', (t) => {
      t.smallint('feedback').notNullable().defaultTo(0); // 1 = pulgar arriba, -1 = abajo, 0 = sin voto
    });
  }
  if (!(await esquema().hasColumn('thot_chat_log', 'promoted'))) {
    await esquema().alterTable('thot_chat_log', (t) => {
      t.boolean('promoted').notNullable().defaultTo(false); // ya se volvió ejemplo dorado
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('thot_chat_log'))) return;
  await knex.schema.withSchema('commercial').alterTable('thot_chat_log', (t) => {
    t.dropColumn('feedback');
    t.dropColumn('promoted');
  });
};
