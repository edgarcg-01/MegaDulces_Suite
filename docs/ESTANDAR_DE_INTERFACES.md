# El estándar de interfaces

> **Qué es esto.** La definición de **cuándo una interfaz está bien**, para cualquier pantalla de
> cualquier app de esta empresa. No habla de colores, tipografías ni componentes: eso es
> [`DESIGN.md`](../DESIGN.md), que implementa este estándar con el sistema «Mercado».
>
> **Dónde se para en la pila:**
>
> | Documento | Responde |
> |---|---|
> | **este** | ¿cuándo está BIEN una interfaz? |
> | [`DESIGN.md`](../DESIGN.md) | ¿con qué piezas, colores y reglas se construye acá? |
> | [`DESIGN_FOUNDATIONS.md`](DESIGN_FOUNDATIONS.md) | ¿por qué esas decisiones, con citas? |
> | [skill `diseno`](../.claude/skills/diseno/SKILL.md) | cómo se **escribe** frontend en este repo |
> | [skill `auditoria-diseno`](../.claude/skills/auditoria-diseno/SKILL.md) | cómo se **juzga** una pantalla ya hecha |
>
> Si este documento y otro se contradicen, **gana éste** y hay que corregir el otro.

---

## Ley 0 — Una interfaz es una afirmación sobre la realidad

Todo lo que hay en pantalla **afirma algo**. Un número afirma que se midió. Una lista afirma que
es *la* lista. Un rótulo afirma que nombra lo que tiene debajo. Un verde afirma que está bien. Un
cero afirma que no hubo.

**El estándar entero cabe en una frase:**

> ### Nada afirma lo que no es, y todo lo que importa se puede alcanzar.

El resto de este documento son las formas conocidas de romper esa frase. Cada una tiene su caso
medido, porque **una regla sin su caso se racionaliza en la primera discusión**.

⚠️ Y por eso esto **no es una guía de estética**. Una pantalla fea que no miente es corregible; una
pantalla hermosa que publica un número falso ya hizo daño y nadie lo sabe.

---

## Capa 1 · Veracidad — la interfaz no miente

### 1.1 Un rótulo dice lo que su contenido muestra

Leé el encabezado. Después leé la celda. Preguntate qué creería alguien que no escribió el código.

> **Costó:** una columna rotulada **«Origen»** pintaba si el motor había propuesto la cuenta
> contable — nada que ver con de dónde salió el dinero. 233 movimientos **con su documento escrito
> al lado** salían todos como «manual». ⭐ Un rótulo que nombra una cosa y muestra otra **es peor
> que no tener la columna**: se lee, se cree, y manda a buscar un problema que no existe.

### 1.2 Una cifra publicada se puede recorrer

Si el encabezado dice **N**, la lista tiene que poder llegar a **N**. Si no llega, **lo dice**.

> **Costó:** un libro publicaba **248 movimientos** y pintaba **100**. Las 148 restantes —
> **$1,943,998.57**, en medio del rango de fechas — no se veían ni se anunciaban. El servidor
> avisaba que había topado y la pantalla descartaba el aviso.
>
> ⛔ **Y paginar, solo, lo empeora:** un paginador diría «1–25 de 100» con total seguridad mientras
> el encabezado dice 248. **La confianza que da un control es parte de lo que afirma.**

⭐ **Es la única regla de esta capa con compuerta** (`npm run check:cifra`, desde el 2026-10-20):
marca la lista que llama a un método con tope **sin mandarlo** y **sin mirar la señal**. Las otras
cinco de Veracidad se siguen comprobando a mano.

### 1.3 Lo que no se midió se DECLARA — nunca se dibuja como cero ni como verde

`0` afirma *«no hubo»*. `—`, *«no lo sé»*. Son hechos distintos y la diferencia suele ser el
hallazgo. Un error de lectura que vacía una lista produce un cero **idéntico** al de un periodo
sin movimiento.

> **Costó:** una pantalla imprimió «0 corte(s)» mientras el endpoint devolvía 1. La petición había
> rebotado y el manejador de error vaciaba la lista. **Cero filas por un defecto es
> indistinguible de cero filas por desuso** — y se leyó como que nadie usaba el módulo.

### 1.4 El nombre de un contenedor cubre todo lo que contiene

