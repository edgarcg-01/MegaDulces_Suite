---
name: auditoria-diseno
description: Protocolo para AUDITAR una pantalla ya construida de esta suite (no para construirla — eso es la skill `diseno`). Los seis cruces que ninguna compuerta hace, la disciplina de instrumento y los tres niveles de evidencia. OBLIGATORIO antes de decir que una pantalla está bien, mal, "es un asco" o "quedó limpia". También (§9) para revisar el PLAN de una fase antes de construir su interfaz: observaciones de diseño con severidad que se agregan al doc de fase. Se invoca con auditar, auditoría, revisar pantalla, review de UI, "está feo", "no se entiende", "qué le falta a esta pantalla", legibilidad, QA de frontend, observaciones de diseño al plan, revisión de diseño de una fase, rediseño.
---

# Auditoría de diseño — el protocolo

> ⭐⭐ **La ley está en [`docs/ESTANDAR_DE_INTERFACES.md`](../../../docs/ESTANDAR_DE_INTERFACES.md),
> no acá.** Ese documento define **cuándo una interfaz está bien** —cinco capas: veracidad,
> alcance, comprensión, sencillez, respeto— y vale para cualquier pantalla de cualquier app. Esta
> skill es su **procedimiento**: con qué comandos de ESTE repo se comprueba cada capa. Si los dos
> se contradicen, gana el estándar y hay que corregir acá.
>
> **Para quién es esto:** la próxima sesión o el próximo dev que tenga que juzgar una pantalla de
> esta suite. No enseña a diseñar — eso es [`diseno`](../diseno/SKILL.md) y `DESIGN.md`. Enseña a
> **encontrar lo que está mal en algo que ya existe**, que es otro oficio.

Nace el **2026-10-20**, de una auditoría de `/finanzas/caja-general` en la que el usuario encontró
**tres defectos graves que la auditoría no vio**, y los encontró *preguntando*. Cada regla de acá
tiene su caso medido: si alguien la quiere borrar, que primero explique el caso.

---

## 0. Cuándo manda esta skill

| Vas a… | Skill |
|---|---|
| escribir o cambiar un componente | `diseno` |
| **juzgar una pantalla que ya existe** | **ésta**, y después `diseno` para arreglarla |
| **revisar el PLAN de una fase antes de construir su C3** | **ésta, §9** — sin tocar la pantalla |

⛔ **No se audita leyendo el código y llamándolo UX.** Eso es revisión de código con otro nombre, y
es exactamente cómo se pasó por alto una columna rotulada «Origen» que mostraba otra cosa: el
bloque se leyó, parseó bien como Angular, y nadie se sentó en la silla de quien la usa.

---

## 1. Primero: declará tu nivel de evidencia

⭐⭐ **Antes del primer hallazgo, decí con qué lo estás mirando.** Un hallazgo inferido escrito con
tono de medición es peor que no tenerlo: se cita después como si se hubiera comprobado.

| Nivel | Qué es | Qué podés afirmar |
|---|---|---|
| **A — Pantalla viva** | la app corriendo, medida en el navegador | todo: alto, contraste, pliegue, foco, recorte |
| **B — Base de datos** | consultas de sólo lectura contra prod | volúmenes, cobertura, huecos, si un número cierra |
| **C — Fuente** | leer el componente | estructura, qué primitivos usa, qué condiciones existen |

⛔ **Con nivel C no se afirma nada visual.** Ni «se ve apretado», ni «no entra», ni «la jerarquía
está mal». Eso se **declara como no medido** (ADR-056).

> **El caso:** la auditoría de Caja General corrió **tres días enteros en nivel C y B**, con la API
> local en 500, y entregó hallazgos con tono de medición. La mitad de lo que importaba —que una
> columna mentía, que la lista mostraba el 40 % de sus filas— **no se ve en el fuente**.

Si estás en nivel C y el trabajo exige A: **pedí que levanten la API antes de seguir**, no después
de entregar.

---

## 2. Los cuatro ejes, y qué compuerta cubre cada uno

Medido el 2026-10-20: **41 reglas ejecutables** — 31 compuertas en `scripts/compuertas.js` más la
nº 32, `pantalla`, que por dentro son las 10 reglas de `check-pantalla.js`. ⚠️ No son 42: `pantalla`
ya está entre las 32 y sumarla otra vez la cuenta dos veces. Reparten desigual:

| Eje | Documentado en `DESIGN.md` | Compuerta |
|---|---|---|
| **1 · Veracidad** | §Jerarquía del dato:1428 · ADR-056 | ⚠️ **una**: `cifra recorrible` cubre el Cruce 1. Los otros cinco de §3, a mano |
| **2 · Alcance** | §10:1318 (Tesler) · §D.7 teclado · §O:1366 | ⚠️ sólo `teclado` y `sin emojis` |
| **3 · Comprensión** | §Jerarquía del dato:1428 · §Ing.UI 2:1078 · §P:1411 | ⚠️ `pantalla` (desde `[AUD.3]`) — pero mide **presencia de piezas**, no jerarquía |
| **4 · Sencillez** | **§10 Leyes de interacción:1318 (BINDING)** | ❌ ninguna (`[AUD.5]`) |
| **5 · Respeto** | §10:1338 (estado sucio) · §Ing.UI 9 · §V (INP) | ❌ ninguna |
| *(transversal)* **Visual** | §Typography:507 · §Color:544 · §Motion:685 · §R:1155 | ✅ `estilos` · `tokens CSS` · `motion` |
| *(transversal)* **Accesibilidad** | §Ing.UI 3:1084 (WCAG AA piso, APCA Lc≥75) | ⚠️ **contraste y `forced-colors`: nada** (`[AUD.4]`) |

> ⛔⛔ **ESTA TABLA SE CORRIGIÓ EL 2026-10-20 Y EL ERROR VALE CONTARLO.** Nació con cuatro ejes
> —visual, accesibilidad, comprensión, sencillez— que son los que Edgar nombró al pedir la
> auditoría, y se escribió **antes** que el estándar. O sea que **no nombraba VERACIDAD**… y
> veracidad es donde vivió **cada uno** de los defectos grandes de esa semana: una columna
> rotulada «Origen» que mostraba otra cosa, un libro que publicaba 248 y pintaba 100, un cero
> publicado por una lectura fallida.
>
> ⭐ Quien siguiera esta tabla auditaría cuatro ejes y **no miraría el que más cobra**. Los seis
> cruces de §3 sí lo cubren, pero un mapa que no nombra el territorio manda a otro lado. Las
> cinco capas de acá son las del estándar, en su orden; **visual** y **accesibilidad** son
> transversales —se verifican en las cinco— y por eso quedan abajo, no porque importen menos.

⛔ **`DESIGN.md` no cabe en una ventana de contexto** (1,767 líneas). Entrá por su «Mapa del
documento» (línea 70) y leé el tramo con `sed -n`. *Leer un fragmento por grep y dar la regla por
cumplida es el modo de fallar acá.*

---

## 3. ⭐⭐ Los seis cruces que NINGUNA compuerta hace

**Acá vive el valor de esta skill.** Las compuertas verifican **presencia de piezas**: que haya
`LoadState`, `MetricStrip`, píldora de frescura. Ninguna detecta que un rótulo mienta ni que una
lista esconda la mitad de sus filas. Estos seis cruces sí, y los seis encontraron un defecto real.

### Cruce 1 — Toda cifra publicada se tiene que poder RECORRER

> Si el encabezado dice **N**, la lista tiene que poder llegar a **N**.

⭐ **Desde el 2026-10-20 esto tiene compuerta** (`[AUD.10]`), la primera de la capa Veracidad:

```bash
npm run check:cifra        # ninguna lista NUEVA se topa en silencio
npm run check:cifra:self   # los cinco controles de la compuerta
```

Marca cuando se dan **las dos**: llama a un método con tope **sin mandarlo**, y **no mira la
señal** (`has_more`…) en la vecindad de esa llamada. Nace con **34 pantallas selladas**.

⛔ **Lo que la compuerta NO ve, y por eso el cruce se sigue haciendo a mano:** si el contrato no
tiene señal de tope **ninguna**. Medido: de 35 servicios con `limit`, **sólo 2 respuestas declaran
`has_more`**. Para esas, el cruce manual sigue siendo lo único:

```bash
grep -n "limit" <el servicio del backend>        # ¿la lista tiene tope?
grep -n "has_more\|total" <el componente>        # ¿alguien mira el aviso de tope?
```

> **El caso (`[CG.127]`):** el libro publicaba **248 movimientos** y pintaba **100**. Las 148
> restantes —**$1,943,998.57**, del 7 al 15 de octubre, en medio del rango— no se veían ni se
> anunciaban. Causas: `cargar()` no mandaba `limit` (el servidor usa 100) y **`has_more` llegaba y
> nadie lo miraba**. ⛔ Y un paginador solo lo habría **empeorado**: diría «1–25 de 100» con total
> seguridad mientras el encabezado dice 248.

### Cruce 2 — Todo rótulo tiene que decir lo que su celda MUESTRA

> Leé el encabezado. Después leé la celda. Preguntate qué creería alguien que no escribió el código.

> **El caso (`[CG.125]`):** la columna **«Origen»** pintaba `m.autofill`, o sea **si el motor
> propuso la cuenta contable** — nada que ver con de dónde salió el dinero. 233 movimientos con
> `U-A-5 0000015 · CONTADO` escrito al lado salían todos como **«manual»**. ⭐ Un rótulo que nombra
> una cosa y muestra otra **es peor que no tener la columna**: se lee, se cree, y manda a buscar un
> problema que no existe. Lo encontró el usuario **preguntando «¿a qué te refieres con origen?»**.

### Cruce 3 — El nombre del contenedor tiene que cubrir TODO lo que contiene

> **El caso (`[CG.123]`):** el diálogo «Tu jornada» contenía dos bandejas de trabajo pendiente y el
> **Historial completo, con su propio rango de fechas y sus propios calendarios**. Dos de sus tres
> regiones no eran «tu jornada». Un título que describe un tercio de lo que contiene **desorienta**.

### Cruce 4 — Lo que SE VE no es lo que está en la plantilla

```bash
# Antes de contar nada, buscá los plegables y su estado INICIAL.
grep -n "signal(false)\|signal(true)\|computed(" <componente> | grep -i "abierto\|ver\|mostrar"
```

> **El caso:** se midió «875 líneas de plantilla» y casi se concluyó de ahí. Pero el Historial nace
> plegado y el cuadre nace abierto: **lo visible al abrir eran 683 líneas, 3 rejillas y 39 cifras**.
> Auditar la plantilla en vez de la pantalla **infla todo y desacredita el resto del informe**.

### Cruce 5 — Dos vistas del mismo dato tienen que traer el mismo universo

> **El caso:** `armarReporte()` pedía **500** filas y la pantalla **100**. El reporte impreso y la
> pantalla mostraban universos distintos del mismo periodo, y nada lo decía.

### Cruce 6 — Lo que VIAJA contra lo que se PINTA

```sql
-- Si el backend hace SELECT *, medí el peso de lo que nadie usa.
SELECT count(*), pg_size_pretty(sum(length(<columna_gorda>))::bigint) FROM <tabla> WHERE <rango>;
```

> **El caso:** el listado bajaba `firma_png` —un PNG en base64— por fila, **sin que la tabla pinte
> ninguna**: **1,386 kB de firmas contra 17 kB de texto, el 98.8 % del payload**. Eso era lo que
> hacía caro subir el tope, y por lo tanto **lo que mantenía la lista truncada**.

---

## 3b. Las 18 leyes, con su pregunta de auditoría

⛔ **Medido el 2026-10-20: diez de las dieciocho no aparecían en ninguna capa ejecutable.** Viven
en `DESIGN.md` `§Ing.UI 1:1068` (fundamento cognitivo) y `§10:1318` (interacción + resiliencia),
y **la tabla completa —qué exige cada una al generar y qué se mira al auditar— está en
[`diseno` §3d](../diseno/SKILL.md).** Acá va el recorrido, para no auditar sólo las que uno recuerda:

| Bloque | Las leyes | En una línea, qué buscás |
|---|---|---|
| **Percepción** `§Ing.UI 1` | Gestalt · Hick · Fitts · Doherty · Carga cognitiva · Lectura Z/F | grupos por espacio y no por cajas · decisiones simultáneas · 44px en touch · INP medido · **¿hace falta explicarla para entenderla?** |
| **Interacción** `§10.1–7` | Tesler · Miller · Jakob · Proximidad numérica · Von Restorff · Poka-yoke · Keyboard-first | qué se escondió «por limpieza» · bloques de >6 · patrones reinventados · «Borrar» pegado a «Guardar» · el error como primer recurso · la tarea sin mouse |
| **Resiliencia** `§10.8–12` | Estado sucio · Datos añejos · Fallos parciales · Idempotencia visual · Postel | ¿se pierde lo tecleado? · ¿se ve la edad del dato? · ¿un lote parcial se reporta como falla total? · ¿el doble clic cobra dos veces? · ¿rechaza `1,250.00` por la coma? |

> ⭐ **La ley no se cita como etiqueta.** «Viola Hick» no es un hallazgo; «hay 23 acciones planas
> en la barra y ninguna curaduría» sí. `DESIGN.md` lo pide textual: *el mecanismo perceptual, no
> la ley suelta*.

---

## 4. ⛔⛔ Disciplina de instrumento

**Tres instrumentos fallaron en una sola sesión**, y los tres habrían metido una conclusión falsa
en el informe:

| Instrumento | Qué dijo | Qué era |
|---|---|---|
| `scrollHeight` | «hay 269px de scroll» | `overflow-y:hidden` propagado: la rueda no movía nada |
| helper de contraste | «el título es invisible, 1.05» | parseaba `color(srgb …)` con la fórmula de `rgb(0-255)`; el valor real ~19:1 |
| emparejador de etiquetas | devolvía la línea de apertura para todo | regex mal armada — **dos veces seguidas** |

**La regla, y es corta:**

> ⭐⭐ **Todo instrumento que escribas arranca con un CONTROL: una pregunta cuya respuesta ya
> conocés por otro camino. Si no acierta el control, el instrumento se tira — no la medición.**

```js
// Así se ve un control que sirve:
console.log('CONTROL 1206-2081 (todo el diálogo):', balance(1206, 2081), ' <- debe dar neto 0');
```

Y dos corolarios que ya costaron:

- ⛔ **Si una compuerta te dice «esto no es tuyo» sobre un archivo que SÍ tocaste, no le creas.**
  `check-template-types` clasificó 4 errores míos como «de otras sesiones» porque mis cambios
  estaban sin commitear. **Un verde sobre el universo equivocado se lee igual que un verde.**
- ⛔⛔ **«tipa (0 errores)» de `check:pantalla` NO tipa la plantilla, y `check-template-types.js`
  sin commits pendientes revisa el árbol COMMITEADO.** Medido el 2026-10-20 con un control
  (`{{ metodoQueNoExiste() }}` en `/finanzas/caos`): las dos dijeron verde. `npx ngc -p
  apps/view/tsconfig.app.json --noEmit` sí lo marcó (`TS2339`). Para lo que acabás de escribir,
  ése es el instrumento — y arrancalo con el mismo control.
- ⛔ **Cruzá toda cifra nueva contra una que ya mediste.** Un conteo diario de «178 capturas» convivía
  con un total de 236 filas en todo el libro: **imposible, y se reportó igual**. El cruce lo habría
  cazado en el momento (el real era 40).

---

## 5. El recorrido, en orden

```bash
# 1 · ¿La pantalla usa el sistema, o es deuda? Cero hits = el hallazgo principal es ése.
M=apps/view/src/app/modules/<ruta>
for p in app-load-state app-metric-strip app-freshness-pill app-side-peek app-segmented \
         app-context-help app-page-tabs surf-table comm-num p-tag p-table; do
  printf "%-22s %s\n" "$p" "$(grep -rho "$p" $M | wc -l)"
done

# 2 · El contrato de producto (10 reglas). Desde [AUD.3] frena el push si sumás una falla NUEVA.
npm run check:pantalla -- <modulo>     # una, con chequeo de tipos (~10 s)
npm run check:pantalla                 # el barrido: sólo lo nuevo pone rojo

# 3 · Las compuertas estáticas
npm run check:templates                # el literal cierra, el CSS parsea
node scripts/check-template-types.js   # ⭐ los tipos DENTRO de la plantilla (NG8001, NG8007…)
npm run check:estilos                  # escala --fs-*, hex crudo, foco sin anillo

# 4 · Los seis cruces de §3. Acá está lo que las compuertas no ven.

# 5 · Sólo con nivel A: medí la pantalla viva (chrome-devtools / playwright).
```

