// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { bannerKepler, cancelacionEnFicha, fechaMx, quienCuando, type BannerKepler } from './requisicion-en-kepler';
import type { RequisicionCancelacionDisponibleDto } from '@megadulces/contracts';
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

describe('[KR.7] C3 — después de cancelarla en Kepler desde la Suite (D43)', () => {
  const KC = { en: '2026-11-14T18:30:00.000Z', por: 'gerente.compras', motivo: 'El proveedor ya no surte' };

  it('la réplica todavía la ve viva: dice que se canceló desde la Suite, cuándo (hora de México), quién, por qué, y que Kepler no lo refleja aún', () => {
    const b = bk({ estado: 'cancelled', kepler_cancelacion: KC, kepler_sucursal: '08', kepler_folio: '0000064',
      en_kepler: { requisicion: doc('0000064', 'A'), ocs: [doc('0000390', 'C')] } } as Partial<RequisitionDetail>)!;
    expect(b.texto).toBe('La requisición 0000064 de Morelia Abastos se canceló en Kepler desde la Suite el 14/11/26 12:30 por gerente.compras: «El proveedor ya no surte». Kepler todavía no lo refleja en su réplica.');
    expect(b.pideCancelar).toBe(false);
  });

  it('NEGATIVA: recién cancelada desde aquí NUNCA dice «sigue viva, hay que cancelarla allá» (la réplica va atrasada)', () => {
    const b = bk({ estado: 'cancelled', kepler_cancelacion: KC, en_kepler: { requisicion: doc('0003143', 'A'), ocs: [] } } as Partial<RequisitionDetail>)!;
    expect(b.texto).not.toContain('sigue viva');
    expect(b.icono).toBe('pi-ban');
  });

  it('la réplica ya la ve en C: sin la coletilla; sin réplica: lo declara', () => {
    const ya = bk({ estado: 'cancelled', kepler_cancelacion: KC, en_kepler: { requisicion: doc('0003143', 'C', 'SUITE', '2026-11-14 12:30'), ocs: [] } } as Partial<RequisitionDetail>)!;
    expect(ya.texto.endsWith('«El proveedor ya no surte».')).toBe(true);
    const sin = bk({ estado: 'cancelled', kepler_cancelacion: KC, en_kepler: null } as Partial<RequisitionDetail>)!;
    expect(sin.texto).toContain('Su estado en Kepler no se pudo leer.');
  });

  it('pideCancelar: sólo «sigue viva allá» y «volvió a pendiente»; nunca la normal ni la ya cancelada', () => {
    expect(bk({ estado: 'cancelled', en_kepler: { requisicion: doc('1', 'F'), ocs: [doc('2', 'N')] } })!.pideCancelar).toBe(true);
    expect(bk({ en_kepler: { requisicion: doc('1', 'A'), ocs: [doc('2', 'C')] } })!.pideCancelar).toBe(true);
    expect(bk({ en_kepler: { requisicion: doc('1', 'F'), ocs: [doc('2', 'N')] } })!.pideCancelar).toBe(false);
    expect(bk({ en_kepler: { requisicion: doc('1', 'C', '07', '2026-11-06 13:58'), ocs: [] } })!.pideCancelar).toBe(false);
  });

  it('fechaMx: dd/MM/aa HH:mm en hora de México (no la del navegador ni UTC)', () => {
    expect(fechaMx('2026-11-15T02:05:00.000Z')).toBe('14/11/26 20:05');
    expect(fechaMx('no-es-fecha')).toBe('no-es-fecha');
  });
});

describe('[KR.7] C3 — el botón «Cancelar en Kepler», o por qué no', () => {
  const pide: BannerKepler = { texto: '', icono: 'pi-ban', tenue: false, reintentable: false, pideCancelar: true };
  const normal: BannerKepler = { ...pide, pideCancelar: false, tenue: true, icono: 'pi-check-circle' };
  const info = (o: Partial<RequisicionCancelacionDisponibleDto>): RequisicionCancelacionDisponibleDto =>
    ({ requisition_id: 'x', sucursal: '08', folio: '0000064', disponible: false, porque: null, ultima: null, ...o });

  it('disponible → botón, en cualquier renglón (también una recién escrita, en N y sin OC)', () => {
    expect(cancelacionEnFicha(info({ disponible: true }), false, pide)).toEqual({ boton: true, nota: null });
    expect(cancelacionEnFicha(info({ disponible: true }), false, normal)).toEqual({ boton: true, nota: null });
  });

  it('NEGATIVA: sin «disponible» del servidor NUNCA hay botón (mientras no conteste, tampoco)', () => {
    expect(cancelacionEnFicha(info({ porque: 'apagado' }), false, pide).boton).toBe(false);
    expect(cancelacionEnFicha(null, false, pide).boton).toBe(false);
  });

  it('no se puede y el renglón pide cancelar: dice por qué (con punto final)', () => {
    const n = cancelacionEnFicha(info({ porque: 'Cancelar la requisición en Kepler está apagado para Morelia Abastos: cancélala en Kepler a mano' }), false, pide);
    expect(n).toEqual({ boton: false, nota: 'Cancelar la requisición en Kepler está apagado para Morelia Abastos: cancélala en Kepler a mano.' });
  });

  it('no se puede en una requisición normal (con su OC viva): no dice nada — sería ruido en 180 de 203', () => {
    expect(cancelacionEnFicha(info({ porque: 'Tiene viva la orden de compra 0000393: primero se cancela la OC' }), false, normal)).toEqual({ boton: false, nota: null });
  });

  it('un intento anterior que Kepler rechazó se dice, para no repetir a ciegas', () => {
    const ultima = { requisition_id: 'x', sucursal: '08', folio: '0000064', estado: 'rechazada' as const, rechazo: 'Alguien tiene esa requisición abierta en Kepler', suite_cancelada: null, cancelada_por: 'a', cancelada_en: '2026-11-14T00:00:00Z' };
    expect(cancelacionEnFicha(info({ disponible: true, ultima }), false, pide).nota).toBe('Último intento desde la Suite, sin cambios en Kepler: Alguien tiene esa requisición abierta en Kepler');
  });

  it('el GET falló: sólo se dice donde el renglón pide cancelar', () => {
    expect(cancelacionEnFicha(null, true, pide).nota).toBe('No se pudo revisar si se puede cancelar desde aquí.');
    expect(cancelacionEnFicha(null, true, normal).nota).toBeNull();
  });

  it('el componente delega aquí y pregunta al servidor antes de ofrecer el botón', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, 'pages', 'compras-requisicion-detalle.component.ts'), 'utf8');
    expect(src).toContain('return cancelacionEnFicha(this.rqCancInfo(), this.rqCancInfoError(), kb);');
    expect(src).toContain('this.api.requisicionCancelacion(r.id)');
    expect(src).toContain('Permission.COMPRAS_REQUISICION_CANCELAR');
  });
});
