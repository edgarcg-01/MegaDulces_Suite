# ERP Kepler — decode y flujo hacia la plataforma

> Guía para devs que van a tocar feeds, importers, finanzas, compras o analytics.
> El decode nació de ingeniería inversa sobre los datos — trátalo como conocimiento vivo:
> verificá contra el dato real antes de asumir. **Este doc NO contiene credenciales ni hosts**
> (esos viven en el vault / `.env`, ver Etapa 2 del roadmap de equipo).
>
> **Auditoría estructural del Kepler crudo: 2026-09-11.** Censo de las 8 réplicas + arbitraje contra
> dos POS vivos. Lo que se midió está en **§2.4** (forma del schema), **§2.5** (historia de precio
> nativa), **§3** (los 4 ejes del doctype) y **§4.1/4.2** (la ruta al ODS y su fecha de vencimiento).
> En esa pasada se corrigieron **cinco contradicciones internas de este mismo archivo** — están
> marcadas en su lugar. Lo arbitrado y lo declarado sin medir viven en
> [`VERDAD_ABSOLUTA.md`](VERDAD_ABSOLUTA.md).

---

## 1. Qué es Kepler y por qué duele

Mega Dulces corre **Kepler**, un ERP retail/distribución mexicano. Su schema está **ofuscado a propósito**:
tablas `kdXX` (`kdii`, `kdm1`, `kdil`…) y columnas `c1, c2, c3…` **sin nombres ni comentarios**. Todo el
"significado" se dedujo cruzando datos, forms `.kpl` del ERP y comportamiento observado.

**Regla de oro para investigar Kepler:** buscar por **nombre de tabla + contenido**
(ej. `WHERE x::text ILIKE '%FUMIGACION%'`), nunca por nombre de columna (no existen).

Hay **una DB Kepler por rama**, y hoy son **ocho**: `00` … `07` (ver §2.3 — ⚠️ la `00` es **OFICINAS**,
no el CEDIS; `06` Canindo y `07` Morelia Madero entraron después de que se escribiera este doc).
Cada rama tiene su propio `kdii`, `kdil`, etc. Referencias exhaustivas en:
- [`docs/IMPLEMENTACION/KEPLER_CATALOGO_TABLAS.md`](IMPLEMENTACION/KEPLER_CATALOGO_TABLAS.md) — barrido curado por dominio.
- [`docs/IMPLEMENTACION/KEPLER_TABLAS_COMPLETO.md`](IMPLEMENTACION/KEPLER_TABLAS_COMPLETO.md) — inventario de tablas.

**Cuántas tablas hay, medido** (auditoría 2026-09-11, §2.4): **322–358 por rama**, **371 en la unión** de
las 8. No es un número: *depende de la rama*. Sólo **315** existen en las ocho; las otras **56** son
drift real — 21 son tablas de período (`kdc2YYMM`, que nacen cada mes) y 35 son **módulos instalados
en unas ramas y no en otras** (nómina `kdrh*` sólo en `00/01/06/07`, variantes de `kdfe33*`…). Una
consulta escrita contra una rama **puede no compilar en otra**.

---

## 2. Tablas clave decodificadas

