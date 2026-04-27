export interface User {
  id: string;
  username: string;
  nombre_completo?: string;
  email?: string;
  role_name: string;
  permissions?: Record<string, boolean>;
  activo: boolean;
}
