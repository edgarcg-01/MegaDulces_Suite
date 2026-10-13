import {
  clasificarKpi, umbralPara, ORDEN_KPI_ESTADO,
  type KpiEstado, type KpiUmbral,
} from '@megadulces/contracts';

/**
 * `[CPA.0]` — **La regla del semáforo de cierre, pura.**
 *
 * Mismo criterio que `cuadre.engine.ts` (`[CP.8.10]`): toda la REGLA vive acá, sin DI y sin base,
 * y el servicio sólo hace la I/O. Así el candado prueba el comportamiento sin levantar nada —y
 * sobre todo, prueba **las dos reglas que pueden mentir en silencio**:
 *
 *  1. ⭐ **El mes en curso no se juzga.** El día 3 de cualquier mes, compras va en cero porque
 *     todavía no pasó el mes, no porque falte la póliza. Si eso saliera `bad`, el tablero se
 *     pondría rojo todos los días 1 — y un tablero que grita siempre enseña a ignorarlo, que es
 *     exactamente cómo un mes que de verdad falta pasa desapercibido.
 *  2. ⛔ **Los umbrales llegan de Postgres como texto.** `numeric` sale `string` por el driver, y
 *     `'0.50' >= 0.9045` es una comparación de TEXTO que devuelve lo contrario de lo que parece.
 *     Un semáforo que compara cadenas no falla: miente, y se ve igual de verde.
 *
 * El veredicto lo emite `clasificarKpi()` de `[CDRP.2]` — acá no se reimplementa ni se "ayuda"
 * con atajos. Si hiciera falta una excepción, va allá y con su prueba.
 */

/** El prefijo con el que viven estas claves en `analytics.kpi_thresholds`. */
export const PREFIJO_KPI = 'cierre_contable.';

/**
 * `[CPA.0.1]` Sufijo del **techo**. El mismo número se lee dos veces: contra el piso (¿falta?) y
 * contra el techo (¿sobra?). Dos filas en el MISMO registro, con el MISMO clasificador — la de
 * techo con `lower_is_better`. Cero primitivos nuevos.
 */
export const SUFIJO_ALTO = '.alto';

/**
 * `[CPA.0.1]` Mínimo de meses para que una mediana sea una base de comparación.
 *
 * ⛔ Medido contra prod: `2025-02 gastos` y `2025-02 nomina` calculaban su mediana con **UN solo
 * mes**, y el veredicto salía idéntico a uno apoyado en seis. Es la lección de `[CP.8.20]`:
 * *pureza perfecta sobre n=1 no es certeza*. Con menos de este mínimo, el engine **se niega a
 * juzgar** y devuelve `sin_medir` con el motivo — que no es lo mismo que decir que está mal.
 *
 * ⚠️ Tres y no dos: con dos meses la mediana es el promedio de ambos, así que un mes raro arrastra
 * la mitad del patrón. Con tres, la mediana ya es un valor observado y el raro queda de lado.
 */
export const MESES_MINIMOS_HISTORIA = 3;

/** El motivo exacto cuando la historia no alcanza. Lo usa el candado; no se duplica. */
export const motivoHistoriaCorta = (n: number): string =>
  `La comparación sería contra ${n} mes${n === 1 ? '' : 'es'} previo${n === 1 ? '' : 's'}, `
  + `y hacen falta ${MESES_MINIMOS_HISTORIA}: no hay patrón contra el cual decir si falta algo.`;

/** Lo que la vista publica por (mes × familia). Los numéricos llegan como texto desde `pg`. */
export interface FilaCierreCruda {
  anio_mes: string;
  familia: string;
  etiqueta: string;
  senal_cuentas: string;
  senal: string | number;
  senal_renglones: string | number;
  provisional: string | number | null;
  testigo: string | number | null;
  testigo_fuente: string | null;
  cobertura_base: 'testigo' | 'historia';
  mediana_6m: string | number | null;
  /** `[CPA.0.1]` Sobre cuántos meses descansa esa mediana. 0 cuando la base es `testigo`. */
  mediana_meses?: string | number | null;
  cobertura: string | number | null;
  periodo_estado: 'cerrado' | 'en_curso';
  data_as_of?: string | null;
}

