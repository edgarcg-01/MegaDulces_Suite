# Tecnología y método de diseño frontend — estado del arte (ago-2026)

> **Qué es:** investigación de la **capa técnica** del diseño frontend a agosto 2026 — plataforma web (CSS/HTML nativo), responsividad, interacción, motion, framework/tooling, accesibilidad, performance, UX de producto (agentic/generative UI) y local-first — **auditada contra nuestro código real**.
> **Qué NO es:** tendencias estéticas. Eso está en [`DESIGN_TENDENCIAS_2026.md`](DESIGN_TENDENCIAS_2026.md) (jun-2026: color, tipografía, spacing, lookbook).
> **Jerarquía de docs de diseño:**
> - [`DESIGN.md`](../DESIGN.md) = sistema operativo + contrato BINDING. **Manda.**
> - [`docs/DESIGN_FOUNDATIONS.md`](DESIGN_FOUNDATIONS.md) = base teórica (OKLCH/APCA/DTCG/opsz).
> - [`docs/DESIGN_TENDENCIAS_2026.md`](DESIGN_TENDENCIAS_2026.md) = qué hay afuera, estético.
> - **Este archivo** = qué hay afuera, **técnico**: qué APIs ya son seguras, qué deuda borran, qué decisiones estratégicas abren. Investigación + backlog, no normativa (lo que se acepte sube a `DESIGN.md`).
> **Fecha:** 2026-08-25. Revalidar en ~6 meses (la mitad de esto es Baseline nueva).

---

## TL;DR — 14 decisiones que salen de esta investigación

| # | Estado del arte (ago-2026) | Nosotros hoy | Acción |
|---|---|---|---|
| 1 | **Container queries** = Baseline widely available (ago-2025, ~93%); el estándar para componentes | **0 usos** en todo el repo, y `DESIGN.md §5` ya las manda para `libs/` | 🔴 **Gap de contrato.** Adoptar en `libs/` + MetricCard/tablas |
| 2 | Método responsive 2026 = **4 herramientas** (media=página · container=componente · `clamp()`=fluido · grid intrínseco=sin breakpoints) | 296 `@media`, 124 con `max-width` en px | 🎯 Reencuadrar: media solo para chrome/página |
| 3 | **`@layer`** (cascade layers) es Interop 2026 y resuelve guerras de especificidad | **0 usos**, y cargamos **971 `!important`** + **317 `::ng-deep`** | 🔴 Prioridad alta: capas `reset < vendor(primeng) < tokens < components < utilities` |
| 4 | **Popover + anchor positioning + invoker commands + `interestfor`** = tooltips/dropdowns/hovercards **sin JS** (anchor = Baseline 2026) | 1 archivo con `popover`, 0 con `anchor-name` | 🎯 Adoptar en overlays nuevos; no reescribir PrimeNG existente |
| 5 | **View Transitions** + **scroll-driven animations** reemplazan ~80% de lo que se hacía con librerías JS de animación | 2 archivos view-transition, 5 `animation-timeline` | 🎯 Ampliar: `withViewTransitions()` en router + master→detail |
| 6 | **Angular 22**: zoneless por default, Signal Forms estable, **Angular Aria** (primitivas headless de a11y), Vitest | Ya en Angular 22 + `provideZonelessChangeDetection()` ✅, pero `zone.js` sigue en polyfills | ✅ Bien parados. Sacar `zone.js` cuando se valide |
| 7 | ⚠️ **PrimeNG dejó de ser open source**: repo archivado 28-jun-2026, v22+ bajo licencia comercial PrimeUI (**$599/dev** perpetua + 1 año, **$799** desde 2027) | `primeng 22.0.0` instalado y usado en todo Operations | 🔴 **Decisión de Edgar requerida** (§5.2): pagar / congelar / migrar |
| 8 | **Tailwind v4** (config CSS-first `@theme`, motor Rust, container queries nativas). spartan/ui 1.x ya corre Angular 22 + TW4 | `tailwindcss 3.4.19` + preset spartan `0.0.1-alpha.*` | 🎯 Migración de infraestructura (colapsa la doble fuente de tokens) |
| 9 | **Design tokens = estándar W3C real** (DTCG Format Module v2025.10 estable, 24+ orgs); toolchain: Figma Variables → DTCG JSON → Style Dictionary → CSS | `tokens.css` a mano, 585 líneas, **0 `oklch`** (todo hex) | 🎯 `tokens.json` (DTCG) como fuente → genera `tokens.css`; rampas a OKLCH |
| 10 | **WCAG 2.2 AA sigue siendo el piso legal**; EN 301 549 v4.1.1 (2026) lo incorpora para la EAA; **WCAG 3.0 es Working Draft** (mar-2026), Recommendation ~2028-2030; APCA **no** normativo | `DESIGN.md` ya usa AA piso + APCA como guía | ✅ Postura correcta. No esperar WCAG 3; sí cerrar los huecos AA ya listados |
| 11 | **CWV 2026**: umbrales iguales (LCP 2.5s / INP 200ms / CLS 0.1), pero la medición de **INP** ahora pondera latencia sostenida; **soft navigations** en CrUX (Chrome 151, jul-2026) → las SPA finalmente se miden en campo | Sin medición de campo; 43% de los sitios falla INP | 🎯 `web-vitals` v5 con atribución + soft-nav; presupuesto INP en vistas densas |
| 12 | **Agentic UX** tiene patrones canónicos: Intent Preview · Autonomy Dial · Explainable Rationale · Confidence Signal · Action Audit & Undo · Escalation Pathway | Tenemos HITL (`proposed_actions`), bandeja de hallazgos, feedback 👍/👎 — sin dial de autonomía ni undo formal | 🎯 Es el mapa para Maat/Thot/Horus (§8) |
| 13 | **Generative UI** se estandarizó: **A2UI** v0.9 (Apache 2.0, Google) con **renderer Angular** + AG-UI para el stream de eventos | Los chats (Thot/Maat) devuelven markdown + `render_response` propio | 🔭 Spike: el agente emite blueprint JSON, el host renderiza **nuestros** componentes |
| 14 | **Local-first**: PowerSync es el único con offline de primera clase (Postgres→SQLite); Electric y Zero declaran offline fuera de alcance | Dexie + cola propia; ADR-032 (device = fuente de verdad, idempotente por `client_uuid`) | ✅ Nuestro diseño es correcto; PowerSync solo si el mantenimiento escala mal |

