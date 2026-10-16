import type { RespuestaHistoriaPrecio } from '@megadulces/contracts';
import { graficaPrecio, serieHistoria } from './precios-historia.util';

/** El ejemplo de Compras: 19 el 10-oct, 18 el 14-oct, 20 el 16-oct. */
const r = (over: Partial<RespuestaHistoriaPrecio> = {}): RespuestaHistoriaPrecio => ({
  sku: '70001', nombre: 'MAZAPAN DE LA ROSA', sucursal: { codigo: '03', nombre: '8 Esquinas' }, unidad: 'PZA',
  precio_actual: 20,
  cambios: [
    { fecha: '2026-10-16', hora: null, anterior: 18, nuevo: 20, ajuste_pct: 11.11, es_baja: false },
    { fecha: '2026-10-14', hora: null, anterior: 19, nuevo: 18, ajuste_pct: -5.26, es_baja: false },
  ],
  bitacora_desde: '2024-10', meses_sin_registro: [],
  ...over,
});

describe('[CAT-PRECIO.4] historia de un precio', () => {
  it('arranca con el precio que regía antes del primer cambio y sigue en orden', () => {
    expect(serieHistoria(r(), '2026-10-16')).toEqual([
      { fecha: '2026-10-14', precio: 19 },
      { fecha: '2026-10-14', precio: 18 },
      { fecha: '2026-10-16', precio: 20 },
    ]);
  });

  it('termina hoy con el precio vigente', () => {
    const s = serieHistoria(r(), '2026-10-20');
    expect(s[s.length - 1]).toEqual({ fecha: '2026-10-20', precio: 20 });
  });

  it('sin cambios en la bitácora, sólo el precio de hoy: no hay escalera que dibujar', () => {
    const s = serieHistoria(r({ cambios: [] }), '2026-10-20');
    expect(s).toEqual([{ fecha: '2026-10-20', precio: 20 }]);
    expect(graficaPrecio(s).d).toBe('');
  });

  it('NEGATIVA: es una escalera (H y V), nunca una diagonal', () => {
    const g = graficaPrecio(serieHistoria(r(), '2026-10-20'));
    expect(g.d).toMatch(/^M[\d.]+,[\d.]+( H[\d.]+ V[\d.]+)+$/);
    expect(g.min).toBe(18);
    expect(g.max).toBe(20);
  });
});
