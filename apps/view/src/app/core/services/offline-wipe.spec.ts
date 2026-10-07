import { decidirBorradoOffline, esDeCampo } from './offline-wipe';
import { Permission } from '../constants/permissions';

/**
 * `[SEG.3]` — La base offline se borra al cerrar sesión, salvo a quien hace trabajo de campo.
 *
 * Las dos aserciones que sostienen la regla son opuestas y las dos tienen que estar:
 * que se BORRE a quien no es de campo (si no, el equipo compartido sigue con las fotos de
 * tienda de la persona anterior), y que NO se borre trabajo sin sincronizar (si no, el cierre
 * de sesión destruye lo que alguien levantó en la calle y no hay de dónde recuperarlo).
 */
const conPermiso = (...claves: string[]) => ({
  permissions: Object.fromEntries(claves.map((k) => [k, true])),
});

describe('[SEG.3] decidirBorradoOffline', () => {
  it('⭐ alguien de OFICINA sin nada pendiente: se borra', () => {
    const v = decidirBorradoOffline(conPermiso(Permission.FINANCE_EXPENSES_VER), 0);
    expect(v.borrar).toBe(true);
  });

  it('⭐ alguien de CAMPO: no se borra, su base es su trabajo', () => {
    const v = decidirBorradoOffline(conPermiso(Permission.VISITAS_REGISTRAR), 0);
    expect(v.borrar).toBe(false);
    expect(v.motivo).toMatch(/campo/i);
  });

  it('⭐ el freno: no es de campo PERO deja trabajo sin sincronizar → no se borra y se declara', () => {
    // Medido en el esquema: `inventoryScans` la llena quien CUENTA inventario, que no es
    // vendedor ni colaborador. Sin este caso, un conteo a medio subir se perdía al salir.
    const v = decidirBorradoOffline(conPermiso(Permission.COMMERCIAL_INVENTORY_CONTAR), 3);
    expect(v.borrar).toBe(false);
    expect(v.motivo).toMatch(/sin sincronizar/i);
  });

  it('⭐ no se pudo CONTAR lo pendiente: ante la duda no se destruye', () => {
    // `null` no es cero. Contar mal hacia abajo destruye trabajo; contar mal hacia arriba sólo
    // posterga el borrado al próximo cierre de sesión.
    const v = decidirBorradoOffline(conPermiso(Permission.FINANCE_EXPENSES_VER), null);
    expect(v.borrar).toBe(false);
    expect(v.motivo).toMatch(/no se pudo contar/i);
  });

  it('sin sesión (token corrupto) tampoco se destruye a ciegas', () => {
    expect(decidirBorradoOffline(null, null).borrar).toBe(false);
  });

  it('esDeCampo se resuelve por PERMISO, no por nombre de rol', () => {
    // Un `role_name === 'vendedor'` escrito a mano se desincroniza al primer rol nuevo, y ya
    // existen `vendedor_vecinal` y `vendedor_telemarketing`.
    expect(esDeCampo(conPermiso(Permission.VISITAS_REGISTRAR))).toBe(true);
    expect(esDeCampo({ permissions: { [Permission.VISITAS_REGISTRAR]: false } })).toBe(false);
    expect(esDeCampo({ permissions: {} })).toBe(false);
  });
});
