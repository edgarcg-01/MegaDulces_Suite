# Fase B — Integración con ERP Kepler (Postgres) — ⚠️ DEFERRED

> **Pivot 2026-05-26:** Kepler no existe todavía. La Fase B actual se construye desde cero en `commercial.*` — ver [`FASE_B_COMERCIAL_CORE.md`](FASE_B_COMERCIAL_CORE.md). Este documento queda como referencia para cuando aparezca un ERP externo y se requiera integrar vía FDW / sync.

---



**Duración estimada:** 3-5 semanas (1 dev) — **reducida desde 4-6** por simplificación con Postgres.
**Objetivo:** sincronizar catálogo de productos, precios, stock y clientes desde Kepler (Postgres) a nuestra plataforma.

> **Cambio mayor (2026-05-26)**: Kepler usa **PostgreSQL**, no SQL Server como se asumió originalmente. Esto simplifica MUCHO la integración. Ver ADR-009 (supersede de ADR-004).

---

## Pre-requisitos

- ✅ Fase A cerrada (Redis, BullMQ, Sentry, staging, observabilidad operativos).
- ✅ ADR-009 documentado (decisión: Postgres-to-Postgres).
- [ ] Confirmar versión de Postgres de Kepler.
- [ ] Confirmar si es la **misma instancia** que nuestra app o **separada**.
- [ ] Usuario read-only en el Postgres de Kepler con permiso SELECT en tablas relevantes.
- [ ] Decisión multi-tenancy tomada (afecta el schema de las tablas espejo).

---

## Decisión clave: ¿misma instancia Postgres o separadas?

**Caso A — Misma instancia (ideal):**
- Kepler y la app comparten servidor Postgres, en schemas separados.
- Acceso es solo cambiar de `search_path`: `kepler.articulos` vs `commercial.products`.
- Performance excelente, sin overhead de red.
- Permite JOINs cross-schema sin ninguna gimnasia.

**Caso B — Instancias separadas:**
- Kepler en su propio Postgres (lo más común con ERPs corporativos).
- Necesitamos `postgres_fdw` (Foreign Data Wrapper) para queries cruzadas.
- Foreign tables se ven como locales pero el driver hace la query remota.
- Latencia: depende de red entre las instancias (low si están en la misma región de cloud).

**Acción Sprint B.0**: confirmar con TI cuál es el caso, ajustar plan según corresponda.

---

## Sprints

### Sprint B.0 — Discovery + setup conexión (3-5 días)

> **Objetivo:** entender qué tiene Kepler antes de programar nada.

#### B.0.1 — Acceso al Postgres de Kepler
- Solicitar a TI:
  - Host + puerto del Postgres de Kepler.
  - Usuario read-only con permiso SELECT en las tablas relevantes.
  - Si requiere VPN o whitelist de IP, gestionar acceso desde Railway.
- Probar conexión con `psql` o pgAdmin localmente.

#### B.0.2 — Versión de Postgres + identificar schema de Kepler
```sql
-- En el Postgres de Kepler:
SELECT version();
SELECT schema_name FROM information_schema.schemata;
SELECT table_name FROM information_schema.tables WHERE table_schema = '<schema_kepler>';
```

#### B.0.3 — Mapear tablas relevantes
Kepler organiza sus datos así (revisar para esta instalación específica):
- **Productos**: típicamente `articulos`, `productos`, `inventario_maestro`.
- **Precios**: `precios`, `lista_precios`, `precios_por_cliente`.
- **Stock**: `existencias`, `inventario`, `stock_por_almacen`.
- **Clientes**: `clientes`, `cuentas_clientes`.

**Acción**: spot-check de 10-20 tablas. Documentar en sección "Mapeo Kepler" abajo.

#### B.0.4 — Decisión final: postgres_fdw vs sync vs ambos

Recomendación post-discovery:

| Entidad | Approach | Razón |
|---|---|---|
| **Productos** (catálogo) | Sync con BullMQ + tabla espejo | Cambia poco, lecturas son MUCHAS |
| **Precios** | Sync nocturno + invalidación manual | Cambia diariamente; eventual consistency aceptable |
| **Stock** | `postgres_fdw` live query | Real-time crítico en checkout |
| **Clientes** | Sync nocturno | Cambia poco, no requiere real-time |

---

### Sprint B.1 — Adapter de lectura (~1.5 sem)

> **Objetivo:** servicios NestJS que leen de Kepler vía Postgres.

#### B.1.1 — Pool de conexión a Kepler
Crear `apps/api/src/shared/kepler/kepler.connection.ts`:
```ts
import knex from 'knex';

export const KEPLER_KNEX = 'KEPLER_KNEX';

export const keplerKnexProvider = {
  provide: KEPLER_KNEX,
  useFactory: () => knex({
    client: 'pg',
    connection: {
      connectionString: process.env.KEPLER_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    },
    pool: { min: 1, max: 5 },
    searchPath: ['<schema_kepler>', 'public'],
  }),
};
```

