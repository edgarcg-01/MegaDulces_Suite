/**
 * `[RH.3.3.3]` La solicitud de empleo por chat. Los casos son los de `probar-solicitud.js` de Mega Talento (validadores,
 * basura reportada por RH, respuestas reales que NO deben rechazarse, el recorrido completo con los datos de una
 * solicitud escaneada, la más corta y la más larga, el avance sin total), más el CONSENTIMIENTO de lo sensible.
 */
import {
  PREGUNTAS, K_CONSENTIMIENTO, aplicables, atras, edadDesde, esNoAplica, escolaridad, habilidades, idiomas, nombreCompleto,
  partirNombre, porBloques, progreso, purgarSensibles, responder, siguiente, textoPregunta, vCP, vCURP, vEstatura, vFecha,
  vOpciones, vPeso, vRangoAnios, vTelefono, type CtxSolicitud, type Respuestas,
} from './solicitud';
import { pareceTecleoAlAzar } from './registro';

const HOY = new Date('2026-08-03T12:00:00');
const CONSENT = { version: 'prueba-v1', texto: 'Para esta parte te pido tu consentimiento expreso (salud, familia, economía).' };
const ctx = (o: Partial<CtxSolicitud> = {}): CtxSolicitud => ({
  registro: { position_interest: 'Anaquelista', full_name: 'José Ismael Reynoso Hernández', email: 'jose@gmail.com', rfc: 'LOGA900101AB1', nss: '12345678901', desired_salary: '8000' },
  telefono: '4431185227', consentimiento: CONSENT, hoy: HOY, ...o,
});
const q = (k: string) => {
  const p = PREGUNTAS.find((x) => x.k === k);
  if (!p) throw new Error(`no existe ${k}`);
  return p;
};
const valor = (k: string, t: string, d: Respuestas = {}, c = ctx()) => {
  const r = responder(q(k), t, d, c);
  return 'valor' in r ? r.valor : undefined;
};

describe('[RH.3.3.3] validadores', () => {
  it('fechas, estatura, peso, CURP, teléfono, CP, años y opciones', () => {
    expect(vFecha('02/11/2007', ctx())).toEqual({ ok: true, valor: '02/11/2007' });
    expect(vFecha('2 de noviembre de 2007', ctx())).toEqual({ ok: true, valor: '02/11/2007' });
    expect(vFecha('2-11-2007', ctx())).toEqual({ ok: true, valor: '02/11/2007' });
    for (const mala of ['45/45/2007', '01/01/2024', '01/01/1900']) expect([mala, vFecha(mala, ctx()).ok]).toEqual([mala, false]);
    expect(vEstatura('1.38 Cm')).toEqual({ ok: true, valor: '1.38 m' });
    expect(vEstatura('138')).toEqual({ ok: true, valor: '1.38 m' });
    expect(vEstatura('16.5')).toEqual({ ok: true, valor: '1.65 m' });
    expect(vEstatura('300').ok).toBe(false);
    expect(vPeso('56 Kg')).toEqual({ ok: true, valor: '56 kg' });
    expect(vPeso('10').ok).toBe(false);
    expect(vCURP('rehj071102hspyrs05')).toEqual({ ok: true, valor: 'REHJ071102HSPYRS05' });
    expect(vCURP('REHJ0711').ok).toBe(false);
    expect(vTelefono('+52 443 118 5227')).toEqual({ ok: true, valor: '4431185227' });
    expect(vTelefono('1185227').ok).toBe(false);
    expect(vCP('58300')).toEqual({ ok: true, valor: '58300' });
    expect(vRangoAnios('2013 a 2020')).toEqual({ ok: true, valor: '2013 - 2020' });
    expect(vRangoAnios('2020 a 2013').ok).toBe(false);
    expect(vOpciones(['Masculino', 'Femenino'])('2')).toEqual({ ok: true, valor: 'Femenino' });
    expect(vOpciones(['Soltero(a)', 'Casado(a)'])('casada')).toEqual({ ok: true, valor: 'Casado(a)' });
  });
  it('el nombre se parte como en México (con partículas) y la edad se calcula', () => {
    expect(partirNombre('José Ismael Reynoso Hernández')).toEqual({ nombres: 'José Ismael', paterno: 'Reynoso', materno: 'Hernández' });
    expect(partirNombre('María del Carmen Hernández de la Cruz')).toEqual({ nombres: 'María del Carmen', paterno: 'Hernández', materno: 'de la Cruz' });
    expect(partirNombre('Omar')).toEqual({ nombres: 'Omar', paterno: '', materno: '' });
    expect([edadDesde('02/11/2007', HOY), edadDesde('03/08/2000', HOY), edadDesde('04/08/2000', HOY)]).toEqual([18, 26, 25]);
  });
});

