import type { KeplerDoctipo } from '@megadulces/contracts';

import { DOCTIPOS } from './kepler-doctipo';

/**
 * `[KR.11]` **Cada sucursal tiene su propio servidor Kepler, y un documento se escribe en el suyo.**
 *
 * Medido en `kepler_ods` el 2026-10-23: los `X-A-30` y `U-D-40` de cada sucursal viven en SU base
 * (`kdm1.sucursal = kdm1.c1` en los nueve servidores, `md_00`…`md_08`). `md_00` sólo guarda los de
 * oficinas. La primera versión del adapter tenía UNA conexión (`KEPLER_PUSH_URL` → `md_00`) y
 * escribía `c1 = sucursal` ahí: una requisición de `02` habría quedado en el servidor de oficinas,
 * donde nadie de La Piedad la ve. No pasaba sólo porque la plantilla `02/1/0000424` no existe en
 * `md_00` y el adapter rechazaba — un freno accidental, no un diseño.
 *
 * ── La regla ────────────────────────────────────────────────────────────────────────────────
 *
 * - Conexión: `KEPLER_PUSH_URL_<NN>` por servidor. `KEPLER_PUSH_URL` (sin sufijo) se acepta
 *   **sólo para `00`**, por compatibilidad con el runbook original. ⛔ **Nunca como comodín**: un
 *   servidor sin su variable queda APAGADO, no redirigido a oficinas.
 * - Plantilla: `KEPLER_REQ_TEMPLATE_FOLIO_<NN>` / `KEPLER_PED_TEMPLATE_FOLIO_<NN>` (y `_SERIE_`).
 *   La plantilla es un documento de ESE servidor; el folio de `00` no existe en `02`. Sólo `00`
 *   hereda las variables sin sufijo y el default `0000424` de la compra.
 * - Sucursal: dos dígitos. `01-005` (camioneta) y vacío se rechazan.
 *
 * Sin base de datos a propósito: el adapter necesita Postgres y un doble de Knex no ejecuta SQL.
 * La regla se prueba sola en `kepler-servidores.spec.ts`.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export interface ServidorKepler {
  sucursal: string;
  url: string;
}

export type Resolucion<T> = { ok: true; valor: T } | { ok: false; motivo: string };

const SUCURSAL_RX = /^\d{2}$/;

const val = (env: Env, k: string): string => (env[k] ?? '').trim();

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
  const propia = val(env, `KEPLER_PUSH_URL_${s}`);
  if (propia) return { ok: true, valor: propia };
  if (s === '00') {
    const legada = val(env, 'KEPLER_PUSH_URL');
    if (legada) return { ok: true, valor: legada };
  }
  return { ok: false, motivo: `La escritura a Kepler de la sucursal ${s} está apagada (falta KEPLER_PUSH_URL_${s})` };
}

/** Todas las sucursales con conexión configurada, en orden. */
export function servidoresEncendidos(env: Env): ServidorKepler[] {
  const out: ServidorKepler[] = [];
  for (let i = 0; i <= 99; i++) {
    const s = String(i).padStart(2, '0');
    const u = urlDeServidor(s, env);
    if (u.ok) out.push({ sucursal: s, url: u.valor });
  }
  return out;
}

/** Coordenada del documento plantilla de ese tipo EN ese servidor. */
export function plantillaDe(tipo: KeplerDoctipo, sucursal: string, env: Env): Resolucion<{ serie: string; folio: string }> {
  const n = normalizarSucursal(sucursal);
  if (!n.ok) return n;
  const s = n.valor;
  const d = DOCTIPOS[tipo];
  const esOficinas = s === '00';
  const folio = val(env, `${d.envFolio}_${s}`)
    || (esOficinas ? val(env, d.envFolio) || (tipo === 'compra' ? '0000424' : '') : '');
  const serie = val(env, `${d.envSerie}_${s}`) || (esOficinas ? val(env, d.envSerie) : '') || '1';
  if (!folio) {
    return { ok: false, motivo: `Falta ${d.envFolio}_${s}: no hay documento plantilla elegido en el servidor ${s}` };
  }
  return { ok: true, valor: { serie, folio } };
}

/**
 * `[KR.12]` **Tope diario de documentos por servidor** — el freno del canario.
 *
 * `KEPLER_PUSH_MAX_DIA_NN` = cuántos documentos puede escribir la Suite en ese servidor con la
 * misma fecha. ⛔ **Default 1**: encender un servidor sin decidir su tope deja pasar UNO, y el
 * segundo rebota con su motivo en `kepler_error`. Subirlo es un paso explícito del protocolo
 * (runbook §9), no un olvido. Lo que motivó un default tan bajo: el 2026-10-13 una sola
 * requisición salió cuatro veces antes de que nadie lo notara.
 *
 * Un valor que no es entero positivo cae al default — nunca a «sin tope».
 */
export const TOPE_DIARIO_DEFAULT = 1;

export function topeDiario(sucursal: string, env: Env): number {
  const n = normalizarSucursal(sucursal);
  if (!n.ok) return TOPE_DIARIO_DEFAULT;
  const raw = val(env, `KEPLER_PUSH_MAX_DIA_${n.valor}`);
  if (!/^\d+$/.test(raw)) return TOPE_DIARIO_DEFAULT;
  const v = Number(raw);
  return v >= 1 ? v : TOPE_DIARIO_DEFAULT;
}

/** Prefijo con el que la Suite marca sus documentos en Kepler (`c11` en compra, `c24` en traspaso). */
export const MARCA_SUITE = 'RQ-';
