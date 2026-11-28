import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import type {
  KeplerInventoryAdjustmentSinkPort,
  KeplerInventarioEntrada,
  KeplerInventarioResultado,
  KeplerInventarioDiferencia,
  KeplerInventarioDocumento,
} from '@megadulces/contracts';

import {
  CAPTURISTA_SUITE, normalizarSucursal, reservarFolioKepler, servidoresEncendidos, urlDeServidor,
} from '@megadulces/platform-core';

import {
  DOCTIPOS_INVENTARIO, MARCA_INVENTARIO, SQL_EXISTENCIA_KEPLER, cantidadDelRenglon,
  coordenadaInventario, ivaDelActa, plantillaInventarioDe, repartirDiferencias, totalDelEncabezado,
  type DiferenciaInventario, type KeplerInventarioDoctipo,
} from './kepler-inventario-doctipo';

/** `[ICR.K5]` Hora de captura como la guarda Kepler (`kdm1.c69`, `HH:MM`, hora de México). */
export const horaMx = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

/** Redondeo a dos decimales, el de Kepler. */
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Número de Kepler (texto con formato) → number. */
const num = (v: unknown): number => Number(String(v ?? '').replace(/[^0-9.-]/g, '') || 0);

/**
 * `[ICR.K6]` **Qué cuenta el tope diario.** Vive aparte y exportada porque es un gate, y un gate
 * sin prueba negativa es una intención (`kepler-inventario-tope.spec.ts`).
 *
 * ⛔ Cuenta **sólo las ACTAS** con marca de la Suite de ese día en ese servidor, no los tres
 * documentos. Es el error que `[AB.NI.8]` ya pagó caro en el traspaso: el tope se definía por
 * tipo y el conteo sumaba familias distintas, así que el cupo de uno se lo comía el otro y el
 * pedido de sucursal **nació bloqueado dos de cada tres días** (cero `U-D-40` escritos en toda la
 * historia del ODS). Acá el acta es el documento que hay UNO por ajuste: contar los tres contra
 * un tope de 1 dejaría pasar un ajuste y rechazaría el siguiente diciendo «3 de 1».
 *
 * Parámetros: `$1` servidor · `$2` fecha · `$3` marca de la Suite.
 */
export const SQL_TOPE_INVENTARIO = `
  SELECT count(*)::int AS n FROM md.kdm1
   WHERE c1 = $1 AND c9::date = $2::date
     AND c2 = 'N' AND c3 = 'A' AND btrim(c4::text) = '45'
     AND btrim(c24) LIKE $3`;

