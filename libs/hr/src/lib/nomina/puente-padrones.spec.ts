import {
  ESTADOS_VIVOS, esLaMismaPersona, normalizaNombre, notaDelAlias, tiendePuente,
  type PersonaDeLaSuite, type PersonaDeNomina,
} from './puente-padrones';

// ⛔ Todos los nombres de este archivo son INVENTADOS: el repo es público y los padrones reales
//    son de personas. Los casos vienen de defectos medidos en prod, no los datos.

/** Atajos para escribir escenarios cortos. */
const suite = (id: string, nombre: string, status = 'active'): PersonaDeLaSuite => ({ id, nombre, status });
const nom = (codigo: string, nombreCompleto: string, llavesDuras?: PersonaDeNomina['llavesDuras']): PersonaDeNomina =>
  ({ codigo, nombreCompleto, llavesDuras });

describe('normalización del nombre', () => {
  it('quita acentos, puntuación y espacios de más', () => {
    expect(normalizaNombre('  Fulano  Pérez-Soto. ')).toBe('FULANO PEREZ SOTO');
    // ⭐ La Ñ se pliega a N a propósito: los dos padrones escriben «Muñoz» y «Munoz» para la
    //    misma persona. Si esto cambiara, se perderían empates reales.
    expect(normalizaNombre('MUÑOZ  ñandú')).toBe('MUNOZ NANDU');
    expect(normalizaNombre('Muñoz')).toBe(normalizaNombre('Munoz'));
    // Un salto de línea dentro del dato, que es como viene en el padrón real.
    expect(normalizaNombre('Mengana\r\nLuisa Gómez')).toBe('MENGANA LUISA GOMEZ');
    expect(normalizaNombre(null)).toBe('');
  });
});

