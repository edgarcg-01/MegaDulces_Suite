# Tienda › Arqueo de caja — en RD/RV la ruta se elige junto a la caja (ARQ-RUTA.1)

## Problema

En el arqueo de una ruta (RD o RV) la ruta se elegía en un bloque aparte, debajo del tipo de arqueo, lejos de la caja a
la que se le está entregando el efectivo.

## Solución

- Al elegir RD o RV, el selector **Ruta** aparece junto a **Caja**: en el renglón del turno («Caja 2 · Ruta …») o en el
  encabezado del modo manual (Sucursal · Caja · Ruta · Fecha · Cajero).
- Abajo sólo queda el aviso de cuando la sucursal no tiene rutas.

## Cómo se implementó

- `tienda-arqueo.component.ts`: el `p-select` de la ruta se pinta dentro del renglón del turno (que pasó de `p` a `div`:
  un `p` no puede contener el bloque del select) y en el encabezado manual, fuera de la cadena de teclado de sus
  campos. Pruebas nuevas en `tienda-arqueo.component.spec.ts` (4, una con mutación verificada).

## Por qué así

El formulario de conteo sólo se pinta con un turno elegido o en modo manual, así que siempre hay una caja a la vista
junto a la cual poner la ruta. **Pendiente:** que las rutas salgan solas de Kepler por sucursal. Kepler no declara el
tipo de ruta (la letra del código engaña: `2V004` es telemarketing), así que el tipo seguirá saliendo del catálogo y lo
que se derivará es la sucursal donde vende cada ruta. Antes hay que medirlo en prod con
`database/scripts/medir-rutas-arqueo-kepler.js` (sólo lectura).

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
