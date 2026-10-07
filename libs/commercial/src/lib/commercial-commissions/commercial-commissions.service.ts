import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * RD.6 / **RD.17-RD.19** — Motor de comisiones de Ruta Directa.
 *
 * Reemplaza las hojas `COMISIONES`, `FORMATO DE PAGO` y `FORMATO DE SUPERVISOR` de
 * `INDICADORES RD 2026.xlsx`, que es con lo que hoy se paga cada quincena.
 *
 * ── Que cambio en RD.17-RD.19, y por que ─────────────────────────────────────────────────
 *
 * **1. El universo sale del dato, no de una lista tecleada.** Antes el bucle iteraba
 * `commission_route_config` -- 13 filas del Excel -- y todo lo que vendia fuera de ahi se
 * caia sin linea y sin aviso: medido, **9 route_code y $9,367,131 de subtotal en 2026**.
 * Ahora itera `analytics.v_rd_commission_universe`, que junta el resolvedor derivado
 * (`mv_rd_route_identity`, 11 camiones por PK y FK), la config de nomina y lo que de verdad
 * vende. Lo que no comisiona **sale igual, con su veredicto**.
 *
 * **2. ⛔ La venta NO se contaba dos veces -- se midio y la sospecha quedo REFUTADA.** Se
 * creyo que el `UNION ALL` de `v_route_sales_lines` duplicaba tickets porque no tiene guarda
 * de fecha. Medido en prod el 2026-10-07: **3 dias con dos capturas en 120 d y CERO folios
 * compartidos en 200 d** -- son el corte de sistema (el push trae el folio de apertura de .68
 * y Wincaja la venta real del dia). ⭐ Y el "arreglo" habria sido una regresion: arbitrar a
 * favor del push publicaba .68 donde hay ,075.36 en la ruta 502. **La venta se sigue
 * sumando**, que estaba bien; lo que se agrega es la procedencia (`fuentes`) y un candado que
 * vigila la duplicacion a nivel FOLIO.
 *
 * **3. El costo deja de inflar el markup.** Antes: `sum(costo)` de los dias que lo tenian
 * contra `sum(subtotal)` de **todos** los dias. Un periodo que cruza el cutover (la quincena
 * 13 contiene el 2026-06-29) inflaba el markup ~27% con el umbral del bono de PH en 25%.
 * Ahora el numerador es `subtotal_con_costo`: numerador y denominador cubren los mismos dias.
 *
 * **4. El peor caso se ORDENA, no se saca con `min()`.** El agregado anterior usaba
 * `min(costo_status)` "para declarar el caso menos bueno" y hacia lo contrario:
 * `'erp_reexpresado_cada_corrida' < 'sin_dato_en_la_fuente'` alfabeticamente. Funcionaba por
 * suerte en `subtotal_origen` y fallaba en el costo. Ahora la precedencia esta escrita.
 *
 * **5. El total es el que se paga.** La deduccion del supervisor es por PERSONA y agregada
 * sobre sus rutas; el motor la dejaba fuera de toda suma y `total_a_pagar` publicaba el
 * bruto. Ahora hay `total_deduccion` y `total_neto`, y si la deduccion no esta cargada se
 * **declara** (`sin_configurar`) en vez de leerse como cero.
 *
 * **6. Motor decide / humano aprueba sigue valiendo (ADR-016)** -- y ahora el motor ademas
 * **se niega**: una corrida que no pasa una compuerta dura nace `bloqueada`, no `borrador`.
 * Nacer borrador la deja a un clic de aprobarse.
 *
 * TODO lo que decide sale de la DB (`commission_scales` + `_tiers` + `_bonuses` +
 * `_route_config` + `_beneficiary_config`), nunca de un `if` aca.
 */

export interface ComputeRunOptions {
  /** No persiste: devuelve el calculo para poder cuadrarlo antes de crear la corrida. */
  dryRun?: boolean;
  /** Reemplaza la corrida viva del periodo (solo si esta en `borrador` o `bloqueada`). */
  replace?: boolean;
  /** Quien la pidio. El cron no puede disfrazarse de persona. */
  origen?: 'manual' | 'cron';
}

interface Tier { min_amount: string; max_amount: string | null; pct: string }
interface Bonus {
  beneficiario: 'chofer' | 'supervisor';
  nombre: string;
  metrica: 'venta' | 'markup_pct';
  comparador: 'gt' | 'gte';
  umbral: string;
  monto: string;
  route_code: string | null;
  gate_venta_min: string | null;
}

/** Una fila del universo derivado. `comisiona` nunca cae a true por omision. */
interface RutaUniverso {
  route_code: string;
  comisiona: boolean;
  veredicto: string;
  route_kind: string | null;
  plaza_o_zona: string | null;
  nomina_banco: string | null;
  chofer_nombre: string | null;
  supervisor_nombre: string | null;
}

/** El periodo de una ruta, ya arbitrado por `v_rd_commission_base`. */
interface VentaRuta {
  route_code: string;
  subtotal: number;
  venta: number;
  /** Solo los dias que SI tienen costo. Es el numerador del markup. */
  subtotal_con_costo: number | null;
  costo: number | null;
  cogs_ruta: number | null;
  cogs_erp: number | null;
  /** Las capturas que compusieron el periodo: wincaja / push / kepler_vecinal, unidas por +. */
  fuentes: string;
  costo_veredicto: string;
  /** Dias alimentados por mas de una captura = corte de sistema, NO duplicado (medido). */
  dias_multifuente: number;
  dias: number;
  dias_con_costo: number;
  /** Dias cuyo COGS del embarque dejo SKUs sin costo unitario: COGS mas chico = markup mas alto. */
  dias_cogs_parcial: number;
}

export type GateEstado = 'pasa' | 'advierte' | 'bloquea' | 'no_medido';
export interface Gate { gate: string; estado: GateEstado; detalle: string }

export interface CommissionLine {
  route_code: string;
  beneficiario: 'chofer' | 'supervisor';
  chofer_nombre?: string | null;
  supervisor_nombre?: string | null;
  /** La plaza, congelada en la linea junto con el nombre (RD.21). */
  zona: string | null;
  subtotal: number | null;
  venta: number | null;
  costo: number | null;
  cogs_ruta: number | null;
  cogs_erp: number | null;
  markup_sobre_costo_pct: number | null;
  margen_sobre_venta_pct: number | null;
  fuentes: string | null;
  costo_veredicto: string | null;
  dias_multifuente: number;
  pct_aplicado: number | null;
  comision: number;
  bonos: number;
  bonos_detalle: { nombre: string; monto: number; metrica: string; umbral: number }[];
  bono_veredicto: string | null;
  nomina_banco: number;
  deduccion_status: string | null;
  a_pagar: number;
  motivo_no_pago: string | null;
}

