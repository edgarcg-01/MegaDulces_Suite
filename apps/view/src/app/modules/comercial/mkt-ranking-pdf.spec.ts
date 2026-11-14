import { vi } from 'vitest';
import type { RankingSemana } from './mkt-ranking.service';

/**
 * `[MKT.16]`–`[MKT.18]` CANDADO del PDF del ranking. Corre el dibujo REAL (jsPDF + autoTable) y lee
 * lo que se escribió: el reporte reemplaza al Excel impreso, así que si no trae una sección o
 * presenta un número a medias como completo, se toma una decisión con papel falso.
 */
const tablas: Array<{ head?: string[][]; body?: string[][] }> = [];
const textos: string[] = [];

vi.mock('../compras/compras-pdf-comun', async (original) => {
  const real = await original<typeof import('../compras/compras-pdf-comun')>();
  return {
    ...real,
    loadLogo: async () => null,
    loadLibs: async () => {
      const { jsPDF, autoTable } = await real.loadLibs();
      class Espia extends (jsPDF as unknown as new (...a: unknown[]) => Record<string, (...a: unknown[]) => unknown>) {
        constructor(...a: unknown[]) {
          super(...a);
          const text = this['text'].bind(this);
          this['text'] = (t: unknown, ...rest: unknown[]) => {
            textos.push(Array.isArray(t) ? t.join(' ') : String(t));
            return text(t, ...rest);
          };
        }
      }
      return {
        jsPDF: Espia as unknown as typeof jsPDF,
        autoTable: (doc: unknown, o: Record<string, unknown>) => { tablas.push(o as never); autoTable(doc as never, o as never); },
      };
    },
  };
});

const renglon = {
  promo_id: 'a', code: 'DM001', mecanica: '3 leches = gratis 1', objetivo: 10, objetivo_fuente: 'dinamico' as const,
  venta: 9, cubrimiento: 0.9, existencia: 4, descripcion_distinta: false,
  productos: [{ sku: 'DM201', nombre: 'LECHE ENTERA LT /12', unidades: 24, cajas: 2 }],
  productos_metodo: 'ticket_y_nombre' as const, productos_nota: '',
};

const mostrador: RankingSemana = {
  semana: { lunes: '2026-11-02', domingo: '2026-11-08', numero: 45, hasta: '2026-11-08', en_curso: false },
  canal: 'mostrador', canal_texto: 'Sucursales', promos_vigentes: 1, promedio_general: 0.9,
  promos_lista: [{ id: 'a', code: 'DM001', mecanica: '3 leches = gratis 1', proveedor_id: null }], promo_filtrada: null,
  proveedores_lista: [], proveedor_filtrado: null,
  participantes: [{
    clave: '01|', warehouse_code: '01', warehouse_name: 'Padre Hidalgo', vendor_code: '', nombre: 'Padre Hidalgo',
    lugar: 1, puntaje: 0.9, con_objetivo: 1, sin_objetivo: 0, cumplidas: 0, sin_venta: 0, promos: [renglon],
  }],
  promos_ranking: [{
    promo_id: 'a', code: 'DM001', nombre: '3 leches = gratis 1', proveedor: { id: 'p1', code: 'CD015', name: 'DULCES DEMO SA' }, proveedor_fuente: 'asignado',
    productos: ['LECHE ENTERA LT /12'], productos_metodo: 'ticket_y_nombre',
    participantes: 2, venta_total: 18, objetivo_total: 20, lugar: 1, puntaje: 0.9, con_objetivo: 2, sin_objetivo: 0, cumplidas: 1, sin_venta: 0,
  }],
  vendedoras: {
    tickets_con_promo: 10, tickets_con_vendedora: 4,
    personas: [{ lugar: 1, warehouse_code: '01', warehouse_name: 'Padre Hidalgo', person_code: '901', nombre: 'VENDEDORA DEMO A', tickets: 3, aplicaciones: 7,
      promos: [{ code: 'DM001', mecanica: '3 leches = gratis 1', cantidad: 7 }] }],
    por_sucursal: [{ warehouse_code: '01', tickets_con_promo: 6, tickets_con_vendedora: 4 }, { warehouse_code: '04', tickets_con_promo: 4, tickets_con_vendedora: 0 }],
  },
  criterio: '', consultado_at: '2026-11-11T18:00:00Z',
};

