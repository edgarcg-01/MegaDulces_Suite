/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Inserts seed entries
  await knex("catalogs").insert([
  {
    "id": "e920b0b2-d9b4-481a-bf69-8eb9b4b04b51",
    "catalog_id": "roles",
    "value": "Jefe_M",
    "orden": 4,
    "puntuacion": 0,
    "icono": "",
    "parent_id": null
  },
  {
    "id": "8f607ef1-416b-4c9d-9888-da9d264622ac",
    "catalog_id": "niveles",
    "value": "Alto",
    "orden": 1,
    "puntuacion": 1,
    "icono": "",
    "parent_id": null
  },
  {
    "id": "ebade76d-916d-47cb-a14b-f230e3a28ae7",
    "catalog_id": "niveles",
    "value": "Medio",
    "orden": 2,
    "puntuacion": 0,
    "icono": "",
    "parent_id": null
  },
  {
    "id": "ef320f32-eeef-4988-8b54-4a490a7e14c5",
    "catalog_id": "niveles",
    "value": "Crítico",
    "orden": 3,
    "puntuacion": 4,
    "icono": "",
    "parent_id": null
  },
  {
    "id": "8d3bcc13-c008-4f40-bb43-27a81319012a",
    "catalog_id": "conceptos",
    "value": "Exhibidor",
    "orden": 1,
    "puntuacion": 2,
    "icono": "",
    "parent_id": null
  },
  {
    "id": "98e94f6e-a382-47bf-9c75-71e082dbe971",
    "catalog_id": "conceptos",
    "value": "Vitrina",
    "orden": 2,
    "puntuacion": 1,
    "icono": "",
    "parent_id": null
  },
  {
    "id": "a7022833-0c65-4db2-8e82-4dbb196a5771",
    "catalog_id": "conceptos",
    "value": "Vitrolero",
    "orden": 3,
    "puntuacion": 100,
    "icono": null,
    "parent_id": null
  },
  {
    "id": "caa6eb53-8690-420d-9074-dd90cc36bcd3",
    "catalog_id": "conceptos",
    "value": "Paletero",
    "orden": 4,
    "puntuacion": 400,
    "icono": null,
    "parent_id": null
  },
  {
    "id": "eb3812d8-fbc9-4f53-9245-c878a8697a13",
    "catalog_id": "conceptos",
    "value": "Tiras",
    "orden": 5,
    "puntuacion": 100,
    "icono": null,
    "parent_id": null
  },
  {
    "id": "0e83a84a-59bb-4e94-a25a-04b6c0b77d84",
    "catalog_id": "ubicaciones",
    "value": "Caja registradora",
    "orden": 1,
    "puntuacion": 100,
    "icono": null,
    "parent_id": null
  },
  {
    "id": "4b1ec990-a73b-4039-b7fa-381f4d7ed1fa",
    "catalog_id": "ubicaciones",
    "value": "Al frente",
    "orden": 2,
    "puntuacion": 80,
    "icono": null,
    "parent_id": null
  },
  {
    "id": "83bfb372-870e-4be1-8612-ee361703cc03",
    "catalog_id": "ubicaciones",
    "value": "Pasillo principal",
    "orden": 3,
    "puntuacion": 60,
    "icono": null,
    "parent_id": null
  },
  {
    "id": "91637da2-8743-4ac0-9feb-8dac29275b51",
    "catalog_id": "ubicaciones",
    "value": "Lado del refrigerador",
    "orden": 4,
    "puntuacion": 50,
    "icono": null,
    "parent_id": null
  },
  {
    "id": "ecce723f-796c-4b90-9374-f1428166c21d",
    "catalog_id": "ubicaciones",
    "value": "Al fondo",
    "orden": 5,
    "puntuacion": 20,
    "icono": null,
    "parent_id": null
  },
  {
    "id": "6b08af36-84ef-4863-8550-362e5606264a",
    "catalog_id": "rutas",
    "value": "Ruta 01 - Centro",
    "orden": 1,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "fb136f01-5efe-4c9f-b297-48f06574002c"
  },
  {
    "id": "fb02e99c-03b8-4c79-802c-95eef673d695",
    "catalog_id": "rutas",
    "value": "Ruta 02 - Norte",
    "orden": 2,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "fb136f01-5efe-4c9f-b297-48f06574002c"
  },
  {
    "id": "db511e4c-a59f-40f1-8183-8b3108e17591",
    "catalog_id": "rutas",
    "value": "Ruta 03 - Sur",
    "orden": 3,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "fb136f01-5efe-4c9f-b297-48f06574002c"
  },
  {
    "id": "ba4cdb36-8894-4c7e-9b56-ea9ddb0c47a8",
    "catalog_id": "rutas",
    "value": "Ruta 04 - Mercado",
    "orden": 4,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "fb136f01-5efe-4c9f-b297-48f06574002c"
  },
  {
    "id": "a9accdf9-4568-442d-95c7-643b4f6a4329",
    "catalog_id": "rutas",
    "value": "Ruta 05 - Periférico",
    "orden": 5,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "fb136f01-5efe-4c9f-b297-48f06574002c"
  },
  {
    "id": "5873d945-592e-422c-b376-9e1d832a3514",
    "catalog_id": "rutas",
    "value": "Ruta 11 - Juarez",
    "orden": 1,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "b3e5d1cf-bf7e-419f-9037-b02f070bd2bc"
  },
  {
    "id": "9d055fde-93dc-41d6-8b0c-3190c17de42b",
    "catalog_id": "rutas",
    "value": "Ruta 12 - Minsa",
    "orden": 2,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "b3e5d1cf-bf7e-419f-9037-b02f070bd2bc"
  },
  {
    "id": "5b500ce6-2c03-4968-94bb-c121f51ea5dd",
    "catalog_id": "rutas",
    "value": "Ruta 13 - Jacona",
    "orden": 3,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "b3e5d1cf-bf7e-419f-9037-b02f070bd2bc"
  },
  {
    "id": "89ec0319-a085-4c48-bce3-b03cff3b23c9",
    "catalog_id": "rutas",
    "value": "Ruta 14 - Centro",
    "orden": 4,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "b3e5d1cf-bf7e-419f-9037-b02f070bd2bc"
  },
  {
    "id": "c51faa33-868a-428d-bd49-4d32087be6e1",
    "catalog_id": "rutas",
    "value": "Ruta 15 - Valle",
    "orden": 5,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "b3e5d1cf-bf7e-419f-9037-b02f070bd2bc"
  },
  {
    "id": "fc8b799e-d093-4d58-a864-03a2c6bd10d0",
    "catalog_id": "rutas",
    "value": "Ruta 21 - Camelinas",
    "orden": 1,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "2107b482-7d3a-4c82-9377-c9f2427e699e"
  },
  {
    "id": "81b7c788-4bbe-4cfb-ab47-02a1d5d7cb28",
    "catalog_id": "rutas",
    "value": "Ruta 22 - Centro Hist",
    "orden": 2,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "2107b482-7d3a-4c82-9377-c9f2427e699e"
  },
  {
    "id": "8cd739ba-47fd-4e0a-857b-d86698270cf9",
    "catalog_id": "rutas",
    "value": "Ruta 23 - Tres Marias",
    "orden": 3,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "2107b482-7d3a-4c82-9377-c9f2427e699e"
  },
  {
    "id": "a3f03773-e92c-4e9c-a792-f49280c5c3c1",
    "catalog_id": "rutas",
    "value": "Ruta 24 - Salida Quiroga",
    "orden": 4,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "2107b482-7d3a-4c82-9377-c9f2427e699e"
  },
  {
    "id": "14905d26-4de3-4c1c-97ff-692488c07048",
    "catalog_id": "rutas",
    "value": "Ruta 25 - Mil Cumbres",
    "orden": 5,
    "puntuacion": 0,
    "icono": null,
    "parent_id": "2107b482-7d3a-4c82-9377-c9f2427e699e"
  },
  {
    "id": "eb4fdefd-d8ac-433d-97cf-9a5c63a538a4",
    "catalog_id": "roles",
    "value": "superadmin",
    "orden": 1,
    "puntuacion": 0,
    "icono": null,
    "parent_id": null
  },
  {
    "id": "dab548b5-179b-4152-9cf1-7c679fc5a1d3",
    "catalog_id": "roles",
    "value": "supervisor_v",
    "orden": 2,
    "puntuacion": 0,
    "icono": null,
    "parent_id": null
  },
  {
    "id": "d71e9c77-8ca3-4e24-b100-9368cf403b5e",
    "catalog_id": "roles",
    "value": "colaborador",
    "orden": 3,
    "puntuacion": 0,
    "icono": null,
    "parent_id": null
  }
]);
};
