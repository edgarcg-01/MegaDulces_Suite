# Design Foundations — bases de UI/UX al estado del arte (knowledge base)

> Knowledge base de **fundamentos** que respalda al sistema operativo [`DESIGN.md`](../DESIGN.md).
> Generado por `/deep-research` (2026-06-08): 6 ángulos · 29 fuentes · 141 claims extraídos · 25 verificados con voto adversarial 3-votos · 21 confirmados / 4 refutados.
>
> **`DESIGN.md` manda sobre la implementación** (tokens, surfaces, patrones). Este archivo explica el *por qué* y el estado del arte, para que las decisiones futuras tengan base teórica y no opinión.

---

## Cómo leer este documento

Cada afirmación lleva un **nivel de confianza** explícito. No todo lo que pediste produjo evidencia primaria; donde no la hubo, lo digo en vez de inventar una cita.

| Nivel | Qué significa |
|---|---|
| 🟢 **Verificado** | Sobrevivió verificación adversarial (≥2 de 3 votos) contra fuente primaria (spec W3C, MDN, docs oficiales). |
| 🟡 **Consenso** | Buena práctica de la industria respaldada por fuentes secundarias/blog de autoridad, pero **sin claim primario verificado** en esta pasada. Tratar como recomendación fuerte, no como ley. |
| 🔴 **Refutado** | Claim que sonaba plausible pero murió en verificación. Listado para que **no** se use. |
| ⚪ **Hueco** | Tema que pediste y la investigación **no** cerró con fuente. Pendiente de una segunda pasada. |

Recordatorio de los 2 surfaces (ver `DESIGN.md`): **Storefront** (`/portal/*`, editorial, comfortable, Fraunces) y **Operations** (`/dashboard`, `/comercial`, `/logistica`, `/admin`, `/vendor`, `/televenta`, tool-mode, compact++, sin serif). Cada recomendación abajo distingue surface cuando importa.

---

## 1. Color y contraste — el hallazgo más importante

### 1.1 🟢 WCAG 2.x no es perceptual; usar APCA para legibilidad real

**Estado del arte.** La fórmula de contraste de WCAG 2.x (el ratio X:1, ej. 4.5:1) es **matemáticamente no perceptual**:

- Es **simétrica** (intercambiar texto/fondo da el mismo número) aunque la visión humana es asimétrica.
- **Sobrestima el contraste en colores oscuros**: un par puede dar 4.5:1 y ser "funcionalmente ilegible cuando un color está cerca del negro".
- En **mid-tones rinde casi como azar** (~49% de aciertos en pruebas con miles de colores aleatorios).
- Su modelo **binario pass/fail** es inadecuado para una propiedad perceptual que es continua.

**APCA** (Accessible Perceptual Contrast Algorithm, base candidata de WCAG 3.0) computa un valor **Lc perceptualmente uniforme**: "Lc 60 representa el mismo contraste de legibilidad percibido a lo largo del rango de colores". Es asimétrico y considera tamaño/peso de fuente.

**El flujo recomendado (Lea Verou, CSS WG):** dos pasos —
1. **APCA/Lc** como check de **legibilidad de diseño** (la verdad perceptual).
2. **WCAG 2.x AA** solo como **gate de cumplimiento legal** (failsafe anti-litigio).

> ⚠️ **Caveat crítico (ver §10):** APCA **no es un estándar normativo** todavía — es un método autopublicado por su autor (Myndex/Andrew Somers); a 2026 el método de contraste de WCAG 3 sigue "por determinarse" y WCAG 3 no llega antes de ~2028-2030. **No abandonar WCAG 2.x AA**: usá APCA para diseñar, pero mantené el AA como red de seguridad legal.

