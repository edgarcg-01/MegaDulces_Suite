import { afterEach, describe, expect, it } from 'vitest';
import { almacenPreferido, elegirAlmacen, guardarAlmacenPreferido } from './almacen-preferido';

/** `[UB.RF.7]` Mapa, Asignación y Contenido comparten el almacén elegido, sólo dentro del alcance. */
describe('[UB.RF.7] almacén preferido de Ubicaciones', () => {
  const LISTA = [{ id: 'w-00' }, { id: 'w-01' }, { id: 'w-08' }];
  afterEach(() => localStorage.clear());

  it('lo que eligió en una pantalla lo abre la otra', () => {
    guardarAlmacenPreferido('w-08');
    expect(almacenPreferido()).toBe('w-08');
    expect(elegirAlmacen(LISTA, 'w-00')).toBe('w-08');
  });

  it('NEGATIVA: una preferencia fuera del alcance NO se abre; gana el que propone el servidor', () => {
    guardarAlmacenPreferido('w-ajeno');
    expect(elegirAlmacen(LISTA, 'w-01')).toBe('w-01');
  });

  it('sin preferencia ni propuesta válida, no inventa uno', () => {
    expect(elegirAlmacen(LISTA, null)).toBeNull();
    expect(elegirAlmacen(LISTA, 'w-otro')).toBeNull();
  });

  it('guardar vacío no borra lo anterior', () => {
    guardarAlmacenPreferido('w-01');
    guardarAlmacenPreferido('');
    expect(almacenPreferido()).toBe('w-01');
  });
});
