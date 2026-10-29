# Tienda › Arqueo de caja — un solo menú para el tipo, y el concepto del retiro (SM.49)

## Problema

Un retiro no decía por qué salió el dinero: una sangría, un pago a proveedor o un gasto se veían iguales. Y el
tipo de arqueo era una barra de cinco pestañas que no tenía dónde poner ese concepto.

## Solución

- Un solo menú, «Tipo de arqueo»: arriba **Retiro** (Pago a proveedor · Pago de nómina · Gasto de la sucursal (caja chica) ·
  Depósito al banco · Otro…), abajo **Otros arqueos** (Retiro de caja · Cierre de día · Relevo · RD · RV).
- Abre en «Retiro · elige el concepto»; un retiro no se guarda sin concepto. «Otro» pide escribir el motivo.
- Si Kepler está pidiendo la sangría, el menú ya queda en «Retiro de caja».
- El concepto aparece en los retiros del turno, en el ticket y en «Sucursales y sus cajas», donde además se suma
  lo que salió por concepto (proveedores, nómina…) por turno y por sucursal: todo eso cuenta en el corte del día.
- «Sucursales y sus cajas» nace minimizada (clic en la caja abre sus turnos; el desglose se abre aparte) y ya no
  tiene botón Validar (se usaba en 19 de 730 arqueos en 30 días).

## Cómo se implementó

- Migración `20261028093702_blind_counts_concepto_retiro`: columna `concepto` con CHECK de la lista; el CHECK del
  motivo (SM.47) también lo exige en el retiro «otro».
- `CONCEPTOS_RETIRO` y `conceptoRetiroLabel` en `libs/contracts/src/http/arqueo-cajas.contract.ts`: una sola lista.
- `BlindCountService.submit` valida el concepto y el motivo; el listado y la vista de cajas lo devuelven.
- Pantalla: `p-select` agrupado (`menuTipos`, `menuValor`, `elegirMenu`) en lugar de `app-segmented`.

## Por qué así

- **Todos cuentan como retiro** (decisión del pedido): se ligan al turno y suman al cuadre contra Kepler.
- **El servidor no exige el concepto:** una pantalla vieja en caché mandaría el retiro sin él, y rechazarlo dejaría
  a la cajera sin registrar su sangría en plena fila. La pantalla nueva sí lo exige.
- **Los retiros viejos quedan sin concepto:** no se inventa un dato del pasado.

---

# Tienda › Arqueo de caja — Sucursales y sus cajas, y el folio por caja + hora (SM.48)

## Problema

«Arqueos recientes» era una lista plana: no decía si los retiros de una caja coincidían con lo que Kepler registró,
ni si el turno cuadraba. Y la mayoría de los retiros se guardaba **sin folio de turno**: en octubre, 169 de 190,
porque el usuario de la Suite no coincide con el código de cajera de Kepler y a la cajera no le aparece su turno.

## Solución

- Para quien valida, la tarjeta pasa a ser **Sucursales y sus cajas**: elige el día; a la izquierda las sucursales
  con lo que hay por revisar; a la derecha cada caja con sus turnos.
- En cada turno: la cajera (nombre y código de Kepler), los **retiros contra Kepler** («Cuadran», «Faltan $X por
  contar», «Contado de más») y el **cuadre del turno** (retiros + cajón contra el esperado), explicado en una línea.
- El **desglose** por denominación de cada arqueo (billetes, monedas, totales y total del turno) viene abierto solo
  en los turnos con algo por revisar. Cada arqueo se valida y se reimprime desde ahí.
- Aparte: los conteos que no cayeron en ningún turno y las rutas / conteos de efectivo (no suman a ningún cuadre).
- Al guardar un retiro, cierre o relevo sin folio, el servidor busca el turno abierto en esa caja a esa hora y
  guarda su folio.
- Se adapta a tablet y teléfono.

## Cómo se implementó

- `libs/reconciliation/src/lib/arqueo-cajas.ts` (puro): `elegirTurno` (retiro → turno abierto; cierre → el que cerró
  en las últimas 3 h; dos candidatos → ninguno), `ligarConteos` (por folio, si no por caja + hora; la llave del turno
  es caja + folio) y `armarCajasDelDia` (usa `cuadreTurno`, la identidad única).
