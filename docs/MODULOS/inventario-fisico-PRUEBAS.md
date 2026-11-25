# Inventario físico — lista de verificación para probar con Playwright

> **Para quien ejecuta.** Cada renglón es una prueba: se provoca a propósito, se anota el resultado
> y se firma. ⛔ **Un renglón sin anotar no es «pasó»: es NO MEDIDO**, y así se reporta (ADR-056).
>
> Acompaña a [`inventario-fisico.md`](inventario-fisico.md), que explica **cómo funciona** el
> módulo. Este documento sólo dice **qué se rompe a propósito y qué tiene que pasar**.

**Estado del módulo al escribir esto (2026-11-25):** nunca se cerró un folio en producción
(6 folios, los 6 cancelados; 7 renglones contados de 18,845; 0 exportaciones a Kepler). O sea que
**todo lo de abajo se prueba por primera vez**: no hay un «antes» con el que comparar, y por eso
cada prueba anota lo que vio, no sólo si pasó.

---

## 0. ⛔⛔ Antes de escribir una línea: contra qué se prueba

Esto **no está decidido y hay que decidirlo primero**, porque cambia qué pruebas son posibles.

Hoy en el repo hay Playwright (`@playwright/test` instalado, suites en [`e2e/`](../../e2e/)) pero
**ninguna apunta a la aplicación corriendo**: todas abren un prototipo estático por `file://`.
No existe `baseURL`, ni `webServer`, ni ayudante de sesión. La razón está escrita en el config de
`e2e/caja-general`: levantar el front o el back en local está prohibido (regla 3), así que las
suites existentes prueban **el contrato**, no la pantalla real.

### D-PW1 · Dónde corren estas pruebas (decide el PM)

| Opción | Qué permite | Qué cuesta | Veredicto |
|---|---|---|---|
| **A · Contra producción** | todo, con datos reales | ⛔ exige credenciales reales (prohibido) y **cada folio abierto congela un almacén de verdad** | **No.** Ni siquiera para leer: la primera prueba de escritura deja basura en prod |
| **B · Carril de CI que levanta la pila** | **todo**, incluido el cierre y los tiempos | el carril [`boot-api.yml`](../../.github/workflows/boot-api.yml) ya arma Postgres desde cero, migra, siembra el tenant, compila y arranca la API — pero **arranca y se apaga**. Falta dejarla viva en el puerto, sembrar un acceso y servir el front | ⭐ **Recomendada.** Es la única que cumple la regla 13 (un endpoint que escribe no está probado hasta ejercerlo contra base real) |
| **C · Front servido + API simulada con `page.route`** | los errores **humanos y de diseño**, y los estados que hoy no existen (folio a medias, red caída, 500 del servidor) | no prueba nada del servidor; el front hay que servirlo | Buena **como complemento** de B, no como sustituto. Es lo que pide la skill de auditoría para simular estados raros |

⭐ **Recomendación:** armar **B** para los bloques marcados `[B]`, y usar **C** para los `[C]`.
Los marcados `[C]` se pueden empezar **hoy**; los `[B]` no existen hasta que el carril exista.

### Nivel de evidencia de cada renglón

- **`[C]`** se puede ver en el navegador con la API simulada → se puede hacer ya.
- **`[B]`** necesita servidor y base reales → espera a D-PW1.
- **`[M]`** se mide (un tiempo, un conteo), no se observa: el renglón anota **el número**.

---

## 1. Las seis personas, y por qué se prueba una por una

Medido en producción el 2026-11-25. **Probar con un admin no sirve**: los roles de plataforma pasan
por god-mode y un permiso que nadie repartió sale verde igual. Cada bloque se corre con un usuario
que tenga **exactamente** ese permiso y ninguno más.

| # | Persona | Permiso | Personas en prod | Qué hace |
|---|---|---|---:|---|
| 1 | **Supervisor** | `COMMERCIAL_INVENTORY_SUPERVISAR` | 21 | abre folios, ve el teórico, resuelve diferencias |
| 2 | **Encargado** | `COMMERCIAL_INVENTORY_ASIGNAR` | 38 | arma el equipo. **No** ve el teórico |
| 3 | **Contador** | `COMMERCIAL_INVENTORY_CONTAR` **o estar asignado** | 31 + asignados | cuenta a ciegas, con o sin red |
| 4 | **Reconciliador** | `COMMERCIAL_INVENTORY_RECONCILIAR` | 17 | cierra y exporta. **No** puede haber contado |
| 5 | **Observador** | `COMMERCIAL_INVENTORY_VER` | 54 | sólo mira |
| 6 | **Ajeno** | ninguno | el resto | **tiene que rebotar en todo** |

