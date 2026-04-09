/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Inserts seed entries
  await knex("users").insert([
  {
    "id": "f1fccc8b-976b-48df-9184-39cda22f229c",
    "username": "superoot",
    "password_hash": "$2b$10$R0pQyz8YP4WQvvsFsQEneeLyOCZvIhE88OBQg261LPHqCJENpg.ma",
    "nombre": null,
    "zona": "NACIONAL",
    "role_name": "superadmin",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.689Z",
    "supervisor_id": null
  },
  {
    "id": "413e02ec-0691-464c-ad11-d3e5cfe2113f",
    "username": "joaquin_hurtado",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "JOAQUIN HURTADO OROZCO",
    "zona": "LA PIEDAD",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.692Z",
    "supervisor_id": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37"
  },
  {
    "id": "53903fa5-edba-49cf-869a-7e3b75eedd24",
    "username": "victorino_urbano",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "VICTORINO URBANO OLIVARES",
    "zona": "LA PIEDAD",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.692Z",
    "supervisor_id": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37"
  },
  {
    "id": "ebf94b7d-06f1-4e4c-82f0-7ae14cae3d59",
    "username": "mariano_martinez",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "MARIANO MARTINEZ PATLAN",
    "zona": "LA PIEDAD",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.693Z",
    "supervisor_id": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37"
  },
  {
    "id": "42d13dd6-ca03-4c94-80f2-00d0043d83d4",
    "username": "victor_garcia",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "VICTOR HUGO GARCIA HURTADO",
    "zona": "LA PIEDAD",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.693Z",
    "supervisor_id": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37"
  },
  {
    "id": "a48104a5-d4e6-4fb9-8eb4-661a93f51ff2",
    "username": "victor_mata",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "VICTOR ALFONSO MATA VILLA",
    "zona": "LA PIEDAD",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.694Z",
    "supervisor_id": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37"
  },
  {
    "id": "64400165-08be-4487-9ec2-2801006ad410",
    "username": "jose_garcia",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "JOSE DE JESUS GARCIA TORRES",
    "zona": "LA PIEDAD",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.694Z",
    "supervisor_id": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37"
  },
  {
    "id": "f6848024-67cb-4c30-b1a8-2c3d779605d8",
    "username": "maria_valadez",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "MARIA ELENA VALADEZ LIMON",
    "zona": "LA PIEDAD",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.694Z",
    "supervisor_id": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37"
  },
  {
    "id": "d024eba5-e837-42b4-8316-744b15bb2378",
    "username": "maria_rocha",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "MARIA TERESA ROCHA FUENTES",
    "zona": "LA PIEDAD",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.695Z",
    "supervisor_id": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37"
  },
  {
    "id": "8d4b7938-b6e9-424b-b37a-07648cae5107",
    "username": "victor_zalapa",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "VICTOR MANUEL ZALAPA BARRIGA",
    "zona": "ZAMORA",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.695Z",
    "supervisor_id": "f5ca24b4-4c08-473e-8991-c8a5377a26ed"
  },
  {
    "id": "ba21e96b-0f8d-4188-a298-1b43fcabfc8c",
    "username": "daniel_rojano",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "DANIEL ROJAÑO PADILLA",
    "zona": "ZAMORA",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.696Z",
    "supervisor_id": "f5ca24b4-4c08-473e-8991-c8a5377a26ed"
  },
  {
    "id": "155e4b4a-8501-4389-8199-cb3df6dc1956",
    "username": "jose_munoz",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "JOSE LUIS MUÑOZ MOTA",
    "zona": "ZAMORA",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.696Z",
    "supervisor_id": "f5ca24b4-4c08-473e-8991-c8a5377a26ed"
  },
  {
    "id": "b1606c48-91d1-4cbb-a417-dcf1794e0097",
    "username": "jose_zavala",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "JOSE DE JESUS ZAVALA VILLALOBOS",
    "zona": "ZAMORA",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.696Z",
    "supervisor_id": "f5ca24b4-4c08-473e-8991-c8a5377a26ed"
  },
  {
    "id": "f8d8e20f-09a1-4a49-aa7f-bc058425de4a",
    "username": "cesar_plascencia",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "CESAR RICARDO PLASCENCIA RAZO",
    "zona": "MORELIA",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.697Z",
    "supervisor_id": "504b1d53-a6ee-4eaf-a0ef-15b4ae9a2deb"
  },
  {
    "id": "f53c560a-0a90-4b5d-bab1-167d0d6d5b55",
    "username": "guillermo_hernandez",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "GUILLERMO HERNANDEZ ALMANZA",
    "zona": "MORELIA",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.697Z",
    "supervisor_id": "504b1d53-a6ee-4eaf-a0ef-15b4ae9a2deb"
  },
  {
    "id": "eec2e856-f5ff-41f9-8ed0-56f00bf12203",
    "username": "enrique_herrera",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "ENRIQUE HERRERA SANCHEZ",
    "zona": "MORELIA",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.697Z",
    "supervisor_id": "504b1d53-a6ee-4eaf-a0ef-15b4ae9a2deb"
  },
  {
    "id": "bc27798d-1cc9-426b-bb51-87707efe221a",
    "username": "joseph_guerrero",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "JOSEPH AGUSTIN GUERRERO PEREZ",
    "zona": "MORELIA",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.698Z",
    "supervisor_id": "504b1d53-a6ee-4eaf-a0ef-15b4ae9a2deb"
  },
  {
    "id": "9c02c60a-be89-4313-9a9a-f863bd8849c1",
    "username": "eduardo_miranda",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "EDUARDO MIRANDA ROMERO",
    "zona": "MORELIA",
    "role_name": "colaborador",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.698Z",
    "supervisor_id": "504b1d53-a6ee-4eaf-a0ef-15b4ae9a2deb"
  },
  {
    "id": "7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37",
    "username": "angel_vazquez",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "ANGEL ALBERTO VAZQUEZ MEJIA",
    "zona": "LA PIEDAD",
    "role_name": "supervisor_v",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.690Z",
    "supervisor_id": null
  },
  {
    "id": "f5ca24b4-4c08-473e-8991-c8a5377a26ed",
    "username": "francisco_martinez",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "FRANCISCO DE JESUS MARTINEZ RAZO",
    "zona": "ZAMORA",
    "role_name": "supervisor_v",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.691Z",
    "supervisor_id": null
  },
  {
    "id": "504b1d53-a6ee-4eaf-a0ef-15b4ae9a2deb",
    "username": "jose_herrera",
    "password_hash": "$2b$10$wK7.zMvXCVu03e./1wvhk.3O9ngx4YGhbApMqphMyC1qiDpsusyNK",
    "nombre": "JOSE MANUEL HERRERA MARTINEZ",
    "zona": "MORELIA",
    "role_name": "supervisor_v",
    "activo": true,
    "created_at": "2026-04-02T20:10:42.691Z",
    "supervisor_id": null
  }
]);
};
