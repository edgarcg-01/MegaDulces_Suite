# Runbook de cutover — WMS Estación de Recepción + Prevención de Inventarios

> **Qué despliega:** todo lo construido en la sesión 2026-08-17 (beta local, verificado con 5 smokes DB-directo = **84 asserts verde**), aún **sin push**.
> **Alcance:** Proyecto A — Estación de Recepción (Piezas 1+2+3) + Fase PREV (PREV.1 + PREV.2).
> **Regla de oro:** migraciones **antes** que redeploy; permisos **después** del deploy; re-login al final.

---

## 0. Qué entra (commits locales en `main`, sin push)

| Commit (tag) | Feature |
|---|---|
| `feat([WMS-REC.2])` ×2 | Auditor de recepción por caducidad (foto→OCR→semáforo + NC + scorecard) + UI de políticas |
| `feat([WMS-REC.1])` | Modo recepción por escaneo — Vale de entrada vivo |
| `feat([WMS-REC.3])` | Ubicación bin-level — auxiliar + put-away + FEFO físico |
| `feat([PREV.1])` | Expediente de investigación de diferencias + timeline del SKU |
| `feat([PREV.2])` | Monitoreo intensivo + ventanas de pérdida |

**Verificación local previa:** `run-all-tests` incluye los 5 smokes nuevos (`test-newdb-{receiving-auditor,receiving-session,bin-locations,inventory-investigation,inventory-monitoring}`), todos verde.

---

## 1. Migraciones a Railway (newdb) — **7, idempotentes**

Se aplican con el knexfile de la newdb apuntando a Railway (`DATABASE_URL_NEW` = URL del proxy `*.proxy.rlwy.net`, entorno `production` con SSL), igual que los batches RA/CB/CC:

```bash
# con DATABASE_URL_NEW = <newdb Railway>
npx knex migrate:latest --knexfile database/knexfile-newdb.js --env production
```

Orden (lo maneja knex por timestamp; `migrate:latest` sólo aplica pendientes):

1. `20260815120000_commercial_expiry_receiving_policy.js`
2. `20260815120100_commercial_receiving_lot_captures.js`
3. `20260817120000_commercial_receiving_sessions.js`
4. `20260817140000_commercial_bin_locations.js`
5. `20260817160000_commercial_inventory_investigations.js`
6. `20260817180000_commercial_inventory_monitoring.js`
7. `20260817200000_commercial_inventory_risk_index.js`

**Esperado:** `Batch N run: 7 migrations`. Cada una tiene guard `hasTable` (re-correr = no-op).
**Requisitos:** Postgres **≥15** (usan `NULLS NOT DISTINCT` en índices únicos) — Railway newdb es 16+, OK. Todas crean tablas `commercial.*` con RLS forzado + grant `app_runtime`, FKs a `identity.tenants` / `commercial.warehouses` / `catalog.products` (existen). **Sin** FDW ni boot-migrations → sin el gotcha de crash en arranque.
**Rollback:** cada mig tiene `down` (dropTableIfExists). No hay backfill destructivo.

---

## 2. Redeploy de código

Push de los commits a `main` → redeploy de **api** y **view** en Railway (Service ID `69f64078-1678-40f4-a266-a18b61a20cde`).

- El API expone los módulos nuevos vía `commercial-receiving` + `commercial-inventory` (ya wireados en `AppModule` bajo `ENABLE_MULTITENANT`).
- Si el deploy no dispara solo tras el push, `railway up` / redeploy manual del servicio (si el api queda atrás de HEAD → 404 en los endpoints nuevos; diagnosticar con `app_runtime` + git SHA del deploy).

**Orden:** migraciones (paso 1) **antes** del redeploy, para que el código nunca consulte una tabla inexistente.

---

## 3. Permisos (post-deploy) — **3 nuevos, restrictivos (sin seed)**

En `/admin/roles`, asignar y luego **re-login** (los permisos viven en el JWT):

| Permiso | A qué rol | Para qué |
|---|---|---|
| `COMMERCIAL_INVENTORY_RECIBIR` | almacén / recepción | Auditor de caducidad, Vales de entrada, put-away |
| `COMMERCIAL_PREVENTION_VER` | `prevencion_auditoria` | Ver expedientes + monitoreo |
| `COMMERCIAL_PREVENTION_GESTIONAR` | `prevencion_auditoria` | Abrir/clasificar/resolver + monitoreo |

- `COMMERCIAL_INVENTORY_ASIGNAR` (ya existía) se usa para administrar **bins** en Ubicaciones — confirmar que quien administra el layout lo tenga.
- **superadmin/admin** tienen `manage:all` → ven todo sin asignar.

---

## 4. Env opcionales (foto + OCR de recepción)

Degradan limpio si faltan (el operador teclea lote/caducidad a mano; la foto se omite):

- `S3_*` (bucket de evidencia — reusa el de comprobantes: entradas/pagos/cobranza).
- `ANTHROPIC_API_KEY` (OCR de la etiqueta de caducidad, Claude Haiku).

---

## 5. Verificación en prod (post-deploy + re-login)

Nav nuevo bajo **Almacén**: grupo *Existencias* → **Recepción · Vales de entrada · Ubicaciones**; grupo *Conciliación* → **Prevención · Monitoreo**.

| Ruta | Prueba rápida |
|---|---|
| `/almacen/inventory/recepcion` | Elegir almacén+producto, capturar caducidad (o teclear) → **semáforo** 🟢🟡🔴. Un 🔴 cae en la bandeja de NC. |
| `/almacen/inventory/recepcion-sesiones` | "Nueva sesión" (manual) → escanear un SKU → aparece línea recibida; cerrar. |
| `/almacen/inventory/ubicaciones` | Crear un bin → put-away de un lote recibido → aparece en el auxiliar; ver FEFO. |
| `/almacen/prevencion` | "Importar diferencias" de un folio de conteo reconciliado **o** "Abrir" manual → clasificar causa → resolver. Ver **línea de tiempo del SKU**. |
| `/almacen/monitoreo` | Iniciar monitoreo → registrar 2 conteos → ver **ventana** de pérdida. |
| `/almacen/riesgo` | "Recalcular" → lista priorizada por score (SKU con reincidencia/PNI → crítico). |

Aislamiento: verificar que un tenant distinto no ve nada de esto (RLS forzado en todas las tablas).

---

## 6. Notas / diferidos (no bloquean el cutover)

- **Diferido WMS-REC:** put-away embebido en la sesión de recepción; timeline por lote/`inventory.warehouse_stock_movements`.
- **Diferido PREV:** botón "investigar" dentro del folio de Fase I; **PREV.3** (índice de riesgo + escalamiento por reincidencia); scheduler de conteos a horas variables + alerta de conteo vencido.
- El auditor de recepción corre **en paralelo** a Kepler (ADR-044): la app es dueña de lote/caducidad/ubicación/evidencia; Kepler sigue siendo SoR de la cantidad; **sin write-back**.
