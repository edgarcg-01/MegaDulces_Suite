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
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        surface: {
          layout: 'var(--layout-bg)',
          card: 'var(--card-bg)',
          sidebar: 'var(--sidebar-bg)',
          hover: 'var(--hover-bg)',
          active: 'var(--active-bg)',
          ground: 'var(--surface-ground)',
          border: 'var(--border-color)',
        },
        content: {
          main: 'var(--text-main)',
          muted: 'var(--text-muted)',
          faint: 'var(--text-faint)',
          disabled: 'var(--text-disabled)',
          active: 'var(--active-text)',
        },
        divider: {
          DEFAULT: 'var(--border-color)',
          table: 'var(--table-border)',
          'table-hover': 'var(--table-hover)',
        }
      }
    },
  },
  plugins: [require('tailwindcss-animate')],
}

