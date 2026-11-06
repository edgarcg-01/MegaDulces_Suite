import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

import {
  MARCA_COTIZACION, plantillaTlmkDe, urlDeServidor,
} from '../commercial-replenishment/kepler-servidores';
import { CAPTURISTA_SUITE, horaMx, textoKepler } from '../commercial-replenishment/kepler-requisition-sink.adapter';
import { factorPresentacionFicha } from '../commercial-replenishment/ficha-kepler';
import { armarPedidoTlmk, renglonesObservaciones, type FichaTlmk, type RenglonCotizacion } from './kepler-pedido-tlmk';

export interface PedidoTlmkEntrada {
  cotizacion_id: string;
  /** Folio de la cotización (`COT-YYYY-NNNNN`): la marca de la Suite en `c24`. */
  folio_suite: string;
  /** Sucursal Kepler de la cotización (`source_branch`): ahí se crea el pedido. */
  sucursal: string;
  /** Clave del cliente en Kepler (`erp_customer_code` → `c10`). */
  cliente: string;
  /** Clave del vendedor en Kepler (`salesperson_code` → `c12`). */
  vendedor: string;
  /** `YYYY-MM-DD` en hora de México. */
  fecha: string;
  /** `terms_discount_pct` congelado de la cotización. */
  pct_cliente: number | null;
  /** Domicilio de entrega (`delivery_address_key` → `c115`, «Dirección Envío»). null = el cliente no tiene: `c115` vacío. */
  direccion_envio: string | null;
  /** COT.28: observaciones del pedido → «Comentarios» renglones 2 y 3 (`c25`, `c26`; 60 + 60). */
  observaciones?: string | null;
  renglones: RenglonCotizacion[];
  /** Tope diario del interruptor (`kepler_push_switch.tope_dia`); null = sin tope. */
  tope_dia: number | null;
}

export type PedidoTlmkResultado =
  | { estado: 'entregado'; ya_estaba?: boolean; kepler: { sucursal: string; folio: string; renglones: number; total: number } }
  | { estado: 'rechazado'; motivo: string; motivos?: string[] };

/** Lo que el pedido copia del cliente: nombre, RFC, domicilio (`c33`–`c35`) y condición de pago (`c30`). */
interface DatosCliente { nombre: string; rfc: string; c33: string; c34: string; c35: string; c30: string }

/**
 * `[COT.37]` La «Dirección Envío» de la pantalla del pedido es **`c115`**, no `c85`. Medido el
 * 2026-11-06 en los pedidos TELEMARK capturados por el personal (todas las sucursales, desde sep):
 * mientras el pedido no se embarca, `c85` = **0** siempre (398 de 398) y la dirección va en `c115`
 * (vacía si el cliente no tiene direcciones en `kdudent`: 185 de 185); al embarcar, Kepler iguala
 * `c85` a `c115` (2,658 de 2,668). La Suite escribía la dirección en `c85` y dejaba `c115` como
 * venía de la plantilla: el pedido 0003826 surtido mostraba «Dirección Envío» vacía.
 */
export const C85_AL_CREAR = '0';

/** El documento: `U-D-40` con origen TELEMARK. Medido en 7,900 pedidos (ERP_KEPLER §3.y.3). */
const DOC = { genero: 'U', naturaleza: 'D', grupo: '40', origen: 'TELEMARK', estado: 'CREADO' } as const;

/**
 * Columnas que llena el PROCESO, no la creación. Un pedido nuevo nace con ellas vacías: los
 * responsables de surtir/checar/embarcar (`c100`/`c102`/`c103`, 0 % en los recién creados, igual
 * que el traspaso) y la logística (`c83` transporte · `c84` chofer · `c86` guía). La plantilla es
 * un pedido `CREADO`, pero si alguien la elige mal no se arrastra nada de otro pedido.
 */
const LIMPIAR = ['c100', 'c102', 'c103', 'c83', 'c84', 'c86'] as const;

