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
| 1 | Consola maestra | `/almacen/pedidos` | coordinación, consulta | 34 | 682 lecturas (135 ms en promedio, máx. 823) | Q.1 · §2 · §9 | absorbió Preventa y Consola (en prod; meta medida en §5d) |
| 1a | — vista «Fila de surtido» | `/almacen/pedidos?vista=fila` | coordina el surtido | (5 por la ruta vieja) | 63 aperturas; armar 2 veces sin falla | Q.1 · §2 · §9 · O.4 | era la Consola de surtido |
| 1b | — detalle de un `PD-` | `/almacen/pedidos/preventa?pedido=` | encargado, Dirección | 2 | 69 lecturas · ligar 14 (sólo Dirección, octubre) | Q.1 · §2 · §9 | sin pestaña: detalle de preventa |
| 2 | Surtir (celular) | `/almacen/surtir` | surtidor | 73 | surtidores: «mis surtidos» 570 (14 ms) · «siguiente» 54 (173 ms, máx. 781) | Q.1 · §2 · §9 | sin cambio; E2 le agrega carreta |
| 2b | Surtir preventa (celular) | `/almacen/surtir-preventa` | surtidor de sucursal | 0 | 6,880 lecturas · terminar: **73 de 696 rechazados (10.5 %)** | Q.1 | retirada en GP.RF.32: quien surte llega a Surtir con su pedido |
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
1. **GP.RF.20** 🧪 (hecho el 2026-11-17), quitar el renglón propio de «Pedidos · Fila de surtido»:
   el cambio de vista va en la cabecera, junto al periodo.
   - **Medido con una maqueta sobre prod** (`paso1-gprf20.e2e.ts`). La maqueta abre el Tablero
     real, hace en el DOM lo mismo que la plantilla nueva (borra las reglas viejas y agrega la nueva)
     y vuelve a medir.
   - **Resultado:** la primera fila sube **50 px** en los tres anchos (507 → 457 px a 1280 y a 1366;
     428 → 378 px a 1920). La cabecera no crece y sus acciones siguen en un solo renglón. Las ligas
     llevan a donde llevaban.
   - **Prueba negativa:** si el cambio de vista ocupara su propio renglón, el instrumento lo cuenta.
   - **La primera maqueta midió mal,** y se corrigió antes de citarla. Dejaba vivo el CSS viejo de
     `.gp-vista`, con su alto de 44 px: la cabecera crecía 11 px y «Pedidos» salía negro sobre
     negro.
   - **Quien surte y coordina sin ver el Tablero** conserva el cambio de vista; antes vivía fuera de
     la cabecera, que para ese puesto no se pinta. Tiene su prueba.
   - **Medido en la versión real** (prod `4d99357f7`, 2026-11-17): la primera fila sube de 507 a
     **457 px** a 1280 y a 1366, y de 428 a **378 px** a 1920. Son los mismos 50 px de la maqueta. ✅
2. **GP.10.5** 🧪 (en código, 2026-11-17): la lista ya no se topa ni baja 1.4 MB.
   - **El «antes», medido en prod hoy** (`paso1-gp105.e2e.ts`, a 1280, 1366 y 1920): la lista baja
     **1.40 MB**, trae 2,000 de **2,358** pedidos del mes y queda quieta en 4.3–5.8 s.
   - **Lo que el tope escondía:** la preventa iba pegada al final de los de Kepler sin importar su
     fecha. Con el corte en 2,000, **348 de los 830 pedidos de preventa** del mes no se podían ver sin
     filtrar.
   - **El cambio:**
     - La API manda sólo la página que se ve (200), con `pagina.total`, y el paginador llega a todos.
     - La lista va por la fecha que pinta, con la preventa intercalada.
     - El más antiguo sin embarcar y las sucursales del selector salen de todo lo filtrado.
   - **D4:** el pie separa lo que va **a clientes**, el **traspaso a sucursales** (cliente `TI###`)
     y la **carga a ruta** (`RD`/`RUTA`). Es la misma partición de `ERP_KEPLER.md`. En noviembre,
     **$22.1 M de los $35.3 M** de Kepler eran traspasos que el pie sumaba como si fueran venta.
   - **La leyenda del volumen**: el gramaje que Kepler guarda como unidad se lee «6 de 500», ya no
     «6 500». La leyenda misma pasó al «?» de la cabecera con GP.RF.22 (§5.7).
   - ⛔ **Corrección. «El volumen se encima sobre el estatus» SÍ ocurre: 36 de 200 filas.** Aquí se
     había escrito que no ocurría (0 de 200, con control negativo de 200). Edgar lo vio en su pantalla
     (SUCURSAL YURECUARO: «1 CJA · 1 BTO · 20 PZA · 40 KG» sobre «Surtido»).
     - **Por qué el instrumento falló:** medía la caja del elemento, no el texto. Con
       `white-space: nowrap` el texto se sale de sus 11rem y la caja no.
     - **Por qué el control no lo delató:** el control movía la caja entera, así que medía lo mismo
       que el instrumento.
     - **El instrumento corregido** mide los renglones del texto pintado y encuentra **36 de 200** en
       los tres anchos, YURECUARO incluida.
     - **El arreglo va en GP.RF.22.** Con su maqueta sobre prod (quitar la clase que impide partir el
       texto), las encimadas bajan de **36 a 0**.
   - **NO MEDIDO:** el «después» en la pantalla viva; se mide con la misma prueba al desplegar.
3. **GP.RF.21**, la preventa a un clic: un botón «Preventa» junto a los de etapa, con su conteo, en
   lugar del filtro de origen en dos clics.

**Un defecto de GP.RF.15 que encontró el recorrido en prod** (`paso1.e2e.ts`, después de desplegar):
- **Qué pasaba:** la liga de los atorados de Canindo abre el Tablero con las **58** filas correctas,
  pero la nota de arriba decía **1,885**. Sumaba los conteos de los botones de etapa, que a propósito
  no llevan el filtro de estatus.
- **Por qué no lo vieron las pruebas:** la prueba del filtro revisaba qué se pedía y que la nota
  existiera, no el número que publicaba.
- **El arreglo:** la nota dice el total filtrado. Va con su prueba negativa, que salió roja antes del
  arreglo, en el mismo commit que GP.10.5.

### 5.6 Lo que queda del paso 1

- **GP.RF.14, los surtidos abandonados en la fila:** es una regla del proceso y la decide Edgar
  (P-RF.4, §7).
- **GP.RF.16, el aviso de atorados en la primera pantalla del Tablero:** pide que la API cuente los
  atorados del alcance de la persona, porque el Tablero es por mes y los atorados son de meses
  anteriores. Es el siguiente cambio de este paso.
- **GP.RF.17 a GP.RF.19:** en el registro (§8).

### 5.7 GP.RF.22 — el Tablero con menos cosas (2026-11-17) 🧪

Edgar, viendo el Tablero ya con GP.10.5: *«esta interfaz no me convence, existen demasiadas cosas.
Hay que rediseñar un poco»*. Antes de tocar la plantilla se contestaron las preguntas de `diseno`
§0a/§0b.

1. **Propósito, en una frase:** ¿qué pedidos siguen en el almacén y en qué etapa va cada uno?
2. **Quién entra (30 días, `analytics.ui_usage`):**
   - Quien coordina embarques: 158 cargas de la lista y 23 aperturas de detalle.
   - Encargado de tienda: 130 cargas; auxiliar de tienda: 101.
   - El surtidor (109) tiene su vista reducida, que no cambia.
   - En total, **793 cargas de la lista contra 59 aperturas de detalle**: la pantalla se usa para
     ver el estado, casi no para abrir pedidos.
3. **El estado real:** de 2,389 pedidos del mes, **1,396 ya estaban embarcados** (58 %) y abrían la
   lista. El trabajo del almacén eran 983 (autorizado 136, surtiendo 6, surtido 65, checado 776).
4. **Qué ve al entrar (decisión de Edgar, entre dos maquetas):** «Por hacer», lo que sigue en el
   almacén. «Todos» y cada etapa quedan a un clic.
5. **Qué deja de ver, y por qué:**

| Pieza de antes | Decisión | Por qué |
|---|---|---|
| Lista de entrada «Todos», con los embarcados | **«Por hacer»** | el 58 % de lo que se veía ya había salido |
| Casilla «Sólo autorizados en adelante» | sale | «Por hacer» ya es eso |
| Periodo: 4 botones y un calendario siempre visibles | **un desplegable**; el calendario sólo con «Otro rango…» | 5 controles para una decisión que casi no cambia |
| Surtir y Checar en naranja relleno | **de contorno** | son puertas a otras pantallas; dos rellenos competían por ser «lo principal» de una pantalla que es de lectura |
| Columna «Abierto» | **bajo la fecha**, como «hace 6 min», sólo si sigue abierto | en los embarcados siempre decía «—» |
| Columna «Guía» | **bajo la etapa**, como «guía 0002066», sólo si existe | casi siempre decía «—» |
| Texto «sólo lectura, el pedido se avanza en Kepler», las definiciones en `title` y la leyenda de unidades | **al «?»** de la cabecera (tema `almacen-pedidos` del diccionario) | eran párrafos que se leían una vez; además el `title` no existe sin mouse (regla P) |
| Volumen encimado sobre la etapa (36 de 200 filas) | **se parte en renglones** dentro de su celda, sin cortar «20 PZA» | ver §5.5 |

6. **Cifras y desglose:** cada botón de etapa filtra la lista. El pie separa a clientes, el
   traspaso y la carga a ruta (D4). El pedido se abre en el panel lateral, igual que antes.
7. **Lo que se conserva:** el cambio de vista Pedidos / Fila de surtido, los filtros de origen y
   sucursal, el buscador, el panel lateral, la liga de los atorados y la vista del surtidor. La liga
   de los atorados entra a «Todos», no a «Por hacer»: su cifra es por estatus de Kepler, y por etapa
   no cuadraría.
8. **Conteo, sin las 5 pestañas del grupo:**
   - Antes de la primera fila: de 22 a 19 controles.
   - Columnas: de 9 a 6, o 7 con la de sucursal.
   - Rellenos naranjas en la cabecera: de 2 a 0.
   - ⚠️ **Al pedirle a Edgar la decisión se le dijo «~15 en vez de 27». Era una estimación y se
     corrige:** con las pestañas son 24 contra 27. Lo que más baja no es el número de controles sino
     lo que se lee: la lista de entrada (2,389 → 983), el texto de la cabecera y dos columnas.
9. **NO MEDIDO:**
   - La pantalla viva con el cambio: se mide con `paso1-gp105.e2e.ts` al desplegar.
   - Los 390 px.
   - Si quien coordina extraña algo de lo que salió: eso se pregunta a quienes la usan después de
     una semana.

---

## 5b. Ubicaciones: capturar (2026-11-17, adelantado por Edgar: «el primer paso es capturar las ubicaciones»)

**Cómo se midió.** `ubicaciones.e2e.ts` recorre las pantallas de punta a punta en prod (`8a48dc0a7`),
como superadmin:
- **Mapa:** alta suelta con 8 códigos, buenos y malos.
- **Captura masiva:** un rango de 180 ubicaciones y un Excel de 8 renglones.
- **Lotes:** el «Deshacer».
- **Asignación:** a mano y por Excel.
- **Contenido.**

Pasan las lecturas y las dos vistas previas, que sólo planifican: se revisó en el código. Se
detuvieron dos escrituras (alta y «Crear 180»), y quedó registrado lo que habrían mandado.

**El estado (nivel B):**
- **Padre Hidalgo, el piloto, no tiene ninguna ubicación.**
- **Ningún producto tiene lugar fijo,** en ningún almacén. En CEDIS son 0 de 9,045.
- **CEDIS tiene 375 que parecen prueba:** salieron de una sola captura del 8-oct, el día en que se
  construyó la captura masiva. Usan la zona **T · Tienda** (un CEDIS no tiene tienda), pasillos A–C,
  racks 01–25 y niveles 1–5, con tipo «Tienda · piso». Además estorban: un lugar fijo de surtido exige
  bodega (B), así que **en CEDIS no se le puede asignar ninguno a un producto**.

