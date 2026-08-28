# ERP Kepler — decode y flujo hacia la plataforma

> Guía para devs que van a tocar feeds, importers, finanzas, compras o analytics.
> El decode nació de ingeniería inversa sobre los datos — trátalo como conocimiento vivo:
> verificá contra el dato real antes de asumir. **Este doc NO contiene credenciales ni hosts**
> (esos viven en el vault / `.env`, ver Etapa 2 del roadmap de equipo).

---

## 1. Qué es Kepler y por qué duele

Mega Dulces corre **Kepler**, un ERP retail/distribución mexicano. Su schema está **ofuscado a propósito**:
tablas `kdXX` (`kdii`, `kdm1`, `kdil`…) y columnas `c1, c2, c3…` **sin nombres ni comentarios**. Todo el
"significado" se dedujo cruzando datos, forms `.kpl` del ERP y comportamiento observado.

**Regla de oro para investigar Kepler:** buscar por **nombre de tabla + contenido**
(ej. `WHERE x::text ILIKE '%FUMIGACION%'`), nunca por nombre de columna (no existen).

Hay **una DB Kepler por sucursal** (01–06) + el CEDIS (00). Cada sucursal tiene su propio `kdii`, `kdil`, etc.
El schema completo son ~330 tablas; solo ~20 tienen valor real. Referencias exhaustivas en:
- [`docs/IMPLEMENTACION/KEPLER_CATALOGO_TABLAS.md`](IMPLEMENTACION/KEPLER_CATALOGO_TABLAS.md) — barrido curado por dominio.
- [`docs/IMPLEMENTACION/KEPLER_TABLAS_COMPLETO.md`](IMPLEMENTACION/KEPLER_TABLAS_COMPLETO.md) — inventario de las 330 tablas.

---

## 2. Tablas clave decodificadas

| Tabla | Qué es | Columnas clave |
|---|---|---|
| **`kdii`** | Maestro de productos (por sucursal) | `c1`=SKU · `c2`=nombre · `c7`=código de barras (EAN) · `c8`=clave familia · **`c84`=piezas por caja** (box factor canónico) · **`c33`=mínimo · `c34`=punto de reorden · `c35`=máximo** |
| **`kdil`** | Existencia/acumulados **por almacén** | ⚠️ `c1`=**ALMACÉN (no sucursal)** — filtrá por la columna `sucursal` + `c1`=almacén principal · `c3`=SKU · **`c9`=existencia actual** (validado vs `kdik.c6`; ~38% de drift entre ambas fuentes) · `c6/c7`=última compra/venta |
| **`kdik`** | Valuación por sucursal | `c2`=SKU · `c6`=existencia · `c9`=valor a costo → **costo unitario = c9/c6** |
| **`kdm1`** | Encabezados de documentos (200 cols) — compras, ventas, ajustes | `c1`=sucursal · `c2/c3/c4`=género/naturaleza/tipo del doc · `c9`=fecha · `c10`=forma de pago |
| **`kdm2`** | Detalle/líneas de documentos (1.26M filas) | `c8`=SKU · `c9`=cantidad · `c32`=fecha (≈ header) |
| **`kdmm`** | **Catálogo de tipos de documento** (la piedra Rosetta) | `c1`=género · `c2`=naturaleza · `c4`=tipo · `c5`=descripción · **`c8`=¿afecta inventario?** · `c19/c20`=cuenta cargo/abono |
| `kdid/kdie/kdif/kdig` | Catálogos: unidad / depto / línea / **proveedor** | `kdig` = proveedores (línea de negocio ≈ marca) |
| `kdij` | Kardex de movimientos con fecha inline (595k) | |
| `kdc2YYMM` | Pólizas contables por mes | |
| `kdb1` | Cuentas bancarias | |
| `kdxd/kdxe/kdxf` | CxP proveedores (estado de cuenta / saldos / facturas-cobros) | |

**No existe tabla de conteo físico** — Kepler ajusta inventario vía documento (`kdm1`/`kdm2`).
La "existencia actual" del reporte NO está en `kdii`; se deriva de `kdil`/`kdik`.

---

## 3. El modelo de documentos (género · naturaleza · tipo)

Todo en Kepler es un **documento** clasificado por 3 ejes en `kdmm` (género/naturaleza/tipo). Los más importantes:

**Ventas** (género `U`, naturaleza `D`):
- `U-D-10` = venta POS/mostrador (el grueso). En `kdm1`: `c2='U' c3='D' c4=10`.

