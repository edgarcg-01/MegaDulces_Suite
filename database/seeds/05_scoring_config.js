/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Check if scoring_config already exists
  const existing = await knex("scoring_config").select("id").first();
  if (existing) {
    console.log("[05_scoring_config] Scoring config already exists, skipping seed.");
    return;
  }

  // Inserts seed entries
  await knex("scoring_config").insert([
  {
    "id": "91528fd9-463d-4121-990a-53cdcb5b9cdf",
    "config": "{\"factores_tipo\":{\"tira\":1,\"vitrina\":1.5,\"exhibidor\":2,\"refrigerador\":1.8},\"pesos_posicion\":{\"caja\":100,\"detras\":10,\"anaquel\":25,\"vitrina\":60,\"adyacente\":70,\"exhibidor\":50,\"refrigerador\":40},\"niveles_ejecucion\":{\"alto\":1,\"bajo\":0.4,\"medio\":0.7}}",
    "updated_at": "2026-04-02T15:52:21.186Z"
  }
  ]);
  console.log("[05_scoring_config] Inserted scoring config.");
};
