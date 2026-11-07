import type { ConstanciaSituacionFiscal, RegimenFiscalOpcion, SolicitudAltaBody } from '@megadulces/contracts';
import { estadoCorto, fichaDesdeConstancia, fichaVacia, prefijoVialidad, recortesDe } from './ficha-kepler';
import { bloquea, diferenciaDeCredito, estadoInicial, revisarSolicitud, type ContextoRevision } from './alta-clientes.rules';

/** Datos ficticios o públicos (RFC de prueba del SAT, CURP de ejemplo de RENAPO). */
const BASE_DOMICILIO = {
  codigo_postal: '58189', tipo_vialidad: 'AVENIDA (AV.)', vialidad: 'FRANCISCO I MADERO PONIENTE', numero_exterior: '3600',
  numero_interior: null, colonia: 'VICENTE GUERRERO', localidad: 'MORELIA', municipio: 'MORELIA',
  entidad: 'MICHOACAN DE OCAMPO', entre_calle: null, y_calle: null,
};
const FISICA: ConstanciaSituacionFiscal = {
  tipo: 'fisica', rfc: 'CACX7605101P8', curp: 'HEGG560427MVZRRL04', nombre: 'GLORIA', primer_apellido: 'HERNANDEZ',
  segundo_apellido: 'GARCIA', razon_social: null, regimen_capital: null, nombre_comercial: null,
  nombre_fiscal: 'GLORIA HERNANDEZ GARCIA', estatus_padron: 'ACTIVO', inicio_operaciones: null, ultimo_cambio_estado: null,
  domicilio: BASE_DOMICILIO, regimenes: [], emitida_el: '2026-01-28', lugar_emision: null, id_cif: null,
};
const MORAL: ConstanciaSituacionFiscal = {
  ...FISICA, tipo: 'moral', rfc: 'EKU9003173C9', curp: null, nombre: null, primer_apellido: null, segundo_apellido: null,
  razon_social: 'ESCUELA KEMPER URGATE', regimen_capital: 'SOCIEDAD CIVIL', nombre_fiscal: 'ESCUELA KEMPER URGATE',
  domicilio: { ...BASE_DOMICILIO, codigo_postal: '58000', tipo_vialidad: 'CALLE', vialidad: 'BELISARIO DOMINGUEZ', numero_exterior: '30', numero_interior: '6', colonia: 'MORELIA CENTRO', localidad: null },
};

describe('fichaDesdeConstancia — la forma «Datos del cliente» de Kepler', () => {
  it('persona física: el mismo acomodo que la ficha real de la captura', () => {
    const { ficha, recortes } = fichaDesdeConstancia(FISICA);
    expect(ficha).toMatchObject({
      nombre: 'GLORIA HERNANDEZ GARCIA',
      direccion_1: 'AV. FRANCISCO I MADERO PONIENTE 3600',
      direccion_2: 'VICENTE GUERRERO MORELIA',
      estado: 'MICHOACAN',
      codigo_postal: '58189', rfc: 'CACX7605101P8', curp: 'HEGG560427MVZRRL04',
      email: '', telefono_1: '',
    });
    expect(recortes).toEqual([]);
  });

  it('persona moral: sin CURP, sin «CALLE», con interior y municipio cuando no hay localidad', () => {
    const { ficha } = fichaDesdeConstancia(MORAL);
    expect(ficha).toMatchObject({
      nombre: 'ESCUELA KEMPER URGATE', direccion_1: 'BELISARIO DOMINGUEZ 30 INT 6', direccion_2: 'MORELIA CENTRO MORELIA', curp: '',
    });
  });

  it('lo que no cabe en 40 se reporta con lo que entra; la ficha conserva el valor completo', () => {
    const larga = { ...FISICA, domicilio: { ...BASE_DOMICILIO, vialidad: 'PROLONGACION LIBRAMIENTO SUR PONIENTE DEL ESTADO' } };
    const { ficha, recortes } = fichaDesdeConstancia(larga);
    expect(ficha.direccion_1).toBe('AV. PROLONGACION LIBRAMIENTO SUR PONIENTE DEL ESTADO 3600');
    expect(recortes).toEqual([{ casilla: 'direccion_1', completo: ficha.direccion_1, cabe: ficha.direccion_1.slice(0, 40), largo: 40 }]);
  });

  it('estado y prefijo de vialidad', () => {
    expect(estadoCorto('Michoacán de Ocampo')).toBe('MICHOACAN');
    expect(estadoCorto('JALISCO')).toBe('JALISCO');
    expect(prefijoVialidad('BOULEVARD (BLVD.)')).toBe('BLVD.');
    expect(prefijoVialidad('CALLE')).toBe('');
    expect(prefijoVialidad('PRIVADA')).toBe('PRIVADA');
    expect(recortesDe(fichaVacia())).toEqual([]);
  });
});