/** El neto por persona: la deduccion del supervisor no es por ruta. */
export interface BeneficiarioNeto {
  beneficiario: 'chofer' | 'supervisor';
  nombre: string;
  rutas: string[];
  comision: number;
  bonos: number;
  bruto: number;
  deduccion: number;
  deduccion_status: 'aplicada' | 'sin_configurar' | 'no_aplica';
  neto: number;
}

/** Redondeo a 2 decimales, una sola vez y al final de cada monto que se persiste. */
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const n0 = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * ⚠️ **Dos consultas al grano de DIA, y el pliegue por ruta se hace en memoria.**
 *
 * No es una preferencia de estilo: unir la venta y el costo en una sola vista le quita al planner
 * el empuje del filtro de fecha dentro de `v_rd_route_daily` -- que se materializa entera en cada
 * consulta -- y el costo salta dos ordenes de magnitud. Medido contra prod:
 *
 *     venta de una quincena ...............  6,491 ms
 *     costo de una quincena ...............  1,208 ms
 *     LAS DOS EN UNA SOLA VISTA ........... >500,000 ms  (lo mato el reaper de prod)
 *
 * Al grano de dia son ~250 filas por lado: plegarlas en JS es gratis y es **predecible**, que es
 * lo que un calculo de nomina necesita. *El agregado de dos consultas rapidas no es una consulta
 * rapida.*
 *
 * `analytics.*` no lleva RLS -> el filtro de tenant va EXPLICITO.
 */
const SQL_VENTA_DIA = `
  SELECT route_code, business_date,
         subtotal::float8        AS subtotal,
         venta::float8           AS venta,
         costo_wincaja::float8   AS costo_wincaja,
         fuentes_dia,
         dia_multifuente
    FROM analytics.v_rd_commission_sales
   WHERE tenant_id = ? AND business_date >= ? AND business_date <= ?`;

const SQL_COSTO_DIA = `
  SELECT route_code, business_date,
         cogs_ruta::float8 AS cogs_ruta,
         cogs_erp::float8  AS cogs_erp,
         cogs_ruta_completo,
         costo_veredicto
    FROM analytics.v_rd_commission_cogs
   WHERE tenant_id = ? AND business_date >= ? AND business_date <= ?`;

/** Del peor al mejor. La precedencia esta ESCRITA: el `min()` alfabetico anterior devolvia el
 *  caso MEJOR (`erp_reexpresado_cada_corrida` < `sin_dato_en_la_fuente`) y decia lo contrario. */
const ORDEN_COSTO = ['sin_costo', 'solo_wincaja_reexpresado', 'una_fuente_erp',
  'una_fuente_embarque', 'dos_fuentes'] as const;

