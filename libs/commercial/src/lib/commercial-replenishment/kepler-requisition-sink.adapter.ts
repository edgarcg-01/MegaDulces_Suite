import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import type {
  KeplerRequisitionSinkPort,
  KeplerRequisitionEntrada,
  KeplerRequisitionResultado,
} from '@megadulces/contracts';

import { DOCTIPOS, coordenada } from './kepler-doctipo';
import { MARCA_SUITE, plantillaDe, servidoresEncendidos, topeDiario, urlDeServidor } from './kepler-servidores';

/** Número de Kepler (texto con formato) → number. `0` si viene vacío. */
const num = (v: unknown): number =>
  Number(String(v ?? '').replace(/[^0-9.-]/g, '') || 0);

/**
 * `[KR.1]` + `[KR.6]` — **Escribe la requisición en Kepler, en el idioma de Kepler.**
 *
 * Plan: [`FASE_KR_REQUISICION_A_KEPLER.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_KR_REQUISICION_A_KEPLER.md).
 * Verificado contra el ERP vivo el 2026-10-13 (tres documentos escritos, vistos en pantalla y
 * borrados; `md_00` volvió a `3110 / 3110`).
 *
 * ── Por qué CLONA y no construye la fila ────────────────────────────────────────────────────
 *
 * ⛔ Porque no se puede construir: **las 200 columnas de `md.kdm1` son `NOT NULL`** (y las 70 de
 * `md.kdm2`). Habría que inventar un valor para doscientas columnas que nadie decodificó. Clonar
 * una requisición real y pisar **sólo** los campos de negocio deja el resto con valores que el
 * propio Kepler escribió, que es la única garantía disponible de que son válidos.
 *
 * ⚠️ El precio es una dependencia: si alguien da de baja el documento plantilla, esto deja de
 * funcionar — y lo dice con todas sus letras en vez de fallar con un `undefined`.
 *
 * ── ⭐⭐ Por qué la UNIDAD se resuelve y no se impone (`[KR.6]`) ────────────────────────────
 *
 * La versión anterior escribía `c11='CJA'` fijo. Medido: **`CJA` es unidad de línea en 24 de
 * 17,810 renglones (0.13%)** — Kepler expresa la línea en la unidad del producto (PAQ 64%, PZA
 * 28%, KG 5%) y declara la caja aparte en `c55`/`c58`. Lo que escribíamos el ERP lo aceptaba y
 * **significaba otra cosa** que los otros 17,786, y de esa unidad dependen la conversión a OC, la
 * recepción y el descuento de inventario.
 *
 * Así que la unidad se lee del precedente del propio ERP: el último renglón de requisición u
 * orden de compra de ese SKU en esa sucursal.
 *
 * ⛔⛔ **Y no se usa a ciegas: se CONTRASTA contra el testigo de la Suite.** Sobre 4,842 SKUs
 * presentes en ambos lados coinciden en **86.6%**, y los 650 que no tienen un patrón único —
 * Kepler dice `c58=1` (sin caja) y la Suite dice 50, 24, 12… Convertir ahí sin contrastar
 * escribiría un pedido **hasta 50 veces menor**, con el documento viéndose perfecto en pantalla.
 *
 * **Fail-closed: si un solo renglón no se puede resolver, NO se escribe la requisición.**
 * Cuesta poco y está medido: de 130 requisiciones elegibles, **122 pasan limpias (93.8%)**; los
 * renglones problemáticos son 49 de 1,693 (2.9%). Escribir parcial dejaría al comprador con un
 * pedido incompleto que parece completo, y caer a una unidad por defecto es justo el error de
 * 50× que esto evita. El rechazo devuelve **cuáles** SKUs y por qué, que es lo que se arregla.
 *
 * ── Por qué una sentencia por renglón ───────────────────────────────────────────────────────
 *
 * ⭐ Los tipos de Kepler no son uniformes y no se adivinan: `c7` es `numeric`, `c51`–`c54` son
 * texto, otras guardan números como texto con formato. Un `c7 = x.n::text` ya reventó. Mandando
 * **parámetros** contra la columna destino, Postgres resuelve el tipo solo.
 *
 * ── Qué NO hace ─────────────────────────────────────────────────────────────────────────────
 *
 * No toca `md.kdfolio`: sólo lleva prefijos del POS y no tiene fila para `XA3001-`. El folio es
 * denso y se deriva con `MAX+1`.
 *
 * No toma `LOCK TABLE`: bloquearía todas las capturas del ERP, que está en uso activo. La llave
 * primaria `(c1..c6)` ya hace que una carrera por el mismo folio **falle sola y sin daño**.
 *
 * ⛔ **No es idempotente.** Un sink entrega lo que le dan; llamarlo dos veces escribe dos
 * documentos — pasó cuatro veces el 2026-10-13 con la misma requisición. Quien llama DEBE mirar
 * `purchase_requisitions.kepler_folio` antes (mig `20261013140000`).
 */
