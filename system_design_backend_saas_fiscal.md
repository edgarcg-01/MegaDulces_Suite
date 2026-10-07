# System Design Document (SDD) — Backend SaaS Fiscal B2B México

> **Documento maestro de ingeniería.** Stack estricto: **NestJS 11 + PostgreSQL 16+**. Alcance: Backend, Base de Datos, Infraestructura y Procesos Asíncronos. **Sin frontend.**
>
> Dominio: descarga masiva de CFDI 4.0 desde el SAT (WS de Descarga Masiva + scraping CIEC), conciliación PUE/PPD vs REP, cruce contra listas negras EFOS (Art. 69-B CFF), generación documental y auditoría fiscal continua para miles de contribuyentes (tenants).

---

## FASE 1: INFRAESTRUCTURA CLOUD Y TOPOLOGÍA BACKEND

### 1.1 Contexto de carga

El tráfico de un SaaS fiscal mexicano es **brutalmente estacional**: los días 1-5 y 15-17 de cada mes (declaraciones provisionales, DIOT, cierre contable) el volumen de descargas y consultas se multiplica ×10-×20 respecto al valle. El día 17 a las 22:00 es el peor momento del sistema. La arquitectura debe absorber ese pico sin sobredimensionar el valle.

### 1.2 API Gateway & Load Balancing

**Topología (AWS como referencia; equivalentes GCP entre paréntesis):**

```
Internet
  └─ CloudFront (Cloud CDN) — TLS termination edge, WAF managed rules
      └─ ALB (Cloud Load Balancing) — path-based routing, health checks /healthz
          ├─ Target Group: api-transactional  (ECS Fargate / Cloud Run)  min 3 tasks
          └─ Target Group: api-webhooks       (ECS Fargate)              min 2 tasks
  [Sin ruta pública] → workers (ECS Fargate / GKE) — solo consumen colas
```

Decisiones concretas:

1. **ALB, no API Gateway de AWS** para el tráfico principal. API Gateway cobra por millón de requests y agrega latencia; su valor (throttling, API keys) lo resolvemos en NestJS con `@nestjs/throttler` + Redis. API Gateway solo se justifica si vendemos API pública a terceros con planes por API key.
2. **Autoscaling por dos señales**: CPU > 60% *y* profundidad de cola BullMQ (métrica custom en CloudWatch). El pico de fin de mes es primero de colas, no de HTTP — escalar workers por `waiting jobs` es lo que evita el colapso.
3. **Scheduled scaling**: regla explícita que sube el mínimo de workers de 2 → 10 los días 1-5 y 14-18 de cada mes a las 06:00 America/Mexico_City. No esperar a que el autoscaler reaccione: el patrón es conocido, se programa.
4. **Rate limiting en capa NestJS** con storage Redis (no en memoria — hay N réplicas):

```typescript
// app.module.ts
ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({
    throttlers: [
      { name: 'default', ttl: 60_000, limit: 120 },   // API general
      { name: 'sat-ops', ttl: 60_000, limit: 6 },     // disparar descargas SAT
      { name: 'reports', ttl: 60_000, limit: 20 },    // reportería pesada
    ],
    storage: new ThrottlerStorageRedisService(cfg.get('REDIS_URL')),
  }),
}),
```

5. **Backpressure explícito**: si la cola `sat-download` supera un umbral (p. ej. 5,000 jobs waiting), el endpoint que encola devuelve `202 Accepted` con `estimated_start_at` calculado, nunca `503`. El cliente B2B tolera espera; no tolera error.

### 1.3 Arquitectura NestJS: Monolito Modular con Workers separados

**Decisión: Monolito Modular con dos perfiles de despliegue del MISMO artefacto** — no microservicios.

Justificación:
- El acoplamiento de dominio es altísimo: un CFDI toca tenancy, impuestos, EFOS, documentos y notificaciones. Separarlo en servicios gRPC/TCP introduce transacciones distribuidas donde hoy basta una transacción Postgres.
- Los microservicios de NestJS (transporte TCP/Redis/gRPC) agregan serialización, descubrimiento y versionado de contratos sin resolver el problema real, que es **aislar el cómputo pesado del path HTTP**. Eso se resuelve con procesos worker.
- Un solo repo/artefacto = un solo pipeline de CI, un solo esquema de migraciones, cero drift de contratos.

**Los dos perfiles se seleccionan por variable de entorno:**

```typescript
// main.ts — un artefacto, dos modos de arranque
async function bootstrap() {
  const role = process.env.APP_ROLE ?? 'api'; // 'api' | 'worker'

  if (role === 'api') {
    const app = await NestFactory.create(ApiModule);
    app.use(helmet());
    app.enableShutdownHooks();
    await app.listen(3000);
  } else {
    // Contexto sin servidor HTTP: solo consumers de BullMQ + crons
    const app = await NestFactory.createApplicationContext(WorkerModule);
    app.enableShutdownHooks(); // crítico: drenar jobs en SIGTERM antes de morir
  }
}
```

```typescript
// worker.module.ts — importa SOLO los módulos de procesamiento
@Module({
  imports: [
    CoreModule,            // config, crypto, db, redis
    SatDownloadModule,     // consumers de descarga
    XmlParsingModule,      // consumers de parseo
    EfosModule,            // cron + cruce masivo
    PdfModule,             // consumers de render
    ScheduleModule.forRoot(), // crons SOLO viven en el worker
  ],
})
export class WorkerModule {}
```

Regla dura: **`ScheduleModule` jamás se importa en el perfil `api`** — si hay 5 réplicas de API, un cron registrado ahí corre 5 veces. Los crons viven en el worker, y aun ahí se protegen con lock distribuido (ver Fase 4).

**Frontera de comunicación entre perfiles: la cola.** La API nunca llama al worker; encola. El worker nunca responde HTTP; escribe estado en Postgres y emite eventos. Esto da idempotencia, reintentos y auditoría gratis.

### 1.4 Bóveda de Seguridad (Secret Management)

Los activos más sensibles del sistema son la **e.firma (.cer/.key + contraseña)** y la **CIEC** de cada tenant. Compromiso de estos = suplantación del contribuyente ante el SAT. Diseño:

