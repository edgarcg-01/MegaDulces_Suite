import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { normalizarSucursal, urlDeServidor, valorDeEnv, type Env, type Resolucion } from '@megadulces/platform-core';

import { armarPagoKepler, escrituraDePagoEncendida, type FacturaAPagar, type PlanPagoKepler, type ProveedorKepler } from './pago-kepler.armador';

/** Una factura del pago, como la conoce la Suite: la llave del documento en Kepler y lo aplicado. */
export interface FacturaDelPago {
  /** `kdxe.c4` / `c5` / `c6` de la factura (`c3='A'`). Salen del `entity_ref` `oblig:suc|c4|c5|c6`. */
  tipo: number;
  subtipo: number;
  folio: string;
  aplicado: number;
}

export interface EntregaPagoKepler {
  /** El servidor: la sucursal de las facturas (`branch_code`; una sola por pago). */
  sucursal: string;
  fecha: string;
  hora: string;
  /** El folio de la Suite del pago: queda como referencia en `kdm1.c11` / `kdxe.c16`. */
  referencia: string;
  acreedor: string;
  importe: number;
  /** La cuenta de origen de la Suite, para resolver su código de tesorería en `kdb1`. */
  origen: { bank: string; account_label: string };
  destino: string | null;
  facturas: FacturaDelPago[];
}

export type ResultadoPagoKepler =
  | { estado: 'escrito'; kepler: { sucursal: string; folio: string; facturas: number } }
  | { estado: 'rechazado'; motivo: string };

/**
 * `[PGP.71]` Coordenada del `X-D-26` plantilla en ese servidor: `KEPLER_PAGO_TEMPLATE_FOLIO_<NN>`
 * (y `_SERIE_<NN>`, default `1`). ⛔ **Sin default en ningún servidor, ni en oficinas**: la
 * plantilla se elige leyéndola entera en el Kepler vivo (candidata en `00`: `1/0023768`). Sin la
 * variable, la escritura del pago en ese servidor queda apagada.
 */
export function plantillaPagoDe(sucursal: string, env: Env): Resolucion<{ serie: string; folio: string }> {
  const n = normalizarSucursal(sucursal);
  if (!n.ok) return n;
  const folio = valorDeEnv(env, `KEPLER_PAGO_TEMPLATE_FOLIO_${n.valor}`);
  const serie = valorDeEnv(env, `KEPLER_PAGO_TEMPLATE_SERIE_${n.valor}`) || '1';
  if (!/^\d{7}$/.test(folio)) {
    return { ok: false, motivo: `Falta KEPLER_PAGO_TEMPLATE_FOLIO_${n.valor}: no hay pago plantilla elegido en el servidor ${n.valor}` };
  }
  return { ok: true, valor: { serie, folio } };
}

/** Sólo nombres de columna de Kepler (`c1`…`c200`): lo que se interpola en el SQL nunca viene de fuera. */
const COLUMNA = /^c\d{1,3}$/;
function setDe(cols: Record<string, unknown>, desde: number): { sql: string; valores: unknown[] } {
  const ks = Object.keys(cols);
  for (const k of ks) if (!COLUMNA.test(k)) throw new Error(`Columna inválida en el plan: ${k}`);
  return { sql: ks.map((k, i) => `${k} = $${desde + i}`).join(', '), valores: ks.map((k) => cols[k]) };
}