**Compras** (género `X`, naturaleza `A`) — la cadena que hay que entender para finanzas/compras:
```
X-A-30 Requisición      (c8=N, no mueve nada)
  → X-A-35 Orden de compra   (c8=N)
    → X-A-37 Vale de entrada (c8=N, solo comprobante de recepción)
      → X-A-40 Orden de entrada (c8=S ← AQUÍ ENTRA EL INVENTARIO)
        → X-A-20 Aplica Orden Entrada (c19=511 compras / c20=201 proveedores ← nace la póliza y la CxP)
```
Compra directa `X-A-5` hace inventario + CxP de golpe.
**Devoluciones** `X-D-30/35/40`. **Pago a proveedor** `X-D-20/25/26`.

**Traspasos** (género `N`): `N-A-6` entrada / `N-D-6` salida (sin proveedor, mueve entre almacenes).

⚠️ **El folio NO es único entre doctypes** — el mismo número de folio puede existir en `X-A-37` y `X-A-40`.
Nunca joinees solo por folio; incluí el doctype. (Ver `reference_kepler_orden_entrada_xa2001` en las notas.)

⚠️ **Y tampoco es único entre servidores: la misma recepción se captura DOS VECES.** La sucursal
la captura en su Kepler y **oficinas** (servidor `192.168.9.95`, que en el ODS es la sucursal
`'00'`) la vuelve a capturar en el suyo. No son réplicas —cada una tiene su propio folio, su
propio vale y su propia póliza— y se distinguen por el detalle:

| | sucursal (`01`–`06`) | oficinas (`'00'`) |
|---|---|---|
| renglones | los productos reales (12–20 en promedio) | casi siempre **uno** de concepto: SKU `0000x` `VENTAS AL 0 %` con el total |
| qué es | la recepción operativa, movió inventario | la captura **contable** |
| canónica | **sí** | no (es el espejo) |

Dos trampas al aparearlas: los importes **no siempre casan al centavo** porque son dos capturas
independientes (visto: `$79,009.21` vs `$79,007.79`, $1.42), y **el nombre del proveedor no es la
misma llave** porque cada servidor tiene su catálogo (`DIONICIO CALDERON` en la sucursal es
`BOTANAS CALDERON` en oficinas). El apareo vive en `analytics.erp_goods_receipt_dedup` con regla y
score, lo dudoso queda `propuesto` hasta que una persona lo dictamine, y la vista
`analytics.erp_goods_receipts` **sólo oculta los pares vigentes** — porque ocultar la copia de
oficinas es afirmar que esa compra no existe. Lo mantiene
`database/importers/kepler/detect-goods-receipt-duplicates.js`. La práctica arrancó en ene-2026 y
viene subiendo: **55% de las recepciones de sucursal en ago-2026** ya tienen copia en oficinas.

---

## 4. Cómo llega Kepler a la plataforma — el pipeline `kepler_ods`

Este es el corazón de la integración. **No leemos las DBs de sucursal directo desde la app.**

```
6 DBs Kepler (sucursales 01-06, Postgres)
        │  replicación lógica nativa de Postgres (WAL)
        ▼
  kepler_md_01 … kepler_md_06   (réplicas locales, mismo schema md.*)
        │  replicate-ods-live.js  — normaliza y consolida en UNA tabla por entidad
        ▼
  kepler_ods.*   ← LA FUENTE CANÓNICA (single-DB, columna `sucursal`, lag ~segundos)
        │  vistas "derive-no-copy" (erp_collections, erp_customers, kepler_bank_movements…)
        ▼
  analytics.* / commercial.*  → endpoints → frontend
```

- **`kepler_ods.*`** es el modelo canónico: una tabla por entidad Kepler, con columna `sucursal`, alimentada
  en near-real-time por replicación lógica. **Todo lo que necesite dato de Kepler debe leer de acá**, no de
  las ramas ni de bases intermedias viejas (`KP_CONCENTRADA`, `Mega_Dulces`).
- El **CEDIS (00)** es un caso aparte: corre sobre **Access 97** (Fase CA) — no está en el pipeline de
  replicación lógica todavía.
- Runbook operacional del pipeline: [`docs/IMPLEMENTACION/RUNBOOK_REPLICACION_LOGICA.md`](IMPLEMENTACION/RUNBOOK_REPLICACION_LOGICA.md).
- Modelo canónico y anti-desincronización: [`docs/MODELO_CANONICO_DATOS.md`](MODELO_CANONICO_DATOS.md).

