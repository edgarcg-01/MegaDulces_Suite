import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import type {
  AcreedorEstadoCuentaResponse, AcreedorFicha, AcreedorResumen, AcreedorTipo, AcreedorTipoTotal, AcreedoresResponse,
} from '@megadulces/contracts';
import {
  CORTE_CONCENTRADOR, TOLERANCIA, armarEstado, clasificarAcreedor, nombreGrupo, r2, totalesEstado,
  type AplicacionCruda, type DocCrudo,
} from './creditor-statements.engine';

/**
 * `[ECA.1]` Estado de cuenta de acreedores — lectura pura sobre el ODS, sin importer (derive-no-copy).
 *
 *  · Documentos  = `kepler_ods.kdxe`: c2 acreedor · c3 naturaleza (`A` sube la deuda, `D` la baja) ·
 *                  c4/c5 tipo y subtipo · c6 folio · c7 fecha · c10 vence (1800 = sin fecha) ·
 *                  c11 importe · c16 referencia.
 *  · Casamiento  = `kepler_ods.kdxf`: el cargo (c4,c5,c6) se aplicó al abono (c7,c8,c9) por c10.
 *  · Nombres     = `kepler_ods.kdmm` (c1='X', c2 naturaleza, c3 tipo, c4 subtipo → c5).
 *  · Catálogo    = `kepler_ods.kdxd`: c3 nombre · c10 RFC · c12 agente · c13 grupo · c14 zona · c15 límite ·
 *                  c16 días de crédito. Un mismo acreedor puede estar en el catálogo de varias
 *                  sucursales: manda el del 00 y, si no está ahí, el de su sucursal.
 *
 * Réplica cruzada: la 03 trae 734 documentos de la 02 → `btrim(c1) = sucursal` (filtro canónico, Fase PO).
 * Costo medido en prod (2026-10-07): el resumen de los ~680 acreedores en ~450 ms; un estado de cuenta
 * de Mondelez (el acreedor con más documentos de mercancía) en menos de 100 ms.
 * `kepler_ods.*` no tiene tenant ni RLS.
 */
const SQL_RESUMEN = `
WITH e AS (
  SELECT sucursal, c2, btrim(c2) AS prov, c3, c4, c5, c6, c7::date AS fecha, c10::date AS vence, c11
    FROM kepler_ods.kdxe WHERE btrim(c1) = sucursal
),
p AS (SELECT ?::numeric AS tol, ?::date AS hoy, ?::date AS corte),
ap AS (SELECT * FROM kepler_ods.kdxf WHERE btrim(c1) = sucursal),
aa AS (SELECT sucursal, c2, c7 AS t, c8 AS s, c9 AS f, sum(c10) AS m FROM ap GROUP BY 1,2,3,4,5),
ad AS (SELECT sucursal, c2, c4 AS t, c5 AS s, c6 AS f, sum(c10) AS m FROM ap GROUP BY 1,2,3,4,5),
doc AS (
  SELECT e.sucursal, e.prov, e.c3 AS nat, e.fecha, e.vence,
         e.c11 - coalesce(CASE WHEN e.c3 = 'A' THEN aa.m ELSE ad.m END, 0) AS pend
    FROM e
    LEFT JOIN aa ON e.c3 = 'A' AND aa.sucursal = e.sucursal AND aa.c2 = e.c2 AND aa.t = e.c4 AND aa.s = e.c5 AND aa.f = e.c6
    LEFT JOIN ad ON e.c3 = 'D' AND ad.sucursal = e.sucursal AND ad.c2 = e.c2 AND ad.t = e.c4 AND ad.s = e.c5 AND ad.f = e.c6
),
cat AS (
  SELECT DISTINCT ON (btrim(c2)) btrim(c2) AS prov, btrim(c3) AS nombre,
         nullif(btrim(c10), '') AS rfc, nullif(btrim(c13), '') AS grupo
    FROM kepler_ods.kdxd ORDER BY btrim(c2), (sucursal <> '00'), sucursal
)
SELECT d.prov AS codigo, cat.nombre, cat.rfc, cat.grupo,
       array_agg(DISTINCT d.sucursal ORDER BY d.sucursal) AS sucursales,
       count(*) FILTER (WHERE d.nat = 'A' AND d.pend > p.tol)                                       AS documentos_pendientes,
       coalesce(sum(d.pend) FILTER (WHERE d.nat = 'A' AND d.pend > p.tol), 0)                       AS pendiente,
       coalesce(sum(d.pend) FILTER (WHERE d.nat = 'A' AND d.pend > p.tol
                                      AND d.vence >= '1900-01-01' AND d.vence < p.hoy), 0)          AS vencido,
       coalesce(sum(d.pend) FILTER (WHERE d.nat = 'D' AND d.pend > p.tol), 0)                       AS pagos_sin_aplicar,
       coalesce(sum(d.pend) FILTER (WHERE d.nat = 'A'), 0)                                          AS saldo_documentos,
       coalesce(sum(d.pend) FILTER (WHERE d.nat = 'A' AND d.pend > p.tol
                                      AND d.sucursal <> '00' AND d.fecha < p.corte), 0)             AS pendiente_sucursal_antes_corte,
       to_char(max(d.fecha), 'YYYY-MM-DD')                                                           AS ultimo_movimiento
  FROM doc d
 CROSS JOIN p
  LEFT JOIN cat ON cat.prov = d.prov
 GROUP BY d.prov, cat.nombre, cat.rfc, cat.grupo`;