const REGIMENES: RegimenFiscalOpcion[] = [
  { clave: '601', descripcion: 'General de Ley Personas Morales', persona_fisica: false, persona_moral: true },
  { clave: '612', descripcion: 'Personas Físicas con Actividades Empresariales y Profesionales', persona_fisica: true, persona_moral: false },
  { clave: '626', descripcion: 'Régimen Simplificado de Confianza', persona_fisica: true, persona_moral: true },
];
const CTX: ContextoRevision = { regimenes: REGIMENES, cp_existe: true, vendedor_existe: true, grupo_existe: true, zona_existe: true };

function solicitud(extra: Partial<SolicitudAltaBody> = {}): SolicitudAltaBody {
  const { ficha } = fichaDesdeConstancia(FISICA);
  return {
    branch: '07', origen: 'constancia', tipo_persona: 'fisica', rfc: 'CACX7605101P8', curp: 'HEGG560427MVZRRL04',
    nombre_fiscal: 'GLORIA HERNANDEZ GARCIA', regimen_fiscal: '612', codigo_postal_fiscal: '58189', ficha,
    vendedor_code: '20001', grupo_code: '2VP02', zona_code: '20000', ...extra,
  };
}
const campos = (b: SolicitudAltaBody, ctx = CTX, g: 'bloquea' | 'aviso' = 'bloquea') =>
  revisarSolicitud(b, ctx).filter((h) => h.gravedad === g).map((h) => h.campo);