| Tabla | Qué es | Columnas clave |
|---|---|---|
| **`kdii`** | Maestro de productos (por sucursal) | `c1`=SKU · `c2`=nombre · `c7`=código de barras (EAN) · `c8`=clave familia · `c84`=piezas por caja (⚠️ ver regla 5) · **`c33`=mínimo · `c34`=punto de reorden · `c35`=máximo** · **`c11`/`c80`/`c83`=rótulos de la escalera de unidades** (uni1/uni2/uni3 — ver §2.1) · `c90`=precio configurado (respaldo; sólo coincide ~58% con lo cobrado) |
| **`kdil`** | Existencia/acumulados **por almacén** | ⚠️ `c1`=**ALMACÉN (no sucursal)** — filtrá por la columna `sucursal` + `c1`=almacén principal · `c3`=SKU · **existencia = `c4`(inicial) + `c8`(entradas) − `c9`(salidas)** — ⚠️ `c9` es **SALIDAS**, NO la existencia (ver §2.2) · `c6/c7`=última compra/venta |
| **`kdik`** | Valuación **por almacén** | ⚠️ **`c1`=ALMACÉN** (igual que `kdil` — ver regla 7, que lo omitía) · `c2`=SKU · `c6`=existencia · `c9`=valor a costo → costo unitario = `c9/c6` · **`c16`=costo unitario NETO almacenado** (es el que leemos; ver §2.1) · ⚠️ `c8` **NO es** existencia×costo (casa sólo 43.4%) |
| **`kdpv_prov_prod`** | **Costo por proveedor por producto** (la pantalla "Costos por Proveedor por Productos") | `c1`=**código de proveedor** · `c2`=SKU · `c3`=descripción · **`c4`=Costo Uni Mayor** · `c5`/`c6`/`c7`=**% Desc 1/2/3** · **`c8`/`c9`/`c10`=Total Uni 1/2/3** (los 3 peldaños de la escalera) |
| **`kdpv_bitacora_precios`** | **Historia NATIVA de precio, con el peldaño** (⭐ ver §2.5 — la teníamos y nadie la lee) | `c1`=fecha (sin hora) · `c2`=hora **como texto** · `c3`=SKU · **`c4`=unidad del peldaño** (`CJA`/`PAQ`/`PZA`/`KG`/`BTO`…) · `c5`=descripción · **`c6`=precio anterior · `c7`=precio nuevo · `c8`=diferencia** · `c9`=motivo (vacío en la práctica) |
| **`kdm1`** | Encabezados de documentos (200 cols) — compras, ventas, ajustes | `c1`=sucursal · **`c2/c3/c4/c5`=género/naturaleza/grupo/tipo** (4 ejes → `kdmm.c1/c2/c3/c4`; ver §3) · `c9`=fecha del documento ⚠️ **puede venir en el FUTURO** (medido: hasta 2026-12-31) · `c10`=forma de pago · **`c68`=fecha de CAPTURA** ← la que sirve para ventanas |
| **`kdm2`** | Detalle/líneas de documentos (1.26M filas) | `c8`=SKU · `c9`=cantidad · `c32`=fecha (≈ header) |
| **`kdmm`** | **Catálogo de tipos de documento** (la piedra Rosetta) — PK `(c1,c2,c3,c4)`, 170 filas | **`c1`=género · `c2`=naturaleza · `c3`=grupo · `c4`=tipo** · `c5`=descripción · **`c8`=¿afecta inventario?** · `c19/c20`=cuenta cargo/abono · ⚠️ **NO confundir con la tabla `doctype`** (§3) |
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

- ✅ **CORREGIDO 2026-09-07 (mig `20260907210000`).** Nuestro almacén `code='00'` se llamaba
  **"Cedis Oficinas"**, un nombre que juntaba las dos cosas justo en la cabecera que lee el
  operador. Hoy se llama **`CEDIS BPIRAPUATO`** y el nombre coincide con la fuente: `kepler_code`
  es NULL y `wincaja_source_branch = '00'`, o sea que desde la mig `20260902170000` su existencia
  sale del **CEDIS de verdad**, no de oficinas. Medido el 2026-09-07: **201 SKUs con existencia,
  183,213 unidades base, $6,481,431** a costo promedio, última venta 2026-09-04 (los 149 SKUs que
  esta tabla citaba eran de la ruta anterior por `commercial.stock`).
  ✅ Y su **plaza también se corrigió** (mig `20260907220000`, autorizada por Edgar el mismo día):
  apuntaba a la zona **OFICINAS**, que es plaza de La Piedad, cuando el CEDIS está en **Irapuato**.
  Queda en **NULL** — no hay zona de Irapuato y crearle una con cero usuarios sería inventar
  estructura; es el precedente que `20260829130000` fijó para `04`. Medido antes de tocar:
  `warehouses.zone_id` **no filtra nada por sí sola** (es el default que propone el alta de usuarios;
  `UsersService.derivarZona()` devuelve `undefined` = *"no toques lo que ya tiene"*) y **0 usuarios**
  tienen el `00` como almacén, así que ningún alcance cambió. En la misma migración se cerró el hueco
  de `[ID.23]` que dejaba `MD-30`/`MD-32` sin plaza (su seed filtraba a códigos de 2 dígitos) mientras
  las zonas `MORELIA ABASTOS` y `MORELIA MADERO` tenían 10 y 4 usuarios y ningún almacén.
