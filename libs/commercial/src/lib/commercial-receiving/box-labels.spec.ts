import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { armarDefectos, armarOrdenes, type FilaBitacora, type FilaVista } from './box-labels';
import { elegir } from './box-labels.service';

/** El espécimen (Suc 08, orden 0000474), medido en prod el 2026-11-19. */
const FILA: FilaVista = {
  sucursal: '08', sucursal_nombre: 'Sucursal Morelia Abastos', serie: 1, folio: '0000474', linea: 1,
  sku: '70106', nombre: 'LA ROSA BOTA GRANDE 418GR', unidad: 'CJA', unidad_base: 'PZA',
  uxc: 18, cajas: 20, cajas_completas: 20, piezas_sueltas: 0, codigo: 'C70106',
  kepler_unidad_caja: 'CJA', kepler_factor_caja: 18, kepler_codigo_caja: 'C70106', sin_catalogo: false,
  capturada_el: '2026-11-05', capturada_hora: '13:11', fecha_documento: '2026-11-03', vale_folio: '0000487', vale_capturado_el: '2026-11-04',
};

const reg = (p: Partial<FilaBitacora>): FilaBitacora => ({
  sucursal: '08', serie: 1, folio: '0000474', linea: 1, motivo: 'primera', consecutivos: [1],
  fecha_etiqueta: '308-26', enviada_at: '2026-11-05T19:20:00Z', enviada_por: 'encargado08', ...p,
});

describe('[RE.ETQ.2.1] armarOrdenes', () => {
  it('sin bitácora: por etiquetar, 20 etiquetas', () => {
    const [o] = armarOrdenes([FILA], []);
    expect(o).toMatchObject({ folio: '0000474', estado: 'por_etiquetar', etiquetas_total: 20, etiquetas_enviadas: 0, vale_capturado_el: '2026-11-04' });
    expect(o.renglones[0]).toMatchObject({ total_etiquetas: 20, enviadas: 0, primera: null, reimpresiones: 0, avisos: [] });
  });

  it('enviadas = consecutivos DISTINTOS: reimprimir la 7 no cuenta dos veces', () => {
    const b = [reg({ consecutivos: Array.from({ length: 20 }, (_, i) => i + 1) }), reg({ motivo: 'reimpresion', consecutivos: [7], fecha_etiqueta: '308-26' })];
    const [o] = armarOrdenes([FILA], b);
    expect(o.estado).toBe('enviada');
    expect(o.renglones[0]).toMatchObject({ enviadas: 20, reimpresiones: 1, primera: { fecha_etiqueta: '308-26', usuario: 'encargado08' } });
  });

  it('parcial cuando falta alguna', () => {
    const [o] = armarOrdenes([FILA], [reg({ consecutivos: [1, 2, 3] })]);
    expect(o).toMatchObject({ estado: 'parcial', etiquetas_enviadas: 3 });
  });

  it('un consecutivo fuera de rango (Kepler bajó la cantidad) no infla lo enviado', () => {
    const [o] = armarOrdenes([{ ...FILA, cajas: 2, cajas_completas: 2 }], [reg({ consecutivos: [1, 2, 3, 4] })]);
    expect(o).toMatchObject({ etiquetas_total: 2, etiquetas_enviadas: 2, estado: 'enviada' });
  });

  it('agrupa por orden y ordena la más reciente primero', () => {
    const otra = { ...FILA, folio: '0000480', capturada_el: '2026-11-06', linea: 1 };
    const segunda = { ...FILA, linea: 2, sku: '70107', codigo: 'C70107' };
    const out = armarOrdenes([FILA, otra, segunda], []);
    expect(out.map((o) => o.folio)).toEqual(['0000480', '0000474']);
    expect(out[1].renglones.map((r) => r.linea)).toEqual([1, 2]);
    expect(out[1].etiquetas_total).toBe(40);
  });

  it('la bitácora de otra sucursal con el mismo folio no se mezcla (el folio se repite por sucursal)', () => {
    const [o] = armarOrdenes([FILA], [reg({ sucursal: '01', consecutivos: [1, 2, 3] })]);
    expect(o.etiquetas_enviadas).toBe(0);
  });
});

describe('[RE.ETQ.2.2] armarDefectos', () => {
  it('sólo productos con defecto del catálogo; la caja incompleta no es defecto del catálogo', () => {
    const incompleta = { ...FILA, cajas: 0.5, cajas_completas: 0, piezas_sueltas: 9 };
    const sinC85 = { ...FILA, sku: '40045', codigo: 'C40045', kepler_codigo_caja: null, kepler_factor_caja: 0 };
    const out = armarDefectos([FILA, incompleta, sinC85, { ...sinC85, linea: 2, capturada_el: '2026-11-07' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sku: '40045', renglones: 2, ultima_captura: '2026-11-07' });
    expect(out[0].defectos).toEqual(['kepler_no_lee_codigo', 'catalogo_factor_0']);
  });
});

describe('elegir consecutivos', () => {
  it('sin pedido: todos', () => {
    expect(elegir(undefined, 3)).toEqual([1, 2, 3]);
  });
  it('filtra y ordena', () => {
    expect(elegir([3, 1, 3, 9], 3)).toEqual([1, 3]);
  });
  it('⛔ ninguno en rango → 400', () => {
    expect(() => elegir([9], 3)).toThrow(BadRequestException);
  });
  it('⛔ renglón sin cajas → 400', () => {
    expect(() => elegir(undefined, 0)).toThrow(BadRequestException);
  });
});
