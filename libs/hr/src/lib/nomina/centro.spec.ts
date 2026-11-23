/**
 * `[NE.0.6]` El centro se parte en sitio físico y área — y lo que no se midió se declara.
 *
 * Lo medido el 2026-11-23: el SITIO se deriva de dónde checa la gente (30 de 34 centros, casi
 * todos con 100 % de consenso); el ÁREA **no se puede derivar**, porque el campo de la Suite y el
 * nombre del centro coinciden sólo en 21 de 28 (75 %, contra 4.8 % del azar). La prueba que más
 * importa es la que exige que un área **propuesta** nunca se cuente como establecida.
 *
 * Centros reales; ninguna persona nombrada.
 */
import {
  ALIAS_DECLARADOS,
  AREAS_CONFIRMADAS,
  areaSegunElNombre,
  BASE_MINIMA,
  CentroInvalido,
  claveDeCentro,
  CONSENSO_MINIMO,
  cubreElUniverso,
  resuelveCentro,
  type SitioDerivado,
} from './centro';

const derivado = (sitio: string, consenso = 1, base = 10): SitioDerivado => ({ sitio, consenso, base });

const DERIVADOS = new Map<string, SitioDerivado>([
  [claveDeCentro('Morelia Abastos'), derivado('morelia-abastos', 1, 18)],
  [claveDeCentro('Morelia Abastos TLMK'), derivado('morelia-abastos', 1, 9)],
  [claveDeCentro('PHidalgo Staff'), derivado('sucursal-ph', 0.67, 3)],
  [claveDeCentro('Promotoras'), derivado('la-piedad-abastos', 1, 1)],
]);

describe('el nombre del centro lleva el área adentro', () => {
  it('reconoce los sufijos medidos', () => {
    expect(areaSegunElNombre('Morelia Abastos TLMK')).toBe('telemarketing');
    expect(areaSegunElNombre('PHidalgo RD')).toBe('ruta_directa');
    expect(areaSegunElNombre('Rutas Vecinales')).toBe('ruta_vecinal');
    expect(areaSegunElNombre('Canindo Staff')).toBe('administracion');
  });

  it('y dice que NO cuando el nombre no la trae', () => {
    expect(areaSegunElNombre('Morelia Abastos')).toBeNull();
    expect(areaSegunElNombre('8Esquinas')).toBeNull();
  });

  it('⛔ no confunde «RD» con una palabra que lo contiene adentro', () => {
    // ⚠️ Honestidad del caso: NINGUNO de los 34 centros de hoy ejerce esto — mi primer intento usó
    // «Morelia Madero», que NO contiene la secuencia «rd» y por eso pasaba con límite de palabra y
    // sin él: una prueba que parecía probar algo y no probaba nada. Estos dos sí discriminan, y la
    // prueba es defensiva: el día que exista un centro así, no se clasificará solo como ruta.
    expect(areaSegunElNombre('Guarderia')).toBeNull();
    expect(areaSegunElNombre('Bordados')).toBeNull();
    // y el área real se sigue reconociendo, pegada o separada
    expect(areaSegunElNombre('RD Zamora')).toBe('ruta_directa');
  });

  it('rechaza algo que no es texto', () => {
    expect(() => areaSegunElNombre(7 as unknown as string)).toThrow(CentroInvalido);
  });
});

describe('dos escrituras del mismo centro no son dos centros', () => {
  it('iguala acentos, espacios y mayúsculas', () => {
    expect(claveDeCentro('8 Esquinas')).toBe(claveDeCentro('8Esquinas'));
    expect(claveDeCentro('Yurécuaro')).toBe(claveDeCentro('Yurecuaro'));
    expect(claveDeCentro('PHidalgo')).toBe(claveDeCentro('Phidalgo'));
  });

  it('⛔ pero NO inventa que un error de dedo es el mismo centro', () => {
    // Medido: «Marcadotecnia» (1 persona) y «Mercadotecnia» (4) conviven en la misma semana.
    // La normalización sola NO los une: un error de dedo y un centro distinto se ven igual.
    expect(claveDeCentro('Marcadotecnia')).not.toBe(claveDeCentro('Mercadotecnia'));
  });
});

