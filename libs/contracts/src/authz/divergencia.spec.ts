import { evaluarDivergencia } from './divergencia';

/**
 * `[OR.2.1]` — El caso que da nombre a este archivo es el TERCERO: puesto sin perfil propuesto.
 * Era el que el formulario viejo resolvía al revés que el backend, y con él **20 de 57 puestos**
 * no podían usarse para dar de alta a nadie.
 */
describe('[OR.2.1] evaluarDivergencia', () => {
  it('el puesto propone lo mismo que se eligió: no hay nada que explicar', () => {
    expect(evaluarDivergencia({ propone: 'almacenista', elegido: 'almacenista' }))
      .toEqual({ diverge: false, sinPropuesta: false });
  });

  it('el puesto propone OTRO perfil: hay que explicarlo', () => {
    expect(evaluarDivergencia({ propone: 'promotor_ruta', elegido: 'vendedor_ruta' }))
      .toEqual({ diverge: true, sinPropuesta: false });
  });

  it('⭐ el puesto NO propone nada: también hay que explicarlo, y se distingue', () => {
    // El formulario viejo devolvía `false` acá. El backend devolvía 400. Entre los dos, el alta
    // con esos puestos era imposible.
    expect(evaluarDivergencia({ propone: null, elegido: 'administrativo' }))
      .toEqual({ diverge: true, sinPropuesta: true });
  });

  it('⭐ sin perfil elegido todavía no se decidió nada: no diverge', () => {
    // Si devolviera `true`, el formulario saldría en rojo antes de tocar el selector.
    expect(evaluarDivergencia({ propone: null, elegido: null }).diverge).toBe(false);
    expect(evaluarDivergencia({ propone: 'almacenista', elegido: '' }).diverge).toBe(false);
  });

  it('compara sin importar mayúsculas ni espacios: el perfil viaja en los dos casos', () => {
    expect(evaluarDivergencia({ propone: ' Almacenista ', elegido: 'almacenista' }).diverge).toBe(false);
  });

  it('una cadena vacía es lo mismo que no proponer', () => {
    expect(evaluarDivergencia({ propone: '   ', elegido: 'administrativo' }))
      .toEqual({ diverge: true, sinPropuesta: true });
  });
});
