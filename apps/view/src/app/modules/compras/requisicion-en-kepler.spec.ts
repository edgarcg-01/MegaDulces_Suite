// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { bannerKepler, quienCuando } from './requisicion-en-kepler';
import type { RequisitionDetail } from './compras.service';

/**
 * `[KR.7]` El banner «En Kepler» de la ficha dice lo que pasó ALLÁ (la réplica), no lo que la Suite cree.
 * Los casos salen de prod (anexo K §3e, 2026-11-14): la requisición 0003143 de CEDIS, que la Suite escribió
 * y una persona canceló a mano (su OC 0007296 antes); 21 requisiciones reabiertas en Kepler porque su OC
 * se canceló a mano, que aquí decían «Ordenada» con palomita; y una al revés.
 */
const LABEL: Record<string, string> = { ordered: 'Ordenada', received: 'Recibida', cancelled: 'Cancelada', approved: 'Aprobada' };
const base = {
  estado: 'ordered', source_type: 'supplier', kepler_sucursal: '00', kepler_folio: '0003143',
  kepler_error: null, oc_cancelada: null,
} as unknown as RequisitionDetail;
const bk = (x: Partial<RequisitionDetail>) => {
  const r = { ...base, ...x } as RequisitionDetail;
  return bannerKepler(r, LABEL[r.estado] ?? r.estado);
};
const doc = (folio: string, estado: string, por: string | null = null, en = '') =>
  ({ folio, estado, cancelada: estado === 'C' ? { por, en } : null });

describe('[KR.7] ficha de la requisición — lo que pasó en Kepler', () => {
  it('cancelada a mano en Kepler: lo dice con quién y cuándo, y que en la Suite sigue «Ordenada»', () => {
    const b = bk({ en_kepler: {
      requisicion: doc('0003143', 'C', '07', '2026-11-06 13:58'),
      ocs: [doc('0007296', 'C', '42YAGL', '2026-11-06 11:45')],
    } })!;
    expect(b.texto).toContain('se canceló el 06/11/26 13:58 por 07');
    expect(b.texto).toContain('En la Suite sigue como «Ordenada»');
    expect(b.icono).toBe('pi-ban');
    expect(b.tenue).toBe(false);
  });

  it('NEGATIVA: cancelada en Kepler NUNCA sale con la palomita tenue de «en Kepler» (el rótulo de antes)', () => {
    const b = bk({ en_kepler: { requisicion: doc('0003143', 'C', '07', '2026-11-06 13:58'), ocs: [] } })!;
    expect(b.icono).not.toBe('pi-check-circle');
    expect(b.tenue).toBe(false);
  });

  it('reabierta porque su OC se canceló a mano: nombra la OC, quién y cuándo, y la sucursal por nombre', () => {
    const b = bk({ kepler_sucursal: '08', kepler_folio: '0000008', en_kepler: {
      requisicion: doc('0000008', 'A'), ocs: [doc('0000210', 'C', '30APL', '2026-11-02 10:12')],
    } })!;
    expect(b.texto).toContain('volvió a pendiente');
    expect(b.texto).toContain('su orden de compra 0000210 se canceló a mano el 02/11/26 10:12 por 30APL');
    expect(b.texto).toContain('Morelia Abastos');
    expect(b.texto).not.toMatch(/\b08\//);
  });

  it('si la canceló la Suite, no repite lo que ya dice el aviso de D41', () => {
    const b = bk({
      oc_cancelada: { en: '2026-11-14T16:00:00Z', por: 'gerente', motivo: 'no surtió', requisicion_reabierta: true },
      en_kepler: { requisicion: doc('0003143', 'A'), ocs: [doc('0007296', 'C', 'SUITE', '2026-11-14 10:00')] },
    })!;
    expect(b.texto).toContain('volvió a pendiente: ya no tiene orden de compra viva');
    expect(b.texto).not.toContain('a mano');
  });

  it('con otra OC viva, no dice que volvió a pendiente', () => {
    const b = bk({ en_kepler: {
      requisicion: doc('0003143', 'A'), ocs: [doc('0007296', 'C', 'X', '2026-11-06 11:45'), doc('0007300', 'N')],
    } })!;
    expect(b.texto).not.toContain('volvió a pendiente');
  });

  it('el revés: cancelada en la Suite y viva en Kepler con su OC → lo avisa', () => {
    const b = bk({ estado: 'cancelled', en_kepler: { requisicion: doc('0003143', 'F'), ocs: [doc('0007296', 'N')] } })!;
    expect(b.texto).toContain('En la Suite está cancelada, pero en Kepler');
    expect(b.texto).toContain('con su orden de compra');
    expect(b.icono).toBe('pi-exclamation-triangle');
  });

  it('cancelada en las dos: no hay nada que avisar', () => {
    expect(bk({ estado: 'cancelled', en_kepler: { requisicion: doc('0003143', 'C', '07', '2026-11-06'), ocs: [] } })).toBeNull();
  });

  it('sin réplica (null) se DECLARA; viva y normal sale tenue como antes, con la sucursal por nombre', () => {
    expect(bk({ en_kepler: null })!.texto).toContain('no se pudo leer');
    const ok = bk({ en_kepler: { requisicion: doc('0003143', 'F'), ocs: [doc('0007296', 'N')] } })!;
    expect(ok.icono).toBe('pi-check-circle');
    expect(ok.texto).toBe('En Kepler como requisición 0003143 de CEDIS.');
  });

  it('traspaso o API vieja (sin en_kepler): el texto de siempre, sin afirmar que se leyó', () => {
    const t = bk({ source_type: 'branch' })!;
    expect(t.texto).toContain('pedido de traspaso');
    expect(t.texto).not.toContain('no se pudo leer');
  });

  it('pendiente de aprobar: nada que decir', () => {
    expect(bk({ estado: 'pending_approval' as never })).toBeNull();
  });

  it('quienCuando tolera fecha sin hora y sin quién', () => {
    expect(quienCuando({ por: null, en: '2026-11-06' })).toBe(' el 06/11/26');
    expect(quienCuando(null)).toBe('');
  });

  it('el componente delega aquí (una sola regla, no dos)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, 'pages', 'compras-requisicion-detalle.component.ts'), 'utf8');
    expect(src).toContain('return bannerKepler(r, this.estadoLabel(r.estado));');
    expect(src).not.toContain('Todavía no se escribió en Kepler');
  });
});
