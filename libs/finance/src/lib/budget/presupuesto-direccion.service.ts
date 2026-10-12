import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, obligacionNoEsDePruebaSql } from '@megadulces/platform-core';
import type {
  PresupuestoDireccion, MotorPresupuesto, EjercicioFila,
  ObligacionesResumen, EtapaPorEjercicio, HuecoDeclarado,
} from '@megadulces/contracts';

const r2 = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * `[TES.21]` **La vista «Dirección» de `/presupuesto`.**
 *
 * Especificada y verificada por el carril de Gastos; construida acá. Contesta y manda a las
 * otras siete vistas — no las reemplaza, y por eso **no agrega ninguna cifra nueva**: re-publica
 * las que ya existen con su universo pegado.
 *
 * ── ⭐ CADA BLOQUE SE MIDE Y FALLA POR SEPARADO ──────────────────────────────
 *
 * Cuatro consultas independientes, cada una con su `try`. Si una falla, su bloque llega `null`
 * **con el motivo**, y las otras tres siguen. Lo que NO se hace es dejar caer la respuesta
 * entera: una pantalla vacía se lee como «no hay nada que decir», que es la respuesta contraria
 * a «esta parte no se pudo medir».
 *
 * ⚠️ Y tampoco se hace lo opuesto —devolver ceros— que es peor: un cero es una afirmación.
 *
 * ── ⛔ LAS DOS TRAMPAS DE ESTE DOMINIO, LAS DOS MEDIDAS ──────────────────────
 *
 * 1. **El ejercicio de prueba.** 156 obligaciones de cada lado, dentro de $4,666.67 una de otra:
 *    un total combinado se ve perfectamente normal y publica el doble. Van separadas y **no hay
 *    campo que las sume**.
 *    ⚠️ La separación NO es `budget_line_id IS NULL` — medido: **las 312 tienen partida**. Es el
 *    salto de dos tablas de `obligacionNoEsDePruebaSql()`.
 *
 * 2. **Los dos ejercicios no se suman.** FY2026 y FY2027 viajan en columnas. Sumarlos fabrica un
 *    total que no existe en ningún lado; este dominio ya publicó $107,275,909.68 haciéndolo.
 */
