import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { claveDeRegimen, fechaConDiagonales, fechaEnLetra, leerConstanciaPdf, type RegimenDeCatalogo } from './constancia-situacion-fiscal';
import { agruparRenglones, leerTextoPdf } from './pdf-texto';
import { digitoVerificadorRfc } from './identidad-fiscal';

/**
 * `[ALC.1.1]` Constancias SINTÉTICAS con el acomodo medido en dos constancias reales del SAT
 * (2026-11-04, no versionadas): rótulo en negritas y valor en letra normal, **palabra por palabra**;
 * tabla de identificación con el valor en x=236, domicilio con el valor pegado al rótulo, recuadro
 * de emisión a la derecha del de la cédula (sus renglones se intercalan en altura) y la tabla de
 * regímenes con sus fechas en x=455 / x=522. Datos ficticios o públicos (RFC de prueba del SAT,
 * CURP de ejemplo de RENAPO).
 */

interface Fuentes { normal: PDFFont; negrita: PDFFont }

/** Dibuja cada palabra por separado, como lo hace el generador del SAT. Devuelve la x final. */
function palabras(p: PDFPage, texto: string, x: number, y: number, font: PDFFont, size = 8): number {
  let cx = x;
  for (const w of texto.split(' ').filter(Boolean)) {
    p.drawText(w, { x: cx, y, size, font, color: rgb(0, 0, 0) });
    cx += font.widthOfTextAtSize(`${w} `, size);
  }
  return cx;
}

/** Rótulo + valor pegado, como el domicilio («Código Postal:58000»). */
function pegados(p: PDFPage, f: Fuentes, rotulo: string, valor: string, x: number, y: number): void {
  let cx = x;
  const ws = rotulo.split(' ');
  ws.forEach((w, i) => {
    p.drawText(w, { x: cx, y, size: 8, font: f.negrita });
    cx += f.negrita.widthOfTextAtSize(i < ws.length - 1 ? `${w} ` : w, 8);
  });
  if (valor) palabras(p, valor, cx, y, f.normal);
}

interface Sintetica {
  tipo: 'fisica' | 'moral';
  rfc: string;
  identificacion: Array<[string, string | string[]]>;
  domicilio: Array<[string, string]>;
  yCalle: string;
  /** Pone «Y Calle:» arriba de la página 2, como la constancia de persona física. */
  yCalleEnPagina2?: boolean;
  regimenes: Array<{ lineas: string[]; desde: string; hasta?: string }>;
  emision: [string, string];
}

