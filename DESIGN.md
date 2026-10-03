# Design System — Mega Dulces ("Mercado")

> Fuente de verdad de UI para toda la app.
> Dirección **"Mercado"**, creada por `/design-consultation` (2026-06-04, extendida 2026-06-08).
> Los tokens viven en [`libs/design-tokens/tokens.css`](libs/design-tokens/tokens.css) — **un solo archivo para las 3 apps** (`view` · `portal` · `vendor`). Este archivo manda sobre cualquier valor hardcodeado.
> *(Consolidado 2026-08-12: antes estaba triplicado en `apps/*/src/styles/tokens.css` + un segundo bloque dentro de cada `styles.css`. Ya había divergido — portal servía Inter/JetBrains en `:root` y `--ease-standard` tenía dos valores. Ver Decisions Log.)*
> **Estado del arte técnico (ago-2026):** [`docs/DESIGN_TECNOLOGIA_2026.md`](docs/DESIGN_TECNOLOGIA_2026.md) — qué APIs de plataforma ya son seguras (container queries, `@layer`, popover+anchor, view transitions), el método responsive de 4 herramientas, tooling (Angular 22 / **PrimeNG ya no es open source** / Tailwind v4 / tokens DTCG), CWV 2026 y patrones de **agentic UX**. Incluye auditoría de adopción del repo y backlog `DT.1-DT.14`. Investigación, no normativa: lo aceptado sube acá.
> **Fundamentos (el *por qué* + estado del arte, con citas):** [`docs/DESIGN_FOUNDATIONS.md`](docs/DESIGN_FOUNDATIONS.md) — color perceptual (OKLCH/APCA), tokens DTCG, tipografía óptica, densidad, WCAG 2.2, motion. Este archivo es operativo; ése es la base teórica.
> **Benchmark CRM/Inventario (cómo lo hacen Linear/Attio/Carbon/Polaris/Stripe, con números):** [`docs/DESIGN_BENCHMARK_CRM_INVENTORY.md`](docs/DESIGN_BENCHMARK_CRM_INVENTORY.md). Las reglas canónicas de datos densos de aquí abajo salen de ahí.

> **Estado de implementación (2026-06-16):** la migración Operations (Hanken/Stone/sunset/ember en `:root`) **ya está aplicada** en `tokens.css` — la nota histórica "pendiente de aprobación" más abajo quedó vieja. El dark de Operations es **zinc neutro `#111111`** (decisión "esto es serio"), NO el espresso `#16130F` que describen las tablas históricas; el espresso quedó scopeado solo a `/portal`.

