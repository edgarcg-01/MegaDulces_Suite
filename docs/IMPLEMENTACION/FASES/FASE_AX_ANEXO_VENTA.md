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

1. Aplicar migraciones `20260822140000` (vistas) y `20260822140100` (índices) en Railway.
2. `node database/tests/test-newdb-erp-sales-invoices.js` (avisa si quedó lento = faltó la de índices).
3. Redeploy api + view.

Sin el paso 1 la pantalla carga vacía: las vistas no existen en prod.

## Decisiones abiertas

- ¿Permiso propio `COMMERCIAL_SALES_DOCS_VER` (10 touch-points) para que aparezca en sidebar y `/admin/roles`? Hoy reusa `COMMERCIAL_ORDERS_VER` y vive sólo como tab.
- ¿El pagaré sale siempre o sólo con crédito?
- ¿Se necesita AX.5 (impresión desatendida en sucursal) o basta el navegador?
