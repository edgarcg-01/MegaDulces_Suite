# Fase AX — Anexo de venta imprimible (detalle + pagaré)

> **ADR-049.** El documento que se le entrega al cliente se **deriva del ODS, no se copia**: vistas en vivo sobre `kepler_ods` (frescura del CDC, ~segundos) + un renderer que arma el PDF por folio. Cero tablas nuevas, cero importers. Hereda ADR-045/046 (menos fuentes de frescura) y el patrón derive-no-copy de `erp_collections`.

**Estado global:** 🟢 MVP CERRADO (beta local) 2026-08-22 — AX.0+AX.1+AX.2+AX.3+AX.4 ✅
**Persona:** único dev (Edgar).

---

## Por qué

El CFDI está **apretado por el formato SAT** y el cliente no entiende qué compró: precios con 6 decimales, sin equivalencias de empaque, el impuesto sólo como un total al final. La queja concreta: *"¿120 paquetes son cuántas cajas? ¿a cómo me sale la pieza?"*.

El CFDI **no se toca** (es el comprobante fiscal). Se le acompaña un **anexo informativo** que desglosa lo mismo en lenguaje de tendero, más un **pagaré** cuando la venta va a crédito.

## Qué NO se hace (anti-scope)

Tocar el CFDI o su timbrado · escribir en Kepler (sigue read-only) · tabla copiada de facturas (mataría la frescura) · factura de mostrador U/D/10 (160k docs/90d, otro problema) · agente de impresión con driver/ESC-POS (el navegador basta hoy).

---

## Decisiones tomadas con datos (no con el catálogo)

| Qué | Hallazgo | Fuente |
|---|---|---|
| **Doctypes** | U/D/8 (100% producto) y U/D/12 (99.7%) SÍ; **U/D/13 NO** — sus 1,097 líneas son 100% servicio (es la factura del traspaso CEDIS; el detalle real vive en U/D/41) | conteo 30d |
| `kdud.c16` | **días de crédito** — correlación perfecta: toda factura con 15 días reales tiene `c16='15'` | cruce kdm1×kdud |
| `kdud.c15` | **límite de crédito** (C3078 = $0.00) | — |
| `kdud.c14` | **zona**, NO el límite (30000 = zona 3, va con lista 30003) | corrige suposición previa |
| `kdm1.c12` | **vendedor** (`kduv.c2`→`c3` = "DANIEL FRANCISCO FRANCO"), NO lista de precios | match de 3 vías con el CFDI impreso |
| `kdm1.c18` | **NO usar como vencimiento**: trae fechas anteriores a la propia factura | verificado |
| Vencimiento | `fecha + dias_credito`; sin días asignados vence al día siguiente | regla de negocio (Edgar) |
| Santa Ana Pacueco | **existe fiscalmente** — localidad de Pénjamo, Gto., **C.P. 36910** (catálogo SAT `kdfe33satcp`: GUA/023). Ojo: se escribe con una sola "n" | 8 direcciones reales + SAT |
| CLABEs | las 3 **validan** dígito verificador (Banxico 3-7-1) y son consistentes con su nº de cuenta | `kepler_ods.kdb1.c3` |

**Descuento (decode):** `kdud.c17` = % del cliente (41 clientes con 2%, 32 con 3%). Se guarda como **total** en `kdm1.c13`; el descuento por renglón **no se persiste**. Encima hay una capa por producto: el mismo cliente da 2.000% en una factura y 1.729% en otra, según qué líneas trae.

### Unidades de medida — VERBATIM de Kepler (2026-08-24)

Censo real de `kdm2.c11` (30d, U/D/8+12): **PAQ** 5,708 · **PZA** 1,736 · **KG** 1,142 · **500** 94 · **CJA** 23 · **CUB** 16 · **250** 13 (a 90d aparecen además **2KG** y **400**). El bulto del catálogo es `kdii.c83` y **no siempre es caja**: hay 552 SKUs KG × **BTO**.

