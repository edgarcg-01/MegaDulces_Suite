import { RESTO_TOLERADO, esRestoDeFactura, esRestoTolerado } from './resto-tolerado.contract';
import * as cierre from './cierre-kepler.contract';

describe('[GP.R.1] la regla del resto de centavos', () => {
  it('un resto de centavos de una factura que ya tuvo cobro es resto', () => {
    expect(esRestoDeFactura(0.37, 15730.37)).toBe(true);
    expect(esRestoDeFactura(RESTO_TOLERADO, 500)).toBe(true);
  });

  it('negativo: una factura que nunca tuvo cobro NO es resto aunque deba centavos', () => {
    expect(esRestoDeFactura(0.08, 0.08)).toBe(false);
  });

  it('negativo: más del tope no es resto, es deuda', () => {
    expect(esRestoDeFactura(1.01, 4458.4)).toBe(false);
    expect(esRestoTolerado(1.01)).toBe(false);
  });

  it('negativo: saldada (≤ medio centavo) o sin dato no es resto', () => {
    expect(esRestoDeFactura(0.004, 100)).toBe(false);
    expect(esRestoDeFactura(null, 100)).toBe(false);
    expect(esRestoDeFactura(0.5, null)).toBe(false);
    expect(esRestoDeFactura(Number.NaN, 100)).toBe(false);
  });

  it('cierre-kepler re-exporta el MISMO primitivo (un solo lugar, ADR-056)', () => {
    expect(cierre.esRestoTolerado).toBe(esRestoTolerado);
    expect(cierre.RESTO_TOLERADO).toBe(RESTO_TOLERADO);
  });
});