⚠️ **La persona 6 es la más importante y la que siempre se salta.** Una pantalla que funciona para
quien tiene permiso no prueba nada sobre quien no lo tiene.

⚠️ Y hay un reparto raro que conviene mirar al armar los usuarios: **`marketing` puede abrir y
congelar un almacén; `prevencion` no puede ni mirar el teórico.** No es un defecto de código —se
arregla en la matriz de accesos— pero si armas los usuarios copiando roles reales, te vas a topar
con eso.

---

## 2. Supervisor — abre el folio

### 2.1 Lo que debe poder

| ID | Prueba | Tiene que pasar | Niv |
|---|---|---|---|
| `SUP-01` | Abrir un folio **total** en una sucursal | Se crea, el aviso dice **cuántos SKUs** y que el alcance es «total del almacén» | B |
| `SUP-02` | Abrir un folio **cíclico** eligiendo clase ABC y tope de SKUs | El folio trae **sólo** esos SKUs, y el aviso dice «cíclico clase X» | B |
| `SUP-03` | Abrir cíclico en un almacén **sin clasificación ABC** | Avisa que no se puede acotar y **ofrece la salida** (recalcular ABC, o abrir total). **No** un error crudo | C |
| `SUP-04` | Entrar al detalle de un folio desde la fila y desde el botón | Los dos llegan al mismo lugar | C |

### 2.2 Errores humanos

| ID | Qué se hace mal a propósito | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `SUP-H1` | Elegir **una camioneta de ruta** creyendo que es la sucursal | ⚠️ Hoy el selector ofrece **28 almacenes y sólo 10 son contables**; 18 son camionetas y **5 rutas están duplicadas** con dos códigos. Anotar si se puede distinguir sin saberlo de memoria | 🟠 | C |
| `SUP-H2` | Abrir un **segundo folio** del mismo almacén y mismo ritmo | Rechazo claro (índice `..._one_open_per_wh_ritmo`), diciendo **cuál** folio lo ocupa | 🔴 | B |
| `SUP-H3` | Abrir un folio con SKUs que **ya están en otro folio vivo** | Rechazo nombrando el folio que los tiene. Un SKU en dos conteos = el segundo ajuste pisa al primero | 🔴 | B |
| `SUP-H4` | Dejar el **umbral de recuento en 0** sin saber qué hace | Anotar si la pantalla explica la consecuencia **antes** de abrir | 🟡 | C |
| `SUP-H5` | Abrir un cíclico **dejando «congelar» prendido** | La pantalla ya avisa que en cíclico normalmente va apagado. Verificar que el aviso se lea **antes** de apretar Abrir | 🟡 | C |
| `SUP-H6` | Abrir un folio y **no volver nunca** | A las 24 h la lista lo marca «Sin conteos»; a los 7 días en rojo. ⛔ Verificar que **el almacén siga congelado** y que alguien pueda destrabarlo | 🟠 | B |
| `SUP-H7` | Doble clic rápido en **Abrir** | Un solo folio. El botón se apaga en el primer clic | 🔴 | C |

### 2.3 Errores de causalidad

| ID | Qué se provoca | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `SUP-C1` | Cortar la red **justo al apretar Abrir** | Anotar si el folio se creó o no, y si la pantalla lo dice. **El peor resultado es «no se abrió» con el folio creado** | 🔴 | B |
| `SUP-C2` | El servidor responde **500** al abrir | Mensaje con causa y **Reintentar**; el formulario **no se vacía** | 🟠 | C |
| `SUP-C3` | El snapshot de un folio total (**4,819 SKUs en Padre Hidalgo**) | **Medir el tiempo.** Anotar el número. ¿Hay indicador de espera o parece colgado? | 🟠 | B·M |
| `SUP-C4` | Cerrar la pestaña mientras se abre el folio | Anotar si el folio quedó creado sin que nadie lo sepa | 🟠 | B |

### 2.4 Errores de diseño

