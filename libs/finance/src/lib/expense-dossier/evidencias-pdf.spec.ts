// El HTML de la sección se prueba sin levantar Chromium.
vi.mock('puppeteer', () => ({}));

import { PDFDocument } from 'pdf-lib';
import { anexarPdfs, htmlEvidencias, prepararEvidencias, tipoDeContenido, type EvidenciasPreparadas } from './evidencias-pdf';
import { archivosDeEvidencia } from './expediente-gasto-document.service';

/**
 * `[GX.76]` Las evidencias dentro del expediente en PDF. Lo que puede mentir:
 *   · perder un archivo en silencio (no se pudo bajar, dañado, tipo raro → se DECLARA);
 *   · anexar un PDF y no decirlo, o decirlo y no anexarlo;
 *   · una página anexada que no dice de qué expediente es.
 */
const pdfDe = async (paginas: number): Promise<Uint8Array> => {
  const d = await PDFDocument.create();
  for (let i = 0; i < paginas; i++) d.addPage([300, 400]);
  return d.save();
};
const uri = (ct: string, bytes: Uint8Array | Buffer) => `data:${ct};base64,${Buffer.from(bytes).toString('base64')}`;
// Un PNG mínimo válido de 1×1.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');

describe('[GX.76] tipoDeContenido', () => {
  it('reconoce PDF por el tipo y también por los bytes (%PDF), aunque el tipo mienta', async () => {
    const pdf = await pdfDe(1);
    expect(tipoDeContenido(uri('application/pdf', pdf))).toBe('pdf');
    expect(tipoDeContenido(uri('application/octet-stream', pdf))).toBe('pdf');
    expect(tipoDeContenido(uri('image/jpeg', PNG))).toBe('imagen');
    expect(tipoDeContenido(uri('image/png', PNG))).toBe('imagen');
    expect(tipoDeContenido(uri('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', PNG))).toBe('otro');
  });
});

describe('[GX.76] prepararEvidencias', () => {
  it('clasifica: foto reducida, PDF con sus páginas, y declara todo lo que no entra', async () => {
    const pdf2 = await pdfDe(2);
    const archivos: Record<string, string | null> = {
      'k/foto.jpg': uri('image/jpeg', PNG),
      'k/ticket.pdf': uri('application/pdf', pdf2),
      'k/roto.pdf': 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 basura').toString('base64'),
      'k/hoja.xlsx': uri('application/vnd.ms-excel', PNG),
      'k/perdido.pdf': null,
    };
    const r = await prepararEvidencias([
      { origen: 'Expediente', archivo: { role: 'comprobante_1', public_id: 'k/foto.jpg' } },
      { origen: 'Expediente', archivo: { role: 'comprobante_2', public_id: 'k/ticket.pdf' } },
      { origen: 'Expediente', archivo: { role: 'cotizacion', public_id: 'k/roto.pdf' } },
      { origen: 'Expediente', archivo: { role: 'cotizacion_2', public_id: 'k/hoja.xlsx' } },
      { origen: 'Expediente', archivo: { role: 'comprobante_3', public_id: 'k/perdido.pdf' } },
      { origen: 'Expediente', archivo: { role: 'viejo', public_id: 'https://res.cloudinary.com/x.jpg' } },
    ], async (k) => archivos[k] ?? null, async () => Buffer.from('chica'));

    expect(r.imagenes).toHaveLength(1);
    expect(r.imagenes[0]).toMatchObject({ etiqueta: 'Expediente · comprobante_1', reducida: true });
    expect(r.imagenes[0].dataUri.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(r.pdfs.map((p) => [p.etiqueta, p.paginas])).toEqual([['Expediente · comprobante_2', 2]]);
    const motivos = Object.fromEntries(r.omitidas.map((o) => [o.etiqueta, o.motivo]));
    expect(motivos['Expediente · cotizacion']).toContain('dañado');
    expect(motivos['Expediente · cotizacion_2']).toContain('no es foto ni PDF');
    expect(motivos['Expediente · comprobante_3']).toContain('no se pudo descargar');
    expect(motivos['Expediente · viejo']).toContain('anterior al bucket');
    // ⛔ Nada se pierde en silencio: 6 archivos entran, 6 salen en alguna de las tres listas.
    expect(r.imagenes.length + r.pdfs.length + r.omitidas.length).toBe(6);
  });

  it('si no se puede reducir la foto, entra la original y se dice', async () => {
    const r = await prepararEvidencias([{ origen: 'Expediente', archivo: { role: 'comprobante_1', public_id: 'k/f.png' } }],
      async () => uri('image/png', PNG), async () => null);
    expect(r.imagenes[0].reducida).toBe(false);
    expect(htmlEvidencias(r)).toContain('(sin reducir)');
  });
});

describe('[GX.76] htmlEvidencias', () => {
  it('sin archivos lo dice, no deja la sección en blanco', () => {
    expect(htmlEvidencias({ imagenes: [], pdfs: [], omitidas: [] })).toContain('no tiene archivos de evidencia');
  });

  it('anuncia los anexos, pinta las fotos y declara las omitidas', () => {
    const e: EvidenciasPreparadas = {
      imagenes: [{ etiqueta: 'Expediente · comprobante_1', dataUri: 'data:image/jpeg;base64,AAAA', reducida: true }],
      pdfs: [{ etiqueta: 'Expediente · comprobante_2', bytes: new Uint8Array(), paginas: 3 }],
      omitidas: [{ etiqueta: 'Expediente · <b>x</b>', motivo: 'no se pudo descargar del almacenamiento' }],
    };
    const h = htmlEvidencias(e);
    expect(h).toContain('Anexados al final de este archivo');
    expect(h).toContain('PDF de 3 páginas');
    expect(h).toContain('<img src="data:image/jpeg;base64,AAAA"');
    expect(h).toContain('No se pudieron incluir');
    expect(h).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('[GX.76] anexarPdfs', () => {
  it('pega las páginas de cada evidencia DESPUÉS del expediente, en orden', async () => {
    const principal = await pdfDe(2);
    const final = await anexarPdfs(principal, [
      { etiqueta: 'Expediente · comprobante_1', bytes: await pdfDe(3), paginas: 3 },
      { etiqueta: 'Comprobación 0009069 · factura', bytes: await pdfDe(1), paginas: 1 },
    ], 'Expediente 06-0000045');
    expect((await PDFDocument.load(final)).getPageCount()).toBe(6);
  });

  it('sin anexos devuelve el documento tal cual', async () => {
    const principal = await pdfDe(1);
    expect(await anexarPdfs(principal, [], 'x')).toBe(principal);
  });
});

describe('[GX.76] archivosDeEvidencia', () => {
  it('junta lo del expediente y lo de cada comprobación, con su origen', () => {
    const r = archivosDeEvidencia({
      expediente: { files: [{ role: 'comprobante_1', public_id: 'a' }, { role: 'cotizacion', public_id: 'b' }] },
      comprobaciones: [{ folio_comprobacion: 'C-12', files: [{ role: 'factura', public_id: 'c' }] }, { folio_gasto: '0009069', files: null }],
    } as never);
    expect(r.map((x) => `${x.origen}|${x.archivo.role}`)).toEqual(['Expediente|comprobante_1', 'Expediente|cotizacion', 'Comprobación C-12|factura']);
    expect(archivosDeEvidencia({ expediente: null, comprobaciones: [] } as never)).toEqual([]);
  });
});