| ID | Sev | Hallazgo | Nivel | Estado |
|---|---|---|---|---|
| UB.RF.1 | 🔴 | **Una cifra que se anima se quedaba con el valor anterior.** Al buscar «mazapan», la API dijo 46 y la tira pintó 9,045; al borrar la búsqueda, al revés. Causa: `count-up.directive.ts` no cortaba la primera animación y ésta tapaba el valor nuevo. Afecta a **toda** tira de cifras que cambie en su primer segundo | A + API | 🧪 arreglado, con 3 pruebas (la prueba salió roja antes del arreglo) |
| UB.RF.2 | 🔴 | Las 375 de prueba en CEDIS, en zona Tienda | B | ⬜ **decisión de Edgar:** deshacer el lote (se puede: 0 en uso) |
| UB.RF.3 | 🟠 | El mapa vacío decía «la captura masiva por rango llega en la siguiente entrega», y ya existe | A | 🧪 el texto ahora manda a «Captura masiva» |
| UB.RF.4 | 🟠 | «Últimas capturas» decía «Todavía no hay» mientras leía y también si fallaba (CEDIS sí tenía una) | A + API | 🧪 dice «Leyendo…», el error con «Reintentar», o «no hay» sólo si no hay. La respuesta de otro almacén ya no tapa la del nuevo. 5 pruebas |
| UB.RF.5 | 🟡 | El mapa abre en «Bodega (0)» aunque todo esté en Tienda | A | 🧪 abre en la zona que tiene ubicaciones. 3 pruebas |
| UB.RF.6 | 🟡 | En el formulario por rango, el selector de Tipo usa `ngModel` sin `name` (NG01352): rompe en modo desarrollo | A (prueba) | 🧪 `name="tipo"` |
| UB.RF.7 | 🟡 | Cada pantalla (Mapa, Asignación, Contenido) pide el almacén otra vez, y Contenido abre vacío | A | 🧪 2026-11-18: las tres comparten el almacén elegido (sólo dentro del alcance) y lo nombran sin número; Contenido abre en él, en el de la persona o en el único (§5c.9) |
| UB.RF.8 | 🟡 | «0» de «Con lugar fijo» en verde, a 3.0:1 (bajo AA) | A | 🧪 2026-11-18: la cifra y el delta del resumen de métricas van en `--ok-soft-fg` (7.13:1), §5c.9 |
| UB.RF.9 | 🟡 | «Se crea 180 de 180» (es «Se crean») | A | 🧪 2026-11-18: el resumen concuerda con su cuenta, §5c.9 |
| UB.3b.1 | ⭐ | **Pedido de Edgar:** asignar con lector de código de barras, y que capturar la ubicación sea también asignar lo que está ahí. **Hecho como modo «Escanear» en Asignación:** se escanea el cartel y después cada producto. La presentación sale del código de barras (medido en prod: el del paquete y el de la caja de un mismo producto llevan a su presentación) y el papel, de la ubicación. Una ubicación que no existe se da de alta en el acto; si el producto ya tiene lugar fijo en otra, ofrece moverlo. Las lecturas rápidas esperan en fila. En el buscador normal, una búsqueda que deja un solo producto lo abre, y si fue su código de barras, abre la asignación de esa presentación con el campo de ubicación listo | C (23 pruebas) | 🧪 sin escribir en prod; `ubicaciones-escaneo.e2e.ts` lo mide al desplegar (hoy se salta: NO MEDIDO) |
| UB.RF.11 | 🔴 | **Asignación dice «0 % ya ubicado» cuando lo asignado sí se guardó** (lo preguntó una persona de Padre Hidalgo por WhatsApp, 2026-11-19). Sus 8 asignaciones eran «Exhibición en tienda» (TA011), y la pantalla sólo cuenta como «lugar fijo» el de surtido en bodega. Además, PH no tenía ninguna ubicación de bodega, el camino a mano no la crea («dala de alta primero»), el aviso rojo sale antes de escribir y el ejemplo «BA053» parece un valor. Ese día, 6 de 17 asignaciones rechazadas sin motivo registrado. Edgar: rehacerla desde cero, práctica y accesible | B + captura del usuario | 🧪 2026-11-19: «Ubicar productos» rehecha con la maqueta aprobada (FASE_UB §8.2): un campo para producto o ubicación, la ubicación que falta se crea en el acto, la cola por venta de 30 días (160–237 ms en prod), cifras «con lugar para surtir · en tienda», Deshacer y el rechazo con su motivo. 22 pruebas (6 en rojo con el arreglo roto); sin validación visual. **En prod 2026-11-19 17:16** (`/api/health` sirve `64064dd4f`): la prueba de integración pasa 21 de 21 contra Postgres real en el CI, la API sin errores, y la lista nueva ya corrió 5 veces en prod (219 ms de promedio, 250 de máximo) |
| UB.RF.12 | ⭐ | **Pedido de Edgar:** en la tienda un cartel de media carta le quita vista al producto; hace falta una etiqueta chica con código de barras para leerla al ubicar. Mapa › Imprimir elige el tamaño: en tienda, **etiqueta de 6.7 × 2.5 cm, 30 por hoja carta** (tipo 5160) para el canto del anaquel; en bodega, el cartel. Mismo componente y mismo CODE128 (40 mm, ~0.36 mm por módulo) | A (PDF en un navegador sin ventana) + C (5 pruebas) | 🧪 2026-11-19: 30 = 1 hoja, 31 = 2; cada etiqueta 66.67 × 25.40 mm en su lugar de la plantilla con 0.000 mm de desviación. NO MEDIDO: el empalme con la marca de etiquetas que compren y la lectura con la pistola de la tienda |
| UB.RF.10 | ⭐ | **Pedido de Edgar:** imprimir uno o muchos carteles con el código. «Imprimir carteles» en el Mapa, por zona o por pasillo, y en cada rack para sus niveles o uno solo. Usa el cartel que ya existía (código grande, código de barras, almacén, dos por hoja carta) | C (3 pruebas) | 🧪 se mide al desplegar, con la misma prueba |

**Lo que funciona bien y se conserva:**
- Cada regla del código dice su motivo («sin Ñ: el código de barras no la lee», «el nivel va del 1
  al 6»), y acepta minúsculas.
- Hay una vista previa antes de crear. El Excel da el motivo por renglón y marca los repetidos.
- «Deshacer» por lote, con confirmación.
- El mapa se recorre con las flechas.
- La asignación sólo ofrece las presentaciones que Kepler tiene en esa sucursal, y dice por qué
  rechaza las demás.

**NO MEDIDO:**
- las escrituras reales y los mensajes del servidor al guardar;
- el celular;
- el uso desde el puesto que captura (encargado o almacenista);
- Contenido con mercancía (hay 0 ubicaciones con mercancía).

---

## 5c. Paso 2 — Surtir en el celular: línea base (2026-11-17)

**La pregunta:** ¿el surtidor termina un pedido sin pensar qué tocar?

**Cómo se midió:**
- Nivel B: el uso de 30 días en `analytics.ui_usage` y los reportes de cierre en
  `commercial.presale_picks`.
- Nivel A: `paso2-surtir.e2e.ts` en prod, a 390 × 844 y táctil, como superadmin y sin escribir.
  - «Empezar a surtir», «Tomar siguiente» y «Terminar» no se tocan.
  - Lo que una pantalla intentó escribir por su cuenta se detuvo y se anota.

### 5c.1 Dónde surten de verdad

⛔ **Corrección del mismo día.** La primera versión de esta tabla atribuía la preventa a la pantalla
`/almacen/surtir-preventa`, porque los conteos venían de su servicio (`presale-picking`). Es falso:
desde `[MCP.3.1]` (19 de octubre) el surtidor surte la preventa en **Surtir, modo «Sucursal»**, que
usa el mismo servicio. Lo delató la telemetría: 748 métricas web desde celular en `/almacen/surtir` y
**ninguna** en `/almacen/surtir-preventa`.

| Pantalla | Uso del surtidor en 30 días |
|---|---|
| **Surtir** (`/almacen/surtir`), modo **«Sucursal»** (preventa de las vendedoras) | 1,056 pedidos empezados y 925 cierres (84 rechazados); la lista se vuelve a pedir cada 30 s |
| **Surtir** (`/almacen/surtir`), modo **«Telemarketing»** (pedidos de Kepler) | 66 «tomar siguiente» y 40 renglones marcados |
| **Surtir preventa** (`/almacen/surtir-preventa`) | sin telemetría en 30 días: **NO MEDIDO** quién la usa |

El trabajo diario es la preventa: 891 pedidos cerrados en 30 días, con 4,487 renglones (unos 5 por
pedido). 219 pedidos (25 %) tuvieron algo que faltó.

### 5c.2 Hallazgos

| # | Hallazgo | Nivel | Costo |
|---|---|---|---|
| **GP.RF.23** | **Uno de cada 11 cierres se rechaza** (84 de 925, todos 4xx: validación, no caídas). El motivo **no queda en ningún lado**: el servidor no lo guarda y la telemetría de la app no registra errores. El mensaje sólo dura 8 s en pantalla. Los rechazos se concentran del 4 al 14 de noviembre (hasta 16 en un día); el 16 y el 17 bajan a 1 de 164 sin un cambio de código visible. Leyendo el código, los candidatos son cambiar un producto por otro (existencia, unidad, cantidad) y dos personas sobre el mismo pedido. El doble toque y el motivo faltante quedan descartados: el botón se apaga en el primer toque y cada faltante lleva un motivo por omisión | B + C | un cierre rechazado es volver a marcar y a enviar |
| **GP.RF.24** | ⚠️ *De `/almacen/surtir-preventa`, que el surtidor no usa (ver la corrección de §5c.1); falta medir lo mismo en Surtir › Sucursal.* **En la bandeja, el primer pedido está a 958 px**: no se ve en un celular de 844 sin bajar. Antes de él hay 51 controles: la lista de sucursales (5 renglones), las pestañas de día y «Otro día», el aviso de **35 pendientes de días anteriores** con 11 botones de fecha, y el filtro de vendedor con 8 opciones en renglones | A (superadmin) | ⚠️ el surtidor ve una sola sucursal: su marco es menor. **NO MEDIDO** con su puesto |
| **GP.RF.25** | ⚠️ *También de `/almacen/surtir-preventa`.* **«Hoy · 39» y la lista de 115 no cuentan lo mismo**: la pestaña cuenta lo pendiente y la lista pinta todo lo de hoy, incluido lo ya surtido y revisado. El rótulo no dice «por surtir» | A + C | se lee como si sobraran 76 pedidos; lo pendiente se mezcla con lo terminado |
| **GP.RF.26** | **No hay «No hubo»**: para marcar que no hubo nada de un renglón se toca «−» hasta 0. En 30 días, 380 renglones costaron **1,073 toques** contra 380 con un botón. La mediana es 1 pieza (un toque); el costo se concentra en 59 renglones de 4 o más piezas, con un máximo de 60 | B | ~700 toques al mes; bajo |
| **GP.RF.27** | **Surtir (Kepler) escribe al abrirse**: entrar a la pantalla pide «tomar trabajo» (`POST waves/next`) sin que la persona toque nada | A | quien entra sólo a ver se lleva un pedido |
| **GP.RF.28** | Surtir (Kepler): **17.6 s** hasta quedar quieta como superadmin (GP.RF.9). El almacén se elige en un `<select>` nativo con código («06 · Canindo»), y no tiene `<h1>` | A | la regla de nombrar la sucursal; el sistema de diseño (`p-select`) |
| **GP.RF.29** | Surtir (Kepler) avisa **«500 clientes nuevos sin clave de Kepler»**. Hoy son exactamente 500, así que cuadra por casualidad, pero el resumen cuenta lo que cabe en la bandeja (tope de 500) y no mira su aviso de tope: **desde el cliente 501 seguirá diciendo 500** | B + C | una cifra que va a mentir sin avisar (Cruce 1) |

### 5c.3 Tiempos de carga

**El servidor**, por llamada y por puesto (30 días, `analytics.ui_usage`; separado por rol porque
superadmin ve todos los almacenes y tarda mucho más). Entre paréntesis, las llamadas del surtidor:

| Llamada | Para qué | Surtidor: promedio | Surtidor: peor | Superadmin: promedio |
|---|---|---:|---:|---:|
| `GET presale-picking` (8,048) | la lista de Sucursal, cada 30 s | 23 ms | 593 ms | 27 ms |
| `GET presale-picking/:id` (1,063) | abrir un pedido | 150 ms | **2.9 s** | 111 ms |
| `POST …/start` · `…/finish` | empezar · terminar | 35 ms · 45 ms | 0.4 s · 1.5 s | 32 ms · 171 ms |
| `GET new-customers/summary` (1,500) | el aviso de clientes nuevos | 217 ms | 1.8 s | 83 ms |
| `GET waves/mine` (727) | «mis surtidos» de Telemarketing | 308 ms | **25.1 s** | 3.5 s |
| `POST waves/next` (66) | «tomar siguiente» de Telemarketing | **2.7 s** | **21.1 s** | 7.6 s |

**El celular** (métricas web de la app, 30 días, sólo celular, `/almacen/surtir`):

| Métrica | Mediana | 75 % de las veces | 95 % de las veces | Lo que se considera bueno |
|---|---:|---:|---:|---|
| Pintar lo principal (LCP, 100 muestras) | 2.1 s | **4.5 s** | **26.4 s** | ≤ 2.5 s el 75 % |
| Responder a un toque (INP, 410) | 120 ms | 152 ms | 346 ms | ≤ 200 ms el 75 % |
| Cuánto se mueve la pantalla (CLS, 238) | 0.13 | **0.23** | **0.45** | ≤ 0.1 el 75 % |

Lo que dicen:
- **Surtir la preventa es rápido del lado del servidor**: la lista, empezar y terminar tardan
  decenas de milisegundos. Sólo abrir un pedido tiene picos de casi 3 s.
- **Lo lento es Telemarketing**: «tomar siguiente» tarda 2.7 s en promedio y llegó a 21 s;
  «mis surtidos» llegó a 25 s. Por eso Surtir tardó 17.6 s en quedar quieta en la línea base. La
  regla del proyecto es medio segundo.
- **En el teléfono, la pantalla tarda 4.5 s en pintarse una de cada cuatro veces**, y una de cada 20
  más de 26 s. Una pantalla que abre en Telemarketing puede pedir «mis surtidos» y «tomar siguiente»
  al entrar (GP.RF.27): es la sospecha a confirmar.
- **La pantalla se mueve** (CLS 0.23 el 75 % de las veces): lo que aparece tarde, como el aviso de
  clientes nuevos o la lista que se vuelve a pedir cada 30 s, empuja lo que el surtidor iba a tocar.
  En un celular eso es tocar el pedido equivocado. **NO MEDIDO** qué pieza lo mueve.
- Tocar responde bien (INP 152 ms).

### 5c.4 Lo que no se pudo medir y qué hace falta

- **Los controles de un renglón (Completo, −, +, Cambiar), su tamaño y los toques por pedido**
  necesitan la **sesión de un surtidor** (P-RF.1). Como superadmin, el pedido en curso de otra persona
  se abre sin sus controles, y empezar uno propio sería una escritura. Por código, los botones piden
  44 px (`--tap-min`).
- **El motivo de cada rechazo (GP.RF.23)** no se puede saber con lo que hay: hace falta registrarlo
  cuando ocurre. Se propone un evento con el código y el mensaje del rechazo, sin datos del cliente.
- **Tres caminos para surtir preventa:** Surtir preventa, Surtir › Sucursal (por ruta) y la consola.
  Saber si se funden (paso 2b) pide recorrer los tres con el surtidor.

### 5c.5 Surtir, rehecho con lo que el surtidor necesita (2026-11-17) 🧪

Edgar: *«arreglemos y volvamos a generar la interfaz de surtir con toda la información o herramientas
necesarias»*. Las tres decisiones se las preguntamos y las tomó él: avisar en lugar de retomar, las
cuatro herramientas del renglón y retirar la pantalla duplicada.

**Lo que el surtidor no tenía, leyendo la pantalla que sí usa (Surtir › Sucursal):**
- Al abrir, la pantalla escribía y esperaba a Telemarketing antes de mostrar la preventa.
- Los renglones de preventa no decían dónde está el producto (la ubicación iba vacía a propósito).
- No había «cambiar por otro producto»: sólo existía en `/almacen/surtir-preventa`, que nadie usa.
- Escanear sólo buscaba el producto; no lo marcaba.

**Lo que cambia, por fase (cada una con su commit local):**

