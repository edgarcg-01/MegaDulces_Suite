import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * `[PR.D2/D3]` — **El diseñador del experimento de precio.**
 *
 * Construye la asignación de un experimento de **no-inferioridad** sobre el aterrizaje
 * psicológico del precio: elige el universo, empareja, aleatoriza con semilla y escribe las
 * unidades. **No aplica ningún precio** — Kepler es read-only (ADR-040): produce la lista que
 * una persona captura, y `aplicado_at` registra cuándo pasó de verdad.
 *
 * ── Por qué no-inferioridad, en una línea ──────────────────────────────────────────────────
 * El experimento natural cerró la puerta a medir el efecto psicológico sobre el volumen
 * (DiD en medianas 0.00 vs 0.00 · placebo −0.69 pp · IC 95 % `[−48.20, +29.82]`). Pero el alza
 * implícita de aterrizar es **cierta**: +$659,564/30 d en modo `.99`. Así que no se pregunta si
 * vende más — se pregunta si **el alza cuesta volumen**.
 *
 * ── ⭐ El δ y la potencia salen de la aritmética, no de una convención ─────────────────────
 * `(1−q) ≥ (P−C) / (P(1+a)−C)`. Medido por rango: **19.85 %** bajo $10 contra **1.09 %** arriba
 * de $100 — y con `sd(ln(post/pre)) = 1.0722`, eso pide **~291** unidades por rama en el primero
 * y **~118,000** en el segundo. Por eso los estratos altos **se declaran imposibles** en vez de
 * correrse sin potencia: un *"no concluyente"* sin potencia se lee como *"no funciona"*.
 */

/** Los estratos, con su δ y el n que el diseño exige. Medidos, no elegidos. */
export const ESTRATOS: ReadonlyArray<{
  clave: string; min: number; max: number; deltaPct: number; nPorRama: number;
  viable: boolean; elegibles: number;
}> = [
  { clave: 'a_bajo_10',   min: 1,   max: 10,  deltaPct: 19.85, nPorRama: 291,
    viable: true,  elegibles: 924 },
  { clave: 'b_10_50',     min: 10,  max: 50,  deltaPct: 7.09,  nPorRama: 2630,
    viable: true,  elegibles: 6120 },
  /**
   * ⛔ $50-100 NO es viable, y la corrección vino de correr la consulta real contra prod.
   * El dimensionamiento dijo "justo" mirando las 24,295 celdas del rango — pero al aplicar los
   * filtros de elegibilidad (sólo precios sucios, con venta, sin oscilación) quedan **3,808**
   * contra las **29,800** que el diseño exige. *Contar el rango no es contar el universo.*
   */
  { clave: 'c_50_100',    min: 50,  max: 100, deltaPct: 3.04,  nPorRama: 14900,
    viable: false, elegibles: 3808 },
  /**
   * ⛔ Arriba de $100 el alza de aterrizar es 0.258 % y el δ tolerable 1.09 %: harían falta
   * ~118,000 unidades por rama y hay **1,228** elegibles. Dos órdenes de magnitud.
   */
  { clave: 'd_sobre_100', min: 100, max: 1e9, deltaPct: 1.09,  nPorRama: 118000,
    viable: false, elegibles: 1228 },
];

/** Cuántos cambios en 7 días delatan un precio que oscila entre dos escritores. */
const OSCILA_CAMBIOS_7D = 20;

export interface PlanExperimento {
  experimentId: string;
  nombre: string;
  semilla: number;
  estratos: Array<{
    clave: string; deltaPct: number; elegibles: number;
    tratamiento: number; control: number;
    suficiente: boolean; motivo: string | null;
  }>;
}

