import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import {
  KNEX_NEW_DB, LlmExtractorService, ObjectStorageService, ScopeService, TenantContextService, TenantKnexService, applySmartSearch, latirCron,
  todayMx, urlDeServidor,
} from '@megadulces/platform-core';
import {
  alcanceDelAcreedor, avisoDeFechas, basesDeQuienPide, comentarioDeLaSolicitud, conceptoDistintoDeCedis, correoValido, cuentaDePago, cuentaFueraDeAlcance, detallesDePago,
  exigeDetalle, faltaParaPedir, fechaReal, formaPago, hayInformacionDePago, PLAZO_MAXIMO_DIAS, quedaDebiendoComprobante, rfcCompatible,
  totalesDeLaSolicitud, unirDetallesDePago, type AlmacenesDeQuienPide, type InformacionDePago,
  type AcreedorDeGasto, type CatalogoDeLaSolicitud, type ConceptoDeGasto, type CrearSolicitudGastoDto,
  type DisponibilidadDeLaSolicitud, type DuplicadoProbable, type EstadoKeplerDeLaSolicitud, type LecturaDelComprobante,
  type PrecargaDeLaSolicitud, type SolicitudGastoCreada, type DetalleDeLaSolicitud, type SucursalesAbiertasDeLaSolicitud,
} from '@megadulces/contracts';

import { ExpenseProofsGateway } from '../expense-proofs.gateway';
import {
  escrituraDeSolicitudEncendida, KeplerSolicitudGastoSinkAdapter, plantillaSolicitudDe,
  type EntregaSolicitudKepler, type ResultadoEscrituraSolicitud,
} from './kepler-solicitud-gasto-sink.adapter';
import { marcaDeLaSolicitud } from './solicitud-kepler.armador';
import { SOLICITUD_CANCELADA_DESDE_LA_SUITE, SOLICITUD_CANCELAR_MOTIVO_MIN } from './solicitud-kepler.cancelacion';

/**
 * `[PGP.122.8]`–`[PGP.122.12]` C2 — **La solicitud de gasto nace en la Suite, y al firmarla se escribe en
 * Kepler.** Plan: `docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md` §5–§8.
 *
 * El vale y la solicitud son el MISMO acto (ADR-056: no se inventa otra tabla): la solicitud nace como un
 * `finance.expense_proofs` de `origen = 'solicitud'`, SIN folio de Kepler, con sus renglones en
 * `finance.expense_proof_lines`. Aprobación, Mis gastos, Expediente y el cierre GX.85 ya lo leen. La firma
 * (`ExpenseProofsService.approve`) llama a `escribirAlFirmar` y Kepler recibe la X-A-15 ya autorizada (DS2):
 * lo rechazado o abandonado nunca llega a Kepler.
 *
 * ── Los pasos de la escritura, en transacciones SEPARADAS a propósito ────────────────────────
 *   1. el RECLAMO atómico (`pending|retry → writing`) se confirma ANTES de hablar con Kepler: dos firmas a
 *      la vez o el cron no escriben dos veces;
 *   2. Kepler (el escritor busca su marca antes de escribir: si ya está, devuelve ese folio);
 *   3. el resultado y su renglón en la bitácora `expense_request_kepler_attempts`.
 * Si el proceso muere entre 1 y 3, el vale queda en `writing`: el cron lo pasa a `in_doubt` a los 10 min y
 * pregunta a Kepler por la marca antes de cualquier reintento.
 *
 * Lo que valida contra Kepler al CAPTURAR lo lee del ODS (`kepler_ods`, casi en vivo); el escritor vuelve a
 * validar contra el Kepler VIVO al escribir. Las dos cosas a propósito: el ODS da la respuesta inmediata en la
 * pantalla; el vivo es el que manda.
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const TIPO_INTERRUPTOR = 'solicitud_gasto';
/** Minutos de espera entre reintentos; tras el último, `stuck` (lo reintenta una persona). */
export const ESPERAS_MIN = [5, 15, 60, 60, 60, 60] as const;
/** Un `writing` más viejo que esto ya no está escribiendo: el proceso murió. Se pregunta por la marca. */
const WRITING_HUERFANO_MIN = 10;
const SUC = /^\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Los 9 servidores de Kepler (sucursal = servidor). */
const SUCURSALES: readonly string[] = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
/** Los estados de un vale ya FIRMADO: la escritura cuelga de la firma, no del estado de la evidencia. */
const FIRMADAS: readonly string[] = ['aprobada', 'validada', 'revision'];

type Trx = Knex | Knex.Transaction;

/** `HH:MM` en México, para `c69`. */
function horaMx(d = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
}

/** Fila del vale que hace falta para escribirlo en Kepler. */
interface ValeParaKepler {
  id: string; status: string; origen: string; sucursal: string | null; folio_solicitud: string | null;
  creditor_code: string | null; vat_amount: string | number | null; document_type: string | null; document_folio: string | null;
  document_date: string | null; cfdi_uuid: string | null; requested_on: string | null; needed_by: string | null;
  comentarios: string | null; forma_pago: string | null; created_by: string | null;
  /** `solicita_usuario`: el username de quien pidió, para `c48`. */
  capture_meta: { solicita_usuario?: string | null } | string | null;
  kepler_request_status: string | null; kepler_request_mark: string | null; kepler_request_attempts: number | null;
  kepler_request_note: string | null; kepler_request_next_at: string | Date | null;
}

type Disparo = 'firma' | 'cron' | 'reintento';

/** El username para `c48` («Solicita»): el que se guardó al pedir; si no, el nombre del vale. */
function usuarioQueSolicita(v: Pick<ValeParaKepler, 'capture_meta' | 'created_by'>): string {
  let meta: { solicita_usuario?: string | null } | null = null;
  try { meta = typeof v.capture_meta === 'string' ? JSON.parse(v.capture_meta) : v.capture_meta; } catch { meta = null; }
  return String(meta?.solicita_usuario ?? '').trim() || String(v.created_by ?? '').trim();
}
/**
 * Una lectura OPCIONAL dentro de una transacción, en su propio SAVEPOINT: si falla, la transacción sigue viva.
 * Un `.catch` pelado no basta: el error ya abortó la transacción, lo que sigue muere con 25P02 y el COMMIT se
 * vuelve rollback en silencio (GOTCHAS §2).
 */
function opcional<T>(trx: Knex.Transaction, fn: (sp: Knex.Transaction) => Promise<T>, siFalla: T): Promise<T> {
  return trx.transaction(fn).catch(() => siFalla);
}
/** Lo que hace falta de un vale para decir cómo va su escritura. */
type FilaEstadoKepler = Pick<ValeParaKepler, 'folio_solicitud' | 'kepler_request_status' | 'kepler_request_note' | 'kepler_request_attempts' | 'kepler_request_next_at'> & { id: string };
/** Ejecuta en una transacción con el tenant puesto (el de la petición, o el de mega_dulces en el cron). */
type Ejecutor = <T>(fn: (trx: Knex.Transaction) => Promise<T>) => Promise<T>;
/** Lo que hizo una pasada del cron: el latido y la prueba lo leen. */
export interface ResultadoDelCiclo {
  /** `writing` de más de 10 min pasados a `in_doubt`. */
  huerfanos: number; intentados: number; vistos_en_ods: number; sin_ver_30min: number; en_duda: number;
  /** R1: vales que en esta pasada se enteraron de que su solicitud se canceló en Kepler. */
  canceladas_en_kepler: number;
  /** R1: cuántos vales con la solicitud cancelada en Kepler siguen firmados (la alarma suena mientras haya). */
  canceladas_firmadas: number;
  /** R1: X-A-15 con la marca de la Suite que ningún vale reclama (tope de 20). */
  sin_vale_en_kepler: number;
  /** R1: sucursales abiertas con el contador de folios atrasado. */
  contadores_atrasados: string[];
}

/**
 * Lo que hizo una pasada del lazo de después de escribir (R1). La corren el aviso del ODS (`SolicitudPorEventoService`,
 * sin reloj) y el ciclo de 5 min, que queda de ÁRBITRO: lo que el ciclo todavía encuentra es lo que el aviso no vio.
 */
export interface ResultadoDelLazo {
  /** `written → seen_in_ods` en esta pasada. */
  vistos_en_ods: number;
  /** Escritas hace más de 30 min que no aparecen en el ODS. */
  sin_ver_30min: number;
  /** Vales que en esta pasada se enteraron de que su solicitud se canceló en Kepler. */
  canceladas_en_kepler: number;
  /** Vales con la solicitud cancelada en Kepler que siguen firmados. */
  canceladas_firmadas: number;
  /** X-A-15 con la marca de la Suite que ningún vale reclama (tope de 20). */
  huerfanas: Array<{ sucursal: string; folio: string; marca: string }>;
}

