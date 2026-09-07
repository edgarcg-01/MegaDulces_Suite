// El barrel de platform-core arrastra `queue.service` (ESM de la cola) y jest no lo parsea.
// Acá no se prueba nada de eso: se sustituyen las tres piezas que el service importa.
jest.mock('@megadulces/platform-core', () => ({
  TenantKnexService: class {},
  TenantContextService: class {},
  applySmartSearch: () => undefined,
}));

import { AnexoVentaService } from './anexo-venta.service';
import { CommercialSalesDocumentsService } from './commercial-sales-documents.service';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AX.10 — candados del anexo imprimible. Tres cosas que salieron mal en producción y que
 * NADIE podía ver desde el código, porque el documento sólo existe al imprimirlo:
 *
 *   1. **el RFC del emisor estaba hardcodeado y equivocado** (`LOGL8810144QS`, y el CP
 *      `59701, Michoacán`), contra `LOGL851014AQ5` / CP 36910 que dicen `fiscal.issuer_config`,
 *      los 167,503 CFDIs recibidos de `fiscal.cfdis` y las fichas internas de `kdud`. Iba
 *      impreso en el membrete, en el beneficiario del pago y en el pagaré;
 *   2. **el nombre se imprimía roto**: se capitalizaba con `/\b\w+/g`, que en JS no matchea
 *      letras acentuadas, así que `LUIS FRANCISCO LÓPEZ GUTIÉRREZ` salía como
 *      "Luis Francisco LÓPez GutiÉRrez";
 *   3. **el RFC genérico del SAT se imprimía como si fuera del cliente** — 79.1% de las
 *      facturas imprimibles traen `XAXX010101000`.
 *
 * Todo con su prueba NEGATIVA: los casos 1 y 2 pasaban en verde con el bug puesto, así que
 * cada aserción va acompañada de la que falla si el bug vuelve.
 */

const EMISOR_OK = { rfc: 'LOGL851014AQ5', nombre: 'LUIS FRANCISCO LOPEZ GUTIERREZ', regimen_code: '612', cp: '36910' };
/** El RFC equivocado que estuvo impreso: ninguna salida ni el fuente deben volver a tenerlo. */
const RFC_VIEJO = 'LOGL8810144QS';

const LINEA = {
  linea: 1, sku: '70031', descripcion: 'CHOC EST SUIZO /16 LA ROSA',
  unidad: 'CJA', unidad_venta: 'PZA', unidad_bulto: 'CJA', unidad_paq: 'PAQ',
  cantidad: 2, precio_unitario: 1827.2, importe: 3654.4, neto: 3544.77, descuento: 109.63,
  box_factor: 320, factor_paq: 16, box_factor_dudoso: false,
};
const doc = (over: Record<string, unknown> = {}) => ({
  sucursal: '01', doc_prefix: 'UD0801', folio: '0000874', doc_label: 'Factura Telemarketing',
  fecha: '2026-08-28', vencimiento: '2026-09-12', dias_credito: 15,
  cliente_code: 'C1015', cliente_nombre: 'JUAN PABLO FONSECA GUTIÉRREZ',
  cliente_rfc: 'XAXX010101000', cliente_domicilio: 'AV. REVOLUCIÓN NO.6', cliente_colonia: 'AYOTLAN',
  cliente_estado: 'JALISCO 47930', vendedor_nombre: 'CINTHIA YARET DEL VALLE RUEDA',
  referencia: 'EMBARCADO', doc_origen: 'UD4101-0001609',
  total: 3544.77, importe_bruto: 3654.4, ieps: 120.5, descuento_pct_efectivo: 3,
  lineas: [LINEA],
  ...over,
});

const svc = new AnexoVentaService({} as CommercialSalesDocumentsService) as any;
const render = (d: Record<string, unknown> = {}, e = EMISOR_OK) =>
  svc.html(doc(d), svc.emisorImpreso(e), { pagare: true }) as string;

