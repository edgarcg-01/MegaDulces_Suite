import { Knex } from "knex";

export async function seed(knex: Knex): Promise<void> {
  await knex("scoring_config").del();

  await knex("scoring_config").insert([
    {
      config: JSON.stringify({
        pesos_posicion: { 
          "caja registradora": 100, 
          "al frente": 80, 
          "pasillo principal": 60, 
          "lado del refrigerador": 50, 
          "al fondo": 20 
        },
        tipos_exhibicion: { 
          "exhibidor": 1.5, 
          "vitrina": 1.2, 
          "vitrolero": 1.0, 
          "paletero": 1.0, 
          "tiras": 0.8 
        },
        niveles_ejecucion: { 
          "excelente": 1.2, 
          "basico": 0.8, 
          "critico": 0.4 
        }
      })
    }
  ]);
}
