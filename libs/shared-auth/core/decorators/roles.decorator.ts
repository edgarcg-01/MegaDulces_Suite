import { SetMetadata } from '@nestjs/common';

export enum UserRole {
  SUPERADMIN = 'superadmin',
  SUPERVISOR_V = 'supervisor_v',
  COLABORADOR = 'colaborador',
  // Roles de Logística
  ADMIN_LOG = 'admin_log',
  OPERADOR_LOG = 'operador_log',
  RH_LOG = 'rh_log',
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: (string | UserRole)[]) => SetMetadata(ROLES_KEY, roles);
