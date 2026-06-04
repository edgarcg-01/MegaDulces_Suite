# Fase L — Schema reorg (namespacing trade.* + cleanup)

**ADR base:** [ADR-015](../02_DECISIONES_ARQUITECTURA.md#adr-015--schema-reorg-namespacing-trade-product-master-único-en-catalog-y-split-de-god-services)

**Decisión arquitectónica clave:** schema único `trade.*` (no `field_ops`+`scoring` separados).

**Estimación revisada:** 1-2 sprints (mucho menos de lo planeado originalmente).

---

## Estado real (auditado 2026-06-04)

Trabajo previo ya hecho descubierto durante la auditoría:

| Schema | Estado | Comentario |
|---|---|---|
| `identity.*` | ✅ TABLAS canónicas | `users`, `tenants`, `role_permissions` |
| `catalog.*` | ✅ TABLAS canónicas | `products` (1199 en prod), `brands` (143), `categories`. **VIEWs en `public.*` para backward-compat** |
| `commercial.*` | ✅ TABLAS canónicas | 15 tablas con RLS |
| `logistics.*` | ✅ TABLAS canónicas | 17 tablas con RLS |
| `field_ops.*`, `scoring.*` | ⚠️ VIEWs muertas | Apuntan a `public.*` — se van a DROP en L.8 |
| **`public.*` (tablas trade)** | ⚠️ **TABLAS reales aún** | 14 tablas: `stores`, `zones`, `catalogs`, `daily_captures`, `daily_assignments`, `visits`, `exhibitions`, `exhibition_photos`, `valid_exhibition_combinations`, `scoring_config`, `scoring_config_versions`, `scoring_weights`, `rubric_criteria`, `rubric_levels` |

**Las 14 tablas trade YA tienen `tenant_id` + RLS forzada + `deleted_at`.** Solo falta moverlas físicamente al schema `trade.*`.

## Impact map de código

### Archivos que referencian `public.X` explícitamente (necesitan textual rename)

**Solo 12 archivos en `libs/commercial/*` + `libs/platform-core/*`** (L.5):

| Archivo | Tablas referenciadas | Refactor target |
|---|---|---|
| `libs/commercial/src/lib/commercial-pricing/commercial-pricing.service.ts` | `public.products`, `public.brands`, `public.categories`, `public.products_top_sellers` | `catalog.*` |
| `libs/commercial/src/lib/commercial-orders/commercial-orders.service.ts` | `public.products`, `public.brands` | `catalog.*` |
| `libs/commercial/src/lib/commercial-inventory/commercial-inventory.service.ts` | `public.products`, `public.brands` | `catalog.*` |
| `libs/commercial/src/lib/commercial-catalog-search/commercial-catalog-search.service.ts` | `public.products`, `public.brands` | `catalog.*` |
| `libs/commercial/src/lib/commercial-catalog-search/commercial-catalog-search.controller.ts` | `public.products` (comment) | `catalog.*` |
| `libs/commercial/src/lib/commercial-alerts/alerts-scanner.service.ts` | `public.products`, `public.brands` | `catalog.*` |
| `libs/commercial/src/lib/commercial-analytics/commercial-analytics.service.ts` | `public.products`, `public.brands`, `public.categories` | `catalog.*` |
| `libs/commercial/src/lib/commercial-recommendations/recommendations.service.ts` | `public.products`, `public.brands` | `catalog.*` |
| `libs/commercial/src/lib/commercial-products/commercial-products.service.ts` | `public.products` (comment) | `catalog.*` |
| `libs/commercial/src/lib/portal-ai-order/portal-ai-order.service.ts` | `public.products`, `public.brands` | `catalog.*` |
| `libs/commercial/src/lib/commercial-customers/commercial-customers.service.ts` | _(verificar — el grep falló inicialmente)_ | _(TBD)_ |
| `libs/platform-core/src/lib/ai-product-matcher/embedding-sync.service.ts` | `public.products` (comment) | `catalog.*` |

**Estos cambios son textuales** (`sed -i 's/public\.products/catalog.products/g'`-style). Las VIEWs `public.products`, `public.brands`, `public.categories` ya existen en Railway y siguen funcionando como backward-compat, así que **el refactor L.5 es opcional** — el sistema funciona como está.

### Archivos que usan `knex('table')` SIN schema prefix (95% del código trade)

Los services en `libs/trade/*` usan `knex('stores')`, `knex('daily_captures')`, etc. **sin prefijo**. Postgres resuelve via `search_path` (default `public`).

**Estrategia**: cuando movamos las tablas a `trade.*`, crearemos VIEWs en `public.*` (auto-updatable) con el mismo nombre. Las queries `knex('stores')` siguen resolviendo a la VIEW que delega a `trade.stores`. **Cero cambios de código necesarios en `libs/trade/*`**.

## FK cross-domain a tener en cuenta

Cuando movamos las tablas trade, hay 2 FKs **fuera del dominio** apuntando a ellas:

1. **`commercial.customers.store_id` → `public.stores`** (`fk_commercial_customers_tenant_store`)
2. **`identity.users.zona_id` → `public.zones`** (`fk_users_tenant_zona`)

Postgres actualiza estas FKs automáticamente al `ALTER TABLE SET SCHEMA` (son OID-based, no por nombre). No requiere acción adicional. Después del move apuntarán a `trade.stores` y `trade.zones` transparentemente.

## Estado granular

- ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD · ⚠️ BLOCKED · ❌ REVERTED

---

## Sub-sprints

### L.0 — Setup & safety nets ⬜

- [ ] L.0.1 Backup completo Railway prod (`pg_dump --format=custom --compress=9` → `database/backups/pre-fase-L-YYYYMMDD.dump`)
- [ ] L.0.2 Regression suite local — guardar baseline en `database/backups/regression-baseline-fase-L.txt`
- [ ] L.0.3 Inventario detallado de las 14 tablas trade en `public.*` ya está → `database/scripts/inventory-trade-tables.sql` y `fk-chains-trade.sql`

### L.1 — Crear schema `trade` ⬜

- [ ] L.1.1 Migration `CREATE SCHEMA IF NOT EXISTS trade`
- [ ] L.1.2 `GRANT USAGE ON SCHEMA trade TO app_runtime`
- [ ] L.1.3 `COMMENT ON SCHEMA trade IS 'Trade marketing: planograma + auditoría PdV. Multi-tenant via tenant_id + RLS forzada.'`
- [ ] L.1.4 Aplicar local + Railway

### L.2 — Mover las 14 tablas `public.X → trade.X` ⬜

**Estrategia transaccional**: TODO en un solo BEGIN/COMMIT. Postgres maneja FKs internas automáticamente (OID-based). Después del move, crear VIEWs backward-compat en `public.*`.

```sql
BEGIN;
-- 1. Mover tablas (orden no crítico dentro de la trx — Postgres lo resuelve)
ALTER TABLE public.zones                          SET SCHEMA trade;
ALTER TABLE public.catalogs                       SET SCHEMA trade;
ALTER TABLE public.stores                         SET SCHEMA trade;
ALTER TABLE public.scoring_config                 SET SCHEMA trade;
ALTER TABLE public.scoring_config_versions        SET SCHEMA trade;
ALTER TABLE public.scoring_weights                SET SCHEMA trade;
ALTER TABLE public.rubric_criteria                SET SCHEMA trade;
ALTER TABLE public.rubric_levels                  SET SCHEMA trade;
ALTER TABLE public.valid_exhibition_combinations  SET SCHEMA trade;
ALTER TABLE public.daily_assignments              SET SCHEMA trade;
ALTER TABLE public.daily_captures                 SET SCHEMA trade;
ALTER TABLE public.visits                         SET SCHEMA trade;
ALTER TABLE public.exhibitions                    SET SCHEMA trade;
ALTER TABLE public.exhibition_photos              SET SCHEMA trade;

-- 2. VIEWs backward-compat (auto-updatable porque son SELECT * simples)
CREATE VIEW public.zones                         AS SELECT * FROM trade.zones;
CREATE VIEW public.catalogs                      AS SELECT * FROM trade.catalogs;
CREATE VIEW public.stores                        AS SELECT * FROM trade.stores;
-- ... (las 14)

-- 3. Grants en las views (para que app_runtime lea/escriba)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zones TO app_runtime;
-- ... (las 14)

-- 4. Grants en las tablas en su nuevo schema
GRANT SELECT, INSERT, UPDATE, DELETE ON trade.zones TO app_runtime;
-- ... (las 14)
COMMIT;
```

Tareas:
- [ ] L.2.1 Crear migración Knex `database/migrations-newdb/YYYYMMDDHHMMSS_move_trade_tables_to_schema.js`
- [ ] L.2.2 Dry-run en local (con backup primero)
- [ ] L.2.3 Verificar: regression suite verde + smoke trade marketing (login → ver stores/zones/captures)
- [ ] L.2.4 Aplicar en Railway prod
- [ ] L.2.5 Verificar prod: portal trade marketing carga, capturas se pueden ver, scoring funciona

### L.3 — Backfill tenant_id + RLS forzada ✅ (YA HECHO)

Inventario confirmó que **las 14 tablas ya tienen** `tenant_id` + `deleted_at` + RLS enabled + RLS forced. Skip este sub-sprint.

### L.4 — Consolidar `catalog.products` ✅ (YA CASI HECHO)

Estado actual: `catalog.products` es TABLE canónica con 1199 rows; `public.products` es VIEW backward-compat.

Falta solo:
- [ ] L.4.1 Verificar drift: `public.products` (la tabla original era 38 cols, `catalog.products` puede tener menos). Si la VIEW funciona y nadie inserta `articulo` explícito, el orphan column no rompe.
- [ ] L.4.2 (Opcional) Drop column `articulo` de `catalog.products` si no se usa.

### L.5 — Refactor `commercial-*` para usar `catalog.*` directo ⬜

**Opcional pero recomendado** (mejora calidad de código, no cambia funcionalidad).

12 archivos a actualizar (textual rename `public.products` → `catalog.products`, etc):

- [ ] L.5.1 `commercial-pricing.service.ts`
- [ ] L.5.2 `commercial-orders.service.ts`
- [ ] L.5.3 `commercial-inventory.service.ts`
- [ ] L.5.4 `commercial-catalog-search.service.ts` + `.controller.ts`
- [ ] L.5.5 `commercial-alerts/alerts-scanner.service.ts`
- [ ] L.5.6 `commercial-analytics.service.ts`
- [ ] L.5.7 `commercial-recommendations.service.ts`
- [ ] L.5.8 `commercial-products.service.ts`
- [ ] L.5.9 `portal-ai-order.service.ts`
- [ ] L.5.10 `commercial-customers.service.ts` (verificar)
- [ ] L.5.11 `embedding-sync.service.ts` (platform-core)
- [ ] L.5.12 Build OK + regression verde

### L.6 — Crear `trade.planogram_skus` ⬜

- [ ] L.6.1 Migración:
  ```sql
  CREATE TABLE trade.planogram_skus (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES identity.tenants(id),
    product_id UUID NOT NULL REFERENCES catalog.products(id),
    sku VARCHAR(20) NOT NULL,
    orden_exhibicion INTEGER,
    categoria_exhibicion VARCHAR(100),
    posicion_shelf JSONB,
    vigente_desde DATE,
    vigente_hasta DATE,
    -- audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES identity.users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES identity.users(id),
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES identity.users(id),
    activo BOOLEAN GENERATED ALWAYS AS (deleted_at IS NULL) STORED,
    UNIQUE (tenant_id, sku)
  );
  ```
- [ ] L.6.2 RLS + grants + trigger auto_populate_tenant_id
- [ ] L.6.3 Importer `database/importers/planogram-skus.js`
- [ ] L.6.4 Importar los 1199 SKUs curados de Mega Dulces (desde lista o ERP)
- [ ] L.6.5 Update referencias en `libs/trade/*` para usar `trade.planogram_skus` en filtros de captura

### L.7 — Split `AlertsScannerService` ⬜

- [ ] L.7.1 Crear `commercial-alerts/low-stock-scanner.service.ts`
- [ ] L.7.2 Crear `commercial-alerts/vip-inactive-scanner.service.ts`
- [ ] L.7.3 Mover lógica desde `alerts-scanner.service.ts`
- [ ] L.7.4 Drop `alerts-scanner.service.ts` viejo
- [ ] L.7.5 Update tests + module providers

### L.8 — Cleanup ⬜

- [ ] L.8.1 Drop `field_ops.*` y `scoring.*` schemas viejos (eran VIEWs muertas)
- [ ] L.8.2 (Después de validar L.5 en prod por 1 sprint) Drop VIEWs `public.products/brands/categories` y forzar uso de `catalog.*` en todo el código
- [ ] L.8.3 (Después de validar L.2 en prod por 1 sprint) Drop VIEWs `public.X` para las tablas trade movidas

### L.9 — Validation final ⬜

- [ ] L.9.1 Regression suite local + prod 100% verde
- [ ] L.9.2 Smoke manual: login → trade dashboard → captura → portal cliente → vendor → televenta → logistics
- [ ] L.9.3 Commit + entry en `03_LOG_REVISIONES.md`

---

## Reglas de seguridad

- **Cada sub-sprint debe dejar prod funcionando.** Si un sub-sprint falla, rollback es trivial mientras existan las VIEWs.
- **NO TRUNCATE CASCADE jamás** en `identity.tenants` (lo aprendimos a la mala).
- **Backup antes de cada sub-sprint con cambios de schema** (L.1, L.2, L.6, L.8).
- **Regression suite verde antes de avanzar.**

## Rollback (por sub-sprint)

| Sub-sprint | Rollback |
|---|---|
| L.1 | `DROP SCHEMA trade` (vacío) |
| L.2 | `ALTER TABLE trade.X SET SCHEMA public` + `DROP VIEW public.X` (en orden inverso) |
| L.5 | `git revert` del commit con el rename |
| L.6 | `DROP TABLE trade.planogram_skus` |
| L.7 | `git revert` |
| L.8 | No reversible una vez aplicado — solo proceder cuando todo está estable |

## Próximo paso

**🔥 L.0 + L.1 + L.2 en una sesión:** backup → crear schema `trade` → mover 14 tablas + crear VIEWs backward-compat. Es la pieza crítica. Después L.4 (cleanup `articulo`) + L.6 (`planogram_skus`) + L.5 (refactor commercial) + L.7 (split alerts) + L.8 (cleanup final) pueden ir en sprints separados.