⚠️ **`vitest` NO tipa las plantillas y `check:pantalla` tampoco.** Un `<p-sortIcon>` que en PrimeNG
v22 se llama `p-sort-icon` pasa las dos y muere en `Build & typecheck`. **Corré
`check-template-types.js`** — es la única local que lo ve.

---

## 6. Trampas que ya cobraron, al auditar

- ⚠️⚠️ **Un acento grave en un comentario dentro de `template:` o `styles:` cierra el literal.** Ya
  pasó **14 veces**. Con número par de acentos el archivo parsea y revienta después, así que
  `check:templates` **pasa en verde**. El barrido que sirve, pase lo que pase (el acento grave va
  entre comillas simples para que el shell no lo expanda):

  ```bash
  git diff -U0 -- <archivo> | grep "^+" | grep '`'
  ```

- ⛔ **Reusar un nombre de propiedad en una clase larga no da error: gana la última declaración.**
  `grep -n "<nombre>"` **antes** de nombrar cualquier miembro en un componente de >1,000 líneas.
  (Costó: `opcionesCaja` ya existía en un componente de 8,000 líneas.)
- ⚠️ **Un doble que nombra un método que el servicio no tiene no simula nada**: el componente llama
  al real y la prueba verde mide el camino sano. (Costó: `recurrentes` en vez de
  `recurrentesSinRegla`.)
- ⚠️ **Mover algo a un panel angosto activa `@container` AJENAS** (reglas móviles de `styles.css`) y
  rompe tablas que nadie tocó.
- ⚠️ **La indentación miente** en archivos que pasaron por refactors. Para delimitar un bloque,
  contá etiquetas con substrings literales y **validá el conteo sobre el bloque entero** (neto 0).

---

## 7. Cómo se entrega un hallazgo

Cada uno lleva las cuatro, o no se entrega:

1. **Qué está mal**, en una frase, desde la silla de quien usa la pantalla.
2. **Con qué se midió** — nivel A, B o C. Si es C y es visual: **«sin validación visual»**.
3. **Cuánto cuesta**, en la unidad del negocio. *«148 filas invisibles por $1,943,998.57»* mueve;
   *«falta paginación»* no.
4. **Qué regla de `DESIGN.md` cobra**, con su sección. Un hallazgo sin regla es una opinión.

⛔ **Y lo que no se pudo medir se DECLARA, nunca se dibuja como cero ni como verde** (ADR-056).

---

## 8. Lo que esta skill NO cubre todavía

Declarado para que nadie lo dé por hecho:

- ⛔⛔ **`check:pantalla` SÓLO MIRA `apps/view`.** Su `ROOT` está fijo en
  `apps/view/src/app/modules`, así que **`apps/portal` y `apps/vendor` no tienen ninguna
  compuerta de contrato de producto**. Medido el 2026-10-20:

  | App | Pantallas | Compuerta de contrato |
  |---|---:|---|
  | `apps/view` | 267 | ✅ `pantalla` |
  | `apps/vendor` | 17 | ❌ **ninguna** |
  | `apps/portal` | 9 | ❌ **ninguna** |

  ⚠️ Y por eso la línea base «247 de 267 con falla» **es de una sola app**, no del repo. Las 26
  pantallas de las otras dos no están medidas: **no se sabe si cumplen**, que no es lo mismo que
  decir que cumplen (ADR-056). ⭐ Se agrava porque `DESIGN.md` ya declara que esas dos apps tienen
  **0 componentes compartidos** — o sea que son justo donde más probable es que haya deuda.
  ⚠️ Y `apps/portal` es **Storefront**, otro surface: varias reglas de acá (densidad compacta, sin
  ilustraciones) **no aplican tal cual**. Extender la compuerta no es cambiar una ruta.

- **`[AUD.4]` contraste** — cero compuertas. Ni WCAG AA ni `forced-colors` (Alto Contraste de
  Windows, que `DESIGN.md` llama «el tercer modo» y la flota **es** Windows). Hoy se mide a mano.
- **`[AUD.5]` sencillez** — las 7 leyes de §10 son BINDING y automatizables (Miller: >6 campos sin
  separador · Tesler: datos vitales tras acordeones · Von Restorff: destructiva nunca en `--action`
  · Hick: `⌘K` con 20+ destinos) y ninguna tiene instrumento.
  ⭐ **El primer candidato ya está nombrado por el Cruce 1**: *toda cifra publicada en un encabezado
  tiene que poder recorrerse en su lista*. Esa sola habría cazado las 148 filas invisibles.

---

## 9. Revisión de diseño de un PLAN — antes de que exista la pantalla

Nace el **2026-10-26** de un pedido de Edgar: *«toma el rol [de diseñador UI crítico] y a cada plan
de cada módulo genérale las observaciones y agrégalas a las fases»*. La razón es de costo: una
columna rotulada «Origen» que muestra otra cosa se corrige en el plan con una línea; en la pantalla,
después de que alguien la creyó, cuesta una auditoría y una reescritura.

**Cuándo:** al escribir el plan (paso 2 de [`METODO_DE_TRABAJO.md`](../../../docs/METODO_DE_TRABAJO.md))
y **antes del primer item C3**; otra vez si cambia el alcance de C3.

**Qué es y qué no:**

- Es **nivel C por definición**: se lee el plan, no la pantalla. Nada visual se afirma como medido.
- ⛔ **No se audita la pantalla en esta pasada** — ni `check:*`, ni navegador, ni base. Eso es §5.
- Si la fase ya está construida, cada observación es **un criterio a verificar** en la pantalla, no
  un defecto medido, y así se escribe.

**Dónde y con qué forma:** al final del plan principal de la fase, una sección
`## Observaciones de diseño UI — revisión del plan (AAAA-MM-DD)`. El ejemplo canónico es la de
[`FASE_ECA_ESTADO_CUENTA_ACREEDORES.md`](../../../docs/IMPLEMENTACION/FASES/FASE_ECA_ESTADO_CUENTA_ACREEDORES.md):

