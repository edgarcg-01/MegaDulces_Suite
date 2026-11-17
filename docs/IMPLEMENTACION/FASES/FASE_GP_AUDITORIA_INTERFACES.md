# Fase GP — Auditoría de interfaces: menos pantallas, menos clics, máxima visibilidad

> **Anexo de la [Fase GP](FASE_GP_GESTION_PEDIDOS_ALMACEN.md)**, ligado a su
> [plan de implementación](FASE_GP_PLAN_IMPLEMENTACION.md). Es un documento **vivo**: cada paso
> se audita, se decide, se cambia y se vuelve a medir, y todo queda escrito aquí.
>
> **El pedido (Edgar, 2026-11-14):** *«una reestructuración del frontend que nos haga tener la
> menor cantidad de interfaces posible: sin interfaces innecesarias ni clics innecesarios. Carga
> visual, accesibilidad, etc. Es primordial darle al usuario los pasos claros y la máxima
> visibilidad posible, sin perder atención al detalle. La menor cantidad de clics, y automatizar
> todo proceso posible. Usa Playwright en cada uno de los pasos; inicia con el paso 0.»*
>
> **Alcance (precisado por Edgar en la misma conversación):** sólo las interfaces de **este plan**
> (el recorrido del pedido en almacén) y las que se trabajaron en la sesión del 2026-11-14. El resto
> de la suite queda fuera; su inventario va en §4.4 sólo como contexto.

---

## 1. Qué se mide y cuándo una interfaz pasa

Cada criterio del pedido tiene su cifra. Una pantalla se juzga con **las mismas mediciones, tomadas
igual**, antes y después de cada cambio.

| Criterio del pedido | Qué se cuenta | Instrumento | Pasa cuando |
|---|---|---|---|
| **Menos interfaces** | Pantallas que hay que abrir para seguir un pedido de punta a punta | recorrido Playwright + inventario de rutas | una por proceso (D1, D2); ninguna duplicada (`surtir-preventa` ↔ `surtir`) |
| **Menos clics** | Clics para TERMINAR cada proceso con N registros, separando los que **deciden** de los que sólo **confirman** lo que el sistema ya sabía | recorrido Playwright, contado | cero clics de pura confirmación; el que decide, a la vista |
| **Automatizar** | Pasos que hace una persona y que el sistema ya podría hacer (capturar en Kepler lo que se surtió, armar la fila, liberar la carreta…) | recorrido + plan GP (E2–E4) | cada paso manual tiene su porqué escrito o su item para automatizarlo |
| **Pasos claros** | Que la pantalla diga qué sigue, en una frase, sin manual | lectura en la pantalla viva (prueba de la frase) | la persona sabe qué hacer al entrar |
| **Máxima visibilidad** | Lo que define el estado se ve sin clic; nada plegado que importe; ninguna lista topada en silencio | Playwright (`marco_px`, plegables) + Cruce 1 de `auditoria-diseno` | todo lo que decide, en la primera pantalla |
| **Carga visual** | Accionables y cifras en la primera pantalla; niveles de letra; marco contra trabajo | `medir.ts`: `controles`, `cifras`, `tamanos_letra`, `marco_px` | sin cifras repetidas; ≥3 niveles de letra (§Q.5); el trabajo empieza arriba |
| **Accesibilidad** | Texto bajo contraste AA; accionables sin nombre accesible; objetivos chicos; letra mínima | `medir.ts`: `contraste_falla`, `sin_nombre`, `objetivos_chicos`, `letra_min_px` | 0 bajo AA; 0 sin nombre; táctil ≥44 px en celular |
| **Atención al detalle** | Rótulos que dicen lo que muestran, cifras que se pueden recorrer, unidades declaradas | los seis cruces de `auditoria-diseno` §3 (a mano) | ningún rótulo falso; toda cifra se abre a sus renglones |
| **Velocidad** | Tiempo hasta que la pantalla queda quieta; consulta del servidor | Playwright `ms_hasta_quieta` + servicio real en prod | la consulta < 500 ms (regla de Edgar) |
| **Retrabajo** | Envíos que el servidor rechaza, por pantalla | `analytics.ui_usage` (errores por ruta que escribe) | sin rechazos recurrentes; cada uno explicado |

⛔ **No hay puntaje global** (skill `auditoria-diseno` §3d): una pantalla limpia que publica un
número falso ya hizo daño. El veredicto se da por criterio.

---

## 2. Cómo se trabaja cada paso

1. **Medir antes, en la pantalla viva** (nivel A): Playwright contra prod, en **sólo lectura**
   (toda escritura se aborta en el navegador). Se declara el nivel de evidencia de cada hallazgo:
   A pantalla viva · B base de datos · C código. Con nivel C no se afirma nada visual.
2. **El recorrido entero, no la vista de entrada**: desde que la persona entra hasta que termina,
   con datos reales y con cada estado (vacío, con muchos, con error).
3. **Decidir**: qué se fusiona, qué se quita, qué se automatiza. Lo que es de Edgar (personas,
   dinero, proceso) se le pregunta; lo de diseño y herramienta se decide y se anuncia.
4. **Cambiar**, con la skill `diseno` y sus cinco preguntas por escrito.
5. **Medir después, igual que antes**, y registrar la diferencia en la sección del paso.

**El kit** (`e2e/reestructura/`):

