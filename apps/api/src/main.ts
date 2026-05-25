import * as dotenv from 'dotenv';
dotenv.config();
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { join } from 'path';
import { json, urlencoded } from 'express';
import { ScheduleModule } from '@nestjs/schedule';
import { INestApplicationContext } from '@nestjs/common';
import { ServerOptions } from 'socket.io';

/**
 * Adapter custom para que socket.io escuche en `/reports/socket.io` en lugar
 * del `/socket.io` por defecto. El frontend espera este path (ver
 * websocket.service.ts) y el `setGlobalPrefix` lo excluye explícitamente.
 */
class ReportsIoAdapter extends IoAdapter {
  constructor(app: INestApplicationContext) {
    super(app);
  }
  override createIOServer(port: number, options?: ServerOptions): any {
    return super.createIOServer(port, {
      ...options,
      path: '/reports/socket.io',
    });
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Crear carpeta uploads si no existe
  const uploadsPath = join(__dirname, '..', 'uploads');
  app.useStaticAssets(uploadsPath, {
    prefix: '/uploads/',
  });

  // Configuración CORS permisiva para desarrollo y producción (incluye WebSocket)
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Accept, Authorization, X-Requested-With',
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ extended: true, limit: '50mb' }));

  const apiPrefix = process.env.API_PREFIX || 'api';
  app.setGlobalPrefix(apiPrefix, {
    exclude: ['/reports/socket.io/'],
  });

  const config = new DocumentBuilder()
    .setTitle('Trade Marketing API')
    .setDescription('API RESTful para operaciones de Trade Marketing en campo')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document);

  // WebSocket adapter custom — sirve socket.io en `/reports/socket.io`.
  app.useWebSocketAdapter(new ReportsIoAdapter(app));

  // Habilita lifecycle hooks (onModuleDestroy, onApplicationShutdown).
  // Sin esto los `setInterval` y `setTimeout` de servicios no se limpian
  // al recibir SIGTERM/SIGINT en producción.
  app.enableShutdownHooks();

  const port = process.env.API_PORT || process.env.PORT || 3334;
  await app.listen(port);
  console.log(`Application running on port ${port}`);
  console.log(`WebSocket gateway available at /reports namespace`);
}

bootstrap().catch(console.error);
