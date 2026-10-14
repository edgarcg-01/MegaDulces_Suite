/**
 * `[RH.3.2.2]` A quien pide un puesto que no existe, ¿qué se le ofrece? Los casos son los de `probar-orientacion.js` de
 * Mega Talento: los 43 candidatos reales que al 17/08/2026 pedían un puesto sin vacante, con la ciudad que contestaron
 * (por eso hay faltas de ortografía y «Unos churros» como ciudad). Las vacantes son las del portal de ese día.
 */
import {
  ciudadesDeVacante, clasificarPuestoTexto, interpretarRespuestaOferta, mensajeOrientacion, nombresOfrecidos, orientar,
  vocabularioDe, type VacanteOrientable,
} from './orientacion';

const v = (name: string, sort_order: number, branch_codes: string[], salary_text: string | null = null): VacanteOrientable =>
  ({ name, sort_order, branch_codes, salary_text });
const VACANTES: VacanteOrientable[] = [
  v('Cajero(a)', 0, ['morelia-vicente-guerrero', 'morelia-figaredo', 'zamora-catedral'], '$8,000-$10,000'),
  v('Surtidor', 1, ['morelia-vicente-guerrero', 'morelia-figaredo', 'santa-ana-pacueco'], '$8,000-$10,000'),
  v('Aux de chofer', 2, ['morelia-figaredo']),
  v('Chofer', 3, ['morelia-vicente-guerrero', 'morelia-figaredo']),
  v('Almacenista', 5, ['morelia-figaredo', 'yurecuaro-centro']),
  v('Bodeguero', 6, ['morelia-figaredo']),
  v('Anaquelista', 7, ['morelia-vicente-guerrero', 'morelia-figaredo', 'zamora-catedral', 'la-piedad-abastos', 'la-piedad-centro']),
  v('Vendedor', 8, ['zamora-canindo']),
  v('Cajero (a)', 9, ['morelia-vicente-guerrero', 'zamora-catedral'], '$8,000-$10,000'), // duplicado real
  v('Vendedor de ruta', 9, ['zamora-canindo', 'santa-ana-pacueco']),
  v('Vendedor promotor', 10, ['santa-ana-pacueco']),
  v('Practicante', 11, ['morelia-figaredo', 'zamora-canindo', 'santa-ana-pacueco'], 'Remuneración: por cita agendada, entrevista y validación de datos.'),
  v('Crédito y Cobranza', 13, ['santa-ana-pacueco'], '10,000 - 10,400'),
  v('Repartidor', 14, ['zamora-catedral']),
  v('Jefatura de recursos humanos', 15, ['santa-ana-pacueco']),
  v('Ventas a detalle', 16, ['yurecuaro-centro']),
];
const VOCAB = vocabularioDe(VACANTES);
const ofrecidas = (texto: string, ciudad: string) => nombresOfrecidos(orientar(texto, ciudad, VACANTES));
const opcionesDe = (d: ReturnType<typeof orientar>) => ('opciones' in d ? d.opciones : []);

describe('[RH.3.2.2] 1) un saludo no es una respuesta', () => {
  it.each(['Hola', 'Buenas tardes', 'Buen día✨', 'Si', 'Me interesa', 'Primeramente le deseo un buen día',
    'De ante mano espero me solucionen', 'Mire una publicación', 'Envío mi currículum por si es de su interés',
    'Este es mi CV', 'Quiera formar parte de su equipo', 'Tiene'])('«%s» → saludo', (t) => {
    expect(clasificarPuestoTexto(t, VOCAB)).toBe('saludo');
  });
  it.each(['Hola, busco de cajera', 'Buenas tardes, me interesa la vacante de chofer', 'hola quiero trabajar en caja'])(
    'un saludo CON contenido sí responde: «%s» → puesto', (t) => {
      expect(clasificarPuestoTexto(t, VOCAB)).toBe('puesto');
    });
});

describe('[RH.3.2.2] 2) «lo que sea» es el candidato más fácil de colocar', () => {
  it.each(['Cualquier esta bien', 'En lo que sea', 'Nose', 'El solisitado', 'lo que haya', 'donde sea',
    'estoy abierta a cualquier cosa', 'en lo que ocupen'])('«%s» → abierto', (t) => {
    expect(clasificarPuestoTexto(t, VOCAB)).toBe('abierto');
  });
});