| Pieza | Qué hace |
|---|---|
| `inventario.js` | Lista las rutas de las tres apps (pantallas, redirecciones, marcos) con el compilador de TypeScript, y las cruza con el uso de 30 días en prod. Arranca con un control de tres rutas conocidas |
| `medir.ts` | El instrumento: lo mismo en cada pantalla, sobre lo pintado en la primera pantalla |
| `paso0.e2e.ts` | El control del instrumento (y su negativa), el blindaje contra escrituras y la línea base |
| `playwright.config.ts` | Prod, 1366×768, service worker bloqueado (sin eso una escritura se cuela) |

```bash
node e2e/reestructura/inventario.js
MD_TOKEN_FILE=<archivo con el JWT> npx playwright test -c e2e/reestructura/playwright.config.ts
```

Los resultados (JSON y capturas) caen en `e2e/reestructura/.resultados/`, fuera de git.

---

## 3. Las interfaces del alcance, en el orden del pedido

Uso de 30 días al 2026-11-14, prod, sólo lectura.
- **Entradas** son persona-días en que alguien entró o salió de la app por esa ruta. Es una **cota
  inferior**: la telemetría no registra la navegación interna (ver §7, P-RF.2).
- **API, por quién opera** son las llamadas del endpoint principal, separadas por rol
  (`analytics.ui_usage`). ⛔ Se separan por rol **siempre**: sin separar, las pruebas de Dirección
  y la vista de superadmin se leían como problemas de la operación (§4.5).

| # | Paso del pedido | Ruta | Quién opera | Entradas | API de quien opera (30 d) | `check:pantalla` (deuda) | Estado tras GP.10.4 |
|---|---|---|---|---:|---|---|---|
| 1 | Consola maestra | `/almacen/pedidos` | coordinación, consulta | 34 | 682 lecturas (135 ms en promedio, máx. 823) | Q.1 · §2 · §9 | absorbió Preventa y Consola (en código, sin soltar) |
| 1a | — vista «Fila de surtido» | `/almacen/pedidos?vista=fila` | coordina el surtido | (5 por la ruta vieja) | 63 aperturas; armar 2 veces sin falla | Q.1 · §2 · §9 · O.4 | era la Consola de surtido |
| 1b | — detalle de un `PD-` | `/almacen/pedidos/preventa?pedido=` | encargado, Dirección | 2 | 69 lecturas · ligar 14 (sólo Dirección, octubre) | Q.1 · §2 · §9 | sin pestaña: detalle de preventa |
| 2 | Surtir (celular) | `/almacen/surtir` | surtidor | 73 | surtidores: «mis surtidos» 570 (14 ms) · «siguiente» 54 (173 ms, máx. 781) | Q.1 · §2 · §9 | sin cambio; E2 le agrega carreta |
| 2b | Surtir preventa (celular) | `/almacen/surtir-preventa` | surtidor de sucursal | 0 | 6,880 lecturas · terminar: **73 de 696 rechazados (10.5 %)** | Q.1 | ⚠️ duplica el modo Sucursal de Surtir (deuda con nombre) |
| 3 | Checar | `/almacen/checar` | checador | 1 | **ningún checador lo usó**: 16 «siguiente», de Dirección, superadmin y un surtidor | Q.1 · §2 · §9 | sin cambio; E3 lo rehace |
| 4 | Por capturar en Kepler | `/almacen/pedidos-por-capturar` | facturación | 0 | 33 lecturas | Q.1 · §2 · §9 · O.4 | se retira o queda como bandeja de fallas (paso 4b) |
| 5 | Revisión de pedidos (caja) | `/almacen/pedidos/revision` | caja | 52 | 15,974 lecturas · terminar: caja **20 de 187 rechazados (10.7 %)** | — | D9: preventa no se toca en esta etapa |
| 6 | Guías de carga | `/almacen/pedidos/guias` | caja | 15 | 307 lecturas | Q.1 · §2 · §9 · O.4 | D9 |
| 7 | Clientes nuevos (Kepler) | `/almacen/clientes-nuevos` | encargado de sucursal | 2 | 1,213 lecturas del resumen | — | D9 |
| 8 | Ubicaciones · mapa (fase UB, paso 1) | `/almacen/ubicaciones` | almacén | 9 | 181 lecturas | §2 · §9 | de la fase UB |
| 9 | Ubicaciones · contenido (fase UB, paso 2) | `/almacen/inventory/ubicaciones` | almacén | 1 | las altas rechazadas son pruebas de Dirección | Q.1 · §9 · D.8 | de la fase UB |

**Leído en una línea:** el pedido de almacén se sigue hoy en **10 interfaces**, más el detalle de
un `PD-`. Lo que de verdad le cuesta a quien opera:
- en dos cierres, **uno de cada diez intentos es rechazado**: el surtido de preventa y la revisión
  en caja;
- **Checar todavía no lo usa ningún checador**.

Todos los rechazos medidos son 4xx, es decir, el servidor dice «no» por una regla. Ninguno es 5xx.

---

## 4. Paso 0 — Línea base (2026-11-14)

### 4.1 El instrumento acierta su control ✅

`paso0.e2e.ts` › *0.1*, con Playwright 1.64 y Chromium. Se probó contra una página hecha a
propósito, cuyas respuestas se conocen por construcción:

| Medición | Esperado | Medido |
|---|---|---|
| Accionables en la primera pantalla (sin contar el que está abajo del pliegue) | 6 | 6 ✅ |
| Cifras visibles (sin el `999` de abajo) | 3 | 3 ✅ |
| Texto bajo AA (`#777` sobre blanco, 4.48:1) | 1 | 1 ✅ (4.48) |
| Niveles de letra / letra mínima | 3 / 12 px | 3 / 12 px ✅ |
| Marco hasta la primera fila | 300 px | 300 px ✅ |
| Objetivos de menos de 24 px | 1 | 1 ✅ |
| Accionables sin nombre accesible (árbol de accesibilidad de Chromium) | 2 | 2 ✅ |

