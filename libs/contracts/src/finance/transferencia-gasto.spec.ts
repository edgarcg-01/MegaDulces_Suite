import { resumenTransferencias, type TransferenciaGasto } from './transferencia-gasto.contract';

/**
 * `[GX.75]` El resumen de transferencias del vale. Las formas de que mienta, cada una con su caso:
 * sumar una cancelada como pagado, decir «sin transferencias» cuando no se midió, y tomar como
 * «última» una fecha de una transferencia cancelada.
 */
const t = (o: Partial<TransferenciaGasto>): TransferenciaGasto => ({
  gasto_folio: '0008602', folio: '0019001', fecha: '2026-09-05', importe: 1000, aplicado: 1000, cancelada: false, ...o,
});

describe('resumenTransferencias', () => {
  it('suma lo aplicado de las vigentes y da la fecha más reciente', () => {
    const r = resumenTransferencias([
      t({ folio: '0019001', aplicado: 600.1, fecha: '2026-09-10' }),
      t({ folio: '0019002', aplicado: 399.9, fecha: '2026-09-05' }),
    ]);
    expect(r).toEqual({ medido: true, vigentes: 2, canceladas: 0, aplicado: 1000, ultima_fecha: '2026-09-10' });
  });

  it('⛔ una transferencia cancelada NO cuenta como pagado ni como la última', () => {
    const r = resumenTransferencias([
      t({ folio: '0019001', aplicado: 500, fecha: '2026-09-01' }),
      t({ folio: '0019002', aplicado: 500, fecha: '2026-09-20', cancelada: true }),
    ]);
    expect(r.aplicado).toBe(500);
    expect(r.vigentes).toBe(1);
    expect(r.canceladas).toBe(1);
    expect(r.ultima_fecha).toBe('2026-09-01');
  });

  it('⛔ null = no medido: no se convierte en «sin transferencias»', () => {
    expect(resumenTransferencias(null).medido).toBe(false);
    expect(resumenTransferencias(undefined).medido).toBe(false);
    const vacio = resumenTransferencias([]);
    expect(vacio.medido).toBe(true);
    expect(vacio.vigentes).toBe(0);
  });

  it('sin encabezado (fecha null) se cuenta pero no inventa fecha', () => {
    const r = resumenTransferencias([t({ fecha: null, aplicado: 250 })]);
    expect(r.aplicado).toBe(250);
    expect(r.ultima_fecha).toBeNull();
  });
});