/**
 * `[PGP.71]` C2 — **Escribe el pago `X-D-26` en Kepler.** Modelo: el de la requisición
 * (`KeplerRequisitionSinkAdapter`, ADR-092): se CLONA un documento que el ERP ya aceptó y se pisan
 * sólo los campos que el armador decidió (las 200 columnas de `kdm1` son `NOT NULL`).
 *
 * Lo vivo se lee de Kepler, nunca del ODS: el saldo de la factura puede haber cambiado desde la
 * última réplica, y el armador rechaza aplicar más de lo que Kepler dice hoy.
 *
 * ── Cuatro candados, y los cuatro tienen que estar abiertos ───────────────────────────────
 *   1. `KEPLER_PAGO_ESCRITURA=encendida` (apagado por default) · 2. `KEPLER_PUSH_URL_NN`
 *   3. `KEPLER_PAGO_TEMPLATE_FOLIO_NN` · 4. los `GRANT` en Kepler (INSERT en `kdxe`/`kdxf`,
 *   `UPDATE (c20)` en `kdxe`). Y antes de todo, la compuerta E3.3 del service.
 *
 * ⛔ **No es idempotente.** Llamarlo dos veces escribe dos pagos. Quien llama reclama el pago en
 * `payment_allocations.kepler_payment_folio` ANTES de llamar (lección de KR: la misma requisición
 * salió cuatro veces el 2026-10-13).
 *
 * Sin `LOCK TABLE` (Kepler está en uso): el folio `MAX+1` se calcula dentro del UPDATE y la llave
 * primaria rebota un choque sin daño. La baja de saldo lleva `c20 >= aplicado` en su WHERE: si
 * otro pago se adelantó, no afecta una fila y se deshace TODO.
 */
