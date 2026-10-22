# Tienda › Arqueo de caja — RD y RV se capturan por ruta, sin caja (SM.46)

## Problema

En RD y RV la pantalla pedía «Caja» además de «Ruta que entrega». En una entrega de ruta la caja no describe
nada: lo que se cuenta es el efectivo que trae un vendedor. Y el botón de guardar se quedaba apagado si la caja
estaba vacía, aunque el servidor no la usa.

## Solución

- En RD y RV ya no aparece el campo Caja. Se elige la sucursal y la ruta.
- Para guardar basta sucursal + ruta.
- La confirmación y el ticket dicen la ruta (por ejemplo «Ruta RUTA 21») en vez de la caja.
- Retiro, Cierre de día y Relevo siguen pidiendo la caja como antes.

## Cómo se implementó

- `tienda-arqueo.component.ts`: el campo Caja va dentro de `@if (!esRuta())`; `canSubmit()` en RD/RV exige
  `sucursalActiva()` + `aRuta`; `rutaLabel()` da el nombre de la ruta para el diálogo y el ticket; `idxCajero` se
  recorre una posición cuando no hay Caja (la cadena de teclado no salta a un campo que no existe).
- `ticket-arqueo.ts`: campo opcional `ruta`; si viene, el papel imprime «Ruta» en lugar de «Caja».
- Dos pruebas nuevas: sin Caja en RD y RV pero sí en Cierre, y RD se puede sellar sin caja mientras que Cierre
  no. Comprobadas en rojo forzando el campo y la regla anterior.

## Por qué así

- El endpoint de ruta (`POST /store/arqueo/ruta`) no recibe caja: pedirla era un dato que nadie guarda.
- Se esconde sólo en RD/RV para no cambiar las otras pestañas, que sí son de una caja.

---

# Tienda › Arqueo de caja — las rutas RD/RV se buscan en la sucursal elegida (SM.45)

## Problema

En las pestañas RD y RV, la pantalla decía «Tu sucursal no tiene rutas de reparto dadas de alta» aunque la
sucursal sí las tuviera. Lo vio `luis_munoz` (auxiliar de tienda, sin sucursal fija) al elegir Padre Hidalgo, que
en producción tiene 7 rutas de reparto y 2 vecinales. Quien recibe el efectivo de un vendedor de ruta no podía
registrarlo.

## Solución

- Las rutas se buscan en la sucursal que se está usando: la del turno de Kepler o la elegida en el selector.
- Al cambiar de sucursal se vuelven a buscar.
- Si todavía no hay sucursal elegida, la pantalla lo pide en vez de afirmar que no hay rutas.
- Si la consulta falla, lo dice («No se pudieron consultar las rutas») con un botón para reintentar.
- Sólo cuando el servidor responde que no hay rutas se muestra ese aviso, con el nombre de la sucursal.
- Al guardar la entrega de ruta también se manda la sucursal correcta.

## Cómo se implementó

- `arqueo.service.ts`: `rutas(warehouseCode)` manda `warehouse_code`; el servidor ya lo aceptaba.
- `tienda-arqueo.component.ts`: un `effect` sobre `sucursalActiva()` llama a `cargarRutas()`, que lleva cuatro
  estados (`sin_sucursal`, `cargando`, `ok`, `error`) y descarta respuestas que lleguen tarde. `submitRuta` usa
  `sucursalActiva()` en vez de `aSuc()`.
- Tres pruebas nuevas con un usuario sin sucursal fija y dos sucursales: pide elegir sin afirmar nada, pide las rutas
  de la sucursal y las vuelve a pedir al cambiarla, y el error se dice como error y se puede reintentar. Comprobadas
  en rojo con la versión anterior.

## Por qué así

El servidor sólo puede deducir la sucursal cuando el usuario tiene exactamente una; con varias responde un error a
propósito, para no recibir dinero en la sucursal equivocada. El defecto era de la pantalla: no le decía la sucursal
y convertía ese error en «no hay rutas», que es afirmar algo que nunca se midió. Separar el error del vacío evita que
se vuelva a confundir uno con otro.

---

# Tienda › Arqueo de caja — «¿Te pidieron algo?» busca por nombre, proveedor, SKU o código y muestra todas las presentaciones (MOS.1–MOS.3)

## Problema