**Arquitectura de envelope encryption con AWS KMS:**

1. Existe una **CMK (Customer Master Key)** en KMS que *nunca sale* de KMS. Política IAM: solo el task-role de los workers puede llamar `kms:Decrypt`; nadie tiene `kms:GetKeyMaterial` (imposible por diseño). La API transaccional **no** tiene permiso de Decrypt — solo de Encrypt (para el alta de credenciales).
2. Por cada tenant se genera una **DEK (Data Encryption Key)** de 256 bits. Los archivos `.key` y contraseñas se cifran con la DEK (AES-256-GCM); la DEK se cifra con la CMK y se guarda junto al ciphertext (patrón envelope). Postgres solo almacena blobs cifrados.
3. **Desencriptado exclusivamente en memoria, en el worker, justo antes de llamar al SAT**, con zeroing explícito del buffer al terminar.

```sql
-- Almacenamiento: nunca texto plano, nunca la DEK en claro
CREATE TABLE tenant_sat_credentials (
  tenant_id        UUID PRIMARY KEY REFERENCES tenants(id),
  cer_der          BYTEA NOT NULL,          -- el .cer es público, se guarda tal cual
  key_encrypted    BYTEA NOT NULL,          -- .key cifrado con DEK (AES-256-GCM)
  key_iv           BYTEA NOT NULL,
  key_auth_tag     BYTEA NOT NULL,
  pwd_encrypted    BYTEA NOT NULL,          -- contraseña de la .key
  pwd_iv           BYTEA NOT NULL,
  pwd_auth_tag     BYTEA NOT NULL,
  ciec_encrypted   BYTEA,                   -- CIEC opcional (scraping)
  ciec_iv          BYTEA,
  ciec_auth_tag    BYTEA,
  dek_wrapped      BYTEA NOT NULL,          -- DEK cifrada por la CMK de KMS
  kms_key_arn      TEXT  NOT NULL,
  cer_valid_to     DATE  NOT NULL,          -- para alertar vencimiento de e.firma
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```typescript
// crypto.service.ts — desencriptado efímero en memoria
import { KMSClient, DecryptCommand } from '@aws-sdk/client-kms';
import { createDecipheriv } from 'node:crypto';

@Injectable()
export class CryptoService {
  private readonly kms = new KMSClient({});

  /**
   * Desencripta la e.firma en memoria, la entrega a `fn` y garantiza
   * el borrado de los buffers aunque `fn` lance. La clave en claro
   * JAMÁS se persiste, loguea ni serializa.
   */
  async withDecryptedEfirma<T>(
    creds: TenantSatCredentials,
    fn: (material: { key: Buffer; password: Buffer }) => Promise<T>,
  ): Promise<T> {
    // 1. Abrir la DEK vía KMS (única llamada de red)
    const { Plaintext: dek } = await this.kms.send(
      new DecryptCommand({ CiphertextBlob: creds.dekWrapped, KeyId: creds.kmsKeyArn }),
    );
    const dekBuf = Buffer.from(dek!);

    const key = this.aesGcmDecrypt(dekBuf, creds.keyEncrypted, creds.keyIv, creds.keyAuthTag);
    const password = this.aesGcmDecrypt(dekBuf, creds.pwdEncrypted, creds.pwdIv, creds.pwdAuthTag);
    dekBuf.fill(0);

    try {
      return await fn({ key, password });
    } finally {
      key.fill(0);       // zeroing: el material no sobrevive al scope
      password.fill(0);
    }
  }

  private aesGcmDecrypt(dek: Buffer, data: Buffer, iv: Buffer, tag: Buffer): Buffer {
    const d = createDecipheriv('aes-256-gcm', dek, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]);
  }
}
```

Controles complementarios: rotación anual de CMK (KMS re-wrap sin re-cifrar datos), audit trail de cada `kms:Decrypt` en CloudTrail correlacionado con `tenant_id` via encryption context (`EncryptionContext: { tenant_id }`), y alarma si un principal distinto al worker-role llama Decrypt.

---

## FASE 2: MASTERCLASS DE POSTGRESQL

### 2.1 Multi-tenancy: Shared DB + Row-Level Security

**Decisión: una sola base, `tenant_id UUID NOT NULL` en toda tabla de datos, RLS forzado.** Esquemas separados por tenant no escalan a miles de contribuyentes (autovacuum, migraciones ×N, connection pooling roto, catálogo pg gigante). RLS da aislamiento *dentro* del motor: aunque un bug de aplicación omita el `WHERE`, Postgres no devuelve filas ajenas.

```sql
-- Rol de runtime SIN bypass de RLS (nunca conectar la app como superuser/owner)
CREATE ROLE app_runtime LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Patrón aplicado a TODA tabla de datos:
ALTER TABLE cfdis ENABLE ROW LEVEL SECURITY;
ALTER TABLE cfdis FORCE ROW LEVEL SECURITY;  -- aplica incluso al owner

CREATE POLICY tenant_isolation ON cfdis
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
```

En NestJS, cada unidad de trabajo corre dentro de una transacción que fija el tenant con `SET LOCAL` (muere con la transacción — seguro con PgBouncer en modo transaction):

```typescript
@Injectable()
export class TenantDb {
  constructor(@Inject(PG_POOL) private pool: Pool) {}

