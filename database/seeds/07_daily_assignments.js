/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Inserts seed entries
  await knex("daily_assignments").insert([
  {
    "id": "9539b459-18f1-4aae-bdff-bff897757ee9",
    "user_id": "413e02ec-0691-464c-ad11-d3e5cfe2113f",
    "route_id": "fb02e99c-03b8-4c79-802c-95eef673d695",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:03.406Z",
    "day_of_week": 1
  },
  {
    "id": "f2e20c32-d4e3-4222-8bf6-e03dcbc0c734",
    "user_id": "413e02ec-0691-464c-ad11-d3e5cfe2113f",
    "route_id": "db511e4c-a59f-40f1-8183-8b3108e17591",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:05.205Z",
    "day_of_week": 2
  },
  {
    "id": "2ad14a1e-1105-4cba-8859-bffc6736cf58",
    "user_id": "413e02ec-0691-464c-ad11-d3e5cfe2113f",
    "route_id": "a9accdf9-4568-442d-95c7-643b4f6a4329",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:06.382Z",
    "day_of_week": 3
  },
  {
    "id": "bcf87cf8-c061-473d-ba9e-2ee51fef9a33",
    "user_id": "413e02ec-0691-464c-ad11-d3e5cfe2113f",
    "route_id": "db511e4c-a59f-40f1-8183-8b3108e17591",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:07.850Z",
    "day_of_week": 4
  },
  {
    "id": "b8fbee85-a580-4287-ab2f-4c3784ef5b03",
    "user_id": "413e02ec-0691-464c-ad11-d3e5cfe2113f",
    "route_id": "fb02e99c-03b8-4c79-802c-95eef673d695",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:09.917Z",
    "day_of_week": 5
  },
  {
    "id": "6aa03de8-673f-4595-95be-e2e95c2eb5d3",
    "user_id": "413e02ec-0691-464c-ad11-d3e5cfe2113f",
    "route_id": "db511e4c-a59f-40f1-8183-8b3108e17591",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:11.319Z",
    "day_of_week": 6
  },
  {
    "id": "254bc095-e703-454d-9505-f6e65d2090a5",
    "user_id": "413e02ec-0691-464c-ad11-d3e5cfe2113f",
    "route_id": "db511e4c-a59f-40f1-8183-8b3108e17591",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:14.087Z",
    "day_of_week": 7
  },
  {
    "id": "51550acd-8522-4e1b-ab99-cf8771a3a60c",
    "user_id": "53903fa5-edba-49cf-869a-7e3b75eedd24",
    "route_id": "db511e4c-a59f-40f1-8183-8b3108e17591",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:19.516Z",
    "day_of_week": 1
  },
  {
    "id": "4e793673-e7f8-4d75-9a1e-587951693b05",
    "user_id": "53903fa5-edba-49cf-869a-7e3b75eedd24",
    "route_id": "6b08af36-84ef-4863-8550-362e5606264a",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:20.821Z",
    "day_of_week": 2
  },
  {
    "id": "d39d0959-39c2-4a1c-9f28-6076179be7cc",
    "user_id": "53903fa5-edba-49cf-869a-7e3b75eedd24",
    "route_id": "a9accdf9-4568-442d-95c7-643b4f6a4329",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:21.853Z",
    "day_of_week": 3
  },
  {
    "id": "6f146f09-4ef6-4932-8634-62f54df8cb51",
    "user_id": "53903fa5-edba-49cf-869a-7e3b75eedd24",
    "route_id": "db511e4c-a59f-40f1-8183-8b3108e17591",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:23.314Z",
    "day_of_week": 4
  },
  {
    "id": "e2c2be8e-f2fb-4fef-912f-e7447fa7cf83",
    "user_id": "53903fa5-edba-49cf-869a-7e3b75eedd24",
    "route_id": "ba4cdb36-8894-4c7e-9b56-ea9ddb0c47a8",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:24.831Z",
    "day_of_week": 5
  },
  {
    "id": "4e0d90ca-a442-4981-a8a3-fdbbcd6b64fe",
    "user_id": "53903fa5-edba-49cf-869a-7e3b75eedd24",
    "route_id": "db511e4c-a59f-40f1-8183-8b3108e17591",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:26.266Z",
    "day_of_week": 6
  },
  {
    "id": "b0bc570a-7f28-4455-94e6-b0b195a02ef8",
    "user_id": "53903fa5-edba-49cf-869a-7e3b75eedd24",
    "route_id": "db511e4c-a59f-40f1-8183-8b3108e17591",
    "assigned_by": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "status": "pendiente",
    "created_at": "2026-04-02T21:28:27.773Z",
    "day_of_week": 7
  }
]);
};
