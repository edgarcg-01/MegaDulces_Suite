import {
  RESTO_TOLERADO,
  RESTO_TOLERADO_CLIENTE,
  RESTO_TOLERADO_PROVEEDOR,
  esRestoDeFactura,
  esRestoTolerado,
} from './resto-tolerado.contract';
import * as cierre from './cierre-kepler.contract';

describe('[GP.R.1] la regla del resto de centavos', () => {
  it('un resto de centavos de una factura que ya tuvo cobro es resto', () => {
    expect(esRestoDeFactura(0.37, 15730.37, RESTO_TOLERADO_CLIENTE)).toBe(true);
    expect(esRestoDeFactura(RESTO_TOLERADO_PROVEEDOR, 500, RESTO_TOLERADO_PROVEEDOR)).toBe(true);
    expect(esRestoDeFactura(RESTO_TOLERADO_CLIENTE, 500, RESTO_TOLERADO_CLIENTE)).toBe(true);
  });

  it('negativo: una factura que nunca tuvo cobro NO es resto aunque deba centavos', () => {
    expect(esRestoDeFactura(0.08, 0.08, RESTO_TOLERADO_CLIENTE)).toBe(false);
  });

  it('negativo: más del tope no es resto, es deuda', () => {
    expect(esRestoDeFactura(10.01, 4458.4, RESTO_TOLERADO_CLIENTE)).toBe(false);
    expect(esRestoTolerado(10.01, RESTO_TOLERADO_CLIENTE)).toBe(false);
    expect(esRestoDeFactura(1.01, 4458.4, RESTO_TOLERADO_PROVEEDOR)).toBe(false);
    expect(esRestoTolerado(1.01, RESTO_TOLERADO_PROVEEDOR)).toBe(false);
  });

  it('negativo: saldada (≤ medio centavo) o sin dato no es resto', () => {
    expect(esRestoDeFactura(0.004, 100, RESTO_TOLERADO_CLIENTE)).toBe(false);
    expect(esRestoDeFactura(null, 100, RESTO_TOLERADO_CLIENTE)).toBe(false);
    expect(esRestoDeFactura(0.5, null, RESTO_TOLERADO_CLIENTE)).toBe(false);
    expect(esRestoDeFactura(Number.NaN, 100, RESTO_TOLERADO_CLIENTE)).toBe(false);
    expect(esRestoTolerado(0.5, Number.NaN)).toBe(false);
  });

  /**
   * ⛔ **El control que faltaba el 2026-11-24.** Hasta ese día el tope era UNA constante que servía a D-C1
   * (proveedores, dinero que sale) y a D-R1 (clientes, dinero que entra). Firmar D-R1 en $10 habría movido
   * callado el lado de proveedores: medido ese día, 55 documentos por $193.48. Si alguien vuelve a atarlos,
   * esta prueba se pone roja.
   */
  it('los DOS topes son decisiones distintas y no se mueven juntos', () => {
    expect(RESTO_TOLERADO_CLIENTE).toBe(10);
    expect(RESTO_TOLERADO_PROVEEDOR).toBe(1);
    expect(RESTO_TOLERADO_CLIENTE).not.toBe(RESTO_TOLERADO_PROVEEDOR);
  });

  it('un resto de $5 es resto del lado CLIENTE y deuda del lado PROVEEDOR', () => {
    expect(esRestoDeFactura(5, 2000, RESTO_TOLERADO_CLIENTE)).toBe(true);
    expect(esRestoDeFactura(5, 2000, RESTO_TOLERADO_PROVEEDOR)).toBe(false);
  });

  it('el alias deprecado sigue valiendo lo de PROVEEDORES (no lo subió D-R1)', () => {
    expect(RESTO_TOLERADO).toBe(RESTO_TOLERADO_PROVEEDOR);
  });

  it('cierre-kepler re-exporta el MISMO primitivo (un solo lugar, ADR-056)', () => {
    expect(cierre.esRestoTolerado).toBe(esRestoTolerado);
    expect(cierre.esRestoDeFactura).toBe(esRestoDeFactura);
    expect(cierre.RESTO_TOLERADO_CLIENTE).toBe(RESTO_TOLERADO_CLIENTE);
    expect(cierre.RESTO_TOLERADO_PROVEEDOR).toBe(RESTO_TOLERADO_PROVEEDOR);
  });
});
