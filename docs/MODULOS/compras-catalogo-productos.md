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

## Productos nuevos dentro de Productos (NP.22, 2026-11-04)

- **Problema:** «Productos nuevos» era otra opción del menú «Ver» con su propia pantalla: dos ventanas para el mismo catálogo.
- **Solución (decisión de David):** es un «Mostrar» más, en Sencillo y Detallado, con sub-filtros por resultado del
  lanzamiento (con conteo), columnas «¿Funcionó?» y «Día» y, en la ficha, la sección «Lanzamiento» (cortes 30/60/90,
  sucursales). La ruta vieja redirige a `/compras/catalogo?mostrar=nuevos`. El bloque de resumen se probó y David lo
  retiró: queda una línea «Preliminar» con la ayuda «?».
- **Cómo:** el servidor de Detallado filtra/cuenta/ordena (`mostrar=nuevos&resultado=…&orden=lanzamiento`) con la foto de
  Productos nuevos que ya tenía; Sencillo pide esa respuesta. Ficha: `producto-lanzamiento.component.ts` sobre
  `GET new-products/:id`. Funciones puras en `productos-nuevos-vista.ts`. Sin tabla ni migración.
- **Por qué así:** la lista es paginada en el servidor; filtrar en el navegador escondería la página 2. Un solo universo
  («en seguimiento») para el número del menú, el de los sub-filtros y el del juicio.

## PF.20–PF.23 (2026-11-04): descontinuado, sucursal por alcance, costo por caja y periodo

- **Problema:** la lista pintaba «Activo» junto a nombres «* DESCONTINUADO» (Kepler marca el descontinuado
  reemplazando el nombre); la lista servía el precio de cualquier sucursal a quien la pidiera y el cliente externo
  (`customer_b2b`) podía ver el último costo; la ficha sólo daba el costo en la unidad de la entrada; la venta por
  sucursal era siempre «este mes».
- **Solución:** regla única de descontinuado en `libs/contracts` (`producto-descontinuado.contract.ts`, con su
  versión de Postgres; 0 diferencias entre las dos sobre 13,623 nombres) — etiqueta y al final de la lista;
  sucursal recortada al alcance con la regla de Precios (`sucursalDelCatalogo`, 403 fuera de alcance) y selector
  «Precios de» en Detallado; `puedeVerCostoCatalogo` excluye al cliente externo; la ficha trae el costo en cada
  unidad (`armarUltimoCosto`, la misma función de la lista); calendario de periodo arriba de la ficha (venta por
  sucursal en Sencillo, compras en Detallado) con `periodoFicha`, y lo anterior al corte a Kepler se DECLARA.
- **Por qué así:** una sola regla por dato (descontinuado, alcance, costo por unidad) para que lista y ficha no se
  contradigan; cero migraciones (todo derivado de lo que ya se lee de Kepler).
- **Pendiente:** medir en prod los tiempos del periodo (hasta 2 años) y de la consulta de alcance; «¿Cómo va la
  venta?», «Dónde se mueve» y «Margen real» de Detallado no siguen el periodo; «Familia» (Línea/Tipo/Grupo) espera la
  medición de `database/scripts/medir-pf20-familia-descontinuado.sql` en prod.

## Riesgos y pendientes

- `[NP.22]` Las columnas de la lista vieja de Productos nuevos (venta por semana, vendido con barra de venta por $1,
  margen, 30·60·90 en la fila, sucursales) ya no están en la fila: viven en la ficha («Lanzamiento»). Confirmar con Compras.
- `[NP.22]` Abrir la ficha en Sencillo SIN el filtro pregunta `new-products/:id` y un producto que no es nuevo responde 404
  (no se pinta nada, pero queda en la consola del navegador).

- **«Editar producto» ya no existe en Compras**: era el único lugar que llamaba a `updateProduct` aquí. Falta
  decidir dónde vive.
- `producto-flujo-panel.component.ts` quedó sin uso (no se borró).
- La identidad y «Unidades y precio» están copiadas entre las dos fichas: deuda con nombre, extraer subcomponentes.
- Tiempos medidos sólo en la base local (48–307 ms, muestra mínima): falta medir en prod.
