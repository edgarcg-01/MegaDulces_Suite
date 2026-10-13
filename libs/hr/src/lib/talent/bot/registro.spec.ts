/**
 * `[RH.3.2]` La conversación de registro, sin base ni red: cada regla de Mega Talento que ya costó algo.
 */
import {
  avanzarRegistro, ciudadDelCatalogo, comandoInformativo, esSaludoSinPuesto, pareceTecleoAlAzar,
  postulacionDesdeRegistro, validarCorreo, validarNSS, validarRFC, PASOS, NO_APLICA, SIN_CORREO, PIDE_CV,
  type ContextoRegistro, type DatosRegistro, type Turno, type VacanteBot,
} from './registro';

const VACANTES: VacanteBot[] = [
  { id: 'v-cajero', name: 'Cajero(a)', salary_text: '$2,000 semanales', branch_codes: [] },
  { id: 'v-chofer', name: 'Chofer', salary_text: null, branch_codes: ['la-piedad-abastos'] },
  { id: 'v-pract', name: 'Practicante', salary_text: null, branch_codes: [] },
  { id: 'v-morelia', name: 'Almacenista', salary_text: null, branch_codes: ['morelia-figaredo'] },
];
const ctx = { vacantes: VACANTES };

/** Manda los mensajes en orden y devuelve el último turno (con la orientación viajando entre turnos, como la guarda el servicio). */
function conversar(mensajes: string[], desde: { estado?: string; datos?: DatosRegistro } = {}, c: ContextoRegistro = ctx): Turno {
  let t: Turno = { estado: desde.estado ?? 'nuevo', datos: desde.datos ?? {}, orientacion: null, respuestas: [] };
  for (const m of mensajes) t = avanzarRegistro(t.estado, t.datos, m, c, t.orientacion);
  return t;
}

const COMPLETO = [
  'hola', 'cajera', 'Ana María López Pérez', 'ana arroba gmail.com', 'Zamora', '20 minutos', 'tiempo completo',
  'Oxxo', '9000 al mes', 'LOGA900101AB1', '123-456-789-01', 'ninguno', 'no',
];

