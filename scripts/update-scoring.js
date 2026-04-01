const knex = require('knex');
const dotenv = require('dotenv');

dotenv.config();

const db = knex({
  client: 'postgresql',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'trade_marketing',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'admin',
  }
});

async function run() {
  try {
    console.log('--- Iniciando actualización de Scoring Config ---');
    
    await db('scoring_config').del();

    await db('scoring_config').insert([
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

    console.log('--- Actualización de Scoring completada con éxito ---');
  } catch (error) {
    console.error('--- ERROR DURANTE LA ACTUALIZACIÓN ---');
    console.error(error);
  } finally {
    await db.destroy();
  }
}

run();