async function constanciaSintetica(s: Sintetica): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setProducer('Oracle XML Publisher 5.6.2');
  const f: Fuentes = { normal: await doc.embedFont(StandardFonts.Helvetica), negrita: await doc.embedFont(StandardFonts.HelveticaBold) };
  const p1 = doc.addPage([612, 792]);
  palabras(p1, 'CÉDULA DE IDENTIFICACIÓN FISCAL', 64, 692.9, f.negrita, 10);
  palabras(p1, 'CONSTANCIA DE SITUACIÓN FISCAL', 339, 637, f.negrita, 12);
  // Recuadro de la cédula (izquierda) y de emisión (derecha): alturas intercaladas.
  palabras(p1, s.rfc, 187, 634.9, f.normal);
  palabras(p1, 'Registro Federal de Contribuyentes', 154, 625.4, f.normal);
  palabras(p1, 'NOMBRE DE LA CEDULA', 188, 604, f.normal);
  palabras(p1, 'Lugar y Fecha de Emisión', 386, 598.9, f.normal, 10);
  palabras(p1, 'Nombre, denominación o razón', 161, 594.5, f.normal);
  palabras(p1, s.emision[0], 316, 587, f.negrita, 10);
  palabras(p1, 'social', 207, 585.2, f.normal);
  palabras(p1, s.emision[1], 425, 575.1, f.negrita, 10);
  palabras(p1, 'idCIF: 12345678901', 181, 563.8, f.normal);
  palabras(p1, 'VALIDA TU INFORMACIÓN', 166, 554.3, f.normal);
  palabras(p1, 'FISCAL', 203, 545, f.normal);

  palabras(p1, 'Datos de Identificación del Contribuyente:', 31, 497.3, f.negrita, 10);
  let y = 476.8;
  for (const [rotulo, valor] of s.identificacion) {
    palabras(p1, rotulo, 36, y, f.negrita);
    const lineas = Array.isArray(valor) ? valor : [valor];
    lineas.forEach((l, i) => palabras(p1, l, 236, y - i * 9.5, f.normal));
    y -= 21.85 + (lineas.length - 1) * 9.5;
  }
  y -= 12;
  palabras(p1, 'Datos del domicilio registrado', 31, y, f.negrita, 10);
  y -= 20.7;
  for (let i = 0; i < s.domicilio.length; i += 2) {
    pegados(p1, f, s.domicilio[i][0], s.domicilio[i][1], 36, y);
    if (s.domicilio[i + 1]) pegados(p1, f, s.domicilio[i + 1][0], s.domicilio[i + 1][1], 311, y);
    y -= 21.85;
  }
  if (!s.yCalleEnPagina2) { pegados(p1, f, 'Y Calle:', s.yCalle, 35, y); y -= 34; palabras(p1, 'Actividades Económicas:', 31, y, f.negrita, 10); }
  palabras(p1, 'Página [1] de [2]', 515, 127.9, f.negrita);

  const p2 = doc.addPage([612, 792]);
  let y2 = 720;
  if (s.yCalleEnPagina2) { pegados(p2, f, 'Y Calle:', s.yCalle, 35, y2); y2 -= 25; palabras(p2, 'Actividades Económicas:', 31, y2, f.negrita, 10); }
  y2 -= 25;
  palabras(p2, 'Orden Actividad Económica Porcentaje Fecha Inicio Fecha Fin', 38, y2, f.negrita, 10);
  palabras(p2, '1 Comercio al por mayor de dulces 100 01/01/2020', 31, y2 - 12, f.normal);
  y2 -= 50;
  palabras(p2, 'Regímenes:', 31, y2, f.negrita, 10);
  y2 -= 19;
  palabras(p2, 'Régimen', 214, y2, f.negrita, 10); palabras(p2, 'Fecha Inicio', 446, y2, f.negrita, 10); palabras(p2, 'Fecha Fin', 522, y2, f.negrita, 10);
  y2 -= 12.2;
  for (const r of s.regimenes) {
    r.lineas.forEach((l, i) => palabras(p2, l, 31, y2 - i * 9.3, f.normal));
    palabras(p2, r.desde, 455, y2, f.normal);
    if (r.hasta) palabras(p2, r.hasta, 522, y2, f.normal);
    y2 -= 21.8 + (r.lineas.length - 1) * 9.3;
  }
  y2 -= 18;
  palabras(p2, 'Obligaciones:', 31, y2, f.negrita, 10);
  palabras(p2, 'Pago definitivo mensual de IVA. 01/01/2020', 31, y2 - 30, f.normal);
  palabras(p2, 'Página [2] de [2]', 515, 127.9, f.negrita);
  return doc.save();
}

const RFC_FISICA = `HEGG560427AB${digitoVerificadorRfc('HEGG560427AB')}`;