**La prueba negativa** (regla 12): `#767676` sobre blanco da 4.54:1, apenas por encima de AA. El
instrumento **no** lo marca, y un botón con nombre no cuenta como «sin nombre». ✅

### 4.2 El blindaje contra escrituras funciona ✅

`paso0.e2e.ts` › *0.2*, contra prod (`https://megadulcessuite.com/login`):
- un `POST` a la API queda **abortado en el navegador** y no llega al servidor;
- un `GET /api/health` **sí** pasa (200), así que el bloqueo es selectivo;
- ningún service worker controla la página.

En el recorrido de 4.3, **ninguna pantalla intentó escribir** (0 escrituras abortadas).

### 4.3 La línea base por pantalla ✅ (con dos límites declarados)

**Cómo se midió:** `paso0.e2e.ts` › *0.3*, el 2026-11-14 a las 12:01, con la sesión de Edgar
(**superadmin**). La sesión se obtuvo con `iniciar-sesion.js`: Edgar entró en un Chromium visible y
el script guardó el token fuera del repo, sin imprimirlo.
- Escritorio: 1366×768.
- Celular (Surtir, Surtir preventa, Checar): 390×844, con toque.

⛔ **Límite 1 — prod tiene la versión de ANTES:** el commit desplegado es `d88bfc45a`, que **no**
incluye GP.10.4. Por eso `?vista=fila` y `?origen=PREVENTA` midieron lo mismo que el Tablero
viejo, y por eso esto es la línea base del «antes»: el Tablero con sus 7 pestañas.

⛔ **Límite 2 — superadmin no ve lo que ve quien opera:** ve todos los almacenes y todo el
dinero. Ejemplo medido: al entrar a Surtir, «mis surtidos» tardó **más de 11.5 s** y la pantalla
siguió en «Cargando…»; para los surtidores ese mismo llamado promedia **14 ms** (§4.5). Las cifras
de carga visual y accesibilidad valen como estructura; **el tiempo y el contenido se vuelven a medir
con el puesto de cada pantalla** (P-RF.1).

| Pantalla | Quieta en | Accionables | Cifras | Marco hasta la 1.ª fila | Letra mín. | Niveles de letra | Bajo AA | Sin nombre | Objetivos < 24 px |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Tablero (`/almacen/pedidos`) | 5.2 s (en frío) | **58** | **108** | **415 px de 768 (54 %)** | 10 px | 6 | 0 | 0 | 3 |
| Surtir 📱 | — | 11 | 0 | — | 12 px | 3 | 1 | 0 | 1 |
| Surtir preventa 📱 | 2.4 s | 33 | 34 | — | 10 px | 7 | 0 | 0 | 1 |
| Checar 📱 | 1.8 s | 16 | 1 | — | 10 px | 6 | 0 | 0 | 1 |
| Por capturar en Kepler | 2.1 s | 42 | 28 | 462 px (60 %) | 10 px | 6 | 1 | 0 | 3 |
| Revisión de pedidos | 2.0 s | 46 | 29 | — | 10 px | **9** | 0 | 0 | **7** |
| Guías de carga | 1.8 s | 30 | 4 | — | 10 px | 6 | 0 | 0 | 3 |
| Clientes nuevos | 1.8 s | 29 | 23 | — | 10 px | 8 | 0 | 0 | 4 |
| Ubicaciones · mapa | 1.9 s | 35 | 17 | — | 10 px | 7 | 0 | 0 | 3 |
| Ubicaciones · contenido | 1.8 s | 30 | 1 | — | 10 px | 7 | 0 | **1** | 3 |

«Quieta en» es el tiempo hasta que la red queda sin peticiones por medio segundo; incluye cargar
la app. «—» en el marco quiere decir que la pantalla no tiene filas de tabla visibles. Surtir se
midió todavía en «Cargando…» (límite 2): sus cifras no describen la pantalla de trabajo.

**Lo que se ve en las capturas** (nivel A; están en `e2e/reestructura/.resultados/paso0/`):
- **Tablero:** antes de la primera fila hay siete franjas:
  1. la barra superior;
  2. las migas;
  3. las **7 pestañas**;
  4. el título y la fecha;
  5. Surtir, Checar, el periodo, el rango y actualizar;
  6. los botones de estatus;
  7. los filtros.

  Las 108 cifras de la primera pantalla incluyen el importe y la hora de cada fila. El «Abierto»
  de cada pedido sale como «12 min», «18 min»: es el tiempo desde que se creó, no el tiempo en su
  estatus (declarado en la pantalla).
- **Checar:** para hacer cualquier cosa primero hay que **elegir el almacén en un `<select>` nativo**
  («— Elige —»). «Tomar siguiente» queda apagado hasta entonces. Es un clic de más en **cada**
  entrada si la persona checa en un solo almacén. El `<select>` nativo no es el control del sistema
  de diseño (`p-select`).
- **Surtir:** abre en «Cargando…» con la barra de navegación de celular abajo (Inventario,
  Ubicaciones, Abasto, Pedidos, Más).
- **Todas las pantallas:** los dos errores de consola son el script de **Cloudflare Insights que la
  política de seguridad del sitio bloquea**. No es de estas pantallas, sino de la infraestructura:
  se avisa, no se toca (regla 7).

