import { vi } from 'vitest';
import type { GuiaRepartoHoja, GuiaRepartoParada } from '@megadulces/contracts';

/**
 * `[EMB.56]` CANDADO de la guía de reparto en papel. Corre el dibujo REAL (jsPDF + autoTable) y lee
 * lo que se escribió: el chofer entrega con esta hoja, así que si dice otra cosa que el endpoint
 * (otro orden, otro domicilio, una factura de más) la mercancía llega a otro lado.
 */
const tablas: Record<string, unknown>[] = [];
const textos: string[] = [];

vi.mock('../compras/compras-pdf-comun', async (original) => {
  const real = await original<typeof import('../compras/compras-pdf-comun')>();
  return {
    ...real,
    loadLogo: async () => null,
    loadLibs: async () => {
      const { jsPDF, autoTable } = await real.loadLibs();
      // jsPDF arma `text` en cada INSTANCIA (no en el prototipo): se envuelve al construir.
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
        autoTable: (doc: unknown, o: Record<string, unknown>) => { tablas.push(o); autoTable(doc as never, o); },
      };
    },
  };
});

import { archivoGuia, archivoGuias, notasGuia, pdfGuiaReparto, pdfGuiasReparto, renglonesGuia, textoEntrega, textoFolios } from './guia-reparto-pdf';

const parada = (p: Partial<GuiaRepartoParada>): GuiaRepartoParada => ({
  numero: 1, orden_visita: 3, cliente_code: 'C0001', cliente_nombre: 'TIENDA DE LA ESQUINA',
  domicilio_calle: 'HIDALGO 354', domicilio_ciudad: 'PENJAMILLO', domicilio_telefono: '4430000000',
  domicilio_supuesto: false, ruta_nombre: 'R0005', instruccion: null, cajas: 4, paquetes: 1, kg: null,
  documentos: [{
    serie: 1, embarque_folio: '0000684', embarque_folio_digital: '01UD4101-0000684',
    pedido_folio_digital: '01UD4001-0000707', facturas: [{ folio: '0000374', folio_digital: '01UD0801-0000374' }],
    factura_estado: 'facturado', cajas: 4, paquetes_nota: 1, kg: null,
  }],
  ...p,
});

const hoja = (): GuiaRepartoHoja => ({
  viaje: { sucursal: '01', sucursal_nombre: 'Sucursal Hidalgo', guia: '0000969', guia_digital: '01-G0000969', fecha: '2026-07-23' },
  unidad: { kepler_code: '00008', descripcion: 'FORD 450 GASOLINA SUPER DUTY', placas: '774H6V' },
  chofer_kepler: null,
  paradas: [
    parada({}),
    parada({
      numero: 2, orden_visita: null, cliente_code: 'C0002', cliente_nombre: 'ABARROTES EL PUENTE', instruccion: 'LAS VELAS SON AZUL',
      cajas: 28, paquetes: 9,
      documentos: [
        { serie: 1, embarque_folio: '0000685', embarque_folio_digital: '01UD4101-0000685', pedido_folio_digital: '01UD4001-0000692',
          facturas: [{ folio: '0000396', folio_digital: '01UD0801-0000396' }], factura_estado: 'facturado', cajas: 28, paquetes_nota: null, kg: null },
        { serie: 1, embarque_folio: '0000694', embarque_folio_digital: '01UD4101-0000694', pedido_folio_digital: '01UD4001-0000694',
          facturas: [], factura_estado: 'sin_factura', cajas: 0, paquetes_nota: 9, kg: null },
      ],
    }),
  ],
  resumen: { paradas: 2, documentos: 3, cajas: 32, paquetes: 10, kg: null, sin_orden: 1, sin_domicilio: 0, sin_factura: 1 },
  procedencia: {},
});

