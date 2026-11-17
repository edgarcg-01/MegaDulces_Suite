import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { KNEX_NEW_DB, TenantKnexService, latirCron, todayMx, urlDeServidor } from '@megadulces/platform-core';
import {
  comprobacionDelVale, totalParaComprobar, formaPago, type ComprobacionEnLaCola, type EscrituraDelGastoEnLaBase, type EstadoKeplerDelGasto,
  type SolicitudAComprobar, type ValeAComprobar,
} from '@megadulces/contracts';

import {
  KeplerGastoSinkAdapter, SERVIDORES_POLIZA_MENSUAL, type EntregaGastoKepler, type ResultadoEscrituraGasto,
} from './kepler-gasto-sink.adapter';

/**
 * `[PGP.123]` G.8 C2 — **Al validar el vale, la Suite comprueba su gasto en Kepler (escribe el X-A-10 con su póliza).**
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_COMPROBACION_DE_GASTO.md` §5.1 y §5.4.
 *
 * El disparo (DG8) es el vale que queda `validada`: al firmarlo, si cierra ahí, o al validarlo después («Dar por
 * comprobado»). También los vales que no nacieron en la Suite (DG9): basta que estén ligados a su X-A-15 por
 * `folio_solicitud`. Si se puede o no lo decide el contrato `comprobacionDelVale` (G.5) con la X-A-15 del ODS; el
 * escritor la vuelve a leer en el Kepler vivo dentro de su transacción.
 *
 * ── Los pasos, en transacciones SEPARADAS a propósito (como la solicitud, PGP.122) ───────────────────────────────
 *   1. el RECLAMO atómico (`null|pending|retry → writing`) se confirma ANTES de hablar con Kepler: la validación y el
 *      cron a la vez no escriben dos veces;
 *   2. Kepler (el escritor busca el gasto de esa solicitud antes de escribir: si ya está, devuelve ese folio);
 *   3. el resultado en el vale y su renglón en la bitácora (`expense_request_kepler_attempts`, tipo 10).
 * Si el proceso muere entre 1 y 3, el vale queda en `writing`: el cron lo pasa a `in_doubt` a los 10 min y busca el
 * gasto en Kepler antes de cualquier reintento.
 *
 * ── El lazo con el ODS ────────────────────────────────────────────────────────────────────────────────────────────
 * Lo escrito tiene que aparecer en `kepler_ods.kdm1` (`c4 = 10`, su folio): `written → seen_in_ods`. Si Kepler lo
 * cancela (`c43 = C`), el vale pasa a `cancelled` y lo dice; la Suite no lo vuelve a escribir sola. Un gasto que
 * capturó una persona se reconoce igual (por la solicitud) y queda `seen_in_ods` con su folio.
 *
 * Nunca lanza hacia quien valida: la validación ya quedó guardada en la Suite.
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const TIPO_INTERRUPTOR = 'comprobacion_gasto';
/** Minutos de espera entre reintentos; tras el último, `stuck` (lo reintenta una persona). */
export const ESPERAS_GASTO_MIN = [5, 15, 60, 60, 60, 60] as const;
/** Un `writing` más viejo que esto ya no está escribiendo: el proceso murió. Se busca el gasto en Kepler. */
const WRITING_HUERFANO_MIN = 10;
/** Un vale que todavía no se puede comprobar (la fecha, la factura, otro mes…) se vuelve a revisar en una hora. */
const REVISAR_EN_MIN = 60;
const SUCURSALES: readonly string[] = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
/** DG3: las formas de pago del vale que ya tienen código de Kepler sin duda. */
const FORMAS_DECODIFICADAS: ReadonlySet<string> = new Set(['01', '02', '03', '04', '99']);

type Trx = Knex | Knex.Transaction;
type Ejecutor = <T>(fn: (trx: Knex.Transaction) => Promise<T>) => Promise<T>;
export type DisparoDelGasto = 'firma' | 'validacion' | 'cron' | 'reintento';

/** `HH:MM` en México, para `c69`. */
function horaMx(d = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
}

/** La forma de pago del vale en código de Kepler (DG3), sólo si es de las decodificadas. */
export function formaPagoKepler(formaPagoVale: string | null | undefined): string | null {
  const codigo = String(formaPago(formaPagoVale ?? undefined)?.codigo_kepler ?? '').trim();
  return FORMAS_DECODIFICADAS.has(codigo) ? codigo : null;
}

/** Lo que hace falta del vale para comprobar su gasto. */
interface ValeParaGasto {
  id: string; status: string; sucursal: string | null; folio_solicitud: string | null; importe: string | number | null;
  forma_pago: string | null; cfdi_uuid: string | null;
  kepler_expense_status: string | null; kepler_expense_folio: string | null; kepler_expense_attempts: number | null;
  kepler_expense_note: string | null; kepler_expense_next_at: string | Date | null; kepler_expense_policy: string | null;
  kepler_expense_date: string | null;
  /** GX.9 guarda aquí lo que declaró quien capturó (`importe_declarado`) cuando casa el vale con su solicitud. */
  capture_meta: unknown;
}
const COLUMNAS_DEL_VALE = [
  'id', 'status', 'sucursal', 'folio_solicitud', 'importe', 'forma_pago', 'cfdi_uuid', 'kepler_expense_status', 'kepler_expense_folio',
  'kepler_expense_attempts', 'kepler_expense_note', 'kepler_expense_next_at', 'kepler_expense_policy', 'capture_meta',
] as const;