describe('[RH.3.3.3] responder', () => {
  it('comandos: pausa y atrás; un texto normal no es comando', () => {
    expect(responder(q('puesto_solicitado'), 'pausa', {}, ctx())).toEqual({ comando: 'pausa' });
    expect(responder(q('puesto_solicitado'), 'me equivoqué', {}, ctx())).toEqual({ comando: 'atras' });
    expect(valor('puesto_solicitado', 'Cajera')).toBe('Cajera');
  });
  it('⛔ la basura que reportó RH no entra («--» se iba impreso en el CV)', () => {
    for (const b of ['-', '--', '...', '???', '//', 'aa', '1111', 'x', 'ok', '    ']) expect([b, valor('esc_comercial_escuela', b)]).toEqual([b, undefined]);
    expect(valor('esc_comercial_escuela', 'CFE')).toBe('CFE');
    expect(valor('estudia_grado', '6')).toBe('6');
    expect(valor('emp1_sueldo', '$8,000')).toBe('$8,000');
    expect(valor('esc_comercial_escuela', 'no lo recuerdo')).toBe('No recuerda');
    expect(esNoAplica('No recuerda')).toBe(true);
  });
  it('tecleo al azar sí, respuestas reales no (CBTIS, purépecha, «papa»…)', () => {
    for (const b of ['dkañslkdñaskdñlaks', 'asdfasdf', 'qwerty', 'jajajaja', 'zxcvbnm']) expect([b, pareceTecleoAlAzar(b)]).toEqual([b, true]);
    const reales = ['Español', 'purépecha', 'náhuatl', 'CBTIS 120', 'CETIS', 'CFE', 'IMSS', 'Instituto Tecnológico de Morelia',
      'Secundaria Técnica N°99', 'constructora', 'transportes del norte', 'Acomodo de mercancía, rotación', 'papa', 'bebé', 'mamá'];
    expect(reales.filter(pareceTecleoAlAzar)).toEqual([]);
  });
  it('un número no es un nivel de idioma ni el nombre de una escuela; donde sí lo es, pasa', () => {
    expect(valor('idiomas_nivel', '3205611561')).toBeUndefined();
    expect(valor('esc_primaria_escuela', '120')).toBeUndefined();
    expect(valor('emp1_telefono', '4433231188')).toBe('4433231188');
  });
  it('la sugerencia se acepta con «sí»; si NO teníamos el dato, un «sí» pelón no se guarda como apellido', () => {
    expect(valor('apellido_paterno', 'sí')).toBe('Reynoso');
    expect(valor('apellido_materno', 'sí', {}, ctx({ registro: { full_name: 'Omar' } }))).toBeUndefined();
  });
});

