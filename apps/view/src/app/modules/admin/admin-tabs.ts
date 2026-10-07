import { Permission } from '../../core/constants/permissions';
import type { PageTab } from '../../shared/components/page-tabs/page-tabs.component';

/**
 * `[AU.2]` — Las tres caras de «Configuración de la suite».
 *
 * Son pestañas y no tres ítems de menú porque responden la misma pregunta desde
 * ángulos distintos: **quién trabaja acá** (personas), **qué puestos existen y
 * quién manda a quién** (puestos) y **de qué responde cada puesto**
 * (responsabilidades). Mirar una sin poder saltar a la otra es lo que hoy obliga
 * a administrar la organización por migración.
 *
 * ⛔ Las tres se gatean con `USUARIOS_VER`, el mismo par que el padrón: quien
 * administra a la persona administra la estructura en la que encaja. No se
 * inventa un permiso nuevo — `[LC.6.2]` dejó la lección de que un módulo no está
 * entregado hasta que su permiso está REPARTIDO en prod, y un par sin repartir
 * no abre nada.
 */
export const ADMIN_TABS: PageTab[] = [
  { label: 'Personas', route: '/admin/users', icon: 'pi pi-users', permission: Permission.USUARIOS_VER },
  { label: 'Puestos', route: '/admin/puestos', icon: 'pi pi-sitemap', permission: Permission.USUARIOS_VER },
  {
    label: 'Responsabilidades',
    route: '/admin/responsabilidades',
    icon: 'pi pi-flag',
    permission: Permission.USUARIOS_VER,
  },
  { label: 'Roles y permisos', route: '/admin/roles', icon: 'pi pi-shield', permission: Permission.ROLES_VER },
];
