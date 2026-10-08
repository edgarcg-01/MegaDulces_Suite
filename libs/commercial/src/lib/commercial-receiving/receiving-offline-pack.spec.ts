import { readFileSync } from 'fs';
import { join } from 'path';
import { claveDoc, docDeVale } from './receiving-session.service';

/**
 * `[WMS-REC.20]` — **El paquete sin red y abrir el vale arman los MISMOS renglones.**
 *
 * Es lo que permite trabajar un vale sin red y sincronizarlo después: cada captura tiene que caer
 * en el renglón que el servidor crea para su producto. Si el paquete y `open()` eligieran distinto
 * (otro producto para un SKU, otro filtro de servicios), la captura chocaría al sincronizar con
 * "El renglón corresponde a otro producto". Contra la base real lo prueba la prueba local; acá van
 * las reglas que se pueden romper sin base.
 */
const SESION = readFileSync(join(__dirname, 'receiving-session.service.ts'), 'utf8');
const CONTROLLER = readFileSync(join(__dirname, 'receiving-session.controller.ts'), 'utf8');

describe('[WMS-REC.20] la llave del documento', () => {
  it('una orden de entrada se llama como su source_ref: sucursal/folio', () => {
    expect(claveDoc({ tipo: 'compra', sucursal: '01', folio: '0000412' })).toBe('01/0000412');
  });

  it('un embarque se llama como su source_ref de traspaso, que no se confunde con una compra', () => {
    const k = claveDoc({ tipo: 'traspaso', sucursal: '00', serie: 2, folio: '0001048' });
    expect(k).toMatch(/^UD41\//);
    expect(k).toContain('0001048');
  });

  it('del menú al documento: en un embarque la sucursal es la que EMBARCA', () => {
    expect(docDeVale({ fuente: 'embarque', sucursal: '00', serie: 2, folio: '0001048' }))
      .toEqual({ tipo: 'traspaso', sucursal: '00', serie: 2, folio: '0001048' });
    expect(docDeVale({ fuente: 'orden_entrada', sucursal: '01', serie: null, folio: '0000412' }))
      .toEqual({ tipo: 'compra', sucursal: '01', folio: '0000412' });
    // Sin `fuente` (vales viejos del menú) es una orden de entrada.
    expect(docDeVale({ sucursal: '01', folio: '9' } as never)).toEqual({ tipo: 'compra', sucursal: '01', folio: '9' });
  });
});

describe('[WMS-REC.20] una sola función arma los renglones', () => {
  const abrir = SESION.slice(SESION.indexOf('private abrir('), SESION.indexOf('private async lineasEsperadas('));
  const paquete = SESION.slice(SESION.indexOf('async offlinePack('));

  it('abrir el vale usa lineasEsperadas, sin consultas de producto por renglón', () => {
    expect(abrir.length).toBeGreaterThan(500);
    expect(abrir).toContain('this.lineasEsperadas(trx, [doc])');
    // El camino viejo elegía producto con un .first() por renglón y sin orden.
    expect(abrir).not.toMatch(/public\.products'\)\.where\(\{ sku/);
  });

  it('el paquete usa la misma función y los mismos vales que el menú', () => {
    expect(paquete).toContain('this.pendingErpOrders(sucursal');
    expect(paquete).toContain('this.lineasEsperadas(trx, docs)');
  });

  it('el producto por SKU se elige igual siempre: el vivo primero y desempate por id', () => {
    const f = SESION.slice(SESION.indexOf('private async productosPorSku('));
    expect(f).toContain(".distinctOn('sku')");
    expect(f).toContain("orderByRaw('(deleted_at IS NOT NULL), id')");
  });

  it('los servicios (SER) quedan fuera en los dos documentos', () => {
    const f = SESION.slice(SESION.indexOf('private async lineasEsperadas('), SESION.indexOf('private async productosPorSku('));
    expect(f.split(`COALESCE(TRIM(unidad),'') <> 'SER'`).length - 1).toBe(2);
  });
});

describe('[WMS-REC.20] la ruta', () => {
  it('pide RECIBIR y va antes de :id (si no, Nest la toma como un id)', () => {
    const i = CONTROLLER.indexOf("@Get('offline-pack')");
    expect(i).toBeGreaterThan(-1);
    // Se busca el DECORADOR al inicio de línea: los comentarios también nombran `@Get(':id')`.
    const id = CONTROLLER.search(/\n {2}@Get\(':id'\)/);
    expect(id).toBeGreaterThan(-1);
    expect(i).toBeLessThan(id);
    expect(CONTROLLER.slice(i, i + 200)).toContain('Permission.COMMERCIAL_INVENTORY_RECIBIR');
  });
});
