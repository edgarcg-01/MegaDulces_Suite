import { PaymentCalendarDocumentService, comoPaga } from './payment-calendar-document.service';
import { folioExternoLegible, type ExpedienteLinea } from './payment-calendar.service';

/**
 * `[PGP.47]` **El desglose por factura del Preliminar.**
 *
 * Lo que se prueba acá no es «que pinte una tabla»: es que el papel **no afirme lo que no es**.
 * Cada caso nace de algo medido contra prod el 2026-11-03 y que, mal escrito, habría mentido:
 *
 *  - `ref_evidencia` son DOS cosas con la misma forma (142 ids internos de comprobante contra 36
 *    UUID fiscales del SAT). Publicar el primero como identificador fiscal mentiría en 142 de 178.
 *  - El folio externo sale del CFDI (36 de 36, timbrado) o del OCR (132 de 142, una lectura de
 *    una foto). Sin declarar la fuente, una lectura automática se lee como un dato fiscal.
 *  - 33 de 226 líneas vivas son documentos que el ERP **ya tiene saldados**: si eso no grita en
 *    el renglón, se firma un pago que no se puede ejecutar.
 *  - Una obligación propia no tiene factura del ERP detrás. Contarla como «sin papel» inflaría
 *    lo que hay que ir a buscar al archivo (ADR-056).
 *
 * ⛔ Los dos métodos son privados a propósito (nadie fuera del documento los necesita); se
 * alcanzan por `as any`, que es acceso de prueba, no un agujero en la API.
 */

const svc = new PaymentCalendarDocumentService(null as never);
const tabla = (alloc: unknown[], det: ExpedienteLinea[]): string =>
  (svc as unknown as { tablaExpediente(a: unknown[], d: ExpedienteLinea[]): string }).tablaExpediente(alloc, det);
const control = (det: ExpedienteLinea[]): string =>
  (svc as unknown as { controlExpediente(d: ExpedienteLinea[]): string }).controlExpediente(det);

function linea(over: Partial<ExpedienteLinea> = {}): ExpedienteLinea {
  return {
    allocation_id: 'A1', obligation_source: 'kepler_payable', obligation_id: 'O1',
    se_paga: 1000, sucursal: '00', folio_interno: '0009780', folio_externo: 'FDA 56778',
    folio_externo_fuente: 'ocr', orden_compra: '0007005', fecha_recepcion: '2026-09-24',
    fecha: '2026-09-24', fecha_fuente: 'erp', vencimiento: '2026-10-24',
    importe: 1000, pendiente: 1000, importe_cfdi: null,
    referencia: '0-F6778', rfc: 'CSA0806034GA', rfc_fuente: 'nombre', rfc_discrepa: null,
    papel: 'pdf', uuid_fiscal: null, saldada: false, ...over,
  };
}
const pago = (over: Record<string, unknown> = {}) => ({
  id: 'A1', priority_rank: 1, amount_assigned: 1000, classification: 'proveedor_mercancia',
  payment_method: 'transferencia', bank_account_label: 'Banorte 3041',
  destination_account_text: 'CLABE 072180001234567890', items: [{ beneficiary: 'SARAMEL' }], ...over,
});