@Injectable()
export class KeplerRequisitionSinkAdapter implements KeplerRequisitionSinkPort, OnModuleDestroy {
  private readonly logger = new Logger(KeplerRequisitionSinkAdapter.name);
  /**
   * `[KR.11]` **Un pool por servidor Kepler**, creado al primer uso. Cada sucursal escribe en SU
   * base (`md_NN`); la regla de qué variable abre qué servidor vive en `kepler-servidores.ts`.
   * ⛔ Un servidor sin `KEPLER_PUSH_URL_NN` queda apagado — nunca se redirige a oficinas.
   */
  private readonly pools = new Map<string, Pool>();

  private poolDe(url: string): Pool {
    let p = this.pools.get(url);
    if (!p) {
      p = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 8000, statement_timeout: 30000 });
      this.pools.set(url, p);
    }
    return p;
  }

  constructor() {
    const encendidos = servidoresEncendidos(process.env);
    if (!encendidos.length) this.logger.warn('Ningún KEPLER_PUSH_URL_NN definido — la escritura a Kepler queda apagada.');
    else this.logger.log(`Escritura a Kepler encendida para: ${encendidos.map((s) => s.sucursal).join(', ')}`);
  }

  async onModuleDestroy() {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
  }

  /** `true` si al menos un servidor está configurado y responde. */
  async disponible(): Promise<boolean> {
    for (const s of servidoresEncendidos(process.env)) {
      try { await this.poolDe(s.url).query('SELECT 1'); return true; }
      catch (e) { this.logger.warn(`Kepler ${s.sucursal} no responde: ${(e as Error).message}`); }
    }
    return false;
  }


  async entregar(e: KeplerRequisitionEntrada): Promise<KeplerRequisitionResultado> {
    if (!e.lineas?.length) return { estado: 'rechazada', motivo: 'La requisición no tiene renglones' };

    const tipo = e.tipo ?? 'compra';
    const d = DOCTIPOS[tipo];
    // El documento se crea en el servidor de `e.sucursal` (en el traspaso, el ORIGEN).
    const srv = urlDeServidor(e.sucursal, process.env);
    if (!srv.ok) return { estado: 'rechazada', motivo: srv.motivo };
    // ⚠️ La plantilla del traspaso **no tiene default** en ningún servidor: hay que elegir a mano
    // un `U-D-40` en `AUTORIZADO`. Clonar uno procesado arrastra quién surtió, checó y embarcó.
    const pl = plantillaDe(tipo, e.sucursal, process.env);
    if (!pl.ok) return { estado: 'rechazada', motivo: `${pl.motivo} (${coordenada(tipo)})` };
    const tmpl = pl.valor;

    const c = await this.poolDe(srv.valor).connect();
    try {
      // ── La CONTRAPARTE de `c10`, que es distinta en cada tipo ─────────────────────────────
      // ⛔ En los dos casos tiene que existir EN KEPLER. Un código válido en la Suite pero
      // desconocido para el ERP no falla al escribir: produce un documento que apunta a algo
      // que no existe, y eso lo descubre alguien de compras días después.
      let c10: string, c32: string;

      if (tipo === 'compra') {
        if (!e.proveedor_code?.trim()) return { estado: 'rechazada', motivo: 'Sin código de proveedor Kepler (kdm1.c10 es obligatorio)' };
        const prov = await c.query(
          `SELECT btrim(c32) AS nombre FROM md.kdm1
            WHERE c1=$1 AND c2='X' AND c3='A' AND btrim(c4::text) IN ('30','35') AND btrim(c10)=$2
            GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
          [e.sucursal, e.proveedor_code.trim()]);
        if (!prov.rowCount) return { estado: 'rechazada', motivo: `Kepler (sucursal ${e.sucursal}) no conoce al proveedor ${e.proveedor_code}` };
        c10 = e.proveedor_code.trim();
        c32 = e.proveedor_nombre?.trim() || prov.rows[0].nombre;
      } else {
        // ⭐ El destino de un traspaso NO es un almacén: es un pseudo-cliente `TI###`, y **no se
        // puede inferir del número de sucursal** — `02` La Piedad es `TI008` y `03` 8 Esquinas
        // es `TI002`. La equivalencia vive en `md.pv_suc_ip` (`c1` sucursal → `c7` TI), que es
        // la misma fuente que ADR-091 señala como la buena (cruzar por número da 5% de acierto).
        if (!e.destino_sucursal?.trim()) return { estado: 'rechazada', motivo: 'Un traspaso necesita la sucursal DESTINO' };
        const ti = await c.query(
          `SELECT btrim(c7) AS ti, btrim(c2) AS nombre FROM md.pv_suc_ip WHERE btrim(c1)=$1 AND btrim(coalesce(c7,'')) <> ''`,
          [e.destino_sucursal.trim()]);
        if (!ti.rowCount) return { estado: 'rechazada', motivo: `pv_suc_ip no tiene el TI### de la sucursal ${e.destino_sucursal}: no se sabe a quién va el traspaso` };
        c10 = ti.rows[0].ti;
        // El nombre lo pone el ERP a partir de cómo ya nombró a ese TI, no lo inventamos.
        const nom = await c.query(
          `SELECT btrim(c32) AS nombre FROM md.kdm1
            WHERE c1=$1 AND c2='U' AND c3='D' AND btrim(c4::text)='40' AND btrim(c10)=$2
              AND btrim(coalesce(c32,'')) <> ''
            GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
          [e.sucursal, c10]);
        c32 = nom.rows[0]?.nombre || ti.rows[0].nombre;
      }

      // ⭐ `[KR.6]` **No hay resolución de unidad: se escribe en `CJA`, tal cual.**
      // La versión anterior leía el precedente del ERP y convertía cajas → `PAQ`, contrastando
      // dos factores de caja. Se retiró el 2026-10-14 tras medir que (a) Kepler **no convierte
      // entre documentos** —copia el renglón, razón 1.0000— y (b) el factor para convertir no se
      // pudo fijar: `kdm2.c58` es el empaque de esa compra, no la caja del producto. Convertir
      // con un factor no verificado es el modo de fallar que esto existe para evitar.
      const resueltas = e.lineas.map((l) => ({
        sku: l.sku, unidad: 'CJA', unidad_caja: 'CJA', por_caja: 1, cantidad: l.cajas,
      }));

      // ⛔ `[KR.12]` El tope diario del servidor: cuántos documentos con marca de la Suite ya
      // tienen esta fecha en ESTE servidor. Se cuenta en Kepler, no en la Suite: lo que importa
      // es lo que el ERP ya tiene, incluido lo que escribió otro proceso o un reintento.
      // ⚠️ Dos aprobaciones simultáneas pueden pasar las dos (no hay candado): el pool es de 2.
      const tope = topeDiario(e.sucursal, process.env);
      const hoy = await c.query(
        `SELECT count(*)::int AS n FROM md.kdm1
          WHERE c1=$1 AND c9::date = $2::date
            AND ((c2='X' AND c3='A' AND btrim(c4::text)='30' AND btrim(c11) LIKE $3)
              OR (c2='U' AND c3='D' AND btrim(c4::text)='40' AND btrim(c24) LIKE $3))`,
        [e.sucursal, e.fecha, `${MARCA_SUITE}%`]);
      if (hoy.rows[0].n >= tope) {
        return { estado: 'rechazada', motivo: `Tope diario del servidor ${e.sucursal} alcanzado: ${hoy.rows[0].n} de ${tope} documentos hoy (KEPLER_PUSH_MAX_DIA_${e.sucursal})` };
      }

      await c.query('BEGIN');

      const h = await c.query(
        `CREATE TEMP TABLE _h ON COMMIT DROP AS
           SELECT * FROM md.kdm1
            WHERE c1=$1 AND c2=$2 AND c3=$3 AND btrim(c4::text)=$4 AND btrim(c5::text)=$5 AND c6=$6`,
        [e.sucursal, d.genero, d.naturaleza, d.grupo, tmpl.serie, tmpl.folio]);
      if (h.rowCount !== 1) {
        await c.query('ROLLBACK');
        return { estado: 'rechazada', motivo: `No existe el documento plantilla ${coordenada(tipo)} ${e.sucursal}/${tmpl.serie}/${tmpl.folio} en Kepler` };
      }

      // El folio se calcula DENTRO del UPDATE para que no haya ventana entre leerlo y usarlo.
      // `c11` y la marca cambian según el tipo: en la compra `c11` ES la referencia; en el
      // traspaso es el ESTADO del flujo y la referencia se va a `c24`.
      await c.query(
        `UPDATE _h SET
            c6  = lpad(((SELECT max(c6::int) FROM md.kdm1
                          WHERE c1=$1 AND c2=$2 AND c3=$3 AND btrim(c4::text)=$4 AND btrim(c5::text)=$5) + 1)::text, 7, '0'),
            c9  = $6, c68 = $6, c43 = 'N',
            c10 = $7, c32 = $8, c16 = $9,
            c11 = $10, c24 = $11`,
        [e.sucursal, d.genero, d.naturaleza, d.grupo, tmpl.serie,
          e.fecha, c10, c32, e.total,
          d.c11 === 'referencia' ? e.folio_suite : d.c11,
          d.marca === 'c24' ? e.folio_suite : '']);

      // `c27` sólo lo usa el traspaso (`SUCURSAL`); la compra no tiene esa columna en juego.
      if (d.c27) await c.query('UPDATE _h SET c27 = $1', [d.c27]);
      // ⛔ Las columnas que llena el PROCESO, no la creación: quién surtió, checó y embarcó.
      // La plantilla puede venir de un documento ya trabajado y arrastrarlas — un pedido que
      // nace diciendo que alguien ya lo surtió. Medido: 90-91% de los procesados las traen, 0%
      // de los nuevos.
      for (const col of d.limpiar) await c.query(`UPDATE _h SET ${col} = ''`);

      const folio: string = (await c.query('SELECT c6 FROM _h')).rows[0].c6;

      const n = e.lineas.length;
      const l = await c.query(
        `CREATE TEMP TABLE _l ON COMMIT DROP AS
           SELECT t.* FROM (SELECT * FROM md.kdm2
                             WHERE c1=$1 AND c2=$2 AND c3=$3 AND btrim(c4::text)=$4
                               AND btrim(c5::text)=$5 AND c6=$6
                             ORDER BY c7::int LIMIT 1) t,
                generate_series(1, $7::int) g`,
        [e.sucursal, d.genero, d.naturaleza, d.grupo, tmpl.serie, tmpl.folio, n]);
      if (l.rowCount !== n) {
        await c.query('ROLLBACK');
        return { estado: 'rechazada', motivo: `El documento plantilla ${coordenada(tipo)} ${tmpl.folio} no tiene renglones de los que copiar` };
      }

      // Numerar por `ctid`: las N filas son idénticas, es lo único que las distingue.
      // ⚠️ Sin `::text` — `c7` es numeric. Castear a mano acá ya reventó una vez.
      await c.query(
        `UPDATE _l SET c7 = x.n
           FROM (SELECT ctid, row_number() OVER () AS n FROM _l) x
          WHERE _l.ctid = x.ctid`);

      for (let i = 0; i < n; i++) {
        const ln = e.lineas[i];
        // La unidad de línea ES la caja, así que `c58=1` y el costo unitario ES el de la caja.
        // Las dos invariantes que Kepler cumple en ~99-100% de sus 17,810 renglones quedan
        // satisfechas POR CONSTRUCCIÓN: `c9×c12 = c13` y `c12×c58 = c57`. Es la misma forma que
        // tienen los 22 documentos `CJA` históricos que llegaron a entrada de inventario.
        await c.query(
          `UPDATE _l SET c6=$1, c8=$2, c9=$3, c10=$4, c11='CJA', c12=$5, c13=$6,
                         c55='CJA', c57=$5, c58=1
            WHERE c7=$7`,
          [folio, ln.sku, ln.cajas, ln.nombre, ln.costo_caja, ln.importe, i + 1]);
      }

      await c.query('INSERT INTO md.kdm1 SELECT * FROM _h');
      await c.query('INSERT INTO md.kdm2 SELECT * FROM _l');
      await c.query('COMMIT');

      this.logger.log(`Requisición ${e.folio_suite} → Kepler ${e.sucursal}/${folio} (${n} renglones)`);
      return { estado: 'entregada', kepler: { sucursal: e.sucursal, folio, renglones: n }, lineas: resueltas };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      const motivo = (err as Error).message;
      this.logger.error(`Requisición ${e.folio_suite} rechazada por Kepler: ${motivo}`);
      return { estado: 'rechazada', motivo };
    } finally {
      c.release();
    }
  }
}