export interface FamiliaCierre {
  familia: string;
  etiqueta: string;
  senal_cuentas: string;
  senal: number;
  senal_renglones: number;
  provisional: number | null;
  testigo: number | null;
  testigo_fuente: string | null;
  cobertura_base: 'testigo' | 'historia';
  mediana_6m: number | null;
  /** `[CPA.0.1]` Sobre cuántos meses descansa la mediana. 0 cuando la base es `testigo`. */
  mediana_meses: number;
  cobertura: number | null;
  estado: KpiEstado;
  motivo: string | null;
  escala_a: string | null;
  /** El umbral que se aplicó, para que la pantalla explique el color sin adivinarlo. */
  umbral: { target: number; warn_at: number; escalate_at: number } | null;
  /**
   * `[CPA.0.1]` `true` cuando el veredicto lo decidió el TECHO (sobra), no el piso (falta).
   * Sin esto, un mes duplicado y un mes ausente se pintan del mismo color sin decir por qué.
   */
  por_exceso: boolean;
}

export interface MesCierre {
  anio_mes: string;
  periodo_estado: 'cerrado' | 'en_curso';
  /** El PEOR de sus familias (`ORDEN_KPI_ESTADO`): lo que se pinta en el renglón del mes. */
  estado: KpiEstado;
  conteo: Record<KpiEstado, number>;
  familias: FamiliaCierre[];
}

/** El motivo exacto con el que se declara un mes incompleto. Lo usa el candado, no se duplica. */
export const MOTIVO_EN_CURSO =
  'Mes en curso: todavía no terminó, así que no se puede decir si está asentado.';

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * Normaliza las filas de `analytics.kpi_thresholds` a números.
 *
 * ⛔ No es cosmético y no se puede saltar: sin esto `clasificarKpi` compara `string` con `number`
 * y JavaScript resuelve por coerción en unos casos y por orden lexicográfico en otros. El candado
 * le pasa umbrales en texto a propósito.
 */
export function normalizarUmbrales(filas: readonly Record<string, unknown>[]): KpiUmbral[] {
  return filas.map((u) => ({
    kpi_key: String(u['kpi_key']),
    position_code: (u['position_code'] as string | null) ?? null,
    period: u['period'] as KpiUmbral['period'],
    target: Number(u['target']),
    warn_at: Number(u['warn_at']),
    escalate_at: Number(u['escalate_at']),
    direction: u['direction'] as KpiUmbral['direction'],
    escalate_to: (u['escalate_to'] as string | null) ?? null,
    source: String(u['source'] ?? ''),
    manual_lock: Boolean(u['manual_lock']),
    auto_tuned_at: (u['auto_tuned_at'] as string | null) ?? null,
  }));
}

/**
 * Agrupa las filas por mes, clasifica cada familia y le pone al mes el peor estado de las suyas.
 *
 * ⚠️ El orden de los meses se **conserva** tal como vino de la consulta: ordenar acá sería una
 * segunda opinión sobre algo que el `ORDER BY` ya decidió, y las dos se desincronizan.
 */
