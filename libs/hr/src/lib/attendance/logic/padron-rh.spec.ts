/**
 * `[RH.14]` El padrón a cargo de RH, como lógica pura (sin base: corre en CI):
 *   · `[RH.14.5]` la ficha acepta departamento, puesto y sucursal (null = quitar) y rechaza códigos con forma inválida;
 *   · `[RH.14.4]` qué nombre es un apodo por confirmar;
 *   · `[RH.14.6]` quién se propone dar de baja por N días sin checar, y quién no porque una incidencia lo explica.
 */
import {
  DIAS_SIN_CHECAR_BAJA, clasificarPosiblesBajas, diasParaBaja, nombrePorConfirmar, validarFicha,
} from './personas';

describe('[RH.14.5] validarFicha con lo de la persona', () => {
  it('acepta los códigos, null para quitar, y cuenta como cambio', () => {
    expect(validarFicha({ departamento_code: ' almacen ', puesto_code: 'aux_almacen', sucursal_code: '03' }))
      .toEqual({ departamento_code: 'almacen', puesto_code: 'aux_almacen', sucursal_code: '03' });
    expect(validarFicha({ sucursal_code: null })).toEqual({ sucursal_code: null });
    expect(validarFicha({ departamento_code: '' })).toEqual({ departamento_code: null });
  });
  it('NEGATIVO: forma inválida y sucursal que no es de 2 dígitos', () => {
    expect(validarFicha({ departamento_code: 'a b;drop' })).toEqual({ error: expect.stringContaining('Departamento') });
    expect(validarFicha({ sucursal_code: 'MD-30' })).toEqual({ error: 'Sucursal: elige una de la lista.' });
    expect(validarFicha({})).toEqual({ error: 'No hay nada que cambiar.' });
  });
  it('lo de antes sigue igual', () => {
    expect(validarFicha({ nombre: ' Ana  López ', seccion: ' cajas ' })).toEqual({ nombre: 'Ana López', seccion: 'CAJAS' });
    expect(validarFicha({ nombre: 'Ana' })).toEqual({ error: expect.stringContaining('nombre completo') });
  });
});

describe('[RH.14.4] nombrePorConfirmar', () => {
  it('apodo del reloj, corto, y el que ya está bien', () => {
    expect(nombrePorConfirmar('Claudia', ['CLAUDIA'])).toBe('apodo_del_reloj');
    // Igual al reloj aunque tenga 3 palabras: el reloj corta a 23 letras y la carga lo copió tal cual.
    expect(nombrePorConfirmar('Jose Alberto Moreno Vil', ['JOSE ALBERTO MORENO VIL'])).toBe('apodo_del_reloj');
    expect(nombrePorConfirmar('Marta Cuetara', ['Martacuetara'])).toBe('menos_de_3_palabras');
    expect(nombrePorConfirmar('', [])).toBe('menos_de_3_palabras');
    expect(nombrePorConfirmar('María Dolores Berber Tovar', ['Dolores'])).toBeNull();
  });
  it('NEGATIVO: un nombre completo con acentos distinto del reloj no se marca', () => {
    expect(nombrePorConfirmar('Luis David Navarro Alvarado', ['Luis', null, undefined])).toBeNull();
  });
});

describe('[RH.14.6] posibles bajas', () => {
  const hoy = '2026-11-18';
  const f = (codigo: string, ultima: string | null) => ({ codigo, ultima });
  it('31 días por omisión y el rango acotado', () => {
    expect(DIAS_SIN_CHECAR_BAJA).toBe(31);
    expect([diasParaBaja(undefined), diasParaBaja(''), diasParaBaja('abc'), diasParaBaja('60'), diasParaBaja(1), diasParaBaja(9999)])
      .toEqual([31, 31, 31, 60, 7, 365]);
  });
  it('propone a quien lleva 31 días o más sin checar o nunca checó; no a quien checó dentro de la ventana', () => {
    const { proponer, explicadas } = clasificarPosiblesBajas(
      [f('1', '2026-11-17'), f('2', '2026-10-18'), f('3', '2026-10-17'), f('4', null), f('5', '2026-06-01')], [], { dias: 31, hoy });
    // 18-oct es justo el límite (hoy − 31): se propone; 17-oct también; 17-nov no.
    expect(proponer.map((p) => [p.codigo, p.diasSinChecar])).toEqual([['5', 170], ['3', 32], ['2', 31], ['4', null]]);
    expect(explicadas).toEqual([]);
  });
  it('NEGATIVO: unas vacaciones que tocan el tramo sin checar la explican y no se propone', () => {
    const incs = [
      { codigo: '2', desde: '2026-10-20', hasta: '2026-12-01', etiqueta: 'Vacaciones' },
      // Una incapacidad que terminó ANTES de su última checada no explica la ausencia de después.
      { codigo: '3', desde: '2026-09-01', hasta: '2026-09-15', etiqueta: 'Incapacidad' },
    ];
    const { proponer, explicadas } = clasificarPosiblesBajas([f('2', '2026-10-01'), f('3', '2026-10-01')], incs, { dias: 31, hoy });
    expect(proponer.map((p) => p.codigo)).toEqual(['3']);
    expect(explicadas.map((e) => [e.codigo, e.incidencia.etiqueta])).toEqual([['2', 'Vacaciones']]);
  });
});