> **Costó:** un diálogo llamado «Tu jornada» contenía dos bandejas de trabajo pendiente y un
> historial **con su propio rango de fechas**. Dos de sus tres partes no eran «tu jornada». Un
> título que describe un tercio de lo que hay adentro no orienta: **desorienta**.

### 1.5 Dos vistas del mismo dato traen el mismo universo

La pantalla, el reporte impreso, el export y el encabezado tienen que contar **lo mismo** o
declarar en qué se diferencian.

> **Costó:** el reporte impreso pedía 500 filas y la pantalla 100. Mostraban universos distintos
> del mismo periodo y nada lo decía.

### 1.6 Un número que se publica dice con qué se calculó

Dos cifras con la misma etiqueta y distinto periodo, a un centímetro, son una sola cosa para quien
lee. Si no podés nombrar el universo de un número, no lo publiques.

---

## Capa 2 · Alcance — lo que importa se puede llegar

### 2.1 Nada vital detrás de un acordeón «por limpieza»

La complejidad de una operación no se elimina: se traslada. En una herramienta de trabajo se
traslada **al código** (cálculos automáticos), no a la persona ni a un colapsable. Esconder lo
vital genera ansiedad; **densidad ordenada > minimalismo que esconde.**

⭐ **Plegar no es esconder:** un bloque cerrado tiene que decir, cerrado, cuánto hay adentro y si
algo falló. Si al plegarlo desaparece una declaración, no plegaste: borraste.

> **Costó:** al partir un diálogo en secciones, el aviso «los cortes no se pudieron leer» quedó
> dentro de una sección que no se abre por default. **Una lectura fallida pasó a ser invisible**,
> que es peor que publicar un cero.

### 2.2 Todo lo que se hace con el mouse se hace con el teclado

Quien captura vive en el teclado. Foco al primer campo, `Enter` envía, orden de tabulación igual
al orden visual, atajos para lo repetitivo — **y el atajo se escribe en pantalla**: uno que nadie
sabe que existe no existe.

### 2.3 El color nunca es el único portador de significado

Siempre acompañado de icono o texto. Vale para daltonismo, para Alto Contraste del sistema
operativo y para una captura en blanco y negro.

### 2.4 Una pantalla sin puerta no está entregada

Si no está en el menú, para quien la necesita **no existe**. Y el permiso tiene que estar
**repartido** en producción, no sólo declarado.

> **Costó:** una pantalla vivió con ruta y permiso pero sin entrada en el menú: se llegaba sólo
> escribiendo la URL. Y un paso de autorización existía en el código, en la pantalla y en el
> enum — **sin ningún rol que pudiera ejercerlo**: cero veces ejecutado en producción.

---

## Capa 3 · Comprensión — se entiende sin que te la expliquen

### 3.1 Primero el veredicto, después la evidencia

Una pantalla abre con **la respuesta a la pregunta que trae quien la abre**, no con la rejilla
cruda. Si lo primero que se ve son N filas, la persona tiene que sumarlas con la vista para saber
si el día va bien.

### 3.2 Un número se explica, no sólo se muestra

Todo número no trivial lleva su lectura en llano al lado: *«de $X, el ERP reconoce $Y → difieren
$Z»*. Un delta crudo obliga a cada persona a reconstruir el porqué, y cada una lo reconstruye
distinto. Si el sistema ya calculó la causa, **se muestra**.

### 3.3 Se señala la fila, no sólo el total

En una conciliación o un descuadre, la interfaz apunta al **renglón exacto** del problema. *«No
cuadra $X»* sin decir dónde convierte un hallazgo en una búsqueda manual.

### 3.4 Todo dato que evidencia algo lleva a arreglarlo

Un número, un chip de estado o una fila que denuncia un problema es **navegable a su lugar de
arreglo con el filtro ya puesto**. Quien lee no debería volver a buscar lo que el sistema ya sabe
señalar.

### 3.5 Los tres estados se pintan distinto

*Cargando*, *vacío* y *falló* no son lo mismo y la persona necesita saber si reintentar. Un
esqueleto dimensionado, un vacío que dice qué hacer, un error que dice qué pasó.

### 3.6 El dato volátil declara su edad

Sin edad, un dato viejo se lee como «al día». «hace 3 min» y «hace 9 horas» tienen que **verse**
distinto, no sólo decirlo: como prosa gris son idénticos.

