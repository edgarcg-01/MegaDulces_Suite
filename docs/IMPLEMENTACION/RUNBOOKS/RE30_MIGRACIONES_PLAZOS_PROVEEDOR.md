# Runbook — `[RE.30]`–`[RE.32]` Obligaciones a proveedor: 4 migraciones para aplicar en prod

> **Actualizado 2026-09-29 (tarde):** además de las 2 de plazos (RE.30), van **2 más** para la entrega
> de compras a Finanzas: la fecha de recepción en la vista (RE.31, §9) y las tablas de la entrega
> (RE.32, §10). **Orden de aplicación: `180050` → `180100` → `180200` → `180300`** (§5 y §11).

> **Para:** Edgar (PM) — quien aplica migraciones en prod.
> **De:** Francisco López (Dirección), que lleva el avance de Compras / Obligaciones a proveedor en este
> proyecto, con Claude Code.
> **Qué pedimos:** revisar y dejar pasar esta actualización, y aplicar las **dos** migraciones de abajo,
> **una por una**, en el orden indicado. Todo lo demás (código, pantalla, docs) viaja en el mismo PR y
> no requiere acción aparte más que el redeploy de `api` + `view`.

| # | Archivo | Qué hace | Filas de negocio que cambia | Lock | Reversible |
|---|---|---|---|---|---|
| 1 | `20260929180050_re30_supplier_credit_terms.js` | 6 columnas + 3 CHECK en `catalog.suppliers`; tabla de historial nueva | **0** (sólo DDL; las columnas nacen NULL / `false`) | ACCESS EXCLUSIVE breve, con `lock_timeout 3s` | `down` quita historial y CHECK; las columnas se quedan (aditivas) |
| 2 | `20260929180100_re30_grant_compras_obligaciones.js` | Reparte 3 permisos a 4 roles | **10** filas de `identity.role_permissions` (medido) | filas, no tabla | `down` quita sólo lo que puso |
| 3 | `20260929180200_re31_goods_receipts_fecha_recepcion.js` | `CREATE OR REPLACE VIEW analytics.erp_goods_receipts`: +4 columnas al final (fecha/hora/usuario/fuente de recepción) | **0** (vista) — las 19 columnas existentes idénticas, medido (§9) | ACCESS EXCLUSIVE sobre la vista, `lock_timeout 3s` | `down` = DROP + CREATE con la definición viva |
| 4 | `20260929180300_re32_purchase_deliveries.js` | 3 tablas nuevas: folio, entrega, renglones (RLS) | **0** (tablas nuevas vacías) | sólo FK a `identity.tenants` | `down` quita las 3 |

Ninguna crea importers, copia tablas ni toca datos de Kepler. No hay backfill.

---

## 1. Por qué existen (medido en prod, 2026-09-29, sólo lectura)

`/compras/obligaciones` es el paso en que **Compras le entrega a Finanzas** lo que recibió, cuánto se
debe y cuándo vence; Finanzas paga y lo regresa al archivo del proveedor. Para calcular "cuándo vence"
hacen falta dos datos **del proveedor** que hoy no existen bien en ningún lado: **cuántos días exactos**
da de crédito y **desde cuándo corren** (fecha de factura o fecha de recepción física).

- **Kepler no sirve de fuente para el plazo.** La condición de la Aplicación de orden de entrada (`c30`)
  dice "Pago de contado" en el 68% de los documentos porque el plazo nunca se capturó allá. En 2026:
  **207 proveedores ($94.0M) salen siempre de contado y 97 ($234.7M) a veces sí y a veces no.** Kepler
  queda en la pantalla sólo como comparación.
- **`catalog.suppliers.credit_days` ya existe** (Fase PP, mig `20260808120000`): 25 de 1,318 llenos,
  rango 8–30, escritos por `import-payment-program.js` desde el Excel del programa de pagos. **Se reusa;
  no se crea una segunda tabla de plazos** (regla de no duplicar).
- **Los permisos del módulo nunca se repartieron.** El candado del proyecto lo marca en rojo hoy:

  ```
  node database/tests/test-newdb-permission-delivery.js
  [1] ✗ 4 clave(s) que NINGUN rol menciona: NIVELACION_VER, NIVELACION_GESTIONAR,
        COMPRAS_OBLIGACIONES_VER, COMPRAS_OBLIGACIONES_GESTIONAR
  ```

  O sea que `/compras/obligaciones` y `/compras/cuentas-pago` sólo los abre el superadmin — el mismo
  defecto de LC.6.2 y CV.24. (`NIVELACION_*` no es de este trabajo.)

