// OTel: DEBE ir PRIMERO de todo (instrumenta al cargar). Inerte sin
// OTEL_EXPORTER_OTLP_ENDPOINT. Ver apps/api/src/otel.ts (INFRA.2, ADR-043).
import './otel';
// Sentry: DEBE ir primero (instrumenta al cargar). Inerte sin SENTRY_DSN.
import './instrument';
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
import compression from 'compression';
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
    // Con LOG_JSON=true, bufferLogs deja que nestjs-pino tome el control (los logs
    // de boot se retienen hasta useLogger). Sin el toggle, comportamiento clásico.
    bufferLogs: process.env.LOG_JSON === 'true',
    // Log level: default PROD-quiet (sin debug/verbose) para no saturar el límite de
    // Railway (500 logs/s → tira mensajes reales) ni la factura de logging. El trace
    // per-request del TenantContextInterceptor y otros debug quedan disponibles con
    // LOG_LEVEL=debug (local/troubleshooting). error/warn/log siempre.
    logger: process.env.LOG_LEVEL === 'debug'
      ? ['error', 'warn', 'log', 'debug', 'verbose']
      : ['error', 'warn', 'log'],
  });

  // INFRA.2: logs JSON estructurados vía pino (feed a Loki). Opt-in por LOG_JSON;
  // default OFF = logger clásico de Nest intacto. app.get(Logger) requiere el
  // LoggerModule de nestjs-pino, que AppModule sólo registra con el mismo toggle.
  if (process.env.LOG_JSON === 'true') {
    const { Logger: PinoLogger } = await import('nestjs-pino');
    app.useLogger(app.get(PinoLogger));
    app.flushLogs();
  }

  // Detrás de nginx (mismo container) y del edge de Railway: confiar en el
  // primer proxy para que `req.ip` use X-Forwarded-For en vez de 127.0.0.1.
  // Sin esto el ThrottlerGuard keyea TODO al loopback (rate-limit = bucket
  // compartido global, inútil) y las IPs de auditoría son las del proxy.
  app.set('trust proxy', 1);

  // Compresión gzip de TODAS las respuestas (JSON de reportes, estático). El JSON de
  // texto baja ~75-85% → recorta egress de Railway directamente. threshold 1KB: no
  // comprime payloads chicos (no vale el CPU). Respeta `x-no-compression` en el request.
  // Va lo más afuera posible (antes de rutas y estático) para envolver todas las salidas.
  app.use(compression({ threshold: 1024 }));

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
  // Comprobación de gasto (GX.7): el comprobante PDF/imagen llega como base64
  // (hasta 10MB → ~13MB en base64). Parser de mayor límite SOLO para esa ruta,
  // montado antes del global para que gane (express salta el segundo si ya parseó).
  app.use('/api/finance/expenses/proofs', json({ limit: '16mb' }));
  // Comprobación de gastos (GX.8): OCR + upload del documento "Gastos" de Kepler (foto/PDF) como base64.
  app.use('/api/finance/expenses/comprobaciones', json({ limit: '16mb' }));
  // Evidencia por foto/PDF (RE.5 recepción, CC cobranza, CC pagos): la remisión/ficha/
  // comprobante llega como base64. Sin esto el global 2mb tira 413 en /ocr, /upload y /attach.
  // Recepción (goods-receipts) admite el PDF COMBINADO (orden+factura+remisión escaneados
  // juntos) hasta 20MB → ~27MB en base64 → 32mb. (nginx client_max_body_size=32m aparte.)
  app.use('/api/finance/goods-receipts', json({ limit: '32mb' }));
  app.use('/api/finance/collections', json({ limit: '16mb' }));
  app.use('/api/finance/supplier-payments', json({ limit: '16mb' }));
  // Conciliación bancaria (CB.2.1): el workbook Excel llega como base64 (~2-5MB).
  app.use('/api/finance/bank/import', json({ limit: '25mb' }));
  // WhatsApp (F.1): el webhook de Meta necesita el body CRUDO para validar la
  // firma HMAC (X-Hub-Signature-256). `verify` guarda el buffer en req.rawBody
  // antes de que se parsee el JSON. Montado antes del global para que gane.
  app.use(
    '/api/webhooks/whatsapp',
    json({
      limit: '1mb',
      verify: (req: any, _res, buf: Buffer) => {
        if (buf?.length) req.rawBody = buf;
      },
    }),
  );
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
