import { vi } from 'vitest';
import type { MiPedidoPdfDatos, MiPedidoPdfRenglon } from './mi-pedido-pdf';

/**
 * `[AB.21]` CANDADO del PDF de «Mi pedido». Corre el dibujo REAL (jsPDF + autoTable) y lee lo que
 * se escribió: si el papel que se lleva a Kepler dice otra cosa que la pantalla, se capturan
 * cantidades equivocadas.
 */
const tablas: Record<string, unknown>[] = [];
const textos: string[] = [];
let guardado: string | null = null;

vi.mock('../compras/compras-pdf-comun', async (original) => {
  const real = await original<typeof import('../compras/compras-pdf-comun')>();
  return {
    ...real,
    loadLogo: async () => null,
    loadLibs: async () => {
      const { jsPDF, autoTable } = await real.loadLibs();
      // jsPDF arma `text` y `save` en cada INSTANCIA (no en el prototipo): se envuelven al construir.
      class Espia extends (jsPDF as unknown as new (...a: unknown[]) => Record<string, (...a: unknown[]) => unknown>) {
        constructor(...a: unknown[]) {
          super(...a);
          const text = this['text'].bind(this);
          this['text'] = (t: unknown, ...rest: unknown[]) => {
            textos.push(Array.isArray(t) ? t.join(' ') : String(t));
            return text(t, ...rest);
          };
          this['save'] = (n: unknown) => { guardado = String(n); return this; };
        }
      }
      return {
        jsPDF: Espia as unknown as typeof jsPDF,
        autoTable: (doc: unknown, o: Record<string, unknown>) => { tablas.push(o); autoTable(doc as never, o); },
      };
    },
  };
});

const r = (sku: string, cantidad: number, unidad: string, valor: number | null, nota = ''): MiPedidoPdfRenglon =>
  ({ sku, nombre: `PRODUCTO ${sku}`, cantidad, unidad, existencia: 1.5, venta_30d: 4, valor, nota });

const base = (): MiPedidoPdfDatos => ({
  almacen: { code: '02', name: 'La Piedad' },
  fecha_mx: '2026-10-13', hora_mx: '09:30', elaboro: 'luis_espino',
  posiciones: ['Agotado', 'Bajo mínimo'],
  grupos: [
    { tipo: 'matriz', origen: '01 · Padre Hidalgo', aviso: null, listas: [
      { clase: 'mayor', renglones: [r('70012', 3, 'CJA', 900), r('17085', 2, 'CJA', null)] },
      { clase: 'menor', renglones: [r('20021', 6, 'PZA', 240, 'Agotado: se pide aunque sea poco')] },
      { clase: 'unica', renglones: [] },
      { clase: 'sin_unidad', renglones: [] },
    ] },
    { tipo: 'proveedor', origen: 'CUERITOS LUPITA', aviso: 'El proveedor pide un mínimo de $27,514; este pedido lleva $20,280.', listas: [
      { clase: 'mayor', renglones: [r('59108', 10, 'CJA', 20280)] },
      { clase: 'menor', renglones: [] }, { clase: 'unica', renglones: [] }, { clase: 'sin_unidad', renglones: [] },
    ] },
  ],
});

const celdas = (o: Record<string, unknown>) => (o['body'] as unknown[][]).map((f) => f.map(String));
const encabezado = (o: Record<string, unknown>) => JSON.stringify(o['head']);

describe('[AB.21] PDF de Mi pedido', () => {
  beforeEach(() => { tablas.length = 0; textos.length = 0; guardado = null; });

  it('un origen por hoja: título según el origen y una tabla por lista con renglones', async () => {
    const { descargarPdfMiPedido } = await import('./mi-pedido-pdf');
    const archivo = await descargarPdfMiPedido(base());
    expect(archivo).toBe('PEDIDO-02-TODOS-2026-10-13-09-30.pdf');
    expect(guardado).toBe(archivo);
    expect(textos).toContain('Pedido de traspaso entre sucursales');
    expect(textos).toContain('Requisición de compra a proveedor');
    // matriz: mayor + menor (única y sin unidad vacías no se dibujan); proveedor: mayor.
    expect(tablas).toHaveLength(3);
    expect(encabezado(tablas[0])).toContain('ORDEN DE UNIDAD MAYOR');
    expect(encabezado(tablas[1])).toContain('ORDEN DE UNIDAD MENOR');
  });

  it('cantidad y unidad de captura tal cual; sin costo dice «sin medir», nunca $0', async () => {
    const { descargarPdfMiPedido } = await import('./mi-pedido-pdf');
    await descargarPdfMiPedido(base());
    const mayor = celdas(tablas[0]);
    // Orden de captura: SKU, Pedir, Unidad, Producto (Francisco, 2026-10-13).
    expect(mayor[0].slice(0, 4)).toEqual(['70012', '3', 'CJA', 'PRODUCTO 70012']);
    expect(mayor[1][6]).toBe('sin medir');
    // La última columna es el aviso del renglón, no un espacio en blanco; el producto va limpio.
    const menor = celdas(tablas[1])[0];
    expect(menor[3]).toBe('PRODUCTO 20021');
    expect(menor[7]).toBe('Agotado: se pide aunque sea poco');
  });

  it('a quién se le pide va tan visible como quién pide; las firmas cambian con el origen', async () => {
    const { descargarPdfMiPedido } = await import('./mi-pedido-pdf');
    await descargarPdfMiPedido(base());
    expect(encabezado(tablas[0])).toContain('Aviso');
    expect(encabezado(tablas[0])).not.toContain('Surtido');
    expect(textos).toContain('PIDE: 02 · La Piedad');
    expect(textos).toContain('A LA SUCURSAL: 01 · Padre Hidalgo');
    expect(textos).toContain('AL PROVEEDOR: CUERITOS LUPITA');
    expect(textos.some((t) => t.startsWith('Surtió (sucursal que abastece)'))).toBe(true);
    expect(textos.some((t) => t.startsWith('Autorizó (Compras)'))).toBe(true);
    expect(textos).toContain('El proveedor pide un mínimo de $27,514; este pedido lleva $20,280.');
    expect(textos).toContain('Incluye: Agotado, Bajo mínimo'); // completo, no cortado en un recuadro
  });

  it('un solo origen nombra el archivo con el origen', async () => {
    const { descargarPdfMiPedido } = await import('./mi-pedido-pdf');
    const d = base();
    d.grupos = [d.grupos[1]];
    expect(await descargarPdfMiPedido(d)).toBe('PEDIDO-02-CUERITOS-LUPITA-2026-10-13-09-30.pdf');
  });

  it('⛔ sin nada que pedir no genera un PDF vacío', async () => {
    const { descargarPdfMiPedido } = await import('./mi-pedido-pdf');
    const d = base();
    d.grupos.forEach((g) => g.listas.forEach((l) => { l.renglones = []; }));
    expect(await descargarPdfMiPedido(d)).toBeNull();
    expect(guardado).toBeNull();
  });
});