**Accesibilidad, en una línea:**
- **Contraste:** sólo 2 textos bajo AA en las 12 pantallas:
  - «Salir» en Surtir, a 4.40:1;
  - un «1» en ámbar `--warn-fg` sobre blanco en Por capturar, a **2.15:1**: el defecto que ya
    describe la skill de auditoría.
- **Nombre:** sólo 1 botón sin nombre accesible, en Ubicaciones · contenido.
- **Tamaño:** lo que más se repite es la **letra de 10 px en todas** y los objetivos de menos de
  24 px: 7 en Revisión.

⛔ **NO MEDIDO todavía:** alto contraste de Windows (`forced-colors`), zoom al 200 %, recorrido sólo
con teclado y lector de pantalla.

### 4.4 Inventario y uso (contexto de toda la suite)

`inventario.js`, con su control en verde:

| App | Rutas de pantalla | Componentes distintos | Redirecciones | Con entrada medida en 30 d | En 0 (cota inferior) |
|---|---:|---:|---:|---:|---:|
| `view` | 356 | 315 | 51 | 181 | 175 |
| `vendor` | 27 | 26 | 7 | — | — |
| `portal` | 10 | 10 | 3 | — | — |

- El **80 %** de las entradas de `view` cae en **22 de 356** pantallas. 101 pantallas tienen entre
  1 y 4 persona-días en un mes.
- `check:pantalla`: **317 pantallas · 244 con falla · 603 fallas**, todas en deuda declarada
  (0 nuevas). Por regla, la deuda sellada se reparte así:

  | Regla | Pantallas |
  |---|---:|
  | §2 — sin estados (cargando ≡ vacío ≡ error) | 200 |
  | §9 — sin edad del dato | 191 |
  | Q.1 — sin veredicto arriba | 163 |
  | O.4 — rejilla fuera de `p-table` | 46 |
  | D.7 — sin teclado | 12 |
  | D.8 — búsqueda con `.includes()` | 12 |
- ⚠️ «En 0» **no** quiere decir «sin uso». Por eso esa columna no basta para retirar nada (P-RF.2).

### 4.5 Lo que dice la base (nivel B), separado por rol

| ID | Hallazgo | Quién lo vive | Costo | Siguiente |
|---|---|---|---|---|
| GP.RF.3 | Surtir preventa: «terminar» rechazado **73 de 696** veces (10.5 %, 4xx) | surtidores | uno de cada diez surtidos de preventa no se cierra al primer intento | paso 2b: qué regla lo rechaza y qué ve el surtidor |
| GP.RF.4 | Revisión en caja: «terminar» rechazado **20 de 187** veces a cajeros (10.7 %, 4xx). A encargados, surtidores y auxiliares, 0 de 436 | cajeros | uno de cada diez cierres de caja se repite | paso 5 (D9: sólo auditar) |
| GP.RF.8 | Checar: **ningún checador lo ha usado** en 30 días. Lo usaron Dirección (9 «siguiente», los 9 rechazados), superadmin (5) y un surtidor (2) | — | el checado sigue en papel o en Kepler | paso 3; es la adopción de E3, no un defecto de pantalla |
| GP.RF.6 | Revisión en caja hace **15,974** lecturas en 30 días (19 ms en promedio) | caja, encargados | cada pantalla abierta pregunta sin parar: barato para el servidor, no medido en el celular | medir cada cuánto encuesta y si hace falta |
| GP.RF.9 | Superadmin y Dirección esperan **2.6 s en promedio** (máx. 15.8 s) al entrar a Surtir, y **7.6 s** en «siguiente» | superadmin, Dirección | quien supervisa no puede revisar Surtir en vivo | el servicio arma la consulta de todos los almacenes; se ve en el paso 2 |
| ~~GP.RF.1~~ | ~~Checar «siguiente» rechazado 9 de 16~~ | — | — | **retirado:** eran pruebas de Dirección (ver GP.RF.8) |
| ~~GP.RF.2~~ | ~~Armar 4 de 6 con error, tanda 2 de 5~~ | — | — | **retirado:** los 6 fallos son de Dirección; los coordinadores armaron 2 veces sin falla |
| ~~GP.RF.5~~ | ~~Alta de ubicaciones 2 de 2 rechazada~~ | — | — | **retirado:** eran de Dirección |
| ~~GP.RF.7~~ | ~~Surtir «siguiente» 1.3 s en promedio~~ | — | — | **corregido:** para surtidores son **173 ms** (máx. 781); el promedio lo inflaba superadmin (GP.RF.9) |

⭐ **La lección del paso 0, que vale para todos los que siguen:** un error o un tiempo sin separar
por rol miente. Cuatro de los siete hallazgos de la primera lectura eran pruebas de Dirección o la
vista de superadmin. Desde aquí, todo hallazgo de base se publica **por rol**.

---

## 5. Paso 1 — Tablero, fila de surtido y detalle de preventa (2026-11-17)

**La pregunta:** ¿quien coordina ve en la primera pantalla qué pedido está atorado y qué sigue, sin
dar un clic?

**La respuesta medida en la versión de hoy: no.**
- **El Tablero no dice nada de pedidos atorados** en su primera pantalla (cero avisos), aunque hay
  **393 pedidos** que Kepler sigue teniendo como autorizados desde hace más de una semana.
- **La fila de surtido sí lo dice, pero no se puede abrir:** «58 pedidos siguen autorizados en Kepler
  desde 15/08/2026 y quedan fuera de la fila: revísalos en Kepler». Para ver cuáles, hay que salir de
  la Suite.