---

## 0. Auditoría de adopción — medida en el repo (ago-2026)

Grep sobre `apps/` + `libs/` (`.ts/.html/.css/.scss`), contando archivos que contienen la feature:

| Feature moderna | Archivos | Lectura |
|---|---:|---|
| `tabular-nums` | 170 | ✅ excelente (cifras) |
| `prefers-reduced-motion` | 71 | ✅ el contrato de motion se cumple |
| `color-mix()` | 64 | ✅ overlays alpha en vez de hex por estado |
| `dvh` | 30 | ✅ viewport móvil correcto |
| `clamp()` | 15 | 🟡 fluido parcial |
| `animation-timeline` (scroll-driven) | 5 | 🟡 puntual, no sistematizado |
| `:has()` | 3 | 🟡 subutilizado (styling por estado) |
| `content-visibility` | 2 | 🟡 solo 2 — es la palanca barata de INP en listas largas |
| `view-transition` | 2 | 🟡 puntual |
| `popover` | 1 | 🔴 casi nada |
| `field-sizing` | 1 | 🔴 |
| `text-wrap` (balance/pretty) | 1 | 🔴 gratis y no lo usamos |
| **`@container` / `container-type`** | **0** | 🔴 **contradice `DESIGN.md §5`** |
| **`@layer`** | **0** | 🔴 con 971 `!important` encima |
| `anchor-name`, `@scope`, `light-dark()`, `@starting-style`, `interpolate-size`, `subgrid` | 0 | 🔴 sin explorar |
| `oklch` en `tokens.css` | 0 | 🔴 todo hex (`--brand-500: #F8B400`) |

**Deuda medida:** `971 !important` · `317 ::ng-deep` · `296 @media` (124 con `max-width` en px).

Diagnóstico honesto: **el sistema de diseño (tokens, reglas, estética, contrato) está muy por delante de la plataforma con la que lo implementamos.** Los 971 `!important` no son descuido — son el síntoma de pelear contra el CSS de un vendor sin capas de cascada.

---

## 1. Plataforma: lo que ya es seguro usar

### 1.1 Interop 2026 — 20 áreas, 11 de CSS

Interop es el acuerdo anual Google/Apple/Mozilla/Microsoft/Igalia sobre qué hacer converger. Las áreas 2026 marcan *dónde habrá estabilidad real este año*:

**Carry-over (madurando):** anchor positioning · view transitions (incl. cross-document) · Navigation API (`precommitHandler`) · WebRTC · `zoom`.

**Nuevas relevantes para nosotros:** **container style queries** (`@container style()`) · **dialogs & popovers** (`<dialog closedby>`, `:open`, `popover="hint"`) · **scroll-driven animations** · **`attr()` tipado** · **`contrast-color()`** · **custom highlights** · **scroll snap** · **`shape()`** · **IndexedDB `getAllRecords()`** (⬅️ pega directo en Dexie/vendor offline) · scoped custom element registries · media pseudo-classes.

### 1.2 Tabla de adopción recomendada