| ID | Cambio | Pruebas |
|---|---|---|
| **GP.RF.27** | Abrir no escribe ni espera a Telemarketing: la lista de preventa sale de inmediato, y un surtido de Telemarketing a medias se avisa con «Continuar» | 2 negativas nuevas; las 3 de «retomar» se reescribieron a la decisión |
| **GP.RF.28** | El almacén por su nombre en un `p-select` (antes `<select>` nativo con «06 · Canindo»); con uno solo, sólo el nombre | la de almacenes ahora exige el nombre y prohíbe el número |
| **GP.RF.31** | «Cambiar por otro producto» en el renglón con faltante, junto a «Surtir en otra unidad»: sugerencias con existencia, buscar, unidad y cantidad. Un producto que ya va en otro renglón se ofrece apagado, porque el servidor rechazaría el cierre (posible parte de los 84 rechazos, GP.RF.23) | 3 (2 negativas) |
| **GP.RF.32** | `/almacen/surtir-preventa` se retira: quien surte llega a Surtir con su `?pedido=`; quien sólo ve la preventa (4 puestos, medidos en prod), al Tablero filtrado. Sale del menú | 3 de la redirección (1 negativa) |
| **GP.RF.33** | Escanear el código de la presentación pedida marca Completo y deja el campo listo para el siguiente. Si es otra presentación (la caja cuando se pidieron paquetes), avisa y no marca. El servidor manda los códigos de cada presentación de Kepler | 6 de la regla + 2 de pantalla (3 negativas) |
| **GP.RF.34** | Cada renglón dice su ubicación (Ubicaciones: lugar fijo, luego tienda, luego reserva) y los renglones van en el orden del recorrido. Sin el dato del servidor, no se afirma «sin ubicación» | 6 del servidor + 2 de pantalla (2 negativas) |

**NO MEDIDO:**
- Todo esto en prod: está en commits locales, sin desplegar.
- El celular real: hace falta la sesión de un surtidor.
- La ubicación y el recorrido en Padre Hidalgo: tiene **0 ubicaciones**, así que dirá «sin
  ubicación» en todos los renglones hasta que se capturen.
- Si los códigos de Kepler de cada presentación están completos: un producto sin código en su
  presentación no se puede marcar escaneando, y la pantalla hace lo de antes.

### 5c.6 La estructura de Surtir, rehecha (GP.RF.35, 2026-11-17) 🧪

Al ver la pantalla después de 5c.5, Edgar dijo: *«eso quiere decir que no reestructuraste la
interfaz»*. Tenía razón: 5c.5 agregó herramientas sobre la misma estructura. Se le propuso una
maqueta de la lista y del pedido abierto, y la aprobó («Así, hazlo»).

**Las cinco preguntas (`diseno` §0b), contestadas antes de tocar la plantilla:**

1. **Qué ve primero.**
   - En la lista: los pedidos de hoy, con lo que ya está surtiendo arriba.
   - En el pedido: dónde está cada producto y cuánto llevar.
2. **Qué no ve.**
   - El aviso de clientes nuevos arriba de todo: no es su tarea, va al final.
   - Un botón naranja por pedido: la tarjeta entera se toca.
   - La lista de folios de lo de Telemarketing a medias: basta el folio y cuántos pedidos son.
3. **Accesibilidad.**
   - Botones de 44 px o más con el dedo.
   - El texto ámbar y verde pasa AA (antes 2.15:1 y 3.30:1).
   - El escáner queda fijo arriba al desplazarse.
4. **Ligas.**
   - «← Pedidos» regresa a la lista sin cerrar el pedido; lo marcado sigue en el celular.
   - El aviso de clientes lleva a ligarlos.
5. **¿Le toca a esta pantalla?** Sí: es la única donde se surte la preventa (§5c.1).

**Lo que cambia:**

| ID | Cambio |
|---|---|
| **GP.RF.35** | **Lista:** almacén y origen en un renglón; el origen «Sucursal» se rotula «Preventa». Los días atrasados van en un renglón que se desliza (antes se envolvían en 5). Cada pedido es una tarjeta que se toca entera; el naranja queda sólo en «Continuar» de lo propio. El pedido que surte otra persona no se puede tocar y dice quién. El aviso de clientes va al final. La lista dice cuándo se cargó. Lo de Telemarketing a medias ocupa un renglón. **Pedido:** el encabezado es el pedido (cliente, folio y vendedor) con «← Pedidos». El escáner y el avance quedan fijos arriba. Cada producto empieza por su ubicación y lleva nombre y cantidad en un renglón; el botón dice «Faltó». Abrir un pedido, o volver, empieza arriba |
| **GP.RF.29** | El aviso de clientes nuevos dice «Más de 500» cuando la lista se topó: el resumen ahora declara `truncated`. Antes decía «500», que parecía exacto |
| **GP.RF.36** | «Rutas de hoy» ya no pinta su esqueleto de 181 px en la primera carga. Sin rutas (lo común por la tarde: 0 de 9 sucursales a las 18 h del 2026-11-17), el bloque aparecía y se iba, y la lista saltaba. Con rutas (171 en 25 de los últimos 30 días), entran una vez, como antes entraba el esqueleto |
| **GP.RF.37** | Dos defectos de la misma hoja de estilos: la nota «búscalo en bodega» compartía la clase `.sr-buscar` con el escáner y le ponía su borde ámbar; y 10 reglas usaban `--warn-fg`/`--ok-fg` como color de texto. Ahora usan `--warn-soft-fg`/`--ok-soft-fg`: 7.09:1 y 7.13:1 sobre blanco, 12.3:1 y 12.6:1 en oscuro, con sus controles de 21.00 y 4.48 |

**Medido con Playwright (nivel A)**, 390 × 844 táctil, sesión de Edgar, en La Piedad Abastos (el
almacén con más preventa ese día: 41 pedidos). Lado nuevo: el frontend de este árbol con las
lecturas pedidas a prod desde Playwright. «Empezar a surtir» se contesta en la prueba sin llegar a
ningún servidor y toda otra escritura se aborta. Instrumento:
[`surtir-rehecho.e2e.ts`](../../../e2e/reestructura/surtir-rehecho.e2e.ts).

| | Primera medición del árbol | Final |
|---|---|---|
| Dónde empieza la primera tarjeta | 1,001 px (abajo del pliegue de 844) | **504 px** |
| Al volver con «← Pedidos» | 685 px (el esqueleto de rutas) | **504 px**, sin escrituras |
| Primer renglón del pedido al abrirlo | −1,381 px (abría a media lista) | **281 px** |
| Escáner al desplazar | no se pudo probar (pedido de 1 renglón) | **fijo**: 170 → 102 px, en un pedido de 11 |
| Tarjetas con texto encimado | 1, falso positivo del instrumento (comparaba las dos líneas de un mismo nombre) | **0** |
| Botones de 44 px o más | el selector de almacén medía 35 | todos, salvo la flecha interna del selector (14 px, dentro de un control de 44) |
| CLS de la carga | — | 0.06 (una medición; el aviso de Telemarketing a medias llega aparte y empuja la lista) |

Controles del instrumento:
- Ninguna petición `/api` ni `/socket.io` llegó al backend local. La negativa: al dejar sin anotar
  una lectura, el detector la reporta.
- Con la cantidad montada encima del nombre a propósito, el detector de encimado cuenta las 13
  tarjetas.
- Producción, todavía sin desplegar, se reconoce como la versión vieja.

El «antes» en prod no se pudo comparar tarjeta por tarjeta. La pantalla vieja intenta tomar trabajo
al abrir; esa escritura se aborta, y con el mismo almacén mostró «Hoy · 0». La comparación contra lo
viejo es la captura de Edgar y la línea base de §5c.

**Pruebas:**
- Surtir: 109, de ellas 8 nuevas de GP.RF.35 y GP.RF.29 (3 negativas).
- Rutas de hoy: 2 nuevas (1 negativa).
- Resumen de clientes nuevos en el servidor: 1 nueva.
- Almacén completo: 815 en verde; `ngc --noEmit` sobre el árbol, 0 errores.

**NO MEDIDO:**
- **La ubicación arriba de cada producto en el navegador.** Prod todavía no manda los códigos por
  presentación (GP.RF.33/34 sin desplegar). Sin ellos la pantalla no afirma «sin ubicación», así que
  hoy no la pinta. Sólo está cubierta por pruebas unitarias.
- El celular real y el puesto de surtidor.
- Cuánto baja el CLS de 0.23 en campo: se verá en `portal_telemetry_events` después de desplegar.
- El desplegable de almacén con un solo almacén (el surtidor típico): se probó en unidad, no en
  navegador.

### 5c.7 Re-auditoría con Modern Web Guidance (GP.RF.38–40, 2026-11-18) 🧪

Edgar pidió *«usa la skill Modern Web Guidance para volver a auditar lo auditado»*. Se consultaron
12 guías de `modern-web-guidance` (GoogleChrome, versión 2026_11_10):
- `card`, `accessibility`, `color`, `forms`;
- `state-aware-sticky-headers`, `scrollability-affordance-hints`, `form-factor-adaptation`;
- `performance`, `natural-interactions`, `content-first-noise-reduction`;
- `stack-drill-down`, `visually-stable-font-fallbacks`.

Se midió lo que esas guías piden y que §5c.6 no había medido.

**Cómo se midió.**
- La sesión de producción venció (la API contestó 401) y no se pidió otra.
- Se midió con Playwright sobre el frontend de este árbol, a 390 × 844 táctil, con una **API
  sintética** (`e2e/reestructura/sintetico.ts`):
  - la sucursal, las vendedoras y los clientes son inventados, con la forma de los contratos;
  - ninguna petición sale del navegador (el control lo cuenta: 0).
- Instrumento: `e2e/reestructura/surtir-mwg.e2e.ts`.
- El «antes» se tomó antes de tocar el código, con el mismo instrumento.

| Qué pide la guía | Antes | Después |
|---|---|---|
| El gesto «atrás» del celular con un pedido abierto regresa a la lista (`stack-drill-down`) | **salía de Surtir** a «Mi trabajo» (`/projects`) | regresa a la lista sin cerrar el pedido. El pedido abierto queda en la URL (`?pedido=`, la misma del aviso de la campana): una recarga lo vuelve a abrir |
| El foco al abrir un pedido (`accessibility` §5) | se quedaba en `<body>` | va al encabezado del pedido (el h1 con el cliente) |
| El foco al volver a la lista | `<body>` | la tarjeta del pedido que se dejó, sin mover la vista |
| Un encabezado principal y niveles en orden (`accessibility` §1) | 0 h1; los grupos en h3 | h1 «Surtir» en la lista y h1 con el cliente en el pedido; los grupos en h2 |
| Las flechas eligen en «Pedidos de», el día y el vendedor (el rol `radio` las promete) | **no elegían** (defecto global, GP.RF.39) | eligen; una sola parada de Tab por grupo |
| El renglón que se desliza dice que hay más (`scrollability-affordance-hints`) | barra oculta y ninguna pista: 3 de 6 vendedores fuera de la vista sin que nada lo dijera | el borde que tiene más se desvanece (24 px) y el desplazamiento se detiene en cada chip. Sin soporte de animaciones por desplazamiento, la barra se queda visible |
| El anillo de foco de esos chips | cortado 4 px arriba, 2 abajo y 4 a la izquierda | 0 |
| En alto contraste de Windows se ve cuál está elegida (`color`) | sólo por la negrita | contorno del sistema (`Highlight`) además de la negrita |
| Ningún control enfocado queda tapado por el escáner o el pie fijos (WCAG 2.4.11) | 0 de 28 | 0 de 28: no hacía falta cambiar nada |
| CLS de la carga | 0.056 | 0.057: no cambia, la causa es global (GP.RF.40) |

**Controles del instrumento:**
- Ninguna petición a la API salió sin pasar por el instrumento.
- **Foco tapado:** un botón puesto a propósito bajo el escáner fijo sale tapado (0 de 5 puntos visibles).
- **Alto contraste:** se mide sin foco. Una primera corrida lo midió con foco y el anillo contaminó
  la comparación; se corrigió antes de citarla.

**Pruebas:**
- **Surtir:** 114 pasan, 5 de ellas nuevas (2 negativas):
  - atrás regresa a la lista;
  - «← Pedidos» saca su entrada del historial;
  - abierto desde la campana no empuja otra entrada;
  - un «atrás» sin pedido abierto no toca nada;
  - el foco va al h1 y regresa a la tarjeta.
- **`radio-group-nav`:** 6 nuevas. Las 3 del defecto salieron **rojas** con el código anterior; la
  negativa comprueba que no toca un grupo que se administra solo.
- **Totales:** almacén 820, `ui-web` 165, `ngc --noEmit` 0 errores.
- **Compuertas:** check:pantalla, check:estilos, check:cifra y check:cascada sin fallas nuevas.

**GP.RF.39: las flechas de todos los `role="radio"` sin teclado propio.**
- **Qué falla.** `installRadioGroupNav` (`libs/ui-web`) da el teclado a los grupos que no lo traen.
  Cada cambio de foco se escribe con `el.tabIndex`, y eso pone el atributo `tabindex`. Su propio
  criterio de «este grupo se administra solo» —que alguna opción traiga `tabindex`— lo tomaba desde
  ese momento como ajeno. Resultado: la flecha no hacía nada en ningún grupo que el listener ya
  hubiera tocado. Además, tras elegir con el dedo, el tabulador seguía entrando por la opción vieja.
- **Arreglo.** Una marca propia (`data-radio-nav="auto"`) y el repaso cuando cambia `aria-checked`.
- **Alcance.**
  - 25 archivos de `apps/view` usan `role="radio"` sin `tabindex` propio, entre ellos Surtir.
  - El portal y el vendedor instalan el mismo listener.
  - ⚠️ En esos grupos la flecha ahora **elige**, como manda el patrón y como lo diseñó TAB.3. Donde
    elegir recarga datos, cada flecha recarga igual que un clic.
- **Lo que no se probó:** esas pantallas, una por una.

**GP.RF.40: el CLS de la carga es el cambio de fuente, y es de toda la Suite.**
- **El empuje medido.** La segunda línea de la primera tarjeta pasa de 21 a 44 px con el mismo
  ancho (324 px) y el mismo texto: cambió el ancho de las letras.
- **La causa.** Hanken Grotesk llega de Google Fonts con `display=swap`: se pinta primero con la
  fuente de respaldo y, al llegar la definitiva, el renglón se parte en dos.
- **Un segundo empuje.** La etiqueta «Cliente nuevo · sin clave de Kepler» llega después de la
  lista y alarga otra tarjeta 22 px.
- **Propuesta (sin hacer).** Una fuente de respaldo con métricas ajustadas
  (`visually-stable-font-fallbacks`: `font-size-adjust: from-font`, o `size-adjust` en un
  `@font-face` de respaldo).
  - ⚠️ `font-size-adjust` iguala la altura de las minúsculas, no el ancho, que es lo que parte el
    renglón: hay que medirlo.
  - Toca `index.html`, así que es un item aparte, medido en varias pantallas.

**Lo que no se cambió, y por qué:**
- **El selector de almacén no tiene rótulo visible**, sólo un nombre para el lector de pantalla.
  - `accessibility` §7 pide rótulo visible.
  - La maqueta aprobada lo quitó para que almacén y origen quepan en un renglón: si se agrega, lo
    decide Edgar. → Edgar lo pidió el mismo día; hecho en §5c.8 (GP.RF.41), sin perder el renglón.