describe('los alias y las áreas que una PERSONA decidió', () => {
  it('⭐⭐ el alias declarado une las dos escrituras, y deja rastro de que se aplicó', () => {
    // Edgar, 2026-11-23: «3. si, es la misma».
    expect(ALIAS_DECLARADOS.get(claveDeCentro('Marcadotecnia'))).toBe(claveDeCentro('Mercadotecnia'));

    const derivados = new Map([[claveDeCentro('Mercadotecnia'), derivado('corporativo', 1, 4)]]);
    const r = resuelveCentro('Marcadotecnia', { derivados });
    expect(r.claveCanonica).toBe(claveDeCentro('Mercadotecnia'));
    expect(r.aliasAplicado).toBe(claveDeCentro('Marcadotecnia'));
    // ⭐ y por eso hereda el sitio derivado del centro bueno, que sola no tendría
    expect([r.sitio.valor, r.sitio.procedencia]).toEqual(['corporativo', 'derivado']);
  });

  it('un centro sin alias no inventa uno, y lo dice con un null, no con el mismo valor', () => {
    const derivados = new Map([[claveDeCentro('Mercadotecnia'), derivado('corporativo', 1, 4)]]);
    expect(resuelveCentro('Mercadotecnia', { derivados }).aliasAplicado).toBeNull();
  });

  it('⭐⭐ «Morelia Vecinal» es ruta_vecinal porque una persona lo decidió, no porque lo diga el nombre', () => {
    // Edgar, 2026-11-23: «morelia vecinal es rv». Medido antes: el nombre decía vecinal y la Suite
    // decía ruta_directa en 3 personas. La decisión gana, y queda con procedencia establecida.
    expect(AREAS_CONFIRMADAS.get(claveDeCentro('Morelia Vecinal'))).toBe('ruta_vecinal');
    const derivados = new Map([[claveDeCentro('Morelia Vecinal'), derivado('morelia-abastos', 1, 8)]]);
    const r = resuelveCentro('Morelia Vecinal', { derivados });
    expect([r.area.valor, r.area.procedencia]).toEqual(['ruta_vecinal', 'derivado']);
    expect(r.completo).toBe(true);
  });

  it('⛔ y sin esa decisión, el mismo centro NO estaría resuelto', () => {
    // Control: la prueba de arriba podría pasar sola por el sufijo «Vecinal». No pasa: sin la
    // confirmación, el área nace sólo PROPUESTA y el centro no resuelve.
    const derivados = new Map([[claveDeCentro('Morelia Vecinal'), derivado('morelia-abastos', 1, 8)]]);
    const r = resuelveCentro('Morelia Vecinal', { derivados, areasConfirmadas: new Map() });
    expect([r.area.valor, r.area.procedencia, r.completo]).toEqual(['ruta_vecinal', 'propuesto', false]);
  });
});