- `BlindCountService.cajasDelDia` y `turnoPorCajaYHora` leen `kepler_ods.kdpv_folio_caja` (el ODS vivo).
- `GET /store/arqueo/cajas` (RECONCILIATION_VER). `anclarAlTurno` llama a `folioPorCajaYHora` cuando no hay folio.
- Pantalla: `apps/view/src/app/modules/tienda/arqueo-cajas/arqueo-cajas.component.ts`.
- Contrato: `libs/contracts/src/http/arqueo-cajas.contract.ts` (importado por su ruta directa).

## Por qué así

- **Caja + hora y no usuario:** medido, los códigos de Kepler y los usuarios de la Suite no son 1 a 1 (cuentas
  compartidas, varias personas por código). La caja y la hora son hechos físicos.
- **El ODS vivo y no `analytics.cash_cuts`:** ésta trae el turno hasta el corte; los retiros se capturan antes.
- **Ambiguo = sin turno:** colgarle a un turno el conteo de otro es peor que mostrarlo aparte.
- **Solo quien valida:** la vista trae el esperado y el arqueo de la cajera es ciego.
- Pendiente aparte: limpiar las cuentas compartidas y decidir si el código de Kepler es de la persona o de la caja.

---

# Tienda › Arqueo de caja — totales por familia y «Conteo de efectivo» sin caja (SM.47)

## Problema

1. La tabla de conteo pasaba del último renglón (50¢) directo a «Total en efectivo». La cajera no veía cuánto llevaba
   en billetes y cuánto en monedas, que es como se arma el sobre.
2. La encargada de sucursal, Finanzas y el jefe de zona necesitan contar efectivo que **no es de ninguna caja**
   (caja fuerte, fondo de cambio, un conteo de supervisión). La pantalla siempre pedía una caja y esa gente, en el
   caso de Finanzas, ni siquiera podía abrirla.

## Solución

- Renglones **«Total billetes»** (después del billete de $20) y **«Total monedas»** (después de 50¢) en todas las
  pestañas. No son casillas: Enter y las flechas los saltan. El detalle de un arqueo guardado los muestra igual.
- Pestaña **«Conteo de efectivo»**: sucursal, «Quién hace el arqueo» (el usuario de la sesión, fijo) y **motivo
  obligatorio** (hasta 200 caracteres). Sin campo Caja. La tabla, los medios y la nota siguen igual.
- Quien solo tiene este permiso (Finanzas) abre la pantalla directo en esa pestaña.
- Se guarda como constancia: no hay monto esperado, así que no se muestra diferencia.
- El ticket se titula «CONTEO DE EFECTIVO», dice «Caja: sin caja» e imprime el motivo.

## Cómo se implementó

- Migración `20261022122545_blind_counts_tipo_sin_caja`: tipo `sin_caja` en el CHECK, se numera como el retiro (varios
  el mismo día sin pisarse), columna `motivo` con CHECK (obligatoria en `sin_caja`, nula en los demás).
- Migración `20261022122546_grant_arqueo_sin_caja`: reparte `STORE_ARQUEO_SIN_CAJA_CAPTURAR` a `encargado_tienda`,
  `finanzas`, `finanzas_operativo` y `tesoreria`. No toca un permiso puesto en `false`.
- `BlindCountService`: `sin_caja` en los tipos válidos y sin corte; valida el motivo; lo lee en el listado.
- `StoreArqueoController`: `POST /store/arqueo/sin-caja` impone tipo, `caja = SIN_CAJA` y la firma de la sesión;
  `POST /` rechaza `sin_caja`; `GET /` acepta también el permiso nuevo.
- Pantalla: `canCaptureSinCaja`, `esSinCaja`, `soloSinCaja`; el panel de captura se abre también con el permiso nuevo;
  la ruta y la entrada a Tienda lo aceptan.
- Pruebas: base real desechable (19 ✓), controlador (5), pantalla (12 nuevas) y ticket (3 nuevas), todas comprobadas
  en rojo con una mutación.

## Por qué así

- Tipo nuevo y no `caja` nula: `caja` entra a la clave única y NULL no deduplica; es el mismo camino que RD/RV.
- Endpoint y permiso aparte: la puerta de la cajera (`POST /`) la tiene también `cajero`; si esto fuera un tipo más,
  cualquiera podría sellar un conteo sin caja.
- La firma la pone el servidor: firmar un conteo de dinero a nombre de otra persona no es un campo de formulario.
- No se pisó el `STORE_ARQUEO_VER = false` de Finanzas: el listado acepta el permiso nuevo y solo le devuelve lo suyo.
- Pendiente: decidir qué rol es «jefe de zona» (hoy no existe como rol).

---

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
