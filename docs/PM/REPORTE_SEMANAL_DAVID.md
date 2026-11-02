# Reporte semanal de trabajo — David (Desarrollo)

**Periodo:** 25 de agosto al 30 de octubre de 2026 (10 semanas, de lunes a domingo).
**Preparado:** 30 de octubre de 2026. **Se actualiza cada viernes a las 17:00.**
**Fuentes:** los PR y commits de David (cuentas `IngeDavid2209` y `dev-david24`), sus descripciones, el tracker del proyecto y la bitácora diaria del PM ([`BITACORA_CAMBIOS.md`](BITACORA_CAMBIOS.md)).

## Cómo leer este reporte

Cada tema responde tres preguntas:

- **En qué se trabajó:** el problema, tal como lo vive quien usa el sistema.
- **Solución:** qué se construyó o se cambió.
- **Optimización:** qué mejoró. **Solo lleva un número si alguien lo midió**, y se dice dónde quedó registrada la medición (PR o commit). Cuando no hubo medición se escribe «(sin medición)»: es preferible a inventar una cifra. Si un número salió de la base de pruebas y no de producción, también se indica.

| Estado | Qué significa |
|---|---|
| ✅ integrado | El cambio ya entró a `main`. **Integrado no quiere decir que ya esté en producción.** Si trae migraciones, permisos o un despliegue pendiente, se indica en el tema y en «Pendientes». |
| 🔄 PR abierto | Está en revisión y todavía no entra. |
| 🔨 local sin PR | El trabajo existe solo en la máquina de David y no está en GitHub. |
| ⛔ descartado | Se cerró sin integrar, y se explica por qué. |

## Resumen ejecutivo