### 3.7 La jerarquía la lleva el peso, no el color

> **Costó:** un diálogo tenía **41 textos atenuados contra 5 enfatizados**. Cuando todo es
> secundario, nada es primario, y la vista rebota sin encontrar dónde empezar.

### 3.8 La jerga del dominio va a un diccionario versionado, no a un `title`

Una definición fija escondida en un `title` sólo existe para quien tiene mouse.

### 3.9 Se nombran las cosas como las nombra quien las usa

El estado es *Por revisar* → la pantalla se llama **Revisión**. Sustantivo del dominio, no un
verbo ni un guion explicativo.

---

## Capa 4 · Sencillez — el mínimo esfuerzo mental

### 4.0 ⭐⭐ Antes de la cura, el diagnóstico: «está saturada» son TRES enfermedades

«Hay demasiada información» es un síntoma, no un diagnóstico. Son tres causas distintas, con
curas distintas — y **aplicar la cura equivocada empeora la pantalla**, que es lo que hace que un
rediseño quede igual de ilegible pero con mejor tipografía.

| | La enfermedad | Cómo se reconoce | La cura | ⛔ Si te equivocás |
|---|---|---|---|---|
| **A** | **Conflación** — la superficie contesta **varias preguntas** | podés nombrar 2+ preguntas distintas que se responden ahí | **partir** | jerarquizarla te deja cuatro preguntas bien tipografiadas |
| **B** | **Ruido** — casi nada de lo que muestra es trabajo | la proporción de filas accionables es chica | **sacarlo** | paginar o jerarquizar ruido lo deja igual de irrelevante, ordenado |
| **C** | **Aplanamiento** — la cantidad está bien, **todo pesa lo mismo** | contás atenuados contra enfatizados y no hay ganador | **jerarquizar** (3.7) | partir o esconder pierde información que sí hacía falta |

> **Los tres, medidos la misma semana en la misma pantalla:**
> **A** — «Tu jornada» contestaba cuatro preguntas: cómo va el día · si cuadra la caja · qué
> capturé · qué pasó antes. Las dos últimas ni siquiera eran «tu jornada».
> **B** — la cola ofrecía **13,245 movimientos de los que 20 eran trabajo real**: 1 de cada 662.
> Ninguna tipografía arregla eso.
> **C** — el mismo diálogo tenía **41 textos atenuados contra 5 enfatizados**. Cuando todo es
> secundario, nada es primario.

### 4.0b La prueba de la frase

> **Escribí en UNA oración la pregunta que contesta la pantalla. Si necesitás «y», son dos
> pantallas — o dos secciones con un selector.**

Es la forma más barata de detectar **conflación** antes de maquetar nada. *«¿Qué me falta por
confirmar y cuánto es?»* es una pregunta. *«Cómo va mi día **y** qué pendientes hay **y** qué pasó
el mes pasado»* son tres, y por eso ese diálogo no se podía salvar acomodando cajas.

### 4.0c Lo que de verdad baja la carga: derivar, no mostrar

⭐ La jugada más fuerte contra la saturación no es esconder: es **que la persona no tenga que
hacer la cuenta**. Tesler dice que la complejidad se traslada al código; en concreto, **en vez de
mostrar cinco números para que alguien los compare, mostrá la comparación**.

> **El caso que funciona:** el arqueo no pide un monto y además un desglose para que la persona
> los cuadre. Pide **sólo las piezas** y calcula el importe. Un total tecleado al lado de un
> conteo son dos versiones de la verdad y nadie decide cuál gana — y además son dos cosas que
> leer en vez de una.

### 4.0d Lo que NO es cura

- **Paginar.** Mueve el problema a la página 2. Y si la lista se topa, *miente* (§1.2).
- **Plegar.** Si lo plegado era vital, lo escondiste (§2.1); si no lo era, sobraba.
- **Achicar la tipografía.** Entra más y se lee menos: eso es más saturación, no menos.
- **Quitar una columna sin más.** El trabajo se traslada a otra pantalla o a la cabeza de alguien.

### 4.1 Nada de más de ~6 elementos seguidos sin separador

Agrupá en bloques con su título. Vale para campos de un formulario y para cifras de un tablero.

> **Costó:** 39 cifras, 3 rejillas y 7 botones en un solo desplazamiento. No se lee: **se recorre
> hasta encontrar.**

