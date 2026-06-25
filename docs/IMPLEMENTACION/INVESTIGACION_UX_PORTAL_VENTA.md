# Investigación UX/UI — Portal de Venta B2B (Mega Dulces)

> Estudio de los mejores diseños de comercio/delivery (Rappi, Uber Eats, DoorDash, Instacart, Amazon/Amazon Business, Faire, Shopify) traducido a recomendaciones accionables para **el portal B2B de Mega Dulces** (`apps/portal`, PWA Angular).
> Foco doble: **interfaces** + **publicidad/marketing in-app** (promos que conviertan sin saturar).
>
> Metodología: harness de research multi-fuente (24 fuentes, 105 claims extraídos, **25 verificados por votación adversarial 3-voto, 22 confirmados, 3 refutados**). Confianza alta en lo apoyado por fuentes primarias (Baymard, Nielsen Norman Group, Material 3, Shopify Polaris, Instacart Ads, Apple HIG, WCAG, FTC). Fecha: 2026-06-24.

---

## 1. Resumen ejecutivo

Los mejores portales de comercio convergen en pocos patrones que **encajan casi 1:1** con un portal B2B de recompra como el tuyo:

1. **El reorden es EL flujo principal, no el browsing.** Los usuarios de grocery/delivery son "transaccionales, no exploratorios": quieren recomprar en mínimos clics. Esto **valida tu inversión en reorden 1-tap** y "Comprar de nuevo" — y dice que debe ser aún más protagónico.
2. **UI neutra por defecto; el color carga las promos y el estado.** Base monocromática → pocos colores vivos ganan prominencia para CTAs/ofertas. Coincide con tu `DESIGN.md` (quiet-luxury). El color **nunca** debe ser el único portador de significado (parear con texto/icono).
3. **Checkout/confirmación de baja fricción:** costos arriba (no al final), pasos etiquetados, tap targets ≥44px, botón de acción sticky, confirmación en 1 toque.
4. **La publicidad in-app debe pelear contra el "banner blindness".** Los banners convencionales (top, lateral, entre contenido) se **ignoran sistemáticamente**. Las promos convierten mejor como **unidades nativas en contexto** (en resultados de búsqueda, en catálogo, en "Comprar de nuevo"), disparadas por término o comportamiento.
5. **Estructura móvil = Material 3:** bottom-nav de 3–5 destinos persistentes; búsqueda predictiva con imágenes; add-to-cart sticky.

**Veredicto sobre tu portal:** la arquitectura de información es sólida y ya implementa muchos de estos patrones (reorden 1-tap, base Stone neutra, tab bar, búsqueda IA, recomendaciones). Los huecos reales están en **(a)** jerarquía del reorden en el home, **(b)** add-to-cart sticky en la ficha, **(c)** diseñar las promos como unidades nativas en vez de banner hero, y **(d)** disciplina de saturación promocional.

---

## 2. Hallazgos verificados (con evidencia y citas)

> Cada hallazgo trae el voto de verificación adversarial y la fuente. "3-0" = los 3 verificadores confirmaron.