---

## 2. Migración 1 — `20260929180050_re30_supplier_credit_terms.js`

### Qué crea

En `catalog.suppliers`:

| Columna | Tipo | Significado |
|---|---|---|
| `credit_days` | `int` | *ya existía* — sólo se garantiza con `hasColumn` |
| `credit_term_base` | `text` | `'factura'` \| `'recepcion'` · NULL = no se sabe |
| `credit_terms_updated_by` | `text` | username de quien lo **confirmó** a mano |
| `credit_terms_updated_at` | `timestamptz` | NULL = el valor viene del Excel o no hay valor |
| `is_internal` | `boolean NOT NULL DEFAULT false` | entidad propia (CEDIS, sucursal, dueño): traspaso, no deuda |
| `internal_reason` | `text` | obligatorio si `is_internal` |

| CHECK | Regla |
|---|---|
| `chk_suppliers_credit_days_range` | `credit_days IS NULL OR credit_days BETWEEN 0 AND 365` (el mismo rango que valida el servicio) |
| `chk_suppliers_credit_term_base` | `credit_term_base IS NULL OR IN ('factura','recepcion')` |
| `chk_suppliers_internal_reason` | `NOT is_internal OR internal_reason no vacío` |

Tabla nueva `catalog.supplier_credit_terms_history` (append-only: valor anterior, nuevo, quién y nota),
con FK compuesta `(tenant_id, supplier_id) → catalog.suppliers (tenant_id, id)`, índice
`ix_sct_hist_supplier`, **RLS forzado** (`tenant_isolation`) y `GRANT` a `app_runtime`.

**Semántica del plazo — tres estados que no se confunden:** `NULL` = sin capturar · `0` = contado
confirmado · `1..365` = días exactos de crédito.

### Decisiones que vas a preguntar

1. **¿Por qué la base (`factura`/`recepcion`) no se exige por CHECK?** Las 25 filas del Excel tienen días
   y no base. Un CHECK —aun `NOT VALID`— se evalúa en todo `UPDATE` de la fila, y rompería al propio
   `import-payment-program.js`. La exige el servicio al confirmar (`SupplierCreditTermsService.update`).
2. **¿Por qué `*_by` es `text` y no `uuid`?** Mismo tipo que las tablas hermanas del flujo de pago
   (`commercial.supplier_payment_obligations`, `supplier_payment_accounts` de TP/TP.7). Las columnas
   genéricas `created_by/updated_by` (uuid) de `catalog.suppliers` no se tocan.
3. **¿El importer del Excel puede pisar un plazo confirmado?** Ya no: en este mismo PR,
   `import-payment-program.js` deja `credit_days` como está si `credit_terms_updated_at` tiene valor.
4. **¿El feed de proveedores lo pisa?** No. `import-kepler-suppliers.js` sólo escribe `name` /
   `updated_at`. Un proveedor nuevo nace "sin plazo" y `is_internal = false`.
5. **¿Por qué el `down` no dropea las columnas?** Son aditivas y borrar columnas exige confirmación
   (CLAUDE.md). `credit_days` además es de la Fase PP.

### Locks (GOTCHAS §38)

`catalog.suppliers` se lee en caliente (16 archivos de `libs/` + el feed de proveedores). `ADD COLUMN`
nullable / con DEFAULT constante es metadata-only en PG ≥ 11 y los CHECK validan 1,318 filas: el riesgo
no es el tamaño sino **quién más tenga la tabla tomada** (el respaldo diario sostiene AccessShare sobre
todo). La migración arranca con **`SET LOCAL lock_timeout = '3s'`** → el peor caso es un `55P03` y se
reintenta, no una cola que tumbe el login. El FK del historial (SHARE ROW EXCLUSIVE sobre la misma
tabla) queda cubierto por el mismo timeout.

### Idempotencia

Guard al inicio (si ya existen la última columna, la tabla y el último CHECK → `return`) y guard por
paso (`hasColumn`, `pg_constraint` filtrado por `conrelid`, `hasTable`). Corre en una transacción de
knex, así que queda todo o nada.

---

## 3. Migración 2 — `20260929180100_re30_grant_compras_obligaciones.js`

