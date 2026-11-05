/**
 * `[KR.11]` **Cada sucursal tiene su propio servidor Kepler, y un documento se escribe en el suyo.**
 *
 * `[PGP.71]` Se mudó aquí desde `libs/commercial/.../kepler-servidores.ts` porque ya lo necesitan
 * dos dominios: la requisición (commercial) y el pago a proveedor (finance), y finanzas no puede
 * importar de commercial (ADR-028). Es la regla de seguridad de la escritura al ERP: escribirla dos
 * veces es dejar que un día diverjan (ADR-056). `kepler-servidores.ts` la re-exporta tal cual.
 *
 * Medido en `kepler_ods` el 2026-10-23: los documentos de cada sucursal viven en SU base
 * (`kdm1.sucursal = kdm1.c1` en los nueve servidores, `md_00`…`md_08`). Lo mismo con los pagos
 * `X-D-26` (2026-11-04): cada servidor tiene su serie `XD2601-` y ningún `kdxf` cruza de servidor.
 *
 * ── La regla ────────────────────────────────────────────────────────────────────────────────
 *
 * - Conexión: `KEPLER_PUSH_URL_<NN>` por servidor. `KEPLER_PUSH_URL` (sin sufijo) se acepta
 *   **sólo para `00`**, por compatibilidad con el runbook original. ⛔ **Nunca como comodín**: un
 *   servidor sin su variable queda APAGADO, no redirigido a oficinas.
 * - Sucursal: dos dígitos. `01-005` (camioneta) y vacío se rechazan.
 *
 * Sin base de datos a propósito; se prueba en `kepler-servidores.spec.ts` (commercial).
 */

export type Env = Readonly<Record<string, string | undefined>>;

export interface ConexionKepler {
  sucursal: string;
  url: string;
}

export type Resolucion<T> = { ok: true; valor: T } | { ok: false; motivo: string };

const SUCURSAL_RX = /^\d{2}$/;

export const valorDeEnv = (env: Env, k: string): string => (env[k] ?? '').trim();

export function normalizarSucursal(sucursal: string | null | undefined): Resolucion<string> {
  const s = String(sucursal ?? '').trim();
  if (!SUCURSAL_RX.test(s)) {
    return { ok: false, motivo: `Sucursal Kepler inválida «${s}»: se esperan dos dígitos (00…08)` };
  }
  return { ok: true, valor: s };
}

/** Conexión del servidor de esa sucursal, o el motivo por el que su escritura está apagada. */
export function urlDeServidor(sucursal: string, env: Env): Resolucion<string> {
  const n = normalizarSucursal(sucursal);
  if (!n.ok) return n;
  const s = n.valor;
  const propia = valorDeEnv(env, `KEPLER_PUSH_URL_${s}`);
  if (propia) return { ok: true, valor: propia };
  if (s === '00') {
    const legada = valorDeEnv(env, 'KEPLER_PUSH_URL');
    if (legada) return { ok: true, valor: legada };
  }
  return { ok: false, motivo: `La escritura a Kepler de la sucursal ${s} está apagada (falta KEPLER_PUSH_URL_${s})` };
}

/** Todas las sucursales con conexión configurada, en orden. */
export function servidoresEncendidos(env: Env): ConexionKepler[] {
  const out: ConexionKepler[] = [];
  for (let i = 0; i <= 99; i++) {
    const s = String(i).padStart(2, '0');
    const u = urlDeServidor(s, env);
    if (u.ok) out.push({ sucursal: s, url: u.valor });
  }
  return out;
}