### 4.2 Curaduría antes de enumerar

El tiempo de decisión crece con la cantidad de opciones. Categorías y lo más usado primero; la
lista completa, detrás. Cuando hay muchos destinos, un buscador de comandos.

### 4.3 No se reinventa un patrón que la persona ya conoce

Tabla = Excel: filtros arriba, orden en el encabezado, paginación abajo. Innovar en la interacción
de una pantalla operativa **frena** a quien trabaja en ella.

### 4.4 La acción destructiva no se parece a la diaria

Nunca el color de acción, separada físicamente de «Guardar», con fricción proporcional o
deshacer. Una sola acción primaria destacada por pantalla.

### 4.5 Prevenir antes que reportar

Validación al salir del campo, envío deshabilitado mientras el formulario es inválido, formatos
guiados, unidades explícitas. **El mensaje de error es el último recurso, no el primero.**

### 4.6 Un control que no elige, no va

Un selector de una sola opción ocupa lugar y sugiere que hay algo más.

---

## Capa 5 · Respeto — no se pierde el trabajo ni el tiempo de nadie

### 5.1 No se pierde lo capturado

Estado sucio rastreado, confirmación al salir, `Esc` que no descarta en silencio.

### 5.2 Lo que se abre no empuja lo que se está usando

Un desplegable mueve de lugar lo de abajo. Quien está contando efectivo pierde el renglón.

### 5.3 Nada se retarda a propósito para que «se sienta» confiable

Fabricar una señal es lo mismo que dibujar un cero, movido al eje del tiempo.

### 5.4 Lo que ya existe no se reimplementa

Re-estilar a mano una pieza que ya vive compartida propaga una variante que nadie mantiene.

### 5.5 No se baja lo que no se pinta

> **Costó:** cada fila de un listado traía una firma en PNG base64 **sin que la tabla pintara
> ninguna**: 1,386 kB de firmas contra 17 kB de texto — el **98.8 %** del peso. Y eso era lo que
> hacía caro traer más filas, o sea **la causa real de que la lista estuviera truncada**.

---

## Cómo se comprueba — la ley del instrumento

Un estándar que no se mide es una aspiración. Y un instrumento que no se valida es peor que
ninguno, porque **produce una conclusión falsa con cara de medición**.

> ### ⭐⭐ Todo instrumento arranca con un CONTROL: una pregunta cuya respuesta ya conocés por otro camino. Si falla el control, se tira el instrumento — no la medición.

Tres corolarios, los tres cobrados:

1. **Una compuerta en verde puede estar mirando otro universo.** Un ✅ sobre lo commiteado no
   cubre lo que acabás de escribir; un ✅ sobre cero archivos se lee igual que una revisión.
2. **Cruzá toda cifra nueva contra una que ya mediste.** Un conteo diario convivía con un total
   más chico que él: imposible, y se reportó igual.
3. **Declará con qué estás mirando, antes del primer hallazgo.** Pantalla viva, base de datos o
   fuente. **Con sólo el fuente no se afirma nada visual.**

Y la regla que hace que esto no se apague:

> ⛔ **Una compuerta que nace roja se aprende a ignorar.** Lo que se mide ya existente se **sella
> como deuda declarada**; lo que frena es lo **nuevo**.

---

## Lo que NO es perfección

- **Decoración.** Sombras, degradados y momentos editoriales en una herramienta de trabajo.
- **Minimalismo que esconde.** Quitar una columna no simplifica: traslada el trabajo a otro lado.
- **Movimiento que no codifica nada.** Si la animación no dice un dato, sobra.
- **Consistencia con el vecino equivocado.** Copiar la pantalla de al lado propaga su deuda
  disfrazada de criterio. Se copia del sistema, no del vecino.
- **Un informe de auditoría largo.** Un hallazgo sin su costo en la unidad del negocio no mueve a
  nadie: *«148 filas invisibles por $1,943,998.57»* mueve; *«falta paginación»* no.

---

## Cómo se entrega un hallazgo

Cuatro cosas, o no se entrega:

1. **Qué está mal**, en una frase, desde la silla de quien usa la pantalla.
2. **Con qué se midió** — y si no se pudo ver, **«sin validación visual»**.
3. **Cuánto cuesta**, en la unidad del negocio.
4. **Qué ley de acá cobra.** Un hallazgo sin regla es una opinión.