### Dos llaves, porque operar ≠ negociar

Regla de negocio (Francisco, 2026-09-29): **el plazo con el proveedor lo negocian el comprador o
dirección**; cuando una factura llega con plazo adicional, **quien la extiende es el auxiliar de
compras**. Si fijar el plazo colgara de `COMPRAS_OBLIGACIONES_GESTIONAR`, darle al auxiliar lo que
necesita para operar le daría también la negociación. Por eso nace **`COMPRAS_PLAZOS_AUTORIZAR`**, llave
aparte (el guard es por clave exacta, GOTCHAS §4) y **fuera de los presets**, igual que
`FINANCE_PAYMENT_CALENDAR_AUTORIZAR` (TP.6).

### Reparto — decidido contra las PERSONAS activas de prod, no sólo el nombre del rol

| Rol | Personas activas (puesto) | `_VER` | `_GESTIONAR` | `PLAZOS_AUTORIZAR` |
|---|---|:-:|:-:|:-:|
| `gerente_compras` | 1 (gerente de compras) | ✓ | ✓ | ✓ |
| `compras` | 2 (comprador · auxiliar de compras) | ✓ | ✓ | ✓ |
| `auxiliar_compras` | 4 (3 auxiliares · 1 analista de abastecimiento) | ✓ | ✓ | — |
| `direccion` | 2 (dirección) | ✓ | — | ✓ |
| `compras_operaciones` | 1 (encargada de operaciones, sucursal 08) | — | — | — |

- `compras_operaciones` queda **fuera** a propósito: su única persona es staff de zona; su trabajo
  (confirmar la recepción física) llega con RE.31 y su propia llave.
- ⚠️ **Declarado, no resuelto por la migración:** el rol `compras` incluye a `rafael_quirino`, cuyo
  **puesto** es auxiliar de compras. Por rol recibe `PLAZOS_AUTORIZAR`. Si no debe negociar plazos, se le
  cambia el rol en `/admin/personas`: es decisión de negocio, y recortarlo por persona escondería el
  desajuste entre rol y puesto.
- ⚠️ **Declarado — roles secundarios (`identity.user_roles`), medido en prod:** `jesus_carrillo` (jefe de
  Finanzas) tiene como adicionales `compras`, `gerente_compras`, `direccion`, `auxiliar_compras` y
  `compras_operaciones`. Con esta migración recibe también `_GESTIONAR` y `PLAZOS_AUTORIZAR`, y además es
  receptor válido de entregas. El servicio impide que una persona entregue y reciba **la misma** entrega;
  que no opere los dos lados del flujo es decisión tuya (quitarle esos roles adicionales).
- (El conteo de personas de la tabla es por rol **principal**; la migración imprime el total real
  incluyendo roles adicionales.)

### Mecánica (calcada de `20260915130000_grant_payment_calendar_autorizar.js`)