La capa de presentación traducía con un mapa fijo `{CJA,PAQ,PZA,KG}` y pluralizaba lo demás → fabricaba unidades que **no existen** ("500s", "cubs") y rotulaba "paq. por caja" aunque el bulto fuera BTO. Regla de Edgar: **cero unidades inventadas**. Corrección en tres capas:

| Capa | Qué cambió |
|---|---|
| Vista (mig `20260824120000`) | expone `unidad_venta` = `kdii.c11` y `unidad_bulto` = `kdii.c83`, passthrough (`NULLIF(btrim(...))`, sin `CASE`) |
| Service | el factor `c84` sólo aplica si la línea se vendió **en la unidad del catálogo** y el bulto existe y difiere — **83 líneas/90d** se venden en otra unidad, donde la equivalencia sería falsa; ahí se suprime |
| PDF / pantalla | códigos tal cual (`120 PAQ`, `= 5 CJA`, `24 PAQ por CJA`, `por BTO`); los códigos puramente numéricos se rinden `15 × 250` para que no se lean "15,250" |

**Verificación (prod, 2026-08-24):** el smoke compara la vista contra `kdm2.c11` / `kdii.c11`/`c83`/`c84` **crudos**, línea por línea (30/30). Un test de mutación (inyectar `PAQ→paquetes`) confirma que la aserción muerde. El smoke quedó registrado en `run-all-tests.js` con skip-graceful si faltan las vistas.

### Barrido total: 5,501 facturas × 35,877 renglones (2026-08-24)

Se comparó **cada** renglón contra Kepler crudo (FULL OUTER JOIN) y se corrió el `derivar()` real del service sobre toda la población. La fidelidad del espejo salió perfecta —0 faltantes, 0 sobrantes, 0 duplicados, 0 diferencias de unidad/factor/cantidad/precio/importe— pero salieron **cuatro defectos propios** y **dos huecos de datos del ERP**:

| # | Qué estaba mal | Alcance | Corrección |
|---|---|---|---|
| 1 | El descuento por renglón se repartía usando `kdud.c17`; con 0% en catálogo el reparto no alcanzaba el objetivo y con objetivo negativo no corría | **593 de 5,128** facturas: la columna NETO no sumaba el total del CFDI (802 con 0% y descuento real hasta $761; 348 con total > Σlíneas) | reparto proporcional al importe, por mayor residuo, con signo → Σ NETO == total **exacto** en las 5,120 que reconcilian |
| 2 | El factor de empaque salía de `kdii.c84` crudo, ignorando el resolvedor canónico | **212 líneas / 195 facturas** contradecían al resto del sistema; **13,935** escondían la equivalencia | la vista trae `box_factor` de `analytics.v_product_box_factor`; se imprime sólo si >1 y no `is_master_suspect` |
| 3 | Las canceladas se listaban como ventas y 2 conservan renglones | **280** facturas en $0; el anexo llegaba a mostrar $43,904 de mercancía con total $0 | `doc_estatus`/`cancelada` (`kdm1.c43='C'`); fuera del listado y del PDF |
| 4 | Tabla con "Desc. 0%", columna de `−$0.00` y dos columnas de precio idénticas | **4,973 de 5,128** facturas no traen descuento | sin descuento, la tabla es de 4 columnas y el producto gana el espacio |
| 5 | *(dato ERP)* facturas cuyo único renglón es de servicio | 95 con total > 0 (hasta $439,527) | `sin_detalle`; el PDF se niega |
| 6 | *(dato ERP)* detalle incompleto: renglones que arrancan en L7/L3/L5 | **6** facturas; una habría inflado sus 2 productos +56% | `detalle_explica_total` (hueco ≤15%, medido: 5,120/5,128 caen dentro); el PDF se niega |

Extra: `02UD0801-0001080` L1 tiene `importe` $12.36 con `1 PAQ × $85.55` — inconsistencia de Kepler en **1 de 35,877** renglones; se muestra verbatim, no se corrige.

**Verificado:** barrido total 16/16 · 14 documentos límite renderizados y auditados (unidades KG/CUB/500/250/2KG/400 y bulto BTO, granel con override, 81 renglones) + los 3 rechazos disparando, 59/59 · factura ancla 53/53 · smoke prod 30/30.

