# Tendencias de diseño frontend 2026 — investigación y guía aplicada

> **Qué es:** investigación de las tendencias reales de diseño web/UI 2026 (tipografía, color, espaciado/márgenes, layout, UX/UI, motion, accesibilidad) con las mejores webs de referencia, **mapeada a nuestro contexto**: portal B2B mayorista + dashboards de operaciones ("Mercado").
> **Relación con los otros docs:**
> - [`DESIGN.md`](../DESIGN.md) = sistema operativo (tokens, reglas, 2 surfaces). **Manda.**
> - [`docs/DESIGN_FOUNDATIONS.md`](DESIGN_FOUNDATIONS.md) = base teórica con citas (OKLCH/APCA, opsz, WCAG 2.2, motion).
> - [`docs/IMPLEMENTACION/DESIGN_QA_MODULOS.md`](IMPLEMENTACION/DESIGN_QA_MODULOS.md) = tracker del barrido módulo por módulo.
> - **Este archivo** = el *qué hay afuera* y *hacia dónde va el campo*. Investigación, no normativa.
> **Fecha:** 2026-06-09. Las tendencias caducan — revalidar en ~6 meses.

---

## TL;DR — las 12 tendencias que importan para Mega Dulces

| # | Tendencia 2026 | Nuestro veredicto |
|---|---|---|
| 1 | **Calm UI / "Barely-There"** en SaaS y AI (claridad cognitiva > riqueza sensorial) | ✅ Es la tesis de Operations. Mantener. |
| 2 | **IA ambiental** (copiloto presente-opcional, no un botón) + explicabilidad "¿por qué veo esto?" | 🎯 Adoptar al sumar IA; identidad **ember** ya lista. |
| 3 | **8pt grid + regla internal ≤ external** como estándar de spacing | ✅ Formalizar; corrige bugs de ritmo (ya visto en order-detail). |
| 4 | **Densidad de interacción, no de píxeles** (Linear/Stripe/Vercel: visualmente espaciados, densos en comportamiento) | 🎯 Matiz: tablas compact++, pero más aire entre bloques. |
| 5 | **Variable fonts como infraestructura** (1 archivo, eje `opsz`) | 🎯 Backlog perf: servir Fraunces/Hanken variable. |
| 6 | **Mono para datos/cifras** (reduce errores en datos sensibles) | ✅ Ya: Geist Mono + `tabular-nums`. |
| 7 | **OKLCH** para tokens de color (punto de inflexión 2026: Linear, Stripe, Slack) | 🎯 Backlog: migrar rampas a OKLCH (luminance-first). |
| 8 | **Neutrales cálidos** (vs zinc frío) + **dark no-negro** | ✅ Ya: rampa Stone + espresso. |
| 9 | **Acento IA propio** (matar el morado genérico) | ✅ Ya: ember ámbar→sunset. |
| 10 | **Bento grids + master-detail + progressive disclosure** | ✅ En uso (Command Center bento, Pedidos master-detail). |
| 11 | **WCAG 2.2** (target 24px AA, Focus Not Obscured, Focus Appearance) → ISO 40500:2025 | 🎯 Subir el piso de a11y; aclarar 24px vs 44px. |
| 12 | **Catálogo "agent-legible"** (procurement delegando a agentes IA) | 🔭 Forward-looking; semántica + datos estructurados. |

---

## 1. Macro-dirección 2026: dos corrientes opuestas

El campo se parte en dos, y **elegir bien según surface es la decisión de diseño más importante de 2026**:

- **Maximalismo expresivo** ("dopamine design"): color saturado, gradientes neón, **tipografía cinética** (texto que se anima/responde al scroll), **bento grids**, "broken grids" / desbalance controlado, Y2K nostálgico, glassmorphism, 3D sutil. Para lifestyle, beauty, marcas jóvenes.
- **Calm UI / "Barely-There"**: minimalismo por restricción — layouts limpios, paleta limitada, tipografía simple. Señala *confianza, estabilidad, inteligencia*. Domina **SaaS y productos de IA**.

> La regla 2026 no es "elegir una", es **ser selectivo**: un titular gigante en vez de diez elementos compitiendo; un acento de color fuerte en vez de un arcoíris.