/**
 * `[ICR.K7]` — **Escribe el ajuste del inventario físico en Kepler, en el idioma de Kepler.**
 *
 * Plan y anatomía medida: [`FASE_ICR_ANEXO_ANATOMIA_INVENTARIO_FISICO_KEPLER_2026-11-27.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_ICR_ANEXO_ANATOMIA_INVENTARIO_FISICO_KEPLER_2026-11-27.md).
 *
 * ⛔⛔ **NO SE HA EJERCIDO CONTRA KEPLER. Ni una vez.** Todo lo de acá se dedujo leyendo el ODS en
 * sólo lectura; el SQL que escribe **nunca corrió**. Encenderlo lo autoriza Edgar y se ejerce
 * desde `md`, primero en ensayo (`BEGIN` … `ROLLBACK`) y después un canario de una sucursal.
 *
 * ── Por qué CLONA y no construye la fila ────────────────────────────────────────────────────
 *
 * ⛔ Porque no se puede construir: las 201 columnas de `md.kdm1` son `NOT NULL` (y las 71 de
 * `md.kdm2`). Clonar un documento real del MISMO tipo y servidor, y pisar **sólo** los campos de
 * negocio, deja el resto con valores que el propio Kepler escribió. Misma decisión y mismo motivo
 * que el sink de la requisición.
 *
 * ⭐ Y acá clonar es **seguro**, medido: no hay una sola columna que distinga un documento ya
 * procesado de uno recién capturado (245 procesadas contra 67 nuevas, las 201 columnas). Por eso
 * `limpiar` está vacía en los tres. Lo único que sí hay que forzar es `c43='N'`: si la plantilla
 * fuera un documento cancelado —hay 50 actas y 3 entradas así— el clon nacería cancelado y **no
 * movería nada, en silencio**.
 *
 * ── El orden, que no es cosmético ───────────────────────────────────────────────────────────
 *
 *   1. acta `N-A-45` → su folio es lo que la entrada y la salida ponen en `c11`.
 *   2. entrada `N-A-30` (sólo si algo sobró).
 *   3. salida `N-D-30` (sólo si algo faltó).
 *
 * Todo en una transacción. Si la salida falla, el acta y la entrada se deshacen: un ajuste a
 * medias es peor que ninguno, porque deja el ERP con la mitad de la corrección y nadie sabe cuál.
 *
 * ── Lo que NO hace ──────────────────────────────────────────────────────────────────────────
 *
 * No toma `LOCK TABLE`: bloquearía las capturas de un ERP en uso. La llave primaria de `kdm1` ya
 * hace que una carrera por el mismo folio falle sola y sin daño, y el candado de `md.sqliov` que
 * toma `reservarFolioKepler` serializa con la pantalla de Kepler.
 *
 * ⛔ **No es idempotente**, y acá eso muerde el doble: la segunda corrida lee la existencia YA
 * ajustada y escribe la diferencia contraria. Quien llama mira primero si el folio ya tiene su
 * coordenada guardada.
 */
@Injectable()
export class KeplerInventarioSinkAdapter implements KeplerInventoryAdjustmentSinkPort, OnModuleDestroy {
  private readonly logger = new Logger(KeplerInventarioSinkAdapter.name);
  private readonly pools = new Map<string, Pool>();