- **Las barras fijas:** el escáner mide 80 px y el pie 94 px, cada una bajo el 12 % del alto que
  pide `content-first-noise-reduction`.
  - Con el encabezado y la barra inferior de la Suite, el marco ocupa el 38 % del alto mientras se
    surte.
  - Lo que excede es del marco de la Suite, no de Surtir.
- **El lector de código de barras** escribe en el buscador sólo si éste tiene el foco.
  - Al abrir un pedido el foco va al encabezado, no al buscador: en el celular eso abriría el
    teclado en pantalla.
  - Si el lector es de tipo teclado, el primer escaneo después de abrir se pierde. **NO MEDIDO:** no
    sabemos qué lector usan.
- **La pastilla de frescura** («cargado ahora») es una región viva del primitivo compartido: el
  lector de pantalla la lee cada vez que cambia su texto. No se midió cuántas veces pasa en una
  jornada.
- **El nombre accesible de la tarjeta** mide hasta 104 caracteres: cliente, productos, folio,
  total, vendedor y «Surtir este». El cliente va primero; se deja así.

**NO MEDIDO:**
- Con datos de prod: la sesión venció, así que todo lo de arriba es comportamiento con datos
  inventados.
- El celular real y su gesto «atrás» (se midió con `goBack` del navegador).
- Las otras 24 pantallas que cambian con GP.RF.39.

### 5c.8 El brinco al cargar y el rótulo del almacén (GP.RF.40–41, 2026-11-18) 🧪

Edgar: «hagámoslo», sobre lo que §5c.7 dejó propuesto. Medido con Playwright sobre la API sintética
(datos inventados, ninguna petición sale del navegador).

**GP.RF.40: el brinco era la letra de las cifras, no Hanken.**
- **Cómo se midió.** `e2e/reestructura/fuente-cls.e2e.ts` hace un A/B en la misma corrida:
  - la variante «sin» recibe `styles.css` sin los respaldos;
  - la letra web se retrasa 1.5 s para que el cambio llegue siempre después de pintar, como en un
    celular con red lenta;
  - 5 vueltas alternadas por pantalla, más una con la letra bloqueada (sin cambio de letra).
- **La primera hipótesis no alcanzó.** Con sólo el respaldo de Hanken, Surtir siguió en 0.052.
  Diagnóstico pieza por pieza de la tarjeta: el folio `PV-PRUEBA-001` va en Geist Mono y se pinta
  primero en Consolas, que es 8.4 % más angosta (100 contra 109 px). Al llegar Geist Mono, el
  segundo renglón (folio · total · vendedor) ya no cabía en 324 px y se partía: 21 → 44 px.
- **Arreglo, en `libs/design-tokens/tokens.css` (las tres apps).** Dos familias de respaldo, la letra
  local de Windows escalada al ancho de la web con `size-adjust` y con su ascenso y descenso:
  - `'Hanken Respaldo'`: Segoe UI, un ajuste por peso (97.2–106.4 %). Error de ancho mediano en 20
    textos de la Suite: 0.7–1.1 % (antes 2–6 % en los pesos 300, 400, 700 y 800).
  - `'Geist Mono Respaldo'`: Consolas al 109.13 %. Al ser monoespaciada, el ancho coincide exacto en
    cualquier texto (antes 8.4 % de diferencia).
  - Se recalculan con `node e2e/reestructura/fuente-respaldo.js`, que incluye sus controles.
- ⛔ **No se usó `font-size-adjust`**, la vía principal de la guía `visually-stable-font-fallbacks`.
  Iguala la altura de la x, no el ancho, y aquí empeora:
  - escala Segoe UI a 0.986, cuando Hanken es 2.5 % más ancha;
  - escala Roboto a 0.933, cuando su ancho ya coincide con Hanken al 1 %.
  - Se usó la alternativa que da la misma guía: `size-adjust` con `ascent-override` y
    `descent-override` en un `@font-face` de respaldo.

| Pantalla | Brinco sin respaldo | Con respaldo | Letra bloqueada (piso) |
|---|---|---|---|
| Surtir, celular 390 px | 0.052 (5 de 5) | **0.0008** (5 de 5) | 0.0008 |
| Surtir, laptop 1366 px | 0.0012 | 0.0005 | 0.0005 |
| Pedidos, laptop | 0.0009 | 0.0008 | 0.0008 |
| Caja General, laptop | 0.0011 | 0.0012 | 0.0006 |

- **Con la red real** (la auditoría de §5c.7 vuelta a correr): CLS de la carga 0.057 → 0.001; ningún
  movimiento atribuido a la tarjeta.
- **Controles:**
  - sin respaldo, la tarjeta brinca: la prueba lo exige, y es su lado rojo;
  - con respaldo queda igual que sin cambio de letra;
  - en «con» se usaron 4–6 caras de respaldo y en «sin», 0;
  - ya con la letra web, la posición final de cada texto es idéntica en las dos variantes (el
    respaldo no deja rastro). En Caja General esto es NO MEDIDO: la pantalla no repite su
    posición ni contra sí misma.
- **Lo que cambia sin red a Google Fonts:** en Windows la Suite se pinta con estos respaldos (Segoe
  UI y Consolas con el ancho de la letra web) en vez de Segoe UI y Consolas a su tamaño natural.

**GP.RF.41: el selector de almacén con su rótulo visible.**
- Antes sólo tenía un nombre para el lector de pantalla. Con el almacén ya elegido, el selector
  mostraba «Sucursal de prueba…» sin decir qué era (guía `forms`: «DON'T use `aria-label` when a
  visible `<label>` can be used»).
- Ahora «ALMACÉN» va encima del selector y «PEDIDOS DE» encima de los chips de origen, que también
  tenía sólo `aria-label`. El rótulo queda a 4 px de su control; entre controles hay 8.
- Los controles siguen en un renglón, como en la maqueta. El costo es 22 px de alto (cabecera de 44 a
  66 px).
- Nombre que calcula el navegador: «Almacén». PrimeNG pone la opción elegida en `aria-label`, pero
  `aria-labelledby` le gana.
- Al medir salió un error del instrumento de §5c.7: leía el atributo `aria-label` y reportaba como
  nombre el del almacén elegido. Se corrigió para que lea el nombre que calcula el navegador.

**NO MEDIDO:**
- Android y iOS. Ahí no hay Segoe UI ni Consolas, `local()` no resuelve y se sigue con la letra del
  sistema, igual que antes. Medido en este navegador: Roboto ya coincide en ancho con Hanken al 1 %,
  y el monospace de Android mide lo mismo que Geist Mono; en un teléfono real no se midió.
- 28 reglas en 10 archivos declaran `'Hanken Grotesk', sans-serif` sin pasar por `--font-body`
  (mapas, historial de vendedor, panel lateral, viajes del ERP, entre otros): no reciben el
  respaldo.
- Las demás pantallas de la Suite: se midieron 4.

### 5c.9 Lo que quedaba abierto, corregido (2026-11-18) 🧪

Edgar: «corrijamos todo lo que está mal». Se recorrió el registro (§8 y §5b) y se corrige todo lo que
no espera una decisión suya ni una sesión de un puesto. Lo que sí espera algo va al final de esta
sección, con su motivo.

**Bloque 1: contraste y letra.**
- **Botones sin relleno, en toda la Suite (GP.RF.13 «Salir», GP.RF.18 «Cancelar surtido»).**
  - El tema (Aura) pinta el texto de los botones `text` y `outlined` con el tono 500, y en claro
    casi ninguno llega a AA.
  - Medido contra blanco y contra el fondo de página: gris 4.83 y 4.40, rojo 3.76 y 3.42, verde 2.28,
    azul 2.77, naranja 2.80, morado 3.96.
  - Ahora, en `core/theme/operations-preset.ts`: gris 600 (7.73 y 7.03) y el tono 700 en los demás,
    de 4.56 a 6.98. En oscuro no cambia; ahí ya pasaban, de 7.2 a 11.4:1.
  - Comprobado en el navegador: el color calculado cambió en las 12 variantes en claro; en oscuro
    quedan el 400.
  - Antecedente: [AUD.4] arregló así el botón primario.
- **El «1» ámbar de Por capturar (GP.RF.13):** `--warn-fg`, 2.15:1, pasa a `--warn-soft-fg`, 7.09:1.
- **La cifra verde del resumen de métricas (UB.RF.8), pieza compartida:**
  - `--ok-fg` daba 3.30:1 sobre blanco y 3.00 sobre el fondo de página, al borde del 3:1 de texto
    grande.
  - Pasa a `--ok-soft-fg`, 7.13, como ya se había hecho con el ámbar en [PQ.73].
  - También el delta («↑»), que es texto chico y no llegaba al 4.5.
- **«Se crea 180» (UB.RF.9):** el resumen de la captura concuerda con su cuenta: «Se crean», «Ya
  existen», «Dadas de baja». El renglón suelto sigue en singular. Prueba con su negativa.
- **La letra al token:** 31 reglas en 10 archivos escribían `'Hanken Grotesk', sans-serif` o
  `'Geist Mono', monospace` a mano. Pasan a `var(--font-body)` y `var(--font-mono)` y reciben el
  respaldo de GP.RF.40. Los mapas, el historial de vendedor, el panel lateral, los viajes del ERP y
  las pestañas compartidas no cambian de letra.

**Bloque 2: el almacén, por su nombre y donde la persona trabaja.**
- **Checar (GP.RF.11).** Ya preseleccionaba el almacén (el guardado, el de la persona o el único).
  Lo que estaba mal era el `<select>` nativo con el número («06 · Canindo»). Ahora es un `p-select`
  con el nombre y el rótulo visible «Almacén donde checas»; arriba de la pantalla también va el
  nombre.
- **Consola del Tablero (GP.RF.17).**
  - Sin preferencia guardada, abre en el almacén de la persona. Antes abría en el primero de la
    lista: CEDIS, con la fila vacía.
  - Las opciones van por nombre.
  - Lo que la persona eligió antes sigue ganando; la prueba negativa lo cuida.
- **Ubicaciones (UB.RF.7).**
  - Mapa, Asignación y Contenido comparten el almacén elegido (`shared/almacen-preferido.ts`).
  - Sólo se usa si está en el alcance que la pantalla recibió: una preferencia vieja no abre un
    almacén ajeno, y la prueba negativa lo cuida.
  - Contenido ya no abre vacío: abre el elegido, el de la persona o el único que maneja.
  - Las tres nombran el almacén sin número.
- **Sin validación visual:** la API sintética no sirve Checar, la consola ni Ubicaciones. Lo cubren
  las pruebas de componente, que montan la plantilla de verdad.

**Bloque 3: lo que nadie veía.**
- **Atorados en el Tablero (GP.RF.16).**
  - Nuevo `GET warehouse/orders/atorados`, de sólo lectura y con permiso del Tablero. Cuenta los
    pedidos que siguen `AUTORIZADO` en Kepler con fecha anterior a la ventana de la fila (7 días),
    por sucursal del alcance.
  - Usa la misma regla que la cuenta de la fila (`ATORADOS_ALCANCE_SQL` junto a
    `ATORADOS_KEPLER_SQL`) y la misma ventana: la constante `VENTANA_POOL_DIAS`, que ahora usa
    también el pool.
  - Medido en prod, sólo lectura: 396 pedidos en 8 sucursales, el más viejo del 29-nov-2025 y 288
    en Zamora Centro. Tarda de 60 a 170 ms, y la suma cuadra sucursal por sucursal con la cuenta que
    ya publicaba la fila.
  - El aviso dice cuántos, desde cuándo y dónde se concentran. «Velos» pone en la lista el filtro con
    la misma frontera, igual que GP.RF.15.
  - Si no se pudo contar, lo dice; sin atorados no hay aviso (pruebas negativas). Se pide una vez
    al abrir, no en cada filtro (control en el navegador).
- **Preventa a un toque (GP.RF.21).**
  - El motor cuenta por origen (`conteos_origen`), con sucursal, búsqueda y el mismo filtro de etapa
    que la lista, sin el de origen. «Preventa N» dice lo que se verá al tocarlo.
  - Un toque pide sólo la preventa; antes eran el desplegable y la opción. Medido en el navegador
    con la API sintética: la petición sale con `origin=PREVENTA` y la lista trae sólo `PD-`.
  - Con una API anterior no se pinta un número inventado (prueba negativa).
- **El motivo de cada cierre rechazado (GP.RF.23).**
  - Uno de cada 11 cierres de Surtir se rechazaba, y el motivo no quedaba en ningún lado.
  - Ahora cada rechazo manda por el canal de incidentes que ya existía (`reportarIncidente`,
    `kind: 'error'`): el código, el mensaje del servidor y lo que traía el cierre (renglones,
    faltantes, cambios de producto, el id del surtido).
  - No manda nada de lo que la persona escribe y no cambia lo que pasa en pantalla. La causa se sabrá
    leyendo esos registros después de soltar.
- **GP.RF.24, 25 y 26:** eran de `/almacen/surtir-preventa`, que se retiró en GP.RF.32. En Surtir,
  «No había nada» está a dos toques: «Faltó» y «No había nada».
- **Arranque no verificado:** el endpoint nuevo agrega decoradores de Nest a un controlador. Se probó
  el motor y el SQL contra prod, no el arranque de la API: eso lo dice el despliegue.

**Bloque 4: letra, lectores de pantalla y la consulta lenta.**
- **La letra de 10 px (GP.RF.12).** Medido en el navegador: en Surtir y el Tablero de escritorio ya
  no quedaba texto bajo 12 px salvo dos casos.
  - **La pastilla de frescura, pieza compartida:** pasa de 10.9 a 12 px.
  - **El Tablero en el celular:** el bloque viejo de `styles.css` para tablas en el teléfono le ganaba
    con `!important` al modo apilado (`.dt-stack`, [UIM.1]). Letra de 11.2 px y **15 de 35 celdas
    escondidas** (Cliente, Renglones y Etapa); a 700 px, Etapa.
  - Ese bloque ya no aplica a las tablas `.dt-stack`, 116 archivos. Medido aplicando el mismo
    cambio a la hoja servida, porque el servidor de desarrollo dejó de recompilar: 35 de 35 celdas a
    la vista, 14 px, sin cortes y sin desbordar.
  - Las tablas que no usan `.dt-stack` siguen escondiendo columnas en el celular: hallazgo
    `AUD-UI.1` en `AUDITORIA_BASE_INICIAL.md`.
  - Las etiquetas y chips de 10 px (`--fs-nano`) de las pantallas del alcance pasan a 11 px
    (`--fs-micro`, el tamaño de los tokens para etiquetas): etapa del Tablero, preventa, guías,
    captura, asignación, Excel de asignación, Mapa (chips y rótulos de renglón), contenido y el
    «URGENTE» de la fila.
  - No se tocaron las cifras dentro de las celdas del Mapa: su espacio está contado y no se pudo ver
    con datos.
  - Lo que queda: los **9 niveles de letra de Revisión** piden un pase de jerarquía con la pantalla a
    la vista (no es un cambio mecánico).