describe('[RH.3.2] registro por WhatsApp', () => {
  it('⭐ de punta a punta: 12 pasos → resumen → «sí» → pide el CV (y avisa al servicio)', () => {
    const t = conversar(COMPLETO);
    expect(t.estado).toBe('confirmando');
    expect(t.respuestas[0]).toContain('12. *Ya trabajó en Mega Dulces:* no');
    expect(t.datos).toMatchObject({
      position_interest: 'cajera', email: 'ana@gmail.com', rfc: 'LOGA900101AB1', nss: '12345678901', city_branch: 'Zamora',
    });
    const fin = avanzarRegistro(t.estado, t.datos, 'Sí', ctx);
    expect([fin.estado, fin.confirmado, fin.respuestas]).toEqual(['esperando_cv', true, [PIDE_CV]]);
  });

  it('el primer «hola» saluda y pide el puesto, sin guardarlo como dato', () => {
    const t = conversar(['hola']);
    expect(t.estado).toBe('esperando_position_interest');
    expect(t.datos).toEqual({});
    expect(t.respuestas[0]).toContain('Bienvenido(a)');
  });

  it('⛔ un SALUDO donde iba el puesto no se guarda (había candidatos cuyo puesto decía «Hola»)', () => {
    for (const s of ['Buenas tardes', 'hola', 'me interesa la vacante', 'te mando mi cv', 'ok']) {
      const t = conversar([s], { estado: 'esperando_position_interest' });
      expect([s, t.estado, t.datos.position_interest]).toEqual([s, 'esperando_position_interest', undefined]);
    }
    // Pero un saludo CON puesto sí cuenta.
    expect(esSaludoSinPuesto('hola, busco de cajera', VACANTES)).toBe(false);
  });

  it('puesto y ciudad exigen un dato claro: «cualquiera», «donde sea», «no sé» no avanzan', () => {
    expect(conversar(['cualquiera'], { estado: 'esperando_position_interest' }).estado).toBe('esperando_position_interest');
    const c = conversar(['donde sea'], { estado: 'esperando_city_branch', datos: { position_interest: 'cajera' } });
    expect(c.estado).toBe('esperando_city_branch');
    expect(c.respuestas[0]).toContain('en *qué ciudad*');
  });

  it('el puesto que SÍ existe se comenta y sigue el registro', () => {
    const t = conversar(['cajera'], { estado: 'esperando_position_interest' });
    expect([t.estado, t.orientacion]).toEqual(['esperando_full_name', null]);
    expect(t.respuestas[0]).toContain('Sí tenemos vacante de *Cajero(a)*');
  });


  it('el correo es suave: «no tengo» guarda «Sin correo» y sigue', () => {
    const t = conversar(['no tengo'], { estado: 'esperando_email', datos: { position_interest: 'cajera', full_name: 'Ana López' } });
    expect([t.estado, t.datos.email]).toEqual(['esperando_city_branch', SIN_CORREO]);
    expect(t.respuestas[0]).toMatch(/^Sin problema, seguimos sin correo/);
  });

  it('RFC: inválido se repite; «no sé» da el enlace del SAT; «después» (puesto normal) se pide firme', () => {
    const datos = { position_interest: 'cajera' };
    expect(conversar(['ABC123'], { estado: 'esperando_rfc', datos }).respuestas[0]).toContain('no parece válido');
    const noSe = conversar(['no lo sé'], { estado: 'esperando_rfc', datos });
    expect([noSe.estado, noSe.respuestas[0].includes('sat.gob.mx')]).toEqual(['esperando_rfc', true]);
    const despues = conversar(['se lo paso después'], { estado: 'esperando_rfc', datos });
    expect([despues.estado, despues.respuestas[0].includes('sí lo necesitamos')]).toEqual(['esperando_rfc', true]);
  });

  it('practicante: RFC y NSS son opcionales («No aplica»); y la pregunta lo dice', () => {
    const datos = { position_interest: 'becario' };
    const t = conversar(['no tengo'], { estado: 'esperando_rfc', datos });
    expect([t.estado, t.datos.rfc]).toEqual(['esperando_nss', NO_APLICA]);
    expect(t.respuestas[0]).toContain('escribe *después*');
  });

  it('⛔ tecleo al azar no se acepta (el nombre va impreso en el CV)', () => {
    const t = conversar(['dkañslkdñaskdñlaks'], { estado: 'esperando_full_name', datos: { position_interest: 'cajera' } });
    expect(t.estado).toBe('esperando_full_name');
    expect(pareceTecleoAlAzar('asdfgh')).toBe(true);
    expect(pareceTecleoAlAzar('jajajaja')).toBe(true);
    expect(pareceTecleoAlAzar('CBTIS 52')).toBe(false);
    expect(pareceTecleoAlAzar('Constructora del Bajío')).toBe(false);
  });

  it('comandos en cualquier momento, sólo si el mensaje ES el comando', () => {
    const t = conversar(['vacantes'], { estado: 'esperando_full_name', datos: { position_interest: 'cajera' } });
    expect(t.estado).toBe('esperando_full_name');
    expect(t.respuestas[0]).toContain('*Cajero(a)* — $2,000 semanales');
    expect(t.respuestas[0]).toContain('¿Cuál es tu *nombre completo*?');
    expect(comandoInformativo('ver las vacantes por favor')).toBe('vacantes');
    expect(comandoInformativo('?')).toBe('menu');
    expect(comandoInformativo('el puesto de vendedor')).toBeNull();
    expect(comandoInformativo('en la tienda del centro')).toBeNull();
    // «el puesto de vendedor» es una RESPUESTA, no un comando: se guarda.
    expect(conversar(['el puesto de vendedor'], { estado: 'esperando_position_interest' }).datos.position_interest).toBe('el puesto de vendedor');
  });

  it('desde el resumen: un número corrige ESE dato y regresa al resumen', () => {
    const r = conversar(COMPLETO);
    const ed = avanzarRegistro(r.estado, r.datos, '4', ctx);
    expect(ed.estado).toBe('editando_city_branch');
    const vuelta = avanzarRegistro(ed.estado, ed.datos, 'La Piedad', ctx);
    expect([vuelta.estado, vuelta.datos.city_branch]).toEqual(['confirmando', 'La Piedad']);
    expect(vuelta.respuestas[0]).toMatch(/^✅ \*Ciudad\/sucursal\* actualizado/);
    expect(avanzarRegistro(r.estado, r.datos, '13', ctx).estado).toBe('confirmando'); // fuera de rango
  });

  it('⛔ sin puesto o ciudad claros no se confirma (aunque hayan llegado así de antes)', () => {
    const r = conversar(COMPLETO);
    const t = avanzarRegistro('confirmando', { ...r.datos, city_branch: 'cualquiera' }, 'sí', ctx);
    expect([t.estado, t.confirmado]).toEqual(['editando_city_branch', undefined]);
  });

  it('«reiniciar» borra todo y vuelve al primer paso, desde cualquier estado', () => {
    const t = conversar(['reiniciar'], { estado: 'postulada', datos: { position_interest: 'cajera' } });
    expect([t.estado, t.datos, t.reiniciado]).toEqual(['esperando_position_interest', {}, true]);
  });

  it('esperando el CV: «no tengo» recibe una respuesta honesta (armarlo es [RH.3.3]); lo demás, un recordatorio', () => {
    expect(conversar(['no tengo cv'], { estado: 'esperando_cv' }).respuestas[0]).toContain('Tus datos ya quedaron guardados');
    expect(conversar(['qué sigue?'], { estado: 'esperando_cv' }).respuestas[0]).toContain('Sólo me falta tu *currículum');
  });

  it('validadores', () => {
    expect(validarCorreo('Juan Arroba Gmail.com.')).toEqual({ ok: true, valor: 'juan@gmail.com' });
    expect(validarRFC('loga 900101 ab1')).toEqual({ ok: true, valor: 'LOGA900101AB1' });
    expect(validarRFC('LOGA901301AB1').ok).toBe(false); // mes 13
    expect(validarNSS('1234567890').ok).toBe(false);
  });

  it('los pasos son los 12 de Mega Talento, en orden', () => {
    expect(PASOS.map((p) => p.campo)).toEqual([
      'position_interest', 'full_name', 'email', 'city_branch', 'commute_time', 'availability', 'previous_employer',
      'desired_salary', 'rfc', 'nss', 'relative_in_company', 'rehire_note',
    ]);
  });
});