@Injectable()
export class CommercialCommissionsService {
  private readonly logger = new Logger(CommercialCommissionsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  // ── Catalogo ─────────────────────────────────────────────────────────────────────────

  /**
   * `[RD.21]` El tablero del año en **una sola consulta sobre tablas**. Es lo que la pantalla
   * pide al abrir, y el unico camino que recorre.
   *
   * ⭐ No toca ninguna vista. Medido contra prod: **2.2 ms** (p50 de 5 corridas, 27 filas),
   * contra los **6,491 ms** que costaba calcular UNA quincena. Esa diferencia es la razon de que
   * la pantalla no tenga botones: calcular es trabajo del cron, y leer es trabajo de la pantalla.
   */
  async board(anio: number) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // ⭐ El latido del carril viaja CON el tablero. Sin esto la pantalla vacia tenia que
      // ADIVINAR por que no hay corridas, y adivinaba mal: mandaba a mirar un latido que
      // (medido) nunca reporto, y "no encuentro nada" se lee igual que "esta bien". Cuesta
      // 0.97 ms, asi que no hay razon para no saberlo.
      const { rows: hb } = await trx.raw(
        `SELECT job_key, status, last_finish, rows_affected, error, host
           FROM analytics.cron_runs WHERE tenant_id = ? AND job_key = 'rd_commission_runner'`,
        [tenantId],
      );
      const { rows } = await trx.raw(
        `SELECT p.id AS period_id, p.period_no,
                to_char(p.date_from, 'YYYY-MM-DD') AS date_from,
                to_char(p.date_to,   'YYYY-MM-DD') AS date_to,
                to_char(p.pay_date,  'YYYY-MM-DD') AS pay_date,
                r.id AS run_id, r.status, r.origen,
                r.total_subtotal, r.total_comision, r.total_a_pagar,
                r.total_deduccion, r.total_neto,
                r.rutas_con_dato, r.rutas_sin_dato, r.rutas_fuera,
                r.gates, r.data_as_of, r.updated_at
           FROM commercial.commission_periods p
           LEFT JOIN commercial.commission_runs r
             ON r.period_id = p.id AND r.deleted_at IS NULL AND r.status <> 'anulado'
          WHERE p.tenant_id = ? AND p.anio = ? AND p.deleted_at IS NULL
          ORDER BY p.period_no`,
        [tenantId, anio],
      );
      // ⚠️ `to_char` en la lista de seleccion es gratis y evita el defecto de LC.16: pg devuelve
      // `date` como objeto Date y `String()` lo imprime en UTC, o sea con el DIA cambiado en
      // hora de Mexico. La pantalla recibe texto ya correcto, no un ISO que tenga que recortar.
      const periodos = rows.map((r: Record<string, unknown>) => ({
        ...r,
        total_subtotal: n0(r.total_subtotal), total_comision: n0(r.total_comision),
        total_a_pagar: n0(r.total_a_pagar), total_deduccion: n0(r.total_deduccion),
        total_neto: n0(r.total_neto),
      }));

      /**
       * ⭐ TRES causas distintas, que se arreglan en tres lugares distintos. Tratarlas como una
       * sola es lo que hacia que la pantalla mandara a todo el mundo al mismo lugar equivocado.
       * La redaccion de `nunca_reporto` es la de `veredictoSinLatido()` de `db-health`, que ya
       * tenia resuelto como se dice esto: no se puede saber cual de las tres sin mirarlo.
       */
      const h = hb[0] ?? null;
      const motor = !h
        ? {
          veredicto: 'nunca_reporto' as const,
          detalle: 'El carril está declarado y no ha escrito ni un latido: o no está desplegado, '
                 + 'o no corre, o corre y no late. No se puede saber cuál sin mirarlo.',
          last_finish: null, status: null, error: null,
        }
        : h.status === 'error'
          ? {
            veredicto: 'con_error' as const,
            detalle: String(h.error ?? 'sin detalle'),
            last_finish: h.last_finish, status: h.status, error: h.error,
          }
          : {
            veredicto: 'corre' as const,
            detalle: `Corrió y escribió ${h.rows_affected ?? 0} corrida(s).`,
            last_finish: h.last_finish, status: h.status, error: null,
          };

      return { periodos, motor };
    });
  }

  async listPeriods(anio?: number) {
    return this.tk.run(async (trx) => {
      const q = trx('commercial.commission_periods')
        .whereNull('deleted_at')
        .orderBy([{ column: 'anio' }, { column: 'period_no' }]);
      if (anio) q.where({ anio });
      const periods = await q.select('*');
      const runs = await trx('commercial.commission_runs')
        .whereNull('deleted_at').whereNot('status', 'anulado')
        .select('period_id', 'id as run_id', 'status', 'total_a_pagar', 'total_neto',
          'rutas_sin_dato', 'rutas_fuera', 'gates', 'origen');
      const byPeriod = new Map(runs.map((x) => [x.period_id, x]));
      return periods.map((p) => ({ ...p, run: byPeriod.get(p.id) ?? null }));
    });
  }

  async getScale(onDate: string) {
    return this.tk.run(async (trx) => this.loadScale(trx, onDate));
  }

  /** El universo derivado, con el veredicto de cada ruta. Lo consume la pantalla de config. */
  async listUniverse() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT * FROM analytics.v_rd_commission_universe
          WHERE tenant_id = ? ORDER BY comisiona DESC, veredicto, route_code`, [tenantId]);
      return rows;
    });
  }

  // ── El calculo ───────────────────────────────────────────────────────────────────────

  async computeRun(periodId: string, opts: ComputeRunOptions = {}) {
    if (!periodId) throw new BadRequestException('periodId requerido');
    const tenantId = this.tenantCtx.requireTenantId();

    return this.tk.run(async (trx) => {
      const period = await trx('commercial.commission_periods')
        .where({ id: periodId }).whereNull('deleted_at').first();
      if (!period) throw new NotFoundException(`Periodo ${periodId} no existe`);

      const from = String(period.date_from).slice(0, 10);
      const to = String(period.date_to).slice(0, 10);

      const scale = await this.loadScale(trx, to);
      const [tiers, bonuses, universo, ventas, deducciones, dataAsOf] = await Promise.all([
        trx('commercial.commission_scale_tiers')
          .where({ scale_id: scale.id }).whereNull('deleted_at')
          .orderBy('min_amount').select<Tier[]>('min_amount', 'max_amount', 'pct'),
        trx('commercial.commission_bonuses')
          .where({ scale_id: scale.id }).whereNull('deleted_at')
          .select<Bonus[]>('beneficiario', 'nombre', 'metrica', 'comparador', 'umbral', 'monto',
            'route_code', 'gate_venta_min'),
        this.universo(trx, tenantId),
        this.ventaPorRuta(trx, tenantId, from, to),
        this.deducciones(trx, scale.id, to),
        this.frescura(trx, tenantId),
      ]);

      if (!tiers.length) throw new ConflictException(`La escala ${scale.code} no tiene escalones`);
      if (!universo.length) throw new ConflictException('El universo de rutas vino vacio');

      const ventaMap = new Map(ventas.map((v) => [v.route_code, v]));
      const lines: CommissionLine[] = [];
      const fuera: { route_code: string; veredicto: string; route_kind: string | null;
        subtotal: number | null; venta: number | null }[] = [];
      // Cobertura contada en el bucle, no deducida despues: "no vendio" y "no paga" son dos
      // cosas distintas y deducirlas de las lineas ya las habia confundido una vez.
      let conDato = 0;
      let sinDato = 0;

      for (const cfg of universo) {
        const v = ventaMap.get(cfg.route_code) ?? null;

        // ── Lo que NO comisiona sale igual, con su motivo. Antes se caia sin aparecer. ──
        if (!cfg.comisiona) {
          if (v) fuera.push({ route_code: cfg.route_code, veredicto: cfg.veredicto,
            route_kind: cfg.route_kind, subtotal: r2(v.subtotal), venta: r2(v.venta) });
          lines.push(this.emptyLine(cfg, 'chofer', cfg.veredicto, v ?? undefined));
          continue;
        }

        // Sin fuente NO es cero: es un hueco declarado. Publicar $0 se leeria como
        // "vendio nada" en vez de "no sabemos" (FASE_RD §2.4).
        if (!v) {
          sinDato++;
          lines.push(this.emptyLine(cfg, 'chofer', 'sin_dato_en_la_fuente'));
          lines.push(this.emptyLine(cfg, 'supervisor', 'sin_dato_en_la_fuente'));
          continue;
        }
        conDato++;

        const gate = scale.gate_field === 'subtotal' ? v.subtotal : v.venta;
        const base = scale.base_field === 'subtotal' ? v.subtotal : v.venta;
        const tier = this.pickTier(tiers, gate);
        const { markup, margen } = this.razones(v);

        if (!tier) {
          lines.push(this.emptyLine(cfg, 'chofer', 'bajo_umbral', v, markup, margen));
          lines.push(this.emptyLine(cfg, 'supervisor', 'bajo_umbral', v, markup, margen));
          continue;
        }

        const pct = Number(tier.pct);
        const comisionTotal = base * (pct / 100);
        const comisionSupervisor = comisionTotal * (Number(scale.share_supervisor_pct) / 100);
        const comisionChofer = comisionTotal - comisionSupervisor;

        const bonosChofer = this.matchBonuses(bonuses, 'chofer', cfg.route_code, v.venta, markup);
        const bonosSuper = this.matchBonuses(bonuses, 'supervisor', cfg.route_code, v.venta, markup);
        const sum = (bs: { monto: number }[]) => bs.reduce((s, b) => s + b.monto, 0);
        const veredictoBono = this.veredictoBono(v, bonosSuper.length > 0);
        const nomina = Number(cfg.nomina_banco ?? 0);

        const comun = {
          subtotal: r2(v.subtotal), venta: r2(v.venta),
          costo: v.costo === null ? null : r2(v.costo),
          cogs_ruta: v.cogs_ruta === null ? null : r2(v.cogs_ruta),
          cogs_erp: v.cogs_erp === null ? null : r2(v.cogs_erp),
          markup_sobre_costo_pct: markup === null ? null : r2(markup),
          margen_sobre_venta_pct: margen === null ? null : r2(margen),
          fuentes: v.fuentes, costo_veredicto: v.costo_veredicto,
          dias_multifuente: v.dias_multifuente,
          zona: cfg.plaza_o_zona,
          pct_aplicado: pct, motivo_no_pago: null,
        };

        lines.push({
          ...comun,
          route_code: cfg.route_code, beneficiario: 'chofer', chofer_nombre: cfg.chofer_nombre,
          comision: r2(comisionChofer), bonos: r2(sum(bonosChofer)), bonos_detalle: bonosChofer,
          bono_veredicto: bonosChofer.length ? 'arbitrado' : null,  // el del chofer va por VENTA
          nomina_banco: r2(nomina),
          deduccion_status: nomina > 0 ? 'aplicada' : 'no_aplica',
          a_pagar: r2(comisionChofer + sum(bonosChofer) - nomina),
        });

        // ⚠️ La linea del supervisor trae la CONTRIBUCION de esta ruta (`nomina_banco = 0`).
        // Su deduccion es por PERSONA y agregada sobre sus rutas -- no se reparte entre rutas,
        // porque esa regla el Excel no la tiene. El neto por persona se arma abajo y ahora SI
        // entra en el total.
        lines.push({
          ...comun,
          route_code: cfg.route_code, beneficiario: 'supervisor',
          supervisor_nombre: cfg.supervisor_nombre,
          comision: r2(comisionSupervisor), bonos: r2(sum(bonosSuper)), bonos_detalle: bonosSuper,
          bono_veredicto: veredictoBono,
          nomina_banco: 0, deduccion_status: null,  // se resuelve al armar el neto por persona
          a_pagar: r2(comisionSupervisor + sum(bonosSuper)),
        });
      }

      const beneficiarios = this.netoPorPersona(lines, universo, deducciones);
      const totals = this.totales(lines, universo, beneficiarios, fuera, conDato, sinDato);
      const gates = this.compuertas(period, to, totals, dataAsOf, lines);
      const bloquea = gates.some((g) => g.estado === 'bloquea');

      // El estado por persona vuelve a las lineas para que la pantalla no tenga que cruzarlo.
      const statusPorSuper = new Map(beneficiarios
        .filter((b) => b.beneficiario === 'supervisor').map((b) => [b.nombre, b.deduccion_status]));
      for (const l of lines) {
        if (l.beneficiario === 'supervisor' && l.supervisor_nombre) {
          l.deduccion_status = statusPorSuper.get(l.supervisor_nombre) ?? 'no_aplica';
        }
      }

      const payload = {
        period: { id: period.id, anio: period.anio, period_no: period.period_no,
          date_from: from, date_to: to, pay_date: period.pay_date },
        scale: { id: scale.id, code: scale.code, base_field: scale.base_field,
          gate_field: scale.gate_field, share_supervisor_pct: Number(scale.share_supervisor_pct) },
        ...totals,
        data_as_of: dataAsOf,
        gates,
        beneficiarios,
        fuera,
        lines,
      };
      if (opts.dryRun) return { ...payload, run_id: null, status: 'dry-run' as const };

      // ⭐ `en_curso` y `bloqueada` NO son lo mismo y no se arreglan igual: a la primera le falta
      // terminar, a la segunda le falla algo. Llamarlas igual mandaria a buscar un problema que
      // no existe cada vez que el cron refresca la quincena que todavia corre (RD.21).
      const abierto = to > new Date().toISOString().slice(0, 10);
      const status = abierto ? 'en_curso' : (bloquea ? 'bloqueada' : 'borrador');
      const runId = await this.persist(trx, tenantId, period, scale, totals, lines,
        { ...opts, status, gates, dataAsOf });
      this.logger.log(
        `Corrida ${runId} [${status}] periodo ${period.anio}-${period.period_no} - ` +
        `${totals.rutas_con_dato} con dato / ${totals.rutas_sin_dato} sin / ${totals.rutas_fuera} fuera - ` +
        `bruto $${totals.total_a_pagar} neto $${totals.total_neto} - ` +
        `${gates.filter((g) => g.estado !== 'pasa').map((g) => `${g.gate}:${g.estado}`).join(' ') || 'todas las compuertas pasan'}`,
      );
      return { ...payload, run_id: runId, status };
    });
  }

  async getRun(runId: string) {
    return this.tk.run(async (trx) => {
      const run = await trx('commercial.commission_runs')
        .where({ id: runId }).whereNull('deleted_at').first();
      if (!run) throw new NotFoundException(`Corrida ${runId} no existe`);
      const [period, lines] = await Promise.all([
        trx('commercial.commission_periods').where({ id: run.period_id }).first(),
        trx('commercial.commission_run_lines').where({ run_id: runId }).whereNull('deleted_at')
          .orderBy([{ column: 'route_code' }, { column: 'beneficiario' }]).select('*'),
      ]);
      // ⚠️ pg devuelve `numeric` como STRING y el repo no fija `setTypeParser`. Sin esto la
      // corrida guardada se ve distinta de su vista previa (`0` -> `"0.00"`, que es truthy, y
      // `3.75` -> `"3.7500"`): la pantalla con la que se cuadra no seria la que queda.
      return { ...run, period, lines: lines.map((l) => this.numerizar(l)) };
    });
  }

  /** borrador|bloqueada -> aprobado -> pagado. No se salta pasos y no se revive lo anulado. */
  async setStatus(runId: string, status: 'aprobado' | 'pagado' | 'anulado') {
    const userId = this.tenantCtx.get()?.userId ?? null;
    return this.tk.run(async (trx) => {
      const run = await trx('commercial.commission_runs')
        .where({ id: runId }).whereNull('deleted_at').first();
      if (!run) throw new NotFoundException(`Corrida ${runId} no existe`);
      const permitido: Record<string, string[]> = {
        // ⭐ Una quincena que todavia corre no se aprueba ni se anula a mano: el cron la
        // reemplaza sola cada 30 min y, al cerrar el periodo, pasa a borrador con el dato
        // completo. Dejarla aprobable seria poder pagar media quincena.
        en_curso: [],
        borrador: ['aprobado', 'anulado'],
        // ⭐ Una corrida bloqueada NO se aprueba: se anula y se vuelve a calcular con el
        // motivo resuelto. Si se pudiera aprobar, la compuerta seria decorativa.
        bloqueada: ['anulado'],
        aprobado: ['pagado', 'anulado'],
        pagado: [],
        anulado: [],
      };
      if (!permitido[run.status]?.includes(status)) {
        const extra = run.status === 'bloqueada'
          ? ` Compuertas que bloquean: ${(run.gates ?? []).filter((g: Gate) => g.estado === 'bloquea').map((g: Gate) => g.gate).join(', ') || '(sin detalle)'}.`
          : '';
        throw new ConflictException(`No se puede pasar de "${run.status}" a "${status}".${extra}`);
      }
      const patch: Record<string, unknown> = { status, updated_at: trx.fn.now(), updated_by: userId };
      if (status === 'aprobado') { patch.approved_at = trx.fn.now(); patch.approved_by = userId; }
      if (status === 'pagado') { patch.paid_at = trx.fn.now(); patch.paid_by = userId; }
      await trx('commercial.commission_runs').where({ id: runId }).update(patch);
      return this.getRunInTrx(trx, runId);
    });
  }

  // ── Internos ─────────────────────────────────────────────────────────────────────────

  private async loadScale(trx: any, onDate: string) {
    const scale = await trx('commercial.commission_scales')
      .whereNull('deleted_at')
      .where('valid_from', '<=', onDate)
      .andWhere((b: any) => b.whereNull('valid_to').orWhere('valid_to', '>', onDate))
      .orderBy('valid_from', 'desc')
      .first();
    if (!scale) throw new NotFoundException(`No hay escala de comision vigente al ${onDate}`);
    return scale;
  }

  /** El universo DERIVADO. `analytics.*` no lleva RLS -> filtro de tenant explicito. */
  private async universo(trx: any, tenantId: string): Promise<RutaUniverso[]> {
    const { rows } = await trx.raw(
      `SELECT route_code, comisiona, veredicto, route_kind, plaza_o_zona,
              nomina_banco, chofer_nombre, supervisor_nombre
         FROM analytics.v_rd_commission_universe
        WHERE tenant_id = ? ORDER BY route_code`, [tenantId]);
    return rows as RutaUniverso[];
  }

  /**
   * El periodo de cada ruta. Dos consultas al grano de dia y el pliegue aca (ver `SQL_VENTA_DIA`).
   *
   * ⭐ El pliegue hace **dos cosas que el agregado anterior hacia mal**:
   *  · `subtotal_con_costo` suma SOLO los dias que tienen costo, para que el markup tenga
   *    numerador y denominador sobre el mismo universo. Medido en prod: con la forma vieja la
   *    quincena 13 publica markups de **368%, 302%, 550%** en PH -- el ledger del embarque
   *    arranca el 15-jul y el periodo es de junio, asi que un COGS de dos dias se divide contra
   *    el subtotal de doce. El umbral del bono del supervisor de PH es 25%.
   *  · el peor veredicto de costo se elige por `ORDEN_COSTO`, no por `min()` alfabetico.
   */
  private async ventaPorRuta(trx: any, tenantId: string, from: string, to: string): Promise<VentaRuta[]> {
    const [venta, costo] = await Promise.all([
      trx.raw(SQL_VENTA_DIA, [tenantId, from, to]),
      trx.raw(SQL_COSTO_DIA, [tenantId, from, to]),
    ]);
    // El costo del dia, indexado para el pliegue. Clave: ruta + fecha.
    const k = (r: string, d: unknown) => `${r}|${String(d).slice(0, 10)}`;
    const costoDia = new Map<string, any>();
    for (const c of costo.rows) costoDia.set(k(c.route_code, c.business_date), c);

    const acc = new Map<string, VentaRuta>();
    for (const v of venta.rows) {
      const cur = acc.get(v.route_code) ?? {
        route_code: v.route_code, subtotal: 0, venta: 0, subtotal_con_costo: 0,
        costo: 0, cogs_ruta: 0, cogs_erp: 0,
        fuentes: '', costo_veredicto: 'sin_costo', dias: 0, dias_con_costo: 0,
        dias_cogs_parcial: 0, dias_multifuente: 0, _fuentes: new Set<string>(),
      } as VentaRuta & { _fuentes: Set<string> };
      const c = costoDia.get(k(v.route_code, v.business_date));
      // Precedencia del costo del DIA: la cuenta del camion, el ERP, y al final el inestable.
      const costoDelDia = c?.cogs_ruta ?? c?.cogs_erp ?? v.costo_wincaja ?? null;

      cur.dias++;
      cur.subtotal += Number(v.subtotal) || 0;
      cur.venta += Number(v.venta) || 0;
      if (v.dia_multifuente) cur.dias_multifuente++;
      if (v.fuentes_dia) for (const f of String(v.fuentes_dia).split('+')) (cur as any)._fuentes.add(f);
      if (costoDelDia !== null && costoDelDia !== undefined) {
        cur.dias_con_costo++;
        cur.subtotal_con_costo = (cur.subtotal_con_costo ?? 0) + (Number(v.subtotal) || 0);
        cur.costo = (cur.costo ?? 0) + Number(costoDelDia);
      }
      if (c?.cogs_ruta != null) cur.cogs_ruta = (cur.cogs_ruta ?? 0) + Number(c.cogs_ruta);
      if (c?.cogs_erp != null) cur.cogs_erp = (cur.cogs_erp ?? 0) + Number(c.cogs_erp);
      if (c && c.cogs_ruta_completo === false) cur.dias_cogs_parcial++;
      // El PEOR veredicto del periodo, por orden escrito.
      const vd = c?.costo_veredicto
        ?? (v.costo_wincaja != null ? 'solo_wincaja_reexpresado' : 'sin_costo');
      if (ORDEN_COSTO.indexOf(vd) < ORDEN_COSTO.indexOf(cur.costo_veredicto as never)) {
        cur.costo_veredicto = vd;
      }
      acc.set(v.route_code, cur);
    }
    return [...acc.values()].map((r) => {
      const f = [...((r as any)._fuentes as Set<string>)].sort();
      delete (r as any)._fuentes;
      return {
        ...r,
        fuentes: f.join('+'),
        subtotal_con_costo: r.dias_con_costo ? r.subtotal_con_costo : null,
        costo: r.dias_con_costo ? r.costo : null,
        cogs_ruta: r.cogs_ruta || null,
        cogs_erp: r.cogs_erp || null,
      };
    });
  }

  /** La deduccion vigente por persona. Si la tabla esta vacia, el mapa queda vacio: declarado. */
  private async deducciones(
    trx: any, scaleId: string, onDate: string,
  ): Promise<Map<string, number>> {
    const rows: { beneficiario: string; nombre: string; nomina_banco: string }[] =
      await trx('commercial.commission_beneficiary_config')
        .where({ scale_id: scaleId }).whereNull('deleted_at')
        .where('valid_from', '<=', onDate)
        .andWhere((b: any) => b.whereNull('valid_to').orWhere('valid_to', '>', onDate))
        .select('beneficiario', 'nombre', 'nomina_banco');
    // ⚠️ Se arma explicitamente: `new Map(rows.map(...))` sobre un knex sin tipar infiere
    // `Map<unknown, unknown>` y el error sale recien en el consumidor, dos metodos mas abajo.
    const out = new Map<string, number>();
    for (const r of rows) out.set(`${r.beneficiario}|${r.nombre}`, Number(r.nomina_banco));
    return out;
  }

  /**
   * Hasta cuando llega el dato. Se deriva del carril que de verdad alimenta la venta de ruta
   * (`route_push_lines`), no de un reloj: una corrida se tiene que poder DEFENDER, y para eso
   * hace falta saber contra que ventana se calculo.
   */
  private async frescura(trx: any, tenantId: string): Promise<string | null> {
    const { rows } = await trx.raw(
      `SELECT max(business_date)::text AS d FROM analytics.route_push_lines WHERE tenant_id = ?`,
      [tenantId]);
    return rows[0]?.d ?? null;
  }

  /** min inclusivo, max exclusivo, `max IS NULL` = sin techo (FASE_RD §4.6). */
  private pickTier(tiers: Tier[], gate: number): Tier | null {
    for (const t of tiers) {
      const min = Number(t.min_amount);
      const max = t.max_amount === null ? Infinity : Number(t.max_amount);
      if (gate >= min && gate < max) return t;
    }
    return null;
  }

  /**
   * ⭐ Las dos razones, cada una con su nombre, y el markup con numerador y denominador sobre
   * LOS MISMOS DIAS. El motor anterior dividia el subtotal de 14 dias entre el costo de los
   * que lo tenian: en la quincena que cruza el cutover de las camionetas (2026-06-29, dentro
   * del periodo 13) eso inflaba la razon ~27% contra un umbral de bono de 25%.
   */
  private razones(v: VentaRuta): { markup: number | null; margen: number | null } {
    const sub = v.subtotal_con_costo;
    if (!v.costo || v.costo <= 0 || sub === null || sub <= 0) return { markup: null, margen: null };
    return {
      markup: (sub / v.costo - 1) * 100,
      margen: ((sub - v.costo) / sub) * 100,
    };
  }

  /**
   * Sobre que descansa el bono del supervisor. NO lo suprime: lo declara (ADR-056).
   *
   * ⚠️ La parcialidad tiene DOS formas y las dos inflan el markup en la misma direccion:
   * dias sin costo (el numerador ya se corrige en `razones()`) y, dentro de un dia, SKUs
   * vendidos sin costo unitario -- ahi el COGS sale mas chico y el markup mas alto, que es
   * justo el lado que paga.
   */
  private veredictoBono(v: VentaRuta, pago: boolean): string | null {
    if (!pago) return v.costo === null ? 'sin_metrica_no_paga' : null;
    if (v.dias_con_costo < v.dias || v.dias_cogs_parcial > 0) return 'fuente_parcial';
    if (v.costo_veredicto === 'dos_fuentes') return 'arbitrado';
    if (v.costo_veredicto === 'solo_wincaja_reexpresado') return 'fuente_inestable';
    return 'fuente_unica';
  }

  private matchBonuses(
    all: Bonus[], beneficiario: 'chofer' | 'supervisor', routeCode: string,
    venta: number, markup: number | null,
  ) {
    const out: { nombre: string; monto: number; metrica: string; umbral: number }[] = [];
    for (const b of all) {
      if (b.beneficiario !== beneficiario) continue;
      if (b.route_code !== null && b.route_code !== routeCode) continue;
      if (b.gate_venta_min !== null && !(venta > Number(b.gate_venta_min))) continue;
      const valor = b.metrica === 'venta' ? venta : markup;
      if (valor === null) continue; // sin metrica no se paga: no se asume que alcanzo
      const umbral = Number(b.umbral);
      const pasa = b.comparador === 'gt' ? valor > umbral : valor >= umbral;
      if (pasa) out.push({ nombre: b.nombre, monto: Number(b.monto), metrica: b.metrica, umbral });
    }
    return out;
  }

  /**
   * El neto POR PERSONA. La deduccion del supervisor se aplica aca, una vez, sobre la suma de
   * sus rutas -- que es como funciona -- y no se reparte entre rutas para no inventar una regla
   * que el Excel no tiene. Si no esta configurada, el neto sale **declarado incompleto**.
   */
  private netoPorPersona(
    lines: CommissionLine[], universo: RutaUniverso[], deducciones: Map<string, number>,
  ): BeneficiarioNeto[] {
    const esperado = new Set<string>();
    for (const u of universo) {
      if (!u.comisiona) continue;
      if (u.supervisor_nombre) esperado.add(`supervisor|${u.supervisor_nombre}`);
    }
    const acc = new Map<string, BeneficiarioNeto>();
    for (const l of lines) {
      if (l.motivo_no_pago) continue;
      const nombre = l.beneficiario === 'chofer' ? l.chofer_nombre : l.supervisor_nombre;
      if (!nombre) continue;
      const key = `${l.beneficiario}|${nombre}`;
      const cur = acc.get(key) ?? {
        beneficiario: l.beneficiario, nombre, rutas: [], comision: 0, bonos: 0,
        bruto: 0, deduccion: 0, deduccion_status: 'no_aplica' as const, neto: 0,
      };
      cur.rutas.push(l.route_code);
      cur.comision += l.comision;
      cur.bonos += l.bonos;
      // El chofer ya trae su deduccion restada en la linea; el supervisor no tiene ninguna.
      cur.bruto += l.a_pagar;
      acc.set(key, cur);
    }
    const out: BeneficiarioNeto[] = [];
    for (const [key, b] of acc) {
      if (b.beneficiario === 'supervisor') {
        const d = deducciones.get(key);
        if (d !== undefined) { b.deduccion = d; b.deduccion_status = 'aplicada'; }
        else if (esperado.has(key)) { b.deduccion = 0; b.deduccion_status = 'sin_configurar'; }
      }
      b.comision = r2(b.comision); b.bonos = r2(b.bonos); b.bruto = r2(b.bruto);
      b.deduccion = r2(b.deduccion);
      b.neto = r2(b.bruto - b.deduccion);
      out.push(b);
    }
    return out.sort((a, b) => a.beneficiario.localeCompare(b.beneficiario) || a.nombre.localeCompare(b.nombre));
  }

  /**
   * ⚠️ El universo de la SUMA no es el de las lineas pagables. Una ruta bajo el umbral
   * **vendio** -- su subtotal cuenta para el total del periodo y su traslape tambien -- pero no
   * paga. Y las rutas que no comisionan no entran en ninguna de las dos. Contarlo con
   * `lines.filter(l => !l.motivo_no_pago)` metia a las de `bajo_umbral` en `rutas_sin_dato`,
   * que es un hueco de fuente y no una venta chica: dos cosas distintas con el mismo nombre.
   */
  private totales(
    lines: CommissionLine[], universo: RutaUniverso[],
    beneficiarios: BeneficiarioNeto[], fuera: unknown[],
    conDato: number, sinDato: number,
  ) {
    const comisionan = new Set(universo.filter((u) => u.comisiona).map((u) => u.route_code));
    // Lo que VENDIO: una fila por ruta que comisiona y tuvo fuente, haya pagado o no.
    const vendieron = lines.filter((l) => l.beneficiario === 'chofer'
      && comisionan.has(l.route_code) && l.motivo_no_pago !== 'sin_dato_en_la_fuente');
    // Lo que PAGA.
    const pagables = lines.filter((l) => !l.motivo_no_pago);
    const bruto = r2(pagables.reduce((s, l) => s + l.a_pagar, 0));
    const deduccion = r2(beneficiarios.reduce((s, b) => s + b.deduccion, 0));
    return {
      total_subtotal: r2(vendieron.reduce((s, l) => s + (l.subtotal ?? 0), 0)),
      total_venta: r2(vendieron.reduce((s, l) => s + (l.venta ?? 0), 0)),
      total_comision: r2(pagables.reduce((s, l) => s + l.comision, 0)),
      /** Bruto. Se conserva el nombre porque lo leen `v_rd_period_summary` y la pantalla. */
      total_a_pagar: bruto,
      total_deduccion: deduccion,
      /** ⭐ Lo que de verdad sale del banco. */
      total_neto: r2(bruto - deduccion),
      dias_multifuente: vendieron.reduce((s, l) => s + l.dias_multifuente, 0),
      rutas_con_dato: conDato,
      rutas_sin_dato: sinDato,
      rutas_fuera: fuera.length,
    };
  }

  /**
   * Las compuertas. Una corrida que no las pasa **nace bloqueada**, no borrador.
   * Un gate sin prueba negativa es una intencion: las rompe `test-newdb-rd-commission-base.js`.
   */
  private compuertas(
    period: any, to: string, totals: ReturnType<CommercialCommissionsService['totales']>,
    dataAsOf: string | null, lines: CommissionLine[],
  ): Gate[] {
    const g: Gate[] = [];
    const hoy = new Date().toISOString().slice(0, 10);

    // 1. No se paga una quincena que no cerro.
    g.push(to > hoy
      ? { gate: 'periodo_cerrado', estado: 'bloquea', detalle: `la quincena cierra el ${to}` }
      : { gate: 'periodo_cerrado', estado: 'pasa', detalle: `cerro el ${to}` });

    // 2. ⭐ Traslape: la venta contada dos veces infla la BASE y la COMPUERTA del escalon.
    // 2. ⛔ Esta compuerta nacio BLOQUEANDO por "venta contada dos veces" y la premisa quedo
    //    REFUTADA al medirla (2026-10-07): 3 dias con dos capturas en 120 d y CERO folios
    //    compartidos en 200 d -- son el corte de sistema, no un duplicado. Bloquear por eso
    //    habria frenado la nomina de la quincena del corte sin que hubiera nada que arreglar.
    //    Queda como AVISO: una quincena que cruza un cambio de sistema merece una mirada, y la
    //    duplicacion de verdad la vigila el candado a nivel folio.
    g.push(totals.dias_multifuente > 0
      ? { gate: 'corte_de_sistema', estado: 'advierte',
        detalle: `${totals.dias_multifuente} dia(s) alimentados por mas de una captura: la quincena cruza un cambio de sistema` }
      : { gate: 'corte_de_sistema', estado: 'pasa', detalle: 'una sola captura por dia' });

    // 3. Cobertura. Bloquea solo si no hay NADA: si faltan rutas, se advierte -- hay tres sin
    //    fuente desde hace meses (321 el 2026-06-02, 322 el 07-01, 505 el 09-10) y bloquear
    //    por eso dejaria la nomina parada para siempre.
    if (totals.rutas_con_dato === 0) {
      g.push({ gate: 'cobertura', estado: 'bloquea', detalle: 'ninguna ruta tiene dato en el periodo' });
    } else if (totals.rutas_sin_dato > 0) {
      g.push({ gate: 'cobertura', estado: 'advierte',
        detalle: `${totals.rutas_sin_dato} de ${totals.rutas_con_dato + totals.rutas_sin_dato} rutas sin fuente` });
    } else {
      g.push({ gate: 'cobertura', estado: 'pasa', detalle: `${totals.rutas_con_dato} rutas con dato` });
    }

    // 4. Frescura: si el carril no llego al ultimo dia, falta venta que si ocurrio.
    if (!dataAsOf) {
      g.push({ gate: 'frescura', estado: 'no_medido', detalle: 'route_push_lines no devolvio fecha' });
    } else if (dataAsOf < to) {
      g.push({ gate: 'frescura', estado: 'bloquea',
        detalle: `el dato llega al ${dataAsOf} y la quincena cierra el ${to}` });
    } else {
      g.push({ gate: 'frescura', estado: 'pasa', detalle: `dato hasta ${dataAsOf}` });
    }

    // 5. Bonos que descansan en un costo no arbitrado. Advierte: suprimirlos cambiaria pagos
    //    por decision del motor, y eso lo decide un humano (ADR-016).
    const flojos = lines.filter((l) => l.bonos > 0
      && l.bono_veredicto && l.bono_veredicto !== 'arbitrado');
    g.push(flojos.length
      ? { gate: 'bono_arbitrado', estado: 'advierte',
        detalle: `${flojos.length} bono(s) sobre costo ${[...new Set(flojos.map((l) => l.bono_veredicto))].join('/')}` }
      : { gate: 'bono_arbitrado', estado: 'pasa', detalle: 'ningun bono descansa en costo flojo' });

    // 6. Deduccion sin cargar: el neto saldria igual al bruto sin que nadie lo haya decidido.
    const sinDed = lines.filter((l) => l.deduccion_status === 'sin_configurar').length;
    g.push(sinDed
      ? { gate: 'deduccion_configurada', estado: 'advierte',
        detalle: `hay supervisor(es) sin deduccion cargada: el neto sale declarado incompleto` }
      : { gate: 'deduccion_configurada', estado: 'pasa', detalle: 'todas las deducciones resueltas' });

    return g;
  }

  private emptyLine(
    cfg: RutaUniverso, beneficiario: 'chofer' | 'supervisor', motivo: string,
    v?: VentaRuta, markup?: number | null, margen?: number | null,
  ): CommissionLine {
    return {
      route_code: cfg.route_code, beneficiario,
      chofer_nombre: beneficiario === 'chofer' ? cfg.chofer_nombre : undefined,
      supervisor_nombre: beneficiario === 'supervisor' ? cfg.supervisor_nombre : undefined,
      subtotal: v ? r2(v.subtotal) : null,
      venta: v ? r2(v.venta) : null,
      zona: cfg.plaza_o_zona,
      costo: v && v.costo !== null ? r2(v.costo) : null,
      cogs_ruta: v && v.cogs_ruta !== null ? r2(v.cogs_ruta) : null,
      cogs_erp: v && v.cogs_erp !== null ? r2(v.cogs_erp) : null,
      markup_sobre_costo_pct: markup === null || markup === undefined ? null : r2(markup),
      margen_sobre_venta_pct: margen === null || margen === undefined ? null : r2(margen),
      fuentes: v ? v.fuentes : null,
      costo_veredicto: v ? v.costo_veredicto : null,
      dias_multifuente: v ? v.dias_multifuente : 0,
      pct_aplicado: null, comision: 0, bonos: 0, bonos_detalle: [], bono_veredicto: null,
      nomina_banco: 0, deduccion_status: null, a_pagar: 0, motivo_no_pago: motivo,
    };
  }

  /** `numeric` llega como string desde pg: la corrida guardada tiene que leerse igual que su preview. */
  private numerizar(l: Record<string, unknown>) {
    const NUM = ['subtotal', 'venta', 'costo', 'cogs_ruta', 'cogs_erp', 'markup_sobre_costo_pct',
      'margen_sobre_venta_pct', 'pct_aplicado', 'comision', 'bonos',
      'nomina_banco', 'a_pagar'];
    const out = { ...l };
    for (const k of NUM) if (k in out) out[k] = n0(out[k]);
    return out;
  }

  private async persist(
    trx: any, tenantId: string, period: any, scale: any,
    totals: Record<string, number>, lines: CommissionLine[],
    ctx: { replace?: boolean; origen?: string; status: string; gates: Gate[]; dataAsOf: string | null },
  ): Promise<string> {
    const userId = this.tenantCtx.get()?.userId ?? null;
    const viva = await trx('commercial.commission_runs')
      .where({ period_id: period.id }).whereNull('deleted_at').whereNot('status', 'anulado').first();
    if (viva) {
      if (!ctx.replace) {
        throw new ConflictException(
          `El periodo ${period.anio}-${period.period_no} ya tiene una corrida ${viva.status}. ` +
          `Usa replace=true (solo si esta en borrador o bloqueada).`,
        );
      }
      if (!['borrador', 'bloqueada', 'en_curso'].includes(viva.status)) {
        throw new ConflictException(`No se reemplaza una corrida "${viva.status}": anulala primero.`);
      }
      await trx('commercial.commission_run_lines').where({ run_id: viva.id }).del();
      await trx('commercial.commission_runs').where({ id: viva.id }).del();
    }

    const [ins] = await trx('commercial.commission_runs')
      .insert({
        tenant_id: tenantId, period_id: period.id, scale_id: scale.id, status: ctx.status,
        ...totals,
        gates: JSON.stringify(ctx.gates),
        data_as_of: ctx.dataAsOf,
        origen: ctx.origen ?? 'manual',
        created_by: userId, updated_by: userId,
        notes: 'RD.19 - total_a_pagar es el BRUTO; total_neto resta la deduccion por persona '
             + 'del supervisor, que es agregada sobre sus rutas y no por ruta.',
      })
      .returning('id');
    const runId = ins.id || ins;

    await trx('commercial.commission_run_lines').insert(
      lines.map((l) => ({
        tenant_id: tenantId, run_id: runId, route_code: l.route_code, beneficiario: l.beneficiario,
        // ⭐ El nombre y la plaza se CONGELAN en la linea (RD.21). La tabla no los guardaba y el
        // payload los traia de la config, que cambia: con la pantalla leyendo solo esta tabla,
        // un recibo de hace seis meses mostraria a quien maneja la ruta HOY.
        beneficiario_nombre: l.beneficiario === 'chofer' ? l.chofer_nombre : l.supervisor_nombre,
        zona: l.zona ?? null,
        dias_multifuente: l.dias_multifuente,
        subtotal: l.subtotal, venta: l.venta, costo: l.costo,
        cogs_ruta: l.cogs_ruta, cogs_erp: l.cogs_erp,
        markup_sobre_costo_pct: l.markup_sobre_costo_pct,
        margen_sobre_venta_pct: l.margen_sobre_venta_pct,
        venta_arbitro: l.fuentes, costo_veredicto: l.costo_veredicto,
        subtotal_origen: l.fuentes, costo_status: l.costo_veredicto, // columnas RD.6
        pct_aplicado: l.pct_aplicado, comision: l.comision, bonos: l.bonos,
        bonos_detalle: JSON.stringify(l.bonos_detalle), bono_veredicto: l.bono_veredicto,
        nomina_banco: l.nomina_banco, deduccion_status: l.deduccion_status,
        a_pagar: l.a_pagar, motivo_no_pago: l.motivo_no_pago,
        created_by: userId, updated_by: userId,
      })),
    );
    return runId;
  }

  private async getRunInTrx(trx: any, runId: string) {
    const run = await trx('commercial.commission_runs').where({ id: runId }).first();
    const lines = await trx('commercial.commission_run_lines').where({ run_id: runId })
      .orderBy([{ column: 'route_code' }, { column: 'beneficiario' }]).select('*');
    return { ...run, lines: lines.map((l: Record<string, unknown>) => this.numerizar(l)) };
  }
}
