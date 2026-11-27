import {
  avisoDeTope, excesoDeTope, MAX_TRANSFERENCIAS_POR_PAGO, partesPorTope, topeDeTransferencia,
} from './tope-por-transferencia.contract';

/**
 * `[PGP.221]` BBVA no deja pasar de $1,000,000.00 por transferencia (Francisco, 2026-11-26; medido en la descarga del
 * banco desde junio: ninguna transferencia de BBVA arriba del millón). El caso: Effem, $1,020,891.81 en dos SPEI.
 */
describe('[PGP.221] el tope por operación del banco', () => {
  it('BBVA tiene tope de $1,000,000.00, con cualquiera de sus nombres; un banco sin tope medido no lo tiene', () => {
    expect(topeDeTransferencia('BBVA')).toBe(1_000_000);
    expect(topeDeTransferencia('Bancomer')).toBe(1_000_000);
    expect(topeDeTransferencia('bbva méxico')).toBe(1_000_000);
    expect(topeDeTransferencia('SANTANDER')).toBeNull();
    expect(topeDeTransferencia('BBAJIO')).toBeNull();
    expect(topeDeTransferencia('CAJA')).toBeNull();
    expect(topeDeTransferencia(null)).toBeNull();
  });

  it('el caso de Effem sale en dos: el tope y el resto, al centavo', () => {
    expect(partesPorTope(1_020_891.81, 1_000_000)).toEqual([1_000_000, 20_891.81]);
    expect(excesoDeTope(1_020_891.81, 'BBVA')).toEqual({ banco: 'BBVA', tope: 1_000_000, partes: [1_000_000, 20_891.81] });
  });

  it('el borde: un millón exacto cabe; un centavo más ya son dos', () => {
    expect(excesoDeTope(1_000_000, 'BBVA')).toBeNull();
    expect(excesoDeTope(1_000_000.01, 'BBVA')?.partes).toEqual([1_000_000, 0.01]);
    expect(avisoDeTope({ importe: 1_000_000, banco: 'BBVA' })).toBeNull();
  });

  it('varios millones: tantas transferencias como hagan falta; el resto suma exacto', () => {
    const p = partesPorTope(3_570_254.76, 1_000_000)!;
    expect(p).toEqual([1_000_000, 1_000_000, 1_000_000, 570_254.76]);
    expect(Math.round(p.reduce((s, x) => s + x, 0) * 100)).toBe(357_025_476);
    expect(partesPorTope(2_000_000, 1_000_000)).toEqual([1_000_000, 1_000_000]);
  });

  it(`más de ${MAX_TRANSFERENCIAS_POR_PAGO} transferencias no se proponen; el aviso dice que salga de otro banco`, () => {
    expect(partesPorTope(10_000_000, 1_000_000)).toHaveLength(MAX_TRANSFERENCIAS_POR_PAGO);
    expect(partesPorTope(10_000_000.01, 1_000_000)).toBeNull();
    expect(avisoDeTope({ importe: 12_500_000, banco: 'BBVA' })).toMatch(/más de 10 transferencias.*otro banco/);
  });

  it('el aviso del pago entero dice en cuántas sale, con sus importes, y dónde se parte', () => {
    expect(avisoDeTope({ importe: 1_020_891.81, banco: 'BBVA' })).toBe(
      'BBVA no deja pasar de $1,000,000.00 por transferencia y este pago es de $1,020,891.81: sale en 2 transferencias '
      + '($1,000,000.00 + $20,891.81). En «Preparar pago», márcalo «Sale en varias transferencias».');
  });

  it('una parte de un pago partido que pasa del tope pide partir en más; un anticipo pide otro banco', () => {
    expect(avisoDeTope({ importe: 1_500_000, banco: 'BBVA', parte: 1 })).toMatch(/^La transferencia 1 es de \$1,500,000\.00 y sale de BBVA.*pártela en más/);
    expect(avisoDeTope({ importe: 1_200_000, banco: 'BBVA', esAnticipo: true })).toMatch(/anticipo sale en una sola transferencia.*otro banco/);
  });

  it('⛔ sin tope conocido no se bloquea nada (Santander deja pasar más de un millón: medido)', () => {
    expect(avisoDeTope({ importe: 5_000_000, banco: 'SANTANDER' })).toBeNull();
    expect(avisoDeTope({ importe: 5_000_000, banco: null })).toBeNull();
    expect(excesoDeTope(5_000_000, 'Banco Desconocido')).toBeNull();
  });
});