describe('[MKT.16–18] PDF del ranking (dibujo real)', () => {
  beforeEach(() => { tablas.length = 0; textos.length = 0; });

  it('trae las 4 tablas de mostrador: lugares, por promoción, por vendedora y el detalle', async () => {
    const { pdfRanking } = await import('./mkt-ranking-pdf');
    const { blob, archivo } = await pdfRanking({ semana: mostrador.semana, rankings: [mostrador], elaboro: 'prueba', consultado: new Date() });
    expect(blob.size).toBeGreaterThan(1000);
    expect(archivo).toMatch(/^RANKING-PROMOCIONES-S45-/);
    expect(tablas.map((t) => t.head?.[0]?.[1])).toEqual(['Sucursal', 'Promoción', 'Vendedora', 'Promoción']);
  });

  it('⭐ por vendedora DICE cuánto está atribuido y dónde no hay captura (no es la venta completa)', async () => {
    const { pdfRanking } = await import('./mkt-ranking-pdf');
    await pdfRanking({ semana: mostrador.semana, rankings: [mostrador], elaboro: 'prueba', consultado: new Date() });
    const todo = textos.join(' ');
    expect(todo).toContain('4 de 10 tickets con promoción tienen vendedora (40 %)');
    expect(todo).toContain('Sin captura: Yurécuaro');
  });

  it('el objetivo dinámico va marcado y la nota dice que el reporte no aplica los filtros', async () => {
    const { pdfRanking } = await import('./mkt-ranking-pdf');
    await pdfRanking({ semana: mostrador.semana, rankings: [mostrador], elaboro: 'prueba', consultado: new Date() });
    const detalle = tablas[3].body ?? [];
    expect(detalle[0][2]).toContain('(dinámico)');
    expect(textos.join(' ')).toContain('no aplica los filtros de la pantalla');
  });

  it('[MKT.24] cada promoción dice su proveedor; sin asignar, lo dice (no lo deja en blanco)', async () => {
    const { filasPromociones } = await import('./mkt-ranking-pdf');
    expect(filasPromociones(mostrador)[0][1]).toContain('Proveedor: CD015 · DULCES DEMO SA');
    const sin = { ...mostrador, promos_ranking: [{ ...mostrador.promos_ranking[0], proveedor: null }] };
    expect(filasPromociones(sin)[0][1]).toContain('Proveedor: sin asignar');
  });

  it('fuera de mostrador no hay sección por vendedora', async () => {
    const { pdfRanking } = await import('./mkt-ranking-pdf');
    await pdfRanking({ semana: mostrador.semana, rankings: [{ ...mostrador, canal: 'ruta', vendedoras: null }], elaboro: 'prueba', consultado: new Date() });
    expect(tablas.map((t) => t.head?.[0]?.[1])).not.toContain('Vendedora');
  });
it('[MKT.21] filtrado: la portada dice que NO es el ranking completo y con qué filtros; el archivo lo lleva en el nombre', async () => {
    const { pdfRanking } = await import('./mkt-ranking-pdf');
    const { archivo } = await pdfRanking({ semana: mostrador.semana, rankings: [mostrador], elaboro: 'prueba', consultado: new Date(),
      filtros: ['Canal: Sucursales (mostrador)', 'Sucursal: Padre Hidalgo'] });
    const todo = textos.join(' ');
    expect(archivo).toMatch(/^RANKING-PROMOCIONES-S45-FILTRADO-/);
    expect(todo).toContain('Reporte filtrado: no es el ranking completo.');
    expect(todo).toContain('Sucursal: Padre Hidalgo');
    expect(todo).toContain('promedio general de la semana completa');
    expect(todo).not.toContain('Es el reporte completo de la semana');
  });

  it('sin filtros sigue siendo el reporte completo (control)', async () => {
    const { pdfRanking } = await import('./mkt-ranking-pdf');
    const { archivo } = await pdfRanking({ semana: mostrador.semana, rankings: [mostrador], elaboro: 'prueba', consultado: new Date(), filtros: [] });
    expect(archivo).not.toContain('FILTRADO');
    expect(textos.join(' ')).not.toContain('Reporte filtrado');
  });
});