describe('[RH.3.2.2] 3) sólo se ofrece lo que hay en su zona', () => {
  it('⭐ La Piedad: cada opción tiene sucursal en su zona, y el mensaje no nombra Morelia ni Zamora', () => {
    const d = orientar('Personal Administrativo', 'La Piedad', VACANTES);
    expect(d.tipo).toBe('ofrecer');
    expect(opcionesDe(d).every((o) => ciudadesDeVacante(o.vacante).some((c) => ['la_piedad', 'santa_ana'].includes(c)))).toBe(true);
    expect(mensajeOrientacion(d, 'Personal Administrativo')).not.toMatch(/Morelia|Canindo|Zamora Centro/);
    // Santa Ana Pacueco está pegado a La Piedad: cuenta igual.
    expect(opcionesDe(d).some((o) => ciudadesDeVacante(o.vacante).includes('santa_ana'))).toBe(true);
    // Y lo administrativo que sí existe allá sale primero.
    expect(ofrecidas('Personal Administrativo', 'La Piedad')[0]).toMatch(/credito|jefatura|practicante/i);
  });
  it('Zamora: todas en Zamora, el mensaje sólo nombra Zamora, y a «Atención al cliente» le sugiere Cajero(a) primero', () => {
    const d = orientar('Atención al cliente', 'Zamora', VACANTES);
    expect(opcionesDe(d).every((o) => ciudadesDeVacante(o.vacante).includes('zamora'))).toBe(true);
    expect(mensajeOrientacion(d, 'Atención al cliente')).not.toMatch(/Morelia|Piedad|Esquinas|Padre Hidalgo|Yurécuaro/);
    expect(nombresOfrecidos(d)[0]).toMatch(/cajero/i);
  });
});

describe('[RH.3.2.2] 4) las cinco personas que pidieron RH (y la vacante estaba abierta)', () => {
  it.each(['RH', 'Rh', 'Jefe de RH', 'Jefe de RRHH', 'Reclutamiento', 'RH o área administrativa'])('«%s» → Jefatura de RH', (t) => {
    expect(ofrecidas(t, 'Santa Ana Pacueco')[0]).toMatch(/jefatura/i);
  });
});

describe('[RH.3.2.2] 5) cuando en su ciudad no hay nada', () => {
  it('se le dice honesto, dónde sí hay, se le PREGUNTA si se trasladaría, y no se le repite su ciudad rara', () => {
    const d = orientar('Sor de Atotonilco', 'Soy de Jalisco', VACANTES);
    expect(d.tipo).toBe('otras_ciudades');
    const msg = String(mensajeOrientacion(d, 'Sor de Atotonilco'));
    expect(msg).toMatch(/trasladart?e/i);
    expect(msg).not.toMatch(/jalisco/i);
    expect(msg).toMatch(/te escribo|avis/i);
  });
  it('«Hola» sigue siendo saludo aunque la ciudad sea absurda; una ciudad no reconocida no se repite', () => {
    expect(orientar('Hola', 'Unos churros', VACANTES).tipo).toBe('no_es_puesto');
    expect(mensajeOrientacion(orientar('Encuestadora', 'Unos churros', VACANTES), 'Encuestadora')).not.toMatch(/churros/i);
  });
});

describe('[RH.3.2.2] 6) si todavía no sabemos su ciudad, se la pregunta', () => {
  it('sin ciudad → falta_ciudad: le pregunta, le dice dónde tenemos sucursal y no lo bota', () => {
    const d = orientar('Ayudante general', '', VACANTES);
    expect(d.tipo).toBe('falta_ciudad');
    const msg = String(mensajeOrientacion(d, 'Ayudante general'));
    expect(msg).toMatch(/ciudad/i);
    expect(msg).toMatch(/Morelia|Zamora|La Piedad/);
    expect(msg).not.toMatch(/no (tenemos|hay) .*(registr|futuras)/i);
  });
  it('a quien le da igual NO se le dice «no tengo esa vacante»', () => {
    expect(mensajeOrientacion(orientar('lo que sea', '', VACANTES), 'lo que sea')).not.toMatch(/no tengo una vacante/i);
  });
});

