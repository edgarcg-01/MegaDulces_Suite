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
    let ejercicios: PresupuestoDireccion['ejercicios'] = null;
    let ejercicios_error: string | null = null;
    let obligaciones: ObligacionesResumen | null = null;
    let obligaciones_error: string | null = null;
    let ledger: PresupuestoDireccion['ledger'] = null;
    let ledger_error: string | null = null;
    let huecos: HuecoDeclarado[] = [];

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
        const filasEj: EjercicioFila[] = (filas as Array<Record<string, unknown>>).map((b) => {
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

        ejercicios = {
          universo: 'los ejercicios del tenant, SIN filtrar: el de prueba viaja con is_test en true para que se vea, no se esconde',
          as_of: ahora(),
          fuente: 'budget.budgets',
          filas: filasEj,
        };
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
          // ⛔ `line_type = 'gasto'`, y faltaba. Sin este filtro la consulta suma INGRESO Y
          // GASTO en el mismo renglón: FY2026 daba $838,642,961.87 = $32,425,843.06 de gasto
          // + $806,217,118.81 de ingreso. Las cinco etapas —reservado, comprometido, ejercido,
          // pagado— son conceptos de EGRESO: un renglón de ingreso no se "reserva". Medido:
          // las cuatro están en cero para los dos tipos, así que el defecto no se veía en las
          // etapas; sólo en `vigente`, que es la única con cifra.
          .andWhere('l.line_type', 'gasto')
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
          universo: 'renglones de GASTO de los ejercicios reales -- ingreso fuera: las cinco etapas son de egreso -- una columna por ejercicio y sin total',
          as_of: ahora(),
          fuente: 'budget.budget_lines',
          etapas,
        };
      } catch (e) {
        ledger_error = e instanceof Error ? e.message.slice(0, 300) : String(e);
        this.log.warn(`ledger no medido: ${ledger_error}`);
      }

      // ── 5 · Los huecos: lo medible SE MIDE, aquí, con la misma transacción ──
      huecos = await this.huecos(trx);
    });

    return {
      motor, motor_error,
      ejercicios, ejercicios_error,
      obligaciones, obligaciones_error,
      ledger, ledger_error,
      huecos,
      as_of: ahora(),
    };
  }

  /**
   * ⭐ La cadencia se **deriva**, no se escribe. Pero la primera versión usaba la **mediana de
   * todas las diferencias** y publicaba **«cada ~0 h»**. Lo midió el carril de Gastos y lo
   * reproduje: de 28 diferencias, **17 valen cero** porque el motor dispara **una corrida por
   * ejercicio en el mismo minuto** — el 12-oct 07:30 fueron 2, el 09-oct fueron 3. La mediana
   * cae justo en ese cero.
   *
   * ⛔ **Y colapsar a minutos distintos tampoco alcanza**: la mediana pasa a 7.65 h, que sigue
   * sin describir nada. La razón es más profunda que el empate —
   * **la mediana contesta «qué pasó normalmente» y la pregunta es «qué está pasando ahora»**.
   * Los primeros cuatro días fueron el arranque (ahí viven las 7 corridas con error y las
   * repeticiones con minutos de diferencia) y desde el 09-oct el régimen es 24.00 h exactas:
   *
   * ```
   *   10-12 07:30  24.00      10-08 13:44  0.02
   *   10-11 07:30  24.00      10-08 13:43  0.62
   *   10-10 07:30  24.00      10-08 13:06  0.03
   *   10-09 07:30  17.77      10-08 13:04  9.57
   * ```
   *
   * ⇒ Regla nueva, que **se declara sola**: las últimas diferencias entre **minutos distintos**;
   * si concuerdan dentro de tolerancia, se publica; **si no concuerdan, `null`**. Con los datos
   * de hoy da 24.00 · 24.00 · 24.00 → «diaria, ~07:30». Hace una semana habría dado `null`,
   * que es la respuesta correcta para un régimen inestable — y eso es lo que la vuelve honesta:
   * **no inventa una cadencia mientras el motor todavía no la tiene.**
   */
  private async derivarCadencia(trx: unknown, tenantId: string): Promise<string | null> {
    const q = trx as { (t: string): { where: (o: object) => { orderBy: (c: string, d: string) => { limit: (n: number) => Promise<Array<Record<string, unknown>>> } } } };
    const filas = await q('budget.generation_runs').where({ tenant_id: tenantId })
      .orderBy('started_at', 'desc').limit(60);

    const crudos = filas
      .map((f) => new Date(f.started_at as string).getTime())
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => b - a);

    // ⭐ Las TRES constantes con nombre, y la primera la pidió la verificación: midiendo «cuántas
    // diferencias valen cero» este carril dio 17 de 28 y el de Gastos 20 de 28. Las dos
    // mediciones eran correctas — una contó el cero exacto y la otra todo lo menor a media hora.
    // El veredicto no se movía, pero **una tolerancia que no está fijada hace que dos
    // implementaciones correctas discrepen**, y el día que alguien toque la regla no va a saber
    // cuál era la buena.
    //
    // ⚠️ Y de paso arregla un borde: colapsar por minuto de RELOJ parte dos corridas a 07:30:59
    // y 07:31:01, que están a dos segundos. Se colapsa por DISTANCIA, no por cubo.
    const MISMO_DISPARO_MS = 120_000;   // dos corridas a menos de 2 min son el mismo disparo
    const MUESTRA = 3;                  // ver la tabla de abajo: 4 era uno de más
    const TOLERANCIA_H = 1.5;           // 24.00 y 23.1 son la misma cadencia; 24.00 y 17.75 no

    // ⭐ `MUESTRA = 3` NO es un número elegido: lo decidió una medición contra prod, y mi primer
    // valor (4) estaba mal. Las ocho diferencias más recientes, en horas:
    //
    //     24.00  24.00  24.00  17.75  0.65  9.60  7.64  0.18
    //            └──── el régimen ────┘  └──── el arranque ────┘
    //
    //     MUESTRA=2 -> spread 0.00  -> publica   ⚠️ pero DOS valores iguales siempre concuerdan:
    //                                             no distingue un patrón de una coincidencia
    //     MUESTRA=3 -> spread 0.00  -> publica   ⭐ el mínimo que evidencia un régimen
    //     MUESTRA=4 -> spread 6.25  -> null      ⛔ alcanza el arranque y esconde una cadencia
    //                                             que existe y se ve
    //     MUESTRA=5 -> spread 23.35 -> null
    //
    // El costo de 3 es que la regla no reconoce un régimen hasta la cuarta corrida. Es el lado
    // correcto del error: tarda en afirmar, no afirma de más.
    //
    // ⚠️ Y `MISMO_DISPARO_MS` resultó **inocuo entre 60 s y 30 min** —las mismas diferencias en
    // todo ese rango—, así que la divergencia que lo motivó (17 contra 20 ceros, según dónde se
    // pusiera el corte) **no movía el veredicto**. Queda fijado igual: que hoy no cambie el
    // resultado no es lo mismo que no importar, y sin nombre dos implementaciones correctas
    // vuelven a discrepar.

    const disparos: number[] = [];
    for (const t of crudos) {
      if (disparos.length === 0 || disparos[disparos.length - 1] - t > MISMO_DISPARO_MS) disparos.push(t);
    }
    if (disparos.length < MUESTRA + 1) return null;

    const difs = disparos.slice(0, MUESTRA).map((t, i) => (t - disparos[i + 1]) / 3600000);
    const max = Math.max(...difs);
    const min = Math.min(...difs);
    if (max - min > TOLERANCIA_H) return null;   // régimen inestable: no se inventa

    const horas = (max + min) / 2;
    if (horas >= 20 && horas <= 28) {
      const h = new Date(disparos[0]);
      return `diaria, ~${String(h.getHours()).padStart(2, '0')}:${String(h.getMinutes()).padStart(2, '0')}`;
    }
    if (horas < 20) return `cada ~${Math.round(horas * 10) / 10} h`;
    return `cada ~${Math.round(horas / 24)} días`;
  }

  /**
   * ⛔ **Lo medible se MIDE; lo demás se declara con su motivo.**
   *
   * La primera versión devolvía esta lista entera escrita a mano, con el argumento de que «los
   * huecos no se miden, se declaran». Era falso para dos de los tres, y uno **se pudrió antes de
   * llegar a producción**: decía «26 familias» y las familias de gasto —`account_code`— son
   * **14**. El literal venía de un artefacto ya publicado.
   *
   * ⭐ El 14 coincide exacto con el universo de concentración que el dominio ya publicaba
   * («4 de 14 partidas llegan al 80 %»): **dos caminos independientes, el mismo número**.
   *
   * ⇒ `medido: false` queda sólo donde de verdad no hay consulta, y entonces `como` dice por qué.
   */
  private async huecos(trx: unknown): Promise<HuecoDeclarado[]> {
    const q = trx as { raw: (s: string) => Promise<unknown> } & ((t: string) => {
      count: (c: string) => Promise<Array<Record<string, unknown>>>;
      where: (o: object) => { count: (c: string) => Promise<Array<Record<string, unknown>>> };
    });

    let familias: number | null = null;
    let comoFamilias = '';
    try {
      const [f] = await q('budget.budget_lines')
        .count('* as n') as unknown as Array<Record<string, unknown>>;
      void f;
      const r = await (q as unknown as { raw: (s: string) => Promise<{ rows?: Array<Record<string, unknown>> }> })
        .raw('select count(distinct account_code)::int as n from budget.budget_lines where account_code is not null');
      familias = Number((r.rows ?? (r as unknown as Array<Record<string, unknown>>))[0]?.n ?? 0);
      comoFamilias = 'count(distinct account_code) sobre budget.budget_lines, medido en esta corrida';
    } catch (e) {
      comoFamilias = `no se pudo medir: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
    }

    let diasFuturos: number | null = null;
    let comoDias = '';
    try {
      const r = await (q as unknown as { raw: (s: string) => Promise<{ rows?: Array<Record<string, unknown>> }> })
        .raw('select count(*)::int as n from budget.daily_capacity where capacity_date >= current_date');
      diasFuturos = Number((r.rows ?? (r as unknown as Array<Record<string, unknown>>))[0]?.n ?? 0);
      comoDias = 'días con fila de capacidad desde hoy en adelante, medido en esta corrida';
    } catch (e) {
      comoDias = `no se pudo medir: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
    }

    return [
      {
        nombre: 'Dueño por familia de gasto',
        porque: 'ningún renglón tiene quién lo defienda; no lo destraba software, lo destraban nombres',
        peso: {
          valor: familias, unidad: 'familias de gasto, cero con dueño',
          medido: familias !== null, como: comoFamilias,
        },
      },
      {
        nombre: 'Días con techo de pago hacia adelante',
        porque: 'la capacidad diaria sólo tiene filas de un mes ya cerrado; hacia adelante no hay un solo día autorizado',
        peso: {
          valor: diasFuturos, unidad: 'días futuros con techo',
          medido: diasFuturos !== null, como: comoDias,
        },
      },
      {
        nombre: 'Ticket por canal de venta',
        porque: 'no existe conteo de tickets por canal en ninguna fuente: el plan de Mostrador no se puede derivar por cliente',
        peso: {
          // ⭐ El único de los tres que de verdad no tiene consulta. Por eso `medido: false`
          // y `valor: null` — nunca 0, que se leería como «no falta nada».
          valor: null, unidad: 'sin cifra',
          medido: false,
          como: 'ninguna fuente cuenta tickets por canal; el peso de este hueco no se puede derivar hoy',
        },
      },
    ];
  }
}