- ⚠️ **Desactualizado, se conserva por trazabilidad:** *"`wincaja.branches` apunta el CEDIS a
  `warehouse_code='MD-00'`, que no existe en `commercial.warehouses`: la existencia del CEDIS real
  no está modelada."* Ese crosswalk sigue diciendo `MD-00`, pero la vista canónica **no une por el
  código** sino por `wincaja_source_branch` (justamente para no perder el CEDIS en silencio — ver
  el comentario en `20260902170000_erp_stock_on_hand_view.js`), así que la existencia del CEDIS
  **sí está modelada** desde el 2026-09-02.
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

### 2.4 ⭐ La forma del schema, medida (auditoría estructural 2026-09-11)

Censo sobre las 8 réplicas + **arbitraje contra dos POS vivos** (`md_02` y `md_03`, sólo catálogo).
Todo lo de abajo está medido, no supuesto.

| Qué | Medido | Qué significa para vos |
|---|---|---|
| **Llaves primarias** | **100%** de las tablas tienen PK | La identidad SÍ existe, y es **natural compuesta** de columnas `cN` (`kdm1`=6 cols, `kdm2`=7, `kdij`=9, `kdii`=1, `kdud`=**`c2`**, no `c1`). No hay surrogates. |
| **Llaves foráneas** | **CERO**, en las 8 réplicas **y en los dos POS** | No hay integridad referencial declarada en todo el ERP. Lo que la sostiene es la aplicación. |
| **UNIQUE / CHECK** | **CERO** / **CERO** | Ninguna regla de negocio está expresada en el motor. |
| **Triggers de usuario** | **CERO** | Nada se dispara solo. |
| **`NOT NULL`** | **100% de las columnas** | ⭐⭐ **Kepler no puede expresar "no hay dato".** La ausencia se codifica con centinelas: `''`, `0`, y fechas `1800-01-01` (visto en `kdik.c3`). *Un cero de Kepler puede ser un cero o puede ser un vacío, y el tipo no los distingue.* |
| **Nombres de columna** | **~96%** son `cN` opacas | Sólo **21 de 340** tablas tienen columnas con nombre, y son los módulos nuevos (`crdcredit`, `doctype`, `webuser`, `orgbranch`, `orglogtbl_*`, `pos95*`). |
| **Columnas muertas** | `kdm1` **126 de 200** · `kdm2` **23 de 70** · `kdik` 58/109 · `kdue` 8/31 | Más de la mitad del schema core está 100% vacío. **Y una columna muerta se ve idéntica a un cero legítimo.** |
| **Tipos** | `numeric(15,2)`×464 (exacto) pero **`double precision`×190** | El dinero está mezclado: parte exacto, parte flotante. ⚠️ **`kdik.c16` —nuestro costo de existencia canónico— es `double precision`.** |
| **Índices** | ver abajo ⚠️ | |

⚠️ **Las "columnas muertas" NO son iguales en todas las ramas.** Excluyendo `md_07` (que tiene 3 días
de vida y contamina el conteo), hay **8 columnas en `kdm1` y 4 en `kdm2`** que están vacías en una
rama y **con dato en otra**. Descartar una columna mirando una sola sucursal es un error medido.

⚠️⚠️ **La réplica NO tiene los índices del POS.** Arbitrado:

| | réplica | POS vivo |
|---|---|---|
| índices `md_02` | **341** (sólo los de PK) | **810** |
| índices `md_03` | **337** | **808** |
| versión Postgres | 18.6 | **16.4** |

O sea: **todo lo que consultamos contra las réplicas corre sin ~470 índices por rama.** Explica los
tiempos que la Fase AX tuvo que arreglar con índices de expresión. Las columnas **sí** están completas
(0 columnas del POS faltan en la réplica), así que la replicación no corre riesgo por ahí.

**Integridad de hecho, sin una sola FK** (medido, y es buena noticia):