describe('[RH.3.3.3] lo sensible, con consentimiento', () => {
  const sensibles = PREGUNTAS.filter((p) => p.sensible).map((p) => p.k);
  const base: Respuestas = { nacionalidad: 'Mexicana', fecha_nacimiento: '02/11/2007', estado_civil: 'Casado(a)', padre_nombre: 'Ismael' };

  it('⭐ sin texto VIGENTE no se pregunta el consentimiento ni nada sensible', () => {
    const k = aplicables(base, ctx({ consentimiento: null })).map((p) => p.k);
    expect(k).not.toContain(K_CONSENTIMIENTO);
    expect(k.filter((x) => sensibles.includes(x))).toEqual([]);
  });
  it('con texto vigente se pregunta; con «no», lo sensible no existe; con «sí», sí', () => {
    expect(aplicables(base, ctx()).map((p) => p.k)).toContain(K_CONSENTIMIENTO);
    const no = aplicables({ ...base, [K_CONSENTIMIENTO]: 'No' }, ctx()).map((p) => p.k);
    expect(no.filter((x) => sensibles.includes(x))).toEqual([]);
    const si = aplicables({ ...base, [K_CONSENTIMIENTO]: 'Sí' }, ctx()).map((p) => p.k);
    expect(si).toEqual(expect.arrayContaining(['estatura', 'salud', 'padre_nombre', 'conyuge_nombre', 'sindicato', 'deudas']));
    expect(textoPregunta(q(K_CONSENTIMIENTO), base, ctx())).toContain(CONSENT.texto);
  });
  it('⛔ si se retracta (o el texto deja de estar vigente), lo sensible ya contestado se BORRA', () => {
    const con: Respuestas = { ...base, [K_CONSENTIMIENTO]: 'Sí', estatura: '1.70 m', salud: 'Bueno', domicilio: 'Calle 1' };
    expect(purgarSensibles(con, ctx())).toEqual(con);
    const retracta = purgarSensibles({ ...con, [K_CONSENTIMIENTO]: 'No' }, ctx());
    expect([retracta['estatura'], retracta['salud'], retracta['padre_nombre'], retracta['domicilio']]).toEqual([undefined, undefined, undefined, 'Calle 1']);
    expect(purgarSensibles(con, ctx({ consentimiento: null }))['salud']).toBeUndefined();
  });
  it('el embarazo sigue apagado aunque haya consentimiento (LFT 133 XIV)', () => {
    expect(aplicables({ ...base, sexo: 'Femenino', [K_CONSENTIMIENTO]: 'Sí' }, ctx()).map((p) => p.k)).not.toContain('embarazo');
  });
});

/** Contesta todo solo; el tope de 400 vueltas es el detector de bucles. */
function recorrer(respuesta: (k: string, opciones: boolean, foto: boolean) => string, c: CtxSolicitud) {
  let d: Respuestas = {};
  const visitadas: string[] = [];
  for (let i = 0; i < 400; i++) {
    const p = siguiente(d, c);
    if (!p) return { d, visitadas, termino: true, atorada: '' };
    textoPregunta(p, d, c);
    const r = responder(p, respuesta(p.k, !!p.opciones, p.tipo === 'foto'), d, c);
    if ('esperaFoto' in r) { d = { ...d, [p.k]: 'Foto recibida' }; visitadas.push(p.k); continue; }
    if (!('valor' in r)) return { d, visitadas, termino: false, atorada: `${p.k}: ${JSON.stringify(r)}` };
    d = purgarSensibles({ ...d, [p.k]: r.valor }, c);
    visitadas.push(p.k);
  }
  return { d, visitadas, termino: false, atorada: 'tope de 400 vueltas' };
}

