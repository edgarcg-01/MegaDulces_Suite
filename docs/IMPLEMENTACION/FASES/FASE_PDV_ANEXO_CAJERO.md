# Anexo PDV — Qué ve el cajero y cómo se opera sólo con teclado

> Anexo de [`FASE_PDV_PUNTO_DE_VENTA.md`](FASE_PDV_PUNTO_DE_VENTA.md) · 2026-10-31 · pedido de Edgar:
> *«investigación psicológica y visual (desde el lado UI) sobre qué debe ver el cajero; cómo optimizar
> aún más su trabajo: todo por teclado, menos clics, menos interfaces, visibilidad 100 %»*.
> Reemplaza al §13 en lo que toca a la pantalla de venta. Prototipo que lo aplica: `pdv-suite.html`
> (archivo local de Edgar, fuera del repo).

## 0. En cinco líneas

1. **El cajero no mira la pantalla: la ojea.** Tiene las manos en el producto y el escáner, y los ojos en el cliente y la gaveta. Cada ojeada debe contestar **una** pregunta. Por eso el número que importa en ese momento va enorme y siempre en el mismo lugar.
2. **Una sola pantalla.** Venta, búsqueda, cobro y autorización pasan en la misma vista. Sólo cambia el panel derecho. La lista del ticket nunca se tapa.
3. **Una sola línea de comandos con gramática de caja de supermercado:** `código ⏎`, `5*código ⏎`, `250 F12`. Nunca hace falta el ratón.
4. **Se conservan las teclas de Kepler** que los cajeros ya traen en los dedos: F9 buscar, F10 autorización para quitar y F11 existencia, leídas del fuente `pv_tk.kpl`.
5. **El cobro baja de unos 6.3 s a unos 2.5 s por ticket** (estimado con el modelo KLM, no medido). Con 3,230 tickets al día son unas 3.5 h de caja diarias en la cadena, si toda la venta de mostrador pasara por la caja de la Suite.

---

## 1. Lo que dice el dato y lo que obliga

Medido en prod (sólo lectura) del 3 al 30 de octubre de 2026; el detalle está en §1 de la fase.

| Hecho medido | Lo que obliga en la pantalla |
|---|---|
| 3,230 tickets al día en 37 cajas. En hora pico, p99 de **61 tickets por caja-hora (uno cada 59 s)** | Cada tecla y cada ojeada cuestan. Hay que diseñar para la fila, no para la caja vacía |
| **4.85 renglones** por ticket en promedio | La lista completa cabe en pantalla: «visibilidad 100 %» es alcanzable. Si un ticket crece, el renglón nuevo siempre queda a la vista |
| **81 % de los tickets dan cambio** y el 80 % del dinero entra en efectivo | El cambio es el número protagonista del cobro, y el efectivo usa la tecla más fácil (`Enter`) |
| **99.2 % de los tickets son «CONTADO»**, sin cliente | Identificar al cliente no ocupa ningún paso del camino normal. Queda en una tecla para el 0.8 % |
| 67 % de los renglones son paquete y 7 % son kilo | La presentación por defecto es la del código escaneado. El kilo entra con su peso (`1.884*código`) |
| **0 eventos con rastro** en la caja de Kepler (la «Baja» borra sin huella) | Corregir es fácil y queda registrado. Nada se borra: lo quitado queda tachado a la vista |

**No medido:** los segundos por ticket con Kepler (su `c62` sólo guarda hora y minuto); el hardware de cada caja (monitor, distancia, teclado numérico, báscula, segunda pantalla); y cuántos productos tienen código de barras por presentación. Los tres se miden en el piloto (§9).

## 2. Dónde está la atención del cajero