describe('AX.10 · identidad fiscal del emisor', () => {
  it('imprime el RFC de fiscal.issuer_config', () => {
    const html = render();
    expect(html).toContain('LOGL851014AQ5');
    expect(html).toContain('C.P. 36910');
  });

  // NEGATIVA: con el bug puesto esto pasaba: el RFC viejo estaba en 3 lugares del documento.
  it('NO reaparece el RFC equivocado, ni en la salida ni en el fuente', () => {
    expect(render()).not.toContain(RFC_VIEJO);
    const fuente = readFileSync(join(__dirname, 'anexo-venta.service.ts'), 'utf8');
    // El RFC sólo puede venir del parámetro; un literal de RFC en el archivo es el bug de vuelta.
    const literales = fuente.match(/['"][A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}['"]/g) || [];
    expect(literales.filter((s) => !s.includes('XAXX') && !s.includes('XEXX'))).toEqual([]);
    expect(fuente).not.toContain(RFC_VIEJO);
  });

  it('el nombre va VERBATIM, con acentos y todo', () => {
    const NOMBRE = 'LUIS FRANCISCO LÓPEZ GUTIÉRREZ';
    // La transformación que estaba puesta, tal cual. Se ejecuta acá para que el test NO dependa
    // de que alguien recuerde cómo era el bug: si esta línea deja de producir basura, la
    // aserción de abajo pierde sentido y se entera el que la lea.
    const capitalizacionVieja = NOMBRE.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase());
    expect(capitalizacionVieja).toBe('Luis Francisco LÓPez GutiÉRrez'); // \w no matchea Ó ni É

    const html = render({}, { ...EMISOR_OK, nombre: NOMBRE });
    expect(html).toContain(NOMBRE);
    // NEGATIVA: con la capitalización vieja el beneficiario del pago decía exactamente esto.
    expect(html).not.toContain(capitalizacionVieja);
    expect(html).not.toContain('LÓPez');
    expect(html).not.toContain('GutiÉRrez');
  });

  it('no le invita un municipio a un CP que no tiene validado', () => {
    const otro = { ...EMISOR_OK, cp: '59701' };
    const html = render({}, otro);
    expect(html).toContain('C.P. 59701');
    expect(html).not.toContain('Santa Ana Pacueco');
  });

  it('se niega a imprimir si no hay identidad fiscal configurada', async () => {
    // Prueba NEGATIVA del fail-loud: sin fila, antes se caía a una constante equivocada.
    const chain: any = { where: () => chain, orderBy: () => chain, first: async () => undefined };
    const tk: any = { run: (fn: any) => fn(() => chain) };
    const ctx: any = { requireTenantId: () => 't' };
    await expect(new CommercialSalesDocumentsService(tk, ctx).emisorFiscal())
      .rejects.toThrow(/identidad fiscal/i);
  });
});

describe('AX.10 · el RFC del cliente no se disfraza', () => {
  it('rotula el genérico del SAT en vez de pasarlo por RFC del cliente', () => {
    const html = render({ cliente_rfc: 'XAXX010101000' });
    expect(html).toContain('XAXX010101000');
    expect(html).toContain('público en general');
  });

  it('el pagaré OMITE el RFC cuando es el genérico, y lo pone cuando es real', () => {
    const generico = render({ cliente_rfc: 'XAXX010101000' });
    const pagareGen = generico.slice(generico.indexOf('Suscriptor (deudor)'));
    expect(pagareGen).not.toContain('XAXX010101000');

    const real = render({ cliente_rfc: 'RUMR7604069M8' });
    const pagareReal = real.slice(real.indexOf('Suscriptor (deudor)'));
    expect(pagareReal).toContain('RUMR7604069M8');
    expect(real).not.toContain('público en general');
  });
});

describe('AX.10 · membrete y aceptación del pagaré', () => {
  const css = readFileSync(join(__dirname, 'anexo-venta.service.ts'), 'utf8');

  it('el logo se imprime y NO se encoge', () => {
    // El logo se cachea del disco; se inyecta para que el test no dependa del cwd.
    const conLogo = new AnexoVentaService({} as CommercialSalesDocumentsService) as any;
    conLogo.logoCache = 'data:image/png;base64,IMG';
    const html = conLogo.html(doc(), conLogo.emisorImpreso(EMISOR_OK), { pagare: true }) as string;
    expect(html).toContain('<img class="logo" src="data:image/png;base64,IMG"');
    // NEGATIVA del encogimiento: al compactar el membrete bajó de 64 a 44 px y quedó
    // irreconocible. Es la marca del documento que se le entrega al cliente.
    const alto = Number(/\.logo\{height:(\d+)px/.exec(css)![1]);
    expect(alto).toBeGreaterThanOrEqual(56);
  });

  it('el pagaré lleva el apartado ACEPTAMOS con sus dos firmas', () => {
    const html = render();
    const pagare = html.slice(html.indexOf('hoja-pagare'));
    expect(pagare).toContain('Aceptamos');
    expect(pagare).toContain('Firma del suscriptor (deudor)');
    expect(pagare).toContain('Aval u obligado solidario');
    // Dos rayas de firma, no una.
    expect((pagare.match(/class="linea"/g) || []).length).toBe(2);
  });

  it('la línea del aval va EN BLANCO: vacía no obliga a nadie', () => {
    const html = render();
    const aval = html.slice(html.indexOf('Aval u obligado solidario'));
    expect(aval).toContain('Nombre y firma');
    expect(aval).not.toContain('JUAN PABLO FONSECA'); // el deudor no firma por el aval
  });
});

describe('AX.10 · la hoja usa el ancho y el alto que tiene', () => {
  const css = readFileSync(join(__dirname, 'anexo-venta.service.ts'), 'utf8');
  /** Anchos declarados; el lookbehind separa el modo de 7 columnas del de 4 (sin descuento). */
  const anchos = (sel: RegExp) => [...css.matchAll(sel)].map((m) => Number(m[1]));
  const CON_DESC = /(?<!sin-desc )col\.c-\w+\{width:([\d.]+)%\}/g;
  const SIN_DESC = /sin-desc col\.c-\w+\{width:([\d.]+)%\}/g;

  it('las 7 columnas suman 100% del ancho (nada de papel sin repartir)', () => {
    const w = anchos(CON_DESC);
    expect(w).toHaveLength(7);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
  });

  it('las 4 columnas del modo sin descuento también suman 100%', () => {
    const w = anchos(SIN_DESC);
    expect(w).toHaveLength(4);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
  });

  it('el nombre del producto se queda con la mayor parte del ancho', () => {
    const [prod] = anchos(CON_DESC);
    // Medido sobre 14,872 renglones: p95 = 41 caracteres. Con el 22% original se partía en dos.
    expect(prod).toBeGreaterThanOrEqual(34);
  });

  it('el precio lleva su unidad PEGADA, no en un renglón aparte', () => {
    const html = render();
    expect(html).toMatch(/<i class="pl">\/CJA<\/i>/);
    // NEGATIVA: la versión vieja ponía la unidad en un bloque propio ("por CJA"), y con dos
    // columnas de precio y tres niveles eso eran 6 renglones de alto por producto.
    expect(html).not.toContain('>por CJA<');
    expect(html).not.toContain('class="pl">por ');
  });

  it('no queda ningún bloque huérfano del layout viejo', () => {
    const html = render();
    // `foot-grid`/`admin` se fundieron en `cierre`; si vuelven, vuelven los 252px apilados.
    expect(html).toContain('class="cierre"');
    expect(html).not.toContain('class="foot-grid"');
    expect(html).not.toContain('class="admin"');
    expect(html).not.toContain('class="titleband"');
  });
});
