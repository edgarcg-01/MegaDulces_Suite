---
name: diseno
description: Sistema de diseño "Mercado" de Mega Dulces. OBLIGATORIO antes de crear o editar cualquier archivo frontend del monorepo (componente Angular, template, styles, CSS, tokens) y para todo review, auditoría o rediseño de una pantalla. Reemplaza a las skills genéricas de diseño instaladas en este repo. Se invoca con diseño, frontend, UI, UX, pantalla, componente, tabla, card, KPI, dark mode, tokens, accesibilidad, DESIGN.md, "revisá esta pantalla", "está feo", "no llena el ancho".
---

# Mercado — el sistema de diseño de esta suite

> ⭐⭐ **Arriba de todo esto está [`docs/ESTANDAR_DE_INTERFACES.md`](../../../docs/ESTANDAR_DE_INTERFACES.md):**
> cuándo una interfaz está bien, para cualquier app, sin hablar de colores ni componentes. Su ley 0
> —*nada afirma lo que no es, y todo lo que importa se puede alcanzar*— es de la que derivan las
> reglas de acá. `DESIGN.md` y esta skill son **cómo se cumple ese estándar con el sistema
> «Mercado»**; si se contradicen, gana el estándar.

`DESIGN.md` (raíz del repo) es la fuente operativa y es **binding**. Esta skill no lo reemplaza: lo
vuelve ejecutable. Dice **qué medir antes de opinar, en qué orden revisar, y qué comando lo prueba**.

---

## 0. Esta skill gana sobre las genéricas

Este repo tiene instaladas `high-end-visual-design`, `design-taste-frontend`, `minimalist-ui`,
`brandkit`, `emil-design-eng` y otras. **No se usan acá.** Empujan decoración, sombras pesadas,
tipografía expresiva y "momentos editoriales": exactamente lo que la superficie Operations prohíbe.
Si una de ellas se activa junto con ésta, manda ésta. Lo único que se les toma es vocabulario, nunca
una decisión.

---

> ⭐⭐ **¿Vas a JUZGAR una pantalla en vez de construirla? Cargá
> [`auditoria-diseno`](../auditoria-diseno/SKILL.md).** Esta skill dice cómo se construye; aquélla,
> cómo se encuentra lo que está mal en algo que ya existe — y son oficios distintos. Trae los **seis
> cruces que ninguna compuerta hace** (un rótulo que miente, una lista que esconde el 40 % de sus
> filas, un contenedor cuyo nombre cubre un tercio de lo que contiene), la disciplina de instrumento
> y los tres niveles de evidencia. Nace el 2026-10-20, después de que el usuario encontrara
> **preguntando** tres defectos graves que una auditoría hecha sólo con esta skill no vio.

## 1. Antes de escribir una línea: medir la pantalla

⛔ **No abras el archivo vecino para "ser consistente".** Ya costó: `/logistica/gasto-ruta` se
construyó copiando a `comercial-comisiones`, que estaba hecha a mano — copiar su vocabulario propagó
la violación disfrazada de consistencia, y se reimplementaron **seis** piezas que ya existían
compartidas.

```bash
# ¿La pantalla que vas a tocar usa el sistema, o es deuda?
M=apps/view/src/app/modules/<ruta-del-modulo>
for p in app-load-state app-metric-strip app-freshness-pill app-side-peek app-segmented \
         app-context-help surf-table comm-num p-tag p-table; do
  printf "%-22s %s\n" "$p" "$(grep -rho "$p" $M | wc -l)"
done
```

**Cero hits en todo = no es referencia, es deuda.** Y si vas a tocarla, el hallazgo principal es ése,
no el color de un borde.

Después, el auditor de contrato:

```bash
npm run check:pantalla -- <nombre-del-modulo>   # una  (el `--` es obligatorio: npm se come los args)
npm run check:pantalla -- --todas               # el barrido
```

> Medido 2026-10-19: **267 pantallas · 247 con falla · 629 fallas.** No es alarmismo, es la línea
> base — tu pantalla casi seguro ya falla algo antes de que la toques. Lo que **no** vale es sumar
> una falla nueva, y desde `[AUD.3]` eso **ya no depende de tu memoria**: está sellado en
> `scripts/check-pantalla.deuda.json` y el push frena si aparece una falla que no esté ahí.