| Principio | Fuente | Qué decide en la caja |
|---|---|---|
| Las manos y los ojos están ocupados. La pantalla se lee en ojeadas de fracción de segundo | Card, Moran y Newell (1983), modelo KLM | La confirmación principal es **auditiva**: tono corto al agregar y zumbido grave ante un error. Así el cajero mira el producto, no el monitor |
| **Ceguera al cambio**: un cambio que ocurre mientras el ojo se mueve no se nota | Rensink, O'Regan y Clark (1997); Simons y Levin (1998) | El renglón que entra o cambia **destella** una vez y se selecciona. Un error **no se va solo**: queda en rojo hasta `Esc` |
| Los rasgos preatentivos (tamaño, color, movimiento) se notan sin buscarlos | Treisman y Gelade (1980) | La jerarquía se da por **tamaño y posición**. El color sólo indica estado (verde cobrado, ámbar aviso, rojo error) y nunca va solo, siempre con texto |
| Bajo presión la atención se estrecha y lo periférico se ignora | Easterbrook (1959) | Con fila, lo crítico (total, cambio, error) va al centro de la vista. En la periferia sólo va lo que puede esperar (red, turno) |
| La memoria de trabajo retiene unas 4 cosas | Cowan (2001) | En cada momento hay a la vista **una** cifra principal y las teclas válidas de ese momento, no las 20 de la caja |
| El tiempo de decisión crece con el número de opciones | Hick (1952); Hyman (1953) | El panel derecho cambia según el momento: vender, cobrar, cambio o autorización. Cada estado ofrece sólo sus opciones |
| Los **modos** causan errores, y una confirmación repetida se vuelve reflejo y deja de proteger | Raskin (2000), *The Humane Interface* | Nunca hay «¿Está seguro?». Lo inocuo se deshace al momento. Lo riesgoso lo autoriza **otra persona** con su PIN, que no es una confirmación. Ninguna tecla tiene dos significados de dinero |
| La atención sostenida decae con el tiempo | Mackworth (1948), vigilancia | Los turnos medidos son largos (en la maqueta, de 07:58 a 20:04). La pantalla no exige recordar nada y valida por el cajero (§6, límite de cambio) |
| Medirle la velocidad en pantalla al trabajador sube el estrés y los errores | Aiello y Kolb (1995); Carayon (1993) | **El cajero no ve un medidor de velocidad.** El supervisor ve las excepciones en `/tienda/cajas`, no un ranking de rapidez |
| Las costumbres se transfieren: la gente espera que una herramienta funcione como las que ya conoce | Ley de Jakob (Nielsen) | Se conservan las teclas de Kepler (§5) y la convención mexicana de `F12` para cobrar |

## 3. Qué debe ver el cajero, momento por momento

| Momento | La pregunta en su cabeza | Lo que ve (por jerarquía) |
|---|---|---|
| **Escaneando** | ¿Entró lo que pasé y cuánto va? | 1) **Total** enorme, a la derecha y siempre en el mismo lugar. 2) **Último movimiento** debajo del total: producto, cantidad e importe. 3) El renglón destacado en la lista. Además, el tono |
| **Error de escaneo** | ¿Qué pasó? | Una barra **roja** bajo la línea de comandos, con zumbido, que dice qué hacer: «No encontrado: 70001. El producto NO entró al ticket.» No bloquea los siguientes escaneos y no desaparece sola |
| **Cobrando** | ¿Cuánto falta y cuánto devuelvo? | 1) **Por cobrar** enorme. 2) Lo que va tecleando como «Recibido» y el **cambio calculado en vivo, antes de confirmar**. 3) Los pagos aplicados |
| **Cobrado** | ¿Cuánto doy de cambio? | **CAMBIO** al tamaño más grande de toda la caja. Se queda en pantalla hasta el siguiente escaneo, mientras cuenta las monedas |
| **Autorización** | ¿Qué pido y quién lo autoriza? | El panel dice qué se quita, cómo cambia el total y que el renglón queda tachado. Muestra los motivos con número (1–4) y el PIN del supervisor |
| **Siempre, en la periferia** | ¿Estoy en línea? ¿Quién está? | Caja, sucursal, cajera, folio del ticket, «En línea · 0 por enviar a Kepler» y la hora |

**Ver toda la información sin abrir nada:**
- Todos los renglones están a la vista, también los quitados (tachados, con motivo y quién autorizó).
- El renglón nuevo siempre se desplaza a la vista.
- Nada importante vive en una pestaña, un menú o una ventana encima.
- El ticket recién cobrado sigue en pantalla junto al cambio hasta que entra el siguiente cliente.

## 4. Qué NO debe ver, y por qué