@Injectable()
export class PresupuestoDireccionService {
  private readonly log = new Logger(PresupuestoDireccionService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async direccion(): Promise<PresupuestoDireccion> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ahora = () => new Date().toISOString();

    let motor: MotorPresupuesto | null = null;
    let motor_error: string | null = null;
    let ejercicios: EjercicioFila[] = [];
    let ejercicios_error: string | null = null;
    let obligaciones: ObligacionesResumen | null = null;
    let obligaciones_error: string | null = null;
    let ledger: PresupuestoDireccion['ledger'] = null;
    let ledger_error: string | null = null;

    await this.tk.run(async (trx) => {
      // ── 1 · El motor ───────────────────────────────────────────────────
      try {
        const fila = await trx('budget.generation_runs')
          .where({ tenant_id: tenantId })
          .select(
            trx.raw('count(*)::int as corridas'),
            trx.raw(`count(*) filter (where status = 'ok')::int as ok`),
            trx.raw(`count(*) filter (where status = 'error')::int as err`),
            trx.raw(`max(started_at) filter (where status = 'ok') as ultima_ok`),
            trx.raw(`max(started_at) filter (where status = 'error') as ultima_error`),
          ).first() as unknown as Record<string, unknown>;

        motor = {
          universo: 'todas las corridas del generador, sin filtrar por ejercicio ni por tipo',
          as_of: ahora(),
          fuente: 'budget.generation_runs',
          corridas: Number(fila?.corridas ?? 0),
          ok: Number(fila?.ok ?? 0),
          error: Number(fila?.err ?? 0),
          ultima_ok: fila?.ultima_ok ? new Date(fila.ultima_ok as string).toISOString() : null,
          ultima_error: fila?.ultima_error ? new Date(fila.ultima_error as string).toISOString() : null,
          cadencia: await this.derivarCadencia(trx, tenantId),
        };
      } catch (e) {
        motor_error = e instanceof Error ? e.message.slice(0, 300) : String(e);
        this.log.warn(`motor no medido: ${motor_error}`);
      }

      // ── 2 · Los ejercicios ─────────────────────────────────────────────
      try {
        const filas = await trx('budget.budgets')
          .where({ tenant_id: tenantId })
          .select('id', 'folio', 'fiscal_year', 'status', 'is_test',
            'created_by', 'created_at', 'authorized_by', 'authorized_at')
          .orderBy([{ column: 'is_test', order: 'asc' }, { column: 'fiscal_year', order: 'desc' }]);

        const hoy = Date.now();
        ejercicios = (filas as Array<Record<string, unknown>>).map((b) => {
          // ⭐ Días SIN FIRMAR, no "en borrador": exacto, no proxy. El ejercicio está sin firmar
          // desde el alta — medido, en los dos reales `created_at == updated_at` al minuto. Si ya
          // está firmado va `null`: no se cuentan días de espera de algo que no espera.
          const firmado = b.authorized_at != null;
          const t = b.created_at ? new Date(b.created_at as string).getTime() : NaN;
          return {
            id: String(b.id),
            folio: (b.folio as string) ?? null,
            fiscal_year: num(b.fiscal_year),
            status: String(b.status),
            is_test: b.is_test === true,
            creado_por: (b.created_by as string) ?? null,
            dias_sin_firmar: firmado || Number.isNaN(t)
              ? null
              : Math.max(0, Math.floor((hoy - t) / 86400000)),
            autorizado_por: (b.authorized_by as string) ?? null,
            autorizado_en: b.authorized_at ? new Date(b.authorized_at as string).toISOString() : null,
          };
        });
      } catch (e) {
        ejercicios_error = e instanceof Error ? e.message.slice(0, 300) : String(e);
        this.log.warn(`ejercicios no medidos: ${ejercicios_error}`);
      }

      // ── 3 · Las obligaciones, SIEMPRE en dos universos ─────────────────
      try {
        const agg = await trx('budget.expense_obligations')
          .where({ tenant_id: tenantId })
          .select(
            trx.raw(`count(*) filter (where ${obligacionNoEsDePruebaSql()})::int as n_real`),
            trx.raw(`coalesce(sum(original_amount) filter (where ${obligacionNoEsDePruebaSql()}),0)::float8 as m_real`),
            trx.raw(`count(*) filter (where not (${obligacionNoEsDePruebaSql()}))::int as n_prueba`),
            trx.raw(`coalesce(sum(original_amount) filter (where not (${obligacionNoEsDePruebaSql()})),0)::float8 as m_prueba`),
          ).first() as unknown as Record<string, unknown>;

        obligaciones = {
          universo: 'obligaciones de gasto en cualquier estado, partidas en dos universos por el ejercicio del que cuelgan',
          as_of: ahora(),
          fuente: 'budget.expense_obligations -> budget_lines -> budgets.is_test',
          reales: { n: Number(agg?.n_real ?? 0), monto: r2(agg?.m_real) },
          prueba: { n: Number(agg?.n_prueba ?? 0), monto: r2(agg?.m_prueba) },
        };
      } catch (e) {
        obligaciones_error = e instanceof Error ? e.message.slice(0, 300) : String(e);
        this.log.warn(`obligaciones no medidas: ${obligaciones_error}`);
      }

      // ── 4 · El ledger, una COLUMNA por ejercicio ───────────────────────
      try {
        const filas = await trx('budget.budget_lines as l')
          .join('budget.budgets as b', 'b.id', 'l.budget_id')
          .where({ 'l.tenant_id': tenantId })
          .andWhere((q: { where: (c: string, v: unknown) => unknown; orWhereNull: (c: string) => unknown }) => {
            q.where('b.is_test', false); q.orWhereNull('b.is_test');
          })
          .groupBy('b.fiscal_year')
          .select('b.fiscal_year',
            trx.raw('coalesce(sum(l.vigente_amount),0)::float8 as vigente'),
            trx.raw('coalesce(sum(l.reserved_amount),0)::float8 as reservado'),
            trx.raw('coalesce(sum(l.committed_amount),0)::float8 as comprometido'),
            trx.raw('coalesce(sum(l.exercised_amount),0)::float8 as ejercido'),
            trx.raw('coalesce(sum(l.paid_amount),0)::float8 as pagado'),
          ).orderBy('b.fiscal_year', 'asc') as unknown as Array<Record<string, unknown>>;

        const QUIEN: Record<string, string> = {
          vigente: 'el motor, cada mañana',
          reservado: 'el calendario de pagos',
          comprometido: 'la orden de compra',
          ejercido: 'la recepción',
          pagado: 'tesorería',
          disponible: 'nadie: se deriva',
        };
        const etapas: EtapaPorEjercicio[] = (
          ['vigente', 'reservado', 'comprometido', 'ejercido', 'pagado', 'disponible'] as const
        ).map((etapa) => ({
          etapa,
          quien_la_mueve: QUIEN[etapa],
          por_ejercicio: filas.map((f) => ({
            fiscal_year: Number(f.fiscal_year),
            monto: etapa === 'disponible'
              ? r2(Number(f.vigente) - Number(f.reservado) - Number(f.comprometido) - Number(f.ejercido))
              : r2(f[etapa]),
          })),
        }));

        ledger = {
          universo: 'renglones de los ejercicios REALES, el de prueba fuera; una columna por ejercicio y sin total',
          as_of: ahora(),
          fuente: 'budget.budget_lines',
          etapas,
        };
      } catch (e) {
        ledger_error = e instanceof Error ? e.message.slice(0, 300) : String(e);
        this.log.warn(`ledger no medido: ${ledger_error}`);
      }
    });

    return {
      motor, motor_error,
      ejercicios, ejercicios_error,
      obligaciones, obligaciones_error,
      ledger, ledger_error,
      huecos: this.huecos(),
      as_of: ahora(),
    };
  }