| Feature | Estado | Dónde nos sirve | Qué reemplaza |
|---|---|---|---|
| Container queries (+ unidades `cqi`) | Baseline widely (ago-2025) | `MetricCard`, tabla densa, master-detail, todo `libs/` embebido en 3 apps | `@media` por viewport dentro de componentes |
| `@layer` | Interop 2026, soportado | orden `reset < vendor < tokens < components < utilities` | 971 `!important`, 317 `::ng-deep` |
| `:has()` | Interop 2026 (perf) | fila seleccionada, card con error, form inválido | clases de estado calculadas en TS |
| Popover API + `<dialog closedby>` + `:open` | Interop 2026 | menús, side-peek, confirmaciones | overlays manuales, click-outside |
| Anchor positioning + `@position-try` | **Baseline 2026** (Chrome 125+ / FF 132+ / Safari 18.2+) | tooltips de KPI, hovercards de cliente/SKU, popovers de filtro | Floating-UI o cálculo de posición en JS |
| Invoker commands (`command`/`commandfor`) + `interestfor` + `popover="hint"` | Chrome 135+, progresivo | abrir dialogs sin JS; hover-cards | handlers de plomería |
| `@starting-style` + `transition-behavior: allow-discrete` | Soportado | entrada de popover/dialog sin flash | animaciones de entrada en JS |
| View Transitions (same + cross-doc) | Interop 2026 | router `/comercial → detalle`, master→detail, tabs | animación de ruta a mano |
| Scroll-driven animations | Interop 2026 (FF parcial) | header que condensa, progreso, reveals | listeners de `scroll` |
| `contrast-color()` | Interop 2026 | texto sobre chips/badges de color-que-codifica-dato | tabla manual de pares de contraste |
| `attr()` tipado | Interop 2026 | `--hue: attr(data-hue type(<number>))` en chips/gauges | `[style.--x]` binding |
| `sibling-index()` / `sibling-count()` | Chrome reciente | stagger de filas/cards | índices en template |
| `text-wrap: balance` / `pretty` | Soportado | títulos de card, page-heads, labels de KPI | nada (mejora gratis) |
| `field-sizing: content` | Soportado | inputs de cantidad (carrito, pedido), notas | JS de auto-resize |
| `interpolate-size` / `calc-size()` | Chrome | acordeones y paneles con altura `auto` animable | `max-height` hackeado |
| `light-dark()` | Soportado | tokens que difieren por tema sin duplicar bloque | duplicación de bloques dark |
| `@scope` | Progresivo | estilos por módulo sin `::ng-deep` | `::ng-deep` |
| Custom highlights | Interop 2026 | resaltar coincidencias de `applySmartSearch` sin tocar el DOM | `<mark>` inyectado por innerHTML |
| `<select>` personalizable (`appearance: base-select`) | Progresivo | selects triviales con **nuestros** tokens | `p-select` donde no aporta |
| CSS carousels (`::scroll-button`, `::scroll-marker`) | **No Baseline** | carrusel del portal como mejora progresiva | librería de carrusel |
| `grid-lanes` / masonry | Radar | galerías de evidencia fotográfica (Horus/HV) | JS de masonry |
| `if()` en valores | Radar | `transition-duration: if(media(prefers-reduced-motion: reduce): 0ms; else: 180ms)` | reglas duplicadas |

> **Regla de oro de adopción:** todo lo de arriba entra como **mejora progresiva** (`@supports`), nunca como requisito. El campo (vendedor/repartidor) corre Android de gama baja: ahí la regla es *que funcione sin la feature*.

### 1.3 La deuda que `@layer` borra

Con Tailwind + PrimeNG + spartan + CSS propio, la única palanca que teníamos era subir especificidad → `!important` (971) y `::ng-deep` (317). Con capas explícitas el orden lo define la **capa**, no el selector:

```css
@layer reset, vendor, tokens, components, utilities;
/* vendor = PrimeNG. Nuestro CSS vive en components/utilities y gana sin !important */
```

Migración realista: declarar el orden global, mover CSS **nuevo** a capas y usar el conteo de `!important` por módulo como métrica de QA. Nada de big-bang.

---

## 2. Responsividad: el método 2026

La síntesis del campo: **cuatro herramientas con trabajos distintos.**

| Herramienta | Trabajo | En nuestro código |
|---|---|---|
| `@media` | **página/chrome**: sidebar colapsa, nav pasa a bottom-bar, densidad por `pointer: coarse` | 296 usos — la mayoría hace trabajo de componente ❌ |
| `@container` | **componente**: cómo se reorganiza según el ancho que le dio el padre | 0 usos ❌ |
| `clamp()` | **fluido**: type y spacing sin breakpoints | 15 usos 🟡 |
| Grid intrínseco (`auto-fit`, `minmax`, `subgrid`) | **layout sin breakpoints** | parcial |

**Regla de a11y del `clamp()`:** el máximo no debe superar ~2.5× el mínimo y el término medio debe llevar componente en `rem`; si no, revienta WCAG 1.4.4 (zoom 200%).

