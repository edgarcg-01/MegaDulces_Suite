import { RESTO_TOLERADO_CLIENTE, SALDO_CERO, esRestoDeFactura } from '@megadulces/contracts';
import type { Resolucion } from '@megadulces/platform-core';

/**
 * `[GP.R.2]` — **El Ajuste Abono `U-A-30` que cierra los restos de centavos de un cliente, armado sin tocar Kepler.**
 *
 * Plan: [`FASE_GP_ANEXO_RESTOS_DE_COBRO.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_GP_ANEXO_RESTOS_DE_COBRO.md).
 * Es lo que hoy Crédito y cobranza cierra con un «Cobro» de centavos —un cobro que dice que entró dinero y no
 * entró—; la Suite lo hace con el documento correcto, el que Kepler ya trae. Capa **C1, función pura**: dice QUÉ
 * escribir o **POR QUÉ NO**. El adaptador (C2, GP.R.3) lee lo vivo y escribe.
 *
 * ── Lo que escribe un Ajuste Abono (medido en los 51 que ya existen; anexo §2, 51 de 51) ────────────────────────
 *
 * | Tabla | Qué | Nota |
 * |---|---|---|
 * | `md.kdm1` | el documento `U-A-30-01-<folio>`, **UNO por cliente**, que cierra varias facturas de una vez | `c31='Aju'`, `c63='UA3001-'` |
 * | `md.kdue` | **UN** renglón de abono (`c3='A'`, `c4=30`, `c29='A'`) | el `kdue` de la FACTURA no se toca |
 * | `md.kdm5` | una aplicación por factura, por su resto exacto | `c8='D'` + tipo/serie/folio de la factura |
 * | `md.kdm2` | **NADA** — el ajuste no tiene renglones de producto | 0 filas en los casos medidos |
 * | la póliza | **NADA** — sep-2026 tiene 0 renglones `U-A-30`, con control (`U-A-5`: 4,188 · `U-A-21`: 698) | por eso D-R2 |
 *
 * ⭐ **El saldo no se guarda: se deriva.** Kepler no lleva el saldo en la cartera (`kdue.c17` = importe en 632 de
 * 632 facturas medidas); el saldo es `importe − Σ kdm5`. Por eso basta con AGREGAR la aplicación: el ensayo de
 * GP.R.3 lo comprobó contra el Kepler vivo — la factura `8-1-0000470` pasó de $7.20 a **$0.00**.
 *
 * ── Dos restricciones que sólo aparecieron ESCRIBIENDO (ensayo del 2026-11-24, con ROLLBACK) ────────────────────
 *  - ⛔ **`kdm1.c11` es `varchar(20)`**: la referencia de idempotencia **tiene que caber en 20 caracteres**. Acá se
 *    valida; el ensayo murió con «el valor es demasiado largo» por no saberlo.
 *  - ⛔ **`clonarFila` inserta y después pisa**, así que clonar directo a `md.kdm1` choca con `pk_kdm1`. El plan de
 *    este armador se vuelca con el patrón `_h0 → _h → md` (como `kepler-nota-sink`). Es cosa del adaptador, no de
 *    acá, pero se deja dicho para que no se reaprenda.
 *
 * ⛔ **Sólo restos, nunca un documento entero.** Una factura que **nunca tuvo un cobro** no es un resto aunque deba
 * $0.08 (`esRestoDeFactura`, la misma regla del cierre de pagos y de la cartera): se rechaza. Y el techo es
 * {@link RESTO_TOLERADO_CLIENTE} — **D-R1, firmada por Edgar el 2026-11-24 en $10**; más que eso es deuda, no
 * redondeo, y no entra.
 *
 * ⬜ **NO MEDIDO (y por eso este armador no lo inventa):** qué mueve el PROGRAMA de Kepler además de esas tres
 * tablas. Las cinco tablas tienen **cero disparadores**, así que no se ve en un ensayo: se mira sobre un ajuste
 * real capturado por una persona, con foto antes/después. Mientras tanto el plan **declara** que no toca
 * acumulados (`acumulados: 'no_medido'`) en vez de dibujar un cero.
 */

/** El capturista con el que la Suite firma sus documentos en Kepler (el mismo del pago y la nota). */
export const CAPTURISTA_SUITE = 'SUITE';
/** Tipo y subtipo del Ajuste Abono en Kepler (`kdmm`: 30 = ajuste de abono). */
export const TIPO_AJUSTE = 30;
export const SERIE_AJUSTE = 1;
/** `md.kdm1.c11` es `varchar(20)`: la referencia de la Suite no puede pasarse (medido escribiendo, 2026-11-24). */
export const REFERENCIA_MAX = 20;

