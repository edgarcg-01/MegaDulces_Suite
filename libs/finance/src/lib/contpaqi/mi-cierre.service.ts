import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import {
  TenantKnexService, TenantContextService, evalInput, composeFreshness,
} from '@megadulces/platform-core';
import type { Freshness, Coverage } from '@megadulces/contracts';
import {
  armarBandeja, FAMILIAS, type Bandeja, type FilaCapturaCruda, type EntregaCruda,
} from './mi-cierre.engine';

/**
 * `[CPA.10]` — **La bandeja «Mi cierre»**: la I/O. La regla vive en `mi-cierre.engine.ts`.
 *
 * ── Por qué esto existe, medido contra PROD el 2026-10-12 ─────────────────────────────────────
 * El rol `contabilidad` hizo **3,604 llamadas en 10 días activos** y **cero** a `/api/fiscal/*` y
 * a `/api/contabilidad/*`; 1,806 de ellas (50.1 %) fueron al módulo de comprobación de gastos,
 * que no es suyo. Tienen los **19 permisos `FISCAL_*` en `true`** y entran todos los días. No es
 * acceso ni permiso: las 16 pestañas del proyecto son **visores**, y su trabajo es **teclear**
 * ~12,357 renglones al mes en ContPAQi. Esta bandeja es la portada que contesta la pregunta que
 * sí tienen: *¿qué me toca hoy y de eso cuánto me armás vos?*
 *
 * ⛔ **No re-juzga si el mes está completo.** Para eso enlaza al semáforo de `[CPA.0]`, que ya lo
 * hace contra un testigo independiente y con umbral registrado. Dos tableros que emiten el mismo
 * veredicto por caminos distintos terminan contradiciéndose; acá se **compone**, no se duplica.
 *
 * ⚠️ Se lee la VISTA, no una matvista, y eso está medido: la consulta da **120–129 ms** en tres
 * corridas contra prod (gate 500 ms). Su hermana `[CPA.0.2]` sí necesitó matvista porque arrastra
 * medianas de 6 meses y tres testigos; ésta sólo agrupa `gl_polizas`. Materializar por costo es
 * legítimo (GOTCHAS §19) — materializar sin medir el costo es inventarse un problema.
 */

const VISTA = 'analytics.v_contpaqi_captura_mensual';
const EXPORTS = 'contpaqi.poliza_exports';
/** El carril `contpaqi` corre @1 min; 6 h de tolerancia deja ver una caída real sin gritar por ruido. */
const HORAS_FRESCURA = 6;

export type { Bandeja, FilaBandeja, EstadoBandeja } from './mi-cierre.engine';

export interface RespuestaMiCierre {
  bandeja: Bandeja;
  freshness: Freshness;
  coverage: Coverage;
  /** Milisegundos reales de la consulta. Se publica aunque incomode. */
  query_ms: number;
}

/** Lo que se puede declarar al cerrar el lazo. Son TRES, no dos: "se cargó sin afectar" existe. */
export const RESULTADOS = ['aplicada', 'sin_afectar', 'rechazada'] as const;
export type ResultadoEntrega = (typeof RESULTADOS)[number];

export interface RegistrarResultadoDto {
  resultado: ResultadoEntrega;
  /**
   * ⛔ TERNARIO a propósito. `true` sólo cuando hay bitácora de ContPAQi que lo respalde.
   * `undefined`/`null` = nadie comprobó, y el engine lo pinta `aplicada_sin_verificar`.
   */
  verificada?: boolean | null;
  motivo?: string | null;
}

