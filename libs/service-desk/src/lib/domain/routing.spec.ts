import { claveEncontrada, contieneClave, elegirRegla, especificidad, normalizarClaves, normalizarTexto, type ReglaRuteo } from './routing';

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

/**
 * `[MS.7.10]` La ubicación como condición de una regla. Lo que se defiende:
 *  · ⛔ la ubicación es un FILTRO: una regla de «Oficinas» no aplica a un ticket del CEDIS ni a uno sin ubicación;
 *  · una regla con ubicación y sin categoría ni palabras se dispara por la ubicación sola;
 *  · gana la MÁS ESPECÍFICA (categoría + ubicación le gana a categoría) aunque vaya después en la lista;
 *  · ⭐ las reglas de antes (sin ubicación) conservan EXACTAMENTE su orden: nada de lo que ya funcionaba cambia de dueño.
 */
const PEDRO = 'u-pedro';
const UBALDO = 'u-ubaldo';
const CAT_PLOMERIA = 'c-plomeria';
const OF = 'OF';
const EC = 'EC';

const aQuienEn = (reglas: ReglaRuteo[], ubicacion: string | null, categoryId = CAT_PLOMERIA, title = 'Fuga'): string | null =>
  elegirRegla(reglas, { title, description: '', categoryId, warehouseCode: ubicacion })?.regla.assignee_id ?? null;

describe('MS.7.10 · la ubicación como filtro', () => {
  const soloOficinas = regla({ id: 'oficinas', assignee_id: PEDRO, warehouse_code: OF });

  it('⭐ una regla sólo por UBICACIÓN se dispara con esa ubicación, aunque el texto no diga nada', () => {
    const r = elegirRegla([soloOficinas], { title: 'algo', description: '', categoryId: CAT_OTRO, warehouseCode: OF });
    expect(r?.regla.assignee_id).toBe(PEDRO);
    expect(r?.motivo).toEqual({ tipo: 'ubicacion' });
  });

  it('⛔ NEGATIVA — con otra ubicación, o sin ubicación, esa regla NO aplica', () => {
    expect(aQuienEn([soloOficinas], EC)).toBeNull();
    expect(aQuienEn([soloOficinas], null)).toBeNull();
    expect(aQuienEn([soloOficinas], undefined as unknown as null)).toBeNull();
  });

  it('⛔ NEGATIVA — categoría + ubicación: la categoría correcta en OTRA ubicación no dispara', () => {
    const r = regla({ id: 'plom-of', assignee_id: PEDRO, category_id: CAT_PLOMERIA, warehouse_code: OF });
    expect(aQuienEn([r], OF)).toBe(PEDRO);
    expect(aQuienEn([r], EC)).toBeNull();
    expect(aQuienEn([r], OF, CAT_OTRO)).toBeNull(); // la ubicación correcta con OTRA categoría tampoco
  });

  it('palabras + ubicación: la palabra dispara sólo en esa ubicación', () => {
    const r = regla({ id: 'luz-of', assignee_id: PEDRO, keywords: ['luz'], warehouse_code: OF });
    expect(aQuienEn([r], OF, CAT_OTRO, 'No hay luz')).toBe(PEDRO);
    expect(aQuienEn([r], EC, CAT_OTRO, 'No hay luz')).toBeNull();
  });
});

describe('MS.7.10 · la más específica gana', () => {
  it('⭐ categoría + ubicación le gana a categoría sola, AUNQUE vaya después en la lista', () => {
    const general = regla({ id: 'plom', assignee_id: UBALDO, sort_order: 10, category_id: CAT_PLOMERIA });
    const enOficinas = regla({ id: 'plom-of', assignee_id: PEDRO, sort_order: 99, category_id: CAT_PLOMERIA, warehouse_code: OF });
    expect(aQuienEn([general, enOficinas], OF)).toBe(PEDRO);
    expect(aQuienEn([general, enOficinas], EC)).toBe(UBALDO); // fuera de Oficinas la específica no aplica: gana la general
  });

  it('a igual especificidad gana la primera por orden (y luego por nombre)', () => {
    const a = regla({ id: 'a', assignee_id: UBALDO, sort_order: 20, warehouse_code: OF });
    const b = regla({ id: 'b', assignee_id: PEDRO, sort_order: 10, warehouse_code: OF });
    expect(aQuienEn([a, b], OF)).toBe(PEDRO);
  });

  it('⭐ las reglas de ANTES (sin ubicación) conservan exactamente su orden: nada cambia de dueño', () => {
    // El caso de siempre: una regla con categoría Y palabras (especificidad 1) y otra sólo de palabras (1): manda el orden.
    expect(REGLAS.map(especificidad)).toEqual([1, 1]);
    expect(aQuien('Falla la impresora de caja')).toBe(FELIPE);
    expect(aQuien('Hay que programar el desarrollo de la impresora')).toBe(FELIPE); // «impresora» va primero: el orden desambigua
    expect(aQuien('Nueva funcionalidad', '', CAT_DESARROLLO)).toBe(DAVID);
  });

  it('especificidad: el disparador categoría/palabras cuenta UNA vez, la ubicación otra', () => {
    expect(especificidad(regla({ id: 'x', assignee_id: 'u', category_id: 'c', keywords: ['a'] }))).toBe(1);
    expect(especificidad(regla({ id: 'x', assignee_id: 'u', warehouse_code: OF }))).toBe(1);
    expect(especificidad(regla({ id: 'x', assignee_id: 'u', category_id: 'c', warehouse_code: OF }))).toBe(2);
  });

  it('una regla apagada no gana aunque sea la más específica', () => {
    const apagada = regla({ id: 'ap', assignee_id: PEDRO, category_id: CAT_PLOMERIA, warehouse_code: OF, active: false });
    const general = regla({ id: 'plom', assignee_id: UBALDO, category_id: CAT_PLOMERIA });
    expect(aQuienEn([apagada, general], OF)).toBe(UBALDO);
  });
});
