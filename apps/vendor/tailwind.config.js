const { join } = require('path');

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('@spartan-ng/ui-core/hlm-tailwind-preset')],
  content: [
    join(__dirname, 'src/**/*.{html,ts}'),
    join(__dirname, 'src/app/shared/components/ui/**/*.{html,ts}'),
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Hanken Grotesk', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        /*
         * Brand — Mega Dulces (warm: yellow → orange → sunset)
         * Escala 50..950 mapeada a var(--brand-*) de tokens.css.
         * Las claves legacy (primary/orange/sunset/light) siguen
         * funcionando porque resuelven a la misma var().
         */
        /*
         * Action — único acento interactivo (sunset naranja).
         * Uso: bg-action, text-action, ring-action, hover:bg-action-hover, etc.
         */
        action: {
          DEFAULT: 'var(--action)',
          hover:   'var(--action-hover)',
          press:   'var(--action-press)',
          ink:     'var(--action-ink)',
          ring:    'var(--action-ring)',
        },

        /*
         * Ember — identidad IA (ámbar→sunset). Chips "Sugeridos", scores, banners IA.
         * Mata el morado/azul SaaS genérico.
         */
        ember: {
          DEFAULT: 'var(--ember-from)',
          from:    'var(--ember-from)',
          to:      'var(--ember-to)',
          soft:    'var(--ember-soft)',
          border:  'var(--ember-border)',
        },

        brand: {
          DEFAULT: 'var(--brand-400)',
          50:  'var(--brand-50)',
          100: 'var(--brand-100)',
          200: 'var(--brand-200)',
          300: 'var(--brand-300)',
          400: 'var(--brand-400)',
          500: 'var(--brand-500)',
          600: 'var(--brand-600)',
          700: 'var(--brand-700)',
          800: 'var(--brand-800)',
          900: 'var(--brand-900)',
          950: 'var(--brand-950)',
          // Legacy aliases (no-breaking durante migración)
          primary: 'var(--brand-primary)',
          orange:  'var(--brand-orange)',
          sunset:  'var(--brand-sunset)',
          light:   'var(--brand-light)',
        },
        // Legacy top-level aliases (compatibilidad con código viejo)
        yellow: 'var(--brand-400)',
        orange: 'var(--brand-600)',
        sunset: 'var(--brand-700)',
        cream:  'var(--brand-100)',

        /*
         * Neutral — cool gray (zinc-aligned).
         * Idéntico a Tailwind zinc en hex, pero pasa por var()
         * para que cualquier ajuste futuro sea centralizado.
         */
        neutral: {
          50:  'var(--neutral-50)',
          100: 'var(--neutral-100)',
          200: 'var(--neutral-200)',
          300: 'var(--neutral-300)',
          400: 'var(--neutral-400)',
          500: 'var(--neutral-500)',
          600: 'var(--neutral-600)',
          700: 'var(--neutral-700)',
          800: 'var(--neutral-800)',
          900: 'var(--neutral-900)',
          950: 'var(--neutral-950)',
        },

        /*
         * Semantic — ok / warn / bad / info.
         * Uso: bg-ok-soft, text-ok-fg, border-ok-border, etc.
         * Cada uno también tiene DEFAULT (= fg) para `bg-ok` / `text-bad`.
         */
        ok: {
          DEFAULT:   'var(--ok-fg)',
          fg:        'var(--ok-fg)',
          'soft-bg': 'var(--ok-soft-bg)',
          'soft-fg': 'var(--ok-soft-fg)',
          border:    'var(--ok-border)',
        },
        warn: {
          DEFAULT:   'var(--warn-fg)',
          fg:        'var(--warn-fg)',
          'soft-bg': 'var(--warn-soft-bg)',
          'soft-fg': 'var(--warn-soft-fg)',
          border:    'var(--warn-border)',
        },
        bad: {
          DEFAULT:   'var(--bad-fg)',
          fg:        'var(--bad-fg)',
          'soft-bg': 'var(--bad-soft-bg)',
          'soft-fg': 'var(--bad-soft-fg)',
          border:    'var(--bad-border)',
        },
        info: {
          DEFAULT:   'var(--info-fg)',
          fg:        'var(--info-fg)',
          'soft-bg': 'var(--info-soft-bg)',
          'soft-fg': 'var(--info-soft-fg)',
          border:    'var(--info-border)',
        },

        /*
         * Score (legacy alias) — mapeado a la nueva escala brand para
         * que `bg-score-high` / `text-score-low` sigan resolviendo.
         */
        score: {
          high:   'var(--brand-600)',
          medium: 'var(--brand-700)',
          low:    'var(--bad-fg)',
        },

        /*
         * Charts — 8 series + grid + axis. Reemplazan los hex literales
         * en `reports.component.ts` / `home.component.ts`. Para Chart.js
         * leer via getComputedStyle del root al construir el config.
         */
        chart: {
          1: 'var(--chart-1)',
          2: 'var(--chart-2)',
          3: 'var(--chart-3)',
          4: 'var(--chart-4)',
          5: 'var(--chart-5)',
          6: 'var(--chart-6)',
          7: 'var(--chart-7)',
          8: 'var(--chart-8)',
          grid: 'var(--chart-grid)',
          axis: 'var(--chart-axis-text)',
        },

        /*
         * Avatars — 8 estables (AA ≥ 4.5 con texto blanco).
         * Reemplaza arrays hardcoded en logistica-staff.ts, promotions-meta.ts, etc.
         */
        avatar: {
          1: 'var(--avatar-1)',
          2: 'var(--avatar-2)',
          3: 'var(--avatar-3)',
          4: 'var(--avatar-4)',
          5: 'var(--avatar-5)',
          6: 'var(--avatar-6)',
          7: 'var(--avatar-7)',
          8: 'var(--avatar-8)',
        },

        /*
         * Surfaces, text, divider — theme-aware (light + dark).
         * Estas no cambian de naming; sólo de fuente (ahora desde tokens.css).
         */
        surface: {
          layout:  'var(--layout-bg)',
          card:    'var(--card-bg)',
          sidebar: 'var(--sidebar-bg)',
          hover:   'var(--hover-bg)',
          active:  'var(--active-bg)',
          ground:  'var(--surface-ground)',
          border:  'var(--border-color)',
        },
        content: {
          main:     'var(--text-main)',
          muted:    'var(--text-muted)',
          soft:     'var(--text-muted)',   // alias — secondary labels, captions
          faint:    'var(--text-faint)',
          dim:      'var(--text-faint)',
          disabled: 'var(--text-disabled)',
          active:   'var(--active-text)',
        },
        divider: {
          DEFAULT:       'var(--border-color)',
          table:         'var(--table-border)',
          'table-hover': 'var(--table-hover)',
        },
      }
    },
  },
  plugins: [require('tailwindcss-animate')],
}

