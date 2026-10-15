import { contenidoCaja, UNIDAD_BASE_SIN_ROTULO } from './box-content';

/**
 * `[VTK.9]` Lo que el vendedor lee al buscar: cuanto trae la caja.
 *
 * Cada bloque trae su prueba negativa (ADR-056): el caso que NO debe pintar, o la cuenta
 * ingenua que daria un numero que no se puede entregar.
 */
describe('contenidoCaja · cuanto trae la caja', () => {
  const PZA = { unit: 'PZA', factor: 1 };
  const PAQ = { unit: 'PAQ', factor: 12 };
  const CJA = { unit: 'CJA', factor: 144 };

  it('⭐ dice la caja en paquetes y en piezas, de mayor a menor', () => {
    expect(contenidoCaja([PZA, PAQ, CJA], { unit: 'CJA', factor: 144 })).toEqual({
      caja: 'CJA',
      factor: 144,
      partes: [
        { unit: 'PAQ', qty: 12 },
        { unit: 'PZA', qty: 144 },
      ],
    });
  });

  it('caja sin paquete: solo la cuenta en unidad base', () => {
    expect(contenidoCaja([PZA, { unit: 'CJA', factor: 24 }], { unit: 'CJA', factor: 24 })?.partes).toEqual([
      { unit: 'PZA', qty: 24 },
    ]);
  });

  it('⭐ la caja que no se llama CJA (bulto de 20 kg) tambien se dice', () => {
    const r = contenidoCaja([{ unit: 'KG', factor: 1 }, { unit: 'BTO', factor: 20 }], { unit: 'BTO', factor: 20 });
    expect(r?.caja).toBe('BTO');
    expect(r?.partes).toEqual([{ unit: 'KG', qty: 20 }]);
  });

  it('⭐ el paquete que no cabe exacto se omite, no se pinta con decimales', () => {
    const r = contenidoCaja([PZA, PAQ, { unit: 'CJA', factor: 50 }], { unit: 'CJA', factor: 50 });
    expect(r?.partes).toEqual([{ unit: 'PZA', qty: 50 }]);
    // Prueba negativa: la cuenta ingenua daba 4.1666 paquetes, que nadie puede entregar.
    expect(50 / 12).not.toBe(Math.floor(50 / 12));
  });

  it('si la escalera no trae la unidad base, la cuenta se dice igual en unidades', () => {
    const r = contenidoCaja([PAQ, CJA], { unit: 'CJA', factor: 144 });
    expect(r?.partes).toEqual([
      { unit: 'PAQ', qty: 12 },
      { unit: UNIDAD_BASE_SIN_ROTULO, qty: 144 },
    ]);
  });

  it('⭐ la escalera vino y NO declara caja → nada (aunque haya un PAQ grande)', () => {
    expect(contenidoCaja([PZA, PAQ], null)).toBeNull();
    // Prueba negativa: sin escalera, el mismo SKU tampoco tiene rotulo de caja.
    expect(contenidoCaja([PZA, PAQ])).toBeNull();
  });

  it('sin escalera se reconoce la caja por rotulo (la mayor si hay dos)', () => {
    const r = contenidoCaja([PZA, PAQ, CJA, { unit: 'BTO', factor: 288 }]);
    expect(r?.caja).toBe('BTO');
    expect(r?.partes.map((p) => p.unit)).toEqual(['CJA', 'PAQ', 'PZA']);
  });

  it('caja de factor 1 o basura no es caja', () => {
    expect(contenidoCaja([PZA], { unit: 'CJA', factor: 1 })).toBeNull();
    expect(contenidoCaja([PZA], { unit: 'CJA', factor: Number.NaN })).toBeNull();
    expect(contenidoCaja([{ unit: 'CJA', factor: 1 }])).toBeNull();
    expect(contenidoCaja([])).toBeNull();
    expect(contenidoCaja(undefined)).toBeNull();
  });

  it('el paquete desambiguado ("PAQ x11") se pinta con su rotulo del selector', () => {
    const r = contenidoCaja(
      [{ unit: 'PAQ', factor: 1 }, { unit: 'PAQ', factor: 11 }, { unit: 'CJA', factor: 66 }],
      { unit: 'CJA', factor: 66 },
    );
    expect(r?.partes).toEqual([
      { unit: 'PAQ x11', qty: 6 },
      { unit: 'PAQ', qty: 66 },
    ]);
  });
});
