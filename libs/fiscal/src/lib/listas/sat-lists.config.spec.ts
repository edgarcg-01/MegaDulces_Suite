import { DIAS_LISTA_VIEJA, diasDeAtraso, fechaDeActualizacion, fechaDeLaLista, SAT_LISTS } from './sat-lists.config';

/**
 * `[PGP.161]` La 69-B se bajaba bien cada noche desde una ruta que el SAT dejó de actualizar: once
 * meses con datos «al 31 de diciembre de 2025» sin que nada lo dijera. Las primeras líneas de abajo
 * son las reales de los dos archivos (medido el 2026-11-19).
 */
const NUEVO = '"Información actualizada al 31 de octubre de 2026; los listados a que se hace mención, son de carácter público';
const VIEJO = '"Información actualizada al 31 de diciembre de 2025; los listados a que se hace mención, son de carácter público';
const SIN_FECHA = 'RFC,RAZÓN SOCIAL,TIPO PERSONA,SUPUESTO,FECHAS DE PRIMERA PUBLICACION';

describe('[PGP.161] la fecha de los datos de una lista del SAT', () => {
  it('lee la fecha que dice el propio archivo', () => {
    expect(fechaDeActualizacion(NUEVO)).toBe('2026-10-31');
    expect(fechaDeActualizacion(VIEJO)).toBe('2025-12-31');
    expect(fechaDeActualizacion('Informacion Actualizada al 5 de Septiembre de 2026')).toBe('2026-09-05');
  });

  it('si el archivo no la dice, no la inventa', () => {
    expect(fechaDeActualizacion(SIN_FECHA)).toBeNull();
    expect(fechaDeActualizacion('actualizada al 31 de brumario de 2026')).toBeNull();
  });

  it('la fecha del texto gana; si no hay, usa el Last-Modified; si no hay ninguna, null', () => {
    expect(fechaDeLaLista(NUEVO, 'Wed, 18 Nov 2026 16:20:34 GMT')).toBe('2026-10-31');
    expect(fechaDeLaLista(SIN_FECHA, 'Wed, 18 Nov 2026 16:16:32 GMT')).toBe('2026-11-18');
    expect(fechaDeLaLista(SIN_FECHA, null)).toBeNull();
    expect(fechaDeLaLista(SIN_FECHA, 'no es una fecha')).toBeNull();
  });

  it('el archivo viejo cuenta como lista vieja y el vigente no (control)', () => {
    expect(diasDeAtraso('2025-12-31', '2026-11-19')).toBeGreaterThan(DIAS_LISTA_VIEJA);
    expect(diasDeAtraso('2026-10-31', '2026-11-19')).toBeLessThanOrEqual(DIAS_LISTA_VIEJA);
  });

  it.skipIf(!!process.env.EFOS_CSV_URL)('la 69-B ya no se baja de la ruta que el SAT dejó de actualizar', () => {
    const urls = SAT_LISTS['69B'].urls;
    expect(urls.some((u) => u.includes('omawww.sat.gob.mx/cifras_sat'))).toBe(false);
    expect(urls.some((u) => u.includes('/Datos_abiertos/Documents_AGAFF/Listado_completo_69-B.csv'))).toBe(true);
  });
});
