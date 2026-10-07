/**
 * HIQ.3b (Fase Horus-IQ) — pHash perceptual de las fotos de exhibición.
 *
 * `fraud_recycled_photo` (H2.4) solo detectaba fotoUrl EXACTA repetida; una foto
 * re-tomada/re-subida se le escapaba. El dHash (difference hash, 64-bit) permite
 * detectar NEAR-duplicados por distancia de Hamming. Se computa durante el scan de
 * visión (la imagen ya está en memoria) con sharp; best-effort (si sharp falla,
 * queda NULL y no se rompe nada).
 *
 * Aditivo sobre commercial.capture_vision. Idempotente (hasColumn).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasColumn('capture_vision', 'phash'))) {
    await knex.schema.withSchema('commercial').alterTable('capture_vision', (t) => {
      t.string('phash', 16); // dHash 64-bit en hex (16 chars). NULL si no se pudo computar.
      t.index(['tenant_id', 'phash'], 'idx_capture_vision_phash');
    });
    await knex.raw(
      `COMMENT ON COLUMN commercial.capture_vision.phash IS 'HIQ.3b dHash perceptual (64-bit hex) para detectar fotos recicladas por near-duplicado (Hamming), no solo URL exacta.'`,
    );
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('capture_vision', 'phash')) {
    await knex.schema.withSchema('commercial').alterTable('capture_vision', (t) => {
      t.dropIndex(['tenant_id', 'phash'], 'idx_capture_vision_phash');
      t.dropColumn('phash');
    });
  }
};