#### B.1.2 — Módulo kepler-sync
Estructura:
```
apps/api/src/modules/kepler-sync/
├── kepler-sync.module.ts
├── services/
│   ├── kepler-products.service.ts
│   ├── kepler-prices.service.ts
│   ├── kepler-stock.service.ts (uses postgres_fdw foreign tables)
│   └── kepler-customers.service.ts
└── dto/
    ├── kepler-product.dto.ts
    └── kepler-customer.dto.ts
```

#### B.1.3 — KeplerProductsService.fetchAll()
```ts
@Injectable()
export class KeplerProductsService {
  constructor(@Inject(KEPLER_KNEX) private keplerKnex: Knex) {}

  async fetchAll(): Promise<KeplerProductDto[]> {
    return this.keplerKnex('articulos as a')
      .leftJoin('marcas as m', 'a.marca_id', 'm.id')
      .where('a.activo', true)
      .select(
        'a.id as kepler_id',
        'a.codigo_sku as sku',
        'a.descripcion as nombre',
        'm.nombre as marca',
        'a.peso',
      );
  }
}
```

> ⚠️ Nombres reales de tablas/columnas dependen del Sprint B.0.3.

#### B.1.4-B.1.6 — Servicios análogos
- `KeplerPricesService` → lista de precios por cliente.
- `KeplerCustomersService` → clientes con RFC, razón social, condiciones.
- `KeplerStockService` → ver sub-sprint B.1.7.

#### B.1.7 — Stock con postgres_fdw (live query)
**Solo si Kepler está en instancia separada.** Si está en la misma, se usa schema directamente.

Setup (corre una sola vez, idealmente como migración):
```sql
CREATE EXTENSION IF NOT EXISTS postgres_fdw;

CREATE SERVER kepler_server
  FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host 'kepler.host', dbname 'kepler', port '5432');

CREATE USER MAPPING FOR app_user
  SERVER kepler_server
  OPTIONS (user 'readonly_user', password '...');

IMPORT FOREIGN SCHEMA "<kepler_schema>"
  LIMIT TO (existencias, inventario)
  FROM SERVER kepler_server
  INTO kepler_fdw;
```

Después, queries del API usan `kepler_fdw.existencias` como si fueran locales.

```ts
@Injectable()
export class KeplerStockService {
  constructor(@Inject(KNEX_CONNECTION) private knex: Knex) {} // app knex, no Kepler knex
  async getStockBySKU(sku: string, almacenId?: string) {
    return this.knex('kepler_fdw.existencias')
      .where('codigo_sku', sku)
      .modify((qb) => almacenId && qb.where('almacen_id', almacenId))
      .first();
  }
}
```

---

### Sprint B.2 — Storage local + sync job (~1.5 sem)

> **Objetivo:** Postgres app es source of truth para data fría (productos, precios, clientes). Stock se lee live.

#### B.2.1 — Schema `commercial.*` en nuestra Postgres
Migración nueva:
```js
exports.up = async function(knex) {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS commercial');

  await knex.schema.withSchema('commercial').createTable('products', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('kepler_id').notNullable().unique();
    table.string('sku').notNullable().unique();
    table.string('nombre').notNullable();
    table.string('marca');
    table.string('categoria');
    table.decimal('peso', 10, 3);
    table.boolean('activo').defaultTo(true);
    table.string('imagen_url'); // gestionada localmente (Cloudinary)
    table.timestamp('synced_at');
    table.timestamps(true, true);
    table.index('sku');
    table.index('activo');
  });

  await knex.schema.withSchema('commercial').createTable('price_lists', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('kepler_id').unique();
    table.string('nombre').notNullable();
    table.timestamp('vigente_desde');
    table.timestamp('vigente_hasta');
    table.timestamps(true, true);
  });

  await knex.schema.withSchema('commercial').createTable('price_list_items', (table) => {
    table.uuid('price_list_id').references('id').inTable('commercial.price_lists').onDelete('CASCADE');
    table.uuid('product_id').references('id').inTable('commercial.products').onDelete('CASCADE');
    table.decimal('precio', 12, 2).notNullable();
    table.timestamp('synced_at');
    table.primary(['price_list_id', 'product_id']);
  });

  await knex.schema.withSchema('commercial').createTable('customers_b2b', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('kepler_id').unique();
    table.uuid('store_id').references('id').inTable('public.stores');
    table.string('rfc');
    table.string('razon_social');
    table.string('condicion_pago');
    table.decimal('limite_credito', 12, 2).defaultTo(0);
    table.uuid('price_list_id').references('id').inTable('commercial.price_lists');
    table.timestamps(true, true);
  });

  await knex.schema.withSchema('commercial').createTable('sync_runs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('entity').notNullable(); // 'products' | 'prices' | 'customers'
    table.timestamp('started_at').notNullable();
    table.timestamp('finished_at');
    table.string('status'); // 'running' | 'success' | 'error'
    table.integer('records_read').defaultTo(0);
    table.integer('records_upserted').defaultTo(0);
    table.text('error_message');
  });
};
```

