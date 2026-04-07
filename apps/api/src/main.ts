import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { json, urlencoded } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import knex from 'knex';
import knexConfig from '../knexfile'; // Asegúrate de que la ruta relativa sea correcta

const execPromise = promisify(exec);
async function bootstrap() {
  // Ejecutar migraciones en producción antes de arrancar el servidor
  if (process.env.NODE_ENV === 'production') {
    console.log('⚙️ Running database migrations...');

    const db = knex(knexConfig);

    try {
      // API nativa de Knex para migrar, no usa la consola
      await db.migrate.latest();
      console.log('✅ Migrations completed successfully.');

      // (Opcional) Cerramos esta conexión temporal, NestJS abrirá la suya luego
      await db.destroy();
    } catch (error) {
      console.error('❌ Migration failed:', error);
      // Es vital matar el proceso si la BD falla, para que el contenedor no levante roto
      process.exit(1);
    }
  }

  // Arranque normal de NestJS
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.useStaticAssets(join(__dirname, '..', 'uploads'), {
    prefix: '/uploads/',
  });

  await app.listen(process.env.PORT || 3000);

  app.enableCors({
    origin: true, // Refleja el origen de la petición (permite el mismo dominio y subdominios)
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Aumentar el límite del payload JSON para permitir el envío de imágenes en Base64
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ extended: true, limit: '50mb' }));

  // Exponer el file system estático de evidencias fotográficas para pruebas
  app.useStaticAssets(join(__dirname, '..', 'uploads'), {
    prefix: '/uploads/',
  });

  const apiPrefix = process.env.API_PREFIX || 'api';
  app.setGlobalPrefix(apiPrefix);

  const config = new DocumentBuilder()
    .setTitle('Trade Marketing API')
    .setDescription('API RESTful para operaciones de Trade Marketing en campo')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
