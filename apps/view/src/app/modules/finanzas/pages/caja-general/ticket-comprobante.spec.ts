/**
 * CS.3.8 — El cuerpo del comprobante es una función PURA (sin DOM), como `cuerpoTicket` del arqueo,
 * para probar que trae lo que operación pidió: folio nuestro, desglose, concepto, recibido, total y
 * espacio para firma — y que el signo cambia el encabezado y la etiqueta de "recibido".
 */
import { cuerpoComprobante, type ComprobanteCaja } from './ticket-comprobante';

const base = (o: Partial<ComprobanteCaja> = {}): ComprobanteCaja => ({
  folio: 'ING-2026-00042', tipo: 'ingreso', fecha: '25/09/2026', sucursal: '00',
  beneficiario: 'R.V. PH SALGADO MORALES MARIA CANDELARIA',
  kepler_cuenta: '115', kepler_concepto: '001', kepler_concepto_nombre: 'CLIENTES',
  glosa: 'Cobro de ruta 21', denominaciones: [{ denominacion: 500, piezas: 16 }, { denominacion: 100, piezas: 3 }],
  morralla: 0, monto: 8300, created_by_username: 'maria', created_at: '2026-09-25T10:00:00-06:00', ...o,
});

describe('cuerpoComprobante — lo que pidió operación', () => {
  it('trae folio nuestro, desglose, concepto, recibido, total y espacio de firma', () => {
    const t = cuerpoComprobante(base());
    expect(t).toContain('MEGA DULCES');
    expect(t).toContain('COMPROBANTE DE INGRESO');
    expect(t).toContain('#ING-2026-00042');          // folio NUESTRO
    expect(t).toContain('115 / 001');                 // concepto contable
    expect(t).toContain('CLIENTES');                  // nombre del concepto
    expect(t).toContain('Cobro de ruta 21');          // glosa
    expect(t).toContain('Recibido de');               // "recibido"
    expect(t).toMatch(/500 x\s+16 =/);                // desglose por denominación
    expect(t).toMatch(/100 x\s+3 =/);
    expect(t).toContain('TOTAL');
    expect(t).toContain('$8,300.00');                 // total
    expect(t).toContain('Recibi conforme');           // espacio de firma
    expect(t).toContain('_____');
    expect(t).toContain('Capturo');                   // quién capturó
  });

  it('el signo cambia el encabezado y la etiqueta de recibido', () => {
    expect(cuerpoComprobante(base({ tipo: 'gasto' }))).toContain('COMPROBANTE DE EGRESO');
    expect(cuerpoComprobante(base({ tipo: 'gasto' }))).toContain('Pagado a');
    expect(cuerpoComprobante(base({ tipo: 'deposito' }))).toContain('COMPROBANTE DE DEPOSITO');
    expect(cuerpoComprobante(base({ tipo: 'deposito' }))).toContain('Depositado por');
  });

  it('la morralla sale sólo si es > 0', () => {
    expect(cuerpoComprobante(base({ morralla: 0 }))).not.toContain('Morralla');
    expect(cuerpoComprobante(base({ morralla: 12.5 }))).toContain('Morralla');
  });

  it('las denominaciones se imprimen de mayor a menor sin importar el orden de entrada', () => {
    const t = cuerpoComprobante(base({ denominaciones: [{ denominacion: 20, piezas: 1 }, { denominacion: 500, piezas: 2 }] }));
    expect(t.indexOf('500 x')).toBeLessThan(t.indexOf('20 x'));   // 500 antes que 20
  });

  it('sin acentos ni × en el cuerpo (térmicas de 203 dpi los imprimen como basura)', () => {
    const t = cuerpoComprobante(base());
    expect(t).not.toMatch(/×/);
    // "Recibi"/"Capturo" van sin acento a propósito.
    expect(t).not.toContain('Recibí');
    expect(t).not.toContain('Capturó');
  });
});