Notar: **no creamos tabla `stocks`** porque stock se lee via `postgres_fdw` directamente (no necesita espejo local).

#### B.2.2 — Sync processor con BullMQ
```ts
@Processor('kepler-sync')
export class KeplerSyncProcessor extends WorkerHost {
  async process(job: Job) {
    if (job.name === 'sync-products') return this.syncProducts();
    if (job.name === 'sync-prices') return this.syncPrices();
    if (job.name === 'sync-customers') return this.syncCustomers();
  }

  private async syncProducts() {
    const run = await this.startRun('products');
    try {
      const fromKepler = await this.keplerProducts.fetchAll();
      let upserted = 0;
      for (const p of fromKepler) {
        await this.knex('commercial.products')
          .insert({ ...p, synced_at: new Date() })
          .onConflict('kepler_id').merge();
        upserted++;
      }
      await this.finishRun(run.id, 'success', fromKepler.length, upserted);
    } catch (err) {
      await this.finishRun(run.id, 'error', 0, 0, err.message);
      throw err;
    }
  }
}
```

#### B.2.3 — Cron nocturno
En `tasks.service.ts`:
```ts
@Cron('0 3 * * *')
async runKeplerSync() {
  await this.keplerQueue.add('sync-products', {});
  await this.keplerQueue.add('sync-prices', {});
  await this.keplerQueue.add('sync-customers', {});
}
```

#### B.2.4 — Endpoint admin para resync manual
```ts
@Post('admin/kepler/resync')
@RequirePermissions(Permission.ROLES_CONFIGURAR)
async triggerResync(@Body() body: { entity?: 'products' | 'prices' | 'customers' }) {
  if (body.entity) {
    await this.keplerQueue.add(`sync-${body.entity}`, {});
  } else {
    await this.keplerQueue.add('sync-products', {});
    await this.keplerQueue.add('sync-prices', {});
    await this.keplerQueue.add('sync-customers', {});
  }
  return { ok: true, message: 'Resync iniciado' };
}
```

#### B.2.5 — UI admin de monitoring
Vista en `apps/view/admin/kepler-sync`:
- Lista de últimos 50 sync runs con duración + status.
- Botón "Resync ahora" por entidad.
- Indicador visual de drift detectado.

---

### Sprint B.3 — Validación + checkpoint (3 días)

#### B.3.1 — Comparar conteos
```sql
-- En nuestra Postgres
SELECT COUNT(*) FROM commercial.products WHERE activo = true;

-- En Kepler (vía conexión separada)
SELECT COUNT(*) FROM articulos WHERE activo = true;
```
Match ± 2-3 (timing).

#### B.3.2 — Validar precios spot-check
10 SKUs aleatorios, comparar precio en lista A.

#### B.3.3 — Validar `postgres_fdw` para stock
Query a foreign table desde nuestra app, comparar con query directo a Kepler.

#### B.3.4 — Cerrar checkpoint
Entry en `03_LOG_REVISIONES.md`.

---

## Mapeo Kepler — DOCUMENTAR AQUÍ (post Sprint B.0.3)

### Tablas identificadas
| Concepto | Tabla Kepler | Columnas relevantes |
|---|---|---|
| Productos | _(por confirmar)_ | _(por confirmar)_ |
| Lista de precios | _(por confirmar)_ | _(por confirmar)_ |
| Stock | _(por confirmar)_ | _(por confirmar)_ |
| Clientes | _(por confirmar)_ | _(por confirmar)_ |

### Notas / particularidades de Kepler de Mega Dulces
_(por completar tras Sprint B.0)_

---

## Entregables al cierre de Fase B

- ✅ Schema `commercial.*` con tablas espejo.
- ✅ `postgres_fdw` configurado para queries de stock real-time.
- ✅ Sync nocturno operando para productos, precios, clientes.
- ✅ Endpoint admin para resync manual.
- ✅ UI admin de monitoring.
- ✅ Tabla `commercial.sync_runs` con historial.
- ✅ Mapeo Kepler documentado.
- ✅ ADR-009 actualizado con realidad final.

---

## Métricas de éxito

- Drift entre app y Kepler < 1% post-sync.
- Tiempo del sync completo < 15 min (más rápido que MSSQL).
- Latencia de query stock vía FDW < 100ms p95.
- Tasa de éxito de runs nocturnos > 95% durante 2 semanas.

---

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Sin acceso al Postgres de Kepler | Bloqueante absoluto. Escalar a sponsor. |
| `postgres_fdw` performance pobre con queries grandes | Fallback a sync local de stock |
| Kepler tiene tablas particionadas/raras | Discovery iterativo |
| Schema de Kepler cambia en upgrade | Adapter pattern + tests de regresión |
| Latencia de red entre Railway y Kepler | Considerar mover Kepler a misma región cloud |

---

## Cuándo se considera cerrada

Items de B.0, B.1, B.2, B.3 marcados ✅ + entry de cierre en `03_LOG_REVISIONES.md`.
