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
5. **Medir después, igual que antes**, y registrar la diferencia en §5.

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
  inferior**: la telemetría no registra la navegación interna (ver §6, P-RF.2).
- **API** son llamadas del endpoint principal de la pantalla (`analytics.ui_usage`).

| # | Paso del pedido | Ruta | Quién | Entradas | API (30 d) | `check:pantalla` (deuda) | Estado tras GP.10.4 |
|---|---|---|---|---:|---|---|---|
| 1 | Consola maestra | `/almacen/pedidos` | coordinación, consulta | 34 | 682 lecturas (135 ms en promedio, máx. 823) | Q.1 · §2 · §9 | absorbió Preventa y Consola |
| 1a | — vista «Fila de surtido» | `/almacen/pedidos?vista=fila` | coordina el surtido | (5 por la ruta vieja) | 63 aperturas · armar 4/6 con error · tanda 2/5 con error | Q.1 · §2 · §9 · O.4 | era la Consola de surtido |
| 1b | — detalle de un `PD-` | `/almacen/pedidos/preventa?pedido=` | encargado, Dirección | 2 | 69 lecturas · ligar 14 (sólo Dirección, octubre) | Q.1 · §2 · §9 | sin pestaña: detalle de preventa |
| 2 | Surtir (celular) | `/almacen/surtir` | surtidor | 73 | «siguiente» 74 (**1.3 s en promedio**) · renglón 99 · terminar 10 | Q.1 · §2 · §9 | sin cambio; E2 le agrega carreta |
| 2b | Surtir preventa (celular) | `/almacen/surtir-preventa` | surtidor de sucursal | 0 | 6,880 lecturas · terminar 711 (72 rechazados) | Q.1 | ⚠️ duplica el modo Sucursal de Surtir (deuda con nombre) |
| 3 | Checar | `/almacen/checar` | checador | 1 | «siguiente» 16 (**9 rechazados**) | Q.1 · §2 · §9 | sin cambio; E3 lo rehace |
| 4 | Por capturar en Kepler | `/almacen/pedidos-por-capturar` | facturación | 0 | 33 lecturas | Q.1 · §2 · §9 · O.4 | se retira o queda como bandeja de fallas (paso 4b) |
| 5 | Revisión de pedidos (caja) | `/almacen/pedidos/revision` | caja | 52 | 15,974 lecturas · terminar 619 (20 rechazados) | — | D9: preventa no se toca en esta etapa |
| 6 | Guías de carga | `/almacen/pedidos/guias` | caja | 15 | 307 lecturas | Q.1 · §2 · §9 · O.4 | D9 |
| 7 | Clientes nuevos (Kepler) | `/almacen/clientes-nuevos` | encargado de sucursal | 2 | 1,213 lecturas del resumen | — | D9 |
| 8 | Ubicaciones · mapa (fase UB, paso 1) | `/almacen/ubicaciones` | almacén | 9 | 181 lecturas | §2 · §9 | de la fase UB |
| 9 | Ubicaciones · contenido (fase UB, paso 2) | `/almacen/inventory/ubicaciones` | almacén | 1 | lotes 3/6 con error · alta 2/2 con error | Q.1 · §9 · D.8 | de la fase UB |

**Leído en una línea:** el pedido de almacén se sigue hoy en **10 interfaces**, más el detalle
de un `PD-`. En tres de ellas el servidor rechaza seguido lo que la persona intenta: Checar, la
fila de surtido y el alta de ubicaciones. **Todos los rechazos medidos son 4xx** (el servidor dice
«no» por una regla) y **ningún 5xx**; «armar» no se puede separar, porque sus filas son anteriores a
esas columnas. Un 4xx no siempre es un defecto: lo es cuando la pantalla no explica por qué ni qué
hacer (§4.5).

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

### 4.3 La línea base por pantalla — ⬜ NO MEDIDA

`paso0.e2e.ts` › *0.3* recorre las 12 rutas de §3. Las de celular (Surtir, Surtir preventa,
Checar) se recorren a 390×844 con toque. En cada una mide:
- el tiempo hasta que la pantalla queda quieta;
- las mediciones de `medir.ts`;
- las llamadas a la API que fallan y los errores de consola;
- una captura.

**Falta la sesión:** se corre con `MD_TOKEN_FILE` (P-RF.1). Sin ella, la prueba se salta y dice
NO MEDIDO; no inventa un cero.

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

### 4.5 Lo que la base ya dice, antes de abrir el navegador (nivel B)

