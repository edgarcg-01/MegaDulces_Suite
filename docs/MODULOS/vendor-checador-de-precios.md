# App del vendedor › Checador de precios

> `[VTK.17]` `[VTK.18]` · 2026-11-09 · 🧪 en código y probado, sin PR

## El problema

El vendedor en ruta no tenía dónde consultar el precio de un producto sin abrir un pedido: el cliente
pregunta «¿a cuánto la caja?» y la única respuesta estaba dentro de Tomar pedido, con la lista de precio
de ESE cliente y con señal. En la tienda ese problema ya estaba resuelto con el verificador de precios
(`/tienda/verificador`), pero vive en la app web y el vendedor no lo tiene.

Y en Tomar pedido no se podía buscar leyendo el código de barras: había que escribir el nombre o la
clave, aunque el producto estuviera en la mano.

## La solución

- **El checador vive en el encabezado, en todas las pantallas**, como el buscador del arqueo: una caja
  «Precio: nombre, clave o código» con su cámara. Al escribir o escanear, el precio baja justo debajo del
  encabezado, sin salir de lo que se hace (un pedido a medias sigue ahí), y se cierra con la X, con Esc o
  tocando fuera. Así lo pidió David el mismo día, después de dos versiones descartadas: una pastilla que
  llevaba a otra pantalla («está escondido», «me arroja a otra ventana») y una pestaña con panel («lo
  quiero siempre al alcance, sin importar en qué ventana esté; básate en el de arqueos»).
- **Lo que se ve de cada producto:** cada presentación con su precio y **lo que trae** («Caja $1,057.11 ·
  12 paquetes»), **los dos mayoreos** (pieza y paquete: desde cuántos y a cuánto) y **el proveedor**. Se
  busca también por proveedor. En la ventana del encabezado ya no van las líneas de contexto; la de la
  copia sólo aparece cuando avisa algo (no es de hoy, no hay copia), para que un precio viejo nunca se
  vea como de hoy.
- **El precio es el mismo del verificador de la tienda:** el de Kepler en la sucursal de surtido del
  vendedor (la misma que usa Tomar pedido), por presentación (pieza, paquete, caja) con lo que trae cada
  una. La pantalla dice que **no** es la lista de precio del cliente.
- **Sirve sin señal** con una copia guardada en el teléfono, y **siempre dice de cuándo es**: «Copia para
  usar sin señal: hoy 08:12», o «del 7 nov, 18:03 · no es de hoy». Un precio que salió de la copia lo
  dice junto al precio («Sin señal: este precio es de la copia de hoy 08:12 y pudo cambiar»). Sin señal
  y sin copia, dice que no se puede consultar: nunca pinta un precio inventado.
- **Tomar pedido** trae un botón de cámara en el buscador: lo leído busca ese producto en el catálogo
  del pedido y dice qué se leyó.

## Cómo se implementó

- **Mismos endpoints que el verificador** (`KpModule` de `apps/api`, sin backend nuevo):
  `/api/kp/precio?q=&sucursal=` en vivo (espera 2.5 s) y `/api/kp/precios-todos?sucursal=` para la copia.
- **La copia** se guarda en la base del teléfono (Dexie, tabla `catalogos`, llave
  `verificador-precios:NN`, sin versión nueva de la base) con su fecha de generación. Se baja sola 8 s
  después de abrir la app si falta o no es de hoy, y al entrar al checador. Pesa ~500 KB comprimida
  (9,537 productos de La Piedad Abastos, 0.73 s; medido en prod el 2026-11-09). `/api/kp/**` **no** va
  al service worker a propósito: lo que el service worker guarda no trae su fecha real.
- **Lo que se reutilizó en vez de copiarse** (se movió a `libs/ui-web` con sus pruebas; `apps/view` sólo
  reexporta y sus pantallas no cambian):
  - `precios/catalogo-mostrador.ts` — la búsqueda por nombre, proveedor, clave o código, y cómo se cuenta
    la caja en paquetes (antes `apps/view/.../tienda/mostrador-catalogo.ts`).
  - `camara/lector-codigos.ts` — abrir la cámara con zxing (se carga al tocar el botón), los dos apagados
    de la cámara (antes `apps/view/.../shared/util/lector-camara.util.ts`) y por qué no abrió.