const FISICA: Sintetica = {
  tipo: 'fisica', rfc: RFC_FISICA,
  identificacion: [
    ['RFC:', RFC_FISICA], ['CURP:', 'HEGG560427MVZRRL04'], ['Nombre (s):', 'GLORIA'], ['Primer Apellido:', 'HERNANDEZ'],
    ['Segundo Apellido:', 'GARCIA'], ['Fecha inicio de operaciones:', '05 DE AGOSTO DE 2002'], ['Estatus en el padrón:', 'ACTIVO'],
    ['Fecha de último cambio de estado:', '05 DE AGOSTO DE 2002'], ['Nombre Comercial:', ''],
  ],
  domicilio: [
    ['Código Postal:', '58189'], ['Tipo de Vialidad:', 'AVENIDA (AV.)'],
    ['Nombre de Vialidad:', 'FRANCISCO I MADERO PONIENTE'], ['Número Exterior:', '3600'],
    ['Número Interior:', ''], ['Nombre de la Colonia:', 'VICENTE GUERRERO'],
    ['Nombre de la Localidad:', 'MORELIA'], ['Nombre del Municipio o Demarcación Territorial:', 'MORELIA'],
    ['Nombre de la Entidad Federativa:', 'MICHOACAN DE OCAMPO'], ['Entre Calle:', 'CALLE CUILALPAN'],
  ],
  yCalle: 'AVENIDA PATRIA', yCalleEnPagina2: true,
  regimenes: [
    { lineas: ['Régimen de las Personas Físicas con Actividades Empresariales y Profesionales'], desde: '01/05/2012' },
    { lineas: ['Régimen de Sueldos y Salarios e Ingresos Asimilados a Salarios'], desde: '04/01/2016' },
    { lineas: ['Régimen de Incorporación Fiscal'], desde: '01/01/2014', hasta: '31/12/2021' },
  ],
  emision: ['MORELIA , MICHOACAN DE OCAMPO A 28 DE ENERO', 'DE 2026'],
};

const MORAL: Sintetica = {
  tipo: 'moral', rfc: 'EKU9003173C9',
  identificacion: [
    ['RFC:', 'EKU9003173C9'],
    ['Denominación/Razón Social:', ['ESCUELA KEMPER URGATE DE ESTUDIOS SUPERIORES', 'Y TECNOLOGICOS DEL BAJIO']],
    ['Régimen Capital:', 'SOCIEDAD CIVIL'], ['Nombre Comercial:', 'KEMPER'],
    ['Fecha inicio de operaciones:', '17 DE SEPTIEMBRE DE 2020'], ['Estatus en el padrón:', 'ACTIVO'],
    ['Fecha de último cambio de estado:', '17 DE SEPTIEMBRE DE 2020'],
  ],
  domicilio: [
    ['Código Postal:', '58000'], ['Tipo de Vialidad:', 'CALLE'],
    ['Nombre de Vialidad:', 'BELISARIO DOMINGUEZ'], ['Número Exterior:', '30'],
    ['Número Interior:', '6'], ['Nombre de la Colonia:', 'MORELIA CENTRO'],
    ['Nombre de la Localidad:', ''], ['Nombre del Municipio o Demarcación Territorial:', 'MORELIA'],
    ['Nombre de la Entidad Federativa:', 'MICHOACAN DE OCAMPO'], ['Entre Calle:', 'CALLE AQUILES SERDAN'],
  ],
  yCalle: 'CALLE FRANCISCO I. MADERO',
  regimenes: [
    { lineas: ['Régimen de las Actividades Empresariales con ingresos a través de', 'Plataformas Tecnológicas'], desde: '01/06/2020' },
    { lineas: ['Régimen General de Ley Personas Morales'], desde: '17/09/2020' },
  ],
  emision: ['MORELIA , MICHOACAN DE OCAMPO A 02 DE JUNIO', 'DE 2026'],
};

const CATALOGO: RegimenDeCatalogo[] = [
  { clave: '601', descripcion: 'General de Ley Personas Morales', persona_fisica: false, persona_moral: true },
  { clave: '605', descripcion: 'Sueldos y Salarios e Ingresos Asimilados a Salarios', persona_fisica: true, persona_moral: false },
  { clave: '612', descripcion: 'Personas Físicas con Actividades Empresariales y Profesionales', persona_fisica: true, persona_moral: false },
  { clave: '621', descripcion: 'Incorporación Fiscal', persona_fisica: true, persona_moral: false },
  { clave: '625', descripcion: 'Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas', persona_fisica: true, persona_moral: false },
  { clave: '626', descripcion: 'Régimen Simplificado de Confianza', persona_fisica: true, persona_moral: true },
];

