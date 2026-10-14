/**
 * `[RH.3.3.3]` La conversación del armado del CV: iniciar, pausa/seguir, atrás, la foto, el fin (efecto `armar_cv`),
 * revisar (efecto `subir_cv`) y corregir un dato; y la EVIDENCIA del consentimiento (versión + fecha).
 */
import { aplicarFoto, avanzarArmado, iniciarArmado, preguntasQueSuenanA, type Aplicacion, type TurnoArmado } from './armado';
import { K_CONSENTIMIENTO, siguiente, type CtxSolicitud } from './solicitud';

const AHORA = new Date('2026-10-14T16:00:00Z');
const CONSENT = { version: 'v-prueba', texto: 'Consentimiento de prueba para datos sensibles.' };
const ctx = (o: Partial<CtxSolicitud> = {}): CtxSolicitud => ({
  registro: { position_interest: 'Anaquelista', full_name: 'Ana López Pérez', email: 'ana@gmail.com' }, telefono: '4431185227',
  consentimiento: null, hoy: AHORA, ...o,
});
const decir = (t: TurnoArmado, texto: string, c = ctx()): TurnoArmado => avanzarArmado(t.estado as never, t.app, texto, c, AHORA);
const vacia = (): Aplicacion => ({ respuestas: {}, iniciada_en: AHORA.toISOString() });

describe('[RH.3.3.3] el armado', () => {
  it('⭐ arranca con la oferta y la primera pregunta (el puesto, sugerido del registro)', () => {
    const t = iniciarArmado(ctx(), AHORA);
    expect(t.estado).toBe('armando_solicitud');
    expect(t.respuestas[0]).toContain('yo te lo armo');
    expect(t.respuestas[0]).toContain('_Tengo esto:_ *Anaquelista*');
  });

  it('contesta, pausa (nada se guarda como respuesta) y retoma donde iba', () => {
    let t = iniciarArmado(ctx(), AHORA);
    t = decir(t, 'sí');
    expect(t.app.respuestas['puesto_solicitado']).toBe('Anaquelista');
    t = decir(t, 'pausa');
    expect(t.estado).toBe('solicitud_pausada');
    const guardada = decir(t, 'ahorita no puedo, estoy en el trabajo');
    expect([guardada.estado, Object.keys(guardada.app.respuestas)]).toEqual(['solicitud_pausada', ['puesto_solicitado']]);
    t = decir(t, 'seguir');
    expect([t.estado, t.respuestas[0].includes('retomamos')]).toEqual(['armando_solicitud', true]);
  });

  it('«atrás» borra la última y vuelve a preguntarla', () => {
    let t = decir(decir(iniciarArmado(ctx(), AHORA), 'sí'), '9000');
    expect(t.app.respuestas['sueldo_deseado']).toBe('9000');
    t = decir(t, 'atrás');
    expect([t.app.respuestas['sueldo_deseado'], t.respuestas[0].includes('corregimos *Sueldo mensual deseado*')]).toEqual([undefined, true]);
  });

  it('la foto: un texto la pide como imagen; «sin foto» la salta; `aplicarFoto` sólo vale si la pregunta es la foto', () => {
    const app: Aplicacion = { ...vacia(), respuestas: Object.fromEntries(Object.entries(fakeHastaFoto()).map(([k, v]) => [k, v])) };
    const c = ctx();
    expect(siguiente(app.respuestas, c)?.k).toBe('foto');
    const t0: TurnoArmado = { estado: 'armando_solicitud', app, respuestas: [] };
    expect(decir(t0, 'aquí va').respuestas[0]).toContain('como *imagen*');
    const conFoto = aplicarFoto(app, 'bucket/foto.jpg', c, AHORA);
    expect([conFoto?.app.foto_key, conFoto?.app.respuestas['foto']]).toEqual(['bucket/foto.jpg', 'Foto recibida']);
    expect(aplicarFoto(vacia(), 'x', c, AHORA)).toBeNull();
    const sinFoto = decir(t0, 'sin foto');
    expect(sinFoto.app.respuestas['foto']).toBe('Sin foto');
  });

  it('⭐ al terminar: efecto `armar_cv`, estado `revisando_cv` y la fecha de fin', () => {
    const app: Aplicacion = { ...vacia(), respuestas: { ...fakeHastaFoto(), foto: 'Sin foto' } };
    const t = decir({ estado: 'armando_solicitud', app, respuestas: [] }, 'sí');
    expect([t.estado, t.efecto, t.app.terminada_en]).toEqual(['revisando_cv', 'armar_cv', AHORA.toISOString()]);
  });

  it('revisando: «sí, está bien» sube (efecto `subir_cv`); «corregir» pregunta qué dato; otra cosa recuerda las opciones', () => {
    const t: TurnoArmado = { estado: 'revisando_cv', app: { ...vacia(), respuestas: { email: 'ana@gmail.com' }, cv_key: 'k' }, respuestas: [] };
    expect(decir(t, 'sí, está bien').efecto).toBe('subir_cv');
    expect(decir(t, 'quiero corregir algo').estado).toBe('corrigiendo_solicitud');
    expect(decir(t, 'mmm').respuestas[0]).toContain('¿Cómo lo ves?');
  });

  it('⭐ corregir «mi correo»: se borra ESA respuesta, se vuelve a preguntar, y el CV viejo deja de valer', () => {
    const app: Aplicacion = { ...vacia(), respuestas: { ...fakeHastaFoto(), foto: 'Sin foto', veraz: 'Sí' }, cv_key: 'viejo.pdf', terminada_en: 'x' };
    const t = decir({ estado: 'corrigiendo_solicitud', app, respuestas: [] }, 'mi correo');
    expect([t.estado, t.app.respuestas['email'], t.app.cv_key, t.app.terminada_en]).toEqual(['armando_solicitud', undefined, null, null]);
    expect(t.respuestas[0]).toContain('Corregimos *E-mail*');
    expect(decir({ estado: 'corrigiendo_solicitud', app, respuestas: [] }, 'ninguno').estado).toBe('revisando_cv');
    expect(preguntasQueSuenanA('xyz', app.respuestas, ctx())).toEqual([]);
  });

  it('⛔ la evidencia del consentimiento queda con su VERSIÓN y fecha; con «no», lo sensible se borra', () => {
    const c = ctx({ consentimiento: CONSENT });
    const app: Aplicacion = { ...vacia(), respuestas: { puesto_solicitado: 'A', sueldo_deseado: '1', apellido_paterno: 'L', apellido_materno: 'P',
      nombres: 'Ana', email: 'a@b.mx', domicilio: 'Calle 1', colonia: 'Centro', codigo_postal: '58300', telefono_casa: '4431185227', sexo: 'Femenino',
      lugar_nacimiento: 'Zamora', fecha_nacimiento: '02/11/2000', edad: '25 años', nacionalidad: 'Mexicana' } };
    expect(siguiente(app.respuestas, c)?.k).toBe(K_CONSENTIMIENTO);
    const si = decir({ estado: 'armando_solicitud', app, respuestas: [] }, 'sí', c);
    expect(si.app.consentimiento).toEqual({ version: 'v-prueba', acepto: true, en: AHORA.toISOString() });
    expect(siguiente(si.app.respuestas, c)?.k).toBe('estatura');
    const conEstatura = decir(si, '1.65', c);
    const retracta = decir(decir(conEstatura, 'atrás', c), 'atrás', c);
    const no = decir(retracta, 'no', c);
    expect([no.app.consentimiento?.acepto, no.app.respuestas['estatura']]).toEqual([false, undefined]);
  });
});