  private poolDe(url: string): Pool {
    let p = this.pools.get(url);
    if (!p) {
      p = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 8000, statement_timeout: 60000 });
      this.pools.set(url, p);
    }
    return p;
  }

  constructor() {
    const encendidos = servidoresEncendidos(process.env);
    if (!encendidos.length) this.logger.warn('Ningún KEPLER_PUSH_URL_NN definido — el ajuste de inventario a Kepler queda apagado.');
  }

  async onModuleDestroy() {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
  }

  async disponible(): Promise<boolean> {
    for (const s of servidoresEncendidos(process.env)) {
      try { await this.poolDe(s.url).query('SELECT 1'); return true; }
      catch (e) { this.logger.warn(`Kepler ${s.sucursal} no responde: ${(e as Error).message}`); }
    }
    return false;
  }

  /**
   * El único paso que ESCRIBE. Aparte para que el ensayo corra TODO el SQL real contra cada
   * servidor —plantillas, existencia, costo, tope, folios, tipos— y termine en `ROLLBACK`.
   */
  protected async confirmar(c: PoolClient, tablas: readonly string[]): Promise<void> {
    for (const t of tablas) {
      await c.query(`INSERT INTO md.kdm1 SELECT * FROM _h_${t}`);
      await c.query(`INSERT INTO md.kdm2 SELECT * FROM _l_${t}`);
    }
    await c.query('COMMIT');
  }

  async entregar(e: KeplerInventarioEntrada): Promise<KeplerInventarioResultado> {
    const suc = normalizarSucursal(e.sucursal);
    if (!suc.ok) return { estado: 'rechazada', motivo: suc.motivo };
    if (!e.lineas?.length) return { estado: 'rechazada', motivo: 'El ajuste no trae un solo SKU contado' };
    if (!String(e.folio_suite ?? '').startsWith(MARCA_INVENTARIO)) {
      return { estado: 'rechazada', motivo: `El folio de la Suite «${e.folio_suite}» no empieza con «${MARCA_INVENTARIO}»: sin marca el documento queda huérfano dentro del ERP` };
    }

    const url = urlDeServidor(suc.valor, process.env);
    if (!url.ok) return { estado: 'rechazada', motivo: url.motivo };

    // Las plantillas de los tres se resuelven ANTES de abrir la transacción: si falta la de la
    // salida, es mejor saberlo sin haber escrito el acta.
    const tmpl: Partial<Record<KeplerInventarioDoctipo, { serie: string; folio: string }>> = {};
    for (const t of ['acta', 'entrada', 'salida'] as const) {
      const p = plantillaInventarioDe(t, suc.valor, process.env);
      if (!p.ok) return { estado: 'rechazada', motivo: p.motivo };
      tmpl[t] = p.valor;
    }
    const serie = tmpl.acta!.serie;

    const c = await this.poolDe(url.valor).connect();
    try {
      // El tope cuenta ACTAS, no los tres documentos (`SQL_TOPE_INVENTARIO`).
      const tope = e.tope_dia === undefined ? 1 : e.tope_dia;
      if (tope !== null) {
        const hoy = await c.query(SQL_TOPE_INVENTARIO, [suc.valor, e.fecha, `${MARCA_INVENTARIO}%`]);
        if (Number(hoy.rows[0].n) >= tope) {
          return { estado: 'rechazada', motivo: `Tope diario del servidor ${suc.valor} alcanzado: ${hoy.rows[0].n} de ${tope} actas de inventario físico hoy` };
        }
      }

      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '5s'`);

      // ── La diferencia se calcula contra la existencia DE KEPLER, acá adentro ───────────────
      const skus = e.lineas.map((l) => String(l.sku).trim());
      const ex = await c.query(SQL_EXISTENCIA_KEPLER, [suc.valor, skus]);
      const existencias = new Map<string, number>(ex.rows.map((r: Record<string, unknown>) => [String(r.sku), num(r.existencia)]));

      // La unidad y el costo salen de la ficha del propio Kepler, de ESA sucursal.
      // ⚠️ `kdik.c16` es la mejor fuente disponible para el costo, **no una medida**: coincide con
      // el acta de Yurécuaro en 933 de 1,567 (59.5 %) y el control de deriva no explica el resto.
      // ⛔ Las llaves NO son simétricas y confundirlas devuelve filas plausibles: en `kdii` el SKU
      // es `c1` (una fila por producto: 9,631 en la copia de Yurécuaro) y en `kdik` el SKU es
      // `c2`, con `c1` = la sucursal (3,155 filas, los productos con movimiento).
      const fichas = await c.query(
        `SELECT btrim(i.c1) AS sku, btrim(i.c11) AS unidad, k.c16::numeric AS costo
           FROM md.kdii i
           LEFT JOIN md.kdik k ON k.c1 = $2 AND btrim(k.c2) = btrim(i.c1)
          WHERE btrim(i.c1) = ANY($1)`, [skus, suc.valor]);
      const ficha = new Map<string, { unidad: string; costo: number }>(
        fichas.rows.map((r: Record<string, unknown>) => [String(r.sku), { unidad: String(r.unidad ?? '').trim(), costo: num(r.costo) }]));

      const diferencias: KeplerInventarioDiferencia[] = [];
      const filas: DiferenciaInventario[] = [];
      for (const l of e.lineas) {
        const sku = String(l.sku).trim();
        const f = ficha.get(sku);
        if (!f || !f.unidad) {
          diferencias.push({ sku, contado: Number(l.contado), existencia: 0, diferencia: 0, motivo: 'Kepler no tiene ficha (kdii) de este SKU en esta sucursal: no se conoce su unidad base' });
          continue;
        }
        const contado = Number(l.contado);
        const existencia = existencias.get(sku) ?? 0;
        const diferencia = r2(contado - existencia);
        diferencias.push({ sku, contado, existencia, diferencia, costo: f.costo });
        filas.push({ sku, nombre: l.nombre, contado, existencia, diferencia });
      }

      // Fail-closed: un solo SKU sin ficha rechaza el ajuste entero. Escribir parcial dejaría un
      // acta que parece completa y un ERP ajustado a medias.
      const sinFicha = diferencias.filter((d) => d.motivo);
      if (sinFicha.length) {
        await c.query('ROLLBACK');
        return {
          estado: 'rechazada', diferencias, costo_no_confirmado: true,
          motivo: `Kepler (sucursal ${suc.valor}) no tiene ficha para ${sinFicha.length} SKU(s): ${sinFicha.slice(0, 5).map((d) => d.sku).join(', ')}`,
        };
      }

      const reparto = repartirDiferencias(filas);
      const costoDe = (sku: string) => ficha.get(sku)?.costo ?? 0;
      const unidadDe = (sku: string) => ficha.get(sku)?.unidad ?? '';

      const escritos: Partial<Record<KeplerInventarioDoctipo, KeplerInventarioDocumento>> = {};
      const tablas: KeplerInventarioDoctipo[] = [];
      let folioActa = '';

      for (const tipo of ['acta', 'entrada', 'salida'] as const) {
        const lineas = reparto[tipo];
        // ⭐ Un documento sin renglones no se escribe: 00, 07 y 08 cerraron septiembre SIN salida.
        if (!lineas.length) continue;

        const d = DOCTIPOS_INVENTARIO[tipo];
        const t = tmpl[tipo]!;
        const importe = r2(lineas.reduce((s, f) => s + r2(cantidadDelRenglon(tipo, f) * costoDe(f.sku)), 0));

        const h = await c.query(
          `CREATE TEMP TABLE _h_${tipo} ON COMMIT DROP AS
             SELECT * FROM md.kdm1
              WHERE c1=$1 AND c2=$2 AND c3=$3 AND btrim(c4::text)=$4 AND btrim(c5::text)=$5 AND c6=$6`,
          [suc.valor, d.genero, d.naturaleza, d.grupo, t.serie, t.folio]);
        if (h.rowCount !== 1) {
          await c.query('ROLLBACK');
          return { estado: 'rechazada', diferencias, costo_no_confirmado: true, motivo: `No existe el documento plantilla ${coordenadaInventario(tipo)} ${suc.valor}/${t.serie}/${t.folio} en Kepler` };
        }

        const reserva = await reservarFolioKepler(c, { sucursal: suc.valor, grupo: 'N', naturaleza: d.naturaleza, tipo: Number(d.grupo), serie: Number(t.serie) });
        if (!reserva.ok) {
          await c.query('ROLLBACK');
          return { estado: 'rechazada', diferencias, costo_no_confirmado: true, motivo: `Folio Kepler ${coordenadaInventario(tipo)} (${suc.valor}): ${reserva.motivo}` };
        }
        const folio = reserva.valor.folio;
        if (tipo === 'acta') folioActa = folio;

        // `c11`: la ZONA en el acta, el FOLIO DEL ACTA en los movimientos. Medido, y es la trampa
        // de esta familia: pisarlo en un movimiento lo deja huérfano del acta que lo explica.
        const c11 = d.c11 === 'zona' ? String(e.zona ?? '').trim() : folioActa;
        await c.query(
          `UPDATE _h_${tipo} SET
             c6=$1, c9=$2, c68=$2, c18=$2, c43='N',
             c11=$3, c24=$4, c31=$5, c63=$6,
             c14=$7, c15=0, c16=$8, c42=$8,
             c67=$9, c69=$10`,
          [folio, e.fecha, c11, e.folio_suite, d.etiqueta, d.prefijo,
            tipo === 'acta' ? ivaDelActa(importe) : 0, totalDelEncabezado(tipo, importe),
            CAPTURISTA_SUITE, horaMx()]);
        for (const col of d.limpiar) await c.query(`UPDATE _h_${tipo} SET ${col} = ''`);

        const n = lineas.length;
        const l = await c.query(
          `CREATE TEMP TABLE _l_${tipo} ON COMMIT DROP AS
             SELECT t.* FROM (SELECT * FROM md.kdm2
                               WHERE c1=$1 AND c2=$2 AND c3=$3 AND btrim(c4::text)=$4
                                 AND btrim(c5::text)=$5 AND c6=$6
                               ORDER BY c7::int LIMIT 1) t,
                  generate_series(1, $7::int) g`,
          [suc.valor, d.genero, d.naturaleza, d.grupo, t.serie, t.folio, n]);
        if (l.rowCount !== n) {
          await c.query('ROLLBACK');
          return { estado: 'rechazada', diferencias, costo_no_confirmado: true, motivo: `El documento plantilla ${coordenadaInventario(tipo)} ${t.folio} no tiene renglones de los que copiar` };
        }
        // Numerar por `ctid`: las N filas son idénticas, es lo único que las distingue.
        // ⚠️ Sin `::text` — `c7` es numeric.
        await c.query(
          `UPDATE _l_${tipo} SET c7 = x.n
             FROM (SELECT ctid, row_number() OVER () AS n FROM _l_${tipo}) x
            WHERE _l_${tipo}.ctid = x.ctid`);

        for (let i = 0; i < n; i++) {
          const f = lineas[i];
          const cant = cantidadDelRenglon(tipo, f);
          const costo = costoDe(f.sku);
          // ⭐ `c13 = round(c9 × c12, 2)` — medido en 1,567 de 1,567 renglones del acta (100 %).
          // `c24` del renglón repite la cantidad y `c28` lleva el folio del acta en los
          // movimientos (vacío en el acta), igual que `c11` del encabezado.
          await c.query(
            `UPDATE _l_${tipo} SET c6=$1, c8=$2, c9=$3, c10=$4, c11=$5, c12=$6, c13=$7,
                                   c17=$8, c24=$3, c28=$9, c32=$10
              WHERE c7=$11`,
            [folio, f.sku, cant, f.nombre, unidadDe(f.sku), costo, r2(cant * costo),
              tipo === 'acta' ? '16' : '0', tipo === 'acta' ? '' : folioActa, e.fecha, i + 1]);
        }

        tablas.push(tipo);
        escritos[tipo] = { folio, renglones: n, importe };
        this.logger.log(`[${e.folio_suite}] ${coordenadaInventario(tipo)} ${suc.valor}/${folio}: ${n} renglones, $${importe}; contador ${reserva.valor.llave} ${reserva.valor.contadorAntes} → ${reserva.valor.contadorNuevo}${reserva.valor.contadorAtrasado ? ', VENÍA ATRASADO' : ''}`);
      }

      // El acta SIEMPRE se escribe —lleva todo lo contado y arriba ya se rechazó el ajuste sin
      // SKUs resolubles—, pero no se afirma por invariante: sin acta los movimientos quedarían
      // con `c11` vacío, que es el 2.4 % que nadie puede explicar después.
      if (!escritos.acta) {
        await c.query('ROLLBACK');
        return { estado: 'rechazada', diferencias, costo_no_confirmado: true, motivo: 'El acta N-A-45 quedó sin renglones: no se escribe un movimiento sin acta que lo explique' };
      }

      await this.confirmar(c, tablas);

      return {
        estado: 'entregada', diferencias, costo_no_confirmado: true,
        kepler: { sucursal: suc.valor, serie, acta: escritos.acta, ...(escritos.entrada ? { entrada: escritos.entrada } : {}), ...(escritos.salida ? { salida: escritos.salida } : {}) },
      };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      const motivo = (err as Error).message;
      this.logger.error(`Ajuste de inventario ${e.folio_suite} rechazado por Kepler: ${motivo}`);
      return { estado: 'rechazada', motivo };
    } finally {
      c.release();
    }
  }
}