@Injectable()
export class PriceExperimentService {
  private readonly log = new Logger(PriceExperimentService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /**
   * Diseña y asigna un experimento. Idempotente por nombre: si ya existe, falla en vez de
   * duplicar — reasignar un experimento en curso destruiría su comparabilidad.
   *
   * @param nombre      identificador legible del experimento
   * @param modo        terminación a probar: `00` | `50` | `90` | `99`
   * @param semilla     ⭐ se guarda. Sin ella la asignación no se puede reproducir, y un
   *                    experimento que no se puede reproducir no se puede auditar.
   * @param clavesEstrato estratos a incluir; por defecto sólo los viables
   */
  async disenar(
    nombre: string,
    modo: '00' | '50' | '90' | '99',
    semilla: number,
    clavesEstrato?: string[],
  ): Promise<PlanExperimento> {
    if (!Number.isFinite(semilla)) throw new BadRequestException('la semilla es obligatoria');

    const pedidos = clavesEstrato?.length
      ? ESTRATOS.filter((e) => clavesEstrato.includes(e.clave))
      : ESTRATOS.filter((e) => e.viable);
    if (!pedidos.length) throw new BadRequestException('ningún estrato seleccionado');

    // ⛔ Un estrato no viable sólo entra si alguien lo pidió por su nombre, y se avisa.
    for (const e of pedidos) {
      if (!e.viable) {
        this.log.warn(`[PR.D2] estrato ${e.clave} pedido explícitamente y NO es viable: `
          + `δ ${e.deltaPct}% exige n≈${e.nPorRama} por rama. El resultado va a salir sin potencia.`);
      }
    }

    return this.tk.run(async (trx) => {
      // El tenant de la sesión: `tenant_id` es NOT NULL y no tiene default, así que se resuelve
      // una vez y se pasa. Viene de la variable que abrió `tk.run` — la misma que la RLS lee.
      const [{ tenant_id: tenantId }] = (await trx
        .select(trx.raw('current_tenant_id() AS tenant_id'))) as Array<{ tenant_id: string }>;
      if (!tenantId) throw new BadRequestException('sin tenant en la sesión');

      const [existe] = await trx('commercial.price_experiments').where({ nombre }).select('id');
      if (existe) {
        throw new ConflictException(
          `ya existe el experimento "${nombre}": reasignarlo destruiría su comparabilidad`);
      }

      const [exp] = await trx('commercial.price_experiments')
        .insert({
          tenant_id: tenantId,
          nombre,
          hipotesis: `El alza implicita de aterrizar el precio a .${modo} NO hace caer el volumen `
            + `mas que el delta de cada estrato, que es la caida a partir de la cual el margen `
            + `total deja de mejorar: (1-q) >= (P-C)/(P(1+a)-C).`,
          tipo: 'no_inferioridad',
          metrica: 'ln_volumen',
          modo_aterrizaje: modo,
          semilla,
          estado: 'diseno',
        })
        .returning(['id']);

      const estratos: PlanExperimento['estratos'] = [];
      for (const e of pedidos) {
        const asignadas = await this.asignarEstrato(trx, tenantId, exp.id, e, modo, semilla);
        estratos.push(asignadas);
      }

      await trx('commercial.price_experiments').where({ id: exp.id })
        .update({ estado: 'asignado', updated_at: trx.fn.now() });

      return { experimentId: exp.id, nombre, semilla, estratos };
    });
  }

  /**
   * ⭐ El corazón: elige el universo, empareja y aleatoriza **dentro del par**.
   *
   * Emparejar antes de sortear es lo que hace que las dos ramas arranquen iguales sin depender
   * de la suerte. Se ordena por venta dentro del estrato, se toman de a dos, y el sorteo decide
   * cuál de los dos va a tratamiento. Así la venta —el confundidor más fuerte— queda equilibrada
   * **por construcción**, no por esperanza.
   */
  private async asignarEstrato(
    trx: Knex,
    tenantId: string,
    experimentId: string,
    e: (typeof ESTRATOS)[number],
    modo: string,
    semilla: number,
  ): Promise<PlanExperimento['estratos'][number]> {
    /**
     * El universo elegible. Cada exclusión tiene su razón medida:
     *  · `veredicto <> 'fuera_de_alcance'` — abajo de $1 son marcadores del ERP, no mercancía
     *  · `terminacion = 'sucio'` — un precio que YA aterrizó no se puede "aterrizar"
     *  · `venta_neta_30d > 0` — sin venta no hay volumen que medir
     *  · ⛔ los que OSCILAN — su precio cambia entre dos escritores cada 30 min: no hay
     *    "precio antes" que registrar, y el experimento mediría ruido
     *
     * ⚠️ La vista de psicología va por `(sucursal, sku)` del ODS y la historia de cambios por
     * `product_id` UUID. El puente es `catalog.products.sku` — el mismo choque de llaves que
     * atraviesa todo este motor, resuelto acá de forma explícita en vez de suponerlo.
     */
    const { rows: filas } = (await trx.raw(`
      WITH oscilan AS (
        SELECT DISTINCT cp.sku
          FROM analytics.master_data_history h
          JOIN commercial.product_prices pp ON pp.id::text = h.pk::text
          JOIN catalog.products cp ON cp.id = pp.product_id
         WHERE h.tabla = 'commercial.product_prices'
           AND h.changed_at >= CURRENT_DATE - 7
         GROUP BY cp.sku
        HAVING count(*) >= ?
      )
      SELECT p.sucursal, p.sku, p.precio, p.cand_${modo} AS cand, p.venta_neta_30d AS venta
        FROM analytics.v_price_psychology p
        LEFT JOIN oscilan o ON o.sku = p.sku
       WHERE p.precio >= ? AND p.precio < ?
         AND p.terminacion = 'sucio'
         AND p.veredicto <> 'fuera_de_alcance'
         AND p.venta_neta_30d > 0
         AND p.cand_${modo} IS NOT NULL
         AND p.cand_${modo} <> p.precio
         AND o.sku IS NULL
       ORDER BY p.venta_neta_30d DESC
    `, [OSCILA_CAMBIOS_7D, e.min, e.max])) as {
      rows: Array<{ sucursal: string; sku: string; precio: string; cand: string; venta: string }>;
    };

    const necesarias = e.nPorRama * 2;
    if (filas.length < necesarias) {
      return {
        clave: e.clave, deltaPct: e.deltaPct, elegibles: filas.length,
        tratamiento: 0, control: 0, suficiente: false,
        motivo: `el diseño pide ${necesarias} celdas (${e.nPorRama} por rama) y hay ${filas.length}. `
          + 'No se asigna: un experimento sin potencia no responde, sólo consume capturas.',
      };
    }

    // ⭐ Aleatorizador reproducible (mulberry32). La semilla queda en la cabecera, así que
    //    cualquiera puede rehacer esta asignación y verificar que no se eligió a dedo.
    let s = (semilla ^ 0x9e3779b9) >>> 0;
    const rnd = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const alta: Array<Record<string, unknown>> = [];
    // Ya vienen ordenadas por venta: los pares consecutivos son los más parecidos.
    for (let i = 0; i + 1 < necesarias; i += 2) {
      const [x, y] = rnd() < 0.5 ? [filas[i], filas[i + 1]] : [filas[i + 1], filas[i]];
      alta.push(this.fila(tenantId, experimentId, e, x, 'tratamiento'));
      alta.push(this.fila(tenantId, experimentId, e, y, 'control'));
    }

    // Lotes chicos: son miles de filas y el INSERT gigante bloquea la tabla más de lo necesario.
    for (let i = 0; i < alta.length; i += 500) {
      await trx('commercial.price_experiment_units').insert(alta.slice(i, i + 500));
    }

    const mitad = alta.length / 2;
    this.log.log(`[PR.D2] estrato ${e.clave}: ${filas.length} elegibles → `
      + `${mitad} tratamiento + ${mitad} control (δ ${e.deltaPct}%)`);

    return {
      clave: e.clave, deltaPct: e.deltaPct, elegibles: filas.length,
      tratamiento: mitad, control: mitad, suficiente: true, motivo: null,
    };
  }

  private fila(
    tenantId: string,
    experimentId: string,
    e: (typeof ESTRATOS)[number],
    f: { sucursal: string; sku: string; precio: string; cand: string },
    rama: 'tratamiento' | 'control',
  ): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      experiment_id: experimentId,
      sucursal: f.sucursal,
      sku: f.sku,
      unit_kind: null,
      estrato: e.clave,
      delta_pct: e.deltaPct,
      rama,
      precio_antes: f.precio,
      // ⛔ El control NO se toca. El CHECK de la tabla lo exige igual, pero dejarlo explícito
      //    acá evita que alguien "optimice" esta línea sin entender qué sostiene.
      precio_propuesto: rama === 'control' ? f.precio : f.cand,
    };
  }
}

