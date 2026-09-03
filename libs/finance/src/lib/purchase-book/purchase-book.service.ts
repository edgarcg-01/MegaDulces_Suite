import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  TIPO_POLIZA_DIARIO, r2, construirTxt, parsearTxt, type Movimiento, type PolizaTxtParseada,
} from './poliza-txt';

export { type Movimiento, type PolizaTxtParseada } from './poliza-txt';

/**
 * Fase LC (ADR-052) — El trámite mensual del libro de compras.
 *
 * Antes: la contadora armaba un Excel a mano, lo convertía a TXT y lo subía a ContPAQi.
 * No quedaba registro de qué se entregó ni cuándo, y por eso julio y agosto de 2026 se
 * cayeron sin que nadie lo notara hasta mirar la balanza.
 *
 * Ahora el trámite se lleva aquí y a ContPAQi solo va el TXT:
 *   1. se ve el mes con sus facturas y su cuadre
 *   2. se decide qué entra (mientras LC.2 siga abierto, lo decide una persona)
 *   3. se genera el archivo, que queda firmado por su hash
 *   4. se marca entregado y, cuando se confirma contra la póliza real, aplicado
 *
 * **No escribimos en ContPAQi** (ADR-040): esto produce un archivo, el trámite de subirlo
 * lo sigue haciendo contabilidad.
 */

/** Cuentas de impuesto acreditable — son fijas, no dependen del proveedor. */
const CTA_IVA = '1470040000';
const CTA_IEPS = '1470110000';

export type ImpuestosModo = 'global' | 'por-cuenta';
export type EstadoRun = 'borrador' | 'generado' | 'entregado' | 'aplicado' | 'cancelado';

/**
 * Las dos corridas que puede tener un mes:
 *   `libro`       → la póliza completa del mes (folio 1). Se usa cuando el mes no se subió.
 *   `complemento` → SOLO los CFDIs que quedaron sin asociar a ninguna póliza. Es el
 *                   sub-módulo "Movimientos no asociados" y es el caso normal: la póliza
 *                   del mes ya existe y se le quedaron facturas fuera.
 */
export type TipoCorrida = 'libro' | 'complemento';

/** Folio 1 del Diario es siempre el registro de compras; el 2 está libre en todos los meses. */
const FOLIO_LIBRO = 1;
const FOLIO_COMPLEMENTO = 2;

export interface FacturaMes {
  uuid: string;
  emisor_rfc: string;
  emisor_nombre: string;
  serie: string | null;
  folio: string | null;
  fecha: string;
  total: number;
  iva: number;
  ieps: number;
  /** Subtotal de lo gravado a 16%, NETO de descuento. Ver `subtotal_iva_16` del feed. */
  subtotal16: number;
  /** Lo que va a la cuenta de compras exentas, por diferencia contra el total. */
  base_exenta: number;
  ieps_por_cuota: boolean;
  account_suffix: string | null;
  supplier_name: string | null;
  cuenta_proveedor: string | null;
  cuenta_compra_exenta: string | null;
  cuenta_compra_iva: string | null;
  /**
   * ⚠️ Los tres `*_existe` son lo único que dice si la cuenta EXISTE en el catálogo de
   * ContPAQi. Los `cuenta_*` de arriba son strings **precalculados** (`212`/`501`/`502` +
   * sufijo) que están poblados para todo proveedor que tenga sufijo, así que preguntar por
   * ellos no frena nada: 14 proveedores sin cuenta `502` pasaban derecho al archivo, y un
   * renglón con la cuenta vacía tumba el import entero sin verse en ninguna pantalla.
   */
  cuenta_existe: boolean;
  compra_exenta_existe: boolean;
  compra_iva_existe: boolean;
  incluida: boolean;
  motivo_exclusion: string | null;
  /**
   * `Documento.IsAsoContabilidad` del ADD: ContPAQi la tiene atada a una póliza.
   * `false` = **movimiento no asociado**, que es el universo del sub-módulo.
   * `null` = no se sabe (CFDI cargado antes de LC.6).
   */
  aso_contabilidad: boolean | null;
  /**
   * Su importe ya aparece como abono a proveedor en la póliza de compras del mes, aunque no
   * tenga marca de asociación. Pasa porque nuestro propio TXT no lleva UUID: ContPAQi la
   * contabiliza y nadie la asocia. Es **heurístico por importe**, no prueba — pero alcanza
   * para no re-meterla: son 271 facturas por $32.6M en 2026 (jul solo, 150 por $17.9M).
   */
  ya_en_poliza: boolean;
}

@Injectable()
export class PurchaseBookService {
  private readonly logger = new Logger(PurchaseBookService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly ctx: TenantContextService,
  ) {}

  private mesValido(anioMes: string) {
    if (!/^\d{4}-\d{2}$/.test(anioMes || '')) throw new BadRequestException('mes inválido, se espera YYYY-MM');
    return anioMes;
  }

