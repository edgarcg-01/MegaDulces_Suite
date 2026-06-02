import * as dotenv from 'dotenv';
dotenv.config();
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Handlers globales de errores no capturados. Sin estos, Node mata el
 * proceso silenciosamente ante el menor `unhandledRejection` (default desde
 * Node 15+), Railway lo marca como "Crashed" y nos quedamos sin pistas.
 * Aquí los logueamos prominentemente y NO terminamos el proceso, para que
 * podamos ver qué los provoca en la próxima ocurrencia.
 *
 * Nota: dejar correr tras `uncaughtException` puede dejar al proceso en
 * estado inconsistente — si vemos que los crashes vuelven con un patrón
 * claro de corrupción, conviene volver a matar el proceso aquí (con un
 * `process.exit(1)`) y aceptar el restart.
 */
const fatalLogger = new Logger('FatalErrors');

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  fatalLogger.error(
    `Unhandled Promise Rejection — reason: ${
      reason instanceof Error ? reason.stack : JSON.stringify(reason)
    }`,
  );
  fatalLogger.error(`Promise: ${promise}`);
});

process.on('uncaughtException', (err: Error) => {
  fatalLogger.error(`Uncaught Exception: ${err.stack || err.message}`);
});
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { join } from 'path';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { ScheduleModule } from '@nestjs/schedule';
import { INestApplicationContext } from '@nestjs/common';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, RedisClientType } from 'redis';

/**
 * Adapter custom: (1) sirve socket.io en `/reports/socket.io` (no en
 * `/socket.io` default — el SPA y el reverse-proxy esperan ese path),
 * (2) si REDIS_URL está seteado, conecta a Redis y registra el
 * `@socket.io/redis-adapter` para broadcast cross-instance. Sin REDIS_URL
 * sigue funcionando in-memory (single-instance). Necesario para escalar
 * el API horizontalmente sin que un emit en pod A se pierda en pod B.
 *
 * Los dos namespaces (`/reports` y `/alerts`) comparten el mismo io server
 * → con un solo adapter quedan ambos cubiertos.
 */
class ReportsIoAdapter extends IoAdapter {
  private readonly mainLogger = new Logger('SocketIOAdapter');
  private pub?: RedisClientType;
  private sub?: RedisClientType;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.mainLogger.log('REDIS_URL no seteado → socket.io en modo in-memory (single instance).');
      return;
    }
    try {
      this.pub = createClient({ url });
      this.sub = this.pub.duplicate();
      await Promise.all([this.pub.connect(), this.sub.connect()]);
      this.mainLogger.log(`Conectado a Redis (${url.replace(/\/\/[^@]+@/, '//***@')}) — adapter cross-instance ACTIVO.`);
    } catch (err: any) {
      this.mainLogger.error(`Falló conexión a Redis: ${err.message}. Sigo en modo in-memory.`);
      this.pub = undefined;
      this.sub = undefined;
    }
  }

  override createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, {
      ...options,
      path: '/reports/socket.io',
    });
    if (this.pub && this.sub) {
      server.adapter(createAdapter(this.pub, this.sub));
      this.mainLogger.log('Redis adapter wired al io server.');
    }
    return server;
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

  // Body parsers diferenciados:
  // - JSON global: 2mb (suficiente para casi todos los endpoints)
  // - URLEncoded: 2mb
  // - Endpoints de upload (daily-captures multipart): los maneja AnyFilesInterceptor
  //   sin pasar por este middleware, así que el límite del JSON no aplica.
  // - Endpoints con payload grande (base64 photos legacy): override por route si surge necesidad.
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true, limit: '2mb' }));

  // Helmet: headers HTTP de seguridad (X-Frame-Options, X-Content-Type-Options,
  // Strict-Transport-Security, X-XSS-Protection, etc.). contentSecurityPolicy
  // deshabilitado por ahora porque rompe Swagger UI; activar después con
  // policy específico que permita Swagger.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false, // para que Swagger UI cargue
    }),
  );

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

  // WebSocket adapter custom — sirve socket.io en `/reports/socket.io` y
  // si REDIS_URL está disponible, conecta el redis-adapter para multi-instance.
  const ioAdapter = new ReportsIoAdapter(app);
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);

  // Habilita lifecycle hooks (onModuleDestroy, onApplicationShutdown).
  // Sin esto los `setInterval` y `setTimeout` de servicios no se limpian
  // al recibir SIGTERM/SIGINT en producción.
  app.enableShutdownHooks();

  // NestJS bindea a API_PORT (interno, fijo) → 127.0.0.1 SOLAMENTE.
  // Nginx (mismo container) le hace proxy desde $PORT (público de Railway).
  // No exponemos NestJS al edge porque:
  //   1. Si Railway por error routea al puerto del API, se exponen las JSON
  //      raw responses (incluyendo el "Cannot GET /" 404 que aterró al user).
  //   2. nginx ya impone headers de seguridad + sirve el SPA estático.
  //   3. WS pasa por el proxy de nginx (location /reports/socket.io/) que
  //      maneja el upgrade correctamente.
  //
  // NO usar fallback a process.env.PORT (Railway lo asigna al edge). Si
  // alguien lo configura como API_PORT por accidente, choca con nginx.
  const port = Number(process.env.API_PORT) || 3334;
  await app.listen(port, '127.0.0.1');
  console.log(`Application running on 127.0.0.1:${port}`);
  console.log(`WebSocket gateway available at /reports namespace`);
}

bootstrap().catch(console.error);
