import { Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  PARAMETROS_PROPUESTOS,
  SALDO_CERO,
  decidirAutorizacion,
  porCobrarKeplerSuma,
  warehouseName,
} from '@megadulces/contracts';
import type {
  BandejaAutorizacion,
  FacturaDelCliente,
  Freshness,
  PagoDelCliente,
  ParametrosAutorizacion,
  PedidoPorAutorizar,
} from '@megadulces/contracts';
import { CustomerLedgerService } from './customer-ledger.service';

/**
 * `[GP.A.4]` **La bandeja «Por autorizar» de Crédito y cobranza** (anexo EA de GP, §3.6, aprobada por Edgar el
 * 2026-11-20). Lee los pedidos TELEMARK en `CREADO` del ODS y le aplica a cada uno `decidirAutorizacion`, la misma
 * regla que usará el automático. **No escribe nada**: autorizar es GP.A.2.
 *
 * Vive junto a Cartera porque ahí trabaja Crédito y cobranza, y reusa su fuente (tabla por evento o vista) y su
 * frescura en vez de copiarlas.
 *
 * Costo medido en prod el 2026-11-20 (sólo lectura): los pedidos que esperan, 21 ms; el «por cobrar» de Kepler de 30
 * clientes por `kdue_pkey`, 20 ms; su cartera por `ix_crc_cuenta`, 70 ms en frío.
 */

/** Lo que leen las consultas, ya en tipos de JS. Separado del armado para probarlo sin base. */
export interface LecturaBandeja {
  hoy: string;
  pedidos: Array<{
    sucursal: string; serie: number; folio: string; cliente: string; importe: number; fecha: string;
    nombre: string | null; limite: number | null; plazo: number | null; por_cobrar: number | null;
    /** `[D-A13]` El vendedor es de la ruta vecinal (`kdm1.c12` ~ `^[0-9]V[0-9]`, el mismo patrón que `ix_kdm1_ruta_vecinal`). */
    ruta_vecinal: boolean;
  }>;
  /** Los pedidos `U-D-40` sin cancelar ni salir (`c43` distinto de C y F) de esos clientes, cualquier estatus. */
  abiertos: Array<{ sucursal: string; cliente: string; serie: number; folio: string; importe: number; fecha: string }>;
  /** Sus cargos en la cartera, vivos y pagados. */
  facturas: Array<{ sucursal: string; cliente: string; saldo: number; importe: number; vencimiento: string | null; dias_pago: number | null }>;
  /** El interruptor por sucursal (tipo `autorizacion`). Sin renglón = apagado. */
  carril: Array<{ sucursal: string; encendida: boolean; tope_dia: number | null }>;
  freshness: Freshness;
  /** Ahora, para calcular la edad de los datos. */
  ahora: Date;
}

/** La cuenta de venta de contado de cada sucursal: no es un cliente con crédito. */
export const CONTADO = 'CONTADO';

const llave = (sucursal: string, cliente: string) => `${sucursal}|${cliente}`;

function mediana(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
}