- **Lo nuevo en la app del vendedor:** `checador-precios.ts` (reglas puras), `checador-precios.service.ts`
  (en línea → copia), `components/lector-codigo.component.ts` (botón + capa del video) y la pantalla
  `pages/vendor-checador-precios.component.ts`.
- **Tomar pedido** se busca por nombre y SKU, no por código de barras. El código leído se traduce a su
  clave de Kepler (con la copia del teléfono, o en línea si no está) y se busca esa clave. Medido en prod:
  el SKU del catálogo es la clave de Kepler de 5 dígitos (9,047 de 9,537 casan exacto).

## Diseño: las cinco preguntas (`diseno` §0b)

1. **Qué ve al entrar, en orden:** de qué sucursal es el precio → el buscador con la cámara → de cuándo es
   la copia. Al buscar, la lista; al elegir o leer, el precio de cada presentación, grande.
2. **Qué no ve:** la lista de precio del cliente, existencias, costo, mayoreo de la tienda (pendiente de
   decidir), selector de sucursal, contador de escaneos, modo kiosco.
3. **Accesibilidad de la información:** a un toque desde cualquier pantalla; buscable por nombre, clave o
   código; todas las presentaciones sin otro toque; `Enter` consulta; la cámara pide permiso sólo al
   tocarla y, si no hay, se escribe.
4. **Ligas:** el mismo precio y la misma regla de presentaciones que `/tienda/verificador`. No escribe nada.
5. **¿Le toca a esta pantalla?** Sí: es consulta. Lo que se le cobra al cliente vive en Tomar pedido.

Jerarquía: primario = el precio de cada presentación · secundario = nombre del producto y de la
presentación · terciario = clave, lo que trae, de dónde y de cuándo es el precio.

## Por qué así

- **Mover a `libs/` y no copiar** (ADR-056): el verificador y el checador tienen que contar la caja igual.
  Dos copias de la misma regla terminan diciendo cosas distintas.
- **La copia con su fecha, no la caché del service worker:** la regla es que lo que no se puede medir se
  declara. Una respuesta de caché sin fecha se vería como de hoy.
- **Sin sucursal asignada no se consulta:** el servidor devuelve la sucursal por omisión del tenant
  (`assigned:false`); usarla sería adivinar qué precio le toca al vendedor.
- **Sin llave nueva:** los endpoints son públicos (los usa el kiosco de la tienda) y la pantalla queda
  dentro de la app, que ya exige `VENDOR_APP_ACCESS`. Medido en prod: la tienen vendedor_ruta (19
  usuarios), promotor_ruta (17), superadmin (8), supervisor_ventas (5) y marketing (3). No hace falta
  migración.

## Cómo se probó

- `libs/ui-web`: 38 pruebas (lector 9, catálogo 29). Suite de la librería: 150 verdes.
- App del vendedor: reglas 17, servicio 15, lector 6, pantalla 9, Tomar pedido con cámara 6. Cada regla
  con su prueba negativa (la copia de ayer no dice «hoy»; un código desconocido no pinta precio; sin
  permiso de cámara se puede escribir; sin sucursal asignada no se consulta; «no está» ≠ «no se pudo»).
- Sabotajes (se rompió la regla a propósito y la prueba se puso roja): fecha leída en UTC; «no
  encontrado» re-preguntado a la copia; código en dos productos reducido a uno.
- `apps/view` (tienda, util de cámara, escáner de comercial): 476 verdes con la reexportación.
- Tipos: `tsc` de `apps/view` y de `libs/ui-web` con control; `ngc` de la app del vendedor con plantillas
  verificadas (control detectado y retirado).

## Lo que queda fuera

- **No verificado:** cómo se ve en el celular, la cámara real, sin señal real y la bajada automática.
- El precio «en línea» dice cuándo se consultó, no de cuándo es el dato de Kepler: el latido del ERP
  (`datos_al`) llega vacío para las 9 sucursales.
- **Deuda:** `[VTK.17.D1]` el botón y la capa de la cámara se repiten por app (ninguna librería hospeda
  componentes); `[VTK.17.D2]` el flujo «en línea → copia» existe dos veces (verificador web y checador).
- **Por decidir:** mostrar o no el mayoreo de la tienda; dejar elegir sucursal a quien no tiene
  asignada; si la bajada diaria automática está bien en datos móviles.
