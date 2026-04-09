/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Deletes ALL existing entries
  await knex("daily_captures").del();

  // Inserts seed entries
  await knex("daily_captures").insert([
  {
    "id": "51737c63-b30b-4ed3-ab2a-6841652f9e3f",
    "folio": "J-154441",
    "user_id": "413e02ec-0691-464c-ad11-d3e5cfe2113f",
    "captured_by_username": "joaquin_hurtado",
    "zona_captura": "LA PIEDAD",
    "fecha": "2026-04-02T06:00:00.000Z",
    "hora_inicio": "2026-04-02T21:37:06.772Z",
    "hora_fin": "2026-04-02T21:44:41.242Z",
    "exhibiciones": [
      {
        "id": "z9s4mnk",
        "fotoUrl": "/uploads/exh_J-154441_z9s4mnk_1775166281267.jpg",
        "conceptoId": "caa6eb53-8690-420d-9074-dd90cc36bcd3",
        "rangoCompra": "",
        "ubicacionId": "0e83a84a-59bb-4e94-a25a-04b6c0b77d84",
        "horaRegistro": "2026-04-02T21:38:17.713Z",
        "nivelEjecucion": "bajo",
        "ventaAdicional": 0,
        "productosMarcados": [
          null
        ],
        "puntuacionCalculada": 895
      },
      {
        "id": "22wyn3t",
        "fotoUrl": "/uploads/exh_J-154441_22wyn3t_1775166281268.jpg",
        "conceptoId": "eb3812d8-fbc9-4f53-9245-c878a8697a13",
        "rangoCompra": "",
        "ubicacionId": "0e83a84a-59bb-4e94-a25a-04b6c0b77d84",
        "horaRegistro": "2026-04-02T21:38:39.978Z",
        "nivelEjecucion": "bajo",
        "ventaAdicional": 0,
        "productosMarcados": [
          null
        ],
        "puntuacionCalculada": 595
      }
    ],
    "stats": {
      "ventaTotal": 0,
      "puntuacionTotal": 1490,
      "totalExhibiciones": 2,
      "totalProductosMarcados": 2
    },
    "created_at": "2026-04-02T21:44:41.308Z",
    "latitud": "20.35270000",
    "longitud": "-102.01760000"
  },
  {
    "id": "5dbc9d9d-d9c0-441a-8453-78a092963500",
    "folio": "S-081830",
    "user_id": "f1fccc8b-976b-48df-9184-39cda22f229c",
    "captured_by_username": "superoot",
    "zona_captura": "NACIONAL",
    "fecha": "2026-04-06T06:00:00.000Z",
    "hora_inicio": "2026-04-06T14:17:37.323Z",
    "hora_fin": "2026-04-06T14:18:30.298Z",
    "exhibiciones": [
      {
        "id": "23u8mip",
        "fotoUrl": "/uploads/exh_S-081830_23u8mip_1775485110307.jpg",
        "conceptoId": "eb3812d8-fbc9-4f53-9245-c878a8697a13",
        "rangoCompra": ">500",
        "ubicacionId": "83bfb372-870e-4be1-8612-ee361703cc03",
        "horaRegistro": "2026-04-06T14:18:15.179Z",
        "nivelEjecucion": "alto",
        "ventaAdicional": 0,
        "productosMarcados": [
          null
        ],
        "puntuacionCalculada": 5.55
      }
    ],
    "stats": {
      "ventaTotal": 0,
      "puntuacionTotal": 5.55,
      "totalExhibiciones": 1,
      "totalProductosMarcados": 1
    },
    "created_at": "2026-04-06T14:18:30.309Z",
    "latitud": "20.35270000",
    "longitud": "-102.01760000"
  },
  {
    "id": "896b4a0c-124c-4dc1-8477-f5381ff50efd",
    "folio": "S-101941",
    "user_id": "f1fccc8b-976b-48df-9184-39cda22f229c",
    "captured_by_username": "superoot",
    "zona_captura": "NACIONAL",
    "fecha": "2026-04-06T06:00:00.000Z",
    "hora_inicio": "2026-04-06T16:18:03.669Z",
    "hora_fin": "2026-04-06T16:19:41.364Z",
    "exhibiciones": [
      {
        "id": "klddfua",
        "fotoUrl": "/uploads/exh_S-101941_klddfua_1775492381374.png",
        "conceptoId": "eb3812d8-fbc9-4f53-9245-c878a8697a13",
        "rangoCompra": ">500",
        "ubicacionId": "ecce723f-796c-4b90-9374-f1428166c21d",
        "horaRegistro": "2026-04-06T16:18:53.430Z",
        "nivelEjecucion": "medio",
        "ventaAdicional": 0,
        "productosMarcados": [
          null
        ],
        "puntuacionCalculada": 515
      }
    ],
    "stats": {
      "ventaTotal": 0,
      "puntuacionTotal": 515,
      "totalExhibiciones": 1,
      "totalProductosMarcados": 1
    },
    "created_at": "2026-04-06T16:19:41.376Z",
    "latitud": "20.35270000",
    "longitud": "-102.01760000"
  }
]);
};
