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
| **`kdii`** | Maestro de productos (por sucursal) | `c1`=SKU · `c2`=nombre · `c7`=código de barras (EAN) · `c8`=clave familia · `c84`=piezas por caja (⚠️ ver regla 5) · **`c33`=mínimo · `c34`=punto de reorden · `c35`=máximo** · **`c11`/`c80`/`c83`=rótulos de la escalera de unidades** (uni1/uni2/uni3 — ver §2.1) · `c90`=precio configurado (respaldo; sólo coincide ~58% con lo cobrado) |
| **`kdil`** | Existencia/acumulados **por almacén** | ⚠️ `c1`=**ALMACÉN (no sucursal)** — filtrá por la columna `sucursal` + `c1`=almacén principal · `c3`=SKU · **existencia = `c4`(inicial) + `c8`(entradas) − `c9`(salidas)** — ⚠️ `c9` es **SALIDAS**, NO la existencia (ver §2.2) · `c6/c7`=última compra/venta |
| **`kdik`** | Valuación por sucursal | `c2`=SKU · `c6`=existencia · `c9`=valor a costo → costo unitario = `c9/c6` · **`c16`=costo unitario NETO almacenado** (es el que leemos; ver §2.1) |
| **`kdpv_prov_prod`** | **Costo por proveedor por producto** (la pantalla "Costos por Proveedor por Productos") | `c1`=**código de proveedor** · `c2`=SKU · `c3`=descripción · **`c4`=Costo Uni Mayor** · `c5`/`c6`/`c7`=**% Desc 1/2/3** · **`c8`/`c9`/`c10`=Total Uni 1/2/3** (los 3 peldaños de la escalera) |
| `kdpv_bitacora_precios` | Bitácora de cambios de precio/costo (el campo "Motivo Cambio Precio en Bitacora" de esa misma pantalla) | |
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

### 2.1 La escalera de unidades y el costo (decodificado 2026-08-31)

Kepler NO guarda "un" costo por producto: guarda una **escalera de hasta 3 peldaños**, y el costo
existe en cada peldaño. El monto vive en `kdpv_prov_prod`, el **rótulo** del peldaño en `kdii`:

| peldaño | monto | rótulo | ejemplo `00303` | ejemplo `99029` |
|---|---|---|---|---|
| uni1 | `kdpv_prov_prod.c8` | `kdii.c11` | `PZA` $11.08 | `500` $8.30 |
| uni2 | `kdpv_prov_prod.c9` | `kdii.c80` | `PAQ` $55.40 | `KG` $16.60 |
| uni3 | `kdpv_prov_prod.c10` | `kdii.c83` | `CJA` $553.97 | `BTO` $415.00 |

`c4` (**Costo Uni Mayor**) repite el peldaño más alto que esté lleno. Los rótulos NO son fijos: pueden
ser `PZA/PAQ/CJA` pero también `500/KG/BTO` (azúcar a granel), `CUB`, `SER`, `250`, `2KG`…

⚠️ **La escalera puede estar CORRIDA.** Si `kdii.c83` viene vacío, el producto tiene sólo 2 peldaños y
el costo de caja vive en `c9`, no en `c10` (ej. `91059 TURIN 16KG`: `500 / CJA / ""` → `c8`=$144.75,
`c9`=$4,632.00, `c10`=0). **Leer un peldaño fijo es el bug**: tomar `c10` a ciegas da 0, y tomar el
más alto no-cero da el costo de caja donde esperabas el unitario — un error de ~32×. Éste es el
origen del problema de unidades que arrastra CANON.0.1.

**El factor de caja real se deriva de la escalera**: `c4 / c8` = unidades del peldaño base por unidad
mayor. Verificado: `91059` → 4632.00/144.75 = **32** × 500 g = 16 KG ✓ (el nombre dice "16KG");
`70344` → 1130.00/56.50 = **20** × 500 g = 10 KG ✓.

**`kdik.c16` = costo unitario NETO, en el peldaño BASE, promedio móvil POR SUCURSAL.** Medido contra
lo que realmente pagamos (entradas `X-A-40`, 90 d): mediana de la razón **1.000**. No es costo
estándar ni último costo — sólo 20.2% coincide exacto con la última compra, mientras que concuerda
92.1% con la valuación `c9/c6` (que *es* promedio por construcción). Cada sucursal promedia **sus**
entradas: mismo centro, deriva propia (19.6%–52.8% idénticos al CEDIS, sin markup de traspaso).

**Cross-check independiente:** `kdpv_prov_prod` valida el factor de caja desde una fuente distinta a
`v_product_box_factor`. Medido: **5,568 de 5,571** coinciden. Sirve como validador de DQ, no como
fuente primaria.

### 2.2 Existencia y ventas — validadas contra Kepler (2026-08-31)

Mismo protocolo que el costo (§5 regla 0): contra un hecho independiente + prueba de unidad
explícita. **Las dos salieron limpias** — el costo era el único roto.

| | vs Kepler | mediana de la razón | prueba de unidad |
|---|---|---|---|
| **Existencia** (suc 03, 2,793 SKUs) | 97.9% exacta | **1.0000** | 0.0% en `bf` · 0.0% en `1/bf` |
| **Ventas importe** (suc 01/03/05) | 89–96% exacta | **1.0000** | — |
| **Ventas unidades** | 88–94% exacta | **1.0000** | 0.0% en `bf` · 0.0% en `1/bf` |

**⚠️ `kdil.c9` NO es la existencia — son las SALIDAS.** La existencia es
`c4`(inicial) + `c8`(entradas) − `c9`(salidas), y así la calcula `import-branch-stock-live.js`.
Leer `c9` a secas da razón **0.1557** contra la existencia real (coincide sólo en 1.6% de los SKUs).
Esta tabla decía lo contrario hasta hoy.

