'use strict';
/**
 * `[CP.8.30]` — **La bandera para emitir los renglones `AD` del libro de compras.**
 *
 * ── Qué hace el `AD` y por qué NO alcanza con lo que ya hay ──────────────────────────────────
 * `[LC.15]` ya mete el UUID en el **concepto** del renglón `M1`, y eso sirve para una cosa:
 * **leerlo de vuelta** (la 4ª puerta anti-duplicado). ⛔ Lo que NO hace es asociar: la asociación
 * vive en `AsocCFDIs` del lado de ContPAQi, y el único registro del formato que la crea es `AD`.
 *
 * Por eso son **dos banderas y no una**. `incluye_uuid` ya existe y viene en **`true`** por
 * omisión; colgar el `AD` de ella lo prendería **en todas las corridas de golpe**, que es
 * exactamente el riesgo que esta fase viene evitando desde `[CP.8.29]`.
 *
 * ── ⛔ Por qué nace en `false` ───────────────────────────────────────────────────────────────
 * El TXT del libro de compras **es la póliza real del mes** ($30–56M, 460–848 renglones). Si
 * ContPAQi rechazara el archivo por un registro que nadie verificó, no se pierde la asociación:
 * se pierde **el mes entero**. Y a hoy nadie ha importado un solo archivo
 * (`contpaqi.poliza_exports` = 0 filas, medido 2026-10-10).
 *
 * Con la bandera apagada el archivo sale **idéntico al byte** — es el invariante que `[CP.8.29]`
 * dejó probado y que el candado de LC sostiene.
 *
 * ── Lo que vale, medido (y corregido) ───────────────────────────────────────────────────────
 * ⛔ Dos cifras que circulaban eran falsas: *«~4,200 asociaciones al mes»* contaba **todos** los
 * CFDIs asociados del mes —incluidos los que ContPAQi asocia solo al capturarlos— y el *«~1,400»*
 * de `FASE_CP8` §22.3 no trae derivación.
 *
 * Lo medido sobre `finance.v_purchase_book_uuids` (2026-01 → 2026-07): el libro transporta
 * **~263 comprobantes al mes** (1,838 en 7 meses). Ésos son los que un `AD` puede asociar, y
 * ningún otro. Aparte está el atraso del complemento: **1,772 comprobantes de 2026**.
 *
 * Aditiva e idempotente. No toca ninguna fila existente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const hay = await knex.schema.withSchema('finance').hasColumn('purchase_book_runs', 'asocia_cfdi');
  if (!hay) {
    await knex.schema.withSchema('finance').alterTable('purchase_book_runs', (t) => {
      t.boolean('asocia_cfdi').notNullable().defaultTo(false);
    });
  }

  await knex.raw(`
    COMMENT ON COLUMN finance.purchase_book_runs.asocia_cfdi IS
    '[CP.8.30] Emitir renglones AD (uno por UUID) para que ContPAQi ASOCIE el comprobante al importar. '
    'Distinta de incluye_uuid, que sólo escribe el UUID en el concepto del renglón para poder leerlo de vuelta. '
    'Nace en false: el TXT del libro es la póliza real del mes y el registro AD no se ha verificado '
    'contra un import real (contpaqi.poliza_exports = 0 al 2026-10-10).'`);

  /**
   * ⛔ Freno de identidad. Una migración que no encuentra su tabla **no falla** — termina en
   * verde y deja el código nuevo leyendo una columna que no existe. Ya pasó en esta fase.
   */
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'finance' AND table_name = 'purchase_book_runs'
        AND column_name = 'asocia_cfdi' AND data_type = 'boolean'
        AND column_default = 'false'`);
  if (!rows[0] || rows[0].n !== 1) {
    throw new Error(
      '[CP.8.30] `finance.purchase_book_runs.asocia_cfdi` no quedó como boolean NOT NULL DEFAULT false: '
      + 'el código que la lee daría `undefined`, que es falsy y se vería como "apagada" sin serlo.',
    );
  }
};

exports.down = async function down(knex) {
  const hay = await knex.schema.withSchema('finance').hasColumn('purchase_book_runs', 'asocia_cfdi');
  if (hay) {
    await knex.schema.withSchema('finance').alterTable('purchase_book_runs', (t) => {
      t.dropColumn('asocia_cfdi');
    });
  }
};