---

## Arquitectura

```
kepler_ods.kdm1/kdm2  ──CDC ~seg──▶  analytics.erp_sales_invoices      (VISTA)
   ⋈ kdud  crédito/cliente               analytics.erp_sales_invoice_lines (VISTA)
   ⋈ kduv  vendedor                              │
   ⋈ kdii  factor de caja                        ▼
   ⋈ warehouses                    GET commercial/sales-documents
                                         ├─ /            listado + KPIs + applySmartSearch
                                         ├─ /filtros     catálogos de la ventana
                                         ├─ /:folio      detalle (deriva precios y equivalencias)
                                         └─ /:folio/anexo.pdf[?pagare=true]
                                                │
                                   /comercial/documentos (tab de Ventas)
```

**Sin tabla, sin importer.** Cualquier copia reintroduciría el lag de batch que la Fase CDC quitó.

### Lo que el service deriva (Kepler no lo guarda)

Precio con descuento **por unidad de medida**, precio por caja (× `kdii.c84`), equivalencia en cajas —sólo con factor real y compra ≥ 1 caja— y el **descuento por renglón repartido por mayor residuo**: redondear cada línea por separado da $1,357.89 contra los $1,357.87 reales, y el cliente que suma la columna no cuadra.

---

## Sprints

Leyenda: ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD · ⚠️ BLOCKED

### AX.0 — Facturas como vistas en vivo 🧪
- 🧪 **AX.0.1** `analytics.erp_sales_invoices` + `_lines` (mig `20260822140000`), derive-no-copy.
- 🧪 **AX.0.2** Índices de expresión sobre `kepler_ods` (mig `20260822140100`, `CONCURRENTLY` + `transaction:false`): sin ellos el lookup de una factura medía **17.1 s** (las vistas filtran con `btrim()`/`::int` y eso bloquea el índice). Un índice no es copia.
- 🧪 **AX.0.3** Smoke `test-newdb-erp-sales-invoices` anclado en la factura 06 UD0801-0000087.

### AX.1 — Backend de lectura 🧪
- 🧪 **AX.1.1** `libs/commercial/commercial-sales-documents`: list + KPIs (misma `base()` para que no se contradigan) + `applySmartSearch` (cliente/RFC/folio/monto) + filtros + detalle.
- 🧪 **AX.1.2** Gateado con `COMMERCIAL_ORDERS_VER` — no se inventó permiso nuevo.

### AX.2/AX.3 — Pantalla e impresión 🧪
- 🧪 **AX.2.1** `/comercial/documentos` en la familia de reportes de Venta (`REPORTS_TABS`). Tabla densa + `MetricStrip` + `LoadState` + **side-peek** para el detalle (§14: documento extenso nunca en modal).
- 🧪 **AX.3.1** Imprimir: el PDF se trae como **blob** (el endpoint exige JWT; abrir la URL daría 401) → iframe aislado → `print()`. Si el visor no expone `print()` (Safari/iPadOS, WebViews) cae a pestaña nueva con toast.

### AX.4 — PDF del anexo 🧪
- 🧪 **AX.4.1** `AnexoVentaService`: HTML en TS (no `.hbs`) porque el dinero cuadra al centavo y conviene formatear donde se controla el redondeo. Puppeteer directo, igual que `movements-export`/`sell-out-export` del mismo lib — se descartó el `PdfService` de `libs/trade` (no está en su barrel y `ReportsModule` arrastraría WebSocketModule/Mapbox/scanners, creando una arista commercial→trade inexistente).
- 🧪 **AX.4.2** Pagaré como **anexo del mismo documento** (mismo membrete y jerarquía de sección), no hoja suelta. 6 requisitos de LGTOC 170 + moratorio 3% mensual pactado.
- 🧪 **AX.4.3** Logo de impresión 400px (36 KB vs 477 KB): el PDF baja **70%** y queda a 600 DPI. Tipografías del sistema, sin webfonts.

