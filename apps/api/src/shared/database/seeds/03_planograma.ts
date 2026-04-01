import { Knex } from "knex";

const DEFAULT_PLANOGRAMA = [
  {marca:'LA ROSA', productos:['Mazapán Clásico','Mazapán Gigante','Nugs','Nugs Recreo','Suizo','Japonés 200g','Japonés 60g','Gummy Pop','Paleta Jumbo','Bombón Chocolate','Ranita','Suave Acidito','Bombón Mini','Malvabón','Mazapán Chocolate','Pulparindo','Bombón Gigante','Confichoky']},
  {marca:'HERSHEY', productos:['Pelón Gde','Pelón Mini','Kisses','Hershey Barra 20g','Crayón','Pelonetes','Hershey Miniatura','Hershey Barra 40g','Peloneta']},
  {marca:'ARCOR', productos:['Nikolo','Bon o Bon','Butter Toffe','Poosh']},
  {marca:'WINIS', productos:['Winis T7','Maxi Tubo','Winis Paleta','Frutaffy','Acidup','Cuadreta','Tubito','Congelada']},
  {marca:'CANELS', productos:['Canels 4s','Goma Tueni','Cherry Sours','ICEE 50g','Mini Chicloso','T7 ICEE','Paletón Vaquita','Pal ICEE']},
  {marca:'MONTES', productos:['Damy','Ricos Besos','Chicloso Surtido']},
  {marca:'AP', productos:['Michamoy']},
  {marca:'DELICIATE', productos:['Ate Azúcar','Ate Chile','Manguito','Gummy Tiras']},
  {marca:'BOLSAS DE LOS ALTOS', productos:['60x90','50x70','90x120']},
  {marca:'LAS DELICIAS', productos:['Wafer Choco','Astridix','Choco Galletín','Crunch Caritas','Frutal Soda','Trueno Pop','Huevito','Brocheta']},
  {marca:'INTERCANDY', productos:['Gelatina','Rainbow','Baileys','Truffles','Malvavisco ICEE']},
  {marca:'KALU', productos:['Volmond','Fruit 3D','Pelafrut','Jelly Pop']},
  {marca:'FRUTI FRESK', productos:['Cometinix','Freskiice','Freskysoda','Agua Calid']},
];

export async function seed(knex: Knex): Promise<void> {
  // 1. Limpieza total para asegurar que solo queden los nuevos
  await knex("planograma_productos").del();
  await knex("planograma_marcas").del();

  for (let i = 0; i < DEFAULT_PLANOGRAMA.length; i++) {
    const entry = DEFAULT_PLANOGRAMA[i];
    
    // Insertar Marca
    const [marca] = await knex("planograma_marcas")
      .insert({ 
        nombre: entry.marca, 
        activo: true, 
        orden: i + 1 
      })
      .returning("id");

    // Insertar Productos de esta marca
    const prodInserts = entry.productos.map((prodName, pIndex) => ({
      marca_id: marca.id,
      nombre: prodName,
      puntuacion: 5, // Puntuación base
      orden: pIndex + 1
    }));

    if (prodInserts.length > 0) {
      await knex("planograma_productos").insert(prodInserts);
    }
  }
}
