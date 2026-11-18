/**
 * El origen público (`https://dominio`) desde el que se sirve la app, leído de la petición. Lo usan los enlaces que se
 * mandan a personas sin cuenta (captura de gasto GX.9, ficha de depósito del cliente CC.20, el QR del estado de cuenta).
 *
 * Detrás del proxy el backend se ve a sí mismo en `127.0.0.1`, así que las cabeceras `x-forwarded-*` son las que traen
 * el dominio real. Se toma el PRIMER valor porque una cadena de proxies las acumula separadas por coma.
 *
 * Subió a `platform-core` en `[CC.20]` (ADR-056) al aparecer su tercer uso; antes vivía copiado en cada controlador.
 */
export interface RequestConCabeceras {
  headers?: Record<string, string | string[] | undefined>;
  protocol?: string;
}

export function requestOrigin(req?: RequestConCabeceras): string | undefined {
  const first = (v: string | string[] | undefined): string | undefined => {
    const s = Array.isArray(v) ? v[0] : v;
    return s ? String(s).split(',')[0].trim() || undefined : undefined;
  };
  const host = first(req?.headers?.['x-forwarded-host']) ?? first(req?.headers?.['host']);
  if (!host) return undefined;
  const proto = first(req?.headers?.['x-forwarded-proto']) ?? req?.protocol ?? 'http';
  return `${proto}://${host}`;
}

/** El dominio de la Suite en internet. `PUBLIC_LINK_URL` lo cambia sin tocar código. */
export const DOMINIO_PUBLICO_SUITE = 'https://megadulcessuite.com';

/** ¿La URL apunta a la red de la oficina (o a la propia máquina)? Desde el celular de un cliente no abre. */
export function esOrigenPrivado(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return true; }
  if (host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '[::1]') return true;
  const m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/**
 * `[CC.20.1]` La base de un enlace que se manda a alguien de FUERA (un cliente): la primera candidata que se abre
 * desde internet — `PUBLIC_LINK_URL`, `APP_PUBLIC_URL`, el origen de la petición — y si ninguna, el dominio público.
 *
 * ⛔ El caso (2026-11-18): en prod `APP_PUBLIC_URL` vale la IP de la oficina (`make-prod-env.js` la puso para el
 * correo de Salud BD, que se lee adentro) y PISA el origen de la petición. El primer estado de cuenta con enlace de
 * depósito salió con `http://192.168.0.222:8080/deposito/…`: el cliente no lo abre desde su celular. Quien emite
 * desde la oficina entra por esa misma IP, así que el origen de la petición tampoco sirve: el respaldo es el dominio.
 */
export function origenPublicoParaEnlace(origin?: string): string {
  const candidatas = [process.env['PUBLIC_LINK_URL'], process.env['APP_PUBLIC_URL'], origin]
    .map((u) => (u || '').trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return candidatas.find((u) => !esOrigenPrivado(u)) ?? DOMINIO_PUBLICO_SUITE;
}
