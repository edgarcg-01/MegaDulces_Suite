/**
 * `[ID.28]` — Re-export. La definición vive en `@megadulces/contracts`.
 *
 * El árbol de autorización sólo existía en `apps/view`, o sea que el backend
 * —que es quien enforza— no podía verlo, y el gate «cada clave aparece
 * exactamente una vez en el árbol» no tenía cómo correr del lado del servidor.
 * Ahora vive en el contrato compartido y esto queda como puente para no tocar
 * a sus consumidores.
 */
export type {
  AuthzAppId,
  AuthzModule,
  AuthzProject,
  AuthzApp,
} from '@megadulces/contracts/authz/authz-tree';
export {
  LEGACY_PERMISSIONS,
  AUTHZ_TREE,
  allTreePermissions,
} from '@megadulces/contracts/authz/authz-tree';

/**
 * `[AU.14]` La lógica de SELECCIÓN sobre el árbol (tri-estado, cascada, diferencia contra el
 * perfil, de claves a pantallas). Vive en el contrato y se consume por este mismo puente, para
 * que el editor de perfiles y el de personas usen una sola implementación (ADR-056).
 */
export type {
  TriEstado,
  MapaDeValores,
  OverrideDePermiso,
  CambioDePantalla,
  PantallasAfectadas,
} from '@megadulces/contracts/authz/authz-tree';
export {
  clavesDeModulo,
  clavesDeProyecto,
  clavesDeApp,
  cuantasEncendidas,
  triEstado,
  alternarGrupo,
  overridesContra,
  valoresDesdeBase,
  pantallasAfectadas,
  ubicacionDeClave,
} from '@megadulces/contracts/authz/authz-tree';
