import * as jwt from 'jsonwebtoken';

/**
 * Lee la sesión de una petición SIN rechazarla si no hay token.
 *
 * Se usa donde el mismo endpoint sirve a dos públicos: la tienda (anónima) y
 * el tablero interno. Con sesión válida se devuelven costos y márgenes; sin
 * ella, esos campos ni siquiera salen del servidor.
 *
 * Para los endpoints que son sólo internos NO se usa esto: ahí va
 * @UseGuards(AuthGuard('jwt')), que sí rechaza.
 *
 * Usa el mismo secreto que auth.module.ts/jwt.strategy.ts
 * (CATALOGO_KP_JWT_SECRET, no JWT_SECRET — ver jwt.strategy.ts).
 */
export interface Sesion {
  sub:    number;
  email:  string;
  rol:    string;
  nombre: string;
}

export function sesionDe(req: any): Sesion | null {
  const cabecera = req?.headers?.authorization || '';
  if (!cabecera.startsWith('Bearer ')) return null;

  const token = cabecera.slice(7).trim();
  if (!token) return null;

  const secreto = process.env.CATALOGO_KP_JWT_SECRET;
  // Sin secreto configurado no se acepta ninguna sesión: es preferible que el
  // tablero pida contraseña de más a que valide tokens contra un valor vacío.
  if (!secreto) return null;

  try {
    const carga = jwt.verify(token, secreto);
    // jwt.verify puede devolver una cadena; sólo sirve el objeto con los
    // campos que firma auth.service.
    if (typeof carga !== 'object' || carga === null) return null;
    const s = carga as Record<string, unknown>;
    if (typeof s.sub !== 'number' || typeof s.email !== 'string') return null;
    return {
      sub:    s.sub,
      email:  s.email,
      rol:    typeof s.rol === 'string' ? s.rol : 'viewer',
      nombre: typeof s.nombre === 'string' ? s.nombre : '',
    };
  } catch {
    return null;   // expirado, alterado o firmado con otro secreto
  }
}

/** true si la petición viene de alguien que inició sesión. */
export const esInterno = (req: any): boolean => sesionDe(req) !== null;
