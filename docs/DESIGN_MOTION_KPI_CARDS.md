# Motion & micro-charts en KPI cards — investigación + reglas

> **Qué es:** cómo los mejores dashboards hacen las KPI cards **dinámicas, gráficas y con movimiento** sin caer en AI-slop, filtrado a nuestro thesis **Calm UI / "esto es serio"** de Operations.
> **Para qué:** subir el apartado de cards (Command Center y similares) a nivel clase mundial con movimiento **sobrio y con sentido**.
> **Relación:** [`DESIGN.md`](../DESIGN.md) manda (las reglas BINDING están allá, sección "Motion de KPI cards"). Este doc = el *por qué* + números + fuentes. Complementa [`DESIGN_BENCHMARK_CRM_INVENTORY.md`](DESIGN_BENCHMARK_CRM_INVENTORY.md) y [`DESIGN_TENDENCIAS_2026.md`](DESIGN_TENDENCIAS_2026.md).
> **Fecha:** 2026-06-16. Fuentes load-bearing: Emil Kowalski, Smashing (real-time dashboards 2025), Linear, web.dev, CountUp.js.

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