  async run<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${assertUuid(tenantId)}'`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
```

### 2.2 Tabla core `cfdis` (CFDI 4.0): columnas vs JSONB

Criterio de diseño: **a columna indexada va todo lo que se filtra, agrupa o cruza** (RFCs, UUID, fechas, montos, tipo, estatus); **a JSONB va lo que solo se lee al mostrar el detalle** (conceptos, impuestos desglosados por concepto, CFDIs relacionados, addenda). El XML crudo **no** vive en Postgres — vive en S3; la tabla guarda el puntero.

```sql
CREATE TABLE cfdis (
  tenant_id        UUID        NOT NULL,
  id               UUID        NOT NULL DEFAULT gen_random_uuid(),
  uuid_fiscal      UUID        NOT NULL,                 -- folio fiscal del TFD
  version          TEXT        NOT NULL DEFAULT '4.0',
  tipo             CHAR(1)     NOT NULL CHECK (tipo IN ('I','E','P','N','T')),
  direccion        TEXT        NOT NULL CHECK (direccion IN ('emitido','recibido')),

  emisor_rfc       VARCHAR(13) NOT NULL,
  emisor_nombre    TEXT,
  receptor_rfc     VARCHAR(13) NOT NULL,
  receptor_nombre  TEXT,
  uso_cfdi         VARCHAR(4),
  regimen_emisor   VARCHAR(4),

  fecha_emision    TIMESTAMPTZ NOT NULL,
  fecha_timbrado   TIMESTAMPTZ NOT NULL,

  metodo_pago      CHAR(3)     CHECK (metodo_pago IN ('PUE','PPD')),  -- NULL en tipo P
  forma_pago       VARCHAR(3),
  moneda           CHAR(3)     NOT NULL DEFAULT 'MXN',
  tipo_cambio      NUMERIC(14,6),

  subtotal         NUMERIC(18,6) NOT NULL,
  descuento        NUMERIC(18,6) NOT NULL DEFAULT 0,
  total            NUMERIC(18,6) NOT NULL,
  total_mxn        NUMERIC(18,2) GENERATED ALWAYS AS
                     (ROUND(total * COALESCE(tipo_cambio, 1), 2)) STORED,
  iva_trasladado   NUMERIC(18,6),
  iva_retenido     NUMERIC(18,6),
  isr_retenido     NUMERIC(18,6),
  ieps             NUMERIC(18,6),

  estatus_sat      TEXT NOT NULL DEFAULT 'vigente'
                     CHECK (estatus_sat IN ('vigente','cancelado','en_proceso_cancelacion')),
  fecha_cancelacion TIMESTAMPTZ,

  -- Detalle no filtrable → JSONB (conceptos, traslados/retenciones por concepto,
  -- CfdiRelacionados, InformacionGlobal, addenda ya normalizada a JSON)
  detalle          JSONB NOT NULL,

  xml_s3_key       TEXT  NOT NULL,      -- el XML crudo vive en S3, no aquí
  xml_sha256       BYTEA NOT NULL,      -- integridad + dedupe

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id, fecha_emision)   -- fecha_emision: requerido por partición
) PARTITION BY RANGE (fecha_emision);

-- Unicidad real de un CFDI dentro del tenant:
CREATE UNIQUE INDEX ux_cfdis_uuid ON cfdis (tenant_id, uuid_fiscal, fecha_emision);

-- Índices de trabajo (se crean en cada partición automáticamente):
CREATE INDEX ix_cfdis_emisor    ON cfdis (tenant_id, emisor_rfc, fecha_emision DESC);
CREATE INDEX ix_cfdis_receptor  ON cfdis (tenant_id, receptor_rfc, fecha_emision DESC);
CREATE INDEX ix_cfdis_pendiente ON cfdis (tenant_id, fecha_emision)
  WHERE metodo_pago = 'PPD' AND estatus_sat = 'vigente';   -- parcial: solo lo conciliable
CREATE INDEX ix_cfdis_detalle_gin ON cfdis USING GIN (detalle jsonb_path_ops);
```

Notas de ingeniería:
- `NUMERIC`, jamás `FLOAT`, para dinero — CFDI exige exactitud a 6 decimales.
- El índice **parcial** sobre PPD vigentes es el que sostiene el motor de conciliación: la tabla puede tener 100M filas, pero el índice solo contiene las facturas que aún importan.
- `jsonb_path_ops` (no el default) para el GIN: mitad de tamaño, más rápido para `@>`, que es el único operador que usamos sobre `detalle`.

### 2.3 El Motor de Impuestos: PUE/PPD vs Complementos de Pago (REP)

La relación es **Many-to-Many con atributos**: un REP (tipo P) paga N facturas PPD; una factura PPD se liquida con M pagos parciales. El complemento trae por cada documento relacionado su parcialidad, saldo anterior e importe pagado. Eso es una tabla puente con payload, no un simple join table:

```sql
-- Cada nodo Pago20:Pago del complemento (un REP puede traer varios pagos)
CREATE TABLE rep_pagos (
  tenant_id        UUID NOT NULL,
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  cfdi_rep_id      UUID NOT NULL,                -- FK al CFDI tipo 'P'
  rep_fecha_em     TIMESTAMPTZ NOT NULL,         -- para la FK compuesta a tabla particionada
  fecha_pago       TIMESTAMPTZ NOT NULL,
  forma_pago       VARCHAR(3) NOT NULL,
  moneda           CHAR(3) NOT NULL,
  tipo_cambio      NUMERIC(14,6),
  monto            NUMERIC(18,6) NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, cfdi_rep_id, rep_fecha_em)
    REFERENCES cfdis (tenant_id, id, fecha_emision)
);

-- Cada DoctoRelacionado: la línea que amarra pago ↔ factura PPD
CREATE TABLE rep_documentos_relacionados (
  tenant_id           UUID NOT NULL,
  id                  UUID NOT NULL DEFAULT gen_random_uuid(),
  rep_pago_id         UUID NOT NULL,
  uuid_factura        UUID NOT NULL,   -- UUID fiscal declarado en el complemento.
                                       -- OJO: puede referir una factura que AÚN no hemos
                                       -- descargado → se liga por UUID, no por FK dura.
  cfdi_factura_id     UUID,            -- se resuelve async cuando la factura llega
  num_parcialidad     INT     NOT NULL CHECK (num_parcialidad >= 1),
  saldo_anterior      NUMERIC(18,6) NOT NULL,
  importe_pagado      NUMERIC(18,6) NOT NULL,
  saldo_insoluto      NUMERIC(18,6) NOT NULL,
  objeto_impuesto     VARCHAR(2),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, rep_pago_id) REFERENCES rep_pagos (tenant_id, id),
  CONSTRAINT ck_saldos CHECK (saldo_insoluto = saldo_anterior - importe_pagado)
);

CREATE INDEX ix_repdoc_por_factura ON rep_documentos_relacionados (tenant_id, uuid_factura);
CREATE INDEX ix_repdoc_sin_resolver ON rep_documentos_relacionados (tenant_id)
  WHERE cfdi_factura_id IS NULL;   -- backlog de vinculación pendiente