| ID | Qué se mira | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `SUP-D1` | **Forzar un 500 en la carga de la lista** | ⛔ Hoy se pinta *«No hay folios. Abre uno para empezar a contar.»* — un fallo se lee como «no hay nada». Tiene que haber **estado de error con Reintentar**, distinto del vacío | 🔴 | C |
| `SUP-D2` | Mirar la lista con folios vivos **y** cancelados | Hoy van mezclados sin separar. Anotar si se distingue de un vistazo | 🟠 | C |
| `SUP-D3` | Buscar el folio de **una sucursal** entre muchos | Hoy **no hay filtro ni orden**, aunque el servidor acepta filtrar por almacén | 🟠 | C |
| `SUP-D4` | Preguntarse **de cuándo es lo que se ve** | Hoy no lo dice en ningún lado | 🟠 | C |
| `SUP-D5` | Pasar el mouse por el chip **«Congelado»** y después **quitarlo** | La explicación vive **sólo en el tooltip**: sin mouse no existe. Igual el detalle de cada alerta | 🟡 | C |
| `SUP-D6` | Leer la celda que dice **«Sin snapshot»** | Es jerga nuestra publicada como dato. Anotar si se entiende sin preguntar | 🟡 | C |

---

## 3. Encargado — arma el equipo

### 3.1 Lo que debe poder

| ID | Prueba | Tiene que pasar | Niv |
|---|---|---|---|
| `ASG-01` | Abrir el diálogo «Quién cuenta» desde la fila | Llega **con lo ya asignado cargado**, no en blanco | C |
| `ASG-02` | Elegir contadores de **su** sucursal y de otra | Los de la sucursal del folio salen **agrupados arriba**, y nadie queda escondido | C |
| `ASG-03` | Buscar por nombre, por puesto y por sucursal | Los tres filtran | C |

### 3.2 Errores humanos

| ID | Qué se hace mal a propósito | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `ASG-H1` | Elegir 20 personas y **hacer clic fuera del diálogo** | ⛔ Hoy se pierde todo, sin preguntar. Tiene que preguntar «¿Descartar cambios sin guardar?» | 🔴 | C |
| `ASG-H2` | Lo mismo con **Esc** | Igual que arriba | 🔴 | C |
| `ASG-H3` | Elegir entre **dos personas con el mismo nombre** (hay repetidos entre 263) | La etiqueta trae nombre, puesto y sucursal: alcanza para decidir | 🟠 | B |
| `ASG-H4` | Asignar a alguien **ya comprometido en otro folio vivo** | La etiqueta lo dice («ya en INV-…»). Verificar que se vea **antes** de elegir, no después | 🟠 | B |
| `ASG-H5` | Guardar **sin contadores** (lista vacía) | Anotar qué pasa: ¿borra el equipo existente? `setAssignments` **reemplaza** | 🔴 | B |
| `ASG-H6` | Intentar entrar al **detalle** del folio | 403 o, mejor, **no ver el botón**. El detalle trae el teórico y no es suyo | 🔴 | B |
| `ASG-H7` | Intentar asignar en un folio **cancelado** | Rechazo claro (409). El botón no debería estar | 🟠 | C |

### 3.3 Errores de causalidad

| ID | Qué se provoca | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `ASG-C1` | **No se puede leer** lo ya asignado (500 en el GET) | El diálogo **se cierra** con aviso, en vez de dejar un Guardar que borraría al equipo. *(Ya resuelto en código — verificar que de verdad ocurra)* | 🔴 | C |
| `ASG-C2` | ⭐ **Falla la segunda de las dos llamadas** (contadores sí, supervisores no) | ⛔ Hoy las dos van en paralelo y **no son atómicas**: si la segunda falla, los contadores **ya se guardaron** y el aviso dice «No se guardó». Un lote parcial reportado como falla total | 🔴 | C |
| `ASG-C3` | Cortar la red al guardar | Mensaje accionable; lo elegido **sigue en pantalla** para reintentar | 🟠 | C |
| `ASG-C4` | Doble clic en **Guardar** | Una sola escritura | 🟠 | C |

---

## 4. Contador — el bloque más largo, y el que más se rompe

> Esta persona trabaja **de pie, con el teléfono, en un pasillo sin señal**. Las pruebas de este
> bloque **no son opcionales**: son el módulo.

### 4.1 Lo que debe poder

