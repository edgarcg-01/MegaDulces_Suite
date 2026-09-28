import { limpiarRastroDeSesion, CLAVES_DEL_APARATO } from './session-cleanup';

/**
 * `[SEG.2]` — El rastro de una sesión no puede sobrevivir al cierre de sesión.
 *
 * ── Lo que vigila, y por qué cada caso está ─────────────────────────────────────────────────
 * El defecto medido: el service worker cachea respuestas de la API **por URL, sin el usuario en
 * la llave**, y `api-performance` es cache-first por 24 h sobre `/api/users/**`. O sea que quien
 * entra después puede recibir la respuesta que bajó quien se fue, sin tocar la red.
 *
 * ⭐ **La prueba que importa es la del contra-ejemplo**: que los caches de ASSETS sobrevivan.
 * Sin ella, un filtro roto que borre TODO pasaría los demás casos con las mejores notas — y
 * dejaría sin aplicación a una tablet que cierra sesión estando sin red. Un candado que sólo
 * sabe decir "borré" no distingue limpiar de arrasar.
 */

type CacheFalso = { nombres: string[]; borrados: string[] };

const montarCaches = (nombres: string[]): CacheFalso => {
  const estado: CacheFalso = { nombres: [...nombres], borrados: [] };
  (globalThis as unknown as { caches: unknown }).caches = {
    keys: async () => [...estado.nombres],
    delete: async (n: string) => {
      estado.borrados.push(n);
      estado.nombres = estado.nombres.filter((x) => x !== n);
      return true;
    },
  };
  return estado;
};

/** Los nombres reales que usa `@angular/service-worker`: `<prefijo>:<version>:data|assets:...`. */
const NOMBRES_NGSW = [
  'ngsw:/:1:data:dynamic:api-performance:cache',
  'ngsw:/:1:data:dynamic:api-freshness:cache',
  'ngsw:/:1:data:dynamic:api-performance:lru',
  'ngsw:/:1:assets:app:cache',
  'ngsw:/:1:assets:chunks:cache',
  'ngsw:/:db:control',
];

describe('[SEG.2] limpiarRastroDeSesion', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    delete (globalThis as unknown as { caches?: unknown }).caches;
  });

  it('⭐ NEGATIVA: los caches de DATOS de la API se borran — son los que se sirven sin mirar quién pregunta', async () => {
    const c = montarCaches(NOMBRES_NGSW);
    const r = await limpiarRastroDeSesion();

    expect(c.borrados).toContain('ngsw:/:1:data:dynamic:api-performance:cache');
    expect(c.borrados).toContain('ngsw:/:1:data:dynamic:api-freshness:cache');
    expect(r.cachesApi).toBe(3);
  });

  it('⭐ CONTRA-EJEMPLO: los caches de ASSETS NO se tocan — ahí vive la app, no los datos de nadie', async () => {
    const c = montarCaches(NOMBRES_NGSW);
    await limpiarRastroDeSesion();

    // Si esta aserción cae, el filtro arrasa: una tablet que cierra sesión sin red se queda
    // sin aplicación. "Borré todo" no es lo mismo que "borré lo que era de la persona".
    expect(c.borrados).not.toContain('ngsw:/:1:assets:app:cache');
    expect(c.borrados).not.toContain('ngsw:/:1:assets:chunks:cache');
    expect(c.nombres).toContain('ngsw:/:1:assets:app:cache');
  });

  it('borra lo que es de la PERSONA y conserva lo que es del APARATO', async () => {
    // De la persona: su última posición, sus diagnósticos, sus filtros, su token.
    localStorage.setItem('ultimaPosicionGPS', '{"lat":20.3,"lng":-102.0}');
    localStorage.setItem('app_diag', '[{"url":"/api/users"}]');
    localStorage.setItem('sell-out-filters:v1', '{"sucursal":"05"}');
    localStorage.setItem('auth_token', 'eyJ...');
    localStorage.setItem('captures.allowSimulatedGps', '1');
    // Del aparato: tema, densidad, y que este equipo es un kiosco.
    localStorage.setItem('tradeMarketingThemeMode', 'dark');
    localStorage.setItem('md.table-density', 'compact');
    localStorage.setItem('tienda.verificador.kiosco', '1');

    await limpiarRastroDeSesion();

    expect(localStorage.getItem('ultimaPosicionGPS')).toBeNull();
    expect(localStorage.getItem('app_diag')).toBeNull();
    expect(localStorage.getItem('sell-out-filters:v1')).toBeNull();
    expect(localStorage.getItem('auth_token')).toBeNull();
    // Una bandera que permite falsear el GPS no puede heredarse entre personas.
    expect(localStorage.getItem('captures.allowSimulatedGps')).toBeNull();

    expect(localStorage.getItem('tradeMarketingThemeMode')).toBe('dark');
    expect(localStorage.getItem('md.table-density')).toBe('compact');
    expect(localStorage.getItem('tienda.verificador.kiosco')).toBe('1');
  });

  it('⭐ una clave NUEVA que nadie declaró se borra por default', async () => {
    // Es la razón de que la lista sea de sobrevivientes y no de condenados: lo que alguien
    // agregue el mes que viene no va a estar en ninguna lista, y tiene que irse igual.
    localStorage.setItem('modulo.inventado.manana', 'datos de la persona');

    await limpiarRastroDeSesion();

    expect(localStorage.getItem('modulo.inventado.manana')).toBeNull();
  });

  it('vacía sessionStorage entero', async () => {
    sessionStorage.setItem('lo-que-sea', 'x');
    sessionStorage.setItem('otra', 'y');

    const r = await limpiarRastroDeSesion();

    expect(sessionStorage.length).toBe(0);
    expect(r.sessionStorage).toBe(2);
  });

  it('DECLARA que IndexedDB queda intacta en vez de borrar trabajo sin sincronizar', async () => {
    const r = await limpiarRastroDeSesion();
    expect(r.declarado.some((d) => /IndexedDB/i.test(d))).toBe(true);
  });

  it('sin service worker no revienta ni miente: cero caches borrados', async () => {
    const r = await limpiarRastroDeSesion();
    expect(r.cachesApi).toBe(0);
  });

  it('avisa si el service worker está pero ningún cache casó con el patrón', async () => {
    // El día que ngsw cambie cómo nombra sus caches, esto es lo único que lo avisa: si no,
    // la limpieza devolvería 0 y se leería igual que "no había nada que borrar".
    const c = montarCaches(['ngsw:/:1:assets:app:cache']);
    const r = await limpiarRastroDeSesion();

    expect(c.borrados).toHaveLength(0);
    expect(r.declarado.some((d) => /ningun cache de datos reconocido/i.test(d))).toBe(true);
  });

  it('la lista de sobrevivientes no tiene duplicados ni claves vacías', () => {
    expect(new Set(CLAVES_DEL_APARATO).size).toBe(CLAVES_DEL_APARATO.length);
    expect(CLAVES_DEL_APARATO.every((k) => !!k.trim())).toBe(true);
  });
});