- `kdm2` → `kdm1`: **0 huérfanos de 924,835**. La convención se cumple.
- `kdm1` → `kdmm` (doctype): **2 huérfanos de 627,577** encabezados en las 8 ramas.
- `kdik` → `kdii` (existencia → catálogo): **132 filas fantasma** en las 8 (la `03` aporta 86).
  ⚠️ **Su valor está SIN MEDIR**: `kdik.c8` no pasó la prueba de unidad, ver §7 de
  [`VERDAD_ABSOLUTA.md`](VERDAD_ABSOLUTA.md).
- `kdm1` sin líneas en `kdm2`: 3,462 (2.5%) — **la mayoría es legítima** (cobros, gastos,
  transferencias no tienen renglón de producto). Pero **262 `U-D-5` "Factura TK Contado"** y
  **103 `U-D-8` "Factura Telemarketing"** sin una sola línea sí son anomalía.

**Kepler no sabe en qué sucursal está.** `orgbranch` —el catálogo de sucursales del ERP— tiene **2
filas genéricas en inglés** (`B001 Main branch` / `W01 Main store`) en *todas* las ramas. Cada
instalación se cree la única. **La dimensión `sucursal` no sale del dato: sale de a qué base te
conectaste.** Es un invento nuestro, y por eso existe el concentrado.

### 2.5 ⭐ La historia de precio que ya teníamos y nadie lee

`kdpv_bitacora_precios` es una **bitácora nativa de cambios de precio, con el peldaño de unidad en
cada renglón**. Medido en `md_02`: **905,546 filas**, del **2024-10-12 a hoy**, 8,426 productos,
14 unidades distintas. En `kepler_ods` hay **5.6M filas**. **Ningún archivo de `libs/`, `apps/` ni
`services/` la consulta** (verificado por grep).

⚠️ **Pero el 94.5% es ruido de recálculo**: 856,078 de esas filas son cambios de **menos de un
centavo** (`15.6000 → 15.6049`). Los cambios reales (≥ $0.01) son **49,468 (5.5%)**. Quien la use
tiene que filtrar `abs(c8) >= 0.01` o va a "descubrir" un millón de cambios de precio que nunca pasaron.

⚠️ La columna de unidad trae basura junto con lo bueno: `CJA`, `PAQ`, `PZA`, `KG`, `BTO`, `CUB`… y
también **`500` y `250`** (números como unidad) — la misma patología de rótulos que describe §2.1.

Lo mismo aplica a **`orglogtbl_YY`**, la bitácora nativa de cambios por tabla (`k_table`, `k_mode`,
`k_date`, `k_user`): **2.48M filas de 2026** en el ODS, y tampoco la consulta nadie. Las dos son
candidatas directas del hueco *"cero historia de datos maestros"* que declara la Fase VP.3.

---

## 3. El modelo de documentos (género · naturaleza · tipo)

Todo en Kepler es un **documento** clasificado en `kdmm`. **Son CUATRO ejes, no tres**
(género · naturaleza · grupo · tipo), y el apareo con `kdm1` va **corrido en uno**:

```
kdm1.c2  →  kdmm.c1   género      (N · U · X — y sólo esos tres)
kdm1.c3  →  kdmm.c2   naturaleza  (A · D)
kdm1.c4  →  kdmm.c3   grupo       (el número: 10, 30, 37, 40…)
kdm1.c5  →  kdmm.c4   tipo
```

Verificado 2026-09-11 en las 8 ramas: **2 encabezados de 627,577** no casan con `kdmm`. El decode es
sólido — pero el corrimiento es exactamente el tipo de error que devuelve un número plausible.

> ⚠️ **NO confundas `kdmm` con la tabla `doctype`.** Son dos catálogos distintos que hablan de lo
> mismo con **alfabetos distintos**, y `doctype` es la tentadora porque tiene columnas con nombre:
>
> | | `kdmm` (170 filas) | `doctype` (81 filas) |
> |---|---|---|
> | idioma | español, los documentos **reales** de esta instalación | inglés, la taxonomía **abstracta del producto** |
> | "género" | `c1` ∈ **`N` · `U` · `X`** | `k_gender` ∈ **`N` · `P` · `S`** |
> | para qué | ⭐ **es la piedra Rosetta, la que hay que leer** | modelo interno del ERP; no aparea con `kdm1` |
>
> Que las dos tengan una columna llamada "género" y que una de ellas esté en inglés y legible **no
> la vuelve la buena**. `kdm1` aparea con `kdmm`.