El buscador del arqueo sólo encontraba por nombre (o por el código exacto con Enter) y mostraba un solo precio, el de la
pieza. El cliente pregunta «¿y por caja?» o «¿cuánto de mayoreo?» y la respuesta no estaba. Además, un código que
existía en otra sucursal pero no en ésta mostraba **el precio de la otra plaza como si fuera de aquí**, y un código que
Kepler no tiene sólo daba un aviso: nadie se enteraba en Compras.

## Solución

- Busca desde 3 caracteres por **nombre, proveedor, SKU o código de barras**, y cada renglón dice por qué salió.
- Cada resultado trae **todas sus presentaciones con precio**; la caja se cuenta **en paquetes** cuando el producto tiene
  paquete y la división es exacta (si no, en piezas).
- El **mayoreo** se muestra en la presentación en que Kepler lo captura, por unidad (`$120.00 c/paquete`), y la ventana
  del producto muestra la escalera: precio normal debajo del mínimo y precio de mayoreo desde el mínimo.
- Un código que Kepler no tiene, o que no está dado de alta en esta sucursal, **se anota solo** en Catálogo › No
  registrados. La cajera puede escribir qué es (opcional) o quitarlo si fue un error.

## Cómo se implementó

- `mostrador-catalogo.ts` (lógica pura, con su spec): búsqueda por cuatro campos sobre el respaldo local con
  `normalizarBusqueda`/`tokensDeBusqueda` de `@megadulces/ui-web`; presentaciones con lo que trae cada una; escalones de
  mayoreo.
- El respaldo del verificador (`/kp/precios-todos`) sube a **formato 3**: factor por presentación (`u[].f`) y proveedor
  como índice en un diccionario (`pv` + `pr`). `/kp/precio` publica `proveedor`. El proveedor sale de
  `catalog.suppliers` (el mismo que ve Compras).
- `faltante-express.component.ts`: la lista y la ventana nuevas; el Enter con sólo números y sin flechas sigue yendo
  contra Kepler (la pistola). Lo elegido de la lista se refresca en vivo y la procedencia lo dice.
- Pruebas: `mostrador-catalogo.spec.ts` (18), `faltante-express.component.spec.ts` (7, con una mutación verificada),
  casos nuevos en `verificador.service.spec.ts` y `kp.service.spec.ts`.

## Por qué así

- **El factor de la caja cuenta desde la base**, no desde el paquete (`costo_peldaño = costo_base × factor` cuadra en
  98.5 % de la Unidad Tres, `ERP_KEPLER.md` §2.1.1). Por eso paquetes por caja = piezas de la caja ÷ piezas del paquete,
  y si no divide exacto se dicen las piezas en lugar de inventar un empaque.
- **El mayoreo no se convierte a pieza**: el precio de un escalón de paquete es el de un paquete (mediana 0.93 contra el
  precio del paquete y 8.99 contra el de la pieza). Convertirlo sería cotizar algo que la caja no cobra.
- **Sin red no se anota nada**: el «no está» del respaldo puede ser viejo; sólo Kepler en vivo es autoritativo.

---

# Tienda › Arqueo de caja — la confirmación del corte desglosa pieza por pieza (SM.44)

## Problema

Antes de sellar un corte, el diálogo «¿Confirmas el corte?» mostraba sólo dos renglones: total de billetes y total de
monedas. La persona no podía comparar contra sus fajos qué capturó de cada denominación; un error de captura en una sola
casilla (por ejemplo 50 billetes de $500 en vez de 5) se sellaba sin que se viera.

## Solución

- El diálogo lista cada billete y cada moneda contados, con sus piezas e importe, en el orden del catálogo
  ($1,000 → 50¢).
- Total de billetes y total de monedas con sus piezas, el efectivo contado marcado entre dos reglas, los medios de pago
  con su total y el total del turno.
- Las denominaciones en cero no se listan. La de $20 dice si es billete o moneda.

## Cómo se implementó

- `tienda-arqueo.component.ts`: `desgloseFamilia(fam)` arma las filas desde el mismo `denomCount` que viaja al
  servidor, así que lo que se confirma es exactamente lo que se guarda. Plantilla del `p-dialog` con secciones por
  familia; estilos con los tokens de la escala.
- Prueba en `tienda-arqueo.component.spec.ts`: el orden, los rótulos de la $20, los importes y una negativa (lo que va
  en cero no aparece en el diálogo).

## Por qué así

El diálogo existe como poka-yoke del dinero (sellar es irreversible). Un resumen de dos números no sirve para detectar
el error más común, que es una casilla mal tecleada; el desglose sí. No se listan los ceros para que la lista se lea en
segundos con la fila esperando.
