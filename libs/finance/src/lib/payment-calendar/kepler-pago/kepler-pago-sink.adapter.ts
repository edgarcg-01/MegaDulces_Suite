import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { normalizarSucursal, urlDeServidor, valorDeEnv, type Env, type Resolucion } from '@megadulces/platform-core';

import { armarPagosKepler, escrituraDePagoEncendida, type FacturaAPagar, type PlanPagoKepler, type ProveedorKepler } from './pago-kepler.armador';
import { columnaAbonoKdxg, columnasKdc126, tablaPolizaDelMes } from '../../shared/kepler-contable';

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
  /** El folio de la Suite del pago: queda como referencia en `kdm1.c11` / `kdxe.c16` / la póliza `c7`. */
  referencia: string;
  acreedor: string;
  importe: number;
  /** La cuenta de origen de la Suite, para resolver su código de tesorería en `kdb1`. */
  origen: { bank: string; account_label: string };
  destino: string | null;
  facturas: FacturaDelPago[];
}

export type ResultadoPagoKepler =
  /** `folios`: un `X-D-26` por concepto (P7); todos con la misma referencia, escritos en una transacción. */
  | { estado: 'escrito'; kepler: { sucursal: string; folios: string[]; facturas: number } }
  | { estado: 'rechazado'; motivo: string };

/** Lo que `confirmar` pasa de las temporales a Kepler: los documentos ya armados y la tabla de pólizas del mes. */
export interface EscrituraPagoKepler {
  sucursal: string;
  /** `kdc2AAMM` del mes del pago (validada: `^kdc2\d{4}$`). */
  tablaPoliza: string;
  documentos: { folio: string; poliza: number; plan: PlanPagoKepler }[];
}

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

/** `YYYY-MM-DD` de un día del mes anterior (el 15): para la tabla de pólizas del mes anterior. */
export function mesAnterior(fecha: string): string {
  const a = Number(fecha.slice(0, 4)), m = Number(fecha.slice(5, 7));
  return m === 1 ? `${a - 1}-12-15` : `${a}-${String(m - 1).padStart(2, '0')}-15`;
}

/** Sólo nombres de columna de Kepler (`c1`…`c200`): lo que se interpola en el SQL nunca viene de fuera. */
const COLUMNA = /^c\d{1,3}$/;
const TABLA_POLIZA = /^kdc2\d{4}$/;
function setDe(cols: Record<string, unknown>, desde: number): { sql: string; valores: unknown[] } {
  const ks = Object.keys(cols);
  for (const k of ks) if (!COLUMNA.test(k)) throw new Error(`Columna inválida en el plan: ${k}`);
  return { sql: ks.map((k, i) => `${k} = $${desde + i}`).join(', '), valores: ks.map((k) => cols[k]) };
}

/** Copia la fila base (`desde`, una fila) a `hacia` y le pisa las columnas: así ninguna `NOT NULL` queda sin valor. */
async function clonarFila(c: PoolClient, desde: string, hacia: string, cols: Record<string, unknown>): Promise<void> {
  const r = await c.query(`INSERT INTO ${hacia} SELECT * FROM ${desde} RETURNING ctid::text AS t`);
  if (r.rowCount !== 1) throw new Error(`La fila base ${desde} trae ${r.rowCount} filas: se esperaba una`);
  const s = setDe(cols, 2);
  await c.query(`UPDATE ${hacia} SET ${s.sql} WHERE ctid = $1::tid`, [r.rows[0].t, ...s.valores]);
}