```

La decisión clave: `uuid_factura` es el vínculo **lógico** (viene del XML) y `cfdi_factura_id` el vínculo **físico** que un worker resuelve después — porque en la vida real el REP frecuentemente se descarga *antes* que la factura que paga (o la factura es de otro periodo). Una FK dura aquí rompería la ingesta.

**El saldo insoluto vivo de cada PPD** se materializa (no se calcula al vuelo sobre millones de filas):

```sql
CREATE MATERIALIZED VIEW mv_ppd_saldos AS
SELECT
  c.tenant_id,
  c.id            AS cfdi_id,
  c.uuid_fiscal,
  c.total_mxn,
  COALESCE(SUM(dr.importe_pagado * COALESCE(p.tipo_cambio,1)), 0)::numeric(18,2) AS pagado_mxn,
  (c.total_mxn - COALESCE(SUM(dr.importe_pagado * COALESCE(p.tipo_cambio,1)), 0))::numeric(18,2)
                  AS saldo_mxn,
  MAX(p.fecha_pago) AS ultimo_pago
FROM cfdis c
LEFT JOIN rep_documentos_relacionados dr
       ON dr.tenant_id = c.tenant_id AND dr.uuid_factura = c.uuid_fiscal
LEFT JOIN rep_pagos p
       ON p.tenant_id = dr.tenant_id AND p.id = dr.rep_pago_id
WHERE c.metodo_pago = 'PPD' AND c.estatus_sat = 'vigente'
GROUP BY c.tenant_id, c.id, c.uuid_fiscal, c.total_mxn;

CREATE UNIQUE INDEX ux_mv_ppd ON mv_ppd_saldos (tenant_id, cfdi_id); -- habilita CONCURRENTLY
-- Refresh: REFRESH MATERIALIZED VIEW CONCURRENTLY mv_ppd_saldos; (cron cada 15 min)
```

### 2.4 Particionamiento por rango de fecha

Con ~5-20M de CFDI/año agregados, la tabla monolítica muere: autovacuum eterno, índices que no caben en RAM, `DELETE` de retención imposible. Partición mensual por `fecha_emision`:

```sql
-- Las particiones se crean por adelantado vía job (pg_partman o script propio):
CREATE TABLE cfdis_2026_07 PARTITION OF cfdis
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE cfdis_2026_08 PARTITION OF cfdis
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Partición default como red de seguridad (CFDIs con fechas absurdas no tiran el INSERT):
CREATE TABLE cfdis_default PARTITION OF cfdis DEFAULT;

-- Función idempotente que el cron mensual ejecuta (crea el mes M+2 por adelantado):
CREATE OR REPLACE FUNCTION ensure_cfdis_partition(p_month DATE) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  part_name TEXT := 'cfdis_' || to_char(p_month, 'YYYY_MM');
  from_d    DATE := date_trunc('month', p_month);
  to_d      DATE := from_d + INTERVAL '1 month';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF cfdis FOR VALUES FROM (%L) TO (%L)',
      part_name, from_d, to_d
    );
  END IF;
END $$;
```

Beneficios medibles: toda consulta con rango de fechas hace **partition pruning** (lee 1-3 particiones, no 60); `VACUUM` opera por partición; la retención de datos históricos es `DETACH PARTITION` + archivado a S3 (milisegundos, cero bloat), jamás `DELETE` masivo.

---

## FASE 3: INGESTA DE DATOS, COLAS Y WORKERS

### 3.1 Topología de colas (BullMQ + Redis)

Una cola por *tipo de trabajo*, nunca una cola global — cada tipo tiene su propia concurrencia, rate limit y política de reintento:

| Cola | Trabajo | Concurrencia/worker | Rate limit | Attempts |
|---|---|---|---|---|
| `sat-solicitud` | Crear solicitud en WS Descarga Masiva | 4 | 20/min (cortesía SAT) | 8 |
| `sat-verificacion` | Poll de estado de solicitud | 8 | 60/min | 20 (delayed) |
| `sat-paquete` | Descargar ZIP de paquetes | 4 | — | 5 |
| `xml-parse` | Descomprimir + parsear + upsert | 16 | — | 3 |
| `pdf-render` | Representación impresa | 4 (proceso aparte) | — | 3 |
| `efos-cruce` | Cruce retroactivo 69-B | 1 | — | 2 |

```typescript
// sat-download.producer.ts
@Injectable()
export class SatDownloadProducer {
  constructor(@InjectQueue('sat-solicitud') private q: Queue<SolicitudJob>) {}

  async solicitarDescarga(tenantId: string, params: RangoDescarga) {
    // jobId determinista = idempotencia: re-encolar el mismo rango no duplica
    const jobId = `sol:${tenantId}:${params.tipo}:${params.desde}:${params.hasta}`;
    await this.q.add('crear-solicitud', { tenantId, ...params }, {
      jobId,
      attempts: 8,
      backoff: { type: 'exponential', delay: 30_000 }, // 30s→1m→2m→4m→8m→16m→32m→64m
      removeOnComplete: { age: 86_400, count: 5_000 },
      removeOnFail: false,   // los fallidos se conservan para la DLQ
    });
  }
}
```

```typescript
// sat-solicitud.consumer.ts
@Processor('sat-solicitud', { concurrency: 4, limiter: { max: 20, duration: 60_000 } })
export class SatSolicitudConsumer extends WorkerHost {
  constructor(
    private readonly sat: SatWsClient,
    private readonly crypto: CryptoService,
    private readonly creds: CredentialsRepo,
    @InjectQueue('sat-verificacion') private verifQ: Queue,
  ) { super(); }