describe('[EMB.56] guía de reparto · lo que dice cada celda', () => {
  it('un renglón por parada, en el orden del endpoint, con número, destino, entrega y folios', () => {
    const r = renglonesGuia(hoja());
    expect(r.map((f) => f[0])).toEqual(['1', '2']);
    expect(r[0][1]).toBe('TIENDA DE LA ESQUINA\nHIDALGO 354\nPENJAMILLO\nTel. 4430000000');
    expect(r[0][2]).toBe('4 cajas\n1 paquete');
    expect(r[0][3]).toBe('Factura 01UD0801-0000374\nEmb. 0000684 · Ped. 0000707');
    expect(r[0][4]).toBe(''); // la firma de recibido
  });

  it('la factura va primero; sin factura, se DICE, no se deja el hueco', () => {
    const t = textoFolios(hoja().paradas[1].documentos);
    expect(t.split('\n')).toEqual([
      'Factura 01UD0801-0000396', 'Emb. 0000685 · Ped. 0000692',
      'Sin factura todavía', 'Emb. 0000694 · Ped. 0000694',
    ]);
  });

  it('la nota que repite el pueblo del domicilio no se imprime; la que aporta, sí', () => {
    const repite = renglonesGuia({ ...hoja(), paradas: [parada({ instruccion: 'Penjamillo' })] })[0][1];
    expect(repite).not.toContain('Nota:');
    expect(renglonesGuia(hoja())[1][1]).toContain('Nota de almacén: LAS VELAS SON AZUL');
  });

  it('la instrucción y la falta de orden en Kepler quedan escritas en la parada', () => {
    const d = renglonesGuia(hoja())[1][1];
    expect(d).toContain('Nota de almacén: LAS VELAS SON AZUL');
    expect(d).toContain('Sin orden de visita en Kepler');
  });

  it('singular y plural; con cajas, los kilos NO van (el bulto ya cuenta como caja)', () => {
    expect(textoEntrega({ cajas: 1, paquetes: 2 })).toBe('1 caja\n2 paquetes');
    expect(renglonesGuia({ ...hoja(), paradas: [parada({ kg: 60 })] })[0][2]).toBe('4 cajas\n1 paquete');
  });

  it('⛔ sin cajas ni paquetes NO dice «sin conteo»: la mercancía va suelta (guía 0001979, 9 kg)', () => {
    expect(textoEntrega({ cajas: 0, paquetes: null, kg: 9 })).toBe('Mercancía suelta\n9 kg');
    expect(textoEntrega({ cajas: 0, paquetes: null })).toBe('Mercancía suelta\nver la factura');
    const sinRenglones = { ...hoja().paradas[0].documentos[0], cajas: null };
    expect(textoEntrega({ cajas: 0, paquetes: null, documentos: [sinRenglones] })).toBe('Sin renglones en Kepler');
  });

  it('el traspaso no repite «sin factura» por embarque: una línea y los folios juntos (guía 0001470)', () => {
    const t = (folio: string, ped: string) => ({
      serie: 2, embarque_folio: folio, embarque_folio_digital: `00UD4102-${folio}`, pedido_folio_digital: `00UD4002-${ped}`,
      facturas: [], factura_estado: 'no_aplica' as const, cajas: 30, paquetes_nota: null, kg: null,
    });
    expect(textoFolios([t('0001497', '0001596'), t('0001498', '0001652'), t('0001499', '0001667')]).split('\n')).toEqual([
      'Traspaso: no lleva factura', 'Emb. 0001497, 0001498, 0001499', 'Ped. 0001596, 0001652, 0001667',
    ]);
  });

  it('una sola parada no dice «sin orden de visita»: no hay nada que ordenar', () => {
    const una = { ...hoja(), paradas: [parada({ orden_visita: null })] };
    expect(renglonesGuia(una)[0][1]).not.toContain('Sin orden de visita');
    expect(notasGuia({ ...una, resumen: { ...una.resumen, paradas: 1, sin_orden: 1 } }).join(' ')).not.toContain('orden de visita');
  });

  it('las notas dicen lo que el papel no puede afirmar', () => {
    const n = notasGuia(hoja());
    expect(n[0]).toBe('Sin importes: el chofer entrega; cobra el vendedor.');
    expect(n).toContain('1 embarque todavía no tiene factura: pídela antes de salir.');
    expect(n).toContain('1 parada no tiene orden de visita en Kepler: van al final.');
  });

  it('el archivo se llama por el viaje y su día', () => {
    expect(archivoGuia(hoja())).toBe('GUIA-REPARTO-01-G0000969-2026-07-23.pdf');
  });
});

describe('[EMB.56] guía de reparto · el dibujo real', () => {
  beforeEach(() => { tablas.length = 0; textos.length = 0; });

  it('dibuja UNA tabla con las paradas y devuelve un PDF', async () => {
    const blob = await pdfGuiaReparto(hoja(), new Date(2026, 6, 23, 19, 16));
    expect(blob.type).toBe('application/pdf');
    expect(tablas).toHaveLength(1);
    expect(JSON.stringify(tablas[0]['head'])).toContain('Recibió (nombre y firma)');
    expect((tablas[0]['body'] as string[][]).map((f) => f[0])).toEqual(['1', '2']);
  });

  it('el encabezado lleva viaje, día, unidad y la línea para el chofer que Kepler no trae', async () => {
    await pdfGuiaReparto(hoja(), new Date(2026, 6, 23, 19, 16));
    const t = textos.join(' | ');
    expect(t).toContain('Guía 0000969');
    expect(t).toContain('23/07/2026');
    expect(t).toContain('FORD 450 GASOLINA SUPER DUTY · 774H6V');
    expect(t).toMatch(/Chofer: _{10,}/);
  });

  it('una guía corta cabe en UNA hoja, notas incluidas (no deja una nota sola en otra)', async () => {
    await pdfGuiaReparto(hoja(), new Date(2026, 6, 23, 19, 16));
    expect(textos).toContain('Página 1 de 1');
    expect(textos.join(' ')).toContain('Sin importes: el chofer entrega; cobra el vendedor.');
  });

  it('«Imprimir todas»: UNA guía por hoja, cada una con su encabezado — nunca fundidas en una lista', async () => {
    const otra: GuiaRepartoHoja = { ...hoja(), viaje: { ...hoja().viaje, guia: '0001979', guia_digital: '01-G0001979' } };
    const blob = await pdfGuiasReparto([hoja(), otra], new Date(2026, 6, 23, 19, 16));
    expect(blob.type).toBe('application/pdf');
    expect(tablas).toHaveLength(2);                                   // una tabla por guía
    expect(textos.filter((t) => t.startsWith('Guía 0')).sort()).toEqual(['Guía 0000969', 'Guía 0001979']);
    expect(textos).toContain('Página 2 de 2');                        // la segunda guía empieza hoja
    expect(textos.join(' ')).toContain('2 guías · 23/07/2026');
    expect(archivoGuias([hoja(), otra])).toBe('GUIAS-REPARTO-2026-07-23-2.pdf');
    expect(archivoGuias([hoja()])).toBe('GUIA-REPARTO-01-G0000969-2026-07-23.pdf');
  });

  it('⛔ ningún importe en el papel: ni signo de pesos ni cifras con centavos', async () => {
    await pdfGuiaReparto(hoja(), new Date(2026, 6, 23, 19, 16));
    const todo = textos.join(' ') + JSON.stringify(tablas.map((o) => o['body']));
    expect(todo).not.toMatch(/\$/);
    expect(todo).not.toMatch(/\d\.\d{2}\b/);
  });
});