---

## 5. Reglas de oro (te ahorran bugs de datos)

1. **Derivar, no copiar.** Si `analytics.*` necesita un dato de Kepler que ya está en `kepler_ods`, hacé una
   **vista/MV** sobre `kepler_ods`, no un importer que copie a otra tabla. Copiar = split-brain garantizado
   (el mismo atributo escrito por N feeds a N cadencias). Tabla real solo para dato **propio** de la app o
   snapshots point-in-time correctos (ej. `order_lines.unit_price`).
2. **El ODS es UPSERT-only → no propaga hard-DELETE.** Una vista sobre `kepler_ods` puede mostrar SKUs
   descontinuados para siempre. (Se está resolviendo con CDC por WAL; hasta entonces, tenelo en cuenta.)
3. **`units` NO es la verdad; usá `revenue`.** Hay un quiebre de datos de unidades (inflado ~3.9× desde
   oct-2025 por un tema de factor de caja). Para demanda/rotación anclá a **revenue**, no a unidades.
4. **RLS no aplica a vistas/MVs.** Si derivás una tabla tenant-scoped desde `kepler_ods` (que es single-tenant
   crudo), tenés que reinyectar `tenant_id` explícito o rompés el aislamiento. Ver [`docs/GOTCHAS.md`](GOTCHAS.md) §1.
5. **Box factor = `kdii.c84`** (piezas por caja). `c84 IN (0,1)` = granel (factor 1). No lo adivines del nombre.
6. **`kepler_ods` filtra por `sucursal`, no por `c1`** (la PK de catálogos es `(sucursal, c1)`).
7. **En las tablas de detalle (`kdil`, `kdij`, `kdue`, `kdxe`, `kdpv_descuxq`), `c1` es el ALMACÉN, no la sucursal.** En `kepler_ods`/`kp.*` la rama real es la columna `sucursal` (agregada al concentrar); `c1` es el almacén dentro de la rama. Para existencia de rama: `WHERE sucursal='03' AND c1='03'` (almacén principal). Existencia = `kdil.c9` (validado vs `kdik.c6`, con ~38% de drift entre ambas fuentes).
8. **La notación `X-A-30` = género(`c2`)·naturaleza(`c3`)·grupo(`c4`) en `kdm1`.** El número (30/35/40…) es el **grupo** (`kdm1.c4` = `kdmm.c3`), no el "tipo". Validado vivo 2026-08-25.

---

## 6. Importers / feeds relevantes

Viven en [`database/importers/`](../database/importers/). Los principales de Kepler:
- `kepler/replicate-ods-live.js` — el normalizer que alimenta `kepler_ods` (dos carriles: ctid + hash-delta).
- `kepler/import-kepler-*.js` — cargas específicas (stock, precios, rotación, proveedores, uom, bank-movements…).
- `mega_dulces_sync.js` — sync nocturno legacy (en retiro a favor del ODS).

Casi todos son **idempotentes** y corren en **dry-run por default** (necesitan `--apply`). Leé el header de
cada uno antes de correrlo.

---

## 7. Conexiones y credenciales

**No están en este doc a propósito.** Las connection strings (réplicas locales, ODS, ramas) viven en `.env` /
el vault del equipo. Pedilas al lead por el canal seguro (Etapa 2 del roadmap). Nunca las pegues en código,
commits ni chat.

---

## 8. Para profundizar

| Doc | Para qué |
|---|---|
| [`KEPLER_CATALOGO_TABLAS.md`](IMPLEMENTACION/KEPLER_CATALOGO_TABLAS.md) | Barrido curado de tablas por dominio |
| [`KEPLER_TABLAS_COMPLETO.md`](IMPLEMENTACION/KEPLER_TABLAS_COMPLETO.md) | Inventario de las 330 tablas |
| [`RUNBOOK_REPLICACION_LOGICA.md`](IMPLEMENTACION/RUNBOOK_REPLICACION_LOGICA.md) | Operar el pipeline de replicación |
| [`MODELO_CANONICO_DATOS.md`](MODELO_CANONICO_DATOS.md) | Fuente única por entidad, anti-desync |
| [`GOTCHAS.md`](GOTCHAS.md) | Trampas de RLS/knex/migraciones al tocar estos datos |
