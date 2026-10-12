# Compras › Catálogo › Productos — revisión por proveedor (PF.9)

## Problema

Compras revisa muchos productos de un mismo proveedor. La pestaña era un listado paginado de 13 columnas con los
nombres en mayúsculas, y antes del primer producto había cuatro tarjetas de conteo y el bloque «Para cuidar hoy». Para
saber qué hacer con un producto había que leer un código de color y abrirlo.

## Solución

- Una barra con los proveedores ordenados por venta del mes (con su variación contra los mismos días del mes
  anterior) y, aparte, los productos **sin proveedor**: nadie los está pidiendo.
- Al elegir un proveedor: su venta del mes, cuántos productos hay que comprar, cuántos están agotados en alguna
  sucursal y cuántos son líderes.
- Chips por situación (Comprar · Mover entre sucursales · Esperar · No comprar · Líderes) con su conteo, un buscador
  dentro del proveedor y orden por venta, por «se acaba primero» o por nombre.
- Un renglón por producto, en palabras: nombre legible, venta del mes, **para cuántos días alcanza** (con barra) y
  **qué hacer y por qué** en una frase («Se acaba en 3 días», «Agotado en Yurécuaro», «Es líder: se le compra antes
  de los 21 días»). El margen sólo aparece con permiso de costo.
- El clic abre el panel de siempre (flujo, sucursales, márgenes, caducidad) con «Editar producto» adentro.
- «Para cuidar hoy» queda como una vista aparte; su número cuenta sólo lo que pide hacer algo hoy.
- El buscador de arriba sigue buscando en todo el catálogo.

## Cómo se implementó

- API (`libs/commercial/.../commercial-products`):
  - `GET /commercial/products/flow/proveedores`: proveedores con productos activos y venta del mes
    (`mv_kepler_sales_daily` con el corte por sucursal de `v_branch_erp_cutover`). Los productos sin proveedor y el
    comodín de Kepler «PRODUCTOS SIN PROVEEDOR» se juntan en un solo grupo.
  - `GET /commercial/products/flow/proveedores/:id` (`sin` = sin proveedor): el flujo de todos los productos activos
    del proveedor con el mismo cálculo de la tabla (`resumenes()`), más la frase corta (`motivoCorto`) y el resumen.
  - Ambos con `COMMERCIAL_PRODUCTS_VER`; el margen sólo con `COMPRAS_COSTO_ESTANDAR_VER`. Sin migración.
- Pantalla (`apps/view/.../compras/pages/compras-catalogo.component.ts`); las funciones puras (nombres legibles,
  filtros, orden, barra de cobertura) en `compras/catalogo-proveedor.ts`, con su prueba.

## Por qué así

- **En vivo con espera corta** (decisión del usuario), no una foto en segundo plano: la respuesta de un proveedor se
  guarda un minuto por proveedor y permiso, y dos pedidos al mismo tiempo comparten el cálculo. Medido en prod (sólo
  lectura): la lista de proveedores 280–340 ms; un proveedor grande (269 productos) 1.1–1.9 s la primera vez y al
  instante dentro del minuto.
- **Por proveedor** porque así trabaja Compras: se le compra a un proveedor, no a un producto suelto.
- **Lo que no se puede medir se dice**: un producto sin venta dice «No se vende», no muestra una barra vacía; si falla
  la carga se avisa, no se pinta una tabla vacía que parezca «sin productos».