- **La fila muestra trabajo que nadie va a hacer.** En Canindo hay 11 surtidos «sin terminar», todos
  «Esperando hace 12 días». En la pantalla se leen igual que el trabajo de hoy.

### 5.1 Cómo se midió

- `paso1.e2e.ts`, el 2026-11-17, contra prod `7edf9508a`. Esa versión no trae GP.10.4, así que es el
  **«antes»**. Sesión de Edgar (superadmin), con los dos límites del paso 0 (§4.3).
- **Nivel A**, la pantalla viva: los clics y la carga.
- **Nivel B**, la base en sólo lectura: el uso por rol y los surtidos.
- **El cruce de cifras** se hizo con el servicio real del Tablero ejecutado contra prod, igual que
  en GP.10.4.
- **Escrituras:** el recorrido intentó dos, «marcar urgente» y «armar». Las dos se abortaron en el
  navegador; ninguna llegó a prod.

### 5.2 El recorrido, contado

Cada clic dice qué es:
- **navega:** sólo cambia de pantalla.
- **decide:** algo que el sistema no puede saber.
- **confirma:** repite una decisión ya tomada.
- **abre:** despliega un detalle.

| Tarea de quien coordina | Antes (medido en prod) | Con GP.10.4 + GP.RF.15 (lo previsto; lo medido de GP.10.4 está en §5.5) |
|---|---|---|
| Entrar y ver la fila | 1 navega (pestaña «Consola de surtido»). Quien maneja varios almacenes cae en el primero (CEDIS, fila vacía): **+2 decide** para elegir otro | 1 navega («Fila de surtido», dentro del Tablero); el selector, igual |
| Priorizar un surtido | 1 decide («Marcar urgente») + motivo tecleado + 1 confirma | igual |
| Armar surtidos | 1 decide. Casi nunca hace falta: el sistema ya los arma solo (§5.3) | igual |
| Abrir un pedido de preventa | 1 navega (pestaña «Preventa») + 1 abre | se previó 1 abre; **medido: 4 clics** (§5.5, GP.RF.21) |
| Ver cuáles son los atorados | **imposible en la Suite** («revísalos en Kepler») | **1 abre** («velos en el Tablero») |

| Pantalla (antes) | Quieta en | Accionables | Cifras | Marco hasta la 1.ª fila | Bajo AA | Lo que pesa |
|---|---:|---:|---:|---:|---:|---|
| Tablero | 4.0 s | 58 | 125 | 415 px de 768 | 0 | la lista baja **1.03 MB** con 1,451 pedidos (sin preventa) |
| Fila de surtido (Canindo) | 1.1 s | 44 | 67 | 462 px | **6** | «Cancelar surtido» en rojo a 3.76:1, una vez por renglón (GP.RF.18) |
| Preventa | 2.8 s | 42 | 81 | 451 px | 0 | — |

### 5.3 Lo que dice la base (nivel B, 30 días, por rol)

- **Quien coordina vive en el Tablero, no en la fila.** El coordinador de embarques:
  - abrió la lista del Tablero 158 veces, en 14 de los 30 días, y el detalle de un pedido 23 veces;
  - abrió la fila 15 veces, en 5 días;
  - armó surtidos a mano 1 vez;
  - no marcó ningún urgente y no liberó ni canceló ningún surtido;
  - no puso ninguna hora de salida (las puso un supervisor, 9 en un solo día).
- **El sistema ya arma solo.** En 30 días hubo 17 surtidos y los 17 los armó el sistema, al pedir
  trabajo un surtidor («Tomar siguiente»). Sólo 5 se terminaron. Ninguno se marcó urgente ni se
  liberó.
- **La fila de hoy son surtidos abandonados.** Hay 27 sin terminar:
  - Morelia Abastos: 14 abiertos desde el 8-oct;
  - Canindo: 10 abiertos y 1 en surtido, desde el 4-nov;
  - Padre Hidalgo: 2 en surtido, desde el 8-oct y el 3-nov.
- **Los atorados son 393:** pedidos que Kepler sigue teniendo como autorizados, con fecha de hace
  más de 7 días.

  | Sucursal | Pedidos | Desde |
  |---|---:|---|
  | Zamora Centro | 288 | 19-mar |
  | Canindo | 58 | 15-ago |
  | Morelia Abastos | 26 | 21-sep |
  | La Piedad Abastos | 9 | 29-nov-2025 |
  | CEDIS | 8 | 20-abr |
  | Padre Hidalgo | 2 | 7-sep |
  | 8 Esquinas | 1 | 5-mar |
  | Morelia Madero | 1 | 26-oct |

  Nadie los va a surtir: hay que cerrarlos en Kepler.

### 5.4 El cambio: la cifra de atorados se abre (GP.RF.15) 🧪

- **Qué cambia en pantalla.** La fila ahora dice: «58 pedidos siguen autorizados en Kepler desde
  15/08/2026 y quedan fuera de la fila: **velos en el Tablero** y ciérralos en Kepler».
- **A dónde lleva la liga.** Al Tablero filtrado por:
  - el estatus de Kepler AUTORIZADO;
  - la sucursal;
  - del primer atorado al día anterior a la ventana de la fila.
- **Qué ve al llegar.** Una nota arriba de la lista dice qué filtro trae, y «Quitar este filtro» lo
  quita en un clic.
- **Por qué por estatus de Kepler y no por etapa:** por etapa no cuadra. En Canindo daría 52 de 58,
  porque 6 están dentro de surtidos abandonados de la Suite y su etapa ya no dice «autorizado». Por
  estatus de Kepler la lista que pide la pantalla da **exactamente** la cifra de la fila en las 8
  sucursales: **393 de 393**, ninguno de preventa. Se midió con el servicio real contra prod.
