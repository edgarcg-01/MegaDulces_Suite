import type { Knex } from 'knex';
import { Permission } from '@megadulces/contracts/authz/permissions';
import type { EstadoPeriodo } from '@megadulces/contracts';
import type { MedirCtx, ResponsabilidadKey } from './me-work';

/**
 * `[SN.16]` — El trabajo que es CÍCLICO: el que se cierra mes por mes.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Pedido de Edgar (2026-09-12): *"necesito que hagamos más interactiva la forma de mostrar «mi
 * trabajo»; por ejemplo mayra_gutierrez tiene que conciliar los egresos por mes, entonces se me
 * ocurre una gráfica o tabla donde se muestren los meses conciliados y no conciliados, y al dar
 * clic a no conciliados que la redirija a la pantalla que la lleva a conciliar"*.
 *
 * Eso **no es una bandeja**. Las ocho de `me-work.ts` contestan *"¿cuántas cosas esperan?"* — una
 * cola sin fin. Esto contesta *"¿qué parte del calendario ya cerré?"* — un ciclo con unidades que
 * se completan. Son dos organismos distintos y por eso viven en archivos distintos.
 *
 * ── Las tres reglas que le dan forma ────────────────────────────────────────────────────────
 *
 *  1. ⭐ **El universo de meses lo arma el CALENDARIO, no la tabla de estado.** Es la lección que
 *     `purchase-book.service.ts` dejó escrita: *"así un mes sin trámite se ve como hueco en vez de
 *     desaparecer de la lista, que es justamente lo que pasó con julio y agosto"*. Un mes que la
 *     consulta no devuelve **se declara `sin_datos`**, no se omite.
 *
 *  2. ⛔ **`sin_datos` ≠ `sin_empezar`.** Medido en prod: **2026-06 y 2026-07 no tienen estado de
 *     cuenta cargado**. Pintarlos como "sin conciliar" sería inventarle trabajo a alguien que no
 *     tiene con qué hacerlo; un mes sin datos **no es clickeable y no cuenta como pendiente**.
 *
 *  3. ⛔ **Esto NO reimplementa el veredicto `cuadra`.** Ése vive en `GET /finance/bank/diagnostico`
 *     (pestaña Cierre) y es caro: por mes corre saldos por cuenta + P&L contra Kepler + evidencia
 *     renglón por renglón. Acá se reportan **hechos baratos del avance** —hay datos, corrió, cuántos
 *     faltan— y el veredicto queda a un clic, con un solo dueño. Dos verdades sobre "cuadra" sería
 *     el defecto que ADR-054 retiró en autorización.
 *
 * ── Lo que costó medir, y por qué el ciclo B no cuenta facturas ──────────────────────────────
 * `EXPLAIN ANALYZE` contra prod: la consulta del ciclo A son **~7 ms** con caché caliente (394 ms
 * en frío); la del ciclo B, **0.9 ms**. Pero la variante del ciclo B que contaba los CFDIs de cada
 * mes para poder decir *"faltan N facturas"* costaba **9,144 ms de ejecución en el servidor** —
 * `fiscal.cfdis` son 167k filas y ni el `Index Only Scan` la salva. Se retiró: el número se
 * **declara ausente** (`faltan: null`) en vez de pagar 9 segundos en la primera pantalla que todos
 * abren. Que no se pueda contar no cambia el hecho de que el trámite no se hizo.
 *
 * Conexión: `KNEX_CONNECTION` bypassa RLS → filtro `tenant_id` EXPLÍCITO, igual que `me-work.ts`.
 */

export interface MedidaPeriodo {
  periodo: string;
  estado: EstadoPeriodo;
  /** Cuántas cosas faltan. `null` = **no se pudo contar**, que NO es cero. */
  faltan: number | null;
  /** Por qué está así, en una línea. Va al `title` de la celda. */
  motivo: string;
}