| No ve | Por qué |
|---|---|
| Cuánto debería haber en la gaveta | Saber el esperado permite «cuadrar» lo que falta. Por eso el corte es ciego (el benchmark, y el 92.2 % de cortes de Kepler con «contado» igual al esperado) |
| Costo, margen y proveedor | No decide nada en el mostrador y es información sensible |
| Su velocidad comparada con otras cajeras | Estrés y errores (Aiello y Kolb). Eso es del supervisor |
| Existencias de otras sucursales, salvo que las pida (F11) | Sólo sirve cuando el cliente pregunta. Lo demás es ruido |
| El detalle técnico de Kepler (folio de Kepler, errores de envío) | Le basta «En línea · N por enviar». El detalle es del supervisor (`/tienda/cajas`, Consulta) |
| La vista previa del ticket de 80 mm | El ticket se imprime. En pantalla compite con el total y no responde ninguna pregunta del momento |
| Botones de acciones que no puede hacer | Si una acción pide autorización, la tecla lo dice al usarse. No se dibujan diez botones grises |
| Un medidor de «artículos por minuto» | Mismo motivo que la comparación de velocidad |

## 5. Visual

**Tamaño.** ISO 9241-303 pide letras de al menos 16′ de arco, y de preferencia de 20 a 22′.
- A unos 70 cm (cajero de pie; distancia **no medida**), 20′ equivalen a **4.1 mm** de altura de mayúscula.
- En un monitor de 15.6″ a 1366×768, el píxel mide 0.25 mm. Entonces 4.1 mm son unos 16 px de mayúscula, o sea **letra de 22–24 px** para lo que se lee de un vistazo.
- El mínimo absoluto (16′) da letra de unos 18 px.
- Resultado en el prototipo: base 18 px, renglones de 19 a 20 px, total de 64 px y cambio de 80 px. El total mide unos 11 mm de alto y el cliente también lo lee a 1–2 m.
- ⛔ Los tamaños se calibran en mm contra el monitor real, porque el mismo número de px se ve más chico en pantallas más densas.

**Polaridad.** Un fondo claro con texto oscuro mejora la agudeza visual y la lectura, en jóvenes y en mayores (Piepenbrock *et al.*, 2013). Con la luz de una tienda, la caja usa **siempre fondo claro**, aunque la computadora esté en modo oscuro.

**Color.**
- Sólo indica estado: verde cobrado, ámbar aviso, rojo error, y el naranja de acción en el foco y en lo seleccionado.
- Cerca de 1 de cada 12 hombres distingue mal rojo y verde, así que todo estado lleva texto.
- El contraste del texto es de al menos 4.5:1 (WCAG 2.2 AA).

**Movimiento.** Un solo destello de 0.7 s en el renglón que cambia, y ninguna otra animación. Con `prefers-reduced-motion` se apaga.

**Posiciones fijas.** El total, el cambio y la línea de comandos nunca se mueven. La lista crece hacia abajo sin empujar el panel. La memoria espacial ahorra búsqueda visual.

## 6. Teclado: la gramática de la caja

**Una línea de comandos que adivina la intención por la forma** de lo tecleado, sin cambiar de pantalla:

| Se teclea | Pasa | Origen |
|---|---|---|
| `33061 ⏎` (o el escáner) | Agrega una pieza | Caja de supermercado |
| `5*33061 ⏎` | Agrega 5 | Caja de supermercado (cantidad antes del código) |
| `1.884*17083 ⏎` | Agrega 1.884 kg (mientras no haya báscula integrada) | Igual, con decimales |
| letras, p. ej. `coca` | Lista en línea (sin acentos y en cualquier orden): `↑↓` y `⏎` | Mientras escribes |
| `250 F12` | Cobra $250 en efectivo y cierra si alcanza | Caja de supermercado (importe y luego tecla de pago) |
| `F12` y `⏎` | Abre el cobro y cobra exacto en efectivo | Convención de cajas mexicanas |

**Mapa de teclas.** Las de Kepler se leyeron del fuente `pv_tk.kpl`: F9 busca en todos sus campos, F10 abre `pv_aut_cambios`, F11 muestra la existencia y F1 la ayuda.

