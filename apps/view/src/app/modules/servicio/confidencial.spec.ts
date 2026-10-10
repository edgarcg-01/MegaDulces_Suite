import type { SdRequestRow } from '@megadulces/contracts';
import { TITULO_VISTA_LIMITADA, avisoConfidencial, esVistaLimitada, etiquetaPrioridad, plazoDeFila, tituloVisible } from './confidencial';

/**
 * `[MSH.3]` La pantalla no inventa lo que el servidor no manda. Lo que se defiende:
 *  · ⛔ una prioridad `null` NO produce etiqueta (ni «undefined» ni «—»: el chip no se pinta);
 *  · ⛔ una fila de vista limitada se rotula con el título neutro y no con su `title` (vacío);
 *  · ⛔ en vista limitada o en un área sin prioridad NO hay «Sin plazo» ni semáforo: no hay plazo que mirar;
 *  · lo normal queda IGUAL (control).
 */
const fila = (p: Partial<SdRequestRow> = {}): Pick<SdRequestRow, 'sla' | 'status' | 'basic' | 'priority' | 'title'> => ({
  title: 'No abre la caja', status: 'nuevo', priority: 'alta', basic: undefined,
  sla: { first_response_due_at: null, due_at: new Date(Date.now() + 3 * 3_600_000).toISOString(), first_responded_at: null, paused: false, first_breached: false, resolution_breached: false, used_ratio: 0.1 },
  ...p,
});

describe('MSH.3 · etiquetaPrioridad', () => {
  it('⭐ control: una prioridad normal sale con su nombre', () => expect(etiquetaPrioridad('urgente')).toBe('Urgente'));
  it('⛔ NEGATIVA — `null`/`undefined` NO dan etiqueta: el chip no se pinta', () => {
    expect(etiquetaPrioridad(null)).toBeNull();
    expect(etiquetaPrioridad(undefined)).toBeNull();
  });
});

describe('MSH.3 · vista limitada', () => {
  it('⛔ NEGATIVA — la fila limitada se rotula neutra, no con su `title` vacío', () => {
    expect(tituloVisible({ title: '', basic: true })).toBe(TITULO_VISTA_LIMITADA);
    expect(tituloVisible({ title: 'x', basic: true })).toBe(TITULO_VISTA_LIMITADA);
  });
  it('⭐ control: una fila normal conserva su título', () => expect(tituloVisible({ title: 'No abre la caja', basic: undefined })).toBe('No abre la caja'));
  it('esVistaLimitada sólo es true con `basic: true`', () => {
    expect(esVistaLimitada({ basic: true })).toBe(true);
    expect(esVistaLimitada({ basic: false })).toBe(false);
    expect(esVistaLimitada({})).toBe(false);
    expect(esVistaLimitada(null)).toBe(false);
  });
});

describe('MSH.3 · plazoDeFila', () => {
  it('⛔ NEGATIVA — vista limitada: «—» y tono neutro (nada que semaforizar)', () => {
    expect(plazoDeFila(fila({ basic: true }) as never)).toEqual({ texto: '—', tono: 'mute' });
  });
  it('⛔ NEGATIVA — un área sin prioridad (`priority: null`) tampoco muestra «Sin plazo»', () => {
    expect(plazoDeFila(fila({ priority: null }) as never)).toEqual({ texto: '—', tono: 'mute' });
  });
  it('⭐ control: una fila normal sigue mostrando «Vence en …»', () => {
    expect(plazoDeFila(fila() as never).texto).toMatch(/^Vence en /);
  });
});

describe('MSH.3 · avisoConfidencial', () => {
  it('⭐ dice quién la verá y quién NO, con el nombre del área', () => {
    const t = avisoConfidencial('Recursos Humanos');
    expect(t).toContain('confidencial');
    expect(t).toContain('equipo de Recursos Humanos');
    expect(t).toContain('no verá su contenido');
  });
  it('sin nombre de área no queda un hueco', () => expect(avisoConfidencial('  ')).toContain('equipo de esta área'));
});