/** La X-A-15 en el ODS, con el folio de su gasto vivo si lo tiene. */
type SolicitudDelOds = SolicitudAComprobar & { gasto_folio: string | null; acreedor?: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** El folio de Kepler a 7 dígitos, como lo compara el ODS (`lpad(btrim(c6), 7, '0')`). */
const folio7 = (f: unknown): string => String(f ?? '').trim().padStart(7, '0');

/** Las columnas de la X-A-15 que lee la regla G.5 (sin su gasto: ése va aparte o correlacionado). */
const SQL_SOLICITUD_SOLA = `SELECT s.sucursal, lpad(btrim(s.c6), 7, '0') AS folio, btrim(s.c43) AS estado, s.c16::float8 AS total,
         s.c42::float8 AS saldo, s.c15::float8 AS retencion, to_char(s.c9, 'YYYY-MM-DD') AS fecha, nullif(btrim(x.c10), '') AS acreedor_rfc,
         btrim(s.c10) AS acreedor`;
const SQL_SOLICITUD_DESDE = `
    FROM kepler_ods.kdm1 s
    LEFT JOIN LATERAL (SELECT c10 FROM kepler_ods.kdxd d WHERE d.sucursal = s.sucursal AND btrim(d.c2) = btrim(s.c10) ORDER BY d.c1 LIMIT 1) x ON true
   WHERE s.c2 = 'X' AND s.c3 = 'A' AND s.c4 = 15 AND s.c5 = 1`;
/** Para UN vale: la X-A-15 con el folio de su gasto vivo (`c39`), correlacionado. */
const SQL_SOLICITUD = `${SQL_SOLICITUD_SOLA},
         (SELECT lpad(btrim(g.c6), 7, '0') FROM kepler_ods.kdm1 g
           WHERE g.sucursal = s.sucursal AND g.c2 = 'X' AND g.c3 = 'A' AND g.c4 = 10 AND g.c5 = 1 AND btrim(g.c43) <> 'C'
             AND lpad(btrim(g.c39), 7, '0') = lpad(btrim(s.c6), 7, '0') ORDER BY g.c6 LIMIT 1) AS gasto_folio${SQL_SOLICITUD_DESDE}`;
/*
 * En LOTE (la cola), tres lecturas que usan los índices de kdm1 en vez de una correlacionada por fila. Medido en prod el
 * 2026-11-16 con los 184 pares de la cola: la correlacionada con el RFC por fila tardaba ~300 ms; así, ~42 ms juntas.
 * ⚠️ Comparan el folio con `btrim`, no con `lpad(btrim(…), 7, '0')` (que no usa índice): en prod las 12,923 X-A-15 traen
 * `c6` a 7 dígitos y las 11,533 X-A-10 traen `c39` igual. Si un folio llegara sin ceros, ese vale saldría `sin_medir`
 * (se dice), nunca con la solicitud de otro.
 */
/** Las X-A-15 de los pares exactos (sucursal, folio), con la clave de su acreedor (`idx_kdm1_xa_doc`). */
const SQL_LOTE_SOLICITUDES = `SELECT s.sucursal, btrim(s.c6) AS folio, btrim(s.c43) AS estado, s.c16::float8 AS total, s.c42::float8 AS saldo,
         s.c15::float8 AS retencion, to_char(s.c9, 'YYYY-MM-DD') AS fecha, btrim(s.c10) AS acreedor
    FROM unnest(?::text[], ?::text[]) AS p(suc, fol)
    JOIN kepler_ods.kdm1 s ON s.sucursal = p.suc AND s.c2 = 'X' AND s.c3 = 'A' AND btrim(s.c4::text) = '15' AND s.c4 = 15 AND s.c5 = 1
                          AND btrim(s.c6) = p.fol`;
/** El RFC (`kdxd.c10`) de esos acreedores, en una pasada. */
const SQL_LOTE_RFC = `SELECT DISTINCT ON (sucursal, btrim(c2)) sucursal, btrim(c2) AS clave, nullif(btrim(c10), '') AS rfc
    FROM kepler_ods.kdxd WHERE sucursal = ANY(?::text[]) AND btrim(c2) = ANY(?::text[]) ORDER BY sucursal, btrim(c2), c1`;
/** Los gastos vivos (X-A-10) de esas solicitudes (`idx_kdm1_xa_chain`). */
const SQL_LOTE_GASTOS = `SELECT g.sucursal, btrim(g.c39) AS solicitud, min(btrim(g.c6)) AS gasto_folio
    FROM kepler_ods.kdm1 g
   WHERE g.c2 = 'X' AND g.c3 = 'A' AND g.c4 = 10 AND g.c5 = 1 AND btrim(g.c43) <> 'C'
     AND g.sucursal = ANY(?::text[]) AND btrim(g.c39) = ANY(?::text[])
   GROUP BY 1, 2`;

@Injectable()
export class ComprobacionGastoService {
  private readonly logger = new Logger(ComprobacionGastoService.name);
  private corriendo = false;

  constructor(
    private readonly tk: TenantKnexService,
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    /** `@Optional` y al final: sin el escritor el vale se valida igual y Kepler no se toca — nunca al revés. */
    @Optional() private readonly sink?: KeplerGastoSinkAdapter,
  ) {}

  /** La llaman la firma (si cierra en `validada`) y la validación, DESPUÉS de guardarse. Nunca lanza. */
  async escribirAlValidar(id: string, actor: string | null, disparo: 'firma' | 'validacion' = 'validacion'): Promise<EstadoKeplerDelGasto | null> {
    try {
      return await this.intentar((fn) => this.tk.run(fn), id, disparo, actor);
    } catch (e) {
      this.logger.error(`vale ${id}: quedó validado, pero la comprobación en Kepler no terminó: ${(e as Error).message}. Si alcanzó a reclamarse, el cron la revisa en ${WRITING_HUERFANO_MIN} min`);
      return null;
    }
  }

  /** «Reintentar» de una persona: también los atorados, los que Kepler rechazó (ya corregidos) y los cancelados. */
  async reintentar(id: string, actor: string): Promise<EstadoKeplerDelGasto | null> {
    return this.intentar((fn) => this.tk.run(fn), id, 'reintento', actor);
  }

  private estadoDe(v: Pick<ValeParaGasto, 'id' | 'kepler_expense_status' | 'kepler_expense_folio' | 'kepler_expense_note' | 'kepler_expense_attempts' | 'kepler_expense_next_at' | 'kepler_expense_policy' | 'kepler_expense_date'>): EstadoKeplerDelGasto {
    const sig = v.kepler_expense_next_at;
    // Llega como `YYYY-MM-DD` (to_char) o, del `returning`, como Date: en las dos sirve el ISO recortado.
    const fecha: unknown = v.kepler_expense_date;
    return {
      id: String(v.id), status: v.kepler_expense_status ?? null, folio: v.kepler_expense_folio ?? null, poliza: v.kepler_expense_policy ?? null,
      fecha: fecha ? (fecha instanceof Date ? fecha.toISOString() : String(fecha)).slice(0, 10) : null,
      nota: v.kepler_expense_note ?? null, intentos: Number(v.kepler_expense_attempts ?? 0), siguiente: sig ? new Date(sig).toISOString() : null,
    };
  }

  /** La X-A-15 del vale en el ODS (`null` si no se pudo leer: el contrato lo declara `sin_medir`). */
  private async solicitudDelOds(trx: Trx, sucursal: string, folio: string): Promise<SolicitudDelOds | null> {
    try {
      const r = (await trx.raw(`${SQL_SOLICITUD} AND s.sucursal = ? AND lpad(btrim(s.c6), 7, '0') = ? LIMIT 1`, [sucursal, folio7(folio)]))
        .rows[0] as (Omit<SolicitudDelOds, 'gasto_vivo'>) | undefined;
      if (!r) return null;
      return { ...r, gasto_vivo: !!r.gasto_folio };
    } catch (e) {
      this.logger.warn(`vale de ${sucursal}/${folio}: no se pudo leer la solicitud en el ODS: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * El CFDI ligado al vale, si lo trae (para que case con la solicitud, §5.1-4). `declarado` = el vale trae factura: si
   * no se pudo leer (o no está en la Suite), `cfdi` es `null` y G.5 lo declara `sin_medir`, nunca «sin factura».
   * ⚠️ `fiscal.cfdis` guarda el UUID en mayúsculas y la bandeja del SAT en minúsculas: se busca por igualdad con los dos,
   * con el tenant, para usar el índice único `(tenant_id, uuid)` (con `lower(uuid)` recorría las 455 mil facturas).
   */
  private async cfdiDelVale(trx: Knex.Transaction, uuid: string | null): Promise<{ cfdi: ValeAComprobar['cfdi']; declarado: boolean }> {
    const u = String(uuid ?? '').trim();
    if (!u) return { cfdi: null, declarado: false };
    const f = await trx.transaction(async (sp) => sp('fiscal.cfdis').where('tenant_id', sp.raw('public.current_tenant_id()'))
      .whereIn('uuid', [...new Set([u.toUpperCase(), u.toLowerCase()])]).where({ rol: 'recibidas' })
      .first<{ uuid: string; total: string | number; emisor_rfc: string; total_retenidos: string | number | null } | undefined>('uuid', 'total', 'emisor_rfc', 'total_retenidos'))
      .catch((e) => { this.logger.warn(`vale con factura ${u}: no se pudo leer en fiscal.cfdis: ${(e as Error).message}`); return undefined; });
    return { cfdi: f ? { uuid: f.uuid, total: Number(f.total), emisor_rfc: String(f.emisor_rfc ?? ''), retenciones: Number(f.total_retenidos ?? 0) } : null, declarado: true };
  }

  /**
   * `[PGP.123]` G.9 — **Lo que «Esperan a Kepler» dice del gasto de cada vale** (anexo G §14): la regla G.5 (se
   * comprueba solo, o el motivo y a quién le toca), cómo va su X-A-10 y si en esa base la Suite escribe. En LOTE: una
   * lectura del ODS para todas las solicitudes (la cola trae ~190 vales en prod; por vale serían ~190 viajes). Nunca
   * lanza: lo que no se pudo leer lo declara el contrato (`sin_medir`). No escribe nada.
   */
  async enLaCola(ids: readonly string[]): Promise<Map<string, ComprobacionEnLaCola>> {
    const out = new Map<string, ComprobacionEnLaCola>();
    const limpios = [...new Set(ids.map((x) => String(x ?? '').trim().toLowerCase()).filter((x) => UUID.test(x)))];
    if (!limpios.length) return out;
    return this.tk.run(async (trx) => {
      const conG6 = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'kepler_expense_status');
      const vales = (await trx('finance.expense_proofs').whereIn('id', limpios)
        .select(conG6 ? [...COLUMNAS_DEL_VALE, trx.raw(`to_char(kepler_expense_date, 'YYYY-MM-DD') AS kepler_expense_date`)]
          : ['id', 'status', 'sucursal', 'folio_solicitud', 'importe', 'forma_pago', 'cfdi_uuid', 'capture_meta'])) as ValeParaGasto[];
      const conSolicitud = vales.filter((v) => String(v.sucursal ?? '').trim() && String(v.folio_solicitud ?? '').trim());
      const solicitudes = new Map<string, SolicitudDelOds>();
      if (conSolicitud.length) {
        try {
          // En su SAVEPOINT: una lectura fallida no aborta la transacción (GOTCHAS §2).
          type FilaSolicitud = Omit<SolicitudDelOds, 'gasto_vivo' | 'gasto_folio' | 'acreedor_rfc'> & { sucursal: string; folio: string; acreedor: string };
          // Los pares exactos (sucursal, folio) de los vales: no el producto de todas las sucursales por todos los folios.
          const sucs = conSolicitud.map((v) => String(v.sucursal).trim());
          const fols = conSolicitud.map((v) => folio7(v.folio_solicitud));
          const filas = await trx.transaction(async (sp) => ((await sp.raw(SQL_LOTE_SOLICITUDES, [sucs, fols])) as { rows: FilaSolicitud[] }).rows);
          type FilaRfc = { sucursal: string; clave: string; rfc: string | null };
          type FilaGasto = { sucursal: string; solicitud: string; gasto_folio: string };
          let rfcs: FilaRfc[] = [];
          let gastos: FilaGasto[] = [];
          if (filas.length) {
            [rfcs, gastos] = await trx.transaction(async (sp): Promise<[FilaRfc[], FilaGasto[]]> => [
              ((await sp.raw(SQL_LOTE_RFC, [[...new Set(filas.map((r) => r.sucursal))], [...new Set(filas.map((r) => r.acreedor))]])) as { rows: FilaRfc[] }).rows,
              ((await sp.raw(SQL_LOTE_GASTOS, [[...new Set(sucs)], [...new Set(fols)]])) as { rows: FilaGasto[] }).rows,
            ]);
          }
          const rfcDe = new Map<string, string | null>(rfcs.map((x): [string, string | null] => [`${x.sucursal}|${x.clave}`, x.rfc]));
          const gastoDe = new Map<string, string>(gastos.map((g): [string, string] => [`${g.sucursal}|${g.solicitud}`, g.gasto_folio]));
          for (const r of filas) {
            const gasto_folio = gastoDe.get(`${r.sucursal}|${r.folio}`) ?? null;
            const { acreedor, ...sol } = r;
            solicitudes.set(`${r.sucursal}|${r.folio}`, { ...sol, acreedor_rfc: rfcDe.get(`${r.sucursal}|${acreedor}`) ?? null, gasto_folio, gasto_vivo: !!gasto_folio });
          }
        } catch (e) {
          this.logger.warn(`la cola: no se pudieron leer las solicitudes en el ODS: ${(e as Error).message}`);
        }
      }
      const uuids = [...new Set(vales.map((v) => String(v.cfdi_uuid ?? '').trim().toLowerCase()).filter(Boolean))];
      const cfdis = new Map<string, NonNullable<ValeAComprobar['cfdi']>>();
      if (uuids.length) {
        // Por igualdad (mayúsculas y minúsculas) y con el tenant: usa el índice único `(tenant_id, uuid)`.
        const variantes = [...new Set(uuids.flatMap((x) => [x, x.toUpperCase()]))];
        const filas = await trx.transaction(async (sp) => sp('fiscal.cfdis').where('tenant_id', sp.raw('public.current_tenant_id()'))
          .whereIn('uuid', variantes).where({ rol: 'recibidas' })
          .select<Array<{ uuid: string; total: string | number; emisor_rfc: string; total_retenidos: string | number | null }>>('uuid', 'total', 'emisor_rfc', 'total_retenidos'))
          .catch(() => [] as Array<{ uuid: string; total: string | number; emisor_rfc: string; total_retenidos: string | number | null }>);
        for (const c of filas) cfdis.set(String(c.uuid).toLowerCase(), { uuid: c.uuid, total: Number(c.total), emisor_rfc: String(c.emisor_rfc ?? ''), retenciones: Number(c.total_retenidos ?? 0) });
      }
      const encendidas = new Set<string>(await trx.transaction(async (sp) => sp('commercial.kepler_push_switch')
        .where({ tipo: TIPO_INTERRUPTOR, encendida: true }).pluck('sucursal')).catch(() => [] as string[]));
      const hoy = todayMx();
      for (const v of vales) {
        const s = solicitudes.get(`${String(v.sucursal ?? '').trim()}|${folio7(v.folio_solicitud)}`) ?? null;
        const declarado = !!String(v.cfdi_uuid ?? '').trim();
        const cfdi = declarado ? cfdis.get(String(v.cfdi_uuid).trim().toLowerCase()) ?? null : null;
        out.set(String(v.id), {
          comprobacion: comprobacionDelVale({ status: v.status, sucursal: v.sucursal, folio_solicitud: v.folio_solicitud,
            total: totalParaComprobar(v.importe, v.capture_meta), cfdi, cfdi_declarado: declarado }, s, hoy),
          gasto: conG6 && (v.kepler_expense_status || v.kepler_expense_folio) ? this.estadoDe(v) : null,
          escritura: this.escrituraEn(String(v.sucursal ?? '').trim(), encendidas),
        });
      }
      return out;
    });
  }

  /** ¿La Suite escribe hoy el gasto en esa base? Los mismos candados que el intento y el cron, dichos en llano. */
  private escrituraEn(sucursal: string, encendidas: ReadonlySet<string>): EscrituraDelGastoEnLaBase {
    const detalle = !this.sink ? 'El escritor de gastos a Kepler no está cargado en este servidor'
      : !this.sink.encendida() ? 'La bandera KEPLER_GASTO_COMPROBACION está apagada'
        : !SERVIDORES_POLIZA_MENSUAL.has(sucursal) ? `DG7: en ${sucursal} la póliza D lleva un contador que la Suite todavía no ve (G.1)`
          : !encendidas.has(sucursal) ? `El interruptor ${TIPO_INTERRUPTOR} de la sucursal ${sucursal} está apagado`
            : !urlDeServidor(sucursal, process.env).ok ? `Sin conexión configurada al Kepler de la sucursal ${sucursal}` : null;
    if (!detalle) return { abierta: true, motivo: null, detalle: null };
    return {
      abierta: false, detalle,
      motivo: detalle.startsWith('DG7') ? 'En esta base la Suite todavía no escribe gastos: su póliza lleva un contador que falta medir'
        : 'La escritura de gastos a Kepler todavía está apagada en esta base',
    };
  }

  /** Un intento completo: leer → decidir (contrato) → (si quedó en duda, buscar el gasto) → reclamar → Kepler → anotar. */
  private async intentar(run: Ejecutor, id: string, disparo: DisparoDelGasto, actor: string | null): Promise<EstadoKeplerDelGasto | null> {
    const manual = disparo === 'reintento';
    const leer = async (trx: Trx): Promise<ValeParaGasto | undefined> => (await trx('finance.expense_proofs').where({ id })
      .first([...COLUMNAS_DEL_VALE, trx.raw(`to_char(kepler_expense_date, 'YYYY-MM-DD') AS kepler_expense_date`)])) as ValeParaGasto | undefined;

    // ── 1. Leer y decidir si toca ─────────────────────────────────────────────────────────────────────────────────
    const lectura = await run(async (trx) => {
      if (!(await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'kepler_expense_status'))) return null;
      const v = await leer(trx);
      if (!v) return null;
      const sw = await trx.transaction(async (sp) => sp('commercial.kepler_push_switch').where({ sucursal: v.sucursal, tipo: TIPO_INTERRUPTOR })
        .first<{ encendida: boolean; tope_dia: number | null } | undefined>('encendida', 'tope_dia')).catch(() => undefined);
      const s = v.sucursal && v.folio_solicitud ? await this.solicitudDelOds(trx, String(v.sucursal), String(v.folio_solicitud)) : null;
      const factura = await this.cfdiDelVale(trx, v.cfdi_uuid);
      return { v, sw, s, factura };
    });
    if (!lectura) return null;
    const { v, sw, s, factura } = lectura;
    if (v.kepler_expense_folio || ['written', 'seen_in_ods', 'writing'].includes(String(v.kepler_expense_status))) return this.estadoDe(v);
    if (v.kepler_expense_status === 'cancelled' && !manual) return this.estadoDe(v);
    if (!this.sink) return this.estadoDe(v);
    const sucursal = String(v.sucursal);

    // ── 2. En duda: ANTES de decidir nada, averiguar si quedó ─────────────────────────────────────────────────────────
    // Si el COMMIT sí llegó, la solicitud ya está en F y la regla diría otra cosa: el vale se quedaba en duda para siempre
    // (revisión independiente, 2026-11-17). Primero el ODS, que no necesita hablar con Kepler; luego el Kepler vivo.
    if (v.kepler_expense_status === 'in_doubt') {
      if (s?.gasto_folio) {
        const r: ResultadoEscrituraGasto = { estado: 'ya_estaba', sucursal, folio: s.gasto_folio, kepler: 'visto en el ODS' };
        return run(async (trx) => this.anotar(trx, id, v, r, disparo, actor, null));
      }
      const m = await this.sink.buscarGasto(sucursal, folio7(v.folio_solicitud));
      if (!m.ok) {
        const nota = `En duda, y no se pudo buscar el gasto en Kepler: ${m.motivo}`;
        await run(async (trx) => trx('finance.expense_proofs').where({ id, kepler_expense_status: 'in_doubt' })
          .update({ kepler_expense_note: nota, kepler_expense_next_at: trx.raw(`now() + interval '5 minutes'`), updated_at: trx.fn.now() }));
        return this.estadoDe({ ...v, kepler_expense_note: nota });
      }
      if (m.encontrado) {
        const r: ResultadoEscrituraGasto = { estado: 'ya_estaba', sucursal, folio: m.encontrado.folio, kepler: m.encontrado.kepler };
        return run(async (trx) => this.anotar(trx, id, v, r, disparo, actor, null));
      }
      // No quedó: deja de estar en duda y sigue el camino de siempre (la regla decide si se escribe).
      await run(async (trx) => trx('finance.expense_proofs').where({ id, kepler_expense_status: 'in_doubt' })
        .update({ kepler_expense_status: 'retry', updated_at: trx.fn.now() }));
      v.kepler_expense_status = 'retry';
    }

    const hoy = todayMx();
    const decision = comprobacionDelVale({
      status: v.status, sucursal: v.sucursal, folio_solicitud: v.folio_solicitud,
      total: totalParaComprobar(v.importe, v.capture_meta), cfdi: factura.cfdi, cfdi_declarado: factura.declarado,
    }, s, hoy);
    if (!decision.listo) {
      // Una persona ya lo capturó en Kepler: se reconoce con su folio y el lazo queda cerrado.
      if (decision.motivo === 'ya_comprobado' && s?.gasto_folio) {
        return run(async (trx) => {
          const [fila] = await trx('finance.expense_proofs').where({ id }).whereNull('kepler_expense_folio')
            .update({ kepler_expense_status: 'seen_in_ods', kepler_expense_folio: s.gasto_folio, kepler_expense_at: trx.fn.now(), kepler_expense_next_at: null,
              kepler_expense_note: `Kepler ya tiene su gasto (X-A-10 ${s.gasto_folio}): no lo escribió la Suite`, updated_at: trx.fn.now() })
            .returning([...COLUMNAS_DEL_VALE]);
          return this.estadoDe(fila ?? v);
        });
      }
      // Todavía no: se dice por qué y se vuelve a revisar en una hora (sólo los vales validados esperan).
      const nota = decision.texto;
      if (v.status !== 'validada') return this.estadoDe({ ...v, kepler_expense_note: nota });
      const [fila] = await run(async (trx) => trx('finance.expense_proofs').where({ id }).whereNull('kepler_expense_folio')
        .where((q) => q.whereNull('kepler_expense_status').orWhereIn('kepler_expense_status', ['pending', 'retry']))
        .update({ kepler_expense_status: 'pending', kepler_expense_note: nota, kepler_expense_next_at: trx.raw(`now() + make_interval(mins => ?)`, [REVISAR_EN_MIN]), updated_at: trx.fn.now() })
        .returning([...COLUMNAS_DEL_VALE]));
      return this.estadoDe(fila ?? { ...v, kepler_expense_note: nota });
    }

    // G.5 sólo dice «listo» con la solicitud leída; si no, no se sigue (y el tipo lo sabe).
    if (!s) return this.estadoDe(v);
    // Apagado (interruptor, bandera o DG7): no se intenta y no cuenta; queda esperando a que lo enciendan.
    // [PGP.123] G.UI.8: la nota llega a la persona (el aviso de «Escribir el gasto ahora»): en llano, sin códigos.
    const apagadoPor = !sw?.encendida ? `El interruptor de la escritura de gastos de la sucursal ${sucursal} está apagado`
      : !this.sink.encendida() ? 'La escritura de gastos a Kepler está apagada en este servidor'
        : !SERVIDORES_POLIZA_MENSUAL.has(sucursal) ? `En la sucursal ${sucursal} la Suite todavía no escribe gastos: su póliza lleva un contador que falta medir` : null;
    if (apagadoPor) {
      if (v.kepler_expense_note !== apagadoPor || disparo !== 'cron') {
        await run(async (trx) => {
          await trx('finance.expense_proofs').where({ id }).whereNull('kepler_expense_folio')
            .where((q) => q.whereNull('kepler_expense_status').orWhereIn('kepler_expense_status', ['pending', 'retry']))
            .update({ kepler_expense_status: 'pending', kepler_expense_note: apagadoPor, kepler_expense_next_at: trx.raw(`now() + interval '15 minutes'`), updated_at: trx.fn.now() });
          if (disparo !== 'cron') await this.bitacora(trx, id, disparo, v, { estado: 'apagado', motivo: apagadoPor }, null, actor);
        });
      }
      return this.estadoDe({ ...v, kepler_expense_status: v.kepler_expense_status ?? 'pending', kepler_expense_note: apagadoPor });
    }

    // ── 3. El reclamo atómico, confirmado ANTES de hablar con Kepler ──────────────────────────────────────────────
    const reclamables = manual ? ['pending', 'retry', 'stuck', 'rejected_by_kepler', 'cancelled'] : ['pending', 'retry'];
    const reclamado = await run(async (trx) => trx('finance.expense_proofs')
      .where({ id, status: 'validada' }).whereNull('kepler_expense_folio')
      .where((q) => q.whereNull('kepler_expense_status').orWhereIn('kepler_expense_status', reclamables))
      .modify((qb) => { if (!manual && v.kepler_expense_status === 'retry') qb.where((w) => w.whereNull('kepler_expense_next_at').orWhere('kepler_expense_next_at', '<=', trx.fn.now())); })
      .update({ kepler_expense_status: 'writing', kepler_expense_at: trx.fn.now(), updated_at: trx.fn.now() })
      .returning('id'));
    if (!reclamado.length) return run(async (trx) => { const otra = await leer(trx); return otra ? this.estadoDe(otra) : null; });

    // ── 4. Kepler ─────────────────────────────────────────────────────────────────────────────────────────────────
    const entrega: EntregaGastoKepler = {
      sucursal, solicitud: String(v.folio_solicitud).padStart(7, '0'), fecha: decision.fecha, capturadoEn: { fecha: hoy, hora: horaMx() },
      formaPagoVale: formaPagoKepler(v.forma_pago), vale: id, tope_dia: sw?.tope_dia ?? null,
      // Lo que aprobó G.5 (del ODS): el escritor lo compara con la X-A-15 viva antes de escribir.
      esperado: { total: s.total, acreedor: String(s.acreedor ?? ''), fecha: s.fecha },
    };
    let r: ResultadoEscrituraGasto;
    try {
      r = await this.sink.entregar(entrega);
    } catch (e) {
      r = { estado: 'en_duda', motivo: `El escritor falló sin contestar: ${(e as Error).message}` };
    }
    return run(async (trx) => this.anotar(trx, id, v, r, disparo, actor, entrega));
  }

  /** Guarda el resultado en el vale y su renglón en la bitácora. */
  private async anotar(trx: Knex.Transaction, id: string, v: ValeParaGasto, r: ResultadoEscrituraGasto, disparo: DisparoDelGasto, actor: string | null, entrega: EntregaGastoKepler | null): Promise<EstadoKeplerDelGasto> {
    const intentos = Number(v.kepler_expense_attempts ?? 0) + (r.estado === 'apagado' ? 0 : 1);
    const ahora = trx.fn.now();
    let cambio: Record<string, unknown>;
    if (r.estado === 'escrito') {
      cambio = { kepler_expense_status: 'written', kepler_expense_folio: r.folio, kepler_expense_policy: `${r.tablaPoliza}/D/${r.poliza}`,
        kepler_expense_date: entrega?.fecha ?? null, kepler_expense_next_at: null, kepler_expense_note: null };
    } else if (r.estado === 'ya_estaba') {
      cambio = { kepler_expense_status: 'written', kepler_expense_folio: r.folio, kepler_expense_next_at: null,
        kepler_expense_note: `Kepler ya tenía el gasto de esta solicitud (X-A-10 ${r.folio}, ${r.kepler}): no se escribió otro` };
    } else if (r.estado === 'apagado') {
      cambio = { kepler_expense_status: 'pending', kepler_expense_note: r.motivo, kepler_expense_next_at: trx.raw(`now() + interval '15 minutes'`) };
    } else if (r.estado === 'en_duda') {
      cambio = { kepler_expense_status: 'in_doubt', kepler_expense_note: r.motivo, kepler_expense_next_at: trx.raw(`now() + interval '5 minutes'`) };
    } else if (r.reintentable) {
      if (r.porTope) {
        cambio = { kepler_expense_status: 'retry', kepler_expense_note: r.motivo, kepler_expense_next_at: trx.raw(`(date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') + interval '1 day 7 hours') AT TIME ZONE 'America/Mexico_City'`) };
      } else if (intentos >= ESPERAS_GASTO_MIN.length) {
        cambio = { kepler_expense_status: 'stuck', kepler_expense_note: `${r.motivo} (${intentos} intentos: lo reintenta una persona)`, kepler_expense_next_at: null };
      } else {
        cambio = { kepler_expense_status: 'retry', kepler_expense_note: r.motivo, kepler_expense_next_at: trx.raw(`now() + make_interval(mins => ?)`, [ESPERAS_GASTO_MIN[intentos - 1] ?? 60]) };
      }
    } else {
      cambio = { kepler_expense_status: 'rejected_by_kepler', kepler_expense_note: r.motivo, kepler_expense_next_at: null };
    }
    const contar = r.estado === 'rechazado' && r.porTope ? Number(v.kepler_expense_attempts ?? 0) : intentos;
    // Sólo sobre el vale que SIGUE reclamado (o en duda) y sin folio: un escritor que regresó tarde no se pisa.
    const devolver = [...COLUMNAS_DEL_VALE];
    const [fila] = await trx('finance.expense_proofs').where({ id }).whereIn('kepler_expense_status', ['writing', 'in_doubt']).whereNull('kepler_expense_folio')
      .update({ ...cambio, kepler_expense_attempts: contar, kepler_expense_at: ahora, updated_at: ahora })
      .returning(devolver);
    await this.bitacora(trx, id, disparo, v, r, entrega, actor);
    if (!fila) {
      const actual = await trx('finance.expense_proofs').where({ id }).first(devolver);
      const aviso = `⚠ Kepler respondió «${r.estado}»${'folio' in r ? ` (folio ${r.folio})` : ''}, pero el vale ya no estaba esperando esa respuesta (estado ${actual?.kepler_expense_status ?? '?'}, folio ${actual?.kepler_expense_folio ?? 'sin folio'}): revisarlo a mano`;
      this.logger.error(`vale ${id}: ${aviso}`);
      await trx('finance.expense_proofs').where({ id }).update({ kepler_expense_note: aviso, updated_at: ahora });
      return this.estadoDe({ ...(actual as ValeParaGasto), kepler_expense_note: aviso });
    }
    const nivel = r.estado === 'escrito' || r.estado === 'ya_estaba' ? 'log' : 'warn';
    this.logger[nivel](`vale ${id} → gasto en Kepler ${v.sucursal}/${v.folio_solicitud}: ${r.estado}${'folio' in r ? ` ${r.folio}` : ''}${'motivo' in r ? ` — ${r.motivo}` : ''}`);
    return this.estadoDe({ ...(fila as ValeParaGasto), kepler_expense_date: (cambio['kepler_expense_date'] as string | undefined) ?? v.kepler_expense_date });
  }

  private async bitacora(trx: Trx, id: string, disparo: DisparoDelGasto, v: ValeParaGasto, r: ResultadoEscrituraGasto, entrega: EntregaGastoKepler | null, actor: string | null): Promise<void> {
    const plan = entrega ? JSON.stringify(entrega) : null;
    await trx('finance.expense_request_kepler_attempts').insert({
      tenant_id: trx.raw('public.current_tenant_id()'), proof_id: id, document_type: 10, trigger: disparo, server: String(v.sucursal ?? ''),
      // El gasto no lleva marca propia (copia la de su solicitud, anexo §3.1): se anota la solicitud que comprueba.
      mark: `X-A-15/${String(v.folio_solicitud ?? '').padStart(7, '0')}`,
      result: r.estado, folio: 'folio' in r ? r.folio : null, retryable: r.estado === 'rechazado' ? r.reintentable : null,
      note: 'motivo' in r ? r.motivo : null, plan, plan_hash: plan ? createHash('sha256').update(plan).digest('hex') : null, created_by: actor,
    });
  }

  // ── El cron: reintentos, huérfanos y el lazo con el ODS ───────────────────────────────────────────────────────────

  /**
   * Costura para la prueba de punta a punta: acota los vales que el cron intenta a los que ella sembró (la base de
   * prueba local trae vales reales copiados que no son suyos). En producción no filtra nada.
   */
  protected filtrarCandidatos(_qb: Knex.QueryBuilder): void {
    return undefined;
  }

  @Cron('45 */5 * * * *', { timeZone: 'America/Mexico_City' })
  async programado(): Promise<void> {
    if (process.env.DISABLE_CRONS === 'true' || process.env.ENABLE_COMPROBACION_KEPLER_CRON === 'false') return;
    if (this.corriendo) { this.logger.warn('Skip: ciclo de gastos a Kepler en curso'); return; }
    await this.ciclo().catch((e) => this.logger.error(`ciclo de gastos a Kepler: ${e?.message ?? e}`));
  }

  /** Una pasada. Pública para la prueba. Devuelve qué hizo, para el latido y para medir. */
  async ciclo(limite = 20): Promise<{ huerfanos: number; intentados: number; vistos_en_ods: number; cancelados: number; sin_ver_30min: number; en_duda: number; dudas_resueltas: number }> {
    this.corriendo = true;
    const t0 = Date.now();
    const m = { huerfanos: 0, intentados: 0, vistos_en_ods: 0, cancelados: 0, sin_ver_30min: 0, en_duda: 0, dudas_resueltas: 0 };
    const fallas: string[] = [];
    // El cron no tiene petición: el tenant se fija a mano (RLS FORZADO en expense_proofs).
    const run: Ejecutor = (fn) => this.tk.run(MEGA, fn);
    try {
      const hay = await run(async (trx) => trx.schema.withSchema('finance').hasColumn('expense_proofs', 'kepler_expense_status'));
      if (!hay) return m;
      m.huerfanos = Number(await run(async (trx) => trx('finance.expense_proofs')
        .where({ tenant_id: MEGA, kepler_expense_status: 'writing' })
        .whereRaw(`kepler_expense_at < now() - make_interval(mins => ?)`, [WRITING_HUERFANO_MIN])
        .update({ kepler_expense_status: 'in_doubt', kepler_expense_note: 'El intento anterior no terminó: se busca el gasto en Kepler antes de reintentar', updated_at: trx.fn.now() })));
      // Sólo las sucursales ABIERTAS (interruptor, bandera, URL y DG7): lo de una sucursal apagada espera sin ocupar el cupo.
      const encendidas = new Set(await run(async (trx) => trx.transaction(async (sp) => sp('commercial.kepler_push_switch')
        .where({ tipo: TIPO_INTERRUPTOR, encendida: true }).pluck('sucursal')).catch(() => [] as string[])));
      const abiertas = SUCURSALES.filter((s) => encendidas.has(s) && this.sink?.encendida() && urlDeServidor(s, process.env).ok && SERVIDORES_POLIZA_MENSUAL.has(s));
      // Los que toca: validados, con su X-A-15, sin gasto, en espera vencida o en duda, y cuya X-A-15 sigue en A en el
      // ODS (sin esto, los miles de vales viejos ya comprobados se revisarían cada 5 minutos). El que más espera, primero.
      const ids: string[] = !abiertas.length ? [] : await run(async (trx) => (await trx('finance.expense_proofs as p')
        .where({ 'p.tenant_id': MEGA, 'p.status': 'validada' }).whereNotNull('p.folio_solicitud').whereNull('p.kepler_expense_folio').whereIn('p.sucursal', abiertas)
        .where((q) => q.whereNull('p.kepler_expense_status').orWhereIn('p.kepler_expense_status', ['pending', 'retry', 'in_doubt']))
        .where((y) => y.whereNull('p.kepler_expense_next_at').orWhere('p.kepler_expense_next_at', '<=', trx.fn.now()))
        .modify((qb) => this.filtrarCandidatos(qb))
        // «En duda» entra aunque su X-A-15 ya no esté en A: si el COMMIT llegó, Kepler la dejó en F (revisión independiente).
        .where((w) => w.where('p.kepler_expense_status', 'in_doubt').orWhereExists(function () {
          this.select(trx.raw('1')).from('kepler_ods.kdm1 as s')
            .whereRaw(`s.sucursal = p.sucursal AND s.c2 = 'X' AND s.c3 = 'A' AND s.c4 = 15 AND s.c5 = 1 AND btrim(s.c43) = 'A'
                       AND lpad(btrim(s.c6), 7, '0') = lpad(btrim(p.folio_solicitud), 7, '0')`);
        }))
        .orderByRaw('coalesce(p.kepler_expense_next_at, p.validated_at, p.updated_at)').limit(limite).select('p.id')).map((x: { id: string }) => x.id));
      for (const id of ids) {
        try {
          await this.intentar(run, id, 'cron', null);
          m.intentados++;
        } catch (e) { fallas.push(`${id}: ${(e as Error).message}`); }
      }
      // El lazo cerrado: lo escrito aparece en el ODS; lo que Kepler canceló, se dice.
      const lazo = await run(async (trx) => {
        // El gasto se reconoce por su folio Y por la solicitud que comprueba (`c39`): un folio solo podría ser otro
        // documento (la prueba lo encontró con la réplica de otra base; en Kepler el folio es único por sucursal).
        const ESTE_GASTO = `g.sucursal = p.sucursal AND g.c2 = 'X' AND g.c3 = 'A' AND g.c4 = 10 AND g.c5 = 1
              AND lpad(btrim(g.c6), 7, '0') = p.kepler_expense_folio AND lpad(btrim(g.c39), 7, '0') = lpad(btrim(p.folio_solicitud), 7, '0')`;
        // «En duda» que el ODS ya resuelve: su solicitud tiene un gasto VIVO, así que quedó (lo escribiera la Suite o una
        // persona) y no se escribe otro. En TODAS las sucursales: no habla con Kepler, sirve aunque la base esté cerrada.
        const VIVO_DE_SU_SOLICITUD = `g.sucursal = p.sucursal AND g.c2 = 'X' AND g.c3 = 'A' AND g.c4 = 10 AND g.c5 = 1 AND btrim(g.c43) <> 'C'
              AND lpad(btrim(g.c39), 7, '0') = lpad(btrim(p.folio_solicitud), 7, '0')`;
        const dudas = await trx.raw(
          `UPDATE finance.expense_proofs p
              SET kepler_expense_status = 'seen_in_ods', kepler_expense_next_at = NULL, kepler_expense_at = now(), updated_at = now(),
                  kepler_expense_folio = (SELECT lpad(btrim(g.c6), 7, '0') FROM kepler_ods.kdm1 g WHERE ${VIVO_DE_SU_SOLICITUD} ORDER BY g.c6 LIMIT 1),
                  kepler_expense_note = 'Estaba en duda y el ODS ya ve su gasto: quedó en Kepler, no se escribe otro'
            WHERE p.tenant_id = ? AND p.kepler_expense_status = 'in_doubt' AND p.kepler_expense_folio IS NULL
              AND EXISTS (SELECT 1 FROM kepler_ods.kdm1 g WHERE ${VIVO_DE_SU_SOLICITUD})`, [MEGA]);
        const vistos = await trx.raw(
          `UPDATE finance.expense_proofs p SET kepler_expense_status = 'seen_in_ods', updated_at = now()
             FROM kepler_ods.kdm1 g
            WHERE p.tenant_id = ? AND p.kepler_expense_status = 'written' AND ${ESTE_GASTO} AND btrim(g.c43) <> 'C'`, [MEGA]);
        // Cancelado SUELTA el folio y la póliza (quedan en la nota): con el folio puesto nada lo podía volver a reclamar y
        // «Reintentar» no hacía nada (revisión independiente, 2026-11-17). En el SET, `p.*` es la fila de antes.
        const cancelados = await trx.raw(
          `UPDATE finance.expense_proofs p
              SET kepler_expense_status = 'cancelled', updated_at = now(),
                  kepler_expense_note = 'Kepler canceló el gasto X-A-10 ' || p.kepler_expense_folio
                    || coalesce(' (póliza ' || p.kepler_expense_policy || ')', '')
                    || ': el vale vuelve a esperar su gasto; la Suite no lo reescribe sola («Reintentar el gasto»)',
                  kepler_expense_folio = NULL, kepler_expense_policy = NULL, kepler_expense_date = NULL, kepler_expense_next_at = NULL
             FROM kepler_ods.kdm1 g
            WHERE p.tenant_id = ? AND p.kepler_expense_status IN ('written', 'seen_in_ods') AND ${ESTE_GASTO} AND btrim(g.c43) = 'C'`, [MEGA]);
        const sinVer = (await trx('finance.expense_proofs').where({ tenant_id: MEGA, kepler_expense_status: 'written' })
          .whereRaw(`kepler_expense_at < now() - interval '30 minutes'`).count<{ n: string }[]>({ n: '*' }))[0]?.n;
        const enDuda = (await trx('finance.expense_proofs').where({ tenant_id: MEGA, kepler_expense_status: 'in_doubt' }).count<{ n: string }[]>({ n: '*' }))[0]?.n;
        return { vistos: Number(vistos.rowCount ?? 0), cancelados: Number(cancelados.rowCount ?? 0), sinVer: Number(sinVer ?? 0),
          dudas: Number(dudas.rowCount ?? 0), enDuda: Number(enDuda ?? 0) };
      });
      m.vistos_en_ods = lazo.vistos;
      m.cancelados = lazo.cancelados;
      m.sin_ver_30min = lazo.sinVer;
      m.dudas_resueltas = lazo.dudas;
      m.en_duda = lazo.enDuda;
      if (m.sin_ver_30min) fallas.push(`${m.sin_ver_30min} gasto(s) escritos en Kepler hace más de 30 min no aparecen en el ODS: revisar la ingesta o la escritura`);
      if (m.en_duda) fallas.push(`${m.en_duda} gasto(s) siguen EN DUDA: no se reintentan hasta saber si quedaron escritos en Kepler`);
    } catch (e) {
      fallas.push((e as Error).message);
    } finally {
      this.corriendo = false;
      await latirCron(this.knex, {
        jobKey: 'gastos_comprobacion_kepler', label: 'Gastos: comprobación (X-A-10) de la Suite a Kepler', tenantId: MEGA,
        durationMs: Date.now() - t0, rowsAffected: m.intentados + m.vistos_en_ods + m.cancelados + m.huerfanos + m.dudas_resueltas, fallas,
        note: `${m.intentados} intentados · ${m.vistos_en_ods} vistos en el ODS · ${m.cancelados} cancelados en Kepler · ${m.huerfanos} huérfanos · ${m.sin_ver_30min} sin ver tras 30 min · ${m.dudas_resueltas} dudas resueltas por el ODS · ${m.en_duda} en duda`,
        ceroEsOk: 'sin vales validados esperando su gasto en una sucursal abierta: la escritura sigue apagada o ya se comprobó todo',
      }).catch(() => undefined);
    }
    return m;
  }
}