describe('el puente', () => {
  it('liga por nombre exacto y por los mismos nombres en otro orden', () => {
    const p = tiendePuente(
      [nom('A1', 'Fulano Pérez Soto'), nom('A2', 'Pérez Soto Zutana')],
      [suite('u1', 'Fulano Perez Soto'), suite('u2', 'Zutana Pérez Soto')],
    );
    expect(p.resumen.nivel1).toBe(1);
    expect(p.resumen.nivel2).toBe(1);
    expect(p.empates.map((e) => [e.codigo, e.userId])).toEqual([['A1', 'u1'], ['A2', 'u2']]);
    expect(p.resumen.cierra).toBe(true);
  });

  it('⛔ CONTROL NEGATIVO: nombres deformados no ligan con nadie', () => {
    const gente = [suite('u1', 'Fulano Pérez Soto'), suite('u2', 'Mengana Gómez Ruiz')];
    // Las mismas letras, al revés: si esto empatara, el empate no estaría midiendo nada.
    const p = tiendePuente([nom('X1', 'otoS zereP onaluF'), nom('X2', 'ziuR zemoG anagneM')], gente);
    expect(p.empates).toEqual([]);
    expect(p.rechazos.every((r) => r.motivo === 'sin-candidato')).toBe(true);
    expect(p.resumen.cierra).toBe(true);
  });

  it('⛔⛔ `invited` es gente VIVA: filtrar por «activo» perdería a quien cobra sin haber entrado nunca', () => {
    expect(ESTADOS_VIVOS.has('invited')).toBe(true);
    expect(ESTADOS_VIVOS.has('terminated')).toBe(false);
    const p = tiendePuente([nom('A1', 'Mengana Gómez Ruiz')], [suite('u1', 'Mengana Gómez Ruiz', 'invited')]);
    expect(p.resumen.ligados).toBe(1);
    // Y el control del otro lado: una baja NO liga, pero tampoco se confunde con «no existe».
    const q = tiendePuente([nom('A1', 'Mengana Gómez Ruiz')], [suite('u1', 'Mengana Gómez Ruiz', 'terminated')]);
    expect(q.empates).toEqual([]);
    expect(q.rechazos[0]).toMatchObject({ motivo: 'solo-baja' });
  });

  it('⛔ un 1:N no es un empate, salvo que UNO solo esté vigente', () => {
    // Dos vivos del mismo estado: nadie destaca → ambiguo.
    const a = tiendePuente(
      [nom('A1', 'Mengana Gómez Ruiz')],
      [suite('u1', 'Mengana Gómez Ruiz', 'invited'), suite('u2', 'Mengana Gómez Ruiz', 'invited')],
    );
    expect(a.empates).toEqual([]);
    expect(a.rechazos[0]).toMatchObject({ motivo: 'ambiguo' });
    // Un registro viejo sin dar de baja + uno vigente: gana el vigente.
    const b = tiendePuente(
      [nom('A1', 'Mengana Gómez Ruiz')],
      [suite('u1', 'Mengana Gómez Ruiz', 'invited'), suite('u2', 'Mengana Gómez Ruiz', 'active')],
    );
    expect(b.empates[0]).toMatchObject({ userId: 'u2', nivel: 1 });
    expect(b.empates[0]?.como).toContain('uno solo vigente');
  });

  it('`[NE.2.5]` el rechazo publica A QUIÉNES miró, para que la cola manual no invente otro emparejador', () => {
    // Ambiguo: los dos candidatos vivos que empataron, en el rechazo.
    const amb = tiendePuente(
      [nom('A1', 'Mengana Gómez Ruiz')],
      [suite('u1', 'Mengana Gómez Ruiz', 'invited'), suite('u2', 'Mengana Gómez Ruiz', 'invited')],
    );
    expect(amb.rechazos[0]?.candidatos.slice().sort()).toEqual(['u1', 'u2']);

    // Juicio: el que coincide en apellidos y primer nombre.
    const jui = tiendePuente(
      [{ ...nom('A1', 'Mengana Patricia Gómez Ruiz'), aPaterno: 'Gómez', aMaterno: 'Ruiz' }],
      [suite('u1', 'Mengana Leticia Gómez Ruiz')],
    );
    expect(jui.rechazos[0]?.candidatos).toEqual(['u1']);

    // Sólo baja: el dado de baja con quien coincide; es a quien habría que reactivar o ligar.
    const baja = tiendePuente([nom('A1', 'Perengano Soto Díaz')], [suite('u9', 'Perengano Soto Díaz', 'terminated')]);
    expect(baja.rechazos[0]).toMatchObject({ motivo: 'solo-baja', candidatos: ['u9'] });

    // ⛔ PRUEBA NEGATIVA: si no hay a quién mirar, la lista va VACÍA — no se rellena con el parecido
    //    más cercano. Un candidato inventado es peor que ninguno: invita a ligar al que no es.
    const nadie = tiendePuente([nom('A1', 'Zutano Quiroz Vela')], [suite('u1', 'Mengana Gómez Ruiz')]);
    expect(nadie.rechazos[0]).toMatchObject({ motivo: 'sin-candidato', candidatos: [] });
  });

  it('⛔ coincidir sólo en apellidos y primer nombre es un JUICIO, no se liga', () => {
    const p = tiendePuente(
      [{ ...nom('A1', 'Mengana Patricia Gómez Ruiz'), aPaterno: 'Gómez', aMaterno: 'Ruiz' }],
      [suite('u1', 'Mengana Leticia Gómez Ruiz')],
    );
    expect(p.empates).toEqual([]);
    expect(p.rechazos[0]).toMatchObject({ motivo: 'juicio' });
    expect(p.resumen.cierra).toBe(true);
  });

  it('⭐ dos códigos para UNA persona se registran los dos; dos PERSONAS bajo un usuario, ninguna', () => {
    // Defecto medido en el padrón real: la misma persona dada de alta dos veces, con la llave dura
    // partida por un salto de línea en una de las filas. La llave dice que es la misma.
    const mismaPersona = tiendePuente(
      [nom('0011', 'Fulano Rubio León', ['LLAVE123\r\n4', 'OTRA999']), nom('1481', 'Fulano Rubio Leon', ['LLAVE1234'])],
      [suite('u1', 'Fulano Rubio León')],
    );
    expect(mismaPersona.resumen.ligados).toBe(2);
    expect(mismaPersona.empates.every((e) => e.duplicado)).toBe(true);
    expect(mismaPersona.resumen.duplicadosEnElOrigen).toBe(1);

    // Dos tocayos sin ninguna llave en común: no se liga ninguno.
    const tocayos = tiendePuente(
      [nom('A1', 'Mengana Gómez Ruiz', ['LLAVE-A']), nom('A2', 'Mengana Gómez Ruiz', ['LLAVE-B'])],
      [suite('u1', 'Mengana Gómez Ruiz')],
    );
    expect(tocayos.empates).toEqual([]);
    expect(tocayos.rechazos.map((r) => r.motivo)).toEqual(['choque', 'choque']);
    expect(tocayos.resumen.cierra).toBe(true);
  });

  it('⛔ sin llave dura NO se presume que sean la misma persona', () => {
    expect(esLaMismaPersona(nom('A', 'x'), nom('B', 'x'))).toBe(false);
    // Los rellenos del padrón no identifican a nadie: si empataran, todos serían la misma persona.
    expect(esLaMismaPersona(nom('A', 'x', ['-', '', null]), nom('B', 'x', ['-', 0]))).toBe(false);
    expect(esLaMismaPersona(nom('A', 'x', ['LLAVE1']), nom('B', 'x', ['LLAVE1']))).toBe(true);
  });

  it('todo el universo queda clasificado: nada se pierde en el camino', () => {
    const p = tiendePuente(
      [nom('A1', 'Mengana Gómez Ruiz'), nom('A2', 'Nadie De Por Aquí'), nom('A3', 'Perengano Mora Paz')],
      [suite('u1', 'Mengana Gómez Ruiz'), suite('u3', 'Perengano Mora Paz', 'terminated')],
    );
    expect(p.resumen).toMatchObject({ universo: 3, ligados: 1, rechazados: 2, cierra: true });
    expect(p.rechazos.map((r) => r.motivo).sort()).toEqual(['sin-candidato', 'solo-baja']);
    // NEGATIVA del propio control: si el puente perdiera una fila, `cierra` tendría que ser false.
    expect(p.empates.length + p.rechazos.length).toBe(p.resumen.universo);
  });

  it('un padrón vacío no explota y cierra igual', () => {
    expect(tiendePuente([], [suite('u1', 'Fulano')]).resumen).toMatchObject({ universo: 0, ligados: 0, cierra: true });
  });
});

describe('la nota del alias', () => {
  it('dice cómo se ligó, con qué código, y que es provisional — sin nombres de personas', () => {
    const n = notaDelAlias(
      { codigo: '0011', userId: 'u1', nivel: 1, como: 'nombre exacto', duplicado: false },
      { item: 'NE.0.17', fecha: '2026-11-24', sistema: 'nómina' },
    );
    expect(n).toContain('nivel 1');
    expect(n).toContain('código 0011');
    expect(n).toContain('PROVISIONAL');
    expect(n).not.toContain('MÁS DE UN código');
    const d = notaDelAlias(
      { codigo: '1481', userId: 'u1', nivel: 2, como: 'mismos nombres en otro orden', duplicado: true },
      { item: 'NE.0.17', fecha: '2026-11-24', sistema: 'ContPAQi' },
    );
    expect(d).toContain('MÁS DE UN código');
  });
});