  /** Último día del mes: el asiento siempre va fechado ahí. */
  private finDeMes(anioMes: string): Date {
    const [y, m] = anioMes.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0));
  }

  // ── El tablero: en qué va cada mes ────────────────────────────────────────────────────
  /**
   * Un renglón por mes con CFDIs recibidos, aunque nunca se haya armado la póliza. Así
   * un mes sin trámite se ve como hueco en vez de desaparecer de la lista, que es
   * justamente lo que pasó con julio y agosto.
   */
  async listMeses(limit = 24) {
    return this.tk.run(async (knex) => {
      const { rows } = await knex.raw(
        `WITH meses AS (
           SELECT to_char(fecha, 'YYYY-MM') AS anio_mes,
                  count(*)      AS cfdis,
                  sum(total)    AS total_cfdis
             FROM fiscal.cfdis
            WHERE tenant_id = current_tenant_id()
              AND source = 'contpaqi_add' AND tipo_comprobante = 'I'
            GROUP BY 1
         )
         SELECT m.anio_mes, m.cfdis, m.total_cfdis,
                r.id AS run_id, r.estado, r.facturas, r.renglones, r.total_cargos,
                r.generado_at, r.entregado_at, r.aplicado_at, r.archivo_hash,
                p.patas_en_contpaqi, p.total_en_contpaqi
           FROM meses m
           LEFT JOIN finance.purchase_book_runs r
             ON r.tenant_id = current_tenant_id() AND r.anio_mes = m.anio_mes
                AND r.tipo = 'libro' AND r.deleted_at IS NULL
           LEFT JOIN LATERAL (
             SELECT count(*) AS patas_en_contpaqi,
                    sum(importe) FILTER (WHERE cargo_abono = 'A') AS total_en_contpaqi
               FROM analytics.gl_poliza_lines l
              WHERE l.tenant_id = current_tenant_id() AND l.source = 'contpaqi'
                AND l.tipo_pol = ? AND l.folio = '1' AND l.anio_mes = m.anio_mes
           ) p ON true
          ORDER BY m.anio_mes DESC
          LIMIT ?`,
        [TIPO_POLIZA_DIARIO, limit],
      );
      return rows.map((r: Record<string, unknown>) => ({
        anio_mes: r['anio_mes'],
        cfdis: Number(r['cfdis']),
        total_cfdis: r2(r['total_cfdis']),
        estado: (r['estado'] as string) ?? 'sin_iniciar',
        run_id: r['run_id'],
        facturas: r['facturas'] ? Number(r['facturas']) : null,
        renglones: r['renglones'] ? Number(r['renglones']) : null,
        total_cargos: r['total_cargos'] ? r2(r['total_cargos']) : null,
        generado_at: r['generado_at'], entregado_at: r['entregado_at'], aplicado_at: r['aplicado_at'],
        // Lo que ContPAQi tiene HOY para ese mes. Si está en cero y el mes tiene CFDIs,
        // la póliza no existe — es la señal que faltaba.
        patas_en_contpaqi: Number(r['patas_en_contpaqi'] ?? 0),
        total_en_contpaqi: r2(r['total_en_contpaqi']),
      }));
    });
  }

  // ── El sub-módulo: movimientos no asociados ───────────────────────────────────────────
  /**
   * El tablero del sub-módulo. Un renglón por mes con los tres números que importan:
   * cuántos CFDIs no están asociados a ninguna póliza, cuántos de esos ya se postearon (y
   * por eso NO hay que volver a mandarlos) y cuántos faltan de verdad.
   *
   * La señal de "no asociado" es `Documento.IsAsoContabilidad` del ADD. Verificada
   * 2026-09-02 contra `AsocCFDIs`, que es donde ContPAQi guarda la asociación de verdad:
   * coinciden dentro del 1% en jun/jul/ago-2026. Lo que NO se usa —y hay que no volver a
   * intentarlo— es `analytics.gl_poliza_lines.cfdi_uuid`: ese espejo tiene 18,979 de los
   * 504,365 UUID asociados (3.8%), así que reportaría miles de "no asociados" falsos.
   */
  async listNoAsociados(limit = 24) {
    return this.tk.run(async (knex) => {
      const { rows } = await knex.raw(
        // Las patas de proveedor de todas las pólizas de compras, deduplicadas por
        // (mes, importe). Se pre-agregan a propósito: con un EXISTS correlacionado por
        // CFDI el tablero tardaba 4.3 s, y el GROUP BY evita que el LEFT JOIN multiplique
        // filas cuando dos proveedores casan el mismo importe en el mes.
        `WITH patas AS (
           SELECT anio_mes, round(importe, 2) AS importe
             FROM analytics.gl_poliza_lines
            WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
              AND tipo_pol = ? AND folio = ?
              AND cuenta_mayor LIKE '212%' AND cargo_abono = 'A'
            GROUP BY 1, 2
         ), cargos AS (
           -- La segunda puerta: compras cargadas a 501/502 desde CUALQUIER póliza del mes
           -- (típicamente la de egresos al pagar, sin pasar por 212). El importe ahí es el
           -- NETO sin impuestos. Ver la nota en getMes.
           SELECT anio_mes, round(importe, 2) AS importe
             FROM analytics.gl_poliza_lines
            WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
              AND (cuenta LIKE '501%' OR cuenta LIKE '502%') AND cargo_abono = 'C'
            GROUP BY 1, 2
         ), ctas AS (
           -- Los RFC que SÍ tienen cuenta de compras usable. Se resuelve acá para que el
           -- tablero muestre lo accionable (lo que entra al TXT) y no un total que incluye
           -- gasto y servicio, que nunca van a entrar. DISTINCT porque un RFC puede tener
           -- más de una cuenta y el join lo duplicaría.
           SELECT DISTINCT rfc
             FROM finance.gl_supplier_accounts
            WHERE tenant_id = current_tenant_id() AND deleted_at IS NULL AND proveedor_existe
         ), base AS (
           SELECT to_char(f.fecha, 'YYYY-MM') AS anio_mes, f.total,
                  (f.aso_contabilidad IS NOT TRUE) AS sin_asociar,
                  (p.importe IS NOT NULL OR g.importe IS NOT NULL) AS ya_en_poliza,
                  (c.rfc IS NOT NULL) AS con_cuenta
             FROM fiscal.cfdis f
             LEFT JOIN patas p
               ON p.anio_mes = to_char(f.fecha, 'YYYY-MM') AND p.importe = round(f.total, 2)
             LEFT JOIN cargos g
               ON g.anio_mes = to_char(f.fecha, 'YYYY-MM')
              AND g.importe = round(f.total
                    - coalesce((f.impuestos->>'iva_trasladado')::numeric, 0)
                    - coalesce((f.impuestos->>'ieps_trasladado')::numeric, 0), 2)
             LEFT JOIN ctas c ON c.rfc = f.emisor_rfc
            WHERE f.tenant_id = current_tenant_id()
              AND f.source = 'contpaqi_add' AND f.tipo_comprobante = 'I'
              -- Acotado a los meses que el tablero va a mostrar. Sin esto se escanean los
              -- 167 mil CFDIs del ADD para tirar 24 renglones.
              AND f.fecha >= date_trunc('month', now()) - make_interval(months => ?)
         ), agg AS (
           SELECT anio_mes,
                  count(*)                                              AS cfdis,
                  count(*) FILTER (WHERE sin_asociar)                   AS no_asociados,
                  sum(total) FILTER (WHERE sin_asociar)                 AS monto_no_asociado,
                  count(*) FILTER (WHERE sin_asociar AND ya_en_poliza)  AS ya_posteados,
                  sum(total) FILTER (WHERE sin_asociar AND ya_en_poliza) AS monto_ya_posteados,
                  count(*) FILTER (WHERE sin_asociar AND NOT ya_en_poliza)   AS faltan,
                  sum(total) FILTER (WHERE sin_asociar AND NOT ya_en_poliza) AS monto_faltan,
                  -- Lo que de verdad entra al TXT: sin asociar, sin postear y con cuenta.
                  count(*) FILTER (WHERE sin_asociar AND NOT ya_en_poliza AND con_cuenta)       AS entran,
                  sum(total) FILTER (WHERE sin_asociar AND NOT ya_en_poliza AND con_cuenta)     AS monto_entran,
                  count(*) FILTER (WHERE sin_asociar AND NOT ya_en_poliza AND NOT con_cuenta)   AS fuera_catalogo,
                  sum(total) FILTER (WHERE sin_asociar AND NOT ya_en_poliza AND NOT con_cuenta) AS monto_fuera
             FROM base GROUP BY 1
         ), libro AS (
           SELECT anio_mes, count(*) AS patas
             FROM analytics.gl_poliza_lines
            WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
              AND tipo_pol = ? AND folio = ?
            GROUP BY 1
         )
         SELECT a.*, r.id AS run_id, r.estado, r.folio_poliza, r.facturas AS run_facturas,
                r.total_cargos, r.generado_at, r.entregado_at, r.aplicado_at,
                coalesce(lb.patas, 0) AS patas_libro
           FROM agg a
           LEFT JOIN libro lb ON lb.anio_mes = a.anio_mes
           LEFT JOIN finance.purchase_book_runs r
             ON r.tenant_id = current_tenant_id() AND r.anio_mes = a.anio_mes
                AND r.tipo = 'complemento' AND r.deleted_at IS NULL
          ORDER BY a.anio_mes DESC
          LIMIT ?`,
        [TIPO_POLIZA_DIARIO, String(FOLIO_LIBRO), limit, TIPO_POLIZA_DIARIO, String(FOLIO_LIBRO), limit],
      );
      return rows.map((r: Record<string, unknown>) => ({
        anio_mes: r['anio_mes'],
        cfdis: Number(r['cfdis']),
        no_asociados: Number(r['no_asociados']),
        monto_no_asociado: r2(r['monto_no_asociado']),
        ya_posteados: Number(r['ya_posteados']),
        monto_ya_posteados: r2(r['monto_ya_posteados']),
        faltan: Number(r['faltan']),
        monto_faltan: r2(r['monto_faltan']),
        // Lo accionable: es lo que la tarjeta del mes debe mostrar, para que no contradiga
        // al encabezado del detalle (que también cuenta solo lo que entra al TXT).
        entran: Number(r['entran']),
        monto_entran: r2(r['monto_entran']),
        fuera_catalogo: Number(r['fuera_catalogo']),
        monto_fuera: r2(r['monto_fuera']),
        // Sin patas del libro, el mes entero está sin contabilizar (caso ago-2026).
        existe_libro: Number(r['patas_libro'] ?? 0) > 0,
        estado: (r['estado'] as string) ?? 'sin_iniciar',
        run_id: r['run_id'],
        folio_poliza: r['folio_poliza'] ? Number(r['folio_poliza']) : FOLIO_COMPLEMENTO,
        run_facturas: r['run_facturas'] ? Number(r['run_facturas']) : null,
        total_cargos: r['total_cargos'] ? r2(r['total_cargos']) : null,
        generado_at: r['generado_at'], entregado_at: r['entregado_at'], aplicado_at: r['aplicado_at'],
      }));
    });
  }

  // ── El mes: sus facturas y su cuadre ──────────────────────────────────────────────────
  /**
   * En modo `libro` devuelve TODOS los CFDIs del mes. En modo `complemento` devuelve solo
   * los **no asociados** — el universo del sub-módulo. Los que ya aparecen en la póliza
   * vienen marcados y excluidos por default, para no postearlos dos veces.
   *
   * ⚠️ Nada de signos de interrogación DENTRO del SQL de abajo, ni siquiera en un comentario
   * `--`: knex cuenta los placeholders con un escaneo de texto plano, sin distinguir
   * comentarios ni literales, así que un `¿...?` en español agrega bindings fantasma y tira
   * `Expected N bindings, saw N+1` en runtime. El build NO lo atrapa y una validación
   * DB-direct con `$1` tampoco, porque no pasa por el formateador de knex. Vivido acá el
   * 2026-09-02: la pantalla dio 500 en prod por un `-- ¿...?` de tres palabras.
   */
  async getMes(anioMes: string, tipo: TipoCorrida = 'libro'): Promise<{ mes: string; tipo: TipoCorrida; run: Record<string, unknown> | null; facturas: FacturaMes[]; resumen: Record<string, number>; bloqueantes: string[]; avisos: string[] }> {
    this.mesValido(anioMes);
    return this.tk.run(async (knex) => {
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes, tipo }).whereNull('deleted_at').first();

      // Un RFC puede tener más de una cuenta en el mapa; DISTINCT ON evita duplicar la
      // factura por el join. Se prefiere la cuenta que ya se usó en pólizas reales.
      const { rows } = await knex.raw(
        `SELECT DISTINCT ON (upper(f.uuid))
                upper(f.uuid) AS uuid, f.emisor_rfc, f.emisor_nombre, f.serie, f.folio,
                f.fecha, f.total,
                coalesce((f.impuestos->>'iva_trasladado')::numeric, 0)  AS iva,
                coalesce((f.impuestos->>'ieps_trasladado')::numeric, 0) AS ieps,
                coalesce((f.impuestos->>'subtotal_iva_16')::numeric, 0) AS subtotal16,
                (f.impuestos->'traslados' @> '[{"tipo_factor":"Cuota"}]') AS ieps_por_cuota,
                a.account_suffix, a.supplier_name, a.cuenta_proveedor,
                a.cuenta_compra_exenta, a.cuenta_compra_iva,
                coalesce(a.proveedor_existe, false)     AS cuenta_existe,
                coalesce(a.compra_exenta_existe, false) AS compra_exenta_existe,
                coalesce(a.compra_iva_existe, false)    AS compra_iva_existe,
                f.aso_contabilidad,
                -- Defensa contra el doble registro mientras el TXT no lleve UUID. Hay DOS
                -- formas de que una compra ya esté contabilizada, y hay que mirar las dos:
                --
                --  a) patrón libro de compras: abono al proveedor 212 por el TOTAL,
                --     en el Diario folio 1.
                --  b) patrón compra pagada directo: cargo a 501/502 por el NETO (sin
                --     impuestos) desde la póliza de EGRESOS del pago, sin pasar por 212.
                --
                -- (b) se descubrió el 2026-09-03: en ago-2026 no hay UN SOLO abono a 212, y
                -- aun así había $7.2M cargados a 501/502 desde pólizas tipo 2 "PAGO FACT
                -- ...". Con sólo la prueba (a), 33 facturas por $2,095,889 se habrían
                -- posteado dos veces — una de ellas era el primer renglón del TXT de agosto.
                (EXISTS (
                  SELECT 1 FROM analytics.gl_poliza_lines l
                   WHERE l.tenant_id = f.tenant_id AND l.source = 'contpaqi'
                     AND l.tipo_pol = ? AND l.folio = ?
                     AND l.anio_mes = to_char(f.fecha, 'YYYY-MM')
                     AND l.cuenta_mayor LIKE '212%' AND l.cargo_abono = 'A'
                     AND round(l.importe, 2) = round(f.total, 2)
                 ) OR EXISTS (
                  SELECT 1 FROM analytics.gl_poliza_lines l
                   WHERE l.tenant_id = f.tenant_id AND l.source = 'contpaqi'
                     AND l.anio_mes = to_char(f.fecha, 'YYYY-MM')
                     AND (l.cuenta LIKE '501%' OR l.cuenta LIKE '502%') AND l.cargo_abono = 'C'
                     AND round(l.importe, 2) = round(
                           f.total
                           - coalesce((f.impuestos->>'iva_trasladado')::numeric, 0)
                           - coalesce((f.impuestos->>'ieps_trasladado')::numeric, 0), 2)
                 )) AS ya_en_poliza,
                i.incluida, i.motivo
           FROM fiscal.cfdis f
           LEFT JOIN finance.gl_supplier_accounts a
             ON a.tenant_id = f.tenant_id AND a.rfc = f.emisor_rfc AND a.deleted_at IS NULL
           LEFT JOIN finance.purchase_book_run_items i
             ON i.tenant_id = f.tenant_id AND i.run_id = ? AND i.cfdi_uuid = upper(f.uuid)
          WHERE f.tenant_id = current_tenant_id()
            AND f.source = 'contpaqi_add' AND f.tipo_comprobante = 'I'
            AND to_char(f.fecha, 'YYYY-MM') = ?
            -- El sub-módulo solo mira lo no asociado. IS NOT TRUE y no = false a
            -- propósito: NULL es "no sabemos" y también hay que mirarlo, no esconderlo.
            AND (? = 'libro' OR f.aso_contabilidad IS NOT TRUE)
          ORDER BY upper(f.uuid), a.usado_en_asiento DESC NULLS LAST, a.account_suffix`,
        [TIPO_POLIZA_DIARIO, String(FOLIO_LIBRO), run?.id ?? null, anioMes, tipo],
      );

      const facturas: FacturaMes[] = rows.map((r: Record<string, unknown>) => {
        const total = r2(r['total']), iva = r2(r['iva']), ieps = r2(r['ieps']);
        const subtotal16 = r2(r['subtotal16']);
        const conCuenta = r['cuenta_existe'] === true;
        const yaEnPoliza = r['ya_en_poliza'] === true;
        // El default de inclusión es lo que cambia entre los dos modos:
        //  · libro       → entra si su proveedor está en el catálogo de compras
        //  · complemento → además: que no esté ya posteada (si no, la duplicamos)
        const porDefault = tipo === 'complemento' ? conCuenta && !yaEnPoliza : conCuenta;
        return {
          uuid: String(r['uuid']),
          emisor_rfc: String(r['emisor_rfc'] ?? ''),
          emisor_nombre: String(r['emisor_nombre'] ?? ''),
          serie: (r['serie'] as string) ?? null,
          folio: (r['folio'] as string) ?? null,
          fecha: String(r['fecha']).slice(0, 10),
          total, iva, ieps, subtotal16,
          base_exenta: r2(total - iva - ieps - subtotal16),
          ieps_por_cuota: r['ieps_por_cuota'] === true,
          account_suffix: (r['account_suffix'] as string) ?? null,
          supplier_name: (r['supplier_name'] as string) ?? null,
          cuenta_proveedor: (r['cuenta_proveedor'] as string) ?? null,
          cuenta_compra_exenta: (r['cuenta_compra_exenta'] as string) ?? null,
          cuenta_compra_iva: (r['cuenta_compra_iva'] as string) ?? null,
          cuenta_existe: conCuenta,
          compra_exenta_existe: r['compra_exenta_existe'] === true,
          compra_iva_existe: r['compra_iva_existe'] === true,
          // La decisión guardada manda; si no hay, el default del modo. En `complemento` el
          // default es además el criterio que LC.2 buscaba y no encontraba en el CFDI: lo
          // que falta por contabilizar es lo que ContPAQi mismo dice que no está asociado.
          incluida: r['incluida'] === null || r['incluida'] === undefined
            ? porDefault
            : r['incluida'] === true,
          motivo_exclusion: (r['motivo'] as string)
            ?? (tipo === 'complemento' && yaEnPoliza ? 'su importe ya está en la póliza del mes' : null),
          aso_contabilidad: r['aso_contabilidad'] === null || r['aso_contabilidad'] === undefined
            ? null
            : r['aso_contabilidad'] === true,
          ya_en_poliza: yaEnPoliza,
        };
      });

      const dentro = facturas.filter((f) => f.incluida);
      const resumen = {
        cfdis_del_mes: facturas.length,
        incluidas: dentro.length,
        excluidas: facturas.length - dentro.length,
        total: r2(dentro.reduce((a, f) => a + f.total, 0)),
        subtotal_exento: r2(dentro.reduce((a, f) => a + f.base_exenta, 0)),
        subtotal_gravado: r2(dentro.reduce((a, f) => a + f.subtotal16, 0)),
        iva: r2(dentro.reduce((a, f) => a + f.iva, 0)),
        ieps: r2(dentro.reduce((a, f) => a + f.ieps, 0)),
        total_todas: r2(facturas.reduce((a, f) => a + f.total, 0)),
        // Los tres números del sub-módulo: cuántas no están asociadas, cuántas de esas ya
        // se postearon (y por eso NO van), y cuántas faltan de verdad.
        no_asociadas: facturas.filter((f) => f.aso_contabilidad !== true).length,
        ya_posteadas: facturas.filter((f) => f.ya_en_poliza).length,
        monto_ya_posteadas: r2(facturas.filter((f) => f.ya_en_poliza).reduce((a, f) => a + f.total, 0)),
      };

      // Dos listas distintas, y la diferencia importa: los BLOQUEANTES son renglones que
      // ContPAQi rechazaría, así que apagan el botón de generar. Los AVISOS son cosas que
      // merecen una mirada pero se postean sin problema. Mezclarlos deja el mes trabado
      // por una nota informativa, que es justo lo que pasó con "IEPS por cuota" en julio.
      const bloqueantes: string[] = [];
      const avisos: string[] = [];
      const sinMapa = dentro.filter((f) => !f.account_suffix);
      const ctaMala = dentro.filter((f) => f.account_suffix && !f.cuenta_existe);
      // Se pregunta por `*_existe`, NO por el string de la cuenta: ese está precalculado y
      // nunca falta, así que el freno viejo (`!f.cuenta_compra_iva`) no frenaba nada.
      const sinCta502 = dentro.filter((f) => f.subtotal16 > 0.004 && (!f.cuenta_compra_iva || !f.compra_iva_existe));
      const sinCta501 = dentro.filter((f) => f.base_exenta > 0.004 && (!f.cuenta_compra_exenta || !f.compra_exenta_existe));
      const negativas = dentro.filter((f) => f.base_exenta < -0.004);
      const cuota = dentro.filter((f) => f.ieps_por_cuota);
      if (sinMapa.length) bloqueantes.push(`${sinMapa.length} factura(s) de un RFC que no está en el mapa de cuentas`);
      if (ctaMala.length) bloqueantes.push(`${ctaMala.length} factura(s) con una cuenta de proveedor que no existe en ContPAQi`);
      if (sinCta502.length) bloqueantes.push(`${sinCta502.length} factura(s) con base gravada pero sin cuenta de compras c/IVA en ContPAQi`);
      if (sinCta501.length) bloqueantes.push(`${sinCta501.length} factura(s) con base exenta pero sin cuenta de compras al 0% en ContPAQi`);
      if (negativas.length) bloqueantes.push(`${negativas.length} factura(s) con base exenta negativa — revisar descuentos`);
      if (cuota.length) avisos.push(`${cuota.length} factura(s) con IEPS por cuota: el Excel las capturaba en cero`);

      if (tipo === 'complemento') {
        const yaPost = facturas.filter((f) => f.ya_en_poliza);
        if (yaPost.length) {
          avisos.push(`${yaPost.length} factura(s) sin marca pero con su importe ya en la póliza del mes — excluidas para no duplicarlas`);
        }
        const sinDato = facturas.filter((f) => f.aso_contabilidad === null);
        if (sinDato.length) avisos.push(`${sinDato.length} factura(s) sin dato de asociación: corre el feed del ADD`);
        const fuera = facturas.filter((f) => !f.incluida && !f.ya_en_poliza && !f.motivo_exclusion);
        if (fuera.length) avisos.push(`${fuera.length} factura(s) no asociadas de proveedores fuera del catálogo de compras (gasto o servicio)`);
      }

      return { mes: anioMes, tipo, run: run ?? null, facturas, resumen, bloqueantes, avisos };
    });
  }

  // ── Decidir qué entra ─────────────────────────────────────────────────────────────────
  /** Excluye (o vuelve a incluir) facturas del mes. Mientras LC.2 esté abierto, esto es
   *  el criterio: lo pone una persona y queda registrado con su motivo. */
  async setInclusion(anioMes: string, uuids: string[], incluida: boolean, motivo?: string, tipo: TipoCorrida = 'libro') {
    this.mesValido(anioMes);
    if (!Array.isArray(uuids) || !uuids.length) throw new BadRequestException('sin facturas que marcar');
    const userId = this.ctx.get()?.userId ?? null;
    return this.tk.run(async (knex) => {
      const run = await this.ensureRun(knex, anioMes, tipo);
      // `entregado` cuenta igual que `aplicado`: el archivo ya salió de nuestras manos, así
      // que cambiarle la inclusión separa en silencio la decisión registrada de lo que se
      // entregó. Si de verdad hay que corregir, se cancela la corrida y se hace otra.
      if (run.estado === 'aplicado' || run.estado === 'entregado') {
        throw new BadRequestException(
          `la corrida de ${anioMes} ya está ${run.estado}; no se puede cambiar qué entra. Cancélala si hay que corregir.`,
        );
      }
      const filas = uuids.map((u) => ({
        tenant_id: run.tenant_id, run_id: run.id, cfdi_uuid: String(u).toUpperCase(),
        incluida, motivo: incluida ? null : (motivo ?? null), origen: 'manual', created_by: userId,
      }));
      await knex('finance.purchase_book_run_items').insert(filas)
        .onConflict(['tenant_id', 'run_id', 'cfdi_uuid'])
        .merge(['incluida', 'motivo', 'origen']);
      await this.invalidar(knex, run, userId);
      return { ok: true, afectadas: filas.length };
    });
  }

  /**
   * Cambió lo que va en el archivo, así que lo generado antes ya no corresponde: vuelve a
   * `borrador` y se tira el artefacto.
   *
   * ⚠️ Se borra `archivo_contenido` junto con el hash. Limpiar sólo el hash dejaba el TXT
   * viejo descargable — `obtenerArchivo` sólo miraba que el contenido existiera — y lo
   * servía con `X-Archivo-Hash` vacío: un archivo sin firma que ya no era el del mes.
   */
  private async invalidar(knex: any, run: Record<string, unknown>, userId: string | null) {
    if (run['estado'] !== 'generado') return;
    await knex('finance.purchase_book_runs').where({ id: run['id'] }).update({
      estado: 'borrador', archivo_hash: null, archivo_contenido: null,
      updated_at: knex.fn.now(), updated_by: userId,
    });
  }

  /**
   * Cambia la carátula de la corrida: con qué folio y con qué concepto entra la póliza.
   *
   * Existe por los meses que NO tienen libro. ago-2026 es el caso: cero abonos a 212 y sin
   * póliza folio 1, así que "todo lo no asociado" ES el mes — el alcance del complemento es
   * el correcto, pero tiene que entrar como folio 1 "REGISTRO DE COMPRAS DEL MES", no como
   * folio 2 "COMPLEMENTO".
   *
   * Editar el folio a secas sería peor que no editarlo, así que va con guarda: se rechaza si
   * ContPAQi YA tiene ese folio ocupado en el Diario de ese mes. ago-2026 folio 1 está libre
   * (el mes arranca en el 3) y pasa; jul-2026 folio 1 tiene 597 renglones y se rechaza —
   * julio necesita un complemento en folio 2, que es exactamente lo correcto.
   */
  async setCaratula(anioMes: string, datos: { folio_poliza?: number; concepto?: string }, tipo: TipoCorrida = 'complemento') {
    this.mesValido(anioMes);
    const folio = datos.folio_poliza === undefined || datos.folio_poliza === null ? null : Number(datos.folio_poliza);
    const concepto = typeof datos.concepto === 'string' ? datos.concepto.trim() : null;
    if (folio === null && concepto === null) throw new BadRequestException('nada que cambiar');
    if (folio !== null && (!Number.isInteger(folio) || folio < 1 || folio > 999999)) {
      throw new BadRequestException('el folio de la póliza tiene que ser un entero entre 1 y 999999');
    }
    if (concepto !== null && !concepto) throw new BadRequestException('el concepto no puede quedar vacío');

    const userId = this.ctx.get()?.userId ?? null;
    return this.tk.run(async (knex) => {
      const run = await this.ensureRun(knex, anioMes, tipo);
      if (run.estado === 'aplicado' || run.estado === 'entregado') {
        throw new BadRequestException(`la corrida de ${anioMes} ya está ${run.estado}; no se puede cambiar la carátula.`);
      }

      if (folio !== null && folio !== run.folio_poliza) {
        const { rows } = await knex.raw(
          `SELECT coalesce(num_lines, 0) AS patas, round(coalesce(cargos, 0), 2) AS cargos
             FROM analytics.gl_polizas
            WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
              AND tipo_pol = ? AND folio = ? AND anio_mes = ?
            LIMIT 1`,
          [TIPO_POLIZA_DIARIO, String(folio), anioMes],
        );
        if (rows.length) {
          throw new BadRequestException(
            `ContPAQi ya tiene el folio ${folio} del Diario en ${anioMes} `
            + `(${rows[0].patas} renglones por ${rows[0].cargos}). Elegí otro folio.`,
          );
        }
      }

      const patch: Record<string, unknown> = { updated_at: knex.fn.now(), updated_by: userId };
      if (folio !== null) patch['folio_poliza'] = folio;
      if (concepto !== null) patch['concepto'] = concepto;
      await knex('finance.purchase_book_runs').where({ id: run.id }).update(patch);
      // Cambió la carátula: el archivo firmado ya no corresponde.
      await this.invalidar(knex, run, userId);
      return {
        ok: true, anio_mes: anioMes, tipo,
        folio_poliza: folio ?? run.folio_poliza,
        concepto: concepto ?? run.concepto,
      };
    });
  }

  private async ensureRun(knex: any, anioMes: string, tipo: TipoCorrida = 'libro') {
    const existente = await knex('finance.purchase_book_runs')
      .where({ anio_mes: anioMes, tipo }).whereNull('deleted_at').first();
    if (existente) return existente;
    const esComplemento = tipo === 'complemento';
    const [creado] = await knex('finance.purchase_book_runs')
      .insert({
        tenant_id: knex.raw('current_tenant_id()'), anio_mes: anioMes, estado: 'borrador', tipo,
        folio_poliza: esComplemento ? FOLIO_COMPLEMENTO : FOLIO_LIBRO,
        fecha_poliza: this.finDeMes(anioMes).toISOString().slice(0, 10),
        concepto: esComplemento
          ? `COMPLEMENTO REGISTRO DE COMPRAS ${anioMes}`
          : `REGISTRO DE COMPRAS DEL MES ${anioMes}`,
        created_by: this.ctx.get()?.userId ?? null,
      })
      .returning('*');
    return creado;
  }

  // ── El archivo ────────────────────────────────────────────────────────────────────────
  /**
   * Arma los movimientos del asiento. Por factura: cargo a compras exentas, cargo a
   * compras c/IVA y abono al proveedor. Los impuestos, global o por cuenta.
   *
   * Cuidado con dos cosas que ya costaron caro:
   *  - lo que va a la cuenta `502` es el SUBTOTAL gravado, no la base fiscal del IVA —
   *    esa base incluye al IEPS y lo contaría dos veces;
   *  - ese subtotal va NETO de descuento, o la base exenta sale negativa.
   */
  construirMovimientos(facturas: FacturaMes[], modo: ImpuestosModo, conUuid: boolean): Movimiento[] {
    const movs: Movimiento[] = [];
    const ivaPorCuenta = new Map<string, number>();
    const iepsPorCuenta = new Map<string, number>();

    /**
     * Invariante del generador: ningún movimiento sale sin cuenta, nunca. Es la última
     * línea de defensa después de los bloqueantes y de `rechazables`, y existe porque el
     * modo de falla es invisible: `padR(null, 30)` produce 30 espacios, el renglón se ve
     * bien en pantalla, y ContPAQi rechaza el archivo entero al importarlo.
     */
    const pata = (cuenta: string | null, m: Omit<Movimiento, 'cuenta'>, quien: string): Movimiento => {
      if (!cuenta || !String(cuenta).trim()) {
        throw new BadRequestException(`${quien}: falta la cuenta contable. No se puede armar el archivo.`);
      }
      return { cuenta: String(cuenta).trim(), ...m };
    };

    for (const f of [...facturas].sort((a, b) => (a.fecha < b.fecha ? -1 : 1))) {
      const ref = String(f.folio ?? '').slice(0, 10);
      const concepto = conUuid ? f.uuid : '';
      const quien = `${f.emisor_nombre || f.emisor_rfc} folio ${f.folio ?? '(sin folio)'}`;
      if (f.base_exenta > 0.004) {
        movs.push(pata(f.cuenta_compra_exenta, { referencia: ref, abono: false, importe: f.base_exenta, concepto }, `${quien} (compras al 0%)`));
      }
      if (f.subtotal16 > 0.004) {
        movs.push(pata(f.cuenta_compra_iva, { referencia: ref, abono: false, importe: f.subtotal16, concepto }, `${quien} (compras c/IVA)`));
      }
      movs.push(pata(f.cuenta_proveedor, { referencia: ref, abono: true, importe: f.total, concepto }, `${quien} (proveedor)`));
      if (f.iva > 0.004) ivaPorCuenta.set(f.account_suffix!, r2((ivaPorCuenta.get(f.account_suffix!) ?? 0) + f.iva));
      if (f.ieps > 0.004) iepsPorCuenta.set(f.account_suffix!, r2((iepsPorCuenta.get(f.account_suffix!) ?? 0) + f.ieps));
    }

    if (modo === 'por-cuenta') {
      for (const [suf, monto] of [...ivaPorCuenta].sort()) {
        movs.push({ cuenta: CTA_IVA, referencia: suf, abono: false, importe: monto, concepto: 'IVA acreditable' });
      }
      for (const [suf, monto] of [...iepsPorCuenta].sort()) {
        movs.push({ cuenta: CTA_IEPS, referencia: suf, abono: false, importe: monto, concepto: 'IEPS acreditable' });
      }
    } else {
      const iva = r2([...ivaPorCuenta.values()].reduce((a, b) => a + b, 0));
      const ieps = r2([...iepsPorCuenta.values()].reduce((a, b) => a + b, 0));
      if (iva > 0.004) movs.push({ cuenta: CTA_IVA, referencia: '', abono: false, importe: iva, concepto: '' });
      if (ieps > 0.004) movs.push({ cuenta: CTA_IEPS, referencia: '', abono: false, importe: ieps, concepto: '' });
    }
    return movs;
  }

  /**
   * El TXT del mes. El layout vive en `./poliza-txt` — acá sólo se resuelve la fecha de la
   * póliza, que es el último día del mes.
   */
  construirTxt(anioMes: string, folio: number, concepto: string, movs: Movimiento[]): string {
    const d = this.finDeMes(anioMes);
    const fecha = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    return construirTxt(fecha, folio, concepto, movs);
  }

  /** Desarma un TXT de póliza. El parser vive en ./poliza-txt, junto al layout. */
  parsearTxt(txt: string): PolizaTxtParseada {
    return parsearTxt(txt);
  }

  /**
   * Genera el archivo del mes y deja la corrida en `generado`, firmada por su hash.
   *
   * **Sólo genera el `complemento`.** El modo `libro` sirve de tablero de lectura, pero su
   * camino de generación es un footgun sin caso de uso: cualquier mes real cae en "la
   * póliza ya existe" (y entonces lo que falta es el complemento) o "no existe" (y entonces
   * el complemento ES el mes, sólo que con folio 1 — ver `setCaratula`). Y el alcance
   * `libro` es estrictamente más peligroso: arrastra los CFDIs que ContPAQi YA tiene
   * asociados, que es una vía de duplicado que ninguna de las dos puertas cubre.
   */
  async generar(anioMes: string, opts: { impuestos?: ImpuestosModo; uuid?: boolean; tipo?: TipoCorrida } = {}) {
    this.mesValido(anioMes);
    const modo: ImpuestosModo = opts.impuestos === 'por-cuenta' ? 'por-cuenta' : 'global';
    const conUuid = opts.uuid !== false;
    const tipo: TipoCorrida = opts.tipo === 'complemento' ? 'complemento' : 'libro';
    if (tipo === 'libro') {
      throw new BadRequestException(
        'el libro completo del mes ya no se genera: arrastra facturas que ContPAQi ya tiene asociadas y las duplicaría. '
        + 'Usá "Movimientos no asociados"; si el mes no tiene póliza, cambiale el folio a 1 en la carátula.',
      );
    }
    const { facturas, resumen, bloqueantes } = await this.getMes(anioMes, tipo);
    const dentro = facturas.filter((f) => f.incluida);
    if (!dentro.length) throw new BadRequestException('no hay movimientos sin asociar por entregar en este mes');

    // Si alguna de las incluidas ya está posteada, el archivo duplicaría un asiento. No es
    // un aviso, es un bloqueo — el daño es irreversible del lado de ContPAQi y nadie lo
    // notaría hasta cuadrar la balanza. Va sin condicionar por tipo: la asimetría anterior
    // (sólo en `complemento`) era un accidente del orden en que se escribió, y dejaba sin
    // freno justo al modo que abarca el mes entero.
    const dobles = dentro.filter((f) => f.ya_en_poliza);
    if (dobles.length) {
      throw new BadRequestException(
        `${dobles.length} factura(s) incluidas ya tienen su importe en la póliza del mes: se duplicarían. Exclúyelas antes de generar.`,
      );
    }

    // Frenos duros: mejor no entregar archivo que entregar uno que ContPAQi va a rechazar.
    // Cada pata que el asiento vaya a escribir tiene que tener su cuenta, y esa cuenta
    // tiene que EXISTIR del lado de ContPAQi — ver la nota de los `*_existe` en FacturaMes.
    const rechazables = dentro.filter((f) => !f.account_suffix || !f.cuenta_existe
      || (f.subtotal16 > 0.004 && (!f.cuenta_compra_iva || !f.compra_iva_existe))
      || (f.base_exenta > 0.004 && (!f.cuenta_compra_exenta || !f.compra_exenta_existe))
      || f.base_exenta < -0.004);
    if (rechazables.length) {
      throw new BadRequestException(
        `${rechazables.length} factura(s) no se pueden postear: ${bloqueantes.join(' · ')}. Resuélvelo o exclúyelas.`,
      );
    }

    const movs = this.construirMovimientos(dentro, modo, conUuid);
    const cargos = r2(movs.filter((m) => !m.abono).reduce((a, m) => a + m.importe, 0));
    const abonos = r2(movs.filter((m) => m.abono).reduce((a, m) => a + m.importe, 0));
    if (Math.abs(r2(cargos - abonos)) >= 0.01) {
      throw new BadRequestException(`la póliza no cuadra: cargos ${cargos} vs abonos ${abonos}`);
    }

    return this.tk.run(async (knex) => {
      const run = await this.ensureRun(knex, anioMes, tipo);
      if (run.estado === 'aplicado') throw new BadRequestException('el mes ya está aplicado');

      // Se vuelve a mirar el folio acá y no sólo en `setCaratula`: entre editar la carátula
      // y generar pudo correr el feed y traerse una póliza nueva en ese folio. Es el último
      // momento en que se puede avisar antes de que el archivo salga.
      const { rows: ocupado } = await knex.raw(
        `SELECT coalesce(num_lines, 0) AS patas, round(coalesce(cargos, 0), 2) AS cargos
           FROM analytics.gl_polizas
          WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
            AND tipo_pol = ? AND folio = ? AND anio_mes = ?
          LIMIT 1`,
        [TIPO_POLIZA_DIARIO, String(run.folio_poliza ?? FOLIO_COMPLEMENTO), anioMes],
      );
      if (ocupado.length) {
        throw new BadRequestException(
          `ContPAQi ya tiene el folio ${run.folio_poliza} del Diario en ${anioMes} `
          + `(${ocupado[0].patas} renglones por ${ocupado[0].cargos}). Cambiá el folio de la carátula antes de generar.`,
        );
      }

      const concepto = run.concepto || `REGISTRO DE COMPRAS DEL MES ${anioMes}`;
      const txt = this.construirTxt(anioMes, run.folio_poliza ?? FOLIO_LIBRO, concepto, movs);
      const hash = createHash('sha256').update(txt, 'latin1').digest('hex');
      const nombre = tipo === 'complemento'
        ? `complemento-compras-${anioMes}.txt`
        : `poliza-compras-${anioMes}.txt`;
      const userId = this.ctx.get()?.userId ?? null;

      await knex('finance.purchase_book_runs').where({ id: run.id }).update({
        estado: 'generado', facturas: dentro.length, renglones: movs.length + 1,
        total_cargos: cargos, total_abonos: abonos,
        subtotal_exento: resumen['subtotal_exento'], subtotal_gravado: resumen['subtotal_gravado'],
        total_iva: resumen['iva'], total_ieps: resumen['ieps'],
        // El contenido se guarda, no sólo su hash: `fiscal.cfdis` sigue creciendo, así que
        // este archivo no se puede reproducir mañana. Es la evidencia de lo entregado.
        archivo_hash: hash, archivo_nombre: nombre, archivo_contenido: txt,
        impuestos_modo: modo, incluye_uuid: conUuid,
        generado_at: knex.fn.now(), generado_by: userId,
        updated_at: knex.fn.now(), updated_by: userId,
      });
      this.logger.log(`Póliza ${tipo} ${anioMes}: ${dentro.length} facturas · ${movs.length} movimientos · ${cargos}`);
      return { anio_mes: anioMes, tipo, nombre, hash, folio: run.folio_poliza ?? FOLIO_LIBRO, facturas: dentro.length, renglones: movs.length + 1, cargos, abonos, txt };
    });
  }

  /**
   * Devuelve el TXT **ya generado**, tal cual quedó guardado. Es sólo lectura a propósito.
   *
   * Antes la descarga llamaba a `generar()`, y eso escribía: bajar un mes que ya estaba en
   * `entregado` lo regresaba a `generado` (el trámite retrocedía solo) y recalculaba el
   * hash, así que si entre generar y descargar entraba un CFDI nuevo el archivo bajado ya
   * no era el firmado — y nadie se enteraba, porque el hash se pisaba junto con él.
   */
  async obtenerArchivo(anioMes: string, tipo: TipoCorrida = 'libro') {
    this.mesValido(anioMes);
    return this.tk.run(async (knex) => {
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes, tipo }).whereNull('deleted_at').first();
      // El estado se mira además del contenido: en `borrador` no hay archivo vigente aunque
      // haya quedado texto de una corrida anterior. Cinturón redundante con `invalidar()`.
      if (!run || run.estado === 'borrador' || !run.archivo_contenido) {
        throw new NotFoundException(
          `${anioMes} no tiene archivo generado todavía. Genéralo primero.`,
        );
      }
      const parsed = this.parsearTxt(run.archivo_contenido as string);
      return {
        anio_mes: anioMes,
        tipo,
        nombre: run.archivo_nombre || `${tipo === 'complemento' ? 'complemento' : 'poliza'}-compras-${anioMes}.txt`,
        hash: run.archivo_hash as string,
        txt: run.archivo_contenido as string,
        // Los movimientos del archivo ENTREGADO, no un recálculo. Los consumen el respaldo
        // en Excel y el CSV del asociador de CFDI.
        movimientos: parsed.movimientos,
        invalidos: parsed.invalidos,
      };
    });
  }

  /**
   * El respaldo del archivo entregado: sus movimientos y las facturas que lo componen.
   *
   * A ContPAQi va el TXT **y su respaldo** — nadie sube $48.2M a la contabilidad de la
   * empresa desde un archivo de longitud fija que no puede leer. Esta es la hoja que
   * reemplaza al Excel que se armaba a mano.
   *
   * Todo sale del **archivo entregado**, no de los datos de hoy. Importa: si entre generar
   * y descargar el respaldo entró un CFDI nuevo, tomar las facturas de `getMes()` haría que
   * las dos hojas describan cosas distintas y el respaldo dejaría de cuadrar contra el TXT.
   * Cuando el archivo lleva UUID (el default) las facturas se resuelven desde los conceptos
   * de sus propios renglones; si no, se cae a la decisión registrada y se declara.
   */
  async respaldo(anioMes: string, tipo: TipoCorrida = 'complemento') {
    this.mesValido(anioMes);
    return this.tk.run(async (knex) => {
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes, tipo }).whereNull('deleted_at').first();
      if (!run || run.estado === 'borrador' || !run.archivo_contenido) {
        throw new NotFoundException(`${anioMes} no tiene archivo generado todavía. Genéralo primero.`);
      }
      const { movimientos, invalidos, header } = parsearTxt(run.archivo_contenido as string);
      if (invalidos.length) {
        throw new BadRequestException(
          `el archivo guardado de ${anioMes} no cumple el layout (${invalidos[0].motivo}); no se puede armar el respaldo.`,
        );
      }

      const uuids = [...new Set(movimientos.map((m) => m.concepto).filter((c) => /^[0-9A-Fa-f-]{36}$/.test(c)))]
        .map((u) => u.toUpperCase());
      const desdeArchivo = uuids.length > 0;

      const { rows: facturas } = desdeArchivo
        ? await knex.raw(
          `SELECT DISTINCT ON (upper(f.uuid))
                  upper(f.uuid) AS uuid, f.emisor_rfc, f.emisor_nombre, f.serie, f.folio, f.fecha,
                  f.total,
                  coalesce((f.impuestos->>'iva_trasladado')::numeric, 0)  AS iva,
                  coalesce((f.impuestos->>'ieps_trasladado')::numeric, 0) AS ieps,
                  coalesce((f.impuestos->>'subtotal_iva_16')::numeric, 0) AS subtotal16,
                  a.account_suffix, a.supplier_name,
                  a.cuenta_proveedor, a.cuenta_compra_exenta, a.cuenta_compra_iva
             FROM fiscal.cfdis f
             LEFT JOIN finance.gl_supplier_accounts a
               ON a.tenant_id = f.tenant_id AND a.rfc = f.emisor_rfc AND a.deleted_at IS NULL
            WHERE f.tenant_id = current_tenant_id() AND upper(f.uuid) = ANY (?)
            ORDER BY upper(f.uuid), a.usado_en_asiento DESC NULLS LAST, a.account_suffix`,
          [uuids],
        )
        : await knex.raw(
          `SELECT DISTINCT ON (upper(f.uuid))
                  upper(f.uuid) AS uuid, f.emisor_rfc, f.emisor_nombre, f.serie, f.folio, f.fecha,
                  f.total,
                  coalesce((f.impuestos->>'iva_trasladado')::numeric, 0)  AS iva,
                  coalesce((f.impuestos->>'ieps_trasladado')::numeric, 0) AS ieps,
                  coalesce((f.impuestos->>'subtotal_iva_16')::numeric, 0) AS subtotal16,
                  a.account_suffix, a.supplier_name,
                  a.cuenta_proveedor, a.cuenta_compra_exenta, a.cuenta_compra_iva
             FROM finance.purchase_book_run_items i
             JOIN fiscal.cfdis f
               ON f.tenant_id = i.tenant_id AND upper(f.uuid) = i.cfdi_uuid
             LEFT JOIN finance.gl_supplier_accounts a
               ON a.tenant_id = f.tenant_id AND a.rfc = f.emisor_rfc AND a.deleted_at IS NULL
            WHERE i.tenant_id = current_tenant_id() AND i.run_id = ? AND i.incluida
            ORDER BY upper(f.uuid), a.usado_en_asiento DESC NULLS LAST, a.account_suffix`,
          [run.id],
        );

      return {
        anio_mes: anioMes,
        tipo,
        folio_poliza: header?.folio ?? run.folio_poliza,
        concepto: header?.concepto ?? run.concepto,
        estado: run.estado,
        archivo_nombre: run.archivo_nombre,
        archivo_hash: run.archivo_hash,
        generado_at: run.generado_at,
        entregado_at: run.entregado_at,
        entregado_a: run.entregado_a,
        total_cargos: Number(run.total_cargos ?? 0),
        total_abonos: Number(run.total_abonos ?? 0),
        movimientos,
        facturas: facturas.map((f: Record<string, unknown>) => {
          const total = r2(f['total']), iva = r2(f['iva']), ieps = r2(f['ieps']);
          const subtotal16 = r2(f['subtotal16']);
          return {
            uuid: String(f['uuid']), emisor_rfc: String(f['emisor_rfc'] ?? ''),
            emisor_nombre: String(f['emisor_nombre'] ?? ''),
            serie: (f['serie'] as string) ?? null, folio: (f['folio'] as string) ?? null,
            fecha: String(f['fecha']).slice(0, 10),
            base_exenta: r2(total - iva - ieps - subtotal16), subtotal16, ieps, iva, total,
            supplier_name: (f['supplier_name'] as string) ?? null,
            cuenta_proveedor: (f['cuenta_proveedor'] as string) ?? null,
            cuenta_compra_exenta: (f['cuenta_compra_exenta'] as string) ?? null,
            cuenta_compra_iva: (f['cuenta_compra_iva'] as string) ?? null,
          };
        }),
        /** `archivo` = las facturas salen de los UUID del propio TXT. `decision` = del registro. */
        facturas_origen: desdeArchivo ? 'archivo' : 'decision',
      };
    });
  }

  /** Mueve el trámite. `entregado` = se le pasó a quien lo sube; `aplicado` = ya está en ContPAQi. */
  async marcar(anioMes: string, estado: Extract<EstadoRun, 'entregado' | 'aplicado' | 'cancelado'>, datos: { entregado_a?: string; notas?: string; tipo?: TipoCorrida } = {}) {
    this.mesValido(anioMes);
    const tipo: TipoCorrida = datos.tipo === 'complemento' ? 'complemento' : 'libro';
    return this.tk.run(async (knex) => {
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes, tipo }).whereNull('deleted_at').first();
      if (!run) throw new NotFoundException(`no hay corrida ${tipo} para ${anioMes}`);
      if (estado !== 'cancelado' && run.estado === 'borrador') {
        throw new BadRequestException('genera el archivo antes de mover el trámite');
      }
      const userId = this.ctx.get()?.userId ?? null;
      const patch: Record<string, unknown> = { estado, updated_at: knex.fn.now(), updated_by: userId };
      if (estado === 'entregado') { patch['entregado_at'] = knex.fn.now(); patch['entregado_by'] = userId; patch['entregado_a'] = datos.entregado_a ?? null; }
      if (estado === 'aplicado') { patch['aplicado_at'] = knex.fn.now(); patch['aplicado_by'] = userId; }
      if (datos.notas) patch['notas'] = datos.notas;
      await knex('finance.purchase_book_runs').where({ id: run.id }).update(patch);
      return { ok: true, anio_mes: anioMes, estado };
    });
  }

  /**
   * LC.7 — compara lo que se entregó contra la póliza que quedó en ContPAQi. Se compara
   * el multiset `(cuenta, cargo/abono, importe)`: si algo se editó a mano al subirlo,
   * aparece aquí.
   */
  async cuadrarContraContpaqi(anioMes: string) {
    this.mesValido(anioMes);
    const { facturas } = await this.getMes(anioMes);
    return this.tk.run(async (knex) => {
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes }).whereNull('deleted_at').first();
      const dentro = facturas.filter((f) => f.incluida && f.account_suffix && f.cuenta_existe);
      const movs = this.construirMovimientos(dentro, (run?.impuestos_modo as ImpuestosModo) ?? 'global', false);

      const { rows } = await knex.raw(
        `SELECT cuenta, cargo_abono, importe FROM analytics.gl_poliza_lines
          WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
            AND tipo_pol = ? AND folio = ? AND anio_mes = ?`,
        [TIPO_POLIZA_DIARIO, String(run?.folio_poliza ?? 1), anioMes],
      );

      const clave = (c: string, ab: string, i: number) => `${c}|${ab}|${Math.round(i * 100)}`;
      const gen = new Map<string, number>(); const real = new Map<string, number>();
      movs.forEach((m) => { const k = clave(m.cuenta, m.abono ? 'A' : 'C', m.importe); gen.set(k, (gen.get(k) ?? 0) + 1); });
      rows.forEach((m: Record<string, unknown>) => {
        const k = clave(String(m['cuenta']), String(m['cargo_abono']), Number(m['importe']));
        real.set(k, (real.get(k) ?? 0) + 1);
      });
      let casan = 0, soloNuestro = 0, soloContpaqi = 0;
      for (const k of new Set([...gen.keys(), ...real.keys()])) {
        const g = gen.get(k) ?? 0, a = real.get(k) ?? 0;
        casan += Math.min(g, a); soloNuestro += Math.max(0, g - a); soloContpaqi += Math.max(0, a - g);
      }
      return {
        anio_mes: anioMes,
        patas_nuestras: movs.length,
        patas_en_contpaqi: rows.length,
        casan, solo_nuestro: soloNuestro, solo_contpaqi: soloContpaqi,
        // Sin póliza del lado de ContPAQi el mes simplemente no se subió.
        existe_en_contpaqi: rows.length > 0,
      };
    });
  }
}