```css
/* type fluido seguro */
--fs-page-head: clamp(1.375rem, 1.125rem + 1.2vw, 2rem);
```

**Nuestro caso más doloroso:** un componente de `libs/` que se embebe en Operations (ancho completo), en un panel de master-detail (~420px) y en `/portal`. Hoy decide por viewport → en el panel se dibuja como si tuviera pantalla completa.

```css
.card-wrap { container-type: inline-size; container-name: card; }

@container card (min-width: 30rem) {
  .card       { grid-template-columns: 1fr auto; }
  .card__spark{ display: block; }
}
@container card (max-width: 22rem) {
  .card__meta { display: none; }   /* progressive disclosure por espacio real */
}
```

**Trampa ya documentada en `DESIGN.md §5` (vale repetirla):** `container-type` crea contención de tamaño y **rompe elementos que se desbordan a propósito** (overlays PrimeNG, tooltips). El contenedor va en el *wrapper de layout*, nunca en el nodo que ancla overlays.

**Novedades 2026 que suman al método:**
- **Container style queries** (`@container style(--density: compact)`): la densidad como *token heredado*, no como clase repetida en cada hijo. Calza exacto con densidad por surface.
- **`@container scroll-state((stuck: top))`**: el header de tabla densa se estiliza *cuando está pegado*, sin `IntersectionObserver`.
- **`pointer: coarse`** para targets ≥44px (ya en el contrato) y `dvh` (30 archivos ✅).
- **Cero `max-width` nuevos en px**: breakpoints en `rem` para que respeten el zoom del usuario. Hoy hay 124 en px.

---

## 3. Interacción nativa: menos JS de plomería

El bloque más grande de 2026: la plataforma absorbió los patrones de overlay.

```html
<!-- hovercard de cliente: sin JS, sin listeners, sin Floating UI -->
<a interestfor="hc-cliente" href="/comercial/clientes/123">DEMO-001</a>
<div id="hc-cliente" popover="hint" class="hovercard">…saldo, última compra, riesgo…</div>
```

```css
.hovercard { position-anchor: --cli; position-area: block-end span-inline-end; }
@position-try --flip { position-area: block-start span-inline-end; } /* se reacomoda solo */
```

- `<dialog closedby="any">` + `:open` → confirmaciones sin plomería de foco/escape.
- Invoker commands (`commandfor`/`command`) → abrir/cerrar sin handler en el componente.
- `appearance: base-select` → selects simples con **nuestros** tokens, sin pelear el theming del vendor.
- **Command menu (⌘K)** ya es patrón esperado en herramientas internas densas; PrimeNG 22 trae `CommandMenu`, y también se arma con Angular Aria + popover.

Criterio: **no reescribir componentes PrimeNG que ya funcionan.** Esto aplica a UI *nueva* y, con suerte, a parte de los 317 `::ng-deep` que existen solo para forzar comportamiento de overlay.

---

## 4. Motion: la stack nativa ganó

- **View Transitions**: en Angular, `provideRouter(routes, withViewTransitions())` + `view-transition-name` en el elemento que persiste (fila → detalle). Reglas: solo `transform`/`opacity`, gate `prefers-reduced-motion` (71 archivos ya lo hacen ✅), techo 350ms del contrato.
- **Scroll-driven** (`scroll-timeline` / `view-timeline`): progreso, headers que condensan, reveals — **sin JS**. Nunca rotaciones ni translaciones grandes sin gate de reduced-motion.
- **Springs sin librería**: `linear()` permite easings tipo resorte generados; no hace falta Motion/GSAP para eso (y `DESIGN.md` ya dice que GSAP no es dependencia).
- Presupuesto 150/250/350ms + limpieza en `DestroyRef`: el contrato está bien; lo que falta es **usar las APIs nativas** en lugar de animar a mano.

---

## 5. Framework y tooling: dónde estamos y los tres movimientos

### 5.1 Angular 22 — estamos bien parados

| Capacidad | Estado nuestro |
|---|---|
| Zoneless change detection (default desde 21) | ✅ `provideZonelessChangeDetection()` en `app.config.ts`; `zone.js 0.16.2` sigue en `polyfills.ts` → **sacarlo** tras validar |
| Signals | ✅ patrón establecido |
| **Signal Forms** (estable en 22) | 🔭 nada migrado. No tocar forms que funcionan; usarlo en forms **nuevos** complejos (pedido, requisición) |
| **Angular Aria** (`@angular/aria`: combobox, listbox, menu, tabs, accordion, toolbar headless) | 🔭 sin usar — **es la pieza clave del plan B de PrimeNG** |
| Vitest como runner | 🔭 seguimos en Jest (`jest-preset-angular 17`) |
| CLI con MCP server | 🔭 sin evaluar |

### 5.2 ⚠️ PrimeNG cerró: decisión estratégica pendiente

