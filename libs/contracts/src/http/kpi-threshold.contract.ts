// [CDRP.2] Registro de umbrales — la forma y el clasificador de un KPI directivo.
//
// ── Por qué existe ───────────────────────────────────────────────────────────────────────────
// §13 del documento CDRP: *«No codificar umbrales dentro de la interfaz. Deben ser configurables
// por KPI, puesto, periodo y eventualmente unidad de negocio»*. Hoy no hay dónde guardarlos, así
// que las 12 interfaces del tablero nacerían cada una con su número clavado adentro.
//
// ── ⛔ Y el defecto que esto evita ya está medido en este repo ───────────────────────────────
// La Fase VP encontró que `db-health` clasificaba con `cfg ? classify : 'ok'`: **sin umbral
// registrado, verde incondicional**. Las 3 matvistas del sell-out estuvieron en verde por no
// tener umbral, no por estar sanas. El contrato de la especificación (§12) repite la trampa: sus
// tres estados son `green|yellow|red`, y con tres, **un KPI sin meta sale verde**.
//
// ── Lo que se HEREDA y no se reinventa ──────────────────────────────────────────────────────
// `manual_lock` y `auto_tuned_at` vienen tal cual de `commercial.execution_thresholds` (Horus
// HIQ.2/HIQ.4, ADR-021): el auto-calibrador NO pisa lo que un humano fijó. Es el mismo primitivo,
// ahora con la forma que sí escala — **una fila por (kpi, puesto, periodo)** en vez de una columna
// por indicador, que es lo que impedía reusar la tabla de Horus para 16 KPIs × 9 puestos.
//
// ⛔ `CRON_JOBS` (`db-health.service.ts`) queda FUERA a propósito: mide frescura de feeds en
// horas, que es otra pregunta, y además es un array de TypeScript — moverlo a tabla es su tarea.

/**
 * `[CDRP.2]` **Hacia dónde es "mejor".**
 *
 * ⛔ No es un adorno: sin esto, la mitad de los KPIs se clasifican al revés. «Cartera vencida» y
 * «días de inventario» son mejores cuanto MENORES; «ventas» y «margen», cuanto mayores. Un
 * registro de umbrales sin dirección pintaría en verde una cartera que se disparó.
 */
export type KpiDireccion = 'higher_is_better' | 'lower_is_better';

/**
 * `[CDRP.2]` **CINCO estados, y los cinco hacen falta.**
 *
 * Los tres del documento (§12) no alcanzan, y las dos ausencias que agrega **no son la misma**:
 *
 *  · `sin_medir` — **no hay cifra**. La fuente no existe, o existe y falló. No se puede decir nada.
 *  · `sin_meta`  — **hay cifra y no hay contra qué compararla**. Es el estado de los 13 de 16 KPIs
 *    del tablero mientras las seis tablas de presupuesto sigan en 0 filas.
 *
 * Colapsarlas convierte «no sé cuánto vendimos» en «vendimos y no sé si está bien», que son
 * problemas de dueños distintos: una la arregla Sistemas, la otra Dirección.
 *
 * ⛔ Y ninguna de las dos es `ok`. Ésa es la regla entera (ADR-056).
 */
export type KpiEstado = 'ok' | 'warn' | 'bad' | 'sin_meta' | 'sin_medir';

/** Orden de atención. Índice más chico = más arriba. Lo no medido NO se ordena junto a lo sano. */
export const ORDEN_KPI_ESTADO: Readonly<Record<KpiEstado, number>> = {
  bad: 0,
  warn: 1,
  sin_meta: 2,
  sin_medir: 3,
  ok: 4,
};

/**
 * `[CDRP.2]` Una fila del registro: contra qué se juzga UN indicador, para UN puesto, en UN grano.
 *
 * ── Los tres números, y por qué son tres y no dos ───────────────────────────────────────────
 * §13 pide distinguir **meta** (resultado esperado), **umbral amarillo** (desviación que exige
 * vigilancia), **umbral rojo** (desviación que exige acción) y **escalamiento** (condición que
 * debe llegar al superior). Eso son dos fronteras de color más una de escalamiento:
 *
 *     higher_is_better:   target  ≥  warn_at  ≥  escalate_at
 *        valor ≥ target        → ok
 *        valor ≥ warn_at       → warn
 *        valor <  warn_at      → bad
 *        valor <  escalate_at  → bad **y además escala**
 *
 * `lower_is_better` invierte las tres comparaciones, no sólo una.
 *
 * ── ⛔ Absolutos, no porcentaje de la meta ──────────────────────────────────────────────────
 * La tentación es guardar «amarillo = 95 % de la meta», que es como lo escribe §13. Se rechaza por
 * dos razones medidas: (1) **se rompe con meta 0**, y «cartera vencida, meta 0» es un objetivo
 * real de este negocio; (2) el porcentaje esconde el número, y este proyecto ya publicó cifras
 * falsas por no poder ver el operando.
 *
 * El riesgo del absoluto —que suban la meta y olviden mover los umbrales— **no se mitiga con
 * disciplina: se impide**. Un CHECK en la tabla RECHAZA la fila incoherente, así que el descuido
 * falla ruidoso en vez de dejar un semáforo callado que clasifica mal.
 */