export interface CicloDef {
  id: string;
  label: string;
  detalle: string;
  icono: string;
  ruta: string;
  /** Query params para aterrizar EN ese mes. Verificado contra cada pantalla. */
  queryDe: (periodo: string) => Record<string, string>;
  /** Cualquiera de estas claves abre `ruta`. Lo verifica el bloque 4b del smoke. */
  anyOf: readonly Permission[];
  responsabilidad?: ResponsabilidadKey;
  medir: (knex: Knex, ctx: MedirCtx) => Promise<MedidaPeriodo[]>;
}

/** Cuántos meses muestra la tira. 12 entran en el ancho de la columna sin apretar. */
export const MESES_VISIBLES = 12;

/**
 * Los últimos N meses en hora de México, del más viejo al más nuevo.
 *
 * ⚠️ La TZ importa: la API corre en UTC y el 30 de septiembre a las 19:00 de México ya es
 * 1 de octubre en UTC — el mes "actual" saldría corrido. Se ancla al día 15 para que ningún
 * corrimiento de zona mueva el mes, y se formatea con `Intl` en `America/Mexico_City`.
 */
export function ultimosMeses(n = MESES_VISIBLES): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
  });
  const hoy = new Date();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - i, 15));
    out.push(fmt.format(d).slice(0, 7));
  }
  return out;
}

/**
 * `[SN.17]` Conciliar INGRESOS y conciliar EGRESOS son **dos trabajos distintos**, con dos
 * personas distintas. Comparten la consulta y la pantalla; lo que cambia es la columna del
 * movimiento y quién responde.
 *
 * ⚠️ Los ingresos NO son un espejo de los egresos: un depósito del banco puede corresponder a
 * varias pólizas de cobranza en Kepler ("se cuadra por total, no 1 a 1", dice el detalle del
 * movimiento). Aun así el matcher **sí** los parea — medido en prod: **2,696 filas de
 * `bank_recon_matches` con `amount_in > 0`** y 2,683 movimientos casados. Por eso el ciclo existe;
 * si el matcher no los tocara, esta tira habría dicho "sin conciliar" para siempre.
 */
function medirBanco(
  kind: 'bank' | 'cash',
  columna: 'amount_in' | 'amount_out',
  sustantivo: string,
) {
  return async (knex: Knex, { tenantId }: MedirCtx): Promise<MedidaPeriodo[]> => {
    const meses = ultimosMeses();
    /*
     * UNA pasada con `FILTER` para los 12 meses. ⚠️ Contadores CRUDOS, y el estado se deriva
     * arriba: un `CASE` en cascada dentro del SQL colapsaría motivos concurrentes. Está medido
     * en `v_rd_period_summary`, que reporta `sin_gasto = 0` no porque el gasto esté, sino porque
     * dos ramas anteriores atrapan la fila antes de llegar ahí.
     */
    const filas = await knex('finance.bank_movements as bm')
      .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
      .join('finance.bank_accounts as ba', 'ba.id', 'st.bank_account_id')
      .where('st.tenant_id', tenantId)
      // `coalesce` porque `kind` admite NULL y las cuentas viejas lo tienen vacío = banco.
      .whereRaw(`coalesce(ba.kind, 'bank') = ?`, [kind])
      .whereNull('bm.deleted_at')
      .whereIn('st.period', meses)
      .groupBy('st.period')
      .select(
        'st.period',
        knex.raw(`count(*) FILTER (WHERE bm.?? > 0)::int AS total`, [columna]),
        knex.raw(`count(*) FILTER (WHERE bm.?? > 0 AND bm.recon_status = 'matched')::int AS casados`, [columna]),
        knex.raw(`count(*) FILTER (WHERE bm.?? > 0 AND bm.recon_status = 'unmatched')::int AS sin_casar`, [columna]),
      );
    const porMes = new Map(filas.map((f: Record<string, unknown>) => [String(f['period']), f]));

    return meses.map((periodo) => {
      const f = porMes.get(periodo) as { total: number; casados: number; sin_casar: number } | undefined;
      // El mes no tiene estado de cuenta cargado. NO es "sin conciliar": no hay con qué.
      if (!f || f.total === 0) {
        return { periodo, estado: 'sin_datos' as const, faltan: null,
          motivo: 'No hay estado de cuenta cargado de este mes.' };
      }
      // Nadie corrió la conciliación: todo sigue en `pending`.
      if (f.casados === 0 && f.sin_casar === 0) {
        return { periodo, estado: 'sin_empezar' as const, faltan: f.total,
          motivo: `${f.total} ${sustantivo} y la conciliación no se ha corrido.` };
      }
      if (f.sin_casar > 0) {
        return { periodo, estado: 'en_proceso' as const, faltan: f.sin_casar,
          motivo: `${f.casados} casados, ${f.sin_casar} sin casar contra Kepler.` };
      }
      return { periodo, estado: 'al_dia' as const, faltan: 0,
        motivo: `Los ${f.casados} ${sustantivo} casaron contra Kepler.` };
    });
  };
}

