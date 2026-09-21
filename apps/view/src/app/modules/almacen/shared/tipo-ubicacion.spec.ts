import { tipoDeUbicacion, TIPOS_UBICACION } from './tipo-ubicacion';

/**
 * El tipo de una ubicación se **deriva** del nombre o del código, porque
 * `commercial.warehouse_bins` no guarda una columna de tipo (WMS-REC.10).
 *
 * Lo que se protege acá es la trampa del prefijo: `T` es tarima, pero `TIENDA-1`
 * no lo es. Sin exigir que después del prefijo venga un separador o un dígito,
 * cualquier rack con nombre que empiece con T quedaba clasificado como tarima, y
 * el filtro de la pantalla mostraría lo que no es.
 */
describe('tipoDeUbicacion', () => {
  it('manda el NOMBRE, que es lo que escribió una persona', () => {
    expect(tipoDeUbicacion('X-9', 'Rack 12').key).toBe('rack');
    expect(tipoDeUbicacion('X-9', 'Tarima 3').key).toBe('tarima');
    // Sin importar mayúsculas ni espacios de más.
    expect(tipoDeUbicacion('', '  tarima 7 ').key).toBe('tarima');
  });

  it('cae al CÓDIGO cuando no hay nombre', () => {
    expect(tipoDeUbicacion('R-12').key).toBe('rack');
    expect(tipoDeUbicacion('T3').key).toBe('tarima');
    expect(tipoDeUbicacion('r_04').key).toBe('rack');
  });

  it('un código que arranca con la letra pero sigue con LETRA no cuenta', () => {
    // La trampa: sin el dígito obligatorio, estos dos quedaban mal clasificados.
    expect(tipoDeUbicacion('RETORNO').key).toBe('otro');
    expect(tipoDeUbicacion('TIENDA-1').key).toBe('otro');
  });

  it('lo que no dice nada se declara Otra — no se inventa un tipo', () => {
    expect(tipoDeUbicacion('X-9').key).toBe('otro');
    expect(tipoDeUbicacion('').key).toBe('otro');
    expect(tipoDeUbicacion(null, null).key).toBe('otro');
    expect(tipoDeUbicacion(undefined).label).toBe('Otra');
  });

  it('el nombre le gana al código cuando se contradicen', () => {
    // El código puede venir de un cartel viejo; el nombre lo escribió alguien hoy.
    expect(tipoDeUbicacion('R-12', 'Tarima 5').key).toBe('tarima');
  });

  it('el vocabulario tiene los tres tipos y ninguno repite prefijo', () => {
    expect(TIPOS_UBICACION.map((t) => t.key)).toEqual(['rack', 'tarima', 'otro']);
    const prefijos = TIPOS_UBICACION.map((t) => t.prefijo);
    expect(new Set(prefijos).size).toBe(prefijos.length);
  });
});