describe('resolver un centro, declarando de dónde viene cada mitad', () => {
  it('⭐⭐ un área leída del nombre nace PROPUESTA, no establecida', () => {
    const r = resuelveCentro('Morelia Abastos TLMK', { derivados: DERIVADOS, areasConfirmadas: new Map() });
    expect([r.sitio.valor, r.sitio.procedencia]).toEqual(['morelia-abastos', 'derivado']);
    expect([r.area.valor, r.area.procedencia]).toEqual(['telemarketing', 'propuesto']);
    expect(r.area.nota).toMatch(/RH/);
    // ⛔ Lo que importa: con el área sólo propuesta, el centro NO está resuelto.
    expect(r.completo).toBe(false);
  });

  it('⭐ y cuando RH la confirma, entonces sí', () => {
    const confirmadas = new Map([[claveDeCentro('Morelia Abastos TLMK'), 'telemarketing']]);
    const r = resuelveCentro('Morelia Abastos TLMK', { derivados: DERIVADOS, areasConfirmadas: confirmadas });
    expect([r.area.procedencia, r.completo]).toEqual(['derivado', true]);
  });

  it('⭐ RH manda sobre el nombre cuando se contradicen', () => {
    // Medido: «Morelia Vecinal» tiene 3 personas que la Suite marca ruta_directa.
    const confirmadas = new Map([[claveDeCentro('Morelia Abastos TLMK'), 'ruta_directa']]);
    const r = resuelveCentro('Morelia Abastos TLMK', { derivados: DERIVADOS, areasConfirmadas: confirmadas });
    expect(r.area.valor).toBe('ruta_directa');
  });

  it('⛔ un consenso flojo NO resuelve el sitio: queda pendiente y dice por qué', () => {
    const r = resuelveCentro('PHidalgo Staff', { derivados: DERIVADOS, areasConfirmadas: new Map() });
    expect(r.sitio.valor).toBeNull();
    expect(r.sitio.procedencia).toBe('pendiente');
    expect(r.sitio.nota).toMatch(/consenso 67 %/);
    expect(CONSENSO_MINIMO).toBe(0.7);
  });

  it('⛔ 100 % sobre UNA persona no es un consenso', () => {
    const r = resuelveCentro('Promotoras', { derivados: DERIVADOS, areasConfirmadas: new Map() });
    expect([r.sitio.valor, r.sitio.procedencia]).toEqual([null, 'pendiente']);
    expect(r.sitio.nota).toMatch(/1 persona/);
    expect(BASE_MINIMA).toBe(2);
  });

  it('un centro que nadie checa queda pendiente, no en blanco', () => {
    const r = resuelveCentro('Direccion', { derivados: DERIVADOS, areasConfirmadas: new Map() });
    expect([r.sitio.procedencia, r.area.procedencia]).toEqual(['pendiente', 'pendiente']);
    expect(r.sitio.nota).toBeTruthy();
    expect(r.area.nota).toBeTruthy();
  });

  it('rechaza un centro vacío', () => {
    expect(() => resuelveCentro('   ', { derivados: DERIVADOS, areasConfirmadas: new Map() })).toThrow(CentroInvalido);
  });
});

describe('el gate: ninguna persona sin sitio y sin área', () => {
  const UNIVERSO = [
    { centro: 'Morelia Abastos', personas: 22 },
    { centro: 'Morelia Abastos TLMK', personas: 10 },
    { centro: 'PHidalgo Staff', personas: 7 },
    { centro: 'Direccion', personas: 3 },
  ];

  it('⭐⭐ hoy NO pasa, y la función lo dice en vez de redondear', () => {
    const c = cubreElUniverso(UNIVERSO, { derivados: DERIVADOS, areasConfirmadas: new Map() });
    expect(c.personas).toBe(42);
    expect(c.conSitio).toBe(32); // Morelia Abastos + su TLMK
    expect(c.conArea).toBe(0); // ninguna confirmada todavía
    expect(c.completas).toBe(0);
    expect(c.completas).toBeLessThan(c.personas);
  });

  it('⭐ y entrega la lista de trabajo con el motivo de cada pendiente', () => {
    const c = cubreElUniverso(UNIVERSO, { derivados: DERIVADOS, areasConfirmadas: new Map() });
    expect(c.pendientes).toHaveLength(4);
    const ph = c.pendientes.find((p) => p.centro === 'PHidalgo Staff');
    expect(ph?.personas).toBe(7);
    expect(ph?.motivo).toMatch(/sitio:.*consenso/);
    expect(ph?.motivo).toMatch(/área:/);
  });

  it('cuando RH confirma todo lo confirmable, el gate avanza — y lo que falta sigue contado', () => {
    const confirmadas = new Map([
      [claveDeCentro('Morelia Abastos'), 'tienda'],
      [claveDeCentro('Morelia Abastos TLMK'), 'telemarketing'],
      [claveDeCentro('PHidalgo Staff'), 'administracion'],
      [claveDeCentro('Direccion'), 'direccion_zona'],
    ]);
    const c = cubreElUniverso(UNIVERSO, { derivados: DERIVADOS, areasConfirmadas: confirmadas });
    expect(c.conArea).toBe(42);
    expect(c.completas).toBe(32); // siguen faltando los sitios de PHidalgo Staff y Direccion
    expect(c.pendientes.map((p) => p.centro).sort()).toEqual(['Direccion', 'PHidalgo Staff']);
  });
});