const SQL_DOCS = `
SELECT e.sucursal, e.c3 AS naturaleza, e.c4 AS tipo_doc, e.c5 AS sub, btrim(e.c6) AS folio,
       m.c5 AS documento, to_char(e.c7, 'YYYY-MM-DD') AS fecha, to_char(e.c10, 'YYYY-MM-DD') AS vence,
       e.c16 AS referencia, e.c11 AS importe
  FROM kepler_ods.kdxe e
  LEFT JOIN LATERAL (
    SELECT k.c5 FROM kepler_ods.kdmm k
     WHERE k.sucursal = '00' AND k.c1 = 'X' AND k.c2 = e.c3 AND k.c3::text = e.c4::text AND k.c4::text = e.c5::text
     LIMIT 1
  ) m ON true
 WHERE e.c2 = ? AND btrim(e.c1) = e.sucursal`;

const SQL_APPS = `
SELECT f.sucursal, f.c7 AS doc_tipo, f.c8 AS doc_sub, btrim(f.c9) AS doc_folio,
       f.c4 AS pago_tipo, f.c5 AS pago_sub, btrim(f.c6) AS pago_folio,
       m.c5 AS pago_documento, to_char(d.c7, 'YYYY-MM-DD') AS pago_fecha, d.c16 AS pago_referencia,
       f.c10 AS importe
  FROM kepler_ods.kdxf f
  LEFT JOIN kepler_ods.kdxe d
    ON d.sucursal = f.sucursal AND d.c1 = f.c1 AND d.c2 = f.c2 AND d.c3 = 'D' AND d.c4 = f.c4 AND d.c5 = f.c5 AND d.c6 = f.c6
  LEFT JOIN LATERAL (
    SELECT k.c5 FROM kepler_ods.kdmm k
     WHERE k.sucursal = '00' AND k.c1 = 'X' AND k.c2 = 'D' AND k.c3::text = f.c4::text AND k.c4::text = f.c5::text
     LIMIT 1
  ) m ON true
 WHERE f.c2 = ? AND btrim(f.c1) = f.sucursal`;

const SQL_FICHA = `
SELECT btrim(c3) AS nombre, nullif(btrim(c10), '') AS rfc, nullif(btrim(c7), '') AS telefono,
       nullif(concat_ws(', ', nullif(btrim(c4), ''), nullif(btrim(c5), ''), nullif(btrim(c6), '')), '') AS direccion,
       nullif(btrim(c12), '') AS agente, nullif(btrim(c13), '') AS grupo, nullif(btrim(c14), '') AS zona,
       c15 AS limite, c16 AS dias
  FROM kepler_ods.kdxd
 WHERE btrim(c2) = ?
 ORDER BY (sucursal <> '00'), sucursal
 LIMIT 1`;

const TIPOS: AcreedorTipo[] = ['mercancia', 'servicios', 'financiero', 'sin_clasificar', 'interno'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** Claves de Kepler: letras, números, punto y guion (`CM009`, `B.B.FAC`, `TC1852`). */
const CODIGO = /^[A-Za-z0-9.\-]{1,20}$/;

const numOnull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null;
};

export interface EstadoCuentaQuery { pendientes?: boolean; from?: string; to?: string }

/** Renglón de `SQL_RESUMEN` (Postgres devuelve `numeric` como texto). */
interface ResumenCrudo {
  codigo: string;
  nombre: string | null;
  rfc: string | null;
  grupo: string | null;
  sucursales: string[] | null;
  documentos_pendientes: string | number;
  pendiente: string | number;
  vencido: string | number;
  pagos_sin_aplicar: string | number;
  saldo_documentos: string | number;
  pendiente_sucursal_antes_corte: string | number;
  ultimo_movimiento: string | null;
}

/** Renglón de `SQL_FICHA`. */
interface FichaCruda {
  nombre: string | null;
  rfc: string | null;
  telefono: string | null;
  direccion: string | null;
  agente: string | null;
  grupo: string | null;
  zona: string | null;
  limite: string | number | null;
  dias: string | number | null;
}

