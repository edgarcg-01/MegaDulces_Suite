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
        // Brand palette
        brand: {
          primary: 'rgba(253, 231, 7, 1)',
          orange: '#f68f1e',
          sunset: '#f05a28',
          light: '#fff8bc',
        },
        // Legacy aliases for backwards compatibility
        yellow: 'rgba(253, 231, 7, 1)',
        orange: '#f68f1e',
        sunset: '#f05a28',
        cream: '#fff8bc',
        // Score/status colors using brand palette
        score: {
          high: '#f68f1e',
          medium: '#f05a28',
          low: '#dc2626',
        },
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