| Regla | Pantallas que fallan hoy |
|---|---|
| §2 matriz de estados (sin `LoadState`: *cargando* ≡ *vacío* ≡ *error*) | 203 |
| §9 frescura (dato volátil sin edad declarada) | 197 |
| Q.1 answer-first (abre con el grid crudo, no con el veredicto) | 154 |
| O.4 rejilla fuera de `p-table` | 48 |
| D.8 búsqueda con `.includes()` | 13 |
| D.7 rejilla sin teclado | 11 |
| D.4c `role="tablist"` que no son pestañas | 3 |

---

## 2. Ubicá el surface — las reglas cambian

| Surface | App | Qué aplica |
|---|---|---|
| **Storefront** | `apps/portal` | editorial: Poppins, ilustraciones, densidad comfortable |
| **Operations** | `apps/view`, `apps/vendor` | quiet-luxury: **sin** display font, **sin** ilustraciones, densidad compacta |

Si la raíz de ruta de tu pantalla no figura en la tabla de Surfaces de `DESIGN.md`, **agregala ahí
antes de seguir**. Una tabla incompleta manda a la pantalla nueva a ningún régimen.

Norte de Operations: **Linear · Stripe · Vercel**. Es una herramienta B2B densa; debe sentirse
profesional, no decorada. El color de marca (`--action`, sunset) sólo en CTA / activo / seleccionado
/ foco. Excepción: data-viz, donde el color **codifica dato**.

---

## 3. El orden del review: macro → micro

Tokenizar hex sobre un componente que está fuera del sistema no arregla nada. El orden es:

1. **¿Usa la librería?** Operations = PrimeNG. `<select>`/`<input type=date>`/`<table>`/`confirm()`
   crudos donde va `p-select`/`p-datepicker`/`p-table`/`p-confirmDialog` → **ése es el hallazgo
   principal**, y se reconstruye.
2. **¿Patrón canónico?** `surf-page` + `surf-page-head` + la tabla como organismo primario + alta en
   `p-dialog`. Nada de formularios centrados bespoke.
3. **¿Feedback del sistema?** `p-toast` + `p-confirmDialog`. Nunca `alert()`/`confirm()` nativos.
4. **Estados:** `app-load-state` (separa los tres), skeleton dimensionado, pill de estado.
5. **Recién entonces** lo micro: tokens, `--sp-*`, `focus-visible`, a11y.

Y los 18 puntos del pre-vuelo se revisan **todos**, no un subconjunto. Un subconjunto da falsa
sensación de "revisado" y deja violaciones vivas.

---

## 4. Lo que no se negocia (cada una ya cobró)

- **Iconos, nunca emojis** en la UI — `<i class="pi pi-pencil">`, no ✏️. Vale también cuando hablás
  de lo que va en pantalla. Hay compuerta: `sin emojis`.
- **Dark mode es first-class, no un pase final.** Sólo tokens que flipean por tema. Un hex o un token
  inexistente se ve bien en claro y queda roto en oscuro. Las sombras casi desaparecen en dark: la
  profundidad la lleva el **borde de 1px**.
- **Alto Contraste de Windows (`forced-colors`) es el tercer modo** y la flota es Windows. La base
  está en `libs/ui-web/src/forced-colors.css`; lo tuyo es que **ningún estado dependa sólo del color**.
- **`:host { display: block; }`** en todo componente de página. Sin eso el `<app-…>` se encoge a su
  contenido y arrastra todo. Si reportan "no llena el ancho", mirá el `:host` **antes** de la tabla.
- **Dinero con `Number()` antes de formatear.** Los `numeric` de Postgres llegan como **string** por
  JSON y `String.prototype.toLocaleString` ignora las opciones de moneda: sale sin `$` ni comas.
- **Señales, y leídas incondicionalmente.** Un `computed()` detrás de un `&&` que corta antes de leer
  el signal queda **sin dependencias y no recalcula nunca**. Hay compuerta: `reactividad`.