Hechos verificados: PrimeTek **archivó el repo de PrimeNG el 28-29 jun-2026** y movió los majors futuros a licencia comercial en la suite **PrimeUI** — **$599 USD/dev** perpetua con 1 año de updates (precio de lanzamiento hasta fin de 2026; **$799** desde 2027), con tier Community para quien califique. La comunidad levantó un fork desde el último código MIT (**OpenNG**, nombre en disputa por marcas).

Nosotros: `primeng 22.0.0` en producción, usado en todo Operations (tablas, overlays, dialogs, charts, MultiSelect…), y `DESIGN.md` dice explícitamente *"preferir PrimeNG"*.

| Opción | Costo | Riesgo | Cuándo conviene |
|---|---|---|---|
| **A. Licenciar PrimeUI** | ~$599/dev × 3 ≈ $1.8k | Bajo. Dependencia de un vendor que ya cambió las reglas una vez | Si el ritmo de features manda (probable ganadora) |
| **B. Congelar en 22.0.0** | $0 | Medio-alto: sin fixes ni soporte de Angular 23+; deuda con fecha de vencimiento | Puente 6-12 meses mientras se decide |
| **C. Migrar a headless** (Angular Aria + spartan/ui, **ya está** en el repo) + nuestros tokens | Alto en horas; ganancia en control y en los 971 `!important` | Medio: reescribir tablas/overlays densos es caro | Dirección estratégica a 12-18 meses, por módulo |
| **D. Fork comunitario (OpenNG)** | $0 + mantenimiento | Alto: gobernanza joven, marca en disputa | Solo si A y B se caen |

**Recomendación:** **B ahora + A al cerrar el año** (presupuestable, no frena features), con **C como dirección**: todo componente *nuevo* de UI densa se construye con Angular Aria + tokens, no con PrimeNG. Así la dependencia deja de crecer sin detener nada. **Decide Edgar.**

### 5.3 Tailwind v4 — migración de infraestructura

Estamos en `3.4.19` con preset `@spartan-ng/ui-core` alpha. v4 trae: config **CSS-first** (`@theme` dentro del CSS, adiós `tailwind.config.js`), motor Rust (cold builds −60-80%), container queries de primera clase, salida en capas de cascada. Los renames (`bg-gradient-to-*` → `bg-linear-to-*`, `flex-shrink-0` → `shrink-0`) los cubre `npx @tailwindcss/upgrade` (~90%). **Compatibilidad verificada:** hay stacks públicos con Angular 22 + Tailwind 4.3 + spartan/ui 1.x (hoy usamos spartan `0.0.1-alpha.*`, así que también implica subir spartan).

Por qué nos importa más que a otros: `@theme` en CSS **es** el modelo que ya adoptamos con `tokens.css` como archivo único de las 3 apps. Hoy tenemos doble fuente — vars CSS + `theme.extend` en JS que las re-mapea.

### 5.4 Design tokens: ahora sí hay estándar

El **DTCG Format Module v2025.10** (W3C Community Group) es la **primera versión estable**, respaldada por 24+ organizaciones (Adobe, Google, Meta, Figma). El toolchain que se asentó en 2026: **Figma Variables → DTCG JSON → Style Dictionary → CSS/Sass/iOS/Android** en CI. Adopción de tokens: 84% de equipos (vs 56% el año anterior).

Nuestro caso: `tokens.css` (585 líneas, mantenido a mano, **0 `oklch`**, hex crudo). Propuesta: `libs/design-tokens/tokens.json` en DTCG como **fuente**, build a `tokens.css` (+ opcionalmente el `@theme` de TW4), y migrar las rampas a **OKLCH** (ya estaba en el backlog de `DESIGN_TENDENCIAS_2026`: escalas perceptualmente uniformes, mezclas predecibles, gamut P3). Beneficio inmediato y medible: un dark que no requiere ajustar a ojo cada paso de la rampa.

---

## 6. Accesibilidad: el piso se movió por ley, no por moda

- **WCAG 2.2 AA sigue siendo el objetivo operativo.** No hay estándar nuevo aplicable hoy.
- **Europa:** EN 301 549 v3.2.1 (WCAG 2.1 AA) es el vigente; **v4.1.1 se publica en 2026 incorporando WCAG 2.2** y será la referencia técnica de la **European Accessibility Act**. Si algún día vendemos software a UE, ése es el piso.
- **WCAG 3.0**: Working Draft (actualizado mar-2026), modelo por *outcomes* con **Bronze/Silver/Gold** (Bronze ≈ 2.2 AA); Recommendation esperada **2028-2030**. Conclusión: **no esperar**; quien cumple 2.2 AA hoy ya está construyendo Bronze.
- **APCA**: sigue **exploratorio y no normativo**. Nuestra postura actual (AA como piso obligatorio + APCA como guía para texto chico) es exactamente la correcta.
- **Nuevo y útil**: `contrast-color()` automatiza el par texto/fondo en chips y badges de dato — justo donde hoy elegimos a mano, y donde la excepción de "color que codifica dato" puede fallar en dark.
- Los huecos propios ya inventariados en `DESIGN.md` (targets 24 vs 44px, `focus-visible` ~22%, 309 `error:()=>{}` vacíos) siguen siendo **la prioridad real**: la ley no cambió, nuestro cumplimiento sí puede.

