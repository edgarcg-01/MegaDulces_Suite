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
