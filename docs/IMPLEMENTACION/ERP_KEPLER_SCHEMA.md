# ERP Kepler — esquema descifrado (referencia)

> Mega Dulces corre **Kepler** (ERP retail/distribución MX). El esquema está **ofuscado a propósito**: tablas `kdXX`, **todas las columnas `c1, c2, c3…`**, sin nombres ni comentarios. Este doc captura el mapeo inferido **desde los datos** — difícil de re-derivar, mantener vivo.
>
> **Este doc = producto/inventario.** Para el **modelo contable** (pólizas `kdc2`, catálogo `kdco`, cuentas, ciclos venta/compra/inventario) ver [`KEPLER_CONTABILIDAD_MODELO.md`](KEPLER_CONTABILIDAD_MODELO.md).

## El dump

- `database/BACKUP.sql` (228 MB) = `pg_dump` **custom-format gzip** de la DB `md_03`, schema `md`. 329 tablas, 1452 entradas TOC.
- **Restaurar** (no es texto plano — datos en binario): `pg_restore -h localhost -p 5433 -U postgres -d md_03 --no-owner --no-privileges -j 4 database/BACKUP.sql` (crear `md_03` antes). Postgres local: contenedor Docker en `localhost:5433`, user `postgres`/`superoot`.
- Trae **2 sucursales con stock: `02` (corte dic-2025, vieja) y `03` (jun-2026, VIVA)**.

## Tablas clave descifradas

| Tabla | Qué es | Columnas (inferidas) |
|---|---|---|
| **`kdii`** | Maestro de productos (9,249) | `c1`=SKU · `c2`=nombre · `c7`=código de barras (EAN) · `c8`=clave familia · c13–c19 numéricos en 0 (precios NO viven acá) |
| **`kdil`** | Existencia/acumulados por sucursal | `c1`=sucursal · `c3`=SKU · **`c9`=existencia actual** · `c8`=cantidad alterna (¿acumulado/máximo?) · `c6`/`c7`=última compra/venta |
| **`kdik`** | Valuación de inventario por sucursal | `c1`=sucursal · `c2`=SKU · `c6`=existencia · `c9`=valor a costo → **costo unitario = c9/c6** (validado: Agua $2.52, Kinder $11.28 — realistas) |
| `kdm1` / `kdm2` | Encabezados (200 cols) / detalle (70 cols, 1.26M filas) de documentos: compras, ventas y **ajustes de inventario** | — |
| `kdpv_bitacora_precios` | Bitácora de cambios de precio (1.3M filas) | — |

**No hay tabla de conteo físico dedicada.** Kepler registra la toma física como un **documento de ajuste** en `kdm1/kdm2` (sin sesión/folio persistido). La **Fase I sí persiste** folio + conteos + varianza — un superset auditable de lo que hace el ERP.

## Reporte "Diario de movimientos" (Almacenes → Reportes → Existencia → Movimientos)

Reporte server-side de Kepler (páginas `.kpl` sirviéndose de `192.168.x`; **el SQL vive en la BD, no en disco**). Lee los documentos de movimiento de inventario desde **`kdm1`** (cabecera) ⋈ **`kdm2`** (líneas). Su diálogo de parámetros mapea 1:1 a columnas de `kdm1`:

| Campo del diálogo | Columna | Valores |
|---|---|---|
| Sucursal | `kdm1.c1` | nº sucursal (`01`, `02`…) — **`kdm1` arrastra réplicas de otras sucursales → filtrar `c1` propio siempre** |
| **Género** | `kdm1.c2` | `U`=Ctas x cobrar · `X`=Ctas x pagar/compra · `N`=Otras/traspaso/inventario |
| **Naturaleza** | `kdm1.c3` | `A`=Acreedora · `D`=Deudora |
| **Tipo** | `kdm1.c4` | `35`=OC · `37`=vale entrada · `40`=orden entrada (suma existencia) · `20`=aplica/CxP · `50`=devolución… |
| Grupo / Folio | `kdm1.c6` | folio del documento |
| Fecha | `kdm1.c9` | fecha del documento |
| (encadenado al padre) | `kdm1.c37`+`c39` | grupo+folio del doc padre (back-pointer de la cadena) |

Líneas `kdm2` (FK compuesta `c1,c2,c3,c4,c6` → `kdm1`): `c8`=SKU · `c9`=cantidad (puede ser fraccionaria: KG) · `c10`=descripción · `c11`=presentación (`SER`=línea de servicio, no producto) · **`c12`=precio/costo UNITARIO** · **`c13`=IMPORTE de la línea** (`c13 = c9×c12`, verificado 100% en 18 tipos × 4 sucursales 2026-07-13). ⚠️ NO usar `c12` como importe — ese error subvaluó el feed DM (caso XA40 `0000179`: $147 vs $24,100.97 real). `c55/c56/c57/c58` = unidad alterna (presentación/factor/costo por bulto).