| Tecla | Vendiendo | Cobrando | Nota |
|---|---|---|---|
| `Enter` | Agregar | **Efectivo** (vacío = exacto) | La acción más frecuente lleva la tecla más fácil |
| `+` / `−` (teclado numérico) | ±1 al renglón seleccionado | — | `−` sobre el último escaneo dentro de 15 s es **corrección inmediata**, sin supervisor y registrada. Fuera de eso pide supervisor |
| `↑` `↓` | Mover el renglón seleccionado | — | |
| `F4` | Cambiar la presentación (la cantidad vuelve a 1) | — | Evita que «5 PAQ» se vuelva «5 CJA» sin querer |
| `F8` | Suspender o recuperar el ticket | — | |
| `F9` | Buscar | — | **Kepler** |
| `F10` / `Supr` | Quitar renglón (supervisor) | — | **Kepler** |
| `F11` | Existencia en otras sucursales | — | **Kepler**. Sólo en modo quiosco: el navegador usa F11 |
| `Ctrl`+`Supr` | Cancelar el ticket (supervisor) | — | Combinación a propósito: lo destructivo no cae con un dedo |
| `F12` | Cobrar | — | Con importe tecleado, cobra en efectivo |
| `F2` / `F3` | — | Tarjeta / transferencia por el saldo | No significan nada al vender, así que no hay error de modo con dinero |
| `Esc` | Borrar lo tecleado o cerrar la búsqueda | Volver (si no hay pagos aplicados) | **Nunca destruye nada** |

**Reglas que hacen que el teclado no falle:**
1. **El escáner es un teclado.** Teclea el código y un `Enter` en lo que tenga el foco. Si el foco quedó en un botón, el `Enter` del siguiente escaneo «presiona» ese botón. Por eso **el foco nunca sale de la línea de comandos**: un clic en cualquier parte lo regresa, y los botones no toman el foco.
2. **El escáner se distingue de la mano por la velocidad:** menos de unos 35 ms entre caracteres. Un código que llega por escáner a media cobranza regresa a la venta en lugar de tomarse como importe.
3. **Límite de cambio.** Si lo recibido supera el total por $1,000 o más, se rechaza, porque siempre habría un billete de sobra. Atrapa el error clásico de teclear un código y luego `F12`, que haría «$33,061 recibidos».
4. **Ninguna tecla tiene dos significados de dinero.** F2 y F3 sólo existen en el cobro, y F12 sólo abre el cobro.
5. **Sin «¿Está seguro?».** Lo inocuo se corrige al momento y queda registrado. Lo riesgoso lo autoriza otra persona con su PIN. La cajera no se autoriza a sí misma.
6. **Teclas del navegador.** F5 recarga, F11 pone pantalla completa y Ctrl+W cierra. La caja corre en **modo quiosco** y el ticket en curso vive en la base local (Dexie), así que una recarga no pierde nada.
7. **Cerrar el ticket no es otro paso.** Cuando el saldo llega a cero se imprime, se abre la gaveta y se muestra el cambio. **El siguiente escaneo abre el ticket nuevo** sin ninguna tecla.

## 7. Menos interfaces: de 5 vistas a 1

| Antes (lienzo y prototipo 1) | Ahora |
|---|---|
| Venta → Buscar (otra pantalla) → Cobro (otra pantalla) → Ticket → «Siguiente cliente» | **Una pantalla.** La búsqueda se despliega bajo la línea de comandos. El cobro, el cambio y la autorización ocupan el panel derecho |
| Autorización como ventana encima de todo | Panel en el mismo lugar del total. La lista sigue visible: se ve qué se quita |
| Botones de efectivo rápido (para táctil) | Teclear el importe, con el cambio en vivo. Los botones quedan sólo para pantallas táctiles |

Apertura, retiro y corte siguen siendo vistas aparte: son otra tarea, una o pocas veces por turno. El retiro obligatorio aparece **dentro** de la venta cuando la gaveta pasa el máximo.

## 8. Cuánto se ahorra (estimado, no medido)

Tiempos del modelo KLM (Card, Moran y Newell, 1983):
- K tecla: 0.28 s (tecleo promedio)
- P apuntar con el ratón: 1.1 s
- clic: 0.2 s
- H mover la mano entre teclado y ratón: 0.4 s
- M prepararse mentalmente: 1.35 s

| Cobro en efectivo | Pasos | Tiempo |
|---|---|---:|
| Prototipo 1 (ratón) | F12 + M + H + 3 × (apuntar y clic: efectivo rápido, «Cobrar e imprimir», «Siguiente cliente») + H | **≈ 6.3 s** |
| Prototipo 2, con importe | `2` `5` `0` `F12` + M | **≈ 2.5 s** |
| Prototipo 2, exacto | `F12` `Enter` + M | **≈ 1.9 s** |