1. La nota de evidencia (nivel C) y la escala de severidad.
2. **La prueba de la frase** (estándar §4.0b): la pregunta que contesta cada pantalla, en una
   oración. Si necesita «y», es conflación y se propone el corte.
3. **La jerarquía propuesta** (§Q.5): primario · secundario · terciario, en una línea.
4. Una tabla `# · Sev · Observación y costo · Ley · Criterio de aceptación`, con ids `XX.UI.n`,
   **6 a 14 por plan**, la más cara primero.

| Sev | Qué significa |
|---|---|
| 🔴 | la pantalla afirmaría algo falso, escondería lo que importa o perdería/duplicaría trabajo → **bloquea pasar C3 a 🚀** |
| 🟠 | se resuelve dentro de la fase |
| 🟡 | mejora; si no entra, deuda con nombre |

**La vara**, la misma de §7 adaptada al papel:

- ⛔ **Si la observación serviría igual para cualquier otro plan, no va.** «Agregar `LoadState`»
  sólo entra si el plan describe algo que lo contradice, citando dónde.
- El costo va **con las cifras que el propio plan midió**, y con su fecha si son viejas. No se
  inventan cifras.
- La ley se cita **por su mecanismo**, nunca como etiqueta.
- El criterio nombra **la pieza del sistema** que lo resuelve y, si hay texto para la pantalla, el
  texto literal en tuteo mexicano.
- Orden de búsqueda: **veracidad primero** (rótulos, cifras recorribles, ceros que son «no medido»,
  universos y **unidades**), después alcance, comprensión, sencillez y respeto, y al final los no
  negociables (sucursal por nombre, dark + `forced-colors`, IA que se ve como propuesta de un
  motor, ≥44 px en `coarse`).
- Lo que el plan **declara como hueco o hipótesis** es el lugar más probable de una 🔴: la pregunta
  es si la pantalla lo va a declarar o lo va a dibujar como dato firme.

**Después:** las 🔴 se vuelven items de C3 al abrir esa capa, y la revisión en nivel A (§5) es la que
las da por cerradas — nunca la revisión del plan.