### H1 — Reorden = flujo primario y superficie con nombre propio · `confianza ALTA · 3-0`
Investigación de usabilidad de Baymard (70+ sesiones, 1,100+ horas): los usuarios de grocery/delivery son "menos exploratorios y más transaccionales", "priorizan localizar rápido lo que ya compraron en vez de navegar". Usuarios de prueba: *"siempre voy por la sección Buy again porque es más fácil"*, agregando productos al carrito desde el home **sin abrir la ficha**. En B2B la aplicabilidad es **mayor** (casi todos son cuentas logueadas de recompra). Lift de conversión por reorden de 1 clic citado en ~35%.
Fuentes: [Baymard – grocery/food delivery](https://baymard.com/blog/grocery-food-delivery-orders), [Rigby – marketplace UX](https://www.rigbyjs.com/blog/marketplace-ux)

### H2 — Base neutra para que pocas vivas carguen la promo/CTA · `ALTA · 3-0`
Shopify Polaris usa "un esquema blanco y negro, creando intencionalmente un fondo neutro" para que los elementos clave ganen "prominencia visual aumentada"; prescribe "usar colores fuertes y vivos para llamar la atención a lo que más importa", reservando los rellenos para superficies pequeñas y **nunca** como fondo de toda la interfaz. Alineado con tu `DESIGN.md`.
Fuente: [Shopify Polaris – Design](https://polaris-react.shopify.com/design)

### H3 — El color nunca solo; rol semántico fijo · `ALTA · 3-0`
Polaris (alineado a WCAG 1.4.1): Do = "usa color junto a otros elementos discernibles"; Don't = "usar color solo para transmitir significado". Cada color atado a un rol: rojo=error crítico, verde=éxito, azul/info=*"tips, promociones o incentivos"*. (Polaris codifica **nombres de rol**, no hues hardcodeados.)
Fuente: [Shopify Polaris – Design](https://polaris-react.shopify.com/design)

### H4 — Bottom-nav Material 3: 3–5 destinos persistentes · `ALTA · 3-0`
M3: "Usa navigation bars con 3–5 destinos top-level de igual importancia… persistentes y consistentes entre pantallas." **Caveat:** "Carrito" es más un estado transitorio que un destino co-igual → un tab bar de 4 (Catálogo/Pedidos/Reordenar/Cuenta) con carrito como **acción sticky con badge** cumple mejor la regla que forzar el carrito a la barra.
Fuente: [Material 3 – Navigation bar](https://m3.material.io/components/navigation-bar/guidelines)

### H5 — Ficha mobile-first con add-to-cart sticky + búsqueda predictiva · `ALTA · 3-0`
Baymard: las barras add-to-cart sticky suben conversión móvil **5–12%** (los usuarios pasan el ATC inline en 2–3s). A/B: +5.2% pedidos (98% significancia), +8–15% (TheGood/Shopify). **Caveat:** ganó la variante drawer-sticky; un simple "scroll-to-ATC" no dio lift significativo — la implementación importa. Búsqueda: 78% de usuarios móviles usan autocomplete; Algolia ~24% uplift; en Amazon los que buscan son ~15% de visitantes pero ~45% del revenue.
Fuentes: [Reliqus – ecommerce UX 2025](https://reliqus.com/best-ecommerce-ux-patterns-2025/), [Baymard – grocery/food delivery](https://baymard.com/blog/grocery-food-delivery-orders)

### H6 — Checkout de baja fricción · `ALTA · 3-0 (merge de 6 claims)`
Baymard: costos inesperados = **driver #1 de abandono** (~48%); creación de cuenta forzada = ~22–26% del abandono; indicadores de progreso reducen abandono (+5–15%) y deben mapear 1:1 a pasos; checkout express/wallet prominente sube conversión **+15–37%**; checkout simplificado ~35% lift. Tap targets 44px (Apple HIG + WCAG 2.5.8); botón Pay sticky 5–12% lift.
**Refutado (0-3):** "siempre diferir la creación de cuenta a post-compra". Lo correcto: **ofrecer** cuenta opcional post-compra, no eliminarla — relevante porque un portal B2B **necesita** cuentas persistentes para precios por cliente.
Fuentes: [DesignStudio – checkout UX](https://www.designstudiouiux.com/blog/ecommerce-checkout-ux-best-practices/), [Rigby](https://www.rigbyjs.com/blog/marketplace-ux), [Reliqus](https://reliqus.com/best-ecommerce-ux-patterns-2025/)

### H7 — Banner blindness: los banners convencionales se ignoran · `ALTA · 3-0`
Documentado en investigación peer-reviewed: Benway (1998), Burke et al. (2005, ACM TOCHI, eye-tracking), y NN/g (eye-tracking 1997–2024, el efecto persiste en móvil moderno). El riel derecho recibe ~0.8% de la atención; top-of-page y entre-contenido se saltan rutinariamente. **Implicación:** no confíes en un banner hero/lateral para cargar tus ofertas.
Fuentes: [LogRocket – banner blindness](https://blog.logrocket.com/ux-design/avoiding-banner-blindness/), [NN/g – banner blindness](https://www.nngroup.com/articles/banner-blindness-old-and-new-findings/)

### H8 — Las promos convierten como unidades nativas en contexto · `ALTA · 3-0`
Kevel + FTC: la publicidad nativa efectiva "matchea la estética del contenido anfitrión", lleva disclosure claro de patrocinio (FTC 2015 exige divulgación clara), y "protege el journey evitando layouts disruptivos". Instacart Ads: los placements "relacionados al término de búsqueda o al comportamiento pasado pueden aparecer **arriba de los resultados de búsqueda**". **Caveat importante:** la regla de Instacart "una impresión por anuncio por carga de página" es **disciplina de medición**, NO un cap visual anti-saturación (el anuncio se re-renderiza al hacer scroll).
Fuentes: [Kevel – native advertising](https://www.kevel.com/native-advertising), [Instacart Ads – display placements](https://docs.instacart.com/ads/ads_guide/concepts/display_placements/)

### H9 — Palancas B2B de recompra · `MEDIA · 3-0`
WizCommerce (corroborado por commercetools, Adobe/Magento, Shopify Enterprise): recomendaciones IA, **catálogos por cliente** y **precios por comprador** son práctica estándar B2B. Las recomendaciones generan hasta ~31% del revenue de ecommerce (Amazon ~35%); personalización ~10–15% de lift de revenue. Validan tus features de recomendaciones IA + precio/catálogo por cliente. (Magnitudes son vendor-cited → tómalas como direccionales.)
Fuentes: [WizCommerce – B2B](https://wizcommerce.com/b2b-ecommerce-marketplace), [Rigby](https://www.rigbyjs.com/blog/marketplace-ux)

### Claims refutados (NO citar como verdad)
- ❌ "Diferir siempre la cuenta a post-compra" (0-3) — ver H6.
- ❌ "Faire ofrece reorden automático" (1-2) — sin sustento.
- ❌ "Más variedad de banners acelera el filtrado de anuncios" (1-2) — direccionalmente plausible pero no verificado.

---

## 3. Patrones por pantalla → aplicado a tu portal

> Mapeo de cada hallazgo a tu código real (referencias clicables) y qué cambiar.

### 3.1 Home / Storefront — [`portal-home.component.ts`](../../apps/portal/src/app/modules/portal/pages/portal-home.component.ts)
**Ya bien (validado):** ribbon de pedido vivo, "Comprar de nuevo" con add 1-tap, atajos (repetir último), historial. El SVG editorial y la base Stone neutra cumplen H2.

**Cambiar (por H1, H7):**
- **Sube "Comprar de nuevo" al primer pliegue**, por encima del hero editorial. Hoy el hero ilustrado ocupa la posición noble; la investigación dice que el usuario B2B quiere recomprar, no admirar. El hero puede achicarse a una franja.
- El **banner de marketing de promo** (`bannerPromo`) está en el lugar de menor atención (H7). Considera moverlo a unidad nativa (§4) o convertirlo en una card dentro de "Comprar de nuevo"/catálogo.
- El **search del home es decorativo** (`⌘K` placeholder que navega) — en una PWA táctil confunde; o lo haces funcional in-place o lo conviertes en CTA explícito.

### 3.2 Catálogo + Búsqueda — [`portal-catalog.component.html`](../../apps/portal/src/app/modules/portal/pages/portal-catalog.component.html)
**Ya bien (validado por H5, H9):** búsqueda dual texto/IA con debounce, autocomplete-like, facets reales, paginación infinita, quick-chips (Reordenar/Sugeridos IA/Con promo), strip "Más vendidos", toggle grid/lista. Esto es best-in-class.

**Cambiar (por H5, H8):**
- Añade **imágenes en las sugerencias de búsqueda** (Baymard: autocomplete con imágenes convierte más). Hoy los chips de historial son solo texto.
- **Promos nativas arriba de resultados** (H8): cuando el cliente busca "bombón", inyecta 1–2 SKUs patrocinados/empujados (de tu motor Thot/promociones) **al inicio de la lista**, marcados como "Destacado", en vez de depender del chip "Con promo".

### 3.3 Ficha / Sheet de producto — [`portal-product-card.component.ts`](../../apps/portal/src/app/modules/portal/ui/portal-product-card.component.ts) + sheet en catálogo
**Ya bien:** stepper, placeholder de marca, sheet con subtotal, pill de stock/promo (H3: color + icono + texto, ✅).

**Cambiar (por H5):**
- En el **product sheet** (bottom-sheet de detalle), haz el botón "Agregar al carrito" **sticky al fondo del sheet** (variante drawer, que es la que ganó los A/B) — que nunca se pierda al hacer scroll del detalle.

### 3.4 Carrito y confirmación — [`portal-cart.component.ts`](../../apps/portal/src/app/modules/portal/pages/portal-cart.component.ts)
**Ya bien (validado por H6):** costos desglosados arriba (subtotal/IVA/ahorro/total), CTA `-lg`, summary sticky, nota "reservamos stock". Tap targets 44px ✅.

**Cambiar (por H6):**
- El carrito **recarga todo (`reload()`)** tras cada cambio de cantidad → se siente lento. Pásalo a **update optimista** como ya hace el catálogo con `cartDetail()`.
- Para B2B: muestra **progreso de pasos** si el flujo crece (Carrito → Confirmar → Aprobación), mapeado 1:1.

### 3.5 Pedidos y tracking — `portal-orders` / `portal-order-detail`
**Ya bien:** filter-chips por status (color+icono+texto, H3 ✅), reorden 1-tap desde la lista (H1 ✅), overlay de celebración, timeline de historial, tracking de embarques.
**Nota (open question):** los patrones específicos de UI de tracking (mapa, ETA, estados de ruta) no fueron cubiertos por la investigación — tienes módulo de logística, vale la pena un estudio dedicado si lo expones al cliente.

### 3.6 Promociones — `portal-promotions`
**Ya bien:** bento grid, tipos de promo con icono+label, promos de canasta auto-aplicables.
**Cambiar (por H7/H8):** la pantalla dedicada de promos está bien para quien la busca, pero **el grueso de la conversión promocional debe ocurrir en contexto** (catálogo/búsqueda/comprar-de-nuevo), no en una pantalla aparte que pocos visitan.

---

## 4. Publicidad / marketing in-app (el foco que pediste)

> Tu portal es **mono-distribuidor** (un solo vendedor: Mega Dulces, sin advertisers terceros). Por eso "publicidad" aquí = **empujar tus propios SKUs/promos**, no retail-media de terceros → el disclosure FTC de "patrocinado" probablemente no aplica; basta etiqueta honesta tipo "Destacado"/"Oferta".

**Principios derivados de la investigación:**

1. **Nada de banner hero como motor de promos** (H7). Úsalo solo como decoración/marca, no esperes conversión de ahí.
2. **Promos = unidades nativas en contexto** (H8), en orden de valor:
   - **En resultados de búsqueda/catálogo:** 1–2 productos empujados al tope, con estética idéntica a las cards normales + etiqueta sutil "Destacado" (color + texto, H3). Disparados por término de búsqueda o comportamiento.
   - **En "Comprar de nuevo":** inserta un SKU nuevo/en-promo relevante entre los habituales (cross-sell contextual, alta intención).
   - **En la ficha/sheet:** módulo "Va bien con esto" (cross-sell) con 2–3 SKUs.
   - **En carrito:** "Te falta poco para el mínimo de $2,500" + sugerencia — convierte una restricción en upsell.
3. **Color con disciplina** (H2/H3): la etiqueta de oferta usa el rol semántico fijo (tu `--brand`/`--action` para destacar; nunca solo color — siempre con "−15%"/"Oferta" en texto).
4. **Disciplina de saturación:** la investigación **no** entregó un número mágico (el claim de "menos banners = mejor" fue refutado por falta de evidencia). Regla pragmática: **máx. 1 unidad nativa promocional por pliegue visible**, medir CTR/conversión y ajustar. No copiar la regla de "1 impresión por carga" de Instacart como cap visual (es medición).
5. **Push / gamificación / loyalty:** la investigación **no produjo claims verificados** (open question). Para B2B, el caso más fuerte es el **push de recordatorio de recompra** ("Tu pedido habitual de cada lunes") apoyado en tu historial — pero diséñalo y mídelo, no lo asumas. Ya tienes `push.service` y `notification-prefs` en el portal: base lista.

---

## 5. Backlog priorizado de mejoras

> Impacto (conversión/recompra) × Esfuerzo. P0 = alto impacto / bajo-medio esfuerzo.

| # | Prioridad | Mejora | Pantalla | Hallazgo | Esfuerzo | Impacto |
|---|---|---|---|---|---|---|
| 1 | **P0** | Subir "Comprar de nuevo" sobre el hero; achicar hero a franja | Home | H1 | S | Alto |
| 2 | **P0** | Add-to-cart **sticky** (drawer) en el product sheet | Ficha | H5 | S | Alto |
| 3 | **P0** | Update **optimista** del carrito (matar `reload()` por cambio de qty) | Carrito | H6 | M | Medio-Alto |
| 4 | **P0** | Promos como **unidad nativa** al tope de resultados de búsqueda/catálogo (1–2 SKUs "Destacado") | Catálogo | H7,H8 | M | Alto |
| 5 | **P1** | Imágenes en sugerencias/autocomplete de búsqueda | Catálogo | H5 | S | Medio |
| 6 | **P1** | Cross-sell "Va bien con esto" en ficha + "te falta para el mínimo" en carrito | Ficha/Carrito | H8,H9 | M | Medio-Alto |
| 7 | **P1** | Auditar tab bar: ¿4 destinos persistentes + carrito como acción sticky? | Shell | H4 | S | Medio |
| 8 | **P1** | Search del home: hacerlo funcional in-place o convertir en CTA honesto | Home | H5 | S | Medio |
| 9 | **P2** | Push de **recordatorio de recompra** basado en cadencia del historial | Cross | H1,§4 | M | Medio (medir) |
| 10 | **P2** | Regla de saturación: máx 1 unidad promo/pliegue + telemetría CTR | Cross | §4 | M | Medio |
| 11 | **P2** | Limpiar utilities de motion heredadas no usadas (parallax/glass/noise) en `styles.css` | Sistema | — | S | Bajo (deuda) |
| 12 | **P2** | Estudio dedicado de UI de tracking/ETA si se expone al cliente | Pedidos | open Q | M | ? |

**Lo que ya NO hay que tocar (validado como correcto):** base Stone neutra + color disciplinado (H2/H3), reorden 1-tap (H1), búsqueda IA + facets + infinite scroll (H5), recomendaciones IA + precio/catálogo por cliente (H9), costos desglosados arriba en carrito (H6), status con color+icono+texto (H3).

---

## 6. Caveats y preguntas abiertas

**Caveats:**
- Casi toda la investigación de reorden/checkout es **B2C grocery/delivery**, no B2B distribución. La transferencia es razonable (y arguably más fuerte en B2B por ser recompra logueada) pero es **extrapolación**, no evidencia B2B directa.
- Los % de lift varían por implementación (drawer vs botón simple) e industria → **direccionales**, no garantías.
- Specs de design-system y docs de ads **evolucionan** → re-verificar Polaris/Instacart/Material 3 antes de implementar. Banner-blindness y fricción de checkout son hallazgos estables (1998–2026).
- Calidad de fuentes mixta: lo *load-bearing* está anclado en primarias (Baymard, NN/g, Polaris, M3, Instacart, Apple HIG, WCAG, FTC). Los blogs (rigbyjs, reliqus, wizcommerce, kevel, designstudiouiux) se usaron solo como **corroboración**, no como evidencia.

**Preguntas abiertas (no resueltas por la investigación):**
1. ¿Un portal mono-distribuidor debe correr "sponsored placements" o "promos" = solo SKUs propios destacados? (cambia si aplica disclosure FTC).
2. Push / gamificación / loyalty (patrones Rappi/DoorDash/Mercado Libre): sin claims verificados — eficacia para recordatorios de recompra B2B **sin investigar**.
3. No emergió una regla concreta de frequency-capping/anti-saturación verificada.
4. UI específica de tracking de pedido (mapa, ETA, estados de ruta) sin cubrir.

---

## 7. Fuentes (primarias destacadas)

- [Baymard Institute — Grocery & Food Delivery UX](https://baymard.com/blog/grocery-food-delivery-orders) · [Amazon case study](https://baymard.com/ux-benchmark/case-studies/amazon) · [DoorDash case study](https://baymard.com/ux-benchmark/case-studies/doordash)
- [Nielsen Norman Group — Banner Blindness](https://www.nngroup.com/articles/banner-blindness-old-and-new-findings/)
- [Shopify Polaris — Design / Color](https://polaris-react.shopify.com/design)
- [Material 3 — Navigation bar](https://m3.material.io/components/navigation-bar/guidelines) · [Bottom sheets](https://m3.material.io/components/bottom-sheets/guidelines)
- [Instacart Ads — Display placements](https://docs.instacart.com/ads/ads_guide/concepts/display_placements/)
- [Kevel — Native advertising](https://www.kevel.com/native-advertising)
- [Android Accessibility — touch targets](https://support.google.com/accessibility/android/answer/7101858)
- Corroboración (blogs): [Rigby](https://www.rigbyjs.com/blog/marketplace-ux), [Reliqus](https://reliqus.com/best-ecommerce-ux-patterns-2025/), [WizCommerce](https://wizcommerce.com/b2b-ecommerce-marketplace), [DesignStudio](https://www.designstudiouiux.com/blog/ecommerce-checkout-ux-best-practices/), [LogRocket](https://blog.logrocket.com/ux-design/avoiding-banner-blindness/)

*Generado por research multi-fuente con verificación adversarial. 24 fuentes · 105 claims · 25 verificados · 22 confirmados · 3 refutados.*