/**
 * `[PR.D2b]` — Lectura y captura. Se separa del diseñador a propósito: **diseñar** decide qué
 * precios se mueven, **capturar** registra que ya se movieron, y son dos permisos distintos.
 */
@Injectable()
export class PriceExperimentReadService {
  private readonly log = new Logger(PriceExperimentReadService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /** Los experimentos, con su avance de captura — que es lo que dice si se puede medir. */
  async listar(): Promise<unknown[]> {
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(`
        SELECT e.id, e.nombre, e.estado, e.tipo, e.modo_aterrizaje, e.semilla,
               e.fecha_inicio, e.fecha_fin, e.resultado, e.resultado_motivo, e.created_at,
               count(u.id)::int                                            AS unidades,
               count(u.id) FILTER (WHERE u.rama = 'tratamiento')::int      AS tratamiento,
               count(u.id) FILTER (WHERE u.rama = 'control')::int          AS control,
               count(u.id) FILTER (WHERE u.rama = 'tratamiento'
                                     AND u.aplicado_at IS NOT NULL)::int   AS capturadas,
               min(u.aplicado_at)                                          AS primera_captura,
               max(u.aplicado_at)                                          AS ultima_captura,
               /**
                * ⚠️ La dispersion de la captura. Si el tratamiento se captura a lo largo de
                * semanas, las dos ramas dejan de compartir calendario y la estacionalidad entra
                * como sesgo. Se publica para que se vea, no se esconde.
                */
               EXTRACT(DAY FROM (max(u.aplicado_at) - min(u.aplicado_at)))::int AS dias_dispersion
          FROM commercial.price_experiments e
          LEFT JOIN commercial.price_experiment_units u
                 ON u.tenant_id = e.tenant_id AND u.experiment_id = e.id
         GROUP BY e.id, e.nombre, e.estado, e.tipo, e.modo_aterrizaje, e.semilla,
                  e.fecha_inicio, e.fecha_fin, e.resultado, e.resultado_motivo, e.created_at
         ORDER BY e.created_at DESC`);
      return rows;
    });
  }

  /**
   * ⭐ La lista para capturar en Kepler. Sólo el TRATAMIENTO pendiente: el control no se toca,
   * y mandarlo a alguien que captura es la forma más fácil de arruinar el experimento.
   */
  async listaDeCaptura(experimentId: string): Promise<unknown[]> {
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(`
        SELECT u.id, u.sucursal, u.sku, u.estrato,
               u.precio_antes, u.precio_propuesto,
               round((100.0 * (u.precio_propuesto - u.precio_antes) / u.precio_antes)::numeric, 2)
                 AS alza_pct,
               u.aplicado_at, u.aplicado_por
          FROM commercial.price_experiment_units u
         WHERE u.experiment_id = ?
           AND u.rama = 'tratamiento'
         ORDER BY u.aplicado_at NULLS FIRST, u.sucursal, u.sku`, [experimentId]);
      return rows;
    });
  }

  /**
   * Marca una unidad como capturada. ⛔ Sólo el tratamiento: marcar un control como "aplicado"
   * no tiene sentido y el servicio se niega en vez de dejar un registro confuso.
   */
  async marcarAplicada(unitId: string, actor: string): Promise<{ id: string; aplicado_at: Date }> {
    return this.tk.run(async (trx) => {
      const [u] = await trx('commercial.price_experiment_units')
        .where({ id: unitId }).select('rama', 'aplicado_at');
      if (!u) throw new BadRequestException('la unidad no existe');
      if (u.rama !== 'tratamiento') {
        throw new BadRequestException(
          'sólo el tratamiento se captura: el control no se toca, ése es su trabajo');
      }
      if (u.aplicado_at) throw new ConflictException('esa unidad ya estaba capturada');

      const [r] = await trx('commercial.price_experiment_units')
        .where({ id: unitId })
        .update({ aplicado_at: trx.fn.now(), aplicado_por: actor })
        .returning(['id', 'aplicado_at']);
      return r;
    });
  }

  /** El resultado. Sale de la vista que se escribió ANTES de asignar (el pre-registro). */
  async resultados(experimentId: string): Promise<unknown[]> {
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT * FROM analytics.v_price_experiment_results WHERE experiment_id = ?`,
        [experimentId]);
      return rows;
    });
  }
}
