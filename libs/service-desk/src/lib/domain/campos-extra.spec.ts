// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el archivo NO CARGUE.
import { validarCamposExtra, validarDefinicionCampo, type CampoDef } from './campos-extra';

/**
 * `[MS.7.4]` + `[MS.7.8]` El validador de los campos propios de una cola. Lo que se defiende:
 *  · ⛔ una clave que la cola no declara se RECHAZA (no se ignora);
 *  · «requerido» exige una respuesta de verdad: `false` es respuesta, un texto en blanco no;
 *  · el tipo se respeta (booleano de verdad, opción de la lista, texto);
 *  · lo opcional sin contestar NO se guarda (ni `null` ni «» inventados);
 *  · la foto es un ADJUNTO: requerida ⇒ ≥1 archivo, y no viaja en `extra`.
 */
const SI_NO: CampoDef = { code: 'afecta_clientes', label: '¿Afecta a clientes?', type: 'boolean', required: true, options: [] };
const OPCION: CampoDef = { code: 'tipo_falla', label: 'Tipo de falla', type: 'select', required: false, options: ['Eléctrica', 'Hidráulica', 'Otra'] };
const TEXTO: CampoDef = { code: 'equipo', label: 'Equipo', type: 'text', required: false, options: [] };
const FOTO_OBL: CampoDef = { code: 'foto_falla', label: 'Foto de la falla', type: 'photo', required: true, options: [] };
const FOTO_OPC: CampoDef = { code: 'foto_extra', label: 'Foto extra', type: 'photo', required: false, options: [] };

describe('`[MS.7.8]` validarCamposExtra', () => {
  it('⭐ sin campos declarados y sin nada que validar es válido y no guarda nada (TI no cambia)', () => {
    expect(validarCamposExtra([], undefined, 0)).toEqual({ valores: {}, errores: [] });
    expect(validarCamposExtra([], {}, 0)).toEqual({ valores: {}, errores: [] });
    expect(validarCamposExtra([], null, 3)).toEqual({ valores: {}, errores: [] });
  });

  it('⭐ lo contestado bien se guarda normalizado', () => {
    const r = validarCamposExtra([SI_NO, OPCION, TEXTO], { afecta_clientes: true, tipo_falla: 'Eléctrica', equipo: '  Compresor 2  ' }, 0);
    expect(r.errores).toEqual([]);
    expect(r.valores).toEqual({ afecta_clientes: true, tipo_falla: 'Eléctrica', equipo: 'Compresor 2' });
  });

  it('⛔ NEGATIVA — una clave que la cola NO declara se rechaza (no se ignora en silencio)', () => {
    const r = validarCamposExtra([SI_NO], { afecta_clientes: true, inventado: 'x' }, 0);
    expect(r.errores).toEqual(['El campo «inventado» no existe en esta área']);
    expect(validarCamposExtra([], { cualquiera: 1 }, 0).errores).toHaveLength(1);
  });

  it('⛔ NEGATIVA — un requerido sin contestar falla (ausente, null y texto en blanco)', () => {
    for (const extra of [{}, { afecta_clientes: null }, undefined]) {
      expect(validarCamposExtra([SI_NO], extra, 0).errores).toEqual(['Contesta «¿Afecta a clientes?»: es obligatorio']);
    }
    const t: CampoDef = { ...TEXTO, required: true };
    expect(validarCamposExtra([t], { equipo: '   ' }, 0).errores).toHaveLength(1);
  });

  it('⭐ CONTROL — un sí/no `false` ES una respuesta: cumple el requerido (no se confunde con «sin contestar»)', () => {
    const r = validarCamposExtra([SI_NO], { afecta_clientes: false }, 0);
    expect(r.errores).toEqual([]);
    expect(r.valores).toEqual({ afecta_clientes: false });
  });

  it('⛔ NEGATIVA — el tipo se respeta', () => {
    expect(validarCamposExtra([SI_NO], { afecta_clientes: 'no' }, 0).errores).toEqual(['«¿Afecta a clientes?» debe ser sí o no']);
    expect(validarCamposExtra([SI_NO], { afecta_clientes: 1 }, 0).errores).toHaveLength(1);
    expect(validarCamposExtra([OPCION], { tipo_falla: 'Mecánica' }, 0).errores).toEqual(['«Tipo de falla»: elige una de las opciones de la lista']);
    expect(validarCamposExtra([OPCION], { tipo_falla: 7 }, 0).errores).toHaveLength(1);
    expect(validarCamposExtra([TEXTO], { equipo: true }, 0).errores).toEqual(['«Equipo» debe ser texto']);
  });

  it('⛔ NEGATIVA — el texto no pasa del tope; justo en el tope sí (control)', () => {
    expect(validarCamposExtra([TEXTO], { equipo: 'a'.repeat(501) }, 0).errores).toHaveLength(1);
    expect(validarCamposExtra([TEXTO], { equipo: 'a'.repeat(500) }, 0).errores).toEqual([]);
  });

  it('lo opcional sin contestar NO se guarda (ni null ni texto vacío inventados)', () => {
    const r = validarCamposExtra([OPCION, TEXTO], { tipo_falla: null, equipo: '  ' }, 0);
    expect(r).toEqual({ valores: {}, errores: [] });
  });

  it('⭐ la FOTO requerida exige al menos un adjunto; opcional no exige nada', () => {
    expect(validarCamposExtra([FOTO_OBL], {}, 0).errores).toEqual(['Adjunta una foto: «Foto de la falla» es obligatoria']);
    expect(validarCamposExtra([FOTO_OBL], {}, 1).errores).toEqual([]);
    expect(validarCamposExtra([FOTO_OPC], {}, 0).errores).toEqual([]);
  });

  it('⛔ NEGATIVA — la foto no viaja en `extra`: mandarla como texto se rechaza y no se guarda', () => {
    const r = validarCamposExtra([FOTO_OPC], { foto_extra: 'data:image/png;base64,xxx' }, 1);
    expect(r.errores).toHaveLength(1);
    expect(r.valores).toEqual({});
  });

  it('⛔ NEGATIVA — `extra` que no es un objeto se rechaza (arreglo, texto, número)', () => {
    for (const malo of [[], 'x', 5, true]) expect(validarCamposExtra([SI_NO], malo, 0).errores).toEqual(['Los campos adicionales deben venir como un objeto']);
  });

  it('junta TODOS los problemas, no sólo el primero (para corregir de una vez)', () => {
    const r = validarCamposExtra([SI_NO, FOTO_OBL, OPCION], { tipo_falla: 'X', otro: 1 }, 0);
    expect(r.errores).toHaveLength(4);
  });
});