  async process(job: Job<SolicitudJob>) {
    const creds = await this.creds.forTenant(job.data.tenantId);

    const idSolicitud = await this.crypto.withDecryptedEfirma(creds, (m) =>
      this.sat.crearSolicitud({ cer: creds.cerDer, key: m.key, pwd: m.password, ...job.data }),
    );

    // Encadenar verificación con delay inicial: el SAT tarda de minutos a horas
    await this.verifQ.add('verificar', { ...job.data, idSolicitud }, {
      jobId: `ver:${idSolicitud}`,
      delay: 120_000,
      attempts: 20,
      backoff: { type: 'custom' },   // ver estrategia adaptativa abajo
    });
    return { idSolicitud };
  }
}
```

**El pipeline completo es una cadena de colas**, no un job monolítico: `solicitud → verificación (polling con backoff) → descarga de paquetes → parseo → (opcional) render PDF`. Cada eslabón es idempotente y reanudable: si el proceso muere descargando el paquete 3 de 7, el reintento retoma exactamente ahí porque el estado (`paquetes_descargados`) vive en Postgres, no en memoria.

### 3.2 Resiliencia: backoff adaptativo y Dead Letter Queue

El WS del SAT falla por intermitencia (timeouts, HTML de mantenimiento en vez de SOAP, `500` aleatorios). Dos clases de error exigen tratos distintos:

```typescript
// Clasificación estricta: NUNCA reintentar errores permanentes
export class SatPermanentError extends UnrecoverableError {}  // BullMQ no reintenta
export class SatTransientError extends Error {}               // reintenta con backoff

// En el cliente SAT:
if (soapFault?.code === '305') throw new SatPermanentError('e.firma inválida o vencida');
if (res.status >= 500 || isTimeout(err)) throw new SatTransientError(err.message);
```

```typescript
// worker settings — backoff custom: exponencial + jitter, y "castigo" en ventana de mantenimiento
new Worker('sat-verificacion', processor, {
  settings: {
    backoffStrategy: (attempts: number, _type, err) => {
      if (err instanceof SatMaintenanceError) return 30 * 60_000;      // SAT caído: 30 min fijos
      const base = Math.min(2 ** attempts * 15_000, 20 * 60_000);      // cap 20 min
      return base / 2 + Math.floor(Math.random() * (base / 2));        // full jitter
    },
  },
});
```

**DLQ explícita** (BullMQ no la trae de fábrica): un listener global mueve los jobs agotados a una cola `dead-letter` con todo el contexto, y esa cola alimenta alertas + un endpoint de re-drive manual:

```typescript
@Injectable()
export class DlqService implements OnModuleInit {
  constructor(
    @InjectQueue('dead-letter') private dlq: Queue,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit() {
    for (const name of ['sat-solicitud', 'sat-verificacion', 'sat-paquete', 'xml-parse']) {
      const events = new QueueEvents(name, { connection: redis });
      events.on('failed', async ({ jobId, failedReason }) => {
        const job = await Job.fromId(this.queues[name], jobId);
        if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return; // aún reintentará
        await this.dlq.add('dead', {
          origin: name, jobId, data: job.data, failedReason,
          stacktrace: job.stacktrace?.slice(0, 3), diedAt: new Date().toISOString(),
        });
        this.metrics.increment('dlq.jobs', { queue: name });
        await job.remove();
      });
    }
  }

  /** Re-drive: reencola en la cola origen con attempts frescos (post-incidente SAT). */
  async redrive(dlqJobId: string) { /* ... */ }
}
```

Regla operativa: **DLQ > 0 es una alerta paginable durante días 1-17**; fuera de esos días es un ticket.

### 3.3 Parseo masivo de XML sin fugas de memoria

Los paquetes del SAT llegan como ZIP con hasta ~200k XML. Los tres errores que matan Node aquí: cargar el ZIP entero a memoria, `Promise.all` sobre 200k promesas, y acumular los objetos parseados en un array. El diseño correcto: **streaming de punta a punta con concurrencia acotada y flush por lotes**.

```typescript
import { Parse } from 'unzipper';           // streaming unzip: entry por entry
import { XMLParser } from 'fast-xml-parser';
import pLimit from 'p-limit';

@Processor('xml-parse', { concurrency: 2 })  // 2 ZIPs simultáneos por proceso, no más
export class XmlParseConsumer extends WorkerHost {
  private readonly parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '',
    numberParseOptions: { leadingZeros: false, hex: false }, // ¡RFCs y folios son strings!
    isArray: (name) => ['Concepto', 'Traslado', 'Retencion', 'Pago', 'DoctoRelacionado',
                        'CfdiRelacionados'].includes(name),
  });

  async process(job: Job<PaqueteJob>) {
    const zipStream = await this.s3.getObjectStream(job.data.paqueteS3Key);
    const limit = pLimit(24);          // presión acotada sobre S3 + CPU
    const batch: CfdiRow[] = [];
    let procesados = 0;

    for await (const entry of zipStream.pipe(Parse({ forceStream: true }))) {
      if (!entry.path.endsWith('.xml')) { entry.autodrain(); continue; }

      const xmlBuf = await entry.buffer();      // UN xml (~5-50KB), no el ZIP entero

      await limit(async () => {
        const doc = this.parser.parse(xmlBuf.toString('utf8'));
        const row = mapCfdi40(doc, job.data.tenantId);      // extracción pura, sin I/O
        row.xmlS3Key = await this.s3.putXml(row, xmlBuf);   // XML crudo → S3
        batch.push(row);
      });

      // Flush por lotes: el array NUNCA crece sin límite
      if (batch.length >= 500) {
        await this.upsertBatch(batch.splice(0, batch.length));
        procesados += 500;
        await job.updateProgress(procesados);   // visibilidad + evita stall detection
      }
    }
    await limit(() => Promise.resolve());       // drenar in-flight
    if (batch.length) await this.upsertBatch(batch.splice(0));
    return { procesados };
  }

  /** UPSERT idempotente: re-procesar un paquete no duplica CFDIs. */
  private async upsertBatch(rows: CfdiRow[]) {
    await this.db.raw(
      `INSERT INTO cfdis (...) SELECT * FROM jsonb_populate_recordset(null::cfdis, ?)
       ON CONFLICT (tenant_id, uuid_fiscal, fecha_emision) DO UPDATE
         SET estatus_sat = EXCLUDED.estatus_sat, fecha_cancelacion = EXCLUDED.fecha_cancelacion`,
      [JSON.stringify(rows)],
    );
  }
}
```

Puntos no negociables:
- **`concurrency: 2` en el processor, `pLimit(24)` adentro**: la concurrencia útil está en los XML individuales, no en abrir 16 ZIPs a la vez (eso es 16× la memoria pico).
- `numberParseOptions` desactivado para campos identidad: `fast-xml-parser` convierte `"0012"` en `12` — un RFC o folio corrompido silenciosamente es un bug fiscal.
- El proceso de parseo corre con `--max-old-space-size` explícito y alarma sobre `process.memoryUsage().heapUsed`; si un ZIP patológico dispara el heap, muere ese job (reintenta acotado), no el worker completo.

---

## FASE 4: CRUCE MASIVO DE EFOS (ART. 69-B) Y CRONJOBS

### 4.1 El problema

El SAT publica periódicamente la lista 69-B (presuntos, desvirtuados, definitivos, sentencia favorable). Cada actualización obliga a responder: **¿alguno de mis clientes tiene operaciones —históricas, de cualquier año— con un RFC recién listado?** Eso es cruzar ~15k RFCs contra cientos de millones de filas de CFDI, para miles de tenants, sin tumbar la base transaccional.

### 4.2 Ingesta del CSV (cron + lock distribuido)

```typescript
@Injectable()
export class EfosIngestService {
  private readonly logger = new Logger(EfosIngestService.name);