**Folio Kepler = `[Género][Naturaleza][Tipo][Serie]-[Folio]`.** Ej. reales: `XA2001-0000065` (Aplicación de orden de entrada, X+A+20+serie01), `XD4001-0000101` (Devolución compra crédito, X+D+40). Cada documento genera su póliza contable (ver [`KEPLER_CONTABILIDAD_MODELO.md`](KEPLER_CONTABILIDAD_MODELO.md)). Cadena de compras: `X-A-35 → 37 → 40 → 20` (misma lógica que `import-in-transit.js`).

**Catálogo `md.doctype` completo** (dump md_03; `k_binv=1` = mueve inventario). Ojo: `X-A-37` (vale de entrada) y los tipos custom Mega Dulces (UA50/UD41/NA06/NA25/NA30/ND06) NO están en este catálogo de sistema — se decodificaron por reconciliación (ver importer DM):

| k_doc7 | k_code | Descripción | binv | | k_doc7 | k_code | Descripción | binv |
|---|---|---|---|---|---|---|---|---|
| `NA1001` | ReqChk1 | Solicitud de cheque | 0 | | `UD5501` | DbNote1 | Nota de cargo (cliente) | 0 |
| `NA1501` | Check1 | Cheque | 0 | | `XA0501` | Purchas1 | Compra | **1** |
| `NA2002` | InvIn1 | Ajuste de entrada | **1** | | `XA0507` | Purchas2 | Compra contado | **1** |
| `ND0502` | InvOut1 | Ajuste de salida | **1** | | `XA1001` | ExpAll1 | Asignación de gasto | 0 |
| `ND2501` | InvTrsf1 | Traspaso (salida) | **1** | | `XA1501` | ExpReq1 | Solicitud de gasto | 0 |
| `ND3001` | PhysInv1 | Inventario físico | **1** | | **`XA2001`** | **ApEntOr1** | **Aplicación de orden de entrada (CxP)** | **0** |
| `UA0501` | Collect1 | Cobranza | 0 | | `XA3001` | Reqn1 | Requisición | 0 |
| `UA1001` | RtrnEn1 | Devolución de venta | **1** | | `XA3501` | PurOrdr1 | Orden de compra | 0 |
| `UA1501` | ApRtrn1 | Aplicación de devolución | 0 | | `XA4001` | EntryOr1 | Orden de entrada | **1** |
| `UA2001` | Rtrn1 | Devolución directa | **1** | | `XA4501` | CrNoteS1 | Nota de crédito (proveedor) | 0 |
| `UA2501` | Bonus | Bonificación (cliente) | 0 | | `XD1001` | ReqPay1 | Solicitud de pago | 0 |
| `UA3501` | CrNote1 | Nota de crédito (cliente) | 0 | | `XD2501` | ApReqPy1/Payment1 | Aplicación de pago / Pago | 0 |
| `UA4001` | Advance | Anticipo (cliente) | 0 | | `XD3001` | RtrnPrd1 | Devolución a proveedor | **1** |
| `UD0501` | Sale1 | Venta directa | **1** | | `XD3501` | ApRtrPrd1 | Aplicación devolución prov. | 0 |
| `UD0502` | Sale2 | Venta contado | **1** | | `XD4001` | RtrnPur1 | Devolución de compra | **1** |
| `UD2001` | Invoice1 | Factura de remisión | 0 | | `XD5501` | DbNoteS1 | Nota de cargo (proveedor) | 0 |
| `UD3501` | Quotat1 | Cotización | 0 | | `XD6001` | AdvSup | Anticipo (proveedor) | 0 |
| `UD4001` | Order1 | Pedido de venta | 0 | | `UD4501` | Remiss1 | Remisión | **1** |

**`XA20` Aplicación de orden de entrada** (verificado 2026-07-14): back-pointer `c37=40/c38/c39` → su orden de entrada XA40; **duplica las líneas de producto 1:1** (muestra 0000180: 3 líneas, 830 pzs, $3,472.25 idénticos en ambos docs). Es el paso CONTABLE que genera la CxP al proveedor — `k_binv=0`, por eso está excluida del feed DM (incluirla doblaría las entradas). Volumen 90d: CEDIS 2,843 / sucursales 80–329. Relevante para PaymentsService/CxP (Fase LM/RA), no para inventario.

### Áreas de mejora (vs. lo que construiríamos como feed `analytics.stock_movements` + endpoint + página Operations)