- **API.** `por_armar.ventana_desde` es opcional. Una API anterior no lo manda, y entonces la
  consola no pinta la liga: no inventa la frontera.
- **Pruebas.**
  - Tablero, 6 nuevas:
    - la liga llega con su filtro puesto;
    - «Quitar este filtro» pide la lista sin él;
    - 4 negativas, en las que no se aplica NADA de la liga, ni a medias: un estatus que la liga no
      manda, fechas invertidas, una fecha que no es fecha y una sucursal mal escrita.
  - Consola, 3 nuevas:
    - la liga lleva su frontera exacta;
    - la resta del día es de calendario (1-mar → 28-feb);
    - negativa: con la API anterior no hay liga.
  - Resultado: 58 de 58 junto con las existentes. Las plantillas tipan en las cuatro apps y
    `check:pantalla` no tiene fallas nuevas.
  - NO MEDIDO: una sucursal válida que la persona no tiene en su alcance. El servidor la filtra por
    alcance; no hay prueba de cómo se ve.
- **NO MEDIDO:**
  - **La pantalla viva con el cambio:** prod no lo tiene. `paso1.e2e.ts` ya trae la tarea «veo los
    atorados» y compara la cifra de la fila contra la de la lista; se corre al desplegar.
  - **La mutación:** el árbol se comparte con otras sesiones vivas. Las negativas cubren cada rama de
    rechazo.
- **Costo:** esa consulta tarda 0.2 a 1.8 s, medida desde la laptop sobre rangos de hasta un año.
  Pasa el límite de 500 ms (GP.RF.19).

### 5.5 El «después» de GP.10.4, medido en prod (2026-11-17, `5b9d9af58`)

GP.10.4 llegó a prod el 17-nov a las 09:22, dentro del lote de 57 commits que empujó otra sesión.
GP.RF.15 todavía no está ahí. Se corrió el mismo `paso1.e2e.ts`, con la misma sesión, una hora
después del «antes».

**Lo que mejoró:**
- Las pestañas del grupo Pedidos pasan de 7 a 5, y seguir un pedido ya no pide cambiar de pantalla.
- Hay menos piezas en la primera pantalla del Tablero: 50 accionables contra 58, y 83 cifras contra
  125.

**Lo que empeoró, y se dice igual de claro:**

| Medida | Antes (`7edf9508a`) | Después (`5b9d9af58`) | Por qué |
|---|---:|---:|---|
| Marco hasta la 1.ª fila del Tablero | 415 px | **507 px** de 768 (66 %) | se agregaron el renglón «Pedidos · Fila de surtido», más botones de etapa y el aviso «Se muestran los primeros 2000» |
| Lo que baja la lista | 1.03 MB, 1,451 pedidos | **1.40 MB, 2,000** (de 2,224: **topada**) | la preventa entró a la lista del mes |
| Quieta en (superadmin) | 4.0 s | **7.4 s** | el mismo peso |
| Abrir un pedido de preventa | 2 clics (pestaña + abrir) | **4 clics** (volver a Pedidos + elegir el origen «Preventa» en dos clics + abrir) | la preventa ya no está en la primera página: la lista va por fecha. Por folio sigue siendo teclear y abrir |
| Marco hasta la 1.ª fila de la fila de surtido | 462 px | **516 px** | la fila vive debajo de la cabecera del Tablero |

**Sin cambio:** ver la fila (1 clic, más 2 si maneja varios almacenes), priorizar (2 clics y el
motivo) y armar (1 clic). En la fila siguen 5 textos bajo AA, los «Cancelar surtido» (GP.RF.18).

Lo que sigue en este paso, en orden, para que el «después» gane en todo y no sólo en pantallas:
1. **GP.RF.20**, quitar el renglón propio de «Pedidos · Fila de surtido»: el cambio de vista va en
   la cabecera, junto al periodo. Recupera unos 45 px.
2. **GP.10.5**, la lista deja de toparse y de bajar 1.4 MB. Con eso también se va el aviso de los
   2000.
3. **GP.RF.21**, la preventa a un clic: un botón «Preventa» junto a los de etapa, con su conteo, en
   lugar del filtro de origen en dos clics.

### 5.6 Lo que queda del paso 1

- **GP.RF.14, los surtidos abandonados en la fila:** es una regla del proceso y la decide Edgar
  (P-RF.4, §7).
- **GP.RF.16, el aviso de atorados en la primera pantalla del Tablero:** pide que la API cuente los
  atorados del alcance de la persona, porque el Tablero es por mes y los atorados son de meses
  anteriores. Es el siguiente cambio de este paso.
- **GP.RF.17 a GP.RF.19:** en el registro (§8).

---

## 6. Los pasos que siguen

Cada paso arranca con la línea base de su pantalla (Playwright), recorre el proceso **completo**
con datos reales y termina con la medición de después. El orden sigue el recorrido del pedido.