- **La pastilla de frescura ya no habla cada 15 s (§5c.7).** Su `aria-live` iba sobre el texto que
  avanza solo («hace 15s», «hace 30s»…), y el lector de pantalla lo leía en cada cambio. Ahora una
  región aparte sólo anuncia cuando cambia el estado: atrasado o sin medir. Prueba negativa: el
  texto que avanza no está en la región viva.
- **La consulta lenta (GP.RF.19).** Medido en prod, sólo lectura, con el rango de la liga de atorados
  (29-nov-2025 al 10-nov-2026).
  - La consulta leía 12,071 pedidos para mostrar 396 y tardaba de 1.8 a 2.2 s.
  - Con filtro de estatus de Kepler, ahora filtra antes de leer los renglones de cada pedido: 171 a
    184 ms, con los mismos 396 pedidos.
  - Con ese filtro, los conteos de etapa y de origen quedan dentro del estatus (la pantalla lo
    rotula así) y la preventa no viene, porque no tiene estatus de Kepler.
  - El mes en curso, sin filtro, sigue en 0.36–0.67 s: lo de arriba de 500 ms es la primera lectura
    en frío.
- **Cancelar surtido (resto de GP.RF.18):** en la fila, apartado del resto de acciones (aire a la
  izquierda en renglón, arriba si están apiladas). Ya pedía confirmación.
- **NO MEDIDO en el navegador:** la pastilla, las etiquetas de 11 px y la separación de «Cancelar»,
  porque el servidor de desarrollo dejó de recompilar; lo cubren las pruebas de componente.

**Bloque 5: lo que seguía mal (Edgar: «resolvamos lo que sigue mal»).**
- **Tablas sin `.dt-stack` en el celular (`AUD-UI.1`, 153 archivos).**
  - El bloque global ya no esconde columnas ni corta celdas con «…».
  - La tabla conserva todas sus columnas y se desplaza a lo ancho dentro de su caja, con la última
    columna fija. Sin `[scrollable]`, PrimeNG no desplazaba, y el `overflow-x: hidden` del `body` la
    habría recortado.
  - Letra mínima de 12 px.
  - Medido con `e2e/reestructura/tabla-celular.e2e.ts`: la hoja real que sirve la app y una tabla de
    PrimeNG de 8 columnas a 390 px.
    - Antes (el bloque del commit previo): 4 columnas escondidas (Cliente, Renglones, Etapa y
      Vendedor), «Vendedor» inalcanzable y 11.2 px.
    - Ahora: 0 escondidas, se llega a todas desplazando, 12 px y la página no se desborda.
    - Controles: el «antes» tiene que esconder; la tabla `.dt-stack` sigue completa.
- **Pastilla de frescura, en el navegador:** 12 px, el texto que avanza ya no es región viva y la
  región viva está vacía mientras el dato está al día.
- ⛔ **Corrección del bloque 4.** Las reglas `.gp-tag`, `.uc-tag`, `.as-tag` y `.ax-tag` nunca
  aplicaron: en PrimeNG 22 `p-tag` no tiene `styleClass`. Esas etiquetas miden 12 px por el tema
  (medido), nunca midieron 10, y el cambio a 11 px no les hizo nada.
  - Se quitaron esas 4 reglas muertas y sus 10 `styleClass`; no cambia nada de lo que se ve.
  - Sí eran de 10 px, y ahora son de 11, los chips y rótulos del Mapa, los rótulos de Asignación y
    Contenido, las etiquetas `.mc-tag` y `.gc-tag` (van con `class`) y el «URGENTE» de la consola.
- **Más texto en ámbar o verde de relleno (resto de GP.RF.13):** 14 textos en Revisión (8), Checar,
  la consola, Preventa, Mapa, Asignación y Captura pasan a su tono para texto (de 2.15 o 3.30 a unos
  7.1:1). Los íconos y bordes quedan en el de relleno.
- **Revisión: de 6 tamaños propios a 4 niveles (resto de GP.RF.12).**
  - Quedan 40 px (el número que se cuenta), 20 (título y producto), 18 (encabezados, estados, cliente
    y cantidad) y 14 (el texto).
  - 16 subió a 18 y 13 subió a 14: casi no se distinguían y diluían la jerarquía. Nada se achicó.
  - **Medido en el navegador** cuando volvió el servidor (`revision-letra.e2e.ts`, API sintética,
    390 px).
    - Dentro de un pedido: 4 tamaños, 20, 18 y 14 más el 13 de las pestañas del marco, que no es de
      Revisión.
    - En la lista: 20, 18 y 14 propios, más los del resumen de métricas y la pastilla.
  - La misma medición encontró dos textos bajo AA, ya corregidos y vueltos a medir (0 bajo AA):
    - «▶ REVISANDO»: `--info-fg` sobre el azul claro de la tarjeta, 4.24:1; ahora `--info-soft-fg`,
      7.15.
    - «Está bien», el botón principal: blanco sobre `--ok-fg`, 3.30:1; ahora fondo `--ok-soft-fg`,
      7.13.

---

## 5d. Revisión del plan y meta de la consola, medida (2026-11-19) 🧪

**El pedido (Edgar):** *«aún todo está en fase de pruebas, sigamos corrigiendo el proceso»* y
*«revisa el plan»*. Nada de lo que sigue cambia de 🧪 a ✅: todo sigue en pruebas hasta el piloto.

### 5d.1 Lo que encontró la revisión del plan

- ⭐ **El riesgo: pulir pantallas que el plan va a rehacer.** E3 rehace Checar (GP.13) y convierte
  «Por capturar en Kepler» en la bandeja de lo que la Suite no pudo escribir (GP.12.3). Hasta E3,
  esas dos pantallas **sólo se miden**: no se invierte en su presentación.
- **El camino que mueve la fase está detenido en E0:** los permisos por columna de `kepler_push`
  (GP.12.0e, los corre el PM), juntar más pedidos de cada transición (GP.12.0a) y el dueño de piso
  del piloto (P-GP.1). **E2 (carretas) no tiene bloqueo técnico**: falta que Edgar la abra.
- **Las sesiones por puesto (P-RF.1) siguen pendientes desde el 14-nov.** Sin ellas no se miden los
  toques por renglón de Surtir ni por qué ningún checador usa Checar.
- **Los documentos se habían quedado atrás:** el plan, en el 14-nov; §6 de este documento daba como
  faltantes cosas ya hechas y nombraba una pantalla retirada. Se pusieron al día aquí y en el plan.

### 5d.2 La meta de E1, medida en prod

Servicio real (`WarehouseOrdersService`) contra `pg-prod` en sólo lectura, noviembre completo, y
`analytics.ui_usage` para la latencia medida dentro del servidor.

| Meta de E1 | Resultado | Cómo se midió |
|---|---|---|
| Pantallas para seguir un pedido: 3 → 1 | ✅ en prod: Preventa y Consola de surtido redirigen al Tablero | rutas en prod desde `4d99357f7` |
| Pedidos visibles: 100 % | ✅ **Kepler 1,737 de 1,737** y **preventa 1,020 de 1,020**, ni uno de más ni de menos; 2,757 filas en 6 páginas, ninguna repetida. Los 108 cancelados quedan fuera de los totales, como se diseñó | todas las páginas de «Todos» contra un testigo escrito aparte: la versión más reciente de cada `U-D-40` en `kdm1`, y los `PD-` de ruta en `commercial.orders` |
| Carga < 500 ms | ✅ **En promedio cumple para todos los puestos, también para quien ve varias sucursales** (corregido el mismo día, ver abajo). En 10 días: supervisor 420 ms (11 llamadas), dirección 281 ms (15), compras 155–288 ms; quien opera una sucursal, 85–127 ms. ⚠️ **Quedan picos de más de un segundo** (hasta 1.7 s en un puesto real), y **no dependen de cuántas sucursales se ven**: el surtidor, que opera una sola, tuvo uno de 1.6 s. Son lecturas en frío del disco: la versión de la consulta anterior a GP.RF.19 leía en promedio 129 bloques del disco por llamada y llegó a 2.6 s; la vigente lleva 34 llamadas con un máximo de 348 ms. Desde la laptop, todas las sucursales: ~1 s en caliente y 5 s en frío (incluye la red) | `ui_usage` de 10 días por rol, promedio pesado por llamada (no por día); `pg_stat_statements` separado por versión de la consulta; la llamada con la que abre el Tablero, corrida 6 veces |

→ **GP.RF.43:** la primera versión de esta fila decía que **no cumplía para quien ve varias sucursales**. Era falso: salía de promedios por día de 1 a 3 llamadas. Igual se bajó lo que sí cuesta ver todas las sucursales, que es leer los renglones de cada pedido: la mediana pasó de 241 a 184 ms y se leen la mitad de bloques (GP.RF.43 en el registro).

### 5d.3 Lo que se corrigió (en código, sin soltar)

- **GP.RF.42 — Por qué la caja rechaza cierres.** La revisión en caja rechazaba 20 de 187 cierres
  (10.7 %) y nadie guardaba el motivo. Ahora cada rechazo deja, por el canal de incidentes:
  - el código y el mensaje del servidor;
  - los renglones, y cuántos se bajaron con motivo;
  - si la revisión venía guardada de antes y cuántos minutos llevaba abierto el pedido.

  Es lo mismo que ya hace Surtir (GP.RF.23), y nada de lo que la persona escribe viaja. La prueba se
  pone en rojo si se quita el registro.
- **GP.10.1b — Un pedido cancelado ya no se ve avanzado** en el seguimiento de la cotización
  (televenta). Medido en prod:
  - 6 de 359 cotizaciones en Kepler tienen el pedido cancelado;
  - 3 decían «Embarcado» sin ningún embarque;
  - los 5 revisados están en $0 y sin renglones.

  Ahora el seguimiento dice «Pedido cancelado en Kepler» y el folio va marcado. No quedan pasos
  pendientes, y los productos que Kepler borra al cancelar ya no se listan como «quitados». Los 353
  pedidos vivos no cambian.

### 5d.4 Lo que sigue sin medir

- El marco del Tablero en prod (GP.RF.10, GP.RF.20): necesita una sesión vigente.
- La causa de los cierres rechazados de Surtir y de la caja: los registros empiezan al soltar.

---

## 5e. Paso 1 del anexo EA — «Por autorizar»: qué necesita el auditor de crédito, y cómo presentárselo (2026-11-23)

> **Lo pidió Edgar** el 2026-11-23, viendo la pantalla en producción: *«a la interfaz le faltan filtros,
> información… revisa qué información y filtros requiere el auditor de crédito y cobranza, y adjúntale
> una evaluación de cómo presentar esa información»*.
>
> **Nivel de evidencia: A** la pantalla viva con datos sembrados (Playwright, frontend local, toda
> escritura en 403) · **B** producción en sólo lectura (ODS, cartera y `analytics.ui_usage`) · **C** el
> código. Lo que no se midió se dice. ⛔ Sin nombres de clientes: el repo es público.

### 5e.1 El estado real, medido antes de opinar

**Qué usa hoy Crédito y cobranza** (telemetría de 30 días, al 2026-11-23):

| Endpoint | Hits | Días con uso | Quién |
|---|---:|---:|---|
| La lista de cartera | **2,972** | 25 | contabilidad, credito_cobranza, dirección, finanzas, finanzas_operativo |
| **La ficha de un cliente** | **883** | 25 | **credito_cobranza**, dirección, finanzas_operativo |
| Registrar un contacto | 10 | 4 | finanzas_operativo (⛔ **ninguno** de credito_cobranza) |
| El estado de cuenta en PDF | **7** | 2 | finanzas_operativo (⛔ **ninguno** de credito_cobranza) |
| **La bandeja «Por autorizar»** | **3** | 1 | ⛔ **sólo superadmin**: nadie del área la ha abierto |

⭐ **Tres conclusiones que ordenan lo demás:**

1. **La herramienta de crédito es la ficha del cliente**: la abren **35 veces al día**. A eso se tiene que
   parecer el panel de autorización, no a una tarjeta suelta.
2. **El PDF no es la forma de ver**: 7 aperturas en 30 días y ninguna del área. Por eso el botón del PDF
   salió del panel y lo reemplazó una liga a la ficha (2026-11-23).
3. **La bandeja todavía no entra en la rutina de nadie.** Se corrige ahora, antes de que la rutina se
   forme alrededor de sus huecos.

**El universo que la pantalla tiene que manejar** (prod, 2026-11-23 por la tarde):

| Sucursal | En `CREADO` | De contado | Ruta vecinal | «Viejos» (+2 días) | Importe menor / mayor |
|---|---:|---:|---:|---:|---|
| Padre Hidalgo | 4 | 3 | 0 | 4 | $94 / $17,504 |
| Canindo | 8 | 2 | 0 | 7 | $550 / $47,232 |
| Morelia Abastos | 9 | 6 | 0 | 6 | $320 / $27,213 |
| **Zamora Centro** | **782** | 10 | **604** | 782 | $34 / $20,007 |
| La Piedad Abastos · 8 Esquinas | 3 | 1 | 1 | 3 | $308 / $2,348 |

**La lista del día es de unidades; la de «aparte» es de cientos.** Sin filtros, esa no se trabaja: son
**782 renglones** de los que **604 son ruta vecinal** y no le tocan a nadie de crédito.

### 5e.2 Qué información requiere el auditor de crédito — y de dónde sale

No se inventa: sale de cruzar **lo que el proceso exige** (la tabla «Qué revisa Crédito y cobranza al
autorizar a mano», acordada con Edgar el 2026-11-20, anexo EA §3.6) con **lo que el sistema ya tiene**.

**A · Existe en el sistema y la pantalla no lo mostraba** — hueco de pantalla, no de dato:

| # | Qué necesita | Por qué, con su cifra | De dónde sale | Estado |
|---|---|---|---|---|
| **GP.RF.45** | **Cuánto de lo que debe está vencido y desde cuándo** | de los 12 clientes que esperaban, **11 tenían vencido y 9 lo tenían TODO vencido**, con atrasos de hasta **111 días**. El panel decía «por cobrar $83,552.80» y nada más | la regla ya lo calculaba (`vencido_fuera_de_gracia`, `dias_vencido_max`) | ✅ 2026-11-23: primer hecho de «Para decidir» |
| **GP.RF.46** | **Las facturas que forman ese saldo** | **66 facturas vivas** entre esos clientes, invisibles | `GET /receivables/:sucursal/:cliente` | ✅ 2026-11-23: al abrir el desglose, con folio, vencimiento, saldo y días |
| **GP.RF.47** | **El estado de cuenta completo, en pantalla** | 883 aperturas de la ficha al mes contra 7 del PDF | la ficha del cliente (CXC.50/51) + enlace profundo de CXC.26 | ✅ 2026-11-23: liga al cliente; el PDF se queda en la ficha |
| **GP.RF.48** | **Si el cliente tiene otra clave en la misma sucursal** | **12 de 135** clientes de la bandeja la tienen (14 claves extra). Un caso real: el panel mostraba $83,552 de un cliente que debe **$114,823** entre sus dos claves vivas, todo vencido | `kdud` por nombre + la cartera de cada clave | ⬜ **pendiente** |
| **GP.RF.49** | **Cuáles son los «otros pedidos sin facturar»** (folio, fecha, importe) | el panel publicaba el total y no se abría; **ya viajaban** en la respuesta | `abiertos` de `leerBandeja`, publicados como `otros_pedidos_detalle` | ✅ 2026-11-23: bloque propio, sin llamada nueva |
| **GP.RF.50** | **Cómo pagó de verdad**: sus últimos abonos con fecha y monto | sólo había promedios; un promedio no dice si pagó la semana pasada o en agosto | `abonos` del detalle | ✅ 2026-11-23: bloque «Cómo ha pagado», misma llamada |
| **GP.RF.51** | **El teléfono, para llamarle antes de decidir** | la ficha ya lo traía por sucursal (CXC.48) y el panel no | el detalle del cliente | ✅ 2026-11-23: arriba y sin plegar (es una línea) |

**B · El proceso lo pide y el sistema NO lo tiene** — hueco de dato (C0), que ninguna interfaz resuelve:

| # | Qué falta | Medido |
|---|---|---|
| **GP.RF.52** | **La promesa de pago**, que el anexo nombra como parte de la decisión | `finance.collection_promises` tiene **0 filas en toda la base**: el campo existe desde CXC y nadie lo ha usado nunca. ✅ 2026-11-23: el panel la muestra **cuando exista** y mientras tanto dice «sin promesa de pago registrada», con dónde se registra — el vacío declarado, no un espacio muerto |
| **GP.RF.53** | **Qué pasó las veces anteriores que se le autorizó excedido** — la pregunta que más pesa | **no existe**: la bitácora de decisiones nació el 2026-11-20 con 0 filas, y antes Kepler no guardaba quién autorizó. Derivable de sus pedidos, sin calcular |
| **GP.RF.54** | **RFC y listas del SAT** | 73 de 366 clientes de telemarketing tienen RFC propio y **0 aparecen en listas** (19-nov). Sin RFC, la ficha dice «no se puede revisar», nunca «limpio» |

⛔ **Se dicen primero a propósito** (`diseno` §0a paso 12): si la pantalla pinta un lugar para la promesa
de pago, va a enseñar un vacío permanente — que es dibujar un cero donde no hubo medición.

### 5e.3 Qué filtros requiere — con la cifra que justifica cada uno

⭐ **No se inventan: se copian de los que esa misma gente ya usa** en la lista de cartera (2,972 llamadas
al mes), que acepta sucursal, cliente, vendedor, grupo, zona, búsqueda y orden por saldo o vencido. Un
filtro nuevo con otro nombre para lo mismo es otra interfaz del mismo trabajo.

| # | Filtro | Por qué, medido | Sev |
|---|---|---|---|
| **GP.RF.55** | **Sucursal** | la bandeja mezcla **6 sucursales**; quien lleva Padre Hidalgo no decide los 782 de Zamora Centro | 🟠 |
| **GP.RF.56** | **Motivo** (excede · sin límite · vencido · bloqueado · viejo · ruta vecinal) | es la columna por la que se ordena el trabajo. En «aparte», **604 de 782 son ruta vecinal** y no le tocan a crédito | 🟠 |
| **GP.RF.57** | **Buscar por cliente o folio** | con 782 renglones, encontrar al cliente que acaba de llamar no se hace con la rueda del ratón | 🟠 |
| **GP.RF.58** | **Orden por importe y por espera** | los importes van de **$34 a $47,232**: de mayor a menor se protege más dinero por hora de trabajo | 🟡 |
| **GP.RF.59** | **«Sólo los que pasarían solos»** | es el control del automático: ver qué autorizaría la regla antes de encenderla, en la pantalla y no en un reporte aparte | 🟡 |

⛔ **Lo que NO lleva filtro:** la fecha. La bandeja es de hoy por definición y lo viejo ya tiene su lista;
un filtro de fechas sobre una cola del día es un control que nadie mueve.

### 5e.4 La evaluación: cómo presentar esa información

> **La regla que lo gobierna la dio Edgar el 2026-11-23:** *«podemos agregar esa información sin saturar
> al usuario, que al dar clic tenga la accesibilidad de ver esa información; lo que tratamos de evitar es
> que al cargar la interfaz suelte mucha información — la información se suelta en base a la búsqueda del
> usuario»*. O sea: **todo disponible, nada soltado de entrada.**

**La jerarquía, en una línea** (§Q.5; se escribe o no existe): **primario** = cuántos esperan y por qué no
pasó cada uno · **secundario** = el veredicto del pedido abierto con sus cuatro números · **terciario** =
las facturas, los abonos y el historial, **a un clic**.

**Los tres niveles, sin inventar pantallas** (§Q.4, mapa de desglose):

| Nivel | Dónde | Qué se ve | Cuándo se pide |
|---|---|---|---|
| **0 · la cola** | la lista | cliente · por qué no pasó (etiqueta + frase) · importe · espera | al entrar |
| **1 · el veredicto** | el panel, arriba | «Excede $112,932.44 su límite» · los cuatro números · **el vencido con su antigüedad** · «Para decidir» | al abrir el pedido, **sin llamadas nuevas** |
| **2 · la explicación** | el panel, plegado | el resumen del estado de cuenta (saldo · vencido · próximo vencimiento) y sus facturas · los abonos · los otros pedidos con folio | **al abrir cada bloque** (una llamada por cliente; ya implementado) |
| **3 · el expediente** | la ficha del cliente | el estado de cuenta completo, el periodo elegible, el PDF para enviárselo, el teléfono | al tocar «Ver su estado de cuenta completo» |

**Cómo se ven los filtros** (y por qué no como una barra de formularios):

- **Las cifras de arriba SON el filtro principal** — ya lo son: tocar «Esperan tu decisión», «Viejos,
  aparte» o «Ya decididos» cambia la lista. Se conserva: es un filtro que no parece un filtro.
- **El motivo, como chips de una línea** bajo las cifras, cada uno con su conteo («Excede 4 · Sin límite 2
  · Vencido 9»), y **los de conteo cero no se pintan**. Un chip con su número informa aunque nadie lo
  toque; un selector vacío sólo ocupa lugar.
- **Sucursal y búsqueda, en la misma línea de los chips**, con `p-select` y la caja de búsqueda del
  sistema (`applySmartSearch`, la misma de toda la suite: multi-token, cliente + folio + importe).
- **El orden, en el encabezado de la columna** (Jakob: tabla = Excel), no como un control aparte.
- ⛔ **Nada de un panel de filtros plegado arriba**: en `/compras/oc-abiertas` eso dejó 17 piezas de marco
  antes de la primera fila, y lo encontró el PM, no una compuerta.

**Lo que se mantiene** (la maqueta aprobada el 2026-11-20 no se rehace): una fila = un objetivo y toda la
fila abre el panel · una frase por pedido, y una segunda línea **sólo** si cambia la decisión · motivo
obligatorio y una sola acción primaria · la edad del dato arriba.

**Maqueta del panel reestructurado** (lo nuevo, con «+»):

```
┌─ CLIENTE · sucursal · pedido 0004278 · espera desde hoy ───────── X ─┐
│ Excede $112,932.44 su límite                                        │  nivel 1
│   Límite                                        $15,000.00          │
│   Por cobrar en Kepler                          $83,552.80          │
│   Otros pedidos sin facturar                    $32,356.73  > (+)   │  nivel 2 al clic
│   Este pedido                                   $12,022.91          │
│                                                                     │
│ Para decidir                                                        │
│ + Debe $83,552.80 vencidos, lo más viejo de hace 111 días.          │  el hecho que faltaba
│   Pagó 50 facturas; suele pagar a 28 días con plazo de 15.          │
│   Su peor atraso fue de 82 días.                                    │
│ + Tiene otra clave en esta sucursal: debe $31,271 más.      (+)     │  GP.RF.48
│                                                                     │
│ > Ver sus facturas · $83,552.80                             (+)     │  nivel 2: una llamada
│     Saldo $83,552.80 · Vencido $83,552.80 · Próximo 30/11 $8,000    │
│     Fac UD0801-1   30/11/26   $8,000.00    —                        │
│     Fac UD0801-2   14/08/26  $12,000.00  101                        │
│     Ver su estado de cuenta completo (12 facturas más)      (+)     │  nivel 3: la ficha
│ > Ver las condiciones                                               │
│                                                                     │
│ Motivo · queda con tu nombre                                        │
│ [                                                              ]    │
│ [ Autorizar ]  [ Rechazar ]                             7 de 8 >    │
└─────────────────────────────────────────────────────────────────────┘
```

### 5e.5 Criterios de aceptación (medibles en la pantalla viva)

1. **Al cargar el panel no sale ninguna llamada nueva** (hay prueba con mutante: pedir el auxiliar al
   abrir lo pone rojo).
2. Con **782 pedidos en «aparte»**, filtrar la ruta vecinal deja **178**, y el conteo de arriba cuadra con
   las filas que se pueden recorrer (Cruce 1).
3. **Ninguna cifra del panel queda sin salida**: las cuatro se abren a su detalle o llevan a la ficha.
4. El panel sigue bajo **20 controles y 40 cifras** visibles al abrir (hoy: 6 y 13).
5. Todo filtro aplicado **se dice en palabras** sobre la lista: «4 de 782 · ruta vecinal».
6. Contraste AA en claro y oscuro, 44 px en táctil, y el recorrido completo con teclado.

### 5e.6 Lo que esta interfaz NO puede resolver

- La **promesa de pago** y el **historial de autorizaciones excedidas** no existen como dato (GP.RF.52,
  GP.RF.53): hasta que existan, el panel **no los dibuja**.
- Que un cliente tenga **tres claves** en una sucursal es del padrón de Kepler: la pantalla puede
  **avisarlo**, no arreglarlo (ALC D1-b cerró que la Suite escriba `kdud`).
- Que **nadie del área haya abierto la bandeja** no se arregla con diseño: pide la cola en «Mi trabajo»
  (anexo EA §3.6e) y que el permiso de Kepler esté corrido.

---

## 6. Los pasos que siguen

Cada paso arranca con la línea base de su pantalla (Playwright), recorre el proceso **completo**
con datos reales y termina con la medición de después. El orden sigue el recorrido del pedido.

