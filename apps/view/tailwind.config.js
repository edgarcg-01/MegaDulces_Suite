/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('@spartan-ng/ui-core/hlm-tailwind-preset')],
  content: [
    "./src/**/*.{html,ts}",
    "./src/app/shared/components/ui/**/*.{html,ts}",
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          layout: 'var(--layout-bg)',
          card: 'var(--card-bg)',
          sidebar: 'var(--sidebar-bg)',
          hover: 'var(--hover-bg)',
          active: 'var(--active-bg)',
        },
        content: {
          main: 'var(--text-main)',
          muted: 'var(--text-muted)',
          faint: 'var(--text-faint)',
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