### AX.9 — cobranza, procedencia y el dinero que sí cuadra 🧪 (2026-09-05)

Salió de auditar la pantalla contra prod. **La respuesta corta a "¿son ventas o facturas de telemarketing?": son telemarketing y nada más** — `U/D/8`, canal `TELEMARK` en el **100%**, 2 sucursales (01 y 06), **$8.36M / 738 docs en 30 días = 31%** de la venta al cliente final (doctypes 8+10+12) y **7%** de todo lo que se mueve en `U/D`. Cadena verificada: Pedido `U/D/40` → Embarque `U/D/41/1` → Factura `U/D/8` (1,355 de 1,355 con padre). Sin fugas: los clientes TM facturados en su misma sucursal bajo otro doctype suman **$112k en 90d (0.8%)**.

Lo que estaba mal, y se arregló:

- 🧪 **AX.9.1 — "vencida" no sabía si ya te pagaron.** Marcaba 355 documentos por $3,320,754 (30d); **91 ya estaban liquidados ($567,504)**. El vencido real: 264 docs y **$2,028,423** de saldo. Ahora `vencida` = venció **y** debe, y el KPI publica **saldo**, no importe facturado. Fuente: `kdue` vía el núcleo compartido — **no** `kdm1.c42/c43`, que van rezagados (563 de 1,346 facturas siguen diciendo "sin abonos" con el cobro ya registrado con folio y fecha).
- 🧪 **AX.9.2 — el vencimiento era una reconstrucción y contradecía al ERP.** Se calculaba `fecha + días de crédito de HOY`; el ERP guarda el pactado al facturar y **difieren en 329 de 729 (45%)**, hasta 25 días. Pero `kdue` tampoco está limpio: **57 de 729 vencen antes de su propia factura**. Veredicto ternario que viaja con el dato (ADR-056): `vencimiento_source` = `erp` (747) · `derivado_erp_invalido` (60) · `derivado` (9), y la pantalla lo declara.
- 🧪 **AX.9.3 — el subtotal no cuadraba con los renglones impresos.** Medido sin excepción: **el IEPS ya viene dentro del renglón** (744/744 sin descuento: Σrenglones == total EXACTO, nunca `total − ieps`) y **`total = Σrenglones × (1 − d%)`** en 1,268/1,268. De ahí `importe_bruto = total/(1−d)`, validado contra la suma real en **3,264 de 3,264** (peor delta $0.93) contra 1,039 del `subtotal` viejo. El anexo dejó de **afirmar** el desglose del CFDI: no hay con qué contrastarlo — `fiscal.cfdis` tiene 167,503 filas y **todas** son `rol='recibidas'`. `commercial-profitability` leía esos dos números; su tasa de descuento pasa de 0.744% a **0.765%**.
- 🧪 **AX.9.4 — etiqueta equivocada.** `U/D/12` decía "Venta a crédito"; `kdmm` dice **"Factura Cont No Fiscal"** (y `U/D/13` es la de crédito). `doc_tipo`: `credito` → `contado_nf`.
- 🧪 **AX.9.5 — `kdm1.c43` decodificado** sobre 2,745 documentos, separación perfecta: `N` sin abonos (`c42 == total`) · `R` abono parcial (`0 < c42 < total`) · `F` liquidada (`c42 == 0`) · `C` cancelada. Confirmado en mostrador: 62,646 tickets de contado son `F`. Viaja como `doc_estatus_label`, **no** como estado de cobro.
- 🧪 **AX.9.6 — una sola definición del saldo.** En vez de copiar la fórmula de la cartera (GOTCHAS §32), su CTE `base` se extrajo a `analytics.erp_receivable_documents` y `customer_receivables` pasa a apoyarse en él. Candado de paridad contra prod: 29 columnas, diferencia simétrica en ambos sentidos = **0**, Σ saldo y Σ signed idénticas. Índice de expresión en `kdue`: scan 162 → **28 ms**, consulta 2,119 → **931 ms** (requiere el `ANALYZE`, sin él el planner lo ignora).