describe('[PGP.47] el desglose por factura', () => {
  it('imprime UN renglón por factura, no los beneficiarios concatenados', () => {
    const html = tabla([pago({ amount_assigned: 3000 })], [
      linea({ folio_interno: '0009780' }), linea({ folio_interno: '0009781' }), linea({ folio_interno: '0009782' }),
    ]);
    expect(html).toContain('0009780');
    expect(html).toContain('0009781');
    expect(html).toContain('0009782');
    expect((html.match(/class="doc-row"/g) ?? []).length).toBe(3);
  });

  it('⛔ publica la sucursal por NOMBRE, y el código NO aparece como celda', () => {
    const html = tabla([pago()], [linea({ sucursal: '00' })]);
    expect(html).toContain('CEDIS');
    // El control que importa: que no quede una celda cuyo contenido ÚNICO sea el código.
    expect(html).not.toMatch(/<td>\s*00\s*<\/td>/);
  });

  it('⛔ el UUID fiscal sólo se publica cuando la evidencia ES el UUID', () => {
    const conPdf = tabla([pago()], [linea({ papel: 'pdf', uuid_fiscal: null })]);
    expect(conPdf).not.toContain('F873518E');
    const conUuid = tabla([pago()], [linea({ papel: 'uuid', uuid_fiscal: 'F873518E-4EDE-459B-A3C6-499A59CD68DC' })]);
    expect(conUuid).toContain('UUID');
  });

  it('⛔ el folio externo viaja con su FUENTE: timbrado y leído no valen lo mismo', () => {
    const porOcr = tabla([pago()], [linea({ folio_externo: 'FDA 56778', folio_externo_fuente: 'ocr' })]);
    expect(porOcr).toContain('FDA 56778');
    expect(porOcr).toContain('OCR');
    const porCfdi = tabla([pago()], [linea({ folio_externo: 'F961549', folio_externo_fuente: 'cfdi' })]);
    expect(porCfdi).toContain('CFDI');
    expect(porCfdi).not.toContain('>OCR<');
  });

  /**
   * ⛔ Lo encontró Edgar leyendo el papel: la columna decía `SD060092661394`, que no es ningún
   * folio — es la serie `SD06` pegada al folio `0092661394` sin separador. En la factura dice
   * «Serie SD06 Folio 0092661394». 37 de 44 CFDI de la deuda programada traen serie.
   */
  it('⛔ serie y folio del CFDI se publican SEPARADOS, no pegados', () => {
    const html = tabla([pago()], [linea({ folio_externo: 'SD06-0092661394', folio_externo_fuente: 'cfdi' })]);
    expect(html).toContain('SD06-0092661394');
    expect(html).not.toContain('SD060092661394');
  });

  it('⭐ la referencia del ERP es la TERCERA fuente, y se declara como tal', () => {
    const html = tabla([pago()], [linea({ folio_externo: '0-F-7470', folio_externo_fuente: 'erp' })]);
    expect(html).toContain('0-F-7470');
    expect(html).toContain('ERP');
    // No se disfraza de dato timbrado ni de lectura: es lo que alguien tecleó.
    expect(html).not.toContain('>CFDI<');
    expect(html).not.toContain('>OCR<');
  });

  it('sin folio externo no inventa fuente: la columna queda declarada en blanco', () => {
    const html = tabla([pago()], [linea({ folio_externo: null, folio_externo_fuente: 'ninguna' })]);
    expect(html).not.toContain('OCR');
    expect(html).not.toContain('CFDI');
  });

  it('⛔ una factura que el ERP ya no debe lo GRITA en su renglón', () => {
    const html = tabla([pago()], [linea({ saldada: true })]);
    expect(html).toContain('YA SALDADA EN EL ERP');
  });

  /**
   * ⛔ El gate que faltaba. La fila de pago traía **9 celdas en una tabla de 10**, y eso no dejaba
   * sólo un hueco al final: corría todo un lugar, así que el total del pago caía bajo «Importe
   * doc.» y el conteo de documentos bajo «Se paga» —una columna de dinero publicando un número de
   * papeles—. Ninguna de las 19 pruebas anteriores lo vio: todas miraban el CONTENIDO de una
   * celda, ninguna la FORMA de la tabla. Lo encontró Edgar preguntando por los vacíos.
   */
  it('⛔ TODA fila tiene el mismo ancho que el encabezado, contando colspan', () => {
    const html = tabla([pago({ amount_assigned: 2000 }), pago({ id: 'A2', priority_rank: 2 })], [
      linea({ allocation_id: 'A1' }), linea({ allocation_id: 'A1', folio_interno: '2' }),
      linea({ allocation_id: 'A2', folio_interno: '3' }),
    ]);
    // ⛔ El contador NO puede usar /<t[dh][^>]*>/: ese patrón también casa `<thead>` («th» + «ead»)
    // y se cuenta a sí mismo. Mi primera medición dijo 11 columnas por ese motivo.
    const ancho = (fila: string): number =>
      (fila.match(/<t[dh](?=[\s>])[^>]*>/g) ?? []).reduce((n, td) => {
        const m = /colspan="(\d+)"/.exec(td);
        return n + (m ? Number(m[1]) : 1);
      }, 0);
    const encabezado = ancho((/<thead>[\s\S]*?<\/thead>/.exec(html) ?? [''])[0]);
    expect(encabezado).toBe(10);
    const filas = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
    expect(filas.length).toBeGreaterThan(4);
    for (const f of filas) expect(ancho(f), f.slice(0, 90)).toBe(encabezado);
  });

  it('⛔ el total del pago se publica bajo «Se paga», no bajo «Importe doc.»', () => {
    const html = tabla([pago({ amount_assigned: 174140.17 })], [linea({ importe: 94005.37 })]);
    const cabeza = (/<tr class="pago-row">[\s\S]*?<\/tr>/.exec(html) ?? [''])[0];
    const celdas = [...cabeza.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    // Orden · beneficiario(colspan 7) · el total · vacío  →  el total es la ANTEÚLTIMA celda,
    // que es la columna 9 = «Se paga». La 10 («Papel») no aplica a nivel de pago.
    expect(celdas.at(-2)).toBe('$174,140.17');
    expect(celdas.at(-1)).toBe('');
    // Exactamente cuatro celdas: Orden · beneficiario(7) · total · vacío. Una quinta significaría
    // que algo volvió a ocupar una columna de dinero.
    expect(celdas).toHaveLength(4);
    // Y el conteo de documentos vive en el texto, no en una celda propia.
    expect(cabeza).toContain('1 documento');
  });

  it('un pago sin documentos ligados lo dice, en vez de dejar el hueco mudo', () => {
    const html = tabla([pago()], []);
    expect(html).toContain('Sin desglose');
  });

  it('las fechas se cortan del texto ISO — nunca por Date, que corre el día en México', () => {
    const html = tabla([pago()], [linea({ fecha: '2026-10-25', vencimiento: '2026-01-01' })]);
    expect(html).toContain('25-oct');
    expect(html).toContain('1-ene');
    expect(html).not.toContain('24-oct');
    expect(html).not.toContain('31-dic');
  });
});

/**
 * ⛔ Estos cinco valores NO son inventados: son **los cinco folios ilegibles** que el OCR había
 * guardado entre los 35 del 2026-11-03, y que el papel publicaba como si fueran folios. Se
 * encontraron mirando el documento generado con datos de prod, no con una compuerta.
 */
describe('[PGP.47] el folio por OCR que no puede ser un folio', () => {
  const ILEGIBLES = [
    '39B08600-96BE-47A1-9AEE-DB40D50F32E',
    'F940276-202040-400D-8CDF-0259B03-B34E',
    '8854EC14-2D3C-4C3A-81B8-8BCFFC90D179',
    'ABF3D7B3-0A61-42C3-8BFF-B871 3C62924B',
    '-1649',
  ];
  const FOLIOS = ['F963114', 'AE 263061', 'FDA 56779', 'XA2001-0000130', '0414970', '31453'];

  it('⛔ los cinco ilegibles de prod se descartan, uno por uno', () => {
    for (const s of ILEGIBLES) expect(folioExternoLegible(s), s).toBeNull();
  });

  it('⭐ y NINGUNO de los folios reales se pierde en el camino', () => {
    for (const s of FOLIOS) expect(folioExternoLegible(s), s).toBe(s);
  });

  it('el vacío y el nulo salen como nulo, no como cadena vacía', () => {
    expect(folioExternoLegible(null)).toBeNull();
    expect(folioExternoLegible('   ')).toBeNull();
  });

  it('⛔ un UUID leído por OCR NO se promueve a uuid_fiscal: no está casado con el documento', () => {
    const html = tabla([pago()], [linea({
      folio_externo: folioExternoLegible('8854EC14-2D3C-4C3A-81B8-8BCFFC90D179'),
      folio_externo_fuente: 'ninguna', papel: 'pdf', uuid_fiscal: null,
    })]);
    expect(html).not.toContain('8854EC14');
  });
});

/**
 * ⭐ Regla de Edgar (2026-11-03): *«todo lo que se pueda obtener vía CFDI es mejor y siempre
 * darle prioridad»*. Lo que se prueba acá es dónde SÍ aplica y, sobre todo, **dónde no**.
 */
describe('[PGP.47] el CFDI manda sobre el ERP', () => {
  it('⭐ el control del expediente cuenta cuántas líneas traen el dato timbrado', () => {
    const html = control([
      linea({ fecha_fuente: 'cfdi' }), linea({ fecha_fuente: 'cfdi' }), linea({ fecha_fuente: 'erp' }),
    ]);
    expect(html).toMatch(/tomados del CFDI timbrado<\/td><td class="r"><b>2<\/b>/);
  });

  /**
   * ⛔ El límite de la regla. El importe que decide cuánto se paga es el del ERP: es contra lo
   * que el acreedor nos tiene registrada la deuda. Una diferencia con el comprobante es un
   * hallazgo para una persona (11 de 43 líneas), **no una corrección automática** — cambiarlo
   * solo movería dinero sin que nadie lo haya revisado.
   */
  it('⛔ un importe distinto en el CFDI se DECLARA, no se corrige solo', () => {
    const html = control([linea({ importe: 1000, importe_cfdi: 1160 }), linea({ importe: 1000, importe_cfdi: 1000 })]);
    expect(html).toMatch(/el CFDI dice otro importe<\/td><td class="r"><b>1<\/b>/);
    expect(html).toContain('revisar cuál es el bueno antes de pagar');
  });

  /**
   * ⛔ El umbral importa tanto como la alerta. Medido el 2026-11-03 sobre el día completo: con el
   * umbral en un centavo saltaban **10** líneas y **9 eran centavos de redondeo** (1 a 11 ¢); la
   * única real tenía $1,228.05. Una alerta que suena diez veces por nada entierra la que importa.
   * Estos cuatro valores son los reales de prod.
   */
  it('⛔ los centavos de redondeo de Kepler NO disparan la alerta', () => {
    const centavos = control([
      linea({ importe: 11748.86, importe_cfdi: 11748.83 }),   // −3 ¢
      linea({ importe: 731529.79, importe_cfdi: 731529.81 }), // +2 ¢
      linea({ importe: 3999.89, importe_cfdi: 4000.0 }),      // +11 ¢, el mayor del día
    ]);
    expect(centavos).not.toContain('dice otro importe');
    // Y la única de verdad sí salta.
    const real = control([linea({ importe: 288993.54, importe_cfdi: 287765.49 })]);
    expect(real).toMatch(/el CFDI dice otro importe<\/td><td class="r"><b>1<\/b>/);
  });

  it('⛔ y la alerta NO aparece cuando todos los importes coinciden', () => {
    expect(control([linea({ importe: 1000, importe_cfdi: 1000 })])).not.toContain('dice otro importe');
  });

  it('la tabla publica el importe del ERP, nunca el del comprobante', () => {
    const html = tabla([pago()], [linea({ importe: 1000, importe_cfdi: 1160 })]);
    expect(html).toContain('$1,000.00');
    expect(html).not.toContain('$1,160.00');
  });
});

describe('[PGP.47] el control del expediente', () => {
  const muestra: ExpedienteLinea[] = [
    linea({ papel: 'pdf' }),
    linea({ papel: 'uuid', uuid_fiscal: 'AA', folio_externo: 'F1', folio_externo_fuente: 'cfdi' }),
    linea({ papel: 'ninguna', folio_externo: null, folio_externo_fuente: 'ninguna' }),
    linea({ obligation_source: 'supplier_payable', papel: 'no_aplica', folio_externo: null, folio_externo_fuente: null }),
  ];

  it('⛔ una obligación propia NO cuenta como «sin papel»: no tiene factura del ERP detrás', () => {
    const html = control(muestra);
    // 4 documentos en total, pero sólo 3 con factura del ERP detrás, y UNO solo sin papel.
    expect(html).toMatch(/Documentos del día<\/td><td class="r"><b>4<\/b>/);
    expect(html).toContain('3 con factura del ERP detrás');
    expect(html).toMatch(/SIN ningún papel<\/td><td class="r"><b>1<\/b>/);
  });

  it('separa lo que se puede imprimir del sistema de lo que hay que pedirle al proveedor', () => {
    const html = control(muestra);
    expect(html).toMatch(/digitalizada \(PDF\)<\/td><td class="r"><b>1<\/b>/);
    expect(html).toMatch(/sin archivo<\/td><td class="r"><b>1<\/b>/);
  });

  it('avisa cuántos folios externos los leyó un OCR y no están verificados', () => {
    const html = control(muestra);
    // Uno solo: de los 3 con factura del ERP detrás, el del CFDI es timbrado y el tercero no
    // tiene folio externo. Contar 2 sería contar el timbrado como lectura.
    expect(html).toMatch(/leído por OCR<\/td><td class="r"><b>1<\/b>/);
    expect(html).toContain('cotejar contra el papel');
  });

  it('cuenta el pago parcial, que es el que necesita soporte anexo', () => {
    const html = control([linea({ se_paga: 400, pendiente: 1000 }), linea({ se_paga: 1000, pendiente: 1000 })]);
    expect(html).toMatch(/menos de lo que se debe<\/td><td class="r"><b>1<\/b>/);
  });

  it('⛔ la alerta de documento saldado NO se imprime cuando no hay ninguno', () => {
    expect(control([linea({ saldada: false })])).not.toContain('ATENCIÓN');
    expect(control([linea({ saldada: true })])).toContain('ATENCIÓN');
  });
});

/**
 * `[PGP.68]` **Cómo se paga, en el papel que se firma** (Edgar, 2026-11-04: «hay que agregar al
 * preliminar cuando se paga con cheque o con qué banco se debe pagar»). Lo que falta se NOMBRA.
 */
const salida = (alloc: unknown[]): string =>
  (svc as unknown as { tablaSalida(a: unknown[]): string }).tablaSalida(alloc);
const pagaDe = (html: string): string => ((/<div class="paga[^"]*">([\s\S]*?)<\/div>/.exec(html) ?? ['', ''])[1]).replace(/<[^>]+>/g, '');

describe('[PGP.68] cómo se paga', () => {
  it('⭐ un cheque dice el BANCO y el NÚMERO de cheque', () => {
    const html = tabla([pago({ payment_method: 'cheque', bank_account_label: 'BB 4166', reference_text: '5362', destination_account_text: null })], [linea()]);
    expect(pagaDe(html)).toBe('CHEQUE · Banco: BB 4166 · cheque núm. 5362');
    expect(html).not.toContain('paga falta');
  });
  it('una transferencia dice de qué banco sale y a qué cuenta va', () => {
    expect(pagaDe(tabla([pago()], [linea()]))).toBe('TRANSFERENCIA · Banco: Banorte 3041 · a CLABE 072180001234567890');
  });
  it('⛔ un pago sin preparar dice que FALTA DEFINIR el método y el banco, y se marca', () => {
    const html = tabla([pago({ payment_method: null, bank_account_label: null, destination_account_text: null })], [linea()]);
    expect(pagaDe(html)).toBe('FALTA DEFINIR · método y banco');
    expect(html).toContain('paga falta');
  });
  it('⛔ un cheque sin número o sin banco no se firma como completo', () => {
    expect(comoPaga({ payment_method: 'cheque', bank_account_label: 'BB 4166', reference_text: null } as never))
      .toEqual({ metodo: 'CHEQUE', banco: 'BB 4166', detalle: 'sin número de cheque', falta: true });
    expect(comoPaga({ payment_method: 'cheque', bank_account_label: null, reference_text: '1' } as never).banco).toBe('banco sin elegir');
  });
  it('el efectivo dice la caja, no «Banco»', () => {
    expect(pagaDe(tabla([pago({ payment_method: 'efectivo', bank_account_label: null, cash_register_text: 'Caja General', destination_account_text: null })], [linea()])))
      .toBe('EFECTIVO · Caja: Caja General');
  });
  it('⭐ el resumen suma por método y banco, y deja al final lo que falta definir', () => {
    const html = salida([
      pago({ id: 'A1', amount_assigned: 100 }), pago({ id: 'A2', amount_assigned: 250 }),
      pago({ id: 'A3', amount_assigned: 9000, payment_method: null, bank_account_label: null }),
      pago({ id: 'A4', amount_assigned: 400, payment_method: 'cheque', bank_account_label: 'BB 4166', reference_text: '1' }),
    ]);
    const filas = (html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr>[\s\S]*?<\/tr>/g) ?? []).map((f) => f.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|'));
    expect(filas).toEqual([
      '|CHEQUE|BB 4166|1 pago|$400.00|',
      '|TRANSFERENCIA|Banorte 3041|2 pagos|$350.00|',
      '|FALTA DEFINIR|—|1 pago|$9,000.00|',
    ]);
  });
});