/** Inserta una fila construida entera (sin plantilla): `kdxf` y `kdm5`, cuyas columnas se conocen todas. */
async function insertarFila(c: PoolClient, hacia: string, fila: Record<string, unknown>): Promise<void> {
  const ks = Object.keys(fila);
  for (const k of ks) if (!COLUMNA.test(k)) throw new Error(`Columna inválida en el plan: ${k}`);
  await c.query(`INSERT INTO ${hacia} (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map((k) => fila[k]));
}

/**
 * `[PGP.71]` + `[PGP.106]` C2 — **Escribe el pago `X-D-26` en Kepler, con su contabilidad.** Modelo: el de la
 * requisición (`KeplerRequisitionSinkAdapter`, ADR-092): se CLONA un documento que el ERP ya aceptó y se pisan
 * sólo los campos que el armador decidió (las 200 columnas de `kdm1` son `NOT NULL`).
 *
 * Las ocho escrituras de un pago (FASE_PGP §4 «Deducido por ingeniería inversa»), todas en UNA transacción:
 *   `kdm1` · `kdm5` × N · `kdxe` · `kdxf` × N · `kdxe.c20` × N · `kdc2AAMM` × (N+1) · `kdxg` · `kdc126` × 2.
 * Un pago con facturas de varios conceptos (P7) sale como varios documentos con la misma referencia: o se
 * escriben todos o ninguno.
 *
 * Lo vivo se lee de Kepler, nunca del ODS: el saldo de la factura puede haber cambiado desde la
 * última réplica, y el armador rechaza aplicar más de lo que Kepler dice hoy.
 *
 * ── Cuatro candados, y los cuatro tienen que estar abiertos ───────────────────────────────
 *   1. `KEPLER_PAGO_ESCRITURA=encendida` (apagado por default) · 2. `KEPLER_PUSH_URL_NN`
 *   3. `KEPLER_PAGO_TEMPLATE_FOLIO_NN` · 4. los `GRANT` en Kepler. Y antes de todo, la compuerta E3.3 del service.
 *
 * ⛔ **No es idempotente.** Llamarlo dos veces escribe dos pagos. Quien llama reclama el pago en
 * `payment_allocations.kepler_payment_folio` ANTES de llamar (lección de KR: la misma requisición
 * salió cuatro veces el 2026-10-13).
 *
 * Sin `LOCK TABLE` (Kepler está en uso): el folio y el número de póliza son `MAX+1` leídos dentro de la
 * transacción. Un folio repetido lo rebota la llave primaria de `kdm1`; el número de póliza no tiene llave
 * medida, así que `confirmar` revisa antes del COMMIT que ningún otro documento lo haya tomado. La baja de saldo
 * lleva `c20 >= aplicado` en su WHERE y los acumulados exigen exactamente una fila: si algo no cuadra, se deshace TODO.
 *
 * ⚠️ `kdxg` y `kdc126` son los acumulados del AÑO en curso: un pago con fecha de otro año se rechaza (no se sabe
 * dónde guarda Kepler los años cerrados).
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
  /**
   * `YYYY-MM-DD` en México: el año de los acumulados. El ensayo lo puede fijar. Sin `todayMx` de platform-core a
   * propósito: el ensayo de `md` empaqueta sólo `kepler-servidor.ts` de esa librería (`empaquetar.js`).
   */
  protected get hoy(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date()); }

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
   * (`kepler-pago-sink.ensayo.spec.ts`, `ops/prod/ensayo-pago-kepler/ensayo.ts`) corra todo el SQL real y
   * termine en ROLLBACK aquí.
   */
  protected async confirmar(c: PoolClient, w: EscrituraPagoKepler): Promise<void> {
    if (!TABLA_POLIZA.test(w.tablaPoliza)) throw new Error(`Tabla de pólizas inválida: ${w.tablaPoliza}`);
    await c.query('INSERT INTO md.kdm1 SELECT * FROM _h');
    await c.query('INSERT INTO md.kdm5 SELECT * FROM _m5');
    await c.query('INSERT INTO md.kdxe SELECT * FROM _e');
    await c.query('INSERT INTO md.kdxf SELECT * FROM _f');
    await c.query(`INSERT INTO md.${w.tablaPoliza} SELECT * FROM _p`);

    for (const d of w.documentos) {
      for (const s of d.plan.saldos) {
        const r = await c.query(
          `UPDATE md.kdxe SET c20 = c20 - $1
            WHERE btrim(c1)=$2 AND btrim(c2)=$3 AND c3='A' AND btrim(c4::text)=$4 AND btrim(c5::text)=$5 AND c6=$6
              AND c20 >= $1 - 0.005`,
          [s.menos, s.almacen, s.acreedor, String(s.tipo), String(s.subtipo), s.folio]);
        if (r.rowCount !== 1) throw new Error(`La factura ${s.tipo}-${s.subtipo}-${s.folio} de ${w.sucursal} ya no debe ${s.menos.toFixed(2)}: otro pago se adelantó`);
      }
    }

    // El número de póliza se leyó como MAX+1: si otro documento lo tomó mientras tanto, no se escribe.
    const ajenas = (await c.query(
      `SELECT count(*)::int n FROM md.${w.tablaPoliza}
        WHERE c8='E' AND c1 = ANY($1::numeric[])
          AND NOT (btrim(c15)='X' AND btrim(c16)='D' AND btrim(c17::text)='26' AND btrim(c19) = ANY($2::text[]))`,
      [w.documentos.map((d) => d.poliza), w.documentos.map((d) => d.folio)])).rows[0].n;
    if (ajenas) throw new Error(`Otro documento tomó el número de póliza ${w.documentos.map((d) => d.poliza).join(', ')} en ${w.tablaPoliza}`);

    // Los acumulados. Todos los documentos son del mismo acreedor, año y mes (los arma un solo pago).
    const a0 = w.documentos[0].plan.acumulados;
    const fecha = String(w.documentos[0].plan.poliza.fecha);
    const abono = Math.round(w.documentos.reduce((s, d) => s + d.plan.acumulados.abonoAcreedor * 100, 0)) / 100;
    const colG = columnaAbonoKdxg(a0.mes);
    const g = await c.query(
      `UPDATE md.kdxg SET ${colG} = ${colG} + $1, c4 = greatest(c4, $2::timestamp), c7 = greatest(c7, $2::timestamp)
        WHERE btrim(c3)=$3 AND btrim(c1)='PESOS'`, [abono, fecha, a0.acreedor]);
    if (g.rowCount !== 1) throw new Error(`El acumulado del acreedor ${a0.acreedor} (kdxg) trae ${g.rowCount} filas en ${w.sucursal}: se esperaba una`);

    const porCuenta = new Map<string, { cargo: number; abono: number }>();
    for (const d of w.documentos) for (const m of d.plan.acumulados.cuentas) {
      const t = porCuenta.get(m.cuenta) ?? { cargo: 0, abono: 0 };
      porCuenta.set(m.cuenta, { cargo: t.cargo + Math.round(m.cargo * 100), abono: t.abono + Math.round(m.abono * 100) });
    }
    const k = columnasKdc126(a0.mes);
    for (const [cuenta, t] of porCuenta) {
      const r = await c.query(
        `UPDATE md.kdc126 SET ${k.cargo[0]} = ${k.cargo[0]} + $1, ${k.cargo[1]} = ${k.cargo[1]} + $1,
                              ${k.abono[0]} = ${k.abono[0]} + $2, ${k.abono[1]} = ${k.abono[1]} + $2
          WHERE btrim(c1)=$3`, [t.cargo / 100, t.abono / 100, cuenta]);
      if (r.rowCount !== 1) throw new Error(`El acumulado de la cuenta ${cuenta} (kdc126) trae ${r.rowCount} filas en ${w.sucursal}: se esperaba una`);
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
    const tablaPoliza = tablaPolizaDelMes(e.fecha);
    if (!tablaPoliza) return { estado: 'rechazado', motivo: `Fecha inválida «${e.fecha}»` };
    if (e.fecha.slice(0, 4) !== this.hoy.slice(0, 4)) {
      return { estado: 'rechazado', motivo: `El pago es de ${e.fecha.slice(0, 4)} y los acumulados de Kepler (kdxg, kdc126) son del año en curso: se captura a mano` };
    }

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
          `SELECT btrim(e.c1) almacen, btrim(coalesce(e.c18,'')) concepto, btrim(coalesce(e.c16,'')) referencia, e.c20::float8 saldo,
                  coalesce(m.c14::numeric,0)::float8 iva, coalesce(m.c15::numeric,0)::float8 ieps, coalesce(m.c16::numeric,0)::float8 total
             FROM md.kdxe e
             LEFT JOIN md.kdm1 m ON m.c1=e.c1 AND m.c2='X' AND m.c3='A' AND btrim(m.c4::text)=btrim(e.c4::text) AND btrim(m.c5::text)=btrim(e.c5::text) AND m.c6=e.c6
            WHERE btrim(e.c2)=$1 AND e.c3='A' AND btrim(e.c4::text)=$2 AND btrim(e.c5::text)=$3 AND e.c6=$4`,
          [e.acreedor, String(f.tipo), String(f.subtipo), f.folio])).rows;
        if (k.length !== 1) return { estado: 'rechazado', motivo: `La factura ${f.tipo}-${f.subtipo}-${f.folio} de ${e.acreedor} aparece ${k.length} veces en Kepler (${e.sucursal})` };
        facturas.push({ almacen: k[0].almacen, tipo: f.tipo, subtipo: f.subtipo, folio: f.folio, concepto: k[0].concepto, referencia: k[0].referencia,
          saldo: k[0].saldo, aplicado: f.aplicado, iva: k[0].iva, ieps: k[0].ieps, total: k[0].total });
      }

      const armado = armarPagosKepler({
        sucursal: e.sucursal, fecha: e.fecha, hora: e.hora, referencia: e.referencia, importe: e.importe,
        cuentaTesoreria: cuentas[0].code, destino: e.destino, proveedor, facturas,
      });
      if (!armado.ok) return { estado: 'rechazado', motivo: armado.motivos.join(' · ') };

      const existe = (await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`md.${tablaPoliza}`])).rows[0].ok;
      if (!existe) return { estado: 'rechazado', motivo: `Kepler (${e.sucursal}) no tiene la tabla de pólizas del mes (${tablaPoliza})` };

      await c.query('BEGIN');
      // ── Las filas base: el pago plantilla, su renglón de CxP y el abono 102 de su póliza ────
      const h = await c.query(
        `CREATE TEMP TABLE _h0 ON COMMIT DROP AS SELECT * FROM md.kdm1
          WHERE c1=$1 AND c2='X' AND c3='D' AND btrim(c4::text)='26' AND btrim(c5::text)=$2 AND c6=$3`,
        [e.sucursal, serie, folioPlantilla]);
      const ex = await c.query(
        `CREATE TEMP TABLE _e0 ON COMMIT DROP AS SELECT * FROM md.kdxe
          WHERE btrim(c1)=$1 AND c3='D' AND btrim(c4::text)='26' AND btrim(c5::text)=$2 AND c6=$3`,
        [e.sucursal, serie, folioPlantilla]);
      if (h.rowCount !== 1 || ex.rowCount !== 1) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: `No existe el pago plantilla X-D-26 ${e.sucursal}/${serie}/${folioPlantilla} en Kepler (kdm1 ${h.rowCount} · kdxe ${ex.rowCount})` };
      }
      // El renglón base de la póliza: el abono 102 más reciente de un X-D-26 en la tabla del MES DEL PAGO (y, si es
      // el primer pago del mes, del mes anterior). No el de la plantilla: Kepler tiene una tabla por mes y el permiso
      // se da tabla por tabla (ensayo del 2026-11-13: «permiso denegado a la tabla kdc22610», la de la plantilla).
      let tablaBase = '';
      for (const t of [tablaPoliza, tablaPolizaDelMes(mesAnterior(e.fecha))]) {
        if (!t) continue;
        const p0 = await c.query(
          `CREATE TEMP TABLE _p0 ON COMMIT DROP AS SELECT * FROM md.${t}
            WHERE c8='E' AND btrim(c15)='X' AND btrim(c16)='D' AND btrim(c17::text)='26' AND btrim(c3)='102' AND c4='A'
            ORDER BY c1 DESC LIMIT 1`);
        if (p0.rowCount === 1) { tablaBase = t; break; }
        await c.query('DROP TABLE _p0');
      }
      if (!tablaBase) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: `Kepler (${e.sucursal}) no tiene ninguna póliza de pago en ${tablaPoliza} ni en el mes anterior para tomarla de base` };
      }

      await c.query('CREATE TEMP TABLE _h (LIKE md.kdm1) ON COMMIT DROP');
      await c.query('CREATE TEMP TABLE _e (LIKE md.kdxe) ON COMMIT DROP');
      await c.query('CREATE TEMP TABLE _f (LIKE md.kdxf) ON COMMIT DROP');
      await c.query('CREATE TEMP TABLE _m5 (LIKE md.kdm5) ON COMMIT DROP');
      await c.query(`CREATE TEMP TABLE _p (LIKE md.${tablaPoliza}) ON COMMIT DROP`);

      // ── Folio y número de póliza: MAX+1, uno por documento ─────────────────────────────────
      const maxFolio = Number((await c.query(
        `SELECT coalesce(max(c6::int), 0) m FROM md.kdm1 WHERE c1=$1 AND c2='X' AND c3='D' AND btrim(c4::text)='26' AND btrim(c5::text)=$2`,
        [e.sucursal, serie])).rows[0].m);
      const maxPoliza = Number((await c.query(`SELECT coalesce(max(c1), 0)::int m FROM md.${tablaPoliza} WHERE c8='E'`)).rows[0].m);

      const documentos: EscrituraPagoKepler['documentos'] = [];
      for (const [i, { plan }] of armado.planes.entries()) {
        const folio = String(maxFolio + 1 + i).padStart(7, '0');
        const poliza = maxPoliza + 1 + i;
        await clonarFila(c, '_h0', '_h', { ...plan.kdm1, c6: folio });
        await clonarFila(c, '_e0', '_e', { ...plan.kdxe, c6: folio });
        for (const f of plan.kdxf) await insertarFila(c, '_f', { ...f, c6: folio });
        for (const r of plan.kdm5) await insertarFila(c, '_m5', { ...r, c5: serie, c6: folio });
        for (const r of plan.poliza.renglones) {
          await clonarFila(c, '_p0', '_p', { ...r, c1: poliza, c2: plan.poliza.fecha, c8: plan.poliza.tipo, c15: 'X', c16: 'D', c17: 26, c18: serie, c19: folio });
        }
        documentos.push({ folio, poliza, plan });
      }

      await this.confirmar(c, { sucursal: e.sucursal, tablaPoliza, documentos });
      const folios = documentos.map((x) => x.folio);
      this.logger.log(`Pago ${e.referencia} → Kepler ${e.sucursal}/X-D-26/${folios.join(', ')} (${e.facturas.length} facturas, póliza ${tablaPoliza} E ${documentos.map((x) => x.poliza).join(', ')})`);
      return { estado: 'escrito', kepler: { sucursal: e.sucursal, folios, facturas: e.facturas.length } };
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