| Paso | Interfaz | La pregunta del paso | Qué se mide con Playwright |
|---|---|---|---|
| **1** | Tablero + fila de surtido + detalle de `PD-` | ¿Quien coordina ve en la primera pantalla qué pedido está atorado y qué sigue, sin clic? | ✅ el «antes» y el «después» de GP.10.4 medidos el 2026-11-17 (§5). 🧪 en prod: GP.RF.15, 16, 20, 21, 22 y GP.10.5; la meta de E1 medida el 2026-11-19 (§5d). Falta: el marco medido en prod con sesión (GP.RF.10), el Tablero de quien ve varias sucursales (GP.RF.43) y la regla de los surtidos abandonados (P-RF.4, de Edgar) |
| **2** | Surtir (celular) | ¿El surtidor termina un pedido sin pensar qué tocar? | 🔨 **línea base medida el 2026-11-17 (§5c)**: dónde surten, los 84 cierres rechazados, la bandeja a 390 px, «No hubo» y Surtir (Kepler). Falta, con el puesto de surtidor: los toques por renglón y el tamaño real de los botones; y registrar el motivo de cada rechazo |
| **2b** | Surtir preventa | ✅ contestada: no hacía falta, se retiró (GP.RF.32). ¿Por qué se rechaza uno de cada diez cierres (GP.RF.3)? | 🧪 el motivo de cada rechazo queda registrado (GP.RF.23); la causa se lee de esos registros |
| **3** | Checar | ¿Por qué ningún checador lo usa (GP.RF.8)? | con el puesto de checador: el recorrido con y sin pedidos en la cola, y los clics antes del primer escaneo. ⛔ Hasta E3 sólo se mide: GP.13 lo rehace (§5d) |
| **4** | Por capturar en Kepler | ¿Sigue haciendo falta cuando la Suite escriba SURTIDO (GP.12)? | qué le pide a Facturación y cuántos pedidos tiene hoy. ⛔ Hasta E3 sólo se mide: GP.12.3 la convierte en bandeja (§5d) |
| **5** | Revisión + Guías (caja) | ¿Cuántas pantallas y clics le toma a la caja cerrar un pedido de preventa? ¿Por qué se rechaza uno de cada diez cierres? | clics por pedido; frecuencia de encuesta (GP.RF.6). 🧪 el motivo de cada rechazo queda registrado (GP.RF.42). D9: sólo se audita |
| **6** | Clientes nuevos | ¿Es una pantalla, o es un aviso dentro de Surtir o del Tablero? | qué hace la persona ahí y cuántas veces |
| **7** | Ubicaciones (fase UB) | ¿Mapa y contenido son una sola tarea? | ✅ adelantado: §5b (captura de punta a punta, 2026-11-17). Falta: medir con el puesto que captura y en celular |

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
| GP.RF.45–47 | EA | 🟠 | «Por autorizar»: el panel no mostraba lo vencido ni sus facturas, y el estado de cuenta sólo salía como PDF. **66 facturas vivas** invisibles entre los 12 clientes que esperaban; **9 de 12 con TODO vencido**, hasta 111 días | A+B | la decisión de crédito se tomaba sin ver la deuda que la motiva | Q.4 cifra recorrible; §7 documento fuente | lo vencido al frente, las facturas al clic y liga a la ficha (§5e.2) | ✅ 2026-11-23 |
| GP.RF.48 | EA | 🔴 | Un cliente puede tener **varias claves en la misma sucursal** y el panel evalúa una: en el caso medido mostraba $83,552 de quien debe **$114,823**, todo vencido. **12 de 135** clientes de la bandeja | B | el panel enseña menos deuda de la que hay | Veracidad (ley 0) | avisar en el panel, con el saldo de la otra clave | ⬜ |
| GP.RF.49–51 | EA | 🟡 | No se podían abrir los «otros pedidos sin facturar» (ya viajaban), ni ver los últimos abonos, ni el teléfono del cliente | C | cada uno obligaba a salir a otra pantalla | Q.4 | se pintó lo que ya llega; abonos, teléfono y lo vencido por antigüedad salen de la misma llamada del desglose | ✅ 2026-11-23 |
| GP.RF.52–54 | EA | — | Hueco de DATO, no de pantalla: la promesa de pago (**0 filas en toda la base**), el historial de autorizaciones excedidas (**no existe**) y el RFC para las listas del SAT (73 de 366) | B | la decisión se toma sin esos tres | ADR-056: lo que no hay no se dibuja | se declaran; no se pinta un lugar vacío | ⬜ |
| GP.RF.55–59 | EA | 🟠 | **La bandeja no tiene ningún filtro** y mezcla 6 sucursales; «aparte» trae **782 renglones, 604 de ruta vecinal** que no le tocan a crédito | A+B | la lista grande no se puede trabajar | Hick; Jakob (tabla = Excel) | chips de motivo con su conteo, sucursal y búsqueda en una línea, orden en el encabezado (§5e.4) | ⬜ |
| GP.RF.3, 4, 6, 8, 9 | 0 | — | ver §4.5 | B | ver §4.5 | Retrabajo (`auditoria-diseno` §3c) | se confirman en su paso, con el puesto que los vive | ⬜ |
| GP.RF.10 | 0 | 🟠 | Tablero: el marco ocupa **415 de 768 px** (54 %) antes de la primera fila; 7 pestañas, 58 accionables y 108 cifras en la primera pantalla. Paso 1 (2026-11-17): igual, con 125 cifras. Con GP.10.4 en prod: 5 pestañas, 50 accionables, 83 cifras, pero **507 px** de marco (GP.RF.20) | A | más de media pantalla sin trabajo, en la pantalla más consultada | Carga visual (`auditoria-diseno` §3c); Q.1 | GP.10.4 ya quita 2 pestañas; el «después» se mide al desplegar | 🔨 |
| GP.RF.11 | 0 | 🟠 | Checar pide elegir el almacén en un `<select>` nativo antes de cualquier cosa | A | un clic de más en cada entrada | Hick; sistema de diseño (`p-select`) | paso 3: preseleccionar si la persona tiene un solo almacén. Medido en el código: ya preseleccionaba (el guardado, el suyo o el único) | 🧪 2026-11-18: `p-select` por nombre con rótulo visible; ya no se ve «06 · Canindo» (§5c.9) |
| GP.RF.12 | 0 | 🟡 | Letra de 10 px en las 12 pantallas; hasta 9 niveles de letra (Revisión) | A | lectura forzada; jerarquía diluida | Q.5; escala `--fs-*` | se revisa pantalla por pantalla | 🧪 2026-11-18: nada bajo 11 px en las pantallas del alcance; la pastilla a 12; el Tablero en celular de 11.2 a 14 px con sus 35 celdas; las tablas sin `.dt-stack` a 12 px y sin columnas escondidas; Revisión de 6 tamaños a 4 niveles (sin medir en el navegador) (§5c.9) |
| GP.RF.13 | 0 | 🟡 | «1» en ámbar `--warn-fg` sobre blanco a 2.15:1 en Por capturar; «Salir» a 4.40:1 en Surtir | A | ilegible a pleno sol en el celular | WCAG AA; `VALORES.md` §2 | `--warn-soft-fg` para texto | 🧪 2026-11-18: el «1» a 7.09:1; «Salir» y todo botón sin relleno pasan AA desde el tema; otros 14 textos ámbar o verde de las pantallas del alcance a su tono para texto (§5c.9) |
| GP.RF.14 | 1 | 🔴 | La fila de surtido muestra **25 surtidos abandonados** como si fueran trabajo de hoy. Canindo: 11, todos «Esperando hace 12 días». Morelia Abastos: 14, desde el 8-oct. En 30 días hubo 17 surtidos, los armó el sistema y se terminaron 5 | A + B | quien coordina no distingue el trabajo de hoy del abandonado; el surtidor que pide trabajo recibe primero el más viejo | Ley 0 del estándar (nada afirma lo que no es) | **P-RF.4**: que el sistema deshaga lo que armó y nadie tomó | ⬜ espera a Edgar |
| GP.RF.15 | 1 | 🟠 | «58 pedidos siguen autorizados en Kepler… revísalos en Kepler»: una cifra publicada que **no se puede abrir** en la Suite | A + B | ver cuáles era imposible sin salir de la Suite | Cruce 1 de `auditoria-diseno` (toda cifra se recorre) | la cifra liga al Tablero filtrado por estatus de Kepler; cuadra 393 de 393 (§5.4) | ✅ en prod `4d99357f7` (la cifra de su nota, corregida en GP.10.5 🧪) |
| GP.RF.16 | 1 | 🟠 | El Tablero **no dice nada de los atorados** en su primera pantalla. Son 393 en 8 sucursales, el más viejo de nov-2025 | A + B | quien coordina no se entera de lo que nadie va a surtir | Q.1 (contestar primero); Q.4 (el número lleva a su arreglo) | aviso arriba del Tablero con la cuenta del alcance de la persona; pide que la API los cuente | 🧪 2026-11-18: `GET warehouse/orders/atorados` (sólo lectura, 60–170 ms en prod; 396 en 8 sucursales, cuadra sucursal por sucursal con la cuenta de la fila) y el aviso con «Velos» (§5c.9) |
| GP.RF.17 | 1 | 🟡 | Quien maneja varios almacenes cae en el primero (CEDIS, con la fila vacía) y da 2 clics para llegar al suyo. Después se recuerda | A | 2 clics la primera vez | Hick | abrir en el almacén que tiene trabajo; baja prioridad | 🧪 2026-11-18: sin preferencia guardada abre en el almacén de la persona, y nombra sin número (§5c.9). «El que tiene trabajo» pediría que la API cuente por almacén: no se hizo |
| GP.RF.18 | 1 | 🟡 | «Cancelar surtido» en rojo sobre blanco a **3.76:1** (bajo AA), una vez por renglón y junto a «Marcar urgente» | A | 6 textos bajo AA en la fila; una acción destructiva al alcance en cada renglón | WCAG AA; Von Restorff (§10) | el botón de peligro sin relleno viene del tema: arreglarlo ahí cambia toda la suite, y eso pide aprobar el cambio de tokens. Edgar: «corrijamos todo lo que está mal» | 🧪 2026-11-18: en el tema, rojo 700 = 6.47:1 (§5c.9). «Cancelar» apartado del resto de acciones en cada renglón (§5c.9) | 
| GP.RF.19 | 1 | 🟡 | El Tablero con un rango largo (hasta un año) tarda **0.2 a 1.8 s** desde la laptop | B (servicio real) | la liga de los atorados puede pasar el medio segundo | regla de Edgar: más de 500 ms no funciona | va con GP.10.5 (la consulta lee todo el rango antes de filtrar el estatus) | 🧪 2026-11-18: con filtro de estatus filtra antes de leer renglones; la liga de atorados de 1.8–2.2 s a 171–184 ms en prod (§5c.9) |
| GP.RF.20 | 1 | 🟠 | Con GP.10.4 el marco del Tablero creció de **415 a 507 px** (66 % de la pantalla): el cambio de vista ocupa un renglón propio, y se sumaron más botones de etapa y el aviso de tope | A (antes y después en prod) | 92 px más de marco en la pantalla más consultada | Carga visual; Q.1 | el cambio de vista pasa a la cabecera (+50 px medidos en maqueta sobre prod, §5.5); el aviso de tope se va con GP.10.5 | ✅ en prod `4d99357f7`: 507 → 457 px medido |
| GP.RF.21 | 1 | 🟡 | Abrir un pedido de preventa pasó de **2 a 4 clics**: la preventa entró a una lista de 2,224 que va por fecha, y para verla hay que elegir el origen en un desplegable | A (antes y después en prod) | 2 clics más por consulta de preventa | Hick; menos clics (§1) | un botón «Preventa» con su conteo junto a los de etapa | 🧪 2026-11-18: «Preventa N» a un toque (la API cuenta por origen con la misma etapa que la lista); medido en el navegador (§5c.9) |
| GP.RF.22 | 1 | 🟠 | «Existen demasiadas cosas» (Edgar). El Tablero abría en «Todos», con 1,396 de 2,389 pedidos ya embarcados; tenía 22 controles antes de la primera fila, dos rellenos naranjas que competían, 9 columnas (dos casi siempre en «—»), párrafos de ayuda en la cabecera y el volumen encimado sobre la etapa en 36 de 200 filas | A + B | lo que se lee antes de encontrar el trabajo; 58 % de la lista ya había salido | Carga visual; Hick; Von Restorff (una primaria); regla P | abre en «Por hacer» (decisión de Edgar); periodo en un desplegable; Surtir y Checar de contorno; Abierto y Guía bajo fecha y etapa; ayuda al «?»; volumen partido (§5.7) | 🧪 |
| GP.RF.23–29 | 2 | 🔴/🟠/🟡 | Surtir en el celular: 1 de cada 11 cierres rechazado sin motivo guardado (23), primer pedido a 958 px (24), «Hoy · 39» contra 115 en la lista (25), sin «No hubo» (26), Surtir (Kepler) escribe al abrirse (27), 17.6 s y select nativo con código (28), «500 clientes nuevos» topado sin aviso (29) | A + B + C | ver §5c.2 | ver §5c.2 | se proponen en §5c; los de renglón esperan la sesión de surtidor | 🧪 todos (2026-11-18): 27, 28 y 29 en §5c.5–5c.6; 24, 25 y 26 eran de `/almacen/surtir-preventa`, retirada en GP.RF.32 (en Surtir, «No había nada» está a dos toques); 23: el motivo de cada cierre rechazado queda en el canal de incidentes (§5c.9). La causa del 1 de cada 11 se sabrá con esos registros |
| GP.RF.35 | 2 | 🟠 | «No reestructuraste la interfaz» (Edgar). La primera tarjeta empezaba a 1,001 px a 390 de ancho, cada pedido traía su botón naranja, el aviso de clientes iba arriba de todo, y al abrir un pedido de abajo la vista quedaba a media lista | A (Playwright, árbol con lecturas de prod) | el trabajo fuera de la primera pantalla; un desplazamiento para encontrar el primer producto | Carga visual; Fitts; Von Restorff | lista y pedido rehechos con la maqueta aprobada (§5c.6): 1,001 → 504 px; el pedido abre arriba; el escáner queda fijo | 🧪 |
| GP.RF.36 | 2 | 🟡 | «Rutas de hoy» pintaba un esqueleto de 181 px y, sin rutas, desaparecía: la lista saltaba | A | posible fuente del CLS 0.23 de §5c.3; un toque que cae en otra tarjeta | Doherty; estabilidad (CLS) | sin esqueleto en la primera carga (§5c.6) | 🧪 |
| GP.RF.37 | 2 | 🟡 | El escáner salía con borde ámbar (clase compartida con un aviso) y 10 textos en `--warn-fg`/`--ok-fg` (2.15:1 y 3.30:1) | C + A | ilegible a pleno sol; el escáner parece un aviso | WCAG AA; `VALORES.md` §2 | `--warn-soft-fg`/`--ok-soft-fg` (7.1:1) y clase propia | 🧪 |
| GP.RF.38 | 2 | 🟠 | Con un pedido abierto, el «atrás» del celular sacaba de Surtir; el foco caía en `<body>` al abrir y al volver; la página no tenía h1; el renglón de vendedores escondía su barra sin pista (3 de 6 fuera de vista) y cortaba el anillo de foco; en alto contraste la opción elegida sólo se distinguía por la negrita | A (Playwright, API sintética) | un viaje entero para regresar al pedido; un toque al buscador antes de escanear; vendedores que no se ven | `stack-drill-down`, `accessibility`, `scrollability-affordance-hints`, `color` (Modern Web Guidance) | historial con `?pedido=`, foco al h1 y a la tarjeta, h1/h2, desvanecido y anillo completo, contorno `Highlight` (§5c.7) | 🧪 |
| GP.RF.39 | 2 | 🟠 | Las flechas no elegían en NINGÚN `role="radio"` que dependiera del listener global: el listener se desconocía a sí mismo al escribir `tabindex` | A + prueba | el patrón que el lector de pantalla anuncia no funciona; el Tab entraba por la opción vieja | `accessibility` §2 (el rol promete su teclado); D.4 de `DESIGN.md` | marca propia y repaso con `aria-checked`, con 6 pruebas (3 rojas antes) (§5c.7) | 🧪 |
| GP.RF.40 | 2 | 🟡 | El CLS de la carga (0.056) es el cambio de fuente: la tarjeta se re-parte en dos renglones cuando llega Hanken Grotesk (`display=swap`) | A | la lista brinca 22 px al cargar; un toque puede caer en otra tarjeta | `visually-stable-font-fallbacks`; Doherty | 2026-11-18: la causa era el folio en Geist Mono (Consolas 8.4 % más angosta). Respaldos con `size-adjust` para Hanken y Geist Mono en `tokens.css`: Surtir 0.052 → 0.0008, igual que sin cambio de letra (§5c.8) | 🧪 |
| GP.RF.41 | 2 | 🟡 | El selector de almacén y los chips de origen sólo tenían `aria-label`: con el almacén elegido, el selector mostraba un nombre sin decir qué era | A | adivinar qué es cada control; regla `forms` | `forms` («DON'T use aria-label when a visible label can be used»); `accessibility` | rótulos visibles «Almacén» y «Pedidos de» encima de cada control, siguen en un renglón (+22 px) (§5c.8) | 🧪 |
| GP.RF.42 | 5 | 🟠 | La revisión en caja rechaza 20 de 187 cierres (10.7 %, todos 4xx) y el motivo no queda en ningún lado: el servidor no lo guarda y el aviso dura 8 s | B | uno de cada diez cierres de caja se repite sin saber por qué | Retrabajo (`auditoria-diseno` §3c) | registrar el motivo como en Surtir (GP.RF.23): código, mensaje, renglones, bajados, si venía guardada y minutos abierto | 🧪 2026-11-19 (§5d). En prod desde ese día (`e8774698e`): en los primeros 50 min hubo 2 cierres de caja y ningún rechazo, muy pocos para decir algo. La causa se lee de los registros |
| GP.RF.43 | 1 | 🟡 | Con todas las sucursales, la lista leía los renglones de cada pedido con ~5 búsquedas en el índice en vez de una: el `c1` (2ª columna de la llave de `kdm2`) iba con `btrim` y no por igualdad. ⚠️ La cifra con que se abrió («supervisor 577–1,656 ms») salía de 1 a 3 llamadas por día y **se corrigió**: en promedio el Tablero ya abría bajo 500 ms para todos los puestos (§5d) | B (prod en `md`, sólo lectura, como `app_runtime`: plan y tiempos de antes y después en la misma foto) | todas las sucursales, noviembre: mediana 241 → 184 ms, bloques 61,966 → 31,741; una sucursal sin cambio (25 ms) | regla de Edgar: más de 500 ms no funciona | `c1` por igualdad con el del encabezado. Mismas 1,880 filas, idénticas columna por columna (28,887 renglones de los dos lados); ningún `c1` de `U-D-40` trae espacios (14,134 encabezados, 208,278 renglones). Descartado: el índice de fecha (leería 70,980 documentos del mes contra 14,133) y contar los renglones con el índice armando el volumen sólo de la página (otros −60 ms, parte la consulta en dos) | 🧪 En prod desde el 2026-11-19 (`e8774698e`). Después, en `pg_stat_statements` (la consulta nueva lleva su propio registro): 20 llamadas en 45 min, todas bajo 250 ms y sin leer del disco; las 5 que vieron todas las sucursales del mes (1,880 filas), de 101 a 145 ms. Falta una lectura en frío y `ui_usage` por rol con días completos |
| GP.RF.44 | 2 | 🟠 | Surtir avisa «no se pudo terminar» cuando el cierre **sí se guardó**. El registro de GP.RF.23, en sus primeras horas en prod: de 3 rechazos, ninguno era real. Un 504 llegó medio segundo después de que el servidor guardó el cierre. Dos 409 («ya se terminó de surtir»), con 6 s entre uno y otro, eran el mismo pedido reabierto 15 min después de cerrarlo: «Empezar» deja pasar un pedido terminado y la pantalla lo pintaba en curso, con las marcas guardadas en el celular | B (registros y cierres en prod, sólo lectura) + prueba | la persona repite un cierre que ya estaba hecho, o cree que no se guardó; el «1 de cada 11» de GP.RF.23 mezcla rechazos falsos con reales | Ley 0 del estándar; retrabajo (`auditoria-diseno` §3c); idempotencia visual (§10) | al abrir, un pedido ya surtido no se pinta en curso: se borran sus marcas, se dice quién lo cerró y a qué hora y se vuelve a la lista. Al cerrar con 409, 5xx o sin respuesta se relee el pedido antes de decir que falló; si lo cerró esta persona queda cerrado, si lo cerró otra se dice quién. El incidente se registra igual, con `ya_guardado`. Sólo pantalla: el endpoint que escribe no cambia | 🧪 2026-11-19: 7 pruebas (3 negativas), 123 en verde; con el arreglo quitado, 5 en rojo |
| GP.RF.30 | 2 | 🟠 | «Salir» de Surtir (y de Checar) no regresa a donde estabas: iba fijo a /almacen, que brinca a la primera pantalla del área. Del Tablero a Surtir, «Salir» dejaba en Inventario; para el surtidor, en Surtir misma (no hacía nada). Lo encontró Edgar | A (reproducido en prod con salir-foco.e2e.ts) | un viaje entero para volver a donde se estaba | Jakob (Atrás vuelve a donde estabas) | regresa a la pantalla anterior; sin ella, al Tablero, o a «Mi trabajo» si el puesto no lo abre | 🧪 |

---

## 9. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-19 | **GP.RF.42 y GP.RF.43 en prod, y el primer hallazgo del registro de rechazos** (Edgar: «sigamos con todo el proceso… si todo pasa lo enviamos a producción»). `/api/health` sirve `e8774698e`. El Tablero con todas las sucursales tarda de 101 a 145 ms en prod. El registro de cierres rechazados de Surtir, en sus primeras horas, mostró que ninguno de los 3 rechazos era real: el cierre ya estaba guardado. Por eso GP.RF.44 relee el pedido antes de decir que falló, y no vuelve a abrir en curso un pedido que ya se surtió. | Edgar (pedido), Claude |
| 2026-11-19 | **Revisión del plan y meta de la consola medida** (§5d), a pedido de Edgar («revisa el plan»; todo sigue en pruebas). La consola muestra el 100 % de los pedidos del mes contra un testigo aparte (Kepler 1,737, preventa 1,020) y abre en menos de medio segundo para quien opera una sucursal, no para quien ve varias (GP.RF.43). Corregido en código: la caja registra el motivo de cada cierre rechazado (GP.RF.42) y el seguimiento de la cotización dice «Pedido cancelado en Kepler» (GP.10.1b: 3 de 6 cancelados decían «Embarcado»). Checar y Por capturar sólo se miden hasta E3. Ese mismo día salió a prod (`c11d75014`) lo del 18-nov. | Edgar (pedido), Claude |
| 2026-11-23 | **Contestada la auditoría y construida** (Edgar marcó **las diez** opciones: *«abarcar la mayor cantidad de información… pero sin saturarlo, sólo cuando ella quiera acceso»*). Cinco de las siete pendientes salían de la **misma llamada** que el panel ya hacía al abrir el desglose: lo vencido **por antigüedad** (sin pintar los tramos en cero), los **últimos pagos**, la **promesa** —que hoy dice «sin promesa registrada», porque la tabla está vacía en toda la base— y el **teléfono**, arriba y sin plegar. Los **otros pedidos** ya viajaban y sólo faltaba publicarlos. Cada bloque lleva su número en el título, así informa sin abrirse, y al cargar el panel sigue sin salir ninguna llamada. 31 pruebas con sus negativos y un mutante en rojo. Quedan las dos que piden dato nuevo: la clave duplicada y el historial de excedidos | Edgar (criterio), Claude |
| 2026-11-23 | **Auditoría de «Por autorizar» (anexo EA): qué necesita el auditor de crédito y cómo presentárselo** (§5e), a pedido de Edgar («a la interfaz le faltan filtros, información»). La telemetría ordenó el diseño: **883 aperturas de la ficha del cliente al mes contra 7 del PDF** —y ninguna del área—, así que el PDF salió del panel y lo reemplazó una liga a la ficha; y la bandeja tiene **3 hits en un día, sólo superadmin**: todavía no está en la rutina de nadie. Hallazgos nuevos GP.RF.45–59: tres ya corregidos (lo vencido al frente, las facturas al clic, el estado de cuenta en pantalla), la clave duplicada en 🔴 (**12 de 135** clientes; un caso mostraba $83,552 de quien debe $114,823), cinco filtros con su cifra (**782 renglones en «aparte», 604 de ruta vecinal**) y tres huecos de DATO que no se dibujan (promesa de pago con 0 filas, historial de excedidos inexistente, RFC). La forma la fijó Edgar: *«nada al cargar; la información se suelta en base a la búsqueda del usuario»* | Edgar (pedido), Claude |
| 2026-11-19 | **GP.RF.43, la carga de quien ve varias sucursales, corregida y optimizada** (Edgar: «sigue con la velocidad del tablero»). La cifra de la mañana exageraba: eran promedios por día de 1 a 3 llamadas. En 10 días, por llamada, todos los puestos abren bajo medio segundo en promedio; los picos de más de un segundo los tiene también quien opera una sola sucursal y son lecturas en frío del disco. Lo que sí cuesta ver todas, leer los renglones de cada pedido, baja de 241 a 184 ms con el `c1` por igualdad, con las mismas filas. | Edgar (pedido), Claude |
| 2026-11-18 | **El brinco al cargar y el rótulo del almacén** 🧪 (GP.RF.40–41), a pedido de Edgar («hagámoslo»). El brinco de Surtir no era Hanken sino el folio en Geist Mono, que se pinta primero en Consolas, 8.4 % más angosta. Respaldos con las medidas de la letra web en `tokens.css`, para las tres apps: Surtir en el celular pasa de 0.052 a 0.0008, lo mismo que sin cambio de letra. Se descartó `font-size-adjust`, la vía principal de la guía: medido, empeoraba el ancho. El selector de almacén y los chips de origen llevan rótulo visible y siguen en un renglón (§5c.8). | Edgar (pedido), Claude |
| 2026-11-18 | **Surtir re-auditado con Modern Web Guidance** 🧪 (GP.RF.38–40), a pedido de Edgar, con 12 guías y Playwright sobre una API sintética (la sesión de prod venció). Con un pedido abierto, el «atrás» del celular ya no saca de Surtir; el foco va al pedido y regresa a su tarjeta; hay h1; el renglón de vendedores dice que hay más y no corta el anillo de foco. Salió un defecto global: las flechas no elegían en ningún `role="radio"` sin teclado propio (GP.RF.39, arreglado en `libs/ui-web` con su prueba roja antes). El CLS es el cambio de fuente de toda la Suite (GP.RF.40, propuesto). De paso: el merge `223e12668` de otra sesión había dejado una línea `=======` en el spec de Surtir y el archivo no compilaba; se quitó (§5c.7). | Edgar (pedido), Claude |
| 2026-11-17 | **Surtir reestructurado** 🧪 (GP.RF.35–37 y GP.RF.29), con la maqueta que aprobó Edgar después de decir «no reestructuraste la interfaz». Medido con Playwright, con su control y su negativa: a 390 px la primera tarjeta pasa de 1,001 a 504 px, el pedido abre arriba (antes a −1,381 px) y el escáner queda fijo. De paso salieron: el esqueleto de «Rutas de hoy» que hacía saltar la lista, el escáner con borde de aviso, 10 textos bajo AA y el «500 clientes» topado. Primero salió un encimado que era falso positivo del instrumento: se corrigió y se probó el detector con una maqueta rota (§5c.6). | Edgar (maqueta), Claude |
| 2026-11-17 | **GP.RF.30 en código** 🧪: «Salir» de Surtir y Checar regresa a la pantalla de donde se llegó. Reproducido en prod antes del arreglo: del Tablero a Surtir, «Salir» dejaba en Inventario. | Edgar (lo encontró), Claude |
| 2026-11-17 | **Paso 2 (Surtir) arrancado: línea base** (§5c). La preventa se surte en Surtir › Sucursal (925 cierres en 30 días, 84 rechazados sin motivo guardado; se corrigió el mismo día la atribución a `/almacen/surtir-preventa`, que no tiene uso medido). Telemarketing casi no se usa, escribe al abrirse y es lo lento (tomar siguiente: 2.7 s de promedio, hasta 21 s). En el celular, Surtir tarda 4.5 s en pintarse el 75 % de las veces y la pantalla se mueve (CLS 0.23). Falta la sesión de un surtidor para medir los renglones. | Claude, a pedido de Edgar |
| 2026-11-17 | **GP.RF.22 en código** 🧪, a pedido de Edgar («existen demasiadas cosas»). Entre dos maquetas eligió abrir en «Por hacer» (983 de 2,389). Además: periodo en un desplegable, Surtir y Checar de contorno, Abierto y Guía bajo fecha y etapa, ayuda al «?», y el volumen partido en renglones. **Corrige** lo dicho de GP.10.5: el volumen sí se encimaba (36 de 200; con el arreglo, 0). | Edgar, Claude |
| 2026-11-17 | **Desplegado** `4d99357f7` (GP.RF.15, GP.RF.20, UB.RF, UB.3b.1, UB.RF.10) y medido en prod con Playwright: GP.RF.20 real da los 50 px de la maqueta; el escaneo arma la asignación correcta; los carteles se dibujan. El recorrido encontró que la nota de los atorados decía 1,885 con 58 filas (defecto de GP.RF.15). **GP.10.5 en código** 🧪: lista por páginas (antes 1.40 MB, 2,000 de 2,358, 348 preventas invisibles), total por destino (D4: $22.1 M de traspasos se leían como venta), leyenda del volumen, y la nota corregida. (Corregido el mismo día: el volumen SÍ se encimaba, 36 de 200; el instrumento medía la caja y no el texto. Ver §5.5.) | Claude, a pedido de Edgar |
| 2026-11-17 | **Ubicaciones adelantado** a pedido de Edgar (§5b). El piloto no tiene ninguna ubicación; las 375 de CEDIS parecen una prueba en zona Tienda (UB.RF.2, decisión de Edgar). Arreglados en código: la cifra animada que se quedaba en el valor anterior (UB.RF.1, afecta a toda la suite), «no hay capturas» mientras lee, el texto falso del mapa, la zona en la que abre y un `ngModel` sin `name` | Claude |
| 2026-11-17 | **GP.RF.20 hecho** 🧪: el cambio de vista sube a la cabecera. En maqueta sobre prod, la primera fila sube 50 px en los tres anchos y la cabecera no se parte (con su prueba negativa). La primera maqueta medía mal (dejaba vivo el CSS viejo) y se corrigió antes de citarla | Claude |
| 2026-11-17 | **«Después» de GP.10.4 medido** en prod `5b9d9af58` (salió en el lote que empujó otra sesión). Mejora: de 7 a 5 pestañas, una sola pantalla para seguir un pedido, menos piezas. Empeora: marco 415→507 px, lista topada a 2,000 con 1.40 MB, y la preventa de 2 a 4 clics. Nuevos: GP.RF.20 y GP.RF.21 (§5.5) | Claude |
| 2026-11-17 | **Paso 1 medido** en prod `7edf9508a` (el «antes») con la sesión de Edgar. Quien coordina no ve lo atorado sin clic: el Tablero no lo dice, la fila lo cuenta sin dejar abrirlo, y 25 de sus 27 surtidos son abandonados. Se hizo GP.RF.15, la cifra de atorados liga al Tablero (cuadra 393 de 393) 🧪. Nuevos: GP.RF.14–19 y P-RF.4 | Claude |
| 2026-11-14 | Paso 0.3 medido con la sesión de Edgar (superadmin), en prod `d88bfc45a` (sin GP.10.4: es el «antes»). Separados por rol, cuatro de los siete hallazgos de base eran pruebas de Dirección o la vista de superadmin: se retiran o corrigen (§4.5). Nuevos: GP.RF.8–13 | Claude |
| 2026-11-14 | Nace el documento, a pedido de Edgar. Paso 0: instrumento con control y negativa ✅, blindaje contra escrituras en prod ✅, inventario y uso medidos, línea base por pantalla NO MEDIDA (falta la sesión, P-RF.1). Alcance acotado por Edgar al plan GP y a lo trabajado en la sesión | Edgar, Claude |
