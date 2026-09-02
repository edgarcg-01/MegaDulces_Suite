const { join } = require('path');

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('@spartan-ng/ui-core/hlm-tailwind-preset')],
  content: [join(__dirname, 'src/**/*.{html,ts}')],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Hanken Grotesk', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Poppins', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        // Action — único acento interactivo (sunset naranja).
        action: {
          DEFAULT: 'var(--action)',
          hover:   'var(--action-hover)',
          press:   'var(--action-press)',
          ink:     'var(--action-ink)',
          ring:    'var(--action-ring)',
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
        },
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
        surface: {
          layout:  'var(--layout-bg)',
          card:    'var(--card-bg)',
          hover:   'var(--hover-bg)',
          active:  'var(--active-bg)',
          ground:  'var(--surface-ground)',
          border:  'var(--border-color)',
        },
        content: {
          main:     'var(--text-main)',
          muted:    'var(--text-muted)',
          faint:    'var(--text-faint)',
          disabled: 'var(--text-disabled)',
        },
        divider: {
          DEFAULT: 'var(--border-color)',
        },
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