/** Una factura del cliente, como la lee la cartera. `importe` y `saldo` en pesos. */
export interface FacturaConResto {
  /** `kdm1.c4` de la factura (8 = telemarketing). */
  tipo: number;
  /** `kdm1.c5`. */
  serie: number;
  /** `kdm1.c6`, sin espacios. */
  folio: string;
  importe: number;
  /** Lo que todavía debe: `importe − Σ kdm5`. */
  saldo: number;
}

export interface PeticionAjuste {
  sucursal: string;
  /** `kdud.c2`. */
  cliente: string;
  facturas: FacturaConResto[];
  /** La llave de idempotencia de la Suite, que va a `kdm1.c11`. Máximo {@link REFERENCIA_MAX}. */
  referencia: string;
  /** El techo por factura. Por omisión, D-R1. */
  tope?: number;
}

/** Lo que el adaptador tiene que escribir. Sólo las columnas DECIDIDAS: el resto sale de la plantilla. */
export interface PlanAjuste {
  /** Columnas a pisar en el encabezado clonado. */
  kdm1: Record<string, string | number>;
  /** Columnas a pisar en el renglón de cartera clonado. */
  kdue: Record<string, string | number>;
  /** Una por factura, en orden; `c7` es el número de renglón. */
  kdm5: Array<Record<string, string | number>>;
  total: number;
  facturas: number;
  /** ⬜ Lo que no se midió no se dibuja como cero. */
  acumulados: 'no_medido';
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * De un cliente y sus facturas con resto → el plan, o el motivo por el que no se arma.
 * No consulta nada: todo lo que decide entra por parámetro.
 */
export function armarAjusteAbono(p: PeticionAjuste): Resolucion<PlanAjuste> {
  const tope = p.tope ?? RESTO_TOLERADO_CLIENTE;
  const suc = (p.sucursal ?? '').trim();
  const cliente = (p.cliente ?? '').trim();
  const ref = (p.referencia ?? '').trim();

  if (!/^\d{2}$/.test(suc)) return { ok: false, motivo: `La sucursal «${suc}» no es de dos dígitos` };
  if (!cliente) return { ok: false, motivo: 'Falta el cliente: un Ajuste Abono es de UN cliente' };
  if (!ref) return { ok: false, motivo: 'Falta la referencia de la Suite: sin ella el ajuste no es idempotente' };
  if (ref.length > REFERENCIA_MAX) {
    return { ok: false, motivo: `La referencia «${ref}» tiene ${ref.length} caracteres y kdm1.c11 admite ${REFERENCIA_MAX}` };
  }
  if (!Number.isFinite(tope) || tope <= 0) return { ok: false, motivo: `El tope del resto («${tope}») no es un número positivo` };
  if (!p.facturas?.length) return { ok: false, motivo: 'No hay facturas con resto que cerrar' };

  const vistas = new Set<string>();
  for (const f of p.facturas) {
    const id = `${f.tipo}-${f.serie}-${f.folio}`;
    if (vistas.has(id)) return { ok: false, motivo: `La factura ${id} viene dos veces: se aplicaría su resto doble` };
    vistas.add(id);
    if (!String(f.folio ?? '').trim()) return { ok: false, motivo: 'Una factura viene sin folio' };
    if (!Number.isFinite(f.importe) || !Number.isFinite(f.saldo)) {
      return { ok: false, motivo: `La factura ${id} no trae importe o saldo: sin eso no se afirma que sea un resto` };
    }
    if (f.saldo > tope) return { ok: false, motivo: `La factura ${id} debe ${f.saldo.toFixed(2)}, más que el tope de ${tope}: es deuda, no redondeo` };
    if (f.saldo <= SALDO_CERO) return { ok: false, motivo: `La factura ${id} ya está saldada (${f.saldo}): no hay resto que cerrar` };
    // La MISMA regla de la cartera y del cierre de pagos: sin un cobro previo no es resto.
    if (!esRestoDeFactura(f.saldo, f.importe, tope)) {
      return { ok: false, motivo: `La factura ${id} nunca recibió un cobro (debe ${f.saldo.toFixed(2)} de ${f.importe.toFixed(2)}): no es un resto` };
    }
  }

  const total = r2(p.facturas.reduce((s, f) => s + f.saldo, 0));
  if (!(total > SALDO_CERO)) return { ok: false, motivo: `El total del ajuste da ${total}: no se escribe un documento en cero` };

  return {
    ok: true,
    valor: {
      kdm1: { c10: cliente, c11: ref, c16: total, c42: total, c67: CAPTURISTA_SUITE },
      kdue: { c2: cliente, c11: total, c17: String(total), c16: ref },
      kdm5: p.facturas.map((f, i) => ({
        c7: i + 1, c8: 'D', c9: f.tipo, c10: f.serie, c11: f.folio, c12: r2(f.saldo), c13: r2(f.saldo), c14: ref,
      })),
      total,
      facturas: p.facturas.length,
      acumulados: 'no_medido',
    },
  };
}
