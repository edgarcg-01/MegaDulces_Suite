/**
 * `[E.29]` La paleta de los DOCUMENTOS (PDF y Excel), espejo de `libs/design-tokens/tokens.css` en
 * modo CLARO — el papel es blanco aunque la pantalla esté en oscuro.
 *
 * Por qué existe: jsPDF y ExcelJS no leen variables CSS, así que cada generador escribía sus hex a
 * mano. La hoja de la cotización mezclaba neutros slate (gris AZULADO; el sistema es zinc), un
 * verde azulado que ya no es de la marca y blanco sobre naranja: 5 de sus 8 pares de texto
 * quedaban abajo de 4.5:1. Un solo lugar, y `paleta-documento.spec.ts` comprueba que cada valor
 * sea el de su token y que cada rol de TEXTO cumpla AA — si alguien cambia un token, la prueba
 * se pone roja en vez de dejar el papel desfasado de la pantalla.
 *
 * Reglas de uso (DESIGN.md §5 «color disciplinado»):
 *  - Fondo blanco y neutros: el documento es SOBRIO. La marca es el logo y, a lo sumo, un filete;
 *    la jerarquía la dan el tamaño y el peso, no el color (la cotización: «tiene mucho color»).
 *  - `marca` (#F05A28) NUNCA como texto chico: da 3.39:1. Para texto de marca, `marcaTexto`.
 *  - `[CI]` 2026-10-28: desde [AUD.4] (2026-10-26) `--action` en claro es #C8401A (contraste AA de la
 *    PANTALLA). El papel no cambia de marca: `marca` se lee de `--brand-700`, el sunset, que AUD.4
 *    declara que «sigue siendo la marca». `marcaTexto` sigue a `--action-press` (#9C3311, 7.25:1 sobre blanco).
 *  - Los estados (ok/aviso/error/info/neutro) significan lo mismo en todos los documentos y nunca
 *    van solos: siempre con su texto («VENCIDA», «SIN ASIGNAR»).
 */
export const PALETA_DOCUMENTO = {
  /** --text-main: texto principal y cifras. */
  tinta: '#09090B',
  /** --text-muted: texto secundario, notas, etiquetas. */
  tintaSecundaria: '#52525B',
  /** --border-color: bordes y divisores de tabla. */
  regla: '#E4E4E7',
  /** --surface-ground: bloques informativos. */
  fondoSuave: '#FAFAFA',
  /** --neutral-100: encabezados de tabla (en vez de un relleno oscuro que gasta tinta). */
  encabezado: '#F4F4F5',
  /** --card-bg */
  blanco: '#FFFFFF',
  /** --brand-700 (el sunset de la marca): SÓLO un trazo (el filete del encabezado). Como texto chico no cumple AA. */
  marca: '#F05A28',
  /** --action-press: si alguna vez la marca tiene que ser TEXTO, éste, nunca --brand-700. */
  marcaTexto: '#9C3311',
  estado: {
    ok: { fg: '#166534', bg: '#DCFCE7', borde: '#BBF7D0' },
    aviso: { fg: '#92400E', bg: '#FEF3C7', borde: '#FDE68A' },
    error: { fg: '#991B1B', bg: '#FEE2E2', borde: '#FECACA' },
    info: { fg: '#1E40AF', bg: '#DBEAFE', borde: '#BFDBFE' },
    neutro: { fg: '#52525B', bg: '#F4F4F5', borde: '#E4E4E7' },
  },
} as const;

/** El token de `tokens.css` del que sale cada rol (lo usa la prueba para no desfasarse). */
export const TOKEN_DE: Record<string, string> = {
  tinta: '--text-main',
  tintaSecundaria: '--text-muted',
  regla: '--border-color',
  fondoSuave: '--surface-ground',
  encabezado: '--neutral-100',
  blanco: '--card-bg',
  marca: '--brand-700',
  marcaTexto: '--action-press',
  'estado.ok.fg': '--ok-soft-fg', 'estado.ok.bg': '--ok-soft-bg', 'estado.ok.borde': '--ok-border',
  'estado.aviso.fg': '--warn-soft-fg', 'estado.aviso.bg': '--warn-soft-bg', 'estado.aviso.borde': '--warn-border',
  'estado.error.fg': '--bad-soft-fg', 'estado.error.bg': '--bad-soft-bg', 'estado.error.borde': '--bad-border',
  'estado.info.fg': '--info-soft-fg', 'estado.info.bg': '--info-soft-bg', 'estado.info.borde': '--info-border',
  'estado.neutro.fg': '--text-muted', 'estado.neutro.bg': '--neutral-100', 'estado.neutro.borde': '--border-color',
};

/** `#RRGGBB` → `[r, g, b]` para jsPDF. */
export function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** `#RRGGBB` → `FFRRGGBB` para ExcelJS. */
export function argb(hex: string): string {
  return `FF${hex.replace('#', '').toUpperCase()}`;
}

/** Contraste WCAG 2.x entre dos `#RRGGBB` (1 a 21). */
export function contraste(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = rgb(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