---

## 7. Performance = UX (y por fin medible en SPA)

- **Umbrales 2026 sin cambios**: LCP < 2.5s · **INP < 200ms** · CLS < 0.1. Pasa los tres ~56% de los orígenes; **43% falla INP**.
- **Cambio real**: la medición de INP ahora **pondera latencia sostenida** en páginas con mucha interacción → nos pega justo en tablas densas, filtros y bandejas (Compras, Bancos, Hallazgos).
- **Soft navigations**: origin trial desde Chrome 147 (mar-2026) y sin flag desde **Chrome 151 (jul-2026)**, reconocidas en CrUX → **por primera vez una SPA como la nuestra puede medir sus transiciones internas en campo**, no solo la carga inicial.
- Palancas concretas: `content-visibility: auto` (solo 2 archivos hoy) en listas/tablas largas; virtualización real donde hay miles de filas; ceder el hilo (`scheduler.yield()`) en handlers de filtro; `@defer` de Angular en bloques pesados (charts, mapas Leaflet); y **medir** — `web-vitals` v5 con atribución + soft-nav reportando a Sentry (ya hay `@sentry/angular 10`).
- Regla de diseño derivada: **el presupuesto de interacción es parte del diseño**, no del sprint de performance. Un filtro que tarda 400ms en responder es un defecto de diseño.

---

## 8. UX de producto 2026: agentic UX (esto nos pega directo)

NN/g *State of UX 2026*: la disciplina se estabilizó y el gran problema de diseño es la **confianza** en experiencias con IA — se construye con transparencia, control, consistencia y buen manejo de la falla. Además, **investigación democratizada** (~70% de diseñadores hace su propia research; unmoderated 20-40% más costo-eficiente).

Los seis patrones canónicos, mapeados a lo que ya tenemos (Maat, Thot, Horus, RA):

| Patrón | Qué es | Nosotros hoy | Falta |
|---|---|---|---|
| **Intent Preview** | Mostrar el plan **antes** de ejecutar, en lenguaje llano, con Proceder / Editar / Lo hago yo | `proposed_actions` HITL (Maat P3), requisiciones RQ | Preview del plan multi-paso en el chat, no solo el resultado |
| **Autonomy Dial** | Nivel de autonomía **por tipo de tarea** (observar → sugerir → actuar) | Todo es "sugerir + humano aprueba" (co-piloto, ADR-020) | Dial por dominio: dejar autónomo lo de bajo riesgo (refrescar MVs, reclasificar bancos por regla) |
| **Explainable Rationale** | "Porque dijiste X, hice Y" con precedente, no logs | Hallazgos con evidencia + link a póliza ✅ (muy bien) | Estandarizar el *por qué* como campo, no como texto libre |
| **Confidence Signal** | Certeza visible para evitar sesgo de automatización | `precision_score` (L2), `score 0..1` en canasta | Mostrar la confianza **en la UI**, no solo usarla para suprimir |
| **Action Audit & Undo** | Log cronológico + undo prominente, con ventana explícita | Auditoría sí (`order_status_history`, audit de chat) | **Undo** casi inexistente; y avisar cuándo ya no se puede revertir |
| **Escalation Pathway** | Escalar la ambigüedad en vez de adivinar | Bandeja de hallazgos con triage | Ruta explícita "no sé / decide un humano" dentro del chat |

**Generative UI — el cambio de fondo.** Se estandarizó cómo un agente emite **UI declarativa**: **A2UI** (Apache 2.0, Google; v0.8 dic-2025, **v0.9 abr-2026**) con renderers para **Angular**, Lit, React y Flutter, patrón Agent-View-Controller; y **AG-UI** (CopilotKit) para el stream de eventos agente↔frontend. La tesis: el agente **no** escribe HTML ni markdown — emite un blueprint JSON que referencia un catálogo de componentes que **el host** anuncia, y el host renderiza con **su** design system.

Por qué nos calza: nuestros chats (Thot, Maat) ya devuelven `render_response` estructurado por decisión propia. A2UI es esa misma idea, pero estándar y con renderer Angular. Un spike acotado ("Maat responde con nuestras tablas/cards en vez de markdown") vale una tarde y respeta la regla de oro: **el LLM fuera del camino del dinero** — emite *layout*, nunca cifras.

---

## 9. Local-first / offline (vendor, VR, LM)

