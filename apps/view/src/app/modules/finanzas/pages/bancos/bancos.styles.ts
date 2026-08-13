/**
 * CB — Estilos COMPARTIDOS del tablero de bancos (shell + 11 hijos).
 *
 * Por qué existe: al partir la pantalla en 12 componentes, la encapsulación de Angular
 * obliga a redeclarar cada clase en cada hijo. El resultado fue 105 clases duplicadas
 * (`.mono` y `.muted` copiadas 11 veces) y drift real — `.bad` llegó a significar
 * `--bad-fg` en 6 archivos y `--warn-fg` en otro. Esto es la fuente única de las reglas
 * que usan 3+ componentes; lo específico de cada vista sigue en SU componente.
 *
 * Uso:  styles: [BANCOS_STYLES, `…lo propio de esta vista…`]
 *
 * Regla: si una clase la necesitan 3+ componentes, va acá — no se copia.
 * Tokens en libs/design-tokens/tokens.css. Cero hex crudo.
 */
export const BANCOS_STYLES = `
  :host { display: block; }

  /* Tipografía de dato: mono + tabular-nums obligatorio en toda cifra (DESIGN §7). */
  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

  /* Jerarquía por contraste de texto, no por color (DESIGN §Q.5). */
  .muted { color: var(--text-muted); }
  .fb-strong { font-weight: 600; color: var(--text-main); }

  /* Semánticos. Canónico: bad = error (rojo), warn = atención (ámbar).
     Un veredicto "no cuadra" es warn, NO bad — por eso los compuestos
     (.fb-diag-head.bad, .tw-verdict.bad) fijan warn en su propio componente. */
  .ok { color: var(--ok-fg); }
  .bad { color: var(--bad-fg); }
  .warn { color: var(--warn-fg); }

  /* Alineación: números a la derecha, texto a la izquierda (DESIGN §7). */
  .ta-r { text-align: right; }
  .ta-c { text-align: center; }

  /* Empty state operacional: nunca "sin resultados" a secas. */
  .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-8); color: var(--text-muted); }
  /* Glifo de icono: tamaño propio a propósito — la escala --fs-* gobierna TEXTO. */
  .surf-empty i { font-size: 1.5rem; }

  /* Contenedor de tabla dentro de card (la card ya pone borde: acá sin padding ni sombra). */
  .fb-tablewrap { padding: 0; overflow: hidden; }
  .fb-card-title { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: 0 0 var(--sp-3); }
  .fb-pnl-title { padding: var(--sp-3) var(--sp-3) 0; }

  /* Fila navegable (clic o Enter) — el foco se ve hacia adentro para no cortarse. */
  .fb-row-click { cursor: pointer; }
  .fb-row-click:focus-visible { outline: 2px solid var(--action-ring); outline-offset: -2px; }

  /* Barra de filtros + contador de truncamiento ("Mostrando X de Y"). */
  .fb-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
  .fb-search { min-width: 16rem; flex: 1; }
  .fb-count { margin-left: auto; font-size: var(--fs-xs); }

  /* Concepto largo: se trunca con title, nunca rompe la densidad de la fila. */
  .fb-concept { max-width: 28rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Lectura en llano al lado del número (DESIGN §Q.2) y nota al pie de un bloque. */
  .fb-plain { font-size: var(--fs-sm); color: var(--text-main); margin: var(--sp-2) 0 0; line-height: 1.4; }
  .fb-recon-note { font-size: var(--fs-xs); margin: var(--sp-3) 0 0; }

  /* Swatch de la leyenda de grupos: --g lo inyecta la fila/ítem. */
  .fb-legend-dot { width: 10px; height: 10px; border-radius: 3px; background: var(--g, var(--text-faint)); flex: none; }

  /* Dirección del dinero: entra / sale. */
  .fb-in-ico { color: var(--ok-fg); font-size: var(--fs-xs); margin-right: 4px; }
  .fb-out-ico { color: var(--text-faint); font-size: var(--fs-xs); margin-right: 4px; }

  /* Anchos de columna (evita style="width" inline — antipatrón DESIGN). */
  .col-w25 { width: 2.5rem; }
  .col-w4  { width: 4rem; }
  .col-w5  { width: 5rem; }
  .col-w6  { width: 6rem; }
  .col-w7  { width: 7rem; }
  .col-w8  { width: 8rem; }
  .col-w10 { width: 10rem; }
  .col-w11 { width: 11rem; }
`;