@Injectable()
export class CreditorStatementsService {
  private readonly logger = new Logger(CreditorStatementsService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /** Hoy en hora de México (AAAA-MM-DD): decide qué está vencido. */
  hoy(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  }

  async resumen(): Promise<AcreedoresResponse> {
    const hoy = this.hoy();
    const t0 = Date.now();
    const rows: ResumenCrudo[] = await this.tk.run(async (trx) => {
      const r = await trx.raw(SQL_RESUMEN, [TOLERANCIA, hoy, CORTE_CONCENTRADOR]);
      return r.rows as ResumenCrudo[];
    });
    const acreedores: AcreedorResumen[] = rows.map((x) => {
      const pagos = r2(x.pagos_sin_aplicar);
      return {
        codigo: x.codigo,
        nombre: x.nombre || x.codigo,
        rfc: x.rfc,
        grupo: x.grupo,
        grupo_nombre: nombreGrupo(x.grupo),
        tipo: clasificarAcreedor(x.codigo, x.grupo),
        sucursales: x.sucursales || [],
        documentos_pendientes: Number(x.documentos_pendientes) || 0,
        pendiente: r2(x.pendiente),
        vencido: r2(x.vencido),
        pagos_sin_aplicar: pagos,
        saldo: r2(r2(x.saldo_documentos) - pagos),
        pendiente_sucursal_antes_corte: r2(x.pendiente_sucursal_antes_corte),
        ultimo_movimiento: x.ultimo_movimiento,
      };
    });
    acreedores.sort((a, b) => b.saldo - a.saldo || a.nombre.localeCompare(b.nombre));

    const totales: AcreedorTipoTotal[] = TIPOS.map((tipo) => {
      const de = acreedores.filter((a) => a.tipo === tipo);
      const sum = (k: 'pendiente' | 'vencido' | 'pagos_sin_aplicar' | 'saldo' | 'pendiente_sucursal_antes_corte') =>
        r2(de.reduce((t, a) => t + a[k], 0));
      return {
        tipo,
        acreedores: de.length,
        pendiente: sum('pendiente'),
        vencido: sum('vencido'),
        pagos_sin_aplicar: sum('pagos_sin_aplicar'),
        saldo: sum('saldo'),
        pendiente_sucursal_antes_corte: sum('pendiente_sucursal_antes_corte'),
      };
    });
    this.logger.debug(`resumen: ${acreedores.length} acreedores en ${Date.now() - t0} ms`);
    return { totales, acreedores, al: hoy };
  }

  async estadoCuenta(codigoIn: string, q: EstadoCuentaQuery): Promise<AcreedorEstadoCuentaResponse> {
    const codigo = (codigoIn || '').trim();
    if (!CODIGO.test(codigo)) throw new BadRequestException('Clave de acreedor no válida.');
    const solo = q.pendientes !== false;
    let periodo: { from: string; to: string } | null = null;
    if (!solo) {
      if (!q.from || !q.to || !ISO.test(q.from) || !ISO.test(q.to)) {
        throw new BadRequestException('Para ver todo el periodo se necesitan "from" y "to" con formato AAAA-MM-DD.');
      }
      if (q.from > q.to) throw new BadRequestException('"from" no puede ser posterior a "to".');
      periodo = { from: q.from, to: q.to };
    }
    const hoy = this.hoy();

    const { docs, apps, ficha } = await this.tk.run(async (trx) => {
      const [d, a, f] = await Promise.all([
        trx.raw(SQL_DOCS, [codigo]),
        trx.raw(SQL_APPS, [codigo]),
        trx.raw(SQL_FICHA, [codigo]),
      ]);
      return { docs: d.rows as DocCrudo[], apps: a.rows as AplicacionCruda[], ficha: (f.rows[0] as FichaCruda | undefined) ?? null };
    });
    if (!ficha && !docs.length) throw new NotFoundException(`No hay acreedor ${codigo} en Kepler.`);

    const armado = armarEstado(docs, apps, hoy);
    const enPeriodo = (f: string | null) => !periodo || (!!f && f >= periodo.from && f <= periodo.to);
    const documentos = armado.documentos.filter((d) =>
      solo ? d.estado !== 'pagado' : enPeriodo(d.fecha));
    const pagos = armado.pagos_sin_aplicar.filter((p) => solo || enPeriodo(p.fecha));

    const acreedor: AcreedorFicha = {
      codigo,
      nombre: ficha?.nombre || codigo,
      rfc: ficha?.rfc ?? null,
      direccion: ficha?.direccion ?? null,
      telefono: ficha?.telefono ?? null,
      grupo: ficha?.grupo ?? null,
      grupo_nombre: nombreGrupo(ficha?.grupo),
      zona: ficha?.zona ?? null,
      agente: ficha?.agente ?? null,
      tipo: clasificarAcreedor(codigo, ficha?.grupo),
      dias_credito: numOnull(ficha?.dias),
      limite_credito: numOnull(ficha?.limite),
    };
    return {
      acreedor,
      solo_pendientes: solo,
      periodo,
      documentos,
      pagos_sin_aplicar: pagos,
      totales: totalesEstado(documentos, pagos),
      al: hoy,
    };
  }
}