  constructor(
    private readonly redlock: RedlockService,
    @InjectQueue('efos-cruce') private cruceQ: Queue,
    private readonly db: DbService,
  ) {}

  // 06:30 CDMX, diario. El DOF/SAT no publica con horario fijo → se checa a diario
  // y solo se procesa si el contenido cambió (hash).
  @Cron('0 30 6 * * *', { timeZone: 'America/Mexico_City' })
  async refreshEfosList() {
    // Lock distribuido: aunque haya N workers, corre exactamente uno
    await this.redlock.using(['lock:efos-ingest'], 15 * 60_000, async () => {
      const csv = await this.descargarCsvSat();          // http + retry propio
      const hash = sha256(csv);
      if (await this.db.yaProcesado(hash)) return;

      // 1. Staging: COPY al vuelo (no INSERTs fila por fila: son ~15k filas, COPY tarda ms)
      await this.db.raw('TRUNCATE efos_staging');
      await this.copyFromCsv('efos_staging', csv);

      // 2. Merge versionado: detecta ALTAS y CAMBIOS DE ESTATUS
      const delta = await this.db.raw(`
        WITH merged AS (
          INSERT INTO efos_rfcs AS e (rfc, situacion, fecha_publicacion, list_hash)
          SELECT rfc, situacion, fecha_publicacion, :hash FROM efos_staging
          ON CONFLICT (rfc) DO UPDATE
            SET situacion = EXCLUDED.situacion,
                fecha_publicacion = EXCLUDED.fecha_publicacion,
                list_hash = EXCLUDED.list_hash
            WHERE e.situacion IS DISTINCT FROM EXCLUDED.situacion
          RETURNING rfc, situacion, (xmax = 0) AS es_alta
        ) SELECT * FROM merged
      `, { hash });

      if (delta.rows.length) {
        // 3. Solo los RFCs nuevos/cambiados disparan el cruce retroactivo
        await this.cruceQ.add('cruce-retroactivo',
          { rfcs: delta.rows.map(r => r.rfc), listHash: hash },
          { jobId: `cruce:${hash}` });
      }
      this.logger.log(`EFOS: ${delta.rows.length} RFCs nuevos/cambiados`);
    });
  }
}
```

### 4.3 Cruce retroactivo: estrategia de índices y ejecución

**Estrategia de índice: B-Tree, no Hash.** El join es igualdad pura y Hash sería candidato, pero: (a) el B-Tree compuesto `(emisor_rfc, tenant_id, fecha_emision)` sirve además a las consultas de listado por proveedor, (b) los índices Hash no soportan index-only scans ni multicolumna. Un solo índice paga dos casos de uso.

El planner resuelve el cruce como **Nested Loop de 15k probes contra el B-Tree** (no un hash join de 100M filas), porque la lista delta es diminuta comparada con `cfdis`. La clave es dárselo masticado:

```sql
-- Índices que sostienen el cruce (ya existen por Fase 2, se listan por claridad):
-- ix_cfdis_emisor    (tenant_id, emisor_rfc, fecha_emision DESC)
-- ix_cfdis_receptor  (tenant_id, receptor_rfc, fecha_emision DESC)
-- PROBLEMA: el cruce EFOS entra "por el RFC", sin tenant. Índice adicional global:
CREATE INDEX CONCURRENTLY ix_cfdis_emisor_global ON cfdis (emisor_rfc)
  INCLUDE (tenant_id, uuid_fiscal, total_mxn, fecha_emision);
-- INCLUDE → index-only scan: el cruce ni siquiera toca el heap de la tabla.

