/**
 * `[RH.3.2]` La conversación de registro, sin base ni red: cada regla de Mega Talento que ya costó algo.
 */
import {
  avanzarRegistro, ciudadDelCatalogo, comandoInformativo, esSaludoSinPuesto, pareceTecleoAlAzar,
  postulacionDesdeRegistro, validarCorreo, validarNSS, validarRFC, PASOS, NO_APLICA, SIN_CORREO, PIDE_CV,
  type DatosRegistro, type Turno, type VacanteBot,
} from './registro';

const VACANTES: VacanteBot[] = [
  { id: 'v-cajero', name: 'Cajero(a)', salary_text: '$2,000 semanales', branch_codes: [] },
  { id: 'v-chofer', name: 'Chofer', salary_text: null, branch_codes: ['la-piedad-abastos'] },
  { id: 'v-pract', name: 'Practicante', salary_text: null, branch_codes: [] },
  { id: 'v-morelia', name: 'Almacenista', salary_text: null, branch_codes: ['morelia-figaredo'] },
];
const ctx = { vacantes: VACANTES };

/** Manda los mensajes en orden y devuelve el último turno. */
function conversar(mensajes: string[], desde: { estado?: string; datos?: DatosRegistro } = {}): Turno {
  let t: Turno = { estado: desde.estado ?? 'nuevo', datos: desde.datos ?? {}, respuestas: [] };
  for (const m of mensajes) t = avanzarRegistro(t.estado, t.datos, m, ctx);
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

  it('el puesto se comenta: hay vacante, o «te registramos para futuras» (la orientación es [RH.3.2.2])', () => {
    expect(conversar(['cajera'], { estado: 'esperando_position_interest' }).respuestas[0]).toContain('Sí tenemos vacante de *Cajero(a)*');
    expect(conversar(['ingeniero de sistemas'], { estado: 'esperando_position_interest' }).respuestas[0]).toContain('futuras oportunidades');
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
