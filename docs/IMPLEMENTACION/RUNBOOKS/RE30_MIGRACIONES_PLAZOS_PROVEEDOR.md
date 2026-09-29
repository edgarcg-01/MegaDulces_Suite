# Runbook — `[RE.30]` Plazos de pago por proveedor: 2 migraciones para aplicar en prod

> **Para:** Edgar (PM) — quien aplica migraciones en prod.
> **De:** Francisco López (Dirección), que lleva el avance de Compras / Obligaciones a proveedor en este
> proyecto, con Claude Code.
> **Qué pedimos:** revisar y dejar pasar esta actualización, y aplicar las **dos** migraciones de abajo,
> **una por una**, en el orden indicado. Todo lo demás (código, pantalla, docs) viaja en el mismo PR y
> no requiere acción aparte más que el redeploy de `api` + `view`.

| # | Archivo | Qué hace | Filas de negocio que cambia | Lock | Reversible |
|---|---|---|---|---|---|
| 1 | `20260929140000_re30_supplier_credit_terms.js` | 6 columnas + 3 CHECK en `catalog.suppliers`; tabla de historial nueva | **0** (sólo DDL; las columnas nacen NULL / `false`) | ACCESS EXCLUSIVE breve, con `lock_timeout 3s` | `down` quita historial y CHECK; las columnas se quedan (aditivas) |
| 2 | `20260929140100_re30_grant_compras_obligaciones.js` | Reparte 3 permisos a 4 roles | **10** filas de `identity.role_permissions` (medido) | filas, no tabla | `down` quita sólo lo que puso |

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

## 2. Migración 1 — `20260929140000_re30_supplier_credit_terms.js`

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

## 3. Migración 2 — `20260929140100_re30_grant_compras_obligaciones.js`

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

**Timestamps:** el último aplicado en `public.knex_migrations` es `20260928260000` (batch 571); ninguno
del 29-sep. Ojo: en el checkout local hay dos migraciones de otra línea de trabajo con
`20260929120000` / `120100` (VK); éstas se nombraron `140000` / `140100` para no empatarlas.

---

## 5. Cómo aplicarlas

Fuera de la ventana del respaldo diario (sostiene locks de toda la base mientras dura).

```bash
# 1) esquema
node database/scripts/apply-one-migration-prod.js 20260929140000_re30_supplier_credit_terms.js
# 2) permisos
node database/scripts/apply-one-migration-prod.js 20260929140100_re30_grant_compras_obligaciones.js
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

- **Bundle inicial de `view`: 1,399.75 kB de 1,400 → quedan 250 bytes.** Una entrada de menú + ruta +
  nodo de árbol lo pasaban por 95 bytes; por eso los plazos entraron como pestaña. El tope nunca se ha
  subido desde el monorepo inicial y no lo subimos nosotros: **el siguiente permiso o renglón de menú que
  entre lo va a romper**, y la decisión es tuya.
- **Rojos que ya estaban en `main` limpio** (medido sobre `git archive HEAD`, sin estos cambios):
  `check-primeng-api.js` en 286/283 `p-table` y 262/255 `p-select` (este PR lo baja a 285);
  `test-authz-route-coverage.js` ✗ `libs/shared-auth` = carpeta sin seguimiento en una máquina local.
- **"Qué vence" (RE.3) calcula con el `c18` de Kepler**, así que hereda el "de contado" falso. Pasará a
  este plazo en una etapa siguiente.

## 8. Lo que sigue (no incluido)

RE.31 fecha de recepción física capturada por la zona (Kepler no la tiene: en el 89% de las recepciones
la cadena entera lleva la fecha de factura) · RE.32 relación de entrega a Finanzas con rechazo por
renglón · RE.33 regreso de Finanzas (fecha de pago, notas de crédito, días recepción→pago) · RE.34
extensión de plazo por factura (la registra el auxiliar, guarda quién la negoció). Plan en
[`FASE_RE`](../FASES/FASE_RE_RECEPCION_MERCANCIA.md).
