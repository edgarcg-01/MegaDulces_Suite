import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { json, urlencoded } from 'express';
import knex from 'knex';
import { connectionConfig } from '../../../database/knexfile';

async function bootstrap() {
  if (process.env.NODE_ENV === 'production') {
    const db = knex(connectionConfig['production']);

    try {
      const migrationsPath = join(process.cwd(), 'database', 'migrations');
      const seedsPath = join(process.cwd(), 'database', 'seeds');

      console.log('Running database migrations from:', migrationsPath);
      await db.migrate.latest({
        directory: join(__dirname, 'database', 'migrations'),
      });

      if (process.env.RUN_SEEDS === 'true') {
        console.log('Running database seeds from:', seedsPath);
        await db.seed.run({
          directory: join(__dirname, 'database', 'seeds'),
        });
      }

      console.log('DB Setup completed.');
      await db.destroy();
    } catch (error) {
      console.error('DB Setup failed:', error);
      process.exit(1);
    }
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Crear carpeta uploads si no existe
  const uploadsPath = join(__dirname, '..', 'uploads');
  app.useStaticAssets(uploadsPath, {
    prefix: '/uploads/',
  });

  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ extended: true, limit: '50mb' }));

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

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application running on port ${port}`);
}

bootstrap();