- **Nada de zebra striping** en tablas.
- **Motion: techo 350 ms, sólo `transform` y `opacity`**, y `prefers-reduced-motion`.
- **Toda pantalla nueva va al sidebar.** Si no está ahí, para el usuario no existe.

---

## 5. El inventario — buscá acá antes de escribir una pieza

Re-estilar a mano lo que ya existe es el antipatrón #1 y se marca en review. Todo vive en
`apps/view/src/app/shared/components/`:

| Pieza | Selector | Cuándo |
|---|---|---|
| KPIs de encabezado | `app-metric-strip` | header de KPIs de una pantalla (sin caja) |
| Tile con micro-viz | `app-metric-card` | dashboards, no headers |
| Los tres estados | `app-load-state` | **siempre** que haya carga de datos |
| Edad del dato | `app-freshness-pill` | **siempre** que el dato sea volátil |
| Detalle sin perder la lista | `app-side-peek` | detalle de más de un campo |
| Control segmentado | `app-segmented` | filtros de una opción (no `role="tablist"`) |
| Ayuda de negocio | `app-context-help` | donde haya jerga o reglas estrictas |
| Tabs de un apartado | `app-page-tabs` | con gate por permiso por tab |

Tabla: `p-table` con `class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first"`,
y `comm-num` en la celda numérica **y en su `<th>`**. Estado: `p-tag [severity]`, nunca un `<span>`
propio. La tabla cruda es legítima (PrimeNG v22 quedó bajo licencia); lo que **no** es legítimo es
reescribir su base: `surf-table--plain` ya es esa base, escrita una vez.

⚠️ `apps/portal` y `apps/vendor` tienen **0 componentes compartidos** — hueco declarado.

---

## 6. Tokens

Tres tiers en `libs/design-tokens/tokens.css`, **archivo único para las 3 apps**. Un componente nuevo
referencia un rol, **nunca inventa un hex**.

- Canónicos: borde `--border-color` · radios `--r-sm/-md/-lg/-xl/-2xl/-pill` · texto
  `--text-main`/`--text-muted`/`--text-faint` · espaciado `--sp-1..12` (escala 4px) · tipografía `--fs-*`.
- Interacción = **alpha-overlays** sobre `--ink-rgb` (`--overlay-hover/active/selected`), que se
  voltea por modo: una definición sirve en claro y oscuro.
- ⚠️ **Hay al menos 4 dialectos fantasma** de tokens que NO existen (`--border`, `--surface-card`,
  `--radius-md`, `--text-strong`…). Un `var()` inexistente **se cae en silencio**. Hay compuerta:
  `tokens CSS`. En código nuevo, canónico siempre.

---

## 7. Las compuertas

El registro canónico es `scripts/compuertas.js` — **32 compuertas, 21 en el push** (medido
2026-10-19). No las copies a ningún lado: en este repo ya hubo dos listas que divergieron.

```bash
npm run check                    # todo
npm run check:estilos            # escala --fs-*, hex crudo, breakpoints en px, foco sin anillo
npm run check:motion             # techo de 350 ms, en ms y en s
npm run check:templates          # el literal de template cierra (ver §8)
npm run check:pantalla           # ⭐ el barrido: ninguna falla NUEVA de contrato de producto
npm run check:pantalla -- <mod>  # ⭐ UNA pantalla, con su chequeo de tipos (~10 s)
```

Las **doce** que cobran una regla de `DESIGN.md`: `templates` · `templates-types` · `tokens CSS` ·
`estilos` · `motion` · `tablas densas` · `teclado` · `búsqueda` · `sin emojis` · `primeng` ·
`reactividad` · **`pantalla`**.

