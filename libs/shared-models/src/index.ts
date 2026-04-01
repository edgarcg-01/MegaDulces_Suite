export interface JwtPayload {
  sub: string;
  username: string;
  zona: string;
  rol: string;
  iat: number;
  exp: number;
}

export interface LoginResponse {
  access_token: string;
}

export interface User {
  id: string;
  username: string;
  nombre_completo?: string;
  email?: string;
  rol: string;
  activo: boolean;
}