Los más importantes:

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
8 DBs Kepler — ramas 00..07, Postgres 16.4 en el POS
        │  ① replicación lógica nativa (WAL).  Publicación FOR TABLES IN SCHEMA md.
        │     MEDIDO 2026-09-11: las 8 conectadas, lag 1–28 SEGUNDOS.  ✓ sano
        ▼
  kepler_md_00 … kepler_md_07   (réplicas en :5433, mismo schema md.*, Postgres 18.6)
        │  ② replicate-ods-live.js — normaliza y consolida en UNA tabla por entidad
        │     MEDIDO 2026-09-11: corre en verde y embarca CERO.  ✗ ROTO (ver abajo)
        ▼
  kepler_ods.*   ← LA FUENTE CANÓNICA (single-DB, columna `sucursal`)
        │  vistas "derive-no-copy" (erp_collections, erp_customers, kepler_bank_movements…)
        ▼
  analytics.* / commercial.*  → endpoints → frontend
```

- **`kepler_ods.*`** es el modelo canónico: una tabla por entidad Kepler, con columna `sucursal`.
  **Todo lo que necesite dato de Kepler debe leer de acá**, no de las ramas ni de bases intermedias
  viejas (`KP_CONCENTRADA`, `Mega_Dulces`).
- ⚠️ **La rama `00` de Kepler SÍ está en el pipeline** (réplica `kepler_md_00`, suscripción activa).
  Lo que **no** está es el **CEDIS de verdad**, que corre sobre **Access 97** y es otra cosa
  (Fase CA). Este doc decía que "el CEDIS (00)" estaba fuera del pipeline — mezclaba las dos, ver §2.3.
- Runbook operacional del pipeline: [`docs/IMPLEMENTACION/RUNBOOK_REPLICACION_LOGICA.md`](IMPLEMENTACION/RUNBOOK_REPLICACION_LOGICA.md).
- Modelo canónico y anti-desincronización: [`docs/MODELO_CANONICO_DATOS.md`](MODELO_CANONICO_DATOS.md).

### 4.1 ⛔ Los dos saltos tienen frescuras DISTINTAS — y confundirlas es el error

> **"Lag de segundos" es del salto ①, no del ②.** Este doc afirmaba que `kepler_ods` se alimenta
> "en near-real-time, lag ~segundos". Eso es cierto de las **réplicas**. El ODS —que es lo que lee la
> app— se alimenta del salto ②, y ese se mide aparte. **Poblado ≠ fresco** (ADR-056).

**Cobertura de tablas, medida:** de las **371** tablas del universo Kepler, `kepler_ods` tiene **223**
= **60.1%**. Las 148 restantes nunca se replicaron (mucho es drift por rama y períodos viejos, pero
**no está clasificado** — hueco declarado, no medido).

**Paridad de filas Kepler vs ODS (conteo exacto, 2026-09-11):**

| rama | `kdm1` | `kdm2` | `kdik` | atraso del ODS |
|---|---|---|---|---|
| 00 · 01 · 02 · 03 | 90–97% | 89–98% | 98–99% | **2 días** |
| 04 · 05 | 90–95% | 90–95% | 98–99% | **7 días** |
| **06 Canindo** | **61.4%** | **61.7%** | 94.9% | **7 días** |
| **07 Morelia Madero** | **0.1%** | **0.0%** | **0%** | **invisible** |
| **TOTAL** | **94.9%** (−32,146) | **93.1%** (−283,401) | **90.6%** | |

⭐ **El hueco es del mes en curso, NO histórico.** En la rama 01 los meses cerrados (may–ago) casan
**exacto, Δ = 0 fila por fila**. No hay agujero de backfill: hay un carril que dejó de entregar.

⛔ **La rama `07` (Morelia Madero) NO EXISTE para la plataforma.** Su POS migró a Kepler el 2026-09-08,
su réplica está viva y recibiendo — y el ODS tiene **1 fila** de `kdm1`, **1** de `kdm2`, **0** de
`kdik` y **0** de `kdii`. Ese "1" es un smoke de una fila, no un embarque.

**Cómo se ve la falla desde afuera — y por qué nadie la vio:**

```
ods.ctl (en cada réplica)  →  last_run_at = hace minutos    ✓ "el carril corre"
                              rows_last  = 0 en TODAS        ✗ y no entrega nada
