import { RESTO_TOLERADO_CLIENTE, RESTO_TOLERADO_PROVEEDOR } from '@megadulces/contracts';
import { REFERENCIA_MAX, armarAjusteAbono, type FacturaConResto } from './ajuste-abono.armador';

/**
 * `[GP.R.2]` Las pruebas del armador del Ajuste Abono. Cada guarda tiene su **prueba negativa**: si alguien la
 * quita, una de éstas se pone roja (regla 12). El caso feliz usa el resto REAL con el que se corrió el ensayo
 * contra el Kepler vivo el 2026-11-24 (factura `8-1-0000470`, $7.20 de $1,589.12).
 */
const base = { sucursal: '08', cliente: 'C2043', referencia: 'RC-mwvbdcvn', fecha: '2026-11-25', hora: '10:30' };
const f = (over: Partial<FacturaConResto> = {}): FacturaConResto =>
  ({ tipo: 8, serie: 1, folio: '0000470', importe: 1589.12, saldo: 7.20, ...over });

describe('[GP.R.2] el armador del Ajuste Abono U-A-30', () => {
  it('arma el plan del caso que el ensayo ejerció contra Kepler', () => {
    const r = armarAjusteAbono({ ...base, facturas: [f()] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.valor.total).toBe(7.2);
    expect(r.valor.facturas).toBe(1);
    expect(r.valor.kdm1).toEqual({
      c9: '2026-11-25', c68: '2026-11-25', c69: '10:30', c10: 'C2043', c11: 'RC-mwvbdcvn',
      c16: 7.2, c42: 7.2, c43: 'N', c67: 'SUITE',
    });
    expect(r.valor.kdue).toEqual({ c2: 'C2043', c7: '2026-11-25', c11: 7.2, c16: 'RC-mwvbdcvn', c17: 7.2, c29: 'A' });
    expect(r.valor.kdm5).toEqual([{ c7: 1, c8: 'D', c9: 8, c10: 1, c11: '0000470', c12: 7.2, c13: 7.2, c14: 'RC-mwvbdcvn' }]);
  });

  it('UN documento cierra VARIAS facturas, numeradas y sumadas al centavo', () => {
    const r = armarAjusteAbono({ ...base, facturas: [f(), f({ folio: '0000543', importe: 19421.55, saldo: 0.86 })] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.valor.total).toBe(8.06);          // 7.20 + 0.86, sin arrastrar flotante
    expect(r.valor.kdm5.map((x) => x.c7)).toEqual([1, 2]);
    expect(r.valor.kdm1.c16).toBe(8.06);
  });


  /** ⛔ Sin fecha propia el documento nace con la de la PLANTILLA: los 67 Ajustes Abono vivos son de sep/oct-2026 y
   *  nov-2025, meses contablemente cerrados. Medido en el ODS el 2026-11-25. */
  it('negativo: sin una fecha YYYY-MM-DD el ajuste caeria en el mes de la plantilla', () => {
    for (const fecha of ['', '25/11/2026', '2026-11', 'hoy']) {
      const r = armarAjusteAbono({ ...base, fecha, facturas: [f()] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivo).toContain('mes de la plantilla');
    }
    expect(armarAjusteAbono({ ...base, fecha: '2026-11-25', facturas: [f()] }).ok).toBe(true);   // el control
  });

  it('negativo: la hora va como la guarda Kepler en kdm1.c69 (HH:MM)', () => {
    expect(armarAjusteAbono({ ...base, hora: '', facturas: [f()] }).ok).toBe(false);
    expect(armarAjusteAbono({ ...base, hora: '10:30:00', facturas: [f()] }).ok).toBe(false);
    expect(armarAjusteAbono({ ...base, hora: '10:30', facturas: [f()] }).ok).toBe(true);        // el control
  });
  it('⬜ lo que no se midió se DECLARA, no se dibuja como cero', () => {
    const r = armarAjusteAbono({ ...base, facturas: [f()] });
    if (!r.ok) throw new Error('debía armar');
    expect(r.valor.acumulados).toBe('no_medido');
  });

  it('negativo: una factura que NUNCA tuvo cobro no es resto, aunque deba centavos', () => {
    const r = armarAjusteAbono({ ...base, facturas: [f({ importe: 0.08, saldo: 0.08 })] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain('nunca recibió un cobro');
  });

  it('negativo: más del tope es deuda, no redondeo', () => {
    const r = armarAjusteAbono({ ...base, facturas: [f({ saldo: 10.01 })] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain('es deuda, no redondeo');
  });

  it('negativo: una factura ya saldada no tiene resto que cerrar', () => {
    const r = armarAjusteAbono({ ...base, facturas: [f({ saldo: 0.004 })] });
    expect(r.ok).toBe(false);
  });

  it('negativo: la misma factura dos veces aplicaría su resto doble', () => {
    const r = armarAjusteAbono({ ...base, facturas: [f(), f()] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain('dos veces');
  });

  /** ⛔ La que el ensayo encontró escribiendo: `kdm1.c11` es `varchar(20)`. */
  it('negativo: una referencia de más de 20 caracteres no cabe en kdm1.c11', () => {
    const larga = 'ENSAYO-RC-1764035000000';
    expect(larga.length).toBeGreaterThan(REFERENCIA_MAX);
    const r = armarAjusteAbono({ ...base, referencia: larga, facturas: [f()] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain('admite 20');
  });

  it('negativo: sin referencia no hay idempotencia, y sin facturas no hay ajuste', () => {
    expect(armarAjusteAbono({ ...base, referencia: '  ', facturas: [f()] }).ok).toBe(false);
    expect(armarAjusteAbono({ ...base, facturas: [] }).ok).toBe(false);
  });

  it('negativo: sucursal que no es de dos dígitos, y cliente vacío', () => {
    expect(armarAjusteAbono({ ...base, sucursal: '8', facturas: [f()] }).ok).toBe(false);
    expect(armarAjusteAbono({ ...base, cliente: '', facturas: [f()] }).ok).toBe(false);
  });

  it('negativo: sin importe o saldo confiable NO se afirma que sea un resto', () => {
    expect(armarAjusteAbono({ ...base, facturas: [f({ importe: Number.NaN })] }).ok).toBe(false);
    expect(armarAjusteAbono({ ...base, facturas: [f({ saldo: Number.NaN })] }).ok).toBe(false);
  });

  /** El tope por omisión es D-R1 ($10 clientes), NO el de proveedores ($1). Si alguien los vuelve a atar, truena. */
  it('el tope por omisión es el de CLIENTES, no el de proveedores', () => {
    expect(RESTO_TOLERADO_CLIENTE).toBe(10);
    expect(RESTO_TOLERADO_PROVEEDOR).toBe(1);
    const cinco = armarAjusteAbono({ ...base, facturas: [f({ saldo: 5 })] });
    expect(cinco.ok).toBe(true);                                                   // $5 sí es resto de cliente
    expect(armarAjusteAbono({ ...base, facturas: [f({ saldo: 5 })], tope: RESTO_TOLERADO_PROVEEDOR }).ok).toBe(false);
  });
});