| ID | Prueba | Tiene que pasar | Niv |
|---|---|---|---|
| `CNT-01` | Escanear un código y capturar cantidad | Se confirma **qué producto** se contó (no es dato ciego: el nombre y el SKU sí se muestran) | B |
| `CNT-02` | Ver su avance | Cuántos lleva de cuántos | C |
| `CNT-03` | Iniciar y terminar su jornada (sesión) | Queda registrada | B |
| `CNT-04` | Registrar una **interrupción** | Queda registrada con su motivo | B |

### 4.2 ⛔ El conteo ciego — el control central del módulo

| ID | Qué se intenta | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `CNT-B1` | Buscar el teórico **en cualquier parte** de la pantalla del contador | **Nunca** aparece: ni en la respuesta del servidor, ni en el HTML, ni en una variable | 🔴 | B |
| `CNT-B2` | Pedir `/counts/:id/items` **con el usuario contador** | 403. Ese endpoint es del supervisor | 🔴 | B |
| `CNT-B3` | Mirar la **respuesta de red** al capturar | No trae `expected_qty` ni la varianza | 🔴 | B |

### 4.3 Errores humanos

| ID | Qué se hace mal a propósito | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `CNT-H1` | Escanear **el mismo SKU dos veces** | Anotar si **suma** o **reemplaza**, y si la pantalla lo deja claro. Las dos son defendibles; **lo que no se vale es que no se sepa cuál** | 🔴 | B |
| `CNT-H2` | Teclear **100 donde iban 10** (dedo gordo) | Anotar si hay alguna barrera para una cantidad absurda contra el orden de magnitud esperado | 🟠 | B |
| `CNT-H3` | Contar **cajas creyendo piezas** | ⚠️ El folio estampa la unidad al abrir (`unit_factor`, `unit_source`), y **puede venir vacía**. Anotar qué unidad muestra la pantalla al capturar, y qué pasa si no hay factor | 🔴 | B |
| `CNT-H4` | Escanear un código **que no está en el folio** | Mensaje claro; no se inventa un renglón | 🟠 | B |
| `CNT-H5` | Escanear un código **que no existe en el catálogo** | Mensaje distinto del anterior | 🟠 | B |
| `CNT-H6` | Intentar el **tercer conteo del mismo SKU siendo el mismo contador** | 409 por segregación: el desempate no lo hace quien ya opinó dos veces | 🔴 | B |
| `CNT-H7` | Dos contadores capturan **el mismo SKU a la vez** | Cada uno cae en su ranura; nadie pisa al otro | 🔴 | B |
| `CNT-H8` | Capturar **0** (el anaquel está vacío) | Se distingue de «no contado». ⛔ Un no-contado jamás puede valer cero | 🔴 | B |

### 4.4 Errores de causalidad — luz, red, aparato

| ID | Qué se provoca | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `CNT-C1` | **Cortar la red** (`context.setOffline(true)`) y seguir contando 20 SKUs | Se captura igual; el banner dice «sin conexión» y **cuántos van pendientes** | 🔴 | C |
| `CNT-C2` | Volver la red | La cola se sube sola; el pendiente baja a 0 | 🔴 | C |
| `CNT-C3` | Volver la red y **reenviar dos veces** | El servidor responde `duplicate` y **no cuenta doble** (cada escaneo lleva su UUID) | 🔴 | B |
| `CNT-C4` | **Recargar la página** con 20 escaneos pendientes | Siguen ahí. La cola vive en el navegador, no en memoria | 🔴 | C |
| `CNT-C5` | **Cerrar el navegador** y volver horas después | Igual que arriba | 🔴 | C |
| `CNT-C6` | Contar **toda la jornada sin red** (200+ escaneos) | Anotar si hay tope, si avisa, y **cuánto tarda** al subir todo junto | 🟠 | C·M |
| `CNT-C7` | ⛔ **Cambiar de aparato** a media jornada | La cola **se quedó en el otro teléfono**. Anotar qué ve el contador en el nuevo: ¿su avance real, o cero? | 🔴 | B |
| `CNT-C8` | ⛔⛔ **Perder el aparato** con escaneos sin subir | **Hoy el servidor nunca supo que existían**: no aparecen como faltantes en ningún lado. Anotar si hay **alguna** forma de preguntar «¿cuántos escaneos hay sin subir y en qué aparatos?» | 🔴 | B |
| `CNT-C9` | **Cerrar el folio** mientras hay cola pendiente | Los pendientes se marcan **descartados con su motivo** y el contador los **ve listados**. No se reintentan en vano | 🔴 | B |
| `CNT-C10` | El servidor responde **500** al subir un escaneo | Se reintenta después; no se descarta | 🟠 | C |
| `CNT-C11` | **Caduca la sesión** (12 h) a media captura | Lo capturado sigue en la cola local; al volver a entrar se sube | 🟠 | B |
| `CNT-C12` | **Reloj del teléfono mal puesto** | Anotar si alguna fecha del conteo sale del futuro o del pasado | 🟡 | B |