  /**
   * ⭐ La cadencia se **deriva**, no se escribe. Mediana de la diferencia entre corridas
   * consecutivas: con menos de tres no hay dos diferencias que comparar, así que va `null`
   * **con motivo del lado del consumidor** — nunca `''`, que se lee como «no tiene cadencia».
   */
  private async derivarCadencia(trx: unknown, tenantId: string): Promise<string | null> {
    const q = trx as { (t: string): { where: (o: object) => { orderBy: (c: string, d: string) => { limit: (n: number) => Promise<Array<Record<string, unknown>>> } } } };
    const filas = await q('budget.generation_runs').where({ tenant_id: tenantId })
      .orderBy('started_at', 'desc').limit(30);
    const ts = filas.map((f) => new Date(f.started_at as string).getTime()).filter((n) => !Number.isNaN(n));
    if (ts.length < 3) return null;
    const difs = ts.slice(0, -1).map((t, i) => Math.abs(t - ts[i + 1])).sort((a, b) => a - b);
    const mediana = difs[Math.floor(difs.length / 2)];
    const horas = mediana / 3600000;
    if (horas >= 20 && horas <= 28) {
      const h = new Date(ts[0]);
      return `diaria, ~${String(h.getHours()).padStart(2, '0')}:${String(h.getMinutes()).padStart(2, '0')}`;
    }
    if (horas < 20) return `cada ~${Math.round(horas * 10) / 10} h`;
    return `cada ~${Math.round(horas / 24)} días`;
  }

  /**
   * Los huecos van **con nombre y peso**, no como ausencia silenciosa. Esta lista no se mide:
   * es el estado declarado de las decisiones abiertas del dominio, y cambia cuando alguien las
   * cierra — por eso cada una dice qué la destraba, no sólo que falta.
   */
  private huecos(): HuecoDeclarado[] {
    return [
      {
        nombre: 'Meta por renglón',
        porque: 'el registro de umbrales no tiene ninguna fila de presupuesto: sin meta, ningún renglón tiene contra qué juzgarse',
        peso: '16 indicadores',
      },
      {
        nombre: 'Días con techo de pago hacia adelante',
        porque: 'la capacidad diaria sólo tiene filas de un mes ya cerrado; hacia adelante no hay un solo día autorizado',
        peso: '0 días futuros',
      },
      {
        nombre: 'Dueño por familia de gasto',
        porque: 'ningún renglón tiene quién lo defienda; no lo destraba software, lo destraban nombres',
        peso: '26 familias',
      },
    ];
  }
}