@Injectable()
export class MiCierreService {
  private readonly logger = new Logger(MiCierreService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** La bandeja de un mes (`YYYY-MM`). Por omisión, el que corre. */
  async bandeja(mes?: string): Promise<RespuestaMiCierre> {
    const tenantId = this.tenantCtx.requireTenantId();
    const anioMes = mes ?? mesActual();

    const t0 = Date.now();
    const { filas, entregas, dataAsOf } = await this.tk.run(async (trx) => {
      const filas = (await trx(VISTA)
        .where('tenant_id', tenantId)
        .andWhere('anio_mes', anioMes)
        .orderBy('orden', 'asc')) as unknown as FilaCapturaCruda[];

      /*
       * Una entrega por (periodo, evento_tipo): la ÚLTIMA. `poliza_exports` es por evento
       * individual (su índice único es `(tenant_id, evento_tipo, evento_id)`), así que una
       * familia puede tener muchas; lo que la bandeja pinta es en qué parte del camino va la
       * familia, y eso lo marca la más atrasada. `DISTINCT ON` con el orden del camino.
       */
      const entregas = (await trx.raw(
        `SELECT DISTINCT ON (evento_tipo)
                periodo, evento_tipo, estado, verificada, total, motivo,
                updated_at AS actualizada_en
           FROM ${EXPORTS}
          WHERE tenant_id = ? AND periodo = ?
          ORDER BY evento_tipo,
                   CASE estado WHEN 'rechazada' THEN 0 WHEN 'armada' THEN 1
                               WHEN 'entregada' THEN 2 ELSE 3 END,
                   updated_at DESC`,
        [tenantId, anioMes],
      )) as unknown as { rows: EntregaCruda[] };

      /*
       * ⚠️ La frescura NO se mide con `now()`: eso diría "recién medido" por el solo hecho de
       * haber contestado (Fase VP — 21 de 24 píldoras medían el reloj del navegador). Se mide
       * con lo último que ENTRÓ por el carril que alimenta la señal.
       */
      const [{ max } = { max: null }] = (await trx('analytics.gl_polizas')
        .where('tenant_id', tenantId)
        .andWhere('source', 'contpaqi')
        .max({ max: 'computed_at' })) as unknown as Array<{ max: string | null }>;

      return { filas, entregas: entregas.rows ?? [], dataAsOf: max };
    });
    const query_ms = Date.now() - t0;

    const bandeja = armarBandeja(filas, entregas);
    if (!bandeja) throw new NotFoundException(`No hay pólizas de ContPAQi para ${anioMes}.`);

    const sinFuente = FAMILIAS.filter((f) => !f.automatizable);
    const conMapaPendiente = bandeja.filas.filter((f) => f.estado === 'falta_mapa');

    return {
      bandeja,
      freshness: composeFreshness([
        evalInput('contpaqi', 'Pólizas de ContPAQi (carril @1 min)', dataAsOf, HORAS_FRESCURA),
      ]),
      coverage: {
        // ⛔ `measured` dice si se pudo medir, no si salió bien. Sin renglones no se midió nada.
        measured: bandeja.total_renglones > 0,
        pct: bandeja.cobertura_pct,
        note: [
          `De ${bandeja.total_renglones.toLocaleString('es-MX')} renglones del mes, `
          + `${bandeja.automatizables.toLocaleString('es-MX')} están en familias cuya fuente ya `
          + 'vive en la Suite y a grano más fino que el capturado.',
          sinFuente.length
            ? `⛔ SIN FUENTE: ${sinFuente.map((f) => `${f.etiqueta} (${f.no_automatizable?.dueno})`).join(', ')}.`
            : '',
          conMapaPendiente.length
            ? `⚠️ Con fuente pero SIN diccionario: ${conMapaPendiente.map((f) => f.etiqueta).join(', ')} `
              + '— salen "falta mapa", no listas.'
            : '',
        ].filter(Boolean).join(' '),
      },
      query_ms,
    };
  }

  /**
   * Cierra el lazo: qué pasó al cargar el archivo en ContPAQi.
   *
   * ⛔ **Nunca escribe `verificada = true` por su cuenta.** Lo que llega sin bitácora se guarda
   * con `verificada = null`, que el engine pinta `aplicada_sin_verificar` — ADR-056: lo que no se
   * pudo comprobar se declara, no se pinta en verde. Y ADR-040 sigue intacto: esto registra lo
   * que la contadora dice que pasó en ContPAQi; no escribe a ContPAQi.
   */
  async registrarResultado(
    eventoTipo: string,
    periodo: string,
    dto: RegistrarResultadoDto,
    usuario: string,
  ): Promise<{ actualizadas: number; estado: string; verificada: boolean | null }> {
    const tenantId = this.tenantCtx.requireTenantId();

    if (!RESULTADOS.includes(dto.resultado)) {
      throw new BadRequestException(`Resultado inválido: ${dto.resultado}.`);
    }
    if (!esMes(periodo)) throw new BadRequestException(`Periodo inválido: ${periodo}.`);
    if (dto.resultado === 'rechazada' && !dto.motivo?.trim()) {
      // Una rechazada sin motivo es un hueco que nadie vuelve a llenar.
      throw new BadRequestException('Una entrega rechazada necesita el motivo.');
    }

    /*
     * `sin_afectar` NO es `aplicada`: entró con «Cargar sin Afectar», o sea que el formato pasó
     * y los saldos no se tocaron. La familia sigue pendiente, y por eso vuelve a `entregada`.
     */
    const estado = dto.resultado === 'aplicada' ? 'aplicada'
      : dto.resultado === 'rechazada' ? 'rechazada'
      : 'entregada';

    // ⛔ Sólo `true` explícito verifica. `undefined` y `null` son "nadie comprobó", no `false`.
    const verificada = dto.verificada === true ? true
      : dto.verificada === false ? false
      : null;

    const motivo = dto.motivo?.trim()
      || (dto.resultado === 'sin_afectar'
        ? 'Se cargó sin afectar: el formato pasó, los saldos no se tocaron.'
        : verificada === null && dto.resultado === 'aplicada'
          ? `Marcada aplicada por ${usuario} sin bitácora de ContPAQi.`
          : null);

    const actualizadas = await this.tk.run(async (trx) =>
      trx(EXPORTS)
        .where({ tenant_id: tenantId, periodo, evento_tipo: eventoTipo })
        .update({ estado, verificada, motivo, updated_at: trx.fn.now() }),
    );

    if (actualizadas === 0) {
      throw new NotFoundException(
        `No hay ninguna entrega de "${eventoTipo}" en ${periodo} que registrar.`,
      );
    }

    this.logger.log(
      `[CPA.10] ${usuario} declaró "${dto.resultado}" sobre ${eventoTipo} ${periodo}: `
      + `${actualizadas} entrega(s) → estado=${estado} verificada=${verificada}`,
    );
    return { actualizadas, estado, verificada };
  }

  /**
   * `[LC.21]` El desglose de un renglón de la bandeja: las pólizas de UNA familia en UN mes, con sus
   * renglones y cargos. Cada póliza abre su detalle en `GET contabilidad/polizas/detail`.
   *
   * ⚠️ La clasificación es COPIA del `CASE` de `v_contpaqi_captura_mensual` (la vista manda) y
   * `test-newdb-mi-cierre-desglose.js` cruza las dos — pólizas, renglones y cargos por familia y mes.
   */
  async polizas(opts: { mes: string; familia: string; page?: number }): Promise<PolizasMiCierre> {
    if (!esMes(opts.mes)) throw new BadRequestException('mes inválido, se espera YYYY-MM');
    if (!FAMILIAS.some((f) => f.familia === opts.familia)) {
      throw new BadRequestException(`familia inválida: ${opts.familia}`);
    }
    const page = Math.max(1, Number(opts.page) || 1);
    const size = 100;
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const base = () => trx('analytics.gl_polizas as p')
        .where('p.tenant_id', tenantId).andWhere('p.source', 'contpaqi').andWhere('p.anio_mes', opts.mes)
        .whereRaw(`(${CLASIFICA_POLIZA}) = ?`, [opts.familia]);
      const t = await base().select(
        trx.raw('count(*)::int AS polizas'),
        trx.raw('COALESCE(sum(p.num_lines), 0)::int AS renglones'),
        trx.raw('ROUND(COALESCE(sum(p.cargos), 0)::numeric, 2) AS cargos'),
      ).first();
      const rows = await base()
        .orderBy([{ column: 'p.fecha' }, { column: 'p.tipo_pol' }, { column: 'p.folio' }])
        .limit(size).offset((page - 1) * size)
        .select('p.ejercicio', 'p.periodo', 'p.tipo_pol', 'p.folio', 'p.sucursal', 'p.concepto', 'p.num_lines', 'p.cargos',
          trx.raw(`to_char(p.fecha, 'YYYY-MM-DD') AS fecha`));
      return {
        mes: opts.mes, familia: opts.familia, page, page_size: size,
        polizas: Number(t?.polizas ?? 0), renglones: Number(t?.renglones ?? 0), cargos: Number(t?.cargos ?? 0),
        filas: rows.map((r: Record<string, unknown>) => ({
          ejercicio: Number(r['ejercicio']), periodo: Number(r['periodo']), tipo_pol: String(r['tipo_pol']),
          folio: String(r['folio']), sucursal: (r['sucursal'] as string) ?? null,
          fecha: (r['fecha'] as string) ?? null,
          concepto: (r['concepto'] as string) ?? null,
          renglones: Number(r['num_lines'] ?? 0), cargos: Number(r['cargos'] ?? 0),
        })),
      };
    });
  }
}

