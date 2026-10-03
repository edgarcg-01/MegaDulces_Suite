# Motion & micro-charts en KPI cards — investigación + reglas

> **Qué es:** cómo los mejores dashboards hacen las KPI cards **dinámicas, gráficas y con movimiento** sin caer en AI-slop, filtrado a nuestro thesis **Calm UI / "esto es serio"** de Operations.
> **Para qué:** subir el apartado de cards (Command Center y similares) a nivel clase mundial con movimiento **sobrio y con sentido**.
> **Relación:** [`DESIGN.md`](../DESIGN.md) manda (las reglas BINDING están allá, sección "Motion de KPI cards"). Este doc = el *por qué* + números + fuentes. Complementa [`DESIGN_BENCHMARK_CRM_INVENTORY.md`](DESIGN_BENCHMARK_CRM_INVENTORY.md) y [`DESIGN_TENDENCIAS_2026.md`](DESIGN_TENDENCIAS_2026.md).
> **Fecha:** 2026-06-16. **Auditado y revalidado: 2026-10-03.** Fuentes load-bearing: Emil Kowalski, Smashing (real-time dashboards 2025), Linear, web.dev, CountUp.js.

---

> ## ✅ Revalidación 2026-10-03 — el contenido aguantó; el código no lo estaba cumpliendo
>
> **Este documento NO caducó.** A diferencia de [`DESIGN_TENDENCIAS_2026.md`](DESIGN_TENDENCIAS_2026.md),
> que afirmaba ✅ sobre cinco decisiones ya revertidas, acá todo lo que dice sigue siendo el estándar en
> octubre: count-up on-view una sola vez, SVG crudo para micro-viz, delta multimodal, techo de motion,
> la lista anti-slop. No hubo nada que corregir en la teoría.
>
> **Lo que sí estaba roto era el cumplimiento, y en el peor lugar posible — el arquetipo canónico:**
>
> | Regla | Qué hacía el código | Estado |
> |---|---|---|
> | **§7 presupuesto** (`<300ms`, sólo `transform`+`opacity`) | `MetricStrip` animaba **`transition: width 900ms`** ×2 — 3× el presupuesto de este doc y sobre una propiedad de **layout**, en **81 pantallas**. Llevaba **tres semanas** escrito como ⛔ en `DESIGN.md` | ✅ **Arreglado.** El bullet usa `transform: scaleX()`; la barra de composición no se pudo (hermanos flex de una fila) y **queda declarada con su razón** |
> | **§5 flash-on-change** (*"se desvanece en ~400ms"*) | `MetricCard` lo hacía en **1s** y el POS en **1.2s** — 2.5× y 3× lo que pide este mismo documento | ✅ **Arreglado**, al techo |
> | **§2 micro-charts** | `sparkline` dibujaba en **800ms**, `ring-gauge` en **700ms** | ✅ **Arreglado**, al techo |
> | **§8 techo** | Medido antes: **40+ declaraciones** por encima en Operations | ✅ **0**, y ahora lo mide `npm run check:motion` en CI |
>
> ⭐ **La lección:** este documento estaba bien escrito, enlazado desde el pre-vuelo y citado como BINDING
> en `DESIGN.md` — y aun así el componente que más lo cita era el que peor lo cumplía. **Un documento no
> hace cumplir nada.** Lo que cambió el resultado fue una compuerta de 200 líneas.
>
> ### Dos huecos del propio documento (abiertos)
>
> - **`aria-live` para dato vivo.** §1 cubre la a11y del count-up (*"el valor final va en el DOM"*) pero
>   **nada dice del valor que cambia solo** en una card alimentada por WebSocket: un lector de pantalla
>   no se entera. [`FASE_J17`](IMPLEMENTACION/FASES/FASE_J17_CARD_SYSTEM_2.0.md) lo detectó
>   (*"`aria-live="polite"` en el nodo del valor que cambia — hoy ausente"*) y sigue sin implementarse.
> - **El count-up en Alto Contraste.** §1 resuelve `prefers-reduced-motion` y no menciona
>   `forced-colors`. La base ya está en [`forced-colors.css`](../libs/ui-web/src/forced-colors.css), pero
>   falta decir acá qué pasa con el flash cuando el SO fuerza los colores: **el flash de color no se ve**,
>   así que la señal de "esto cambió" tiene que ser otra cosa.
>
> ### Estado del plan de evolución
>
> ⚠️ **[`FASE_J17` (Card System 2.0) lleva ~3 meses en "🔨 DISEÑADO, sin código"** (2026-07-10), y
> [`J16`](IMPLEMENTACION/FASES/FASE_J16_CARD_REPERTOIRE.md) especifica **14 arquetipos de los que sólo
> existe el grupo A** (KPI). Medido hoy: `odometer` aparece en 4 archivos, `bullet` en 2, `heat-strip`
> en 0. Por ADR-056, **o se ejecuta o se declara deuda con nombre en el tracker** — listarlo como "la
> evolución que viene" durante tres meses es la tercera opción, que es la que no vale.

---

## Principio rector

Nuestras cards ya tienen lo correcto de base (tokens `--ease-out`/`--ease-standard`, Geist Mono `tabular-nums`, `prefers-reduced-motion`, sparklines SVG inline en la hero). **El trabajo NO es agregar librerías — es aplicar disciplina de motion como reglas.** En Operations: *refinamiento, no espectáculo* (Linear: "structure should be felt, not seen"). El "dinamismo" correcto es **dato** (sparkline, delta, bullet), no **decoración** (gradientes que laten, íconos girando).

---

## 1. Count-up del número (value roll)
- Trigger **on-view** (IntersectionObserver), **una sola vez**, NO en cada poll/re-render. [CountUp.js]
- Duración **~900ms** para Ops (2s es default de CountUp.js → es techo de marketing, no de tool). `--ease-out`.
- Técnica para nuestro stack: **`requestAnimationFrame` → signal** (tenemos signals). Mejor que el hack CSS `@property`+`counter` (Chromium-only; Safari/FF muestran 0) y que meter una lib.
- **A11y:** el valor final va en el DOM como texto (el SR lo lee); animar capa visual; bajo `prefers-reduced-motion` **render instantáneo del final**. [CSS-Tricks, Emil]

## 2. Micro-charts inline (SVG, 0 KB)
- **Tile canónico de 3 capas:** número (Geist Mono tabular) + **sparkline** de trayectoria + **delta multimodal** `▲ +3.2%` (flecha+signo+número, NO solo color → sobrevive daltonismo). [ChartLoad, Smashing]
- Cuál usar: **sparkline línea/área** = tendencia temporal (default KPI); **mini-barras** = períodos discretos (pedidos/día 7d); **bullet chart** = actual vs meta (preferir sobre gauge radial — más data-ink); **progress ring** = un solo % acotado (fulfillment/cobertura), con moderación.
- Todo en **SVG crudo** (`vector-effect="non-scaling-stroke"`, stroke 1.5–2px). `<title>`/`aria-label` describiendo la tendencia.

## 3. Reveal de entrada (stagger)
- Solo **primer paint**, nunca en refresh. [Emil: "never animate repeated actions"]
- `translateY(8–12px)+opacity` (NO scale desde 0 en Ops), **150–250ms/card**, **stagger 30–60ms**. >250ms/card o >80ms stagger = "slideshow". `transform`+`opacity` only.

## 4. Hover / press
- **`scale(0.97)` en `:active`** = la micro-interacción de mayor ROI. [Emil]
- Hover: **lift `translateY(-1 a -2px)` + revelar borde/acento** (no glow), 120–150ms `--ease-out`. Revelar el acento `#F05A28` en un rule fino o en la flecha de delta, no en toda la card. `cursor:pointer` solo si navega.

## 5. "Live" / realtime
- Mejor **"actualizado HH:MM" + dot de estado** que movimiento constante. [Smashing]
- Update de valor: **fade/count-up + flash-on-change** (verde sube / rojo baja / gris neutro) que se desvanece en **~400ms**, sobre la métrica que cambió, no toda la card.
- Dot live **fijo o breathe lento (~2s)**, nunca blink duro. **No** actualizar todas las tiles a la vez (debounce/stagger); reorder ≤300ms.

## 6. Skeleton → data
- Skeleton **bloquea CLS**: reservar dimensiones finales exactas antes de la data. [web.dev, eBay]
- Transición: **crossfade opacity ~150–200ms**, sin cambiar dimensiones. Shimmer = gradiente que se mueve por `background-position`/`transform` (no por tamaño), loop ~1.2–1.5s.

## 7. Librería de charts (decisión)
- **SVG crudo para TODO micro-chart de KPI (0 KB).** Ya lo hacemos — mantener.
- uPlot (~48 KB) solo si aparece un panel de time-series interactivo. Chart.js (~254 KB) / ApexCharts (131 KB gz) = anti-patrón para sparklines.

## 8. Presupuesto de motion (techos calm)
- **Todo < 300ms.** `ease-out` default; evitar `ease-in` en UI. [Emil]
- **Animar solo `transform`+`opacity`** (composite). Nunca `width/height/top/left/margin` (layout+paint → jank+CLS).
- **CSS/WAAPI** para hover/press/entrada (hardware-accelerated); **rAF** solo para el count-up.
- **Nunca** animar lo que el usuario ve decenas de veces al día (refresh/re-render).

## 9. Anti-slop (prohibido en Operations)
- Re-correr entrada/count-up en cada poll o re-render.
- Number roll ≥2s, overshoot/spring/bounce/confetti en cifras.
- Gradientes que laten/respiran, glassmorphism/blur, **ember como decoración** en tiles (ember = solo superficies de IA).
- Íconos girando en círculos de color; badges flotando; texto con gradiente.
- Dots "live" con blink duro; flashear toda la card; animar todas las tiles a la vez.
- Hover scale-up + shadow bloom + barrido de color.
- **Barra de acento a la izquierda como "diferenciador"** (es el tell del 90% de dashboards AI — diferenciar con sparkline+delta+tabular, no con el rule de color).
- Deltas solo-color (sin flecha/label). Chart lib solo para sparklines.

---

## Plan de aplicación (KPI cards de Operations)
1. **Componente `KpiCard` / utilidades** que estandaricen las 3 capas (número + sparkline + delta multimodal). Reusa el patrón `.cell` existente.
2. **Count-up** on-view (rAF→signal, 900ms, reduced-motion-safe) en los valores.
3. **Delta `▲ %`** con color semántico + flecha en las cards que tengan comparativa (ya existe en la hero `cc-delta`; generalizar).
4. **Sparkline/mini-bar** donde haya serie (la hero ya; extender a las que tengan histórico).
5. **Hover/press** sobrio + **stagger de entrada** one-time.
6. QA: `prefers-reduced-motion`, CLS 0 (skeleton dimensionado), <300ms, transform/opacity only.

> Storefront puede tomar motion algo más expresivo (`ease` elegante, scale(0.93), count-up hasta ~1.5–2s) manteniendo la misma disciplina transform/opacity + reduced-motion.

### Fuentes
Emil Kowalski [great-animations](https://emilkowal.ski/ui/great-animations) · [7-tips](https://emilkowal.ski/ui/7-practical-animation-tips) — Smashing [real-time dashboards](https://www.smashingmagazine.com/2025/09/ux-strategies-real-time-dashboards/) — Linear [calmer interface](https://linear.app/now/behind-the-latest-design-refresh) — web.dev [CLS](https://web.dev/articles/optimize-cls) — [CountUp.js](https://github.com/inorganik/countUp.js) · [CSS-Tricks counters](https://css-tricks.com/animating-number-counters/) — [ChartLoad sparkline KPI](https://www.chartload.com/charts/sparkline-kpi/) — [uPlot](https://github.com/leeoniya/uPlot) — [Developers Digest AI slop](https://www.developersdigest.tech/blog/ai-design-slop-and-how-to-spot-it)