@Injectable()
export class KeplerPagoSinkAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(KeplerPagoSinkAdapter.name);
  private readonly pools = new Map<string, Pool>();

  /**
   * Las variables de entorno, en un método y no en el constructor: un parámetro sin token haría que
   * Nest intente inyectar `Object` y la API no arranque (el caso de #414). El ensayo lo reemplaza.
   */
  protected get env(): Env { return process.env; }

  private poolDe(url: string): Pool {
    let p = this.pools.get(url);
    if (!p) {
      p = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 8000, statement_timeout: 30000 });
      this.pools.set(url, p);
    }
    return p;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
  }

  /**
   * El único paso que ESCRIBE en el ERP. Aparte para que el ensayo
   * (`kepler-pago-sink.ensayo.spec.ts`) corra todo el SQL real y termine en ROLLBACK aquí.
   */
  protected async confirmar(c: PoolClient, plan: PlanPagoKepler, sucursal: string): Promise<void> {
    await c.query('INSERT INTO md.kdm1 SELECT * FROM _h');
    await c.query('INSERT INTO md.kdxe SELECT * FROM _e');
    await c.query('INSERT INTO md.kdxf SELECT * FROM _f');
    for (const s of plan.saldos) {
      const r = await c.query(
        `UPDATE md.kdxe SET c20 = c20 - $1
          WHERE btrim(c1)=$2 AND btrim(c2)=$3 AND c3='A' AND btrim(c4::text)=$4 AND btrim(c5::text)=$5 AND c6=$6
            AND c20 >= $1 - 0.005`,
        [s.menos, s.almacen, s.acreedor, String(s.tipo), String(s.subtipo), s.folio]);
      if (r.rowCount !== 1) throw new Error(`La factura ${s.tipo}-${s.subtipo}-${s.folio} de ${sucursal} ya no debe ${s.menos.toFixed(2)}: otro pago se adelantó`);
    }
    await c.query('COMMIT');
  }

  async entregar(e: EntregaPagoKepler): Promise<ResultadoPagoKepler> {
    if (!escrituraDePagoEncendida(this.env)) return { estado: 'rechazado', motivo: 'La escritura de pagos a Kepler está apagada (KEPLER_PAGO_ESCRITURA)' };
    const srv = urlDeServidor(e.sucursal, this.env);
    if (!srv.ok) return { estado: 'rechazado', motivo: srv.motivo };
    const pl = plantillaPagoDe(e.sucursal, this.env);
    if (!pl.ok) return { estado: 'rechazado', motivo: pl.motivo };
    const { serie, folio: folioPlantilla } = pl.valor;

    const c = await this.poolDe(srv.valor).connect();
    try {
      // ── El acreedor: debe existir en el catálogo de ESTE servidor ───────────────────────────
      const d = (await c.query(
        `SELECT btrim(c2) c2, btrim(c3) c3, btrim(coalesce(c10,'')) rfc, btrim(coalesce(c4,'')) dom, c16::text dias FROM md.kdxd WHERE btrim(c2)=$1 LIMIT 1`,
        [e.acreedor])).rows[0];
      if (!d) return { estado: 'rechazado', motivo: `Kepler (${e.sucursal}) no tiene al acreedor ${e.acreedor} en su catálogo (kdxd)` };
      // RFC, nombre y domicilio del último pago a ese acreedor (98.9 %); si no hay, del catálogo.
      const prev = (await c.query(
        `SELECT coalesce(c22,'') c22, coalesce(c32,'') c32, coalesce(c33,'') c33, coalesce(c34,'') c34, coalesce(c35,'') c35
           FROM md.kdm1 WHERE c1=$1 AND c2='X' AND c3='D' AND btrim(c4::text)='26' AND btrim(c10)=$2 AND c43 <> 'C'
          ORDER BY c6 DESC LIMIT 1`, [e.sucursal, e.acreedor])).rows[0];
      const dias = Number(d.dias);
      const proveedor: ProveedorKepler = prev
        ? { codigo: d.c2, rfc: prev.c22, nombre: prev.c32, domicilio: [prev.c33, prev.c34, prev.c35], dias: Number.isFinite(dias) ? dias : null }
        : { codigo: d.c2, rfc: d.rfc, nombre: d.c3, domicilio: [d.dom, '', ''], dias: Number.isFinite(dias) ? dias : null };

      // ── La cuenta de tesorería: UN código de kdb1 (18 de 18 cuentas resuelven, medido) ─────
      const digitos = (e.origen.account_label || '').replace(/\D/g, '');
      const banco = (e.origen.bank || '').toUpperCase().replace(/[^A-Z]/g, '');
      const cuentas = (await c.query(
        `SELECT btrim(c1) code FROM md.kdb1
          WHERE $1 <> '' AND (regexp_match(c2, '([0-9]{3,})'))[1] LIKE '%' || $1
            AND (regexp_replace(upper(c2),'[^A-Z]','','g') LIKE $2 || '%' OR $2 LIKE regexp_replace(upper(c2),'[^A-Z]','','g') || '%'
                 OR ($2 = 'BBAJIO' AND regexp_replace(upper(c2),'[^A-Z]','','g') = 'BAJIO'))`,
        [digitos, banco])).rows;
      if (cuentas.length !== 1) return { estado: 'rechazado', motivo: `La cuenta ${e.origen.bank} ${e.origen.account_label} corresponde a ${cuentas.length} cuentas de tesorería en Kepler (kdb1): se necesita exactamente una` };

      // ── Las facturas, con su saldo de HOY en Kepler ─────────────────────────────────────────
      const facturas: FacturaAPagar[] = [];
      for (const f of e.facturas) {
        const k = (await c.query(
          `SELECT btrim(e.c1) almacen, btrim(coalesce(e.c18,'')) concepto, e.c20::float8 saldo,
                  coalesce(m.c14::numeric,0)::float8 iva, coalesce(m.c15::numeric,0)::float8 ieps, coalesce(m.c16::numeric,0)::float8 total
             FROM md.kdxe e
             LEFT JOIN md.kdm1 m ON m.c1=e.c1 AND m.c2='X' AND m.c3='A' AND btrim(m.c4::text)=btrim(e.c4::text) AND btrim(m.c5::text)=btrim(e.c5::text) AND m.c6=e.c6
            WHERE btrim(e.c2)=$1 AND e.c3='A' AND btrim(e.c4::text)=$2 AND btrim(e.c5::text)=$3 AND e.c6=$4`,
          [e.acreedor, String(f.tipo), String(f.subtipo), f.folio])).rows;
        if (k.length !== 1) return { estado: 'rechazado', motivo: `La factura ${f.tipo}-${f.subtipo}-${f.folio} de ${e.acreedor} aparece ${k.length} veces en Kepler (${e.sucursal})` };
        facturas.push({ almacen: k[0].almacen, tipo: f.tipo, subtipo: f.subtipo, folio: f.folio, concepto: k[0].concepto,
          saldo: k[0].saldo, aplicado: f.aplicado, iva: k[0].iva, ieps: k[0].ieps, total: k[0].total });
      }

      const armado = armarPagoKepler({
        sucursal: e.sucursal, fecha: e.fecha, hora: e.hora, referencia: e.referencia, importe: e.importe,
        cuentaTesoreria: cuentas[0].code, destino: e.destino, proveedor, facturas,
      });
      if (!armado.ok) return { estado: 'rechazado', motivo: armado.motivos.join(' · ') };
      const plan = armado.plan;

      await c.query('BEGIN');
      const h = await c.query(
        `CREATE TEMP TABLE _h ON COMMIT DROP AS SELECT * FROM md.kdm1
          WHERE c1=$1 AND c2='X' AND c3='D' AND btrim(c4::text)='26' AND btrim(c5::text)=$2 AND c6=$3`,
        [e.sucursal, serie, folioPlantilla]);
      const ex = await c.query(
        `CREATE TEMP TABLE _e ON COMMIT DROP AS SELECT * FROM md.kdxe
          WHERE btrim(c1)=$1 AND c3='D' AND btrim(c4::text)='26' AND btrim(c5::text)=$2 AND c6=$3`,
        [e.sucursal, serie, folioPlantilla]);
      if (h.rowCount !== 1 || ex.rowCount !== 1) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: `No existe el pago plantilla X-D-26 ${e.sucursal}/${serie}/${folioPlantilla} en Kepler (kdm1 ${h.rowCount} · kdxe ${ex.rowCount})` };
      }

      // El folio se calcula DENTRO del UPDATE: no hay ventana entre leerlo y usarlo.
      await c.query(
        `UPDATE _h SET c6 = lpad(((SELECT max(c6::int) FROM md.kdm1
                                    WHERE c1=$1 AND c2='X' AND c3='D' AND btrim(c4::text)='26' AND btrim(c5::text)=$2) + 1)::text, 7, '0')`,
        [e.sucursal, serie]);
      const s1 = setDe(plan.kdm1, 1);
      await c.query(`UPDATE _h SET ${s1.sql}`, s1.valores);
      const folio: string = (await c.query('SELECT c6 FROM _h')).rows[0].c6;

      const s2 = setDe({ ...plan.kdxe, c6: folio }, 1);
      await c.query(`UPDATE _e SET ${s2.sql}`, s2.valores);

      await c.query('CREATE TEMP TABLE _f (LIKE md.kdxf) ON COMMIT DROP');
      for (const f of plan.kdxf) {
        const fila = { ...f, c6: folio };
        const ks = Object.keys(fila);
        for (const k of ks) if (!COLUMNA.test(k)) throw new Error(`Columna inválida en el plan: ${k}`);
        await c.query(`INSERT INTO _f (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map((k) => (fila as Record<string, unknown>)[k]));
      }

      await this.confirmar(c, plan, e.sucursal);
      this.logger.log(`Pago ${e.referencia} → Kepler ${e.sucursal}/X-D-26/${folio} (${plan.kdxf.length} facturas)`);
      return { estado: 'escrito', kepler: { sucursal: e.sucursal, folio, facturas: plan.kdxf.length } };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      const motivo = (err as Error).message;
      this.logger.error(`Pago ${e.referencia} rechazado por Kepler: ${motivo}`);
      return { estado: 'rechazado', motivo };
    } finally {
      c.release();
    }
  }
}
