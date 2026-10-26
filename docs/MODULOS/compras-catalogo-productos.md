# Compras › Catálogo › Productos — vista Sencilla y Detallada (PF.12)

## Problema

La pestaña Productos mezclaba en una sola pantalla todo lo que se había ido agregando: renglón de conteos, aviso de
precios BASE-MXN, barra de proveedores, selector «Por proveedor / Para cuidar hoy», chips de ejemplo, una fila de 12
pestañas (4 vacías) y un panel de flujo con «Editar producto». Para saber **en qué unidades se vende un producto y a
qué precio** —lo que más se pregunta— había que abrirlo, y la unidad salía como «Caja × 20» aunque Kepler la registre
en paquetes. El buscador no encontraba por todos los códigos de barras ni por unidad.

## Solución

- **Un botón Sencillo / Detallado** sobre la misma lista. Arranca en Sencillo y recuerda la última elección.
- **Sencillo** (para quien sólo consulta): Producto · Proveedor · Unidades de medida (una por renglón, con su
  equivalencia: «CJA = 20 PAQ») · Precio por unidad. La ficha lateral trae identidad (SKU para copiar, estado, todos
  los códigos con el principal), unidades y precio (mayoreo, «mismo precio en las N sucursales»), venta y existencia
  por sucursal **en unidades compuestas** («65 CJA 5 PAQ») y la última entrada (costo sólo con permiso).
- **Detallado** (para quien compra): lo mismo más **Este mes** (venta con impuestos del 1 a hoy, ▲▼ contra los mismos
  días del mes anterior) y etiquetas (Líder #N, Nuevo · día N, Caducado / Caduca pronto). Su ficha agrega: Qué hacer
  y traspasos (del motor PF), dónde se mueve y dónde se estancó, «¿Cómo va la venta este mes?» en palabras y dos
  barras, margen y compras de 90 días (con permiso de costo) y caducidad por lote.
- **Un solo buscador**: palabras con o sin acento, cualquier código de barras, proveedor y palabras de unidad
  («caja», «bulto»); dice por qué coincidió.
- **Menú «Ver»** agrupado (Productos · Precios y costos · Por corregir) en lugar de la fila de pestañas; las 4
  vacías se ocultan. **Menú «Mostrar»** con conteos, filtrado en el servidor.
- Se quitaron: conteos, aviso BASE-MXN, barra de proveedores, selector «Por proveedor / Para cuidar hoy», chips de
  ejemplo y **el diálogo «Editar producto»** (decisión de David en la maqueta; ver «Riesgos»).

## Cómo se implementó

- API (`libs/commercial/src/lib/commercial-products/`), aditiva, permiso `COMMERCIAL_PRODUCTS_VER`:
  - `GET commercial/products/catalogo` (`search`, `sucursal`, `page`, `pageSize` ≤ 200, `mostrar`); con
    `vista=detallado` agrega venta del mes, variación, etiquetas y veredicto.
  - `GET commercial/products/catalogo/:id/ficha` y `GET commercial/products/catalogo/:id/compras`.
  - Búsqueda en `catalogo-busqueda.ts` (`f_unaccent`, códigos por `(tenant_id, sku)`, unidades por
    `analytics.v_kepler_unit_ladder`).
  - Precio de `commercial.product_label_prices` por sucursal; venta de `mv_kepler_sales_daily` +
    `v_branch_erp_cutover`; existencia del ODS; última entrada de XA2001.
  - **Sin tabla nueva ni migración.** Las fotos caras usan `FotoSwr` (60 s).
- Frontend (`apps/view/src/app/modules/compras/`): `catalogo-menu`, `producto-ficha`, `producto-ficha-detallada`,
  `unidades-composicion.ts` (cantidad base → unidades compuestas, de mayor a menor).

## Por qué así

- **«Qué hacer» no se calcula para todo el catálogo**: en prod un proveedor de 269 productos ya tardaba 1.1–1.9 s y
  hay 11,008 activos. Se calcula sólo si la búsqueda deja ≤ 200 productos; si no, las 5 opciones dicen «sin medir»
  (ADR-056), no un número inventado.
- «No se venden» sale de la foto `product_flow_watch`, que sólo guarda los 300 de más dinero detenido (en prod eran
  969 el 9-oct): el menú lo dice.
- Sin la columna `sucursal` de `product_label_prices` (migración NORM.3) los precios se declaran «sin medir».

## Riesgos y pendientes

- **«Editar producto» ya no existe en Compras**: era el único lugar que llamaba a `updateProduct` aquí. Falta
  decidir dónde vive.
- `producto-flujo-panel.component.ts` quedó sin uso (no se borró).
- La identidad y «Unidades y precio» están copiadas entre las dos fichas: deuda con nombre, extraer subcomponentes.
- Tiempos medidos sólo en la base local (48–307 ms, muestra mínima): falta medir en prod.