| Paso | Interfaz | La pregunta del paso | Qué se mide con Playwright |
|---|---|---|---|
| **1** | Tablero + fila de surtido + detalle de `PD-` | ¿Quien coordina ve en la primera pantalla qué pedido está atorado y qué sigue, sin clic? | ✅ el «antes» y el «después» de GP.10.4 medidos el 2026-11-17 (§5). 🧪 GP.RF.15 en código. Falta: GP.RF.20 (marco), GP.10.5 (tope y peso), GP.RF.21 (preventa a un clic), GP.RF.16 (aviso de atorados) y la regla de los surtidos abandonados (P-RF.4) |
| **2** | Surtir (celular) | ¿El surtidor termina un pedido sin pensar qué tocar? | con el puesto de surtidor: toques por renglón; objetivos ≥44 px; qué pasa si se cae la red a medio surtido; la espera de superadmin (GP.RF.9) |
| **2b** | Surtir preventa | ¿Hace falta una segunda pantalla de surtir? ¿Por qué se rechaza uno de cada diez cierres (GP.RF.3)? | lado a lado con Surtir: actos que una tiene y la otra no (sustitutos, «otra unidad»); el mensaje del rechazo |
| **3** | Checar | ¿Por qué ningún checador lo usa (GP.RF.8)? ¿Hace falta elegir almacén cada vez? | con el puesto de checador: el recorrido con y sin pedidos en la cola, y los clics antes del primer escaneo |
| **4** | Por capturar en Kepler | ¿Sigue haciendo falta cuando la Suite escriba SURTIDO (GP.12)? | qué le pide a Facturación y cuántos pedidos tiene hoy |
| **5** | Revisión + Guías (caja) | ¿Cuántas pantallas y clics le toma a la caja cerrar un pedido de preventa? | clics por pedido; frecuencia de encuesta (GP.RF.6). D9: sólo se audita |
| **6** | Clientes nuevos | ¿Es una pantalla, o es un aviso dentro de Surtir o del Tablero? | qué hace la persona ahí y cuántas veces |
| **7** | Ubicaciones (fase UB) | ¿Mapa y contenido son una sola tarea? | recorrido de acomodar un producto; los errores de alta (GP.RF.5) |

---

## 7. Decisiones pendientes de Edgar

| # | Pregunta | Recomendación |
|---|---|---|
| **P-RF.1** | ✅ en parte: Edgar inició sesión (superadmin) con `iniciar-sesion.js`. Falta medir **como cada puesto**: el paso 0 probó que superadmin no ve lo que vive el surtidor (14 ms contra más de 11 s) | Una sesión por puesto para los pasos 1–3: coordinador de embarques, surtidor, checador y caja. La persona entra con `iniciar-sesion.js`; nadie comparte su contraseña |
| **P-RF.2** | Hoy la Suite registra en qué pantalla entra o sale la persona, no por dónde navega. Lo dejó prometido por escrito: *«el evento es el clic en un enlace de navegación, no el recorrido dentro de cada módulo»* (SN.12). Sin el recorrido no se puede contar cuántos clics da la gente de verdad, ni afirmar que una pantalla no se usa | Registrar sólo la **ruta** al cambiar de pantalla (nada del contenido), y analizarla por puesto, nunca por persona. Es tu decisión porque cambia lo que se prometió |
| **P-RF.4** | Hay **25 surtidos** que el sistema armó solo, que nadie tomó y que siguen en la fila: 12 a 40 días. Se ven como trabajo de hoy, y «Tomar siguiente» le daría al surtidor primero el más viejo. ¿Qué pasa con un surtido que el sistema armó y nadie tomó? (GP.RF.14) | Que **se deshaga solo** al día siguiente: sus pedidos regresan a «por armar» y, si Kepler ya no los tiene autorizados, salen. Los que armó una persona no se tocan. Cero clics para el coordinador. Es tu decisión porque fija cuándo un pedido se da por abandonado |
| **P-RF.3** | ¿Se extiende después a toda la suite? (356 pantallas en `view`; el 80 % del uso en 22) | Primero cerrar este alcance; el inventario de §4.4 queda listo para cuando se decida |

---

## 8. Registro de hallazgos

Formato de cada hallazgo:
- **Qué está mal**, desde la silla de quien usa la pantalla.
- **Con qué se midió:** nivel A, B o C.
- **Cuánto cuesta**, en clics, pantallas, segundos o pesos.
- **Qué regla cobra**, de `DESIGN.md` o del estándar.
- **Decisión y estado.**

