import { posicionDeCaja, type HechosPosicion } from './caja-posicion.engine';

/** `[CGS.35]` Lo que hay en caja, con los números de prod del 21-oct-2026. */
describe('posicionDeCaja', () => {
  const hoy: HechosPosicion = {
    ahora: '2026-10-21T23:00:00.000Z',
    corte: { folio: 'CC-2026-00008', fecha: '2026-10-20', contado: 25787, cerrado_at: '2026-10-21T00:10:00.000Z' },
    libro: { ingresos: 384282.39, gastos: 505411.53, depositos: 0, movimientos: 64 },
    caosCajon: { depositado: 302630, dispensado: 176460 },
    control: {
      folio: 'A23683', at: '2026-10-21T00:12:06.000Z', caja_fuerte: 376470, efectivo: 25787,
      usd: 12059, tipo_cambio: 19.101, cheques: 10121, papeles: 20782,
    },
    caosDesdeControl: { depositado: 302630, dispensado: 176460, otros: [] },
  };
  const de = (h: HechosPosicion, r: string) => posicionDeCaja(h).rubros.find((x) => x.rubro === r)!;

  it('[negativa] el cajón de hoy da −$221,512.14: se declara IMPOSIBLE, no se publica la cifra', () => {
    const e = de(hoy, 'efectivo');
    expect(e.ahora).toMatchObject({ monto: null, estado: 'imposible' });
    expect(e.ahora.nota).toContain('$221,512.14');
    expect(e.ultimo?.monto).toBe(25787);
  });

  it('la caja fuerte: lo arqueado por Control + depositado − dispensado = $502,640', () => {
    expect(de(hoy, 'caja_fuerte').ahora).toMatchObject({ monto: 502640, estado: 'derivado' });
  });

  it('con un vaciado o dotación en la máquina, la caja fuerte queda PARCIAL y lo dice', () => {
    const p = de({ ...hoy, caosDesdeControl: { ...hoy.caosDesdeControl!, otros: ['Vaciar Stocks'] } }, 'caja_fuerte');
    expect(p.ahora.estado).toBe('parcial');
    expect(p.ahora.nota).toContain('Vaciar Stocks');
  });

  it('dólares: USD 12,059 × 19.101 = $230,338.96, con los dólares a la vista', () => {
    expect(de(hoy, 'dolares').ahora).toMatchObject({ monto: 230338.96, usd: 12059, estado: 'medido' });
  });

  it('el total suma lo que se puede afirmar y dice qué quedó fuera', () => {
    const p = posicionDeCaja(hoy);
    expect(p.total).toEqual({ monto: 502640 + 230338.96 + 10121 + 20782, completo: false, fuera: ['efectivo'] });
  });

  it('con un cajón posible, entra al total y el total queda completo', () => {
    const p = posicionDeCaja({ ...hoy, libro: { ingresos: 1000, gastos: 0, depositos: 0, movimientos: 1 }, caosCajon: { depositado: 0, dispensado: 0 } });
    expect(p.rubros[0].ahora).toMatchObject({ monto: 26787, estado: 'derivado' });
    expect(p.total.completo).toBe(true);
  });

  it('sin arqueo de Control, los cuatro rubros se declaran NO MEDIDOS (no en cero)', () => {
    const p = posicionDeCaja({ ...hoy, control: null, caosDesdeControl: null });
    for (const r of ['caja_fuerte', 'dolares', 'cheques', 'papeles']) {
      expect(p.rubros.find((x) => x.rubro === r)!.ahora).toMatchObject({ monto: null, estado: 'no_medido' });
    }
  });
});
