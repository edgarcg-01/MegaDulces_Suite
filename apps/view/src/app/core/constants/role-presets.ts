/**
 * `[ID.28]` — Re-export. La definición vive en `@megadulces/contracts`.
 *
 * Las plantillas de área sólo existían en `apps/view`, y son justamente donde
 * se ve el obstáculo estructural de la segregación de funciones: los grupos de
 * `MODULE_GROUPS` son **atómicos** —no se puede dar una punta sin la otra— y
 * 13 de 13 plantillas de área otorgan las dos puntas de al menos un par
 * capturar/validar. Con el catálogo del lado compartido, eso se puede medir
 * desde un smoke en vez de leyéndolo a mano.
 */
export type { AreaPreset, AreaMeta } from '@megadulces/contracts/authz/role-presets';
export {
  MODULE_GROUPS,
  AREA_PRESETS,
  resolveAreaPreset,
  resolveAreaPresetMap,
  AREAS,
  LEGACY_ROLE_AREA,
  roleAreaSlug,
  areaMeta,
} from '@megadulces/contracts/authz/role-presets';