### AX.10 — el papel: identidad fiscal de verdad, y la hoja usada 🧪 (2026-09-07)

Disparador: *"necesito que mejoremos el apartado de las facturas… que la hoja optimice todo el uso en columnas para que use todo el espacio disponible, y optimice el consumo de hojas verticalmente. el rfc esta mal y como se imprimi el nombre"*.

**Los dos datos equivocados, verificados antes de tocar (no se adivinó ninguno):**

- 🧪 **AX.10.1 — el RFC del emisor estaba HARDCODEADO y MAL.** Imprimía `LOGL8810144QS` y *"Lugar de expedición: C.P. 59701, Michoacán"*. Lo correcto es **`LOGL851014AQ5`** y **C.P. 36910**, confirmado por **tres fuentes independientes**: `fiscal.issuer_config` (la config del emisor de la Fase FE: RFC, razón social, régimen 612, CP 36910), los **167,503 CFDIs recibidos** de `fiscal.cfdis` —todos con `receptor_rfc = 'LOGL851014AQ5'` desde 2018-01, y el receptor de una factura recibida somos nosotros— y **11 fichas internas** de `kepler_ods.kdud`. Iba impreso en el membrete, en el beneficiario del pago y **en el pagaré**. El CP viejo además **se contradecía con el propio pagaré del mismo documento**, que dice Santa Ana Pacueco, C.P. 36910. ⚠️ **El resto del repo ya tenía el correcto** (el importer de ContPAQi, el placeholder del formulario de facturación, el matcher de OCR): era un typo en una constante que nadie cruzó nunca contra nada. Ahora sale de `issuer_config` vía `emisorFiscal()`, con cache en proceso, y **si no hay fila configurada el anexo se niega a imprimir** — un RFC inventado en un pagaré es peor que no emitirlo.
- 🧪 **AX.10.2 — el nombre se imprimía roto.** El beneficiario del pago se capitalizaba con `/\b\w+/g`, y en JS `\w` **no matchea letras acentuadas**: `LUIS FRANCISCO LÓPEZ GUTIÉRREZ` salía como **"Luis Francisco LÓPez GutiÉRrez"** en todos los anexos. Se imprime **verbatim**, que además es lo correcto para un beneficiario de pago: la razón social tal como consta en el RFC, no una versión bonita.
- 🧪 **AX.10.3 — el RFC genérico del SAT se pasaba por RFC del cliente.** **1,298 de 1,640 facturas imprimibles (79.1%)** traen `XAXX010101000` en `kdm1.c22`, y el anexo lo ponía bajo la etiqueta "RFC" al lado de un nombre propio. Ahora se **rotula** (`XAXX010101000 · público en general`) y en el **pagaré se OMITE**: en un título de crédito un RFC que no es del deudor es peor que ninguno (el art. 170 LGTOC no lo pide; el deudor queda identificado por nombre, domicilio y número de cliente).

**El papel — medido, no estimado.** Banco A/B sobre **15 facturas reales** de 14 días (3 por tramo de renglones), renderizando la misma muestra con el anexo de `HEAD` y con el nuevo:

| renglones | antes | después |
|---|---|---|
| 1 (×3) | 2 hojas | **1** |
| 4 (×3) | 2 hojas | **1** |
| 9 (×3) | 2-3 hojas | **2** |
| 17 (×3) | 3 hojas | **2** |
| 31 (×3) | 4 hojas | **2** |
| **TOTAL** | **41 hojas** | **24 (−41%)** |

14 de 15 facturas bajan de hojas; promedio 2.73 → **1.60 por factura**. Y una factura de hasta ~8 renglones ahora entra **completa con su pagaré en UNA hoja**.

De dónde salió, en orden de rendimiento:

1. **La unidad pegada al precio.** Iba en su propio renglón (`$495.00` / `por CJA`), así que un producto de 3 niveles gastaba **6 líneas por columna** — y hay dos columnas de precio. Pegada (`$495.00 /CJA`) son 3. Es la mitad del alto de la tabla en facturas largas.
2. **Dos filas del pie fundidas en una.** "Importe con letra + totales" y "cómo leer + bancos" eran dos filas apiladas de **252 px** con la mitad de cada una en blanco; encima el `align-items:stretch` estiraba la caja de texto hasta el alto de la tabla de bancos. Y su renglón central (`Importe − Descuento = Total`) **repetía al peso** el bloque de totales de arriba. Ahora: bancos a la izquierda, totales a la derecha con el importe con letra como pie (donde se lee, como en un cheque), y las dos notas como prosa al pie.
3. **Anchos dimensionados con el dato.** Medido sobre los **14,872 renglones de 90 días**: la cifra más larga es `$49,750.20` de precio por caja (≈90 px con la unidad) y `$36,810.00` de importe (≈65 px); el nombre de producto llega a 70 caracteres con p95 = 41. El nombre tenía **22%** y se partía en dos renglones constantemente —una línea de alto pagada en TODAS las facturas— mientras `CANTIDAD` gastaba 14.5% para decir "1 CJA". Ahora el nombre toma **38.5%** (60% en el modo sin descuento) y el dinero se queda con su peor caso más un margen.
4. **Membrete y título en una fila** (eran dos bloques apilados con una regla en medio: 82 px para cuatro datos), **tira de datos en tres columnas** en vez de dos (el alto lo fijaba la columna más larga: 7 renglones contra 4, tres de alto pagados en blanco), márgenes **12 → 9 mm** de lado (+3% de ancho útil, dentro del área imprimible de cualquier láser) y el rótulo de grupo sólo **desde 10 productos** (con 6 costaba 40 px para decir algo que la columna Cantidad ya dice en cada línea).
5. Régimen por **código** en el membrete: su descripción de 62 caracteres envolvía dos renglones para repetir un dato del catálogo público del SAT que el CFDI ya trae.

**Candado `libs/commercial/.../anexo-venta.spec.ts` (19/19, `nx test commercial`).** Es la primera prueba automática que tiene este documento: antes sólo existía al imprimirlo. Cubre las tres correcciones **con su prueba negativa** —las tres pasaban en verde con el bug puesto—:

- ningún literal con forma de RFC puede volver al archivo (el gate lee su propio fuente), y el RFC viejo no aparece ni en la salida ni en el código;
- el nombre acentuado sale intacto, y el test **ejecuta la capitalización vieja** y afirma que producía exactamente `Luis Francisco LÓPez GutiÉRrez`: si esa línea deja de producir basura, el que lea el test se entera;
- `emisorFiscal()` **truena** sin fila en `issuer_config`;
- el genérico se rotula y el pagaré lo omite; con RFC real, lo pone;
- **los anchos de columna suman 100%** en los dos modos (nada de papel sin repartir) — verificado en rojo a propósito subiendo `neto` de 10% a 14%;
- no vuelve ningún bloque del layout viejo (`foot-grid`, `admin`, `titleband`) ni la unidad en renglón aparte.

Smoke `test-newdb-sales-docs-cobranza.js` **13/13 contra prod** (el dinero no cambió). Builds api y view verdes. **Sin migraciones y sin permisos nuevos → sin re-login.**

### Diferidos
- ⬜ **AX.5** Agente de impresión por WebSocket (`/print`, room por sucursal) para sucursal desatendida. Hoy **no existe** ESC/POS ni agente local en el repo; el navegador cubre oficina.
- ⬜ **AX.6** IA: búsqueda en lenguaje natural → **filtros estructurados** (el LLM nunca calcula importes, ADR-016); aviso de riesgo por motor determinista; OCR del pagaré firmado (`extractDepositSlip` ya recibe PDF nativo).
- ⬜ **AX.7** Control de pagarés: folio propio, estado firmado, evidencia.
- ⬜ **AX.8** Extender a factura de mostrador U/D/10 (160k docs/90d) si se pide.

---

## Sobre el pagaré (qué es y qué no)

**No tiene ni tendrá valor fiscal** — no es CFDI, no deduce, no acredita. Lo fiscal ya lo cubre el CFDI de ingreso y, al cobrar, el **REP** (la factura es PPD).