> ⭐ **`pantalla` entró al push el 2026-10-19 (`[AUD.3]`), y hasta ese día no la corría NADIE.**
> Estaba escrita desde `[AUD.1]` pero fuera de los dos runners —cero menciones en `ci.yml`, cero
> en el `pre-push`—, así que sólo se ejecutaba si alguien se acordaba. **Esta skill lo pedía, y
> una skill es una instrucción, no un mecanismo.** Lo que midió no ejecutarse: 247 de 267
> pantallas con falla.
>
> ⛔ **Nace con la deuda sellada** en `scripts/check-pantalla.deuda.json` (ruta → ids de regla) y
> frena **sólo lo NUEVO**: encendida en duro sobre el árbol entero nacería roja para los cuatro y
> la apagarían el primer día. Si arreglás una pantalla, re-sellá con `-- --sellar-deuda`; sellar
> una falla nueva sube el piso y hay que decir por qué en el commit.

⛔ **No compiles ni levantes nada en local** (`CLAUDE.md`, regla dura: un backend local terminó con 6
conexiones a la base de **producción**). El build lo hace el CI. Las compuertas de arriba son scripts
de Node, no builds: ésas sí corren local. Para ver errores de tipos, los diagnósticos del editor leen
el servicio de lenguaje sin compilar.

---

## 8. Trampas que ningún compilador marca

- ⚠️⚠️ **Un acento grave en un comentario dentro de `template:` o `styles:` cierra el template
  literal.** El error sale desplazado (cientos de líneas abajo, o como `NG1002`) y se pierde el
  tiempo buscándolo donde no está. Ya pasó **seis veces**. Con un número par de acentos el archivo
  parsea igual y revienta después. Lo caza `npm run check:templates`.
- **Cerrar un comentario CSS dentro de un comentario CSS** sale como *warning*: el build **no frena**
  y la regla simplemente no existe en el bundle. Ya dejó una caja de aviso sin estilo en producción.
- **Reusar un nombre de propiedad en una clase larga no da error: gana la última declaración.** Antes
  de nombrar un signal en un componente de >1,000 líneas, `grep -n "<nombre>"` sobre el archivo.
- **`[hidden]` no oculta nada si el CSS declara `display`.** Usá `@if`, o su
  `.clase[hidden]{display:none}` explícito.
- **Los estilos del padre no alcanzan al componente hijo** (ViewEncapsulation Emulated). Al extraer un
  componente, los estilos viajan con él. Las clases globales de `styles.css` sí aplican.
- **Un pipe (`| date`, `| currency`) en un standalone debe importarse explícito**, o el AOT de
  producción truena y tumba el deploy — aunque el build local pase en verde.

---

## 9. Lo que NO se hace

- Maquillar colores sobre un componente que está fuera del sistema.
- Parchear strings por script sin releer el archivo completo. *Parchear texto no es diseñar pantallas*
  — así se degradó `/finanzas/solicitudes` hasta tener tres controles segmentados distintos en una
  sola pantalla y el mismo número en cuatro lugares contando universos distintos.
- Unificar dos vistas perdiendo columnas, chips o subtotales. Inventario feature×feature **antes** de
  tocar código.
- Nombrar un módulo con un verbo o con un guion explicativo. Sustantivo, y el de la máquina de
  estados: el estado es *Por revisar* → la pantalla es **Revisión**.
- Retardar algo a propósito para que "se sienta" costoso o confiable. Es fabricar una señal, que es lo
  mismo que dibujar un cero (ADR-056), movido al eje del tiempo.
- Dibujar un cero donde no hubo medición. Lo que no se pudo medir **se declara**.

---

## 10. Dónde está el detalle

| Archivo | Para qué |
|---|---|
| `DESIGN.md` | la fuente binding: pre-vuelo de 18 puntos, surfaces, inventario, reglas D, §Q, §G, PWA |
| `libs/design-tokens/tokens.css` | los valores exactos |
| `docs/DESIGN_FOUNDATIONS.md` | el *porqué* con citas (APCA vs WCAG, OKLCH, DTCG) |
| `docs/DESIGN_TABLES.md` | la spec de tablas profesionales |
| `docs/DESIGN_MOTION_KPI_CARDS.md` | motion de cards: dinamismo = dato, no decoración |
| `docs/MATRIZ_ACCESOS.md` | permisos por puesto — consultar **antes** de crear un módulo |

**Si un requerimiento choca con el sistema, se expone el conflicto y decide Edgar.** No se resuelve en
silencio.
