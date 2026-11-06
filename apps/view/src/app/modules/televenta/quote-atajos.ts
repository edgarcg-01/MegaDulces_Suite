/**
 * `[COT.33]` Los atajos de teclado del cotizador (alta y detalle), en UNA función pura: las dos
 * pantallas leen la tecla igual y se prueba sin montar Angular (`quote-atajos.spec.ts`).
 *
 * - `/` → al buscador de artículo. Convención de la suite (Calendario de pagos, Catálogo digital).
 *   Sólo FUERA de un campo: dentro, «/» es texto (una observación, una lista del cliente).
 * - `Alt+1/2/3` → la unidad, de menor a mayor. Por `code` y no por `key`: con Alt la tecla puede
 *   llegar como otro carácter según el teclado.
 * - `Ctrl+Enter` (o ⌘+Enter) → crear la cotización, si la pantalla lo permite.
 */
export type Atajo = { tipo: 'buscar' } | { tipo: 'crear' } | { tipo: 'unidad'; indice: number } | null;

type Tecla = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'> & { target: EventTarget | null };

export function esCampoDeTexto(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable;
}

export function atajoDeTecla(ev: Tecla, opciones: { crear?: boolean } = {}): Atajo {
  if (ev.key === '/' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    return esCampoDeTexto(ev.target) ? null : { tipo: 'buscar' };
  }
  if (opciones.crear && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.altKey) return { tipo: 'crear' };
  const n = ev.altKey && !ev.ctrlKey && !ev.metaKey ? /^(?:Digit|Numpad)([1-3])$/.exec(ev.code) : null;
  return n ? { tipo: 'unidad', indice: Number(n[1]) - 1 } : null;
}