describe('`[MS.7.4]` validarDefinicionCampo', () => {
  const ok = { code: 'tipo_falla', label: 'Tipo de falla', type: 'select', options: ['A', 'B'] };

  it('⭐ una definición bien formada pasa (de cada tipo)', () => {
    expect(validarDefinicionCampo(ok)).toEqual([]);
    expect(validarDefinicionCampo({ code: 'afecta', label: '¿Afecta?', type: 'boolean' })).toEqual([]);
    expect(validarDefinicionCampo({ code: 'nota', label: 'Nota', type: 'text', options: [] })).toEqual([]);
    expect(validarDefinicionCampo({ code: 'foto', label: 'Foto', type: 'photo' })).toEqual([]);
  });

  it('⛔ NEGATIVA — código, pregunta y tipo mal formados', () => {
    expect(validarDefinicionCampo({ ...ok, code: 'Mal Código' })).toHaveLength(1);
    expect(validarDefinicionCampo({ ...ok, code: '1x' })).toHaveLength(1);
    expect(validarDefinicionCampo({ ...ok, label: '  ' })).toHaveLength(1);
    expect(validarDefinicionCampo({ ...ok, label: 'x'.repeat(81) })).toHaveLength(1);
    expect(validarDefinicionCampo({ ...ok, type: 'fecha' })).toHaveLength(1);
  });

  it('⛔ NEGATIVA — las opciones: un select necesita 2–20, sin repetidas ni vacías; los demás tipos no llevan', () => {
    expect(validarDefinicionCampo({ ...ok, options: ['sola'] })).toHaveLength(1);
    expect(validarDefinicionCampo({ ...ok, options: Array.from({ length: 21 }, (_, i) => `o${i}`) })).toHaveLength(1);
    expect(validarDefinicionCampo({ ...ok, options: ['A', 'A'] })).toHaveLength(1);
    expect(validarDefinicionCampo({ ...ok, options: ['A', ' '] }).length).toBeGreaterThan(0);
    expect(validarDefinicionCampo({ ...ok, options: undefined })).toHaveLength(1);
    expect(validarDefinicionCampo({ code: 'afecta', label: '¿Afecta?', type: 'boolean', options: ['sí'] })).toHaveLength(1);
  });
});