// Las respuestas de una solicitud REAL escaneada (José Ismael), como en Mega Talento.
const FIJAS: Record<string, string> = {
  puesto_solicitado: 'Anaquelista', sueldo_deseado: '$8,000 mensuales', apellido_paterno: 'sí', apellido_materno: 'sí', nombres: 'sí', email: 'sí',
  domicilio: 'Av. Revolución #2820 B', colonia: 'Villas Oriente', codigo_postal: '58300', telefono_casa: 'sí', sexo: 'masculino',
  lugar_nacimiento: 'Río Verde, San Luis Potosí', fecha_nacimiento: '02/11/2007', edad: 'sí', nacionalidad: 'sí', [K_CONSENTIMIENTO]: 'sí',
  estatura: '1.38', peso: '56', vive_con: '1', dependientes: 'mis padres', estado_civil: '1', rfc: 'sí', nss: 'sí',
  curp: 'REHJ071102HSPYRS05', credencial_elector: '2692141393678', cartilla_militar: 'D-8659550', pasaporte: 'no tengo', afore: 'no sé',
  licencia: 'no', salud: 'bueno', enfermedad_cronica: 'no', deporte: 'futbol', club: 'no', pasatiempo: 'escuchar música',
  meta_vida: 'Superarme y tener mi casa propia', padre_nombre: 'Ismael Reynoso Tamayo', padre_vive: 'vive', padre_domicilio: 'Desconocido',
  padre_ocupacion: 'no sé', madre_nombre: 'María de los Ángeles Hernández Mejía', madre_vive: 'vive', madre_domicilio: 'Avenida Revolución #2820 B',
  madre_ocupacion: 'Promotora', hijos: 'ninguno',
  esc_primaria_hubo: 'sí', esc_primaria_escuela: 'Lázaro Cárdenas', esc_primaria_domicilio: 'Cural Heriberto Jara', esc_primaria_anios: '2013 a 2020', esc_primaria_titulo: 'Certificado',
  esc_secundaria_hubo: 'sí', esc_secundaria_escuela: 'Secundaria Técnica N°99', esc_secundaria_domicilio: 'Carretera Morelia-Charo km 4',
  esc_secundaria_anios: '2020 a 2023', esc_secundaria_titulo: 'Certificado',
  esc_prepa_hubo: 'sí', esc_prepa_escuela: 'CETIS 120', esc_prepa_domicilio: 'Avenida Francisco I. Madero Oriente 4923', esc_prepa_anios: '2023 a 2026',
  esc_prepa_titulo: 'Certificado en proceso de entrega', esc_profesional_hubo: 'no', esc_comercial_hubo: 'no',
  estudia_ahora: 'sí', estudia_escuela: 'CETIS 120', estudia_curso: 'Preparatoria', estudia_grado: '6to semestre', estudia_horario: 'matutino de 7 a 13',
  idiomas: 'Español', idiomas_nivel: 'sí', funciones_oficina: 'Word, Excel', maquinas: 'computadora',
  otros_conocimientos: 'acomodo de mercancía, rotación, atención al cliente, surtir mercancía',
  emp1_hubo: 'sí', emp1_compania: 'Mega Dulces', emp1_domicilio: 'Soledad Gutiérrez de Figueredo #510', emp1_telefono: '4433231188', emp1_puesto: 'Anaquelista',
  emp1_funciones: 'Acomodo de mercancía, rotación de producto y atención al cliente', emp1_logro: 'no aplica', emp1_desde: 'junio 2025', emp1_hasta: 'agosto 2025',
  emp1_sueldo: '$2,000', emp1_motivo: 'Temporal por vacaciones, sigo estudiando la prepa', emp1_jefe_nombre: 'José David Rendón', emp1_jefe_puesto: 'Encargado de piso',
  emp1_informes: 'sí', emp2_hubo: 'no', ref_intro: 'sí',
  ref1_nombre: 'Abraham Sánchez Reynel', ref1_domicilio: 'Villas Oriente', ref1_telefono: '4924649570', ref1_ocupacion: 'Auxiliar de chofer', ref1_tiempo: '8 años',
  ref2_hubo: 'sí', ref2_nombre: 'José Kaleb Ríos Hernández', ref2_domicilio: 'Las Verónicas', ref2_telefono: '4437277664', ref2_ocupacion: 'Estudiante', ref2_tiempo: '7 años',
  ref3_hubo: 'sí', ref3_nombre: 'Cristina Sánchez', ref3_domicilio: 'Tirimostique #180', ref3_telefono: '4436941159', ref3_ocupacion: 'Chofer vendedor', ref3_tiempo: '7 años',
  como_supo: 'Un conocido me dijo', parientes_empresa: 'no tengo', afianzado: 'no', sindicato: 'no', seguro_vida: 'no',
  puede_viajar: 'No, por mi familia', cambiar_residencia: 'No, por mi familia', fecha_presentarse: 'A la inmediata',
  otros_ingresos: 'no', casa_propia: 'no', renta: 'no', automovil: 'no', deudas: 'no', gastos_mensuales: 'como $2,000', veraz: 'sí',
};
const real = (k: string, opciones: boolean, foto: boolean): string => FIJAS[k] ?? (foto ? 'sin foto' : opciones ? '1' : 'dato de prueba');

