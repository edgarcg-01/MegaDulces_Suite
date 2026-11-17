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