| ID | Hallazgo | Costo | Siguiente |
|---|---|---|---|
| GP.RF.1 | Checar: «tomar el siguiente» fue rechazado **9 de 16** veces en 30 días, todas 4xx | quien checa no recibe pedido más de la mitad de las veces | ver en la pantalla qué dice ese rechazo: si es «no hay pedidos», el defecto es que no se diga antes del toque |
| GP.RF.2 | Fila de surtido: «Armar surtidos ahora» falló **4 de 6** (sin poder separar 4xx de 5xx); la tanda fue rechazada 2 de 5 (4xx) | el coordinador arma a mano o no arma | recorrerlo en el paso 1 |
| GP.RF.3 | Surtir preventa: **72 de 711** «terminar» rechazados (10 %, todos 4xx) | el surtido se repite o queda abierto | recorrer el cierre en el paso 2b |
| GP.RF.7 | Surtir: «Tomar siguiente» tarda **1,303 ms en promedio** y llegó a **14,999 ms** (74 llamadas) | el surtidor espera con el celular en la mano cada vez que pide trabajo; la regla es < 500 ms | medir el servicio real en el paso 2 (consulta y armado de la ola) |
| GP.RF.4 | Revisión en caja: 20 de 619 «terminar» rechazados (4xx); el más lento tardó 2,832 ms | retrabajo en caja | paso 5 (D9: sólo auditar) |
| GP.RF.5 | Ubicaciones: el alta fue rechazada 2 de 2 y la lectura de lotes 3 de 6 (4xx) | el acomodo no se guarda | fase UB; se avisa a su dueño |
| GP.RF.6 | Revisión en caja hace **15,974** lecturas en 30 días (19 ms en promedio) | cada pantalla abierta pregunta sin parar: barato para el servidor, no medido en el celular | medir cada cuánto encuesta y si hace falta |

---

## 5. Los pasos que siguen

Cada paso arranca con la línea base de su pantalla (Playwright), recorre el proceso **completo**
con datos reales y termina con la medición de después. El orden sigue el recorrido del pedido.

| Paso | Interfaz | La pregunta del paso | Qué se mide con Playwright |
|---|---|---|---|
| **1** | Tablero + fila de surtido + detalle de `PD-` | ¿Quien coordina ve en la primera pantalla qué pedido está atorado y qué sigue, sin clic? | clics de «entro» a «prioricé» y a «armé»; carga de la primera pantalla; el volumen encimado y las unidades sin leyenda (GP.10.5); la lista topada a 2,000 |
| **2** | Surtir (celular) | ¿El surtidor termina un pedido sin pensar qué tocar? | toques por renglón; objetivos ≥44 px; qué pasa si se cae la red a medio surtido |
| **2b** | Surtir preventa | ¿Hace falta una segunda pantalla de surtir? | lado a lado con Surtir: actos que una tiene y la otra no (sustitutos, «otra unidad») |
| **3** | Checar | ¿Por qué falla «siguiente» y qué ve el checador entonces? | el recorrido con y sin pedidos en la cola; el mensaje de cada error |
| **4** | Por capturar en Kepler | ¿Sigue haciendo falta cuando la Suite escriba SURTIDO (GP.12)? | qué le pide a Facturación y cuántos pedidos tiene hoy |
| **5** | Revisión + Guías (caja) | ¿Cuántas pantallas y clics le toma a la caja cerrar un pedido de preventa? | clics por pedido; frecuencia de encuesta (GP.RF.6). D9: sólo se audita |
| **6** | Clientes nuevos | ¿Es una pantalla, o es un aviso dentro de Surtir o del Tablero? | qué hace la persona ahí y cuántas veces |
| **7** | Ubicaciones (fase UB) | ¿Mapa y contenido son una sola tarea? | recorrido de acomodar un producto; los errores de alta (GP.RF.5) |

---

## 6. Decisiones pendientes de Edgar

| # | Pregunta | Recomendación |
|---|---|---|
| **P-RF.1** | ¿Con qué sesión se recorre prod? Hace falta un `MD_TOKEN_FILE`: un archivo, fuera del repo, con el `auth_token` del navegador | Uno tuyo para empezar, porque lo ve todo. Para auditar «como su usuario», uno por puesto (coordinador de embarques, surtidor, checador, caja): cada puesto ve otra pantalla |
| **P-RF.2** | Hoy la Suite registra en qué pantalla entra o sale la persona, no por dónde navega. Lo dejó prometido por escrito: *«el evento es el clic en un enlace de navegación, no el recorrido dentro de cada módulo»* (SN.12). Sin el recorrido no se puede contar cuántos clics da la gente de verdad, ni afirmar que una pantalla no se usa | Registrar sólo la **ruta** al cambiar de pantalla (nada del contenido), y analizarla por puesto, nunca por persona. Es tu decisión porque cambia lo que se prometió |
| **P-RF.3** | ¿Se extiende después a toda la suite? (356 pantallas en `view`; el 80 % del uso en 22) | Primero cerrar este alcance; el inventario de §4.4 queda listo para cuando se decida |

---

## 7. Registro de hallazgos

Formato de cada hallazgo:
- **Qué está mal**, desde la silla de quien usa la pantalla.
- **Con qué se midió:** nivel A, B o C.
- **Cuánto cuesta**, en clics, pantallas, segundos o pesos.
- **Qué regla cobra**, de `DESIGN.md` o del estándar.
- **Decisión y estado.**

| ID | Paso | Sev | Hallazgo | Nivel | Costo | Regla | Decisión | Estado |
|---|---|---|---|---|---|---|---|---|
| GP.RF.1–7 | 0 | — | ver §4.5 | B | ver §4.5 | Retrabajo (`auditoria-diseno` §3c) | se confirman en su paso con Playwright | ⬜ |

---

## 8. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-14 | Nace el documento, a pedido de Edgar. Paso 0: instrumento con control y negativa ✅, blindaje contra escrituras en prod ✅, inventario y uso medidos, línea base por pantalla NO MEDIDA (falta la sesión, P-RF.1). Alcance acotado por Edgar al plan GP y a lo trabajado en la sesión | Edgar, Claude |