**Mapa a Mercado:**
- **Operations** (`/dashboard`, `/comercial`, `/logistica`, ...) = **Calm UI** puro. Claridad cognitiva sobre riqueza sensorial. Esto valida nuestra tesis "esto es serio".
- **Storefront** (`/portal`) = Calm UI de base **+ momentos expresivos selectivos** (hero, promos): ahí sí cabe tipografía grande/Fraunces, ilustración, un bento llamativo. Nunca en el catálogo/carrito (esos son tool-mode).

[Figma: Web Design Trends 2026](https://www.figma.com/resource-library/web-design-trends/) · [Envato: calm interfaces, transparent AI](https://elements.envato.com/learn/ux-ui-design-trends)

---

## 2. Espaciado y márgenes (a fondo — lo más pedido)

### 2.1 La base: 8pt grid + escala 4px

El **8-point grid** es el estándar de oro: todo (padding, gutters, alturas, gaps) en múltiplos de 8 (8/16/24/32/40/48/56/64). Razón técnica: la mayoría de resoluciones son divisibles por 8 → renderiza nítido en pantallas estándar y Retina sin artefactos de anti-aliasing. Para control fino se baja a **incrementos de 4** (4/8/12/16).

**Mercado ya define** (DESIGN.md): `2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64)`. ✅ Alineado.
**Hallazgo del barrido:** valores como `.4rem` (6.4px) o `.35rem` (5.6px) **rompen la grid** — no son múltiplos de 4. Regla: todo spacing cae en la escala, sin excepciones "a ojo".

### 2.2 Regla de oro: **internal ≤ external** (Gestalt de proximidad)

> El padding (espacio interno) **nunca debe exceder** el margen (espacio externo).

Por qué: elementos cercanos se perciben *agrupados*; lejanos, *separados*. Si una card tiene más padding interno que separación con sus vecinas, el ojo no distingue dónde termina una y empieza otra. Es la regla que **garantiza jerarquía sin bordes ni líneas**.

### 2.3 Ritmo vertical entre secciones

El error más común (y el que encontramos en `order-detail`): **mezclar `margin-top` + `margin-bottom` ad-hoc** produce gaps dobles (40px) o de cero (cards pegadas) según qué bloques condicionales se rendericen.
**Patrón correcto:** un único ritmo (p. ej. 20–24px), aplicado **solo con `margin-bottom`** (o `gap` en un contenedor flex/grid). Nunca top+bottom combinados entre hermanos.

### 2.4 Números concretos de la industria

| Medida | Valor de referencia | Nota |
|---|---|---|
| **Gutter** (entre columnas) | 24px (1.5rem) | grilla 12-col estándar |
| **Márgenes laterales desktop** | ~60px / lado | en contenedor centrado |
| **Artboard desktop** | 1440px | base de diseño común |
| **Max-width de texto (measure)** | **45–75 caracteres, óptimo ~66ch** | legibilidad; ≈ 640–720px |
| **Max-width de contenido app** | 1180–1280px (tool), hasta 1440 (dashboards) | el nuestro: 1180–1280 (DESIGN.md) |
| **Line-height** | múltiplos de 4/8 (16/20/24) | ritmo vertical |
| **Alto de fila de tabla densa** | 40px desktop / 56px touch | compact++ Operations |

### 2.5 Densidad: "interaction-dense, not pixel-dense"

El insight clave de Linear/Stripe/Vercel: **son visualmente espaciados (sparse) pero densos en interacción**. El error de los SaaS genéricos es confundir "amontonar datos" con "premium". La densidad va en el *comportamiento* (atajos, acciones inline, velocidad), no en pegar todo.

**Matiz para Mercado:** la **tabla** sí es compact++ (es donde el supervisor escanea cifras). Pero **entre bloques/secciones** conviene más aire del que parece necesario — eso es lo que da el "feel premium". No es contradicción: denso *dentro* de la tabla, generoso *entre* organismos.

[Cieden: spacing best practices](https://cieden.com/book/sub-atomic/spacing/spacing-best-practices) · [Designsystems.com: space, grids & layouts](https://www.designsystems.com/space-grids-and-layouts/) · [Pixeldarts: Stripe/Linear/Vercel principles](https://www.pixeldarts.com/en/post/four-design-principles-behind-stripe-linear-and-vercel)

---

## 3. Tipografía 2026

- **Variable fonts = infraestructura, no opcional.** Un archivo variable (~100–200KB) reemplaza 4 estáticos (400–800KB) → mejora Core Web Vitals y mobile. Ejes continuos (peso, ancho, óptico) manipulables en runtime.
- **Optical sizing (`opsz`):** la fuente ajusta grosor de trazo y espaciado según el tamaño (12pt body vs 48pt headline) automáticamente. **Fraunces ya lo usa** (DESIGN.md: "opsz auto"). ✅
- **Mono para datos:** para cifras financieras, historiales, SKUs, números de cuenta — el contraste claro entre números y letras **reduce errores** en UI sensible a datos. **Ya: Geist Mono + `tabular-nums`** obligatorio en dinero/cantidad. ✅ (y lo acabamos de extender a `comm-num`, `cell-value`).
- **Tensión de pares tipográficos:** grotesca + serif, o display serif + mono — se siente "considerado" en vez de default. **Nuestro trío Fraunces + Hanken Grotesk + Geist Mono** es exactamente esta jugada.
- **Headlines expresivos / tipografía cinética:** grande, animada, letter-by-letter, responde al scroll. **Solo storefront** (hero/promos). Prohibido en Operations.
- **Escala y line-height** en múltiplos de 4/8.
- **Anti-default:** Inter es "el default de me-rendí" al que todo converge (lo usa Linear, válido, pero genérico). Nuestro Hanken Grotesk evita esa convergencia manteniendo neutralidad.

**Backlog:** evaluar servir Hanken/Fraunces como **variable font** (hoy cargamos pesos discretos desde Google Fonts) para perf.

[Kittl: variable fonts winning 2026](https://www.kittl.com/blogs/why-variable-fonts-are-winning-fnt/) · [DesignMonks: typography trends 2026](https://www.designmonks.co/blog/typography-trends-2026)

---

## 4. Color 2026

- **OKLCH es el punto de inflexión.** Devs migrando de hex a OKLCH; tokens basados en LCH usados por **Linear, Slack, Stripe, Zapier**. Ventaja: **luminance-first** → rampas estables y contraste accesible across light/dark sin sacrificar vibrancia. Update enero 2026: en dark se **reduce el chroma progresivamente** en tonos oscuros para evitar artefactos/clipping (sobre todo en cálidos).
- **Reglas de token OKLCH:** texto con `L < 0.30` en light y `L > 0.80` en dark; colores de outline con `chroma 0.01–0.03` para evitar "halos" de color en UIs neutras.
- **Neutrales cálidos** (earthy, grounded, humanos) como contra-tendencia al zinc frío SaaS. **Ya: rampa Stone.** ✅
- **Dark mode ≠ negro puro.** Espresso/cálido conserva la marca. **Ya: `#16130F`.** ✅
- **Acento IA con identidad propia** — matar el morado genérico de la industria. **Ya: ember (ámbar→sunset) + sello ✦.** ✅
- **APCA** (candidato WCAG 3.0): modelo perceptual mejor alineado a la visión humana, sobre todo en bajo contraste y pantallas modernas. **WCAG 2.2 AA sigue siendo el piso legal.**

**Backlog:** migrar las rampas `tokens.css` a OKLCH (hoy hex). Es lift moderado y *future-proof*; permite generar dark/variantes con luminancia consistente.

[BoldVanta: luminance-first OKLCH tokens](https://www.boldvanta.com/design/designing-luminance-cefirst-color-systems-with-oklch-tokens-ramps-and-real-ceworld-pitfalls.html) · [LogRocket: OKLCH accessible palettes](https://blog.logrocket.com/oklch-css-consistent-accessible-color-palettes) · [Dopely: OKLCH vs hex](https://dopelycolors.com/blog/oklch-vs-lch-why-modern-web-developers-are-moving-away-from-hex-codes)

---

## 5. Layout & composición

- **Bento grids** (cards modulares de distinto tamaño) — para dashboards y home storefront. **Ya: Command Center.**
- **Broken / asymmetric grids, "controlled imbalance"** — desbalance intencional que se siente estable. **Solo momentos storefront.**
- **Master-detail** como organismo primario en data apps. **Ya: Pedidos, Rutas.**
- **Dashboards por zonas / layered layout** + **progressive disclosure** (esconder lo avanzado hasta que se necesita). Mejora mantenibilidad y carga cognitiva.
- **Layouts adaptativos por rol/contexto:** un gerente comercial y un operador de logística ven *defaults distintos* del mismo dato. 🔭 Relevante para nuestros múltiples roles.
- **Command palette (⌘K)** y búsqueda sticky — velocidad keyboard-first. DESIGN.md ya lo pide en portal.
- **B2B mobile:** reorder de un toque, búsqueda predictiva, layouts swipe-friendly como estándar.

[UXPin: 12 trends product design 2026](https://www.uxpin.com/studio/blog/ui-ux-design-trends/) · [GitNexa: SaaS dashboard UX patterns 2026](https://www.gitnexa.com/blogs/saas-dashboard-ux-patterns)

---

## 6. UX/UI 2026 — patrones (B2B + dashboards)

### 6.1 IA ambiental (la tendencia #1 transversal)
- De "IA como autopilot omnisciente" → **"IA como copiloto: presente, opcional, respetuoso del contexto humano".** "La IA no vivirá detrás de un botón; vivirá *dentro* de la UI" como capa ambiental, invisible hasta que se necesita.
- **Lenguaje natural sobre flujos complejos:** consultar dashboards de analytics, configurar settings, gestionar pedidos *por conversación* — no solo FAQ.
- **Capa de explicación:** "¿por qué estoy viendo esto?" incorporado en la interfaz (transparencia de IA). Genera confianza.
- **Mapa:** cuando sumemos scoring/anomalías/match (Fase K+), la IA va con identidad **ember** y un "¿por qué?" en recomendaciones.

### 6.2 Esenciales B2B (no negociables 2026)
Pricing por cliente · **bulk ordering** · **quick reorder** (un toque) · info de producto detallada e **inline** · self-service portal · **búsqueda avanzada/predictiva** · **Punchout** (cXML/OCI/EDI) para que un comprador en Coupa/SAP Ariba lance al catálogo y devuelva el carrito a su sistema de aprobación sin re-teclear. 🔭 (Punchout = enterprise; futuro lejano para nosotros, pero define el techo del mercado).

### 6.3 La lección McMaster-Carr
El sitio está **"diseñado para eliminar cada milisegundo de fricción entre 'necesito esta parte' y 'envíenla hoy'"**: filtrado instantáneo, búsqueda inteligente, info de producto que **carga inline** (sin cambiar de página), claridad de especificaciones. **Es nuestra estrella polar para el catálogo y la toma de pedidos.**

### 6.4 Catálogo "agent-legible" (forward-looking 2026)
Criterio emergente: **¿el portal es legible para un comprador automatizado?** El procurement empieza a delegar descubrimiento y pedido rutinario a **agentes IA**; los catálogos que solo los humanos pueden leer se vuelven invisibles al gasto automatizado. 🔭 Implica semántica HTML limpia + datos estructurados.

### 6.5 Carga / perceived performance
Skeletons (no spinners de bloque), **optimistic UI**, progressive disclosure. Carga percibida > carga real. (Ya lo aplicamos en el barrido: skeletons por-sección, mata-CLS).

[Orizon: 10 UI/UX trends 2026](https://www.orizon.co/blog/10-ui-ux-trends-that-will-shape-2026) · [WizCommerce: B2B ecommerce UX 2026](https://wizcommerce.com/blog/b2b-ecommerce-example/) · [McMaster-Carr](https://www.mcmaster.com/) · [Onething: B2B SaaS UX 2026](https://www.onething.design/post/b2b-saas-ux-design)

---

## 7. Motion 2026

- **Motion disciplinado = feedback del sistema**, no decoración. "El fin de los teatrales visuales".
- **Tipografía cinética** como excepción expresiva (storefront).
- **Ética de `prefers-reduced-motion`:** respetar siempre. (Ya en tokens/portal.)
- Tokens de easing/duración (DESIGN.md: `--ease-standard`, micro 50–120ms / short 150–250ms / medium 250–400ms). El barrido encontró transiciones con `cubic-bezier` Material en vez del token — normalizar.

---

## 8. Accesibilidad 2026 — WCAG 2.2 (ahora ISO/IEC 40500:2025)

9 criterios nuevos. Los que más nos tocan:

- **2.5.8 Target Size (Minimum) — AA:** objetivos interactivos **≥ 24×24 CSS px**, *o* con espaciado suficiente entre ellos. ⚠️ **Aclaración importante:** los 24px son el **piso legal AA**; los **44×44px** que cita DESIGN.md son la **best-practice de iOS HIG / zona del pulgar** (más estricto). Regla nuestra: **24px mínimo absoluto, 44px objetivo en mobile**.
- **2.4.11 / 2.4.12 Focus Not Obscured (Min/Enhanced):** el elemento con foco no debe quedar tapado por contenido propio (headers sticky, etc.).
- **2.4.13 Focus Appearance:** el indicador de foco debe ser suficientemente grande/contrastado.
- Otros: Dragging Movements (alternativa a arrastrar), Consistent Help, Redundant Entry, Accessible Authentication.
- **APCA** (WCAG 3 candidato) para contraste perceptual — adoptar como *target* opcional además de AA.

> Deadline regulatorio: la DOJ (abril 2026) exige **WCAG 2.1 AA**; 2.2 es el estándar W3C vigente desde oct-2025. Apuntar a 2.2 AA.

[W3C: Understanding 2.5.8 Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) · [TestParty: WCAG 2.2 new SC](https://testparty.ai/blog/wcag-22-new-success-criteria)

---

## 9. Lookbook — referencias best-in-class (educar el ojo antes de diseñar)

| Referencia | Qué robar | Surface aplicable |
|---|---|---|
| **Linear** | Calm UI, monocromo + 1 acento, densidad de interacción, atajos | Operations |
| **Vercel / Geist** | Sistema de tokens, mono-influenced sans, B/N + acento mínimo, "serio sistemático" | Operations |
| **Stripe** | Whitespace inteligente, alto contraste, Söhne grotesca, docs/dashboard premium | Ambos |
| **McMaster-Carr** | Cero fricción, filtrado instantáneo, info inline, velocidad utilitaria | Storefront catálogo/pedido |
| **Uline** | B2B utilitario denso, reorder rápido | Storefront |
| **Faire** | Editorial cálido, momentos de marca en wholesale | Storefront home/promos |
| **Shopify Polaris / IBM Carbon / Atlassian ADS** | Patrones de data-table, forms, tokens, a11y madura | Operations (referencia de componentes) |
| **Mobbin / PageFlows** | Flujos reales (login, checkout, alta de pedido) capturados paso a paso | Antes de diseñar un flujo nuevo |
| **Base Web (Uber)** | Estructura de componentes (átomos→organismos) | Capa atómica |

[ecomm.design: best B2B ecommerce examples](https://ecomm.design/best-b2b-ecommerce-website-examples/) · [Geist (Vercel)](https://vercel.com/geist/introduction) · [Mantlr: how Stripe/Linear/Vercel ship premium UI](https://mantlr.com/blog/stripe-linear-vercel-premium-ui)

---

## 10. Mapa a Mega Dulces — qué hacer

### ✅ Ya estamos alineados (mantener)
- Calm UI en Operations · neutrales cálidos (Stone) · dark espresso · acento IA ember (no morado) · mono+tabular en cifras · trío tipográfico con tensión · bento + master-detail · skeletons · `prefers-reduced-motion`.

### 🎯 Adoptar (backlog priorizado)
1. **Formalizar 8pt grid + regla internal ≤ external** como check de QA (ya reforzado en D4 del tracker). Barrer off-grid en todos los módulos.
2. **Ritmo vertical único por pantalla** (solo `margin-bottom`/`gap`, nunca top+bottom ad-hoc).
3. **Subir piso a11y a WCAG 2.2:** 24px mínimo / 44px objetivo mobile; Focus Not Obscured con headers sticky; focus-visible con `--action-ring`.
4. **Migrar rampas de color a OKLCH** (luminance-first) en `tokens.css` — habilita dark/variantes consistentes.
5. **Variable fonts** para Hanken/Fraunces (perf, Core Web Vitals).
6. **Normalizar motion** a tokens `--ease-standard` + duraciones.
7. **IA ambiental + explicabilidad** ("¿por qué veo esto?") cuando llegue scoring/recos en Operations.

### ❌ Evitar (anti-tendencia para nosotros)
- Tipografía cinética / broken grids / glassmorphism / 3D / dopamine color **en Operations** (rompe "esto es serio").
- Fraunces fuera de storefront.
- Morado/azul para IA.
- Confundir "amontonar datos" con premium.
- Negro puro en dark.

### 🔭 Radar (no ahora, pero viene)
- **Catálogo agent-legible** (procurement con agentes IA): semántica + structured data.
- **Layouts adaptativos por rol.**
- **NL queries sobre dashboards** (preguntar al Command Center en lenguaje natural).
- **Punchout** (cXML/OCI/EDI) si aparecen clientes enterprise.

---

## Fuentes

**Tendencias generales / UI:**
- [Figma — Top Web Design Trends 2026](https://www.figma.com/resource-library/web-design-trends/)
- [Envato — UX/UI trends: calm interfaces, transparent AI](https://elements.envato.com/learn/ux-ui-design-trends)
- [UXPin — 12 UX/UI trends reshaping product design 2026](https://www.uxpin.com/studio/blog/ui-ux-design-trends/)
- [Orizon — 10 UI/UX trends 2026](https://www.orizon.co/blog/10-ui-ux-trends-that-will-shape-2026)

**Espaciado / layout:**
- [Cieden — Spacing best practices (8pt, internal≤external)](https://cieden.com/book/sub-atomic/spacing/spacing-best-practices)
- [Designsystems.com — Space, grids and layouts](https://www.designsystems.com/space-grids-and-layouts/)
- [GitNexa — SaaS Dashboard UX Patterns 2026](https://www.gitnexa.com/blogs/saas-dashboard-ux-patterns)
- [Pixeldarts — Principles behind Stripe/Linear/Vercel](https://www.pixeldarts.com/en/post/four-design-principles-behind-stripe-linear-and-vercel)

**Tipografía:**
- [Kittl — Why variable fonts are winning 2026](https://www.kittl.com/blogs/why-variable-fonts-are-winning-fnt/)
- [DesignMonks — Typography trends 2026](https://www.designmonks.co/blog/typography-trends-2026)

**Color / OKLCH / contraste:**
- [BoldVanta — Luminance-first OKLCH tokens](https://www.boldvanta.com/design/designing-luminance-cefirst-color-systems-with-oklch-tokens-ramps-and-real-ceworld-pitfalls.html)
- [LogRocket — OKLCH accessible palettes](https://blog.logrocket.com/oklch-css-consistent-accessible-color-palettes)
- [Dopely — OKLCH vs hex](https://dopelycolors.com/blog/oklch-vs-lch-why-modern-web-developers-are-moving-away-from-hex-codes)

**B2B / ecommerce:**
- [WizCommerce — B2B ecommerce examples 2026](https://wizcommerce.com/blog/b2b-ecommerce-example/)
- [ecomm.design — Best B2B ecommerce examples](https://ecomm.design/best-b2b-ecommerce-website-examples/)
- [Onething — B2B SaaS UX 2026](https://www.onething.design/post/b2b-saas-ux-design)
- [McMaster-Carr](https://www.mcmaster.com/)

**Design systems de referencia:**
- [Geist (Vercel)](https://vercel.com/geist/introduction)
- [Mantlr — How Stripe/Linear/Vercel ship premium UI](https://mantlr.com/blog/stripe-linear-vercel-premium-ui)

**Accesibilidad:**
- [W3C — Understanding SC 2.5.8 Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [TestParty — WCAG 2.2 new success criteria](https://testparty.ai/blog/wcag-22-new-success-criteria)