**Recomendación Mercado.**
- Recalibrar con APCA los puntos críticos: la rampa **Stone** sobre fondos, el **naranja-sunset `#F05A28`** con texto blanco, y **sobre todo el dark mode espresso `#16130F`** (es justo donde WCAG 2.x miente más).
- Herramientas: [apcacontrast.com](https://git.apcacontrast.com/documentation/WhyAPCA.html), `apca-w3` (npm), el Contrast checker de Polypane.
- **Lo que ya está bien:** tener tokens como single source of truth permite recalibrar la rampa una sola vez y propagar. Esa arquitectura es la que hace barato este cambio.

Fuentes: [Why APCA (primaria)](https://git.apcacontrast.com/documentation/WhyAPCA.html) · [Lea Verou — contrast-color (primaria)](https://lea.verou.me/blog/2024/contrast-color/)

### 1.2 🟢 OKLCH para *generar* rampas; el flip negro/blanco por Lightness (~0.69)

**Estado del arte.** Cuando dos colores tienen **lightness suficientemente distinta**, el ojo **descarta el contraste cromático** y decide legibilidad casi solo por lightness (respaldado por psicofísica revisada por pares, Legge et al. 1990). Consecuencia práctica:

- **OKLCH** (espacio polar perceptual: L=lightness, C=chroma, H=hue) es excelente para **generar rampas tonales** uniformes: variás L en pasos regulares y obtenés una rampa que *se ve* pareja, cosa que HSL/sRGB no logran (en HSL el amarillo y el azul al mismo "lightness" se ven radicalmente distintos de brillo).
- El **flip de color de texto** (negro vs. blanco encima) se puede decidir por umbral de **L ≈ 0.65–0.72 (promedio ~0.69)**.

> 🔴 **Refutado — no usar:** "OKLCH es *el* espacio más perceptualmente uniforme y la distancia euclidiana = diferencia perceptual exacta." Murió 1-2. Verou misma nota que la **luminancia Y** es *marginalmente mejor* que la L de OKLCH para la decisión exacta del flip. → **OKLCH genera rampas; no es la métrica de contraste definitiva.** Para el veredicto final de legibilidad, APCA.

**Recomendación Mercado.**
- Migrar la definición de las rampas (`--stone-*`, `--brand-*`) a **OKLCH** y generarlas variando L en pasos regulares. CSS ya soporta `oklch()` nativo en todos los browsers modernos.
- Decidir texto negro/blanco sobre cualquier superficie por umbral de L (~0.69), **validando con APCA** después.
- **Evolución concreta:** hoy las rampas en [`tokens.css`](../apps/view/src/styles/tokens.css) son hex sueltos. Reescribir `--stone-*` y `--brand-*` como `oklch()` con L escalonada hace la rampa auditable y editable de un solo eje.

Fuentes: [Lea Verou (primaria)](https://lea.verou.me/blog/2024/contrast-color/) · [Evil Martians — OKLCH in CSS (blog)](https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl)

### 1.3 Dark mode y daltonismo (consenso)

- 🟡 **Dark mode no es invertir.** Ya lo hacen bien: el espresso `#16130F` en vez de `#000` puro es exactamente la jugada correcta (negro puro bajo marca cálida se ve duro/barato, y maximiza el halation en texto). Mantener.
- 🟡 **No codificar significado solo en color** (daltonismo ~8% de hombres). Estado de visita/orden debe llevar **forma/ícono/texto** además del color semántico. Ya tienen `p-tag` con label + severity — mantener esa disciplina; nunca un dot de color sin texto.

---

## 2. Tipografía

### 2.1 🟢 Optical sizing (`opsz`) — activarlo en toda la escala de Fraunces

**Estado del arte.** En fuentes variables con eje `opsz` (Fraunces lo tiene), el navegador ajusta el dibujo de la letra al tamaño:

- A **tamaños chicos**: trazos más gruesos, serifas más grandes, mayor altura-x, interletraje más abierto, **menos contraste** → más legible.
- A **tamaños display**: trazos más finos y **más contraste** grueso/fino → más elegante.

Se activa **automáticamente**: `font-optical-sizing: auto` es el valor inicial para fuentes con eje `opsz`. **No** hay que pinear `opsz` vía `font-variation-settings` salvo razón específica (hacerlo *desactiva* el `auto`).

**Recomendación Mercado (Storefront).**
- Confiar en `font-optical-sizing: auto` para Fraunces en todo el rango (hero display → títulos chicos). No fijar `opsz` manualmente.
- **Lo que ya está bien:** elegir Fraunces (display serif óptico) para el editorial del portal es coherente con el estado del arte; el `font-optical-sizing` ya aplicado en el home (ver `DESIGN.md`, revisión 2026-06-04) es correcto. Extenderlo a toda la escala display.

Fuentes: [MDN font-optical-sizing (primaria)](https://developer.mozilla.org/en-US/docs/Web/CSS/font-optical-sizing) · [OpenType opsz spec (primaria)](https://learn.microsoft.com/en-us/typography/opentype/spec/dvaraxistag_opsz) · [Pixel Ambacht — optical size (blog)](https://pixelambacht.nl/2021/optical-size-hidden-superpower/)

### 2.2 🟡 Escala modular, measure, line-height, tracking (consenso — sin claim primario)

> ⚪ **Hueco honesto:** la investigación **no** produjo claims primarios verificados sobre ratios de escala modular, measure, line-height o `tabular-nums`. Lo de abajo es consenso de industria, no spec citada. Es candidato a una segunda pasada de research.

- **Escala modular:** elegir un **ratio** y derivar tamaños (no inventar px sueltos). Ratios comunes: 1.2 (minor third, denso — bueno para **Operations**), 1.25 (major third), 1.333 (perfect fourth — bueno para **Storefront** editorial con más salto entre niveles). Mercado ya tiene escala display con `clamp()` responsive — formalizar el ratio detrás.
- **Measure (ancho de línea):** 45–75 caracteres para texto corrido. Relevante en empty states y descripciones del portal; en tablas no aplica.
- **Line-height:** inverso al tamaño — títulos display `1.0–1.15`, body `1.4–1.6`, datos en tabla `1.2–1.3`.
- **Tracking:** negativo en display grande (`-0.01` a `-0.02em`, ya lo hacen), neutro en body, **positivo** en labels uppercase chicos (`+0.06em`, ya lo hacen en `--text-label`).
- **`tabular-nums`:** obligatorio en dinero/cantidades/folios/horas para que las columnas alineen. Ya está en la doctrina (Geist Mono + `font-variant-numeric: tabular-nums`). Mantener como invariante no negociable.
- **Pairing Fraunces + Hanken Grotesk** (serif display + grotesque body) es un patrón canónico; el corpus no devolvió nada que lo refute.

Fuentes (secundarias): [Cieden — type scale types (blog)](https://cieden.com/book/sub-atomic/typography/different-type-scale-types)

---

## 3. Spacing, márgenes y grid

> ⚪ **Hueco honesto:** el tema central de *spacing base-4/8, grid de 8pt, columnas y gutters* **no produjo claims verificados** en esta pasada (solo densidad vía Carbon, §5). Lo de abajo es consenso, no spec. **Candidato #1 a una segunda pasada de research** porque lo pediste explícitamente.

**Consenso de industria (🟡):**

- **Base-8 (8pt grid)** con **base-4 para ajustes finos** es el estándar de facto (Material, Apple, la mayoría de los DS). Todo spacing, tamaño de ícono y altura de control múltiplo de 4/8 → ritmo visual coherente y alineación automática entre componentes.
- **Escala de espaciado** (la de Mercado: 2/4/8/16/24/32/48/64) es **lineal-con-saltos**, no estrictamente modular — correcto para spacing (a diferencia de tipografía, donde el ratio modular ayuda). Mantener.
- **White space como jerarquía:** el espaciado **dentro** de un grupo debe ser menor que el espaciado **entre** grupos (ley de proximidad de Gestalt). Es la herramienta más barata de jerarquía y la más subutilizada.
- **Optical vs métrico:** a veces el spacing matemáticamente correcto se *ve* mal (ej. ícono+texto, padding de botón con cap-height). Permitir override óptico puntual, documentándolo.
- **Grid de columnas:** 12 columnas desktop con gutter múltiplo de 8 es el default seguro. Mercado ya define `max-width` 1180–1280px — falta formalizar columnas/gutter como tokens.

**Recomendación Mercado.** Formalizar la escala de spacing como **tokens** (`--space-2xs … --space-3xl`) y prohibir px sueltos en componentes (consumir siempre el token). Esto ya está alineado con el sprint UX/UI en curso (codemod de hex/px inline → tokens).

Fuentes (secundarias): [DesignSystems.com — space, grids, layouts](https://www.designsystems.com/space-grids-and-layouts/) · [8-point grid (blog)](https://medium.com/free-code-camp/8-point-grid-typography-on-the-web-be5dc97db6bc)

---

## 4. Design tokens — arquitectura canónica

### 4.1 🟢 El spec W3C DTCG (2025.10) define el contrato

**Estado del arte.** El **Design Tokens Format Module** (DTCG, primer spec estable 2025.10) define:

- Un token = **par nombre/valor**; un objeto con propiedad **`$value` es un token** (única propiedad obligatoria).
- **Propiedades reservadas con prefijo `$`**: `$value`, `$type`, `$description`, `$extensions`, `$deprecated`. Los **nombres de token/grupo NO deben empezar con `$`** — esto elimina la necesidad de una lista de palabras reservadas y hace el formato future-proof.
- **Aliasing** con `{group.token}` → así se construyen las **capas**. Las referencias **no pueden ser circulares**.

> 🔴 **Refutado — no usar:** "DTCG define un set fijo de tipos y si no se puede determinar el tipo, las tools DEBEN tratar el token como inválido." Murió 1-2. La realidad: solo `$value` es obligatoria; describir "exactamente tres propiedades primarias" es framing editorial, no el spec.

### 4.2 🟢 Arquitectura en 3 capas

El patrón que convergen los DS top:

```
Capa 1 — Primitivos / raw      --stone-500: oklch(...)        (el valor crudo, sin semántica)
Capa 2 — Semánticos / alias    --text-muted: {stone.600}     (el rol; lo que consumen las pantallas)
Capa 3 — De componente         --table-row-bg: {surface.card} (opcional, específico)
```

**Regla de gobernanza:** los **componentes consumen semánticos, nunca primitivos**. Cambiar la marca = recolorear la capa 1; los semánticos se reasignan; los componentes no se tocan.

**Recomendación Mercado.**
- Mercado **ya hace esto parcialmente** (`--text-main: var(--neutral-950)`, aliases legacy `--brand-primary: var(--brand-400)`). Formalizarlo como **3 capas explícitas** y documentar qué capa puede tocar quién.
- Adoptar el **naming DTCG con `$`** si en algún momento se exporta a Figma/otras tools (portabilidad). Para CSS puro no es urgente, pero el modelo de capas + aliasing **sí**.
- **Tooling:** [Style Dictionary v4+](https://styledictionary.com/info/dtcg/) tiene **soporte de primera clase de DTCG** (🟢 verificado) — compila un único set de tokens DTCG a CSS custom properties con **light/dark/density como dimensiones de transformación**, en vez de mantener variantes a mano. Alternativa de diseño: Tokens Studio (Figma). *Caveat:* soporte 100% del spec estabilizado es WIP en v5; v4 cubre la base.
- **Lo que ya está bien:** tokens CSS como single source of truth es la dirección correcta. El siguiente nivel es la disciplina de capas y (si crece el equipo o se suma Figma) el pipeline Style Dictionary.

Fuentes: [DTCG Format Module (primaria)](https://www.designtokens.org/tr/drafts/format/) · [Style Dictionary DTCG (primaria)](https://styledictionary.com/info/dtcg/)

---

## 5. Tablas densas / data-heavy UI (Operations)

### 5.1 🟡 La densidad es una dimensión parametrizable

**Estado del arte (confianza media).** Carbon Design System expone la tabla en **múltiples alturas de fila discretas** — v10 tenía 4 (compact 24px, short 32px, normal 48px, tall 64px); el **v11 actual** renombró a 5 (extra small → extra large, medium=40px). La densidad **no es un valor fijo sino un eje del sistema**.

> 🔴 **Refutado — no usar:** "Las filas tall solo se justifican con contenido multilínea; lo denso es siempre el default." Murió 1-2. → **La densidad es decisión de contexto, no dogma.** Compact++ es correcto para Operations *porque el usuario escanea muchas filas*, no porque "denso = mejor" universalmente.

> ⚠️ Caveats: Carbon v10 está **archivado**; "tokenizable" fue inferencia del investigador, no implementación literal de Carbon (Carbon expresa las alturas en px/rem).

**Recomendación Mercado.**
- Parametrizar la densidad vía un **token de altura de fila** (`--row-h`) + spacing tokens, exponiendo al menos **2 niveles** (compact++ Operations, comfortable Storefront) e idealmente 3-4 intermedios como Carbon. Hoy `DESIGN.md` fija "row 40px desktop / 56px mobile" — convertir esos px en token.
- Esto valida directamente la tesis de los dos surfaces: misma base, distinta densidad por token.

Fuente: [Carbon v10 data-table (primaria, archivada)](https://v10.carbondesignsystem.com/components/data-table/usage/)

### 5.2 🟡 Patrones de tabla densa (consenso)

- **Números a la derecha + `tabular-nums`** → las columnas de dinero/cantidad alinean el punto decimal y se escanean verticalmente.
- **Texto a la izquierda**, headers alineados con su columna.
- **Sticky header** + **primera columna pegada** en scroll horizontal (ya en la doctrina Operations).
- **Zebra vs. líneas:** debate real. Zebra ayuda en tablas **muy anchas** (seguir la fila), pero **agrega ruido visual** y compite con el color semántico de estado. Para Operations, donde el color comunica estado (verde/ámbar/rojo), **preferir líneas divisorias sutiles** (border `--stone-200`) sobre zebra, para que el color signifique *estado*, no *fila par/impar*.
- **Master-detail** como organismo primario (ya es doctrina, implementado en `/dashboard/routes`).
- **KPI strips sin "AI slop":** métricas en mono-tabular, delta vs. target con color semántico, **sin íconos en círculos de color** (ese es el patrón AI-slop #3 que `DESIGN.md` ya prohíbe).

Fuentes (secundarias): [Pencil & Paper — enterprise data tables](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables) · [Stephanie Walter — complex data tables](https://stephaniewalter.design/blog/essential-resources-design-complex-data-tables/) · [Zebra striping (blog)](https://medium.com/@designbyfgs/do-zebra-striping-practices-in-table-ui-design-enhance-readability-or-create-visual-noise-5d98cc59f4fd)

---

## 6. Accesibilidad — WCAG 2.2

### 6.1 🟢 Target size mínimo 24×24px (SC 2.5.8, Nivel AA, nuevo)

**Estado del arte.** WCAG 2.2 (Recommendation Oct 2023) añade **SC 2.5.8 Target Size (Minimum), Nivel AA**: el target de un puntero es **≥ 24×24 CSS px**. Excepción de **spacing**: targets más chicos cumplen si un **círculo de 24px de diámetro** centrado en cada uno **no intersecta** otro target. (Distinto de SC 2.5.5 *Enhanced*, AAA, que pide 44px.)

**Recomendación Mercado.**
- **Storefront (mobile-first / Capacitor):** apuntar a **44px (AAA)** en flujos críticos (add-to-cart, confirmar, steppers). Ya subieron `cat-add`/steppers a 44px — mantener esa barra.
- **Operations (densidad):** donde 24px sea difícil en celdas/iconos compactos, **usar la excepción de spacing** (círculos de 24px no solapados) en vez de inflar todo y romper la densidad. Es la salida correcta para no sacrificar compact++.

Fuentes: [W3C SC 2.5.8 (primaria)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) · [W3C — New in 2.2 (primaria)](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/)

### 6.2 🟢 Focus Appearance (SC 2.4.13, Nivel AAA, nuevo)

**Estado del arte.** El indicador de foco debe ser **≥ el área de un perímetro de 2 CSS px** alrededor del componente **y** tener **contraste ≥ 3:1** entre estado con y sin foco.

**Recomendación Mercado.**
- Definir un **token de focus-ring** (grosor ≥2px, color con contraste ≥3:1 contra el fondo adyacente) y aplicarlo con `:focus-visible` en **ambos surfaces**.
- En Operations, el ring tiene que **destacar sobre tablas densas** y sobre dark espresso — testear contra Stone neutro y `#16130F`.
- **Evolución concreta:** `tokens.css` hoy tiene `--focus-ring: rgba(37,99,235,0.4)` (azul) global y `--action-ring` (sunset) solo en portal. El plan de migración Operations ya contempla `--focus-ring → --action-ring` global — hacerlo y verificar el 3:1.
- Combinar con **los 4 estados de componente explícitos** (hover/active/disabled/focus) tokenizados — Material 3 y HIG lo exigen.

Fuente: [W3C — New in 2.2 (primaria)](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/)

---

## 7. Motion

### 7.1 🟢 Material 3 migró a física de resortes (springs); cubic-bezier = legacy

**Estado del arte.** M3 declara que "el sistema de física **está reemplazando** al sistema previo de easing y duración" y que el sistema de easing/duración "ya no se mantiene... los productos deben migrar" (M3 Expressive, Google I/O Mayo 2025). En la **librería de implementación** (material-components-android) ambos coexisten sin lenguaje de deprecación todavía.

> 🔴 **Refutado — no usar:** la tabla de curvas easing específicas de M3 (`standard cubic-bezier(0.4,0,0.2,1)`, `emphasized`, etc.) como "los valores canónicos a adoptar". Murió 1-2 — esos valores son del sistema *legacy* que M3 está dejando atrás. No los copies como verdad permanente.

**Recomendación Mercado.**
- **Operations:** motion **funcional y mínimo**. No invertir fuerte en una librería de tokens cubic-bezier fijos como base permanente. El `--ease-standard: cubic-bezier(0.2,0,0,1)` actual está bien como default pragmático — solo no lo trates como "lo correcto para siempre".
- Adoptar **springs solo donde aporten feedback físico** (drag, reordenar, sheets) y mantener transiciones cortas/discretas en el resto (la doctrina "intencional, rápido, no decorativo" ya es correcta).

Fuentes: [M3 — easing & duration (primaria)](https://m3.material.io/styles/motion/easing-and-duration) · [M3 — how it works (primaria)](https://m3.material.io/styles/motion/overview/how-it-works)

### 7.2 🟢 `prefers-reduced-motion`: reducir/reemplazar, no eliminar

**Estado del arte.** La media feature tiene **dos valores**: `no-preference` (false) y `reduce` (true). El propósito es "remover, reducir **o reemplazar**" el movimiento no esencial — específicamente lo que dispara trastornos vestibulares (escalar/panear objetos grandes, parallax). El ejemplo canónico de MDN **reemplaza** un keyframe de escala por uno de **opacity** dentro del bloque `reduce`. **Reducido ≠ cero.**

**Recomendación Mercado.**
- Implementar `@media (prefers-reduced-motion: reduce)` **globalmente**, reemplazando transforms grandes (slides, scales, parallax) por **fades de opacity de baja amplitud**; preservar microinteracciones esenciales (feedback de tap, foco). Bajo riesgo, alto valor, ambos surfaces.
- **Lo que ya está bien:** el portal ya respeta `prefers-reduced-motion`. Extender el patrón a Operations y asegurar que sea *reemplazo*, no *eliminación total*.

Fuentes: [MDN prefers-reduced-motion (primaria)](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) · [WCAG técnica C39 (primaria)](https://www.w3.org/WAI/WCAG22/Techniques/css/C39)

---

## 8. Gobernanza y metodología de design systems

### 8.1 🟡 El patrón común de los equipos top

**Síntesis transversal (confianza media — no hubo un claim aislado de "gobernanza").** Los DS verificados (Material 3, Carbon, DTCG/Style Dictionary) convergen en:

1. Un **spec/formato normativo versionado** como contrato (DTCG con prefijo `$`).
2. **Capas raw → semántico → componente** vía aliasing.
3. **Dimensiones parametrizadas** (density en Carbon, motion en M3) en vez de valores hardcoded.
4. **Tooling** que compila el contrato a plataformas (Style Dictionary v4).

**Recomendación Mercado.**
- Documentar el sistema con esa estructura: **tokens versionados**, **changelog de tokens**, y **reglas de qué capa puede cambiar** (componentes consumen semánticos, nunca raw).
- Mantener el modelo Atomic Design que ya adoptaron (átomos = tokens, moléculas, organismos) y **terminar la capa de componentes compartidos** (el gap #1 que `DESIGN.md` ya identificó: ~4 variantes de card, ~5 de botón → extraer `ProductCard`, `Pill`, `Stepper`, `EmptyState`, `SearchBar`).

> ⚠️ **Caveat:** las prácticas específicas de **Atlassian, Shopify Polaris, Uber Base Web y Stripe** que pediste **NO** se verificaron con fuentes primarias en esta pasada (solo se confirmaron Material 3, Carbon y DTCG/Style Dictionary). Quedan como open question.

Fuentes: [Atlassian — contribution (primaria)](https://atlassian.design/contribution) · [Carbon — component checklist (primaria)](https://carbondesignsystem.com/contributing/component-checklist/) · [Polaris — components lifecycle (primaria)](https://polaris-react.shopify.com/getting-started/components-lifecycle)

---

## 9. Backlog accionable para Mercado (priorizado)

Derivado de los findings, ordenado por **payoff / esfuerzo**. Todo es **tokens-first** salvo donde se indica.

| # | Acción | Surface | Esfuerzo | Por qué |
|---|---|---|---|---|
| 1 | Auditar contraste con **APCA** los puntos críticos (sunset sobre fondos, dark espresso, texto muted). Mantener WCAG 2.x AA como gate legal. | Ambos | Bajo | El dark mode y los grises son donde WCAG 2.x miente; APCA revela legibilidad real. §1.1 |
| 2 | Migrar rampas `--stone-*` / `--brand-*` a **`oklch()`** con L escalonada; decidir flip de texto por L≈0.69 + validación APCA. | Ambos | Medio | Rampas perceptualmente parejas y auditables de un eje. §1.2 |
| 3 | Token de **focus-ring ≥2px / contraste ≥3:1** con `:focus-visible`; unificar `--focus-ring → --action-ring`. | Ambos | Bajo | Cumple SC 2.4.13; ya está en el plan de migración. §6.2 |
| 4 | `@media (prefers-reduced-motion: reduce)` **global**, reemplazando transforms por opacity. | Ambos | Bajo | A11y, bajo riesgo; falta extender a Operations. §7.2 |
| 5 | Tokenizar **densidad** (`--row-h` + spacing) con ≥2 niveles (compact++ / comfortable). | Operations | Medio | Valida la tesis de 2 surfaces con un eje real. §5.1 |
| 6 | Target size: **44px (AAA)** en flujos críticos Storefront; **excepción de spacing** (no inflar) en Operations denso. | Ambos | Bajo | SC 2.5.8 sin romper la densidad. §6.1 |
| 7 | Formalizar **3 capas de tokens** (raw→semántico→componente) + regla "componentes consumen semánticos". | Ambos | Medio | Gobernanza; abarata el rebranding. §4.2 |
| 8 | Terminar la **capa de componentes Atomic** (ProductCard, Pill, Stepper, EmptyState, SearchBar). | Ambos | Alto | Gap #1 ya identificado en `DESIGN.md`; resuelve consistencia. §8.1 |
| 9 | (Si entra Figma o crece el equipo) pipeline **Style Dictionary v4** con light/dark/density como dimensiones. | Infra | Alto | Una fuente DTCG → todas las plataformas. §4.1 |

---

## 10. Caveats globales (leer antes de actuar)

1. **APCA no es normativo.** Es un método autopublicado; su uniformidad perceptual es aserción del modelo, no certificada par-por-par. WCAG 3 (donde APCA es candidato) no llega antes de ~2028-2030 y su método de contraste sigue "por determinarse". → **APCA para diseñar, WCAG 2.x AA como gate legal.** Ignorar WCAG 2.x = riesgo de litigio.
2. **OKLCH no está sobre-vendido aquí:** úsalo para *generar* rampas, no como métrica de contraste final (claim de "máxima uniformidad perceptual" fue refutado; la luminancia Y es marginalmente mejor para el flip exacto).
3. **Carbon v10 archivado:** el dato de "4 alturas de fila" es v10; v11 usa 5. "Tokenizable" fue inferencia.
4. **Parte de color se apoya en blog de autoridad** (Lea Verou, CSS WG) + material de advocacy de APCA — alta calidad pero no spec normativo. La cifra "~azar en mid-tones" viene de ahí.
5. **Claims refutados (no usar):** tipos fijos DTCG con fallback a inválido · curvas easing específicas de M3 como canónicas · "tall solo multilínea / compact siempre default" · "OKLCH = espacio más uniforme".

---

## 11. Preguntas abiertas (lo que esta investigación NO cerró)

Candidatas a una **segunda pasada de `/deep-research`** — son temas que pediste y no produjeron fuente primaria:

1. **Spacing / grid systems** (base-4/8, 8pt grid, columnas, gutters) — tema central, **cero claims verificados**. ⚪ Es el hueco #1.
2. **Escala tipográfica concreta** (ratio modular, measure, line-height, tracking por tamaño, parametrizar `tabular-nums`) para el pairing Fraunces + Hanken Grotesk. ⚪
3. **Gobernanza con fuente primaria de Atlassian / Polaris / Base Web / Stripe** (solo se confirmaron M3, Carbon, DTCG). ⚪
4. **Tabla de tokens de motion vigente de M3 Expressive** (springs) tras la migración — el sistema nuevo, no el legacy refutado. ⚪
5. **Métrica unificada para el flip de texto + calibración de la rampa Stone**: ¿APCA/Lc como check primario + OKLCH para generar, o incorporar luminancia Y para el flip exacto? Falta una recomendación primaria unificada. ⚪

---

## 12. Fuentes (por calidad)

**Primarias (spec / docs oficiales):**
- W3C — [Why APCA](https://git.apcacontrast.com/documentation/WhyAPCA.html) · [SC 2.5.8 Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) · [New in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/) · [Técnica C39 (reduced motion)](https://www.w3.org/WAI/WCAG22/Techniques/css/C39)
- [DTCG Format Module 2025.10](https://www.designtokens.org/tr/drafts/format/) · [Style Dictionary DTCG](https://styledictionary.com/info/dtcg/)
- MDN — [font-optical-sizing](https://developer.mozilla.org/en-US/docs/Web/CSS/font-optical-sizing) · [prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) · [OpenType opsz](https://learn.microsoft.com/en-us/typography/opentype/spec/dvaraxistag_opsz)
- M3 — [easing & duration](https://m3.material.io/styles/motion/easing-and-duration) · [motion how-it-works](https://m3.material.io/styles/motion/overview/how-it-works)
- [Carbon v10 data-table](https://v10.carbondesignsystem.com/components/data-table/usage/) · [Carbon component checklist](https://carbondesignsystem.com/contributing/component-checklist/) · [Atlassian contribution](https://atlassian.design/contribution) · [Polaris lifecycle](https://polaris-react.shopify.com/getting-started/components-lifecycle)

**Autoridad / secundarias:**
- [Lea Verou — contrast-color](https://lea.verou.me/blog/2024/contrast-color/) · [Evil Martians — OKLCH](https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl) · [Pixel Ambacht — optical size](https://pixelambacht.nl/2021/optical-size-hidden-superpower/)
- [DesignSystems.com — space/grids/layouts](https://www.designsystems.com/space-grids-and-layouts/) · [Cieden — type scales](https://cieden.com/book/sub-atomic/typography/different-type-scale-types) · [Pencil & Paper — data tables](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables) · [Stephanie Walter — data tables](https://stephaniewalter.design/blog/essential-resources-design-complex-data-tables/)
