import type { ExpedienteNotasLados } from '@megadulces/contracts';
import { notasLadosTexto } from './receipt-verdict';

/**
 * `[RE.63]` El texto del bloque «Notas de crédito · Kepler y CFDI». Montos sintéticos (el repo es público).
 * Lo que se prueba es que cada estado diga DÓNDE está la rebaja y si CAMBIA lo que se paga, y que nunca
 * mande a aplicar en Kepler una nota que ya está descontada en la entrada.
 */
const base = (p: Partial<ExpedienteNotasLados>): ExpedienteNotasLados => ({
  estado: 'ninguna', kepler: [], cfdi: [], kepler_total: 0, cfdi_total: 0, diferencia: null, compartida: false,
  neto_kepler: 100000, neto_cfdi: 100000, dif_neta: 0, netos_cuadran: true, ...p,
});

describe('[RE.63] notasLadosTexto', () => {
  it('sólo Kepler con la factura completa: lo dice y manda a pedir el CFDI', () => {
    const t = notasLadosTexto(base({ estado: 'solo_kepler', kepler_total: 9000, neto_kepler: 91000, neto_cfdi: 100000, dif_neta: 9000, netos_cuadran: false }));
    expect(t.titulo).toMatch(/^Sólo en Kepler/);
    expect(t.consecuencia).toMatch(/factura neto \$9,000\.00 más .* pedirle el CFDI/);
    expect(t.icono).toBe('pi-exclamation-triangle');
  });
  it('sólo CFDI con la entrada completa: Kepler pagaría de más → aplicarla en Kepler', () => {
    const t = notasLadosTexto(base({ estado: 'solo_cfdi', cfdi_total: 5000, neto_kepler: 100000, neto_cfdi: 95000, dif_neta: -5000, netos_cuadran: false }));
    expect(t.titulo).toMatch(/^Sólo en el CFDI/);
    expect(t.consecuencia).toMatch(/Kepler pagaría \$5,000\.00 más .* aplicar la nota en Kepler/);
  });
  it('NEGATIVA (el caso de prod): sólo CFDI con la entrada YA con el descuento NO manda a aplicarla', () => {
    const t = notasLadosTexto(base({ estado: 'solo_cfdi', cfdi_total: 5000, neto_kepler: 95000, neto_cfdi: 95000, dif_neta: 0, netos_cuadran: true }));
    expect(t.consecuencia).toMatch(/No cambia lo que se paga.*la descontaría dos veces/);
    expect(t.consecuencia).not.toMatch(/hay que aplicar/);
  });
  it('las dos con el mismo monto y netos que cuadran', () => {
    const t = notasLadosTexto(base({ estado: 'ambas', kepler_total: 1000, cfdi_total: 1000.5, diferencia: 0.5 }));
    expect(t.titulo).toMatch(/por el mismo monto/);
    expect(t.icono).toBe('pi-check');
  });
  it('las dos con montos distintos dicen los dos montos', () => {
    const t = notasLadosTexto(base({ estado: 'ambas', kepler_total: 900, cfdi_total: 1170, diferencia: 270, neto_cfdi: 99830, neto_kepler: 99100, dif_neta: 730, netos_cuadran: false }));
    expect(t.titulo).toMatch(/montos distintos: Kepler \$900\.00, CFDI \$1,170\.00/);
    expect(t.consecuencia).toMatch(/factura neto \$730\.00 más/);
    expect(t.consecuencia).not.toMatch(/pedirle/);
  });
  it('NEGATIVA: con una nota compartida no se afirma la consecuencia al peso', () => {
    const t = notasLadosTexto(base({ estado: 'solo_cfdi', compartida: true, neto_cfdi: null, dif_neta: null, netos_cuadran: null }));
    expect(t.consecuencia).toMatch(/relaciona también otras facturas/);
  });
  it('sin factura ligada: dice lo que aplicó Kepler y no inventa consecuencia', () => {
    const t = notasLadosTexto(base({ estado: 'cfdi_no_medido', cfdi: null, kepler_total: 900, cfdi_total: null, neto_cfdi: null, dif_neta: null, netos_cuadran: null }));
    expect(t.titulo).toMatch(/Kepler aplicó \$900\.00/);
    expect(t.consecuencia).toBeNull();
  });
});
