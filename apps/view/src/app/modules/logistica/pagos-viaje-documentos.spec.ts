import type { SolicitudDePersona } from '@megadulces/contracts';
import { CSV_CABECERA, csvSolicitudes, nombreArchivo, textoDelCorte } from './pagos-viaje-documentos';

/**
 * `[EMB.47]` — El Excel de las solicitudes: lo que se procesa tiene que salir exacto (BOM, comillas,
 * punto decimal sin miles). El PDF no se prueba aquí: dibuja con jsPDF en el navegador.
 */
const CORTE = { desde: '2026-10-08', hasta: '2026-10-21', pago: '2026-10-23' };
const s = (o: Partial<SolicitudDePersona>): SolicitudDePersona => ({
  persona_id: 'd1', persona: 'CHOFER PRUEBA', roles: ['chofer'], operaciones: 2,
  por_concepto: { comision: 1250.5, viatico: 80, carga: 0 }, total: 1330.5,
  renglones: [
    { codigo: '054', nombre_concepto: 'COMISION ARRASTRE MERCANCIA', cuenta: '514-001', centro: null, sin_centro: 'varios_destinos',
      destino: 'YURECUARO · LA PIEDAD, ABASTOS', operaciones: 2, importe: 1250.5 },
    { codigo: '027', nombre_concepto: 'VIATICOS TRASPASO DE MERCANCIA', cuenta: '514-001', centro: { codigo: '1-01-44-00', nombre: 'YURECUARO PISO.' },
      sin_centro: null, destino: 'YURECUARO PISO.', operaciones: 1, importe: 80 },
  ],
  detalle: [], ...o,
});

describe('pagos-viaje-documentos', () => {
  it('CSV: BOM, cabecera, un renglón por concepto × destino × persona, comillas donde hay coma y montos con punto', () => {
    const csv = csvSolicitudes([s({}), s({ persona_id: 'c1', persona: 'CARGADOR "EL GÜERO"', renglones: [{ codigo: '054', nombre_concepto: 'X', cuenta: null, centro: null, sin_centro: null, destino: 'D', operaciones: 1, importe: 1234567.8 }] })]);
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    const lineas = csv.slice(1).split('\n');
    expect(lineas[0]).toBe(CSV_CABECERA.join(','));
    // [EMB.53] Como se captura el X-A-15: proveedor, beneficiario, cuenta, concepto, centro de costo.
    expect(lineas[1]).toBe('GNFC002,CHOFER PRUEBA,514-001,054,COMISION ARRASTRE MERCANCIA,,Varios destinos: se reparte al capturar,"YURECUARO · LA PIEDAD, ABASTOS",2,1250.50');
    expect(lineas[2]).toBe('GNFC002,CHOFER PRUEBA,514-001,027,VIATICOS TRASPASO DE MERCANCIA,1-01-44-00,YURECUARO PISO.,YURECUARO PISO.,1,80.00');
    expect(lineas[3]).toBe('GNFC002,"CARGADOR ""EL GÜERO""",,054,X,,,D,1,1234567.80');
    expect(lineas).toHaveLength(4);
  });

  it('PRUEBA NEGATIVA: sin solicitudes el CSV es sólo la cabecera (no un archivo vacío que parezca roto)', () => {
    expect(csvSolicitudes([]).slice(1)).toBe(CSV_CABECERA.join(','));
  });

  it('nombre del archivo: catorcena y, si es una sola persona, su nombre sin acentos', () => {
    expect(nombreArchivo(CORTE, 'csv')).toBe('pagos-logistica-2026-10-08-a-2026-10-21.csv');
    expect(nombreArchivo(CORTE, 'pdf', 'José Pérez')).toBe('pagos-logistica-JOSE-PEREZ-2026-10-08-a-2026-10-21.pdf');
  });

  it('el corte se dice en llano', () => {
    expect(textoDelCorte(CORTE)).toBe('Catorcena 08 oct a 21 oct · se paga el 23 oct');
  });
});
