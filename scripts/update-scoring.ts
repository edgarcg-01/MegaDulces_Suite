import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { KNEX_CONNECTION } from './src/shared/database/database.module';

async function updateScoring() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const knex = app.get(KNEX_CONNECTION);

  console.log('--- Updating Scoring Configuration ---');

  const config = {
    pesos_posicion: {
      caja: 100,
      adyacente: 70,
      vitrina: 60,
      exhibidor: 40,
      refrigerador: 40,
      anaquel: 25,
      detras: 10
    },
    factores_tipo: {
      tira: 1.0,
      vitrina: 1.5,
      congelador: 2.0,
      mueble_especial: 1.8
    },
    niveles_ejecucion: {
      alto: 1.0,
      medio: 0.7,
      bajo: 0.4
    }
  };

  await knex('scoring_config').truncate();
  
  await knex('scoring_config').insert({
    config: JSON.stringify(config)
  });

  console.log('✅ Scoring Configuration updated successfully');
  await app.close();
}

updateScoring();
