import { validarConteo, diferenciaContra } from './caos-conteo-fisico';

/** `[CGS.22]` El conteo físico de la caja fuerte: 0 en toda la historia hasta el 2026-10-21. */
describe('validarConteo', () => {
  it('suma billete por billete e ignora los renglones en cero', () => {
    const r = validarConteo([
      { denominacion: 500, piezas: 507 }, { denominacion: 200, piezas: 383 }, { denominacion: 100, piezas: 252 },
      { denominacion: 50, piezas: 46 }, { denominacion: 20, piezas: 121 }, { denominacion: 1000, piezas: 0 },
    ]);
    // El contenido que la máquina reportó el 2026-10-20 a las 10:04: $360,020.00.
    expect(r).toMatchObject({ ok: true, total: 360020 });
    if (r.ok) expect(r.piezas.map((p) => p.denominacion)).toEqual([500, 200, 100, 50, 20]);
  });

  it('todo en cero es una caja fuerte vacía: válido y en $0', () => {
    expect(validarConteo([{ denominacion: 500, piezas: 0 }])).toMatchObject({ ok: true, total: 0 });
  });

  it('[negativa] sin renglones, con una denominación que no existe o con piezas raras: rechaza', () => {
    expect(validarConteo([])).toEqual({ ok: false, motivo: 'vacio' });
    expect(validarConteo([{ denominacion: 10, piezas: 3 }])).toEqual({ ok: false, motivo: 'denominacion' });
    expect(validarConteo([{ denominacion: 500, piezas: -1 }])).toEqual({ ok: false, motivo: 'piezas' });
    expect(validarConteo([{ denominacion: 500, piezas: 1.5 }])).toEqual({ ok: false, motivo: 'piezas' });
  });
});

describe('diferenciaContra', () => {
  it('con referencia: contado menos lo que decía la máquina', () => {
    expect(diferenciaContra(359820, 360020)).toBe(-200);
  });
  it('[negativa] sin referencia NO es cero: es null (no se midió)', () => {
    expect(diferenciaContra(360020, null)).toBeNull();
  });
});