describe('revisarSolicitud', () => {
  it('una solicitud completa de contado no bloquea y entra lista para Kepler', () => {
    const b = solicitud();
    expect(bloquea(revisarSolicitud(b, CTX))).toBe(false);
    expect(estadoInicial(b)).toBe('lista_para_kepler');
    // RFC y CURP de este caso son de dos anclas públicas distintas: el aviso de que no empiezan igual es correcto.
    expect(campos(b, CTX, 'aviso')).toEqual(['curp']);
  });

  it('pedir crédito, plazo o descuento la manda a Crédito y Cobranza', () => {
    expect(estadoInicial(solicitud({ credito_solicitado: 5000, plazo_dias: 15 }))).toBe('credito_por_aprobar');
    expect(estadoInicial(solicitud({ descuento_pct: 2 }))).toBe('credito_por_aprobar');
    expect(campos(solicitud({ credito_solicitado: 5000 }), CTX, 'aviso')).toContain('plazo_dias');
  });

  it('bloquea un RFC con un carácter cambiado y el RFC de la ficha distinto', () => {
    expect(campos(solicitud({ rfc: 'CACX7605101P9' }))).toEqual(expect.arrayContaining(['rfc', 'ficha.rfc']));
  });

  it('bloquea el tipo de persona que no corresponde al RFC y la CURP en persona moral', () => {
    expect(campos(solicitud({ tipo_persona: 'moral', regimen_fiscal: '601' }))).toEqual(expect.arrayContaining(['tipo_persona', 'curp']));
  });

  it('bloquea un régimen que no es para ese tipo de persona, o que no existe', () => {
    expect(campos(solicitud({ regimen_fiscal: '601' }))).toContain('regimen_fiscal');
    expect(campos(solicitud({ regimen_fiscal: '999' }))).toContain('regimen_fiscal');
    expect(campos(solicitud({ regimen_fiscal: '626' }))).not.toContain('regimen_fiscal');
  });

  it('el CP: 5 dígitos, en el catálogo; si no se pudo consultar, se avisa y no se da por bueno', () => {
    expect(campos(solicitud({ codigo_postal_fiscal: '5818' }))).toContain('codigo_postal_fiscal');
    expect(campos(solicitud(), { ...CTX, cp_existe: false })).toContain('codigo_postal_fiscal');
    expect(campos(solicitud(), { ...CTX, cp_existe: null }, 'aviso')).toContain('codigo_postal_fiscal');
  });

  it('el genérico se acepta con aviso (no se le factura a su nombre)', () => {
    const b = solicitud({ rfc: 'XAXX010101000', curp: null, ficha: { ...solicitud().ficha, rfc: 'XAXX010101000' } });
    expect(bloquea(revisarSolicitud(b, CTX))).toBe(false);
    expect(campos(b, CTX, 'aviso')).toContain('rfc');
  });

  it('persona moral con «SA DE CV» pegado al nombre: aviso del CFDI 4.0', () => {
    const { ficha } = fichaDesdeConstancia(MORAL);
    const b = solicitud({ tipo_persona: 'moral', rfc: 'EKU9003173C9', curp: null, nombre_fiscal: 'ESCUELA KEMPER URGATE SA DE CV', regimen_fiscal: '601', ficha });
    expect(bloquea(revisarSolicitud(b, CTX))).toBe(false);
    expect(campos(b, CTX, 'aviso')).toContain('nombre_fiscal');
  });

  it('catálogos de Kepler: un código que no existe en la sucursal bloquea; faltar sólo avisa', () => {
    expect(campos(solicitud(), { ...CTX, zona_existe: false })).toContain('zona_code');
    expect(campos(solicitud({ vendedor_code: null }), CTX, 'aviso')).toContain('kepler');
  });

  it('montos imposibles y correo mal formado', () => {
    const f = solicitud().ficha;
    expect(campos(solicitud({ credito_solicitado: -1, plazo_dias: 1.5, descuento_pct: 120, ficha: { ...f, email: 'no-es-correo' } })))
      .toEqual(expect.arrayContaining(['credito_solicitado', 'plazo_dias', 'descuento_pct', 'ficha.email']));
  });

  it('[ALC.3.5] la ubicación es opcional; si viene, imposible bloquea y fuera de México avisa', () => {
    expect(campos(solicitud({ ubicacion: null }))).not.toContain('ubicacion');
    // La Piedad, del GPS: ni bloquea ni avisa.
    const ok = solicitud({ ubicacion: { lat: 20.3456, lng: -102.0312, origen: 'gps', precision_m: 8 } });
    expect([...campos(ok), ...campos(ok, CTX, 'aviso')]).not.toContain('ubicacion');
    expect(campos(solicitud({ ubicacion: { lat: 120, lng: -102, origen: 'mapa' } }))).toContain('ubicacion');
    // Madrid: posible, pero no aquí.
    expect(campos(solicitud({ ubicacion: { lat: 40.4168, lng: -3.7038, origen: 'direccion' } }), CTX, 'aviso')).toContain('ubicacion');
  });
});

describe('diferenciaDeCredito — al ligar, lo de Kepler contra lo aprobado', () => {
  const aprobado = { credito: { decision: 'aprobado' as const, por: 'u', por_nombre: null, el: '', motivo: 'ok', credito_aprobado: 3000, plazo_aprobado: 15, descuento_aprobado: 0 } };
  it('igual a lo aprobado (con números como texto, como llegan de Kepler): sin nota', () => {
    expect(diferenciaDeCredito(aprobado, { nombre: 'X', rfc: null, limite: '3000.00', plazo: '15', descuento: '0' })).toBeNull();
  });
  it('distinto: la nota dice las dos versiones, con pesos', () => {
    expect(diferenciaDeCredito(aprobado, { nombre: 'X', rfc: null, limite: 5000, plazo: 30, descuento: '2.5' }))
      .toBe('Al ligar: Kepler tiene límite $5,000.00, plazo 30 días y descuento 2.5 %; lo aprobado era $3,000.00, 15 días y 0 %.');
  });
  it('de contado (sin decisión) se espera 0 / 0 / 0; con crédito en Kepler, se avisa', () => {
    expect(diferenciaDeCredito({ credito: null }, { nombre: 'X', rfc: null, limite: 0, plazo: 0, descuento: '' })).toBeNull();
    expect(diferenciaDeCredito({ credito: null }, { nombre: 'X', rfc: null, limite: 1000, plazo: 0, descuento: '' })).toMatch(/lo esperado \(de contado\)/);
  });
});
