/**
 * `[RH.1.2]` Reglas de los relojes: el nombre que acepta el equipo, el semáforo, los intentos de
 * una orden, y la llave que acepta tanto el encabezado de la Suite como el del agente de MT.
 */
import { esRelojDesconocido, estadoTrasIntento, nombreParaReloj, semaforoReloj, tipoParaAgente, MUDO_SEG, OK_SEG } from './relojes';
import { llaveDelLector } from '../hr-ingest.guard';

describe('nombre para el reloj (24 bytes ASCII)', () => {
  it('quita acentos y «ñ», símbolos y espacios de más', () => {
    expect(nombreParaReloj('  Prueba   Ñandú, Ángel!! ')).toBe('Prueba Nandu Angel');
  });
  it('se corta a 23 caracteres (queda el cero final)', () => {
    expect(nombreParaReloj('A'.repeat(40))).toHaveLength(23);
  });
  it('vacío si no queda nada utilizable', () => {
    expect(nombreParaReloj('¡¿?!')).toBe('');
    expect(nombreParaReloj(null)).toBe('');
  });
});

describe('semáforo del reloj', () => {
  it('pausado gana a todo; sin señal nunca es mudo', () => {
    expect(semaforoReloj({ pendiente: true, segundosSinSenal: 5 })).toBe('pendiente');
    expect(semaforoReloj({ pendiente: false, segundosSinSenal: null })).toBe('mudo');
  });
  it('verde bajo 10 min, amarillo hasta 2 h, rojo desde 2 h', () => {
    expect(semaforoReloj({ pendiente: false, segundosSinSenal: OK_SEG - 1 })).toBe('ok');
    expect(semaforoReloj({ pendiente: false, segundosSinSenal: OK_SEG })).toBe('atrasado');
    expect(semaforoReloj({ pendiente: false, segundosSinSenal: MUDO_SEG })).toBe('mudo');
  });

  // `[RH.13.1]` El caso de PH (11-nov): el lector manda latidos con error cada pocos minutos.
  const PH = { pendiente: false, segundosSinSenal: 120, error: 'no responde en 192.0.2.10:4370' };
  it('lector vivo pero reloj caído hace 4 h 30 m: rojo, no verde', () => {
    expect(semaforoReloj({ ...PH, segundosSinLectura: 4.5 * 3600 })).toBe('mudo');
  });
  it('con error nunca es verde, aunque la última lectura buena sea reciente', () => {
    expect(semaforoReloj({ ...PH, segundosSinLectura: 30 })).toBe('atrasado');
    expect(semaforoReloj({ ...PH, segundosSinLectura: MUDO_SEG - 1 })).toBe('atrasado');
    expect(semaforoReloj({ ...PH, segundosSinLectura: MUDO_SEG })).toBe('mudo');
  });
  it('con error y sin ninguna lectura buena: rojo', () => {
    expect(semaforoReloj({ ...PH, segundosSinLectura: null })).toBe('mudo');
    expect(semaforoReloj({ ...PH })).toBe('mudo');
  });
  it('sin error, la regla de siempre (el error en blanco no cuenta)', () => {
    expect(semaforoReloj({ pendiente: false, segundosSinSenal: 120, error: '', segundosSinLectura: 9_999 })).toBe('ok');
    expect(semaforoReloj({ pendiente: false, segundosSinSenal: 120, error: '   ', segundosSinLectura: null })).toBe('ok');
    expect(semaforoReloj({ pendiente: false, segundosSinSenal: 120, error: null })).toBe('ok');
  });
  it('en pausa gana aunque haya error', () => {
    expect(semaforoReloj({ ...PH, pendiente: true, segundosSinLectura: null })).toBe('pendiente');
  });
});

describe('intentos de una orden', () => {
  it('un éxito termina; un error se reintenta y al tercero se queda en error', () => {
    expect(estadoTrasIntento('hecho', 2)).toBe('hecho');
    expect([0, 1, 2].map((n) => estadoTrasIntento('error', n))).toEqual(['pendiente', 'pendiente', 'error']);
  });
  it('el agente de Mega Talento entiende <orden>_usuario', () => {
    expect(tipoParaAgente('renombrar')).toBe('renombrar_usuario');
  });
  it('el reloj desconocido de la carga no es un equipo', () => {
    expect([esRelojDesconocido('MT-SIN-RELOJ-cedis'), esRelojDesconocido('CLXK225060395')]).toEqual([true, false]);
  });
});

describe('llave del lector', () => {
  it('acepta el encabezado de la Suite y el del agente de Mega Talento; nada más', () => {
    expect(llaveDelLector({ 'x-hr-ingest-key': 'k1' })).toBe('k1');
    expect(llaveDelLector({ 'x-agente-token': 'k2' })).toBe('k2');
    expect(llaveDelLector({ authorization: 'Bearer k3' })).toBeUndefined();
    expect(llaveDelLector({ 'x-agente-token': '' })).toBeUndefined();
  });
});
