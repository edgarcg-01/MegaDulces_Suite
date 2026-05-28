# Design System — Tokens & Colorimetría

> Fuente única de verdad: [`apps/view/src/styles/tokens.css`](../apps/view/src/styles/tokens.css). Cualquier color que se necesite en el frontend **vive ahí**. No agregar hex literales en HTMLs, TSs o CSSs de componentes.

---

## Filosofía

**Mega Dulces es un brand warm** (amarillo → naranja → sunset). Esto manda en accents, CTAs y sello visual. **El resto del UI usa neutrales fríos** (zinc-aligned) para que el calor del brand no sature todas las superficies. Los colores semánticos (ok/warn/bad/info) son **estándar industria** con contraste WCAG AA verificado, no marca.

Reglas duras:

1. **`--brand-400` (amarillo `#FDE707`) NUNCA con texto blanco encima**. Contraste 1.07, ilegible. Siempre `--neutral-950` o `--text-main`.
2. **Hex literales prohibidos en código**. Si necesitás un color que no existe como token, agregalo a `tokens.css` con su variante dark — no lo escribas inline.
3. **`!important` está reservado para overrides de PrimeNG inevitables**. Para tu propio CSS, usá especificidad o `:where()`.
4. **Charts respetan el tema**. No hardcodear hex en `chart.js` configs — leer via `getComputedStyle(document.documentElement).getPropertyValue('--chart-1')`.

---

## Escalas

### Brand (warm — Mega Dulces)

| Token | Hex | Uso recomendado | vs blanco |
|---|---|---|---|
| `--brand-50`  | `#FFFEF0` | Fondos hero muy sutiles | 1.04 (decorativo) |
| `--brand-100` | `#FFF8BC` | `chip-brand-bg`, highlight soft | 1.13 (no texto) |
| `--brand-200` | `#FEEC7C` | Hover en chip-brand | 1.32 (no texto) |
| `--brand-300` | `#FDE044` | Accent secundario | 1.42 (no texto) |
| `--brand-400` ★ | `#FDE707` | **Primary** — CTA, sello marca | 1.07 — texto NEGRO obligatorio |
| `--brand-500` | `#F8B400` | Transition yellow→orange | 2.04 (decorativo) |
| `--brand-600` ★ | `#F68F1E` | **Secondary** — naranja | 2.44 AA Large solo |
| `--brand-700` ★ | `#F05A28` | **Tertiary** — sunset, alerts cálidas | 3.74 AA Large ✓ |
| `--brand-800` | `#C53E15` | Texto sobre brand-100/200 | 5.62 AA Normal ✓ |
| `--brand-900` | `#8C2308` | Texto en chips brand | 9.15 AAA ✓ |
| `--brand-950` | `#4B1300` | Brand acento dark mode | 15.6 AAA ✓ |

**Tailwind clases generadas:** `bg-brand-{50..950}`, `text-brand-{50..950}`, `border-brand-{50..950}`. También `bg-brand` (= 400 default), `bg-brand-primary`, `bg-brand-orange`, `bg-brand-sunset` (aliases legacy).

### Neutral (cool gray, zinc-aligned)

| Token | Hex | Uso |
|---|---|---|
| `--neutral-50`  | `#FAFAFA` | Page background alt |
| `--neutral-100` | `#F4F4F5` | `--layout-bg`, `--surface-ground` light |
| `--neutral-200` | `#E4E4E7` | `--border-color` light |
| `--neutral-300` | `#D4D4D8` | Bordes acentuados |
| `--neutral-400` | `#A1A1AA` | `--text-faint`, placeholders |
| `--neutral-500` | `#71717A` | Charts axes, meta-text |
| `--neutral-600` | `#52525B` | `--text-muted` |
| `--neutral-700` | `#3F3F46` | Hover dark mode |
| `--neutral-800` | `#27272A` | Card bg dark alt |
| `--neutral-900` | `#18181B` | Card bg dark |
| `--neutral-950` | `#09090B` | `--text-main` light, `--active-bg` |

**Tailwind clases:** `bg-neutral-{50..950}`, `text-neutral-{50..950}`, etc.

### Semantic — semáforo unificado (WCAG AA verificado)

