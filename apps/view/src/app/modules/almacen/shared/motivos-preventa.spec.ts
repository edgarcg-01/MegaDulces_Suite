import { MOTIVOS_CAJA, MOTIVOS_SURTIDO, type PresaleReviewLine } from '@megadulces/contracts';
import { camposDeMotivo, motivoDe, motivosIncompletos, pidenMotivoEnCaja } from './motivos-preventa';
import type { ProgresoPedido } from '../revision-caja';

/** `[MCP.18]` El justificante del lado de la pantalla, sin Angular. */
describe('[MCP.18] motivos-preventa', () => {
  it('sin tocar, el renglón lleva el motivo de por omisión; tocado, el elegido', () => {
    expect(motivoDe({}, 'a', 'sin_existencia')).toEqual({ reason: 'sin_existencia', note: '' });
    expect(motivoDe({ a: { reason: 'danado', note: 'x' } }, 'a', 'sin_existencia')).toEqual({ reason: 'danado', note: 'x' });
  });

  it('a la red va sin nota vacía, y la nota recortada', () => {
    expect(camposDeMotivo({ reason: 'danado', note: '   ' })).toEqual({ reason: 'danado' });
    expect(camposDeMotivo({ reason: 'otro', note: '  se rompió  ' })).toEqual({ reason: 'otro', reason_note: 'se rompió' });
  });

  it('negativa: «Otro motivo» sin nota, o un motivo de otra lista, no se puede mandar', () => {
    const m = { a: { reason: 'otro', note: '' }, b: { reason: 'otro', note: 'ya' }, c: { reason: 'no_venia', note: '' } };
    expect(motivosIncompletos(m, ['a', 'b', 'c', 'd'], MOTIVOS_SURTIDO, 'sin_existencia')).toEqual(['a', 'c']);
    expect(motivosIncompletos(m, ['c'], MOTIVOS_CAJA, 'no_venia')).toEqual([]);
  });

  const linea = (key: string, ordered: number, picked: number): PresaleReviewLine => ({
    key, product_id: key, product_name: key, unit: 'PZA', factor: 1, ordered, picked, restorable: true, stock: null,
  });
  it('en caja, sólo lo que la CAJA deja por debajo de lo surtido pide motivo', () => {
    const lines = [linea('caja_quita', 2, 2), linea('ya_faltaba', 2, 1), linea('bien', 1, 1), linea('sin_resolver', 1, 1)];
    const p: ProgresoPedido = { hist: [], marcas: {
      caja_quita: { estado: 'nohay', vienen: 1, despues: false },
      ya_faltaba: { estado: 'nohay', vienen: 1, despues: false },
      bien: { estado: 'bien', vienen: 1, despues: false },
      sin_resolver: { estado: 'falta', vienen: 0, despues: false },
    } };
    expect(pidenMotivoEnCaja(lines, p).map((l) => l.key)).toEqual(['caja_quita']);
  });
});
