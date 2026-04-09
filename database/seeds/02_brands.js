/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Inserts seed entries
  await knex("brands").insert([
  {
    "id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "LA ROSA",
    "activo": true,
    "orden": 1
  },
  {
    "id": "cd9023fa-5ba9-45da-aa1c-d42a495e9191",
    "nombre": "HERSHEY",
    "activo": true,
    "orden": 2
  },
  {
    "id": "48120e2d-4533-4c5c-92a2-379e416cf6d4",
    "nombre": "ARCOR",
    "activo": true,
    "orden": 3
  },
  {
    "id": "d54096c4-ecaf-4505-b510-3f04cbea2c71",
    "nombre": "WINIS",
    "activo": true,
    "orden": 4
  },
  {
    "id": "aba43d16-6652-4f08-8766-d9138daff311",
    "nombre": "CANELS",
    "activo": true,
    "orden": 5
  },
  {
    "id": "5895c198-d28e-488a-b235-dc792e460dce",
    "nombre": "MONTES",
    "activo": true,
    "orden": 6
  },
  {
    "id": "c728fb5a-adf9-472d-9fef-9ae05d73f6af",
    "nombre": "AP",
    "activo": true,
    "orden": 7
  },
  {
    "id": "a7f45120-07fa-4c88-9f6c-88ea8e618a24",
    "nombre": "DELICIATE",
    "activo": true,
    "orden": 8
  },
  {
    "id": "4bd2dc1c-503e-4388-a3fd-767211384193",
    "nombre": "BOLSAS DE LOS ALTOS",
    "activo": true,
    "orden": 9
  },
  {
    "id": "1b7b4167-a81c-483b-9989-30a0b0f9b6e8",
    "nombre": "LAS DELICIAS",
    "activo": true,
    "orden": 10
  },
  {
    "id": "7caec435-7469-4596-985a-5ab15bb8a788",
    "nombre": "INTERCANDY",
    "activo": true,
    "orden": 11
  },
  {
    "id": "ef741ae4-ff0f-43ac-875f-c630025c24d1",
    "nombre": "KALU",
    "activo": true,
    "orden": 12
  },
  {
    "id": "dd77f71c-d4ac-4666-9937-f3171d62501b",
    "nombre": "FRUTI FRESK",
    "activo": true,
    "orden": 13
  }
]);
};