1. **Integridad.** Sin **saldo corrido** (no es kardex real: falta `existencia_antes → ±mov → existencia_después`); sin **cuadre contra `kdil`** (drift silencioso — cf. bug `kdil.c9`); **réplicas cross-sucursal** no advertidas (doble conteo); **cadena rota** invisible (OC sin recepción, vale huérfano); **signo ambiguo** (deriva de `c2+c3+c4` → normalizar a cantidad con signo).
2. **Valor analítico.** Sin **valorización** (piezas sin $, aunque `kdm2.c13`=importe de línea está disponible); sin **agregaciones** (totales por producto/tipo/proveedor/día); sin **detección de anomalías** (ajustes atípicos, salidas sin venta); sin dimensión temporal/tendencia.
3. **UX.** Códigos crípticos (`U/X/N`, `D/A`) sin labels legibles; rango de fechas único sin presets; sin consolidado multi-sucursal; output HTML estático (no ordenar/filtrar/buscar/drill); sin configuraciones guardadas.
4. **Performance.** `NOT EXISTS` anidado sobre `kdm1/kdm2` sin índice compuesto `(c1,c2,c3,c4,c6)`; réplicas inflan scans; HTML monolítico sin virtualización.
5. **Integración.** Solo HTML/impresión — **sin CSV/JSON, sin API**, sin tiempo real. No alimenta BI ni se automatiza.
6. **Auditoría.** No muestra quién capturó ni cuándo (usuario, timestamp captura vs fecha doc); sin historial de cambios/reversas.
7. **⭐ Agregación primero, folio a folio bajo demanda.** El diseño arranca **colapsado en el agregado**, no en el detalle. Jerarquía de drill-down:
   - **Nivel 0 (default):** totales **por producto** en el rango — `Σ entradas`, `Σ salidas`, `neto`, **valorizado $** (`GROUP BY kdm2.c8`). Un renglón por SKU.
   - **Re-agrupable** con un click: por tipo de documento / proveedor / día-semana / almacén.
   - **Drill 1:** expandir producto → movimientos agrupados por tipo.
   - **Drill 2:** expandir tipo → folios individuales (`kdm1`) con fecha, cantidad, usuario, estado de cadena.
   - **Drill 3:** abrir folio → documento completo + póliza + cadena `35→37→40`.
   - Regla: nunca se arranca en el detalle; se desmenuza **solo la rama de interés**, el resto queda colapsado (igual que un pivote financiero).

## Join a nuestra plataforma

**`kdii.c1` == `public.products.sku`** (mismo esquema de códigos — nuestro catálogo vino de este Kepler). Mapeo por SKU dentro del tenant Mega Dulces. Overlap sucursal 03: **3,936/4,066 (97%)**; los 130 sin match son SKUs que no están en nuestro catálogo (ej. BOING).

Relación con `productos_activos`: ese sync (DATABASE_URL_REMOTE_SNAPSHOT, 6,489 SKUs) es la **vista limpia** sobre este mismo Kepler. Este dump crudo aporta lo que la vista no expone: barcode, clave familia, bitácora de precios, las dos sucursales.

## Importer de stock

`database/importers/kepler/import-kepler-stock.js` — lee Kepler (kdil existencia + kdik costo) de una sucursal y puebla `commercial.stock`.

- Dry-run por defecto (imprime match/sin-match + muestra de validación); `--apply` escribe.
- Args: `--branch 03` · `--warehouse KEPLER-03` · `--exist-col c9`.
- Join por SKU; idempotente (upsert por tenant+warehouse+product).
- **Aplicado 2026-06-15**: sucursal 03 → almacén **KEPLER-03** (creado), **3,936 SKUs / 1,127,490 unidades**. La Fase I ya puede contar contra stock real.

## Write-back de inventario físico (Fase I → Kepler)

Kepler registra ajustes de inventario con documentos de tipo (tabla `doctype`):
- **`PhysInv` / `PhysInv1`** (k_doc7=`ND3001`) = Physical inventory (toma física).
- **`InvIn` / `InvIn1`** (`NA2002`, nature N/A) = entrada (sobrante).
- **`InvOut` / `InvOut1`** (`ND0502`, nature N/D) = salida (merma).
- Header `kdm1`: c1=sucursal, c2='N' (nature inventario), c3=A/D (dirección), c4=tipo, c6=folio, c9=fecha.
- Líneas `kdm2`: c8=SKU, c9=cantidad, c11=presentación, c12=costo unitario, c13=importe de línea.

**Mapeo Fase I → Kepler** (endpoint `GET /commercial/inventory/counts/:id/kepler-export`, gate RECONCILIAR):
- Sucursal = código del almacén `KEPLER-NN` → `NN`.
- Por cada item con `variance != 0` del folio reconciliado:
  - `variance < 0` (merma) → línea **InvOut**, cantidad `|variance|`.
  - `variance > 0` (sobrante) → línea **InvIn**, cantidad `variance`.
  - valor = `|variance| × cost_base`. Alternativa: un único PhysInv con `final_qty` (Kepler recalcula su varianza).
- Devuelve `{folio, kepler_branch, date, lines[], summary{merma_value, sobrante_value, net_value}}`.

**Limitación (importante):** NO escribe en Kepler. El ERP de producción tiene header de ~200 columnas, folio/sequencing/triggers propios y mecanismo de import desconocido — escribir directo a `kdm1/kdm2` sería riesgoso e imposible de probar acá. El endpoint produce el documento para **importar/capturar** en Kepler. Un write-back vivo real requiere conocer el API/import de Kepler. Validado contra folio de prueba en KEPLER-03 (AGUA −4→InvOut $9.93, CHURRO +5→InvIn $22.68).

## Pendiente / ideas

- Confirmar con ancla real si `kdil.c9` es la existencia exacta (costos realistas lo respaldan; falta 1 SKU verificado contra la tienda).
- Los 130 SKUs sin match: decidir si se crean en el catálogo o se ignoran.
- Write-back: mapear el formato de ajuste de `kdm1/kdm2` si se quiere que la reconciliación de Fase I genere el documento de ajuste en Kepler.
