import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import * as dotenv from 'dotenv';
import { AppModule } from './app.module';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Origen abierto a propósito: los verificadores de mostrador y los kioscos
  // pegan desde distintas máquinas de la red interna sin configuración de CORS.
  app.enableCors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] });

  app.setGlobalPrefix('api');

  // Sirve catalogo.html / tienda.html / verificador-NN.html desde la raíz del
  // proceso, mientras la API vive bajo /api/*. Mismo primitivo que apps/api usa
  // para /uploads/ — nunca ServeStaticModule (retirado 2026-06-01 por el bug de
  // Express 5 + path-to-regexp con `exclude`). Sin `exclude` acá, no aplica.
  //
  // OJO al portar rutas relativas a __dirname: en el proyecto origen (`nest
  // build` plano) dist/main.js y public/ eran hermanos de la raíz del proyecto,
  // así que `join(__dirname, '..', 'public')` llegaba a la raíz. En este
  // monorepo Nx el build vive en dist/apps/catalogo-kp/{main.js,public/,sql/}
  // — YA son hermanos entre sí, sin el nivel extra. Verificado con build real:
  // `../public` daba 404 (buscaba dist/apps/public, que no existe).
  app.useStaticAssets(join(__dirname, 'public'));

  // SPA fallback para /tienda/* (apps/tienda, Fase CV). Angular maneja sus
  // propias rutas (/tienda/carrito, /tienda/checkout, /tienda/pedido/:x) —
  // sin esto, recargar la página en una de esas rutas da 404 porque no es un
  // archivo real. Deliberadamente un app.use() de Express plano, NO
  // `setGlobalPrefix('api', { exclude: [...] })`: ese `exclude` pasa por el
  // mismo path-to-regexp que causó el bug de Express 5 que retiró
  // ServeStaticModule (ver comentario arriba) — este primitivo lo evita
  // igual que useStaticAssets.
  app.use((req: any, res: any, next: any) => {
    if (req.path.startsWith('/tienda/') && !req.path.includes('.')) {
      return res.sendFile(join(__dirname, 'public', 'tienda', 'index.html'));
    }
    next();
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`catalogo-kp corriendo en: http://localhost:${port}/api`);
}

bootstrap();
