import type { ConstanciaSituacionFiscal, OpcionCatalogo, RegimenFiscalOpcion, UsoCfdiOpcion } from '@megadulces/contracts';
import { leerConfigLecturaAlta } from './lectura-documento.config';
import {
  claveDeCatalogo, correccionesDe, formaPagoDeTexto, fusionarConConstancia, lecturaDocumentoDesdeModelo,
  propuestaDesdeLectura, usoCfdiDeTexto, type PropuestaGuardada,
} from './lectura-documento';
import { CAMPOS_LEIDOS, ESQUEMA_LECTURA_ALTA } from './lectura-documento.schema';

/**
 * `[ALC.4.2]` La lectura con IA de fotos y capturas, revisada por código. Los casos imitan lo que llegó
 * de verdad (una etiqueta pegada, la captura de Wincaja, la pantalla de otro ERP, las hojas de la
 * constancia en foto) con datos FICTICIOS: RFC de prueba del SAT y la CURP de ejemplo de RENAPO. Los
 * documentos reales no van al repo (es público).
 */

const REGIMENES: RegimenFiscalOpcion[] = [
  { clave: '603', descripcion: 'Personas Morales con Fines no Lucrativos', persona_fisica: false, persona_moral: true },
  { clave: '612', descripcion: 'Personas Físicas con Actividades Empresariales y Profesionales', persona_fisica: true, persona_moral: false },
  { clave: '616', descripcion: 'Sin obligaciones fiscales', persona_fisica: true, persona_moral: false },
  { clave: '626', descripcion: 'Régimen Simplificado de Confianza', persona_fisica: true, persona_moral: true },
];
const USOS: UsoCfdiOpcion[] = [
  { clave: 'G01', descripcion: 'Adquisición de mercancías.', regimenes: ['603', '612', '626'] },
  { clave: 'G03', descripcion: 'Gastos en general.', regimenes: ['603', '612', '626'] },
  { clave: 'S01', descripcion: 'Sin efectos fiscales.', regimenes: ['603', '612', '616', '626'] },
];
const FORMAS: OpcionCatalogo[] = [
  { clave: '01', nombre: 'Efectivo' }, { clave: '03', nombre: 'Transferencia electrónica de fondos' },
  { clave: '04', nombre: 'Tarjeta de crédito' }, { clave: '28', nombre: 'Tarjeta de débito' }, { clave: '99', nombre: 'Por definir' },
];
const CAT = { regimenes: REGIMENES, usos: USOS, formas: FORMAS };

/** Lo que devolvería el modelo: todos los campos en "" salvo los que se pasan. */
function modelo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tipo_documento: 'etiqueta_o_nota', legible: 'si', tipo_persona: 'fisica',
    ...Object.fromEntries(CAMPOS_LEIDOS.map((c) => [c, ''])),
    regimenes: [], dudosos: [], avisos: [], ...over,
  };
}
const leer = (over: Record<string, unknown> = {}) => {
  const l = lecturaDocumentoDesdeModelo(modelo(over));
  if (!l) throw new Error('lectura inválida');
  return propuestaDesdeLectura(l, CAT);
};
const campos = (p: ReturnType<typeof leer>) => p.hallazgos.map((h) => h.campo);