@Injectable()
export class SolicitudGastoService {
  private readonly logger = new Logger(SolicitudGastoService.name);
  private corriendo = false;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    /**
     * S.17 (DS27): en qué bases puede pedir quien pide (ADR-050, área `finanzas`, la misma que la bandeja del SAT).
     * Obligatorio: sin él no hay a quién preguntarle, y abrir todas sería pedir de más.
     */
    private readonly scope: ScopeService,
    /** `@Optional` y al final: sin el escritor la solicitud se guarda igual y Kepler no se toca — nunca al revés. */
    @Optional() private readonly sink?: KeplerSolicitudGastoSinkAdapter,
    @Optional() private readonly gateway?: ExpenseProofsGateway,
    /** El lector de comprobantes (GX.33) y el almacén de archivos: proponen la captura; sin ellos, se teclea. */
    @Optional() private readonly ocr?: LlmExtractorService,
    @Optional() private readonly storage?: ObjectStorageService,
  ) {}

  // ── Lectura para la pantalla (ODS) ──────────────────────────────────────────────────────────

  /** Conceptos (con su cuenta y si entran), proyectos y departamentos del catálogo de ESE servidor. */
  async catalogo(sucursal: string): Promise<CatalogoDeLaSolicitud> {
    const s = await this.base(sucursal);
    return this.tk.run(async (trx) => {
      const conceptos = (await trx.raw(
        `SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS codigo, btrim(c2) AS nombre, btrim(c3) AS cuenta
           FROM kepler_ods.kdco WHERE sucursal = ? AND btrim(c3) <> '' ORDER BY btrim(c1), c2`, [s])).rows as Array<{ codigo: string; nombre: string; cuenta: string }>;
      const proyectos = (await trx.raw(`SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS codigo, btrim(c2) AS nombre FROM kepler_ods.kdcp WHERE sucursal = ? ORDER BY btrim(c1)`, [s])).rows;
      const departamentos = (await trx.raw(`SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS codigo, btrim(c2) AS nombre FROM kepler_ods.kdc3 WHERE sucursal = ? ORDER BY btrim(c1)`, [s])).rows;
      const cedis = await this.cuentasDeCedis(trx, s);
      return {
        sucursal: s,
        conceptos: conceptos.map((c): ConceptoDeGasto => ({
          ...c, fuera_de_alcance: cuentaFueraDeAlcance(c.cuenta), distinto_de_cedis: conceptoDistintoDeCedis(c, cedis.get(c.codigo), s),
        })),
        proyectos, departamentos,
      };
    });
  }

  /**
   * R14 (anexo S §16): la cuenta de cada concepto en el catálogo de CEDIS (00), para compararla con la del servidor
   * (`conceptoDistintoDeCedis`). En 00 no hay contra qué comparar: mapa vacío. Opcionalmente, sólo esos códigos.
   */
  private async cuentasDeCedis(trx: Trx, sucursal: string, codigos?: string[]): Promise<Map<string, { nombre: string; cuenta: string }>> {
    if (sucursal === '00' || (codigos && !codigos.length)) return new Map();
    const filas = (await trx.raw(
      `SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS codigo, btrim(c2) AS nombre, btrim(c3) AS cuenta FROM kepler_ods.kdco
        WHERE sucursal = '00' AND btrim(c3) <> '' ${codigos ? 'AND btrim(c1) = ANY(?::text[])' : ''} ORDER BY btrim(c1), c2`,
      codigos ? [codigos] : [])).rows as Array<{ codigo: string; nombre: string; cuenta: string }>;
    return new Map(filas.map((f) => [f.codigo, { nombre: f.nombre, cuenta: f.cuenta }]));
  }

  /** Acreedores de gasto del alcance v1 (DS3) en ESE servidor, los frecuentes primero, con el buscador compartido. */
  async buscarAcreedores(sucursal: string, texto?: string, limite = 20): Promise<AcreedorDeGasto[]> {
    const s = await this.base(sucursal);
    const lim = Math.min(50, Math.max(1, Number(limite) || 20));
    return this.tk.run(async (trx) => {
      const usos = trx('kepler_ods.kdm1')
        .where({ sucursal: s }).whereRaw(`c1 = sucursal AND c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1 AND c43 <> 'C' AND c68 >= now() - interval '180 days'`)
        .groupByRaw('btrim(c10)').select(trx.raw('btrim(c10) AS clave'), trx.raw('count(*)::int AS usos')).as('u');
      const qb = trx('kepler_ods.kdxd as d')
        .leftJoin(usos, 'u.clave', trx.raw('btrim(d.c2)'))
        .where('d.sucursal', s)
        .whereRaw(`btrim(d.c2) ~ '^G' AND btrim(d.c2) !~ '^GB' AND btrim(d.c2) <> 'GN001'`)
        .select(trx.raw('btrim(d.c2) AS clave'), trx.raw('max(btrim(d.c3)) AS nombre'), trx.raw(`max(nullif(btrim(d.c10), '')) AS rfc`), trx.raw('coalesce(max(u.usos), 0)::int AS usos'))
        .groupByRaw('btrim(d.c2)')
        .orderByRaw('coalesce(max(u.usos), 0) DESC, max(btrim(d.c3))')
        .limit(lim);
      applySmartSearch(qb, texto, { columns: ['d.c2', 'd.c3', 'd.c10'] });
      return (await qb) as AcreedorDeGasto[];
    });
  }

  /** «Como la última vez»: los conceptos más usados con ese acreedor, su último proyecto y depto, y su forma de pago. */
  async precarga(sucursal: string, acreedor: string): Promise<PrecargaDeLaSolicitud> {
    const s = await this.base(sucursal);
    const a = String(acreedor ?? '').trim().toUpperCase();
    const alcance = alcanceDelAcreedor(a);
    return this.tk.run(async (trx) => {
      const d = (await trx.raw(
        `SELECT btrim(c2) AS clave, btrim(c3) AS nombre, nullif(btrim(c10), '') AS rfc, nullif(btrim(c11), '') AS correo, c16::text AS dias
           FROM kepler_ods.kdxd WHERE sucursal = ? AND btrim(c2) = ? ORDER BY c1 LIMIT 1`, [s, a])).rows[0];
      if (!d) return { acreedor: null, alcance, conceptos: [], ultimo: null, forma_pago: null, plazo: null, pago: null };
      const renglones = `FROM kepler_ods.kdm6 l
          JOIN kepler_ods.kdm1 h ON h.sucursal = l.sucursal AND h.c1 = l.c1 AND h.c2 = l.c2 AND h.c3 = l.c3 AND h.c4 = l.c4 AND h.c5 = l.c5 AND h.c6 = l.c6
         WHERE l.sucursal = ? AND l.c1 = l.sucursal AND l.c2 = 'X' AND l.c3 = 'A' AND l.c4 = 15 AND l.c5 = 1
           AND h.c43 <> 'C' AND btrim(h.c10) = ? AND h.c68 >= now() - interval '180 days'`;
      const top = (await trx.raw(
        `SELECT btrim(l.c12) AS codigo, count(*)::int AS usos ${renglones} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 3`, [s, a])).rows as Array<{ codigo: string; usos: number }>;
      const cat = top.length ? (await trx.raw(
        `SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS codigo, btrim(c2) AS nombre, btrim(c3) AS cuenta FROM kepler_ods.kdco
          WHERE sucursal = ? AND btrim(c1) = ANY(?::text[]) ORDER BY btrim(c1), c2`, [s, top.map((t) => t.codigo)])).rows as Array<{ codigo: string; nombre: string; cuenta: string }> : [];
      const porCodigo = new Map(cat.map((c) => [c.codigo, c]));
      const cedis = await this.cuentasDeCedis(trx, s, top.map((t) => t.codigo));
      const ultimo = (await trx.raw(
        `SELECT btrim(l.c12) AS concepto, btrim(l.c13) AS proyecto, btrim(l.c16) AS departamento, to_char(h.c68, 'YYYY-MM-DD') AS fecha
          ${renglones} ORDER BY h.c68 DESC, h.c69 DESC, h.c6 DESC, l.c7 LIMIT 1`, [s, a])).rows[0] ?? null;
      // La forma de pago: la del último vale a ese acreedor en la sucursal (la Suite la tiene en el 100 %).
      // Sin la migración no hay `creditor_code`: sólo la mitad que liga por folio. Con guarda y no con `.catch`:
      // un error tragado DENTRO de la transacción la aborta y el COMMIT se vuelve rollback (GOTCHAS §2).
      const conClave = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'creditor_code');
      const porClave = conClave
        ? `SELECT p.forma_pago, p.created_at FROM finance.expense_proofs p
            WHERE p.sucursal = ? AND p.creditor_code = ? AND p.forma_pago IS NOT NULL AND p.status <> 'rechazada'
           UNION ALL`
        : '';
      const fp = (await trx.raw(
        `SELECT forma_pago FROM (
           ${porClave}
           SELECT p.forma_pago, p.created_at FROM finance.expense_proofs p
             JOIN kepler_ods.kdm1 k ON k.sucursal = p.sucursal AND k.c1 = p.sucursal AND btrim(k.c6) = p.folio_solicitud AND k.c2 = 'X' AND k.c3 = 'A' AND k.c4 = 15 AND k.c5 = 1
            WHERE p.sucursal = ? AND btrim(k.c10) = ? AND p.forma_pago IS NOT NULL AND p.status <> 'rechazada'
         ) x ORDER BY created_at DESC LIMIT 1`, conClave ? [s, a, s, a] : [s, a])).rows[0]?.forma_pago ?? null;
      // S.17 (DS30): el plazo. Primero los días de crédito del catálogo de Kepler (`kdxd.c16`: 12 de 223 lo tienen); si
      // no, el de su última solicitud aquí (fecha de pago − fecha; el 88 % es el mismo día). Sin historia, sin dato.
      let plazo: PrecargaDeLaSolicitud['plazo'] = null;
      const diasKepler = Math.round(Number(d.dias));
      if (Number.isFinite(diasKepler) && diasKepler > 0) plazo = { dias: Math.min(PLAZO_MAXIMO_DIAS, diasKepler), fuente: 'catalogo' };
      else {
        const u = (await trx.raw(
          `SELECT (h.c18::date - h.c9::date) AS d FROM kepler_ods.kdm1 h
            WHERE h.sucursal = ? AND h.c1 = h.sucursal AND h.c2 = 'X' AND h.c3 = 'A' AND h.c4 = 15 AND h.c5 = 1 AND h.c43 <> 'C'
              AND btrim(h.c10) = ? AND h.c68 >= now() - interval '180 days'
            ORDER BY h.c68 DESC, h.c69 DESC, h.c6 DESC LIMIT 1`, [s, a])).rows[0] as { d: number | null } | undefined;
        if (u && u.d != null && Number.isFinite(Number(u.d))) plazo = { dias: Math.max(0, Math.min(PLAZO_MAXIMO_DIAS, Math.round(Number(u.d)))), fuente: 'habito' };
      }
      // S.17 (DS31): la información de pago. La cuenta y el banco, sólo de la última solicitud de la Suite a este acreedor
      // (ningún catálogo tiene la CLABE); el correo, de ahí o del catálogo de Kepler (`kdxd.c11`: 16 de 342 lo tienen).
      const conPago = conClave && await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'payee_account');
      const previa = conPago ? (await trx.raw(
        `SELECT payee_account AS cuenta, payee_bank AS banco, payee_email AS correo FROM finance.expense_proofs
          WHERE sucursal = ? AND creditor_code = ? AND status <> 'rechazada' AND (payee_account IS NOT NULL OR payee_email IS NOT NULL)
          ORDER BY created_at DESC LIMIT 1`, [s, a])).rows[0] as { cuenta: string | null; banco: string | null; correo: string | null } | undefined : undefined;
      const correoKepler = correoValido(d.correo) ? String(d.correo).trim() : null;
      const correo = previa?.correo ?? correoKepler;
      const pago: PrecargaDeLaSolicitud['pago'] = previa?.cuenta || correo ? {
        cuenta: previa?.cuenta ?? null, banco: previa?.cuenta ? previa.banco ?? null : null, correo,
        fuente_cuenta: previa?.cuenta ? 'habito' : null, fuente_correo: previa?.correo ? 'habito' : correoKepler ? 'catalogo' : null,
      } : null;
      return {
        acreedor: { clave: d.clave, nombre: d.nombre, rfc: d.rfc, usos: top.reduce((n, t) => n + t.usos, 0) },
        alcance,
        conceptos: top.filter((t) => porCodigo.has(t.codigo)).map((t) => {
          const c = porCodigo.get(t.codigo)!;
          return { ...c, usos: t.usos, fuera_de_alcance: cuentaFueraDeAlcance(c.cuenta), distinto_de_cedis: conceptoDistintoDeCedis(c, cedis.get(c.codigo), s) };
        }),
        ultimo,
        forma_pago: formaPago(fp) ? fp : null,
        plazo,
        pago,
      };
    });
  }

  /**
   * Mismo acreedor e importe el mismo día, en la Suite y en Kepler (conviven dos puertas). Es un AVISO:
   * con sólo acreedor + importe el ruido medido es del 50 % (395 pares contra 197 de un placebo).
   */
  async duplicados(sucursal: string, acreedor: string, total: number, fecha: string, sinId?: string): Promise<DuplicadoProbable[]> {
    const s = await this.base(sucursal);
    const a = String(acreedor ?? '').trim().toUpperCase();
    if (!(Number(total) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return [];
    return this.tk.run(async (trx) => {
      // Con guarda de columna y no con `.catch`: un error tragado aborta la transacción y la consulta de Kepler
      // de abajo moriría con 25P02 (GOTCHAS §2).
      const conClave = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'creditor_code');
      const enSuite = conClave ? (await trx.raw(
        `SELECT id, folio_solicitud AS folio, to_char(requested_on, 'YYYY-MM-DD') AS fecha, importe::float8 AS total FROM finance.expense_proofs
          WHERE origen = 'solicitud' AND sucursal = ? AND creditor_code = ? AND requested_on = ?::date AND round(importe, 2) = round(?::numeric, 2)
            AND status <> 'rechazada' AND (?::uuid IS NULL OR id <> ?::uuid) LIMIT 5`,
        [s, a, fecha, total, sinId ?? null, sinId ?? null])).rows : [];
      const enKepler = (await trx.raw(
        `SELECT btrim(c6) AS folio, to_char(c9, 'YYYY-MM-DD') AS fecha, c16::float8 AS total FROM kepler_ods.kdm1
          WHERE sucursal = ? AND c1 = sucursal AND c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1 AND c43 <> 'C'
            AND btrim(c10) = ? AND c9::date = ?::date AND round(c16, 2) = round(?::numeric, 2) LIMIT 5`, [s, a, fecha, total])).rows;
      return [
        ...enSuite.map((r: { id: string; folio: string | null; fecha: string; total: number }): DuplicadoProbable => ({ donde: 'suite', id: r.id, folio: r.folio, fecha: r.fecha, total: r.total })),
        ...enKepler.map((r: { folio: string; fecha: string; total: number }): DuplicadoProbable => ({ donde: 'kepler', id: null, folio: r.folio, fecha: r.fecha, total: r.total })),
      ];
    });
  }

  // ── ¿Está abierta la puerta en esta sucursal? ────────────────────────────────────────────────

  /**
   * Abierta sólo si la escritura en Kepler está encendida DE PUNTA A PUNTA para esa sucursal: lo pedido en la
   * Suite que no llega a Kepler deja a Finanzas sin solicitud dónde aplicar el gasto. Se abre servidor por
   * servidor, conforme se enciende (los candados son los del escritor, más la migración).
   */
  async disponibilidad(sucursal: string): Promise<DisponibilidadDeLaSolicitud> {
    return this.puerta(await this.base(sucursal));
  }

  /** La puerta de ESA sucursal, sin preguntar el alcance (lo hacen `disponibilidad`, `abiertas` y `crear`). */
  private async puerta(s: string): Promise<DisponibilidadDeLaSolicitud> {
    const motivos: string[] = [];
    const env = process.env;
    if (!this.sink) motivos.push('El escritor de solicitudes a Kepler no está cargado en este servidor');
    if (!escrituraDeSolicitudEncendida(env)) motivos.push('La escritura de solicitudes a Kepler está apagada (KEPLER_GASTO_SOLICITUD)');
    const url = urlDeServidor(s, env);
    if (!url.ok) motivos.push(url.motivo);
    const pl = plantillaSolicitudDe(s, env);
    if (!pl.ok) motivos.push(pl.motivo);
    await this.tk.run(async (trx) => {
      if (!(await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'kepler_request_status'))) {
        motivos.push('Falta la migración de [PGP.122] en esta base');
        return;
      }
      const sw = await opcional(trx, (sp) => sp('commercial.kepler_push_switch').where({ sucursal: s, tipo: TIPO_INTERRUPTOR })
        .first<{ encendida: boolean } | undefined>('encendida'), undefined);
      if (!sw?.encendida) motivos.push(`El interruptor ${TIPO_INTERRUPTOR} de esta sucursal está apagado`);
    });
    return { sucursal: s, disponible: motivos.length === 0, motivos };
  }

  /**
   * Las bases donde ESTA persona puede pedir hoy: las abiertas (la misma regla que `disponibilidad`) que son suyas
   * (S.17, DS27). La pantalla sólo muestra la pestaña donde hay algo que abrir (sin esto, el día del despliegue todos
   * veían una pestaña cerrada); con una sola base, no pregunta.
   */
  async abiertas(): Promise<SucursalesAbiertasDeLaSolicitud> {
    const a = await this.misAlmacenes();
    // Sólo se pregunta la puerta de las que podrían ser suyas: con «una», es una consulta y no nueve.
    const candidatas = a.modo === 'all' ? SUCURSALES : SUCURSALES.filter((s) => a.valores.includes(s));
    const abiertas = await Promise.all(candidatas.map(async (s) => ((await this.puerta(s)).disponible ? s : null)));
    const r = basesDeQuienPide(abiertas.filter((s): s is string => !!s), a);
    return { sucursales: r.bases, alcance: r.alcance };
  }

  /** Lo que se escribirá en Kepler al firmarla (o lo que se escribió): para que quien firma lo vea ANTES de firmar. */
  async detalle(id: string): Promise<DetalleDeLaSolicitud> {
    const limpio = String(id ?? '').trim().toLowerCase();
    if (!UUID.test(limpio)) throw new BadRequestException('Identificador de solicitud inválido');
    return this.tk.run(async (trx) => {
      if (!(await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'kepler_request_status'))) throw new NotFoundException('La solicitud de gasto en la Suite todavía no está habilitada en esta base');
      const conPago = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'payee_account');
      const v = await trx('finance.expense_proofs').where({ id: limpio, origen: 'solicitud' }).first(
        'id', 'sucursal', 'creditor_code', 'proveedor', 'document_type', 'document_folio', 'cfdi_uuid',
        trx.raw(`to_char(document_date, 'YYYY-MM-DD') AS document_date`), trx.raw(`to_char(requested_on, 'YYYY-MM-DD') AS requested_on`),
        trx.raw(`to_char(needed_by, 'YYYY-MM-DD') AS needed_by`), trx.raw('vat_amount::float8 AS iva'), trx.raw('importe::float8 AS total'),
        ...(conPago ? ['payee_account', 'payee_bank', 'payee_email'] : []));
      if (!v) throw new NotFoundException('No es una solicitud nacida en la Suite');
      const lineas = await trx('finance.expense_proof_lines').where({ proof_id: limpio }).orderBy('line_no').select(
        'line_no', 'concept_code', 'concept_name', 'account', 'project_code', 'department_code', trx.raw('amount::float8 AS amount'));
      return {
        id: String(v.id), sucursal: String(v.sucursal), acreedor: { clave: String(v.creditor_code ?? ''), nombre: v.proveedor ?? null },
        renglones: (lineas as Array<Record<string, unknown>>).map((l) => ({
          linea: Number(l['line_no']), concepto: String(l['concept_code']), nombre: (l['concept_name'] as string | null) ?? null,
          cuenta: (l['account'] as string | null) ?? null, proyecto: String(l['project_code']), departamento: String(l['department_code']), importe: Number(l['amount']),
        })),
        iva: Number(v.iva ?? 0), total: Number(v.total ?? 0),
        documento: { tipo: v.document_type ?? null, folio: v.document_folio ?? null, fecha: v.document_date ?? null, uuid: v.cfdi_uuid ?? null },
        fecha_solicitud: v.requested_on ?? null,
        necesita_para: v.needed_by ?? null,
        pago: v.payee_account || v.payee_bank || v.payee_email
          ? { cuenta: v.payee_account ?? null, banco: v.payee_bank ?? null, correo: v.payee_email ?? null } : null,
      };
    });
  }

  // ── La Suite llena: lo que sale de la foto del comprobante ───────────────────────────────────

  /**
   * Lee el comprobante ya subido y, con lo leído, busca al acreedor (por RFC, en el catálogo de esa sucursal) y la
   * factura recibida en el SAT (RFC + total ±$1 + fecha ±5 días). Todo PROPONE: la persona confirma (contrato de
   * GX.32/GX.33). Medido: el lector sacó un importe en 292 de 406 vales con comprobante (72 %) en noviembre.
   */
  async leerComprobante(sucursal: string, archivo: { public_id?: string | null; url?: string | null; kind?: string | null }): Promise<LecturaDelComprobante> {
    const s = await this.base(sucursal);
    const vacio = (motivo: string): LecturaDelComprobante => ({ legible: false, motivo, leido: null, acreedor: null, cfdi: null });
    if (!this.ocr || !this.storage) return vacio('El lector de comprobantes no está disponible en este servidor');
    if (archivo?.kind && archivo.kind !== 'image' && archivo.kind !== 'pdf') return vacio('Sólo se leen imágenes y PDF');
    const llave = String(archivo?.public_id || archivo?.url || '').trim();
    if (!llave) return vacio('Falta el archivo');
    const dataUri = await this.storage.getDataUri(llave).catch(() => null);
    if (!dataUri) return vacio('No se pudo abrir el archivo');
    const tipo = (/^data:([^;,]+)[;,]/.exec(dataUri)?.[1] ?? 'image/jpeg').toLowerCase();
    const f = await this.ocr.extractExpenseReceipt(dataUri.replace(/^data:[^,]*,/, ''), tipo as 'image/jpeg');
    if (!f.legible) return vacio('No se pudo leer el comprobante: captúralo a mano');
    const rfc = String(f.rfc ?? '').trim().toUpperCase();
    const leido = { total: f.total, subtotal: f.subtotal, iva: f.iva, fecha: f.fecha, folio: f.folio, rfc: rfc || null, comercio: f.comercio };
    return this.tk.run(async (trx) => {
      let acreedor: AcreedorDeGasto | null = null;
      if (rfc) {
        const filas = (await trx.raw(
          `SELECT btrim(c2) AS clave, max(btrim(c3)) AS nombre, max(nullif(btrim(c10), '')) AS rfc, 0 AS usos FROM kepler_ods.kdxd
            WHERE sucursal = ? AND upper(btrim(c10)) = ? AND btrim(c2) ~ '^G' AND btrim(c2) !~ '^GB' AND btrim(c2) <> 'GN001'
            GROUP BY btrim(c2) LIMIT 2`, [s, rfc])).rows as AcreedorDeGasto[];
        if (filas.length === 1) acreedor = filas[0];
      }
      let cfdi: LecturaDelComprobante['cfdi'] = null;
      if (rfc && Number(f.total) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(f.fecha ?? ''))) {
        const c = await opcional(trx, async (sp) => (await sp.raw(
          `SELECT uuid, nullif(concat_ws('-', nullif(btrim(serie), ''), nullif(btrim(folio), '')), '') AS folio, to_char(fecha, 'YYYY-MM-DD') AS fecha,
                  subtotal::float8 AS subtotal, coalesce(descuento, 0)::float8 AS descuento, coalesce(total_trasladados, 0)::float8 AS iva,
                  coalesce(total_retenidos, 0)::float8 AS retenidos, total::float8 AS total
             FROM fiscal.cfdis
            WHERE rol = 'recibidas' AND tipo_comprobante = 'I' AND upper(emisor_rfc) = ? AND abs(total - ?) <= 1
              AND fecha::date BETWEEN ?::date - 5 AND ?::date + 5 AND coalesce(estatus_sat, '') NOT ILIKE 'cancel%'
            LIMIT 2`, [rfc, Number(f.total), f.fecha, f.fecha])).rows as Array<NonNullable<LecturaDelComprobante['cfdi']>>, []);
        if (c.length === 1) cfdi = c[0];
      }
      return { legible: true, motivo: null, leido, acreedor, cfdi };
    });
  }

  // ── Pedir / registrar ────────────────────────────────────────────────────────────────────────

  /**
   * `quien.nombre` es lo que el vale guarda en `created_by` (como la captura de hoy: con eso se revisa que nadie
   * firme lo suyo, GX.65.4a); `quien.usuario` va a «Solicita» en Kepler (`c48`), que ya es el username de la Suite
   * en 2,151 de 2,327 solicitudes desde octubre.
   */
  async crear(dto: CrearSolicitudGastoDto, quien: { nombre: string; usuario: string }): Promise<SolicitudGastoCreada> {
    this.tenantCtx.requireTenantId();
    const actor = String(quien?.nombre ?? "").trim() || String(quien?.usuario ?? "").trim();
    if (!actor) throw new BadRequestException("No se sabe quién pide: la sesión no trae usuario");
    const nombre = actor;
    // S.17 (DS27): sólo en una base de quien pide. Sin esto, por API se pedía en la sucursal de otro (anexo §14.8 b).
    const s = await this.base(dto?.sucursal);
    // La puerta: la MISMA regla que abre la pestaña. Sin esto, por API se pedían solicitudes en sucursales donde la
    // escritura nunca se configuró, y quedaban firmadas sin X-A-15 por meses.
    const puerta = await this.puerta(s);
    if (!puerta.disponible) throw new ConflictException(`La solicitud de gasto todavía no está abierta en la sucursal ${s}: ${puerta.motivos.join('; ')}`);
    const hoy = todayMx();
    const files = Array.isArray(dto.files) ? dto.files.filter((f) => f && f.url && f.role) : [];
    const acreedor = String(dto.acreedor ?? '').trim().toUpperCase();
    const renglones = (dto.renglones ?? []).map((r) => ({
      concepto: String(r.concepto ?? '').trim(), proyecto: String(r.proyecto ?? '').trim(),
      departamento: String(r.departamento ?? '').trim(), importe: Number(r.importe),
    }));
    const formaPagoDetalle = unirDetallesDePago(detallesDePago(dto.forma_pago_detalle));
    const faltan = faltaParaPedir({
      sucursal: s, acreedor, renglones, iva: Number(dto.iva ?? 0), fecha_solicitud: hoy, comprobante: dto.comprobante,
      forma_pago: dto.forma_pago, forma_pago_detalle: formaPagoDetalle, archivos: files, motivo_fecha: dto.motivo_fecha,
      pago: dto.pago ?? null,
    });
    if (faltan.length) throw new BadRequestException(faltan.map((f) => f.motivo).join('; '));
    // S.17 (DS31): lo que viene vacío no se guarda; lo que viene ya pasó la compuerta (la CLABE con su dígito de control).
    const pago: InformacionDePago | null = hayInformacionDePago(dto.pago) ? (dto.pago as InformacionDePago) : null;
    const cuentaPago = pago ? cuentaDePago(pago.cuenta) : null;
    const fechas = avisoDeFechas(dto.comprobante?.fecha, hoy);
    const necesitaPara = fechaReal(dto.necesita_para) && String(dto.necesita_para) >= hoy ? String(dto.necesita_para) : null;

    // El id del vale: el que generó la pantalla (si reintenta tras «no sé si llegó», es el mismo) o uno nuevo.
    const idCliente = String(dto.id_cliente ?? '').trim().toLowerCase();
    const id = UUID.test(idCliente) ? idCliente : randomUUID();
    const marca = marcaDeLaSolicitud(id);
    const t = totalesDeLaSolicitud(renglones, dto.iva);
    const uuidPedido = dto.comprobante?.tipo === 'cfdi' ? String(dto.comprobante.uuid ?? '').trim().toLowerCase() : '';

    let creada: { comentario: string; repetida?: boolean };
    try {
      creada = await this.tk.run(async (trx) => {
      if (!(await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'kepler_request_status'))) {
        throw new ServiceUnavailableException('La solicitud de gasto en la Suite todavía no está habilitada en esta base (falta la migración de [PGP.122])');
      }
      if (pago && !(await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'payee_account'))) {
        // Nunca se tira en silencio lo que la persona escribió: se dice y se decide.
        throw new ServiceUnavailableException('La información de pago todavía no se puede guardar en esta base (falta la migración de [PGP.122] S.17): quítala y mándala sin ella');
      }
      // Idempotencia: la misma solicitud otra vez (la respuesta anterior se perdió) devuelve la que ya está.
      const previa = await trx('finance.expense_proofs').where({ id }).first('created_by', 'origen');
      if (previa) {
        if (previa.origen !== 'solicitud' || String(previa.created_by ?? '') !== actor) throw new ConflictException('Ese identificador de solicitud ya lo usa otra captura');
        return { comentario: '', repetida: true };
      }
      // ── Contra el catálogo de Kepler de ESA sucursal (ODS): acreedor, conceptos con cuenta, proyectos, deptos ──
      const d = (await trx.raw(`SELECT btrim(c3) AS nombre, btrim(c10) AS rfc FROM kepler_ods.kdxd WHERE sucursal = ? AND btrim(c2) = ? ORDER BY c1 LIMIT 1`, [s, acreedor])).rows[0];
      const no: string[] = [];
      if (!d) no.push(`Kepler (${s}) no tiene al acreedor ${acreedor}`);
      // ── La factura del SAT: se VERIFICA (no basta un texto con forma de UUID): recibida, de ingreso, vigente,
      // por el mismo total (±$1), de un emisor compatible con el acreedor y sin respaldar ya otro vale vivo ──
      if (uuidPedido) {
        const cf = (await trx.raw(
          `SELECT upper(emisor_rfc) AS rfc, total::float8 AS total, coalesce(estatus_sat, '') AS estatus FROM fiscal.cfdis
            WHERE lower(uuid) = ? AND rol = 'recibidas' AND tipo_comprobante = 'I' LIMIT 1`, [uuidPedido])).rows[0] as { rfc: string; total: number; estatus: string } | undefined;
        if (!cf) no.push(`La factura ${uuidPedido} no está entre las recibidas del SAT: adjunta la foto o el PDF del comprobante`);
        else {
          if (/cancel/i.test(cf.estatus)) no.push(`La factura ${uuidPedido} está cancelada en el SAT`);
          if (Math.abs(cf.total - t.total) > 1) no.push(`La factura es por $${cf.total.toFixed(2)} y la solicitud por $${t.total.toFixed(2)}`);
          if (d && !rfcCompatible(d.rfc, cf.rfc)) no.push(`La factura es de ${cf.rfc} y el acreedor ${acreedor} tiene otro RFC en Kepler (${d.rfc})`);
        }
        const otro = await trx('finance.expense_proofs').whereRaw('lower(cfdi_uuid) = ?', [uuidPedido]).whereNot('status', 'rechazada').first('id');
        if (otro) no.push(`La factura ${uuidPedido} ya respalda otro vale`);
      }
      const codigos = (k: 'concepto' | 'proyecto' | 'departamento') => [...new Set(renglones.map((r) => r[k]))];
      const conceptos = new Map<string, { nombre: string; cuenta: string }>(((await trx.raw(
        `SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS c, btrim(c2) AS nombre, btrim(c3) AS cuenta FROM kepler_ods.kdco
          WHERE sucursal = ? AND btrim(c1) = ANY(?::text[]) AND btrim(c3) <> '' ORDER BY btrim(c1), c2`, [s, codigos('concepto')])).rows as Array<{ c: string; nombre: string; cuenta: string }>)
        .map((r) => [r.c, { nombre: r.nombre, cuenta: r.cuenta }]));
      const cedis = await this.cuentasDeCedis(trx, s, codigos('concepto'));
      for (const c of codigos('concepto')) {
        const k = conceptos.get(c);
        if (!k) no.push(`el concepto ${c} no está en el catálogo de ${s} o no tiene cuenta`);
        else {
          const fuera = cuentaFueraDeAlcance(k.cuenta); if (fuera) no.push(fuera);
          // R14: en este servidor el concepto va a otro rubro que en CEDIS (el 074 a caja): no se escribe así en Kepler.
          const distinto = conceptoDistintoDeCedis({ codigo: c, nombre: k.nombre, cuenta: k.cuenta }, cedis.get(c), s); if (distinto) no.push(distinto);
        }
      }
      for (const [k, tabla, que] of [['proyecto', 'kdcp', 'proyecto'], ['departamento', 'kdc3', 'departamento']] as const) {
        const hay = new Set(((await trx.raw(`SELECT DISTINCT btrim(c1) AS c FROM kepler_ods.${tabla} WHERE sucursal = ? AND btrim(c1) = ANY(?::text[])`, [s, codigos(k)])).rows as Array<{ c: string }>).map((r) => r.c));
        for (const c of codigos(k)) if (!hay.has(c)) no.push(`el ${que} ${c} no está en el catálogo de ${s}`);
      }
      if (no.length) throw new BadRequestException(no.join('; '));

      const primero = conceptos.get(renglones[0].concepto);
      const comentario = String(dto.comentario ?? '').trim()
        || comentarioDeLaSolicitud({ concepto: primero?.nombre, del: dto.periodo_del, al: dto.periodo_al, unidad: dto.unidad });
      const tieneComprobante = files.some((f) => String(f.role).startsWith('comprobante'));
      await trx('finance.expense_proofs').insert({
        id, tenant_id: trx.raw('public.current_tenant_id()'),
        solicitante: String(nombre ?? '').trim() || actor, departamento: `Sucursal ${s}`, sucursal: s,
        fecha_gasto: dto.comprobante.fecha, folio_solicitud: null, proveedor: d.nombre, importe: t.total,
        // Como la captura de hoy (GX.19) hasta que Contabilidad confirme la clase fiscal por acreedor (DS12).
        clasificacion: 'no_comprobable', comprobacion_nota: comentario,
        // DS17: al pedir, la referencia o el cheque pueden no existir todavía; vacío se guarda como «sin dato», no ''.
        forma_pago: dto.forma_pago, forma_pago_detalle: exigeDetalle(dto.forma_pago) && formaPagoDetalle ? formaPagoDetalle : null,
        files: JSON.stringify(files), comentarios: comentario, status: 'recibida', created_by: actor, origen: 'solicitud',
        capture_meta: JSON.stringify({ pgp122: true, solicita_usuario: String(quien.usuario ?? '').trim() || null, fuentes: dto.fuentes ?? {}, periodo_del: dto.periodo_del ?? null, periodo_al: dto.periodo_al ?? null, unidad: dto.unidad ?? null }),
        ...(tieneComprobante ? { evidencia_por: actor, evidencia_at: trx.fn.now() } : {}),
        ...(quedaDebiendoComprobante({ archivos: files, exige_evidencia: true, forma_pago: dto.forma_pago }) ? { provisional: true } : {}),
        creditor_code: acreedor, vat_amount: t.iva, document_type: dto.comprobante.tipo,
        document_folio: String(dto.comprobante.folio ?? '').trim() || null, document_date: dto.comprobante.fecha,
        // Sólo el UUID que se verificó arriba, y sólo si el documento es una factura.
        cfdi_uuid: uuidPedido || null, requested_on: hoy, needed_by: necesitaPara,
        is_retroactive: fechas.ok ? fechas.retroactiva : true, date_reason: String(dto.motivo_fecha ?? '').trim() || null,
        kepler_request_status: 'pending', kepler_request_mark: marca, kepler_request_attempts: 0,
        ...(pago ? {
          payee_account: cuentaPago?.ok ? cuentaPago.cuenta : null,
          payee_bank: String(pago.banco ?? '').trim() || null,
          payee_email: String(pago.correo ?? '').trim() || null,
        } : {}),
      });
      await trx('finance.expense_proof_lines').insert(renglones.map((r, i) => ({
        tenant_id: trx.raw('public.current_tenant_id()'), proof_id: id, line_no: i + 1,
        concept_code: r.concepto, concept_name: conceptos.get(r.concepto)?.nombre ?? null, account: conceptos.get(r.concepto)?.cuenta ?? null,
        project_code: r.proyecto, department_code: r.departamento, amount: Math.round(r.importe * 100) / 100,
        prefill_source: dto.fuentes?.[`renglon_${i + 1}`] ?? null, created_by: actor, updated_by: actor,
      })));
      return { comentario };
      });
    } catch (e) {
      // Dos envíos simultáneos con el mismo id: el segundo choca con la llave del vale. Es la misma solicitud.
      const err = e as { code?: string; constraint?: string; message?: string };
      if (err?.code === '23505' && /expense_proofs_pkey/.test(String(err.constraint ?? err.message ?? ''))) creada = { comentario: '', repetida: true };
      else throw e;
    }

    if (creada.repetida) {
      const ya = await this.tk.run(async (trx) => trx('finance.expense_proofs').where({ id, origen: 'solicitud' })
        .first('status', 'kepler_request_status', 'is_retroactive', 'created_by', trx.raw('importe::float8 AS importe')));
      if (!ya || String(ya.created_by ?? '') !== actor) throw new ConflictException('Ese identificador de solicitud ya lo usa otra captura');
      this.logger.log(`solicitud de gasto ${marca}: la pantalla la mandó otra vez; ya estaba guardada (no se creó otra)`);
      return {
        id, status: String(ya.status), kepler_request_status: String(ya.kepler_request_status ?? 'pending'), total: Number(ya.importe),
        retroactiva: !!ya.is_retroactive, duplicados: await this.duplicados(s, acreedor, Number(ya.importe), hoy, id).catch(() => []),
      };
    }

    const duplicados = await this.duplicados(s, acreedor, t.total, hoy, id).catch(() => []);
    try {
      this.gateway?.emitChange(this.tenantCtx.requireTenantId(), { action: 'captured', folio_solicitud: '', status: 'recibida', solicitante: nombre || actor, importe: t.total, sucursal: s, actor });
    } catch { /* el aviso es cortesía: la solicitud ya se guardó */ }
    this.logger.log(`solicitud de gasto ${marca} (${s}, ${acreedor}, $${t.total.toFixed(2)}, ${renglones.length} renglones) pedida por ${actor}: espera firma («${creada.comentario}»)`);
    return { id, status: 'recibida', kepler_request_status: 'pending', total: t.total, retroactiva: fechas.ok ? fechas.retroactiva : true, duplicados };
  }

  // ── Escribir en Kepler ───────────────────────────────────────────────────────────────────────

  /** La llama `ExpenseProofsService.approve` DESPUÉS de guardar la firma. Nunca lanza. */
  async escribirAlFirmar(id: string, actor?: string | null): Promise<EstadoKeplerDeLaSolicitud | null> {
    try {
      return await this.intentar((fn) => this.tk.run(fn), id, 'firma', actor ?? null);
    } catch (e) {
      // Puede haber fallado ANTES de Kepler o DESPUÉS de su COMMIT (al anotar): no se afirma cuál. Si el vale quedó
      // reclamado (`writing`), a los WRITING_HUERFANO_MIN el cron lo da por huérfano y le pregunta a Kepler por la marca.
      this.logger.error(`vale ${id}: la firma quedó guardada, pero la escritura en Kepler no terminó: ${(e as Error).message}. Si alcanzó a reclamarse, el cron la revisa por su marca en ${WRITING_HUERFANO_MIN} min`);
      return null;
    }
  }

  /**
   * `[PGP.122]` F3 (DS40, Edgar 2026-11-17) — **Cancela en Kepler la solicitud que escribió la Suite, y cierra el vale.**
   * Sólo con `COMPROBAR` (lo exige el controlador), sólo sin gasto X-A-10 vivo (lo decide Kepler vivo, con candado) y
   * con motivo. Ya cancelada en Kepler (Finanzas lo hizo allá): no se escribe nada y el vale se cierra igual.
   * No exige «que no sea suyo» como el rechazo: cancelar no saca dinero, deshace; quién canceló queda en el vale.
   */
  async cancelarEnKepler(id: string, motivo: unknown, actor: string): Promise<EstadoKeplerDeLaSolicitud> {
    const m = String(motivo ?? '').trim().replace(/\s+/g, ' ');
    if (m.length < SOLICITUD_CANCELAR_MOTIVO_MIN) throw new BadRequestException(`Escribe por qué se cancela (al menos ${SOLICITUD_CANCELAR_MOTIVO_MIN} caracteres): lo lee quien revise el gasto después`);
    if (!UUID.test(String(id))) throw new BadRequestException('Vale inválido');
    const v = await this.tk.run(async (trx) => trx('finance.expense_proofs').where({ id }).first(
      'id', 'status', 'origen', 'sucursal', 'folio_solicitud', 'kepler_request_status', 'kepler_request_mark', 'kepler_request_note',
      'kepler_request_attempts', 'kepler_request_next_at')) as (ValeParaKepler & { id: string }) | undefined;
    if (!v) throw new NotFoundException('No existe ese vale');
    if (v.origen !== 'solicitud') throw new ConflictException('Este vale no nació en la Suite: su solicitud se cancela en Kepler');
    if (!FIRMADAS.includes(v.status)) throw new ConflictException('Sólo se cancela una solicitud firmada; una por firmar se rechaza');
    if (!v.folio_solicitud || !['written', 'seen_in_ods'].includes(String(v.kepler_request_status))) {
      throw new ConflictException('Esta solicitud todavía no está escrita en Kepler: se rechaza aquí y Kepler nunca se entera');
    }
    const s = this.sucursal(v.sucursal);
    await this.base(s);
    const sw = await this.tk.run(async (trx) => opcional(trx, (sp) => sp('commercial.kepler_push_switch').where({ sucursal: s, tipo: TIPO_INTERRUPTOR })
      .first<{ encendida: boolean } | undefined>('encendida'), undefined));
    if (!sw?.encendida) throw new ConflictException(`La escritura de solicitudes en Kepler de esta sucursal está apagada: cancélala en Kepler`);
    if (!this.sink) throw new ServiceUnavailableException('El escritor de Kepler no está disponible');
    const r = await this.sink.cancelar({ sucursal: s, folio: String(v.folio_solicitud), marca: String(v.kepler_request_mark ?? ''), fecha: todayMx(), hora: horaMx() });
    if (r.estado === 'apagado') throw new ConflictException(r.motivo);
    if (r.estado === 'rechazado') throw new ConflictException(r.reintentable ? `${r.motivo}. Intenta de nuevo en un momento` : r.motivo);
    const nota = r.estado === 'ya_estaba'
      ? `Ya estaba cancelada en Kepler (folio ${r.folio}); ${actor} la cerró en la Suite: ${m}`
      : `${SOLICITUD_CANCELADA_DESDE_LA_SUITE} por ${actor} (folio ${r.folio}): ${m}`;
    const [fila] = await this.tk.run(async (trx) => trx('finance.expense_proofs').where({ id }).whereIn('status', FIRMADAS)
      .update({
        status: 'rechazada', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: `${SOLICITUD_CANCELADA_DESDE_LA_SUITE}: ${m}`.slice(0, 500),
        kepler_request_status: 'cancelled', kepler_request_next_at: null, kepler_request_note: nota.slice(0, 500), updated_at: trx.fn.now(),
      })
      .returning(['id', 'kepler_request_status', 'folio_solicitud', 'kepler_request_note', 'kepler_request_attempts', 'kepler_request_next_at']));
    if (!fila) {
      // Kepler ya quedó cancelado y el vale cambió entre tanto (alguien lo rechazó): se dice, no se pierde.
      this.logger.error(`vale ${id}: la solicitud ${s}-${r.folio} quedó cancelada en Kepler, pero el vale ya no estaba firmado al cerrarlo: revisarlo a mano`);
      throw new ConflictException(`La solicitud quedó cancelada en Kepler (folio ${r.folio}), pero el vale cambió mientras tanto: revísalo`);
    }
    this.logger.log(`vale ${id}: ${nota}`);
    return this.estadoDe(fila as FilaEstadoKepler);
  }

  /** «Reintentar» de una persona con `COMPROBAR`: también los atorados y los que Kepler rechazó (ya corregidos). */
  async reintentar(id: string, actor: string): Promise<EstadoKeplerDeLaSolicitud | null> {
    return this.intentar((fn) => this.tk.run(fn), id, 'reintento', actor);
  }

  // El estado de cada vale para la pantalla lo da la lectura de Kepler de PGP.79 (`nace_en_la_suite` en
  // `AutorizacionKeplerLecturaService.porVales`): una sola fuente para la pastilla de Aprobación.

  private estadoDe(v: FilaEstadoKepler): EstadoKeplerDeLaSolicitud {
    const sig = v.kepler_request_next_at;
    return {
      id: String(v.id), status: v.kepler_request_status ?? null, folio: v.folio_solicitud ?? null,
      nota: v.kepler_request_note ?? null, intentos: Number(v.kepler_request_attempts ?? 0),
      siguiente: sig ? new Date(sig).toISOString() : null,
    };
  }

  /**
   * Un intento completo: leer → (si quedó en duda, preguntar por la marca) → reclamar → Kepler → anotar.
   * `run` es el ejecutor de transacciones con el tenant puesto (el de la petición o el del cron).
   */
  private async intentar(run: Ejecutor, id: string, disparo: Disparo, actor: string | null): Promise<EstadoKeplerDeLaSolicitud | null> {
    const leer = async (trx: Trx): Promise<ValeParaKepler | undefined> => (await trx('finance.expense_proofs').where({ id }).first(
      'id', 'status', 'origen', 'sucursal', 'folio_solicitud', 'creditor_code', 'vat_amount', 'document_type', 'document_folio',
      trx.raw(`to_char(document_date, 'YYYY-MM-DD') AS document_date`), 'cfdi_uuid',
      trx.raw(`to_char(requested_on, 'YYYY-MM-DD') AS requested_on`), trx.raw(`to_char(needed_by, 'YYYY-MM-DD') AS needed_by`),
      'comentarios', 'forma_pago', 'created_by', 'capture_meta', 'kepler_request_status', 'kepler_request_mark', 'kepler_request_attempts',
      'kepler_request_note', 'kepler_request_next_at')) as ValeParaKepler | undefined;

    // ── 1. Leer y decidir si toca ──────────────────────────────────────────────────────────────
    const lectura = await run(async (trx) => {
      if (!(await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'kepler_request_status'))) return null;
      const v = await leer(trx);
      if (!v || v.origen !== 'solicitud') return null;
      const sw = await opcional(trx, (sp) => sp('commercial.kepler_push_switch').where({ sucursal: v.sucursal, tipo: TIPO_INTERRUPTOR })
        .first<{ encendida: boolean; tope_dia: number | null } | undefined>('encendida', 'tope_dia'), undefined);
      const lineas = await trx('finance.expense_proof_lines').where({ proof_id: id }).orderBy('line_no')
        .select('concept_code', 'project_code', 'department_code', trx.raw('amount::float8 AS amount'));
      return { v, sw, lineas: lineas as Array<{ concept_code: string; project_code: string; department_code: string; amount: number }> };
    });
    if (!lectura) return null;
    const { v, sw, lineas } = lectura;
    if (v.folio_solicitud || ['written', 'seen_in_ods', 'cancelled'].includes(String(v.kepler_request_status))) return this.estadoDe(v);
    // La escritura cuelga de la FIRMA (ADR-092 regla 6), no del estado de la evidencia: un vale firmado que pasa a
    // «revision» (subió su factura) sigue escribiéndose; uno sin firma o rechazado, no.
    if (!FIRMADAS.includes(v.status)) return this.estadoDe(v);
    if (!this.sink) return this.estadoDe(v);
    const manual = disparo === 'reintento';

    // Apagado (interruptor o bandera): no se intenta y no cuenta; queda esperando a que lo enciendan.
    const apagadoPor = !sw?.encendida ? `El interruptor ${TIPO_INTERRUPTOR} de la sucursal ${v.sucursal} está apagado` : !this.sink.encendida() ? 'La escritura de solicitudes a Kepler está apagada (KEPLER_GASTO_SOLICITUD)' : null;
    if (apagadoPor) {
      if (v.kepler_request_note !== apagadoPor || disparo !== 'cron') {
        await run(async (trx) => {
          await trx('finance.expense_proofs').where({ id }).whereIn('kepler_request_status', ['pending', 'retry']).update({ kepler_request_note: apagadoPor, updated_at: trx.fn.now() });
          if (disparo !== 'cron') await this.bitacora(trx, id, disparo, v, { estado: 'apagado', motivo: apagadoPor }, null, actor);
        });
      }
      return this.estadoDe({ ...v, kepler_request_note: apagadoPor });
    }

    // ── 2. En duda: primero se le pregunta a Kepler por la marca ────────────────────────────────
    if (v.kepler_request_status === 'in_doubt') {
      const m = await this.sink.buscarPorMarca(String(v.sucursal), String(v.kepler_request_mark));
      if (!m.ok) {
        // Sin poder preguntar, NO se reintenta (podría duplicar). Se dice por qué y se vuelve a preguntar en 5 min.
        const nota = `En duda, y no se pudo preguntar a Kepler por la marca: ${m.motivo}`;
        await run(async (trx) => trx('finance.expense_proofs').where({ id, kepler_request_status: 'in_doubt' })
          .update({ kepler_request_note: nota, kepler_request_next_at: trx.raw(`now() + interval '5 minutes'`), updated_at: trx.fn.now() }));
        return this.estadoDe({ ...v, kepler_request_note: nota });
      }
      if (m.encontrada) {
        const r: ResultadoEscrituraSolicitud = { estado: 'ya_estaba', sucursal: String(v.sucursal), folio: m.encontrada.folio, kepler: m.encontrada.kepler };
        return run(async (trx) => this.anotar(trx, id, v, r, disparo, actor, null));
      }
      await run(async (trx) => trx('finance.expense_proofs').where({ id, kepler_request_status: 'in_doubt' }).whereIn('status', FIRMADAS)
        .update({ kepler_request_status: 'retry', updated_at: trx.fn.now() }));
      v.kepler_request_status = 'retry';
    }

    // ── 3. El reclamo atómico, confirmado ANTES de hablar con Kepler ───────────────────────────
    // Sólo un vale FIRMADO se reclama: si lo rechazaron entre la lectura y aquí, no se escribe.
    const reclamables = manual ? ['pending', 'retry', 'stuck', 'rejected_by_kepler'] : ['pending', 'retry'];
    const reclamado = await run(async (trx) => trx('finance.expense_proofs')
      .where({ id }).whereNull('folio_solicitud').whereIn('kepler_request_status', reclamables).whereIn('status', FIRMADAS)
      .modify((qb) => { if (!manual && v.kepler_request_status === 'retry') qb.where((w) => w.whereNull('kepler_request_next_at').orWhere('kepler_request_next_at', '<=', trx.fn.now())); })
      .update({ kepler_request_status: 'writing', kepler_request_at: trx.fn.now(), updated_at: trx.fn.now() })
      .returning('id'));
    if (!reclamado.length) return run(async (trx) => { const otra = await leer(trx); return otra ? this.estadoDe(otra) : null; });

    // ── 4. Kepler ──────────────────────────────────────────────────────────────────────────────
    const entrega: EntregaSolicitudKepler = {
      sucursal: String(v.sucursal), acreedor: String(v.creditor_code), fechaSolicitud: String(v.requested_on), fechaPago: v.needed_by,
      renglones: lineas.map((l) => ({ concepto: l.concept_code, proyecto: l.project_code, departamento: l.department_code, importe: Number(l.amount) })),
      iva: Number(v.vat_amount ?? 0),
      comprobante: { tipo: (v.document_type ?? 'ticket') as 'cfdi' | 'ticket' | 'cotizacion', folio: v.document_folio, fecha: v.document_date, uuid: v.cfdi_uuid },
      comentario: String(v.comentarios ?? ''), solicita: usuarioQueSolicita(v), formaPago: v.forma_pago,
      marca: String(v.kepler_request_mark), estado: 'A', capturadaEn: { fecha: todayMx(), hora: horaMx() }, tope_dia: sw?.tope_dia ?? null,
    };
    let r: ResultadoEscrituraSolicitud;
    try {
      r = await this.sink.entregar(entrega);
    } catch (e) {
      // El escritor no lanza; si algo lo hizo, el resultado no se sabe: EN DUDA, se pregunta por la marca.
      r = { estado: 'en_duda', motivo: `El escritor falló sin contestar: ${(e as Error).message}` };
    }
    return run(async (trx) => this.anotar(trx, id, v, r, disparo, actor, entrega));
  }

  /** Guarda el resultado en el vale y su renglón en la bitácora. */
  private async anotar(trx: Knex.Transaction, id: string, v: ValeParaKepler, r: ResultadoEscrituraSolicitud, disparo: Disparo, actor: string | null, entrega: EntregaSolicitudKepler | null): Promise<EstadoKeplerDeLaSolicitud> {
    const intentos = Number(v.kepler_request_attempts ?? 0) + (r.estado === 'apagado' ? 0 : 1);
    const ahora = trx.fn.now();
    let cambio: Record<string, unknown>;
    if (r.estado === 'escrito' || r.estado === 'ya_estaba') {
      cambio = {
        folio_solicitud: r.folio, kepler_request_status: 'written', kepler_request_next_at: null,
        kepler_request_note: r.estado === 'ya_estaba' ? `Kepler ya la tenía (folio ${r.folio}, ${r.kepler}): no se escribió otra` : null,
        // Nació autorizada: para Aprobación y los tableros, es la autorización en Kepler.
        kepler_authorization_status: 'escrito', kepler_authorization_at: ahora, kepler_authorization_note: 'Nació autorizada en Kepler al firmar [PGP.122]',
      };
    } else if (r.estado === 'apagado') {
      // El escritor dijo «este servidor no escribe» (p. ej. la plantilla): espera, sin gastar intentos, y el cron
      // no lo vuelve a tomar en 15 min (sin esto lo tomaba cada 5 y se comía el cupo de las demás sucursales).
      cambio = { kepler_request_status: 'pending', kepler_request_note: r.motivo, kepler_request_next_at: trx.raw(`now() + interval '15 minutes'`) };
    } else if (r.estado === 'en_duda') {
      cambio = { kepler_request_status: 'in_doubt', kepler_request_note: r.motivo, kepler_request_next_at: trx.raw(`now() + interval '5 minutes'`) };
    } else if (r.reintentable) {
      if (r.porTope) {
        cambio = { kepler_request_status: 'retry', kepler_request_note: r.motivo, kepler_request_next_at: trx.raw(`(date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') + interval '1 day 7 hours') AT TIME ZONE 'America/Mexico_City'`) };
      } else if (intentos >= ESPERAS_MIN.length) {
        cambio = { kepler_request_status: 'stuck', kepler_request_note: `${r.motivo} (${intentos} intentos: lo reintenta una persona)`, kepler_request_next_at: null };
      } else {
        cambio = { kepler_request_status: 'retry', kepler_request_note: r.motivo, kepler_request_next_at: trx.raw(`now() + make_interval(mins => ?)`, [ESPERAS_MIN[intentos - 1] ?? 60]) };
      }
    } else {
      cambio = { kepler_request_status: 'rejected_by_kepler', kepler_request_note: r.motivo, kepler_request_next_at: null };
    }
    const contar = r.estado === 'rechazado' && r.porTope ? Number(v.kepler_request_attempts ?? 0) : intentos;
    // Sólo sobre el vale que SIGUE reclamado (o en duda) y, si trae folio, que no tenga ya otro: un escritor que
    // regresó tarde o un folio puesto por otro camino no se pisan en silencio.
    const devolver = ['id', 'kepler_request_status', 'folio_solicitud', 'kepler_request_note', 'kepler_request_attempts', 'kepler_request_next_at'];
    const [fila] = await trx('finance.expense_proofs').where({ id }).whereIn('kepler_request_status', ['writing', 'in_doubt'])
      .modify((qb) => { if (r.estado === 'escrito' || r.estado === 'ya_estaba') qb.whereNull('folio_solicitud'); })
      .update({ ...cambio, kepler_request_attempts: contar, kepler_request_at: ahora, updated_at: ahora })
      .returning(devolver);
    await this.bitacora(trx, id, disparo, v, r, entrega, actor);
    if (!fila) {
      const actual = await trx('finance.expense_proofs').where({ id }).first(devolver);
      const aviso = `⚠ Kepler respondió «${r.estado}»${'folio' in r ? ` (folio ${r.folio})` : ''}, pero el vale ya no estaba esperando esa respuesta (estado ${actual?.kepler_request_status ?? '?'}, folio ${actual?.folio_solicitud ?? 'sin folio'}): revisarlo a mano`;
      this.logger.error(`vale ${id} (${v.kepler_request_mark}): ${aviso}`);
      await trx('finance.expense_proofs').where({ id }).update({ kepler_request_note: aviso, updated_at: ahora });
      return this.estadoDe({ ...(actual as FilaEstadoKepler), kepler_request_note: aviso });
    }
    const nivel = r.estado === 'escrito' || r.estado === 'ya_estaba' ? 'log' : 'warn';
    this.logger[nivel](`vale ${id} (${v.kepler_request_mark}) → Kepler ${v.sucursal}: ${r.estado}${'folio' in r ? ` ${r.folio}` : ''}${'motivo' in r ? ` — ${r.motivo}` : ''}`);
    return this.estadoDe(fila);
  }

  private async bitacora(trx: Trx, id: string, disparo: Disparo, v: ValeParaKepler, r: ResultadoEscrituraSolicitud, entrega: EntregaSolicitudKepler | null, actor: string | null): Promise<void> {
    const plan = entrega ? JSON.stringify(entrega) : null;
    await trx('finance.expense_request_kepler_attempts').insert({
      tenant_id: trx.raw('public.current_tenant_id()'), proof_id: id, trigger: disparo, server: String(v.sucursal ?? ''), mark: String(v.kepler_request_mark ?? ''),
      result: r.estado, folio: 'folio' in r ? r.folio : null, retryable: r.estado === 'rechazado' ? r.reintentable : null,
      note: 'motivo' in r ? r.motivo : null, plan, plan_hash: plan ? createHash('sha256').update(plan).digest('hex') : null, created_by: actor,
    });
  }

  // ── El cron: reintentos, huérfanos y el lazo con el ODS ──────────────────────────────────────

  @Cron('30 */5 * * * *', { timeZone: 'America/Mexico_City' })
  async programado(): Promise<void> {
    if (process.env.DISABLE_CRONS === 'true' || process.env.ENABLE_SOLICITUD_KEPLER_CRON === 'false') return;
    if (this.corriendo) { this.logger.warn('Skip: ciclo de solicitudes a Kepler en curso'); return; }
    await this.ciclo().catch((e) => this.logger.error(`ciclo de solicitudes a Kepler: ${e?.message ?? e}`));
  }

  /** Una pasada. Público para la prueba. Devuelve qué hizo, para el latido y para medir. */
  async ciclo(limite = 20): Promise<ResultadoDelCiclo> {
    this.corriendo = true;
    const t0 = Date.now();
    const m: ResultadoDelCiclo = {
      huerfanos: 0, intentados: 0, vistos_en_ods: 0, sin_ver_30min: 0, en_duda: 0,
      canceladas_en_kepler: 0, canceladas_firmadas: 0, sin_vale_en_kepler: 0, contadores_atrasados: [],
    };
    const fallas: string[] = [];
    // El cron no tiene petición: el tenant se fija a mano (RLS FORZADO en expense_proofs, como en CierreKeplerService).
    const run: Ejecutor = (fn) => this.tk.run(MEGA, fn);
    try {
      const hay = await run(async (trx) => trx.schema.withSchema('finance').hasColumn('expense_proofs', 'kepler_request_status'));
      if (!hay) return m;
      // Huérfanos: `writing` de hace más de 10 min — el proceso murió entre el reclamo y la respuesta.
      m.huerfanos = Number(await run(async (trx) => trx('finance.expense_proofs')
        .where({ tenant_id: MEGA, origen: 'solicitud', kepler_request_status: 'writing' })
        .whereRaw(`kepler_request_at < now() - make_interval(mins => ?)`, [WRITING_HUERFANO_MIN])
        .update({ kepler_request_status: 'in_doubt', kepler_request_note: 'El intento anterior no terminó: se pregunta a Kepler por la marca antes de reintentar', updated_at: trx.fn.now() })));
      // Sólo las sucursales ABIERTAS (bandera, URL, plantilla e interruptor): las firmadas de una sucursal apagada
      // esperan sin ocupar el cupo de 20, que si no dejaba sin turno a los reintentos de las demás.
      const encendidas = new Set(await run(async (trx) => (await opcional(trx, (sp) => sp('commercial.kepler_push_switch')
        .where({ tipo: TIPO_INTERRUPTOR, encendida: true }).pluck('sucursal'), [] as string[]))));
      const abiertas = SUCURSALES.filter((s) => encendidas.has(s) && this.sink?.encendida() && urlDeServidor(s, process.env).ok && plantillaSolicitudDe(s, process.env).ok);
      // Los que toca intentar: firmados, sin folio, pendientes, en espera vencida o en duda; el que más espera, primero.
      const ids: string[] = !abiertas.length ? [] : await run(async (trx) => (await trx('finance.expense_proofs')
        .where({ tenant_id: MEGA, origen: 'solicitud' }).whereIn('status', FIRMADAS).whereNull('folio_solicitud').whereIn('sucursal', abiertas)
        .whereIn('kepler_request_status', ['pending', 'retry', 'in_doubt'])
        .where((y) => y.whereNull('kepler_request_next_at').orWhere('kepler_request_next_at', '<=', trx.fn.now()))
        .orderByRaw('coalesce(kepler_request_next_at, aprobado_at, updated_at)').limit(limite).select('id')).map((x: { id: string }) => x.id));
      for (const id of ids) {
        try {
          const e = await this.intentar(run, id, 'cron', null);
          m.intentados++;
          if (e?.status === 'in_doubt') m.en_duda++;
        } catch (e) { fallas.push(`${id}: ${(e as Error).message}`); }
      }
      // El lazo de después de escribir. Con el aviso del ODS encendido, lo que encuentre AQUÍ es lo que el aviso no vio
      // (o una carrera de segundos con su espera): es la medida para retirar este ciclo (anexo S §17.6).
      const l = await this.lazo();
      m.vistos_en_ods = l.vistos_en_ods;
      m.sin_ver_30min = l.sin_ver_30min;
      m.canceladas_en_kepler = l.canceladas_en_kepler;
      m.canceladas_firmadas = l.canceladas_firmadas;
      const huerfanas = l.huerfanas;
      m.sin_vale_en_kepler = huerfanas.length;
      // La compuerta del contador, en las sucursales abiertas (sólo ahí la Suite escribe y hay con qué preguntar).
      for (const s of abiertas) {
        const k = await this.sink!.revisarContador(s);
        if (!k.ok) { fallas.push(`Contador de folios de Kepler ${s}: no se pudo revisar — ${k.motivo}`); continue; }
        if (k.atrasado) { m.contadores_atrasados.push(s); fallas.push(`El contador de folios de la solicitud de gasto en Kepler ${s} está ATRASADO (sqliov.c4 = ${k.contador}, último folio ${k.maximo}): la próxima captura a mano chocaría`); }
      }

      // Las alarmas SUENAN: con fallas, el latido sale en rojo en db-health (antes quedaba en verde).
      if (m.sin_ver_30min) fallas.push(`${m.sin_ver_30min} solicitud(es) escritas en Kepler hace más de 30 min no aparecen en el ODS: revisar la ingesta o la escritura`);
      if (m.en_duda) fallas.push(`${m.en_duda} solicitud(es) EN DUDA sin poder preguntarle a Kepler por su marca: no se reintentan hasta saber si quedaron escritas`);
      if (m.canceladas_firmadas) fallas.push(`${m.canceladas_firmadas} solicitud(es) de la Suite CANCELADAS en Kepler con el vale todavía firmado: rechazarlas en la Suite o recapturarlas`);
      if (huerfanas.length) fallas.push(`${huerfanas.length}${huerfanas.length === 20 ? '+' : ''} solicitud(es) en Kepler con la marca de la Suite y SIN vale: ${huerfanas.slice(0, 5).map((h) => `${h.sucursal}-${h.folio} (${h.marca})`).join(', ')}`);
    } catch (e) {
      fallas.push((e as Error).message);
    } finally {
      this.corriendo = false;
      await latirCron(this.knex, {
        jobKey: 'gastos_solicitud_kepler', label: 'Gastos: solicitudes de la Suite a Kepler', tenantId: MEGA,
        durationMs: Date.now() - t0, rowsAffected: m.intentados + m.vistos_en_ods + m.huerfanos + m.canceladas_en_kepler, fallas,
        note: `${m.intentados} intentadas · ${m.vistos_en_ods} vistas en el ODS · ${m.huerfanos} huérfanas · ${m.sin_ver_30min} sin ver tras 30 min · ${m.en_duda} en duda`
          + ` · ${m.canceladas_en_kepler} canceladas en Kepler (${m.canceladas_firmadas} con el vale firmado) · ${m.sin_vale_en_kepler} sin vale · ${m.contadores_atrasados.length} contadores atrasados`
          + ` · árbitro: ${m.vistos_en_ods + m.canceladas_en_kepler} las encontró el ciclo y no el aviso`,
        ceroEsOk: 'sin solicitudes firmadas esperando a Kepler: la escritura sigue apagada o ya se escribió todo',
      }).catch(() => undefined);
    }
    return m;
  }

  /**
   * R1 — el lazo de DESPUÉS de escribir, una pasada. Lee el estado de verdad (el vale contra `analytics.expense_requests`
   * y `kepler_ods.kdm1`), así que correrlo de más no hace daño y un aviso perdido no pierde nada. Lo corren el aviso del
   * ODS (`SolicitudPorEventoService`) y el ciclo de 5 min (árbitro).
   */
  async lazo(): Promise<ResultadoDelLazo> {
    const run: Ejecutor = (fn) => this.tk.run(MEGA, fn);
    // 0. Lo escrito tiene que aparecer en el ODS (la vista sobre kepler_ods).
    const vistos = await run(async (trx) => {
      const r = await trx.raw(
        `UPDATE finance.expense_proofs p SET kepler_request_status = 'seen_in_ods', updated_at = now()
           FROM analytics.expense_requests r
          WHERE p.tenant_id = ? AND p.origen = 'solicitud' AND p.kepler_request_status = 'written'
            AND r.tenant_id = p.tenant_id AND r.sucursal = p.sucursal AND r.folio = p.folio_solicitud`, [MEGA]);
      const sinVer = (await trx('finance.expense_proofs').where({ tenant_id: MEGA, origen: 'solicitud', kepler_request_status: 'written' })
        .whereRaw(`kepler_request_at < now() - interval '30 minutes'`).count<{ n: string }[]>({ n: '*' }))[0]?.n;
      return { n: Number(r.rowCount ?? 0), sinVer: Number(sinVer ?? 0) };
    });

    // ── R1 (anexo S §16): el lazo de DESPUÉS de escribir ─────────────────────────────────────
    // 1. Cancelada en Kepler → el vale lo sabe (DS8 v1: Finanzas cancela allá). NO se rechaza sola: el vale pudo
    //    pagarse ya en efectivo, y eso lo decide una persona. Queda `cancelled` con su nota y la alarma suena mientras
    //    el vale siga firmado. Sin esto, `seen_in_ods` era para siempre (control en prod, 2026-11-17: la misma unión
    //    sobre los vales de hoy encuentra los 43 validados con su solicitud cancelada).
    const cancelacion = await run(async (trx) => {
      const r = await trx.raw(
        `UPDATE finance.expense_proofs p
            SET kepler_request_status = 'cancelled', kepler_request_next_at = NULL, updated_at = now(),
                kepler_request_note = 'Se canceló en Kepler (folio ' || p.folio_solicitud || '): si el gasto ya no va, recházalo aquí'
           FROM analytics.expense_requests r
          WHERE p.tenant_id = ? AND p.origen = 'solicitud' AND p.kepler_request_status IN ('written', 'seen_in_ods')
            AND p.folio_solicitud IS NOT NULL
            AND r.tenant_id = p.tenant_id AND r.sucursal = p.sucursal AND r.folio = p.folio_solicitud AND r.estado = 'C'`, [MEGA]);
      const firmadas = (await trx('finance.expense_proofs').where({ tenant_id: MEGA, origen: 'solicitud', kepler_request_status: 'cancelled' })
        .whereNotNull('folio_solicitud').whereIn('status', FIRMADAS).count<{ n: string }[]>({ n: '*' }))[0]?.n;
      return { nuevas: Number(r.rowCount ?? 0), firmadas: Number(firmadas ?? 0) };
    });
    // 2. Huérfanas: una X-A-15 con la marca de la Suite (`c26 = SUITE SG-…`) que ningún vale reclama. Por la marca y
    //    NO por `c67 = 'SUITE'`: Kepler reescribe `c67` al cancelar, y PGP.79 pone `c67 = 'SUITE'` en solicitudes
    //    capturadas en Kepler. Deben ser 0 (medido en prod el 2026-11-17: 0, 12 ms).
    const huerfanas = await run(async (trx) => (await trx.raw(
      `SELECT k.sucursal::text AS sucursal, btrim(k.c6::text) AS folio, btrim(k.c26::text) AS marca
         FROM kepler_ods.kdm1 k
        WHERE k.c1 = k.sucursal AND k.c2 = 'X' AND k.c3 = 'A' AND k.c4 = 15 AND k.c5 = 1
          AND btrim(k.c26::text) LIKE 'SUITE SG-%'
          AND NOT EXISTS (SELECT 1 FROM finance.expense_proofs p
                           WHERE p.tenant_id = ? AND p.origen = 'solicitud'
                             AND p.sucursal = k.sucursal::text AND p.kepler_request_mark = btrim(k.c26::text))
        ORDER BY 1, 2 LIMIT 20`, [MEGA])).rows as Array<{ sucursal: string; folio: string; marca: string }>);
    return {
      vistos_en_ods: vistos.n, sin_ver_30min: vistos.sinVer,
      canceladas_en_kepler: cancelacion.nuevas, canceladas_firmadas: cancelacion.firmadas, huerfanas,
    };
  }

  private sucursal(s: unknown): string {
    const v = String(s ?? '').trim();
    if (!SUC.test(v)) throw new BadRequestException(`Sucursal inválida «${v}»: se esperan dos dígitos (00…08)`);
    return v;
  }

  /** S.17 (DS27): el alcance de almacén de quien pide, en el área `finanzas` (el mismo de la bandeja del SAT). */
  private async misAlmacenes(): Promise<AlmacenesDeQuienPide> {
    const d = (await this.scope.current('finanzas')).dims.warehouse;
    return { modo: d.mode, valores: d.values, resoluble: d.resolvable !== false };
  }

  /**
   * La sucursal pedida, si es una base de quien pide (`basesDeQuienPide`, la misma regla que `abiertas`). Si no, 403
   * con lo que la persona puede hacer: sin almacén en su ficha, que Sistemas se lo asigne.
   */
  private async base(sucursal: unknown): Promise<string> {
    const s = this.sucursal(sucursal);
    const a = await this.misAlmacenes();
    const r = basesDeQuienPide([s], a);
    if (r.bases.includes(s)) return s;
    if (r.alcance === 'sin_almacen') throw new ForbiddenException('Tu ficha no tiene almacén asignado: pídele a Sistemas que te asigne los tuyos para pedir gastos en la Suite');
    if (r.alcance === 'ninguna') throw new ForbiddenException('Tu usuario no tiene almacenes para pedir gastos');
    throw new ForbiddenException(`No puedes pedir gastos en la base ${s}: ${a.valores.length > 1 ? 'tus almacenes son' : 'tu almacén es'} ${a.valores.join(', ')}`);
  }
}