describe('[RH.3.2.2] 7) el mensaje no miente ni abruma', () => {
  it('máx. 3 opciones, no repite su frase larga, cabe en un WhatsApp, no promete ni descalifica, sólo vacantes reales', () => {
    const pedido = 'Tengo esperiensia en caja pero igual en acomodar mercancía';
    const d = orientar(pedido, 'La Piedad, Michoacán', VACANTES);
    const msg = String(mensajeOrientacion(d, pedido));
    expect(opcionesDe(d).length).toBeLessThanOrEqual(3);
    expect(msg).not.toMatch(/esperiensia/i);
    expect(msg.length).toBeLessThan(800);
    expect(msg).not.toMatch(/te contratamos|ya quedaste|el puesto es tuyo|seguro te contrat/i);
    expect(msg).not.toMatch(/no calificas|no cumples|no eres apto/i);
    const reales = new Set(VACANTES.map((x) => x.name));
    expect(nombresOfrecidos(d).every((n) => reales.has(n))).toBe(true);
  });
});

describe('[RH.3.2.2] 8) entender lo que contesta a la oferta', () => {
  const OFRECIDAS = ['Crédito y Cobranza', 'Anaquelista', 'Vendedor de ruta'];
  it.each([
    ['la de anaquelista', 'elige', 'Anaquelista'], ['Anaquelista', 'elige', 'Anaquelista'],
    ['me interesa la de credito', 'elige', 'Crédito y Cobranza'], ['la 2', 'elige', 'Anaquelista'], ['2', 'elige', 'Anaquelista'],
    ['la primera', 'elige', 'Crédito y Cobranza'], ['vendedor de ruta porfa', 'elige', 'Vendedor de ruta'],
    ['no', 'rechaza', null], ['ninguna me interesa', 'rechaza', null], ['no gracias', 'rechaza', null],
    ['esta muy lejos', 'rechaza', null], ['prefiero esperar', 'rechaza', null],
    ['soy de Zamora', 'ciudad', null], ['Morelia', 'ciudad', null],
    ['si', 'no_claro', null], // con 3 opciones un «sí» no dice cuál
    ['xq', 'no_claro', null],
  ] as Array<[string, string, string | null]>)('«%s» → %s %s', (texto, tipo, nombre) => {
    const r = interpretarRespuestaOferta(texto, OFRECIDAS);
    expect(r.tipo).toBe(tipo);
    if (nombre) expect(r.tipo === 'elige' && r.nombre).toBe(nombre);
  });
  it('con UNA sola opción, «sí» elige esa; «ninguna de las 3» es rechazo, no la tercera', () => {
    expect(interpretarRespuestaOferta('si', ['Anaquelista'])).toEqual({ tipo: 'elige', nombre: 'Anaquelista' });
    expect(interpretarRespuestaOferta('ninguna de las 3', OFRECIDAS).tipo).toBe('rechaza');
  });
});

describe('[RH.3.2.2] 9) nunca truena ni inventa', () => {
  it('sin vacantes, texto vacío o decisión nula', () => {
    for (const lista of [[], null, undefined]) expect(['nada', 'no_es_puesto']).toContain(orientar('cajera', 'Zamora', lista).tipo);
    for (const t of ['', null, undefined]) expect(orientar(t, 'Zamora', VACANTES).tipo).toBe('no_es_puesto');
    expect(mensajeOrientacion(null, 'x')).toBeNull();
    expect(interpretarRespuestaOferta('', ['Anaquelista']).tipo).toBe('no_claro');
  });
  it('⭐ una vacante SIN sucursales aplica en todas (regla de la Suite): se ofrece en cualquier ciudad', () => {
    const conGeneral = [...VACANTES, v('Auxiliar de limpieza', 0, [])];
    expect(nombresOfrecidos(orientar('limpieza', 'Yurécuaro', conGeneral))).toContain('Auxiliar de limpieza');
    // Pero si su domicilio la ubica, manda el domicilio.
    const ubicada = [...VACANTES, { ...v('Auxiliar de limpieza', 0, []), branches_text: 'Av. Madero, Morelia' }];
    expect(nombresOfrecidos(orientar('limpieza', 'Yurécuaro', ubicada))).not.toContain('Auxiliar de limpieza');
  });
  it('el duplicado de RH («Cajero(a)» y «Cajero (a)») no se ofrece dos veces', () => {
    const nombres = ofrecidas('cajera de caja', 'Zamora');
    expect(nombres.filter((n) => /cajero/i.test(n)).length).toBe(1);
  });
});
