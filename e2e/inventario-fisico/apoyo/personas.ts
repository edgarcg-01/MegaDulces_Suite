/**
 * Las seis personas del plan de pruebas, con **exactamente** su permiso y ninguno más.
 *
 * ⛔ Probar con un admin no sirve: los roles de plataforma pasan por god-mode y un permiso que
 * nadie repartió sale verde igual. Por eso acá no existe un «admin».
 *
 * Los mapas salen de lo medido en prod el 2026-11-25
 * (`docs/MODULOS/pruebas-inventario-fisico/`), no de lo que el enum permite.
 */

/** Las seis llaves del módulo, con el nombre EXACTO del enum (ADR-054: el permiso es una CLAVE). */
export const LLAVE = {
  VER: 'COMMERCIAL_INVENTORY_VER',
  SUPERVISAR: 'COMMERCIAL_INVENTORY_SUPERVISAR',
  ASIGNAR: 'COMMERCIAL_INVENTORY_ASIGNAR',
  CONTAR: 'COMMERCIAL_INVENTORY_CONTAR',
  RECONCILIAR: 'COMMERCIAL_INVENTORY_RECONCILIAR',
  CANCELAR: 'COMMERCIAL_INVENTORY_CANCELAR_CONTEO',
} as const;

export interface Persona {
  /** Cómo se llama en el plan de pruebas. */
  nombre: string;
  username: string;
  role_name: string;
  /** Sucursal Kepler, cuando la persona pertenece a una. */
  warehouse_code?: string;
  permissions: Record<string, boolean>;
  /** Una línea: por qué esta persona existe como caso de prueba. */
  porque: string;
}

const p = (...llaves: string[]): Record<string, boolean> =>
  Object.fromEntries(llaves.map((k) => [k, true]));

export const SUPERVISOR: Persona = {
  nombre: 'Supervisor de oficina',
  username: 'prueba.supervisor',
  role_name: 'supervisor',
  permissions: p(LLAVE.VER, LLAVE.SUPERVISAR),
  porque: '21 personas, todas de oficina: ningun almacenista ni encargado tiene esta llave.',
};

/**
 * ⭐ El caso raro que de verdad existe: **puede abrir y congelar un almacen, y NO puede
 * cerrarlo**. Cinco personas en prod.
 */
export const MARKETING: Persona = {
  nombre: 'Marketing (abre y congela, no cierra)',
  username: 'prueba.marketing',
  role_name: 'marketing',
  permissions: p(LLAVE.VER, LLAVE.SUPERVISAR, LLAVE.ASIGNAR, LLAVE.CONTAR, LLAVE.CANCELAR),
  porque: 'Mide el corte real: SUPERVISAR sin RECONCILIAR.',
};

export const ENCARGADO: Persona = {
  nombre: 'Encargado de tienda',
  username: 'prueba.encargado',
  role_name: 'encargado_tienda',
  warehouse_code: '01',
  permissions: p(LLAVE.VER, LLAVE.ASIGNAR),
  porque: '19 personas. Arma el equipo y NO puede ver el teorico ni cancelar.',
};

export const CONTADOR: Persona = {
  nombre: 'Almacenista contador',
  username: 'prueba.almacenista',
  role_name: 'almacenista',
  warehouse_code: '01',
  permissions: p(LLAVE.VER, LLAVE.CONTAR, LLAVE.CANCELAR),
  porque: '11 personas (4 nunca entraron). Cuenta a ciegas, y SI puede cancelar.',
};

export const RECONCILIADOR: Persona = {
  nombre: 'Reconciliador',
  username: 'prueba.reconciliador',
  role_name: 'gerente_compras',
  permissions: p(LLAVE.VER, LLAVE.SUPERVISAR, LLAVE.RECONCILIAR, LLAVE.CANCELAR),
  porque: '17 personas. El unico cuyo clic mueve existencia.',
};

export const OBSERVADOR: Persona = {
  nombre: 'Prevencion (solo mira)',
  username: 'prueba.prevencion',
  role_name: 'prevencion',
  permissions: p(LLAVE.VER),
  porque: '5 personas cuyo oficio ES el descuadre, con el acceso mas pobre del modulo.',
};

export const AJENO: Persona = {
  nombre: 'Ajeno (ninguna llave del modulo)',
  username: 'prueba.ajeno',
  role_name: 'vendedor_ruta',
  permissions: {},
  porque: 'El unico bloque que prueba que los candados existen.',
};

export const TODAS: Persona[] = [
  SUPERVISOR, MARKETING, ENCARGADO, CONTADOR, RECONCILIADOR, OBSERVADOR, AJENO,
];