Cada estado tiene 4 variantes: `fg` (sólido), `soft-bg` (chip), `soft-fg` (texto sobre soft-bg), `border`.

| Estado | fg | soft-bg | soft-fg | border |
|---|---|---|---|---|
| ok    | `#16A34A` | `#DCFCE7` | `#166534` | `#BBF7D0` |
| warn  | `#F59E0B` | `#FEF3C7` | `#92400E` | `#FDE68A` |
| bad   | `#DC2626` | `#FEE2E2` | `#991B1B` | `#FECACA` |
| info  | `#2563EB` | `#DBEAFE` | `#1E40AF` | `#BFDBFE` |

**Tailwind clases:** `bg-ok-soft-bg`, `text-ok-fg`, `border-ok-border`, `bg-ok` (= fg).

Para chips completos hay utilities en `styles.css`: `.status-chip` + modificador `.status-ok` / `.status-warn` / `.status-bad`. Para info usar `.chip-info` (utility legacy).

### Charts — 8 series distinguibles

| Token | Light | Dark | Uso |
|---|---|---|---|
| `--chart-1` | `#F68F1E` | `#FBA94E` | brand orange (anchor) |
| `--chart-2` | `#185FA5` | `#60A5FA` | corporate blue |
| `--chart-3` | `#9333EA` | `#C084FC` | purple |
| `--chart-4` | `#0EA5E9` | `#38BDF8` | cyan |
| `--chart-5` | `#EC4899` | `#F472B6` | pink |
| `--chart-6` | `#14B8A6` | `#2DD4BF` | teal |
| `--chart-7` | `#F59E0B` | `#FCD34D` | amber |
| `--chart-8` | `#71717A` | `#A1A1AA` | neutral (baseline / "otros") |

Auxiliares: `--chart-grid`, `--chart-axis-text`, `--chart-meta-line` — todos theme-aware.

**Patrón de uso en chart.js:**

```ts
const cs = getComputedStyle(document.documentElement);
const chartColors = [1, 2, 3, 4, 5, 6, 7, 8].map(n =>
  cs.getPropertyValue(`--chart-${n}`).trim()
);
const gridColor = cs.getPropertyValue('--chart-grid').trim();
```

### Avatars — 8 colores estables (AA ≥ 4.5 con texto blanco)

```
--avatar-1  #C53E15   ← brand-800 (warm anchor)
--avatar-2  #185FA5
--avatar-3  #15803D   ← green-700
--avatar-4  #7E22CE   ← purple-700
--avatar-5  #0F766E   ← teal-700
--avatar-6  #B91C1C   ← red-700
--avatar-7  #BE185D   ← pink-700
--avatar-8  #52525B   ← neutral-600
```

Helper recomendado en TS (a crear cuando se migren `logistica-staff.ts`, `promotions-meta.ts`):

```ts
export function avatarColorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % 8 + 1;
  return `var(--avatar-${idx})`;
}
```

---

## Surfaces, text, borders (theme-aware)

| Token | Light | Dark | Uso |
|---|---|---|---|
| `--layout-bg` | `#F4F4F5` | `#000000` | Page background |
| `--card-bg` | `#FFFFFF` | `#111111` | Cards, paneles |
| `--sidebar-bg` | `#FFFFFF` | `#111111` | Sidebar, headers |
| `--surface-ground` | `#F8FAFC` | `#111111` | Sub-surfaces, table headers |
| `--hover-bg` | `#F4F4F5` | `#222222` | Hover states |
| `--active-bg` | `#09090B` | `#FFFFFF` | Selected nav, buttons primary alt |
| `--active-text` | `#FFFFFF` | `#000000` | Texto sobre active-bg |
| `--border-color` | `#E4E4E7` | `#333333` | Bordes default |
| `--text-main` | `#09090B` | `#FFFFFF` | Body text |
| `--text-muted` | `#52525B` | `#A1A1AA` | Captions, meta |
| `--text-faint` | `#A1A1AA` | `#52525B` | Placeholders, deshabilitado |

**Tailwind clases:** `bg-surface-{layout,card,sidebar,hover,active,ground}`, `text-content-{main,muted,faint,disabled,active}`, `border-divider`.

---

## Mapa hex → token (codemod reference)