function diasDesde(fecha: string, hoy: string): number | null {
  const a = Date.parse(`${fecha.slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${hoy.slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : null;
}

/** Cómo paga, de sus facturas pagadas (saldo en cero y con días de pago). */
export function pagoDelCliente(facturas: LecturaBandeja['facturas'], plazo: number | null): PagoDelCliente {
  const dias = facturas.filter((f) => f.saldo <= SALDO_CERO && f.dias_pago != null).map((f) => Number(f.dias_pago));
  return {
    facturas_pagadas: dias.length,
    mediana_dias: mediana(dias),
    a_tiempo: plazo == null || !dias.length ? null : dias.filter((d) => d <= plazo).length,
    peor_atraso: plazo == null || !dias.length ? null : Math.max(0, ...dias.map((d) => d - plazo)),
  };
}

/** El armado, puro: de lo leído a la bandeja. */
export function armarBandeja(l: LecturaBandeja, p: ParametrosAutorizacion): BandejaAutorizacion {
  const abiertosPor = new Map<string, LecturaBandeja['abiertos']>();
  for (const a of l.abiertos) {
    const k = llave(a.sucursal, a.cliente);
    abiertosPor.set(k, [...(abiertosPor.get(k) ?? []), a]);
  }
  const facturasPor = new Map<string, LecturaBandeja['facturas']>();
  for (const f of l.facturas) {
    const k = llave(f.sucursal, f.cliente);
    facturasPor.set(k, [...(facturasPor.get(k) ?? []), f]);
  }
  const carril = new Map(l.carril.map((c) => [c.sucursal, c]));
  const edad = l.freshness.data_as_of ? (l.ahora.getTime() - Date.parse(l.freshness.data_as_of)) / 60_000 : null;

  const todos: PedidoPorAutorizar[] = l.pedidos.map((x) => {
    const k = llave(x.sucursal, x.cliente);
    // Los OTROS pedidos abiertos del cliente, sin los viejos: un pedido muerto de hace meses no le come el crédito
    // a uno nuevo (Kepler tampoco los suma; los viejos se listan aparte, condición 7).
    const otros = (abiertosPor.get(k) ?? [])
      .filter((a) => !(a.serie === x.serie && a.folio === x.folio))
      .filter((a) => { const d = diasDesde(a.fecha, l.hoy); return d != null && d <= p.pedidoViejoDias; })
      .reduce((s, a) => s + a.importe, 0);
    const suyas = facturasPor.get(k) ?? [];
    const vivas: FacturaDelCliente[] = suyas.filter((f) => f.saldo > SALDO_CERO)
      .map((f) => ({ saldo: f.saldo, importe: f.importe, vencimiento: f.vencimiento }));
    const c = carril.get(x.sucursal);
    const resultado = decidirAutorizacion({
      hoy: l.hoy,
      pedido: { importe: x.importe, fecha: x.fecha, ruta_vecinal: x.ruta_vecinal },
      cliente: { nombre: x.nombre, limite: x.limite, es_contado: x.cliente === CONTADO },
      por_cobrar_kepler: x.por_cobrar,
      pedidos_abiertos: Math.round(otros * 100) / 100,
      facturas: vivas,
      edad_datos_min: edad,
      // NO MEDIDO hasta GP.A.2: la Suite todavía no registra cuántas autorizó hoy.
      carril: { encendido: c?.encendida ?? false, autorizados_hoy: 0, tope_dia: c?.tope_dia ?? null },
    }, p);
    return {
      sucursal: x.sucursal,
      sucursal_nombre: warehouseName(x.sucursal),
      serie: x.serie,
      folio: x.folio,
      fecha: x.fecha,
      dias_esperando: diasDesde(x.fecha, l.hoy),
      cliente: x.cliente,
      cliente_nombre: x.nombre,
      es_contado: x.cliente === CONTADO,
      ruta_vecinal: x.ruta_vecinal,
      importe: x.importe,
      resultado,
      limite: x.limite,
      plazo_dias: x.plazo,
      por_cobrar_kepler: x.por_cobrar,
      saldo_cartera: Math.round(vivas.reduce((s, f) => s + f.saldo, 0) * 100) / 100,
      otros_pedidos: Math.round(otros * 100) / 100,
      pago: pagoDelCliente(suyas, x.plazo),
    };
  });

  const porFecha = (a: PedidoPorAutorizar, b: PedidoPorAutorizar) => a.fecha.localeCompare(b.fecha) || a.folio.localeCompare(b.folio);
  return {
    hoy: l.hoy,
    freshness: l.freshness,
    parametros: { ...p, origen: 'propuesta' },
    // [D-A12] CONTADO no le toca a Crédito y cobranza: va en su propia lista (con el automático encendido, pasa solo).
    pendientes: todos.filter((t) => t.resultado.decision !== 'aparte' && !t.es_contado).sort(porFecha),
    aparte: todos.filter((t) => t.resultado.decision === 'aparte').sort(porFecha),
    contado: todos.filter((t) => t.resultado.decision !== 'aparte' && t.es_contado).sort(porFecha),
    sucursales_encendidas: l.carril.filter((c) => c.encendida).map((c) => c.sucursal).sort(),
    autorizados_hoy: null,
  };
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

@Injectable()
export class AutorizacionPedidosService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cartera: CustomerLedgerService,
  ) {}

  async bandeja(q: { sucursal?: string } = {}): Promise<BandejaAutorizacion> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const fuente = await this.cartera.fuenteCartera(trx);
      const freshness = await this.cartera.freshness(trx, fuente);
      const lectura = await leerBandeja(trx, tenantId, fuente.rel, q.sucursal, freshness, PARAMETROS_PROPUESTOS);
      return armarBandeja(lectura, PARAMETROS_PROPUESTOS);
    });
  }
}

/**
 * Las lecturas de la bandeja. Fuera de la clase porque el reporte previo a cada empuje
 * (`ops/prod/reporte-autorizacion-automatica`) corre ESTAS consultas contra prod en vez de copiarlas: si alguien
 * cambia la bandeja, el reporte cambia con ella.
 */
export async function leerBandeja(trx: Knex.Transaction, tenantId: string, rel: string, sucursal: string | undefined, freshness: Freshness, p: ParametrosAutorizacion): Promise<LecturaBandeja> {
    const filtro = sucursal ? 'AND k.sucursal = ?' : '';
    // La llave de Kepler va CRUDA (sin btrim) para entrar por las llaves primarias; ver POR_COBRAR_KEPLER_SQL.
    const ped = await trx.raw(`
      WITH h AS (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date AS hoy),
      p AS (
        SELECT k.sucursal, (k.c5)::int AS serie, k.c6 AS folio, k.c10 AS cliente, k.c16::numeric AS importe, k.c9::date AS fecha,
               btrim(coalesce(k.c12, '')) ~ '^[0-9]V[0-9]' AS ruta_vecinal
          FROM kepler_ods.kdm1 k
         WHERE k.c2 = 'U' AND k.c3 = 'D' AND k.c4 = 40 AND k.c1 = k.sucursal AND k.c27 = 'TELEMARK' AND k.c11 = 'CREADO'
           AND coalesce(k.c43, '') <> 'C' ${filtro}),
      -- CONTADO (la cuenta de venta de contado, una por sucursal) se deja fuera: no es un cliente con crédito y su
      -- cartera son 426 mil renglones (medido el 2026-11-20); sumarlos en cada lectura costaba casi todo el tiempo.
      c AS MATERIALIZED (SELECT DISTINCT sucursal, cliente FROM p WHERE cliente <> 'CONTADO'),
      -- MATERIALIZED a propósito: el planificador estima 1 pedido (hay ~800, con los muertos de Zamora Centro) y, sin
      -- esto, recalculaba el «por cobrar» de TODOS los clientes por cada pedido: medido el 2026-11-20, 245 s.
      m AS MATERIALIZED (SELECT c.sucursal, c.cliente, ${porCobrarKeplerSuma('x')} AS por_cobrar
              FROM c LEFT JOIN kepler_ods.kdue x ON x.sucursal = c.sucursal AND x.c1 = c.sucursal AND x.c2 = c.cliente
             GROUP BY 1, 2)
      SELECT p.sucursal, p.serie, p.folio, p.cliente, p.importe, p.fecha::text AS fecha, p.ruta_vecinal, h.hoy::text AS hoy,
             u.c3 AS nombre, u.c15::numeric AS limite, u.c16::numeric AS plazo, m.por_cobrar
        FROM p CROSS JOIN h
        LEFT JOIN m USING (sucursal, cliente)
        LEFT JOIN LATERAL (SELECT u.c3, u.c15, u.c16 FROM kepler_ods.kdud u
                            WHERE u.sucursal = p.sucursal AND btrim(u.c2) = p.cliente LIMIT 1) u ON true`,
      sucursal ? [sucursal] : []);
    const filas = ped.rows as Array<Record<string, unknown>>;
    const hoyRow = (await trx.raw(`SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text AS hoy`)).rows[0];
    const hoy = String(filas[0]?.['hoy'] ?? hoyRow.hoy);
    // Sin CONTADO (ver arriba): sus pedidos abiertos y su cartera no dicen nada de un cliente con crédito.
    const conCredito = filas.filter((r) => String(r['cliente']) !== CONTADO);
    const sucs = conCredito.map((r) => String(r['sucursal']));
    const clis = conCredito.map((r) => String(r['cliente']));

    // Primero los pedidos de los últimos N días por ix_kdm1_venta_fecha (MATERIALIZED: una sola pasada) y después se
    // cruzan con los clientes. Al revés, el planificador recorría todos los U-D-40 de la sucursal por cada cliente:
    // medido el 2026-11-20, 226–334 ms contra 80 ms así. Los viejos no cuentan: no le comen crédito a nadie.
    const abiertos = conCredito.length ? (await trx.raw(`
      WITH r AS MATERIALIZED (
        SELECT k.sucursal, k.c10 AS cliente, (k.c5)::int AS serie, k.c6 AS folio, k.c16::numeric AS importe, k.c9::date::text AS fecha
          FROM kepler_ods.kdm1 k
         WHERE k.c2 = 'U' AND k.c3 = 'D' AND (k.c9)::date >= (now() AT TIME ZONE 'America/Mexico_City')::date - ?::int
           AND k.c4 = 40 AND k.c1 = k.sucursal AND coalesce(k.c43, '') NOT IN ('C', 'F'))
      SELECT r.* FROM r JOIN unnest(?::text[], ?::text[]) AS q(sucursal, cliente) ON q.sucursal = r.sucursal AND q.cliente = r.cliente`,
      [p.pedidoViejoDias, sucs, clis])).rows : [];

    // `rel` sale de fuenteCartera (una de dos constantes), nunca de la petición.
    const facturas = conCredito.length ? (await trx.raw(`
      SELECT r.sucursal, r.cliente_code AS cliente, GREATEST(COALESCE(r.saldo_ajustado, 0), 0) AS saldo, r.importe,
             r.vencimiento::date::text AS vencimiento, r.dias_pago
        FROM ${rel} r
       WHERE r.tenant_id = ? AND r.cargo_abono = 'C'
         AND (r.sucursal, r.cliente_code) IN (SELECT * FROM unnest(?::text[], ?::text[]))`, [tenantId, sucs, clis])).rows : [];

    const carril = (await trx.raw(`
      SELECT sucursal, encendida, tope_dia FROM commercial.kepler_push_switch WHERE tenant_id = ? AND tipo = 'autorizacion'`, [tenantId])).rows;

    return {
      hoy,
      pedidos: filas.map((r) => ({
        sucursal: String(r['sucursal']), serie: Number(r['serie']), folio: String(r['folio']), cliente: String(r['cliente']),
        importe: Number(r['importe']), fecha: String(r['fecha']),
        nombre: r['nombre'] == null ? null : String(r['nombre']).trim(),
        limite: num(r['limite']), plazo: num(r['plazo']), por_cobrar: num(r['por_cobrar']),
        ruta_vecinal: r['ruta_vecinal'] === true,
      })),
      abiertos: (abiertos as Array<Record<string, unknown>>).map((r) => ({
        sucursal: String(r['sucursal']), cliente: String(r['cliente']), serie: Number(r['serie']), folio: String(r['folio']),
        importe: Number(r['importe']), fecha: String(r['fecha']),
      })),
      facturas: (facturas as Array<Record<string, unknown>>).map((r) => ({
        sucursal: String(r['sucursal']), cliente: String(r['cliente']), saldo: Number(r['saldo']), importe: Number(r['importe']),
        vencimiento: r['vencimiento'] == null ? null : String(r['vencimiento']), dias_pago: num(r['dias_pago']),
      })),
      carril: (carril as Array<Record<string, unknown>>).map((r) => ({
        sucursal: String(r['sucursal']), encendida: r['encendida'] === true, tope_dia: num(r['tope_dia']),
      })),
      freshness,
      ahora: new Date(),
    };
}