export interface KpiUmbral {
  /** Clave estable del indicador (`comercial.ventas_consolidadas`). */
  kpi_key: string;
  /**
   * Puesto al que aplica. **`null` = a todos.** Una fila con puesto GANA sobre la genérica.
   *
   * ⚠️ La precedencia se resuelve en `umbralPara()` y en un solo lugar a propósito: ADR-057 dejó
   * dicho que *cuando un CASE mezcla dos preguntas, la precedencia le miente a una*, y acá las
   * dos preguntas son «¿qué KPI?» y «¿de quién?».
   */
  position_code: string | null;
  /** Grano del que habla el umbral. Una meta mensual no juzga un día. */
  period: 'dia' | 'semana' | 'mes' | 'trimestre' | 'anio';
  /** El resultado esperado, en la unidad del KPI. */
  target: number;
  /** Frontera del amarillo. */
  warn_at: number;
  /** Frontera del escalamiento. Cruzarla NO cambia el color: agrega destinatario. */
  escalate_at: number;
  direction: KpiDireccion;
  /** Puesto al que escala (`identity.positions.code`). `null` = no escala a nadie. */
  escalate_to: string | null;
  /**
   * De dónde salió el número. Texto libre y **obligatorio**: un umbral sin procedencia es el mismo
   * problema que una cifra sin procedencia (ADR-056), sólo que del otro lado de la comparación.
   */
  source: string;
  /** `[CDRP.2]` Heredado de Horus (ADR-021): con `true`, el auto-calibrador NO pisa esta fila. */
  manual_lock: boolean;
  /** Última vez que un calibrador automático tocó la fila. `null` = nunca; siempre fue humana. */
  auto_tuned_at: string | null;
}

/** Lo que el clasificador devuelve. `escala_a` sólo se llena cuando de verdad hay que escalar. */
export interface KpiVeredicto {
  estado: KpiEstado;
  /** Por qué. En `sin_meta`/`sin_medir` dice QUÉ falta, no «sin datos». */
  motivo: string | null;
  escala_a: string | null;
  /** Avance contra la meta (`0.94`). `null` cuando no hay meta o la meta es 0. */
  avance: number | null;
}

/**
 * `[CDRP.2]` **Qué umbral le toca a esta persona para este KPI.**
 *
 * Precedencia declarada y en UN solo lugar: la fila del puesto gana sobre la genérica; entre dos
 * del mismo puesto, gana la del grano pedido. Si no hay ninguna, devuelve `null` — que NO es un
 * umbral permisivo, es la ausencia, y `clasificarKpi` la convierte en `sin_meta`.
 */
export function umbralPara(
  filas: readonly KpiUmbral[],
  kpi_key: string,
  position_code: string | null,
  period: KpiUmbral['period'],
): KpiUmbral | null {
  const delKpi = filas.filter((f) => f.kpi_key === kpi_key && f.period === period);
  return (
    delKpi.find((f) => f.position_code !== null && f.position_code === position_code) ??
    delKpi.find((f) => f.position_code === null) ??
    null
  );
}

/**
 * `[CDRP.2]` **El semáforo.** Cinco estados, y las dos ausencias se distinguen.
 *
 * ⛔ La prueba negativa que este contrato existe para pasar: con `umbral === null` NO devuelve
 * `ok`. Ése es el `cfg ? classify : 'ok'` que la Fase VP encontró dando verde incondicional, y es
 * lo único que impide que el tablero directivo nazca mintiendo.
 */
export function clasificarKpi(valor: number | null, umbral: KpiUmbral | null): KpiVeredicto {
  if (valor === null || !Number.isFinite(valor)) {
    return {
      estado: 'sin_medir',
      motivo: 'No hay cifra: la fuente de este indicador no está construida o no respondió.',
      escala_a: null,
      avance: null,
    };
  }
  if (!umbral) {
    return {
      estado: 'sin_meta',
      motivo: 'Hay cifra y no hay meta registrada: no se puede decir si está bien o mal.',
      escala_a: null,
      avance: null,
    };
  }

  const mayor = umbral.direction === 'higher_is_better';
  const cumple = (a: number, b: number) => (mayor ? a >= b : a <= b);

  // ⚠️ El avance sólo tiene sentido contra una meta distinta de cero, y «meta 0» es legítimo
  // (cartera vencida). Se declara `null` en vez de dividir entre cero o dibujar 0 %.
  const avance = umbral.target === 0 ? null : valor / umbral.target;

  const escala = !cumple(valor, umbral.escalate_at) ? umbral.escalate_to : null;

  if (cumple(valor, umbral.target)) {
    return { estado: 'ok', motivo: null, escala_a: null, avance };
  }
  if (cumple(valor, umbral.warn_at)) {
    return {
      estado: 'warn',
      motivo: `Por ${mayor ? 'debajo' : 'encima'} de la meta y dentro de la tolerancia.`,
      // ⛔ El escalamiento se evalúa por su PROPIA frontera, no por el color: un umbral mal
      // ordenado no puede colar un `warn` que escale, porque el CHECK de la tabla lo rechaza.
      escala_a: escala,
      avance,
    };
  }
  return {
    estado: 'bad',
    motivo: `Fuera de la tolerancia: exige acción${escala ? ' y aviso al superior' : ''}.`,
    escala_a: escala,
    avance,
  };
}