analytics.cron_runs        →  sin latido de ods_live_hot / ods_live_mirror
kepler_ods._sync_status    →  rows_last = 1  ← eso es el smoke, no el carril
```

*Un carril que corre no es un carril que entrega.* El latido tiene que medir **filas entregadas**;
`last_run_at` solo, y `rows_last = 1` de un smoke, se leen igual que "todo bien".

### 4.2 ⏰ La bomba de calendario — fecha exacta: **2027-01-01**

Kepler crea tablas nuevas al cambiar el período (`kdc2YYMM` mensual; `kdcn<YY>`, `kdmx_<YY>`,
`orglogtbl_<YY>` anuales) y **la replicación lógica no replica DDL**. Si el suscriptor no tiene la
tabla, el apply worker muere con `target relation does not exist` y **reinicia cada 5 s para siempre**:
la réplica se congela entera, con la suscripción en `enabled` y el latido en verde.

Medido en las **8** réplicas (2026-09-11): todas cubiertas hasta **`kdc22612`** (dic-2026) y las tres
familias anuales hasta **`_27`**.

> ⛔ **El primer mes sin cobertura es `kdc22701` — enero de 2027 — y cae en las 8 ramas a la vez.**
> Las tres familias anuales aguantan hasta 2028-01-01.
>
> El desactivador existe —`ensure-monthly-tables.js`— pero **no está agendado**: su único invocador es
> `reconcile-ods-window.js`, que `CLAUDE.md` marca como *"escrito y nunca levantado"* (OBS.3, pendiente)
> y que no aparece en [`ops/vl/crontab.feeds`](../ops/vl/crontab.feeds). La cobertura actual la puso
> una corrida a mano. **Corregido de paso:** el header de `ensure-monthly-tables.js` dice que "el 1 de
> enero de 2027 vencen las cuatro familias a la vez"; hoy ya no — las tres anuales están pre-creadas
> para 2027 y sólo vence la mensual.

---

## 5. Reglas de oro (te ahorran bugs de datos)

> ### 0. NUNCA ADIVINES UNA COLUMNA. INVESTIGÁ LA FUENTE.
>
> Kepler no tiene nombres de columna ni comentarios: es `c1, c2, c3…` sobre **322–358 tablas por rama**
> (371 en la unión; medido §2.4 — este párrafo decía "226"). Eso vuelve
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
7. **En las tablas de detalle (`kdil`, **`kdik`**, `kdij`, `kdue`, `kdxe`, `kdpv_descuxq`), `c1` es el ALMACÉN, no la sucursal.** En `kepler_ods`/`kp.*` la rama real es la columna `sucursal` (agregada al concentrar); `c1` es el almacén dentro de la rama. Para existencia de rama: `WHERE sucursal='03' AND c1='03'` (almacén principal).
   ⚠️ **`kdik` faltaba en esta lista** (agregado 2026-09-11, medido).
   ⛔⛔ **Y esta confusión NO se ve fallar.** En **7 de las 8 ramas hay un solo almacén y su código es
   igual al de la sucursal** (`md_04` → almacén `04`), así que tratar `c1` como sucursal **devuelve el
   resultado correcto**. La única que lo delata es la **`03`, que tiene tres almacenes** (`01`=3 filas,
   `02`=3,664, `03`=4,561). Un bug que sólo existe en una sucursal es un bug que se atribuye a "datos
   sucios de esa tienda" durante meses.
   ⚠️ **La existencia NO es `kdil.c9`** — eso son las SALIDAS. Es `c4`+`c8`−`c9`; ver §2.2, que corrigió
   esta misma regla y quedó contradiciéndola hasta hoy.
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