**Valor legal:** hoy el PDF es un *formato*. Se vuelve título de crédito con **firma autógrafa en papel**; el título es el papel, no el PDF (incorporación, arts. 42-68 LGTOC para reposición). Acción cambiaria directa, prescribe a 3 años del vencimiento.

⚠️ **Antes de producción**: que un contador y un abogado mercantil revisen el texto una vez.

---

## Pendiente para prod

1. `npm run migrate:new` — aplica lo que falte de: `20260822140000` (vistas) ✅, `20260822140100` (índices) ✅, `20260824120000` (unidades) ✅, **`20260824140000` (estatus + empaque canónico) ⬜**.
2. `node database/tests/test-newdb-erp-sales-invoices.js` (avisa si quedó lento = faltó la de índices).
3. Redeploy api + view.

### AX.9 (2026-09-05) — pendiente en prod

Aplicadas y verdes en el `.245`; en prod **no** (al 2026-09-05 hay 9 migraciones pendientes ahí, de otros trabajos: el orden lo decide quien despliegue).

1. **`20260905150000_erp_receivable_documents_core.js`** — índice + núcleo + `CREATE OR REPLACE` de la cartera.
   ⚠️ Corre **fuera de transacción** (`CONCURRENTLY`) y puede quedarse en *"waiting for old snapshots"* detrás de un `REFRESH MATERIALIZED VIEW`. En el `.245` esperó ~15 min. No bloquea a nadie; si urge, lanzarla sin refresh en vuelo.
   ⚠️ Comparte timestamp con `20260905150000_blank_retired_role_permissions.js` (de otro trabajo). Knex ordena por nombre completo, así que `blank_…` va primero — determinista, pero conviene saberlo. **No se renombra**: ya está aplicada en el `.245` y borrar/renombrar una migración aplicada deja el directorio "corrupt".
2. **`20260905150100_erp_sales_invoices_cobranza.js`** — recrea sólo la cabecera (`_lines` no se toca; nada depende de la cabecera, verificado en `pg_depend`).
3. `node database/tests/test-newdb-receivable-core-parity.js` → debe decir **REGRESION** y 0 FAIL (antes de aplicar dice PRE-APLICACION, y también sirve).
4. `node database/tests/test-newdb-sales-docs-cobranza.js` → 13 OK.
5. Redeploy api + view. **Sin permisos nuevos → no hace falta re-login.**

**Orden obligatorio: migración ANTES del redeploy** — el service pide `estatus_cobro`, `saldo`, `importe_bruto`, `vencimiento_source`. Al revés (código nuevo, vista vieja) el listado tira 500.
Aplicar sólo las migraciones, sin redeploy, es **seguro**: la vista conserva todas las columnas viejas y el código en prod sigue leyendo `subtotal`/`descuento`.

**Medido en prod (2026-09-07):** ver la tabla de la sección siguiente. Falta sólo el **redeploy de api + view** (el código con el CTE materializado) y la validación visual.

### AX.9 en PROD (2026-09-07) — aplicada, medida y con una trampa del planner de por medio

**Las 2 migraciones están en prod**: batch **288** (núcleo + índice + cartera, 6 s) y batch **289**
(cabecera, 3 s). Cada una aplicada por nombre, sin arrastrar ninguna de las 9 pendientes ajenas.
Smokes contra prod: paridad **6/6** (modo REGRESION) y cobranza **13/13**. El `CONCURRENTLY` esta
vez no esperó: no había refresh en vuelo.

**Lo que el KPI estaba contando mal, medido en prod a 90 días: 366 facturas por $2,819,231.67**
que decía vencidas y ya estaban cobradas (928 → 553). En la ventana de 30 días: 371 documentos con
la fecha pasada → **292 realmente vencidos con $2,340,863 de saldo**, 80 pagados y 9 sin cartera.