-- Tabla de resultados (la "bandeja de riesgo" que consume el producto):
CREATE TABLE efos_matches (
  tenant_id      UUID NOT NULL,
  id             UUID NOT NULL DEFAULT gen_random_uuid(),
  cfdi_uuid      UUID NOT NULL,
  rfc_efos       VARCHAR(13) NOT NULL,
  rol            TEXT NOT NULL CHECK (rol IN ('emisor','receptor')),
  situacion      TEXT NOT NULL,          -- presunto | definitivo | ...
  monto_mxn      NUMERIC(18,2) NOT NULL,
  fecha_cfdi     TIMESTAMPTZ NOT NULL,
  detectado_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  list_hash      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, cfdi_uuid, rfc_efos, situacion)   -- idempotencia del cruce
);
```

El worker ejecuta el cruce como **SQL crudo por lotes de RFCs**, fuera del ORM, con sesión configurada para trabajo pesado:

```typescript
@Processor('efos-cruce', { concurrency: 1 })   // UNO. Es un batch pesado, no un stream.
export class EfosCruceConsumer extends WorkerHost {
  async process(job: Job<CruceJob>) {
    const { rfcs, listHash } = job.data;

    // Conexión dedicada del pool "batch" (statement_timeout alto, work_mem alto)
    await this.db.onBatchConnection(async (c) => {
      await c.query(`SET LOCAL work_mem = '256MB'`);
      await c.query(`SET LOCAL statement_timeout = '10min'`);

      for (const lote of chunk(rfcs, 500)) {           // lotes: commits acotados, progreso real
        await c.query(`
          INSERT INTO efos_matches
            (tenant_id, cfdi_uuid, rfc_efos, rol, situacion, monto_mxn, fecha_cfdi, list_hash)
          SELECT c.tenant_id, c.uuid_fiscal, e.rfc, 'emisor', e.situacion,
                 c.total_mxn, c.fecha_emision, $2
          FROM efos_rfcs e
          JOIN cfdis c ON c.emisor_rfc = e.rfc          -- probe sobre ix_cfdis_emisor_global
          WHERE e.rfc = ANY($1) AND c.direccion = 'recibido'
          ON CONFLICT (tenant_id, cfdi_uuid, rfc_efos, situacion) DO NOTHING
        `, [lote, listHash]);
        // (query gemela para rol='receptor' sobre ix_cfdis_receptor_global)
        await job.updateProgress({ done: lote.length });
      }
    });

    // Al terminar: evento por tenant afectado → notificaciones
    await this.notifQ.add('efos-alert-fanout', { listHash });
  }
}
```

Decisiones que hacen esto viable a escala:
1. **Cruce solo del delta** (RFCs nuevos/cambiados), nunca la lista completa: pasa de 15k probes a decenas.
2. El worker de cruce corre contra la **réplica de lectura** para el `SELECT` cuando el volumen lo exige (el `INSERT` va al primario); en la práctica, con index-only scans, el primario lo absorbe.
3. Este job **bypassa RLS deliberadamente** (rol `batch_runtime` con `BYPASSRLS`, solo montado en el worker de cruce): es un proceso de plataforma que escribe para todos los tenants. El acceso de lectura del producto a `efos_matches` sí pasa por RLS.

---

## FASE 5: GENERACIÓN DE PDF Y GESTIÓN DOCUMENTAL

### 5.1 Object Storage (S3): layout y acceso

```
s3://saas-fiscal-docs/
  {tenant_id}/xml/{yyyy}/{mm}/{uuid_fiscal}.xml          # inmutable, Object Lock (WORM)
  {tenant_id}/pdf/{yyyy}/{mm}/{uuid_fiscal}.pdf          # regenerable
  {tenant_id}/evidencias/{cfdi_uuid}/{evidencia_id}.jpg  # fotos de materialidad
```

- **XML con S3 Object Lock (governance) + versioning**: el XML es evidencia legal; nadie —ni la app— lo reescribe. Lifecycle: Standard → Standard-IA a los 90 días → Glacier Instant a los 3 años (obligación fiscal: 5 años).
- Cifrado SSE-KMS con la misma jerarquía de llaves de Fase 1; bucket policy niega todo `s3:GetObject` que no venga de los roles de la app.

**Subidas de evidencias con presigned POST** (el archivo nunca pasa por la API — cero carga en el event loop):

```typescript
@Injectable()
export class DocumentStorageService {
  constructor(private readonly s3 = new S3Client({})) {}

  /** La API solo firma; el cliente sube directo a S3. Condiciones estrictas. */
  async presignEvidenciaUpload(tenantId: string, cfdiUuid: string, mime: string) {
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(mime))
      throw new BadRequestException('Tipo no permitido');

    const key = `${tenantId}/evidencias/${cfdiUuid}/${randomUUID()}`;
    return createPresignedPost(this.s3, {
      Bucket: BUCKET,
      Key: key,
      Conditions: [
        ['content-length-range', 1, 15 * 1024 * 1024],   // máx 15MB
        ['eq', '$Content-Type', mime],
        ['starts-with', '$key', `${tenantId}/evidencias/`], // jamás fuera de su prefijo
      ],
      Expires: 300,
    });
  }

  /** Descargas: presigned GET de vida corta; nunca URLs públicas. */
  presignDownload(key: string) {
    return getSignedUrl(this.s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 120 });
  }
}
```

Tras el upload, S3 emite evento → SQS → un consumer valida el objeto (magic bytes reales, escaneo AV con ClamAV layer) y recién entonces registra la evidencia en Postgres. Un objeto subido pero no validado no existe para el dominio.

### 5.2 Generación dinámica de PDFs sin bloquear el Event Loop

**Decisión: dos motores según el documento.**

1. **Representación impresa del CFDI** (layout determinista: tabla de conceptos, QR del SAT, sellos): **pdfmake/PDFKit nativo**. Es 50-100× más barato que un browser, corre en el mismo proceso worker sin riesgo — la construcción es streaming y no bloquea.
2. **Reportes ricos con evidencias fotográficas embebidas** (expediente de materialidad, dictámenes): **Puppeteer con Chromium**, porque el layout HTML/CSS complejo a mano en PDFKit es inviable. Puppeteer vive en su **propio servicio worker** (imagen Docker dedicada con Chromium), jamás en el proceso de la API ni en el worker de parseo: un Chromium con fuga de memoria no puede llevarse a nadie más.

```typescript
// pdf-render.consumer.ts — pool de páginas, browser reciclado, cero zombie processes
@Processor('pdf-render', { concurrency: 4 })
export class PdfRenderConsumer extends WorkerHost implements OnModuleDestroy {
  private browser: Browser | null = null;
  private rendered = 0;

