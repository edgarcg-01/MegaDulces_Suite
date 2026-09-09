import { elegirVozLatina, puntuarVoz, VozDisponible } from './voz-latina';

/**
 * La elección de voz es la clase de código que "parece funcionar" y suena mal en
 * la máquina de otro: depende de qué voces tenga el sistema, y eso cambia en cada
 * equipo. Acá se fijan los casos reales con los nombres que de verdad entrega
 * Windows / Edge / Chrome.
 */

const v = (name: string, lang: string, def = false): VozDisponible => ({ name, lang, default: def });

// Lo que ofrece un Windows con Español (México) instalado.
const WINDOWS_ES_MX = [
  v('Microsoft David - English (United States)', 'en-US', true),
  v('Microsoft Raul - Spanish (Mexico)', 'es-MX'),
  v('Microsoft Sabina - Spanish (Mexico)', 'es-MX'),
  v('Microsoft Helena - Spanish (Spain)', 'es-ES'),
];

describe('elegirVozLatina', () => {
  it('prefiere la femenina de México sobre la masculina de México', () => {
    expect(elegirVozLatina(WINDOWS_ES_MX).voz?.name).toContain('Sabina');
  });

  it('prefiere México sobre España aunque las dos sean femeninas', () => {
    const r = elegirVozLatina([
      v('Microsoft Helena - Spanish (Spain)', 'es-ES'),
      v('Microsoft Sabina - Spanish (Mexico)', 'es-MX'),
    ]);
    expect(r.voz?.lang).toBe('es-MX');
  });

  it('elige una latina de otro país antes que una de España', () => {
    const r = elegirVozLatina([
      v('Microsoft Laura - Spanish (Spain)', 'es-ES'),
      v('Google español de Estados Unidos', 'es-US'),
    ]);
    expect(r.voz?.lang).toBe('es-US');
  });

  it('si sólo hay una masculina en español, la usa igual (mejor que inglés)', () => {
    const r = elegirVozLatina([
      v('Microsoft David - English (United States)', 'en-US', true),
      v('Microsoft Raul - Spanish (Mexico)', 'es-MX'),
    ]);
    expect(r.voz?.name).toContain('Raul');
    expect(r.esEspanol).toBe(true);
  });

  // El caso de ESTA máquina: ni una voz española. Es el que hay que avisar,
  // porque el navegador NO falla — lee español con acento inglés.
  it('sin voz española avisa y reporta la que el sistema usaría', () => {
    const r = elegirVozLatina([
      v('Microsoft David - English (United States)', 'en-US', true),
      v('Microsoft Zira - English (United States)', 'en-US'),
    ]);
    expect(r.voz).toBeNull();
    expect(r.esEspanol).toBe(false);
    expect(r.etiqueta).toContain('David');
  });

  it('lista vacía (las voces cargan async) no se toma como error', () => {
    expect(elegirVozLatina([])).toEqual({ voz: null, esEspanol: true, etiqueta: null });
    expect(elegirVozLatina(null)).toEqual({ voz: null, esEspanol: true, etiqueta: null });
  });

  it('la de nube desempata contra la local del mismo acento y sexo', () => {
    const local = v('Microsoft Dalia - Spanish (Mexico)', 'es-MX');
    const nube = v('Google Dalia Neural - Spanish (Mexico)', 'es-MX');
    expect(puntuarVoz(nube)).toBeGreaterThan(puntuarVoz(local));
  });

  it('España nunca gana por defecto: puntúa menos que cualquier latina', () => {
    expect(puntuarVoz(v('Microsoft Sabina - Spanish (Mexico)', 'es-MX')))
      .toBeGreaterThan(puntuarVoz(v('Microsoft Helena - Spanish (Spain)', 'es-ES')));
  });
});