describe('[ALC.4.1] el esquema cabe en structured outputs', () => {
  it('cero uniones (el límite es 16) y todo objeto cerrado', () => {
    const json = JSON.stringify(ESQUEMA_LECTURA_ALTA);
    expect((json.match(/"anyOf"/g) ?? []).length).toBe(0);
    expect(json).not.toMatch(/"type":\[/);
    const cerrados = (s: unknown): boolean => {
      if (!s || typeof s !== 'object') return true;
      const o = s as Record<string, unknown>;
      if (o['type'] === 'object') {
        const props = Object.keys(o['properties'] as object);
        if (o['additionalProperties'] !== false || JSON.stringify([...(o['required'] as string[])].sort()) !== JSON.stringify(props.sort())) return false;
      }
      return Object.values(o).every(cerrados);
    };
    expect(cerrados(ESQUEMA_LECTURA_ALTA)).toBe(true);
  });
});

describe('[ALC.4.2] lo que copió el modelo, revisado por código', () => {
  it('una etiqueta pegada: RFC válido, régimen y uso del catálogo; «pago con tarjeta» NO se adivina', () => {
    const p = leer({
      rfc: 'CACX7605101P8', nombres: 'Cliente de Prueba Uno', vialidad: 'Calzada Ficticia', numero_exterior: '402',
      colonia: 'Colonia Ficticia', municipio: 'Morelia', entidad: 'Michoacán', codigo_postal: '58000',
      email: 'cliente.prueba@example.com', uso_cfdi: 'GASTOS EN GENERAL', forma_pago: 'PAGO CON TARJETA',
      regimenes: [{ descripcion: 'REGIMEN SIMPLIFICADO DE CONFIANZA', vigente: 'si' }],
    });
    expect(p.constancia).toMatchObject({ tipo: 'fisica', rfc: 'CACX7605101P8', nombre_fiscal: 'CLIENTE DE PRUEBA UNO' });
    expect(p.constancia.domicilio).toMatchObject({ codigo_postal: '58000', colonia: 'Colonia Ficticia', entidad: 'Michoacán' });
    expect(p.regimenes_vigentes).toEqual(['626']);
    expect(p.uso_cfdi).toBe('G03');
    expect(p.forma_pago).toBeNull();
    expect(p.hallazgos.find((h) => h.campo === 'forma_pago')?.mensaje).toMatch(/crédito \(04\) o de débito \(28\)/);
    expect(p.email).toBe('cliente.prueba@example.com');
  });

  it('la captura de Wincaja: sin RFC (genérico), clave anterior a comentarios, sin apellidos separados', () => {
    const p = leer({
      tipo_documento: 'captura_de_sistema', rfc: 'XAXX010101000', nombres: 'CLIENTE DE PRUEBA DOS',
      colonia: 'COLONIA FICTICIA', localidad: 'LA PIEDAD', codigo_postal: '59300', telefono: '453 000 0000',
      clave_en_otro_sistema: '900001',
    });
    expect(p.constancia).toMatchObject({ tipo: 'fisica', rfc: 'XAXX010101000', nombre_fiscal: 'CLIENTE DE PRUEBA DOS' });
    expect(p.telefono).toBe('4530000000');
    expect(p.comentario).toBe('Clave en el sistema anterior: 900001');
    expect(campos(p)).not.toContain('rfc');
  });

  it('la pantalla de otro ERP (persona moral): régimen, uso y forma por su texto; método de pago a comentarios', () => {
    const p = leer({
      tipo_documento: 'captura_de_sistema', tipo_persona: 'moral', rfc: 'EKU9003173C9', razon_social: 'ESCUELA KEMPER URGATE',
      uso_cfdi: 'Gastos en general', forma_pago: 'Efectivo', metodo_pago: 'Pago en una sola exhibición',
      regimenes: [{ descripcion: 'Personas Morales con Fines no Lucrativos', vigente: 'no_se' }],
    });
    expect(p.constancia).toMatchObject({ tipo: 'moral', nombre_fiscal: 'ESCUELA KEMPER URGATE', curp: null });
    expect(p.regimenes_vigentes).toEqual(['603']);
    expect([p.uso_cfdi, p.forma_pago]).toEqual(['G03', '01']);
    expect(p.comentario).toBe('Método de pago en el documento: Pago en una sola exhibición');
  });

  it('las hojas de la constancia en foto: nombre por partes, el régimen con su clave escrita', () => {
    const p = leer({
      tipo_documento: 'constancia_sat', rfc: 'CACX7605101P8', curp: 'HEGG560427MVZRRL04',
      nombres: 'GLORIA', primer_apellido: 'HERNANDEZ', segundo_apellido: 'GARCIA', fecha_emision: '2026-07-14',
      regimenes: [
        { descripcion: 'Régimen de Sueldos y Salarios e Ingresos Asimilados a Salarios', vigente: 'si' },
        { descripcion: '612 - Personas Físicas con Actividades Empresariales y Profesionales', vigente: 'si' },
      ],
    });
    expect(p.constancia).toMatchObject({ nombre_fiscal: 'GLORIA HERNANDEZ GARCIA', emitida_el: '2026-07-14' });
    // Sueldos y salarios (605) no está en este catálogo: se dice; el 612 entra por su clave escrita.
    expect(p.regimenes_vigentes).toEqual(['612']);
    expect(campos(p)).toContain('regimen_fiscal');
  });

  it('NEGATIVA: un RFC con el verificador mal se propone, pero con su aviso (y al guardar bloquea la regla)', () => {
    const p = leer({ rfc: 'CACX7605101P9', nombres: 'X' });
    expect(p.constancia.rfc).toBe('CACX7605101P9');
    expect(p.hallazgos.find((h) => h.campo === 'rfc')?.mensaje).toMatch(/La IA leyó «CACX7605101P9»/);
  });

  it('lo dudoso se avisa en SU casilla; un relleno («N/A») es vacío', () => {
    const p = leer({ rfc: 'CACX7605101P8', codigo_postal: 'N/A', email: 'n/a', dudosos: ['rfc', 'codigo_postal', 'colonia'] });
    expect(p.constancia.domicilio.codigo_postal).toBeNull();
    expect(p.email).toBeNull();
    expect(campos(p)).toEqual(expect.arrayContaining(['rfc', 'codigo_postal_fiscal', 'ficha.direccion_2']));
    expect(p.faltantes).toContain('el código postal');
  });

  it('NEGATIVA: una respuesta sin la forma del esquema no es lectura', () => {
    expect(lecturaDocumentoDesdeModelo({ ...modelo(), legible: undefined })).toBeNull();
    expect(lecturaDocumentoDesdeModelo({ ...modelo(), rfc: 123 })).toBeNull();
    expect(lecturaDocumentoDesdeModelo({ ...modelo(), regimenes: 'x' })).toBeNull();
    expect(lecturaDocumentoDesdeModelo('{}')).toBeNull();
  });
});

describe('[ALC.4.2] catálogos: nunca «el más parecido»', () => {
  it('por clave escrita, por descripción exacta o contenida ÚNICA', () => {
    expect(usoCfdiDeTexto('G01 - Adquisición de mercancías', USOS)).toBe('G01');
    expect(usoCfdiDeTexto('sin efectos fiscales', USOS)).toBe('S01');
    expect(formaPagoDeTexto('03', FORMAS)).toEqual({ clave: '03', ambigua: false });
    expect(formaPagoDeTexto('Transferencia', FORMAS)).toEqual({ clave: '03', ambigua: false });
    expect(formaPagoDeTexto('Tarjeta de débito', FORMAS)).toEqual({ clave: '28', ambigua: false });
  });

  it('NEGATIVA: dos candidatas = ninguna', () => {
    expect(claveDeCatalogo('TARJETA DE', FORMAS.map((f) => ({ clave: f.clave, descripcion: f.nombre })), /\b\d{2}\b/)).toBeNull();
    expect(usoCfdiDeTexto('algo que no existe', USOS)).toBeNull();
  });
});

const OFICIAL: ConstanciaSituacionFiscal = {
  tipo: 'fisica', rfc: 'CACX7605101P8', curp: null, nombre: 'GLORIA', primer_apellido: 'HERNANDEZ', segundo_apellido: 'GARCIA',
  razon_social: null, regimen_capital: null, nombre_comercial: null, nombre_fiscal: 'GLORIA HERNANDEZ GARCIA',
  estatus_padron: 'ACTIVO', inicio_operaciones: null, ultimo_cambio_estado: null,
  domicilio: { codigo_postal: '58000', tipo_vialidad: 'CALLE', vialidad: 'PRUEBA', numero_exterior: '1', numero_interior: null,
    colonia: null, localidad: null, municipio: 'MORELIA', entidad: 'MICHOACAN DE OCAMPO', entre_calle: null, y_calle: null },
  regimenes: [{ descripcion: 'Régimen Simplificado de Confianza', desde: null, hasta: null, vigente: true }],
  emitida_el: '2026-11-01', lugar_emision: null, id_cif: null,
};

describe('[ALC.4.2] la constancia del SAT (leída sin IA) gana', () => {
  it('la IA sólo llena huecos; un RFC distinto se avisa y gana el oficial', () => {
    const ia = { ...OFICIAL, rfc: 'EKU9003173C9', curp: 'HEGG560427MVZRRL04', domicilio: { ...OFICIAL.domicilio, colonia: 'CENTRO', municipio: 'OTRO' } };
    const f = fusionarConConstancia(OFICIAL, ia);
    expect(f.constancia).toMatchObject({ rfc: 'CACX7605101P8', curp: 'HEGG560427MVZRRL04' });
    expect(f.constancia.domicilio).toMatchObject({ colonia: 'CENTRO', municipio: 'MORELIA' });
    expect(f.hallazgos.map((h) => h.campo)).toEqual(['rfc']);
  });
});

describe('[ALC.4.4] la medición: qué corrigió la persona', () => {
  it('corregido = la máquina propuso y se cambió; completado = venía vacío y se llenó; una coma no cuenta', () => {
    const p: PropuestaGuardada = {
      tipo_persona: 'fisica', rfc: 'CACX7605101P8', curp: '', nombre_fiscal: 'GLORIA HERNANDEZ GARCIA', regimen_fiscal: '626',
      codigo_postal_fiscal: '58000', uso_cfdi: 'G03', forma_pago: '', ficha: { nombre: 'GLORIA HERNANDEZ GARCIA', direccion_2: 'CENTRO, MORELIA' },
      rfc_oficial: null, emitida_el: null, que_se_leyo: null, lectura_oficial: null,
    };
    const c = correccionesDe(p, {
      rfc: 'CACX7605101P8', curp: null, nombre_fiscal: 'GLORIA HERNANDEZ GARCÍA', regimen_fiscal: '612',
      codigo_postal_fiscal: '58000', uso_cfdi: 'G03', forma_pago: '01',
      ficha: { nombre: 'GLORIA HERNANDEZ GARCIA', direccion_2: 'CENTRO MORELIA', telefono_1: '4430000000' },
    });
    expect(c.corregidos).toEqual(['regimen_fiscal']);
    expect(c.completados).toEqual(['forma_pago', 'ficha.telefono_1']);
  });
});

describe('[ALC.4.3] la configuración: apagada por default', () => {
  it('sólo «true» enciende; el modelo por default es el más capaz', () => {
    expect(leerConfigLecturaAlta({}).habilitada).toBe(false);
    expect(leerConfigLecturaAlta({ ALC_AI_ENABLED: '1' }).habilitada).toBe(false);
    expect(leerConfigLecturaAlta({ ALC_AI_ENABLED: 'true' })).toMatchObject({ habilitada: true, modelo: 'claude-opus-5-5', effort: 'medium', topeDiario: 60 });
  });

  it('NEGATIVA: un tope mal escrito es 0 lecturas, no uno más caro; Haiku 4.5 sin effort', () => {
    const c = leerConfigLecturaAlta({ ALC_AI_DAILY_CAP: 'mucho' });
    expect(c.topeDiario).toBe(0);
    expect(c.advertencias).toHaveLength(1);
    expect(leerConfigLecturaAlta({ ALC_AI_MODEL: 'claude-haiku-4-5' }).effort).toBeNull();
  });
});
