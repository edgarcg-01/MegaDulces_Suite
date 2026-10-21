import { createHash } from 'node:crypto';
import type { Asiento } from './poliza-egreso';
import { guidDe, tokenDe } from './token';

/**
 * `[CP.8.50]` — **Marcar entregado: la regla, sin base de datos.**
 *
 * `GET /archivo` genera y **no** registra (`[CP.8.38]`): descargar no es entregar. Esto es la otra
 * mitad: cuando contabilidad ya CARGÓ el archivo en ContPAQi, lo dice, y el cuadre empieza a
 * buscarlo del otro lado.
 *
 * ⛔⛔ **Se registra sólo lo que se cargó.** Quien marca sube el MISMO archivo que importó, y se
 * compara byte a byte con lo que la Suite genera hoy para ese mes. Si el mes cambió entre la
 * descarga y la marca (un movimiento recategorizado, un alias nuevo), las pólizas que la Suite
 * registraría no serían las que entraron a ContPAQi, y el cuadre las daría por «difieren» o «no
 * aparecieron» por un error nuestro. Por eso el archivo distinto se **rechaza**, no se aproxima.
 *
 * ⭐ Es posible porque el archivo es determinista: lotes ordenados, egresos por fecha e id, y
 * token y guid derivados del evento (`token.ts`), sin reloj ni azar.
 */

export interface LoteArchivo {
  /** `cuenta_banco|fecha` — el `evento_id` del lote, el mismo que usa el sink. */
  clave: string;
  asiento: Asiento;
  movimientos: number;
}

export interface FilaEntrega {
  tenant_id: string;
  evento_tipo: 'bank_lote';
  evento_id: string;
  periodo: string;
  asiento: string;
  total: number;
  estado: 'entregada';
  sink: 'txt';
  motivo: string;
}

/** La huella del archivo: SHA-256 de los BYTES (latin1), no del texto. */
export function huellaArchivo(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * ¿El archivo que subieron es el que la Suite genera hoy? Devuelve dónde difiere, para que quien
 * marca sepa qué hacer en vez de recibir un «no» seco.
 */
export function compararArchivo(
  recibido: Buffer, generado: Buffer,
): { igual: true } | { igual: false; motivo: string } {
  if (recibido.equals(generado)) return { igual: true };
  const a = recibido.toString('latin1').split('\r\n');
  const b = generado.toString('latin1').split('\r\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return {
    igual: false,
    motivo: `el archivo no es el que la Suite genera hoy para este mes `
      + `(${recibido.length} bytes contra ${generado.length}; primera diferencia en el renglón ${i + 1}). `
      + 'Si el mes cambió desde que lo descargaste, vuelve a generarlo y cárgalo de nuevo; '
      + 'si cargaste otro archivo, sube ése.',
  };
}

/**
 * Las filas de `contpaqi.poliza_exports`, una por póliza del archivo.
 *
 * ⛔ Nacen en `entregada`, nunca en `aplicada`: quien afirma que ContPAQi la tiene es el cuadre,
 * leyendo el carril de vuelta. Llevan el `token` y el `guid` que el sink escribió en el archivo,
 * que es por donde el cuadre las va a encontrar.
 */
export function filasDeEntrega(p: {
  tenantId: string; mes: string; lotes: LoteArchivo[]; por: string; huella: string;
}): FilaEntrega[] {
  if (!p.por) throw new Error('una entrega sin autor no es una afirmación');
  if (!/^\d{4}-\d{2}$/.test(p.mes)) throw new Error(`mes inválido: "${p.mes}"`);
  return p.lotes.map((l) => ({
    tenant_id: p.tenantId,
    evento_tipo: 'bank_lote',
    evento_id: l.clave,
    periodo: p.mes,
    asiento: JSON.stringify({
      ...l.asiento,
      token: tokenDe('bank_lote', l.clave),
      guid: guidDe('bank_lote', l.clave),
      // `[CP.8.50]` Quién lo afirmó y sobre qué archivo. Viaja en el JSON y no en una columna
      // para no pedir una migración por esto; deuda con nombre en el tracker.
      entrega: { por: p.por, archivo_sha256: p.huella, movimientos: l.movimientos },
    }),
    total: l.asiento.total,
    estado: 'entregada',
    sink: 'txt',
    motivo: `cargada en ContPAQi según ${p.por}`,
  }));
}
