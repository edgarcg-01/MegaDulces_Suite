import { CSV_CABECERA, csvPedidoProveedor, esc, nombreArchivoCsv } from './orden-proveedor-csv';
import type { OcProvData } from './orden-proveedor-pdf';

/**
 * `[OC.4]` El CSV del pedido consolidado. Lo que se prueba es lo que rompe a quien lo ABRE:
 * la codificación, el escapado y que las columnas no bailen entre un archivo y otro.
 */

const base = (filas: OcProvData['filas']): OcProvData => ({
  emitido: new Date(2026, 9, 19, 14, 30),
  elaboro: 'arizbeth_gonzalez',
  proveedor: { code: 'CD015', name: 'DISTRIBUIDORA DE LA ROSA' },
  ordenes: [{ folio: 'OC-2026-00412', warehouse_code: '00', expected_date: '2026-10-24' }],
  filas,
  totales: { cantidad: 0, pendiente: 0, importe: 0 },
});

const fila = (over: Partial<OcProvData['filas'][number]> = {}) => ({
  sku: '70001', nombre: 'LA ROSA MAZAPAN /30', cantidad: 66, pendiente: 66,
  unit_cost: 1330.37, importe: 87804.42, costo_varia: false, destinos: ['00'], folios: ['OC-2026-00412'],
  ...over,
});

describe('[OC.4] CSV del pedido a proveedor', () => {
  it('⭐ arranca con BOM: sin él Excel abre «MAZAPÁN» como «MAZAPÃN»', () => {
    expect(csvPedidoProveedor(base([fila()])).startsWith('﻿')).toBe(true);
  });

  it('la cabecera es fija y en el mismo orden que las filas', () => {
    const txt = csvPedidoProveedor(base([fila()]));
    const [cab, f1] = txt.replace('﻿', '').split('\n');
    expect(cab).toBe(CSV_CABECERA.join(','));
    expect(cab.split(',').length).toBe(f1.split(',').length);
  });

  it('⭐ la columna Falta va SIEMPRE, aunque no haya nada a medias', () => {
    // En el PDF se oculta porque repetiría la de al lado; acá no, porque un archivo que a veces
    // trae la columna y a veces no rompe a quien lo abre con una fórmula.
    const txt = csvPedidoProveedor(base([fila({ cantidad: 10, pendiente: 10 })]));
    expect(txt).toContain('Falta');
    expect(txt.replace('﻿', '').split('\n')[1]).toContain('10,10,');
  });

  it('⭐ lleva los FOLIOS por renglón: la liga que la consolidación borra', () => {
    const txt = csvPedidoProveedor(base([fila({ ordenes: 2, folios: ['OC-2026-00412', 'OC-2026-00418'] } as never)]));
    expect(txt).toContain('OC-2026-00412 OC-2026-00418');
    expect(txt.replace('﻿', '').split('\n')[1]).toMatch(/,2,/);  // el conteo sale de los folios
  });

  it('marca el costo que varía, en vez de publicar un precio que nadie cotizó', () => {
    expect(csvPedidoProveedor(base([fila({ costo_varia: true })]))).toMatch(/,SI,/);
    expect(csvPedidoProveedor(base([fila({ costo_varia: false })]))).not.toMatch(/,SI,/);
  });

  it('los números salen sin separador de miles: es un archivo para procesar', () => {
    const f1 = csvPedidoProveedor(base([fila({ importe: 87804.42 })])).replace('﻿', '').split('\n')[1];
    expect(f1).toContain('87804.42');
    expect(f1).not.toContain('87,804.42');
  });

  it('acepta el numeric como TEXTO, que es como llega de node-pg', () => {
    const f1 = csvPedidoProveedor(base([fila({ cantidad: '66.000', importe: '87804.4200' } as never)])).replace('﻿', '').split('\n')[1];
    expect(f1).toContain('66,66,');
    expect(f1).toContain('87804.42');
  });

  describe('escapado', () => {
    it('⭐ un nombre con coma NO parte la fila', () => {
      const txt = csvPedidoProveedor(base([fila({ nombre: 'MAZAPAN, CAJA 30' })]));
      const f1 = txt.replace('﻿', '').split('\n')[1];
      expect(f1).toContain('"MAZAPAN, CAJA 30"');
      expect(f1.split('","').length).toBe(1);
    });

    it('las comillas se doblan', () => {
      expect(esc('PALETA "GRANDE"')).toBe('"PALETA ""GRANDE"""');
    });

    it('un salto de línea queda dentro de comillas', () => {
      expect(esc('linea1\nlinea2')).toBe('"linea1\nlinea2"');
    });

    it('lo normal no se toca', () => {
      expect(esc('70001')).toBe('70001');
      expect(esc(null)).toBe('');
    });
  });

  it('sin filas devuelve sólo la cabecera, no un archivo roto', () => {
    expect(csvPedidoProveedor(base([]))).toBe('﻿' + CSV_CABECERA.join(','));
  });

  it('el nombre del archivo lleva proveedor y fecha, sin acentos', () => {
    const f = nombreArchivoCsv('DULCES MONTAÑÉS', new Date(2026, 9, 19, 14, 30));
    expect(f).toMatch(/^pedido-/);
    expect(f).toMatch(/\.csv$/);
    expect(f).not.toMatch(/[ÑÉñé]/);
  });
});