| ID | Paso | Sev | Hallazgo | Nivel | Costo | Regla | Decisión | Estado |
|---|---|---|---|---|---|---|---|---|
| GP.RF.3, 4, 6, 8, 9 | 0 | — | ver §4.5 | B | ver §4.5 | Retrabajo (`auditoria-diseno` §3c) | se confirman en su paso, con el puesto que los vive | ⬜ |
| GP.RF.10 | 0 | 🟠 | Tablero: el marco ocupa **415 de 768 px** (54 %) antes de la primera fila; 7 pestañas, 58 accionables y 108 cifras en la primera pantalla. Paso 1 (2026-11-17): igual, con 125 cifras. Con GP.10.4 en prod: 5 pestañas, 50 accionables, 83 cifras, pero **507 px** de marco (GP.RF.20) | A | más de media pantalla sin trabajo, en la pantalla más consultada | Carga visual (`auditoria-diseno` §3c); Q.1 | GP.10.4 ya quita 2 pestañas; el «después» se mide al desplegar | 🔨 |
| GP.RF.11 | 0 | 🟠 | Checar pide elegir el almacén en un `<select>` nativo antes de cualquier cosa | A | un clic de más en cada entrada | Hick; sistema de diseño (`p-select`) | paso 3: preseleccionar si la persona tiene un solo almacén | ⬜ |
| GP.RF.12 | 0 | 🟡 | Letra de 10 px en las 12 pantallas; hasta 9 niveles de letra (Revisión) | A | lectura forzada; jerarquía diluida | Q.5; escala `--fs-*` | se revisa pantalla por pantalla | ⬜ |
| GP.RF.13 | 0 | 🟡 | «1» en ámbar `--warn-fg` sobre blanco a 2.15:1 en Por capturar; «Salir» a 4.40:1 en Surtir | A | ilegible a pleno sol en el celular | WCAG AA; `VALORES.md` §2 | `--warn-soft-fg` para texto | ⬜ |
| GP.RF.14 | 1 | 🔴 | La fila de surtido muestra **25 surtidos abandonados** como si fueran trabajo de hoy. Canindo: 11, todos «Esperando hace 12 días». Morelia Abastos: 14, desde el 8-oct. En 30 días hubo 17 surtidos, los armó el sistema y se terminaron 5 | A + B | quien coordina no distingue el trabajo de hoy del abandonado; el surtidor que pide trabajo recibe primero el más viejo | Ley 0 del estándar (nada afirma lo que no es) | **P-RF.4**: que el sistema deshaga lo que armó y nadie tomó | ⬜ espera a Edgar |
| GP.RF.15 | 1 | 🟠 | «58 pedidos siguen autorizados en Kepler… revísalos en Kepler»: una cifra publicada que **no se puede abrir** en la Suite | A + B | ver cuáles era imposible sin salir de la Suite | Cruce 1 de `auditoria-diseno` (toda cifra se recorre) | la cifra liga al Tablero filtrado por estatus de Kepler; cuadra 393 de 393 (§5.4) | 🧪 |
| GP.RF.16 | 1 | 🟠 | El Tablero **no dice nada de los atorados** en su primera pantalla. Son 393 en 8 sucursales, el más viejo de nov-2025 | A + B | quien coordina no se entera de lo que nadie va a surtir | Q.1 (contestar primero); Q.4 (el número lleva a su arreglo) | aviso arriba del Tablero con la cuenta del alcance de la persona; pide que la API los cuente | ⬜ siguiente cambio |
| GP.RF.17 | 1 | 🟡 | Quien maneja varios almacenes cae en el primero (CEDIS, con la fila vacía) y da 2 clics para llegar al suyo. Después se recuerda | A | 2 clics la primera vez | Hick | abrir en el almacén que tiene trabajo; baja prioridad | ⬜ |
| GP.RF.18 | 1 | 🟡 | «Cancelar surtido» en rojo sobre blanco a **3.76:1** (bajo AA), una vez por renglón y junto a «Marcar urgente» | A | 6 textos bajo AA en la fila; una acción destructiva al alcance en cada renglón | WCAG AA; Von Restorff (§10) | el botón de peligro sin relleno viene del tema: arreglarlo ahí cambia toda la suite, y eso pide aprobar el cambio de tokens | ⬜ |
| GP.RF.19 | 1 | 🟡 | El Tablero con un rango largo (hasta un año) tarda **0.2 a 1.8 s** desde la laptop | B (servicio real) | la liga de los atorados puede pasar el medio segundo | regla de Edgar: más de 500 ms no funciona | va con GP.10.5 (la consulta lee todo el rango antes de filtrar el estatus) | ⬜ |
| GP.RF.20 | 1 | 🟠 | Con GP.10.4 el marco del Tablero creció de **415 a 507 px** (66 % de la pantalla): el cambio de vista ocupa un renglón propio, y se sumaron más botones de etapa y el aviso de tope | A (antes y después en prod) | 92 px más de marco en la pantalla más consultada | Carga visual; Q.1 | el cambio de vista pasa a la cabecera; el aviso de tope se va con GP.10.5 | ⬜ siguiente cambio |
| GP.RF.21 | 1 | 🟡 | Abrir un pedido de preventa pasó de **2 a 4 clics**: la preventa entró a una lista de 2,224 que va por fecha, y para verla hay que elegir el origen en un desplegable | A (antes y después en prod) | 2 clics más por consulta de preventa | Hick; menos clics (§1) | un botón «Preventa» con su conteo junto a los de etapa | ⬜ |

---

## 9. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-17 | **«Después» de GP.10.4 medido** en prod `5b9d9af58` (salió en el lote que empujó otra sesión). Mejora: de 7 a 5 pestañas, una sola pantalla para seguir un pedido, menos piezas. Empeora: marco 415→507 px, lista topada a 2,000 con 1.40 MB, y la preventa de 2 a 4 clics. Nuevos: GP.RF.20 y GP.RF.21 (§5.5) | Claude |
| 2026-11-17 | **Paso 1 medido** en prod `7edf9508a` (el «antes») con la sesión de Edgar. Quien coordina no ve lo atorado sin clic: el Tablero no lo dice, la fila lo cuenta sin dejar abrirlo, y 25 de sus 27 surtidos son abandonados. Se hizo GP.RF.15, la cifra de atorados liga al Tablero (cuadra 393 de 393) 🧪. Nuevos: GP.RF.14–19 y P-RF.4 | Claude |
| 2026-11-14 | Paso 0.3 medido con la sesión de Edgar (superadmin), en prod `d88bfc45a` (sin GP.10.4: es el «antes»). Separados por rol, cuatro de los siete hallazgos de base eran pruebas de Dirección o la vista de superadmin: se retiran o corrigen (§4.5). Nuevos: GP.RF.8–13 | Claude |
| 2026-11-14 | Nace el documento, a pedido de Edgar. Paso 0: instrumento con control y negativa ✅, blindaje contra escrituras en prod ✅, inventario y uso medidos, línea base por pantalla NO MEDIDA (falta la sesión, P-RF.1). Alcance acotado por Edgar al plan GP y a lo trabajado en la sesión | Edgar, Claude |