describe('[RH.3.2.2] orientación dentro del registro', () => {
  const AHORA = new Date('2026-10-13T18:00:00Z');
  const c: ContextoRegistro = { vacantes: VACANTES, ahora: AHORA };

  it('⭐ puesto que no hay y sin ciudad: se guarda lo pedido, se le pregunta la ciudad, se le ofrece lo de su zona, elige y sigue', () => {
    const t1 = conversar(['ayudante general'], { estado: 'esperando_position_interest' }, c);
    expect([t1.estado, t1.datos.position_interest, t1.orientacion?.tipo, t1.orientacion?.pedido])
      .toEqual(['orientando_puesto', 'ayudante general', 'falta_ciudad', 'ayudante general']);
    expect(t1.respuestas[0]).toMatch(/en qué \*ciudad\*/);

    const t2 = avanzarRegistro(t1.estado, t1.datos, 'soy de La Piedad', c, t1.orientacion);
    expect([t2.estado, t2.datos.city_branch, t2.orientacion?.tipo]).toEqual(['orientando_puesto', 'soy de La Piedad', 'ofrecer']);
    // Almacenista está sólo en Morelia: no se le ofrece a alguien de La Piedad.
    expect(t2.orientacion?.ofrecidas).toEqual(['Cajero(a)', 'Chofer', 'Practicante']);
    expect(t2.respuestas[0]).not.toMatch(/Morelia/);

    const t3 = avanzarRegistro(t2.estado, t2.datos, 'la 2', c, t2.orientacion);
    expect([t3.estado, t3.datos.position_interest, t3.orientacion?.aceptada, t3.orientacion?.aceptada_en])
      .toEqual(['esperando_full_name', 'Chofer', 'Chofer', AHORA.toISOString()]);
    expect(t3.respuestas[0]).toContain('Te registro para *Chofer*');
    // La ciudad ya la dio: el registro no se la vuelve a pedir.
    const t4 = conversar(['Ana López Pérez', 'no tengo'], { estado: t3.estado, datos: t3.datos }, c);
    expect(t4.estado).toBe('esperando_commute_time');
  });

  it('rechaza lo ofrecido: se respeta, lo que pidió se queda y sigue el registro', () => {
    const t1 = conversar(['ingeniero de sistemas'], { estado: 'esperando_position_interest', datos: { city_branch: 'Zamora' } }, c);
    expect(t1.orientacion?.tipo).toBe('ofrecer');
    const t2 = avanzarRegistro(t1.estado, t1.datos, 'no gracias', c, t1.orientacion);
    expect([t2.estado, t2.datos.position_interest, t2.orientacion?.rechazada]).toEqual(['esperando_full_name', 'ingeniero de sistemas', true]);
    expect(t2.respuestas[0]).toContain('Te dejo registrado para *ingeniero de sistemas*');
  });

  it('⛔ nunca se queda dando vueltas: una repregunta numerada y a la segunda sigue el registro', () => {
    const t1 = conversar(['ingeniero de sistemas', 'xq'], { estado: 'esperando_position_interest', datos: { city_branch: 'Zamora' } }, c);
    expect([t1.estado, t1.orientacion?.rondas]).toEqual(['orientando_puesto', 1]);
    expect(t1.respuestas[0]).toMatch(/1\. \*Cajero\(a\)\*/);
    const t2 = avanzarRegistro(t1.estado, t1.datos, 'xq', c, t1.orientacion);
    expect(t2.estado).toBe('esperando_full_name');
    expect(t2.respuestas[0]).toMatch(/^Va, sigamos con tu registro/);
  });

  it('un comando en medio de la orientación recuerda lo que se le ofreció; «reiniciar» la borra', () => {
    const t1 = conversar(['ingeniero de sistemas', 'vacantes'], { estado: 'esperando_position_interest', datos: { city_branch: 'Zamora' } }, c);
    expect(t1.estado).toBe('orientando_puesto');
    expect(t1.respuestas[0]).toContain('¿Cuál de estas te interesa? *Cajero(a)*');
    const t2 = avanzarRegistro(t1.estado, t1.datos, 'reiniciar', c, t1.orientacion);
    expect([t2.orientacion, t2.datos]).toEqual([null, {}]);
  });

  it('sin vacantes publicadas: se le dice, se le registra igual y no se atora', () => {
    const sin: ContextoRegistro = { vacantes: [], ahora: AHORA };
    const t1 = conversar(['cajera'], { estado: 'esperando_position_interest' }, sin);
    expect([t1.estado, t1.orientacion?.tipo]).toEqual(['orientando_puesto', 'nada']);
    const t2 = avanzarRegistro(t1.estado, t1.datos, 'ok', sin, t1.orientacion);
    expect(t2.estado).toBe('esperando_full_name');
  });
});