Tabla 1:1 que usa el codemod siguiente para reemplazar hex hardcoded por tokens. Si un hex no está acá, no se reemplaza automáticamente — se evalúa caso por caso.

| Hex hardcoded en uso | Token destino | Variante |
|---|---|---|
| `#FDE707`, `rgba(253,231,7,1)` | `--brand-400` | primary |
| `#F68F1E` | `--brand-600` | orange |
| `#F05A28` | `--brand-700` | sunset |
| `#FFF8BC` | `--brand-100` | brand-light |
| `#71717A` | `--neutral-500` o `--text-muted` | según contexto |
| `#52525B` | `--neutral-600` o `--text-muted` | según contexto |
| `#09090B` | `--neutral-950` o `--text-main` | según contexto |
| `#A1A1AA` | `--neutral-400` o `--text-faint` | |
| `#E4E4E7` | `--neutral-200` o `--border-color` | |
| `#F4F4F5` | `--neutral-100` o `--layout-bg` | |
| `#FAFAFA` | `--neutral-50` | |
| `#FFFFFF` | `--card-bg` (si es superficie) o literal (si es text-on-dark) | |
| `#185FA5`, `#3B82F6`, `#2563EB` | `--info-fg` | era checkbox-accent / hints |
| `#16A34A` | `--ok-fg` | |
| `#DC2626`, `#EF4444` | `--bad-fg` | |
| `#F59E0B`, `#F5A623` | `--warn-fg` o `--chart-7` | según contexto |
| `#97C459` | `--ok-fg` (verde KPI logistica) | |
| `#6C757D` | `--neutral-500` | gris Bootstrap legacy |
| `#9333EA` | `--chart-3` o `--avatar-4` | |
| `#EC4899` | `--chart-5` o `--avatar-7` | |
| `#0EA5E9` | `--chart-4` | |
| `#14B8A6` | `--chart-6` | |
| Tailwind `bg-green-{100,500}` | `bg-ok-soft-bg` / `bg-ok` | |
| Tailwind `bg-red-{100,500}` | `bg-bad-soft-bg` / `bg-bad` | |
| Tailwind `bg-amber-{100,400,500}` | `bg-warn-soft-bg` / `bg-warn` | |
| Tailwind `bg-blue-{50,100}` | `bg-info-soft-bg` | |
| Tailwind `text-emerald-600`, `text-green-{600,700}` | `text-ok-fg` | |
| Tailwind `text-red-{500,600,700}` | `text-bad-fg` | |
| Tailwind `text-blue-{600,700}` | `text-info-fg` | |
| Tailwind `text-zinc-{500,600}` | `text-content-muted` | |

---

## Aliases legacy (compatibilidad temporal)

Todos estos siguen funcionando porque resuelven a la nueva escala vía `var()`:

```
--brand-primary       → --brand-400
--brand-orange        → --brand-600
--brand-sunset        → --brand-700
--brand-light         → --brand-100
--accent-brand        → --brand-400
--accent-brand-light  → rgba amarillo 15% (light) / 20% (dark)

--status-ok-fg        → --ok-fg
--status-ok-soft-bg   → --ok-soft-bg
--status-ok-soft-fg   → --ok-soft-fg
--status-ok-border    → --ok-border
(idem warn / bad)

--chip-info-bg        → --info-soft-bg
--chip-info-fg        → --info-soft-fg
--chip-info-border    → --info-border
--chip-warn-soft-*    → --warn-soft-*
--chip-brand-bg       → --brand-100
--chip-brand-fg       → --brand-900
--chip-brand-border   → --brand-200

--checkbox-accent     → --info-fg
```

**Plan:** estos aliases viven mientras se hace el codemod. Una vez todo el código usa los nombres nuevos, se eliminan en un PR de limpieza.

---

## Patrón: Ghost buttons (color reveal on hover)

**Decisión de diseño (Edgar, 2026-05-27):** los botones de acción que están "siempre presentes" en filas, headers de card o toolbars deben ser **discretos por default y revelar su color semántico en hover**. Razón: una tabla con 50 filas y 3 botones rojos/azules/verdes por fila se vuelve ruido visual. El color sólo aparece cuando el usuario está por interactuar.

**Reglas:**