### 4.5 Errores de diseño

| ID | Qué se mira | Sev | Niv |
|---|---|---|---|
| `CNT-D1` | Capturar **con una sola mano, de pie**: ¿los objetivos son de 44 px o más? | 🟠 | C |
| `CNT-D2` | La pantalla **a 390 px** de ancho: ¿algo se corta o se encima? | 🟠 | C |
| `CNT-D3` | **Sin mouse**, sólo teclado: ¿se puede capturar la jornada entera? | 🟠 | C |
| `CNT-D4` | **Modo oscuro** y **Alto Contraste de Windows** | 🟡 | C |
| `CNT-D5` | El banner de red: ¿se distingue «sin conexión» de «subiendo»? | 🟠 | C |

---

## 5. Reconciliador — cerrar el folio

> ⛔⛔ **Este bloque NO se puede probar hoy.** El ajuste cae en `commercial.stock`, que quedó
> congelada con `[CANON.7.5]`: una prueba de cierre **saldría verde sin que pasara nada**, que es
> peor que fallar. **No se corre hasta que D-EX8 esté construido.** Se deja escrito para que esté
> listo ese día.

| ID | Qué se provoca | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `REC-01` | Cerrar **habiendo contado** uno de los renglones | 403 por segregación de funciones | 🔴 | B |
| `REC-02` | Cerrar con **SKUs sin contar** | Bloqueado, y el aviso tiene que haber llegado **antes**, no al apretar el botón. *(Es el defecto que mató los 6 folios de junio: nadie supo que no podía cerrar hasta tener 3,664 SKUs contados)* | 🔴 | B |
| `REC-03` | ⛔⛔ Cerrar un folio **congelado** después de que la tienda vendió por el POS | **Hoy aplica un set absoluto y borra esas ventas**, porque el guard busca los movimientos en nuestra tabla y es ciego a Kepler. **Ésta es la prueba más importante de todo el documento** | 🔴 | B |
| `REC-04` | Cerrar un folio **no congelado** (cíclico) con ventas en medio | Aplica **delta relativo** contra `book_at_count` y **conserva** las ventas | 🔴 | B |
| `REC-05` | ⭐ Cerrar un folio total de **4,819 renglones** | **Medir el tiempo.** El tope es `statement_timeout = 60s` y se recorre renglón por renglón: ~19 mil sentencias, ~3 ms de presupuesto cada una. **Anotar el número** | 🔴 | B·M |
| `REC-06` | Cerrar con un renglón cuyo **saldo quedaría bajo lo reservado** | Ese renglón queda como diferencia con su nota, el resto se aplica, y **el resumen dice cuántos quedaron fuera** | 🟠 | B |
| `REC-07` | **Cortar la luz del servidor** a media reconciliación | Todo es una transacción: o entra completo o no entra. El folio sigue abierto y se reintenta | 🔴 | B |
| `REC-08` | **Doble clic** en reconciliar | Una sola vez | 🔴 | C |
| `REC-09` | Un renglón **sin costo en ningún ERP** | `unit_cost` queda **nulo**, no cero. Un cero publica la merma como $0.00, indistinguible de «no hubo merma» | 🔴 | B |
| `REC-10` | Generar el archivo para Kepler y **no capturarlo** | Anotar qué sabe el sistema del lazo abierto. Hoy: nada (0 exportaciones en la historia) | 🟠 | B |
| `REC-11` | Intentar cerrar **dos veces** el mismo folio | 409 claro | 🟠 | B |

---

## 6. Observador y Ajeno — las negativas

> ⚠️ **Probar esto con un admin no sirve de nada.** Hay que crear usuarios efímeros con
> exactamente el permiso del bloque y ninguno más.

