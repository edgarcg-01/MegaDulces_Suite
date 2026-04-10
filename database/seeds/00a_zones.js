/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Inserts seed entries
  await knex("zones").insert([
    {
      "id": "fb136f01-5efe-4c9f-b297-48f06574002c",
      "name": "LA PIEDAD",
      "orden": 1
    },
    {
      "id": "b3e5d1cf-bf7e-419f-9037-b02f070bd2bc",
      "name": "ZAMORA",
      "orden": 2
    },
    {
      "id": "2107b482-7d3a-4c82-9377-c9f2427e699e",
      "name": "MORELIA",
      "orden": 3
    },
    {
      "id": "a5f9532e-a836-455c-9c8c-3df906615a5b",
      "name": "NACIONAL",
      "orden": 4
    },
    {
      "id": "f63125c2-025f-4122-89f0-14f3c80ac0ca",
      "name": "CANINDO",
      "orden": 5
    }
  ]);
};
