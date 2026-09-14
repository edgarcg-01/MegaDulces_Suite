import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/**
 * Preset PrimeNG "Operations" — alinea PrimeNG con los tokens del design system
 * Mercado (ver DESIGN.md + styles/tokens.css). Sin esto PrimeNG corre Aura
 * vanilla y filtra su azul/esmeralda en botones, selects, paginador, datepicker,
 * checkbox y spinners — el leak off-brand que mata la identidad sunset.
 *
 * Qué mapea:
 *  - primary  → rampa naranja centrada en sunset --action (#F05A28).
 *  - highlight / focusRing → sunset.
 *  - surface  → NO se pisa: se usa el de Aura (slate en claro, zinc en oscuro),
 *    que desde el 2026-09-14 es también la rampa de neutrales de Operations en
 *    tokens.css. Antes de esa fecha acá se forzaba Stone cálido.
 *
 * Global: afecta TODAS las surfaces (comercial/admin/portal/vendor). Es coherente
 * — el portal ya usa --action sunset y DESIGN.md manda sunset en Operations.
 */
export const OperationsPreset = definePreset(Aura, {
  semantic: {
    // Rampa primaria = naranja sunset (deriva de --action / --brand-*).
    primary: {
      50: '#FEF1ED',
      100: '#FCDDD3',
      200: '#F9BBA7',
      300: '#F5957A',
      400: '#F2744E',
      500: '#F05A28', // --action
      600: '#D2451C', // --action-hover
      700: '#B83C15', // --action-press
      800: '#8C2308', // --brand-900
      900: '#4B1300', // --brand-950
      950: '#2E0B00',
    },
    focusRing: {
      width: '2px',
      style: 'solid',
      color: '{primary.500}',
      offset: '2px',
    },
    colorScheme: {
      light: {
        primary: {
          color: '#F05A28',
          contrastColor: '#FFFFFF',
          hoverColor: '#D2451C',
          activeColor: '#B83C15',
        },
        highlight: {
          background: 'rgba(240, 90, 40, 0.12)',
          focusBackground: 'rgba(240, 90, 40, 0.20)',
          color: '#B83C15',
          focusColor: '#B83C15',
        },
        // Surface: SIN override — hereda el de Aura (slate en claro, zinc en
        // oscuro). Hasta el 2026-09-14 acá se pisaba con Stone cálido; al
        // adoptar Aura como paleta de neutrales de Operations (decisión Edgar,
        // ver DESIGN.md → Decisions Log) el override dejó de tener sentido:
        // pisarlo volvería a separar los componentes PrimeNG (panels, overlays,
        // dropdowns, dialogs, inputs) del chrome de la página, que ahora es
        // slate. El acento sunset se mantiene arriba, que es lo que sí
        // diferencia la marca.
      },
      dark: {
        primary: {
          color: '#F2744E',
          contrastColor: '#1A1A1A',
          hoverColor: '#F05A28',
          activeColor: '#F2744E',
        },
        highlight: {
          background: 'rgba(240, 90, 40, 0.18)',
          focusBackground: 'rgba(240, 90, 40, 0.28)',
          color: '#F5957A',
          focusColor: '#F5957A',
        },
      },
    },
  },
});
