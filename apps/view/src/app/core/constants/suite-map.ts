/**
 * `[SN.1]` — Re-export. La definición vive en `@megadulces/contracts` (mismo puente que
 * `authz-tree.ts`): el mapa de espacios de la suite es una capa de presentación sobre el árbol
 * de autorización, y por eso vive junto a él, no en la app.
 */
export type {
  SuiteEntry,
  SuiteGate,
  SuiteSpace,
  SuiteSpaceStatus,
  SuiteSourceStatus,
  VisibleEntry,
  VisibleSpace,
  VisibleSuiteMap,
} from '@megadulces/contracts/authz/suite-map';
export {
  LANDING_ROUTE,
  SUITE_SPACES,
  SUITE_UNCLASSIFIED,
  accessibleModules,
  entryIcon,
  entryLabel,
  entryModules,
  entryPermissions,
  entryRoute,
  findModule,
  findProject,
  isEntryVisible,
  primaryDestinations,
  resolveProjectForUrl,
  resolveSpaceForUrl,
  validateSuiteMap,
  viewApp,
  viewProjects,
  visibleSuiteMap,
} from '@megadulces/contracts/authz/suite-map';
