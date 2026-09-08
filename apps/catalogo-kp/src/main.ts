import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// AppModule se trae con require() DENTRO de bootstrap(), no con `import`
// estático arriba — evita que el require se ejecute antes que
// `dotenv.config()` de abajo (bug real de CV.15, cuando `AuthModule` hacía
// throw a nivel de módulo si faltaba una env var; ese módulo ya no existe,
// pero se mantiene el mismo patrón defensivo por costo cero).
//
// `require()` en vez de `await import()`: un `import()` dinámico hace que
// webpack lo separe en un chunk aparte, y el despliegue de este app copia
// sólo `main.js` — `require()` síncrono lo empaqueta inline en el mismo
// bundle.
async function bootstrap() {
  const { AppModule } = require('./app.module');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Origen abierto a propósito: los verificadores de mostrador y los kioscos
  // pegan desde distintas máquinas de la red interna sin configuración de CORS.
  app.enableCors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] });

  app.setGlobalPrefix('api');

  // Sirve public/verificador-NN.html (generados por
  // herramientas/Actualizar_Verificador.ps1) desde la raíz del proceso,
  // mientras la API vive bajo /api/*. Mismo primitivo que apps/api usa para
  // /uploads/ — nunca ServeStaticModule (retirado 2026-06-01 por el bug de
  // Express 5 + path-to-regexp con `exclude`). Sin `exclude` acá, no aplica.
  //
  // El build de este app vive en dist/apps/catalogo-kp/{main.js,public/} —
  // ya son hermanos entre sí, sin nivel extra.
  app.useStaticAssets(join(__dirname, 'public'));

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`catalogo-kp corriendo en: http://localhost:${port}/api`);
}

bootstrap();