describe('[RH.3.2] de lo contestado a la postulación', () => {
  it('la ciudad va al catálogo por como la escribe la gente', () => {
    expect(ciudadDelCatalogo('canindo')).toBe('Zamora');
    expect(ciudadDelCatalogo('en 8 esquinas')).toBe('La Piedad');
    expect(ciudadDelCatalogo('Padre Hidalgo')).toBe('Santa Ana Pacueco');
    expect(ciudadDelCatalogo('Guadalajara')).toBeNull();
    expect(ciudadDelCatalogo('Zamora o Morelia')).toBeNull(); // varias: no se adivina
  });

  it('⭐ la vacante se liga sólo si aplica en su ciudad; si no, queda como texto (y no truena en `postular`)', () => {
    const enZamora = postulacionDesdeRegistro({ position_interest: 'cajera', city_branch: 'canindo' }, VACANTES);
    expect([enZamora.job_posting_id, enZamora.position_interest, enZamora.city_branch]).toEqual(['v-cajero', 'Cajero(a)', 'Zamora']);
    const fuera = postulacionDesdeRegistro({ position_interest: 'almacenista', city_branch: 'Zamora' }, VACANTES);
    expect([fuera.job_posting_id, fuera.position_interest]).toEqual([null, 'almacenista']);
    const sinCiudad = postulacionDesdeRegistro({ position_interest: 'chofer', city_branch: 'Guadalajara' }, VACANTES);
    expect([sinCiudad.job_posting_id, sinCiudad.city_branch]).toEqual([null, 'Guadalajara']);
  });

  it('los centinelas son ausencia declarada, no dato', () => {
    const p = postulacionDesdeRegistro({ email: SIN_CORREO, rfc: NO_APLICA, nss: '12345678901' }, VACANTES);
    expect([p.email, p.rfc, p.nss]).toEqual([null, null, '12345678901']);
  });
});
