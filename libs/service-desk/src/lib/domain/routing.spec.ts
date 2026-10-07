import { claveEncontrada, contieneClave, elegirRegla, normalizarClaves, normalizarTexto, type ReglaRuteo } from './routing';

/**
 * `[MS.3.10]` La asignación automática. Lo que se defiende, con el texto que de verdad escribe la gente:
 *  · sin acentos ni mayúsculas, y el plural entra sin pedirle a nadie que liste las dos formas;
 *  · por PALABRA: una clave no se encuentra en medio de otra («red» no está en «ocurrido»);
 *  · gana la primera regla por orden, y el orden es la desambiguación;
 *  · una regla apagada no asigna; una categoría exacta asigna aunque el texto no diga nada.
 */
const FELIPE = 'u-felipe';
const DAVID = 'u-david';
const CAT_EQUIPO = 'c-equipo';
const CAT_DESARROLLO = 'c-desarrollo';
const CAT_OTRO = 'c-otro';

const regla = (p: Partial<ReglaRuteo> & Pick<ReglaRuteo, 'id' | 'assignee_id'>): ReglaRuteo => ({
  name: p.id,
  keywords: [],
  category_id: null,
  sort_order: 100,
  active: true,
  ...p,
});

const REGLAS: ReglaRuteo[] = [
  regla({ id: 'equipo', assignee_id: FELIPE, sort_order: 10, category_id: CAT_EQUIPO, keywords: ['sistemas', 'cpu', 'impresora'] }),
  regla({ id: 'desarrollo', assignee_id: DAVID, sort_order: 20, category_id: CAT_DESARROLLO, keywords: ['desarrollo', 'nueva funcionalidad'] }),
];

const aQuien = (title: string, description = '', categoryId = CAT_OTRO, reglas = REGLAS): string | null =>
  elegirRegla(reglas, { title, description, categoryId })?.regla.assignee_id ?? null;

describe('MS.3.10 · normalizarTexto', () => {
  it('quita acentos y mayúsculas y colapsa todo lo que no es letra o dígito', () => {
    expect(normalizarTexto('  ¡Impresora   CAÍDA!!  ')).toBe('impresora caida');
    expect(normalizarTexto('Cámara / CCTV')).toBe('camara cctv');
  });
  it('pliega la ñ a n (quien escribe «diseno» sin ñ encuentra «diseño») y conserva los dígitos', () => {
    expect(normalizarTexto('Diseño 2026')).toBe('diseno 2026');
    expect(contieneClave(normalizarTexto('el DISENO nuevo'), normalizarTexto('diseño'))).toBe(true);
  });
  it('no se rompe con vacío ni nulo', () => {
    expect(normalizarTexto('')).toBe('');
    expect(normalizarTexto(undefined as unknown as string)).toBe('');
  });
});

describe('MS.3.10 · normalizarClaves', () => {
  it('normaliza, quita vacías y repetidas (aunque difieran en acentos o mayúsculas)', () => {
    expect(normalizarClaves(['Impresora', ' impresora ', 'IMPRESORA', '', '  ', 'Programación'])).toEqual(['impresora', 'programacion']);
  });
});

describe('MS.3.10 · contieneClave — por palabra, no por subcadena', () => {
  it('una palabra del texto que EMPIEZA con la clave: el plural entra', () => {
    expect(contieneClave('las impresoras no imprimen', 'impresora')).toBe(true);
    expect(contieneClave('falla la cpu', 'cpu')).toBe(true);
    expect(contieneClave('tres cpus nuevas', 'cpu')).toBe(true);
  });
  it('⛔ NEGATIVA — la clave en MEDIO de otra palabra no cuenta: «red» no está en «ocurrido»', () => {
    expect(contieneClave('lo ocurrido ayer', 'red')).toBe(false);
    expect(contieneClave('el mouse no sirve', 'ouse')).toBe(false);
  });
  it('una clave de varias palabras debe aparecer como frase', () => {
    expect(contieneClave('quiero una nueva funcionalidad en el portal', 'nueva funcionalidad')).toBe(true);
    expect(contieneClave('funcionalidad nueva', 'nueva funcionalidad')).toBe(false);
  });
  it('la clave vacía nunca coincide (no puede volverse «todo»)', () => {
    expect(contieneClave('cualquier cosa', '')).toBe(false);
    expect(claveEncontrada('cualquier cosa', [''])).toBeNull();
  });
});

