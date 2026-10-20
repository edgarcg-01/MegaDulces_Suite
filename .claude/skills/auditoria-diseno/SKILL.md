---
name: auditoria-diseno
description: Protocolo para AUDITAR una pantalla ya construida de esta suite (no para construirla — eso es la skill `diseno`). Los seis cruces que ninguna compuerta hace, la disciplina de instrumento y los tres niveles de evidencia. OBLIGATORIO antes de decir que una pantalla está bien, mal, "es un asco" o "quedó limpia". Se invoca con auditar, auditoría, revisar pantalla, review de UI, "está feo", "no se entiende", "qué le falta a esta pantalla", legibilidad, QA de frontend.
---

# Auditoría de diseño — el protocolo

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

Medido el 2026-10-19: **41 reglas ejecutables** (32 compuertas en `scripts/compuertas.js` + las 10
de `check-pantalla.js`). Reparten desigual:

| Eje | Documentado en `DESIGN.md` | Compuerta |
|---|---|---|
| **Visual** | §Typography:507 · §Color:544 · §Motion:685 · §R:1155 | ✅ `estilos` · `tokens CSS` · `motion` |
| **Accesibilidad** | §Ing.UI 3:1084 (WCAG AA piso, APCA Lc≥75) | ⚠️ sólo `teclado` y `sin emojis` — **contraste y `forced-colors`: nada** (`[AUD.4]`) |
| **Comprensión** | §Jerarquía del dato:1428 · §Ing.UI 2:1078 · §P:1411 | ✅ `pantalla` (desde `[AUD.3]`) |
| **Sencillez** | **§10 Leyes de interacción:1318 (BINDING)** | ❌ ninguna (`[AUD.5]`) |

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

```bash
# El número del KPI y el de la lista salen de consultas distintas: comprobá que cierren.
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

- **`[AUD.4]` contraste** — cero compuertas. Ni WCAG AA ni `forced-colors` (Alto Contraste de
  Windows, que `DESIGN.md` llama «el tercer modo» y la flota **es** Windows). Hoy se mide a mano.
- **`[AUD.5]` sencillez** — las 7 leyes de §10 son BINDING y automatizables (Miller: >6 campos sin
  separador · Tesler: datos vitales tras acordeones · Von Restorff: destructiva nunca en `--action`
  · Hick: `⌘K` con 20+ destinos) y ninguna tiene instrumento.
  ⭐ **El primer candidato ya está nombrado por el Cruce 1**: *toda cifra publicada en un encabezado
  tiene que poder recorrerse en su lista*. Esa sola habría cazado las 148 filas invisibles.
