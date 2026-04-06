import { SetMetadata } from '@nestjs/common';

export enum UserRole {
  SUPERADMIN = 'superadmin',
  SUPERVISOR_V = 'supervisor_v',
  COLABORADOR = 'colaborador',
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: (string | UserRole)[]) => SetMetadata(ROLES_KEY, roles);
