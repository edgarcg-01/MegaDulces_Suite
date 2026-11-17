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

/**
 * `[PGP.122]` `kdm1.c67` («quién capturó») de todo documento que la Suite escribe en Kepler. Hasta hoy
 * vivía copiado en cuatro escritores (requisición, cliente, pago, comisiones); lo nuevo lo toma de aquí y
 * los cuatro quedan como deuda con nombre de adoptarlo (ADR-056) —son el mismo literal—.
 */
export const CAPTURISTA_SUITE = 'SUITE';

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

/**
 * `[ALC.2.7]` El **concentrador** de Kepler (`pv_suc_ip.c6 = 'SC'`, «Sistema Concentrador»): un
 * décimo servidor que NO está en el ODS y desde el que se dan de alta los catálogos. La forma de
 * clientes, guardada ahí, repite cada escritura en las 9 sucursales con la librería del cliente
 * `pv_sc_lib` (medido en `md_cat_cli.kpl`, 2026-11-07): la base no replica nada.
 *
 * Conexión: `KEPLER_PUSH_URL_SC`. ⛔ Sin comodín: no se toma la de oficinas (`00`) en su lugar.
 */
export function urlDelConcentrador(env: Env): Resolucion<string> {
  const u = valorDeEnv(env, 'KEPLER_PUSH_URL_SC');
  return u ? { ok: true, valor: u } : { ok: false, motivo: 'La escritura al concentrador de Kepler está apagada (falta KEPLER_PUSH_URL_SC)' };
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

/**
 * `[PGP.122.4]` El folio por el contador de Kepler (`md.sqliov`). Se re-exporta desde aquí porque los
 * ensayos empaquetados y las pruebas de `database/tests` apuntan `@megadulces/platform-core` a ESTE
 * archivo: así lo encuentran sin cambiar sus alias.
 */
export * from './kepler-folio';
/** `[PGP.122]` Cómo escribe Kepler un texto (se mudó de ALC, ver el archivo). */
export * from './kepler-texto';