export const CICLOS: readonly CicloDef[] = [
  /*
   * `[SN.19]` Cuatro ciclos, no dos: **dos fuentes × dos lados**.
   *
   * Edgar (2026-09-12): *"lo que debería ver Ivonne sería conciliación de bancos y conciliación de
   * caja, mismo formato pero sólo ingresos. Mismo caso con Mayra"*. O sea que el trabajo se parte
   * por DÓNDE (banco o caja) y por QUÉ LADO (lo que entra o lo que sale); la responsabilidad de
   * cada quien decide el lado, y cada una sigue las dos fuentes.
   *
   * Las fuentes son cuentas de `finance.bank_accounts` distinguidas por `kind`, medido en prod:
   *   · `bank`  — 18 cuentas · 27,092 movimientos
   *   · `cash`  —  1 cuenta («CAJA / CG») · 8,843 movimientos, y **sí se concilian** (1,060 casados)
   *   · `factoraje` — 1 cuenta · 196 movimientos ⛔ **queda fuera**: 0 ingresos y 1 solo casado, y
   *     tiene su propia pestaña. Meterlo dentro de "bancos" ensuciaría un conteo por 196 filas que
   *     nadie concilia ahí.
   *
   * ⚠️ **El clic aterriza en el MES, no en la cuenta.** El shell de `/finanzas/bancos` sólo guarda
   * `view` y `period` en la URL (`writeUrl`), así que no hay forma de pre-filtrar a CAJA sin tocar
   * esa pantalla — y eso es de la Fase CB. Por eso la fila dice de qué fuente habla: la persona
   * llega al cuadre del mes correcto y ahí busca su cuenta. Queda declarado como lo que falta para
   * que el clic sea exacto.
   */
  {
    id: 'conciliacion-bancos-ingresos',
    label: 'Conciliación de bancos · ingresos',
    detalle: 'lo que ENTRÓ al banco, contra las pólizas de cobranza de Kepler',
    icono: 'pi pi-building-columns',
    ruta: '/finanzas/bancos',
    // Verificado: la pantalla lee `?view=&period=` de la URL y valida el periodo contra los que
    // existen (`finanzas-bancos.component.ts` §Ing.UI 9). Aterriza en el mes sin tocar esa pantalla.
    queryDe: (periodo) => ({ view: 'cuadre', period: periodo }),
    anyOf: [Permission.FINANCE_BANK_VER],
    responsabilidad: 'finanzas.conciliacion_ingresos',
    medir: medirBanco('bank', 'amount_in', 'depósitos'),
  },
  {
    id: 'conciliacion-caja-ingresos',
    label: 'Conciliación de caja · ingresos',
    detalle: 'lo que ENTRÓ a la caja general, contra Kepler',
    icono: 'pi pi-wallet',
    ruta: '/finanzas/bancos',
    queryDe: (periodo) => ({ view: 'cuadre', period: periodo }),
    anyOf: [Permission.FINANCE_BANK_VER],
    responsabilidad: 'finanzas.conciliacion_ingresos',
    medir: medirBanco('cash', 'amount_in', 'entradas'),
  },
  {
    id: 'conciliacion-bancos-egresos',
    label: 'Conciliación de bancos · egresos',
    detalle: 'lo que SALIÓ del banco, contra las pólizas del 102 de Kepler',
    icono: 'pi pi-building-columns',
    ruta: '/finanzas/bancos',
    queryDe: (periodo) => ({ view: 'cuadre', period: periodo }),
    anyOf: [Permission.FINANCE_BANK_VER],
    responsabilidad: 'finanzas.conciliacion_egresos',
    medir: medirBanco('bank', 'amount_out', 'retiros'),
  },
  {
    id: 'conciliacion-caja-egresos',
    label: 'Conciliación de caja · egresos',
    detalle: 'lo que SALIÓ de la caja general, contra Kepler',
    icono: 'pi pi-wallet',
    ruta: '/finanzas/bancos',
    queryDe: (periodo) => ({ view: 'cuadre', period: periodo }),
    anyOf: [Permission.FINANCE_BANK_VER],
    responsabilidad: 'finanzas.conciliacion_egresos',
    medir: medirBanco('cash', 'amount_out', 'salidas'),
  },
  {
    id: 'libro-de-compras',
    label: 'Libro de compras',
    detalle: 'la póliza mensual que se entrega a ContPAQi',
    icono: 'pi pi-book',
    ruta: '/contabilidad/libro-de-compras',
    // Verificado: `ngOnInit` lee `?mes=` y abre ese mes (`libro-compras.component.ts:296`).
    queryDe: (periodo) => ({ mes: periodo }),
    anyOf: [Permission.FISCAL_PURCHASE_BOOK_VER],
    medir: async (knex, { tenantId }) => {
      const meses = ultimosMeses();
      // 3 filas en prod: 0.9 ms. Se lee el `estado` que la tabla YA guarda — no se recalcula
      // ningún veredicto. El universo lo pone el calendario, no esta tabla.
      const filas = await knex('finance.purchase_book_runs')
        .where({ tenant_id: tenantId, tipo: 'libro' })
        .whereNull('deleted_at')
        .whereIn('anio_mes', meses)
        .select('anio_mes', 'estado', 'facturas');
      const porMes = new Map(
        filas.map((f: Record<string, unknown>) => [String(f['anio_mes']), f]),
      );

      return meses.map((periodo) => {
        const f = porMes.get(periodo) as { estado: string; facturas: number | null } | undefined;
        /*
         * ⚠️ Sin `estado` el trámite NO se hizo — eso es un hecho. Lo que NO se sabe es si ese mes
         * tenía facturas, porque contarlas cuesta 9 s (ver cabecera). Por eso `faltan: null`: se
         * declara que no se contó, en vez de escribir un 0 que se leería como "no hay nada que
         * hacer" (ADR-056).
         */
        if (!f) {
          return { periodo, estado: 'sin_empezar' as const, faltan: null,
            motivo: 'No se ha armado el libro de este mes.' };
        }
        if (f.estado === 'aplicado') {
          return { periodo, estado: 'al_dia' as const, faltan: 0,
            motivo: 'Entregado y aplicado en ContPAQi.' };
        }
        if (f.estado === 'cancelado') {
          return { periodo, estado: 'sin_empezar' as const, faltan: null,
            motivo: 'La póliza de este mes se canceló.' };
        }
        return { periodo, estado: 'en_proceso' as const, faltan: f.facturas ?? null,
          motivo: `En ${f.estado}${f.facturas ? ` · ${f.facturas} facturas` : ''}.` };
      });
    },
  },
];

/** ¿Esta persona puede abrir este ciclo? God-mode ve todos; el resto, por clave exacta. */
export function puedeVerCiclo(
  c: CicloDef,
  permisos: Record<string, boolean> | null | undefined,
  esAdmin: boolean,
): boolean {
  if (esAdmin) return true;
  const p = permisos ?? {};
  return c.anyOf.some((k) => p[k] === true);
}