  private async getBrowser(): Promise<Browser> {
    // Reciclar el browser cada 200 renders: Chromium acumula memoria sí o sí
    if (!this.browser || this.rendered > 200) {
      await this.browser?.close().catch(() => {});
      this.browser = await puppeteer.launch({
        headless: 'shell',
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
               '--js-flags=--max-old-space-size=256'],
      });
      this.rendered = 0;
    }
    return this.browser;
  }

  async process(job: Job<RenderJob>) {
    const html = await this.templates.render('expediente-cfdi', await this.loadData(job.data));
    const page = await (await this.getBrowser()).newPage();
    try {
      // Las imágenes se inyectan como data-URI desde S3 — la página NO sale a la red
      await page.setRequestInterception(true);
      page.on('request', r => r.url().startsWith('data:') ? r.continue() : r.abort());

      await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
      const pdf = await page.pdf({ format: 'letter', printBackground: true, timeout: 30_000 });
      this.rendered++;

      const key = await this.storage.putPdf(job.data.tenantId, job.data.cfdiUuid, pdf);
      await this.db.marcarPdfListo(job.data.tenantId, job.data.cfdiUuid, key);
      return { key, bytes: pdf.length };
    } finally {
      await page.close().catch(() => {});   // la página SIEMPRE muere, pase lo que pase
    }
  }

  async onModuleDestroy() { await this.browser?.close().catch(() => {}); }
}
```

Los PDFs son **regenerables por diseño** (el estado canónico es XML + Postgres): si hay que cambiar la plantilla, se invalida el prefijo `pdf/` y se re-renderiza lazy bajo demanda — nunca un backfill masivo de entrada.

---

## FASE 6: OBSERVABILIDAD Y DESEMPEÑO

### 6.1 Logging estructurado + APM

- **Pino** (via `nestjs-pino`) como logger único: JSON a stdout, recolectado por el agente Datadog. Cero `console.log`.
- **Correlación end-to-end**: un `AsyncLocalStorage` porta `request_id`, `tenant_id` y `trace_id` desde el middleware HTTP hasta los logs de cualquier capa; al encolar un job, el producer copia el contexto al payload y el consumer lo restaura — **el trace sobrevive el salto por Redis**, que es donde el 80% de los APM se rompen.

```typescript
// tracing.interceptor.ts — latencia + contexto por endpoint hacia Datadog
@Injectable()
export class ApmInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = process.hrtime.bigint();
    const req = ctx.switchToHttp().getRequest();
    const span = tracer.startSpan('http.request', {
      tags: { 'tenant.id': req.tenantId, 'route': req.route?.path },
    });
    return next.handle().pipe(
      tap({
        next: () => span.finish(),
        error: (err) => {
          span.setTag('error', err);
          span.finish();
          this.metrics.histogram('http.latency_ms',
            Number(process.hrtime.bigint() - start) / 1e6,
            { route: req.route?.path, status: err.status ?? 500 });
        },
      }),
    );
  }
}
```

Reglas de higiene: los logs **jamás** contienen material criptográfico, CIEC, ni XML completos (redaction list en el serializer de Pino); `tenant_id` va en *todos* los logs — sin él, depurar un SaaS multi-tenant es arqueología.

### 6.2 Métricas clave (las que evitan caídas silenciosas)

| Métrica | Fuente | Umbral de alerta | Por qué importa |
|---|---|---|---|
| **Event Loop delay p99** | `perf_hooks.monitorEventLoopDelay()` | > 150ms sostenido | El asesino silencioso de Node: la API "está viva" pero responde en segundos |
| Heap used / RSS por proceso | `process.memoryUsage()` | > 80% del límite | Predice OOM-kill del contenedor antes de que pase |
| **BullMQ waiting + delayed por cola** | `queue.getJobCounts()` (gauge cada 15s) | `sat-*` > 5k; `xml-parse` > 20k | La profundidad de cola ES la salud del negocio en fin de mes |
| BullMQ job duration p95 por cola | evento `completed` | 3× la línea base | Detecta degradación del SAT o de Postgres antes que los usuarios |
| DLQ size | gauge | > 0 (días 1-17) | Trabajo fiscal perdido = incumplimiento del cliente |
| **Latencia/errores del WS SAT** | histograma en `SatWsClient` | error rate > 20% en 10 min | Distinguir "el SAT está caído" de "nosotros estamos rotos" — cambia el runbook completo |
| Postgres: conexiones activas vs pool | `pg_stat_activity` + métricas del pool | > 85% del pool | El pool agotado se manifiesta como "API lenta", no como error |
| Postgres: replication lag | `pg_stat_replication` | > 30s | Los reportes en réplica mostrarían datos viejos |
| Particiones futuras existentes | check nocturno | < 2 meses adelante | Un INSERT sin partición cae al default y degrada silenciosamente |
| Edad del último refresh de `mv_ppd_saldos` | tabla de control | > 45 min | Saldos PPD viejos = conciliación incorrecta mostrada al cliente |
| Edad de la lista EFOS cargada | gauge | > 72h | La detección 69-B desactualizada es riesgo legal directo del producto |
| Vencimiento de e.firma por tenant | query diaria | < 30 días | Sin e.firma vigente no hay descarga: avisar ANTES de que truene |

**Healthchecks en dos niveles**: `/healthz` (liveness: el proceso responde) y `/readyz` (readiness: Postgres + Redis alcanzables, event loop delay < 500ms). El worker no expone HTTP: su liveness es un heartbeat a Redis (`SET worker:{id} EX 60`) que un monitor externo vigila — un worker colgado con el proceso vivo es indetectable de otra forma.

### 6.3 SLOs de partida

- API transaccional: p95 < 300ms, error rate < 0.5%.
- Descarga SAT: 95% de solicitudes completadas < 6h (dependencia externa: se mide, se comunica, no se promete más).
- Parseo: un paquete de 50k XML procesado < 10 min por worker.
- Cruce EFOS: delta de lista publicada → matches visibles < 30 min.

---

## Apéndice: mapa de módulos NestJS

```
src/
├── main.ts                    # bootstrap dual (APP_ROLE=api|worker)
├── core/                      # ConfigModule, CryptoService, TenantDb, S3, Redis, Metrics
├── tenancy/                   # tenants, credenciales SAT, RLS context middleware
├── sat/                       # SatWsClient (SOAP), producers/consumers solicitud→paquete
├── ingestion/                 # xml-parse consumer, mapCfdi40, upsert batch
├── tax-engine/                # PUE/PPD, REP linking, mv_ppd_saldos refresh
├── efos/                      # ingest cron, cruce consumer, matches API
├── documents/                 # storage presign, pdf-render consumer, templates
├── notifications/             # fanout de alertas (email/webhook) post-cruce
└── observability/             # ApmInterceptor, LoggerModule (pino), health, queue metrics
```

**Principio rector del documento completo:** el estado canónico vive en Postgres, el trabajo pesado vive en colas, los secretos viven en KMS y solo existen en memoria durante milisegundos, y toda operación de ingesta es idempotente — porque contra el SAT, *todo* se reintenta.