/** Respuestas que llevan hasta la pregunta de la foto (sin consentimiento vigente, el camino corto). */
function fakeHastaFoto(): Record<string, string> {
  return {
    puesto_solicitado: 'Anaquelista', sueldo_deseado: '8000', apellido_paterno: 'López', apellido_materno: 'Pérez', nombres: 'Ana', email: 'ana@gmail.com',
    domicilio: 'Calle 1', colonia: 'Centro', codigo_postal: '58300', telefono_casa: '4431185227', sexo: 'Femenino', lugar_nacimiento: 'Zamora',
    fecha_nacimiento: '02/11/2000', edad: '25 años', nacionalidad: 'Mexicana', rfc: 'No aplica', nss: 'No aplica', curp: 'No aplica',
    credencial_elector: 'No aplica', cartilla_militar: 'No aplica', pasaporte: 'No aplica', afore: 'No aplica', licencia: 'No',
    deporte: 'No aplica', club: 'No aplica', pasatiempo: 'Leer', meta_vida: 'Crecer', esc_primaria_hubo: 'No', esc_secundaria_hubo: 'No',
    esc_prepa_hubo: 'No', esc_profesional_hubo: 'No', esc_comercial_hubo: 'No', estudia_ahora: 'No', idiomas: 'Español', idiomas_nivel: 'Español: nativo',
    funciones_oficina: 'No aplica', maquinas: 'No aplica', otros_conocimientos: 'No aplica', emp1_hubo: 'No', ref_intro: 'No',
    como_supo: 'Facebook', parientes_empresa: 'No aplica', afianzado: 'No aplica', puede_viajar: 'Sí', cambiar_residencia: 'No por familia',
    fecha_presentarse: 'Inmediata',
  };
}