- Idempotente por `permissions -> 'KEY' IS NULL`: un `false` puesto a mano en `/admin/roles` **no se
  pisa** (criterio de tu revisión del PR #100).
- `UPDATE` por `id` de fila, no por `role_name`.
- Imprime cuántas **personas** quedan con cada llave (no roles) y avisa si un rol operativo terminó con
  `PLAZOS_AUTORIZAR`.
- `down` quita **sólo** lo que esta migración pudo poner (true en estos roles); un `true` puesto a mano
  en otro rol no se toca.
- **Requiere re-login** de compras y dirección (el permiso viaja en el JWT).

---

## 4. Ensayo en seco contra prod (sólo lectura, 2026-09-29)

Transacción `READ ONLY`, sin escribir nada. Resultado:

```
── 140000 supuestos
✓ credit_days existe (Fase PP)
✓ credit_term_base / credit_terms_updated_by / credit_terms_updated_at / is_internal / internal_reason todavía no existen
✓ CHECK 0..365 valida: 25 con valor, 0 fuera de rango
✓ nombres de CHECK libres · nombre de índice libre · tabla de historial no existe
✓ UNIQUE (tenant_id,id) para el FK compuesto
✓ public.current_tenant_id() existe · rol app_runtime existe
  locks vivos sobre catalog.suppliers ahora: 0
── 140100 efecto
  COMPRAS_OBLIGACIONES_VER:       4 filas → auxiliar_compras(4p), compras(2p), direccion(2p), gerente_compras(1p)
  COMPRAS_OBLIGACIONES_GESTIONAR: 3 filas → auxiliar_compras(4p), compras(2p), gerente_compras(1p)
  COMPRAS_PLAZOS_AUTORIZAR:       3 filas → compras(2p), direccion(2p), gerente_compras(1p)
  (todas del tenant mega_dulces; ninguna con true/false previo)
```

**Timestamps — revisados en prod, no sólo en el repo (GOTCHAS §3), la tarde del 2026-09-29:** en
`public.knex_migrations` el 29-sep ya tiene `120000`–`140000` (batches 572–583) **y
`20260929170000_commercial_margin_targets.js` (batch 584), que todavía no está en `main`**. Además `main`
trae `20260929140000_mv_profitability_sales_agg.js`, que chocaba con el primer nombre de estas. Por eso las
4 van en la serie **`20260929180050` → `180100` → `180200` → `180300`**, en el orden en que se aplican.
**Corrección 2026-09-30 (revisión PR #192):** la primera se llamaba `20260929180000`, prefijo que `main` ya
ocupaba con dos migraciones aplicadas en prod (`analytics_price_waterfall`, `cash_ledger_origen_pagable`).
Se renombró a `180050` — no al siguiente libre (`180400`) — para que siga corriendo primero. La `180100`
no depende de ella (sólo toca `identity.role_permissions`), pero el orden del runbook queda intacto.

**Pre-vuelo re-medido contra prod el 2026-09-30 (sólo lectura, `BEGIN READ ONLY`):**
- Ledger `public.knex_migrations`: ninguna de las 4 aplicada, ni con el nombre viejo; `identity.knex_migrations`
  sin filas del 29-sep; `knex_migrations_lock.is_locked = 0`. `check-migration-collisions` y
  `check-applied-migrations` contra prod: verdes.
- ⚠️ **Prod tiene 6 migraciones registradas que NO están en `main`** (otra sesión, precios, batches 616–621):
  `20260930220000_price_signals_v4_arbitro`, `…220100_price_signal_registry_a4`, `…230000_analytics_price_action`,
  `…230100_price_action_unidades`, `…230200_price_action_umbral`, `…240000_grant_margin_engine_perm`. Si al
  aplicar desde `prod-api` knex dice *«migration directory is corrupt»*, hay que copiar ESOS archivos al
  contenedor también (ya aplicados: knex no los corre, sólo necesita verlos — cabecera de
  `apply-one-migration-prod.js`). No son de este PR.
- **180050:** las 6 columnas y los 3 CHECK no existen; nombres de constraint e índice libres; `credit_days`
  = 25 de 1,318 con valor, rango 8–30 → los CHECK validan sin fallar. `UNIQUE (tenant_id, id)` existe para el FK.
- **180100:** los 4 roles tienen 1 fila cada uno y ninguno tiene todavía `COMPRAS_OBLIGACIONES_*`.
- **180200:** el SELECT nuevo corrido contra la vista viva: 20/20 columnas con el mismo nombre y tipo en el
  mismo orden, 12,875 = 12,875 filas; las 4 nuevas son `date, text, text, text`.
  ⚠️ **Revisión PR #192: los LATERAL de orden (X-A-40) y vale (X-A-37) ahora filtran el almacén** (`btrim(c1) =
  sucursal`), porque el folio se repite por almacén y el renglón lo elegía el plan (492 y 497 grupos ambiguos →
  0 y 0). **Cambia columnas existentes, a propósito**: `vale_folio`/`oc_folio` en 490 renglones, todos de la
  sucursal `03` (la única con 3 almacenes; bug PREEXISTENTE de la vista viva). Las otras 17 columnas: `EXCEPT ALL`
  0/0. Detalle y medición en la cabecera de la migración. El `down` reproduce la vista viva (`EXCEPT ALL` 0/0). `kdm1.c68` es
  `timestamp` → el `::date` no puede fallar por texto sucio. Sin dependientes en `pg_depend`, ninguna función la
  usa como tipo de fila. `relacl` = `app_runtime`, `dev_ro` (los re-aplica).
- **180300:** las 3 tablas y sus 4 índices no existen; `public.current_tenant_id()`, `identity.tenants`,
  `app_runtime` y `dev_ro` sí. Ninguna entrada de la vista tiene monto ≤ 0 (el `CHECK amount > 0` no estorba).
- Dueño: prod aplica como `postgres`, dueño de `catalog.suppliers` e `identity.role_permissions`; los
  privilegios por defecto de `postgres` en `catalog`/`commercial` le dan lectura a `dev_ro` en las tablas nuevas.
- `import-payment-program.js` ya no puede tumbar su importación entera por el CHECK 0..365: un plazo fuera de
  rango o no entero se omite y se reporta (`[WARN]`).

---

## 5. Cómo aplicarlas

Fuera de la ventana del respaldo diario (sostiene locks de toda la base mientras dura).

```bash
# 1) esquema
node database/scripts/apply-one-migration-prod.js 20260929180050_re30_supplier_credit_terms.js
# 2) permisos
node database/scripts/apply-one-migration-prod.js 20260929180100_re30_grant_compras_obligaciones.js
```

Si la 1 falla con `55P03` (lock_timeout) → no quedó nada a medias (transacción); reintentar más tarde.

### Verificación después de la 1 (columnas, no el registro — GOTCHAS §3)

```sql
SELECT a.attname FROM pg_attribute a
 WHERE a.attrelid = 'catalog.suppliers'::regclass AND a.attnum > 0 AND NOT a.attisdropped
   AND a.attname IN ('credit_term_base','credit_terms_updated_by','credit_terms_updated_at','is_internal','internal_reason');
-- esperado: 5 filas

SELECT conname FROM pg_constraint WHERE conrelid = 'catalog.suppliers'::regclass AND conname LIKE 'chk_suppliers_%';
-- esperado: chk_suppliers_credit_days_range, chk_suppliers_credit_term_base, chk_suppliers_internal_reason

SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'catalog.supplier_credit_terms_history'::regclass;
-- esperado: t, t

-- invariante del dato: nada se movió
SELECT count(*) FILTER (WHERE credit_days IS NOT NULL) AS con_dias,      -- esperado 25
       count(*) FILTER (WHERE is_internal)            AS internos,       -- esperado 0
       count(*) FILTER (WHERE credit_terms_updated_at IS NOT NULL) AS confirmados  -- esperado 0
  FROM catalog.suppliers;
```

### Verificación después de la 2

```bash
node database/tests/test-newdb-permission-delivery.js
# [1] ya NO debe listar COMPRAS_OBLIGACIONES_VER / _GESTIONAR ni COMPRAS_PLAZOS_AUTORIZAR
```

Y re-login de: `arizbeth_gonzalez`, `bruno_lopez`, `rafael_quirino`, los 4 de `auxiliar_compras`,
`guillermo_lopez` y `superuser`.

### Rollback

```bash
# en orden inverso; knex migrate:down de cada una, o su `down` a mano
# 2) quita las 3 llaves de esos 4 roles (respeta lo puesto a mano)
# 1) quita historial + CHECK; las columnas quedan (NULL, sin efecto)
```

---

## 6. Qué más trae el PR (sin acción de BD)

- **Backend:** `SupplierCreditTermsController/Service` en `libs/commercial/.../supplier-payment-obligations/`
  (`GET /commercial/supplier-credit-terms`, `GET :id/history` con `COMPRAS_OBLIGACIONES_VER`;
  `PUT :id` con `COMPRAS_PLAZOS_AUTORIZAR`; el `PUT` escribe el historial en la misma transacción).
  Tipos en `libs/contracts/src/http/supplier-credit-terms.contract.ts` (ADR-052).
- **Permiso nuevo** en los 5 puntos de GOTCHAS §4: enum, gate, `permission-meta`, `authz-tree` y
  `perms.has`. `landing-guards.spec.ts` lo declara como facultad de firma (la ruta exige `_VER`).
- **Pantalla:** pestaña "Plazos por proveedor" dentro de `/compras/obligaciones` (sin ruta ni entrada de
  menú nuevas, ver §7). Contra prod: 307 proveedores con recepciones en 12 meses, 285 sin plazo, 46
  cubren el 80% de lo recibido. "Nueva obligación" / "Cancelar" ahora exigen `_GESTIONAR`. Las dos
  `p-table` pasan a `size="small"` + clase en el host (GOTCHAS §41).
- **Importer:** `import-payment-program.js` respeta el plazo confirmado a mano.

**Verificado:** `nx build api` y `nx build view` verdes · `nx test view` 1237/1237 · `nx test contracts`
160/160 · `lint-boundary-gate` ✅ · `check:templates` ✅ · `check-provenance` ✅ · eslint 0 errores.

---

## 7. Lo que tienes que saber aunque no sea de este PR

- **Bundle inicial de `view`: ya no es un problema.** Cuando empezó este trabajo estaba en 1,399.75 kB de
  1,400 (por eso los plazos entraron como pestaña y no como página). Tu trabajo **BND.1–3** en `main` lo
  bajó: con `main` actual + este PR el inicial mide **1.22 MB**. La pestaña se queda: es el lugar correcto
  (Obligaciones es el flujo Compras→Finanzas completo).
- **Rojos ajenos:** `test-authz-route-coverage.js` ✗ `libs/shared-auth` = carpeta sin seguimiento en una
  máquina local. `check-primeng-api.js` estaba sobre el techo en el `main` del mediodía (286/283
  `p-table`); con el `main` actual queda bajo techo y este PR no agrega API retirada (sus tablas nuevas
  usan `size="small"` + clase en el host).
- **"Qué vence" (RE.3) calcula con el `c18` de Kepler**, así que hereda el "de contado" falso. Pasará a
  este plazo en una etapa siguiente.

## 8. Lo que sigue (no incluido)

RE.33 al confirmar Finanzas nace la obligación en el Calendario con el vencimiento del plazo (RE.30) +
regreso de Finanzas (fecha de pago, notas de crédito, días recepción→pago) · RE.34 extensión de plazo por
factura (la registra el auxiliar, guarda quién la negoció). Plan en
[`FASE_RE`](../FASES/FASE_RE_RECEPCION_MERCANCIA.md).

---

## 9. Migración 3 — `20260929180200_re31_goods_receipts_fecha_recepcion.js`

**Para qué:** el auxiliar entrega a Finanzas **por fecha de recepción**, y hay proveedores cuyo plazo
corre desde la recepción. La vista sólo tenía `receipt_date`, que **es la fecha de factura** (`kdm1.c9`
de la aplicación X-A-20; el vencimiento de Kepler = esa fecha + plazo "fecha factura" en el 99.9%). No se
renombra — la leen `fn_pair_goods_receipts`, `fn_goods_receipt_twin_candidates` y varios servicios —; se
declara en un `COMMENT`.

**De dónde sale la recepción:** `kdm1.c68 · c69 · c67` = fecha · hora · usuario de **captura** en Kepler
(ya decodificado en `ERP_KEPLER.md` contra una cotización capturada a propósito). Se toma la del **vale de
entrada X-A-37** (el documento de la llegada física), por la misma cadena que la vista ya recorre. Medido
sobre 4,846 entradas jun–sep 2026 (prod, sólo lectura):

| Prueba | Resultado |
|---|---|
| Captura del vale vs captura de la aplicación | nunca posterior (4,513 iguales · 333 antes) |
| Hora de captura | 07–21 h, horario laboral: reloj del sistema, no tecleo |
| **Árbitro independiente**: fotos subidas a `/compras/entradas` (reloj de NUESTRO servidor) | 417 con foto · **0 fotos anteriores a la captura** |
| Retraso contra factura | 66% mismo día · 22% 1–2 días · 11% más de 2 (casi todo CEDIS) |
| Factura con fecha POSTERIOR a la recepción | 569 de 12,846 (4.4%) — dato del ERP, no se corrige |

**Qué cambia:** el LATERAL al vale lee del mismo renglón `c39` (la OC, como antes) y `c68/c69/c67`; 4
columnas nuevas **al final**: `fecha_recepcion` (vale; si no hay vale, la aplicación), `_hora`,
`_usuario`, `_fuente` (`vale`|`aplicacion`). Wincaja: las 4 en NULL (su `mp.fecha` no está verificada).

**Candado corrido antes de escribirla** (consulta nueva vs vista viva en prod, `EXCEPT ALL` en las dos
direcciones sobre las 19 columnas existentes):

```
filas vista actual  : 12,846        filas vista nueva : 12,846
actual − nueva      : 0             nueva − actual    : 0
30 días             : 994 · $51,202,834.22 en las dos   (60 → 80 ms)
fecha_recepcion_fuente = 'vale' en las 12,846
```

Y el archivo se probó contra un knex falso que registra el SQL: **el `up` genera exactamente la consulta
validada y el `down` exactamente la definición viva** (`pg_get_viewdef` del 2026-09-29); re-aplicarla es
no-op. Permisos: `relacl` = `app_runtime=r`, `dev_ro=r` (leído del catálogo, no de `information_schema`,
que sólo muestra lo que ve el usuario que consulta); se re-aplican los dos `GRANT`. Sin `security_invoker`
antes ni después.

## 10. Migración 4 — `20260929180300_re32_purchase_deliveries.js`

**Para qué:** la entrega de Compras a Finanzas con folio. El auxiliar marca lo que tiene en físico y
validado, elige a la persona de Finanzas que recibe, se asigna `ENT-YYYY-NNNNN` y se descarga el PDF para
firmas. Finanzas confirma y puede **rechazar renglón por renglón** (vuelve a pendientes).

| Tabla | Qué es |
|---|---|
| `commercial.purchase_delivery_sequences` | contador (tenant, año) del folio, UPSERT atómico como `quote_sequences` |
| `commercial.purchase_deliveries` | la entrega: folio, estado, base y periodo, quién entrega, quién recibe, confirmación, totales |
| `commercial.purchase_delivery_lines` | un renglón por orden de entrada: llave Kepler + **snapshot** (lo firmado no cambia si Kepler corrige) + su estado |

**Invariantes en la base:** índice único parcial `(tenant, sucursal, doc_prefix, folio) WHERE status IN
('entregado','aceptado')` — una entrada no puede estar en dos entregas vivas (dos auxiliares a la vez:
gana el primer commit, el segundo recibe 23505 → el servicio lo traduce a "recarga la lista"); rechazo
exige motivo; decidir exige quién y cuándo; importe > 0; FK compuesta `(tenant_id, delivery_id)`.
RLS forzado + `GRANT` a `app_runtime` en las tres.

**Sintaxis verificada contra prod sin escribir:** cada sentencia en una transacción `READ ONLY` → las 22
DDL rechazadas con `25006` (sintaxis válida, no ejecutadas), 0 errores de sintaxis.

**Permisos: ninguno nuevo.** Armar/cancelar = `COMPRAS_OBLIGACIONES_GESTIONAR` (el auxiliar); ver =
`_VER` **o** `FINANCE_PAYMENTS_GESTIONAR`; confirmar = `FINANCE_PAYMENTS_GESTIONAR` **y ser la persona
asignada** (el servicio lo valida). Quién puede recibir se **deriva**: activos de departamento
`finanzas`/`tesoreria` con `FINANCE_PAYMENTS_GESTIONAR` — hoy 7 personas. La ruta
`/compras/obligaciones` pasa a `anyPermissionGuard(_VER, FINANCE_PAYMENTS_GESTIONAR)` (Finanzas sólo ve
la pestaña Entregas) y el Calendario de Pagos gana un botón "Entregas de Compras".

## 11. Aplicar las 4, en orden

```bash
node database/scripts/apply-one-migration-prod.js 20260929180050_re30_supplier_credit_terms.js
node database/scripts/apply-one-migration-prod.js 20260929180100_re30_grant_compras_obligaciones.js
node database/scripts/apply-one-migration-prod.js 20260929180200_re31_goods_receipts_fecha_recepcion.js
node database/scripts/apply-one-migration-prod.js 20260929180300_re32_purchase_deliveries.js
```

Después de la 3:

```sql
SELECT fecha_recepcion_fuente, count(*) FROM analytics.erp_goods_receipts GROUP BY 1;  -- 'vale' ≈ todas las de Kepler
SELECT count(*) FROM analytics.erp_goods_receipts;                                      -- igual que antes de aplicarla
SELECT has_table_privilege('app_runtime', 'analytics.erp_goods_receipts', 'SELECT');   -- t
```

Después de la 4:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
 WHERE c.oid IN ('commercial.purchase_deliveries'::regclass, 'commercial.purchase_delivery_lines'::regclass,
                 'commercial.purchase_delivery_sequences'::regclass);                   -- t, t en las 3
SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_pdel_lines_receipt_live';          -- UNIQUE … WHERE status IN (…)
```

La API detecta sola cada migración aplicada (sondas por pieza; sólo se recuerda el "sí"): antes de
aplicarlas, las pantallas se ven en sólo lectura con un aviso, nunca con un 500. Después: **redeploy
api+view** si el código no está ya desplegado, y **re-login** de compras, dirección y Finanzas.