/**
 * `[LC.21]` COPIA del `CASE` de `v_contpaqi_captura_mensual` (el orden importa: gana la primera que
 * casa). No se edita uno sin el otro; la prueba de desglose lo vigila.
 */
const CLASIFICA_POLIZA = `CASE
  WHEN p.concepto ILIKE 'NOM %' THEN 'nomina'
  WHEN p.concepto ILIKE '%COMISION%' THEN 'comisiones_bancarias'
  WHEN p.concepto ILIKE '%TRASPASO%' THEN 'traspasos'
  WHEN p.concepto ILIKE '%COMPRAS DEL MES%' OR p.concepto ILIKE '%REGISTRO DE COMPRAS%' THEN 'libro_compras'
  WHEN p.concepto ILIKE 'VENTAS %' THEN 'cobranza_sucursal'
  WHEN p.concepto ILIKE 'VTA%' THEN 'venta_diaria'
  WHEN p.concepto ILIKE 'TLMKT%' THEN 'venta_telemarketing'
  WHEN p.concepto ILIKE 'PAGO%' THEN 'pago_gasto'
  WHEN p.concepto ILIKE 'GASTOS %' THEN 'gastos_varios'
  ELSE 'otros' END`;

/** `[LC.21]` Las pólizas de una familia de la bandeja en un mes. */
export interface PolizasMiCierre {
  mes: string; familia: string; page: number; page_size: number;
  polizas: number; renglones: number; cargos: number;
  filas: {
    ejercicio: number; periodo: number; tipo_pol: string; folio: string; sucursal: string | null;
    fecha: string | null; concepto: string | null; renglones: number; cargos: number;
  }[];
}

function mesActual(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * ⚠️ Se valida la FORMA antes de pasarla al `where`. Knex parametriza, así que esto no es contra
 * inyección: es contra un `?mes=2026` que compara texto contra texto y devuelve una ventana
 * silenciosamente equivocada.
 */
export function esMes(v: string | undefined): v is string {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}