/**
 * `[COT.7.2]` — **Escribe la cotización aceptada como «Pedido Telemarketing» en Kepler.**
 *
 * ADR-113 (extiende ADR-092). Mismo método que la requisición de KR, sobre sus piezas puras:
 * CLONAR un pedido TELEMARK del propio servidor (las 200 columnas de `kdm1` y 70 de `kdm2` son
 * `NOT NULL`) y pisar sólo los campos de negocio, que arma `armarPedidoTlmk` con la ficha
 * (`md.kdii`) del servidor destino. Folio `MAX+1` dentro del `UPDATE`: si dos compiten, la llave
 * primaria rebota y se deshace todo. Todo o nada.
 *
 * Los candados, independientes: `KEPLER_PUSH_URL_<NN>` (conexión) · `KEPLER_TLMK_TEMPLATE_FOLIO_<NN>`
 * (plantilla, sin default) · `kepler_push_switch` tipo `telemarketing` (lo lee el servicio) ·
 * `GRANT INSERT` en la base de Kepler.
 *
 * ⛔ **No es idempotente**: llamarlo dos veces escribe dos pedidos. La idempotencia es de quien
 * llama (`commercial.quotes.kepler_folio`).
 */
@Injectable()
export class KeplerPedidoTlmkSinkAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(KeplerPedidoTlmkSinkAdapter.name);
  private readonly pools = new Map<string, Pool>();

  private poolDe(url: string): Pool {
    let p = this.pools.get(url);
    if (!p) {
      p = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 8000, statement_timeout: 30000 });
      this.pools.set(url, p);
    }
    return p;
  }

  async onModuleDestroy() {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
  }

  /** Conexión y plantilla de esa sucursal: lo que el interruptor necesita para decir si está configurada. */
  configuracion(sucursal: string): { ok: true } | { ok: false; falta: string } {
    const srv = urlDeServidor(sucursal, process.env);
    if (!srv.ok) return { ok: false, falta: srv.motivo };
    const pl = plantillaTlmkDe(sucursal, process.env);
    if (!pl.ok) return { ok: false, falta: pl.motivo };
    return { ok: true };
  }

  /** Lee un catálogo de Kepler; si el usuario de escritura no tiene permiso, devuelve el motivo con el GRANT que falta. */
  private async leerCatalogo(c: PoolClient, sql: string, args: unknown[], tabla: string): Promise<Record<string, string>[] | string> {
    try {
      return (await c.query(sql, args)).rows;
    } catch (err) {
      if ((err as { code?: string }).code === '42501') {
        return `El usuario de escritura no puede leer md.${tabla} en Kepler (falta GRANT SELECT ON md.${tabla}) y no hay un documento previo que lo resuelva`;
      }
      throw err;
    }
  }

  /** El único paso que ESCRIBE. Aparte para que un ensayo corra todo el SQL y termine en ROLLBACK. */
  protected async confirmar(c: PoolClient): Promise<void> {
    await c.query('INSERT INTO md.kdm1 SELECT * FROM _h');
    await c.query('INSERT INTO md.kdm2 SELECT * FROM _l');
    await c.query('COMMIT');
  }

  async entregar(e: PedidoTlmkEntrada): Promise<PedidoTlmkResultado> {
    if (!e.renglones.length) return { estado: 'rechazado', motivo: 'La cotización no tiene renglones' };
    if (!e.folio_suite.startsWith(MARCA_COTIZACION)) return { estado: 'rechazado', motivo: `El folio ${e.folio_suite} no es de cotización` };
    const srv = urlDeServidor(e.sucursal, process.env);
    if (!srv.ok) return { estado: 'rechazado', motivo: srv.motivo };
    const pl = plantillaTlmkDe(e.sucursal, process.env);
    if (!pl.ok) return { estado: 'rechazado', motivo: pl.motivo };
    const tmpl = pl.valor;
    let obs: [string, string];
    try { obs = renglonesObservaciones(e.observaciones); } catch (err) { return { estado: 'rechazado', motivo: (err as Error).message }; }

    const c = await this.poolDe(srv.valor).connect();
    try {
      // ⭐ Idempotencia EN EL ERP: si ya hay un pedido con la marca de esta cotización, es el
      // nuestro (de un envío cuya respuesta se perdió, o de otro clic). Se devuelve ese folio en vez
      // de escribir otro. La Suite también guarda el folio, pero un corte entre el COMMIT de Kepler
      // y el UPDATE de la Suite dejaría la cotización sin folio y el pedido escrito.
      const ya = await c.query(
        `SELECT c6, c16::text AS total, (SELECT count(*)::int FROM md.kdm2 l WHERE l.c1 = k.c1 AND l.c2 = k.c2 AND l.c3 = k.c3
                 AND l.c4 = k.c4 AND l.c5 = k.c5 AND l.c6 = k.c6) AS n
           FROM md.kdm1 k WHERE c1 = $1 AND c2 = 'U' AND c3 = 'D' AND btrim(c4::text) = '40'
            AND (btrim(c24) = $2 OR btrim(c24) LIKE ($2::text || ' %'))
          ORDER BY c6 LIMIT 1`, [e.sucursal, e.folio_suite]);
      // [COT.36] «empieza con el folio y un espacio», no sólo igual: el personal le agrega texto en
      // Kepler («COT-2026-00142    CJA 4, PAQ 6, U1»; 10 de 11 pedidos medidos el 2026-11-06) y la
      // comparación exacta ya no lo encontraba. El espacio evita que COT-2026-0014 case con 00142.
      if (ya.rowCount) {
        const r = ya.rows[0];
        this.logger.warn(`Cotización ${e.folio_suite} ya estaba en Kepler ${e.sucursal}/${r.c6}: no se escribe otra vez`);
        return { estado: 'entregado', ya_estaba: true, kepler: { sucursal: e.sucursal, folio: String(r.c6), renglones: Number(r.n), total: Number(r.total) } };
      }

      // ── El cliente y el vendedor tienen que existir EN ESTE servidor ─────────────────────
      // Un código válido en la Suite y desconocido para el ERP no falla al escribir: produce un
      // pedido que apunta a nadie. Primero el PRECEDENTE: lo que Kepler mismo le escribió a ese
      // cliente en su último documento de venta aquí (nombre, RFC, domicilio, condición de pago;
      // medido: c32 = kdud.c3 y c22 = kdud.c10 en 748/749). Sólo sin precedente se lee el catálogo
      // (`kdud`), que el usuario de escritura puede no tener otorgado (ensayo 2026-11-03: 01 y 06
      // responden «permiso denegado a la tabla kdud»).
      const cliente = e.cliente.trim();
      const vendedor = e.vendedor.trim();
      let cli = (await c.query(
        `SELECT btrim(c32) AS nombre, coalesce(c22,'') AS rfc, coalesce(c33,'') AS c33, coalesce(c34,'') AS c34,
                coalesce(c35,'') AS c35, coalesce(c30,'') AS c30
           FROM md.kdm1
          WHERE c1 = $1 AND c2 = 'U' AND c3 = 'D' AND btrim(c4::text) IN ('40', '8', '5', '12') AND btrim(c10) = $2
            AND btrim(coalesce(c32,'')) <> ''
          ORDER BY (btrim(c27) = 'TELEMARK') DESC, c9 DESC, c6 DESC LIMIT 1`, [e.sucursal, cliente])).rows[0] as DatosCliente | undefined;
      if (!cli) {
        const cat = await this.leerCatalogo(c,
          `SELECT btrim(c3) AS nombre, coalesce(c10,'') AS rfc, coalesce(c4,'') AS c33, coalesce(c5,'') AS c34,
                  coalesce(c6,'') AS c35, '' AS c30 FROM md.kdud WHERE btrim(c2) = $1 LIMIT 1`, [cliente], 'kdud');
        if (typeof cat === 'string') return { estado: 'rechazado', motivo: cat };
        cli = cat[0] as unknown as DatosCliente | undefined;
        if (!cli) return { estado: 'rechazado', motivo: `Kepler (sucursal ${e.sucursal}) no tiene al cliente ${cliente} en su catálogo (kdud)` };
      }
      const vendConocido = await c.query(
        `SELECT 1 FROM md.kdm1 WHERE c1 = $1 AND c2 = 'U' AND c3 = 'D' AND btrim(c4::text) IN ('40', '8') AND btrim(c12) = $2 LIMIT 1`,
        [e.sucursal, vendedor]);
      if (!vendConocido.rowCount) {
        const cat = await this.leerCatalogo(c, `SELECT 1 FROM md.kduv WHERE btrim(c2) = $1 LIMIT 1`, [vendedor], 'kduv');
        if (typeof cat === 'string') return { estado: 'rechazado', motivo: cat };
        if (!cat.length) return { estado: 'rechazado', motivo: `Kepler (sucursal ${e.sucursal}) no tiene al vendedor ${vendedor} (kduv)` };
      }
      const prev = cli;

      // ── La ficha de cada producto en ESTE servidor ────────────────────────────────────────
      const skus = [...new Set(e.renglones.map((r) => r.sku))];
      const fic = await c.query(
        `SELECT btrim(c1) AS sku, btrim(c2) AS nombre, c11, c18, c19, c77, c78, c79, c80, c81, c83, c84
           FROM md.kdii WHERE btrim(c1) = ANY($1::text[])`, [skus]);
      const num = (v: unknown) => Number(String(v ?? '').replace(/[^0-9.-]/g, '') || 0);
      const fichas = new Map<string, FichaTlmk>();
      for (const r of fic.rows) {
        const ren = e.renglones.find((x) => x.sku === String(r.sku));
        fichas.set(String(r.sku), {
          nombre: String(r.nombre ?? ''), unidad_base: String(r.c11 ?? '').trim().toUpperCase(),
          iva: num(r.c18), ieps: num(r.c19), costo_base: num(r.c77),
          factor_presentacion: factorPresentacionFicha(r, ren?.presentacion ?? String(r.c11 ?? '')),
        });
      }
      const armado = armarPedidoTlmk(e.renglones, fichas, e.pct_cliente);
      if (!armado.ok) return { estado: 'rechazado', motivo: `${armado.motivos.length} renglón(es) no se pueden escribir en Kepler`, motivos: armado.motivos };
      const { renglones, cabecera } = armado;

      // ── Tope diario: pedidos con marca de cotización ya escritos hoy en ESTE servidor ─────
      if (e.tope_dia !== null) {
        const hoy = await c.query(
          `SELECT count(*)::int AS n FROM md.kdm1
            WHERE c1 = $1 AND c2 = 'U' AND c3 = 'D' AND btrim(c4::text) = '40' AND c9::date = $2::date AND btrim(c24) LIKE $3`,
          [e.sucursal, e.fecha, `${MARCA_COTIZACION}%`]);
        if (hoy.rows[0].n >= e.tope_dia) {
          return { estado: 'rechazado', motivo: `Tope diario del servidor ${e.sucursal} alcanzado: ${hoy.rows[0].n} de ${e.tope_dia} pedidos hoy` };
        }
      }

      await c.query('BEGIN');
      const h = await c.query(
        `CREATE TEMP TABLE _h ON COMMIT DROP AS
           SELECT * FROM md.kdm1
            WHERE c1 = $1 AND c2 = $2 AND c3 = $3 AND btrim(c4::text) = $4 AND btrim(c5::text) = $5 AND c6 = $6
              AND btrim(c27) = $7`,
        [e.sucursal, DOC.genero, DOC.naturaleza, DOC.grupo, tmpl.serie, tmpl.folio, DOC.origen]);
      if (h.rowCount !== 1) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: `No existe el pedido TELEMARK plantilla ${e.sucursal}/${tmpl.serie}/${tmpl.folio} en Kepler` };
      }

      const hora = horaMx();
      await c.query(
        `UPDATE _h SET
            c6  = lpad(((SELECT max(c6::int) FROM md.kdm1
                          WHERE c1 = $1 AND c2 = $2 AND c3 = $3 AND btrim(c4::text) = $4 AND btrim(c5::text) = $5) + 1)::text, 7, '0'),
            c9 = $6, c18 = $6, c68 = $6, c62 = $7, c69 = $7, c67 = $8,
            c10 = $9, c12 = $10, c11 = $11, c27 = $12, c24 = $13,
            c22 = $14, c32 = $15, c33 = $16, c34 = $17, c35 = $18, c30 = $19,
            c43 = 'N', c85 = $20, c115 = $21`,
        [e.sucursal, DOC.genero, DOC.naturaleza, DOC.grupo, tmpl.serie,
          e.fecha, hora, CAPTURISTA_SUITE,
          e.cliente.trim(), e.vendedor.trim(), DOC.estado, DOC.origen, e.folio_suite,
          cli.rfc, cli.nombre, prev.c33, prev.c34, prev.c35, prev.c30,
          // c115 SIEMPRE se escribe: si no, el pedido hereda la dirección del que se clonó.
          C85_AL_CREAR, e.direccion_envio?.trim() || '']);
      // Cada importe con su propio parámetro: los tipos de Kepler no son uniformes (KR.16).
      await c.query('UPDATE _h SET c13 = $1, c14 = $2, c15 = $3', [cabecera.c13, cabecera.c14, cabecera.c15]);
      await c.query('UPDATE _h SET c16 = $1, c42 = $2, c19 = $3', [cabecera.c16, cabecera.c16, cabecera.c19]);
      for (const col of LIMPIAR) await c.query(`UPDATE _h SET ${col} = ''`);
      // COT.28: siempre se escriben, también vacíos: así no se hereda el comentario de la plantilla.
      await c.query('UPDATE _h SET c25 = $1, c26 = $2', obs);
      const folio: string = (await c.query('SELECT c6 FROM _h')).rows[0].c6;

      const n = renglones.length;
      const l = await c.query(
        `CREATE TEMP TABLE _l ON COMMIT DROP AS
           SELECT t.* FROM (SELECT * FROM md.kdm2
                             WHERE c1 = $1 AND c2 = $2 AND c3 = $3 AND btrim(c4::text) = $4
                               AND btrim(c5::text) = $5 AND c6 = $6
                             ORDER BY c7::int LIMIT 1) t,
                generate_series(1, $7::int) g`,
        [e.sucursal, DOC.genero, DOC.naturaleza, DOC.grupo, tmpl.serie, tmpl.folio, n]);
      if (l.rowCount !== n) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: `El pedido plantilla ${tmpl.folio} no tiene renglones de los que copiar` };
      }
      await c.query(
        `UPDATE _l SET c7 = x.n FROM (SELECT ctid, row_number() OVER () AS n FROM _l) x WHERE _l.ctid = x.ctid`);

      for (let i = 0; i < n; i++) {
        const r = renglones[i];
        await c.query(
          `UPDATE _l SET c6 = $1, c8 = $2, c10 = $3, c11 = $4, c9 = $5, c24 = $5, c55 = $6, c25 = $7, c27 = $8,
                         c28 = $9, c32 = $10
            WHERE c7 = $11`,
          [folio, r.sku, r.nombre, r.c11, r.c9, r.c55, e.cliente.trim(), e.vendedor.trim(), DOC.estado, e.fecha, i + 1]);
        await c.query('UPDATE _l SET c12 = $1, c13 = $2 WHERE c7 = $3', [r.c12, r.c13, i + 1]);
        await c.query(
          'UPDATE _l SET c51 = $1, c56 = $2, c57 = $3, c65 = $4, c58 = $5, c62 = $6, c63 = $7, c66 = $8 WHERE c7 = $9',
          [textoKepler(r.c51), textoKepler(r.c51), textoKepler(r.c57), textoKepler(r.c57), textoKepler(r.c58),
            textoKepler(r.c62), String(r.c63), String(r.c66), i + 1]);
        await c.query('UPDATE _l SET c17 = $1 WHERE c7 = $2', [textoKepler(r.c17), i + 1]);
        await c.query('UPDATE _l SET c18 = $1 WHERE c7 = $2', [r.c18, i + 1]);
      }

      await this.confirmar(c);
      this.logger.log(`Cotización ${e.folio_suite} → Pedido TELEMARK Kepler ${e.sucursal}/${folio} (${n} renglones, $${cabecera.c16})`);
      return { estado: 'entregado', kepler: { sucursal: e.sucursal, folio, renglones: n, total: cabecera.c16 } };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      const motivo = (err as Error).message;
      this.logger.error(`Cotización ${e.folio_suite} rechazada por Kepler: ${motivo}`);
      return { estado: 'rechazado', motivo };
    } finally {
      c.release();
    }
  }
}
