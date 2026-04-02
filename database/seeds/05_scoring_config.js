exports.seed = async function(knex) {
  // 1. Limpieza de configuración de puntos
  await knex("scoring_config").del();

  // 2. Definición base de puntuaciones
  const config = [
    { key: "FOTO_ÉXITO", value: 100, description: "Puntos por cada fotografía clara de exhibición", group: "GENERAL" },
    { key: "VISITA_PUNTUAL", value: 50, description: "Puntos por iniciar visita en horario", group: "GENERAL" },
    { key: "PROYECTO_ACTIVO", value: 500, description: "Puntos base por participación en el proyecto", group: "BONUS" },
  ];

  for (const item of config) {
    await knex("scoring_config").insert(item);
  }
};