> **Contrato de ingeniería de UI (2026-07-10):** el *cómo se construye* (fundamento cognitivo, matriz de estados, a11y AA+APCA, presupuesto de motion + limpieza de ciclo de vida, container queries, error boundaries, formateo de dominio, XSS, estado-en-URL) está codificado como BINDING en la sección [Ingeniería de UI](#ingeniería-de-ui--contrato-de-implementación-binding). Se verifica en review.

> **Plataforma + IA (2026-08-25):** dos contratos nuevos BINDING, destilados de la investigación técnica: [Plataforma web moderna](#plataforma-web-moderna--cascada-responsividad-overlays-motion-nativo-binding) (§R responsividad por capas · §S cascada `@layer` · §T overlays nativos · §U motion nativo · §V presupuesto INP · §W ganancias gratis) y [Superficies con IA](#superficies-con-ia--contrato-de-agentic-ux-binding) (§X: plan previo, razón, confianza, reversa, escalación). Marco: **mejora progresiva** — la pantalla funciona sin la feature moderna.

> **Norte de estilo — directiva "quiet luxury" (2026-06-23):** el surface Operations toma como referencia absoluta a **Linear · Stripe · Vercel (Geist)**: minimalismo técnico, herramienta profesional, máxima densidad sin sacrificar claridad. Reglas que **mandan** (refuerzan/afinan lo de abajo):
> 1. **Estructura casi monocromática.** El color de marca (sunset `--action`) se reserva para **CTAs, enlaces activos y el estado seleccionado** — nada de decorar con color. Semánticos (ok/warn/bad) **desaturados y controlados**, solo en badges de estado.
>    - **Excepción confirmada (decisión Edgar 2026-06-23):** los **accents de color por card** en `MetricCard` y las gráficas (sparkline/bars/gauge/donut) **se conservan** — ahí el color **codifica dato**, no decora (igual que los charts de Linear/Stripe). No atenuar a monocromo. La regla "casi monocromático" aplica a la **estructura/chrome** (tablas, paneles, navegación, formularios), no a la capa de data-viz.
> 2. **Separadores apenas perceptibles:** borde 1px (`--border-color`/`--c-divider`); profundidad con sombras mínimas (`shadow-sm`) o ring 1px, **nunca** sombras difusas/pesadas. Radios discretos (`md`/`lg`); pill solo para badges.
> 3. **Densidad Stripe:** `--fs-sm` base, `--fs-xs` para metadatos; jerarquía por **contraste de texto** (`c-text-1` principal / `c-text-2`/`c-text-3` secundario).
> 4. **Tablas:** padding compacto, números/estados a la derecha, texto a la izquierda, **filas separadas por divisor inferior 1px fino**. ⛔ **NADA de zebra striping** (se ve anticuado) — `surf-table--zebra` quedó **neutralizado (no-op)**. ⚠️ **35 archivos siguen aplicando la clase** (medido 2026-09-14): no rompe nada pero es una intención que el sistema descarta en silencio — al tocar una de esas tablas, quitala. Detalle en [`docs/DESIGN_TABLES.md`](docs/DESIGN_TABLES.md).

---

## Mapa del documento

> **Última verificación contra el código: 2026-09-14** ([Estado de cumplimiento](#estado-de-cumplimiento--lo-que-el-doc-manda-vs-lo-que-el-código-hace)). Las secciones marcadas 🗄️ son **histórico** — trazabilidad, no checklist.

| # | Sección | Qué contiene | ¿Binding? |
|---|---|---|---|
| 1 | [Checklist pre-vuelo](#️-checklist-pre-vuelo-leer-antes-de-tocar-frontend) | los 18 puntos que hay que tener en la cabeza. **Empezá acá** | sí (resume todo) |
| 2 | [Estado de cumplimiento](#estado-de-cumplimiento--lo-que-el-doc-manda-vs-lo-que-el-código-hace) | qué se cumple hoy y qué no, medido y fechado | — (es el espejo) |
| 3 | [Arquitectura de tokens](#arquitectura-de-tokens-3-tiers--interacción--densidad-por-puntero) · [Surfaces](#surfaces--dos-modes-del-mismo-sistema) · [Inventario](#inventario-de-componentes-compartidos) | de dónde sale cada valor y qué pieza ya existe | sí |
| 4 | [Typography](#typography) · [Color](#color) · [Spacing](#spacing) · [Layout](#layout) · [Motion](#motion) | el sistema visual. **§Motion es la única fuente de duraciones y curvas** | sí |
| 5 | [Botones «Confite»](#sistema-de-botones-confite-storefront--binding) | firma táctil del Storefront | sí (storefront) |
| 6 | [Operations](#mercado--operations--surface-interno) → [datos densos](#reglas-canónicas-de-datos-densos-crm--inventario--binding) · [motion de KPI](#motion-de-kpi-cards-binding) · [reglas D](#reglas-d--interacción-teclado-y-dato-en-operations-d0d8--binding) | el surface interno y sus 13+9+9 reglas | sí |
| 7 | [Ingeniería de UI §1-§11](#ingeniería-de-ui--contrato-de-implementación-binding) | cómo se construye: estados, a11y, motion, errores, dominio, XSS, URL | sí |
| 8 | [Plataforma web moderna §R-§W](#plataforma-web-moderna--cascada-responsividad-overlays-motion-nativo-binding) | responsividad por capas, `@layer`, overlays nativos, INP | sí |
| 9 | [Superficies con IA §X](#superficies-con-ia--contrato-de-agentic-ux-binding) | plan · razón · confianza · reversa · escalación | sí |
| 10 | [Leyes de interacción](#leyes-de-interacción--arquitectura-de-interacciones-resilientes-binding) | Tesler/Miller/Jakob/Von Restorff + estado sucio, lote, doble-clic | sí |
| 11 | [Layouts por sector §O/§P](#arquitectura-de-layouts-por-sector--ayuda-contextual-binding) | fiscal vs almacén vs mostrador + ayuda contextual | sí |
| 12 | [Jerarquía del dato §Q](#jerarquía-visual--comprensión-del-dato-interfaces-densas-en-valores--binding) | answer-first en pantallas con muchas cifras | sí |
| 13 | [PWA](#pwa--app-instalable-binding) | app instalable: SW, manifest, safe-area, offline | sí (`apps/vendor`) |
| 14 | [Decisions Log](#decisions-log) | por qué cada cosa es como es | — |
| 15 | Auditorías 2026-06-04 + planes de migración | 🗄️ histórico | no |

---

## ✈️ Checklist pre-vuelo (LEER ANTES DE TOCAR FRONTEND)

> **Regla dura:** antes de crear o editar cualquier archivo frontend (componente Angular, HTML, SCSS/CSS, token), se lee esta sección + [`tokens.css`](libs/design-tokens/tokens.css). No es opcional.
> Cada punto enlaza a su detalle binding abajo. Si algo aquí choca con el requerimiento, se expone el conflicto y decide Edgar — no se resuelve en silencio.

**1. Ubicá tu surface.** [Storefront](#surfaces--dos-modes-del-mismo-sistema) = `apps/portal` (editorial, Poppins, comfortable) · [Operations](#mercado--operations--surface-interno) = `apps/view` **y** `apps/vendor` (denso, sin display font, quiet-luxury). Las raíces de ruta de `apps/view` están en la [tabla de Surfaces](#surfaces--dos-modes-del-mismo-sistema) — si la tuya no figura, **agregala ahí antes de seguir**; no inventes régimen. Las reglas cambian por surface, y §O las tensa además por **sector** (fiscal / almacén / mostrador).

**2. Cero hex crudo.** Referenciá un [rol/token de 3 tiers](#arquitectura-de-tokens-3-tiers--interacción--densidad-por-puntero); si no existe, agregá el token, no un literal. Estados de superficie = alpha-overlays sobre `--ink-rgb`, no hex por interacción.

**3. PrimeNG-first, plataforma-antes-que-JS.** Lo que PrimeNG cubra, con PrimeNG (`p-table`, `p-tag`, `p-dialog`), no HTML crudo. Overrides vía theming/token + **capa de cascada**, no `!important` (→ [§S](#plataforma-web-moderna--cascada-responsividad-overlays-motion-nativo-binding)). **Antes** de sumar un componente/librería nueva, verificá si la plataforma ya lo cubre nativo (popover + anchor positioning, `<dialog closedby>`, `appearance: base-select`, view transitions): eso no crece la superficie de dependencia ni pelea con el theming.
> ⚠️ **Riesgo de licencia (ago-2026):** PrimeNG dejó de ser open source — repo archivado jun-2026, v22+ bajo licencia comercial PrimeUI. Estamos en `primeng 22.0.0`. La regla PrimeNG-first **sigue vigente** para lo existente; la decisión (licenciar / congelar / migrar a `@angular/aria` headless) es de Edgar y está abierta — ver [`docs/DESIGN_TECNOLOGIA_2026.md §5.2`](docs/DESIGN_TECNOLOGIA_2026.md). Mientras esté abierta: **no crecer la dependencia sin necesidad** (si nativo lo cubre, nativo).

**4. Tipografía por rol.** Body = Hanken Grotesk · data/cifras/SKU/folio = Geist Mono con **`tabular-nums` obligatorio** · display Poppins **solo** en Storefront. Nunca Fraunces (retirada) ni `system-ui` como display.

**5. Color disciplinado (quiet-luxury).** Marca (sunset `--action`) solo en CTA / activo / seleccionado / foco. IA = **ember** (mata morado `#8b5cf6` y azul `#2563EB`). Semánticos vía `p-tag [severity]`, nunca hex inline. Color nunca es único portador de significado (+ icono/texto). Excepción: data-viz (`--chart-*`) y accent por `MetricCard` codifican dato.

**6. Matriz de estados completa** (el happy path no basta): `hover` · `focus-visible` (ring tokenizado, jamás `outline:none`) · `active` (crítico en touch) · `disabled`; `loading` (skeleton dimensionado, CLS 0) · `empty` (con CTA + microcopy de dominio) · `error` (`catchError` + banner + reintento) · `overflow` (texto 10×). **Empty ≠ error de red.** → [Ingeniería de UI §2](#ingeniería-de-ui--contrato-de-implementación-binding).

**7. Datos densos** (Operations): [elevación = borde 1px *o* sombra, nunca ambas](#reglas-canónicas-de-datos-densos-crm--inventario--binding); fila tokenizada (`--row-h-*`); optimistic UI sin spinner; skeleton-filas; header sticky + 1ª columna congelada; side-peek para detalle; inline-edit 1 campo; **nada de zebra**.

**7c. Teclado y buscador — los dos primitivos YA EXISTEN; se usan, no se rediseñan.** Tabla → `pSelectableRow` de PrimeNG ya da `↑↓` / `Home`/`End` / `Enter` y **roving tabindex**; lo tuyo es que la fila clicable sea alcanzable y acordarte de que la **guarda global** ([`installRowNavGuard`](libs/ui-web/src/keyboard/row-nav.ts)) existe porque PrimeNG **no mira `event.target`** y le roba `Space`/`Enter`/`Home`/`End`/flechas a cualquier campo de la fila. Buscador → servidor con [`applySmartSearch`](libs/platform-core/src/lib/search/smart-search.ts), lista completa en memoria con [`coincideBusqueda`](libs/ui-web/src/search/buscar-en-cliente.ts); **nunca `.toLowerCase().includes()`** (sin acentos, sin varias palabras, sensible al orden), y **nunca filtrar en el cliente una lista paginada**. → [D.7 y D.8](#reglas-d--interacción-teclado-y-dato-en-operations-d0d8--binding).

**7b. Cards — cero `p-card` plana / stat-card suelta.** Toda card se construye con un arquetipo del **repertorio** ([`FASE_J16_CARD_REPERTOIRE.md`](docs/IMPLEMENTACION/FASES/FASE_J16_CARD_REPERTOIRE.md)): KPIs → [`MetricCard`](apps/view/src/app/shared/components/metric-card/) y los demás arquetipos en `apps/view/src/app/shared/components/` (ver [inventario](#inventario-de-componentes-compartidos)). Base compartida (hairline + stripe 3px + spotlight), cifras Geist mono con **count-up**, [dinamismo = dato, no decoración](#motion-de-kpi-cards-binding) (`DESIGN_MOTION_KPI_CARDS.md`), **variedad por tipo de dato** (nunca 4 cards idénticas), 0 hex. Evolución en diseño (cards vivas: odómetro/flash, bullet/heat-strip, drill): [`FASE_J17_CARD_SYSTEM_2.0.md`](docs/IMPLEMENTACION/FASES/FASE_J17_CARD_SYSTEM_2.0.md).
>
> **ADR-033 (2026-07-17) — arquetipo `MetricStrip` "sin caja" para KPI headers.** Para los **encabezados de KPIs de página** (el número+etiqueta que antes vivía en decenas de cajitas `.kpi`/`rk-card` ad-hoc) el arquetipo canónico ahora es [`MetricStrip`](apps/view/src/app/shared/components/metric-strip/metric-strip.component.ts) (`shared/components/metric-strip/`): **cero bg/borde/radio por métrica**, separación por hairline 1px, cifras Geist mono tabular con count-up on-view, color solo en la cifra vía token semántico (`ok/warn/bad/brand`, flipa en dark), delta multimodal, modo texto refinado (nombres/fechas), y modos `strip · spark · ring · bullet · composition` por forma del dato. `prefers-reduced-motion` respetado; móvil colapsa a grid 2×2. `MetricCard` (cajita rica con stripe/spotlight) se conserva para **dashboards con micro-viz propia** (home, /dashboard/reports, routes-analysis, stores-tab): esos NO se aplanan — ahí la caja + gauge/sparkline codifican dato. Regla: **header de KPIs de una pantalla → `MetricStrip`; tile rico individual con su viz → `MetricCard`.** Barrido de adopción 2026-07-17 (28 pantallas view migradas).

**8. Motion con techo** (150/250/**350ms máx**, ease-out): **solo `transform`+`opacity`**; `prefers-reduced-motion`; limpiar en `DestroyRef`. **CSS/WAAPI por default**; GSAP **sí** es dependencia (desde 2026-06-25) pero **sólo por `import()` lazy** — ver §Motion. ⚠️ `NgZone.runOutsideAngular` quedó obsoleto: `apps/view` es **zoneless** (`provideZonelessChangeDetection`). → [Ingeniería de UI §4](#ingeniería-de-ui--contrato-de-implementación-binding).

**9. Responsividad por capas (4 herramientas, cada una con su trabajo).** `@media` = **página/chrome** (sidebar, tab bar, densidad por puntero) · `@container` = **componente** (todo lo que se embebe en más de un ancho: `libs/`, cards, tablas, master-detail) · `clamp()` = **fluido** (type/spacing, máximo ≤ 2.5× el mínimo y término medio con `rem`, o revienta el zoom 200%) · **grid intrínseco** (`auto-fit`/`minmax`/`subgrid`) = layout sin breakpoints. Breakpoints nuevos en **`rem`**, nunca en px. → [§5](#ingeniería-de-ui--contrato-de-implementación-binding) + [§R](#plataforma-web-moderna--cascada-responsividad-overlays-motion-nativo-binding).

**10. Dominio + seguridad.** Divisa/fecha vía `Intl`/pipes es-MX (`registerLocaleData`); TZ ya normalizada en backend, no re-convertir con `new Date()`. Cero `[innerHTML]` sin `DomSanitizer`; jamás `bypassSecurityTrustHtml` sobre input de usuario. Estado de filtros/selección en URL. → [§7–§9](#ingeniería-de-ui--contrato-de-implementación-binding).

**11. a11y AA piso** (APCA guía en texto chico): `aria-label` en icon-buttons, foco al abrir/retorno al cerrar dialogs, targets ≥44px en touch (`pointer: coarse`). → [§3](#ingeniería-de-ui--contrato-de-implementación-binding).

**12. Verificá.** Build prod `nx build <p> --skip-nx-cache` de lo tocado; probar vivo (endpoint nuevo → o avisar que falta restart); QA con datos reales extremos, **light + dark + móvil** (los tres, siempre).
> ⚡ **Antes del build corré las tres compuertas de CSS — tardan ~8 s las tres juntas:**
> `npm run check:templates` · `npm run check:estilos` · `npm run check:motion`.
> - **`check:estilos`** (~2.6 s): las 4 reglas de `DESIGN.md` que nadie medía — `font-size` fuera de la
>   escala `--fs-*` (y te **imprime el token equivalente**), hex crudo en un color, breakpoint en px,
>   y `outline:none` sin un `:focus-visible` hermano. Es un **ratchet**: frena si la deuda crece, no
>   por existir. ⚠️ **No es stylelint, y fue medido**: el 89% del `font-size` de este repo vive dentro
>   de `styles:` en `.ts`, donde stylelint de fábrica no entra.
> - **`check:motion`** (~1.5 s): techo de 350ms en Operations, en `ms` **y** en `s`.
> - **`check:templates`** (~2.9 s) cubre **una sola familia de bug: puntuación adentro de un comentario que TERMINA el comentario.** Se comete justo al documentar un token o una clase en el comentario — que es lo que más se pide hacer acá.
> - **Acento grave** en un comentario de `template:`/`styles:` → **cierra el template literal**. El error sale desplazado (`NG1002` o cascada de `TS1005` a cientos de líneas), así que se pierde el tiempo buscándolo donde no está. En la sesión que escribió estas reglas volvió a pasar **ocho veces**. ⚠️ Con un número **par** el archivo parsea igual y revienta después.
> - **El cierre de comentario CSS adentro de un comentario CSS** — escribir `--warn-*` con la barra pegada. ⛔ **Esto `tsc` no lo ve y el build NO lo frena: sale como *warning* y nada más.** Medido: en `tienda-verificador` significaba que la regla `.vf-cambio` **no existía en el bundle** y la caja de aviso del verificador de mostrador se renderizaba **sin estilo en producción**. Se parsea con **esbuild, el mismo parser del build**, para que el veredicto no pueda divergir del suyo.
> - **Cierre de comentario HTML huérfano** en un `template:` → lo de en medio **se renderiza como texto** en la página. Angular no se queja: es texto válido.
>
> **Con gate en CI desde el 2026-09-14** (job `verify`, con prueba negativa por caso), pero el gate avisa tarde: corriéndolo local te ahorrás el ciclo. Lo que no se puede parsear —un literal con `${}`— sale declarado como **NO MEDIDO**, no se salta en silencio (ADR-056); hoy son 0.

**12b. Modo oscuro — SIEMPRE.** Dark es first-class, no un pase final. En cada componente/estilo: usar solo tokens que flipean por tema (nunca hex crudo — un `#fff`/`#ddd`/`--border` inexistente se ve bien en light y roto en dark); las sombras casi desaparecen en dark → la profundidad la lleva el **borde 1px**; verificar contraste AA en **ambos** temas (no naive-invert). `#fff`/`#000` literales solo si son correctos en los dos (ej. preview de hoja de papel).

**12c. Alto Contraste de Windows — el tercer modo, y el que nadie mira.** Hay un modo más además de
claro y oscuro: **`forced-colors: active`** (Alto Contraste del SO). **La flota es Windows**, o sea que
lo prende gente real — típicamente la que más lo necesita. Y este sistema es, por construcción, el que
peor se lleva con él: la jerarquía in-page descansa en un **hairline de 1px** y en **alpha-overlays**
sobre `--ink-rgb`, y el navegador **funde los tres estados de fila —normal, hover, seleccionada— en el
mismo valor**; las pastillas de estado distinguen por **fondo** y todos los fondos se fuerzan; y el
anillo de foco hecho con `box-shadow` **desaparece** (`box-shadow` se ignora en ese modo). La base vive
en [`libs/ui-web/src/forced-colors.css`](libs/ui-web/src/forced-colors.css), importada por las 3 apps:
no hay que repetirla por pantalla. Lo que sí es tuyo: **que ningún estado dependa sólo del color** —
que es la regla #5 de este mismo checklist, cobrada. `forced-color-adjust: none` **sólo** donde el color
*es* el dato (data-viz), nunca en el chrome: ahí no es una excepción, es apagar la accesibilidad para
que la pantalla se vea como vos querías. *(Medido 2026-10-02: `forced-colors` tenía **0 usos** en todo
el repo, igual que `prefers-contrast` y `prefers-reduced-transparency`.)*

**13. Interacción resiliente** (captura, concurrencia, lote, dinero): estado sucio + `CanDeactivate`/`beforeunload`; frescura ("hace N min") + refresh local + scroll anclado en inserts vivos; fallos parciales tabulares (fallidos siguen seleccionados); todo botón que muta DB se auto-deshabilita **síncrono** al 1er clic; Tesler (no esconder lo vital) · Miller (chunking >6 campos / SKU) · Poka-yoke · keyboard-first. → [Leyes de interacción + arquitectura resiliente](#leyes-de-interacción--arquitectura-de-interacciones-resilientes-binding).

**14. Layout por sector + ayuda contextual.** El layout lo dicta el **sector**, no el componente: Fiscal/Contable → **master-detail permanente** (nunca modal para leer doc extenso); Almacén/Compras → **full-width grid** + totales congelados + sidebar colapsable + offline/frescura prominentes; Mostrador/POS → **keyboard-first**, foco permanente en captura, total/cobro dominan, feed al tope (la bandeja auditable SÍ pagina). Pantalla con reglas de negocio estrictas → **`<app-context-help>`** desde diccionario versionado, no texto inventado. → [Arquitectura de layouts por sector](#arquitectura-de-layouts-por-sector--ayuda-contextual-binding).

**15. Jerarquía + comprensión (interfaces de MUCHOS valores).** En pantallas densas en cifras (tablas de conciliación, KPIs, ledger, existencia, egresos, pólizas) el riesgo #1 no es el estilo — es que no se entienda qué se mira: **answer-first** (veredicto/resumen primero; el grid crudo al drill-down) · cada número no trivial con su **lectura en llano** al lado · las diferencias **señalan la fila exacta**, no solo el total · todo dato accionable es **navegable a su arreglo** (con el filtro puesto) · jerarquía por **tipo+contraste, no por color** · color de grupo determinista + leyenda + nunca único portador · abouts (regla P) donde haya jerga. → [Jerarquía visual + comprensión del dato](#jerarquía-visual--comprensión-del-dato-interfaces-densas-en-valores--binding).

**16. Plataforma antes que JS + cascada en capas.** Overlay/tooltip/hovercard **nuevo** = Popover API + anchor positioning con `@supports` (no librería de posicionamiento ni cálculo en JS). CSS nuevo entra en su `@layer`; `!important` requiere justificación en review y `::ng-deep` es **solo** para vendor y con comentario. Nada de esto es requisito de render: la feature moderna es **mejora progresiva** — en el Android de gama baja del campo la pantalla funciona sin ella. → [§S / §T](#plataforma-web-moderna--cascada-responsividad-overlays-motion-nativo-binding).

**17. Presupuesto de interacción (INP < 200ms).** En vistas densas (tablas, filtros, bandejas, conciliación) la latencia de respuesta es **criterio de aceptación**, no tarea de perf posterior: se mide, no se estima. Palancas: virtualización, `content-visibility: auto`, `@defer` en bloques pesados (charts/mapas), ceder el hilo en handlers de filtro. Un filtro que tarda 400ms en pintar es un **defecto de diseño**. → [§V](#plataforma-web-moderna--cascada-responsividad-overlays-motion-nativo-binding).

**18. Superficies con IA = contrato de confianza.** Toda acción sugerida o ejecutada por un motor/agente (Maat, Thot, Horus, hallazgos, canasta, requisiciones) expone las cinco: **plan antes de ejecutar** · **razón en llano** ("porque X, propongo Y") · **confianza visible** · **reversa o ventana de reversa explícita** · **ruta de escalación** ("no sé / decide un humano"). El motor decide, el agente comunica, el LLM nunca escribe cifras. → [§X](#superficies-con-ia--contrato-de-agentic-ux-binding).

---

## Estado de cumplimiento — lo que el doc manda vs. lo que el código hace

> **Última verificación contra el código: 2026-10-03.** Método: `grep` sobre `apps/` + `libs/`, excluyendo `node_modules`. **Toda cifra de este documento lleva la fecha en que se midió** — una cifra sin fecha es una foto vencida, y este doc ya publicó cuatro.
>
> ⭐ **Y desde el 2026-10-03 lleva también su COMANDO.** La auditoría del 2026-10-02 intentó
> reproducir tres cifras de esta tabla —*171 hex*, *76 `<th>` vacíos*, *55 veces BINDING*— y **no
> pudo**: la tabla publicaba el número sin decir sobre qué conjunto de archivos ni con qué patrón.
> (Para «BINDING» hoy se mide 26 en mayúsculas sueltas y 81 contando los anclas de los enlaces;
> ninguno de los dos da 55.) **Una cifra que sólo puede re-medir quien la escribió no es una
> medición, es una afirmación** — justo lo que ADR-056 existe para evitar. La tabla del
> [inventario de componentes](#inventario-de-componentes-compartidos) ya publicaba su `grep`: ésa
> es la práctica; el resto la copia.
>
> **Para qué sirve esta sección:** el doc marca BINDING decenas de veces y dice *"se verifica en
> review"*, y el review no alcanza — el ⛔ más citado de esta tabla (`MetricStrip` animando `width
> 900ms` en 81 pantallas) vivió **tres semanas** después de quedar escrito acá. Por ADR-056,
> *un gate sin prueba negativa es una intención*. Antes de citar una regla como cumplida, mirá acá.
>
> 🔸 **Corregida una afirmación de esta misma sección (2026-10-03):** decía *"el CI no corre ni un
> check de diseño"*. **Es falso desde hace semanas.** El job `verify` corre `check:templates`,
> `check:tables` y `check:tokens`, **cada uno con su prueba negativa en un paso aparte**, y
> `gate-push` suma `check:teclado` y `check:busqueda`. Hoy son **cinco** con `check:motion` y
> `check:estilos`.
>
> 🔸 **Y una corrección a lo que esta misma sección dijo el 2026-10-02.** Decía que lo que faltaba
> era **stylelint**, y la medición lo desmintió al ir a instalarlo:
>
> | | en archivos `.css` | dentro de `styles:` en `.ts` |
> |---|---|---|
> | `font-size` | 608 | **5,023 (89%)** |
> | hex crudo (`apps/view`) | 69 | **1,304 (95%)** |
> | archivos | 28 `.component.css` | **337 componentes** |
>
> **El CSS de este repo no vive en archivos CSS.** Vive dentro de template literals en el decorador
> `@Component`, que no es styled-components ni lit — ni `postcss-lit` lo toma limpio. Stylelint de
> fábrica habría visto **~1 de cada 10 defectos** y cobrado una dependencia nueva (más su sintaxis
> custom) por esa décima parte, justo con la decisión de PrimeNG abierta. Lo que sí había:
> `check-template-literals.js` **ya extraía esos bloques** con el compilador de TypeScript. Las
> cuatro reglas viven en [`check-estilos.js`](scripts/check-estilos.js), reusando ese camino:
> **100% de cobertura, cero dependencias**. *La herramienta correcta depende de la forma del
> código, no de su reputación.*

**Lo que SÍ se cumple** (y no hay que tocar):

- **Tokens: una sola [`tokens.css`](libs/design-tokens/tokens.css)**, sin copias en `apps/*`. La consolidación de ago-2026 se sostiene.
- **Disciplina tipográfica — la regla mejor cumplida del sistema:** Fraunces / Inter / JetBrains fuera de las 3 apps, y `--font-display`/Poppins con **0 fugas** a `apps/view` y `apps/vendor`.
- **GSAP 100% por `import()` lazy**, plugins incluidos (`cart-fx.service.ts`, `portal-login`, `portal-shell`, `portal-cart`, `portal-catalog`, `portal-order-detail`).
- **Neutrales: UNA sola familia en toda la suite.** Zinc (PrimeNG Aura) en las 3 apps y en los dos modos, desde el 2026-09-14. Ya no hay texto de una familia sobre superficie de otra —que era el bug de fondo— ni dos rampas que puedan divergir. `tabular-nums` con 577 usos ✓ · los 8 docs satélite enlazados existen todos ✓.

**Deuda declarada, medida y abierta** (⛔ = viola una regla marcada BINDING):

| # | Regla | 09-14 | **2026-10-03** | Dónde |
|---|---|---|---|---|
| 1 | ⛔ §S cascada en capas | `@layer` 0 · `!important` 961 · `::ng-deep` 370 | **`@layer` 0 · `!important` 1,034 (+7.6%) · `::ng-deep` 439 (+18.6%)** | todo el repo |
| 2 | ✅ §Motion techo 350ms | *"19 por encima"* | **0 en Operations**, en las dos notaciones. ⚠️ Y la cifra vieja estaba **mal medida**: contaba sólo `ms`. Sumando `.5s`/`.7s`/`0.8s` eran 40+, y la compuerta encontró **40 más** que el barrido manual tampoco veía (la duración va **después** del nombre del keyframe). Cerrado con `npm run check:motion` en CI | [`check-motion.js`](scripts/check-motion.js) |
| 2b | ⚠️ §Motion sólo `transform`/`opacity` | — | **48 `transition` sobre propiedades de layout**, declaradas con tope: la compuerta frena si crecen. Las 48 se revisaron una por una, **cero falsos positivos** | `[DS.1]` |
| 3 | ✅ §Motion KPI 1/7 | `MetricStrip` `width 900ms` en 64 archivos | **Arreglado.** El bullet anima `transform: scaleX()`; la barra de composición no se pudo (hermanos flex de una fila) y **queda declarada con su razón**, a 250ms. Adopción: **81 archivos** | [`metric-strip.component.ts`](apps/view/src/app/shared/components/metric-strip/metric-strip.component.ts) |
| 4 | ✅ Anti-slop #1 (morado IA) | `#8b5cf6` vivo en 2 pantallas | **Arreglado** (entre el 09-14 y hoy): `promotions-meta.ts` usa `var(--chart-N)`. El hex sólo sobrevive **dentro del comentario** que explica por qué se fue | [`promotions-meta.ts`](apps/view/src/app/modules/comercial/promotions-meta.ts) |
| 5 | ⚠️ §R breakpoints en `rem` | 169 px / 26 rem | **205 en px, congelados con tope** por `check:estilos`. Dejan de crecer; bajan cuando alguien los baje | todo el repo |
| 6 | ⚠️ pre-vuelo 2 "cero hex crudo" + 12b (dark) | *171 decls / 40 archivos* | **1,449 declaraciones, congeladas con tope** por `check:estilos` (medido sobre `apps/`+`libs/`, exentos `tokens.css`, el preset de Aura y `#fff`/`#000`, que 12b permite). ⚠️ **No es comparable con los 171 de antes**: aquella cifra no publicaba su patrón ni su universo. Se deja el número con su comando, **no se finge la serie** | todo el repo |
| 6a | ⛔ D.0 alineación de tabla | 52 clases propias vs 41 con `.num` | **140 archivos usan `.num`** (otro universo: cuenta archivos, no clases inventadas). Pendiente re-medir el lado de las clases propias con un patrón publicado | todo el repo |
| 6b | ⚠️ Escala tipográfica (`--fs-*`, ESTRICTA) | 97 tamaños distintos · 38% adopción | **3,161 `font-size` con literal, congelados con tope** por `check:estilos` — que además **imprime la equivalencia** de cada literal con el token más cercano, porque ⭐ **no falta un peldaño: ninguno de los 9 literales top está a más de 0.5px de un token que ya existe.** Era la regla binding con peor cumplimiento del sistema; ahora al menos deja de empeorar | todo el repo |
| 7 | §Motion adopción de tokens | 27 de 270 = 10% | **47 `var(--dur-*)`** (+74%) — subió por el barrido `[DS.1]`, no solo | todo el repo |
| 8 | `surf-table--zebra` neutralizada | 35 plantillas | **39 (+4)** | 39 plantillas |
| 9 | Capa atómica (hallazgo #1 de 2026-06-04, sigue ⬜) | 133 selectores de botón | sin re-medir | `apps/portal`, `apps/vendor` |
| 10 | `motion@^12.38.0` | dep muerta, 0 imports | **sigue**, y la razón es más filosa de lo que decía: **está en `package-lock.json` y el CI corre `npm ci`** — sacarla sólo de `package.json` rompe el `npm ci` **de todos** (`not in sync`). Necesita `npm install` para regenerar el lock, que es una operación deliberada (red, ~60k archivos, puede arrastrar otras versiones), no el borrado de una línea | `package.json` + lock |
| 11 | ⛔ **`forced-colors` = 0 en todo el repo** *(hallazgo nuevo 2026-10-02)* | — | **Cerrado el 2026-10-03** con [`forced-colors.css`](libs/ui-web/src/forced-colors.css) en las 3 apps. La flota es Windows y este sistema es el que peor se lleva con Alto Contraste: hairline + alpha-overlays + semáforo por fondo = hover/seleccionado/normal **colapsan en lo mismo**, y el anillo de foco hecho con `box-shadow` **desaparece** | `libs/ui-web` |
| 12 | ✅ **El papel tiene régimen — cerrado 2026-10-03** | 7 `@media print` y **cero** menciones en el doc | [`print.css`](libs/ui-web/src/print.css) en las 3 apps + regla **12c** del pre-vuelo. Cuatro decisiones: el papel es **claro siempre** (el oscuro es preferencia de PANTALLA), el **chrome no se imprime**, la tabla **repite encabezado y no parte renglones**, y el **semáforo SÍ se imprime** (`print-color-adjust: exact`: si el color es el dato, quitarlo deja una hoja que no dice lo que decía la pantalla). ⚠️ **No toca los tickets ni los exports**: ésos abren ventana propia y no cargan este `styles.css` | `libs/ui-web` |
| 13 | ✅ **INP se mide en `apps/view` — cerrado 2026-10-03** | `web-vitals` sólo en el portal | `UsoService.medirWebVitals()` manda **INP · LCP · CLS** por el canal que ya existía (`POST /telemetry/suite`, autenticado). ⭐ **No hubo que construir nada**: el endpoint, el servicio y la librería ya estaban — faltaba la llamada. Carga por `import()` perezoso y hereda el "dispara y olvida". ⚠️ **Lo que se mide es la RUTA, no el promedio**: un INP global no dice nada en una suite con `/projects` y `/compras/pedido` en la misma app | [`uso.service.ts`](apps/view/src/app/core/services/uso.service.ts) |
| 14 | ⚠️ **`--action-ink` 3.39:1** — declarado el 09-14, sin dueño ni fecha | — | **Verificado independientemente: 3.39:1 es correcto** (y `#D2451C` da 4.56:1). Lleva **19 días** «declarado». *Declarar no es un estado terminal: sin dueño y sin fecha, un defecto declarado se vuelve mobiliario* | decisión de Edgar |
| 15 | ✅ **Anillo de foco — cerrado el 2026-10-03** | — | Eran **37 controles sin anillo** (27 + **10 que el primer criterio de la compuerta escondía**) y **103 anillos por debajo del piso de contraste**. Hoy: **0 sin anillo** y **189 anillos que pasan 3:1**. ⭐ **24 de los 37 eran CAMPOS DE ENTRADA**: los dos de escaneo (andén, etiquetas), el **login de las dos apps**, los steppers del vendedor, el **verificador de mostrador**, los tabs de PrimeNG en las 3 apps, y **los buscadores que D.7 acaba de volver navegables con teclado** — la ruta existía y era invisible. Lo mide `check:estilos` con **tope 0**: un `outline:none` nuevo sin anillo es rojo | [`check-estilos.js`](scripts/check-estilos.js) |
| 16 | ✅ **Contrato de data-viz — cerrado 2026-10-03** | sólo existían `--chart-1..8` | **§G, nueve reglas.** Una paleta evita que dos series se parezcan; **no evita que la gráfica diga algo falso**. Eje de barra desde cero · hueco ≠ cero · color de serie determinista y nunca único portador · truncar se declara ("10 de 428 · 62%") · micro-viz SVG 0 KB · frescura también en la gráfica | §G |

**Los comandos** (para que cualquiera pueda contradecir estas cifras, que es el punto):

```bash
SRC=$(find apps libs -type f \( -name "*.ts" -o -name "*.html" -o -name "*.css" \) ! -path "*/node_modules/*")
echo "$SRC" | xargs grep -o "!important"  | wc -l            # 1 — !important
echo "$SRC" | xargs grep -o "::ng-deep"   | wc -l            # 1 — ::ng-deep
echo "$SRC" | xargs grep -o "@layer "     | wc -l            # 1 — capas de cascada
npm run check:motion                                          # 2, 2b, 3 — techo y deuda de layout
echo "$SRC" | xargs grep -oE "@media[^{]*\((max|min)-width:\s*[0-9.]+px" | wc -l   # 5 — breakpoints px
VIEW=$(find apps/view -type f \( -name "*.ts" -o -name "*.html" -o -name "*.css" \))
echo "$VIEW" | xargs grep -oiE "(color|background|background-color|border-color|fill|stroke|box-shadow)\s*:\s*[^;]*#[0-9a-f]{3,8}" | wc -l   # 6 — hex crudo
echo "$VIEW" | xargs grep -ohE "font-size:\s*[0-9.]+(rem|px|em)" | grep -oE "[0-9.]+(rem|px|em)" | sort -u | wc -l   # 6b — tamaños distintos
echo "$SRC" | xargs grep -o "forced-colors" | wc -l           # 11
echo "$SRC" | xargs grep -o "@media print" | wc -l            # 12
```

**La lectura de fondo, confirmada con 19 días más de evidencia:** las que empeoraron (#1, #5, #6b, #8)
son **todas** mecánicamente medibles y **ninguna** tiene instrumento. Las que se arreglaron
(#2, #3, #4, #11) se arreglaron cuando alguien las miró a propósito — y #2 sólo se queda arreglada
porque ahora hay una compuerta. **Regla con un solo lugar donde vive + instrumento que la mida.**

✅ **Cerrado el 2026-10-03:** las cuatro reglas que faltaban viven en
[`check-estilos.js`](scripts/check-estilos.js) (#5, #6, #6b, #15). Son un **ratchet**, no un muro:
cada una arranca con la deuda de hoy congelada y **frena cuando crece**. Con 3,161 literales de
`font-size` vivos, una compuerta absoluta estaría roja para siempre y en la primera corrida enseñaría
a ignorarla — que es exactamente cómo se perdió `check-keyboard-nav` el día que marcó 7 falsos de 8.
La deuda baja cuando alguien la baja, y el tope se actualiza en ese mismo commit.

⛔ **Lo que sigue sin instrumento es #1** (`@layer` = 0, `!important` 1,034, `::ng-deep` 439), y a
propósito: ahí no hay número que congelar, hay una **migración** — declarar el orden de capas y mover
los overrides adentro. Es la deuda más grande del sistema y la única que no se arregla con un ratchet.

⭐ **Y una lección de método que esta ronda dejó clara:** `check:motion` encontró **40 declaraciones
que tres barridos manuales con `grep` no vieron**, porque en `animation: nombre 0.6s ease` la duración
no está donde uno la busca. *El instrumento no es sólo para que no vuelva: ve lo que el barrido no ve.*

---

## Arquitectura de tokens (3 tiers + interacción + densidad por puntero)

Implementado 2026-06-24 en [`tokens.css`](libs/design-tokens/tokens.css). Regla: **un componente nuevo referencia un rol/token, nunca inventa un hex.**

- **Tier 1 — Primitivas** (valor crudo, sin significado): rampa `--stone-50..950`, `--brand-*`, paleta cruda. No usar directo en componentes.
- **Tier 2 — Semánticos/rol** (qué significa): `--action`/`--action-hover/press`, `--ok/warn/bad/info-*`, superficies (`--card-bg`, `--border-color`, `--text-1/2/3`), y la **capa de interacción por alpha-overlay**: `--overlay-hover` / `--overlay-active` / `--overlay-selected`, derivados de **`--ink-rgb`** (la tinta del overlay; **se voltea por modo** — light=stone-950, dark=stone-50 — así una sola definición sirve en ambos temas).
- **Tier 3 — Componente** (valor exacto por elemento; cambiar el look de un componente = tocar SU token, sin efectos colaterales): `--table-row-hover-bg`, `--table-row-selected-bg`, `--surface-hover-bg/active/selected`, `--btn-primary-bg/-hover/-press/-ink`. (`--table-hover` quedó repuntado a `--overlay-hover`.)
- **Estados de superficie** = **alpha overlays** sobre `--ink-rgb`, no hex por interacción → consistencia garantizada en cualquier fondo y en dark sin segunda definición.
- **Spacing — escala 4px** (`--sp-1`=4 … `--sp-12`=48, en rem para respetar zoom). Es el **único origen** de paddings/gaps/margins de layout; nada de rem sueltos fuera de grid. Excepciones legítimas: 1px (bordes/hairlines) y micro-nudges <4px en chips/badges. La tipografía tiene su propia escala (`--fs-*`).
- **Densidad por método de entrada** (Polaris/Carbon): la densidad la decide el **puntero**, no el surface. `@media (pointer: coarse)` sube `--row-h-sm/md` y `--tap-min` a **≥44px** (Ley de Fitts en touch / `apps/vendor` Capacitor); `pointer: fine` mantiene ultra-compacto. Hit areas táctiles aplicadas en `styles.css` sin tocar componentes.
- **Data-viz**: secuencia categórica `--chart-1..8` (light+dark), ordenada por separación perceptual, **sin morado** (`--chart-3` es verde). El color codifica dato → exenta de la regla monocromática.
- **Diferido**: SSOT JSON + Style Dictionary (export web/Tailwind/Android nativo) — se monta cuando la divergencia multiplataforma realmente lo exija; por ahora puente manual de los ~4 colores que la status-bar/splash de Capacitor necesita.
  - **Actualización ago-2026 — ya hay estándar:** el **DTCG Format Module v2025.10** (W3C Community Group) es la primera versión **estable** y el toolchain se asentó (Figma Variables → DTCG JSON → Style Dictionary → CSS/`@theme`). Dirección aprobada como investigación, **no binding todavía**: `tokens.json` en DTCG pasa a ser la **fuente** y `tokens.css` un **artefacto generado**, con las rampas migradas a **OKLCH** (hoy son 100% hex → el dark se ajusta a ojo paso por paso). Backlog `DT.5` en [`docs/DESIGN_TECNOLOGIA_2026.md`](docs/DESIGN_TECNOLOGIA_2026.md). Mientras no se ejecute, **`tokens.css` sigue siendo la fuente de verdad** y se edita a mano.

## Surfaces — dos modes del mismo sistema

> **El surface lo decide la APP, no sólo la ruta** (corregido 2026-09-14: la tabla listaba `/vendor` y `/portal` como rutas de `apps/view`, y hace tiempo son apps propias).

| Surface | App | Alcance (raíces de ruta reales) | Mode | Decoración | Display font |
|---|---|---|---|---|---|
| **Storefront** | `apps/portal` | todo el portal B2B (se sirve en `/portal/*`) | storefront + tool | intencional (ilustraciones SVG, eyebrows) | Poppins + Hanken Grotesk + Geist Mono |
| **Operations** | `apps/view` | `/dashboard` · `/comercial` · `/finanzas` · `/contabilidad` · `/compras` · `/almacen` · `/tienda` · `/logistica` · `/admin` · `/telemarketing` (`/televenta` redirige) · `/reparto` · `/projects` · `/servicio` · **`/mkt`** · **`/presupuesto`** · **`/desarrolladores`** · **`/diagnostico`** | **solo tool** | nula | Hanken Grotesk + Geist Mono (+ Sniglet, **sólo** en la excepción `/tienda/verificador` → §O.3) |
| **Operations** | `apps/view` | **`/captura/:token`** — captura de gasto por link desde el celular, **sin sesión y sin guard** (GX.9) | **solo tool**, mobile-first | nula | Hanken Grotesk + Geist Mono |
| **Operations** | `apps/vendor` | app instalable del vendedor en campo (Capacitor) | **solo tool**, mobile-first | nula, **pero con radios propios** (ver abajo) | Hanken Grotesk + Geist Mono |

> 🔸 **Corregida contra `app.routes.ts` el 2026-10-03 — tenía cinco defectos y el doc conocía tres.**
> Faltaban `/mkt`, `/presupuesto`, `/desarrolladores` y **`/diagnostico`** (ésta no la había visto nadie),
> y sobraba **`/mi-trabajo`: no es una ruta.** La ruta es `/projects` y `mi-trabajo` es el nombre de la
> **carpeta del componente** — un renglón fantasma que le daba régimen a algo que no existe. También
> faltaba **`/captura/:token`**, que es el caso donde más importa: pública, sin sesión, en el celular de
> quien manda un gasto. *Una tabla que el paso 1 del pre-vuelo vuelve obligatoria no puede estar
> incompleta: manda la pantalla nueva a ningún régimen.*
>
> ⚠️ **Y `apps/vendor` NO es Operations a secas.** [`tokens.css`](libs/design-tokens/tokens.css) tiene un
> bloque `.vendor-shell` que **redefine los cinco radios** (10/14/18/22/26 contra los 8/12/16/20/24 del
> sistema) y suma `--v-hero-grad`, un degradado dorado. O sea que hay un **tercer régimen** vivo, con su
> propia geometría, y esta tabla decía *"Decoración: nula"*. Queda declarado acá hasta que se decida:
> **o se absorbe en el sistema (radios por densidad, no por app) o se nombra como surface propio.**

**Cómo se re-verifica esta tabla** (porque una tabla sin su comando sólo la puede revisar quien la escribió):

```bash
grep -nE "^ {0,6}path: '" apps/view/src/app/app.routes.ts | sed "s/.*path: '//;s/'.*//"
```

**⭐ Los neutrales son UNA SOLA FAMILIA en toda la suite** (decisión Edgar 2026-09-14): **Zinc de PrimeNG Aura**, en las 3 apps y en los dos modos.

| | Claro | Oscuro |
|---|---|---|
| ground | `#F4F4F5` (zinc-100) | `#09090B` (zinc-950) |
| card | `#FFFFFF` | `#18181B` (zinc-900) |
| borde | `#E4E4E7` (zinc-200) | `#27272A` (zinc-800) |
| texto 1/2/3 | `#09090B` · `#52525B` · `#A1A1AA` | `#FAFAFA` · `#A1A1AA` · `#71717A` |

`.portal-shell`/`.pl-wrap` **ya no pisan los neutrales** — heredan de `:root`. Sólo conservan propio su `--font-body`/`--font-mono` y la identidad IA ámbar (`--ai-accent`). **La rampa `--stone-*` se retiró** en el mismo commit: quedó con cero consumidores, y dejarla declarada invitaba a volver a partir el sistema. Está en git.

**La calidez de marca ya no vive en el sustrato: vive en `--brand-*`, `--action` (sunset) y `--ember-*`.** Ése es el cambio de tesis — el color de marca tiene que ganarse la pantalla por acento, no por fondo.

**Cómo mantener esta tabla honesta:** las raíces salen de [`apps/view/src/app/app.routes.ts`](apps/view/src/app/app.routes.ts) — `grep -nE "^    path: '" apps/view/src/app/app.routes.ts`. Si agregás un proyecto nuevo de primer nivel, **se agrega acá**: el paso 1 del pre-vuelo manda ubicar el surface en esta tabla, y una tabla incompleta manda a la pantalla nueva a ningún régimen.

Ambos surfaces comparten: **neutrales zinc, sunset `--action`, IA ember, escala de radios, tokens semánticos, tipografía de body y data**. Lo que **Operations** descarta: display font, ilustraciones, momentos editoriales, densidad comfortable.

La regla 1-línea: Operations es el portal pero sin storefront. Mismo lenguaje, menos drama.

---

## Inventario de componentes compartidos

> **Antes de construir una pieza de UI, buscá acá.** Todo vive en [`apps/view/src/app/shared/components/`](apps/view/src/app/shared/components/) (excepto `context-help`, en `shared/context-help/`). Re-estilar a mano lo que ya existe es el antipatrón #1 de Atomic Design y está flagueado en review.
> **Adopción = archivos que instancian el selector.** Re-medir con: `grep -rl "<app-metric-strip[ >]" apps --include=*.html --include=*.ts | wc -l`. La columna "ago-12" se conserva para ver la dirección.
> ⚠️ **Este repertorio sirve sólo a `apps/view`.** `apps/portal` y `apps/vendor` tienen **0 componentes compartidos** — ver el hueco declarado en §Ing.UI 5.

| Componente | Selector | Cuándo se usa | ago-12 | **2026-09-14** |
|---|---|---|---|---|
| **MetricStrip** | `app-metric-strip` | **Header de KPIs de una pantalla** (ADR-033): sin caja, hairline entre métricas, cifra mono con count-up. Modos `strip · spark · ring · bullet · composition` según la forma del dato | 50 | **64** |
| **MetricCard** | `app-metric-card` | **Tile rico individual** con su propia micro-viz (gauge/sparkline). Dashboards, no headers de página | 16 | **17** |
| **PageTabs** | `app-page-tabs` | Barra de tabs de un apartado, con gate por `permission` por tab | 46 | **50** |
| **TabShell** | `app-tab-shell` | Shell con tabs **ruteadas** (lee `data.tabs` de la ruta padre + `<router-outlet>`) | 0 | **0** ⚠️ nunca se usó |
| **ContextHelp** | `app-context-help` | Regla P: cajón de ayuda de negocio desde el **diccionario versionado**. Obligatorio donde hay jerga o reglas estrictas | 31 | **38** |
| **FreshnessPill** | `app-freshness-pill` | §9 datos añejos: "actualizado hace N min", pasa a warn tras `staleAfterSec`. Obligatorio en dato volátil | 15 | **26** |
| **LoadState** | `app-load-state` | §2 matriz de estados: separa `loading` / `empty` / `error` (mata el bug `error === empty`). Proyecta el contenido real | 12 | **22** |
| **SidePeek** | `app-side-peek` | §datos densos 8: drawer de detalle 480–560px sin perder la lista | 6 | **17** |
| **Segmented** | `app-segmented` | Segmented control canónico (radiogroup accesible). Reemplazó 3 implementaciones ad-hoc | 10 | **18** |
| **Map** / **MapLegend** | `app-map` · `app-map-legend` | Mapa Leaflet tokenizado + su leyenda | 11 / 4 | **11 / 4** |
| **MiniBars** | `app-mini-bars` | Micro-chart de columnas para cards. SVG/CSS puro, 0 KB de librería | 1 | **0** ⛔ sin usos |
| **Customer360Panel** | `app-customer-360-panel` | Drill-down compartido de cliente | 2 | **1** |
| **OfflineStatus** | `app-offline-status` | §PWA 5: estado de red visible en app instalable | 1 | **1** |

⛔ **Dos componentes compartidos con cero adopción** (`TabShell` nunca arrancó; `MiniBars` la perdió). Un componente en este inventario con 0 usos es peor que no tenerlo: se ofrece como camino canónico y nadie lo ejercita, así que nadie sabe si funciona. Decisión pendiente por cada uno: **adoptarlo o retirarlo** — no dejarlo listado como si estuviera vivo.

**Huecos conocidos** (no existe componente compartido — hoy se resuelve a mano en cada pantalla): formulario/campo, tabla (se usa `p-table` + clases `surf-table--*` de `styles.css`), empty-state genérico, badge/pill, stepper, search-bar. Extraerlos es backlog abierto.
> 🔸 **El de `search-bar` sigue abierto como COMPONENTE, pero su lógica ya no** (2026-10-01): el criterio de coincidencia vive en [`coincideBusqueda`/`filtrarPorBusqueda`](libs/ui-web/src/search/buscar-en-cliente.ts) y el salto al primer renglón en [`bajarAlPrimerRenglon`](libs/ui-web/src/keyboard/row-nav.ts). Quien extraiga el componente **los consume**, no los reescribe — si no, la 26ª pantalla vuelve a filtrar con `.includes()` (→ D.8).

---

## Tesis de diseño

Una herramienta de pedido mayorista que se siente como una **marca CPG mexicana premium**, no como un dashboard SaaS genérico. Resuelve el hueco que casi nadie ocupa: los gigantes B2B que la gente ama (McMaster-Carr, Uline) son utilitarios y rapidísimos pero feos; la nueva ola (Faire) es editorial y cálida pero lenta. **Mercado hace las dos cosas**, porque el comprador no es un agente de compras — es un dueño de dulcería (prosumer) que quiere sentir que por fin tiene una herramienta seria.

**Lo memorable, ordenado por jerarquía** (no los tres con el mismo peso — eso sería memorable por nada):
1. **Velocidad = la columna.** Pantallas transaccionales densas, instantáneas, teclado-first (la lección McMaster).
2. **Premium = la textura.** Tipografía y calidez hacen ver pro a un changarro. Momentos editoriales solo en home/promos (la lección Faire).
3. **IA = el acento.** El diferenciador real, con identidad visual propia (**ember ámbar**) — nunca el morado genérico de la industria.

### Regla de dos modos (define todo)
- **Tool mode** (catálogo, carrito, pedidos): denso, escaneable, compacto. Body bold, cifras tabulares, naranja-acción.
- **Storefront mode** (home, promos, login): editorial, con aire, Poppins display (sans geométrica), ilustración.

---

## Product Context
- **Qué es:** portal de autoservicio B2B donde una dulcería/tienda inicia sesión, ve el catálogo con SU lista de precios, busca (texto o IA semántica), recibe recomendaciones IA, arma carrito y hace/seguimiento de pedidos con estado en tiempo real.
- **Para quién:** dueños de pequeños comercios de dulces en México (prosumers, no compradores profesionales). Mobile-first (Capacitor) y desktop.
- **Espacio:** wholesale ordering / B2B e-commerce. Peers de referencia: McMaster-Carr y Uline (velocidad utilitaria), Faire (editorial branded), Pepperi/Wizcommerce (order-taking).
- **Tipo:** web app transaccional con superficies editoriales.

---

## Aesthetic Direction
- **Dirección:** Warm Editorial Utilitarian ("Mercado").
- **Nivel de decoración:** intencional — gradientes cálidos, ilustraciones SVG propias de dulces (mantener: son originales y encantadoras), sin fotos stock.
- **Mood:** cálido, confiado, rápido. "Mi herramienta de trabajo, y se ve bien."
- **Anti-slop (prohibido):** morado/violeta para IA, gradientes morados, grids de 3 features con íconos en círculos de color, todo centrado, fotos stock genéricas, `system-ui` como display.

---

## Typography

**Cada app carga SU propio `<link>` de Google Fonts — no hay uno global** (verificado 2026-09-14). Lo que sirve cada una:

| App | Familias que descarga | Nota |
|---|---|---|
| [`apps/portal`](apps/portal/src/index.html) | Poppins · Hanken Grotesk · Geist Mono | la única con display font |
| [`apps/view`](apps/view/src/index.html) | Hanken Grotesk · Geist Mono · **Sniglet** | Sniglet es **sólo** para `/tienda/verificador` (excepción §O.3), no está en ningún token |
| [`apps/vendor`](apps/vendor/src/index.html) | Hanken Grotesk · Geist Mono | |

⛔ **No copies el `<link>` del portal a otra app**: le metés Poppins a Operations y rompés la regla display (storefront-only). Si agregás una familia, va en el `<link>` de *esa* app y se declara en esta tabla.

- **Display/Hero:** **Poppins** (sans geométrica redondeada — look "delivery app" tipo Rappi). Pesos 500/600/700/800. Solo en **storefront mode**: hero h1, section heads, empty states, títulos de promo, monogramas. **Nunca** en tablas/UI densa. *(Cambiado de Fraunces serif → Poppins el 2026-06-24, decisión de marca: identidad táctil tipo Rappi sobre editorial.)*
- **Body/UI:** **Hanken Grotesk** (reemplaza a Inter) — grotesca redonda, cálida, amigable, muy legible. Pesos 400/500/600/700/800.
- **Data/Tablas/Code:** **Geist Mono** (reemplaza a JetBrains Mono) — SKUs, códigos de pedido, precios en columna, atajo `⌘K`. **Obligatorio `font-variant-numeric: tabular-nums`** en todo lo que sea dinero o cantidad.
- **Por qué:** Inter es el default de convergencia. Poppins (display) + Hanken Grotesk (body) dan el carácter geométrico-cálido de las apps de delivery, sin serif. Poppins NO se usa en Operations (sigue tool-only).
- **Escala display** (clamp responsive, ya en tokens):
  - `--text-display-xl: clamp(2.5rem, 7vw, 3.5rem)` — hero h1
  - `--text-display-lg: clamp(1.875rem, 4.5vw, 2.5rem)` — section feature
  - `--text-display-md: clamp(1.375rem, 3vw, 1.625rem)` — card title
- **Escala UI:** 0.7 / 0.75 / 0.8125 / 0.875 / 0.9375 / 1 / 1.125rem. Tool mode tira hacia abajo; storefront hacia arriba.

```html
<!-- apps/portal/src/index.html — ÚNICA app con Poppins -->
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700;800&family=Hanken+Grotesk:wght@300;400;500;600;700;800&family=Geist+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">

<!-- apps/view + apps/vendor (Operations) — SIN display font -->
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@300;400;500;600;700;800&family=Geist+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
```
```css
--font-display: 'Poppins', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
--font-body:    'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
--font-mono:    'Geist Mono', ui-monospace, 'Courier New', monospace;
```

---

## Color

Mantiene la calidez de marca Mega Dulces, pero **reasigna los roles**: el amarillo deja de ser "primary de acción" (no puede llevar texto blanco — el propio token lo admite) y pasa a ser sello de marca; el **naranja-sunset toma la acción**.

### Brand ramp (cálido — se conserva)
```css
--brand-50:#FFFEF0; --brand-100:#FFF8BC; --brand-200:#FEEC7C; --brand-300:#FDE044;
--brand-400:#FDE707; /* SELLO de marca — momentos, logo, pulsos "live". NUNCA bg de botón con texto. */
--brand-500:#F8B400; --brand-600:#F68F1E;
--brand-700:#F05A28; /* SUNSET */
--brand-800:#C53E15; --brand-900:#8C2308; --brand-950:#4B1300;
```

### Acción (color interactivo — NUEVO rol)
```css
--action:       #F05A28;            /* botones, links, foco, steppers, "+" */
--action-hover: #D2451C;
--action-press: #B83C15;
--action-ink:   #FFFFFF;            /* texto sobre --action — ver nota de contraste abajo */
--action-ring:  rgba(240,90,40,0.30);   /* HALO — sólo para box-shadow */
--focus-ring:   var(--action);          /* ANILLO — sólo para outline */
```

> ⚠️ **Son DOS tokens porque son DOS roles, y confundirlos costaba 103 anillos de foco**
> (medido y corregido el 2026-10-03). `--action-ring` nació como **halo**: un resplandor
> translúcido alrededor del control, que es exactamente lo que `box-shadow: 0 0 0 3px ...` quiere.
> Pero se lo empezó a usar como color de **`outline`**, y ahí un 30% de alpha no funciona: el
> outline no se difumina, se dibuja encima, y a ese alpha queda en **1.44:1 sobre tarjeta clara**
> contra el piso de **3:1** que §datos densos 13 y WCAG 1.4.11 exigen para un indicador de foco.
>
> | Fondo | `--action-ring` 30% | `--focus-ring` sólido |
> |---|---|---|
> | tarjeta clara `#FFFFFF` | 1.44:1 ⛔ | **3.39:1** ✓ |
> | ground claro `#F4F4F5` | 1.41:1 ⛔ | **3.08:1** ✓ |
> | tarjeta oscura `#18181B` | 1.52:1 ⛔ | **5.23:1** ✓ |
> | ground oscuro `#09090B` | 1.48:1 ⛔ | **5.87:1** ✓ |
>
> **La regla: `outline` → `--focus-ring` · `box-shadow` → `--action-ring`.** Al 2026-10-03 hay
> **189 anillos** de `outline` y los 189 pasan 3:1; los **25** halos de `box-shadow` siguen con el
> translúcido, que ahí es correcto.
>
> ⚠️ **Nota de precisión, porque el número confunde:** 3.39:1 es **el mismo** contraste que hace
> fallar a `--action-ink` (blanco sobre sunset) más arriba en esta sección, y acá **pasa**. No es
> contradicción: un **indicador de foco** pide 3:1 y un **texto** pide 4.5:1. Mismo contraste, dos
> pisos, dos veredictos. *Citar un ratio sin su piso no dice nada.*
Regla: amarillo `#FDE707` solo con texto oscuro (`--stone-950`), nunca blanco.

> ⚠️ **Corrección medida 2026-09-14 — el comentario `(AA OK)` que llevaba `--action-ink` era falso.** Blanco sobre `--action` da **3.39:1**, que es AA **sólo para texto grande** (≥18.66px bold o ≥24px). La mayoría de nuestros CTA son de 13–14px → **no cumplen AA a tamaño normal**. No se cambió nada todavía porque tocar `--action` mueve la marca entera; queda **declarado, no disfrazado** (ADR-056). Salidas posibles cuando se decida: oscurecer `--action` a ~`#D2451C` (el `--action-hover` actual, que da 4.5:1), subir el label del botón a ≥16px bold, o aceptar el riesgo por escrito. Lo que NO vale es seguir escribiendo "AA OK" al lado.

### Neutrales — UNA sola familia: Zinc de PrimeNG Aura (decisión 2026-09-14)

> ⚠️ **Una rampa para las 3 apps y los dos modos. No hay rampa por surface.** El día que se decidió esto se pasó por un estado intermedio de *dos* familias (Operations zinc / Storefront stone) y se cerró el mismo día en una sola: dos rampas paralelas son dos cosas que pueden divergir, y este archivo ya tiene la cicatriz de esa divergencia en su cabecera (consolidación 2026-08-12). **Nunca mezcles hexes de una paleta con superficies de otra** — ése es el bug que originó todo el cambio (ver Decisions Log).

**Las 3 apps — Zinc de PrimeNG Aura.** Es lo que `--neutral-*` sirve en `:root`, sin overrides por surface:
```css
--neutral-50:#FAFAFA; --neutral-100:#F4F4F5; --neutral-200:#E4E4E7; --neutral-300:#D4D4D8;
--neutral-400:#A1A1AA; --neutral-500:#71717A; --neutral-600:#52525B; --neutral-700:#3F3F46;
--neutral-800:#27272A; --neutral-900:#18181B; --neutral-950:#09090B;
/* oscuro (body.theme-monochrome) — los mismos pasos, invertidos */
--layout-bg:#09090B; --card-bg:#18181B; --border-color:#27272A;
--text-main:#FAFAFA; --text-muted:#A1A1AA; --text-faint:#71717A;
```
> ⚠️ **Aura por default NO es zinc en claro: es slate.** Se probó slate tal cual el 2026-09-14 y se revirtió el mismo día. **Zinc se fija a mano** en `tokens.css` y también en `semantic.colorScheme.light.surface` de [`operations-preset.ts`](apps/view/src/app/core/theme/operations-preset.ts) — si sólo tocás uno de los dos, el chrome de la página y los componentes PrimeNG (panels, overlays, dialogs, inputs) quedan en familias distintas.

**⭐ La lección, que vale para cualquier rampa futura: lo que tiñe una pantalla NO es el fondo, es el chrome.** El croma de slate crece rápido bajando la rampa — ground 0.0069 → borde 0.0126 → texto faint 0.0351 (**5× el ground**). Los bordes de las cards, los iconos y el texto secundario cubren mucha más superficie visual que el fondo, así que mandan ellos: el ground era casi neutro y aun así la pantalla se leía azul. **Al elegir neutrales, mirá los pasos 200–600, no el 100.**

**⛔ La rampa `--stone-*` se RETIRÓ** (2026-09-14). Quedó con cero consumidores cuando el portal dejó de pisar sus neutrales, y una rampa declarada sin usar invita a volver a partir el sistema en dos. Está en git si hace falta.

**Qué pasó con la tesis "el sustrato cálido mata el frío SaaS":** se sostiene, pero **cambió de portador**. La calidez ya no la da el fondo — la dan `--brand-*`, `--action` (sunset) y `--ember-*`. El color de marca tiene que ganarse la pantalla por **acento**, no por sustrato. En el Storefront eso se refuerza además con Poppins, las ilustraciones y la densidad comfortable, que Operations no tiene.

**Dos reglas que salen de esto y valen para cualquier surface futura:**

1. **El texto pertenece a la familia de la superficie que lo sostiene.** Texto cálido sobre superficie neutra —o al revés— se percibe como un tinte que ninguno de los dos tiene: es contraste simultáneo, y fue exactamente la causa del "se ve zinc".
2. **Lo que tiñe una pantalla no es el fondo, es el chrome.** Al elegir o juzgar una rampa, mirá los pasos **200–600** (bordes, iconos, texto secundario), no el 100. El ground de slate era casi neutro y aun así la pantalla se leía azul.

### IA — Ember (mata el `#8b5cf6` morado)
```css
--ember-from:  #F8B400;
--ember-to:    #F05A28;
--ember-grad:  linear-gradient(135deg, #F8B400 0%, #F05A28 100%);
--ember-soft:  rgba(248,180,0,0.12);   /* dark: 0.16 */
--ember-border:rgba(240,90,40,0.30);
```
Toda superficie de IA (búsqueda semántica, chips "Sugeridos IA", recomendaciones, scores de relevancia, FAB asistente) usa el gradiente ember + un sello ✦. La IA se vuelve reconocible de un vistazo **y** on-brand.

### Semánticos
```css
--ok-fg:#16A34A; --ok-soft-bg:#DCFCE7; --ok-soft-fg:#166534; --ok-border:#BBF7D0;
--warn-fg:#D97706; --warn-soft-bg:#FEF3C7; --warn-soft-fg:#92400E; --warn-border:#FDE68A;
--bad-fg:#DC2626; --bad-soft-bg:#FEE2E2; --bad-soft-fg:#991B1B; --bad-border:#FECACA;
--info-fg:#2563EB; --info-soft-bg:#DBEAFE; --info-soft-fg:#1E40AF; --info-border:#BFDBFE;
```

### Superficies — LIGHT

> 🔸 **Corregido 2026-10-03.** Este bloque apuntaba a **`var(--stone-*)`**, la rampa que este mismo
> documento declara retirada el 2026-09-14 — dos párrafos más arriba. Verificado: `--stone-` sobrevive
> en `tokens.css` sólo dentro de **tres comentarios**, con **cero consumidores**. O sea que quien copiara
> de acá escribía un `var()` que **no resuelve**, y una propiedad personalizada indefinida sin respaldo
> **tira la declaración entera** en el navegador, sin que el build diga nada (lo frenaría `check:tokens`,
> que existe justamente por esto). *Un ejemplo que no funciona se copia igual que uno que sí.*

```css
--surface-ground: var(--neutral-50);
--card-bg:        #FFFFFF;
--layout-bg:      var(--neutral-100);
--hover-bg:       var(--neutral-100);
--border-color:   var(--neutral-200);
--text-main:  var(--neutral-950);
--text-muted: var(--neutral-600);
--text-faint: var(--neutral-400);
```

### Dark mode — zinc (una sola definición para las 3 apps)
`body.theme-monochrome`:
```css
--layout-bg:#09090B; --surface-ground:#111113; --card-bg:#18181B;
--hover-bg:#27272A; --border-color:#27272A;
--text-main:#FAFAFA; --text-muted:#A1A1AA; --text-faint:#71717A;
--ink-rgb: 250, 250, 250;   /* la tinta se voltea: los overlays recalculan solos */
--ember-soft: rgba(248,180,0,0.16);
```
Sigue sin ser `#000` puro (`#09090B` es zinc-950), así que la objeción original —negro puro se ve duro/barato— queda cubierta. **El espresso cálido `#16130F` se retiró el 2026-09-14**: era el dark exclusivo del Storefront y desapareció al unificar la suite en una familia. Los tres `theme-color` de los `index.html` apuntan a `#18181B` (= `--card-bg`, el color del chrome), no al ground.

---

## Spacing
- **Base:** 4px. **Escala única: `--sp-1`(4) `--sp-2`(8) `--sp-3`(12) `--sp-4`(16) `--sp-5`(20) `--sp-6`(24) `--sp-8`(32) `--sp-10`(40) `--sp-12`(48).** Es el único origen de paddings/gaps/margins de layout. Excepciones legítimas: 1px (hairlines) y micro-nudges <4px en chips/badges. *(La escala `2xs(2)…3xl(64)` que figuraba acá nunca existió como token y contradecía la base de 4px — retirada.)*
- **Densidad:** **compact** en tool mode (catálogo, carrito, pedidos, listas), **comfortable** en storefront (home, promos, login). La altura de fila la parametriza `--row-h-*` y **la decide el puntero**, no el surface.

## Layout
- **Enfoque:** híbrido — utilitario en tool mode, editorial en storefront.
- **Velocidad primero:** búsqueda sticky con `⌘K`, acceso permanente a reordenar, steppers inline, agregado directo desde la card.
- **Catálogo: vista conmutable grid ⇄ lista.**
  - **Grid:** cards `minmax(180px, 1fr)`, 4-5 columnas desktop. Default.
  - **Lista:** filas densas `[thumb 38px | nombre+SKU/marca/mín | flag IA/promo | precio tabular | stepper]`. Para el que sabe exactamente qué quiere (estilo McMaster). Estado recordado por usuario.
- **Reorder rail:** strip horizontal de los más pedidos (90d) arriba del catálogo.
- **Sticky cart bar:** pill flotante con conteo + total tabular + CTA (tool mode).
- **Max content width:** 1180–1280px. **Mobile:** tab bar flotante (pill) + sidebar desktop (ya implementado).
- **Border radius (tokens en `tokens.css`):** `--r-sm` 8px · `--r-md` 12px (controles/botones) · `--r-lg` 16px (tarjetas) · `--r-xl` 20px (tarjetas grandes) · `--r-2xl` 24px (hero) · `--r-pill` 999px. Usar siempre el token, no el valor hardcodeado.

## Motion

> **Única fuente de duraciones y curvas del sistema.** Si otra sección cita un número
> de motion, cita a ésta. Tokens en [`libs/design-tokens/tokens.css`](libs/design-tokens/tokens.css).

- **Enfoque:** intencional, rápido. No decorativo.
- **Duración — techo duro 350ms** (`--dur-max`). Escala: `--dur-micro` 120ms (press, tint de hover) · `--dur-short` 150ms (micro-transiciones) · `--dur-standard` 250ms (drawer, side-peek, bulk-bar) · `--dur-max` 350ms (máximo absoluto, nada lo supera). *(Corrige el rango "250-400ms" que figuraba acá y contradecía el techo binding de §datos densos 11 y §Motion KPI 7.)*
- **Easing:** `--ease-standard: cubic-bezier(0.4, 0, 0.2, 1)` para movimiento general · `--ease-emphasized: cubic-bezier(0.2, 0, 0, 1)` para acción destacada · `--ease-decelerate` entrada · `--ease-accelerate` salida · `--ease-drawer` bottom-sheets · `--ease-spring` sólo en gestos drag-to-dismiss. *(`--ease-standard` estaba declarado con dos valores distintos en dos archivos; ganaba `0.4,0,0.2,1`. Se conservó el valor efectivo al consolidar — la curva `0.2,0,0,1` que este doc documentaba vive como `--ease-emphasized`.)*
- **⭐ El techo es POR SURFACE, y eso resuelve una contradicción que el doc arrastraba** (2026-10-03):
  - **Operations** (`apps/view`, `apps/vendor`) — **350ms, techo duro, sin excepción.** Medido y en **0**.
  - **Storefront** (`apps/portal`) — el techo guía, pero los **momentos de celebración** (confirmación de
    pedido, dibujo del check, pop del FAB) pueden pasarlo. Hoy son **4 archivos** entre 420 y 1100ms.
  > **Por qué se declara en vez de "arreglarse":** §Motion decía *"máximo absoluto, nada lo supera"* y
  > [`DESIGN_MOTION_KPI_CARDS.md`](docs/DESIGN_MOTION_KPI_CARDS.md) decía, en el mismo repo, que el
  > Storefront *"puede tomar motion algo más expresivo (count-up hasta ~1.5–2s)"*. **Las dos no pueden ser
  > ciertas.** El código llevaba meses obedeciendo la segunda. Se resolvió a favor de la realidad y de la
  > tesis de los dos modes —Operations es tool, el Storefront tiene momentos— en vez de dejar una regla
  > que todos incumplen. *Una regla que el código contradice hace meses no es una regla: es un deseo.*
- **Sólo `transform` + `opacity`.** Nunca `width/height/margin/padding/box-shadow`.
  - **Excepciones con nombre** (no son licencia; son estas tres y nada más):
    **(a)** `stroke-dashoffset`/`stroke-dasharray` en micro-viz SVG — es la única forma de dibujar un arco
    progresivo y no dispara layout (J17 ya la bendecía; acá queda unificado). **(b)** `filter: blur()` en
    la entrada de mensaje de las **superficies de IA** (Thot/Maat/Horus): es paint, no layout, y es
    one-shot sobre un elemento chico. **(c)** La barra de **composición** de `MetricStrip`, que son
    hermanos flex de una misma fila y no admite `scaleX` sin rehacer el TS — declarada en el componente.
  - **Una barra se anima con `transform: scaleX()` sobre un elemento de ancho fijo**, con el radio en el
    track (que ya recorta con `overflow:hidden`). Referencia: `MetricCard`. **Nunca con `width`.**
- **✅ Esto se MIDE, no se revisa a ojo** (desde 2026-10-03): `npm run check:motion`, en CI con su prueba
  negativa aparte. Frena si una animación de Operations pasa el techo —en `ms` **o** en `s`— o si crecen
  las **48** `transition` sobre propiedades de layout que quedan declaradas como deuda `[DS.1]`.
  > ⚠️ **Por qué hacía falta, y es la parte que enseña:** esta sección es BINDING desde hace meses y el
  > arquetipo más copiado del repo (`MetricStrip`, 81 pantallas) animaba `width 900ms` — 2.6× el techo y
  > sobre layout. La tabla de cumplimiento publicaba *"19 por encima"*, **midiendo sólo milisegundos**;
  > contando `.5s`/`.7s`/`0.8s` eran el doble. Y cuando la compuerta corrió por primera vez encontró
  > **40 más** que tres barridos manuales no vieron, porque en `animation: nombre 0.6s ease` la duración
  > no está donde uno la busca. *El instrumento no es sólo para que no vuelva: ve lo que el barrido no ve.*
- **Mobile:** usar `HapticService` en acciones (add to cart, confirmar).
- **Siempre** respetar `@media (prefers-reduced-motion: reduce)`.
- **Implementación = plataforma primero** (2026-08-25): transiciones de ruta y master→detail con **View Transitions**; progreso/header-condensa/reveals con **scroll-driven animations**; easing tipo resorte con **`linear()`**. Nada de librería de animación para esto. Los números y curvas de arriba **no cambian** — cambia con qué se implementan. → [§U](#plataforma-web-moderna--cascada-responsividad-overlays-motion-nativo-binding).

---

## Sistema de botones «Confite» (Storefront) — BINDING

> Implementado 2026-06-24 en `apps/portal/src/styles.css` (átomos `.portal-btn-*`).
> **Identidad táctil repetible** — análoga a la "esencia" de Rappi pero monocromática
> con acento de marca. NO re-estilar botones por componente: usar estos átomos.

**El ADN (5 rasgos):** geometría redonda (pill) · profundidad suave (sombra de color difusa) ·
tactilidad (lip inferior + press físico) · brillo "render" sutil (gloss neutro) · tipografía confiada (700).

**La receta (los 5 ingredientes de la firma):**

1. **Píldora** — `border-radius: var(--r-pill)` por default (la `-pill` legacy es no-op ahora).
2. **Gloss** — `::before` con `linear-gradient(180deg, rgba(255,255,255,.16), transparent)` en el tercio superior. Solo en rellenos sólidos (primary/ember/hero), NO en ghost.
3. **Lip** — `inset 0 -3px 0 rgba(0,0,0,.16)` (borde inferior que da cuerpo físico).
4. **Halo** — drop-shadow de color (`--action-ring`) SOLO en primary; el resto usa sombra neutra.
5. **Press** — `:hover` sube `translateY(-2px)`; `:active` baja `translateY(1px)` y colapsa la sombra. Easing `--ease-spring`.

**Regla de color (monocromática — BINDING):**

- **`.portal-btn-primary` = la ÚNICA acción en color** (sunset `--action`). Es el CTA de conversión.
- `.portal-btn-ghost` = neutro; **hover en gris** (`--neutral-400`), nunca en color.
- `.portal-btn-ember` (IA) = **carbón** (`--neutral-950`) + susurro ámbar (glow en la sombra). Ya NO es gradiente.
- `.portal-btn-hero` = carbón + texto amarillo sello (`--brand-400`).
- El `+` del catálogo (`.cat-add`) y la promo nativa (`.cat-promo-add`): negro + sello, con lip/press.
- El gloss y el lip son **blanco/negro** → dan profundidad sin agregar color.

**Cómo extender:** cualquier botón nuevo usa `.portal-btn-primary|ghost|ember|hero` (+ `-lg`/`-block`). Un control custom (stepper, FAB, circle) copia los 3 insets (`halo, lip, gloss`) + el patrón hover/active. Mantener el gloss **sutil** (≤.18 alpha) — quiet-luxury, no caricatura.

---

## Patrones del portal aplicados (2026-06-24) — referencia para seguir construyendo

Derivados de la investigación (`docs/IMPLEMENTACION/INVESTIGACION_UX_PORTAL_VENTA.md`: Baymard, NN/g, Polaris, Material 3, Instacart). Estado: **en código, builds verdes**.

| Patrón | Dónde | Regla para replicar |
|---|---|---|
| **Thumbnails monocromáticos** | `core/util/brand-placeholder.ts` (fuente única) | Placeholder sin foto = gradiente **Stone oscuro** determinista por `product_id`. Monograma blanco. Cero color en thumbnails — el color es para CTA/promo/estado. |
| **Reorden-primero** | `portal-home` | "Comprar de nuevo" va en el **primer pliegue**, sobre el hero. El cliente B2B es transaccional, no exploratorio. |
| **Promo nativa** | `portal-catalog` (`.cat-promo-native`) | Promos = unidad **en contexto** al tope de resultados (estética de card + etiqueta amarilla "Destacado"), NUNCA banner hero (banner blindness). 1 por pliegue. |
| **CTA sticky en sheet** | `portal-catalog` (`.cat-sheet-actions`) | En bottom-sheets, el botón de acción va `position: sticky; bottom: 0` para que nunca se pierda al scrollear. |
| **Cross-sell** | `portal-catalog` (`sheetCrossSell`) | "Va bien con esto" = 3 SKUs. Hoy heurístico (top-sellers); migrar a afinidad real (Thot) cambiando la fuente del `computed`. |
| **Upsell de mínimo** | `portal-cart` (`.ca-min-upsell`) | Convertir la restricción ($2,500) en oportunidad: "te faltan $X" + barra de progreso + sugerir. No bloquea. |
| **Tab bar Material 3 + búsqueda circular** | `portal-shell` (`.portal-tabdock`) | Móvil = **4 destinos persistentes** + botón de búsqueda circular aparte (firma Rappi). El carrito es acción con badge, no tab co-igual. Desktop conserva la nav completa. |

**Color discipline (toda superficie nueva):** lienzo neutro Stone; el color de marca solo en — (1) CTA de conversión, (2) tab/chip activo, (3) badge de descuento/promo, (4) estado "en vivo", (5) focus ring. El color **nunca** es el único portador de significado (Polaris/WCAG): siempre + icono o texto.

---

## Hallazgos del portal actual (auditoría 2026-06-04)

> 🗄️ **HISTÓRICO — mayormente resuelto.** Los 🔴/🟡 (morado IA→ember, Inter→Hanken, amarillo→sunset, Zinc→Stone, dark espresso) ya se aplicaron; se conserva por trazabilidad, no es checklist operativo. Lo vigente está en el [checklist pre-vuelo](#️-checklist-pre-vuelo-leer-antes-de-tocar-frontend).

Prioridad: 🔴 alto impacto · 🟡 medio · 🟢 pulido.

1. 🔴 **AI-slop morado.** `--ai-accent: #8b5cf6` (chips "Sugeridos IA" en `portal-catalog`) es exactamente el morado al que toda la industria convergió. La IA — tu diferenciador #1 — está pintada del color más genérico posible. **Fix:** reemplazar por `--ember-grad`. Bajo esfuerzo, máximo payoff.
2. 🔴 **Inter como body.** Default de convergencia. **Fix:** swap `--font-body` → Hanken Grotesk (token único).
3. 🟡 **Rol del amarillo inconsistente.** `--brand-400` está documentado como "PRIMARY" pero no puede llevar texto blanco (AA 1.07). Hoy los botones primary terminan siendo `--neutral-900`/negro porque el amarillo no sirve. **Fix:** formalizar naranja-sunset como `--action`; amarillo = sello.
4. 🟡 **Display font inconsistente.** `.cat-h1` y `.ph-hero-h1` usan Fraunces, pero la utilidad compartida `.portal-page-head h1` (styles.css:1833) usa Inter weight-800. Títulos de página distintos según el componente. **Fix:** regla de dos modos — editorial = Fraunces, tool = body bold; aplicarla a `.portal-page-head`.
5. 🟡 **Neutrales fríos (Zinc) bajo una marca cálida.** Choque sutil pero omnipresente que empuja el "feel SaaS". **Fix:** rampa Stone.
6. 🟡 **Dark mode `#000` puro.** Duro bajo marca cálida. **Fix:** espresso `#16130F`.
7. 🟢 **`--accent-soft-bg: #fde68a22`, `--promo-accent: #ef4444` hardcodeados** en `portal-catalog` con fallbacks inline. **Fix:** tokenizar (`--promo-accent` puede mapear a `--brand-700` o un rojo semántico).
8. 🟢 **Mucho color inline en SVGs/gradientes** repetido entre componentes. **Fix:** consolidar en utilidades/tokens (alinea con el sprint UX/UI en curso, ver memoria `project_sprint_ux_ui`).

**Lo que ya está muy bien (conservar):** ilustraciones SVG propias de dulces · accesibilidad (focus rings, `prefers-reduced-motion`, `aria-*`, safe-area insets) · arquitectura de tokens en `tokens.css` · tab bar flotante mobile · steppers inline + estados de carga (skeletons) · estructura editorial del home.

---

## Plan de migración (cuando se implemente — no tocar código aún)

> 🗄️ **HISTÓRICO — APLICADO.** La migración del portal (fonts, Stone, `--action`, ember, dark espresso, regla display) ya está en código. Se conserva como registro del alcance ejecutado.

Casi todo es **swap de tokens** en `tokens.css`, por eso el costo real es bajo:
1. Cargar fonts nuevas en `index.html` (Fraunces + Hanken Grotesk + Geist Mono).
2. `--font-body` → Hanken Grotesk; `--font-mono` → Geist Mono.
3. Renombrar/agregar rampa Stone; apuntar superficies/textos a Stone.
4. Agregar `--action*` y `--ember*`; reemplazar usos de `--ai-accent` (#8b5cf6) y normalizar botones primary a `--action`.
5. Reescribir bloque dark (`body.theme-monochrome`) a espresso.
6. Aplicar la regla display: `.portal-page-head h1` con `var(--font-display)` solo en storefront.
7. Agregar toggle grid/lista en `portal-catalog`.
8. QA: contraste AA en botones `--action`, dark espresso, y `tabular-nums` en toda cifra.

> Alcance acordado: **solo `/portal`**. El resto de la app (dashboard, comercial, logística) sigue con los tokens actuales hasta decidir extender "Mercado" globalmente.

Preview de referencia: `~/.gstack/projects/edgarcg-01-Trade_marketing/designs/portal-redesign-20260604/mercado-preview.html`

---

---

## Mercado / Operations — surface interno

> Alcance: `/dashboard/*` (Trade Marketing), `/comercial/*`, `/logistica/*`, `/admin/*`, `/vendor/*`, `/telemarketing/*`. Usuario tipo: supervisor PdV, vendedor, gerente comercial / logística, admin de tenant. NO es el cliente B2B (eso es Storefront).

### Tesis Operations
Una herramienta de operación que se siente de Mega Dulces, no de Salesforce. **McMaster-Carr LATAM**: densa, instantánea, keyboard-first, cifras alineadas. La calidez viene del color y la tipografía; la velocidad viene del layout y la disciplina. "Esto es serio."

### Memorable thing
Un supervisor que entra una vez recuerda: **velocidad y densidad** — está usando software profesional, no un dashboard pintado.

### Decisiones del sistema (delta vs Storefront)

| Dimensión | Operations | Storefront |
|---|---|---|
| Display font | **Ninguna.** Page-head = Hanken Bold + tracking tight | **Poppins** (`--font-display`) |
| Body font | Hanken Grotesk 13/14/16 | Hanken Grotesk 14/15/16 |
| Data font | Geist Mono + `tabular-nums` obligatorio | Geist Mono |
| Neutrales | **Zinc** (PrimeNG Aura) — `#F4F4F5` ground | **Zinc** — el mismo |
| Acción | `--action` sunset (igual que portal) | Sunset |
| IA | Ember `--ember-grad` | Ember |
| Dark | **Zinc (Aura) `#09090B`** | **Zinc — el mismo** (el espresso se retiró) |
| Density | **compact++** (más denso que tool-mode portal) | compact / comfortable |
| Primary organism | **Tabla densa + master-detail**. Cards solo para KPIs minimal | Card grid |
| Decoración | nula (sin ilustraciones SVG dulces — son del storefront) | intencional |
| Motion | minimal-functional | intencional |

### Type scale (única, ambos surfaces)

> **Los tokens reales son `--fs-*` + `--fw-*`**, en [`libs/design-tokens/tokens.css`](libs/design-tokens/tokens.css).
> ⛔ **No crear tokens nuevos de tamaño en el namespace `--text-<rol>`**: `--text-*` significa **color de texto** (`--text-main/muted/faint`). Colisionar los prefijos fue el error de la versión anterior de esta tabla (mandaba `--text-page-head/data/label`, que nunca se declararon → 0 usos en código y `font-size` crudo en su lugar).
> ⚠️ **Excepción heredada, real y en uso** (medida 2026-09-14): `--text-display-xl/-lg/-md` **sí existen** en `tokens.css:28-30` y tienen **14 usos** — son la escala display `clamp()` del Storefront (documentada arriba en §Typography). O sea: el prefijo `--text-` hoy carga **dos significados**. No los uses en Operations (no hay display font ahí) y **no agregues más**; renombrarlos a `--fs-display-*` es deuda abierta (toca 14 call sites + tokens.css).
> Alias de color sin ambigüedad para código nuevo: `--fg-1` / `--fg-2` / `--fg-3`.

| Token | Value | Uso |
|---|---|---|
| `--fs-display` | 40px | headline metric — **una por vista** |
| `--fs-h1` | 30px | page hero title (Storefront) |
| `--fs-h2` | 20px | page-head de apartado (`Rutas`, `Pedidos`) — con `--fw-bold` + tracking tight |
| `--fs-h3` | 16px | título de panel / section-head dentro de card |
| `--fs-body` | 14px | body, párrafos |
| `--fs-sm` | 13px | **base de celda de tabla** (densidad Operations) |
| `--fs-xs` | 12px | metadatos, hint, helper, hora secundaria |
| `--fs-micro` | 11px | column header y KPI label (`uppercase 0.06em` + muted) |
| `--fs-nano` | 10px | micro label — último recurso |

Pesos: `--fw-regular` 400 · `--fw-medium` 500 · `--fw-bold` 700 · `--fw-black` 800 (sólo headline metric). Cifras/SKU/folio: `--font-mono` + `tabular-nums` **obligatorio**.

### Color semántico de Trade (estado de visita / ejecución)
- **visitada / fulfilled**: `--ok-soft-bg/fg` (verde)
- **parcial / pending_approval**: `--warn-soft-bg/fg` (ámbar)
- **sin visitar / draft**: chip neutral Stone-200
- **atípica / out-of-range**: `--bad-soft-bg/fg` (rojo) — visita > 2× duración promedio, captura sin geofence, expirada
- **cancelada / fallida**: `--bad-soft-bg/fg` muted
- **sugerencia IA**: ember (`--ember-soft` bg + `--ember-border`)

Regla: siempre `p-tag` con `[severity]` mapeado a token semántico. Nunca hex inline.

### Patrones canónicos Operations
1. **Master-Detail** — Rutas, Pedidos, Clientes, Embarques, Tickets. Aside 280-320px sticky + section flex-1. Mobile: stack con back-button (patrón implementado en `/dashboard/routes` 2026-06-08 — referencia).
2. **KPI Strip** — 4-5 metrics en row, mono-tabular, delta vs target con color semántico. SIN íconos en círculos de color (eso es AI slop).
3. **Tabla densa** — row 40px desktop / 56px mobile, sticky header, sort visible en header, paginación abajo. PrimeNG `p-table` con `styleClass="p-datatable-sm"`. En ancho suficiente, scroll horizontal con la primera columna pegada. **Spec completa (anatomía, estados, a11y, sort, selección, gaps + plan de adopción): [`docs/DESIGN_TABLES.md`](docs/DESIGN_TABLES.md).**
   > ⛔ **Corrección 2026-09-28 ([UIM.1]) de una regla de este mismo doc.** Acá decía *"scroll horizontal con primera columna pegada"* **sin condición de ancho**, y `DESIGN_TABLES.md` §6 dejaba la vista apilada como *"no obligatorio por spec"*. Medido en `/almacen/inventory/existencia` a 390 px: las dos columnas congeladas ocupan **344 px de 390 (88%)**, quedan **46 px** de ventana para el dato y una columna pide 88 — **no cabe ni una cifra completa**, y desplazarse no ayuda porque lo congelado no se mueve. La columna congelada, que existe para no perder el renglón de vista, a esa anchura **se come el renglón**. La pantalla no estaba mal hecha: **estaba obedeciendo esta línea**.
   > ⌨️ **El teclado de la tabla NO se diseña por pantalla: es D.7.** `pSelectableRow` ya da `↑↓`, `Home`/`End`, `Enter`/`Space` y roving tabindex; lo que hay que agregar es la **guarda global** (PrimeNG no mira `event.target` y le roba las teclas a los campos de la fila) y el **salto buscador → lista**. Compuerta `npm run check:teclado`.
   > **La regla nueva se decide con una pregunta: ¿qué son las columnas?** Campos de un registro → **apilar** (`libs/ui-web/src/dense-table.css`, `.dt-scope` + `.dt-stack` + `data-label`/`role="cell"`). Valores de otra dimensión (un **pivote**) → **perder un eje**: la dimensión se elige arriba como alcance y la comparación se muda al detalle. ⛔ Apilar un pivote es el error que parece la solución: 9 almacenes apilados dan 9 renglones por producto. Compuerta `npm run check:tables`, con prueba negativa y **11 pantallas en deuda declarada** — ver [`DESIGN_TABLES.md` §6](docs/DESIGN_TABLES.md).
4. **Empty state operacional** — ícono PrimeIcon mediano + título neutral + descripción + CTA accionable. NUNCA "No items found." sin más. Voz: técnica, no editorial. Ejemplo correcto: "Ninguna ruta registra actividad entre 01/06/26 y 08/06/26. [Ampliar a 30 días]".
5. **Mapa Leaflet** — pin numerado sequence (sunset `--action`), pin gris en pendientes (`--neutral-400`), polyline dashed sunset para recorrido. Token canónico: `var(--action)`, no `var(--brand)`.
6. **Filtros** — rango de fechas top-right del header del apartado, filtros secundarios contextualizados en el card específico que filtran (NO banda global de filtros mid-page que parece ruido).
7. **Status pills** — `p-tag` con severity mapeada al color semántico arriba. Nunca hardcodear bg/fg.
8. **Navegación** — sidebar hover-expand desktop (patrón VS Code) + bottom-nav mobile 4 items + drawer overflow (patrón FB / IG / Slack). Ya implementado en `LayoutComponent`.
9. **Acción única** — `--action` sunset para CTA primario en formularios, modales, headers. Secundaria = ghost. Destructiva = `--bad-fg` ghost (botón ghost-bad pattern de la memoria `feedback_ghost_buttons_pattern`).
10. **A11y línea base** — `focus-visible:ring-2 ring-action`, `aria-current="true"` en master selection, `aria-label` rica en botones sin texto, labels `for/id` formales en inputs, touch targets ≥ 44px mobile.

### Reglas canónicas de datos densos (CRM / Inventario) — BINDING

> Destiladas del benchmark de líderes. Aplican a toda surface Operations con tablas, registros o stock. Fuente y números: [`docs/DESIGN_BENCHMARK_CRM_INVENTORY.md`](docs/DESIGN_BENCHMARK_CRM_INVENTORY.md).

1. **Elevación = una de dos, nunca ambas.** Superficies **in-page** (cards, filas, paneles, KPIs) = **borde 1px hairline `--border-color`, sin sombra**. **Overlays** (menú, popover, modal, ⌘K, toast, drawer) = **sombra (`--shadow-float`) + borde**. Prohibido card con sombra difusa dentro de la página. (Attio/Linear)
   - **Aclaración (resuelve el choque con el repertorio de cards):** el *spotlight* y el *hover lift* de `MetricCard` **no son elevación en reposo** — son respuesta al puntero, no jerarquía. En reposo la card es hairline pura; el spotlight aparece **sólo bajo el cursor** y el lift es `translateY(-1px)` transitorio. Un `box-shadow` permanente en una card in-page sigue prohibido.
2. **Densidad de fila tokenizada.** Tabla Operations default **40px (`--row-h-md`)**; toggle a **32px (`--row-h-sm`)** para power users; **48px (`--row-h-lg`)** solo si la fila lleva avatar + 2 líneas. Nunca dos densidades en un mismo card. (Carbon)
3. **Optimistic UI en toda mutación de 1 registro** (cambiar estado, asignar, editar inline, ajustar qty): mutar estado local sync → reconciliar con server → rollback visible en error. **Sin spinner** en estas acciones. (Linear)
4. **Carga:** skeleton-shell a nivel ruta + **filas skeleton** a nivel data (shimmer, nunca spinner de bloque). Spinner solo <300ms inline. (Stripe/Linear)
5. **Tabla:** header **sticky**; **primera columna congelada** (nombre entidad / SKU) en grids anchas; hover de fila con tint sutil; selección = checkbox + bg tintado; acciones de fila = icon-buttons ghost revelados en hover, a la derecha.
6. **Acciones masivas:** al seleccionar ≥1 fila, sube una **bulk-bar** (slide-up ~200ms) con conteo + ops batch, reemplazando el toolbar.
7. **Paginar** data transaccional/auditable (pedidos, facturas, ledger de stock) — server pagination 25–50 filas; **infinite virtualizado** solo en listas exploratorias o >200 filas visibles.
8. **Detalle = side-peek drawer** (~480–560px, slide desde derecha, ~250ms) para ver/editar manteniendo la lista; **full page** solo para create/edit multi-sección complejo. (Attio)
9. **Inline edit** para cambios de 1 campo (Enter commit / Esc cancel / Tab→derecha). Modal solo para confirmaciones destructivas o create con muchos requeridos.
10. **Escala tipográfica de tabla:** header `--fs-micro` (11px) `--fw-medium` muted +0.02–0.06em · valor `--fs-sm` (13px) · meta `--fs-xs` (12px) muted · lh 1.25–1.35. `tabular-nums` **obligatorio** en toda celda numérica/dinero/qty/fecha (Geist Mono **y** números inline en Hanken).
11. **Motion con techo duro:** `--dur-short` micro · `--dur-standard` · **`--dur-max` 350ms tope**, ease-out. Animar **solo `transform`+`opacity`**; jamás `width/height/margin/padding` en tablas (reflow). No animar filas/celdas al cargar data. → [§Motion](#motion) es la única fuente de estos números.
12. **Command palette ⌘K / Ctrl+K** cuando una surface tenga 20+ destinos/acciones: navegar **+ actuar** (cambiar estado, asignar, crear), fuzzy, solo-teclado, modal 560–640px con sombra.
13. **A11y piso:** anillo de foco **2px ≥3:1 contraste** (`--action-ring`) en todo interactivo; **icon-button hit area ≥24px** (44px objetivo mobile); focus no obstruido por headers sticky.

### Motion de KPI cards (BINDING)

> Cómo hacer las cards dinámicas/gráficas sin romper "esto es serio". Fuente y números: [`docs/DESIGN_MOTION_KPI_CARDS.md`](docs/DESIGN_MOTION_KPI_CARDS.md).

1. **Dinamismo = dato, no decoración.** El movimiento permitido es: count-up del número, sparkline/mini-chart de la serie, delta con flecha, flash-on-change. Prohibido: gradientes que laten, íconos girando, badges flotando, ember decorativo en tiles.
2. **Tile canónico de 3 capas:** número (Geist Mono `tabular-nums`) + sparkline SVG inline + **delta multimodal `▲ +3.2%`** (flecha+signo+número, nunca solo color).
3. **Count-up:** on-view (IntersectionObserver), **una vez**, ~900ms `--ease-out`, vía `rAF`→signal. Valor final en el DOM para SR. Bajo `prefers-reduced-motion` → instantáneo. **Nunca** en poll/re-render.
   - ⚠️ **La compuerta on-view no decide si el número es correcto.** El primer render tiene que ser el VALOR, no `0`, cuando la cifra es dato autoritativo (modo live) o cuando el navegador no trae `IntersectionObserver`. Vivido en `[TDA.7]`: la pastilla del ahorro del verificador se quedaba en **`$0.00`** si caía abajo del pliegue, y `prefers-reduced-motion` no rescataba porque la compuerta de visibilidad corre antes que la del movimiento. Dibujar un cero por no haber podido medir es exactamente lo que ADR-056 prohíbe.
   - **Excepción `[TDA.7]` — POS, cifra que cambia de SUJETO** (aprobada por 0Sistemas, 2026-09-10; hoy sólo `/tienda/verificador`): ahí el count-up del **ahorro** re-anima en cada escaneo. No contradice el "nunca en poll/re-render" — esa regla protege de animar **el mismo dato refrescándose**, y acá cada escaneo es **otro producto**: el número anterior y el nuevo no son la misma cifra. Condiciones para que valga: (a) sólo sobre el **ahorro**, nunca sobre un precio que se lee en voz alta — los precios siguen siendo interpolación directa, visibles en el primer fotograma; (b) el `rAF` anterior se cancela, así que dos escaneos seguidos no dejan dos cifras peleando; (c) se declara el costo — con una permanencia de ~2 s, ~740 ms de esa permanencia muestran una cifra que todavía converge. Fuera de un POS con esas tres condiciones, sigue rigiendo "una vez".
4. **Micro-charts = SVG crudo (0 KB).** Nada de Chart.js/Apex para sparklines. uPlot solo si aparece panel time-series interactivo.
5. **Entrada:** stagger one-time en primer paint (`translateY(8–12px)+opacity`, 150–250ms/card, stagger 30–60ms). Jamás en refresh.
6. **Hover/press:** `:active scale(0.97)`; hover lift `translateY(-1px)` + revelar borde/acento, 120–150ms. Sin glow ni barrido de color.
7. **Presupuesto:** todo **<300ms**, `ease-out`, **solo `transform`+`opacity`**, CSS para hover/entrada y rAF solo para count-up.
   - ⛔ **El arquetipo canónico incumple hoy esta regla y las barras son el caso:** `MetricStrip` anima el relleno de `bullet` y `composition` con `transition: width 900ms` ([`metric-strip.component.ts:137,143`](apps/view/src/app/shared/components/metric-strip/metric-strip.component.ts#L137)) — 2.6× el techo **y** sobre una propiedad de layout, en el componente que está en 64 pantallas. **Una barra se anima con `transform: scaleX()` sobre un elemento de ancho fijo, nunca con `width`.** Mientras no se arregle, no lo copies como referencia de motion.
8. **Skeleton dimensionado** (CLS 0) + crossfade ~180ms a data.
9. **Variedad por tipo de dato — las cards NO deben ser todas iguales.** Cada KPI lleva la micro-viz que su dato pide, y eso las diferencia visualmente: **serie temporal → sparkline/mini-barras** · **ratio/cobertura → barra de progreso con %** · **actual vs meta → bullet** · **% acotado → ring** · **valor único sin serie → headline grande** (count-up, sin chart falso). Un strip donde las 4 cards son idénticas (mismo layout, solo cambia el número) es plano y se siente genérico — usar el tipo de métrica para dar ritmo visual. Nunca inventar una serie/chart si no hay dato real (eso es slop, §9).

### Tokens de estado de dominio (mapear, no inventar hex)
- **Inventario (escalada gradual):** in-stock → `--ok-*` · low-stock → `--warn-*` · out-of-stock → `--bad-*` · overstock (opcional) → `--info-*`. El umbral low→crítico mueve el chip de ámbar a rojo.
- **CRM / pipeline:** new/lead → `--info-*` (slate/azul) · qualified/in-progress → `--warn-*` · won/fulfilled → `--ok-*` · lost/cancelled → `--bad-*` · on-hold/draft → chip neutral Stone-200.
- **Regla:** siempre `p-tag [severity]` mapeado a estos semánticos. Nunca hex inline.

### SAFE choices (no inventar — es categoría operacional)
- Master-detail patrón
- Tabla como primary organism (no card grids)
- Sidebar desktop hover-expand + bottom-nav mobile
- Status semantics clásico verde/ámbar/rojo

### RISK choices (donde Mega Dulces se diferencia de cualquier ERP)
1. ~~**Stone + sunset + ember en backoffice**: 95% de tools internas son Zinc/blue/Inter. Mover Operations a la paleta del portal hace que el supervisor sienta que es la MISMA empresa, no "el portal por un lado y la herramienta de trabajo por otro". Costo: swap de tokens. Win: identidad cross-app.~~
   **⛔ REVERTIDO 2026-09-14 (decisión Edgar).** Operations pasó a **Zinc de PrimeNG Aura**. La apuesta de arriba se tomó a conciencia y se dejó ir a conciencia: el riesgo que nombra —verse como el otro 95%— **se acepta**, a cambio de un neutro que se lee limpio (zinc-100 tiene croma 0.0013 contra 0.0103 del stone-100 que había; medido). Lo que queda de la tesis: el sunset y el ember **siguen siendo los mismos en los dos surfaces**, así que la identidad cross-app ahora la carga el **acento**, no el sustrato. Razonamiento completo en el Decisions Log 2026-09-14.
2. **No Fraunces ni decoración en internal**: muchos ERPs meten serif en empty states para no verse crudos. Aquí vamos full grotesque honesto. Costo: empties visualmente más fríos. Win: refuerza la promesa "esto es serio".
3. **IA ember preventivo en backoffice**: cuando Trade agregue scoring assist / anomaly detection / product match (Fase K extension), ya tiene identidad coherente con portal. Costo: nada hoy. Win: evita el reflejo "azul SaaS" o "morado AI" cuando aparezca el primer feature IA en operations.

### Plan de migración Operations (tokens-only, sin tocar componentes)

> 🗄️ **HISTÓRICO — APLICADO (2026-06-16).** La migración Operations (Hanken/Stone/sunset/ember en `:root`) ya está en `tokens.css`; el dark de Operations quedó en **zinc neutro `#111111`** (no espresso — ver nota de estado del encabezado). Se conserva como registro. *(La nota "NO aplicado todavía" quedó obsoleta.)*

Costo bajo: casi todo es swap de tokens en `tokens.css`.

1. `--font-body` → Hanken Grotesk globalmente en `:root` (hoy `Inter`).
2. `--font-mono` → Geist Mono globalmente (hoy `JetBrains Mono`).
3. Aliasar `--neutral-50..950` → `--stone-50..950` en `:root`. El portal ya lo hace localmente; será no-op para él.
4. `--ai-accent` → `--action` sólido (o `--ember-grad` para chips que soporten gradiente). Mata el `#2563EB` azul tibio actual.
5. `--active-bg: var(--neutral-950)` → revaluar: ¿negro hard o stone-950? Bajo paleta cálida el negro puro se ve agresivo. Recomendación: stone-950 light, stone-50 dark.
6. ~~Dark mode `:root` → espresso: copiar el bloque `.portal-shell body.theme-monochrome` al `body.theme-monochrome` global.~~ ⛔ **NO se ejecutó así y no debe ejecutarse**: la decisión final fue **zinc neutro `#111111`** para Operations ("esto es serio"), y el espresso quedó scopeado al portal. Lo que corrió es el bloque zinc de [`tokens.css:297-309`](libs/design-tokens/tokens.css). *(Paso corregido 2026-09-14: estaba marcado como aplicado y ordenaba lo contrario de lo decidido.)*
7. Cargar Hanken + Geist Mono en `index.html` sin scope (ya están cargados — verificar).
8. Pin tokenizado en [`MapComponent`](apps/view/src/app/shared/components/map/map.component.ts): `var(--brand, #f97316)` → `var(--action)`. Aplica también a [`routes-analysis`](apps/view/src/app/modules/dashboard/routes-analysis/routes-analysis.component.ts) que tiene el mismo fallback inline.
9. `--focus-ring` → `--action-ring` globalmente.
10. Fraunces quedó **retirada del sistema** (decisión 2026-06-24, ejecutada 2026-08-12: fuera de `--font-display` y de los `<link>` de las 3 apps). El display es **Poppins** y sigue siendo **storefront-only**.

QA tras migrar:
- Contraste AA en `--action` sobre `--card-bg` light + dark.
- `tabular-nums` en TODO precio, cantidad, hora, score, folio.
- Dark espresso no rompe la paleta de charts (`--chart-1..8` dark ya redefinida — verificar contra fondo espresso).
- Smoke visual: `/dashboard`, `/dashboard/routes`, `/comercial/command-center`, `/comercial/orders`, `/logistica/dashboard`, `/admin/users`.

### Reglas D — interacción, teclado y dato en Operations (D.0–D.8) — BINDING

> 🔸 **El título decía «Tres reglas» y hacía rato que eran nueve** (corregido 2026-10-01). Nació como *«tres reglas destiladas de la auditoría de `/compras/pedido`, 2026-09-14»* y fue creciendo con cada defecto medido; un encabezado que cuenta mal es la primera señal de que nadie lo está leyendo entero. **Se renombró y no se partió**: las nueve son la misma familia —cómo se toca una pantalla densa— y repartirlas en dos secciones es cómo se empiezan a contradecir.

**D.1 — Un control que ELIGE UN VALOR no puede verse igual que uno que ACTIVA UN FILTRO.**
Si `14d / 30d / 45d` (mutuamente excluyentes) y `Solo con pedido` / `Con sobrestock` / `▲ Acelerando` (toggles independientes) comparten clase y aspecto, el usuario **no tiene cómo saber cuáles se excluyen** — y lo descubre a los golpes. Selector de valor → [`app-segmented`](apps/view/src/app/shared/components/segmented/segmented.component.ts) (radiogroup, flechas del teclado). Toggle → chip con `aria-pressed`. Entre los dos grupos, un separador. Nunca la misma clase para las dos cosas.

**D.2 — La jerga necesita AFORDANCIA, no sólo definición; y ninguna columna se queda sin nombre.**
**La utilidad compartida es `.surf-def`** (en [`styles.css`](apps/view/src/styles.css)): subrayado punteado + `cursor: help`, y cubre también el `th[title]` de una tabla. Nació local en una pantalla y se subió a global el mismo día, cuando la segunda la necesitó. ⚠️ El `pTooltip` de PrimeNG **no deja `title` en el DOM** — ahí hay que poner la clase a mano. ⚠️ Y `text-decoration` **no se propaga dentro de un `<button>`**: en una cabecera ordenable el rótulo vive en `.surf-sort` y la regla tiene que alcanzarlo.
⛔ **El `<th>` sin nombre:** un encabezado vacío (la típica columna de acciones) deja una columna que el lector de pantalla no puede nombrar. El repo ya tiene **`.sr-only`** para eso —su comentario dice literal *"headers de columna de acciones"*— y aun así hay **76 `<th>` vacíos en 52 archivos** contra 30 que la usan (medido 2026-09-14). Barrido pendiente.
 Tener la definición en el diccionario de `<app-context-help>` es necesario y **no alcanza**: si `Tend.`, `Est.` o `XYZ` no muestran que son explicables, nadie va a buscarlas. Toda cabecera con jerga lleva señal visible (subrayado punteado + `cursor: help`, la convención de `<abbr>`). Y como el hover **no existe en touch**, la definición tiene que estar **también** en el cajón de ayuda — el `title` es el atajo de escritorio, nunca el único canal.

**D.0 — La cabecera se alinea con su columna, y la celda numérica usa la clase canónica `.num`.**
Una columna de números alinea a la derecha **la celda Y su título**. Si no, el ojo no puede emparejarlos y la tabla se lee descuadrada aunque cada celda esté bien.
**Por qué se rompe solo:** PrimeNG pone `text-align: start` en el `th` con especificidad de elemento; una clase suelta inventada por la pantalla (`.pr-r`, `.co-r`, `.so-r`…) es `(0,1,0)` y **pierde**, así que el dato queda a la derecha y el título a la izquierda. No es un descuido: es el resultado predecible de no usar la utilidad compartida.
**El repo ya tiene la solución:** `td.num, th.num` en [`styles.css`](apps/view/src/styles.css) — alineación derecha + `--font-mono` + `tabular-nums`, calificada por elemento para ganarle al vendor.
⛔ **Medido 2026-09-14: 52 componentes inventaron su propia clase de alineación contra 41 que usan `.num`.** Toda tabla nueva usa `.num`; ninguna inventa la suya.

**D.4 — Un grupo de controles contiguos es UN tab stop, y toda barra de filtros se puede limpiar.**
**(a) Roving tabindex.** Cinco chips seguidos son cinco paradas de tabulador que hay que cruzar para llegar a la tabla. El grupo lleva `role="toolbar"` (o el `app-segmented` que ya lo encapsula): **un** `tabindex="0"`, el resto `-1`, y `← →` / `Home` / `End` mueven el foco dentro. En un **radiogroup** la selección sigue al foco; en un **toolbar de toggles** NO —moverse no debe activar— y en **tabs que recargan un panel** se usa activación manual (`Enter`/`Espacio`). ⛔ Los `select`/`combobox` **no entran** al toolbar: ya usan las flechas para abrir su lista y el contenedor se las robaría.
🔸 **Omisión corregida 2026-10-01 (`[KBD.1]`):** esta regla hablaba sólo de grupos de controles, y el organismo dominante de Operations es la **tabla**. Quien la leyera para una tabla se escribía su propio roving. **No hace falta: `pSelectableRow` de PrimeNG ya lo trae** —`tabindex` roving, `↑↓`, `Home`/`End`, `Enter`/`Space`— y la tabla entera ya es **un** stop de tabulador. La regla del teclado en tablas es **D.7**, abajo; acá sólo se aclara que no hay que duplicarlo.
**(b) Salida.** Toda barra de filtros expone **cuántos hay activos** y cómo limpiarlos de un gesto. El botón **existe sólo si hay algo que limpiar** (uno permanentemente deshabilitado es ruido, no información) y es **secundario** (ghost neutro, jamás `--action`).
**(c)** `role="tab"` sin `role="tabpanel"` que controlar es ARIA rota: el lector anuncia "pestaña 1 de 2" y no hay panel al que ir. Si no hay panel, no son tabs — es un radiogroup (`app-segmented`).

**D.5 — `input[type=number]`: fuera el spinner, guarda en la rueda, y el teclado hace el trabajo.**
⛔ **La rueda del mouse sobre un campo numérico ENFOCADO cambia el valor.** Es el default del navegador y en una pantalla de captura es un **riesgo de dato**: scrolleás la tabla para mirar otra fila y de paso alteraste una cantidad que después se convierte en requisición, factura o conteo — sin tocar el teclado y sin que nada lo avise. Todo campo numérico suelta el foco al primer `wheel` (sin `preventDefault`, que trabaría el scroll de la página).
**El spinner nativo se quita** — ya global, en [`libs/ui-web/src/number-input.css`](libs/ui-web/src/number-input.css); no hay que repetirlo por pantalla: aparece al enfocar y **empuja la cifra** —justo en la columna que existe para que las cifras estén alineadas—, son dos targets de ~9px (contra el piso de 24px de §datos densos 13), no existen en touch, y se comen ~1rem de un campo de 4rem.
**En una COLUMNA de captura, las flechas MUEVEN ENTRE CAMPOS — no incrementan.** `input[type=number]` usa `↑↓` para sumar de a uno, y eso choca de frente con lo que hace quien captura: bajar al siguiente renglón. Gana bajar, por tres razones: **ley de Jakob** (es una tabla, el usuario ya sabe Excel, y ahí las flechas cambian de celda), el valor **se escribe** (pedir 24 cajas a golpe de flecha son 24 pulsaciones), y sin spinner el incremento ya no tiene ni affordance visual. El teclado queda: `↑ ↓` y `Enter`/`Shift+Enter` mueven · **`← →`** restan / suman un paso · **`Alt + ↑ ↓`** el mismo paso, para quien ya lo usaba. Al llegar, `select()`: teclear reemplaza. En el borde **no da la vuelta** — dar la vuelta en captura desorienta.
🔸 **Enmienda 2026-09-26 (`[RA-PRO.57]`, `/compras/pedido`, pedida por Compras):** `← →` pasan de mover el cursor dentro del número a **restar / sumar un paso**, sin chocar con `↑ ↓` (siguen moviendo de renglón). Con decimales el paso **cae al entero** (`147.4 →` = 148). **Se pierde** mover el cursor dentro de la cifra, que casi no se usa porque al llegar ya está seleccionada; con modificador (`Shift+←`) se conserva lo nativo. **En táctil** la columna lleva botones **`−` / `+`** de 44px (sólo `@media (pointer: coarse)`: en escritorio no se pintan) que no enfocan el campo ni abren el teclado; mantener presionado repite. Tocar la cifra sigue abriendo el teclado, pero el **numérico** (`inputmode="numeric"`), para cantidades grandes. Es el stepper `+`/`−` que esta misma regla ya preveía para pantallas que lo quisieran.
⚠️ **Y se anuncia** (→ D.2): `aria-keyshortcuts` en el campo y el atajo escrito en la cabecera de la columna. Un atajo que nadie sabe que existe no existe. Si cambiás el teclado, **la cabecera que lo describía queda mintiendo** — actualizala en el mismo commit.
✅ **La rueda ya no hay que acordarse de ella: la guarda es global.** [`installNumberWheelGuard()`](libs/ui-web/src/number-wheel-guard.ts) de `@megadulces/ui-web`, un solo listener en fase de captura, instalado en el `main.ts` de las tres apps. Cubre lo que existe hoy y lo que se escriba mañana. **Se eligió listener global y no directiva a propósito:** una directiva hay que acordarse de importarla en cada componente standalone, el que la olvida no rompe nada —simplemente vuelve a quedar expuesto—, y eso es exactamente cómo se llegó a 29 de 30 sin guarda.
⚠️ **Efecto declarado:** soltar el foco dispara el `blur` del campo. En la pantalla que commitea en blur eso escribe el valor *que ya estaba* (el incremento nunca ocurrió): una escritura idempotente de más por cada scroll accidental. Estrictamente mejor que antes, que escribía el valor **equivocado** — pero se declara en vez de disimularse (ADR-056).
⛔ **Medición corregida 2026-09-14: son 65 `input[type=number]` en 30 archivos de las 3 apps, no 23 componentes** (la cifra anterior contaba componentes de `apps/view` y se quedaba corta). Uno solo tenía guarda. **El peor caso era [`almacen-recepcion-sesion.component.ts`](apps/view/src/app/modules/almacen/pages/almacen-recepcion-sesion.component.ts#L173), el único que además COMMITEA en `(blur)`:** la rueda cambiaba la cantidad recibida de un vale y el blur la guardaba, alimentando conciliación de entradas y cuentas por pagar con un número que nadie tecleó.
✅ **El spinner tampoco: se retira global desde [`number-input.css`](libs/ui-web/src/number-input.css)**, el mismo lib que la guarda, importado por el `styles.css` de las 3 apps. Un stylesheet global penetra los componentes (los selectores de elemento no quedan scopeados). Las 4 reglas scopeadas que ya lo hacían se retiraron: una sola fuente.
⚠️ **Se puede optar por salir:** una regla de componente gana por especificidad (el atributo `[_ngcontent-*]` la sube), así que `appearance: auto` devuelve el spinner si hiciera falta.
⚠️ **Y se declara qué se pierde:** el usuario de **mouse** que hacía clic en esas flechas de 9px. El incremento por **teclado** NO se pierde — `↑↓` son del input, no del spinner — salvo donde D.5 las reasigna a moverse entre campos. Una pantalla que quiera stepper de verdad pone sus `+`/`−`, que es lo que ya hacen el carrito del portal y el pad del vendedor.
🔸 **Corrección 2026-09-14 de una afirmación de este mismo doc:** se había escrito que el spinner *"no tiene forma global honesta"* porque no se puede distinguir una columna de captura de un filtro suelto. **Es falso, y lo desmiente la propia regla de arriba:** de los tres daños del spinner, dos —targets bajo el piso de 24px, e inexistentes en touch— **no dependen de si el campo es una columna**. Lo que sí la necesita es el **teclado**, y eso es lo único que sigue por componente. Confundir las dos mitades de una regla dejó un barrido abierto de más.

**D.6 — Una fecha de calendario se arma con los componentes LOCALES, nunca con `toISOString()`.**
⛔ `d.toISOString().slice(0, 10)` devuelve la fecha **UTC**, y en `America/Mexico_City` (UTC−6) eso **ya es el día siguiente a partir de las 18:00**. Medido: a las 19:30 del 14-sep devuelve `2026-09-15`.
**El daño escala al revés de lo que uno espera:** en un rango de un mes el corrimiento de un día es invisible; en un filtro **"hoy"** es el **100% del error** — pide desde mañana y la pantalla sale vacía toda la tarde, que en captura de facturas es justo el turno. Por eso el bug puede vivir años en "últimos 7 días" (que en realidad son 6 cada tarde) y sólo explotar cuando alguien agrega el preset de un día.
**Usar `isoLocalDate()`** de [`shared/util/date-presets.util.ts`](apps/view/src/app/shared/util/date-presets.util.ts), junto a `datePresetRange()` que ya resuelve los presets en `Date` locales. Es la contracara en el frontend de `mx-date.ts` del servidor y de §Ing.UI 7 ("no re-convertir con `new Date()` ingenuo").
⛔ **Medido 2026-09-14: 17 lugares de `apps/view` usan `toISOString().slice(0,10)`.** No todos son fechas de calendario locales —algunos sí quieren UTC— pero **ninguno lo declara**, así que hay que revisarlos uno por uno. Barrido pendiente.

**D.7 — Lo que se hace con el mouse se tiene que poder hacer con el teclado. Y el primitivo YA EXISTE: no se escribe otro.**
⛔ **`pSelectableRow` de PrimeNG ya navega.** `↑↓` mueven entre filas, `Home`/`End` van a los extremos, `Enter`/`Space` activan, y el `tabindex` ya es **roving** (la tabla entera = un solo stop de tabulador, → D.4a). Medido 2026-10-01: **13 de 153 archivos con `<p-table>` lo usan**. El trabajo es *usarlo*, no diseñarlo.
⛔ **PERO trae un bug, y encender la navegación sin arreglarlo lo REPARTE.** `SelectableRow.onKeyDown` conmuta sobre `event.code` **sin mirar `event.target`** (verificado en `primeng@22.0.0`). El listener vive en el `<tr>`, así que una tecla apretada en un `<input>` de esa fila **burbujea hasta la fila** y PrimeNG la atiende como suya, con `preventDefault()` incluido:
· **`Space`** → selecciona la fila y **no se puede escribir un espacio** · **`Enter`** → abre el detalle en vez de confirmar · **`Home`/`End`** → saltan de fila en vez de mover el cursor del texto · **`↑↓`** → chocan de frente con **D.5**, donde en una columna de captura ya significan "siguiente renglón": los dos manejadores corren y el foco salta de a dos.
**Medido: 9 de los 13 archivos que ya navegan tienen controles en línea**, o sea que el defecto ya está en producción.
✅ **La guarda es global, por la misma razón que la de la rueda (D.5).** [`installRowNavGuard()`](libs/ui-web/src/keyboard/row-nav.ts) de `@megadulces/ui-web`, un listener en **fase de captura**, instalado en el `main.ts` de las tres apps. Acá el global no es sólo comodidad: una directiva sobre la fila llegaría **tarde** —PrimeNG ya habría hecho `preventDefault()`—. ⚠️ Usa `stopPropagation` y **no** `stopImmediatePropagation`: el `(keydown)` que la pantalla puso en su propio campo —el de D.5— tiene que seguir corriendo.
✅ **El salto buscador → lista.** Con el foco en el buscador, `↓` baja al primer renglón; `Escape` vuelve con el texto **seleccionado** (teclear lo reemplaza). Es el gesto que separa "tiene teclado" de "se siente rápido" y existía en **1 de 153 pantallas**: [`bajarAlPrimerRenglon()`](libs/ui-web/src/keyboard/row-nav.ts) / `volverAlBuscador()`. ⚠️ **Acotá el alcance** si la pantalla tiene dos tablas, o el foco se va a la del panel de detalle. ⚠️ Con la lista vacía **no se mueve el foco**: mandarlo a la nada deja sin referencia y sin forma de volver sin el mouse.
⛔ **Una fila con `(click)` que el teclado no alcanza es un defecto, no una pantalla incompleta.** Medido: **23 archivos**. La salida es `pSelectableRow` (roving, un stop) y no `tabindex="0"` por fila, que da N paradas de tabulador y vuelve a romper D.4a.
⚠️ **La multi-selección con checkbox NO entra en esta regla:** ahí `pSelectableRow` secuestraría el clic de la fila —que en esas pantallas abre el detalle— y el checkbox ya es el camino de teclado. Exigírselo sería meter una regresión disfrazada de arreglo.
**Compuerta:** `npm run check:teclado` (12 casos de prueba negativa, 23 en deuda declarada), en `gate-push.js`.

**D.8 — Un buscador no se escribe con `.toLowerCase().includes()`.**
⛔ Falla de cuatro formas, y las cuatro se ven en un catálogo de dulcería: **acentos** (`pina` no encuentra `PIÑA`) · **varias palabras** (`coca 600` no encuentra `COCA COLA 600 ML`, pide la cadena contigua) · **el orden** (`600 coca` no encuentra nada) · **un solo campo** (corre sobre el nombre O sobre el SKU, nunca los dos). Medido en el servidor sobre `/compras/costo-estandar`: el `LIKE` ingenuo devolvía **18 filas donde hay 1,425**.
✅ **El motor existe y tokeniza: [`applySmartSearch`](libs/platform-core/src/lib/search/smart-search.ts).** Normaliza sin acentos, parte en tokens y exige **cada token en cualquier orden y en cualquier campo**, con typos por trigramas. Cobertura medida 2026-10-01: **15 archivos**.
✅ **Lista COMPLETA en memoria** (catálogo offline, combos) → [`coincideBusqueda`/`filtrarPorBusqueda`](libs/ui-web/src/search/buscar-en-cliente.ts) de `@megadulces/ui-web`, con la **misma semántica** que el servidor.
⚠️ **El límite se DECLARA y está probado: en el cliente NO hay tolerancia a typos** (eso es `pg_trgm`). Una aproximación en JS que *casi* da lo mismo que Postgres es peor que no tenerla — el mismo texto devolvería conjuntos distintos según quién filtró y nadie sabría cuál creer.
⛔ **Y la trampa estructural que tokenizar NO arregla:** filtrar en el cliente una lista **paginada** mira sólo las filas que llegaron. Buscás algo que está en la fila 400 y la pantalla dice que no hay. Ahí el arreglo es **mandar el texto al servidor** (→ D.3). Cambiar `includes` por `coincide` deja el bug intacto y se ve igual de verde.
**Compuerta:** `npm run check:busqueda` (8 casos de prueba negativa, 25 en deuda), en `gate-push.js`. ⛔ **El lado SERVIDOR queda declarado SIN CUBRIR:** hay **118 `LIKE`/`ILIKE`** y no todos están mal (`applySmartSearch` usa `LIKE` por dentro, el prefijo es legítimo, `::text LIKE` sobre dígitos es el camino numérico correcto). Separar los armados a mano exige verlos uno por uno; marcar los 118 enseñaría a ignorar la compuerta en la primera corrida.

🔸 **Lección de las dos compuertas de arriba, que se paga una sola vez:** la primera versión de `check-keyboard-nav` buscaba `selectionMode` **en todo el archivo** y marcó 8 pantallas — **7 eran falsos positivos**, porque `selectionMode="range"` es también un input de `p-datepicker` y casi toda pantalla con filtro de fechas lo tiene. **El criterio de una compuerta se MIDE contra los hallazgos reales antes de encenderla**: una que marca siete de ocho mal enseña a ignorarla en la primera corrida, y después ya no protege de nada.

**D.3 — Lo que no se puede arreglar desde el frontend se MARCA, no se esconde.** Con paginación de servidor, filtrar filas del lado del cliente deja huecos en las páginas y miente el total del paginador. Cuando la fuente manda algo que no corresponde (pseudo-productos contables en una pantalla de compras), el frontend lo **rotula y lo atenúa**, declara por qué está ahí, y el arreglo de fondo queda anotado como pendiente de backend. Esconder sin poder contar es peor que mostrar con etiqueta (ADR-056).

### Antipatrones para Operations (flag en review)
- Cabecera de columna numérica alineada distinto que su celda, o clase de alineación inventada por la pantalla en vez de `.num` (→ D.0).
- Campo numérico que cambia de valor al scrollear, o con el spinner nativo puesto en una columna de cifras (→ D.5).
- Grupo de botones contiguos con un tab stop cada uno; barra de filtros sin forma de limpiarlos ni conteo de activos; `role="tab"` sin `role="tabpanel"` (→ D.4).
- Control nativo (`<select>`, `<input type=checkbox>`…) conviviendo con su equivalente de PrimeNG en la MISMA vista: distinto alto, distinto foco, distinta cortinilla, y en oscuro lo pinta el sistema operativo en vez de nuestros tokens. Medido 2026-09-14: **5 archivos con `<select>` nativo contra 128 con `p-select`** (→ pre-vuelo 3).
- Control nativo (`<select>`, checkbox…) conviviendo con su equivalente de PrimeNG en la **misma vista**: distinto alto, distinto foco, distinta cortinilla, y en oscuro lo pinta el sistema operativo en vez de nuestros tokens. Medido 2026-09-14: **5 archivos con `<select>` nativo contra 128 con `p-select`** — es el outlier, no una convención alternativa (→ pre-vuelo 3).
- Sumar una librería de a11y/headless para un patrón que [`app-segmented`](apps/view/src/app/shared/components/segmented/segmented.component.ts) ya resuelve. `@angular/aria` **no está instalado** (verificado 2026-09-14) y la decisión de PrimeNG sigue abierta: mientras lo esté, **no crecer la dependencia** (→ pre-vuelo 3).
- Chip de valor y chip de toggle con el mismo aspecto (→ D.1).
- Fila con `(click)` a la que el teclado no llega, o una directiva de navegación propia para una tabla cuando `pSelectableRow` ya lo hace (→ D.7).
- Tabla con navegación encendida y campos en línea **sin** la guarda global: ahí `Space` deja de escribirse y `Enter` abre el detalle en vez de confirmar (→ D.7).
- Buscador con `.toLowerCase().includes(termino)`: sin acentos, sin varias palabras, sensible al orden y de un solo campo (→ D.8).
- Filtrar en el cliente una lista **paginada**: tokenizar no lo arregla, el texto tiene que ir al servidor (→ D.8, D.3).
- Cabecera con jerga sin señal de que es explicable, o explicación que sólo vive en un `title` (→ D.2).
- Píldora de frescura que dice **"Datos actualizados"** midiendo `Date.now()` del navegador: promete la edad del DATO y mide la de la CONSULTA. Si no hay timestamp del servidor, `measures="fetch"` y dice "cargado hace N" (→ VP.0).
- `font-size` con literal en vez de `var(--fs-*)`. La escala es **estricta**: un tamaño fuera de ella es un bug, no una preferencia.
- Dos acciones en `--action` en la misma fila: la que escribe en la DB deja de ser la obvia. Secundaria = ghost **neutro** (`p-button-text p-button-secondary`), no ghost naranja.
- Inter como `--font-body` en cualquier surface (es default de convergencia).
- Cards con íconos en círculos de color como decoración (AI slop #3).
- 3-column feature grid (AI slop #2) — aquí no aplica porque es tool, pero alguien podría caer en eso para un dashboard de KPIs.
- `#000` puro en dark mode.
- Morado `#8b5cf6` o azul `#2563EB` **como acento de IA o como color de acción**. *(El azul `#2563EB` sí es legítimo como `--info-*` — información, no acción ni IA. Lo prohibido es el rol, no el hex.)*
- Hex inline en color de pin Leaflet u otros componentes compartidos.
- Centered everything en empties.
- Empty state "No items found." sin contexto ni CTA.
- `!important` o `::ng-deep` como herramienta de primera mano en vez de capa de cascada + token de Tier 3 (→ [§S](#plataforma-web-moderna--cascada-responsividad-overlays-motion-nativo-binding)).
- Componente reutilizable que decide su layout interno con `@media` de ancho (→ [§R](#plataforma-web-moderna--cascada-responsividad-overlays-motion-nativo-binding)).
- Morado/azul como identidad de IA — ya listado arriba — **y** superficie de IA que sugiere sin razón, sin confianza y sin reversa (→ [§X](#superficies-con-ia--contrato-de-agentic-ux-binding)).

---

## Ingeniería de UI — contrato de implementación (BINDING)

> Alcance: **toda** superficie (Storefront + Operations + apps instalables). Añadido 2026-07-10.
> Complementa lo visual con el *cómo se construye*: por qué una composición funciona a nivel cerebral, cómo no se rompe con datos/errores reales, y cómo el motion no janquea ni fuga memoria. Base teórica: [`docs/DESIGN_FOUNDATIONS.md`](docs/DESIGN_FOUNDATIONS.md). Estas reglas se **verifican en review**, no son aspiracionales.

### 1. Fundamento cognitivo obligatorio (el *por qué*, no la etiqueta)
Toda decisión de layout se justifica por su **mecanismo perceptual**, no citando la ley suelta:
- **Gestalt (proximidad/similitud/continuidad)** = agrupación que baja el parsing visual de *n* elementos a *k* grupos. Un grupo se forma con **espaciado** (escala 4px), no con cajas/bordes por default — el borde es el último recurso, no el primero.
- **Hick** = recortar decisiones *simultáneas*. En toolbars densas y menús: curaduría + progressive disclosure antes que listar 20 acciones planas (→ `⌘K` cuando hay 20+ destinos, regla ya binding en datos densos §12).
- **Fitts** = target = f(distancia, tamaño). CTA primario grande y en zona alcanzable; en touch, `≥44px` (ya tokenizado por `pointer: coarse`). **Conflicto densidad↔Fitts:** en Operations `fine` gana la densidad (32–40px); en `coarse` gana Fitts (44px). No se promedia — lo decide el puntero.
- **Carga cognitiva** = la composición elegida debe *reducir esfuerzo mental*; si un layout necesita una leyenda para entenderse, falló. Jerarquía por **contraste de texto y peso**, no por más color.
- Patrón de lectura **Z** (pantallas de marketing/storefront) vs **F** (tablas/listas densas Operations): el CTA/acción principal cae donde el patrón deposita el ojo, no centrado por estética.

### 2. Matriz de estados por componente (el happy path es la fila 1, no la entrega)
Ningún componente se considera terminado sin sus estados. Cada entrega los declara:
- **Interacción:** `hover` · `focus-visible` (ring tokenizado, **nunca** `outline:none` a secas) · `active` · `disabled`. En touch, `active` (feedback ≤100ms) es el estado crítico — **nada** puede depender solo de `hover`.
- **Datos:** `loading` (skeleton dimensionado al contenido real → CLS 0; shimmer, no spinner de bloque — ya binding §4 datos densos) · `empty` (con acción de recuperación y microcopy de dominio, ver §7) · `error` (`catchError` + banner + reintento aislado — regla del repo "nunca fallar callado") · `overflow` (texto 10× — `truncate`+`title` o `line-clamp` justificado; números de 8 dígitos que no rompan columna).
- **Empty ≠ error de red:** son pantallas distintas. Nunca mostrar "no hay datos" cuando fue un fetch fallido (bug vivo documentado en PWA §5).

### 3. a11y técnica — AA piso duro, APCA como guía perceptual
- **Contraste:** WCAG **AA** es el requisito formal/legal (piso innegociable); **APCA** es el mejor predictor perceptual y manda cuando difieren, sobre todo en texto ≤14px de celdas densas (buscar Lc≥75 para body chico). Justificar el par de color con ambas métricas cuando no coincidan. Tokens en OKLCH (`FOUNDATIONS`).
- **Semántica + ARIA:** roles correctos; `aria-label` en todo icon-button; `aria-current` en selección master; labels `for/id` en inputs. El color **nunca** es único portador de significado (+ icono/texto — ya binding).
- **Foco:** navegación por teclado fluida; al abrir `p-dialog`/side-peek → mover foco dentro + **retornarlo al trigger** al cerrar; foco no obstruido por headers sticky. PrimeNG trae base ARIA pero **no es gratis** — se verifica, no se asume.
- **Estado del estándar (ago-2026), para no perseguir fantasmas:** **WCAG 2.2 AA es el piso vigente** (y lo que la EAA europea va a exigir vía EN 301 549 v4.1.1). **WCAG 3.0 sigue siendo Working Draft** — modelo Bronze/Silver/Gold, Recommendation esperada ~2028-2030 — y **APCA sigue exploratorio y no normativo**. Conclusión operativa: **no se espera WCAG 3**; quien cumple 2.2 AA hoy ya está construyendo Bronze. Nuestra postura (AA obligatorio + APCA como guía perceptual en texto chico) queda igual.
- **`contrast-color()`** resuelve el par texto/fondo cuando el fondo lo decide el dato (chips de grupo, badges de data-viz): usarlo en vez de elegir el par a mano — es donde el dark se rompe más seguido.

### 4. Presupuesto de motion + ciclo de vida (60fps o no se anima)
> Extiende el techo de motion ya binding (§11 datos densos, §Motion KPI). **GSAP ES dependencia desde el 2026-06-25** (`gsap@^3.15.0`) y corre en producción en `apps/portal`. Estas reglas rigen CSS/Web Animations API **por default**, y GSAP **sólo cargado con `import()` lazy** (patrón de referencia: `apps/portal/src/app/modules/portal/cart-fx.service.ts`). Motivo: el bundle inicial de `apps/view` ya excede su warning (1.171 MiB contra 1 MB; quedan ~234 KiB al error de 1.4 MB), así que nada de animación entra al `main`.
- **Solo propiedades de compositor:** `transform` + `opacity`. Prohibido animar `width/height/top/left/margin/padding/box-shadow` (layout thrashing/reflow). Si un efecto "lo necesita", se rediseña con `scale`/`clip-path`/crossfade de capas.
- **`will-change` quirúrgico y temporal**, nunca permanente (cada capa promovida come VRAM).
- **Change detection (⚠️ NO usar `NgZone` en código nuevo):** `apps/view` es **zoneless** (`provideZonelessChangeDetection()` en [`app.config.ts`](apps/view/src/app/app.config.ts)), así que **`NgZone.runOutsideAngular()` ya no es la herramienta** — ahí no hay tick de zona del que escapar. En zoneless, un callback de alta frecuencia (`onUpdate`, ScrollTrigger, `rAF`) **no dispara** change detection por sí mismo: sólo la dispara si escribe una `signal` que la vista consume. Regla: **el callback muta variables locales / estilos, y toca una `signal` lo menos posible** (idealmente una sola vez al final, no por frame). En las apps que todavía corran con zona, `runOutsideAngular()` sigue siendo válido — verificar el `app.config.ts` de *esa* app antes de aplicarlo. *(Retiro declarado en el Decisions Log 2026-09-09 y ejecutado el 2026-09-14; quedan ~30 usos heredados en código, barrido aparte.)*
- **Limpieza (memory leaks):** escopar al host y limpiar en `DestroyRef`. Con GSAP: `gsap.context(...)` + `destroyRef.onDestroy(() => ctx.revert())` — `revert()` sobre `kill()` porque además **restaura estilos inline** (crítico si el componente se re-instancia por navegación). ScrollTriggers viven dentro del context y mueren con él.
- **`prefers-reduced-motion`** gatea todo (`gsap.matchMedia()` o media query CSS) — ya patrón en el repo (`motion-safe`).

### 5. Container queries sobre media queries en componentes reutilizables (Nx)
- Un componente **compartido** — el que se embebe en más de un ancho (una card en el dashboard *y* dentro de un side-peek de 480px) — **no** decide su layout interno por viewport (`md:`/`lg:`/`@media`) sino por el espacio que le da el padre: `@container` sobre un wrapper con `container-type: inline-size`.
- **CSS crudo, no Tailwind.** El plugin `@tailwindcss/container-queries` **no está instalado** y estamos en Tailwind 3.4 (`apps/portal` ni siquiera tiene config de Tailwind). Las container queries se escriben a mano en el `styles` del componente — que es como ya están los 16 usos vivos del repo.
- **Trampa:** `container-type` establece contención de tamaño y **rompe elementos que se desbordan a propósito** (overlays PrimeNG, `p-overlay`, tooltips). Regla: container query en el *wrapper de layout*, no en el nodo que ancla overlays.
- **Dónde vive un componente compartido — estado real (medido 2026-09-14):** en [`apps/view/src/app/shared/components/`](apps/view/src/app/shared/components/) (19 componentes, ver [Inventario](#inventario-de-componentes-compartidos)). ⚠️ **`libs/` NO es hoy la casa de nada de frontend**: tiene **0 componentes Angular** (es backend NestJS + `contracts` + `design-tokens`). Mientras no exista una lib Angular, "ponelo en `libs/`" es una instrucción vacía — **no la sigas**: sumá el componente al shared de `apps/view` y declaralo en el Inventario.
- ⚠️ **Hueco abierto:** `apps/portal` y `apps/vendor` tienen **0 componentes compartidos** — cada una re-estila a mano (133 selectores de botón distintos entre las 3 apps). El repertorio del Inventario sirve sólo a `apps/view`. Una lib Angular compartida (`libs/ui`) es el prerrequisito real para que esta regla aplique cross-app; hasta entonces, la regla es **por app**.
- **Método completo** (las 4 herramientas, `rem` en breakpoints, regla del `clamp()`, style queries y `scroll-state`): [§R](#plataforma-web-moderna--cascada-responsividad-overlays-motion-nativo-binding). *(Auditoría ago-2026: esta regla existía desde jul-2026 y el repo tenía **0 usos** de `@container` — el gap se atacó ahí.)*

### 6. Error boundaries por sección + degradación elegante
- Angular **no** tiene error boundaries nativos — se construyen. Dos capas: `ErrorHandler` global para lo no capturado + por sección el patrón `catchError` con estado local y reintento aislado (reintenta *esa* query, no recarga la vista).
- Si una sección revienta (datos o render), el error se **contiene en ese nodo**; header, nav y demás secciones siguen operativas. Nada de pantalla en blanco.

### 7. Rigor de dominio (divisas, cantidades, fechas, TZ)
- La UI **nunca** renderiza número/fecha crudos. Divisa vía `Intl.NumberFormat('es-MX', {currency:'MXN'})` o `CurrencyPipe`; fechas con locale MX explícito.
- **`tabular-nums` innegociable** en toda columna numérica/dinero/qty/fecha (ya binding) — sin él los montos "bailan" y la tabla densa se ve rota. Números a la derecha, texto a la izquierda (jerarquía de lectura, no estética).
- **TZ:** backend ya normaliza en `America/Mexico_City` (`apps/api/src/shared/date/mx-date.ts`). Frontend: **no** re-convertir con `new Date()` ingenuo del navegador (descuadra el pedido de las 11:50 PM). Renderizar la fecha ya normalizada sin doble conversión.
- **i18n gotcha:** los pipes con locale `es-MX` requieren `registerLocaleData(localeEsMx)` en bootstrap, o `CurrencyPipe`/`DatePipe` caen a `en-US` en silencio. Verificar una vez a nivel app.
- **Microcopy = capa de diseño.** Empty/error/confirmaciones en español operativo de Mega Dulces con acción de recuperación ("No hay pedidos hoy" + CTA), nunca "No data found" placeholder.

### 8. Sanitización del render (XSS) — cero confianza en datos inyectados
- La data la teclean vendedores y captura de campo (nombres de producto, notas de visita): el vector es real en el backoffice.
- Default: interpolación `{{ }}` (Angular ya escapa). `[innerHTML]` **solo** con directiva de negocio explícita y pasando por `DomSanitizer.sanitize(SecurityContext.HTML, …)`.
- ⛔ **Nunca** `bypassSecurityTrustHtml` sobre input de usuario (ése es exactamente el agujero). Rich text real → allowlist de tags, no saneo ad-hoc.

### 9. Estado en la URL + optimistic UI
- **URL como fuente de verdad** en Operations con filtros/master-detail: filtro activo, fila seleccionada, tab y rango de fechas viven en query params, no solo en signals. Si no, F5 pierde contexto y no se puede compartir "este pedido filtrado".
- **Optimistic UI** en toda mutación de 1 registro (confirmar pedido, aprobar requisición, editar inline): pintar resultado optimista → reconciliar con server → rollback **visible** en error, sin spinner (ya binding §3 datos densos). Es decisión de UX por acción.

### 10. Verificación (definition of done)
- **Se prueba vivo, no se promete.** Con Chrome DevTools/Playwright MCP: screenshot en light/dark/móvil, trace de performance real. Endpoint nuevo → probar vivo o avisar que falta restart (regla del repo).
- Build de prod `nx build <p> --skip-nx-cache` de **todo** lo tocado (dev/caché tapa errores).
- QA visual contra **datos reales extremos** (nombres 80c, RFC raro, tablas 4k filas → virtual scroll, montos 8 dígitos), no lorem ipsum.

### 11. Gobernanza
Cuando un requerimiento choque con `DESIGN.md`, **no se resuelve en silencio**: se expone el conflicto y decide el usuario. "No desviarse del DS sin aprobación."

---

## Plataforma web moderna — cascada, responsividad, overlays, motion nativo (BINDING)

> Alcance: **toda** superficie. Añadido 2026-08-25, destilado de [`docs/DESIGN_TECNOLOGIA_2026.md`](docs/DESIGN_TECNOLOGIA_2026.md) (estado del arte técnico ago-2026) y de la auditoría de adopción del repo.
> **El diagnóstico que origina esta sección (ago-2026):** el DS visual iba muy por delante de la plataforma con la que lo implementábamos — **0 container queries** (aunque §5 ya las mandaba), **0 `@layer`** contra **971 `!important`** + **317 `::ng-deep`**, 124 breakpoints en px, y features gratis sin usar (`text-wrap`, `field-sizing`, `content-visibility`). Estas reglas se **verifican en review**.
>
> **Re-medición 2026-09-14 (3 semanas después) — el diagnóstico no se movió, y en dos ejes empeoró:**
>
> | Señal | ago-2026 | **2026-09-14** | Lectura |
> |---|---|---|---|
> | `@container` | 0 | **16** (8 archivos) | único avance real; todos en `apps/view`, ninguno en un componente compartido |
> | `@layer` | 0 | **0** | la cascada en capas **no existe**; §S es aspiracional |
> | `!important` | 971 | **961** | plano (−1%) |
> | `::ng-deep` | 317 | **370** | ⛔ **+17%** contra una métrica que dice "no sube" |
> | breakpoints en px | 124 | **169** (rem: 26) | ⛔ **+36%**, siendo antipatrón declarado |
>
> **Conclusión operativa, no reproche:** una regla marcada BINDING que sólo se "verifica en review" se cumple exactamente tanto como la revisión alcance a mirar. Las tres cifras que empeoraron son las tres **mecánicamente medibles** — o sea, las que un gate habría frenado. Sin gate, esta sección describe una intención. Ver [Estado de cumplimiento](#estado-de-cumplimiento--lo-que-el-doc-manda-vs-lo-que-el-código-hace).
> **Regla marco — mejora progresiva:** todo lo de esta sección entra bajo `@supports` cuando no es Baseline widely available. El piso es que la pantalla **funcione sin la feature** (el campo corre Android de gama baja). Ninguna capacidad moderna es requisito de render.

### R. Responsividad por capas — 4 herramientas, 4 trabajos
Cada herramienta tiene **su** trabajo; usar la de al lado es el bug:

| Herramienta | Trabajo | Regla |
|---|---|---|
| `@media` | **página / chrome**: sidebar colapsa, tab bar móvil, densidad por `pointer: coarse` | Solo para esto. Breakpoints nuevos en **`rem`** (respetan zoom), nunca px |
| `@container` | **componente**: cómo se reorganiza según el ancho que le dio el padre | Obligatorio en todo componente **compartido** (`shared/components/`) y en cualquiera que viva en >1 ancho (card, tabla, panel de master-detail). CSS crudo — el plugin de Tailwind no está instalado (→ §Ing.UI 5) |
| `clamp()` | **fluido**: type y spacing entre extremos | Máximo **≤ 2.5×** el mínimo y término medio con componente `rem` (si no, rompe WCAG 1.4.4 a 200% de zoom) |
| Grid intrínseco | **layout sin breakpoints**: `auto-fit` + `minmax()`, `subgrid` para alinear filas entre cards | Preferido sobre inventar un breakpoint |

```css
/* el mismo componente en Operations (ancho completo), en un side-peek (~420px) y en /portal */
.card-wrap { container-type: inline-size; container-name: card; }

@container card (min-width: 30rem) {
  .card        { grid-template-columns: 1fr auto; }
  .card__spark { display: block; }
}
@container card (max-width: 22rem) {
  .card__meta  { display: none; }   /* progressive disclosure por espacio real, no por viewport */
}
```

- **Trampa (repetida a propósito):** `container-type` crea contención de tamaño y **rompe lo que se desborda a propósito** (overlays PrimeNG, tooltips). El contenedor va en el *wrapper de layout*, jamás en el nodo que ancla un overlay.
- **Densidad como token heredado:** cuando haya que variar densidad por contexto, `@container style(--density: compact)` en vez de repetir clases en cada hijo. La densidad la sigue decidiendo el **puntero** (regla ya binding).
- **Header de tabla pegado:** estilo del sticky con `@container scroll-state((stuck: top))`, no con `IntersectionObserver`.
- ⛔ **Prohibido** un `@media` de ancho dentro de un componente reutilizable para decidir su layout interno.

### S. Cascada en capas — el fin de la guerra de especificidad
- **Orden declarado una sola vez, global:**

```css
@layer reset, vendor, tokens, components, utilities;
/* vendor = PrimeNG/spartan. Nuestro CSS vive en components/utilities y gana por capa, no por selector */
```

- **`!important` requiere justificación explícita en review** (comentario en el sitio: qué regla de vendor está peleando y por qué no alcanza la capa). No se acepta "para que agarre".
- **`::ng-deep` es solo para vendor**, con comentario, y con horizonte de retiro: si el componente es nuestro, se resuelve con token de Tier 3 o `@scope`.
- **Métrica de QA:** el conteo de `!important` y `::ng-deep` **por módulo** no sube. Bajar es la dirección; subir necesita justificación.
  - ⛔ **Re-medido 2026-09-14 y la métrica se incumplió sin que nadie se enterara:** `::ng-deep` **317 → 370 (+17%)** y `!important` 971 → 961 (−1%, plano). **`@layer` sigue en 0**, así que el orden de cascada de arriba **no existe en el código** y la justificación que esta sección le exige a un `!important` ("contra qué regla de vendor pelea y por qué no alcanza la capa") es **imposible de dar**: no hay capa que pueda no alcanzar.
  - **Causa de fondo, no de disciplina:** una métrica declarada sin instrumento es una intención (ADR-056). Hasta que haya gate en CI, se mide a mano con `grep -rn "<patrón>" apps libs --include=*.css --include=*.scss --include=*.ts --include=*.html | grep -v node_modules | wc -l` para `::ng-deep`, `!important` y `@layer`.
  - **Orden de trabajo:** primero declarar `@layer` una vez global (sin eso lo demás no tiene a dónde ir), recién después bajar los conteos. Mientras `@layer` sea 0, **esta sección es aspiracional y hay que leerla así.**
- Estilos de módulo nuevos: `@scope` antes que subir especificidad.

### T. Overlays y controles nativos — menos JS de plomería
Para UI **nueva** (no se reescribe lo que ya funciona con PrimeNG):

```html
<!-- hovercard de cliente/SKU: cero JS, cero listeners, cero librería de posicionamiento -->
<a interestfor="hc-cliente" href="/comercial/clientes/123">DEMO-001</a>
<div id="hc-cliente" popover="hint" class="hovercard">…saldo, última compra, riesgo…</div>
```

```css
.hovercard { position-anchor: --cli; position-area: block-end span-inline-end; }
@position-try --flip { position-area: block-start span-inline-end; } /* se reacomoda solo al borde */
```

- **Popover API + anchor positioning** (Baseline 2026) para tooltip / hovercard / popover de filtro. ⛔ Nada de cálculo de posición en JS en código nuevo.
- **`<dialog closedby="any">` + `:open`** para confirmaciones: el foco y `Esc` los da la plataforma (pero la regla de **foco al abrir + retorno al trigger** sigue siendo nuestra y se verifica).
- **Invoker commands** (`command`/`commandfor`) para abrir/cerrar sin handler.
- **`appearance: base-select`** para selects triviales con nuestros tokens, en vez de pelear el theming del vendor.
- **`@starting-style` + `transition-behavior: allow-discrete`** para la entrada de popover/dialog (mata el flash), dentro del techo de motion.
- **Custom highlights** para resaltar coincidencias de `applySmartSearch` sin inyectar `<mark>` por `innerHTML` (además cierra el vector XSS de §8).

### U. Motion nativo — la plataforma primero
> No cambia el presupuesto (§Motion es la única fuente de duraciones/curvas: techo **350ms**, solo `transform`+`opacity`, `prefers-reduced-motion` gatea todo). Cambia **con qué se implementa**.
- **View Transitions** para transiciones de ruta y master→detail: `provideRouter(routes, withViewTransitions())` + `view-transition-name` en el elemento que persiste (la fila que se convierte en detalle). Antes que animar a mano.
- **Scroll-driven animations** (`scroll-timeline` / `view-timeline`) para progreso, header que condensa y reveals: sin listeners de `scroll`, sin trabajo en el hilo principal. Jamás rotación ni translación grande sin gate de reduced-motion.
- **Springs sin librería:** `linear()` genera easings tipo resorte. **No se introduce una librería NUEVA de animación para eso** — GSAP ya está y se usa lazy; `anime.js`/`framer` no entran. ⚠️ `motion@^12.38.0` está instalada desde el 2026-04-27 con **cero imports en todo el repo**: es dep muerta, y una tercera librería sería la segunda muerta.

### V. Presupuesto de interacción y percepción (INP < 200ms)
- **Criterio de aceptación** de toda vista densa: la respuesta a la interacción (filtro, orden, selección, expandir fila) **< 200ms**. Se **mide** (DevTools/Playwright MCP o campo), no se estima. Un filtro de 400ms es defecto de diseño, no deuda de infra.
- Palancas por orden de rendimiento: **virtualización** en tablas de miles de filas → **`content-visibility: auto`** en listas/secciones largas → **`@defer`** en bloques pesados (charts, mapas Leaflet) → ceder el hilo en handlers de filtro → memoizar con `computed()`.
- **CLS 0** sigue siendo requisito (skeleton dimensionado al contenido real, ya binding §2).
- La medición de campo (soft navigations ya reconocidas para SPA desde jul-2026) es backlog `DT.3`: hasta que exista, la medición es local y explícita en el PR.

### W. Ganancias gratis (usar por default en código nuevo)
- **`text-wrap: balance`** en títulos de card / page-head (≤4 líneas) y **`pretty`** en párrafos y microcopy: mata la palabra huérfana sin tocar el layout.
- **`field-sizing: content`** en inputs de cantidad (carrito, take-order, requisición) y textareas de nota: adiós al auto-resize en JS.
- **`light-dark()`** para el token que solo difiere por tema: una declaración en vez de dos bloques (menos chance de que dark quede roto).
- **`interpolate-size: allow-keywords` / `calc-size()`** para animar acordeones y paneles a altura `auto` sin hackear `max-height`.
- **`contrast-color()`** para el texto sobre chips/badges cuyo fondo lo decide el dato (data-viz, color por grupo): resuelve el par de contraste solo, en ambos temas.
- **`:has()`** para estado dependiente del contenido (fila con selección, card con error, form inválido) en vez de calcular clases en TS.
- **`attr()` tipado** y **`sibling-index()`** para chips/gauges por dato y stagger de filas, en vez de `[style.--x]` binding.

### Antipatrones (flag en review)
- `!important` nuevo sin comentario que justifique contra qué vendor pelea.
- `::ng-deep` sobre un componente **nuestro** (es un token de Tier 3 mal hecho).
- `@media (max-width: 768px)` **en px** o dentro de un componente reutilizable para decidir su layout interno.
- Tooltip/hovercard nuevo con posicionamiento calculado en JS.
- `clamp()` con máximo >2.5× el mínimo o sin componente `rem` (rompe el zoom).
- `container-type` puesto en el nodo que ancla un overlay (overlay recortado).
- Animar `width/height/top/left` "porque view transitions no alcanzaba" — se rediseña, no se excepciona.
- Vista densa entregada sin número de latencia medido cuando la tabla pasa de ~200 filas.
- Feature moderna usada como requisito (pantalla vacía o rota en un navegador/dispositivo sin soporte) — falta el `@supports` y el camino base.

---

## Superficies con IA — contrato de agentic UX (BINDING)

> Alcance: toda UI donde un motor o agente **sugiere, propone o ejecuta** algo: Maat (chat + hallazgos + `proposed_actions`), Thot (canasta/sugeridos), Horus (parte diario, auditoría visual, fraude), RA (sugerido de compra, requisiciones), alertas y nudges. Añadido 2026-08-25 desde el estado del arte de agentic UX 2026 (los seis patrones canónicos) — detalle y mapeo en [`docs/DESIGN_TECNOLOGIA_2026.md §8`](docs/DESIGN_TECNOLOGIA_2026.md).
> **Herencia:** ADR-016 / ADR-020 / ADR-021 — **el motor decide, el agente comunica, el LLM fuera del camino del dinero**. Esta sección es el *cómo se ve* de esa tesis. Identidad visual = **ember** (nunca morado ni azul; regla ya binding).
> **Tesis:** en 2026 el problema de diseño de la IA no es la capacidad, es la **confianza**. Y la confianza no se declara: se construye con transparencia, control, consistencia y buen manejo de la falla.

### X. Los seis, como reglas
1. **Plan antes de ejecutar (Intent Preview).** Acción irreversible, que mueve dinero, que escribe en un tercero o que afecta a muchos registros → se muestra **el plan en lenguaje llano** con opciones **Proceder / Editar / Lo hago yo**. Nunca "listo, ya lo hice" como primer contacto. Es la forma visual del HITL que ya usamos (`finance.proposed_actions`, requisiciones RQ).
2. **Nivel de autonomía explícito y por dominio (Autonomy Dial).** El usuario ve —y donde aplique, ajusta— cuánta libertad tiene el motor **por tipo de tarea**: observar → sugerir → actuar. Lo de bajo riesgo (refrescar vistas, reclasificar por regla determinista) puede ser autónomo; lo que toca dinero o terceros, nunca por default. El nivel vigente se muestra, no se asume.
3. **Razón en llano, no logs (Explainable Rationale).** Toda sugerencia trae su **por qué** como dato estructurado ("porque este cliente compra X cada 14 días y lleva 26"), no un volcado del razonamiento del modelo. Nadie quiere leer la cadena de pensamiento; quieren saber **qué hizo, con qué confianza y cómo verificarlo**. El link a la evidencia (póliza, ticket, foto, movimiento) es parte de la razón — patrón que ya hacemos bien en hallazgos y hay que sostener.
4. **Confianza visible (Confidence Signal).** Si el motor tiene score/precisión (`score 0..1`, `precision_score`, umbral por percentil), **se muestra** con forma perceptual (no solo el número) y con su alcance ("esto lo estimo, esto lo leí"). Usarla solo para suprimir por dentro es desperdiciarla y alimenta el sesgo de automatización.
5. **Auditoría + reversa con ventana (Action Audit & Undo).** Toda acción del motor queda en un log cronológico consultable **desde la UI** (ya lo hay en histórico de pedidos y audit de chat) y, cuando el dominio lo permite, con **undo prominente** y **ventana explícita** ("se puede revertir hasta que se timbre / hasta el cierre del día"). Si algo no es reversible, se dice **antes** (se conecta con la regla 1 y con la fricción de la acción destructiva).
6. **Ruta de escalación (Escalation Pathway).** Ante ambigüedad el motor **escala, no adivina**: pide la aclaración mínima, ofrece opciones válidas o marca "esto lo decide un humano". El chat debe poder decir "no sé" y ofrecer a quién preguntar. Escalar es un resultado exitoso, no una falla.

### Presentación
- **Progressive disclosure siempre:** resumen accionable arriba (answer-first, regla Q), detalle y evidencia al drill-down. El razonamiento largo va colapsado por default.
- **La IA no es un botón, es una capa presente-opcional:** se puede ignorar sin perder la pantalla. Nada crítico vive **solo** dentro del chat.
- **Cero cifras del LLM en pantalla:** todo número renderizado viene de una query/tool determinista. Si el texto del modelo trae un número, es bug (regla ya viva en Maat/Thot).
- **Estado de trabajo honesto:** "buscando en 3 fuentes…" con lo que ya encontró; jamás un spinner opaco ni una animación que finja progreso.
- **Feedback del humano = dato de entrenamiento** (👍/👎, confirmar/descartar, pin): visible, con efecto declarado ("dejaré de mostrar esta regla si sigue fallando"), reversible.

### Dirección (no binding aún)
**Generative UI estándar:** que el agente emita un **blueprint declarativo** (A2UI v0.9, Apache 2.0, tiene renderer Angular) y el host renderice **nuestros** componentes con nuestros tokens, en vez de markdown parseado. Encaja con el `render_response` que Thot/Maat ya usan y respeta la tesis (el modelo emite *layout*, nunca cifras). Spike `DT.11` — cuando se apruebe, sube acá como regla.

### Antipatrones (flag en review)
- Acción del motor ejecutada sin plan previo cuando toca dinero, terceros o muchos registros.
- Sugerencia sin razón, o con "razón" que es un volcado del prompt/razonamiento.
- Score de confianza usado solo internamente y nunca mostrado.
- Cifra tomada del texto del modelo y pintada como dato.
- Acción del agente sin rastro en un log consultable desde la UI.
- Chat que inventa antes que escalar ("no sé" no está en su repertorio).
- Morado/azul como identidad de IA (ember es la identidad).
- Todo el valor de una función encerrado en el chat, sin superficie determinista equivalente.

---

## Leyes de interacción + arquitectura de interacciones resilientes (BINDING)

> Alcance: **toda** superficie Operations con captura, datos volátiles o acciones que mutan DB. Añadido 2026-07-20 (destilado de la revisión de puntos ciegos de la IA como dev de frontend, con Edgar). Convierte el DS de "guía visual" en **contrato de interacción resiliente**: la IA diseña la fachada perfecta y omite la plomería (estado sucio, concurrencia, fallos parciales, doble-clic). Estas reglas se **verifican en review**, no son aspiracionales. Complementan [Ingeniería de UI](#ingeniería-de-ui--contrato-de-implementación-binding).

### Leyes de interacción / densidad (complementan §Ing.UI 1)

1. **Tesler (conservación de la complejidad).** La complejidad inherente de una operación (contabilidad, reglas SAT, conciliación) no se elimina, solo se traslada — y en Operations se traslada al **código** (cálculos automáticos), **no** al usuario ni a un colapsable. ⛔ **Prohibido ocultar datos vitales o filtros críticos** tras hamburguesas/tabs/acordeones en desktop "por limpieza": esconder complejidad operativa genera ansiedad. Progressive disclosure es legítimo **solo** para lo secundario/avanzado y debe verse como tal. Densidad ordenada > minimalismo que esconde.

2. **Miller (chunking).** Ningún formulario con **>6 campos consecutivos** sin separador visual (grupo/tarjeta con su título: "Datos fiscales", "Contacto", "Condiciones de crédito"). Todo valor alfanumérico **>6 caracteres** (SKU, folio, RFC, UUID de factura) se muestra segmentado (`1234 5678 90`) — pero **la separación es de presentación** (CSS/spans): el valor copiable/buscable queda intacto, sin espacios ni guiones (se copia/pega a Kepler/SAT). Romper el paste es peor que la estética.

3. **Jakob (familiaridad).** No se reinventan patrones que el usuario ya conoce de otras herramientas: tabla = Excel (filtros arriba, orden en header, paginación abajo), búsqueda arriba, `⌘K`, breadcrumbs. Innovar en la interacción de una pantalla operativa **frena** la productividad del equipo. Lookbook (Mobbin/Base Web) antes de inventar un flujo. Refuerza los "SAFE choices" + PrimeNG-first.

4. **Proximidad numérica (Gestalt aterrizada).** En formularios, el margen inferior de un grupo de inputs = **2×** la distancia `label↔input` (el label pega a SU input, no al anterior). En tablas densas, el header pega a los datos y el `padding` vertical no infla la densidad (usar `--row-h-*`); demasiado aire entre etiqueta y dato rompe la asociación visual (el "efecto Dribbble").

5. **Von Restorff — jerarquía de acción destructiva.** La acción destructiva (borrar, cancelar pedido, anular/cancelar factura) **nunca** usa `--action` (sunset); usa `--bad-fg` (patrón ghost-bad) + exige **confirmación con fricción proporcional o undo**, y va **físicamente separada** de la acción diaria (Fitts: no pegar "Borrar" junto a "Guardar"). Una sola acción primaria destacada por pantalla; el resto, discreto.

6. **Poka-yoke (prevenir > reportar).** El diseño previene el error antes de reportarlo: validación **inline** al blur, submit **deshabilitado** mientras el form es inválido, formatos guiados (máscara RFC/teléfono/importe), unidades explícitas. El mensaje de error es el último recurso, no el primero.

7. **Keyboard-first en captura.** Todo formulario de alta frecuencia: **autofocus** al primer campo, `Enter` = submit (salvo textarea), tab order lógico según el orden visual, atajos para lo repetitivo. Los capturistas viven en el teclado; obligar al mouse los frena. Complementa inline-edit (§datos densos 9) y ⌘K (§datos densos 12).

### Arquitectura de interacciones resilientes

8. **Estado sucio + navigation guards (anti-pérdida).** Todo formulario de captura compleja rastrea `isDirty`. Con `isDirty === true`: navegación **interna** (Router) interceptada por `CanDeactivate` con modal "¿Descartar cambios sin guardar?"; salida **externa** (cerrar pestaña / refresh) con `beforeunload` (prompt nativo — el texto ya no es customizable en navegadores modernos, y es lo esperado). `Esc` cierra modales de **lectura**; en un modal de **captura activa** pide confirmación, nunca descarta en silencio. Aplica a: requisición, take-order, captura/emisión CFDI, conciliación.

9. **Datos añejos + frescura (concurrencia).** Toda vista de datos volátiles (existencia, tickets en vivo, pedidos, ledger) muestra **indicador de frescura** ("actualizado hace N min") y **refresh local** (re-consulta esa vista, no recarga la SPA — patrón ya usado en los botones "Refresh MVs" de analytics/command-center). Con WS/polling: **anclar el scroll** — insertar filas nuevas **no** debe desplazar bruscamente la posición si el usuario está interactuando con una fila (rompe Fitts en movimiento). *(El ticker de `/tienda/live` prepende: verificar que no salte durante hover/expand de un ticket.)*

10. **Fallos parciales en lote.** Toda acción masiva maneja respuesta **parcial** (nunca binaria éxito/error): el backend devuelve resultado por ítem; la UI muestra resumen explícito ("48 procesados · 2 fallaron") o tabla de resultados. Los ítems fallidos **permanecen seleccionados** en la tabla para corregirlos; solo se limpia la selección de los exitosos. ⛔ Prohibido el toast rojo global que oculta 48 éxitos, o el verde que oculta 2 fallos. Aplica a: timbrado masivo CFDI, descarga masiva SAT, upsert de precios, aprobación de requisiciones.

11. **Idempotencia visual (anti doble-clic del pánico).** Todo botón que muta DB (POST/PUT/DELETE) se **deshabilita a sí mismo de forma síncrona en el instante del primer clic** (`[loading]`/`[disabled]` **antes** de esperar la promesa de red), no al resolver. Defensa en profundidad con idempotencia de servidor (clave `client_uuid` / UPSERT por folio — ya en route-sale y `commercial.order_sequences`). Crítico en pago, timbrado, confirmación de pedido, liquidación.

### Antipatrones (flag en review)
- Formulario de captura largo sin `CanDeactivate` (se pierde todo al presionar Atrás).
- Tabla de dato volátil sin frescura ni refresh local; ticker WS que salta el scroll al insertar.
- Bulk action con toast único rojo/verde que oculta el resultado real por ítem.
- Botón de pago/timbrado que no se deshabilita hasta que responde la red (registros duplicados).
- Dato vital escondido tras un colapsable "por limpieza" (viola Tesler).
- SKU/folio renderizado como cadena pegada de 10+ dígitos (viola Miller).

---

## Arquitectura de layouts por sector + ayuda contextual (BINDING)

> Alcance: Operations. Añadido 2026-07-20. **El layout sigue a la operación, no al componente**: cada sector tiene una plantilla estructural **inmutable** que el dev/IA no reinventa por pantalla. Reconcilia y **tensa** los patrones de datos densos según el contexto operativo. Se verifica en review.

### O. Layout por sector

**O.1 — Fiscal / Contable (alta precisión).** Alcance: `/contabilidad/*`, `/finanzas/*`.
- **Layout: Master-Detail permanente** (split). Al seleccionar un documento, su visor (XML · estado del sello digital · desglose de impuestos · timeline) aparece **al lado** sin perder el listado.
- ⛔ **Prohibido modal superpuesto para LEER documentos financieros extensos** (CFDI, póliza, conciliación, DIOT). El modal queda para confirmar/crear corto.
- Reconciliación con §datos densos 8: el **side-peek drawer** es aceptable para detalle ligero; para documento fiscal extenso → **split permanente**, no drawer efímero.

**O.2 — Operativo / Almacén y Compras (densidad + volatilidad).** Alcance: `/compras/*`, `/almacen/*`, `/logistica/*` (inventario).
- **Layout: full-width data grid** con **header y fila de totales congelados**. El sidebar es **colapsable a íconos** con un **modo foco** que cede el 100% del ancho a la grid (no forzado siempre; a un clic).
- **Lectura a distancia:** contraste alto y tamaño suficiente (el operador mira de lejos / en movimiento).
- **Tolerante a red:** indicador **offline prominente** (§PWA 5) + **frescura visible** (§9). El dato de existencia es volátil: nunca se ve estático sin señal de cuán fresco es.

**O.3 — Comercial / Mostrador (velocidad, fricción cero).** Alcance: superficie **POS / captura en vivo** — `/tienda` (POS), `/vendor` take-order, `/telemarketing` take-order.
- **Layout: keyboard-first / POS.** Foco **permanente** en el input de búsqueda/captura (listo para escáner / ingreso rápido). El **TOTAL y las acciones de cobro dominan** la jerarquía visual sobre cualquier otra métrica.
- **Adición en tiempo real al tope** de la lista (feed de ticket/captura), **no paginación tradicional**.
- **Reconciliación (crítica) con §datos densos 7:** esto aplica SOLO a la superficie de captura/POS en vivo. Las **listas transaccionales/auditables** (bandeja de pedidos, facturas, ledger de stock) **siguen paginadas** — auditabilidad manda. No confundir "mostrador" (feed) con "bandeja" (registro).
- **Excepción confirmada (decisión 0Sistemas, 2026-09-12):** `/tienda/verificador` (`TiendaVerificadorComponent`) NO sigue esta sección — es un clon fiel a propósito del kiosco `verificador.html` retirado en la Fase CV: Sniglet en vez de Hanken Grotesk, paleta cruda propia (`--vf-*`, mismas cifras hex del HTML original) en vez de tokens, fondo con patrón decorativo, tema fijo (siempre claro, ignora el modo oscuro del navegador). Es la única pantalla del repo con esta excepción — no repetir el patrón en otro módulo sin la misma autorización explícita. Lo que sí sigue intacto (no es "look"): foco permanente, procedencia del precio, declarar-en-vez-de-esconder (ADR-056), "no encontrado" ≠ "sin conexión" (§pre-vuelo 6).

### P. Ayuda contextual (Abouts por módulo)

- Toda pantalla con **reglas de negocio estrictas** (criterio de existencia crítica, umbrales ABC/XYZ y nivel de servicio, estados 1-6 del SAT, reglas de materialidad, safety stock) incluye un componente **`<app-context-help>`**: cajón lateral deslizable (o popover amplio) que documenta la lógica de **ese** módulo, sin sacar al usuario de la pantalla.
- **La descripción NO se inventa:** se consume de un **diccionario de negocio predefinido y versionado** (fuente única, p.ej. `shared/context-help/context-help.dictionary.ts`), no se redacta ad-hoc en el template. Si falta la entrada, se agrega al diccionario, no un texto suelto.
- **Trigger:** icono `?` en el header del apartado; abre el cajón. A11y: focus-trap + Escape + retorno de foco (§PWA 6). **No intrusivo** — nunca auto-abre.

### Antipatrones (flag en review)
- Modal para leer un CFDI / póliza / conciliación extensa (viola O.1).
- Grid de existencias con el sidebar comiéndose el ancho, o sin totales congelados (viola O.2).
- Existencia/stock volátil sin indicador de frescura ni de offline (viola O.2 + §9).
- Mostrador/POS con paginación tradicional o sin foco permanente en el input de captura (viola O.3).
- Aplicar "no paginación" a una bandeja auditable de pedidos/facturas (rompe §datos densos 7).
- Texto de ayuda de negocio inventado en el template en vez de consumir el diccionario (viola P).

---

## Jerarquía visual + comprensión del dato (interfaces densas en valores) — BINDING

> Alcance: superficies **densas en cifras** — tablas de conciliación, tableros de KPIs, ledgers, existencia, egresos, pólizas, cualquier grid con muchos valores. Añadido 2026-07-22 (destilado con Edgar sobre el rediseño de `/finanzas/bancos`). Donde hay **muchos números**, el riesgo #1 no es el estilo: es que el usuario no entienda **qué mira, qué significa, dónde está el problema y qué hacer**. Estas reglas convierten "muchos valores" en "una respuesta". Complementan [§Ingeniería de UI 1 (fundamento cognitivo)](#ingeniería-de-ui--contrato-de-implementación-binding) y [O.1 (Fiscal/Contable)](#arquitectura-de-layouts-por-sector--ayuda-contextual-binding). Se **verifican en review**.

**Q.1 — Answer-first (pirámide invertida).** La pantalla abre con la **conclusión** — veredicto / total / "¿cuadra? · cuánto · qué falta" — no con la herramienta cruda. El dato primario domina por tamaño+peso+posición; la evidencia y el grid de N filas van al drill-down. ⛔ Si lo primero que ve el usuario es una tabla de cientos de filas en vez de la lectura del periodo, falló.

**Q.2 — Explicar el número, no solo mostrarlo.** Todo número no trivial lleva su **lectura en lenguaje llano** al lado ("de $X, Kepler reconoce $Y → difieren $Z"), no solo el Δ crudo. Cuando el backend ya computa el porqué (dirección + causa), se **muestra**; no se entierra en una sola vista.

**Q.3 — Señalar dónde está la diferencia.** En conciliación/comparación/descuadre, la UI apunta a la **fila/renglón exacto** del problema (expandible o enlazado), no solo el total agregado. Si el backend calcula la evidencia (el renglón donde salta el saldo, el par que no casa), se muestra **en contexto**.

**Q.4 — Redirección desde el dato.** Todo número/estado que **evidencia algo** es **navegable a su lugar de arreglo con el filtro ya puesto** (chip de estado, fila, Δ, ítem de checklist → vista+filtro exactos). El usuario no vuelve a buscar lo que el sistema ya sabe señalar. Refuerza estado-en-URL (§Ing.UI 9).

**Q.5 — Tres niveles de jerarquía explícitos.** Cada pantalla declara **primario / secundario / terciario** y lo expresa por **escala de tipo** (`--fs-*` + `--fw-*`) + **contraste de texto** (`--fg-1/2/3`), nunca por color ni por más cajas (refuerza §Ing.UI 1). `tabular-nums` innegociable para que las columnas de cifras se lean como columnas.

**Q.6 — Color de grupo al servicio del entendimiento.** Cuando el color codifica categoría/grupo en un grid de muchos valores (patrón banco/Excel), es **determinista** (mismo grupo→mismo color siempre), **sutil** (tinte/borde, no fill saturado), **dark-safe** (paleta `--chart-*`, sin morado), con **leyenda visible** y **nunca único portador** (siempre + etiqueta/categoría). Es la excepción data-viz de la directiva quiet-luxury, no licencia para decorar.

**Q.7 — Abouts (regla P) donde haya jerga.** El entendimiento del dato incluye poder consultar qué significa cada término sin salir de la pantalla: `<app-context-help>` desde el diccionario versionado.

### Antipatrones (flag en review)
- Pantalla de muchos valores que abre en el grid crudo, sin veredicto/lectura arriba (viola Q.1).
- Δ / total mostrado sin explicación en llano de qué significa o por qué (viola Q.2).
- "No cuadra $X" sin señalar la fila que lo causa (viola Q.3).
- Número que evidencia un problema pero no lleva a arreglarlo (viola Q.4).
- Jerarquía "lograda" con colores/cajas en vez de tipo+contraste (viola Q.5).
- Color de grupo inconsistente, saturado, sin leyenda, o como único portador de significado (viola Q.6).

---

## Gráficas — contrato de data-viz (§G) — BINDING

> **Por qué existe esta sección** (agregada 2026-10-03): el sistema tenía `--chart-1..8` y **nada
> más**. Ninguna regla sobre ejes, cero, escala, truncado, leyenda ni orden — y Maat, el Command
> Center, Horus y los reportes pintan gráficas todos los días. Una paleta no es un contrato: evita
> que dos series se parezcan, no evita que la gráfica **diga algo falso**.
>
> El resto del documento se ocupa de que un número se entienda. Esta sección se ocupa de que una
> **forma** no mienta, que es un riesgo distinto: un número mal leído se nota; una barra mal
> escalada convence.

**G.1 — El eje de una barra ARRANCA EN CERO. Sin excepción.** La barra codifica magnitud por su
longitud; si el eje arranca en 80, una diferencia de 2% se ve como el triple. Si el rango útil es
estrecho, **la barra no es el gráfico**: usá una línea, un sparkline o un bullet, que codifican
posición y sí admiten un eje recortado. *(Un eje de línea recortado es legítimo y se rotula.)*

**G.2 — Lo que no se midió NO se dibuja como cero.** Es ADR-056 sobre una forma: un hueco en la
serie se corta o se sombrea como "sin dato", nunca se interpola ni se apoya en el eje. Un cero
dibujado es indistinguible de un cero real, y la gráfica no tiene dónde poner la aclaración.

**G.3 — El color de serie sale de `--chart-1..8`, en orden, y es determinista.** El orden ya está
por separación perceptual y **sin morado** (anti-slop #1). La misma categoría lleva el mismo color
en todas las pantallas: si "Dulces Típicos" es `--chart-1` en el Command Center, lo es también en
el reporte. ⛔ Nada de asignar color por posición en el resultado de la consulta — cambia con el
filtro y el lector cree que cambió el dato.

**G.4 — El color nunca es el único portador.** Vale la regla #5 del pre-vuelo: toda serie lleva
etiqueta directa o leyenda, y un cambio de estado lleva además forma (flecha, icono, texto). Es lo
que hace que la gráfica siga diciendo lo mismo impresa (§DS.8) y en Alto Contraste (12c) — donde
el navegador puede forzar los colores.

**G.5 — Leyenda sólo si no se puede etiquetar directo.** Una leyenda obliga a ir y volver entre la
forma y su nombre. Con ≤4 series, la etiqueta va **pegada a la serie**. La leyenda es para cuando
hay más, y entonces se ordena como los datos (mayor a menor), no alfabéticamente.

**G.6 — Truncar es una decisión que se declara.** Un "Top 10" dice **cuánto queda afuera**
("10 de 428 · 62% del total"). Sin eso, el lector asume que está viendo todo, y es la forma más
común de que una pantalla honesta se lea como una mentira.

**G.7 — Eje de tiempo completo, con su unidad.** Los huecos de calendario se muestran como huecos
(un domingo sin venta es un domingo sin venta, no una línea que salta). Toda cifra lleva su unidad
y su moneda explícitas — y si viene de otra unidad de medida, se resuelve antes de graficar
([`UNIDADES_DE_MEDIDA.md`](docs/UNIDADES_DE_MEDIDA.md)), no en el eje.

**G.8 — Micro-viz = SVG crudo, 0 KB.** Sparkline, mini-barras, bullet y ring se dibujan a mano
(ya existen en `shared/components/charts/`). Una librería de charts para un sparkline es
antipatrón — ver [`DESIGN_MOTION_KPI_CARDS.md` §7](docs/DESIGN_MOTION_KPI_CARDS.md). uPlot sólo si
aparece un panel de series temporales interactivo.

**G.9 — Frescura y procedencia también en la gráfica.** Una gráfica es un número publicado: lleva
su `as_of` / píldora de frescura como cualquier cifra (ADR-056, §VP). Una serie vieja dibujada con
la misma confianza que una fresca es exactamente lo que la Fase VP existe para impedir.

### Antipatrones (flag en review)
- Barra con eje recortado · dona con más de 5 porciones · dona para comparar (usá barras).
- Eje doble con dos escalas distintas — hace parecer correlación donde no la hay.
- Hueco de dato dibujado como cero, o interpolado sin decirlo.
- Color de serie por índice del resultado, o inventado con un hex.
- "Top N" sin decir de cuántos ni qué porcentaje cubre.
- Gradiente decorativo bajo una línea cuando el área no codifica nada.
- Chart.js/ApexCharts para un sparkline.

---

## PWA / App instalable (BINDING)

> Alcance: toda app que se **instala** en el dispositivo. Hoy `apps/vendor` (mobile-first, vendedor en campo); candidatos: `/portal` y `apps/view`. Origen: auditoría del vendor 2026-06-18 (manifest copiado de `apps/view`, sin service worker, `theme-color` hardcodeado). Bases teóricas + fuentes en [`docs/DESIGN_FOUNDATIONS.md` §10](docs/DESIGN_FOUNDATIONS.md).

### Tesis
Una app instalada **promete capacidades nativas**: arranca offline, se ve como app (no como pestaña), respeta el notch, y no muere sin señal. Si instalás algo que falla igual que la web, rompiste el contrato. El vendedor en ruta es el caso límite: **señal intermitente es el estado normal, no el error.**

### 1. Service worker — OBLIGATORIO en app instalable
- Registrar con `provideServiceWorker` (Angular) + `ngsw-config.json` por app. Sin SW, "instalable" es una mentira: cero offline, cero caché, cero update flow.
- **App shell + chunks lazy**: `prefetch`/`lazy` en `assetGroups` → la cáscara abre sin red.
- **Datos (GET)**: `dataGroups` con `freshness` (red primero, cae a caché) para listas de ruta/cartera; `performance` (caché primero) solo para catálogo/recursos casi-estáticos. Definir `maxAge`/`maxSize` explícitos.
- **Update flow visible**: al detectar `VersionReady`, ofrecer "Hay una nueva versión — actualizar" (no recargar a la fuerza en medio de un pedido).

### 2. Manifest — por app, nunca copiado
- **Prohibido reusar el manifest de otra app.** Cada `manifest.webmanifest` describe SU app.
- `name` / `short_name`: nombre real user-facing (no `vendor-MD`).
- `start_url`: la **ruta real de arranque** del rol (vendedor → `/vendor/route-home`), no `/`.
- `shortcuts`: **solo rutas que existen en esa app**. Un shortcut a una ruta inexistente cae al `**` redirect = bug silencioso.
- `theme_color` / `background_color`: derivados del tema (superficie de chrome = `--card-bg`), **no `#FFFFFF` fijo** si la app tiene dark mode.
- `icons`: incluir `192` y `512` + variantes `purpose: "maskable"` (Android adaptive). `display: "standalone"`.

### 3. Chrome del SO (status bar / splash / theme-color)
- `theme-color` en `index.html` debe **derivar de `--card-bg`** (regla cross-proyecto, ver `feedback_pwa_mobile_chrome`), no un hex suelto.
- Si el tema togglea en runtime (modo oscuro del shell), **actualizar el `<meta name="theme-color">` por JS** al cambiar — el meta estático no sigue al toggle.
- iOS: `apple-mobile-web-app-status-bar-style: black-translucent` + `apple-mobile-web-app-title` real.

### 4. Safe-area (notch / home indicator) — BINDING
- Header sticky, bottom-nav, FAB y bottom-sheets usan `env(safe-area-inset-*)` (ya correcto en `vendor-shell` y `route-home` — **conservar**).
- `viewport` con `viewport-fit=cover` siempre que se use `env(safe-area-inset-*)`.

### 5. Offline UX — contrato de UI (aunque la cola sea deferred)
- **Distinguir "vacío real" de "fallo de red".** Empty-state ("no tenés cartera") y error-state ("no se pudo cargar — reintentar") son pantallas DISTINTAS. Nunca mostrar el empty cuando fue un error de fetch. *(Bug vivo en `route-home`: `forkJoin` que falla cae al empty de "sin cartera".)*
- Todo error de carga ofrece **Reintentar** explícito.
- Escrituras críticas (tomar pedido, marcar visita) → destino futuro es **cola offline (Dexie)** con reintento; mientras siga deferred, el estado de red debe ser **visible** (banner "sin conexión", no fallar en silencio).
- Indicador de conexión cuando la app está instalada (no hay barra del browser que lo delate).

### 6. A11y de superpuestos en app instalada (sin chrome del browser)
- Bottom-sheets / modales: **focus trap + cierre con Escape + `scroll-lock` del body + restaurar foco al abridor + `aria-labelledby`**. En instalada no existe "back del browser" como escape — el patrón debe bastarse solo. *(Gap vivo en el bottom-sheet de `route-home`.)*
- Touch targets ≥44px en flujos críticos (ya se cumple en FAB/sheet-primary).

### 7. Viewport / zoom
- `user-scalable=no` + `maximum-scale=1` **rompe WCAG 1.4.4** (zoom). Se tolera como excepción documentada solo por la desalineación de inputs en iOS (`feedback_pwa_mobile_chrome`). Preferir arreglar el layout y **permitir zoom**; si se mantiene el bloqueo, justificarlo en el PR.

### Antipatrones PWA (flag en review)
- App "instalable" (con manifest) **sin service worker**.
- Manifest copiado de otra app (shortcuts/start_url/colores de otra superficie).
- `theme_color` / `theme-color` blanco fijo bajo una app con dark mode.
- Empty-state mostrado en un fallo de red (sin Reintentar).
- Modal/sheet sin focus-trap ni Escape en app instalada.
- Escritura crítica que falla en silencio sin señal de "sin conexión".

---

## Decisions Log
| Fecha | Decisión | Razón |
|------|----------|-------|
| 2026-10-03 | **Cierre de la auditoría: lo que se bajó con cambio visual CERO, lo que NO se bajó así, y las dos superficies que el sistema no nombraba.** **(1) Tres deudas bajadas sin mover un píxel:** zebra (63 ocurrencias en 40 plantillas de una clase que **llevaba meses sin regla** — declaraban una intención que el sistema descartaba en silencio), breakpoints **206 → 0** (root en 16px ⇒ conversión exacta; ⚠️ **no es no-op puro**: en un `@media` el `rem` se mide contra el tamaño de letra **inicial del navegador**, así que para quien lo subió el layout cambia antes — que es para lo que §R lo pide), y `font-size` **3,161 → 2,687** convirtiendo sólo los **495 literales EXACTOS**. ⛔ **(2) Lo que NO se convirtió, con su razón:** los que quedan están **fuera de la escala** (`.8rem` = 12.8px cae entre `--fs-xs` 12 y `--fs-sm` 13) — tokenizarlos **mueve el texto**, y eso se hace con la pantalla a la vista; y los 144 que caen en un token de **ROL** (`1rem`→`--fs-h3`) se saltearon porque la muestra tiene `h2`/`h3` reales **pero también** `.qty-num`, `.va-input input` y `.kv dd`: mapear un input a un token llamado "h3" lo haría moverse el día que alguien retoque los títulos. ⭐ **Hallazgo: la escala no tiene un peldaño de 16px con nombre de TAMAÑO** — el único 16 es `--fs-h3`. Decisión de diseño abierta. ⛔ **(3) Y ese mismo barrido rompió 14 sitios**: metió `var(--fs-*)` dentro de **tickets de impresión y exports a PDF**, que se renderizan **fuera del árbol de la app**, sin `:root` — ahí la propiedad no resuelve y el navegador **tira la declaración entera**. Revertidos a px. *La pregunta antes de tokenizar un `font-size` no es en qué archivo está: es **dónde se renderiza**.* Y 53 de los 72 que marqué eran **falsos positivos** (los `*.styles.ts` se importan DENTRO de `styles: [...]`): revertirlos habría deshecho trabajo bueno. **(4) Dos superficies que el doc no nombraba:** el **papel** (§DS.8, `print.css`) y las **gráficas** (§G, nueve reglas). Las dos existían en producción hace años sin una sola regla. **(5) INP ya se mide en `apps/view`** — no hubo que construir nada: el endpoint, el servicio y la librería estaban; faltaba la llamada. **(6) `motion@^12.38.0` NO se quitó**, y la razón corrige a la que este doc daba: no es "toca `package.json`", es que **está en el lockfile y el CI corre `npm ci`** — sacarla a medias rompe el `npm ci` de todos. | Lo mecánico se baja con un script **si y sólo si el valor nuevo es el mismo número**; en cuanto mueve un píxel, deja de ser mecánico y necesita ojos. Y un barrido automático sobre 200 archivos **va a tocar algo que no entendés**: el seguro no es revisarlo antes, es tener una compuerta que lo note después — acá lo notó `check:estilos` poniéndose roja por mi propia reversión. |
| 2026-10-03 | **El anillo de foco: dos tokens porque son dos roles, 37 controles que no lo tenían, y una compuerta que se puso verde por el motivo equivocado.** ⭐ **(1) `--action-ring` es el HALO (`box-shadow`), `--focus-ring` es el ANILLO (`outline`).** Eran el mismo valor y el translúcido al 30% servía para los dos usos; como color de `outline` eso da **1.44:1 sobre tarjeta clara** contra el piso de **3:1** de §datos densos 13 y WCAG 1.4.11. **103 anillos estaban por debajo del piso.** Hoy `--focus-ring: var(--action)` → 3.08 a 5.87:1 según el fondo, y los **25 halos de `box-shadow` quedaron intactos**, que ahí el translúcido es lo correcto. ⚠️ **El mismo 3.39:1 que hace fallar a `--action-ink` acá PASA**: foco pide 3:1, texto pide 4.5:1 — *citar un ratio sin su piso no dice nada*. **(2) 37 controles sin ningún anillo, y 24 eran campos de entrada**: los dos de escaneo (andén de almacén, etiquetas de tienda), el login de las dos apps, los steppers del vendedor, el verificador de mostrador, los tabs de PrimeNG en las 3 apps, y **los buscadores que D.7 acaba de volver navegables con teclado** — la ruta existía y era invisible. Arreglados los 37; tope **0**. ⛔ **(3) La compuerta tenía el defecto que venía a buscar.** Su primera versión preguntaba si el ARCHIVO contenía `:focus-visible` en cualquier parte — así que **en cuanto un archivo ganaba un anillo, todo `outline:none` agregado después pasaba en silencio**, y eso dejaba ciegos justo a los 20 archivos recién arreglados. **La encontró su propia prueba negativa, el mismo día.** Reescrita por CONTROL, destapó **10 defectos más** que el criterio por archivo tapaba. Y en el camino se corrigieron **dos criterios demasiado estrictos** medidos contra los hallazgos reales: un anillo hecho con `box-shadow` vale igual que uno con `outline` (patrón vivo del repo), y un bloque que ya responde al foco puede apagar el `outline` si pone otra señal — pero **`border: none` y `background: none` NO son señal: apagar no es señalar**, y ésa era la firma exacta de los 27. Los cinco casos quedaron en el `--self-test` (20 en total). | **Un gate que se pone verde por el motivo equivocado es peor que no tenerlo**, porque además da permiso. El criterio de una compuerta se mide contra los hallazgos reales **antes** de encenderla — y después se rompe a propósito, que es lo único que distingue una compuerta de una intención (ADR-056). |
| 2026-10-03 | **⛔ NO se adopta stylelint. Las 4 reglas de CSS van en una compuerta de la casa** ([`check-estilos.js`](scripts/check-estilos.js), `[DS.3]`). La auditoría del día anterior había recomendado stylelint; **al ir a instalarlo, la medición lo desmintió**: el **89%** de los `font-size` y el **95%** de los hex crudos de este repo viven **dentro de template literals de TypeScript** (337 componentes con `styles:` inline contra **28** `.component.css`). Angular no usa una plantilla taggeada de CSS sino un string suelto en una propiedad del decorador, así que ni `postcss-lit` lo toma limpio: stylelint de fábrica habría visto **~1 de cada 10 defectos** y cobrado una dependencia nueva —más su sintaxis custom— por esa décima parte, justo con la decisión de PrimeNG abierta. `check-template-literals.js` **ya extraía esos bloques** con el compilador de TS: la compuerta reusa ese camino y llega al 100%, con cero dependencias. Las cuatro reglas: escala `--fs-*` · hex crudo en color · breakpoint en px · `outline:none` sin `:focus-visible` hermano. **Son un ratchet, no un muro:** cada una congela la deuda de hoy y frena cuando CRECE — con 3,161 literales vivos, una compuerta absoluta estaría roja para siempre y enseñaría a ignorarla en la primera corrida (que es cómo se perdió `check-keyboard-nav` al marcar 7 falsos de 8). ⭐ **Hallazgo que salió de encenderla: 27 controles con `outline:none` y sin anillo de reemplazo, y 24 de los 27 son CAMPOS DE ENTRADA** — los dos campos de escaneo, el login de las dos apps, los steppers del vendedor y **los buscadores que D.7 acaba de volver navegables con teclado**: la ruta existe y es invisible. Se listan uno por uno (`--lista`) y **no se arreglaron a ciegas**: el anillo correcto difiere entre Storefront y Operations. | **La herramienta correcta depende de la forma del código, no de su reputación.** Y un instrumento que nace rojo no protege de nada: protege el que nace verde con la deuda declarada y sólo se enoja cuando alguien la empeora. |
| 2026-10-03 | **Auditoría del sistema de diseño y sus tres satélites — lo que se arregló y lo que se decidió.** ⭐ **(1) El techo de motion pasa de intención a medición.** `npm run check:motion` en CI con prueba negativa aparte; Operations queda en **0** incumplimientos en las **dos** notaciones. Disparador: el arquetipo más copiado del repo (`MetricStrip`, 81 pantallas) llevaba **tres semanas** con `transition: width 900ms` **después de estar escrito como ⛔ en la tabla de cumplimiento de este archivo** — o sea que escribirlo acá no alcanzó. ⚠️ **Y la cifra publicada estaba sesgada**: *"19 por encima del techo"* contaba sólo `ms`; sumando segundos eran 40+, y la compuerta encontró **40 más** que tres barridos manuales no vieron (en `animation: nombre 0.6s ease` la duración no está donde uno la busca). **El instrumento no es sólo para que no vuelva: ve lo que el barrido no ve.** **(2) El techo se declara POR SURFACE.** §Motion decía *"nada lo supera"* y el doc de cards decía que el Storefront puede llegar a 2s: las dos no pueden ser ciertas, y el código obedecía la segunda hace meses. Operations 350ms duro; Storefront con momentos de celebración declarados. *Una regla que el código contradice hace meses no es una regla.* **(3) `forced-colors` deja de ser un hueco.** Tenía **0 usos** en todo el repo y la flota es Windows; este sistema —hairline + alpha-overlays + semáforo por fondo— es el que peor se lleva con Alto Contraste: los tres estados de fila colapsan en uno y el anillo de foco hecho con `box-shadow` desaparece. `libs/ui-web/src/forced-colors.css` en las 3 apps. **(4) Las cifras de la tabla de cumplimiento ahora publican su COMANDO.** Se intentó reproducir tres (*171 hex*, *76 `<th>` vacíos*, *55 BINDING*) y no se pudo: el número estaba sin su patrón ni su universo. **Una cifra que sólo puede re-medir quien la escribió no es una medición.** **(5) `DESIGN_TENDENCIAS_2026.md` caducó EN VERDE y se revalidó:** afirmaba ✅ sobre **cinco** decisiones que el sistema revirtió después (Fraunces ×7, Stone ×3, espresso ×3, una escala de spacing que nunca existió, y un rango de motion que contradecía el techo binding). **(6) Dos defectos de este mismo archivo:** la tabla de Surfaces —que el paso 1 del pre-vuelo vuelve obligatoria— tenía **5 defectos** (faltaban `/mkt`, `/presupuesto`, `/desarrolladores`, `/diagnostico` y `/captura/:token`; sobraba `/mi-trabajo`, que **no es una ruta** sino la carpeta del componente de `/projects`), y el bloque «Superficies — LIGHT» documentaba `var(--stone-*)`, la rampa que este mismo doc declara retirada —cero consumidores, sólo vive en 3 comentarios— así que **enseñaba a escribir un `var()` que no resuelve**. **(7) `tokens.css`: `.portal-shell` redeclaraba `--font-body` (copia literal de `:root`) y `--font-mono`, que YA HABÍA DIVERGIDO** — `:root` caía a `'Courier New'` y el portal a SFMono. El día que Geist Mono no cargue, Operations imprimía los precios en una Courier con serifas. Es exactamente lo que advierte el comentario que estaba doce líneas arriba. | Un documento de 1,242 líneas con decenas de BINDING y *"se verifica en review"* se degrada en las reglas que nadie mide, y se degrada **rápido**: 19 días de evidencia dan `!important` +7.6%, `::ng-deep` +18.6%, breakpoints en px +22%, tamaños de letra distintos **97→120**. Las que se cumplen solas (tipografía, tokens, GSAP lazy) tienen **un solo lugar donde vivir**. La conclusión no es más párrafos: **regla con un solo lugar + instrumento que la mida**. El instrumento que falta tiene nombre —**stylelint con 4 reglas**— y es una dependencia nueva: decisión de Edgar. |
| 2026-10-03 | **Mesa de Servicio (`/servicio`, Fase MS): superficie Operations, y las cuatro reglas de UI que se decidieron al construirla.** (1) **Prioridad con tokens, no con hex:** Baja neutro · Media `--info-*` · Alta `--warn-*` · Urgente `--bad-*` (la Bitácora que sirvió de referencia usaba hex sueltos). (2) **Una sola ficha para los dos oficios** (`sd-request-detail`): quien reporta ve cerrar/reabrir/cancelar; quien atiende, tomar/estado/prioridad/asignar/tiempo/nota interna; lo que el solicitante no debe ver (notas internas, tiempo) **no llega del servidor**, no se esconde con CSS. (3) **Sin semáforo donde no hay meta:** `/servicio/reportes` publica el porcentaje de cumplimiento sin rojo/verde porque nadie ha registrado «90 % es verde»; pintarlo exigiría inventar el umbral en el componente — el color llega cuando haya meta. Y lo que no se midió sale «—», nunca «0». (4) **Tablas con `dt-stack` + `data-label`** desde el primer commit: la bandeja (8 columnas) la rechazó `check:tables` y se arregló apilando, no subiendo el umbral. **El botón «Reportar un problema» vive en el header del layout** y lo comparten todas las áreas; `SERVICIO_REPORTAR` es una clave sin destino en el mapa de la suite a propósito (si abriera un destino, cajeras y almacenistas perderían la auto-entrada a `/projects`). ⚠️ **Hallazgo del doc, no corregido aquí:** la tabla de Surfaces de arriba sigue sin listar `/desarrolladores`, `/mkt` ni `/presupuesto` (medido contra `app.routes.ts` el 2026-10-03); quien sea dueño de esas áreas debe agregarlas. |
| 2026-09-26 | **`/compras/pedido` en celular vertical (menos de 40rem): la tabla principal oculta 11 de 15 columnas y el desglose por sucursal pasa a TARJETAS (`[RA-PRO.59]`).** Quedan Producto · Exist. red · Suma Ped. · $ Pedido; cada sucursal es una tarjeta (sucursal y valor · venta, existencia, días · − cantidad + y cj/pz · entrega) armada con CSS grid sobre las MISMAS celdas (no hay segunda copia del template). La barra inferior queda en un renglón con resumen corto que se abre al tocarlo. Tableta y escritorio no cambian. | Se aparta a propósito del default de tabla densa (§organismos 3: scroll horizontal con primera columna pegada), en el caso que [`DESIGN_TABLES.md`](docs/DESIGN_TABLES.md) §6 ya preveía: *"vista card/stack por fila solo en pantallas muy chicas si el scroll horizontal se vuelve ilegible"*. Medido en un celular real: la columna pegada de 15rem dejaba ver UNA columna, y al llegar a la cantidad del desglose la sucursal ya se había ido; la leyenda inferior tapaba ~35% de la pantalla. El corte usa `@media` en `rem` (es la página, §R) y una señal `compacto()` con el mismo corte sólo para los textos de los botones, que el CSS no puede cambiar. ⚠️ Las columnas ocultas se eligen por **posición** (`nth-child`): si se agrega o mueve una columna, hay que actualizar la lista (queda escrito junto a la regla). |
| 2026-09-26 | **D.5 enmendada: en la columna Pedido de `/compras/pedido`, `← →` suman / restan un paso y en táctil hay botones `−` / `+` (`[RA-PRO.57]`).** Los botones sólo se pintan con `@media (pointer: coarse)`, miden 44px y no enfocan el campo (no abren el teclado); mantener presionado repite. `↑ ↓` siguen moviendo de renglón. | Lo pidió Compras: en tableta y celular el teclado virtual tapa media tabla, y en escritorio ajustar de a uno no debería exigir teclear. **Se declara qué se pierde:** mover el cursor dentro de la cifra con `← →` (casi no se usa: al llegar el valor ya está seleccionado; con `Shift` se conserva lo nativo). La propia D.5 ya preveía el stepper `+`/`−` para pantallas que lo quisieran. |
| 2026-09-14 | **El spinner nativo se retira global desde [`libs/ui-web/src/number-input.css`](libs/ui-web/src/number-input.css) — el mismo lib que la guarda de la rueda, porque son las dos mitades del mismo contrato (D.5).** Importado por el `styles.css` de las 3 apps; un stylesheet global penetra los componentes. Se retiraron las **4** reglas scopeadas que ya lo hacían (`portal-cart`, `portal-recommendations`, `vendor-take-order` ×2, `compras-pedido-real`): una sola fuente. Verificado **en el bundle de las tres apps**, no sólo en el build. Y se corrigió un comentario de `compras-pedido-real` que decía *"ahora Shift+↑↓ mueve de a 10"* — ese atajo se había retirado horas antes y el comentario quedó mintiendo, que es justo lo que D.5 prohíbe. | ⚠️ **Esta fila corrige una afirmación que este mismo doc había hecho el mismo día:** que el spinner *"no tiene forma global honesta"* porque no se puede distinguir una columna de captura de un filtro suelto. Es falso — de los **tres** daños que la propia D.5 le imputa al spinner, **dos no dependen de eso** (targets de ~9px bajo el piso de 24px, e inexistentes en touch: en media flota el spinner ni existe). Lo que sí necesita saber si es una columna es el **teclado**. **Confundir las dos mitades de una regla dejó un barrido abierto de más** — y es el mismo error de forma que arrastraba la medición original ("23 componentes… sólo 1 protege la rueda *o* quita el spinner" mezclaba dos cosas que resultaron ser 1 y 4). ⭐ **Nota de proceso: el gate de comentarios que se acababa de commitear atrapó DOS backticks míos en los comentarios CSS de este mismo cambio, minutos después de existir** — novena vez en la sesión. Lo que perdería el tiempo buscándolo desplazado salió con archivo y línea en 2 s. |
| 2026-09-14 | **`check:templates` deja de ser el gate del backtick y pasa a ser el gate del comentario que se cierra solo: tres casos, una familia.** Se le suman (2) el cierre de comentario **CSS** prematuro, parseando cada `styles:` con **esbuild — el mismo parser que usa el build de Angular**, y (3) el cierre de comentario **HTML huérfano** en un `template:`, por desbalance (no heurística: sin falsos positivos). **Baseline medido antes de cablear: 305 componentes · 281 templates + 269 bloques de estilo · 0 hallazgos · 0 bloques con `${}`** — o sea cobertura total, sin subconjunto ciego, y compuerta dura en cero sin necesidad de ratchet. ~1.8 s → **2.9 s**. Cuatro pruebas negativas antes del verde: los tres casos rotos a propósito salen `1` apuntando a la línea correcta, y el camino "no medido" (un `styles:` con `${}`) sale `0` **pero declarando**. | **El caso 2 es el que justifica la extensión, y es el único de los tres que el build deja pasar en VERDE.** Angular lo compila, esbuild lo reporta como *warning*, nadie lee los warnings, y la regla desaparece del bundle — así estuvo el aviso "precio cambiado" del verificador de mostrador, sin estilo en producción. `tsc` tampoco lo ve: es CSS, no TypeScript. Se eligió **esbuild y no postcss** por dos razones: postcss es tolerante y se traga el comentario mal cerrado sin chistar, y un gate que usa un parser distinto al del build es un gate que puede **discutirle a la verdad**. La pista de "backtick en un comentario" quedó **acotada al caso 1**: ante un CSS roto, esa lista mandaría a buscar donde no está — que es exactamente el pecado original de este bug. ⚠️ Sigue sin cubrir: un `styles:` con `${}` no se puede parsear (el texto depende de una expresión) y por eso se **declara NO MEDIDO** en la salida en vez de saltarse callado (ADR-056). Hoy son 0; el día que aparezca uno, el resumen lo dice. |
| 2026-09-14 | **La guarda de la rueda deja de ser un handler por componente y pasa a `libs/ui-web` — el primer lib de frontend compartido del repo.** [`installNumberWheelGuard()`](libs/ui-web/src/number-wheel-guard.ts): un listener en fase de captura, `passive`, instalado una vez en el `main.ts` de `view`, `portal` y `vendor`. Se retiró el `onQtyWheel` local de `compras-pedido-real`. Además, **se arregló un defecto visible en producción que apareció midiendo esto**: en [`tienda-verificador.component.ts`](apps/view/src/app/modules/tienda/pages/tienda-verificador.component.ts) un comentario de CSS decía `--warn-*` con la barra pegada, la secuencia **cerraba el comentario ahí mismo**, y el texto restante quedaba absorbido en el selector de `.vf-cambio` — Angular le pegó el atributo de scope a cada palabra. Verificado en el bundle: la regla **no existía**, la caja de aviso "precio cambiado" del verificador de mostrador se renderizaba sin estilo. El build lo decía sólo como *warning*. | **Un mecanismo que hay que acordarse de aplicar se cumple tanto como la revisión alcance a mirar — y acá la medición dio 1 de 30.** Se eligió listener global sobre directiva justamente por eso: la directiva que se olvida no rompe nada, sólo vuelve a dejar el campo expuesto, que es el modo de falla que produjo los otros 29. El caso peor era [`almacen-recepcion-sesion`](apps/view/src/app/modules/almacen/pages/almacen-recepcion-sesion.component.ts#L173), el único que **commitea en `(blur)`**: ahí la rueda cambiaba la cantidad recibida de un vale y el blur la guardaba. La prueba negativa (romper la guarda a propósito → rojo en el caso 1) se corrió antes de dar el verde. ⚠️ **Lo que NO cierra:** el spinner y el teclado de columna siguen por componente — no hay forma global honesta de distinguir una columna de captura de un filtro suelto. Y el `*/` prematuro es **la misma familia** que el backtick suelto de `check:templates`: puntuación dentro de un comentario que termina el comentario, con el error desplazado y el build en verde. *(Cubierto el mismo día — ver la fila de arriba.)* |
| 2026-09-14 | **Auditoría visual de `/compras/pedido` → 6 arreglos + 3 reglas nuevas (D.1/D.2/D.3) + 5 antipatrones.** Arreglado en [`compras-pedido-real.component.ts`](apps/view/src/app/modules/compras/pages/compras-pedido-real.component.ts): (1) **escala tipográfica** — 62 de 65 `font-size` pasaron de literal a `var(--fs-*)`; los 2 que quedan son **glifos de icono** (1.4/1.6rem), fuera de la escala de TIPO, y lo dicen. (2) **Header de columna** al spec de §datos densos 10 (`--fs-micro` uppercase muted): heredaba `--fs-sm` en caja normal, así que la tabla y su propio desglose se veían de dos sistemas distintos **en la misma pantalla**. (3) **Cobertura 14/30/45** de chips ad-hoc a `app-segmented` + separador visual de los toggles (D.1); `setCoverage()` era código muerto que además llamaba a `loadAll()` en vez de `loadWorkbook()`. (4) **Jerga descubrible**: `th[title]` con subrayado punteado + `cursor:help` — una regla CSS, cero markup, 22 cabeceras (D.2). (5) **Frescura**: se retiró la píldora hecha a mano y su `setInterval` de 60s; entra `app-freshness-pill measures="fetch"`. (6) **Pseudo-productos contables** rotulados y atenuados (D.3), y el ghost del XLSX bajado a neutro para que "Requisición" vuelva a ser la única acción naranja. | **Lo que la pantalla enseñó no es sobre la pantalla.** (a) La **escala tipográfica es la regla binding peor cumplida del sistema**: esta pantalla tenía **16 tamaños distintos y cero tokens**, y el repo entero tiene **97 tamaños y 38% de adopción** — por eso las pantallas densas se ven desparejas sin que nadie sepa señalar qué está mal. (b) **Tres de mis propios hallazgos estaban mal y los corrigió medir**: dije que faltaba la píldora de frescura (existía, pero decía "Datos actualizados" midiendo el reloj del navegador — peor que faltar), que el glosario no estaba en el diccionario (sí estaba; el problema era que **nada anunciaba que existía**), y que había 66 hexes cálidos sueltos (eran 50 fallbacks muertos y 3 comentarios). **Auditar por grep de síntoma sobrestima el ruido y pierde la causa.** (c) El criterio para marcar lo contable **no se inventó**: `unidad = 'SER'` ya era la identificación canónica en `catalogo-interno.service.ts` —cuyo comentario nombra literalmente "DEVOLUCIONES 16%", la primera fila de la captura— y en `receiving-session.service.ts`. ⚠️ **Sistema de soluciones sólo-frontend** (decisión de Edgar en esta sesión): el arreglo de fondo de (6) es excluir `'SER'` en la query del workbook, igual que los otros dos módulos; queda **declarado como pendiente de backend**, no aplicado. ⚠️ Y me comí el gotcha #1 del repo escribiendo estos mismos comentarios: **acento grave dentro del template literal** — quinta vez documentada. Build `view` verde. |
| 2026-09-14 | **Tercer y último paso: el Storefront también pasa a zinc → UNA sola familia de neutrales en toda la suite, y se retira la rampa `--stone-*`.** Decisión de Edgar ("cambiemos los demás"). `.portal-shell`/`.pl-wrap` **dejan de pisar** los neutrales —no se reescribieron a zinc, se **borraron**: heredar es más barato que duplicar, y un override que repite al padre es la forma más común de que dos definiciones diverjan sin que nadie lo note (ya pasó en este archivo, ver cabecera 2026-08-12). El portal conserva propio sólo `--font-body`/`--font-mono` y `--ai-accent`. El dark espresso del portal se retira. Barrido completo en el mismo commit: **16 usos de `var(--stone-N)` dentro de Operations** (15 en `apps/vendor`) que mi búsqueda por hex no veía, los **8 gradientes de `brand-placeholder.ts`** (thumbnails del catálogo, regenerados en zinc **conservando el L\* exacto de cada extremo** → misma progresión de tonos y mismo contraste del monograma), los banners PWA y el `theme-color` de las 3 apps, y el `#333333` hardcodeado del `liquid-tabs-indicator` que existía **sólo porque** `--neutral-700` era café cálido — ahora vuelve al token. | **Una segunda rampa paralela es una segunda cosa que puede divergir.** El propio encabezado de `tokens.css` documenta la vez que pasó. Con el portal en zinc, `--stone-*` quedó en **cero consumidores**: dejarla declarada era invitar a re-partir el sistema, así que se borró (está en git). ⚠️ **Lo que este barrido enseñó sobre cómo auditar color:** buscar por **hex** encuentra poco y miente. De 55 ocurrencias de la paleta vieja, **50 eran fallbacks muertos** de `var(--token, #hex)` —el token siempre existe, el hex nunca se aplica— y de las 5 "reales" **3 eran comentarios**. O sea: la búsqueda por hex decía "66 islas cálidas" y no había casi ninguna. Las islas de verdad estaban en `var(--stone-N)`, que usa el **token correcto de la familia equivocada** y ningún grep de hex lo ve. **Al migrar una paleta hay que barrer las tres formas: el hex, el token de la familia vieja, y el fallback dentro de `var()`.** Builds `portal` + `vendor` verdes. |
| 2026-09-14 | **Corrección el mismo día: Slate → ZINC.** Al ver la app real con slate, el veredicto fue *"demasiado azulado"*. Se cambió `:root --neutral-*` a la rampa **zinc** de Aura (`#FAFAFA`…`#09090B`), más `--ink-rgb`, `--text-disabled`, `--shadow-float`, `--skeleton-bg` y los `--chart-fill-*`; y se **re-agregó** el override de `surface` en `operations-preset.ts`, ahora con zinc — porque Aura sirve **slate** en claro por default y sin ese override los componentes PrimeNG quedaban azules bajo un chrome zinc. El modo oscuro **no se tocó**: ya era zinc, así que ahora hay **una sola familia de neutrales en los dos modos** (Aura misma se parte en slate/zinc, y esa partición era justo la incoherencia que originó todo). | **⭐ La lección que deja, y es la de más valor de toda la sesión: lo que tiñe una pantalla NO es el fondo, es el chrome.** El ground de slate era casi neutro (croma 0.0069) y aun así la pantalla se leía azul, porque **el croma crece bajando la rampa**: borde 0.0126, texto faint **0.0351** — 5× el ground. Los bordes de las cards, los iconos y el texto secundario cubren muchísima más superficie visual que el fondo, así que mandan ellos. Medido el corte al pasar a zinc: ground **−81%**, borde **−68%**, faint **−63%**, muted **−61%**, texto principal **−89%**. **Regla operativa: al elegir una rampa de neutrales, mirá los pasos 200–600, no el 100.** Contraste sin daño (claro: principal 18.10:1, muted 7.03:1; oscuro sin cambios). Builds `portal` + `vendor` verdes; `view` sigue sin compilar por el mismo WIP ajeno. ⚠️ **Se descartaron con medición, no por gusto:** `gray` corta el azul sólo a la mitad (borde 0.0058) y `neutral` es croma **0** en todos los pasos — que es exactamente el estado que produjo el "se ve zinc" original cuando el texto encima era de otra familia. Zinc conserva un frío mínimo **y** unifica los dos modos. |
| 2026-09-14 | **Los neutrales de Operations pasan de Stone cálido a Slate/Zinc — la paleta de PrimeNG Aura.** *(Corregido el mismo día a zinc — ver la fila de arriba.)* Decisión de Edgar. `:root --neutral-*` → slate (`#F8FAFC`…`#020617`); `body.theme-monochrome` → zinc de Aura (`#09090B` / `#18181B` / `#27272A`, texto `#FAFAFA`/`#A1A1AA`/`#71717A`). **El Storefront NO cambia**: `.portal-shell`/`.pl-wrap` ya re-apuntaban `--neutral-*` a `--stone-*`, así que el portal queda cálido por construcción y la rampa `--stone-*` sigue viva. Arrastró además los neutrales que estaban sueltos fuera de la rampa: `--ink-rgb`, `--text-disabled`, `--shadow-float`, `--skeleton-bg` y los 5 `--chart-fill-*`/`--chart-axis-text`/`--chart-meta-line` de ambos modos. **Supersede** el RISK choice #1 y la decisión 2026-06-04 "Zinc → Stone" **sólo para Operations**. | **La queja fue "no me gusta el fondo como zinc", y medir mostró que había DOS bugs con una causa común: el sistema no gestionaba el tinte de sus neutrales.** (1) En oscuro, las superficies (`#111111`/`#1A1A1A`/`#2A2A2A`) tenían croma **exactamente 0** —el único set del sistema sin tinte, y **escrito a mano, sin salir de ninguna rampa**— mientras el texto encima era Stone cálido (hue 79°): un neutro puro junto a un crema se percibe **frío por contraste simultáneo**. (2) En claro, croma 0.0103 en **hue 82° (amarillo)**, que a esa saturación no lee "crema cálido" sino "papel viejo". Al comparar contra lo que Edgar señaló (PrimeNG Aura) apareció el dato que decidió: **slate-100 tiene 33% MENOS croma que stone-100 (0.0069 vs 0.0103) y más luz (L\* 96.8 vs 95.9)** — lo que se percibía como "limpio" no era el azul, era menos tinte y más claridad; a ese croma el azul casi no se ve pero empuja hacia donde un blanco se lee más blanco (principio del abrillantador óptico), mientras el mismo croma en amarillo se lee sucio. **Se advirtió el costo antes de ejecutar** (adoptar el tema por default de PrimeNG es volverse el "95% de tools Zinc/blue" que el RISK choice #1 quería evitar) y Edgar lo confirmó. **Contraste verificado, ambos lados calculados:** todo par de texto se mantiene o mejora (principal en oscuro **17.28 → 19.06**; en claro **17.21 → 18.41**; muted −0.03 en oscuro). Builds `portal` + `vendor` verdes; `view` no compila por **WIP ajeno sin commitear** (`admin-roles-grid` + `admin-responsabilidades`: acento grave dentro de un template literal — el gotcha de siempre), ninguno de los dos tocado por este cambio. ⚠️ **Hallazgo colateral declarado, no arreglado:** el comentario `(AA OK)` de `--action-ink` era **falso** — blanco sobre `--action` da **3.39:1**, AA sólo para texto grande, y nuestros CTA son de 13–14px. |
| 2026-09-14 | **Auditoría del doc contra el código: 6 contradicciones internas corregidas + toda cifra fechada + [Estado de cumplimiento](#estado-de-cumplimiento--lo-que-el-doc-manda-vs-lo-que-el-código-hace) e [índice](#mapa-del-documento) nuevos.** Corregido: (1) **§Ing.UI 4 seguía exigiendo `NgZone.runOutsideAngular()`** — el retiro estaba *declarado* en la fila 2026-09-09 de esta misma tabla y **nunca se ejecutó**; ahora dice qué hacer en zoneless (el callback no dispara CD salvo que escriba una `signal`). (2) **§Ing.UI 5 y §R mandaban poner los componentes compartidos en `libs/`**, que tiene **0 componentes Angular**: la regla apuntaba a un conjunto vacío y por eso se leía como cumplida; ahora apunta a `apps/view/src/app/shared/components/` y declara el hueco real (portal y vendor con **0** componentes compartidos). (3) **La tabla de Surfaces —paso 1 del pre-vuelo— listaba 6 rutas y faltaban 8** (`/finanzas`, `/contabilidad`, `/compras`, `/almacen`, `/tienda`, `/reparto`, `/projects`, `/mi-trabajo`), justo las pantallas de dinero más densas; y listaba `/vendor` y `/portal` como rutas de `apps/view` cuando hace tiempo son apps. (4) **Typography apuntaba a un solo `index.html`**: cada app carga su `<link>` y `apps/view` sirve **Sniglet** (3ª familia, exención §O.3) sin estar documentada. (5) **§Type scale prohibía el namespace `--text-*` para tamaños** mientras `--text-display-xl/-lg/-md` existen en `tokens.css` con 14 usos. (6) **El paso 6 del plan Operations, marcado "APLICADO", ordenaba dark espresso** cuando lo decidido y vigente es zinc `#111111`. | **Un contrato que se cita como BINDING y contiene afirmaciones falsas no gatea: enseña a no creerle.** Lo detonó medir, no opinar: al contrastar las cifras que el doc publica contra `grep` de hoy, **cuatro estaban vencidas y dos habían empeorado** — `::ng-deep` 317 → **370 (+17%)** contra una métrica de §S que dice literalmente "no sube", y breakpoints en px 124 → **169 (+36%)**, siendo antipatrón declarado. Y `@layer` **sigue en 0**, así que la justificación que §S le exige a cada `!important` (*"por qué no alcanza la capa"*) era imposible de dar desde el día que se escribió. El patrón de fondo: **lo que se cumple solo** (tokens en un archivo único, tipografía con 0 fugas, GSAP 100% lazy) tiene **un solo lugar donde vive**; lo que se degrada es lo que depende de que la revisión se acuerde. Por ADR-056, *un gate sin prueba negativa es una intención*: las 3 cifras que empeoraron son justo las **mecánicamente medibles**, o sea las que un check de CI habría frenado. ⚠️ **Declarado sin resolver (no se tocó código):** `MetricStrip` —arquetipo de ADR-033 en 64 pantallas— anima `width` 900ms (viola techo 350ms **y** compositor-only) · el morado prohibido `#8b5cf6` volvió en `promotions-meta.ts` junto a la paleta default de Tailwind · 171 hex crudos en 40 archivos de `apps/view` · `surf-table--zebra` no-op aplicada en 35 archivos · `TabShell` y `MiniBars` con **0 adopción** · `motion@^12.38.0` sigue muerta. Todo con archivo y línea en el Estado de cumplimiento. |
| 2026-09-09 | **El contrato de motion decía una cosa y el `package.json` otra: se reconcilia.** §U y el punto 8 afirmaban *"GSAP no es dependencia"* y **es falso desde el 2026-06-25** (`gsap@^3.15.0`, commit `d011d92d`), corriendo en **producción** en `apps/portal` con plugins de Club GreenSock (SplitText, DrawSVG, Physics2D, MotionPath). Regla nueva: **CSS/WAAPI por default; GSAP permitido SÓLO por `import()` lazy**; ninguna librería NUEVA de animación entra. Se retira además el consejo de `NgZone.runOutsideAngular` (obsoleto: `apps/view` es zoneless). | §U *se verifica en review*, así que el contrato desactualizado bloqueaba cualquier PR de animación contra un hecho que ya no era cierto — y al revés, dejaba pasar sin discusión el uso que ya estaba en prod. Medido al reconciliar: el **bundle inicial de `apps/view` ya excede su warning** (1.171 MiB contra 1 MB; 234 KiB de aire hasta el error), así que la regla de *lazy* no es preferencia, es lo único que cabe; la **CSP bloquea todo CDN** (`script-src 'self'`), así que cualquier librería tiene que ser npm bundleada; y la **adopción de los tokens de duración es del 9%** (31 de 338 declaraciones), con dos animaciones en `styles.css` **por encima del techo de 350ms** (400ms y 500ms). ⚠️ Declarado sin resolver: `motion@^12.38.0` está instalada desde el 2026-04-27 con **cero imports** — dep muerta; retirarla toca el lockfile compartido, así que es decisión de Edgar (`npm uninstall motion`). |
| 2026-08-25 | **Plataforma web moderna BINDING (§R-§W + pre-vuelo 16/17)** (responsividad por capas: `@media`=página / `@container`=componente / `clamp()` con máx ≤2.5× / grid intrínseco, breakpoints en `rem` · cascada `@layer` + `!important` justificado + `::ng-deep` solo vendor · overlays nativos Popover+anchor+`<dialog closedby>`+`base-select` · motion nativo View Transitions/scroll-driven/`linear()` · presupuesto INP<200ms como criterio de aceptación · ganancias gratis `text-wrap`/`field-sizing`/`light-dark`/`contrast-color`/`:has`) **+ agentic UX BINDING (§X + pre-vuelo 18)** (plan previo · autonomía por dominio · razón en llano · confianza visible · auditoría+undo con ventana · escalación) **+ marco de mejora progresiva** (`@supports`, el piso es que funcione sin la feature) | Auditoría del DS contra la plataforma (investigación [`DESIGN_TECNOLOGIA_2026.md`](docs/DESIGN_TECNOLOGIA_2026.md)): **el sistema de diseño iba muy por delante de la tecnología con la que lo implementábamos**. Medido en el repo: **0 `@container`** (aunque §Ing.UI 5 lo mandaba desde jul-2026), **0 `@layer`** contra **971 `!important` + 317 `::ng-deep`**, **124 breakpoints en px** (rompen zoom), y features gratis sin usar (`text-wrap` 1 archivo, `field-sizing` 1, `content-visibility` 2, `popover` 1). Además faltaba por completo el contrato visual de las superficies con IA — teníamos la tesis (motor decide / LLM fuera del dinero) y la identidad (ember), pero no las reglas de **confianza** (plan, razón, confianza, reversa, escalación), que es el problema de diseño #1 de la IA en 2026. Se anotó también el riesgo de licencia de PrimeNG (v22+ comercial, repo archivado jun-2026) en pre-vuelo 3 sin cerrar la decisión — es de Edgar. |
| 2026-08-12 | **Tokens consolidados en un archivo único** [`libs/design-tokens/tokens.css`](libs/design-tokens/tokens.css) para las 3 apps + **6 contradicciones del doc resueltas** + **inventario de componentes** agregado | Auditoría del DS contra el código. La "fuente única" eran **3 copias** de `tokens.css` (una por app) **más** un segundo bloque de tokens duplicado dentro de cada `styles.css`, y ya habían divergido: `apps/portal` servía **Inter + JetBrains Mono** en `:root` (retiradas en 2026-06-04, sólo se salvaba por el override de `.portal-shell`) y **`--ease-standard` estaba declarado dos veces con curvas distintas** — ganaba la de `styles.css`, así que la curva documentada acá no era la que corría. Resueltas además: motion 400↔350ms (→ **350ms**, §Motion es la única fuente) · dark Operations zinc↔espresso (→ **zinc `#111111`**; espresso queda scopeado al portal) · dos escalas de spacing (→ **`--sp-*`**) · Fraunces "retirada" vs. autorizada en portal (→ **retirada de verdad**: fuera de `--font-display` y de los `<link>` de las 3 apps; display = Poppins, storefront-only) · elevación hairline vs. spotlight de cards (→ el spotlight/lift es **respuesta al puntero, no elevación en reposo**) · `#2563EB` antipatrón vs. `--info-fg` (→ **se prohíbe el rol, no el hex**). Y la **escala tipográfica**: el doc mandaba `--text-page-head/data/label`, que **nunca existieron** (0 declaraciones, 1 uso) y además colisionaban con `--text-*` = *color*; la escala real `--fs-*`/`--fw-*` (481 usos) quedó documentada y movida al archivo canónico, con alias `--fg-1/2/3` para color. Efecto colateral medible: el payload de fuentes de `view` y `vendor` baja de **5 familias a 2** (Inter/Fraunces/JetBrains ya no se descargan). Builds view+portal+vendor verdes. |
| 2026-07-22 | **Jerarquía visual + comprensión en interfaces de MUCHOS valores BINDING (§Q + pre-vuelo 15)** (answer-first · explicar el número en llano · señalar la fila exacta de la diferencia · redirección desde el dato · jerarquía por tipo+contraste no por color · color-grupo determinista+leyenda+no único portador · abouts P) | El DS garantizaba tokens/estados/a11y pero no que una pantalla con muchas cifras se **entienda**: qué es primario, qué significa cada número, dónde está el problema, cómo arreglarlo. Faltaba como regla → dependía de que el usuario lo pidiera a los golpes. Destilado con Edgar sobre el rediseño de `/finanzas/bancos` (color-por-grupo, renglón que salta, lecturas en llano, chips navegables). |
| 2026-07-20 | **Arquitectura de layouts por sector + ayuda contextual BINDING** (O.1 Fiscal = master-detail permanente sin modal para docs extensos · O.2 Almacén/Compras = full-width grid + totales congelados + sidebar colapsable + offline/frescura · O.3 Mostrador/POS = keyboard-first + total/cobro dominantes + feed al tope; P = `<app-context-help>` desde diccionario de negocio versionado) | "El layout sigue a la operación, no al componente": cada sector tiene plantilla estructural inmutable. Reconcilia con datos densos (mostrador NO pagina / bandeja auditable SÍ; fiscal split permanente vs side-peek ligero). Genera backlog: viewer fiscal master-detail, focus-mode de sidebar, componente+diccionario ContextHelp. |
| 2026-07-20 | **Leyes de interacción + arquitectura resiliente BINDING** (Tesler, Miller/chunking, Jakob, proximidad numérica, Von Restorff/destructivo, Poka-yoke, keyboard-first + estado sucio/`CanDeactivate`, datos añejos/frescura/scroll anclado, fallos parciales en lote, idempotencia visual anti doble-clic) | Cierra los puntos ciegos de la IA como dev de frontend: diseña la fachada y omite la plomería (retención de captura, concurrencia, respuesta parcial de bulk, doble-submit financiero). El DS visual no garantizaba interacciones resilientes. Destilado de la revisión con Edgar; huecos de cumplimiento asociados (309 `error:()=>` vacíos, focus-visible ~22%) quedan como barrido aparte. |
| 2026-07-10 | **Contrato de ingeniería de UI BINDING** (fundamento cognitivo, matriz de estados, a11y AA+APCA, presupuesto de motion + ciclo de vida/Zone.js/`ctx.revert`, container queries en `libs/`, error boundaries por sección, formateo `Intl`+TZ+`tabular-nums`, XSS/`DomSanitizer`, estado-en-URL, optimistic UI, i18n locale) | Codifica el *cómo se construye* que faltaba: el DS visual no garantiza que la UI no se rompa con datos reales/errores ni que el motion no janquee/fugue memoria. GSAP aún no es dependencia — reglas rigen CSS/WAAPI hoy y GSAP si/cuando entre. |
| 2026-06-24 | **Display Storefront: Fraunces serif → Poppins** (sans geométrica). *Supersede la decisión 2026-06-04 de conservar Fraunces.* | El usuario quiere la identidad tipográfica tipo Rappi (delivery app), no editorial-serif. Poppins es el análogo libre más cercano a "Rappi Sans". Body sigue Hanken Grotesk. Operations no cambia. |
| 2026-06-24 | Firma de botones «Confite» (pill + gloss + lip + press) + portal monocromático con acento de marca | Darle al portal una identidad táctil propia (la "esencia" tipo Rappi) sin perder el quiet-luxury. Una sola acción en color; thumbnails/chrome neutros. Implementado en `.portal-btn-*` + util de placeholders. |
| 2026-06-24 | Patrones P0/P1 aplicados al portal (reorden-primero, promo nativa, CTA sticky, cross-sell, upsell de mínimo, tab bar 4+búsqueda) | Traducción de la investigación UX (Baymard/NN-g/Polaris/M3/Instacart) a código. Ver `docs/IMPLEMENTACION/INVESTIGACION_UX_PORTAL_VENTA.md`. |
| 2026-06-18 | Estándares PWA BINDING (SW obligatorio, manifest por-app, theme-color derivado, offline-UX contract) | Auditoría del vendor reveló app "instalable" sin service worker + manifest copiado de `apps/view` con shortcuts a rutas inexistentes. El vendedor en campo necesita offline real, no una web envuelta. |
| 2026-06-08 | Extender "Mercado" como sistema único con 2 surfaces (Storefront + Operations) | Coherencia cross-app: cliente B2B y operador interno ven la MISMA empresa visual. Costo: tokens-only. Win: identidad de marca y reuso del trabajo del portal. |
| 2026-06-08 | Operations = tool-mode-only (sin Fraunces ni decoración) | El usuario interno no tiene "storefront moments". Type bold + density + mono cifras = tesis "esto es serio". |
| 2026-06-08 | Operations hereda Stone, sunset action, ember IA, espresso dark de Storefront | Reuso completo de paleta. Evita 2 fuentes de verdad. Migración es swap de tokens en `:root`. |
| 2026-06-04 | Dirección "Mercado" (Warm Editorial Utilitarian) para `/portal` | Hueco de mercado: velocidad utilitaria + textura premium + IA no-genérica, para un comprador prosumer |
| 2026-06-04 | Inter → Hanken Grotesk (body), JetBrains Mono → Geist Mono (data) | Evitar el default de convergencia; calidez + tabular-nums para precios |
| 2026-06-04 | Fraunces se conserva como display, disciplinado a storefront mode | Serif óptico cálido ya presente y de calidad |
| 2026-06-04 | Naranja-sunset `#F05A28` = acción; amarillo `#FDE707` = sello | El amarillo no soporta texto blanco (AA); formalizar lo que el código ya hacía de facto |
| 2026-06-04 | Neutrales Zinc → Stone cálido; dark `#000` → espresso `#16130F` | Matar el "feel SaaS frío" bajo una marca cálida |
| 2026-06-04 | IA: matar `#8b5cf6` morado → identidad ember (ámbar→sunset) | Diferenciar la IA sin caer en el AI-slop de la industria |
| 2026-06-04 | Catálogo: vista conmutable grid ⇄ lista | Servir tanto al que explora como al que reordena rápido (lección McMaster) |
| 2026-06-04 | Adoptar principios formales (Atomic Design + leyes UX + guías nativas) | Cómo diseñan Rappi/Uber/Airbnb: sistema de componentes + psicología, no pantallas sueltas |

---

## Principios de diseño (cómo diseñan Rappi / Uber / Airbnb)

> Marco de referencia para TODA decisión de UI en el portal. No diseñar pantallas sueltas — construir un sistema.

### 1. Sistema de Diseño + Atomic Design
Las grandes apps no diseñan una pantalla desde cero: componen un **Design System** con la metodología **Atomic Design**:
- **Átomos**: botón, tipografía, color, input, badge, ícono. (≈ nuestros `tokens.css`.)
- **Moléculas**: combinaciones simples (search bar = input + botón; stepper = −/valor/+).
- **Organismos**: bloques completos (nav bar, product card, cart drawer).
- **Coherencia absoluta**: si el botón primario es radio 10px + sombra X, **ese mismo componente** se reutiliza en toda la app. Nunca re-estilar a mano por pantalla.
- Referencia pública: **Base Web** de Uber (https://baseweb.design) — cómo estructuran componentes.

**Regla para este repo:** un cambio visual recurrente = un componente/clase compartida, NO copy-paste de estilos por componente. (Ver auditoría abajo: hoy violamos esto.)

### 2. Guías nativas (estándar de los SO)
Antes de inventar interacciones, respetar:
- **Material Design 3** (Android/web): sombras, animaciones, transiciones, estados (`hover`/`active`/`disabled`/`focus`).
- **Human Interface Guidelines** (iOS): navegación, gestos, jerarquía. Relevante porque corremos en Capacitor.
- Implicación: todo control interactivo necesita los 4 estados visibles + `focus-visible` accesible.

### 3. Psicología y leyes de UX
- **Ley de Hick**: el tiempo de decisión crece con la cantidad/complejidad de opciones. → mostrar **categorías y curaduría** antes que listas de 10.000. (Rappi muestra categorías, no todos los restaurantes.)
- **Ley de Fitts**: el tiempo para alcanzar un target depende de distancia y **tamaño**. → CTA primario **grande y abajo** (zona del pulgar). Targets táctiles ≥ 44×44px.
- **Jerarquía visual**: tamaño + peso de fuente (bold vs regular) + contraste de color guían el ojo al clic deseado.

### 4. Dónde educar el ojo (tendencias reales, no slop)
- **Mobbin** (mobbin.com): biblioteca de capturas de apps reales (Uber, Rappi, Spotify) mapeando flujos completos (login, checkout). **Lookbook obligatorio antes de diseñar un flujo nuevo.**
- **PageFlows**: igual que Mobbin pero en video de los flujos.
- **Dribbble / Behance**: solo inspiración visual pura (color, sombra, ilustración). ⚠️ Mucho es conceptual / inusable — no copiar UX de ahí.

---

## Auditoría del portal vs. estos principios (2026-06-04)

> 🗄️ **HISTÓRICO.** Auditoría de origen; la capa de botón «Confite» y varios targets 44px ya se aplicaron (ver estado del sprint Atomic abajo). Referencia, no checklist operativo.

🔴 alto · 🟡 medio · 🟢 pulido

1. 🔴 **Falta capa Atómica (el gap #1).** Tenemos átomos (tokens) pero NO moléculas/organismos compartidos. Hay **~4 variantes de card** (`cat-card`, `cat-bestseller-card`, `pp-offer`, `po-card`) y **~5 definiciones de botón primario** (`portal-btn-primary`, `ph-btn-primary`, `cat-ai-btn`, `cat-sheet-btn-primary`, `pl-submit`), cada una re-estilada a mano. Eso es exactamente lo que Atomic Design evita. **Fix:** extraer componentes Angular standalone reutilizables: `PortalButton` (variants: primary/ghost/ai-ember), `ProductCard`, `Pill/Badge`, `Stepper`, `EmptyState`, `SearchBar`. Una fuente → coherencia + pantallas más rápidas de construir.
2. 🟡 **Targets táctiles < 44px (Fitts).** `cat-add` 38px, `cat-stepper-btn` 32-36px, varios icon-btn. **Fix:** mínimo 44×44px en mobile para todo lo clickeable.
3. 🟡 **Acción primaria ambigua (Fitts + jerarquía).** Conviven CTA negro (`ph-btn-primary`), naranja-acción (`portal-btn-primary` futuro) y ember-IA sin una regla única. **Fix:** UNA jerarquía: primaria=sunset, secundaria=ghost, IA=ember, marca/hero=negro+amarillo. Documentarla en el átomo `PortalButton`.
4. 🟡 **Hick en el catálogo.** El catálogo abre a "todos los productos" (grid largo). Ya hay buenas reducciones (panel de filtros vs 438 chips, bestsellers, reorder, sugeridos) pero el default sigue siendo la lista completa. **Fix:** abrir con curaduría (categorías + reorder + sugeridos) y empujar el grid completo abajo / detrás de una categoría.
5. 🟢 **Estados nativos inconsistentes.** `disabled/hover/focus` varían entre los botones bespoke. Se resuelve solo al centralizar en `PortalButton`.
6. 🟢 **Workflow de referencia.** Adoptar Mobbin + Base Web como lookbook antes de diseñar flujos nuevos (checkout, alta de pedido, etc.).

**Lo que YA cumple bien (conservar):** tokens como átomos · ley de Hick en bento top-3 de promos · ley de Fitts en el cart FAB (grande, abajo, zona pulgar) · jerarquía con Fraunces + pesos + `tabular-nums` · `prefers-reduced-motion` + safe-area + haptics (alineado a Material/HIG).

**Próximo paso recomendado:** sprint "Atomic layer" — extraer los 6 componentes del punto 1; al hacerlo se resuelven de paso los puntos 2, 3 y 5.

### Estado del sprint Atomic layer (2026-06-04)

✅ **Aplicado — capa de botón compartida.** En `styles.css` se estableció el átomo canónico de botón con jerarquía única (ver "ÁTOMO: Botón del portal"):
- `.portal-btn-primary` → **sunset** (acción principal) · `.portal-btn-ghost` → secundaria · `.portal-btn-ember` → IA (gradiente ámbar→sunset) · `.portal-btn-hero` → CTA de marca storefront (negro+amarillo). Modificadores `--lg` / `--block` / `--pill`.
- Todos ≥ **44px** (Fitts), con `hover/active/disabled/focus-visible` unificados.
- Adoptado en: catálogo (botón IA → `portal-btn-ember`), home (hero → `portal-btn-hero`, ghost → `portal-btn-ghost`), y propagado automáticamente a todos los `.portal-btn-primary` existentes (orders, promociones, order-detail, empty states) que ahora son sunset.
- **Resuelve:** #3 (acción única = sunset), #5 (estados nativos), y la mitad de #2 (botones a 44px).

✅ **Aplicado — touch targets de steppers/add (Fitts, #2).** `cat-add`, `cat-stepper`/`cat-stepper-btn` y `pp-offer-stepper`/`pp-offer-step` subidos a **44px**.

⬜ **Pendiente (próximas fases):**
- #1 (resto): extraer **`ProductCard`** (unifica `cat-card`/`cat-bestseller-card`/`pp-offer`/`po-card`) + **`SearchBar`** + **`Pill/Badge`** + **`Stepper`** + **`EmptyState`** como componentes Angular. El budget CSS del catálogo (31.9 kB) confirma que extraer `ProductCard` aliviana mucho.
- #4 (Hick): abrir el catálogo con curaduría (categorías + reorder + sugeridos) antes del grid completo.

### Revisión paso-a-paso del portal (2026-06-04) — outcomes

Auditoría módulo por módulo (tipografía al detalle + densidad + bordes + a11y + código). Aplicado:
- **Login**: títulos → Fraunces; submit → átomo sunset (se eliminó un p-button con 8 `!important`); focus → `--action-ring`; campo "Empresa" colapsado; radios a escala; show-pass 44px.
- **Shell**: 🔴 bug dark-mode del tab bar flotante (estaba `rgba(255,255,255,.85)` hardcodeado) → tokens; nav móvil **6→5 tabs + FAB IA eliminado** (duplicaba el tab); tamaños/borders a escala.
- **Home**: tracking display -0.035/-0.025 → -0.02 + `font-optical-sizing`; eyebrows → 0.08em; **fast-path subido** (Atajos arriba de Promos).
- **Catálogo**: tracking/eyebrow; drawer del carrito con **nombres de producto**; flag: extraer ProductCard + declutter de cabecera (hero-mini).
- **Carrito**: `--font-mono` (era JetBrains hardcoded); qty 44px; 🔴 **muestra nombre+marca real** (no UUID — el dato ya venía del backend `findById`, el front lo ignoraba).
- **Promociones**: bento hero → Fraunces.
- **Recomendaciones (IA)**: 🟡 **identidad ember aplicada** (iconos/avatares ámbar→sunset); acciones a sunset/ember; focus token; steppers a 40px.
- **Detalle de pedido**: nombres de producto + `--font-mono`.
- **Pedidos / Guard / Service / Notif-prefs**: revisados, sin deuda relevante.

Hallazgo transversal resuelto: **líneas de pedido mostraban UUID en vez del nombre** (carrito, detalle, drawer). Fix 100% frontend — el backend `commercial-orders.findById` ya hacía el join `p.nombre as product_name`.

Pendientes de esta revisión (no bloqueantes): radios de tarjeta a escala (tokenizar 16/20/24), `.portal-section-head h2` global → Fraunces en páginas storefront, declutter de cabecera del catálogo, y la extracción de `ProductCard`.