### 2.3 ⚠️ La sucursal `00` de Kepler es OFICINAS, **no** el CEDIS

Corrección de Edgar, 2026-08-31. Es la confusión más cara del modelo porque está **en el nombre**:

| | qué es | dónde vive | evidencia |
|---|---|---|---|
| **Kepler `sucursal='00'`** | **OFICINAS** — centraliza compra, tránsito y contabilidad | Kepler (Postgres, en el ODS) | **cero** líneas de mostrador `U-D-10` en 30 d; las que venden son 01–06 |
| **CEDIS real** | el bodegón que surte a la red | **WINCAJA** — `BPIRAPUATO`, archivo `0 BPIRAPUATO MOV.MDB` | `wincaja.branches`: `status='live_on_wincaja'`, *"CEDIS/bodegón Irapuato"* |

**Consecuencias medidas:**

- Nuestro almacén `code='00'` se llama **"Cedis Oficinas"** (`kepler_code` NULL) y es el **hub raíz de
  la red de abasto** — 4 hijos (01, 06, MD-30, 03) — pero tiene **149 SKUs** de existencia contra
  2,364–3,264 de las sucursales reales. El DRP planea contra un nodo administrativo.
- `wincaja.branches` apunta el CEDIS a `warehouse_code='MD-00'`, **que no existe en
  `commercial.warehouses`**: la existencia del CEDIS real no está modelada.
- Hay **~11 importers** con comentarios del tipo *"CEDIS '00'"* que en realidad hablan de oficinas.
  Funcionan bien (la lógica de incluir/excluir `00` es correcta para lo suyo); lo que engaña es el
  nombre. Uno ya lo había notado: `import-stock-movements.js` escribe `CEDIS '00'='Cedis Oficinas'`.
- Traer el CEDIS de verdad al pipeline es justamente el objetivo de la [`FASE_CA`](IMPLEMENTACION/FASES/FASE_CA_CEDIS_ACCESS_ODS.md)
  (Access 97 → ODS), y por eso esa fase advierte que el `md_00` Postgres que hoy leen finanzas y
  compras **es data de PRUEBA, no el CEDIS vivo**.

**Al escribir cualquier consulta:** `sucursal='00'` te da oficinas. Si querés el CEDIS, la fuente es
Wincaja (`w00` / `wincaja.*` con `source_branch='00'`), no Kepler.

**Trampas al comparar ventas** (las tres las pisé antes de que salieran los números):

1. **El doctype de venta es `U-D-10`** ("Ticket Contado Caja N"), naturaleza **D**. `U-A-10` es
   *"Entrada por Devolución"* — leelo de `kdmm`, no lo adivines.
2. **El SKU de `kdm2` es `c8`**, no `c3` (`c3` es la naturaleza del documento). Verificable: 777,425
   líneas de `c8` existen en `kdii`; de `c3`, cero.
3. **⚠️ Los folios se RECICLAN.** Unir `kdm2`→`kdm1` por `(sucursal, c1, c2, c3, c4, c6)` filtrando
   la fecha **sólo en el encabezado** hace que líneas viejas con folio repetido se peguen a
   encabezados recientes: infló las ventas de Kepler a **$8.59M contra $4.34M reales (2×)**. Usá la
   fecha propia de la línea (`kdm2.c32`) o acotá las dos puntas.

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

> ### 0. NUNCA ADIVINES UNA COLUMNA. INVESTIGÁ LA FUENTE.
>
> Kepler no tiene nombres de columna ni comentarios: es `c1, c2, c3…` sobre 226 tablas. Eso vuelve
> **irresistible** suponer — y toda suposición sobre un `cN` termina en dinero mal calculado, porque
> nadie la ve fallar: devuelve un número plausible.
>
> Antes de usar un `cN` en código, **probalo contra una verdad externa**:
> - **Contrastalo con un hecho independiente.** ¿El costo? contra lo que realmente pagamos. ¿El precio?
>   contra lo que realmente cobró el PdV. Si la mediana de la razón no da ~1.000, no es lo que creés.
> - **Probá la unidad explícitamente.** ¿La razón se pega a 1, a `bf`, o a `1/bf`? Es la prueba que
>   destapó ADR-051 (3.3 pp de margen falso) y la que confirmó §2.1.
> - **Buscá el placebo.** Corré el mismo test sobre la ventana espejo *anterior*. Un 78% que también
>   da 78% hacia atrás no es señal, es rotación.
> - **Pedí la pantalla.** Una captura del Kepler real decodifica en un minuto lo que la aritmética
>   tarda horas en inferir — y encima la verifica renglón por renglón. `kdpv_prov_prod` salió así.
> - **Escribí cómo lo verificaste**, no sólo la conclusión. El que venga necesita poder re-correr la prueba.
>
> Y cuando la fuente no alcance para decidir, **declaralo** — no lo dibujes como cero ni lo publiques
> con `%`. Un dato ausente que se declara cuesta una consulta; uno que se adivina cuesta un trimestre
> de decisiones. Corolario operativo: **un descubrimiento vacío nunca es un estado válido** — es la
> fuente inalcanzable disfrazada de éxito (ver [`GOTCHAS.md`](GOTCHAS.md) §30).

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
5. **Box factor: usá `analytics.v_product_box_factor`, NUNCA `kdii.c84` crudo.** `c84 IN (0,1)` **no**
   significa "no tiene caja" — significa "Kepler no lo capturó". Medido 2026-08-31: 7,247 SKUs marcados
   así y **6,135 sí tienen escalera de unidades real** en `kdpv_prov_prod` (factor mediano 16×). Tomar
   `c84` a ciegas falla en 4 de cada 5. Tampoco lo adivines del nombre. Ver §2.1.
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
