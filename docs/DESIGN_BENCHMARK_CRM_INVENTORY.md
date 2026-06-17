# Benchmark de diseño — CRM + Inventario (clase mundial → Mercado)

> **Qué es:** investigación de las decisiones front-end / UX-UI de los mejores CRM y gestores de inventario, con **números concretos y fuente citada**, mapeada a nuestras dos surfaces (Operations + Storefront) y a lo que **ya tenemos fabricado**.
> **Para qué:** elevar `DESIGN.md` a nivel clase mundial y usarlo como norma en toda actualización de interfaces.
> **Relación con los otros docs:**
> - [`DESIGN.md`](../DESIGN.md) = sistema operativo normativo. **Manda.** Las reglas canónicas de aquí ya están integradas allá.
> - [`DESIGN_TENDENCIAS_2026.md`](DESIGN_TENDENCIAS_2026.md) = macro-tendencias del campo.
> - **Este archivo** = el *cómo lo hacen los líderes de CRM/inventario*, con la mira en datos densos.
> **Fecha:** 2026-06-16. Referencias load-bearing: Linear, Attio, Carbon (IBM), Polaris (Shopify), Stripe.

---

## TL;DR — las 15 decisiones a adoptar (ranking impacto/esfuerzo)

| # | Decisión canónica | Impacto/Esfuerzo | Fuente | Estado nuestro |
|---|---|---|---|---|
| 1 | **Optimistic UI en toda mutación de 1 registro** (cambio de estado, asignar, edición inline, ajuste de qty): mutar estado local sync → reconciliar con server → rollback en error. Mata spinners. | 🔴 Alto / Medio | Linear | ⬜ adoptar |
| 2 | **Altura de fila tokenizada en 3 tiers: compact 32 / default 40 / relaxed 48px**, con toggle de densidad por usuario (default 40). | 🔴 Alto / Bajo | Carbon | 🟡 tokens ya existen (`--row-h-*`), falta toggle |
| 3 | **Regla de superficie/elevación:** in-page (cards, filas, paneles) = **borde 1px hairline, sin sombra**; solo overlays (menú, popover, modal, ⌘K, toast) = **sombra + borde**. | 🔴 Alto / Bajo | Attio/Linear | ⬜ codificar 2 tokens de elevación |
| 4 | **Skeletons con forma de contenido (shimmer), no spinners** — shell a nivel ruta + filas skeleton a nivel data. Spinner solo <300ms inline. | 🔴 Alto / Medio | Stripe/Linear | 🟡 parcial (logística ya usa shimmer) |
| 5 | **Command palette ⌘K / Ctrl+K** (modal 560–640px, fuzzy, navegar **+ actuar**, solo-teclado, resultados virtualizados). | 🔴 Alto / Alto | Linear/Raycast | ⬜ no existe |
| 6 | **Side-peek drawer (~520px, slide-in 250ms)** para ver/editar un registro desde la fila sin perder la lista; full page solo para create/edit complejo. | 🔴 Alto / Medio | Attio | ⬜ adoptar como organismo |
| 7 | **Techos de motion: 150ms micro / 250ms standard / 350ms máx, ease-out**; animar solo `transform`+`opacity`; honrar `prefers-reduced-motion`. | 🟡 Medio / Bajo | Linear | 🟡 tokens de easing ok, falta techo duro |
| 8 | **`tabular-nums` en TODA celda numérica/dinero/qty/fecha** (Geist Mono y también números inline en Hanken). | 🟡 Medio / Bajo | Attio/Stripe | ✅ casi: extender a Hanken inline |
| 9 | **Escala tipográfica de tabla fija:** header 12–13px/600/+0.02em muted; valor 13–14px/450; meta 12px muted; line-height 1.25–1.35. | 🟡 Medio / Bajo | Attio/Carbon | 🟡 tokens Operations existen, alinear números |
| 10 | **Tokens de estado de inventario con escalada gradual:** in-stock verde / low-stock ámbar / out-of-stock rojo / overstock azul; umbral low→crítico mueve ámbar→rojo. | 🟡 Medio / Bajo | convención inventario | ⬜ falta el set inventario |
| 11 | **Tokens de estado CRM/pipeline:** new=slate/azul, qualified=ámbar, won=verde, lost=rosa/rojo, on-hold=gris. | 🟡 Medio / Bajo | convención CRM | 🟡 mapear a semánticos existentes |
| 12 | **Header sticky + primera columna congelada (entidad/SKU)** en toda grid ancha. | 🟡 Medio / Medio | Attio/Airtable | ⬜ adoptar |
| 13 | **Barra de acciones masivas** que sube (200ms) al seleccionar ≥1 fila (conteo + ops batch); hover de fila revela acciones ghost a la derecha. | 🟡 Medio / Medio | Attio/Linear | ⬜ adoptar |
| 14 | **Pase de a11y de foco/target:** anillo de foco **2px ≥3:1 contraste** en todo interactivo; icon-button con hit area ≥24px. | 🟡 Medio / Bajo | WCAG 2.2 (2.4.13 / 2.5.8) | 🟡 focus-ring ok, auditar targets |
| 15 | **Rampas neutral+acción+estado en OKLCH;** en dark reducir chroma ~15% y usar near-black (#111, no #000). | 🟡 Medio / Medio | OKLCH/Linear/Attio | 🟡 dark ya #111 ops, falta migrar rampas a OKLCH |

---

## 1. Carga de pantalla / performance percibida

- **[Linear]** Optimistic UI en todo: muta el store en memoria sync, encola la transacción de red. **Elimina spinners**; la UI nunca espera al server. Acciones sub-50ms vs 800–3000ms de Jira.
- **[Linear]** Local-first: hidrata IndexedDB al arranque; el costo de arranque depende de la *estructura* del workspace, no del *tamaño*. Tablas pesadas lazy-loaded por chunks, no fetch por ruta.
- **[Linear]** Code-split en cientos de chunks por ruta + `modulepreload` en deps críticas + service worker cachea el resto. La migración de bundler dio **−59% time-to-first-paint**.
- **[Linear]** Re-renders granulares: 1 cambio de campo = exactamente 1 componente re-renderiza (observables por-propiedad), no reflow de lista.
- **[Stripe/Linear/Notion]** Skeletons con forma de contenido + shimmer, no spinners. Skeletons miden **~20% más rápido percibido** para la misma espera. Spinner solo para <300ms indeterminado o bloqueo full-page.
- **[Industria]** Optimistic UI mejora **INP** directamente (desacopla feedback de la red). Targets Core Web Vitals: **LCP < 2.5s, INP < 200ms**.
- **Regla:** skeleton a **nivel ruta** para el shell, **skeleton de filas** para el body de tabla, **optimistic** para toda mutación de un registro (editar, cambiar estado, asignar, ajustar stock).

Fuentes: [performance.dev/how-is-linear-so-fast](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown) · [LogRocket skeletons](https://blog.logrocket.com/ux-design/skeleton-loading-screen-design/) · [Simon Hearne optimistic](https://simonhearne.com/2021/optimistic-ui-patterns/)

## 2. Espaciado y grid

- **[Polaris]** Unidad base **4px** (`space-100=4`, `space-400=16`). Admin completo en grid de 4px; muchos componentes en incrementos de **20px** para casar con line-height del body.
- **[Carbon]** Base 8px (2x grid) con mini-unidad **2px**: `2 / 4 / 8 / 12 / 16 / 24 / 32 / 40 / 48 / 64 / 80 / 96 / 160px`.
- **Card padding:** Stripe = **24px** en KPI cards; **16px** en list cards densas.
- **Section gaps:** 24–32px entre bloques bento; 16px dentro de un bloque.
- **Max-width data apps:** las tablas van **full-bleed** (sin max-width — que las columnas usen el viewport); solo columnas de *lectura/form* llevan max-width (~640–720px form, ~800px panel detalle).
- **internal ≤ external (invariante):** el padding interno de un grupo ≤ el gap que lo separa de vecinos, para que el agrupamiento lea bien.

Fuentes: [Polaris Spacing](https://legacy.polaris.shopify.com/design/spacing) · [Carbon Spacing](https://carbondesignsystem.com/elements/spacing/overview/)

## 3. Bordes, radios, elevación

- **[Attio]** Separación por **bordes 1px, no sombras** — look "tallado/preciso". Tablas densas = 1px + headers de alto contraste. Borde light `#ebecf0` / dark `#1c2536`.
- **[Linear]** Plano: solo anima `transform/opacity/background-color`; la estructura la cargan los bordes hairline. Sombras reservadas a capas que *flotan de verdad* (popover, ⌘K, dropdown).
- **[Attio]** Radios: **default 6px, medio 8px, grande 12px.** Inputs/chips ≈ 6–8px; cards ≈ 8–12px.
- **[Stripe]** Cards: radio **8–12px** consistente, 24px padding, y **borde *o* sombra** (uno por superficie, no ambos).
- **Decisión:** **superficies in-page (cards, filas, paneles) = borde 1px hairline, sin sombra. Overlays (menú, popover, modal, ⌘K, toast) = sombra + borde.** Patrón dominante Linear/Attio/Stripe.

Fuentes: [Attio DESIGN.md](https://explainx.ai/designs/whyashthakker-design-md-templates-skills/attio/design-md) · [SaaSFrame Stripe](https://www.saasframe.io/examples/stripe-payments-dashboard)

## 4. Tipografía (tablas de datos)

- **[Attio]** Body **14px / lh 1.5**; headings **600 / -0.01em**.
- **Convención de tabla (Carbon/Attio/Stripe):**
  - Header de columna: **12–13px / 600 / muted**, letter-spacing +0.02em.
  - Valor de celda: **13–14px / 400–450 / color primario**.
  - Meta secundaria: **12px / muted**.
  - Page/section head: bold ~20–24px.
- **Tabular figures obligatorio** en toda columna numérica/dinero/qty/fecha. Geist Mono ya; aplicar `tabular-nums` también a números inline en Hanken.
- **Line-heights:** apretados en tabla (1.2–1.35); 1.5 en lectura/forms.
- **Dos pesos hacen el 90%** (regular valores, 600 headers/énfasis); evitar >3 pesos en tool-mode.

Fuentes: [Attio DESIGN.md](https://explainx.ai/designs/whyashthakker-design-md-templates-skills/attio/design-md)

## 5. Color y contraste

- **[Attio]** **Un solo acento** (teal) para focus ring + botón primario + highlight activo; todo lo demás neutral. → espejo exacto de nuestro sunset `#F05A28` como único acento de acción + Stone haciendo el 90%.
- **[Stripe]** Sistema riguroso de status pills: un hue semántico por estado, fills baja saturación + texto legible.
- **CRM pipeline (convención):** lead/new = azul/slate · qualified/in-progress = ámbar · won = verde · lost = rojo/rosa · on-hold = gris.
- **Inventario (ampliamente adoptado):** in-stock = verde · low-stock = ámbar/naranja · out-of-stock = rojo · overstock = azul opcional. **Escalada gradual** (ámbar en umbral bajo → rojo crítico) para evitar "fatiga de urgencia".
- **OKLCH:** adoptar para generar rampas — lightness perceptualmente uniforme → pasos de contraste parejos y variantes dark triviales.
- **Dark:** **reducir chroma** del acento y estados (~10–25%) y nunca negro puro — Linear/Attio usan near-black (`#0d0e10` / `#111`) y acentos algo desaturados (anti-halación).

Fuentes: [Attio](https://explainx.ai/designs/whyashthakker-design-md-templates-skills/attio/design-md) · [Koble stock colors](https://koblesystems.com/knowledge/inventory/stock_level_color.htm)

## 6. Densidad y tablas de datos

- **[Carbon] escala canónica de fila (5 tiers):** **xs/compact 24 · sm 32 · md 40 · lg 48 · xl 64px.** Toolbars: 32px con filas compactas; 48px con default/tall.
  - **Nuestra recomendación ops:** default **40px (md)** + toggle a **32px (compact)** para power users. 48px solo para fila con avatar + 2 líneas.
- **[Polaris]** Admin "alta densidad por default"; no mezclar dos densidades en un mismo card.
- **Header sticky:** obligatorio. **Primera columna congelada** (nombre entidad/SKU) en tablas anchas.
- **Inline edit:** click-to-edit (grid estilo spreadsheet). Enter commit, Esc cancel, Tab → derecha. Write optimistic.
- **Hover de fila:** tint sutil (~neutral-50 / 4% acento). **Selección** = checkbox + bg tintado persistente; acciones de fila se revelan en hover (icon buttons ghost a la derecha).
- **Barra de acciones masivas:** aparece (slide-up ~150–200ms) al seleccionar ≥1 fila → conteo + ops batch; reemplaza el toolbar contextualmente.
- **Paginación vs infinite:** **paginar** data transaccional/auditable (pedidos, facturas, ledger de inventario — necesitan posición estable + conteos); **infinite virtualizado** para listas exploratorias largas. Default: **server pagination 25–50 filas**, virtualizar arriba de ~200 visibles.
- **Resize de columna:** drag en el borde del header; persistir ancho por usuario.
- **Empty states:** ciudadano de primera clase (Linear trata empty/loading/error como deliverables) — ícono + 1 línea + CTA primaria, nunca tabla en blanco.

Fuentes: [Carbon row-height](https://github.com/carbon-design-system/carbon/issues/8874) · [Polaris Density](https://polaris-react.shopify.com/design/layout/density)

## 7. Navegación

- **[Attio]** Sidebar izquierdo persistente con **rail colapsable** (icon-only ~56–64px ↔ ~240–260px). Estado persiste por usuario.
- **[Linear/Notion/Raycast]** **⌘K / Ctrl+K** obligatorio con 20+ acciones/destinos: fuzzy, grupos de acción, comandos anidados, resultados virtualizados, solo-teclado, modal ~560–640px centrado con sombra. Sirve para **navegar + actuar** (cambiar estado, asignar, crear), no solo buscar.
- **Breadcrumbs** para drill-down jerárquico (almacén → ubicación → SKU; cuenta → contacto). Nav superficial: **2 niveles máx** en sidebar; más profundo va a breadcrumbs/tabs.
- CRM/inventario: agrupar por objeto (Clientes, Pedidos, Inventario, Logística, Analytics), sub-items expandibles, barra de acento en activo.

Fuentes: [Mobbin command palette](https://mobbin.com/glossary/command-palette) · [UX Patterns](https://uxpatterns.dev/patterns/advanced/command-palette)

## 8. Forms y paneles de detalle

- **[Attio]** **Record side-peek** — overlay vertical con edición inline de campos + activity log, abierto desde una fila *sin salir de la lista*. Patrón CRM dominante.
- **Decisión:** **side-peek drawer (~480–560px, slide desde derecha, ~250ms)** para ver/editar rápido manteniendo contexto de lista; **full page** solo para edición multi-sección compleja (spec de producto, armado de pedido).
- **Inline editing** default para cambios de 1 campo (sin modal): click valor → input in situ → save optimistic. Modales solo para **confirmaciones destructivas** y **create con muchos campos requeridos**.
- Forms: 1 columna, labels arriba, agrupados en cards con borde, 16–24px entre grupos, acción primaria abajo-derecha (o footer sticky en drawers).

Fuentes: [Attio record sidebar](https://www.saasui.design/application/attio)

## 9. Motion

- **[Linear] techos estrictos:** **0.1s** quick · **0.15s** exit · **0.25s** standard · **0.35s** máx.
- **[Material/Apple convergencia]** 150ms micro · 200–250ms navegación/panel · ≤300ms complejo. Default cross-platform: **220–280ms ease-out** `cubic-bezier(0.4,0,0.2,1)`.
- **Animar solo `transform` + `opacity`** (GPU). **Nunca `width/height/margin/padding`** en tablas densas (reflow — regla explícita de Linear).
- Tool-mode: animar **cambios de estado y overlays** (drawer, palette, bulk-bar, toast); **no** animar filas/celdas al cargar data (molesto a densidad). Respetar `prefers-reduced-motion`.

Fuentes: [performance.dev](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown) · [Material motion](https://m1.material.io/motion/duration-easing.html)

## 10. Accesibilidad (WCAG 2.2)

- **[2.5.8 AA]** Target **≥ 24×24 CSS px** (o 24px de separación). Best-practice **44×44**. Filas compactas de 32px pasan; **icon-buttons ghost deben tener hit area ≥24px** (padear).
- **[2.4.13 Focus Appearance]** Indicador de foco ≥ **perímetro de 2px** y **≥3:1 contraste** focused/unfocused. Anillos **2px, acento o neutral alto contraste, ≥3:1**; nunca quitar outline sin reemplazo.
- **[Líderes]** Linear/Attio/Stripe: operabilidad total por teclado (palette, nav de tabla, inline edit commit/cancel) + foco visible. Contraste: APCA como target; mínimo WCAG 4.5:1 body / 3:1 large+UI.

Fuentes: [Deque WCAG 2.2](https://dequeuniversity.com/resources/wcag-2.2/) · [AccessiCart 2.5.8](https://accessicart.com/wcag-2-2-aa-sc-2-5-8-target-size-minimum/)

---

## Gap analysis — nosotros vs estos líderes

**Ya alineados (mantener):** acento único sunset + Stone neutral · dark near-black `#111` en ops · Geist Mono + tabular-nums · tokens de densidad `--row-h-*` (Carbon) · skeletons shimmer (logística) · master-detail (Pedidos, Rutas) · easing tokens · `prefers-reduced-motion`.

**Huecos reales a cerrar (orden recomendado):**
1. **Optimistic UI** — hoy las mutaciones esperan al server. Es el mayor salto de "feel premium". (#1)
2. **Regla de elevación codificada** — definir `--elevation-flat` (borde) y `--elevation-overlay` (sombra+borde); auditar cards que hoy llevan sombra in-page. (#3)
3. **Command palette ⌘K** — no existe; alto valor para operadores con 20+ destinos. (#5)
4. **Side-peek drawer canónico** — formalizar el organismo y reusarlo (CRM/inventario/pedidos). (#6)
5. **Sets de estado inventario + CRM** — faltan tokens dedicados con escalada gradual. (#10, #11)
6. **OKLCH** — migrar rampas (backlog, future-proof). (#15)

> Nota de fuentes: row-scale de Carbon (24/32/40/48/64), hex/radios de Attio y padding 24px de Stripe vienen de agregadores secundarios consistentes; confirmar contra Carbon Storybook + Polaris token JSON si se quiere canon exacto.
