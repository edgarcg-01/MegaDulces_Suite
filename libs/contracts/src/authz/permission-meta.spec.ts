import { Permission } from './permissions';
import { PERMISSION_META, PERMISSION_CATEGORY_ORDER } from './permission-meta';

/**
 * `[AU.6]` — El catálogo de etiquetas tiene que cubrir el enum ENTERO.
 *
 * El archivo lo pedía desde que nació, en un comentario: *"Debe cubrir TODAS las claves del enum
 * `Permission`; si se agrega un permiso al enum, agregar su entrada aquí o saldrá con la key
 * cruda"*. No había ninguna prueba que lo hiciera cumplir — y un comentario no se pone rojo.
 *
 * Lo que se paga sin este candado no es un error: es una pantalla que **funciona** mostrando
 * `COMMERCIAL_QUOTES_VER` donde debería decir "Ver cotizaciones". Nadie reporta un bug; el
 * administrador simplemente no entiende qué está concediendo. Lo consumen hoy el editor de roles
 * (`admin-roles-permissions`) y el acceso por persona (`persona-acceso`), los dos con fallback a
 * la clave cruda — que es la red de seguridad, no el comportamiento deseado.
 */
describe('PERMISSION_META cubre el enum Permission', () => {
  const claves = Object.values(Permission) as string[];

  it('toda clave del enum tiene etiqueta, descripción y categoría', () => {
    const sinEntrada = claves.filter((k) => !PERMISSION_META[k]);
    expect(sinEntrada).toEqual([]);

    const incompletas = claves.filter((k) => {
      const m = PERMISSION_META[k];
      return !m?.label?.trim() || !m?.description?.trim() || !m?.category?.trim();
    });
    expect(incompletas).toEqual([]);
  });

  it('ninguna etiqueta es la clave repetida (una etiqueta igual a la key no explica nada)', () => {
    const perezosas = claves.filter((k) => PERMISSION_META[k]?.label === k);
    expect(perezosas).toEqual([]);
  });

  /**
   * Prueba negativa: sin esto el bloque de arriba se pondría verde con un catálogo vacío si
   * alguna vez `Object.values(Permission)` devolviera `[]`. Un gate que no se puede romper a
   * propósito es una intención, no un gate (ADR-056).
   */
  it('el candado DETECTA un hueco (rompelo a propósito)', () => {
    const conHueco: Record<string, unknown> = { ...PERMISSION_META };
    delete conHueco[Permission.USUARIOS_VER];
    const sinEntrada = claves.filter((k) => !conHueco[k]);
    expect(sinEntrada).toEqual([Permission.USUARIOS_VER as string]);
  });

  it('toda categoría usada está declarada en PERMISSION_CATEGORY_ORDER', () => {
    const usadas = [...new Set(claves.map((k) => PERMISSION_META[k]?.category).filter(Boolean))];
    const huerfanas = usadas.filter((c) => !PERMISSION_CATEGORY_ORDER.includes(c as string));
    // El orden es lo que agrupa el selector de `persona-acceso`; una categoría fuera de la lista
    // cae al final en un montón sin nombre propio.
    expect(huerfanas).toEqual([]);
  });
});