⚠️ **Y una trampa que sólo aparece en prod: la pantalla tardaba 24 segundos.** El `LEFT JOIN` a la
cartera es inocuo hasta que aparece un `LIMIT`: ahí el planner cambia a nested loop y
**re-escanea el CTE `src` de la cartera (14,623 filas, en disco) una vez por fila devuelta**
(`loops=50` en el EXPLAIN). Medido en prod, tres consultas y tres veces el mismo patrón:

| consulta | antes de AX.9 | AX.9 sin arreglo | AX.9 arreglada |
|---|---|---|---|
| `list()` página 1 | 387 ms | **23,856 ms** | **970 ms** |
| `filtros()` sucursales | ~470 ms | **10,853 ms** | **418 ms** (los dos catálogos juntos) |
| `kpis()` | 1,056 ms | 791 ms | 791 ms |
| `detail()` cabecera | 182 ms | 405 ms | 405 ms |

El arreglo es el mismo en los dos casos: **materializar la selección ANTES de ordenar/recortar**
(`WITH sel AS MATERIALIZED`). Con eso el planner elige hash join —lo que `kpis()` hacía desde el
principio por ser agregado, y por eso nunca se vio afectado— y la última página cuesta lo mismo
que la primera (959 ms con OFFSET 500).

**Lección:** el costo de un join a una vista con CTE **no es un porcentaje, es un salto**, y sólo
se dispara con un LIMIT. Medirlo en el .245 (donde `list()` daba ~880 ms) no lo destapó: hizo
falta la consulta REAL del service —con su `ORDER BY` y su `LIMIT`— contra prod. Una medición de
"la misma consulta pero sin paginar" habría dado verde y publicado una pantalla inusable.

### Lo que AX.9 cuesta, y lo que encontró de paso

**El precio del cruce con la cartera: ~750-880 ms fijos**, cobrados igual para 738 documentos que para uno solo (medido en el `.245`, misma sesión: lookup 6→764 ms, lista 30d 25→735 ms). El costo es el `DISTINCT ON` sobre `kdue` (528 ms) y **no se puede filtrar**: el WHERE del consumidor cae sobre columnas derivadas que el planner no puede invertir. `NOT MATERIALIZED` no ayuda (774 vs 755 ms). Se acepta —es el precio de que el vencido deje de contar $567,504 ya cobrados, y esto es un reporte, no un camino caliente— y queda la salida escrita en la migración por si estorba: retirar el LEFT JOIN de la cabecera y resolver la cobranza en el service, sólo en `list()`/`kpis()`.

⚠️ **Hallazgo preexistente, NO tocado: el smoke `test-newdb-erp-sales-invoices.js` (AX.0) no termina.** Su bloque del `box_factor` canónico —el que cruza `erp_sales_invoice_lines` × `erp_sales_invoices` × `v_product_box_factor` a 90 días— **se pasa del `statement_timeout` también en prod, con la vista vieja**, así que el candado que debía cazar a quien vuelva a derivar el factor por su cuenta está muerto. Nadie lo había visto porque el test apunta por default a `localhost:5433/postgres_platform` (el contenedor de réplicas), donde **no existen las vistas** y sale por el `SKIP` sin ejecutar una sola aserción. Se verificó que **no es regresión de AX.9**: la misma consulta ya se colgaba en prod, donde este cambio no está aplicado. Arreglarlo es otro sprint: acotar la ventana cambiaría lo que el candado mide, y hay que decidirlo con la intención original a la vista.

**Orden obligatorio: migración ANTES del redeploy.** El service pide `cancelada`, `box_factor`, `box_factor_dudoso`; con la vista vieja el detalle tira 500.

Sin el paso 1 la pantalla carga vacía: las vistas no existen en prod.

## Decisiones abiertas

- ¿Permiso propio `COMMERCIAL_SALES_DOCS_VER` (10 touch-points) para que aparezca en sidebar y `/admin/roles`? Hoy reusa `COMMERCIAL_ORDERS_VER` y vive sólo como tab.
- ¿El pagaré sale siempre o sólo con crédito?
- ¿Se necesita AX.5 (impresión desatendida en sucursal) o basta el navegador?