Estado del ecosistema 2026: tres motores de sync pluggables — **PowerSync** (el único con **offline de primera clase**: subset de Postgres/Mongo/MySQL → SQLite en cliente; el más listo para producción si ya tenés Postgres), **ElectricSQL** (Postgres→SQLite, pero la **persistencia del cliente es tu problema**) y **Zero** (colaborativo; offline explícitamente fuera de alcance por ahora).

Nosotros: Dexie + cola propia; ADR-032 (Venta en Ruta) define *el device es la fuente de verdad, el server acepta y concilia, idempotente por `client_uuid`*. Eso **es** arquitectura local-first correcta, y para venta en ruta (dinero, folio local, arqueo) el control fino importa más que la conveniencia del framework.

Veredicto: **no migrar**. Evaluar PowerSync solo si el mantenimiento de la cola escala mal (>1 dominio offline: VR + LM + captura). Sí adoptar ya: **IndexedDB `getAllRecords()`** (Interop 2026) para lecturas en lote de Dexie.

---

## 10. Backlog priorizado

| # | Item | Impacto | Esfuerzo | Notas |
|---|---|---|---|---|
| DT.1 | Declarar `@layer` global + política anti-`!important` (métrica por módulo) | 🔥 alto | M | Ataca 971 `!important` + 317 `::ng-deep` |
| DT.2 | Container queries en `libs/` + MetricCard + tabla densa + master-detail | 🔥 alto | M | Cierra el gap del contrato `DESIGN.md §5` |
| DT.3 | Medición CWV de campo (`web-vitals` v5 + atribución + soft-nav → Sentry) + presupuesto INP | 🔥 alto | S | Sin datos no hay diseño de performance |
| DT.4 | **Decisión PrimeNG** (§5.2) + regla "UI densa nueva = Angular Aria + tokens" | 🔥 alto | S (decisión) | Riesgo de vendor, no técnico |
| DT.5 | `tokens.json` DTCG como fuente + build a `tokens.css`; rampas a OKLCH | alto | M | Estándar W3C + dark predecible |
| DT.6 | Tailwind v4 + spartan 1.x | alto | L | Colapsa la doble fuente de tokens |
| DT.7 | Overlays nuevos con Popover + anchor + `interestfor` (hovercards cliente/SKU) | medio | S | Menos JS, menos `::ng-deep` |
| DT.8 | View Transitions en router + master→detail; scroll-driven en headers densos | medio | S | Ya hay 2+5 archivos de base |
| DT.9 | Quick wins gratis: `text-wrap: balance/pretty`, `field-sizing`, `light-dark()`, `content-visibility` | medio | XS | Una tarde y se nota |
| DT.10 | Patrones agentic faltantes: Autonomy Dial, Undo con ventana, confianza visible, escalación explícita | alto (producto) | M | §8; al aceptarse sube a `DESIGN.md` |
| DT.11 | Spike A2UI (renderer Angular) para respuestas de Maat/Thot con componentes nuestros | medio | S | El LLM emite layout, nunca cifras |
| DT.12 | Sacar `zone.js` de polyfills; Signal Forms en forms nuevos; evaluar Vitest | medio | M | Angular 22 ya lo permite |
| DT.13 | Breakpoints en `rem` (migrar los 124 `max-width` en px) | medio | S | Respeta el zoom del usuario (1.4.4) |
| DT.14 | `contrast-color()` en chips/badges de data-viz | bajo | XS | Cubre la excepción de color por card en dark |

Orden sugerido: **DT.3 → DT.1 → DT.2 → DT.9** (medir, ordenar la cascada, arreglar responsividad de componentes, cosechar lo gratis), con **DT.4** en paralelo porque es decisión, no código.

## 11. Qué debería subir a `DESIGN.md` (propuestas de regla)

1. **Responsividad por capas (BINDING):** `@media` solo para chrome/página; componente = `@container`; breakpoints en `rem`; `clamp()` con máximo ≤ 2.5× el mínimo.
2. **Cascada (BINDING):** orden de `@layer` declarado; `!important` requiere justificación en review; `::ng-deep` solo para vendor y con comentario.
3. **Overlays (BINDING):** overlay/tooltip/hovercard nuevo usa Popover + anchor positioning con `@supports`, no JS de posicionamiento.
4. **Presupuesto de interacción (BINDING):** INP < 200ms como criterio de aceptación de vistas densas (medido, no estimado).
5. **Agentic UX (BINDING para IA):** toda acción de agente expone plan previo, confianza, razón y ruta de reversa/escalación.
6. **Tokens:** la fuente es DTCG JSON; `tokens.css` pasa a ser **artefacto generado**; color en OKLCH.

---

## Fuentes

