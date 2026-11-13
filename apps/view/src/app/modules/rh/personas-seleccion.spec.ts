import { persona } from '../../../testing/rh.fixture';
import { aplicarCambio, cubiertas, etiquetaPersonas, opcionesPersonas, personaUnica, valorSeleccion, type SeleccionPersonas } from './personas-seleccion';

const gente = [
  persona({ codigo: '1', nombreCompleto: 'Ana Sistemas', departamento: 'SISTEMAS · 07' }),
  persona({ codigo: '2', nombreCompleto: 'Beto Sistemas', departamento: 'SISTEMAS · 07' }),
  persona({ codigo: '3', nombreCompleto: 'Caro Caja', departamento: 'CAJA' }),
  persona({ codigo: '4', nombreCompleto: 'Dani Caja', departamento: 'CAJA' }),
  persona({ codigo: '5', nombreCompleto: 'Eva Suelta', departamento: null }),
  persona({ codigo: '6', nombreCompleto: 'Fer Ventas', departamento: 'VENTAS' }),
];
const nada: SeleccionPersonas = { departamentos: [], elegidas: [] };

describe('[RH.13.5] Personas: plaza, departamento y personas sueltas', () => {
  it('las opciones: cada departamento seguido de su gente, «SIN DEPARTAMENTO» al final', () => {
    const o = opcionesPersonas(gente).map((x) => x.value);
    expect(o).toEqual(['d:CAJA', 'p:3', 'p:4', 'd:SISTEMAS', 'p:1', 'p:2', 'd:VENTAS', 'p:6', 'd:SIN DEPARTAMENTO', 'p:5']);
    expect(opcionesPersonas(gente)[0]).toMatchObject({ tipo: 'depto', n: 2 });
  });

  it('nada elegido = toda la plaza: el campo cerrado no dice nada y la lista no se filtra', () => {
    expect(etiquetaPersonas(gente, nada)).toBe('');
    expect(personaUnica(gente, nada)).toBeNull();
    expect(valorSeleccion(gente, nada)).toEqual([]);
  });

  it('marcar un departamento lo elige entero y marca a los suyos', () => {
    const s = aplicarCambio(gente, nada, ['d:SISTEMAS']);
    expect(s).toEqual({ departamentos: ['SISTEMAS'], elegidas: [] });
    expect(valorSeleccion(gente, s)).toEqual(['d:SISTEMAS', 'p:1', 'p:2']);
    expect(etiquetaPersonas(gente, s)).toBe('SISTEMAS');
  });

  it('desmarcar a uno de un departamento entero deja «todos menos él»', () => {
    const s0 = aplicarCambio(gente, nada, ['d:SISTEMAS']);
    const s = aplicarCambio(gente, s0, ['d:SISTEMAS', 'p:1']);   // PrimeNG quitó p:2
    expect(s).toEqual({ departamentos: [], elegidas: ['1'] });
    expect(personaUnica(gente, s)?.codigo).toBe('1');
    expect(etiquetaPersonas(gente, s)).toBe('Ana Sistemas');
  });

  it('personas sueltas de varios departamentos', () => {
    let s = aplicarCambio(gente, nada, ['p:1']);
    s = aplicarCambio(gente, s, [...valorSeleccion(gente, s), 'p:3']);
    expect([...cubiertas(gente, s)].sort()).toEqual(['1', '3']);
    expect(etiquetaPersonas(gente, s)).toBe('2 personas');
    expect(personaUnica(gente, s)).toBeNull();
  });

  it('marcar a todos los de un departamento (de dos o más) lo vuelve el departamento', () => {
    let s = aplicarCambio(gente, nada, ['p:3']);
    s = aplicarCambio(gente, s, [...valorSeleccion(gente, s), 'p:4']);
    expect(s).toEqual({ departamentos: ['CAJA'], elegidas: [] });
  });

  it('con una sola persona en el departamento no se promueve: se sigue viendo su nombre', () => {
    const s = aplicarCambio(gente, nada, ['p:6']);
    expect(s).toEqual({ departamentos: [], elegidas: ['6'] });
    expect(etiquetaPersonas(gente, s)).toBe('Fer Ventas');
  });

  it('desmarcar el departamento quita a los suyos; las sueltas de otro se quedan', () => {
    let s = aplicarCambio(gente, nada, ['d:CAJA']);
    s = aplicarCambio(gente, s, [...valorSeleccion(gente, s), 'p:5']);
    expect(etiquetaPersonas(gente, s)).toBe('3 personas');
    s = aplicarCambio(gente, s, valorSeleccion(gente, s).filter((v) => v !== 'd:CAJA'));
    expect(s).toEqual({ departamentos: [], elegidas: ['5'] });
  });

  it('marcar a alguien cuyo departamento ya está entero no lo duplica', () => {
    const s0 = aplicarCambio(gente, nada, ['d:CAJA']);
    expect(aplicarCambio(gente, s0, [...valorSeleccion(gente, s0), 'p:3'])).toEqual(s0);
  });

  it('cuatro departamentos o más se cuentan; hasta tres se nombran', () => {
    expect(etiquetaPersonas(gente, { departamentos: ['CAJA', 'SISTEMAS'], elegidas: [] })).toBe('CAJA + SISTEMAS');
    expect(etiquetaPersonas(gente, { departamentos: ['CAJA', 'SISTEMAS', 'VENTAS', 'SIN DEPARTAMENTO'], elegidas: [] })).toBe('4 departamentos');
  });

  it('un departamento que se quedó sin gente esta semana sigue elegido (no se convierte en códigos)', () => {
    const s = { departamentos: ['SISTEMAS'], elegidas: [] };
    const nuevaSemana = [...gente, persona({ codigo: '9', nombreCompleto: 'Nuevo Sistemas', departamento: 'SISTEMAS' })];
    expect([...cubiertas(nuevaSemana, s)].sort()).toEqual(['1', '2', '9']);
  });
});