Son unos 3.9 s menos por ticket. Por 3,230 tickets al día da **unas 3.5 h de caja diarias** en la cadena, si toda la venta de mostrador pasara por la Suite.
- ⛔ Es un **estimado del modelo**, no una medición.
- La línea base real (Kepler hoy) está **NO MEDIDA**.

## 9. Lo que el teclado no resuelve, y cómo se mide

**Los pasos manuales que quedan, en orden de valor:**
1. **Terminal bancaria sin integrar.** Hoy el monto se teclea dos veces (en la terminal y en la caja) y el número de autorización otra vez. Integrarla (Mercado Pago Orders, Clip, NetPay; ver el benchmark) quita la doble captura y su error.
2. **Báscula integrada** (con aprobación NOM-010): el peso entra solo, sin teclear `1.884*`.
3. **Código de barras por presentación** (pieza y caja): escanear la caja agrega CJA sin F4. Cobertura **NO MEDIDA**.
4. **Pantalla del cliente.** Ve cada renglón y el «lleva 1 más y te queda en…» (ya está en el lienzo). Reduce reclamos y regalos indebidos, porque el cliente ve lo que se cobra.

**Cómo se valida en el piloto (PDV.50).** La Suite registra cada evento con su marca de tiempo, así que se mide sin cronómetro:
- segundos por ticket (primer escaneo → cambio)
- teclas por ticket
- correcciones y «no encontrado» por cada 100 tickets
- tiempo del total al cambio

Para la **línea base de Kepler** se cronometran 50 tickets en hora pico en Yurécuaro antes del piloto. Además se hace una sesión con cajeras: cinco tareas, contar errores y cuestionario SUS.

## 10. Las 5 preguntas (`diseno` §0b), contestadas

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | ¿Qué ve y en qué orden? | Total, último movimiento, lista y periferia. Al cobrar: por cobrar y cambio en vivo. Al cerrar: el cambio |
| 2 | ¿Qué no ve? | Lo de §4: el esperado de la gaveta, el costo, su velocidad, el detalle de Kepler y la vista previa del ticket |
| 3 | ¿Qué accesibilidad necesita? | Cero clics, todo por teclado. Teclas de Kepler, letra de 22–24 px, color siempre con texto, y el error audible y persistente |
| 4 | ¿Está ligada a otro proceso? | Cada ticket va a Kepler (U-D-10) y su estado se ve en la periferia. Las excepciones van a `/tienda/cajas` y el corte ciego cierra el turno |
| 5 | ¿Le toca a esta pantalla? | Sí: vender y cobrar. Facturar, devolver y consultar tickets viejos viven en otras vistas o en Kepler (§7 de la fase) |

## Fuentes

- Card, S., Moran, T. y Newell, A. (1983). *The Psychology of Human-Computer Interaction*. Modelo KLM.
- Hick, W. E. (1952); Hyman, R. (1953). Tiempo de reacción y número de opciones.
- Treisman, A. y Gelade, G. (1980). Teoría de integración de rasgos.
- Rensink, R., O'Regan, J. K. y Clark, J. (1997); Simons, D. y Levin, D. (1998). Ceguera al cambio.
- Easterbrook, J. A. (1959). Emoción y uso de señales (la atención se estrecha bajo presión).
- Cowan, N. (2001). La capacidad de la memoria de trabajo, unas 4 unidades.
- Mackworth, N. H. (1948). Decaimiento de la vigilancia.
- Raskin, J. (2000). *The Humane Interface*. Modos y habituación a las confirmaciones.
- Aiello, J. y Kolb, K. (1995); Carayon, P. (1993). Monitoreo electrónico del desempeño y estrés.
- Piepenbrock, C., Mayr, S., Mund, I. y Buchner, A. (2013). Ventaja de la polaridad positiva. *Ergonomics*.
- ISO 9241-303:2011, altura de caracteres en pantalla. WCAG 2.2, contraste.
- Fuente de la caja de Kepler: `pv_tk.kpl` (teclas `OnF9`, `OnF10`, `OnF11`, `OnF1`), leído el 2026-10-31.