describe('[RH.3.3.3] el recorrido completo', () => {
  it('⭐ la solicitud real termina, sin repetir preguntas, y arma lo que pide el CV', () => {
    const r = recorrer(real, ctx());
    expect(r.atorada).toBe('');
    expect(r.visitadas.length).toBeGreaterThanOrEqual(90);
    expect(r.visitadas.length).toBeLessThanOrEqual(130);
    expect(new Set(r.visitadas).size).toBe(r.visitadas.length);
    expect(nombreCompleto(r.d)).toBe('José Ismael Reynoso Hernández');
    expect(r.d['idiomas_nivel']).toBe('Español: nativo');
    expect(r.d['estatura']).toBe('1.38 m');
    expect(escolaridad(r.d).map((e) => e.nivel)).toEqual(['Preparatoria o vocacional', 'Secundaria', 'Primaria']);
    expect(idiomas(r.d)).toEqual([{ nombre: 'Español', nivel: 'Nativo', pct: 100 }]);
    expect(habilidades(r.d).length).toBeGreaterThanOrEqual(4);
    expect(porBloques(r.d, ctx())[0].titulo).toBe('Datos personales');
  });
  it('la misma solicitud SIN consentimiento termina y no trae nada sensible', () => {
    const r = recorrer((k, o, f) => (k === K_CONSENTIMIENTO ? 'no' : real(k, o, f)), ctx());
    expect(r.atorada).toBe('');
    for (const k of PREGUNTAS.filter((p) => p.sensible).map((p) => p.k)) expect([k, r.d[k]]).toEqual([k, undefined]);
  });
  it('el que nunca ha trabajado y no da referencias: la más corta, sin empleos ni referencias', () => {
    const r = recorrer((k, o, f) => (['emp1_hubo', 'ref_intro', K_CONSENTIMIENTO].includes(k) ? 'no' : real(k, o, f)), ctx());
    expect(r.atorada).toBe('');
    expect(r.visitadas.some((k) => /^emp\d_compania|^ref\d_nombre/.test(k))).toBe(false);
  });
  it('⛔ el avance no promete un total: bloques fijos y respuestas que sólo suben', () => {
    let d: Respuestas = {};
    const c = ctx();
    const textos: string[] = [];
    for (let i = 0; i < 60; i++) {
      const p = siguiente(d, c);
      if (!p) break;
      textos.push(textoPregunta(p, d, c));
      const r = responder(p, real(p.k, !!p.opciones, p.tipo === 'foto'), d, c);
      d = { ...d, [p.k]: 'valor' in r ? r.valor : 'x' };
    }
    expect(textos.filter((t) => /\d+ de \d+ preguntas|\d+\/\d+ preguntas/.test(t))).toEqual([]);
    expect(textos[5]).toMatch(/bloque \d+\/11 · \d+ respuestas/);
    expect(progreso(d, c).bloquesTotal).toBe(11);
  });
  it('«atrás» borra la última respuesta dada', () => {
    const c = ctx();
    const { respuestas, borrada } = atras({ puesto_solicitado: 'Cajera', sueldo_deseado: '8000' }, c);
    expect([borrada, respuestas]).toEqual(['sueldo_deseado', { puesto_solicitado: 'Cajera' }]);
    expect(atras({}, c).borrada).toBeNull();
  });
});