| ID | Quién | Qué intenta | Tiene que pasar | Niv |
|---|---|---|---|---|
| `NEG-01` | Observador | Abrir un folio | Sin botón, y 403 si se llama al endpoint directo | B |
| `NEG-02` | Observador | Ver el teórico (`/counts/:id/items`) | 403 | B |
| `NEG-03` | Observador | Asignar, contar, reconciliar, cancelar | 403 en los cuatro | B |
| `NEG-04` | Ajeno | Entrar a `/almacen/inventory/sessions` | Rebota; y **la entrada no está en su menú** | B |
| `NEG-05` | Ajeno | Llamar cada uno de los **29 endpoints** del controlador | 403 en todos. Es la única forma de saber que ninguno quedó sin guard | B |
| `NEG-06` | Contador **no asignado** y sin la clave | Capturar en un folio ajeno | 403 | B |
| `NEG-07` | Contador asignado | Capturar **después de que el folio cerró** | 409, y el escaneo queda descartado con motivo | B |
| `NEG-08` | Cualquiera | Pedir un folio **de otro tenant** | 404 (no 403: no se confirma que exista) | B |

---

## 7. Transversales — no son de nadie y le pegan a todos

| ID | Qué se provoca | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `TRV-01` | ⛔ Abrir un folio con **el ODS atrasado** para esa sucursal | Hoy `openCount` **no consulta la frescura del ODS** ni la declara: el folio nace con un teórico viejo y nada avisa. Tiene que declarar **de cuándo es la foto** | 🔴 | B |
| `TRV-02` | **Dos pestañas** con el mismo folio abiertas, capturando en las dos | Anotar si se pisan | 🟠 | C |
| `TRV-03` | La **misma persona** en dos aparatos | Anotar qué pasa con las dos colas | 🟠 | B |
| `TRV-04` | Congelar un almacén y **pedir un pedido** desde la Suite | Rechazo nombrando el folio | 🟠 | B |
| `TRV-05` | Congelar un almacén y **vender por el POS** | ⛔ **No se frena, y no se puede frenar**: la Suite no escribe en Kepler. Verificar que, cuando menos, **quede registrado** que el teórico se movió | 🔴 | B |
| `TRV-06` | Toda la suite **sin internet** (la ingesta cae) | Anotar qué sigue funcionando del módulo | 🟠 | B |
| `TRV-07` | El contraste de cada texto, en claro y oscuro | Ya medido en código: pasa AA. Verificarlo **sobre lo pintado** | 🟡 | C |
| `TRV-08` | La pantalla con **200 folios** (el tope de la lista) | Avisa que hay tope; mide el tiempo de carga (gate: 500 ms) | 🟠 | B·M |

---

## 8. Cómo se anota

Una tabla por corrida, en este mismo archivo o en el documento de la fase:

| ID | Fecha | Quién | Resultado | Lo que se vio | Evidencia |
|---|---|---|---|---|---|
| `CNT-C8` | | | ✅ / ❌ / **NO MEDIDO** | en una frase, lo que de verdad pasó | traza de Playwright, captura, o el número medido |

**Reglas de anotación:**

1. ⛔ **Un renglón sin correr se anota NO MEDIDO**, nunca se deja en blanco ni se asume verde.
2. Los renglones **`·M`** anotan **el número**, no «pasó». «Reconcilió» no vale; «reconcilió 4,819
   renglones en 41 s» sí.
3. Un ❌ se anota **aunque ya se sepa** que está mal (varios de arriba ya están diagnosticados):
   la prueba es lo que convierte el diagnóstico en evidencia reproducible.
4. ⭐ **Toda prueba que afirme que una compuerta funciona tiene que romperla primero.** Un guard
   que nunca se vio en rojo es una intención, no un guard.

---

## 9. Por dónde empezar

Si hay medio día y no el documento entero:

1. **`REC-05`** — medir el tiempo del cierre con 4,819 renglones. Si no cabe en 60 s, nada de lo
   demás importa, y se descubre con la sucursal parada.
2. **`CNT-C1` a `CNT-C9`** — el camino offline completo. Es donde vive el trabajo de la gente.
3. **`SUP-D1`** — el fallo que se lee como «no hay folios». Es barato y hoy engaña.
4. **`REC-03`** — el cierre con ventas del POS en medio. Es el que puede destruir existencia.

El resto ordena por severidad: primero las 🔴, después las 🟠.