describe('leerConstanciaPdf — persona física', () => {
  it('lee identificación, domicilio (con «Y Calle» en la página 2), emisión y regímenes', async () => {
    const r = await leerConstanciaPdf(await constanciaSintetica(FISICA));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.constancia;
    expect(c).toMatchObject({
      tipo: 'fisica', rfc: RFC_FISICA, curp: 'HEGG560427MVZRRL04',
      nombre: 'GLORIA', primer_apellido: 'HERNANDEZ', segundo_apellido: 'GARCIA', nombre_fiscal: 'GLORIA HERNANDEZ GARCIA',
      razon_social: null, nombre_comercial: null, estatus_padron: 'ACTIVO',
      inicio_operaciones: '2002-08-05', emitida_el: '2026-01-28', lugar_emision: 'MORELIA, MICHOACAN DE OCAMPO', id_cif: '12345678901',
    });
    expect(c.domicilio).toEqual({
      codigo_postal: '58189', tipo_vialidad: 'AVENIDA (AV.)', vialidad: 'FRANCISCO I MADERO PONIENTE', numero_exterior: '3600',
      numero_interior: null, colonia: 'VICENTE GUERRERO', localidad: 'MORELIA', municipio: 'MORELIA',
      entidad: 'MICHOACAN DE OCAMPO', entre_calle: 'CALLE CUILALPAN', y_calle: 'AVENIDA PATRIA',
    });
    expect(c.regimenes.map((x) => [x.desde, x.hasta, x.vigente])).toEqual([
      ['2012-05-01', null, true], ['2016-01-04', null, true], ['2014-01-01', '2021-12-31', false],
    ]);
    expect(r.faltantes).toEqual([]);
    expect(r.avisos).toEqual(['Tiene más de un régimen vigente: hay que elegir con cuál se le factura.']);
  });

  it('cada régimen vigente encuentra su clave del catálogo; el vencido también, pero ya no cuenta', async () => {
    const r = await leerConstanciaPdf(await constanciaSintetica(FISICA));
    if (!r.ok) throw new Error(r.detalle);
    expect(r.constancia.regimenes.map((x) => claveDeRegimen(x.descripcion, CATALOGO)?.clave)).toEqual(['612', '605', '621']);
  });
});

describe('leerConstanciaPdf — persona moral', () => {
  it('une la razón social partida en dos líneas y separa el régimen de capital', async () => {
    const r = await leerConstanciaPdf(await constanciaSintetica(MORAL));
    if (!r.ok) throw new Error(r.detalle);
    expect(r.constancia).toMatchObject({
      tipo: 'moral', rfc: 'EKU9003173C9', curp: null,
      razon_social: 'ESCUELA KEMPER URGATE DE ESTUDIOS SUPERIORES Y TECNOLOGICOS DEL BAJIO',
      nombre_fiscal: 'ESCUELA KEMPER URGATE DE ESTUDIOS SUPERIORES Y TECNOLOGICOS DEL BAJIO',
      regimen_capital: 'SOCIEDAD CIVIL', nombre_comercial: 'KEMPER', emitida_el: '2026-06-02',
    });
    expect(r.constancia.domicilio).toMatchObject({ numero_interior: '6', localidad: null, y_calle: 'CALLE FRANCISCO I. MADERO' });
  });

  it('un régimen de nombre largo en dos renglones queda en uno solo', async () => {
    const r = await leerConstanciaPdf(await constanciaSintetica(MORAL));
    if (!r.ok) throw new Error(r.detalle);
    expect(r.constancia.regimenes[0].descripcion)
      .toBe('Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas');
    expect(r.constancia.regimenes.map((x) => claveDeRegimen(x.descripcion, CATALOGO)?.clave)).toEqual(['625', '601']);
    expect(r.avisos).toContain('Tiene más de un régimen vigente: hay que elegir con cuál se le factura.');
  });
});