**Volumen:** 175 PR integrados, 2 abiertos y 21 cerrados sin integrar, en 9 proyectos. De los 175, GitHub marca 173 como fusionados; los otros 2 (#470 y #473) entraron a `main` por commit directo y su PR quedó cerrado.

| Semana | PR integrados | Lo más importante |
|---|---:|---|
| S10 · 27 oct–2 nov (en curso) | 7 | Se integró **vender de otras sucursales de la zona** (PR #455). La cajera **revisa el pedido de preventa antes de cobrarlo**: 8 de 28 pedidos salían con faltantes que el ERP sí tenía. El arqueo gana la vista «Sucursales y sus cajas» y el concepto de cada retiro: 89 % de los retiros se guardaba sin folio de turno. El catálogo de Compras queda en dos vistas, Sencillo y Detallado. En Gastos se **quitó** el horario que iba a bloquear el alta de vales: ahora sólo avisa. |
| S9 · 20–26 oct | 12 | Los pedidos de las vendedoras **por fin le llegan al surtidor** (se habían visto 0 de 12 avisos). Llegan la ruta del vendedor y el tablero del supervisor. El arqueo de rutas encuentra las rutas de la sucursal y se agrega el «Conteo de efectivo». |
| S8 · 13–19 oct | 16 | **Abrir un cliente en Tomar pedido** tardaba entre 12.8 y 19.3 s; se corrigió la causa, pero el tiempo nuevo aún no se mide en producción. Reclutamiento de RH con bolsa de trabajo y bot de WhatsApp. El vale de gasto se cierra solo cuando Kepler lo aplica. |
| S7 · 6–12 oct | 43 | **Asistencia de Mega Talento en la Suite, con 0 diferencias** contra los datos reales. La Existencia pasa de 1.5–2.8 s a 26–45 ms. **93 vales de gasto destrabados**. El embarque toma el viaje de Kepler y el pago a choferes se libera por viaje cerrado. |
| S6 · 29 sep–5 oct | 19 | Los comprobantes de pago a proveedor se validan solos con IA. El ciclo del vale queda conectado con Kepler. Se destraban 25 cajeras que tenían el arqueo bloqueado. |
| S5 · 22–28 sep | 24 | El ticket de un cliente pasa de **18 s a 50 ms**. Las compuertas de calidad dejan de castigar por errores ajenos (estaban en rojo en 24 de 26 corridas). Gastos queda separado en capturar y aprobar. |
| S4 · 15–21 sep | 19 | Nace el módulo Tickets de venta. Un arreglo en el arqueo de caja mostró que un supuesto faltante de **$387 mil** era en realidad un **sobrante de $13.5 mil**. El catálogo se muda a Compras. |
| S3 · 8–14 sep | 12 | Reclamo automático por faltantes al recibir mercancía. Captura de gastos desde el celular. Arreglos que tenían los despliegues bloqueados. |
| S2 · 1–7 sep | 15 | Andén de entrada: **de 79 toques a 24** por vale. El arqueo compara tarjeta, transferencia y retiros contra Kepler. |
| S1 · 25–31 ago | 8 | Arqueo de caja ciego contra el turno de Kepler. El vale de recepción se llena solo con el folio. El menú de Almacén pasa de 19 opciones a 5. |

**Lo que el PM debe saber:**

- ⚠️ **La lista de migraciones pendientes creció y ya hay código integrado esperándolas.** Sin confirmar en producción: Arqueo (#447 y ahora #470), Venta (#444, #448, #455 —3 migraciones— y #473), Almacén (#321), Logística (#368, #379, #395), Gastos y RH. Sin ellas, esas pantallas no funcionan en producción aunque el código ya esté en `main`. Las aplica Edgar, una por una. El caso más urgente es el **#470**, cuya migración va **antes** del código y cuyo commit ya quedó dentro de la liberación del 30-oct.
- **Lo que se integró esta semana va a sacar descuadres reales a la luz.** Los cierres de caja que antes se guardaban sin folio de turno ahora se comparan contra el ERP. Medido en producción: 169 de 190 retiros y cierres de octubre (89 %) no se podían comparar, y en una sucursal el 26-oct hubo $379,230 en sangrías sin un solo retiro contado (PR #470). Conviene avisar a la operación **antes** de que la pantalla lo muestre.
- **Hay trabajo que existe solo en la máquina local**, sin PR: Viajes/CEDIS, la auditoría del catálogo, el documento de qué es un WMS, el WhatsApp de la empresa (CBW) y dos continuaciones del catálogo de Compras (PF.12.1 y PF.12.3). Ver «Pendientes».
- **Hay decisiones abiertas que no son técnicas:** qué rol es «jefe de zona», el aviso de privacidad de `/empleo`, aprobar el ADR-084 de RH, la fecha del corte de asistencia, aprobar **ADR-105, ADR-106, ADR-107** (vender de la zona; los tres siguen «propuestos») y **ADR-110** (revisión en caja), cómo pasa Finanzas el dinero entre sucursales cuando una caja liquida lo cobrado en otra, y las tres decisiones de Compras del catálogo nuevo (dónde se edita un producto, de qué sucursal es el precio, y si «Qué hacer» se calcula para todo el catálogo).
- **El PR #459 se cerró porque todo su contenido era de Caja General, que no es el área de David**; el diagnóstico quedó escrito en su rama para quien lleva esa área. Lo que encontró es delicado: el paso «Servicio real del corte» del CI **se pintaba verde con pruebas rojas desde el 15-oct**, y sigue así, porque el arreglo no se integró (ver «Pendientes · Plataforma y calidad»). Otros dos PR de la misma zona se cerraron por duplicados o superados (#457, #471), sin pérdida de trabajo.

## Detalle por semana

> La semana más reciente va primero.

---

## Semana 10 · 27 de octubre al 2 de noviembre (en curso)

### Arqueo de caja

#### «Sucursales y sus cajas» y el concepto de cada retiro (SM.48, SM.49)
- **En qué se trabajó:** quien valida el arqueo veía una lista plana de «Arqueos recientes»: no decía si los retiros de una caja coincidían con lo que registró Kepler ni si el turno cuadraba. Peor: la mayoría de los conteos se guardaba **sin folio de turno**, porque el usuario de la Suite no coincide con el código de cajera de Kepler, así que a la cajera no le aparecía su turno y capturaba «sin turno». Y un retiro no decía **por qué** salió el dinero: una sangría, un pago a proveedor o un gasto se veían iguales.
- **Solución:** «Sucursales y sus cajas» reemplaza «Arqueos recientes» para quien valida: se elige el día y, por sucursal y caja, se ven los turnos de Kepler con su cajera, los retiros contra lo que Kepler registró («Cuadran», «Faltan $X por contar», «Contado de más»), el cuadre del turno y el desglose de billetes y monedas, con validar y reimprimir desde ahí. Un retiro, cierre o relevo capturado sin folio **se ancla solo** al turno abierto en esa caja a esa hora; si hay duda, se guarda sin folio, como antes. Las cinco pestañas pasan a un solo menú y cada retiro lleva concepto (pago a proveedor, nómina, gasto de la sucursal, depósito al banco, otro con motivo obligatorio, o retiro de caja), que sale en el ticket y se suma por concepto.
- **Optimización:** medido en producción, sólo lectura: 169 de 190 retiros y cierres de octubre (**89 %**) se guardaron sin folio de turno, o sea sin poderse comparar contra Kepler; el anclaje por caja y hora ataca exactamente ese 89 % (PR #470). Se quitó el botón «Validar» de esa vista porque se usaba en 19 de 730 arqueos en 30 días (PR #470). El dinero recuperado (sin medición). Pruebas: 59/59 en conciliación, 451/452 en la pantalla de tienda y dos pruebas contra base real (12 y 19 casos), todo en **base local**; el cálculo de las cajas sí se ejerció contra producción en sólo lectura y los números del 26-oct cuadraron (PR #470).
- **Estado:** ✅ integrado (commit `76843521e`, 29-oct). GitHub muestra el **PR #470 cerrado sin fusionar**: el cambio entró a `main` por commit directo. ⚠️ Necesita su migración en producción **antes** del código (ver Pendientes).

### Gastos

#### El horario para dar de alta un vale se quitó: ahora sólo avisa (GX.86)
- **En qué se trabajó:** quien levanta un vale no sabe cuándo se lo van a revisar. La primera versión (PR #451) atacaba otra cosa: concentrar el alta en dos ventanas y **cerrar la puerta** fuera de ellas. Al medirlo se vio el tamaño del golpe.
- **Solución:** el 26-oct David decidió quitar el bloqueo y dejar sólo un aviso. Se retiró **completo** el candado —servidor, link de captura, pantallas y diálogo vuelven al código anterior— y en su lugar quedó un letrero que dice primero «puedes subir tus gastos a cualquier hora del día» y debajo en qué ronda se revisa **ese** gasto («hoy a las 5:00 pm», «el lunes a las 8:30 am»). Aparece en las tres puertas de alta (pantalla, link del celular sin sesión y el diálogo «Adjuntar evidencia»); quien aprueba no lo ve.
- **Optimización:** se evitó una regla que habría bloqueado al **81 % de las altas**: medido en producción, 30 días al 22-oct, **784 de 972 vales de 46 personas** se levantaban fuera de ese horario (PR #451). El beneficio del aviso en sí (sin medición): no hay medida de si la gente lo lee. Pruebas: 25 del contrato en 3 zonas horarias y 4 de la pieza visual, en base local (PR #461).
- **Estado:** ✅ integrado (PR #461). ⛔ El bloqueo se descartó (PR #451, cerrado sin integrar el 27-oct). Sin migraciones ni permisos nuevos.

#### Agregar evidencia a un vale ya levantado, con su porqué (GX.87)
- **En qué se trabajó:** lo que llega **después** del alta —la factura definitiva de una prefactura, un ticket que apareció, la foto que pidió quien revisa— no tenía por dónde entrar. El único camino era pedir la reapertura del vale, que le cambia el estado y lo vuelve a poner a esperar aprobación.
- **Solución:** botón «Agregar evidencia» en el expediente de cada vale, en las tres pantallas donde se ve. Abre un diálogo: hasta 5 archivos por envío, 20 MB cada uno, y un **porqué obligatorio**. Los archivos se **suman** al expediente, no reemplazan nada y no cambian el estado del vale ni sus firmas; quedan con su porqué, quién los subió y cuándo, puestos por el servidor. También salen en el PDF del expediente como «Agregada después: …». Pueden el dueño del vale y quien aprueba; un vale rechazado no acepta.
- **Optimización:** quita el rodeo de reabrir un vale para sumarle un papel (sin medición: no hay cuenta de cuántas reaperturas se pedían por este motivo). Lo medido es la cobertura: 49 pruebas nuevas con tres pruebas negativas, más 941/941 de contratos y 1,123 de la pantalla de finanzas, todo en **base local y simulada, no producción** (PR #474).
- **Estado:** ✅ integrado (PR #474). Sin migraciones ni permisos nuevos: nadie tiene que volver a entrar.

#### La prueba de la barra de Gastos frenaba el CI de todo el equipo (GX.80)
- **En qué se trabajó:** la barra de Gastos ganó una sexta pestaña, «Hoja de zona», cuando se entregó otro trabajo. La prueba automática seguía esperando cinco, así que la compuerta «Lint & test» quedó **roja en `main`** y en **todo** PR que tocara la app de pantallas, no sólo en Gastos.
- **Solución:** se corrigió la prueba, no la barra —que quien firma vea la hoja de zona es intencional—. Quedó fijado el orden de las seis pestañas y se agregaron dos casos más. Prueba negativa hecha: quitando la pestaña de la lista, 3 de las 7 salen en rojo.
- **Optimización:** destraba la compuerta compartida para cualquier PR de pantallas (sin medición de cuántos PR estaban detenidos). Prueba 7/7 y 1,108/1,108 de la pantalla de finanzas sobre `main` (PR #477). Riesgo en producción: ninguno, sólo cambia una prueba.
- **Estado:** ✅ integrado (PR #477)

### Venta y preventa

#### La cajera revisa el pedido de preventa antes de cobrarlo (MCP.10)
- **En qué se trabajó:** en una ruta vecinal, **8 de 28 pedidos de preventa salieron del surtido con faltantes, y en los 8 Kepler decía que sí había el producto**; un producto faltó 3 veces teniendo 1,308 piezas en existencia (medido en producción, sólo lectura, 29-oct; PR #473). Como el surtido **quita** del pedido lo que no hubo, se cobraba de menos y nadie iba a la bodega por el producto.
- **Solución:** pantalla nueva «Revisión de pedidos» para la cajera, pensada para personas mayores: un producto a la vez, en grande, y lo normal es un solo toque («Está bien»). Si faltó, la pantalla dice si Kepler tiene y cuánto pedirle al surtidor, y la cajera confirma «Ya se completó»; también «No hay», «Trajo otra cantidad», «Ya los devolví». Al cerrar, el pedido queda con lo que de verdad se cobra y la vendedora recibe aviso. Lo no revisado **no caduca**: se queda en la lista con «Sin revisar · hace N días». Usa un permiso que en producción ya está repartido a cajera y encargado de tienda, así que no nace ningún permiso sin repartir.
- **Optimización:** recupera el cobro de los faltantes que sí había: **8 de 28 pedidos** medidos en una ruta (PR #473); el monto de esa diferencia (sin medición). Pruebas: 30 contra Postgres real y 133 + 24 de código, con dos sabotajes que dan rojo, todo **en base local, no en producción** (PR #473).
- **Estado:** ✅ integrado (commit `644e4f8e2`, 30-oct). GitHub muestra el **PR #473 cerrado sin fusionar**: entró a `main` por commit directo porque GitHub reportaba conflictos que ya estaban resueltos. ⚠️ Trae una migración pendiente en producción.

> Lo que creció el PR #455 entre el 23 y el 28 de octubre (MCP.3.14 a MCP.3.16: un solo pedido para el vendedor, indicaciones al surtidor y existencia que no miente) se cuenta en la Semana 9, con el resto de ese PR.

### Compras — Catálogo y productos

#### El catálogo de productos en dos vistas, Sencillo y Detallado (PF.12)
- **En qué se trabajó:** la pestaña Productos de Compras › Catálogo había ido acumulando capas: renglón de conteos, aviso de precios, barra de proveedores, un selector extra, chips de ejemplo y una fila de 12 pestañas, 4 de ellas vacías. Lo que más se pregunta de un producto —en qué unidades se vende y a qué precio— no se veía sin abrirlo, y el buscador no encontraba por todos los códigos de barras ni por unidad.
- **Solución:** la misma lista con un botón **Sencillo / Detallado**. Sencillo muestra producto, proveedor, cada unidad con su equivalencia («CJA = 20 PAQ») y el precio de cada una. Detallado agrega la venta del mes con su variación, y una ficha lateral con qué hacer, dónde se mueve, margen, compras de 90 días (sólo con permiso de costo) y caducidad por lote. Un solo buscador (con o sin acentos, cualquier código, proveedor y palabras de unidad) y un menú «Ver» en lugar de la fila de pestañas. Todo de **sólo lectura**, con un permiso que ya existía y sin migración ni tabla nueva.
- **Optimización:** el beneficio es de claridad, no de tiempo, y no se midió en producción. Lo medido: 584/584 pruebas del módulo de Compras y 277/277 de la librería de productos; los tiempos (lista 120–307 ms, búsqueda 48–98 ms, ficha < 40 ms) son de **base local con muestra mínima**, no de producción (PR #460). Dato de alcance que justifica un límite: un proveedor de 269 productos ya tardaba 1.1–1.9 s en producción y el catálogo tiene 11,008 productos activos, por eso el bloque «Qué hacer» sólo se calcula cuando la búsqueda deja 200 productos o menos; si no, dice «sin medir» en lugar de inventar un número.
- **Estado:** ✅ integrado (PR #460). El PR #458 es el mismo trabajo y se ⛔ cerró sin integrar: su rama iba 72 commits atrás de `main` y no se pudo poner al día, así que el mismo código se volvió a montar sobre el `main` del día. **No hubo trabajo perdido ni dos versiones distintas.** En el tracker el item sigue en 🧪, no en producción.

### Plataforma y calidad

#### Los rojos de `main` que frenaban «Lint & test» en todos los PR (CI)
- **En qué se trabajó:** la compuerta «Lint & test» estaba roja en `main` por cinco pruebas que otros cambios dejaron desactualizadas. Como la compuerta es heredada, **cualquier PR del equipo salía rojo sin tener culpa**, y así el equipo se acostumbra a ignorar un rojo que algún día será verdadero.
- **Solución:** el cambio mínimo en cada una —6 archivos, 18 líneas agregadas y 8 quitadas—, sin debilitar ninguna aserción y sin tocar comportamiento, salvo que el texto de marca de los PDF queda un poco más oscuro y con más contraste.
- **Optimización:** verificación propia 19 correctas y 0 fallas reproduciendo la lógica de cada prueba contra los archivos de `main` (PR #465). No se corrió el motor de pruebas sobre esos archivos; la corrida real es la del CI.
- **Estado:** ✅ integrado, pero no por su PR: el **#465 se cerró sin integrar** y el arreglo entró completo dentro del PR #455 (28-oct). Se verificó que los cinco archivos quedan idénticos en `main`.

#### Un permiso nuevo de CAOS dejaba roja la pantalla de entrada (CGA-A.57)
- **En qué se trabajó:** un permiso nuevo entró al árbol de accesos como «acción» mientras la pantalla seguía pidiendo el de «ver». La prueba que cuida que nadie rebote al entrar se ponía roja en `main`, y con ella todos los PR que tocaran la app.
- **Solución:** declarar la discrepancia en la lista de deuda conocida de esa prueba —un renglón— en vez de aflojar el candado, que es lo que dejaría una pantalla rota al alcance de quien no la puede ver. Se comprobó en producción, sólo lectura, que **hoy nadie rebota**: todos los puestos que tienen la llave nueva tienen también la de ver.
- **Optimización:** (sin medición). El beneficio es que la compuerta vuelve a verde para todo el equipo.
- **Estado:** ✅ resuelto, pero no por su PR: el **#471 se cerró sin integrar** («detenido a pedido») y la misma declaración entró a `main` dentro del commit del #470.

#### El paso del CI que se pintaba verde con pruebas rojas (continuación del #456)
- **En qué se trabajó:** destapado el problema de la base de caja (ver Semana 9), apareció algo mayor: el paso «Servicio real del corte» llevaba **desde el 15-oct declarando verde con pruebas rojas**, porque leía el resultado del comando que guarda el log y no el de las pruebas. Al destaparlo salieron 17 fallas reales, 13 de ellas por un defecto de fondo —la jornada del libro se calculaba con la zona horaria de la sesión: en producción daba bien, en el CI se corría 12 horas—.
- **Solución:** se preparó el arreglo completo: `pipefail` en el paso que mentía, las seis copias del cálculo de la jornada unificadas en una sola que no depende de la zona de la sesión, el permiso que le faltaba a la base del CI y una prueba del alta de un egreso, una escritura que ninguna prueba ejercía.
- **Optimización:** el paso pasa de 17 fallas escondidas a 55/55. En producción el cambio no movería ningún número, medido en sólo lectura: **2,922 de 2,922 días idénticos entre 2020 y 2027**, y en los últimos 30 días 0 días distintos entre la consulta vieja, la nueva y un testigo independiente (PR #459).
- **Estado:** ⛔ descartado (PR #459, cerrado el 27-oct). Motivo: **todo su contenido era de Caja General, que no es el área de David**; la rama queda en GitHub para quien lleva esa área y el diagnóstico quedó escrito ahí. ⚠️ El defecto sigue vivo: ver «Pendientes». 🔨 Además, nueve commits del 26-oct sobre pruebas y documentación de caja viven sólo en esa rama y **no llegaron a `main`**.

---

## Semana 9 · 20 al 26 de octubre

### Arqueo de caja

#### Arqueo de rutas: la ruta correcta y sin campo "Caja"
- **En qué se trabajó:** en RD/RV la pantalla decía "tu sucursal no tiene rutas" aunque sí las tenía. Esto pasaba con usuarios que no tienen una sucursal fija. Además pedía una "Caja" que nadie guarda y que bloqueaba el botón de guardar.
- **Solución:** las rutas se buscan en la sucursal elegida y se vuelven a buscar al cambiarla. Si la consulta falla, la pantalla lo dice y ofrece "Reintentar". El selector de Ruta va junto a la caja. En RD/RV ya no existe el campo Caja: se captura con sucursal y ruta, y el ticket muestra la ruta.
- **Optimización:** en una sucursal de producción ahora aparecen sus 7 rutas de reparto y 2 vecinales, donde antes decía "no tiene rutas" (PR #438). Se quita un campo y un bloqueo falso al guardar (sin medición).
- **Estado:** ✅ integrado (PR #429, #438, #440)

#### Total de billetes y de monedas, y "Conteo de efectivo" sin caja
- **En qué se trabajó:** la operación pidió ver el subtotal de billetes y el de monedas. También la encargada y Finanzas necesitaban contar efectivo que no es de ninguna caja.
- **Solución:** la tabla cierra los billetes con "Total billetes" y las monedas con "Total monedas". Se agregó la pestaña "Conteo de efectivo": sucursal, quién cuenta (fijo, el usuario de la sesión) y motivo obligatorio. Queda como constancia, sin esperado. Tiene su propio permiso y su propio endpoint para que una cajera no pueda usarlo. Se reparte a encargadas, Finanzas y Tesorería.
- **Optimización:** el ticket ahora suma las monedas en lugar de calcularlas por resta (sin medición). En la prueba contra una base real pasaron 19 casos, ninguno falló y 1 quedó sin medir (PR #447).
- **Estado:** ✅ integrado (PR #447). ⚠️ Necesita 2 migraciones en producción antes del código (ver Pendientes).

### Gastos

#### Horario para dar de alta un vale
- **En qué se trabajó:** el alta de vales se hace a cualquier hora, incluido sábado. Además, el diálogo «Adjuntar evidencia» también da de alta el vale, pero subía primero los archivos: fuera de horario, la persona subía todo y al final la rechazaban.
- **Solución:** quien sólo captura puede dar de alta de lunes a viernes, 8:30–10:00 y 17:00–18:00 (hora de México); el servidor bloquea fuera de horario y la pantalla dice cuándo abre. Quien autoriza no tiene horario. Subir la factura de un vale aprobado no tiene horario. Arreglo GX.86.1 (23-oct): «Adjuntar evidencia» revisa el horario **antes** de subir los archivos (commit `ea526658c`).
- **Optimización:** concentra el trabajo de aprobación en dos ventanas (sin medición del beneficio). Medido antes: 784 de 972 vales (81 %) de los últimos 30 días se levantaron fuera de ese horario (PR #451). GX.86.1: (sin medición).
- **Estado:** ⛔ descartado (PR #451, cerrado sin integrar el 27-oct). **Actualizado el 30-oct:** el 26-oct David decidió quitar el bloqueo y dejar sólo un aviso; el candado se retiró completo y lo reemplazó el PR #461 (ver Semana 10). Con eso, el arreglo GX.86.1 del diálogo «Adjuntar evidencia» **ya no aplica**: desapareció el bloqueo, y con él el defecto.

### Venta y preventa

#### Los pedidos de las vendedoras sí le llegan al surtidor (MCP.3.1–MCP.3.3)
- **En qué se trabajó:** los pedidos que levantaban las vendedoras en la app no le llegaban al surtidor. Su pantalla de Surtir sólo mostraba pedidos de Telemarketing, y abrir un pedido de preventa daba error.
- **Solución:** en Surtir quedan dos opciones, **Sucursal** (primero) y Telemarketing. En Sucursal se surten los pedidos de la app por día, en la misma pantalla. Se corrigió el error al abrir el pedido. El surtidor tiene además una lista sencilla de pedidos, sin importes. Y en la app del vendedor, el botón para volver al inicio ya no queda tapado por la barra de abajo.
- **Optimización:** el problema se midió en producción el 19-oct: de 12 avisos de pedido nuevo se habían visto 0, y ningún pedido de preventa se había empezado a surtir (fuente: PR #433). El efecto después del cambio no se ha medido.
- **Estado:** ✅ integrado (PR #433)

#### La fecha de entrega es hoy por omisión (MCP.3.4)
- **En qué se trabajó:** el pedido nuevo proponía la entrega para mañana, así que no le salía al surtidor en «Hoy».
- **Solución:** la fecha propuesta es hoy; el domingo, que no hay reparto, propone el lunes. El vendedor la puede cambiar como siempre.
- **Optimización:** (sin medición)
- **Estado:** ✅ integrado (PR #435)

#### Ruta del vendedor, surtido de la ruta como un solo pedido y tablero del supervisor (MCP.3.5–MCP.3.9)
- **En qué se trabajó:** el vendedor no tenía inicio ni fin de ruta ni registro de visitas. Al sumar cantidades, el número se trababa. El surtidor armaba pedido por pedido, y el supervisor no veía el avance de su equipo.
- **Solución:**
  - **Vendedor:** «Iniciar / Finalizar ruta». La app avisa «Llegaste» a menos de 80 m y abrir al cliente registra la visita. Se puede marcar «El cliente no pidió nada» con su motivo. Hay alta de cliente nuevo con «¿Es este?» contra clientes parecidos. Precio normal y de mayoreo siempre visibles, y se corrigió la traba de cantidades.
  - **Surtidor:** al cerrar la ruta le llega como **un solo pedido**: primero recolecta por marca y luego reparte por cliente. Lo que no alcanzó se reparte con una regla fija y se avisa a la vendedora. Hay una bandeja para ligar los clientes nuevos con su clave de Kepler.
  - **Supervisor:** pestaña «Mis vendedores» en Cartera de ventas. Cada supervisor sólo ve su tipo de ruta (vecinal o directa). La venta que no se puede medir dice «Sin medir», nunca $0.
  - **Corrección posterior (#445):** el tablero dice de cuándo es el dato de venta de Kepler, no sólo a qué hora cargó.
- **Optimización:** (sin medición). El tiempo del tablero no se midió contra la meta de 1 s.
- **Estado:** ✅ integrado (PR #444 y PR #445). Trae 3 migraciones que se aplicaron **sólo en la base local**. Sin ellas, la bandeja del surtidor falla en producción.

#### «Asignar rutas» como menú de vendedores y tablero simplificado (MCP.3.10, MCP.3.11)
- **En qué se trabajó:** la pantalla de asignar rutas guardaba en una tabla que la app del vendedor no lee. Una vendedora con ruta toda la semana salía «Sin ruta asignada», y asignarle ruta ahí no cambiaba nada.
- **Solución:**
  - **Tablero:** queda en 4 columnas (vendedor, ruta de hoy, visitados, venta de hoy).
  - **Asignar rutas:** es un menú de vendedores con dos pestañas. **Resumen**: meta de la catorcena contra lo cobrado y sus últimos días. **Configurar**: ruta de la semana, guardada en la agenda que sí usa la app; sucursal de surtido; meta; y clientes a visitar.
  - **Permiso nuevo y acotado** para cambiar la sucursal de surtido de una ruta.
  - Si la venta de Kepler no responde, el tablero ya no se cae.
- **Optimización:** (sin medición)
- **Estado:** ✅ integrado (PR #448). Falta aplicar la migración del permiso en producción.

#### Vender de las sucursales de la zona: un pedido que se surte en varias sucursales (MCP.3.12, MCP.3.13)
- **En qué se trabajó:** la decisión del 23-oct es poder vender de otras sucursales de la zona, pero la vendedora sólo veía y podía pedir lo de su propia sucursal. Además, todo el sistema daba por hecho que un pedido sale de una sola sucursal: precio, surtido, ticket de Kepler, guía del repartidor y liquidación.
- **Solución:**
  - **Ver la existencia de la zona (MCP.3.12):** debajo de cada producto, una tira chica con la existencia de cada sucursal de la zona (La Piedad, Zamora y Morelia; el CEDIS queda fuera), en la unidad que eligió la vendedora. «—» quiere decir que no hay dato, nunca cero. Avisa qué tan viejo es el dato y si la consulta falla.
  - **Pedido agrupado (MCP.3.13, ADR-101):** si la vendedora toca una sucursal en la tira, ese producto sale de ahí y con su precio. Para la vendedora y el cliente sigue siendo un solo pedido («Se surte en LPA y PH»); por dentro, cada sucursal recibe su parte.
  - **Surtido, cobro y reparto:** cada sucursal surte su parte y la cobra en su propio Kepler. El repartidor pasa a recoger a cada sucursal.
  - **Liquidación:** la caja del pedido principal recibe todo el dinero y lo desglosa por sucursal, en pantalla y en el PDF.
  - Se escogió partir el pedido en partes porque cada parte funciona como un pedido normal. Poner la sucursal en cada renglón obligaba a rehacer unos 30 puntos del sistema (PR #455).
  - **Creció antes de integrarse (26 al 28-oct), con tres entregas más:**
    - **Un solo pedido para el vendedor (MCP.3.14):** el vendedor ve **un** pedido con el total de todas las sucursales; el estado por sucursal sólo aparece si surten dos o más. Almacén, mesa y caja siguen viendo cada parte, porque cada sucursal da su salida.
    - **Indicaciones para el surtidor (MCP.3.15):** un recuadro que se escribe o se **dicta**, que el surtidor ve en grande y no puede cerrar sin marcar «Cumplí las indicaciones». Y la preventa le llega **pedido por pedido**, sin esperar a que el vendedor cierre la ruta.
    - **La existencia deja de mentir (MCP.3.16):** declara sus cuatro casos (hay / se agotó / la sucursal no lo maneja / sin dato) y **ya no deja agregar lo que no hay**, diciendo qué sucursal de la zona sí tiene.
  - **Numeración final de los ADR:** lo que aquí se llamó ADR-101 quedó finalmente como **ADR-105** (pedido agrupado), **ADR-106** (pedido por pedido) y **ADR-107** (existencia del vendedor); los números 101 a 104 ya los había ocupado otra fase.
- **Optimización:** la tira responde en **107 ms** para la zona La Piedad, con 4,683 productos; medido en producción, sólo lectura (PR #455). Antes, **0 de 60 pedidos** de los últimos 30 días llevaban una nota para el surtidor: no había dónde escribirla (PR #455). La preventa llegaba al surtidor con **3 h 43 min de espera promedio por pedido** y 7 h el primero, en un día de ejemplo; con la llegada pedido por pedido esa espera desaparece (ADR-106). La existencia salía en blanco **entre el 40 y el 64 % del catálogo en 6 de 8 sucursales** (medido en producción, sólo lectura; ADR-107). Costo medido en producción: el catálogo del vendedor pasó de 84–119 ms a **426–685 ms** y cada producto que se agrega suma 346–426 ms (PR #455). Pruebas en la base **local**, no en producción: 17 correctas (3 rechazos esperados) y 71 correctas más 2 sin medir en el flujo completo, del surtido a la liquidación (PR #455). El beneficio en ventas o en tiempo (sin medición).
- **Estado:** ✅ integrado (PR #455, fusionado el 28-oct). Necesita 3 migraciones en producción antes del código y el visto bueno de Edgar a ADR-105, ADR-106 y ADR-107, los tres todavía «propuestos». Sin permisos nuevos. En el tracker, MCP.3.14 a MCP.3.16 están en 🧪, no en producción.

### Recursos Humanos (Mega Talento)

#### Solicitud del corte de asistencia
- **En qué se trabajó:** el código ya está en producción, pero el corte necesita que Edgar ejecute pasos en el servidor.
- **Solución:** guía paso a paso para Edgar (~30–40 min): revisión previa de sólo lectura, migraciones una por una, llave del lector, cargas en ensayo y luego reales. Decisión de David: el lector sigue en su laptop por ahora y usa la misma llave; se rotará al apagar Mega Talento. Reversa limpia durante 36 h sin perder checadas.
- **Optimización:** en el ensayo con datos reales se ligan **1,006 de 1,015** códigos de reloj activos (PR #403).
- **Estado:** ✅ integrado (PR #403, sólo documento). El corte en sí **todavía no se ha ejecutado**: el runbook dice «en cuanto Edgar pueda» (el intento del 14-oct no se hizo).

#### Alarmas de salud para la asistencia
- **En qué se trabajó:** si el lector de relojes o el agente de alertas se callan, nadie se entera.
- **Solución:** dos alarmas en el tablero de Salud BD con umbrales según cómo late cada uno (el lector cada 5 min, el agente cada 30 min). Un reloj caído se ve en Relojes; la alarma salta si se calla el lector entero.
- **Optimización:** (sin medición)
- **Estado:** 🔄 PR abierto #436. Se mergea **en el paso 7 del corte**, no antes (si no, sale en amarillo).

#### Asistencia al día con los últimos cambios de Mega Talento
- **En qué se trabajó:** Mega Talento siguió cambiando su lógica después del 12-oct; el día del corte RH vería horas distintas.
- **Solución:** marca sin pareja (antes un desayuno sin pareja podía descontar de 3 a 5 h), hasta 4 horarios por persona, incidencia «Descanso», y columnas de horas extra ganadas, usadas y saldo (si no se puede leer, la celda queda vacía, nunca cero).
- **Optimización:** según Mega Talento, 40 días del último mes tenían el descuento erróneo de 3 a 5 h (dato citado en PR #442). Paridad con datos reales: **NO MEDIDA** todavía.
- **Estado:** 🔄 PR abierto #442. Requiere aplicar su migración en producción **antes** de mergear, o se frena el despliegue de todo el equipo.

### Plataforma y calidad

#### El job de pruebas contra base real vuelve a correr completo (fix(ci))
- **En qué se trabajó:** el job «Pruebas contra Postgres real» fallaba también en `main`, primero por SSL y después por cadenas de migraciones viejas que no corrían sobre una base vacía. Además, una prueba de pronto pago estaba roja desde un refactor.
- **Solución:** SSL solo para bases remotas, con producción sin cambios. Las 9 migraciones de logística (tablas que se crearon a mano) declaran «no medido» en vez de tronar. Se agregó el rol que faltaba, se sacaron dos scripts que estaban mezclados con las semillas, y la prueba de pronto pago ahora mide la regla donde vive.
- **Optimización:** sobre una base vacía corren 89 migraciones legacy sin error, y 1,284 en el arranque de la base nueva (160 saltadas), con las semillas completas. En la bitácora del PM consta como «5 problemas viejos que la tumbaban» (PR #434 y sus commits).
- **Estado:** ✅ integrado (PR #434)

#### Dos compuertas rojas tras un merge (VP.2.3, RA.TR.2)
- **En qué se trabajó:** el tablero del supervisor no declaraba de cuándo es la venta, y una prueba de Compras exigía la palabra «NO» en mayúsculas.
- **Solución:** el tablero declara la frescura del dato de Kepler (y si no se puede medir, lo dice). La prueba ignora mayúsculas, pero sigue exigiendo que la pantalla lo niegue.
- **Optimización:** la deuda de procedencia bajó de 1 a 0 (PR #445).
- **Estado:** ✅ integrado (PR #445, compartido con MCP)

#### `main` rojo por un permiso nuevo del puente ContPAQi (CP.8.80)
- **En qué se trabajó:** «Lint & test» estaba rojo en `main` desde el 22-oct, por un permiso de acción que no tiene pantalla propia. Todo PR que toque los contratos heredaba ese rojo.
- **Solución:** se declaró el caso en la lista de excepciones, igual que su permiso hermano, sin aflojar la ruta. Se verificó en producción, en solo lectura, que nadie rebota hoy.
- **Optimización:** (sin medición). No se corrió en local; lo confirma el CI del PR.
- **Estado:** ⛔ descartado (PR #452, cerrado el 26-oct como «duplicado, no rechazado»). El arreglo ya estaba en `main` por el PR #453 del lead, del 23-oct.

#### La base de pruebas de Caja del CI volvió a armarse (CGP-D.1.2)
- **En qué se trabajó:** desde el 23-oct la compuerta «Caja General · base real» salía roja en **todos** los PR del equipo y en `main`. No era culpa de ningún cambio en particular: una migración que corrige datos reales de producción se detenía a propósito al no encontrarlos en la base vacía que arma el CI y, como todo el lote corre en una sola transacción, se deshacía completo. Ningún PR del equipo podía mostrar esa compuerta en verde.
- **Solución:** el preparador de la base del CI acepta **sólo** ese aborto concreto, con el esquema sí aplicado y la corrección de datos declarada «no medido». Se repararon además dos casos de prueba que nunca habían llegado a correr, y se le puso `pipefail` al paso «Base de caja desde cero», que antes se pintaba verde aunque el preparador se hubiera detenido.
- **Optimización:** con el arreglo se aplican 32 migraciones y las suites quedan en 28, 44 (4 no medidas), 30 y 21 correctas, sin fallas; todo **contra un Postgres desechable local, nunca contra producción** (PR #456).
- **Estado:** ✅ integrado (PR #456). ⛔ Un segundo intento por el otro extremo —parchar la migración para que no aborte en base vacía— se descartó (PR #457, cerrado como «superado, no rechazado»: `main` ya tenía la misma guarda).

---

## Semana 8 · 13 al 19 de octubre

### Arqueo de caja

#### La confirmación del corte desglosa pieza por pieza
- **En qué se trabajó:** el "¿Confirmas el corte?" solo mostraba el total de billetes y el de monedas, y así no se podía comparar contra los fajos que se tienen en la mano.
- **Solución:** el resumen lista cada denominación con sus piezas y su importe, indica si los $20 son billete o moneda, y muestra los totales, los medios de pago y el total del turno. Se hizo sobre una maqueta aprobada por la operación.
- **Optimización:** lo que se confirma es exactamente lo que se guarda, así que se evitan errores de captura antes de sellar (sin medición).
- **Estado:** ✅ integrado (PR #396)

### Gastos

#### El vale se cierra cuando Kepler aplica el pago
- **En qué se trabajó:** el estado del vale en la Suite no coincidía con Kepler («tenemos un caos»); la tarjeta «Gastos» de «Mi trabajo» abría la pantalla equivocada.
- **Solución:** cada 10 minutos, los vales que Kepler marca como «autorizado y aplicado» pasan solos a cerrados (no toca los rechazados); la tarjeta lleva a la primera pantalla de Gastos permitida para cada persona.
- **Optimización:** 13 vales abiertos se cierran en la primera pasada; cierre en menos de 10 min tras la aplicación en Kepler (PR #400).
- **Estado:** ✅ integrado (PR #400). ⛔ GX.84 (cerrar un solo vale por migración) descartado: lo absorbe la regla de GX.85.

### Venta y preventa

#### Preventa: el surtidor recibe los pedidos en vivo y la vendedora ve su avance (MCP.3, MCP.8)
- **En qué se trabajó:** el surtidor no tenía una bandeja con los pedidos de preventa de su sucursal, y la vendedora no sabía en qué iba su pedido ni qué faltó.
- **Solución:** bandeja del surtidor por Hoy / Mañana / Próximos que se actualiza sola y avisa por la campana. «Empezar a surtir» registra quién y a qué hora. Lo que no hubo se quita del pedido y el total se recalcula. La vendedora ve en «Mis pedidos» cada etapa (agendado → surtido → cobrado → entregado) y recibe aviso de los faltantes. El cobro en Kepler se detecta y se muestra «por confirmar»: no se da por hecho.
- **Optimización:** (sin medición)
- **Estado:** ✅ integrado (PR #404). Trajo una tabla nueva; para el 19-oct ya existía en producción (el PR #433 la midió ahí, con 0 filas).

#### App del vendedor sin IA (VTK.8)
- **En qué se trabajó:** después de una prueba en campo con una vendedora vecinal, la app tenía que ser más rápida en cada visita.
- **Solución:** se quitaron de Tomar pedido y Mi ruta las sugerencias de IA, el dictado por voz y el «por qué ofrecerlo». Se quedan «Lo que suele pedir», el catálogo y la canasta sugerida, que no usan IA.
- **Optimización:** menos peticiones al servidor. Ya no hay una consulta de IA al abrir un cliente ni otra después de cada ráfaga de +/−, y Mi ruta ya no espera la recomendación de IA para mostrar la lista (fuente: PR #405). El tiempo ganado no se midió.
- **Estado:** ✅ integrado (PR #405)

#### Tomar pedido dice cuánto trae la caja (VTK.9, VTK.12)
- **En qué se trabajó:** el cliente pregunta «¿cuántas trae la caja?» y el vendedor tenía que deducirlo o hacer la cuenta.
- **Solución:** al buscar, cada producto muestra «1 CJA trae 12 PAQ · 144 PZA». Al elegir caja, muestra cuántas piezas trae y cuántas lleva el pedido. Si el producto no tiene caja declarada, no inventa nada. El dato sale de las unidades de Kepler de la sucursal.
- **Optimización:** (sin medición). El vendedor ya no hace la cuenta a mano.
- **Estado:** ✅ integrado (PR #412)

#### Abrir un cliente en Tomar pedido: de 13–19 s a casi inmediato, y el catálogo completo (VTK.10, VTK.11)
- **En qué se trabajó:** al escoger un cliente, la pantalla tardaba 13 a 19 segundos en dejar capturar. Además, algunos productos no salían al buscarlos («busco y sólo sale uno»).
- **Solución:** los precios de mayoreo y las unidades de la sucursal se guardan unos minutos y se refrescan solos por detrás. El precio que se cobra no cambia. La app abre con el catálogo que el celular ya tiene (si es de la misma sucursal y tiene menos de un día), baja el nuevo por detrás y dice de cuándo son los precios. Ahora llegan todos los productos.
- **Optimización:** antes de tocar nada se midió en producción: 12.8 a 19.3 s para cargar el catálogo; sólo el cálculo de mayoreo tardaba 9.4 s. Llegaban 8,000 de 9,429 productos, así que faltaban 1,429 (fuente: PR #415). El tiempo después del despliegue **no se ha medido**: la estimación por partes es de ~0.5–0.8 s del lado del servidor. Desde el segundo cliente del día, la apertura ya no espera el catálogo.
- **Estado:** ✅ integrado (PR #415). Queda pendiente medir en producción.

#### Mostrador: buscar por nombre, proveedor, SKU o código, y lo que Kepler no tiene se anota solo (MOS.1–MOS.3)
- **En qué se trabajó:** en el mostrador («¿Te pidieron algo?», en el arqueo de caja y en Faltantes) costaba encontrar un producto y ver sus presentaciones. Los códigos que Kepler no conoce se perdían.
- **Solución:** la búsqueda acepta nombre, proveedor, SKU o código de barras, y cada resultado trae todas sus presentaciones con precio y mayoreo. Nueva lista Compras › Catálogo › No registrados con lo que se escaneó y Kepler no tiene en esa sucursal. Cada código sale solo de la lista cuando Kepler lo da de alta. La cajera puede anotar qué es el producto.
- **Optimización:** (sin medición). El tiempo de la lista nueva no se midió contra la meta de 1 s.
- **Estado:** ✅ integrado (PR #428)

### Recursos Humanos (Mega Talento)

#### Pantallas de reclutamiento
- **En qué se trabajó:** RH necesita ver el embudo de candidatos; Mega Talento tenía una pantalla por etapa.
- **Solución:** `/rh/reclutamiento` con Candidatos (una tabla con filtros por apartado y etapa, marca de «Atrasado» según la meta de cada etapa, ficha lateral con todas las acciones), Vacantes y Revisiones (reingresos, duplicados por teléfono, tiempo por etapa). Permiso repartido al rol de RH.
- **Optimización:** RH ve todo el embudo en una sola pantalla en lugar de una por etapa (PR #385). (sin medición)
- **Estado:** ✅ integrado (PR #385). Sin validación visual con RH.

#### Bolsa de trabajo pública, ligas personales y evaluaciones
- **En qué se trabajó:** en Mega Talento cualquiera con el número del candidato podía leer y editar su expediente para siempre, y el avance de etapa lo decidía el navegador del candidato o del jefe.
- **Solución:** página pública `/empleo` con vacantes y formulario (reglas: un proceso a la vez por persona, 90 días para volver a la misma vacante, licencia obligatoria para chofer), protecciones contra envíos automáticos, ligas personales que vencen en 7 días para subir el CV, cuestionario de liderazgo y evaluación de aptitudes para el jefe que entrevista. Ahora **el servidor decide** si el candidato avanza de etapa y exige los mínimos (por ejemplo, que tenga CV).
- **Optimización:** se cerró el acceso abierto al expediente por número de candidato (PR #392, #397). (sin medición)
- **Estado:** ✅ integrado (PR #392, #397). ⛔ El aviso de privacidad es un **borrador**: no publicar `/empleo` sin el texto oficial.

#### Bot de reclutamiento por WhatsApp
- **En qué se trabajó:** la Suite sólo tenía un bot de ventas y un solo número; el bot de RH vive en Mega Talento.
- **Solución:** la Suite reconoce por qué número llega cada mensaje y lo manda al bot que corresponde (ventas no cambia). Bot de RH con: registro en 12 preguntas, orientación a quien pide un puesto que no existe (hasta 3 vacantes reales de su zona), IA que entiende varios datos en un mensaje (la IA propone, las reglas validan), notas de voz transcritas, revisión de que el archivo sí sea un CV, armado del CV en PDF para quien no tiene, y recepción de documentos del expediente a su casillero. RH puede pedir documentos desde la ficha; el mensaje sólo sale dentro de la ventana de 24 h de WhatsApp.
- **Optimización:** se eliminó la diferencia de cálculo entre bot y portal y se evita que un documento equivocado quede en el expediente (PR #401, #410). (sin medición)
- **Estado:** ✅ integrado (PR #398, #401, #410). Nada contesta todavía a candidatos reales: el número de RH sigue en Mega Talento hasta su corte. Las preguntas de datos sensibles están apagadas hasta que RH/legal aprueben el texto de consentimiento.

#### RH liga códigos de reloj a personas desde la Suite
- **En qué se trabajó:** después del corte, cada persona nueva aparecería como «Empleado N», sin faltas ni sección, y nadie podría arreglarlo desde la Suite.
- **Solución:** bandeja «Códigos sin persona» en Relojes: la Suite sugiere a quién corresponde y RH confirma con un clic (nunca automático); también permite dar de alta a la persona sin acceso al sistema. Todo queda en bitácora. Al ligar, se recupera todo su historial.
- **Optimización:** cubre las **3 a 11 personas nuevas por semana** medidas en Mega Talento (PR #418).
- **Estado:** ✅ integrado (PR #418).

#### Tablero de salud para los relojes (primer intento)
- **En qué se trabajó:** que el tablero de salud avise si el lector de relojes deja de mandar.
- **Solución:** primera versión de las alarmas.
- **Optimización:** (sin medición)
- **Estado:** ⛔ descartado (PR #402 cerrado; lo reemplaza el #436 de S9).

### Almacén — Andén de entrada

#### Documento: qué es un WMS, qué tenemos y qué se usa
- **En qué se trabajó:** explicar en palabras sencillas qué es un sistema de gestión de almacén y comparar lo construido contra lo que de verdad se usa.
- **Solución:** documento nuevo (`docs/WMS_QUE_ES_Y_QUE_TENEMOS.md`), revisado contra producción. Conclusión: lo que falta no es funcionalidad, sino uso y datos de base.
- **Optimización:** son hallazgos de uso, no mejoras. Medido en producción el 16-oct: 376 ubicaciones creadas (375 en el CEDIS) y 7 de 9 sucursales sin ninguna. Sólo 59 de 26,871 partidas en existencia tienen caducidad (0.2%). De 38 vales en tres meses, 26 quedaron abandonados y el último es del 7-oct (commits `4db07c0ad` y `2830b2765`).
- **Estado:** 🔨 local sin PR (rama `docs/wms-que-es`, 2 commits sin subir)

### Logística — Embarques

#### Alta rápida de ayudantes y cargadores, y rutas locales sin comisión (EMB.32, EMB.33)
- **En qué se trabajó:** no se podía poner ayudante en ninguna guía, porque en producción había 0 ayudantes y 0 cargadores activos. Darlos de alta pedía un permiso que quien captura no siempre tiene. Además, los traslados locales nunca se completaban por «falta la tarifa».
- **Solución:** botón «+ Nuevo ayudante» / «+ Nuevo cargador» dentro de la guía, que sólo pide el nombre. No duplica: reutiliza, agrega el papel o reactiva a quien estaba de baja. Las rutas locales se marcan «No paga comisión» y su guía se completa con comisión $0 (sí cobran viáticos y cargadores).
- **Optimización:** destraba la ruta local de más movimiento, con 811 viajes en 90 días, y otras dos (cuerpo del PR #395). No se inventaron montos: el historial de pago no daba una tarifa por ruta.
- **Estado:** ✅ integrado (PR #395). La migración va antes del código.

#### Módulo «Viajes» y pago en efectivo del CEDIS (HDV.*)
- **En qué se trabajó:** el mismo viaje vivía en cuatro listas. Los fletes a terceros, las recolecciones en proveedor y el combustible no tenían registro. En el CEDIS el pago en efectivo se hace con vales tecleados a mano, con riesgo de pagar dos veces.
- **Solución:** un solo módulo «Viajes», con km del GPS contra km capturado, fletes con su factura, recolecciones y combustible ligado al viaje. Bandeja «CEDIS: capturar», donde lo que ya está en Kepler o en el GPS sale fijo. Candados contra el doble pago y aviso de «Posible doble pago» en Finanzas.
- **Optimización:** el menú de Logística pasa de 13 a 8 entradas. La lista carga 150 viajes de 30 días en 180–460 ms, medido en local (commit `4595007d4`). Medido en producción: en el CEDIS Kepler trae el chofer en el 77 % de los viajes y el GPS el horario en el 61 % (bitácora del PM, 16-oct). Lo que se pagaba a mano: 3 vales «MANIOBRAS CEDIS» por $17,501 en 90 días (`docs/MODULOS/logistica-viajes.md` en la rama).
- **Estado:** 🔨 local sin PR (rama `feat/hdv-viajes`, 10 commits del 15–16 oct, no está en `main`). Trae una migración.

### Compras — Catálogo y productos

#### La hoja de precios se imprime como documento
- **En qué se trabajó:** la hoja de precios por proveedor salía de la impresora como una captura de pantalla: con el menú, avisos encima de la tabla y los encabezados del navegador.
- **Solución:** la hoja se imprime sola. Lleva membrete y pie en cada página, el nombre del proveedor como título, los precios agrupados por unidad, paquete y caja, y letra más legible. Se quitó la nota «Cómo leer esta hoja», como pidió Compras.
- **Optimización:** (sin medición). Caben 10 productos por hoja.
- **Estado:** ✅ integrado (PR #393).

#### Auditoría del catálogo: historial más rápido y nada se pinta en cero
- **En qué se trabajó:** el historial de costos de un producto tardaba hasta 4.2 s en producción con un año de datos. Si fallaba la lectura de códigos, la pantalla decía «0 códigos repetidos».
- **Solución:** dos índices nuevos (retoman los de S6), un buscador más ligero, Productos nuevos y la barra de proveedores calculados una vez para todos y no por cada pestaña abierta, un mensaje de error en lugar del cero y estados de carga/vacío/error uniformes en todas las pestañas.
- **Optimización:** el buscador del historial bajó de ~1.6 s a ~30 ms y las fallas de la revisión de pantallas del catálogo bajaron de 23 a 10 (commit `9a3e4c2ed`, bitácora del 16-oct).
- **Estado:** 🔨 local sin PR (rama `perf/catalogo-auditoria`).

### Plataforma y calidad

#### Frescura declarada en el reporte por ruta de CAOS (VP.2.3)
- **En qué se trabajó:** `main` estaba rojo porque un reporte nuevo no declaraba de cuándo son sus datos.
- **Solución:** se preparó el arreglo.
- **Optimización:** (sin medición).
- **Estado:** ⛔ descartado (PR #411). El lead subió uno equivalente al mismo tiempo.

#### Pruebas contra Postgres real: primer intento (CI.SSL)
- **En qué se trabajó:** el job de pruebas contra una base de datos real moría en el primer paso por un problema de conexión cifrada (SSL).
- **Solución:** se desactivaba el SSL solo en las direcciones del job.
- **Optimización:** (sin medición).
- **Estado:** ⛔ descartado (PR #430). Lo reemplazó el PR #434 de la S9, que lo arregló de raíz.

#### Regla de proceso: todo agente pregunta «¿por qué?» y «¿para qué?» (PROC.4)
- **En qué se trabajó:** un trabajo de rendimiento (índices del catálogo) nunca llegó a `main`: quedó en una rama sin subir y nadie lo revisó.
- **Solución:** una regla documentada para que todo agente audite lo que se le pide y lo que él mismo hace.
- **Optimización:** (sin medición).
- **Estado:** 🔨 local sin PR (rama `docs/auditar-por-que-para-que`)

---

## Semana 7 · 6 al 12 de octubre

### Arqueo de caja

#### La hoja de conteo como la de la operación, buscador y reimpresión
- **En qué se trabajó:** la operación pidió contar en una sola lista, como su hoja de arqueo, y poder encontrar y reimprimir un arqueo anterior.
- **Solución:** una sola lista de $1,000 a 50¢ (billetes primero), con "Total en efectivo". En Retiro ya no se piden medios de pago. Se agregó un buscador por monto, hora, caja, cajera, tipo o folio, y un botón "Reimprimir" que imprime lo guardado, marcado como REIMPRESIÓN y sin revelar el esperado a la cajera.
- **Optimización:** un medio de pago escrito en el cierre ya no se suma por error a un retiro (sin medición). Buscar y reimprimir ya no obliga a reconstruir el ticket (sin medición).
- **Estado:** ✅ integrado (PR #289, #296, #309)

#### Mantenimiento: main estaba en rojo por la pantalla de conteo del camión
- **En qué se trabajó:** dos controles automáticos de estilo estaban en rojo en `main` por la pantalla de conteo de rutas de Almacén, y eso bloqueaba los PR de todos.
- **Solución:** la barra de avance se anima de forma más ligera y se dejó justificado por qué los números grandes de esa pantalla son grandes.
- **Optimización:** los dos controles volvieron a verde y se desbloquearon los PR del equipo (PR #312).
- **Estado:** ✅ integrado (PR #312)

### Gastos

#### El importe del vale es el que dice Kepler
- **En qué se trabajó:** algunos vales mostraban un total distinto al «Saldo» de Kepler (con IVA o con un importe contable).
- **Solución:** el importe se calcula en vivo desde Kepler (saldo del gasto; si no hay gasto, el de la solicitud), sin copias ni procesos programados.
- **Optimización:** consulta de los vales en 18–30 ms en prod (PR #273); 8 vales corrigen lo que muestran, sin escribir datos (PR #273).
- **Estado:** ✅ integrado (PR #273)

#### Expediente en PDF completo, filtros y estado al día
- **En qué se trabajó:** el PDF del expediente fallaba para autorizadores sin área; una persona de Tesorería necesitaba el historial de todos; faltaban filtros; el vale seguía en una fase vieja aunque Kepler ya lo había autorizado; el pago sólo admitía un renglón; archivos grandes rebotaban.
- **Solución:** PDF disponible para quien autoriza; permiso por persona para ver el historial de todos; filtros por fecha y departamento en el Expediente, y por estado, sucursal y persona en el Historial; reenvío continuo de las solicitudes abiertas de Kepler y pantallas que se refrescan cada 60 s; varios renglones en el pago; el Expediente y el PDF muestran la transferencia que pagó cada gasto y traen las evidencias adentro; «Mis gastos» saca lo ya cerrado; archivos de hasta 20 MB (antes 10).
- **Optimización:** el PDF fallaba en 8 de 8 vales para un autorizador sin área (PR #291). Filtros del Historial responden en 20–45 ms (PR #338). 557 de 559 evidencias entran al PDF; las 2 que no, se declaran (PR #337). Tope de archivo de 10 MB a 20 MB (PR #343).
- **Estado:** ✅ integrado (PR #291, #298, #337, #338, #343)

#### Gastos en una sola entrada con pestañas y vales trabados con cotización
- **En qué se trabajó:** cuatro renglones de menú para Gastos; vales aprobados sólo con cotización no aceptaban su factura y se quedaban atorados aunque Kepler ya los había pagado.
- **Solución:** una sola entrada «Gastos» con cuatro pestañas (cada persona cae en la primera que puede ver); regla única de «debe comprobante»; por decisión del usuario, la cotización basta y el vale aprobado se cierra (la casilla «provisional» se conserva para pedir factura a propósito); migración que cierra los ya atorados. Además, las comisiones y viáticos de logística se pagan con un vale por persona dentro de Gastos (PR #368, proyecto de Logística).
- **Optimización:** 70 vales destrabados sin tocar datos (PR #364); 93 vales por $759,955.11 cerrados con la migración (PR #374).
- **Estado:** ✅ integrado (PR #353, #364, #374)

### Recursos Humanos (Mega Talento)

#### Plan de la migración
- **En qué se trabajó:** Mega Talento vive aparte, en otra nube y con un lector de relojes en una laptop; había que decidir cómo traerlo sin duplicar datos ni lectores.
- **Solución:** plan completo de la fase con calendario (preparación, corte de asistencia, corte de reclutamiento y bot, apagado) y una decisión de arquitectura (ADR-084) para aprobar: la persona es el usuario de la Suite, un solo lector de relojes y cargas únicas verificadas en lugar de sincronizaciones permanentes.
- **Optimización:** se descubrió que existían cuatro lectores para los mismos relojes y que un reloj sólo acepta una conexión; el plan deja uno solo (PR #274). (sin medición de tiempo)
- **Estado:** ✅ integrado (PR #274). ⚠️ La decisión ADR-084 sigue marcada como «propuesta», no aprobada (tracker RH.0.2).

#### Asistencia en la Suite: datos, entrada de checadas, reglas, incidencias y cierre semanal
- **En qué se trabajó:** RH necesita ver checadas, faltas, retardos y comidas por persona y cerrar la semana para prenómina; todo eso hoy sólo existe en Mega Talento.
- **Solución:** se construyó la base de datos de asistencia, la entrada por donde los relojes mandan sus checadas (compatible con el lector actual, para que el corte sea sólo cambiar una dirección), las reglas de horario copiadas tal cual de Mega Talento, el agente de alertas, las incidencias (con separación de funciones: RH captura y califica, contabilidad audita) y el cierre de semana jueves→miércoles con reapertura sólo con motivo. Pantallas nuevas: Asistencia, Incidencias y Relojes.
- **Optimización:** paridad con datos reales contra el código de Mega Talento: 1,464 personas, 5,464 días, **0 diferencias** (PR #286). Reenviar 83,512 checadas históricas mete **0 duplicados** (PR #286). Consultas: una semana en 116 ms y tres meses en 259 ms, medido en base local con un sitio de tamaño real (PR #286; falta medir en producción). Se encontró que la prueba de horarios de Mega Talento estaba en rojo desde el 18-ago y que el bot calculaba distinto que el portal; en la Suite queda una sola regla.
- **Estado:** ✅ integrado (PR #281, #283, #286). Nace apagado: se enciende en el corte.

#### Pantalla de Asistencia con la forma que RH ya usa + corrección del desayuno
- **En qué se trabajó:** RH trabaja con el reporte «Horarios» de Mega Talento; una pantalla distinta obligaría a reaprender.
- **Solución:** la sección de Asistencia copia esa forma: pestañas (Checadas, Tolerancia, Faltas, Incidencias, Relojes), reporte semanal por persona y día, ficha lateral, búsqueda en todas las plazas, exportar a PDF para firmar y a Excel. El día en curso no se marca como falta. Se trajo además la corrección del desayuno que Mega Talento hizo ese mismo día.
- **Optimización:** sobre 6,137 días-persona reales, las alertas de desayuno bajan de **683 a 4** y los días con desayuno excedido de **1,257 a 90**, sin cambiar las horas netas (PR #330).
- **Estado:** ✅ integrado (PR #330). Sin validación con un usuario real de RH.

#### Personas de Mega Talento en la Suite + «nadie a prenómina sin identificar»
- **En qué se trabajó:** tras cargar las checadas había 991 códigos de reloj activos y **0** ligados a una persona: sin eso no se sabe quién faltó, quién es promotora ni quién está de baja. Frenaba el corte.
- **Solución:** guion de carga única de personas (ensayo por omisión) que liga cada código de reloj a su persona; lo ambiguo no se liga, queda en lista. Corrección posterior: conserva la sección de RH tal cual (como sale en el reporte de nómina), une a la persona que rota entre plazas y no inventa puestos. Además, la semana no se puede cerrar si alguien checó sin estar identificado, salvo con motivo escrito.
- **Optimización:** códigos ligados de **0 a 988 de 1,004** en el ensayo con datos reales (PR #366); con la corrección, departamento con **0 diferencias** frente a Mega Talento y 16 personas que rotan unidas en una sola (PR #376). Se evitó que las promotoras salieran con falta todos los días (PR #366).
- **Estado:** ✅ integrado (PR #366, #370 arreglo de revisión automática, #381 arreglo de pruebas). La corrección RH.1.4b entró a `main` por commit directo; su PR #376 aparece cerrado sin merge.

#### Horas extra
- **En qué se trabajó:** Mega Talento agregó horas extra (ganadas, banco, desayuno/comida distintos, cambio de descanso) después de la primera paridad; sin esto los números ya no coincidirían.
- **Solución:** cálculo de horas extra por día (bloques de 30 min, tope 6 h, sólo jornada completa fija), banco de horas por persona con ajustes de RH con motivo, pestaña «Horas extra» y columna en el reporte, PDF y Excel.
- **Optimización:** paridad con datos reales: 1,467 personas, 5,094 días, **0 diferencias** (PR #371).
- **Estado:** ✅ integrado (PR #371).

#### Lector de relojes dentro del monorepo
- **En qué se trabajó:** el lector de los 12 relojes corre como servicio de Windows en una laptop; si la laptop se apaga, no hay asistencia.
- **Solución:** el lector queda en el repositorio, listo para correr en el servidor de la empresa, pero **apagado a propósito** (dos lectores a la vez se pelean el reloj). Se retiró el lector viejo que sobraba.
- **Optimización:** (sin medición)
- **Estado:** ✅ integrado (PR #373). Pendiente: medir desde el servidor que los 12 relojes responden.

#### Reclutamiento: datos y API
- **En qué se trabajó:** candidatos, vacantes y expediente viven en Mega Talento; los documentos se subían con ligas públicas.
- **Solución:** base de reclutamiento y API para RH: candidatos por apartado, ficha con historia, etapas, lista negra y spam con motivo, papelera, fusión de duplicados, vacantes y expediente por casillero (12 casilleros, 9 obligatorios). Los documentos van a un almacén privado con ligas que duran 10 minutos y se valida el tipo real del archivo.
- **Optimización:** se portó sólo lo que se usa: medido en Mega Talento, requisiciones y evaluaciones tenían 0 registros y no se trajeron (PR #378). Se corrigió un defecto de Mega Talento donde el registro de cambios de etapa falló 5 días en silencio (PR #383).
- **Estado:** ✅ integrado (PR #378, #383).

#### WhatsApp de la empresa (fichas, pagos y pagarés) — CBW.9 a CBW.13
- **En qué se trabajó:** el número único de la empresa recibe fichas de depósito, pagarés y comprobantes de pago a proveedores, y hoy no se ligan a nada.
- **Solución:** modo «buzón» que recibe todo documento sin contestar, clasificador de documentos, liga automática de la ficha a su cobro, del comprobante a su pago y del pagaré a su factura sólo cuando cuadran sin ambigüedad; bandeja con filtro por tipo y motivo.
- **Optimización:** (sin medición). No se ha probado con documentos reales.
- **Estado:** 🔨 local sin PR (commit del 8-oct). ⚠️ No está en ninguna rama ni en GitHub, y su carpeta de trabajo ya no existe: puede perderse. Lleva más de 1,000 commits de atraso contra `main`.

### Almacén — Andén de entrada

#### El Andén no pierde vales y funciona sin internet
- **En qué se trabajó:** si se iba el internet a medio vale, el avance se «borraba». Lo que no se terminaba ayer desaparecía hoy. Y se pidió que el Andén se dedicara sólo a las caducidades.
- **Solución:** el menú muestra los vales de hoy y de los últimos 7 días, con los atrasados en un grupo aparte llamado «Incompletos». El vale se puede seguir sin red y lo hecho se envía solo al volver la conexión, sin duplicar existencia. Los traspasos entran por su número de embarque. Acomodar se movió a la pantalla de Ubicaciones.
- **Optimización:** (sin medición). Las pruebas pasan, pero no se probó en un equipo real sin señal.
- **Estado:** ✅ integrado (PR #321). Cambia dos reglas fijadas antes por Edgar: «sólo hoy» y «al fechar se acomoda».

#### Monitor de llegadas y producto sin caducidad
- **En qué se trabajó:** hay camiones a los que Kepler ya les dio entrada pero nadie abrió su vale en el Andén. Esa mercancía queda en inventario sin caducidad y ninguna pantalla lo mostraba. Además, productos como bolsas o velas no tienen fecha de caducidad y no había cómo declararlo.
- **Solución:** pestaña nueva «Llegadas al andén», que por ahora sólo ve la administración: qué camiones llegaron, qué traían y si se les puso caducidad. En el Andén se agregó un enlace pequeño, «Este producto no cuenta con fecha de caducidad».
- **Optimización:** (sin medición). No se midió cuánto tarda la consulta en producción ni se revisó la pantalla en el navegador.
- **Estado:** ✅ integrado (PR #341)

#### Ubicaciones por sección de la bodega (WMS-UB)
- **En qué se trabajó:** organizar el acomodo por secciones de la bodega.
- **Solución:** se trabajó de forma local y se dejó en pausa por decisión de David.
- **Optimización:** (sin medición).
- **Estado:** ⛔ en pausa. No se encontró el trabajo: no hay commits en git y la carpeta de trabajo local (`.wt-wms-ub`) ya no existe en la máquina. Puede haberse perdido.

### Logística — Embarques

#### «Nuevo embarque» toma el viaje de Kepler (EMB.12)
- **En qué se trabajó:** Logística volvía a teclear en la Suite lo que almacén ya había capturado en Kepler: unidad, chofer, paradas, cajas y valor.
- **Solución:** se elige el viaje del día y la hoja de embarque llega llena y bloqueada. Sólo se captura lo que Kepler no tiene. Además se crea una guía de entrega con un destinatario por parada. Una guía no se puede tomar dos veces.
- **Optimización:** la hoja aparece en ~0.44 s y la API responde en menos de 100 ms. Se midió en el ambiente local, no en producción (cuerpo del PR #275).
- **Estado:** ✅ integrado (PR #275)

#### Comisión y viáticos calculados, no tecleados (EMB.13, EMB.19)
- **En qué se trabajó:** la comisión y los viáticos se escribían a mano. Un cero por omisión significaba no pagarle a alguien.
- **Solución:** la comisión sale de la tarifa de la ruta (en un viaje de varias rutas, la más alta). Los viáticos salen del horario: café antes de las 6:00, desayuno antes de las 7:00, comida si llega después de las 15:00, cena si duerme fuera o llega después de las 20:00. Los montos quedan bloqueados. Sin tarifa, la guía no se crea, y la pantalla dice qué falta.
- **Optimización:** se quita la captura a mano (sin medición del tiempo ahorrado). Impacto medido en el ambiente local: 29 de las 49 rutas usadas en 60 días no tenían tarifa (49 % de las paradas), y sólo 2 de 18 viajes de un día se podían tomar (cuerpo del PR #290). Logística tiene que capturar esas tarifas.
- **Estado:** ✅ integrado (PR #290 y #327)

#### La guía se llena en un solo lugar y se revisa contra el GPS (EMB.21, EMB.22)
- **En qué se trabajó:** la guía se podía llenar en tres pantallas distintas. Lo capturado (horas, km, si durmió fuera) no se contrastaba con nada.
- **Solución:** la guía nace al tomar el viaje como «Incompleta» y se completa sólo en la pestaña Guías. Un embarque no se cierra con una guía incompleta. Un recuadro compara lo capturado con el GPS de la unidad y marca las diferencias. Si no se puede revisar, explica por qué.
- **Optimización:** medido en producción, de sólo lectura: Kepler trae el chofer en 606 de 852 viajes (71 %). Con una ventana de 48 h el GPS reconstruye 29 de 42 viajes con rastreador. La revisión tarda unos 20 ms (cuerpo del PR #339).
- **Estado:** ✅ integrado (PR #339)

#### Pago por viaje cerrado (EMB.24–EMB.29)
- **En qué se trabajó:** las comisiones y los viáticos se pagaban por día en Kepler, sin saber si el viaje había llegado completo.
- **Solución:** el pago se libera cuando el viaje se cierra. Un traspaso se cierra solo con la recepción en Kepler; un pedido de cliente, cuando Logística marca «entregado» o «no entregado». Se paga con un vale por persona en Gastos › «Comisiones de logística», en corte catorcenal (jueves a miércoles, pago el viernes). Quien arma el vale no lo puede aprobar, y un viaje no se paga dos veces.
- **Optimización:** el corte reproduce los 6 viernes en que Kepler pagó estos conceptos (17-jul a 25-sep). Con el índice nuevo, cada parada se revisa en 0.3 ms (cuerpo del PR #368). El tiempo ahorrado a Finanzas es (sin medición).
- **Estado:** ✅ integrado (PR #368). Lleva 2 migraciones que van antes del despliegue (una fuera de horario hábil). Que estén aplicadas en producción no está verificado en este reporte.

#### Tarifas fijas con autorizador e historial (EMB.28.1)
- **En qué se trabajó:** al editar una tarifa en Logística › Configuración, el monto tecleado no se guardaba y no salía ningún error. Además, cualquiera con permiso de configuración podía cambiar una tarifa con la que se le paga a alguien.
- **Solución:** se corrigió el guardado. Ahora una tarifa se captura una vez; cambiarla, borrarla o renombrar la ruta exige un permiso nuevo de autorizador (Dirección). Cada cambio queda en un historial con quién, cuándo y el valor anterior y nuevo.
- **Optimización:** el defecto se midió en producción: una ruta editada quedó en $0, y por eso su guía no se podía completar (cuerpo del PR #379). El beneficio de control es cualitativo (sin medición).
- **Estado:** ✅ integrado (PR #379). Requiere su migración antes del despliegue y que las 2 personas de Dirección vuelvan a iniciar sesión.

### Compras — Catálogo y productos

#### Productos nuevos: seguimiento a 30/60/90 días
- **En qué se trabajó:** Compras no sabía si un producto recién dado de alta se estaba vendiendo, si ya recuperó lo invertido ni si conviene recomprarlo.
- **Solución:** pestaña nueva, Compras › Catálogo › Productos nuevos. Sigue cada producto 90 días desde su primera compra o venta, con cortes a 30, 60 y 90 días, y recomienda: recomprar, esperar, revisar o no recomprar, siempre con su motivo. Después se agregó: sólo datos de Kepler y en vivo las 24 h; los tres márgenes (de lista, real y sobre lo pagado, sólo con permiso de costos); en qué sucursal se mueve mejor; cuándo llegó la mercancía; el reparto entre sucursales; y todo en cajas y piezas. Al juntar los datos apareció un error de Kepler: en los productos que cambiaron de unidad, la existencia sale mal y la pantalla daba por agotadas sucursales que sí tenían producto. Ahora esas sucursales salen marcadas «en duda» y se pide contarlas antes de recomprar.
- **Optimización:** el primer cálculo en producción no terminaba y frenaba los demás cálculos de 15 minutos. Se rehízo y el refresco quedó en unos 43 s, contra un tope de 180 s (PR #329, #344). Con un ajuste de la base, el refresco bajó de 4.8 s a 70 ms en local (PR #325). Hay 173 combinaciones sucursal×producto, de 50 productos nuevos, con la existencia en duda (PR #344).
- **Estado:** ✅ integrado (PR #311, #325, #329, #331, #344).

#### Productos: flujo de venta, líderes, lo que no se vende y caducidad
- **En qué se trabajó:** Compras quería saber de cualquier producto cómo se vende, dónde se estancó y si de verdad hace falta comprarlo. También quería que «Productos nuevos» dejara de parpadear al recargar.
- **Solución:** en Compras › Catálogo › Productos, cada producto tiene «Este mes» contra el mes anterior y una «Situación» (comprar, mover entre sucursales, esperar, sobra, no comprar). Al darle clic se abre un panel con el detalle por sucursal. Se agregaron los líderes (los productos que juntos hacen la mitad de la venta), la caducidad por lote y un bloque «Para cuidar hoy» con los líderes de un lado y lo que no se vende del otro. Ese bloque lo calcula el servidor en segundo plano cada minuto.
- **Optimización:** en Productos nuevos, la lista bajó de 1.7–2.3 s a 0.13–0.16 s y el detalle de 1.1 s a 8 ms. «Para cuidar hoy» pasó de 2.9–3.6 s en producción a 23–50 ms en local (la cifra de después no es de producción). La respuesta pesa 234 KB en vez de 477 KB. Se encontraron 928 productos sin venta en 30 días o más, con $1.16M detenidos. Todo medido en el PR #363.
- **Estado:** ✅ integrado. El PR #363 se cerró sin merge porque el líder técnico lo subió directo a `main` (commit `246f0f7a9`) y verificó que no faltara ningún archivo.

#### Catálogo revisado por proveedor
- **En qué se trabajó:** Compras trabaja por proveedor, y la pestaña Productos era una tabla general con muchas columnas.
- **Solución:** una barra de proveedores ordenada por venta del mes, con los productos sin proveedor aparte. Cada proveedor tiene su encabezado (venta, por comprar, agotados, líderes) y un renglón por producto que dice para cuántos días alcanza y qué hacer, en una frase. Un segundo PR corrigió tamaños de letra que no se aplicaban.
- **Optimización:** en producción, la lista de proveedores carga en 280–340 ms y un proveedor de 269 productos tarda 1.1–1.9 s la primera vez; dentro del mismo minuto sale al instante (PR #375).
- **Estado:** ✅ integrado (PR #375, #382).

#### Existencia rápida y en cajas, paquetes y piezas
- **En qué se trabajó:** cada búsqueda o filtro en la pantalla de Existencia tardaba más de un segundo, y las cantidades salían con decimales («333.7») en vez de cajas y piezas.
- **Solución:** el servidor arma una foto de la existencia y filtra sobre ella. Las cantidades se muestran como «35 cj 171 pz». La pantalla dice qué tan reciente es la foto (a lo más ~1 minuto). De paso volvió a funcionar un aviso que nunca salía: el de las celdas valuadas con el costo del catálogo.
- **Optimización:** medido contra producción, la vista por omisión bajó de 1,525 ms a 45 ms y una búsqueda de 2,811 ms a 26 ms. La primera carga del día tarda ~2.5 s (PR #367).
- **Estado:** ✅ integrado (PR #367).

### Plataforma y calidad

#### `main` rojo por dos causas ajenas (PRIMENG.TECHO, TES.21)
- **En qué se trabajó:** «Lint & test» salía rojo en cualquier PR por dos causas. Un selector del puente ContPAQi rebasaba el límite de usos de una opción obsoleta de PrimeNG, y una prueba de Finanzas producía errores sin manejar.
- **Solución:** se corrigió el selector (sin cambio visible) y se arregló la prueba, no el servicio, para que falle donde fallaría una consulta real.
- **Optimización:** los usos de la opción obsoleta bajaron de 273 a 272, dentro del límite (PR #365). Los errores sin manejar bajaron de **14 a 0**, con 1,096 pruebas de Finanzas en verde (PR #372).
- **Estado:** ✅ integrado (PR #365, PR #372). ⛔ El PR #377 se cerró porque duplicaba al #372.

#### Documentación por módulo (MODULOS)
- **En qué se trabajó:** no existía un lugar donde se explicara, módulo por módulo, qué problema se resolvió y por qué se hizo así.
- **Solución:** una carpeta con un documento por módulo, en cuatro partes fijas, más una guía para convertirlo en documento formal para la empresa. Se rellenó con 161 entradas de 13 módulos.
- **Optimización:** (sin medición).
- **Estado:** 🔨 local sin PR (rama `docs/modulos`). Los documentos de cada módulo sí van entrando a `main` dentro de los PRs de cada funcionalidad.

---

## Semana 6 · 29 de septiembre al 5 de octubre

### Arqueo de caja

#### El arqueo deja de tener horario y candados
- **En qué se trabajó:** las cajeras se quedaban bloqueadas sin poder hacer más cortes. La causa principal era que la ingesta de Kepler llevaba 6 días caída, pero además había tres candados que solo se podían abrir desde Kepler.
- **Solución:** se quitaron la regla de orden, el bloqueo por dos cajas (ahora es solo un aviso) y la obligación de tener turno: sin turno se cuenta igual y queda marcado como "sin folio". Llega un aviso cuando Kepler abre la caja. El arqueo sigue siendo ciego.
- **Optimización:** se destraban 25 cajeras con el turno congelado, entre ellas 4 que estaban trabadas por la regla de orden (una desde hacía 235 días) (PR #188).
- **Estado:** ✅ integrado (PR #188)

### Gastos

#### El ciclo del vale conectado con Kepler
- **En qué se trabajó:** el vale no reflejaba lo que pasaba en Kepler después de la firma; quien sólo tenía la cotización no podía mandar el gasto; faltaba la constancia de autorización.
- **Solución:** el vale llega solo a «Mis gastos» de quien Kepler marca en «Solicita»; etapas «Por ejercer» / «Ejercido» leídas de Kepler (y «sin medir» cuando no se sabe); constancia de autorización dentro del expediente; sugerencia de CFDI con su cobertura; cotización basta para mandar y el vale vuelve si queda debiendo la factura.
- **Optimización:** la señal de «dinero salió» en Kepler acierta 7,949 de 7,949 casos (PR #189). La sugerencia de CFDI cubre 743 de 8,899 gastos (8.4 %) (PR #189). Kepler no registra quién ni cuándo autorizó: se declaró en vez de inventarlo.
- **Estado:** ✅ integrado (PR #189)

#### Expediente, bandeja limpia y reglas de control
- **En qué se trabajó:** la bandeja de aprobación sólo mostraba lo del día y quedaba vacía con decenas pendientes de otros días; un autorizador podía aprobar su propio vale; quien levantaba el vale recibía «sin permiso» al abrir su evidencia; el importe del vale a veces tomaba el de otra sucursal; el PDF del expediente existía pero no tenía botón; un aviso de instalar la app tapaba los botones de subir archivo durante 30 s.
- **Solución:** «Expediente» con los vales de todos agrupados por persona y su PDF; «Mis gastos» en 3 columnas (Solicitudes → Pendientes de comprobación → Expedientes); la comprobación de Kepler deja de ser forzosa; nadie aprueba, valida ni rechaza su propio vale (superadmin incluido); la bandeja es una cola de cualquier fecha; quien captura abre sólo sus propios vales; el importe sale de Kepler por sucursal + folio y se reparan los vales pasados; sucursal con clave y nombre; la visión de la otra pantalla de comprobaciones tampoco cierra sola; script y guía para medir la huella de autorización cuando haya acceso de lectura a Kepler.
- **Optimización:** en base local, 78 vales esperaban firma repartidos en ~25 días y la bandeja salía vacía (PR #256). En base local, 76 usuarios que capturan recibían «sin permiso» al abrir su propia evidencia; ya no (PR #257). 373 folios se repiten entre sucursales: el importe ya no se toma de otra tienda (PR #264).
- **Estado:** ✅ integrado (PR #201, #215, #242, #243, #246, #256, #257, #264)

### Venta y preventa

#### Acuerdos de promoción y sell-out (MKT.6)
- **En qué se trabajó:** había trabajo de otra sesión sobre acuerdos de promoción sin guardar en el repositorio, con controles de calidad en rojo.
- **Solución:** se preservó tal cual y se corrigió lo que lo bloqueaba: la categoría de permisos «MKT · Acuerdos» no estaba declarada (sus permisos salían fuera de su grupo en el editor de accesos) y se cerraron las violaciones de tipos. Al cerrarlas salieron 3 errores reales, entre ellos uno que podía guardar el acuerdo sin nombre de quien lo capturó.
- **Optimización:** violaciones de tipos de 29 a 0 (fuente: PR #201). Es una mejora de calidad, no de tiempo.
- **Estado:** ✅ integrado (PR #201)

### Logística — Embarques

#### Guía de Cobranza con Total factura · Abonos/Pagos · Saldo (GT.17)
- **En qué se trabajó:** el cobrador veía sólo «Descuento» e «Importe» y no sabía cuánto se había abonado a cada factura.
- **Solución:** cada factura muestra Total factura, Abonos/Pagos y Saldo. Si el sistema no conoce el saldo, dice «—» en lugar de un cero falso. Las guías viejas se reimprimen tal como se firmaron.
- **Optimización:** probado con datos reales: 3 clientes, 38 facturas, $277,010.92; cada renglón cuadra al centavo (cuerpo del PR #198). Hallazgo: 15 facturas «parciales» tienen un saldo de ≈3 % del total ($7,771.78 en conjunto). Puede ser un descuento por pronto pago que Kepler no acreditó, y la guía mandaría a cobrarlo. Falta confirmarlo con crédito y cobranza.
- **Estado:** ✅ integrado (PR #198)

### Compras — Catálogo y productos

#### Costos: costo estándar entre sucursales e historial por producto
- **En qué se trabajó:** el costo estándar sale de la negociación con el proveedor y debe ser igual en todas las sucursales. Compras no tenía cómo ver cuáles se salían ni cuándo una compra llegó a otro costo, que es lo que se le reclama al proveedor.
- **Solución:** se separaron las pestañas «Costos» y «Precios». En Costos hay dos vistas: «Entre sucursales», con los productos cuyo costo no coincide con el de la mayoría (los casos que no se pueden comparar se declaran), e «Historial por producto», que muestra por sucursal cuándo cambió el costo estándar y cuándo llegó una compra a otro costo. Sólo la ve quien tiene permiso de costos.
- **Optimización:** (sin medición). El PR avisa que las cifras y el tiempo de carga no se habían verificado contra producción.
- **Estado:** ✅ integrado (PR #253).

#### Costos: que la pestaña deje de tardar
- **En qué se trabajó:** el historial de un producto leía toda su historia de ventas y compras sin índice.
- **Solución:** índices por producto, historial de 90 días por omisión y la lista guardada en memoria por 10 minutos.
- **Optimización:** en una base de prueba con volumen como el de producción, la lectura de ventas bajó de 309 a 28 ms y la de compras de 235 a 16 ms (commit `759356adc`).
- **Estado:** 🔨 local sin PR. Quedó en una rama de rescate y nunca llegó a `main`. Sus índices se retomaron en la auditoría de S8.

### Tickets de venta

#### Bandeja de tickets por filtros y desglose por pieza y partida
- **En qué se trabajó:** la pantalla exigía saber el folio para mostrar algo; y el usuario pidió que al cliente con descuento se le desglose el impuesto sobre el precio ya descontado, por pieza, por partida y al total.
- **Solución:** bandeja con filtros de sucursal, fechas (máximo 31 días) y cliente, más buscador. Nuevo formato en carta, pantalla y rollo: lista, descuento, precio con descuento, sin impuestos, IVA, IEPS y neto, con totales que cuadran al centavo. El rollo vuelve a decir «Reimpresión» con hora de México. Ningún papel dice ya «fiscal» ni «no fiscal» (pedido del usuario). Se arregló que la lista de candidatos saliera mutilada y que «lo más reciente» se ordenara por día de la semana. Se dejaron en verde 4 pruebas que venían rotas.
- **Optimización:** la bandeja responde en 7–42 ms de 1 a 31 días, medido contra producción en la revisión; el tope se subió a 5,000 porque un día normal ya rebasaba el de 1,000, y el día completo sale en 153 ms (tracker TK.12). Los 282 documentos de prueba cuadran partida por partida (PR #193).
- **Estado:** ✅ integrado (PR #193)

#### El código del producto en la misma línea que el nombre
- **En qué se trabajó:** el usuario pidió ahorrar papel en la hoja carta; el código ocupaba un renglón propio bajo cada producto.
- **Solución:** el código va junto al nombre. Se probó también apretar el espacio entre filas, pero no ahorraba hojas y no se hizo.
- **Optimización:** con un ticket real, entran 18 renglones por hoja en vez de 13 (+38%) y la tabla baja de 171.7 mm a 140 mm. El ticket de 30 productos que originó el pedido sigue ocupando 2 hojas (tracker TK.15).
- **Estado:** ✅ integrado (PR #201, junto con trabajo de gastos y PWA)

### Pagos a proveedor

#### Captura por lote con IA y validación automática (PC.3–PC.6)
- **En qué se trabajó:** cada comprobante de pago a proveedor se capturaba en un diálogo propio, había que elegir su pago a mano y luego esperar a que alguien lo validara. Además, quien adjuntaba el comprobante podía validarse a sí mismo.
- **Solución:** una zona de carga que acepta varios PDFs a la vez. La IA lee cada uno y busca su pago en Kepler, y nada se guarda sin el clic de «Guardar». El comprobante solo queda listo si coinciden exactos el banco, la fecha, el monto y el proveedor, y en ese caso **el servidor lo valida solo** (ADR-082). Lo que no coincide pasa a una pestaña nueva, «Con diferencias», con marcas que dicen qué dato falló, y el botón «Volver a comparar» recalcula contra lo que Kepler dice hoy. Nadie puede validar ni rechazar el comprobante que él mismo adjuntó, tampoco el superadmin. Trae una migración aditiva.
- **Optimización:** (sin medición). El propio PR aclara que no se midió cuántos comprobantes se validarán solos, porque la base local no tiene pagos de Kepler.
- **Estado:** ✅ integrado (PR #250)

#### Cuentas BanBajío que nunca coincidían (PC.7)
- **En qué se trabajó:** en las primeras pruebas en producción, ningún pago que salía de BanBajío coincidía en «banco», así que ninguno se validaba solo. La alerta de «cuenta de origen no reconocida» además los marcaba todos como si vinieran de una cuenta ajena.
- **Solución:** había dos fallas encadenadas. La IA guardaba solo los últimos 4 dígitos de la cuenta, y en BanBajío esos 4 dígitos son iguales en todas las cuentas. Por otro lado, la regla comparaba el final del número, cuando BanBajío pone la clave de la cuenta en el centro. Ahora la IA lee el número completo y la regla lo interpreta según el formato del banco. La regla no se aflojó: se sigue exigiendo la cuenta exacta, para no validar un pago que salió de otra cuenta del mismo banco.
- **Optimización:** (sin medición). Es cualitativa: los pagos de BanBajío vuelven a poder validarse solos.
- **Estado:** ✅ integrado (PR #251)

#### La lista del lote se limpia al guardar y se mide la lentitud (PC.8)
- **En qué se trabajó:** había dos reportes de producción. (a) Después de guardar un lote, las filas seguían en pantalla y había que salir y volver a entrar para limpiarlas. (b) La página tardaba de 5 a 6 segundos en cargar.
- **Solución:** (a) lo guardado sale de la lista y en su lugar aparece un resumen («N guardados · N validados solos · N con diferencias») con un botón para ir a las diferencias. La lista tiene scroll propio y «Guardar» queda siempre a la vista. (b) No se pudo reproducir. Se probaron cuatro hipótesis, todas descartadas con medición, y la pantalla quedó instrumentada: reporta cuánto tarda cada consulta y deja aviso en el log si la carga pasa de 1 segundo.
- **Optimización:** en la simulación de 25 PDFs, las filas que quedan después de guardar bajaron de **25 a 5** (solo las que aún piden algo). Con un volumen parecido al de producción (600 mil documentos), la consulta tardó **unos 110 ms**, así que la consulta no explica los 5–6 s. Fuente: cuerpo del PR #254 y tracker [PC.8].
- **Estado:** ✅ integrado (PR #254)

### Plataforma y calidad

#### Desarrolladores › Proyectos: bitácora del equipo (DEV)
- **En qué se trabajó:** las ideas de proyecto del equipo de desarrollo se perdían en pláticas.
- **Solución:** un módulo nuevo donde cada proyecto es una orden con folio, objetivo escrito o dictado por voz, evidencia (archivos, fotos y video tomados en pantalla), responsable, notas y seguimiento. Cada edición deja un registro automático con el antes y el después, que nadie puede borrar.
- **Optimización:** (sin medición).
- **Estado:** ✅ integrado (PR #205)

#### El aviso de «Instalar app» bloqueaba los botones (PWA)
- **En qué se trabajó:** botones como «Subir cotización» no respondían. El aviso de instalar la app tapaba los últimos 83 px de la pantalla durante los primeros 30 segundos de cada carga, **en toda la app**, y se comía los clics.
- **Solución:** el aviso deja pasar los clics, y solo sus propios botones los reciben.
- **Optimización:** (sin medición) en uso. Se comprobó en el navegador que el clic vuelve a llegar al botón.
- **Estado:** ✅ integrado (PR #201)

#### Corte del 1-oct: el `00` dejó de concentrar (PO.0)
- **En qué se trabajó:** desde el 1-oct cada centro de costo opera por su cuenta, pero varias vistas seguían filtrando solo la sucursal `00`. No marcan error: simplemente muestran menos datos, o de más en el caso de las cancelaciones.
- **Solución:** se hizo un diagnóstico medido, un plan (Fase PO) y un script que detecta las vistas afectadas. A propósito no se tocó código.
- **Optimización:** se revisaron 65 vistas y 6 estaban ancladas. Quedan 4 por corregir, que alimentan 3, 16, 11 y 3 consumidores (cuerpo del PR #237).
- **Estado:** ✅ integrado (PR #237, solo documentación)

#### Colores que apuntaban a variables inexistentes (tokens)
- **En qué se trabajó:** «check:tokens» estaba rojo en `main` porque Caja General y Mis gastos usaban 5 referencias a colores que no existen, y el navegador las ignoraba sin avisar.
- **Solución:** se apuntaron a los colores reales del sistema de diseño.
- **Optimización:** (sin medición). La compuerta volvió a verde.
- **Estado:** ✅ integrado (dentro del PR #193)

---

## Semana 5 · 22 al 28 de septiembre

### Gastos

#### Evidencia en vivo, expediente y separación capturar / aprobar
- **En qué se trabajó:** la forma de pago venía vacía en el 54 % de las solicitudes y casi ningún gasto tenía comprobante en el sistema; la historia de un gasto vivía en cuatro lugares; 76 personas que capturan no tenían área asignada y veían su lista vacía; capturar y aprobar estaban en la misma pantalla.
- **Solución:** forma de pago obligatoria y foto en vivo con la cámara; expediente del gasto consultable por sucursal + folio con su PDF; propuesta automática de áreas para confirmar; la sección se parte en «Gastos» (capturar, abierta a todos), «Aprobación de gastos» y «Tablero»; la aprobación es de uno en uno y rechazar exige motivo; nadie recibe la firma por rol si no fue nombrado (permiso por persona).
- **Optimización:** forma de pago vacía en 5,410 de 10,082 solicitudes y expedientes en sólo 0.09 % de ellas — medido antes del cambio (PR #151). El cruce de solicitudes y gastos bajó de más de 90 s (cancelado) a 1.2 s (PR #151). Antes, 66 de 166 usuarios podían entrar a Gastos pero no veían la opción en el menú (PR #160).
- **Estado:** ✅ integrado (PR #151, #157, #158, #159, #160)

#### Correcciones de la pantalla de captura
- **En qué se trabajó:** la cámara mostraba negro y no tomaba la foto; el buscador sólo encontraba el folio exacto; «¿Cómo se pagó?» salía como texto pegado; la fecha agrupaba por día de captura y no del gasto; el chip mostraba una clave técnica («no_fiscal_comprobable»).
- **Solución:** cámara reparada con salida si no hay permiso; búsqueda parcial sólo para quien ya tiene su cartera; botones de forma de pago con su código de Kepler; agrupación por día del gasto; etiquetas claras («Con factura», «Sólo ticket o recibo», «Sin comprobante»).
- **Optimización:** evita gastos agrupados en el día equivocado y fotos que no se podían tomar (sin medición).
- **Estado:** ✅ integrado (PR #158, #159, #162)

#### Módulo completo: levantar, autorizar y «Mis gastos»
- **En qué se trabajó:** la captura estaba muerta: el botón pedía un archivo que ninguna pantalla subía y nadie podía levantar un gasto; la visión firmaba sola expedientes como «Claude Vision»; el Historial prometía el de la empresa y a 57 de 80 personas les mostraba sólo lo propio; un vale escaneado no contaba como evidencia.
- **Solución:** flujo de tres pasos (folio → método de pago → evidencia); bandeja de aprobación en tres pestañas (entrada, aprobados, rechazados); aprobación «provisional» con cotización; reapertura que decide quien firmó; avisos a quien levantó el gasto. La visión ya no decide: sólo avisa cuando no pudo leer o el monto no cuadra. Nace «Mis gastos» para quien levanta. El vale escaneado vale lo mismo que la foto.
- **Optimización:** se reabre la captura de gastos, que estaba bloqueada para todos (PR #170). Se corrigió que los contadores de «Mis gastos» mostraran los de toda la empresa en vez de los propios (PR #174). Ninguna decisión sobre dinero queda firmada por una máquina (sin medición).
- **Estado:** ✅ integrado (PR #170, #174). ⛔ PR #173 descartado: lo reemplazó #174, que además devolvió la visión como aviso.

### Almacén — Andén de entrada

#### Rediseño del Andén: una sola pasada por caja y mover mercancía de rack
- **En qué se trabajó:** cada caja se tocaba dos veces: una para fecharla y otra para acomodarla. El bloqueo por inventario físico aparecía hasta el momento de guardar. Una vez acomodado, un lote ya no se podía cambiar de rack. Y al crear una ubicación salía «no se pudo crear» sin decir por qué.
- **Solución:** la caja se fecha y se acomoda en la misma pasada. El bloqueo se avisa antes de capturar. Ya se puede mover mercancía de un rack a otro sin alterar la existencia. El botón de cerrar sólo aparece cuando no falta nada. El alta de ubicación explica el error, y el código del rack se puede escanear para ver qué contiene.
- **Optimización:** se agregaron 47 pruebas automáticas nuevas (PR #149). La reducción de tiempo no se midió (sin medición).
- **Estado:** ✅ integrado (PR #142, #149)

#### El Andén arranca por sucursal y muestra los vales del día
- **En qué se trabajó:** se pidió que los vales aparecieran solos, por sucursal y sólo los del día. Había además un error oculto: después de las 7 PM la pantalla mostraba los vales del día siguiente, porque la base de datos calcula la fecha con otra zona horaria.
- **Solución:** el Andén abre con un menú de sucursales y sus vales del día, en hora de México. El folio a mano queda como respaldo. Si el usuario puede ver todas las sucursales, la pantalla lo dice en lugar de fingir un filtro.
- **Optimización:** a las 7 PM aparecían 4 vales del día equivocado; ahora 0 (PR #152).
- **Estado:** ✅ integrado (PR #152, #154)

#### Destrabar el almacén congelado desde el Andén
- **En qué se trabajó:** en una sucursal no se podía recibir mercancía. Un conteo de inventario abierto desde hacía 100 días congelaba el almacén y revertía cada fecha que se capturaba. El botón para cancelarlo existía, pero en otra pantalla y con un permiso que los bodegueros no tienen.
- **Solución:** el Andén dice desde cuándo está congelado el almacén y permite cancelar el conteo. Se creó un permiso propio para cancelar, separado del de aplicar el conteo. Quien no es supervisor sólo puede cancelar un conteo sin actividad en 7 días.
- **Optimización:** de 22 capturas de caducidad registradas en toda la historia, 10 se habían revertido por ese conteo, que llevaba 3 de 2,094 artículos contados. 4 de las 5 personas del Andén no podían destrabarlo. El permiso nuevo quedó repartido a 6 roles y 18 personas (PR #172).
- **Estado:** ✅ integrado (PR #172)

### Compras — Catálogo y productos

#### Aviso de cambios y hoja de precios por proveedor
- **En qué se trabajó:** la tabla se recargaba sola mientras alguien la leía para ir a corregir en Kepler, y podía terminar corrigiendo el producto equivocado. Además, Compras necesitaba llevar a la negociación una hoja impresa con los precios de un proveedor.
- **Solución:** en vez de recargarse sola, la pantalla muestra un aviso con la hora del cambio y un botón «Cargar los nuevos». Se agregó la pestaña «Reporte»: se eligen proveedores, sucursal, productos y qué precios salen (unidad, mayoreo, paquete, caja; el costo sólo si se marca), y se imprime o se guarda en PDF. La hoja dice de qué sucursal y de qué fecha son los precios. Un precio que falta sale con guion, nunca como $0.00.
- **Optimización:** (sin medición). El beneficio es que la hoja de precios ya no se arma a mano.
- **Estado:** ✅ integrado (PR #141, #156).

### Tickets de venta

#### Reporte por cliente (nueva sección)
- **En qué se trabajó:** además de «dame este ticket» hacía falta «dame todo lo que compró este cliente», con filtros.
- **Solución:** sección nueva con 8 filtros (sucursal, fechas, importe, cliente, marca, proveedor, caja, quién atendió) e impresión del reporte. Las notas de crédito restan. Arreglos al buscador: encuentra nombres con o sin acento, ordena por parecido (tolera errores de dedo) y agrupa al cliente una sola vez aunque aparezca en las nueve sucursales. Después se simplificó la pantalla a pedido del usuario: periodo en un renglón de opciones, filtros finos en un panel y fechas en palabras. De paso se arregló un acceso de Comercial que mandaba a una página vacía.
- **Optimización:** la consulta de facturas del reporte bajó de 9,889 ms a 1,335 ms (PR #143). El buscador pasó de 5,297 resultados repetidos a 685 clientes únicos para la misma búsqueda, y con acento pasó de 0 a encontrar (PR #144).
- **Estado:** ✅ integrado (PR #143, #144, #146)

#### Colores de texto que no existían en la pantalla
- **En qué se trabajó:** subtítulos, encabezados y notas se veían con el mismo peso que el contenido, porque 17 colores apuntaban a variables que no existen.
- **Solución:** se corrigieron los colores, la fila excluida ahora se atenúa (antes se tintaban casi todas) y los filtros dejaron de usar el naranja del botón principal. Se agregó una prueba que impide volver a usar colores inexistentes.
- **Optimización:** (sin medición)
- **Estado:** ✅ integrado (PR #153)

#### Formato del papel: precios netos y luego cinco columnas claras
- **En qué se trabajó:** el área usuaria pidió precio neto y neto con descuento; al verlo impreso, cuatro columnas de precio confundían al cliente.
- **Solución:** primero se agregaron las columnas de neto (PR #161); tres días después, con la captura del papel, se rediseñó a una lectura simple: precio original, precio con descuento, descuento por pieza, descuento total y total a pagar. IVA e IEPS bajan al pie. El reporte por cliente puede mostrar el detalle por producto de cada compra.
- **Optimización:** en carta el nombre del producto pasa de 20% a 30% del ancho y deja de partirse en dos renglones (PR #171); sin medición de papel ahorrado.
- **Estado:** ✅ integrado (PR #161, #171)

#### El descuento de cliente salía en $0 y luego con la cifra equivocada
- **En qué se trabajó:** el reporte por cliente mostraba $0 de descuento justo en telemarketing y crédito, donde sí existe, y el filtro «Sólo con descuento» nunca devolvía nada. La tabla de la pantalla tenía columnas sin encabezado.
- **Solución:** se toma el descuento real, se nombra «Descuento de cliente» (como lo llama el ERP) en todos los papeles, se corrigieron los encabezados de la tabla y el ticket de mostrador también muestra el porcentaje en las sucursales que lo cobran en caja.
- **Optimización:** la primera corrección usaba un campo que subdeclaraba el descuento un 8.3%; se cambió al dato medido, que cuadra al centavo (commit del PR #176). El porcentaje coincide con el negociado en el maestro de clientes en el 92.2% de las ventas de septiembre (docs del tracker, TK.d3b).
- **Estado:** ✅ integrado (PR #176)

### Plataforma y calidad

#### Las compuertas de calidad dejan de castigar por deuda ajena y de dar verde sin revisar (CI)
- **En qué se trabajó:** «Lint & test» estaba rojo casi siempre, porque revisaba todo el proyecto y no solo lo que el cambio tocaba, y un mismo cambio podía salir rojo o verde según el momento. Además, la compuerta de tipos, corrida en local, contestaba «OK» sin haber revisado nada.
- **Solución:** un revisor nuevo bloquea solo por errores en las líneas que el cambio escribió. La deuda vieja se sigue mostrando, declarada, pero ya no bloquea. La compuerta de tipos ahora revisa también lo que todavía no se commitea, y si no puede medir, marca rojo. Las dos se rompieron a propósito para comprobar que sí detectan el error.
- **Optimización:** antes del cambio, «Lint & test» estaba rojo en **24 de 26 corridas**. En un caso real hubo 294 errores en 11 proyectos y ninguno estaba en una línea escrita por el PR (cuerpo del PR #150). La compuerta de tipos pasó de dar verde a detectar 3 violaciones sembradas (PR #155).
- **Estado:** ✅ integrado (PR #150, PR #155)

#### El candado de la página de inicio, en rojo por 7 fallas (SN.4)
- **En qué se trabajó:** la prueba que revisa a dónde aterriza cada usuario llevaba varios merges en rojo en `main`.
- **Solución:** se revisaron las 7 fallas una por una. Dos eran excepciones legítimas que faltaba declarar, y las otras cinco eran menús que apuntaban a pantallas que no existen, así que se dejó de ofrecerlos como destino hasta que la pantalla exista. El candado no se debilitó.
- **Optimización:** las fallas del candado bajaron de 7 a 0 (commits del 23-sep).
- **Estado:** ✅ integrado (dentro del PR #146)

---

## Semana 4 · 15 al 21 de septiembre

### Arqueo de caja

#### Los retiros ya no se publican como faltante de la cajera
- **En qué se trabajó:** el historial mostraba "FALTAN" en todas las filas. A la cajera se le cobraba como faltante el dinero que ya había retirado, y eso salía en el ranking por persona y en el ticket.
- **Solución:** una sola regla de cuadre compartida (retiros + cajón = esperado) en todos los lugares que la usan. Los turnos que se perdían cuando dos cajas repetían el mismo folio el mismo día ahora se traen. La pestaña Retiro va primero, porque es lo más frecuente.
- **Optimización:** en 11 cierres el faltante que se mostraba bajó de $387,085.43 a la cifra real, que era un sobrante neto de $13,564.57 (PR #107). Se recuperaron 16 turnos que no llegaban, con $485 mil de esperado (PR #107). Además salió a la luz un faltante que Kepler da por cuadrado: 1,066 cortes, unos $2.2 millones (PR #107).
- **Estado:** ✅ integrado (PR #107, #112)

#### Arqueo de rutas RD/RV, la caja abierta que no aparecía y la moneda de $20
- **En qué se trabajó:** el efectivo que entrega el vendedor de ruta no quedaba registrado en ningún lado. Una caja abierta en Kepler salía como cerrada. Se pidió bloquear cuando una cajera tiene dos cajas abiertas, y no había manera de capturar la moneda de $20.
- **Solución:** pestañas RD y RV con su propio permiso (solo encargadas y auxiliares), donde se guarda quién entregó cuánto y con qué billetes. La caja abierta ya aparece. Cuando una cajera tiene dos cajas abiertas el mismo día, el arqueo se bloquea. Se agregó la moneda de $20 en un catálogo único de denominaciones.
- **Optimización:** la cajera afectada pasó de ver 0 turnos a ver 1, medido contra producción (PR #133). El candado se activa solo en 2 de 5 casos detectados, para no bloquear por datos viejos (PR #133). RD/RV no tiene esperado, así que no muestra diferencia y se declara "no medible".
- **Estado:** ✅ integrado (PR #133). ⚠️ #133 se integró sin compilar: la API y la vista se cayeron en producción, Edgar lo revirtió y lo restauró corregido el mismo día. ⛔ El PR #136 (la corrección de la vista) se cerró sin integrar porque Edgar incorporó su contenido en la restauración.

### Gastos

#### Una sola puerta a Gastos, folio por sucursal y lectura del ticket
- **En qué se trabajó:** tres entradas de menú para el mismo trámite; el folio de Kepler se trataba como único cuando cada sucursal lleva su propio contador (el cuadre podía correr contra el dinero de otra tienda); los links de captura nacían apuntando a una dirección local y no abrían en el celular; el trabajador tenía que teclear un importe que ya venía impreso en el ticket.
- **Solución:** una sola entrada «Gastos» que se adapta al permiso de quien entra; la llave del vale pasa a ser sucursal + folio; la evidencia se exige al capturar; el link toma la dirección real del servidor; la visión lee el ticket y propone importe, beneficiario y fecha (editable, nunca pisa lo que escribió la persona); se puede escribir una sucursal nueva; textos corregidos al español de México (17 textos).
- **Optimización:** 252 folios existen en más de una sucursal y ninguno es el mismo documento; ya no se cruzan (PR #111). Antes, todo link emitido desde producción era inservible (PR #116). Menos tecleo en el celular al leer el ticket (sin medición).
- **Estado:** ✅ integrado (PR #111, #116, #118; GX.10 directo a `main`)

### Almacén — Andén de entrada

#### Del folio a las fechas, y la ubicación se crea donde se usa
- **En qué se trabajó:** no había ninguna ubicación registrada en el sistema, así que «escanea el rack» no tenía nada que escanear. Muchas veces las cajas de un mismo producto traen fechas distintas. Y 4 de las 5 personas que reciben no podían acomodar ni ver el mapa de ubicaciones, por falta de permiso.
- **Solución:** el recorrido queda en folio → fechas → ubicación. Se puede poner una sola fecha para todo el vale. Si el rack no existe, se crea ahí mismo y se imprime su cartel con código de barras. Un renglón acepta varias caducidades, cada una con su cantidad y su foto. La pantalla de Ubicaciones se volvió un mapa de la bodega: a la izquierda los racks, a la derecha qué hay en cada uno ordenado por caducidad. Los bodegueros ya pueden ver y acomodar sin recibir permisos de más (no se les abrió el ajuste de inventario).
- **Optimización:** antes 4 de los 5 usuarios del Andén no podían acomodar ni ver Ubicaciones; ahora pueden los 5 (PR #131, #135, medido en producción).
- **Estado:** ✅ integrado (PR #120, #131, #135)

### Compras — Catálogo y productos

#### El catálogo se muda a Compras y detecta códigos repetidos y precios distintos
- **En qué se trabajó:** el catálogo estaba en Ventas, aunque lo mantiene Compras. Además, había códigos de barras dados de alta en más de un producto: la caja cobraba el que le tocaba y la venta se descontaba del producto equivocado. Tampoco había forma de ver el mismo producto con distinto precio según la sucursal.
- **Solución:** el catálogo pasó a Compras › Catálogo (las ligas viejas redirigen) y ganó tres pestañas: «Códigos repetidos» (con columna de en qué sucursal se repite), «Precios distintos» (separa precio de pieza y de mayoreo, y aparta los casos que parecen de unidad, pieza contra caja) y una matriz «alta × sucursal» que dice si el problema es del catálogo central o de una tienda. Se dio permiso de ver el catálogo a los roles de Compras, que no lo veían.
- **Optimización:** se encontraron 56 códigos repetidos en la base de trabajo y 50 en producción (PR #101, #105). En producción, 1,032 de 8,757 productos comparables tienen precio distinto entre sucursales, y en 71 sólo difiere el mayoreo (PR #104). Siete personas de Compras no veían el catálogo y ahora sí (PR #108). La pestaña de códigos responde en 326 ms (PR #105) y la matriz por sucursal en 168 ms (PR #111), medido contra producción.
- **Estado:** ✅ integrado (PR #101, #104, #105, #108, #111). El PR #109 se cerró sin integrar porque su contenido entró en el #111.

#### El catálogo se mantiene al día solo
- **En qué se trabajó:** Compras reportó que al corregir códigos o precios en Kepler la pantalla no cambiaba. Se midió y el dato sí llegaba; lo que no se refrescaba era la pantalla.
- **Solución:** la pantalla pregunta cada 10 segundos si hubo cambios en el catálogo y siempre muestra si sigue vigilando. De paso se corrigió un defecto de la ingesta que tiraba el código de barras bueno cuando una sucursal tenía uno de relleno.
- **Optimización:** la consulta de «¿hubo cambios?» tarda 24.8 ms en producción (PR #114). Se recuperaron los códigos de 22 pares y 1 producto que no tenían código de barras (PR #114).
- **Estado:** ✅ integrado (PR #114).

### Tickets de venta

#### Buscar cualquier folio y reimprimirlo (arranque del módulo)
- **En qué se trabajó:** el cliente pedía su ticket y no había forma de reimprimirlo sin importar de qué canal viniera la venta, ni de mostrarle cuánto costaba antes y cuánto le quedó con el descuento.
- **Solución:** pantalla nueva que busca el folio en todos los canales y reimprime en ticket térmico de 80 mm y en carta PDF, con la cascada «precio de lista → descuento → total». Permiso propio repartido a 12 roles. Se descubrió que el descuento no está donde lo leía el módulo hermano (ahí habría salido «$0.00» en todos los tickets) y se tomó del renglón. Los tickets de antes del 13-ago-2026 muestran «sin dato» en vez de inventar un cero. Como el mismo folio se repite en varias cajas, la búsqueda ofrece candidatos y abre sola sólo si hay uno.
- **Optimización:** abrir el detalle de un ticket bajó de 8.8 ms a 0.75 ms (PR #117, medido sobre el mismo folio).
- **Estado:** ✅ integrado (PR #117)

#### El folio tecleado sin guion no encontraba nada
- **En qué se trabajó:** al escribir el folio sin guion (la forma normal de teclearlo) la pantalla decía «ningún documento con ese folio» y culpaba al usuario; por dentro armaba un folio que no existía.
- **Solución:** la búsqueda acepta el folio con o sin guion, sin ceros a la izquierda, en minúsculas o con espacios de un copiar-pegar. Si no reconoce el texto lo busca tal cual en vez de inventar otro. El mensaje de vacío ya no acusa al usuario.
- **Optimización:** (sin medición) de tiempo; la búsqueda pasa a usar el camino indexado. Probado con 11 casos, incluido el que falló.
- **Estado:** ✅ integrado (PR #119)

#### Desglose de IVA, IEPS y descuento por producto
- **En qué se trabajó:** el área usuaria pidió que el papel diga, por producto, cuánto es IVA, cuánto IEPS y cuánto descuento.
- **Solución:** el desglose sale en la carta, en el ticket y en la pantalla. Se reparte primero el descuento del documento y luego se separa el impuesto, igual que lo calcula el ERP. El sistema compara su resultado contra el total del documento y, si no cuadra, no imprime el desglose (mejor no mostrarlo que mostrarlo mal).
- **Optimización:** el desglose cuadra con el ERP en el 100% de los documentos de los tres canales; sin el reparto del descuento, en telemarketing habría cuadrado sólo en el 1.93% (PR #122, medido contra producción en sólo lectura).
- **Estado:** ✅ integrado (PR #122)

#### Ticket a 80 mm, botón de PDF y vista previa de facturas
- **En qué se trabajó:** el ticket no cabía bien en el rollo de 80 mm, el botón de PDF casi nunca abría (el navegador lo bloqueaba y el aviso culpaba al usuario) y la vista previa de facturas era lenta.
- **Solución:** nueva maqueta del rollo (cada producto en tres renglones, sin cortar montos), el PDF abre la pestaña en el mismo clic y, si hay bloqueo, se descarga. Se quitó del papel la leyenda legal (el aviso queda en pantalla para el operador). Se corrigió la consulta de las partidas de factura sin cambiar el resultado.
- **Optimización:** vista previa de facturas de 338 ms a 1 ms, de 1,898 ms a 238 ms y de 3,214 ms a 1,147 ms en documentos de prueba; un caso no mejoró (2,635 → 2,924 ms) y se declaró (PR #134).
- **Estado:** ✅ integrado (PR #134)

#### Los tickets de un cliente tardaban 18 segundos
- **En qué se trabajó:** pedir los tickets de un cliente en un mes tardaba casi 18 s; cualquier consulta que no fuera por folio pagaba ese tiempo.
- **Solución:** se quitó trabajo inútil de la consulta (no faltaba un índice, sobraba peso), con un candado que verifica contra los datos reales que el resultado no cambia.
- **Optimización:** de 17,876 ms a 50 ms para las mismas 16 filas, 357 veces más rápido (PR #139, medido contra producción en sólo lectura).
- **Estado:** ✅ integrado (PR #139)

### Plataforma y calidad

#### El tracker reescrito entero en cada edición (git)
- **En qué se trabajó:** el tracker era el único documento del repo con saltos de línea al estilo Windows. Cualquier herramienta que lo editara lo reescribía entero, así que los cambios eran imposibles de revisar y chocaban con las demás sesiones que lo tocaban.
- **Solución:** una regla del repo fija el mismo formato para todos los `.md`, y el tracker quedó alineado una sola vez.
- **Optimización:** 252 de los 253 `.md` ya cumplían el formato y el tracker era la excepción. El ruido que se elimina llegó a un diff de 2,998 líneas que solo tenía 38 líneas reales (cuerpo del PR #113).
- **Estado:** ✅ integrado (PR #113)

---

## Semana 3 · 8 al 14 de septiembre

### Arqueo de caja

#### Captura rápida con teclado y en teléfono
- **En qué se trabajó:** para bajar de $1,000 a Tarjeta había que dar 11 teclazos, y al final había que soltar el dinero para buscar el botón con el mouse. En el teléfono la hoja de conteo quedaba cortada.
- **Solución:** las flechas se mueven en las 4 direcciones por toda la hoja y terminan en el botón de guardar. Antes de sellar aparece un resumen para confirmar. El total del turno es uno solo (efectivo + medios). La pantalla funciona en el teléfono y tiene botones del tamaño del dedo.
- **Optimización:** de 11 teclazos a moverse por columna (PR #73). En el teléfono se recuperaron unos 100 px de la hoja que no se podían alcanzar y se corrigieron 29 botones demasiado chicos (PR #75).
- **Estado:** ✅ integrado (PR #71, #73, #75)

#### Sin cronómetro, la cajera ve solo su día, y un ticket más legible
- **En qué se trabajó:** el arqueo tenía un plazo de 45 minutos después del cierre, pero para entonces el efectivo de los retiros ya había salido del cajón. La letra del ticket era chica.
- **Solución:** se quitó el plazo y se puede contar con la caja abierta. La cajera ve sus cortes del día, no todo su historial. La letra del ticket subió de 11 a 14 px sin cambiar el ancho. De paso, el ticket del retiro ya dice "RETIRO" (antes salía como "ARQUEO").
- **Optimización:** contar solo al cierre verificaba unos $9,000 de cada $27,000 cobrados; contar con la caja abierta cubre el resto (PR #82). El ticket pasó de usar el 78 % al 99 % del ancho del papel (PR #89).
- **Estado:** ✅ integrado (PR #81, #82, #89, #90)

### Gastos

#### Captura de gasto por link desde el celular
- **En qué se trabajó:** el trabajador gasta antes de que la solicitud exista en Kepler; la foto del ticket se quedaba en su celular porque el sistema exigía el folio primero.
- **Solución:** link personal, reutilizable y revocable, que se abre sin cuenta desde el celular; el folio de Kepler se liga después. Lo que entra por link siempre lo revisa una persona.
- **Optimización:** la evidencia se captura en el momento del gasto y no se pierde (sin medición).
- **Estado:** ✅ integrado directo a `main` (commit del 14-sep, sin PR)

### Almacén — Andén de entrada

#### Reclamo automático por faltantes y ajustes del Andén
- **En qué se trabajó:** si un camión llegaba incompleto, el faltante no quedaba registrado ni tenía un responsable de reclamarlo. Además, la pantalla prometía una calificación de proveedor que no existía.
- **Solución:** al cerrar el vale, cada faltante levanta un reclamo con responsable. Hay una bandeja nueva en `/compras/reclamos`. El indicador de entregas completas de cada proveedor ahora también cuenta lo que se registró en el Andén, no sólo las órdenes de compra. Se integraron también ajustes del Andén (búsqueda sin acentos y el cursor que regresa solo a la caja de escaneo).
- **Optimización:** prueba contra los servicios reales: 74 de 74 casos correctos (PR #81). El beneficio para el negocio no se midió (sin medición).
- **Estado:** ✅ integrado (PR #69, #81)

#### Caducidades de tienda: alta por producto con expediente y folio
- **En qué se trabajó:** en sucursal, la caducidad se daba de alta por «hoja», un concepto que el colaborador no maneja. Si nadie cerraba la hoja, el dato nunca llegaba al inventario. Además, el botón de guardar no se activaba al elegir la sucursal, la fecha había que teclearla con diagonales y el asistente de voz ocupaba lugar sin funcionar.
- **Solución:** se registra producto por producto: se escanea, se teclea fecha y cantidad, y se guarda ya cerrado. Cada alta lleva un folio por sucursal y queda en un expediente con hoja imprimible y espacio para firmas. La sucursal sale de la ficha del usuario. La diagonal de la fecha la pone el campo. Las pantallas se adaptaron al teléfono. Se quitó el micrófono, porque el asistente nunca llegó a funcionar.
- **Optimización:** de 8 frases de prueba, el buscador del asistente no encontraba nada en 4; ahora da referencias útiles en las 8 (PR #81), aunque el asistente quedó apagado. Pruebas de captura: 64 de 64 correctas (commit `1203348ac`). El beneficio para el usuario no se midió (sin medición).
- **Estado:** ✅ integrado (PR #69, #72, #75, #81). ⛔ Los PR #70, #74, #79 y #80 se cerraron sin integrar porque los reemplazaron #69, #75 y #81.

### Logística — Embarques

#### Guía de Cobranza imprimible y expedientes por vendedor (GT.12–GT.16)
- **En qué se trabajó:** la guía de cobranza se armaba fuera de la Suite. Al imprimir salía la pantalla en lugar del documento. Cualquier usuario veía las facturas de todas las sucursales.
- **Solución:** se palomean facturas en Facturación TM y sale la guía impresa (una guía = un vendedor). Queda archivada con folio propio en «Expedientes», con reimpresión. Cada quien ve sólo las facturas de su sucursal. La tabla se ordena por fecha, importe o saldo.
- **Optimización:** la reimpresión sale idéntica byte por byte al papel firmado (cuerpo del PR #92/#93). El ahorro de tiempo frente al proceso anterior es (sin medición).
- **Estado:** ✅ integrado (PR #92 y #93). Nota: estos dos PR salieron de la segunda cuenta de GitHub de David (`dev-david24`), no de `IngeDavid2209`.

### Plataforma y calidad

#### Despliegues bloqueados y un entorno de desarrollo que no arrancaba desde cero (main, SETUP, OBS)
- **En qué se trabajó:** (1) el API no compilaba en `main` porque importaba un módulo que nunca se subió al repo. Con eso, **ningún despliegue podía pasar del build**: producción siguió sirviendo la versión anterior, y todo PR salía rojo sin tener la culpa. (2) En una máquina limpia, el entorno de desarrollo no arrancaba, por tres defectos de configuración y una migración. (3) En Windows, las pruebas que corrían desde una copia de trabajo enlazada en realidad probaban otra carpeta y reportaban verde.
- **Solución:** se quitó la referencia al módulo inexistente. Se arreglaron el entorno Docker y la migración para que el entorno arranque desde cero. La trampa del enlace quedó documentada, junto con cómo detectarla.
- **Optimización:** desde cero quedaron aplicadas 435 de 480 migraciones y 7 de 7 semillas, y el API arranca (commit de SETUP del 25-ago). En la copia enlazada, Nx reportaba 2 suites y 30 pruebas cuando eran 4 y 60, y 5/56 cuando eran 15/184 (commit OBS). Sobre el tiempo de despliegues bloqueados: (sin medición).
- **Estado:** ✅ integrado (el arreglo del build entró en el PR #69; SETUP y OBS en el PR #81, cuenta `dev-david24`)

#### El micrófono estaba prohibido en producción (A.0bis.19b)
- **En qué se trabajó:** la voz (por ejemplo, en caducidades) nunca funcionó en producción. Una cabecera de seguridad del servidor web bloqueaba el micrófono para todo el sitio, y como en local esa cabecera no se manda, se probó y se aprobó tres veces sin que nadie lo notara.
- **Solución:** la cabecera ahora permite el micrófono en el propio sitio, en los dos lugares donde el servidor la declara.
- **Optimización:** (sin medición). La función de voz pasó de no funcionar a poder usarse.
- **Estado:** ✅ integrado (PR #76, cuenta `dev-david24`)

#### Etiquetera caída por una migración faltante en producción (NORM.3)
- **En qué se trabajó:** de cuatro migraciones de precios de etiqueta, en producción se aplicaron solo tres y el código se desplegó igual. La etiquetera daba error, el verificador de precios perdió el gramaje y el mayoreo, y el carril de precios dejó de escribir.
- **Solución:** se aplicó la migración faltante, sola, después de verificar contra producción tres condiciones previas, y se recalcularon los precios.
- **Optimización:** la falla duró unas 2 h 20 min antes de corregirse (commit del 12-sep). La tabla quedó en una fila de precio por producto en cada una de las 8 plazas.
- **Estado:** ✅ operación aplicada en producción. Solo cambió el tracker, y ese commit quedó en una rama de respaldo, no en `main`.

#### La app web no compilaba: un commit ajeno borró la página de inicio (ID.33)
- **En qué se trabajó:** desde el 10-sep fallaba todo despliegue de `main`, porque un commit ajeno borró como daño colateral la página de inicio de la app web.
- **Solución:** se propuso restaurar los 3 archivos tal como estaban.
- **Optimización:** (sin medición).
- **Estado:** ⛔ descartado (PR #84, cuenta `dev-david24`). Se cerró sin integrar y el PR no registra el motivo.

#### Otros: Logística › Flotilla (FC.0–FC.5)
- **En qué se trabajó:** una revisión de Logística encontró 7 defectos que publicaban números falsos. Entre ellos: el rendimiento km/L leía solo una de tres fuentes de litros, el costo no se recalculaba al corregir los km, una unidad se podía asignar a dos embarques a la vez y el «top por margen» se cortaba antes de ordenar. Además, el formato de asignación vehicular se llenaba en papel.
- **Solución:** se corrigieron los 7 defectos, cada uno con su prueba. Se digitalizaron el derecho de uso de cada unidad y el acta de asignación (unas 50 piezas calificadas Malo/Regular/Bueno), y Flotilla quedó como la única puerta: derechos, actas y combustible en pestañas propias. También se puede dar de alta a un colaborador sin salir de la captura.
- **Optimización:** (sin medición) en tiempo. Los litros sin unidad asignada ya no se omiten: se declaran (34,443 L, según el commit FC.0).
- **Estado:** ✅ integrado (PR #81, cuenta `dev-david24`)

#### Otros: el catálogo de mostrador lee del ODS, no de una copia (CV.22)
- **En qué se trabajó:** el catálogo y los precios del verificador de mostrador se leían de una base copia, en contra de la regla principal del proyecto.
- **Solución:** se movieron 54 referencias de la copia al ODS. La frescura se lee del mismo indicador que usa Salud BD, y los esquemas propios pasaron a migraciones.
- **Optimización:** (sin medición). Se retira una copia de datos que había que mantener.
- **Estado:** ✅ integrado (en el PR #62, de otro autor)

---

## Semana 2 · 1 al 7 de septiembre

### Arqueo de caja

#### El corte de Kepler llega solo, y el arqueo se pide a tiempo
- **En qué se trabajó:** había cortes de Kepler que nunca llegaban a la Suite porque dependían de correr un proceso a mano. Casi ningún corte tenía conteo físico porque nada se lo pedía a la cajera. Además, a la cajera se le pedían cortes viejos que ya no se podían contar.
- **Solución:** los cortes se traen solos cada 10 minutos y también al abrir la pantalla. Se agregó un tablero de cumplimiento. Aparece un aviso fijo "haz tu arqueo" (también como notificación del navegador) cuando Kepler cierra la caja o pide un retiro. A la cajera solo se le piden los cortes de hoy. Los textos pasaron a español de México.
- **Optimización:** faltaban 20 cortes de 515 (todos de una sucursal, más de $300 mil declarados) y ahora se traen solos (PR #57). Se hizo visible que 76 de 78 cortes cerrados no tenían conteo físico (PR #57). Entre el 63 % y el 81 % del efectivo sale en retiros durante el turno, y ese dinero ahora también se pide contar (PR #61).
- **Estado:** ✅ integrado (PR #57, #58, #61)

#### El arqueo cubre todo el corte y el ticket lo explica
- **En qué se trabajó:** solo se contaba el efectivo. Tarjeta, transferencia, retiros, créditos y cheques pasaban por la caja sin compararse contra nada. El ticket no traía el motivo ni las notas, y para validar había que ir a otra pantalla.
- **Solución:** sección "Otros medios del turno". Tarjeta, transferencia y retiros se comparan contra Kepler. Créditos y cheques se guardan como "sin con qué comparar", nunca como cero. El ticket imprime el turno, el motivo, las notas, las firmas con hora y el folio, y sale solo al guardar. Cada fila del historial se abre a su desglose por billete y a los cortes de esa persona. El arqueo quedó como una sola entrada del menú, con pestañas, y la captura toma la forma de la hoja de piso (billetes | monedas | medios).
- **Optimización:** se pasa de comparar 1 de los 6 renglones del corte a comparar 3 contra Kepler y guardar los otros 2. En la prueba se detectó una diferencia de $50 en transferencia (PR #64). La impresión ya no la bloquea el navegador (sin medición).
- **Estado:** ✅ integrado (PR #59, #64, #65, #66, #67)

### Almacén — Andén de entrada

#### Andén de Entrada: una sola pantalla junto al camión
- **En qué se trabajó:** recibir un vale obligaba a pasar por cuatro pantallas y a dar muchos toques. Mientras el chofer esperaba, fechar y acomodar competían con la siguiente tarima.
- **Solución:** pantalla nueva `/almacen/anden`, que separa dos momentos: primero contar y dar acceso al camión, y después, con calma, fechar y acomodar. Se cuenta por cajas y piezas sueltas, con un botón de «Llegó todo». La caducidad se teclea con 4 dígitos (`0327` = 31/03/2027) y el rack sugerido aparece ya puesto. Después se dividió en 3 secciones (Llegada · Caducidad · Ubicación), con una sola caja de escaneo cada una para que la pistola no se confunda.
- **Optimización:** un vale de 5 renglones pasa de 79 toques a 24 (PR #51, conteo de toques del flujo).
- **Estado:** ✅ integrado (PR #50, #51, #52)

#### Arreglos de campo en el Andén
- **En qué se trabajó:** en producción salieron cuatro fallas. Había un segundo campo de escaneo que competía con el principal. Los indicadores de «listo» nunca se veían en verde. Fechar con foto fallaba («request entity too large»). Y ningún rol operativo, ni el supervisor, veía el Andén.
- **Solución:** se quitó el campo duplicado y se corrigieron los colores. La foto se reduce en el teléfono antes de enviarla. Se dio acceso al Andén al supervisor. Además, el Andén ahora distingue si la mercancía viene de un proveedor o de un traspaso entre sucursales, y deja fechar productos que no vienen en el vale.
- **Optimización:** según el PR, la foto pasa de 3–8 MB a unos 200–400 KB (PR #54). Los traspasos internos que ahora se distinguen suman 1,176 entradas, unos $38.4 M (PR #56). Las mejoras de los arreglos visuales y de acceso no se midieron (sin medición).
- **Estado:** ✅ integrado (PR #53, #54, #55, #56)

---

## Semana 1 · 25 al 31 de agosto

### Arqueo de caja

#### Arqueo ciego atado al turno de Kepler
- **En qué se trabajó:** la cajera veía la diferencia al guardar, así que podía recapturar hasta que "cuadrara". El monitor de cajas escondía las cajas abiertas de días anteriores.
- **Solución:** el conteo es ciego de verdad (solo el supervisor ve esperado y diferencia). El turno lo dice Kepler: sin turno no había arqueo, y la caja, la fecha y la cajera no se pueden cambiar. La encargada firma la validación, y si se recaptura el conteo la firma se borra. Se agregó un historial por cajera y la cajera solo ve sus sucursales.
- **Optimización:** se cierra el mecanismo detrás del 74.5 % de cortes "exactos al centavo" y se elimina el ~4.5 % de días-caja que no se podían comparar porque eran ambiguos (PR #42). El monitor tenía 14 cajas abiertas y marcaba 0; ahora las muestra (PR #42).
- **Estado:** ✅ integrado (PR #39, PR #42)

### Almacén — Andén de entrada

#### El vale se llena solo con el folio del papel
- **En qué se trabajó:** para recibir un camión, el operador tecleaba la sucursal y parte del folio, y luego elegía el almacén a mano. Además, nada impedía recibir el mismo folio dos veces, y eso podía dar de alta el doble de inventario. El revisor de caducidad marcaba error en todas las capturas.
- **Solución:** basta teclear el folio del papel y el sistema trae el vale de Kepler con proveedor, orden de compra, monto y unidad tal como dice el papel. El almacén sale solo. Si el folio ya se recibió, avisa en qué vale fue. Un producto se puede repartir en varios lotes, cada uno con su caducidad. Se corrigió el error que tumbaba el revisor de caducidad.
- **Optimización:** en pruebas se abrieron 7 vales distintos sobre el mismo folio sin ningún aviso; ahora el segundo se rechaza (PR #27). La búsqueda deja fuera 1,308 vales duplicados que trae el ERP (PR #22). Antes el revisor de caducidad fallaba en el 100% de las capturas; ahora funciona (PR #9).
- **Estado:** ✅ integrado (PR #9, #22, #27, #39)

#### Control de Caducidades: el semáforo y la foto de evidencia vuelven a funcionar
- **En qué se trabajó:** en la hoja de caducidades, cada renglón mostraba «NaN d» en lugar de los días que faltan. Las cantidades salían con decimales de relleno («5.000 pz») y la foto de evidencia aparecía rota o vacía.
- **Solución:** se corrigió la lectura de la fecha y el semáforo vuelve a pintar vencido, por vencer y vigente. Las cantidades se muestran limpias. La foto ya tiene vista previa al capturarla y en el renglón guardado. Si no se puede mostrar, la pantalla dice «Foto adjunta (sin vista previa)» en lugar de dejar un hueco. La tarjeta dice «Vence».
- **Optimización:** el semáforo no funcionaba en ningún renglón (todo salía gris, aunque estuviera vencido); ahora sí funciona (PR #12). La foto sí se guardaba; lo que fallaba era sólo mostrarla (PR #16).
- **Estado:** ✅ integrado (PR #12, #16)

#### El menú del Almacén pasa de 19 opciones a 5
- **En qué se trabajó:** el menú lateral del Almacén tenía 19 opciones sueltas. Además, cada pantalla dibujaba su propia barra de pestañas encima, así que se veían dos menús que no coincidían. Algunas pestañas daban error de acceso y otras se escondían a quien sí tenía permiso.
- **Solución:** quedan 5 áreas (Entrada, Inventario, Conteo, Control, Movimientos) y cada una tiene sus pestañas. Se quitó la barra repetida de 12 pantallas.
- **Optimización:** menú lateral de 19 opciones a 5 (PR #48).
- **Estado:** ✅ integrado (PR #48)

---

## Proyectos: de qué se trata cada uno

**Arqueo de caja.** Pantalla de Tienda donde la cajera cuenta el efectivo de su caja "a ciegas" (sin ver cuánto debería haber), y el sistema lo compara solo contra el corte de Kepler. La encargada lo valida y se imprime un ticket. Cubre el cierre del día, los retiros (sangrías), el relevo de cajera, la entrega de efectivo de las rutas (RD/RV) y, desde esta semana, conteos de efectivo que no son de ninguna caja (Finanzas).

**Gastos.** Módulo de Finanzas para el ciclo del vale de gasto: Kepler genera la solicitud, la persona levanta el vale y sube su evidencia (foto, escaneo o cotización), Finanzas lo aprueba, y el expediente queda completo con la transferencia y un PDF. Lo usan quienes capturan gastos (cajeros, encargados, promotores), quienes autorizan (Tesorería/Finanzas) y Dirección para consultar el historial.

**Venta y preventa.** Herramientas para que la venta en ruta funcione sin papel: la app del vendedor (Mi ruta, Tomar pedido), el surtidor que arma esos pedidos en el almacén, y el supervisor que ve el avance de su equipo y les asigna rutas. Incluye también la búsqueda de productos del mostrador de tienda.

**Recursos Humanos (Mega Talento).** Mega Talento es la aplicación propia de RH (asistencia de 12 relojes checadores, horas extra, incidencias y cierre semanal para prenómina, reclutamiento con bot de WhatsApp). Se está trasladando a la Suite como el espacio «Recursos Humanos» / «Personal», para que RH, contabilidad y los jefes trabajen en un solo sistema y Mega Talento se apague. Calendario acordado en el plan: corte de asistencia, corte de reclutamiento + bot el 5-dic y apagado de Mega Talento el 18-dic.

**Almacén — Andén de entrada.** Es la pantalla con la que el personal de bodega recibe la mercancía que llega en camión (de proveedor o de otra sucursal). Ahí registra lo que llegó contra el vale de entrada de Kepler, le pone su fecha de caducidad y decide dónde se acomoda (rack o tarima). La usan los almacenistas y el supervisor de almacén, con el teléfono o la pistola lectora en la mano.

**Logística — Embarques.** Digitalizar el viaje de reparto: el embarque se toma de Kepler en lugar de recapturarse, la guía calcula sola comisión y viáticos, y el pago a choferes, ayudantes y cargadores se libera cuando el viaje se cierra y se paga por Gastos. Es para Logística (quien arma y cierra viajes), Finanzas (quien paga) y Dirección (quien autoriza tarifas). Incluye también la Guía de Cobranza que el vendedor lleva a cobrar.

**Compras — Catálogo y productos.** El catálogo de productos pasó de Ventas a Compras, porque quien lo mantiene es el comprador. Ahí se agregaron pantallas para encontrar errores del ERP (códigos de barras repetidos, precios distintos entre sucursales), imprimir la hoja de precios por proveedor, revisar costos, seguir los productos nuevos a 30/60/90 días, ver cómo se vende cada producto y consultar la existencia. Es para el equipo de Compras y su gerente.

**Tickets de venta.** Apartado «Tickets» dentro de Ventas (`/comercial/tickets`) para encontrar cualquier venta por su folio (mostrador, telemarketing, crédito o pedido) y reimprimirla en ticket de 80 mm o en hoja carta PDF, con el descuento y los impuestos desglosados. Lo usan cajeros, vendedores y oficina cuando un cliente pide la copia de su compra; incluye un reporte de todo lo que compró un cliente.

**Pagos a proveedor.** La pantalla Finanzas › Pagos a proveedor (comprobantes) dejó de pedir que una persona revise uno por uno cada comprobante. Ahora se sueltan varios PDFs a la vez, la IA los lee y los liga a su pago en Kepler, y los que coinciden en banco, fecha, monto y proveedor se validan solos. Todo se entregó en la semana 6, incluidos dos arreglos que salieron de las primeras pruebas en producción.

**Plataforma y calidad.** Trabajo que no es de una pantalla de negocio, sino de la salud del sistema: arreglos que tenían `main` o los despliegues bloqueados, compuertas de calidad que daban verde sin haber revisado nada, el sistema de pruebas contra una base de datos real, documentación del corte del 1-oct y la bitácora del equipo de desarrollo. Al final van, marcados, unos trabajos sueltos que no caen en ningún otro proyecto.

---

## Pendientes por proyecto

### Arqueo de caja

- ⚠️ **PR #470 (Sucursales y sus cajas), lo más urgente:** la migración `20261028093702_blind_counts_concepto_retiro` va **antes** del código, y el commit ya quedó dentro de la liberación del 30-oct. El listado y la vista leen esa columna, así que sin la migración la pantalla nueva falla. No hay registro en el repo de que se haya aplicado. La autoriza Edgar, una por una.
- **Avisar a la operación antes de que la pantalla lo muestre (PR #470):** los cierres que antes se guardaban sin turno ahora se comparan contra Kepler, y la vista saca a la luz retiros sin contar (una sucursal, el 26-oct: $379,230 en sangrías sin un solo retiro contado).
- **Decisión de negocio abierta con Kepler (PR #470):** si un pago a proveedor o la nómina no se registran como retiro en Kepler, esa caja saldrá «contado de más».
- **Cuentas compartidas de Kepler:** hay códigos de cajera usados por varias personas y usuarios con varios códigos. Hay que limpiarlos y decidir si el código es de la persona o de la caja. Es tarea de Edgar, aparte de este cambio.
- **Permiso por repartir:** dejar «Conteo de efectivo» sólo a tres personas se hace en Administración (permisos por persona), no en código; quedó fuera del PR #470.
- **Cambios de comportamiento que conviene anunciar (PR #470):** la pantalla abría en «Cierre de día» y ahora abre en «Retiro», y quien valida ya no tiene botón «Validar» en esa vista.
- **PR #447 (Conteo de efectivo):** hay que aplicar en producción las 2 migraciones (`20261022122545` y `20261022122546`) **antes** de desplegar, una por una, con autorización de Edgar. Sin la primera, el historial del arqueo falla. Después del reparto del permiso, las personas tienen que volver a entrar. No verifiqué si ya se aplicaron.
- **Decisión pendiente:** qué rol es "jefe de zona". Hoy no existe como rol y no recibió el permiso nuevo. La matriz de accesos tampoco se regeneró.
- **[ARQ-RUTA.2] bloqueado:** que las rutas de cada sucursal salgan solas de Kepler en lugar del catálogo armado a mano. Antes hay que medirlo en producción con el script incluido, que necesita acceso de solo lectura.
- **RD/RV no tiene diferencia:** no existe una fuente del efectivo esperado de una ruta, así que el conteo queda como "no medible". Depende también del PR #448 (sucursal de surtido de la ruta), que decide a qué tienda reporta el arqueo de la ruta.
- **Hallazgo de negocio sin revisar (PR #107):** unos $2.2 millones de faltante que Kepler da por cuadrado. Quedó visible, pero el PR dice que nadie lo había revisado. No sé si se revisó después.
- **Deudas declaradas en PR anteriores (no verifiqué si ya se cerraron):** el cuadre de Almacén no captura la moneda de $20 (PR #133), y un turno de solo tarjeta no se podía sellar (PR #71).
- **Validación visual en navegador** pendiente en casi todos los PR de S7 a S10 (#289, #309, #429, #438, #440, #447, #470).
- **Tracker desactualizado:** SM.47 sigue sin marcar y "🔨 Local", aunque ya está integrado. SM.36 a SM.46 dicen "🔨 Local" en lugar de ✅/🚀, ARQ-RUTA.1 está en 🧪, y SM.48 y SM.49 siguen en "🔨 Local 2026-10-28" aunque ya están en `main`. Hay que actualizar los estados (regla 19).
- **Limpieza de git:** quedan ramas del arqueo ya integradas (`feat/arqueo-confirmacion-desglose`, `feat/arqueo-rutas-kepler`, `fix/arqueo-rutas-sucursal`, y en remoto `feat/arqueo-conteo-sin-caja` y `feat/arqueo-ruta-sin-caja`), más 2 worktrees encima de las dos primeras. Hay que borrarlas; antes de quitar cada worktree, revisar su enlace a `node_modules`.

### Gastos

- ~~**PR #451 (horario):** avisar a los capturistas antes de desplegar…~~ ✅ resuelto (27-oct): el bloqueo se quitó por completo y el PR se cerró sin integrar. Hoy se puede dar de alta un gasto a cualquier hora.
- ~~**GX.86.1 sin subir:** el arreglo de «Adjuntar evidencia»…~~ ✅ resuelto (27-oct): al desaparecer el bloqueo desapareció el defecto; ese arreglo ya no aplica.
- **GX.86 (aviso de rondas), supuesto sin confirmar:** el letrero da por hecho que en esas horas de verdad se revisa y que el fin de semana no hay ronda. Si no es así, **la pantalla dice algo falso**. Lo tiene que confirmar **Finanzas**; se corrige cambiando sólo el contrato. Tampoco contempla días festivos. Sin validación visual.
- **GX.87 (evidencia adicional):** sin validación visual y **sin probar el endpoint contra base real** —el servidor se probó con base simulada—. Decisión de Finanzas pendiente: «Pedir que lo reabran» (GX.29) se pedía justo para agregar algo al vale; hay que decidir si la reapertura se queda sólo para corregir datos. Además, nadie recibe aviso cuando aparece evidencia nueva en un vale ya cerrado, y el tope de 5 archivos es **por envío**, no por vale.
- **GX.80:** falta el redespliegue de la app de pantallas y la validación visual de las seis pestañas.
- **Llegada a producción sin verificar:** ni el tracker ni el CHANGELOG marcan GX.86, GX.87 o GX.80 como desplegados. Confirmar con Edgar.
- **Migraciones a prod:** el tracker sigue marcando sin confirmar la aplicación de la de GX.82 (cierre de vales con cotización) y la de GX.71 (permiso del historial de todos, más re-login de esa persona). Confirmar en prod.
- **Despliegues y validación visual:** varios items siguen sin la casilla de desplegado o validado en el tracker (GX.72, GX.75, GX.76, GX.78, GX.79, GX.80, GX.81); verificar en prod con un vale real que el PDF baja las evidencias del almacenamiento.
- **Frescura de Kepler (GX.73):** medir antes y después y desplegar el carril que reenvía solicitudes abiertas; el mismo punto ciego afecta a otros documentos de Kepler.
- **Velocidad:** la consulta del Expediente tarda ~2.7 s en prod, arriba de la meta de 1 s (tracker GX.75.p).
- **Decisiones abiertas:** rediseño de «Mis gastos» propuesto en maqueta, sin decidir (GX.77.d); los vales provisionales que Kepler cierra quedan sin su factura y el cierre automático no avisa a quien levantó (GX.85.x); al aprobar sin cerrar no se guarda quién aprobó (GX.82.x); la pantalla no dice de dónde sale el importe (GX.69.u).
- **Bloqueado:** ligar automáticamente «quién levantó en Kepler» con un usuario de la Suite; ninguna caja de Kepler trae nuestros usuarios (GX.39.1).
- **Trabajo local sin PR:** script de sólo lectura que lista vales cuyo monto no coincide con Kepler (GX.69, ramas locales `fix/gx-vales-monto-kepler` y respaldo); no está en `main`.

### Venta y preventa

- **Migraciones en producción, una por una y antes de desplegar el código** (las autoriza Edgar):
  - PR #444: `20261021114018_seller_route_days`, `20261021164903_seller_route_days_fuera_de_ruta` y `20261022085457_vendor_targets`. Sin la primera, la bandeja del surtidor da error.
  - PR #448: `20261022131601_grant_sucursal_de_ruta_supervisor`, que da el permiso al supervisor de ventas.
  - PR #455 (**ya integrado el 28-oct**), en este orden: `20261023134416_pedido_agrupado_por_sucursal`, `20261023134417_surtido_de_ruta_por_sucursal` y `20261023134418_clave_kepler_por_sucursal`. Hoy sólo están en la base local.
  - PR #473 (**ya integrado el 30-oct**): `20261029125146_presale_picks_revision_caja`. Sin ella, la revisión en caja no funciona en producción.
  - Revisado el 30-oct: el tracker todavía no marca como aplicada ninguna de las de #444, #448, #455 ni #473. **Ya hay código en `main` esperando las cuatro últimas.**
- **Permisos:** avisar a Edgar que el permiso nuevo deja al supervisor cambiar a qué tienda reporta el arqueo de la ruta. Después de repartirlo, los supervisores tienen que volver a entrar y hay que regenerar la matriz de accesos.
- **Decisiones abiertas:**
  - **Cartera sin totales:** abrir Cartera sin totales choca con el estándar de pantallas; lo decide Edgar.
  - **Catorcena:** confirmar el día de arranque, hoy fijado en el sábado 17-oct.
  - **Cobro en caja:** confirmar cómo cobra caja en Kepler. Si lo captura como «pedido», el surtidor lo vería otra vez en Telemarketing.
  - **Pedidos de sucursal de Kepler:** confirmar que esos pedidos ya no se surten desde Surtir.
  - **Venta de otra sucursal (PR #455):** ✅ resuelto el 28-oct lo de «PR abierto»: ya está integrado. Siguen abiertos el visto bueno de Edgar a **ADR-105, ADR-106 y ADR-107** (los tres «propuestos»; el ADR-106 además lo debe ver el PM, porque **apaga el surtido de ruta junto** que se entregó en MCP.3.6) y la definición de **Finanzas** de cómo se pasa el dinero entre sucursales, porque una sola caja liquida lo cobrado en otra. El cliente recibe un ticket por sucursal. Si el cliente no existe en el Kepler de la otra sucursal, hay que darlo de alta ahí antes de ligar su clave.
  - **Revisión en caja (PR #473, ADR-110):** la Suite **no impide** cobrar sin revisar, porque el cobro vive en Kepler. Hay que acordar con la operación que primero se revisa y luego se cobra. El ADR-110 y el item MCP.10 no tienen tarjeta en el tablero del PM: el trabajo se abrió a pedido de una cajera.
  - **Promociones del vendedor:** siguen sin definirse.
- **Deuda de datos para Edgar (PR #455):** limpiar los **573 pares de productos duplicados** o llenar la tabla de alias, hoy con una sola fila.
- **Configuración y datos:**
  - Asignar sucursal al surtidor que no la tiene.
  - Declarar el tipo de cada ruta vecinal; si no, no le aparece al supervisor vecinal.
  - La venta se atribuye a la ruta, no a la persona.
- **Sin verificar en producción:**
  - El tiempo de apertura de Tomar pedido después de #415.
  - Las escrituras nuevas de #444 y #448 contra datos reales (regla 13).
  - El tiempo del tablero y de «No registrados» contra la meta de 1 s.
  - PR #455: el cotejo contra tickets de Kepler, la entrega con pago y la tira en un teléfono real (pantallas chicas). El catálogo del vendedor pasó de 84–119 ms a 426–685 ms y en una sucursal **4,420 productos (47 %) bajan al final en gris**: falta verlo en un teléfono real.
  - PR #473: la pantalla de revisión, con la cajera y en el equipo que usa.
- **Deuda declarada:**
  - La tabla vieja de rutas del vendedor sigue viva, como segunda fuente que se va a desincronizar de la agenda.
  - La vista de mayoreo sigue calculándose para toda la red.
  - PR #455: dos formateadores repetidos de «Parte de …» que hay que unificar en `libs/`.
  - Siguen contando cada parte del pedido agrupado como un pedido aparte: «Por entregar», «Carga resuelta», el reporte de pedidos por ruta y la analítica de dirección. Comisiones, metas y el cuadro de resultados **no** se afectan, porque salen de Kepler.
  - El tracker marca MCP.10 como 🔨 «falta PR» aunque ya está en `main`: quedó desactualizado al integrarse por commit directo.

### Recursos Humanos (Mega Talento)

- **Corte de asistencia (RH.1.8):** sin fecha; depende de que Edgar corra los pasos en el servidor (PR #403). El plan original lo tenía el 7-nov. Tras el corte, Mega Talento queda 2 semanas en sólo lectura para asistencia.
- **Migraciones por aplicar en prod, una por una:** toda la cadena de asistencia (incluida la de personas, que toma un candado exclusivo y va de noche), las de reclutamiento y bot, y la del PR #442 (antes de su merge). El pre-vuelo da el orden.
- **PRs abiertos:** #436 (mergear en el paso 7 del corte) y #442 (falta medir la paridad con datos reales y el tiempo de carga del reporte, meta < 1 s).
- **Decisiones abiertas:** aprobar ADR-084 (sigue «propuesta»); texto oficial del aviso de privacidad antes de publicar `/empleo`; texto de consentimiento para datos sensibles; confirmar con RH quién ajusta horas extra; congelar la lógica de Mega Talento hasta el corte (la propuesta ya se hizo dos veces porque siguió cambiando).
- **Preparación atrasada:** inventario de uso con RH (RH.0.5); desplegar el cierre de accesos abiertos en Mega Talento y su bot (RH.0.6, código listo, falta desplegar); medir desde el servidor que los 12 relojes responden.
- **El rol de RH en la Suite no tiene personas asignadas:** hasta que alguien de RH quede en ese rol, las pantallas sólo las abre un superadmin.
- **Después:** corte de reclutamiento + bot (5-dic, falta la carga única de candidatos y la plantilla aprobada de WhatsApp para escribir fuera de la ventana de 24 h) y apagado de Mega Talento con rotación de credenciales de la base compartida (18-dic).
- **CBW (WhatsApp de la empresa):** el trabajo de CBW.9–13 está en un commit local sin rama; conviene rescatarlo en una rama antes de que se pierda y decidir si sigue.

### Almacén — Andén de entrada

- **Migraciones del PR #321 en producción:** `20261006143917` y `20261007213847` deben aplicarse una por una, antes del despliegue. No se verificó si ya están aplicadas. Falta también probar en un equipo sin señal y avisar a Edgar de las dos reglas que cambiaron.
- **PR #341:** falta revisar la pantalla y medir cuánto tarda la consulta de Llegadas en producción. El tracker sigue diciendo «EN CÓDIGO» aunque el PR ya está integrado: hay que actualizarlo.
- **Bodega por secciones (WMS-UB):** está en pausa y no se encontró el trabajo en la máquina. Hay que confirmar con David si existe en otro lado o si se rehace. Coordinar con el módulo de Ubicaciones que hizo otro desarrollador (PR #317 y #324, 8-oct), porque se traslapa.
- **Uso real:** 26 de 38 vales abandonados y sólo 0.2% de la existencia con caducidad. El problema es de adopción; necesita acompañamiento en piso, no más código.
- **Detectados en el documento WMS, sin resolver:** hay dos formas distintas de crear la misma ubicación. Y el permiso «ALMACEN_UBICACIONES_ACOMODAR», repartido a 24 personas, no abre la función de acomodar.
- **Contar por cajas:** sólo el 3.1% de los productos tiene registrado cuántas piezas trae la caja (PR #51). Falta decidir si se captura a mano, se toma de Kepler o el Andén se queda en piezas.
- **Sucursal asignada a los bodegueros:** sólo 1 de 4 tiene sucursal asignada (PR #152). Es un dato que debe cargar administración.
- **Documento WMS:** subirlo con un PR (está sólo en local).

### Logística — Embarques

- ⚠️ **Dudoso, revisar ya:** la rama del CEDIS fija que la Suite paga desde el corte del **jueves 22-oct** (pago el 6-nov), pero sigue sin PR ni merge. Hoy, 23-oct, ese corte ya arrancó y la Suite no lo está cubriendo. Hay que decidir si se mueve la fecha o se integra ya. También faltan los permisos de captura para la persona del CEDIS.
- **Tarifas en producción:** quedan unas 32 rutas en $0 y los viáticos sin configurar (EMB.14, EMB.17). Mientras tanto, las guías de esas rutas no se completan. Lo captura Logística una vez.
- **Decisiones de negocio abiertas:** si la carga a camión de ruta paga comisión; los apoyos fijos de $1,000; el tratamiento fiscal (gasto o nómina) con Contabilidad; la foto de la remisión, hoy opcional.
- **Liquidaciones** (EMB.20, EMB.23): sólo paga viáticos con pernocta y sólo al chofer, y ninguna guía llega a «entregada». Queda resuelto por el pago por viaje (EMB.24–29), pero no se ha validado en producción.
- **Faltan de la beta** (EMB.18): carga de salida, descarga de regreso, maniobra LAB y comisión de repartidor.
- **Avisos y padrón** (EMB.30, EMB.31): avisos de parada con diferencia; ligar choferes con usuarios (0 de 56 ligados).
- **Choferes vacíos en Kepler** (EMB.16) en una sucursal: se corrige en Kepler.
- **Guía de Cobranza:** confirmar con cobranza el saldo de ≈3 % en facturas parciales (GT.17).
- **Seguimiento:** el tracker marca EMB.24–33 como 🧪 («sin prod»). No se verificó en este reporte si las migraciones de #368, #379 y #395 ya están aplicadas en producción.

### Compras — Catálogo y productos

- **Catálogo en dos vistas (PF.12), tres decisiones de Compras abiertas:**
  1. **«Editar producto» ya no existe en esa pantalla.** Era el único lugar que guardaba cambios del producto. Falta decidir dónde se edita ahora; reponerlo no obliga a tocar lo demás.
  2. **De qué sucursal es el precio de la lista.** Hoy siempre muestra el de la sucursal 01, sin selector. Falta decidir si debe ser la del usuario.
  3. **El bloque «Qué hacer» sólo se calcula con 200 resultados o menos.** Hacerlo para todo el catálogo pediría una foto nocturna y sería una tarjeta aparte, que decide el PM. Esa tarjeta no se ha abierto.
- **PF.12 sin validación visual ni modo oscuro** (el PR lo declara). Dos defectos conocidos: un error de red se muestra como texto técnico, y en pantalla angosta la tabla no se apila. Tampoco se verificó el arranque de la API, con un servicio nuevo de 5 dependencias inyectadas.
- **PF.12 no está anotado en la bitácora del PM** ni figura como desplegado: el tracker sigue en 🧪.
- **Trabajo local sin PR (PF.12.1 y PF.12.3):** dos continuaciones del catálogo sin subir —Productos como primera pestaña con las pantallas vacías fuera del menú, y la columna «Último costo» con aviso de precio bajo costo—. Todavía no tienen fila en el tracker.
- **Auditoría del catálogo (S8):** falta autorización para subirla y abrir el PR. Hay que aplicar su migración de índices fuera de horario y hacer la revisión visual.
- **Rama de rescate de Costos (S6):** decidir si se borra, porque su contenido se retomó en la auditoría.
- **Productos nuevos:** «venta por cada peso invertido» compara venta con impuesto contra compra sin impuesto. Sale 8–16 % arriba y afecta la recomendación; hay que decidirlo aparte. Quedan $230 sin explicar en una sucursal al cuadrar márgenes. El refresco de cada 30 minutos no avisa si se detiene.
- **Productos nuevos:** hay que contar físicamente los 50 productos con existencia «en duda» para corregir Kepler.
- **Productos (flujo de venta):** calibrar con Compras los umbrales (15/21 días para comprar, 60 para «sobra», 30 para «caduca pronto», el corte de líderes). Restar lo que viene en camino (órdenes por recibir) y considerar el plazo de entrega de cada proveedor. Hoy la caducidad sólo cubre los lotes que tienen fecha registrada.
- **Costos:** las cifras de la pestaña no se verificaron contra producción cuando se entregó (PR #253).
- **Hoja de precios:** no numera páginas; para eso hay que generar el PDF del lado del servidor.
- **Mejoras al catálogo de precios** (productos con existencia y precio en $0): en planeación, sin código.

### Tickets de venta

- **Llevar a producción:** el tracker sigue con los items en 🧪 (probado) y TK.5 «aplicar migraciones a prod + redeploy + re-login» abierto. Hay que confirmar con Edgar qué está desplegado y qué migraciones faltan.
- **Validación visual** de la pantalla y de los papeles impresos en impresora real (TK.4 abierto; varios PR lo declaran pendiente).
- **Sucursales con Wincaja (30 y 32):** sus folios todavía no aparecen en la búsqueda (TK.6, decidido como siguiente paso).
- **Tickets anteriores al 13-ago-2026:** no pueden mostrar descuento porque el ERP no guardaba el precio de lista; no hay fuente para reconstruirlo.
- **Reporte por cliente:** falta el PDF generado del lado del servidor, la versión de 80 mm y los selectores de marca y proveedor en pantalla.
- **Rendimiento:** la bandeja no se midió con volumen real en todas sus combinaciones; las facturas del reporte aún tardan ~1.3 s y una vista previa de factura no mejoró (~2.9 s).
- Sin trabajo de este proyecto en S7–S10.

### Pagos a proveedor

- Medir en producción cuántos comprobantes se validan solos. Si Kepler registra el pago en un día distinto al del SPEI, casi ninguno saldrá «listo» (tracker [PC.5]).
- Abrir la pantalla en producción con DevTools y leer los tiempos que ya reporta, para encontrar la causa real de los 5–6 s ([PC.8]).
- Volver a leer los comprobantes viejos de BanBajío, que se guardaron con la cuenta recortada ([PC.7]).
- ⚠️ La vista de pagos de Kepler sigue filtrando solo la sucursal `00` (ver Fase PO). Si no ve los pagos posteriores al 1-oct, la captura dirá «ningún pago con ese monto» en comprobantes legítimos.
- Por evaluar: un proceso automático para «Volver a comparar», que hoy es manual, y detectar en el servidor un PDF que ya se había subido antes.
- El tracker marca PC.3–PC.8 como 🧪 (probado) y no como ✅. Falta cerrar el estado.

---

### Plataforma y calidad

- ~~Integrar el PR #452 … Falta cerrar el #452, que quedó duplicado.~~ ✅ resuelto (26-oct): el #452 se cerró como duplicado; el arreglo ya estaba en `main` por el PR #453 del lead.
- ⚠️ **El paso «Servicio real del corte» del CI sigue sin `pipefail`**: lee el resultado del comando equivocado, así que **puede seguir declarando verde con pruebas rojas**, como lo hizo desde el 15-oct. El diagnóstico y el arreglo están en la rama del PR #459, sin integrar. **Es de Caja General: lo decide el dueño de esa área, no David.**
- **El defecto de zona horaria en la jornada del corte sigue en el código** (misma rama sin integrar). Hoy no afecta a nadie porque producción corre en hora de México; se nota en cualquier entorno en UTC. El PR #459 anotó además cuatro copias latentes del mismo defecto fuera de caja (`customer-360`, `autonomy`, `outcome-verifier` y la vista de capturas anuladas del punto de venta), sin verificar si se atendieron.
- **La vista de escalera de unidades de producto** arrastra el mismo defecto de expresión que ya se corrigió en otra función: **65 de los 119 SKU** con unidad base numérica salen como si no fueran por peso (PR #459). Al 30-oct no se encontró su arreglo en `main`.
- **Cinco ramas quedan vivas en GitHub sin integrar**, por si alguien las retoma (el job de caja honesto, los cinco rojos de `main`, las dos declaraciones de permiso y la migración en base vacía). Conviene decidir si se borran.
- **El trabajo de plataforma de esta semana no está en el tracker:** no existen items `CGP-D.1.2`, `CGP-D.1.3`, `CGP-D.1.4` ni `CGS.52.1`, y la bitácora del PM sólo deja constancia del PR #457.
- Fase PO: corregir las 4 vistas que siguen filtrando el `00` (PO.1–PO.4), con la primera en prioridad porque cuenta como vivo lo cancelado, y agregar la compuerta que evite que vuelva a pasar (PO.5). Antes, correr el diagnóstico contra producción. No hay commits de PO.1–PO.5 en `main`.
- Desarrolladores › Proyectos: los permisos no están repartidos a ningún rol (hoy solo los ve el modo god). Falta verificar en producción el equipo y la migración, y que el proxy acepte archivos de 200 MB.
- Documentación por módulo (rama `docs/modulos`) y regla PROC.4: pedir autorización para subirlas.
- El job de pruebas contra base real sigue siendo informativo, no bloquea. Además, siguen fuera las suites que necesitan el API levantado.
- La deuda de lint sigue declarada y sin pagar: 294 errores, de los cuales 16 son cruces entre módulos y merecen su propio PR (PR #150).
