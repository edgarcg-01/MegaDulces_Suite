import type { PriceChangeNoticeDto } from '@megadulces/contracts';
import { avisoDePrecio } from './aviso-precio';

/** `[ETQ-AVISOS.2]` Lo que lee la encargada en la campana. */
const AHORA = new Date('2026-10-09T18:00:00Z'); // 12:00 en México: hoy = 2026-10-09
const aviso = (extra: Partial<PriceChangeNoticeDto> = {}): PriceChangeNoticeDto => ({
  id: 'a', plaza: '01', plaza_nombre: 'Padre Hidalgo', fecha: '2026-10-08', corte: 'manana', origen: 'auto',
  productos: 47, suben: 30, bajan: 15, sin_precio: 2, nota: null, enviado_por: null, created_at: '2026-10-09T13:30:00Z', ...extra,
});

describe('avisoDePrecio', () => {
  it('⭐ el aviso automático dice la tienda, cuántos productos, qué día y a dónde ir', () => {
    const a = avisoDePrecio(aviso(), AHORA);
    expect(a.title).toBe('Cambios de precio · Padre Hidalgo');
    expect(a.message).toBe('47 productos cambiaron de precio ayer (30 suben, 15 bajan, 2 sin precio). Revisa qué etiquetas reimprimir.');
    expect(a.route).toBe('/tienda/etiquetas/cambios?plaza=01&fecha=2026-10-08');
  });

  it('el día se dice en palabras cuando es hoy o ayer, y con fecha cuando no', () => {
    expect(avisoDePrecio(aviso({ fecha: '2026-10-09', corte: 'tarde' }), AHORA).message).toContain('de precio hoy');
    expect(avisoDePrecio(aviso({ fecha: '2026-10-08' }), AHORA).message).toContain('de precio ayer');
    expect(avisoDePrecio(aviso({ fecha: '2026-10-02' }), AHORA).message).toContain('de precio el 2026-10-02');
  });

  it('singular y plural bien dichos, y sin mencionar lo que no hubo', () => {
    const a = avisoDePrecio(aviso({ productos: 1, suben: 1, bajan: 0, sin_precio: 0 }), AHORA);
    expect(a.message).toBe('1 producto cambió de precio ayer (1 sube). Revisa qué etiquetas reimprimir.');
  });

  it('⭐ «sin precio» sube la urgencia: esa etiqueta saldría en blanco', () => {
    expect(avisoDePrecio(aviso({ sin_precio: 2 }), AHORA).severity).toBe('warn');
    expect(avisoDePrecio(aviso({ sin_precio: 0, suben: 47, bajan: 0 }), AHORA).severity).toBe('info');
  });

  it('el aviso de Compras dice quién lo mandó y lleva su nota', () => {
    const a = avisoDePrecio(aviso({ origen: 'compras', corte: 'compras', enviado_por: 'Ana Compras', nota: 'Reimprime primero la caja' }), AHORA);
    expect(a.title).toBe('Compras te mandó los cambios de precio · Padre Hidalgo');
    expect(a.message).toBe('Ana Compras: 47 productos de ayer. «Reimprime primero la caja»');
  });

  it('sin nombre de tienda en el catálogo cae al código, no a «null»', () => {
    expect(avisoDePrecio(aviso({ plaza_nombre: null, plaza: '04' }), AHORA).title).toBe('Cambios de precio · Tienda 04');
  });

  it('⛔ el enlace no se deja romper por una plaza o fecha con caracteres raros', () => {
    const a = avisoDePrecio(aviso({ plaza: '0&1', fecha: '2026-10-08&x=1' }), AHORA);
    expect(a.route).toBe('/tienda/etiquetas/cambios?plaza=0%261&fecha=2026-10-08%26x%3D1');
  });
});