describe('leerConstanciaPdf — lo que NO es una constancia legible se dice, no se adivina', () => {
  it('bytes que no son PDF', async () => {
    expect(await leerConstanciaPdf(new TextEncoder().encode('hola, no soy un pdf'))).toMatchObject({ ok: false, motivo: 'no_es_pdf' });
  });

  it('un PDF sin texto (escaneado o foto)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).drawRectangle({ x: 50, y: 50, width: 200, height: 100, color: rgb(0.5, 0.5, 0.5) });
    expect(await leerConstanciaPdf(await doc.save())).toMatchObject({ ok: false, motivo: 'sin_texto' });
  });

  it('un PDF con texto que no es la constancia del SAT', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([612, 792]).drawText('FACTURA 123 RFC: EKU9003173C9', { x: 50, y: 700, size: 10, font });
    expect(await leerConstanciaPdf(await doc.save())).toMatchObject({ ok: false, motivo: 'no_es_constancia' });
  });

  it('una constancia sin el renglón del RFC', async () => {
    const sinRfc = { ...MORAL, identificacion: MORAL.identificacion.filter(([r]) => r !== 'RFC:') };
    expect(await leerConstanciaPdf(await constanciaSintetica(sinRfc))).toMatchObject({ ok: false, motivo: 'sin_rfc' });
  });

  it('lo que falta se lista en `faltantes` y el estatus no ACTIVO se avisa', async () => {
    const rara: Sintetica = {
      ...MORAL,
      identificacion: MORAL.identificacion.map(([r, v]) => [r, r === 'Estatus en el padrón:' ? 'SUSPENDIDO' : v] as [string, string | string[]]),
      domicilio: MORAL.domicilio.filter(([r]) => r !== 'Código Postal:'),
    };
    const r = await leerConstanciaPdf(await constanciaSintetica(rara));
    if (!r.ok) throw new Error(r.detalle);
    expect(r.faltantes).toContain('código postal');
    expect(r.avisos).toContain('Estatus en el padrón: SUSPENDIDO (no ACTIVO).');
  });
});

describe('leerTextoPdf / agruparRenglones', () => {
  it('pone espacio entre palabras separadas y no entre rótulo y valor pegados', async () => {
    const lectura = await leerTextoPdf(await constanciaSintetica(MORAL));
    if (!lectura.ok) throw new Error(lectura.detalle);
    const textos = agruparRenglones(lectura.trozos, 1).map((r) => r.texto);
    expect(textos).toContain('Código Postal:58000 Tipo de Vialidad:CALLE');
    expect(textos).toContain('RFC: EKU9003173C9');
    expect(lectura.trozos.every((t) => t.ancho !== null)).toBe(true); // Helvetica: métricas estándar
  });
});

describe('fechas', () => {
  it('en letra y con diagonales; una fecha que no existe es null', () => {
    expect(fechaEnLetra('17 DE SEPTIEMBRE DE 2020')).toBe('2020-09-17');
    expect(fechaEnLetra('31 de febrero de 2020')).toBeNull();
    expect(fechaConDiagonales('04/01/2016')).toBe('2016-01-04');
    expect(fechaConDiagonales('2016-01-04')).toBeNull();
  });
});

describe('claveDeRegimen', () => {
  it('sin coincidencia única no inventa clave', () => {
    expect(claveDeRegimen('Régimen de algo que no existe', CATALOGO)).toBeNull();
    expect(claveDeRegimen('', CATALOGO)).toBeNull();
    expect(claveDeRegimen('Régimen Simplificado de Confianza', CATALOGO)?.clave).toBe('626');
  });
});