**Plataforma / CSS:** [Interop 2026 (web.dev)](https://web.dev/blog/interop-2026) · [Announcing Interop 2026 (WebKit)](https://webkit.org/blog/17818/announcing-interop-2026/) · [Launching Interop 2026 (Mozilla)](https://hacks.mozilla.org/2026/02/launching-interop-2026/) · [interop/2026 README](https://github.com/web-platform-tests/interop/blob/main/2026/README.md) · [2026 CSS features (Riad Kilani)](https://blog.riadkilani.com/2026-css-features-you-must-know/) · [anchor() (MDN)](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/anchor) · [Web Platform Baseline 2026](https://www.buildmvpfast.com/blog/web-platform-baseline-2026-new-features-browser-support) · [CSS Wrapped 2025](https://chrome.dev/css-wrapped-2025/) · [::scroll-button (MDN)](https://developer.mozilla.org/docs/Web/CSS/::scroll-button) · [CSS-only carousel](https://modern-css.com/articles/build-a-css-only-carousel/)

**Responsividad:** [Container queries en 2026 (LogRocket)](https://blog.logrocket.com/container-queries-2026/) · [Responsive Web Design 2026 (Scrimba)](https://scrimba.com/articles/responsive-web-design-a-complete-guide-2026-2/) · [Beyond breakpoints (Studio Meyer)](https://studiomeyer.io/en/blog/responsive-design-beyond-breakpoints)

**Motion:** [View Transitions + scroll-driven: los triunfos de 2026](https://www.frontendhorizon.com/blog/view-transitions-api-and-css-scroll-driven-animations-the-browser-wins-of-2026) · [View Transitions con Angular](https://konstantin-denerz.com/view-transitions-with-angular-spa/) · [Scroll-driven animations (Josh Comeau)](https://www.joshwcomeau.com/animation/scroll-driven-animations/)

**Framework / tooling:** [What's new in Angular 21 (AngularArchitects)](https://www.angulararchitects.io/blog/whats-new-in-angular-21-signal-forms-zone-less-vitest-angular-aria-cli-with-mcp-server/) · [Angular Aria (dev.to)](https://dev.to/brianmtreese/angular-accessibility-just-got-easier-introducing-angular-aria-3k71) · [The Next Chapter of PrimeTek](https://primeui.dev/nextchapter) · [PrimeUI pricing](https://primeui.dev/pricing) · [PrimeNG is no longer open source (OpenNG)](https://github.com/openng-org/openng.org/blob/main/src/content/posts/primeng-is-no-longer-open-source.md) · [Ng-News 26/17](https://dev.to/playfulprogramming-angular/ng-news-2617-primengs-new-licensing-and-a2ui-for-angular-4eik) · [Tailwind v4 migration](https://www.digitalapplied.com/blog/tailwind-css-v4-migration-new-features-guide) · [spartan + Angular 22 + TW4](https://blog.rasc.ch/2026/07/spartan-angular.html)

**Tokens:** [El spec de tokens ya es real](https://themotiondesign.com/writing/design-token-spec-finally-real-now-what) · [DTCG en Figma](https://www.misha.wtf/blog/figma-dtcg-design-tokens) · [Design systems 2026](https://www.digitalapplied.com/blog/design-systems-2026-scale-ui-without-chaos-methodology)

**A11y:** [WCAG 3.0 overview 2026 (AbilityNet)](https://abilitynet.org.uk/resources/digital-accessibility/what-expect-wcag-30-web-content-accessibility-guidelines) · [EAA compliance (Level Access)](https://www.levelaccess.com/compliance-overview/european-accessibility-act-eaa/) · [WCAG 3.0 status 2026](https://web-accessibility-checker.com/en/blog/wcag-3-0-guide-2026-changes-prepare)

**Performance:** [Soft navigations (Chrome)](https://developer.chrome.com/docs/web-platform/soft-navigations) · [Core Web Vitals update 2026](https://webvitals.tools/blog/google-core-web-vitals-update-2026/) · [CWV statistics 2026](https://thestacc.com/blog/core-web-vitals-statistics/) · [web-vitals](https://github.com/GoogleChrome/web-vitals)

**UX / agentic / generative UI:** [State of UX 2026 (NN/g)](https://www.nngroup.com/articles/state-of-ux-2026/) · [Designing for Agentic AI (Smashing)](https://www.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/) · [Introducing A2UI (Google)](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/) · [A2UI standard (AgentPatterns)](https://agentpatterns.ai/standards/a2ui/) · [Generative UI 2026 (CopilotKit)](https://www.copilotkit.ai/blog/the-developer-s-guide-to-generative-ui-in-2026) · [Agentic UX patterns (Zylos)](https://zylos.ai/research/2026-05-28-agentic-ux-frontend-design-patterns-ai-agents/)

**Local-first:** [The architecture of local-first web development (Smashing)](https://www.smashingmagazine.com/2026/05/architecture-local-first-web-development/) · [Electric vs PowerSync vs Zero](https://trybuildpilot.com/648-electric-sql-vs-powersync-vs-zero-2026)
