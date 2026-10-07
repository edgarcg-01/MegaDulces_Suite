/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Check existing products to avoid duplicates
  const existingProducts = await knex("products").select("nombre");
  const existingNames = existingProducts.map(p => p.nombre);

  const productsToInsert = [
  {
    "id": "3d4d7a21-464b-43da-a010-5b31e6309a2f",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Mazapán Clásico",
    "activo": true,
    "orden": 1,
    "puntuacion": 5
  },
  {
    "id": "772b57b3-a9f8-475f-bf27-1073910cc03d",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Mazapán Gigante",
    "activo": true,
    "orden": 2,
    "puntuacion": 5
  },
  {
    "id": "bd9d97a8-3ebe-4f8e-a63d-5c7d5082e7bd",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Nugs",
    "activo": true,
    "orden": 3,
    "puntuacion": 5
  },
  {
    "id": "d9316b97-de0a-4e8e-ae34-0bbadb459753",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Nugs Recreo",
    "activo": true,
    "orden": 4,
    "puntuacion": 5
  },
  {
    "id": "3956e667-31b6-47e2-9ab1-f47c8a53c665",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Suizo",
    "activo": true,
    "orden": 5,
    "puntuacion": 5
  },
  {
    "id": "982de956-1ab1-4f6f-9716-2cb70ad0ad93",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Japonés 200g",
    "activo": true,
    "orden": 6,
    "puntuacion": 5
  },
  {
    "id": "b1f21f0e-1659-4972-a9a7-cdc0a7106881",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Japonés 60g",
    "activo": true,
    "orden": 7,
    "puntuacion": 5
  },
  {
    "id": "e208c6a0-c847-432a-9495-c3ea55e19b7e",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Gummy Pop",
    "activo": true,
    "orden": 8,
    "puntuacion": 5
  },
  {
    "id": "9e930c4c-5b86-43e5-98a5-25fdded9f3ce",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Paleta Jumbo",
    "activo": true,
    "orden": 9,
    "puntuacion": 5
  },
  {
    "id": "c2bc0a66-7667-45ef-affb-5407a0550be3",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Bombón Chocolate",
    "activo": true,
    "orden": 10,
    "puntuacion": 5
  },
  {
    "id": "f1a8be96-f22e-474f-85e0-aa57284d734d",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Ranita",
    "activo": true,
    "orden": 11,
    "puntuacion": 5
  },
  {
    "id": "48d75d52-79b1-46ec-ba44-7f1f5c195c06",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Suave Acidito",
    "activo": true,
    "orden": 12,
    "puntuacion": 5
  },
  {
    "id": "6257391b-e130-4a63-b328-edf1911170a2",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Bombón Mini",
    "activo": true,
    "orden": 13,
    "puntuacion": 5
  },
  {
    "id": "cb5b6b0d-bcbf-4e46-985c-526a355abd3a",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Malvabón",
    "activo": true,
    "orden": 14,
    "puntuacion": 5
  },
  {
    "id": "bc990e4d-c2d1-45dc-a699-2bc69a56bd67",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Mazapán Chocolate",
    "activo": true,
    "orden": 15,
    "puntuacion": 5
  },
  {
    "id": "16c79879-5249-4690-8eb1-dd6de0903198",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Pulparindo",
    "activo": true,
    "orden": 16,
    "puntuacion": 5
  },
  {
    "id": "ef1587c8-c808-49bc-b786-7f8aa2a7625c",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Bombón Gigante",
    "activo": true,
    "orden": 17,
    "puntuacion": 5
  },
  {
    "id": "745bb1f2-e9ce-4bad-a322-b0c2106ca7d5",
    "brand_id": "45e91aae-d16b-4d19-a723-25382af60747",
    "nombre": "Confichoky",
    "activo": true,
    "orden": 18,
    "puntuacion": 5
  },
  {
    "id": "872076df-baa6-439b-82fe-90b0aeb17d31",
    "brand_id": "cd9023fa-5ba9-45da-aa1c-d42a495e9191",
    "nombre": "Pelón Gde",
    "activo": true,
    "orden": 1,
    "puntuacion": 5
  },
  {
    "id": "906d5af4-24d6-40f2-9df3-ee766237e7e3",
    "brand_id": "cd9023fa-5ba9-45da-aa1c-d42a495e9191",
    "nombre": "Pelón Mini",
    "activo": true,
    "orden": 2,
    "puntuacion": 5
  },
  {
    "id": "13d66809-adff-4e36-99d8-4c6fce97363c",
    "brand_id": "cd9023fa-5ba9-45da-aa1c-d42a495e9191",
    "nombre": "Kisses",
    "activo": true,
    "orden": 3,
    "puntuacion": 5
  },
  {
    "id": "595683df-a263-4074-9d08-3006dca199a0",
    "brand_id": "cd9023fa-5ba9-45da-aa1c-d42a495e9191",
    "nombre": "Hershey Barra 20g",
    "activo": true,
    "orden": 4,
    "puntuacion": 5
  },
  {
    "id": "a91dd7f2-c8b2-4e71-a200-07d2c33d6c67",
    "brand_id": "cd9023fa-5ba9-45da-aa1c-d42a495e9191",
    "nombre": "Crayón",
    "activo": true,
    "orden": 5,
    "puntuacion": 5
  },
  {
    "id": "e4ea1993-ae4d-4abf-8d62-6ee2fb80ec11",
    "brand_id": "cd9023fa-5ba9-45da-aa1c-d42a495e9191",
    "nombre": "Pelonetes",
    "activo": true,
    "orden": 6,
    "puntuacion": 5
  },
  {
    "id": "bb29d5c4-ddcf-4948-9da0-4a09df4bfc39",
    "brand_id": "cd9023fa-5ba9-45da-aa1c-d42a495e9191",
    "nombre": "Hershey Miniatura",
    "activo": true,
    "orden": 7,
    "puntuacion": 5
  },
  {
    "id": "18d87999-a6fd-4e52-9678-92fa2472e5a0",
    "brand_id": "cd9023fa-5ba9-45da-aa1c-d42a495e9191",
    "nombre": "Hershey Barra 40g",
    "activo": true,
    "orden": 8,
    "puntuacion": 5
  },
  {
    "id": "cbe373b0-0ba9-437b-afe5-c1a2787bd06d",
    "brand_id": "cd9023fa-5ba9-45da-aa1c-d42a495e9191",
    "nombre": "Peloneta",
    "activo": true,
    "orden": 9,
    "puntuacion": 5
  },
  {
    "id": "09653d2e-96b6-446c-bd1f-21ef6ba16b40",
    "brand_id": "48120e2d-4533-4c5c-92a2-379e416cf6d4",
    "nombre": "Nikolo",
    "activo": true,
    "orden": 1,
    "puntuacion": 5
  },
  {
    "id": "d02339ac-4220-4abd-9d75-dc9ebcc83163",
    "brand_id": "48120e2d-4533-4c5c-92a2-379e416cf6d4",
    "nombre": "Bon o Bon",
    "activo": true,
    "orden": 2,
    "puntuacion": 5
  },
  {
    "id": "b2fcb4b0-5c90-43f7-893e-ef8a7bc04759",
    "brand_id": "48120e2d-4533-4c5c-92a2-379e416cf6d4",
    "nombre": "Butter Toffe",
    "activo": true,
    "orden": 3,
    "puntuacion": 5
  },
  {
    "id": "1865d9df-c75f-4775-825a-c94440d0fc01",
    "brand_id": "48120e2d-4533-4c5c-92a2-379e416cf6d4",
    "nombre": "Poosh",
    "activo": true,
    "orden": 4,
    "puntuacion": 5
  },
  {
    "id": "33b7233b-2db8-4995-80f7-7ea3dc21aff5",
    "brand_id": "d54096c4-ecaf-4505-b510-3f04cbea2c71",
    "nombre": "Winis T7",
    "activo": true,
    "orden": 1,
    "puntuacion": 5
  },
  {
    "id": "455212a6-110c-44af-9487-42c870a181c6",
    "brand_id": "d54096c4-ecaf-4505-b510-3f04cbea2c71",
    "nombre": "Maxi Tubo",
    "activo": true,
    "orden": 2,
    "puntuacion": 5
  },
  {
    "id": "77020202-3cf9-4e68-88bb-90abb954f05c",
    "brand_id": "d54096c4-ecaf-4505-b510-3f04cbea2c71",
    "nombre": "Winis Paleta",
    "activo": true,
    "orden": 3,
    "puntuacion": 5
  },
  {
    "id": "dbd4fff8-e4b9-40bf-8144-edd3fd4f755c",
    "brand_id": "d54096c4-ecaf-4505-b510-3f04cbea2c71",
    "nombre": "Frutaffy",
    "activo": true,
    "orden": 4,
    "puntuacion": 5
  },
  {
    "id": "42ded419-cbf6-436a-8b0b-40a17c91088c",
    "brand_id": "d54096c4-ecaf-4505-b510-3f04cbea2c71",
    "nombre": "Acidup",
    "activo": true,
    "orden": 5,
    "puntuacion": 5
  },
  {
    "id": "cc3b52ec-f49c-42ec-a4cb-f79a0cfe3de4",
    "brand_id": "d54096c4-ecaf-4505-b510-3f04cbea2c71",
    "nombre": "Cuadreta",
    "activo": true,
    "orden": 6,
    "puntuacion": 5
  },
  {
    "id": "0511b082-00ca-48cc-b793-052034fffd68",
    "brand_id": "d54096c4-ecaf-4505-b510-3f04cbea2c71",
    "nombre": "Tubito",
    "activo": true,
    "orden": 7,
    "puntuacion": 5
  },
  {
    "id": "33470391-5111-480e-94e9-11123013f34a",
    "brand_id": "d54096c4-ecaf-4505-b510-3f04cbea2c71",
    "nombre": "Congelada",
    "activo": true,
    "orden": 8,
    "puntuacion": 5
  },
  {
    "id": "c1322126-41e9-4d9e-9b58-c6663a83ad07",
    "brand_id": "aba43d16-6652-4f08-8766-d9138daff311",
    "nombre": "Canels 4s",
    "activo": true,
    "orden": 1,
    "puntuacion": 5
  },
  {
    "id": "56ecccb9-654b-4fd4-96b6-cf12b44f2ac2",
    "brand_id": "aba43d16-6652-4f08-8766-d9138daff311",
    "nombre": "Goma Tueni",
    "activo": true,
    "orden": 2,
    "puntuacion": 5
  },
  {
    "id": "a3d0a90f-74fb-49c4-b034-417646fce20b",
    "brand_id": "aba43d16-6652-4f08-8766-d9138daff311",
    "nombre": "Cherry Sours",
    "activo": true,
    "orden": 3,
    "puntuacion": 5
  },
  {
    "id": "1820edca-8e3b-4714-afc6-3f54e3cd9eb7",
    "brand_id": "aba43d16-6652-4f08-8766-d9138daff311",
    "nombre": "ICEE 50g",
    "activo": true,
    "orden": 4,
    "puntuacion": 5
  },
  {
    "id": "50411cc7-1332-4e50-8400-b6b58e72b97e",
    "brand_id": "aba43d16-6652-4f08-8766-d9138daff311",
    "nombre": "Mini Chicloso",
    "activo": true,
    "orden": 5,
    "puntuacion": 5
  },
  {
    "id": "7a3d2679-3524-4416-baaf-56b081f5932b",
    "brand_id": "aba43d16-6652-4f08-8766-d9138daff311",
    "nombre": "T7 ICEE",
    "activo": true,
    "orden": 6,
    "puntuacion": 5
  },
  {
    "id": "3d4d9cad-54f2-4b16-9483-88c97519e6f7",
    "brand_id": "aba43d16-6652-4f08-8766-d9138daff311",
    "nombre": "Paletón Vaquita",
    "activo": true,
    "orden": 7,
    "puntuacion": 5
  },
  {
    "id": "ed1874a8-c9cb-4698-a1c5-2a3124fc852d",
    "brand_id": "aba43d16-6652-4f08-8766-d9138daff311",
    "nombre": "Pal ICEE",
    "activo": true,
    "orden": 8,
    "puntuacion": 5
  },
  {
    "id": "bd2ef8f3-437a-42bd-becd-042662973fac",
    "brand_id": "5895c198-d28e-488a-b235-dc792e460dce",
    "nombre": "Damy",
    "activo": true,
    "orden": 1,
    "puntuacion": 5
  },
  {
    "id": "e0a87d56-b305-4e10-ac6e-23ed9baea081",
    "brand_id": "5895c198-d28e-488a-b235-dc792e460dce",
    "nombre": "Ricos Besos",
    "activo": true,
    "orden": 2,
    "puntuacion": 5
  },
  {
    "id": "397396e0-c8ba-4e24-ab79-a273027e6caa",
    "brand_id": "5895c198-d28e-488a-b235-dc792e460dce",
    "nombre": "Chicloso Surtido",
    "activo": true,
    "orden": 3,
    "puntuacion": 5
  },
  {
    "id": "cb984871-6af0-4bf3-b60c-425946ccc03e",
    "brand_id": "c728fb5a-adf9-472d-9fef-9ae05d73f6af",
    "nombre": "Michamoy",
    "activo": true,
    "orden": 1,
    "puntuacion": 5
  },
  {
    "id": "6096fd91-15ed-426f-9aee-e0d8182593ee",
    "brand_id": "a7f45120-07fa-4c88-9f6c-88ea8e618a24",
    "nombre": "Ate Azúcar",
    "activo": true,
    "orden": 1,
    "puntuacion": 5
  },
  {
    "id": "007e153a-5b32-40b3-94af-c13eb26f12ad",
    "brand_id": "a7f45120-07fa-4c88-9f6c-88ea8e618a24",
    "nombre": "Ate Chile",
    "activo": true,
    "orden": 2,
    "puntuacion": 5
  },
  {
    "id": "8e4ad33f-7ba5-4428-bd45-6c526b543b81",
    "brand_id": "a7f45120-07fa-4c88-9f6c-88ea8e618a24",
    "nombre": "Manguito",
    "activo": true,
    "orden": 3,
    "puntuacion": 5
  },
  {
    "id": "bcf2a875-3820-41df-837e-ea1990e608e2",
    "brand_id": "a7f45120-07fa-4c88-9f6c-88ea8e618a24",
    "nombre": "Gummy Tiras",
    "activo": true,
    "orden": 4,
    "puntuacion": 5
  },
  {
    "id": "a04154dc-51e5-4fb7-8d73-6cd4c080ae00",
    "brand_id": "4bd2dc1c-503e-4388-a3fd-767211384193",
    "nombre": "60x90",
    "activo": true,
    "orden": 1,
    "puntuacion": 5
  },
  {
    "id": "b1d97ce6-21e6-4b0b-a041-b496b45181b5",
    "brand_id": "4bd2dc1c-503e-4388-a3fd-767211384193",
    "nombre": "50x70",
    "activo": true,
    "orden": 2,
    "puntuacion": 5
  },
  {
    "id": "0eecd5ad-2a52-4ab2-9bf9-988a1198b67e",
    "brand_id": "4bd2dc1c-503e-4388-a3fd-767211384193",
    "nombre": "90x120",
    "activo": true,
    "orden": 3,
    "puntuacion": 5
  },
  {
    "id": "9af891d1-2c3f-44b4-b1f4-71ce686021b5",
    "brand_id": "1b7b4167-a81c-483b-9989-30a0b0f9b6e8",
    "nombre": "Wafer Choco",
    "activo": true,
    "orden": 1,
    "puntuacion": 5
  },
  {
    "id": "a1c0d1cb-0a53-4b43-8595-49f1d3480e58",
    "brand_id": "1b7b4167-a81c-483b-9989-30a0b0f9b6e8",
    "nombre": "Astridix",
    "activo": true,
    "orden": 2,
    "puntuacion": 5
  },
  {
    "id": "57d7b345-ea49-4c7c-8fa0-915303e8a9fd",
    "brand_id": "1b7b4167-a81c-483b-9989-30a0b0f9b6e8",
    "nombre": "Choco Galletín",
    "activo": true,
    "orden": 3,
    "puntuacion": 5
  },
  {
    "id": "557fa935-754a-423c-b63b-4aa68ab80d53",
    "brand_id": "1b7b4167-a81c-483b-9989-30a0b0f9b6e8",
    "nombre": "Crunch Caritas",
    "activo": true,
    "orden": 4,
    "puntuacion": 5
  },
  {
    "id": "a7330223-2519-486e-937d-d80afbd3a61f",
    "brand_id": "1b7b4167-a81c-483b-9989-30a0b0f9b6e8",
    "nombre": "Frutal Soda",
    "activo": true,
    "orden": 5,
    "puntuacion": 5
  },
  {
    "id": "abf08fe3-1443-4930-9ee1-edd3d24dce62",
    "brand_id": "1b7b4167-a81c-483b-9989-30a0b0f9b6e8",
    "nombre": "Trueno Pop",
    "activo": true,
    "orden": 6,
    "puntuacion": 5
  },
  {
    "id": "eb12f1c0-2bc5-43a7-a37d-9105efb8601c",
    "brand_id": "1b7b4167-a81c-483b-9989-30a0b0f9b6e8",
    "nombre": "Huevito",
    "activo": true,
    "orden": 7,
    "puntuacion": 5
  },
  {
    "id": "1fb132f0-6a1c-41ea-97e5-fe67a77ee9c5",
    "brand_id": "1b7b4167-a81c-483b-9989-30a0b0f9b6e8",
    "nombre": "Brocheta",
    "activo": true,
    "orden": 8,
    "puntuacion": 5
  },
  {
    "id": "eef81f23-a881-49a1-960d-ee7ac6b8e137",
    "brand_id": "7caec435-7469-4596-985a-5ab15bb8a788",
    "nombre": "Gelatina",
    "activo": true,
    "orden": 1,
    "puntuacion": 5
  },
  {
    "id": "a3944d93-6b5a-476d-973a-df239bb733f8",
    "brand_id": "7caec435-7469-4596-985a-5ab15bb8a788",
    "nombre": "Rainbow",
    "activo": true,
    "orden": 2,
    "puntuacion": 5
  },
  {
    "id": "053f0f29-b8bc-4695-854f-a20133362e4c",
    "brand_id": "7caec435-7469-4596-985a-5ab15bb8a788",
    "nombre": "Baileys",
    "activo": true,
    "orden": 3,
    "puntuacion": 5
  },
  {
    "id": "a31826a3-fbb9-44fe-804b-efb2c99ed46e",
    "brand_id": "7caec435-7469-4596-985a-5ab15bb8a788",
    "nombre": "Truffles",
    "activo": true,
    "orden": 4,
    "puntuacion": 5
  },
  {
    "id": "d3484b25-72f9-4cec-8520-131d84ebdc90",
    "brand_id": "7caec435-7469-4596-985a-5ab15bb8a788",
    "nombre": "Malvavisco ICEE",
    "activo": true,
    "orden": 5,
    "puntuacion": 5
  },
  {
    "id": "41d72294-ebd8-4461-8649-ae2412a4d21b",
    "brand_id": "ef741ae4-ff0f-43ac-875f-c630025c24d1",
    "nombre": "Volmond",
    "activo": true,
    "orden": 1,
    "puntuacion": 5
  },
  {
    "id": "3fd77d71-81ff-436f-8234-06adb04e367d",
    "brand_id": "ef741ae4-ff0f-43ac-875f-c630025c24d1",
    "nombre": "Fruit 3D",
    "activo": true,
    "orden": 2,
    "puntuacion": 5
  },
  {
    "id": "c3842958-70a7-4c6b-bcee-ee433f8911de",
    "brand_id": "ef741ae4-ff0f-43ac-875f-c630025c24d1",
    "nombre": "Pelafrut",
    "activo": true,
    "orden": 3,
    "puntuacion": 5
  },
  {
    "id": "d01b127c-a806-4722-a025-34f8e36f0486",
    "brand_id": "ef741ae4-ff0f-43ac-875f-c630025c24d1",
    "nombre": "Jelly Pop",
    "activo": true,
    "orden": 4,
    "puntuacion": 5
  },
  {
    "id": "6cb2e1bd-2e66-4b15-b621-ffdb5df2145b",
    "brand_id": "dd77f71c-d4ac-4666-9937-f3171d62501b",
    "nombre": "Cometinix",
    "activo": true,
    "orden": 1,
    "puntuacion": 5
  },
  {
    "id": "aea8e31a-02f2-48ed-843a-72f29472a6fd",
    "brand_id": "dd77f71c-d4ac-4666-9937-f3171d62501b",
    "nombre": "Freskiice",
    "activo": true,
    "orden": 2,
    "puntuacion": 5
  },
  {
    "id": "440aa798-e685-4bb6-9d37-10d8806c7c42",
    "brand_id": "dd77f71c-d4ac-4666-9937-f3171d62501b",
    "nombre": "Freskysoda",
    "activo": true,
    "orden": 3,
    "puntuacion": 5
  },
  {
    "id": "8200ef50-e062-42b1-9d4d-89ad660d37db",
    "brand_id": "dd77f71c-d4ac-4666-9937-f3171d62501b",
    "nombre": "Agua Calid",
    "activo": true,
    "orden": 4,
    "puntuacion": 5
  }
  ].filter(product => !existingNames.includes(product.nombre));

  if (productsToInsert.length === 0) {
    console.log("[03_products] All products already exist, skipping seed.");
    return;
  }

  await knex("products").insert(productsToInsert);
  console.log(`[03_products] Inserted ${productsToInsert.length} new products.`);
};