describe('MS.3.10 · elegirRegla', () => {
  it('⭐ «sistemas», «cpu» o «impresora» en el título → Felipe', () => {
    expect(aQuien('Falla la impresora de caja')).toBe(FELIPE);
    expect(aQuien('Se quemó la CPU')).toBe(FELIPE);
    expect(aQuien('Problema con sistemas')).toBe(FELIPE);
  });
  it('también en la descripción, con acentos y mayúsculas distintos', () => {
    expect(aQuien('Ayuda', 'La IMPRESORA está atorada')).toBe(FELIPE);
    expect(aQuien('Pantalla', 'Necesito DESARROLLO de un reporte')).toBe(DAVID);
  });
  it('⭐ todo lo de desarrollo → David', () => {
    expect(aQuien('Quiero una mejora de desarrollo')).toBe(DAVID);
    expect(aQuien('Pido una nueva funcionalidad')).toBe(DAVID);
  });
  it('la categoría exacta asigna aunque el texto no diga nada', () => {
    expect(aQuien('Hola', '', CAT_DESARROLLO)).toBe(DAVID);
    expect(aQuien('Hola', '', CAT_EQUIPO)).toBe(FELIPE);
  });
  it('⛔ NEGATIVA — sin categoría ni palabra que aplique, no se asigna a nadie (queda para quien reparte)', () => {
    expect(aQuien('No puedo entrar a mi correo')).toBeNull();
    expect(aQuien('Lo ocurrido en la bodega', 'se vio rojo')).toBeNull();
  });
  it('⭐ si menciona las dos cosas gana la regla que va primero (el orden es la desambiguación)', () => {
    expect(aQuien('Impresora y desarrollo del reporte')).toBe(FELIPE);
    const alReves = [{ ...REGLAS[0], sort_order: 30 }, REGLAS[1]];
    expect(aQuien('Impresora y desarrollo del reporte', '', CAT_OTRO, alReves)).toBe(DAVID);
  });
  it('una regla apagada no asigna, y la siguiente sí puede', () => {
    const apagada = [{ ...REGLAS[0], active: false }, REGLAS[1]];
    expect(aQuien('Falla la impresora', '', CAT_OTRO, apagada)).toBeNull();
    expect(aQuien('Falla la impresora y el desarrollo', '', CAT_OTRO, apagada)).toBe(DAVID);
  });
  it('dice POR QUÉ: la palabra exacta, o la categoría', () => {
    expect(elegirRegla(REGLAS, { title: 'Falla la impresora', description: '', categoryId: CAT_OTRO })?.motivo).toEqual({ tipo: 'palabra', palabra: 'impresora' });
    expect(elegirRegla(REGLAS, { title: 'x', description: '', categoryId: CAT_DESARROLLO })?.motivo).toEqual({ tipo: 'categoria' });
  });
  it('sin reglas no hay asignación', () => {
    expect(aQuien('Falla la impresora', '', CAT_OTRO, [])).toBeNull();
  });
  it('a igual orden desempata por nombre, siempre igual (no por el orden en que llegaron de la base)', () => {
    const a = regla({ id: 'a', name: 'Alfa', assignee_id: 'u-a', keywords: ['pantalla'] });
    const b = regla({ id: 'b', name: 'Beta', assignee_id: 'u-b', keywords: ['pantalla'] });
    expect(aQuien('pantalla rota', '', CAT_OTRO, [b, a])).toBe('u-a');
  });
});