export function armarCierre(
  filas: readonly FilaCierreCruda[],
  reglas: readonly KpiUmbral[],
): MesCierre[] {
  const porMes = new Map<string, MesCierre>();

  for (const f of filas) {
    const umbral = umbralPara(reglas, PREFIJO_KPI + f.familia, null, 'mes');
    const techo = umbralPara(reglas, PREFIJO_KPI + f.familia + SUFIJO_ALTO, null, 'mes');
    const cobertura = num(f.cobertura);
    const medianaMeses = num(f.mediana_meses) ?? 0;

    /*
     * ⭐ `[CPA.0.1]` El MISMO número se lee DOS veces y manda el peor:
     *   · piso  (`higher_is_better`) — ¿falta? Es para lo que el semáforo nació.
     *   · techo (`lower_is_better`)  — ¿sobra? Un mes posteado dos veces da ~2.0 y, sin esto,
     *     salía `ok` porque el piso sólo mira hacia abajo.
     * Las dos filas viven en el mismo registro y las clasifica la misma función: cero primitivos
     * nuevos (ADR-056). `por_exceso` dice cuál de las dos mandó, para que la pantalla no pinte
     * igual «falta» que «sobra».
     */
    const vPiso = clasificarKpi(cobertura, umbral);
    const vTecho = techo ? clasificarKpi(cobertura, techo) : null;
    const mandaTecho = !!vTecho
      && ORDEN_KPI_ESTADO[vTecho.estado] < ORDEN_KPI_ESTADO[vPiso.estado];
    const vRango = mandaTecho && vTecho
      ? { ...vTecho, motivo: `Por ENCIMA de lo esperado (${vTecho.motivo ?? 'fuera de rango'}). Puede ser un mes posteado dos veces.` }
      : vPiso;

    // Regla 1: el mes en curso se DECLARA, no se aprueba ni se reprueba.
    // Regla 4 `[CPA.0.1]`: una mediana sobre muy pocos meses NO es una base de comparación.
    const veredicto = f.periodo_estado === 'en_curso'
      ? { estado: 'sin_medir' as KpiEstado, motivo: MOTIVO_EN_CURSO, escala_a: null }
      : (f.cobertura_base === 'historia' && medianaMeses < MESES_MINIMOS_HISTORIA
        ? { estado: 'sin_medir' as KpiEstado, motivo: motivoHistoriaCorta(medianaMeses), escala_a: null }
        : vRango);

    const fam: FamiliaCierre = {
      familia: f.familia,
      etiqueta: f.etiqueta,
      senal_cuentas: f.senal_cuentas,
      senal: num(f.senal) ?? 0,
      senal_renglones: num(f.senal_renglones) ?? 0,
      provisional: num(f.provisional),
      testigo: num(f.testigo),
      testigo_fuente: f.testigo_fuente,
      cobertura_base: f.cobertura_base,
      mediana_6m: num(f.mediana_6m),
      mediana_meses: medianaMeses,
      cobertura,
      estado: veredicto.estado,
      motivo: veredicto.motivo,
      escala_a: veredicto.escala_a,
      umbral: umbral
        ? { target: umbral.target, warn_at: umbral.warn_at, escalate_at: umbral.escalate_at }
        : null,
      // Sólo cuenta si el veredicto SOBREVIVIÓ: si después lo pisó `en_curso` o la historia
      // corta, el color no lo decidió el techo y marcarlo sería mentir sobre el porqué.
      por_exceso: mandaTecho && veredicto === vRango,
    };

    let mes = porMes.get(f.anio_mes);
    if (!mes) {
      mes = {
        anio_mes: f.anio_mes,
        periodo_estado: f.periodo_estado,
        estado: 'sin_medir',
        conteo: { ok: 0, warn: 0, bad: 0, sin_meta: 0, sin_medir: 0 },
        familias: [],
      };
      porMes.set(f.anio_mes, mes);
    }
    mes.familias.push(fam);
    mes.conteo[fam.estado] += 1;
  }

  // Regla 3: manda el peor. `ORDEN_KPI_ESTADO` pone `ok` al final a propósito, así que un mes
  // con una sola familia en rojo no puede salir verde por mayoría.
  for (const m of porMes.values()) {
    m.estado = m.familias.reduce<KpiEstado>(
      (peor, f) => (ORDEN_KPI_ESTADO[f.estado] < ORDEN_KPI_ESTADO[peor] ? f.estado : peor),
      'ok',
    );
  }

  return [...porMes.values()];
}

/** Qué familias de la ventana NO tienen umbral registrado. Alimenta la cobertura declarada. */
export function familiasSinUmbral(
  filas: readonly FilaCierreCruda[],
  reglas: readonly KpiUmbral[],
): string[] {
  const sin = new Set<string>();
  for (const f of filas) {
    if (!umbralPara(reglas, PREFIJO_KPI + f.familia, null, 'mes')) sin.add(f.familia);
  }
  return [...sin];
}

/** `YYYY-MM` de una fecha, en hora local (TZ del backend: America/Mexico_City). */
export function mesDe(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * `YYYY-MM` n meses antes.
 *
 * ⚠️ Aritmética sobre el número de mes y no sobre `Date`: restarle meses a un `Date` cruza husos
 * y cambios de horario, y el día 31 "se cae" al mes siguiente (31-mar menos 1 mes da 3-mar).
 */
export function mesMenos(mes: string, n: number): string {
  const [y, m] = mes.split('-').map(Number);
  const total = y * 12 + (m - 1) - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}