- Default: texto/icono en `--text-muted` o `--text-faint`, fondo transparente.
- Hover: revela `*-fg` + `*-soft-bg` + `*-border` del color semántico (ej: rojo para delete, azul para edit, verde para aprobar).
- Focus-visible: outline de 2px del color sólido (`*-fg`) — accesibilidad teclado.
- Active: `scale(0.97)` para feedback táctil.
- Disabled: `--text-disabled`, sin reveal.

**Mapa acción → color semántico:**

| Acción | Modificador | Color hover |
|---|---|---|
| Eliminar, descartar, cancelar destructivo | `btn-ghost-bad` | rojo (`--bad-fg`) |
| Aprobar, confirmar, marcar OK | `btn-ghost-ok` | verde (`--ok-fg`) |
| Editar, ver detalle, info | `btn-ghost-info` | azul (`--info-fg`) |
| Archivar, advertencia, postergar | `btn-ghost-warn` | ámbar (`--warn-fg`) |
| Destacar, marca, featured | `btn-ghost-brand` | naranja/amarillo (`--brand-*`) |

**Variantes:**

```html
<!-- Botón completo con label -->
<button class="btn-ghost btn-ghost-bad" (click)="delete(row)">
  <i class="pi pi-trash"></i>
  Eliminar
</button>

<!-- Botón sólo-icono (acciones densas en tablas) -->
<button class="icon-btn-ghost icon-btn-ghost-bad" (click)="delete(row)" aria-label="Eliminar">
  <i class="pi pi-trash"></i>
</button>

<!-- Editar (azul info) -->
<button class="icon-btn-ghost icon-btn-ghost-info" (click)="edit(row)" aria-label="Editar">
  <i class="pi pi-pencil"></i>
</button>

<!-- Aprobar (verde) -->
<button class="btn-ghost btn-ghost-ok" (click)="approve()">
  <i class="pi pi-check"></i> Aprobar
</button>
```

**Cuándo NO usarlo:**
- CTA principal de una página o dialog (ahí queremos color permanente: usar `p-button-brand` o variante sólida).
- Botones aislados donde la acción NO es repetitiva (ahí el color carga poco y comunica más fuerte).
- Botones donde la "consecuencia destructiva" debe verse desde lejos (ej: "Eliminar cuenta" en una pantalla de settings sensible).

---

## Patrones a evitar (anti-patterns)

❌ `class="bg-green-100 text-green-700"` — usar `class="status-ok status-soft-bg status-text"` o las utilities `bg-ok-soft-bg text-ok-soft-fg`.

❌ `style="color: #185FA5"` — usar `class="text-info-fg"`.

❌ `borderColor: '#FBA94E'` en chart config — usar `getPropertyValue('--chart-1')`.

❌ `'.theme-monochrome .bg-blue-50 { background: ... }'` overrides — los tokens semánticos ya cambian solos entre temas; usá `bg-info-soft-bg` y olvidate del override.

❌ `text-black`, `bg-white` literales — usá `text-content-main`, `bg-surface-card` para que respeten el tema.

❌ Definir `--mi-color-custom` en un componente CSS — agregalo a `tokens.css` o no es un token, es un magic number.

---

## Próximos pasos del refactor UI

1. ✅ **Paso 1 (este PR)**: tokens.css + integración + tailwind config + docs. Aliases legacy mantienen todo funcionando.
2. ⬜ **Paso 2 — Codemod en HTMLs**: reemplazar las 200+ clases Tailwind color hardcoded por las nuevas semantic. Empezar por `captures.component.html` (27 hits), `admin-catalogs` (11), `login` (10).
3. ⬜ **Paso 3 — Charts dinámicos**: refactor `reports.component.ts` y `home.component.ts` para leer chart colors via `getComputedStyle`. Resuelve dark mode roto.
4. ⬜ **Paso 4 — Limpiar `!important`**: tema PrimeNG custom que gana por especificidad. Reducir 347 → bajo 50.
5. ⬜ **Paso 5 — Eliminar aliases legacy**: rename `--brand-primary` → `--brand-400` en código, borrar bloque de aliases en `tokens.css`.
6. ⬜ **Paso 6 — Lint rule**: regex que falle CI si aparece un hex literal en `apps/view/src/**/*.html` o un `style="color:#..."`.
