import { Permission } from '../constants/permissions';

/**
 * `[SEG.3]` — **¿La base offline de esta persona se borra al cerrar sesión?**
 *
 * Decisión del usuario (2026-09-28): *«hay que borrarlo para todo usuario que no sea vendedor o
 * colaborador»*. El motivo es el mismo de `[SEG.2]`: en un equipo compartido, la base offline
 * guarda visitas, **fotos de tienda**, pings de GPS y conteos de quien la usó, y la siguiente
 * persona los hereda. Para quien trabaja en oficina no hay nada que conservar y sí hay datos de
 * otro esperando.
 *
 * ── Quién es «de campo» se resuelve por CAPACIDAD, no por nombre de rol ──────────────────────
 * Un `role_name === 'vendedor'` escrito acá se desincroniza al primer rol nuevo (`vendedor_vecinal`,
 * `vendedor_telemarketing`… ya existen). Lo que de verdad define a quien puede dejar trabajo sin
 * sincronizar es el permiso con el que lo produce: **`VISITAS_REGISTRAR`** es el que abre la
 * captura de campo, que es lo que llena `visitas`, `photos` y `tiendasPendientes`.
 *
 * ── ⚠️ El freno que la regla no contemplaba, y por qué está ─────────────────────────────────
 * Medido en el esquema de `OfflineDatabaseService`: la base **no es sólo de campo**. La tabla
 * `inventoryScans` la llena quien CUENTA inventario (almacén), que no es vendedor ni colaborador
 * — y `routePings`, quien anda en ruta. O sea que aplicar la regla al pie de la letra podía
 * destruir un conteo de almacén a medio sincronizar.
 *
 * Por eso: se borra a quien no es de campo **salvo que quede trabajo sin sincronizar**. No es
 * ablandar la regla: es la misma intención —no destruir trabajo de nadie— aplicada al caso que
 * la regla no había visto. Y cuando pasa, **se declara con el conteo**, que es lo que permite
 * decidir si ese rol tiene que entrar a la excepción o si su pantalla está mal.
 */

/** Lo que hace falta saber de la sesión que se va. */
export interface SesionQueSeVa {
  permissions?: Record<string, boolean> | null;
}

/** ¿Esta persona produce trabajo de campo offline? */
export function esDeCampo(sesion: SesionQueSeVa | null | undefined): boolean {
  return sesion?.permissions?.[Permission.VISITAS_REGISTRAR] === true;
}

export interface VeredictoDeBorrado {
  borrar: boolean;
  /** Por qué. Va al log del cierre de sesión: un borrado silencioso no se puede auditar. */
  motivo: string;
}

/**
 * @param pendientes filas sin sincronizar en la base offline. `null` = **no se pudo contar**, y
 *   eso NO es cero: ante la duda no se borra. Contar mal hacia abajo destruye trabajo; contar mal
 *   hacia arriba sólo deja una base que se borrará el próximo cierre de sesión.
 */
export function decidirBorradoOffline(
  sesion: SesionQueSeVa | null | undefined,
  pendientes: number | null,
): VeredictoDeBorrado {
  if (esDeCampo(sesion)) {
    return { borrar: false, motivo: 'es de campo (VISITAS_REGISTRAR): su base es su trabajo' };
  }
  if (pendientes === null) {
    return { borrar: false, motivo: 'no se pudo contar lo pendiente: ante la duda no se destruye' };
  }
  if (pendientes > 0) {
    return {
      borrar: false,
      motivo: `no es de campo pero deja ${pendientes} registro(s) sin sincronizar — se conserva y se declara`,
    };
  }
  return { borrar: true, motivo: 'no es de campo y no hay nada sin sincronizar' };
}
