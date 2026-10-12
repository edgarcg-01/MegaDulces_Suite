/**
 * `[TES.21]` **La vista «Dirección» de `/presupuesto` — el contrato.**
 *
 * Primera vista del módulo: **contesta y manda a las otras siete**, no las reemplaza.
 *
 * ── ⭐ CADA BLOQUE CARGA SU UNIVERSO, Y NO HAY COPETE QUE LO DECLARE POR TODOS ──
 *
 * El 2026-10-10 este dominio produjo **seis derivaciones del mismo DPO en dos horas** entre tres
 * sesiones. Cuatro estaban mal declaradas, no mal calculadas: cada una dividía dos recortes
 * distintos sin decirlo. Un `as_of` único arriba de la página habría tapado exactamente eso,
 * porque los bloques **no comparten ventana ni fuente**: el motor se mide en corridas, las
 * obligaciones en una tabla viva que se movió **$2,542.47 en 24 h**, y el ledger en dos
 * ejercicios que no se suman.
 *
 * ⇒ `BloqueUniverso` viaja **por bloque**. Si un bloque no puede decir de qué es recorte,
 * no se publica.
 *
 * ── ⛔ LOS `*_error` NO SON DEFENSIVOS: SON LA MITAD DEL CONTRATO ──
 *
 * Un bloque que **desaparece** cuando su consulta falla se lee como «no hay nada», que es la
 * respuesta contraria a la verdad. Por eso cada bloque es `T | null` **más** su `*_error`:
 * `null` sin motivo es un bug; `null` con motivo es una medición que falta, declarada.
 */

/** De qué es recorte este bloque. Sin esto, la cifra es irreproducible aunque esté bien. */
export interface BloqueUniverso {
  /** El recorte en una línea, legible: qué filas entran y cuáles no. */
  universo: string;
  /** Cuándo se midió ESTE bloque. No se hereda del de al lado. */
  as_of: string;
  /** Tabla o vista de la que salió, para poder re-correrlo. */
  fuente: string;
}

/**
 * El motor que reescribe el presupuesto solo, todos los días.
 *
 * ⚠️ `cadencia` se **deriva** de los `started_at` reales, nunca se escribe a mano: un literal
 * como `'07:30 diaria'` es una afirmación que nadie vuelve a medir y que sobrevive al día en que
 * deja de ser cierta. Si las corridas no alcanzan para derivarla, va `null` — **nunca `''`**,
 * que se renderiza como «no hay cadencia» en vez de «no se pudo derivar».
 */
export interface MotorPresupuesto extends BloqueUniverso {
  corridas: number;
  ok: number;
  error: number;
  ultima_ok: string | null;
  ultima_error: string | null;
  cadencia: string | null;
}

export interface EjercicioFila {
  id: string;
  folio: string | null;
  fiscal_year: number | null;
  status: string;
  is_test: boolean;
  creado_por: string | null;
  /**
   * ⭐ **Días sin firmar — exacto, no un proxy.** La primera versión de este campo era
   * `dias_en_borrador` derivado de `updated_at`, declarado como aproximación porque `budget.*`
   * no guarda cuándo un ejercicio entró a borrador. El carril de Gastos lo corrigió con una
   * medición: **no hacía falta un proxy, hacía falta otra pregunta.**
   *
   * `current_date − created_at::date`, con guarda `authorized_at IS NULL`. Es exacto porque el
   * ejercicio está **sin firmar desde el alta**: medido el 2026-10-12, en los dos ejercicios
   * reales `created_at == updated_at` al minuto —nadie los tocó desde que nacieron— y los tres
   * tienen `authorized_at` en NULL. `null` cuando ya está firmado: no se cuentan días de espera
   * de algo que no espera.
   *
   * ⚠️ **Su límite, que sí existe:** en `budget.*` la única tabla de historial es
   * `daily_capacity_history` — **no hay historial de estado**. Un ejercicio que hubiera sido
   * firmado y revertido limpiando `authorized_at` contaría desde el alta y nadie podría verlo.
   * Hoy no aplica; el día que exista una reversión, este campo necesita historial.
   */
  dias_sin_firmar: number | null;
  autorizado_por: string | null;
  autorizado_en: string | null;
}

/**
 * ⛔ **Los dos universos van SEPARADOS y no existe un campo que los sume.**
 *
 * El ejercicio de prueba es copia casi exacta del real —156 obligaciones de cada lado, dentro de
 * $4,666.67 una de otra— así que un total combinado **se ve perfectamente normal** y publica el
 * doble. Ya ocurrió una vez en este dominio.
 *
 * ⚠️ Y la separación **no** es por `budget_line_id IS NULL`: medido el 2026-10-12, **las 312
 * tienen partida**. Separarlas por ese campo devuelve 0 de prueba y 312 reales — el defecto
 * entrando por la puerta de la especificación. El salto correcto es
 * `budget_line_id → budget_lines.budget_id → budgets.is_test`, con `NOT EXISTS` y no `JOIN`
 * (un `JOIN` también se comería las obligaciones sin partida, que no son de prueba).
 */
export interface ObligacionesResumen extends BloqueUniverso {
  reales: { n: number; monto: number };
  prueba: { n: number; monto: number };
}

/**
 * Una etapa del ledger, con una columna por ejercicio.
 *
 * ⛔ `por_ejercicio` es una lista **a propósito**: sumar FY2026 y FY2027 fabrica un total que no
 * existe en ningún lado. Este dominio ya publicó $107,275,909.68 haciendo esa suma.
 */
export interface EtapaPorEjercicio {
  etapa: 'vigente' | 'reservado' | 'comprometido' | 'ejercido' | 'pagado' | 'disponible';
  por_ejercicio: Array<{ fiscal_year: number; monto: number | null }>;
  /** Quién mueve esta etapa en el negocio. Una etapa en cero sin dueño no se puede accionar. */
  quien_la_mueve: string;
}

/**
 * Lo que no se puede medir hoy, con nombre y peso. Nunca 0, nunca verde.
 *
 * ⛔ **El `peso` era un `string` literal y se pudrió antes de llegar a producción.** La primera
 * versión decía «26 familias»; medido el 2026-10-12, las familias de gasto —`account_code`— son
 * **14**, y el número venía de un artefacto ya publicado. ⭐ El 14 además **coincide exacto** con
 * el universo de concentración que el dominio ya publicaba («4 de 14 partidas llegan al 80 %»):
 * dos caminos independientes dan el mismo número, que es lo que lo vuelve creíble.
 *
 * ⇒ **Lo medible se mide.** `medido: false` queda sólo para lo que de verdad no tiene consulta
 * —el ticket por canal no existe en ninguna fuente— y entonces `como` dice por qué. Un literal
 * que nadie vuelve a medir es el mismo defecto que ya se corrigió en `cadencia`.
 */
export interface HuecoDeclarado {
  nombre: string;
  porque: string;
  peso: {
    /** `null` cuando no hay cifra: nunca 0, que se leería como «no falta nada». */
    valor: number | null;
    unidad: string;
    /** `true` = salió de una consulta en esta corrida. `false` = no hay con qué medirlo. */
    medido: boolean;
    /** De dónde salió, o por qué no se pudo. Obligatorio en los dos casos. */
    como: string;
  };
}

export interface PresupuestoDireccion {
  motor: MotorPresupuesto | null;
  motor_error: string | null;

  /**
   * ⭐ Lleva `BloqueUniverso` como los demás, y lo corrigió la revisión de frontend: era **el
   * único bloque sin universo pegado**, y la regla vale para los nueve o no vale.
   *
   * ⛔ Importa más acá que en otros: tres cifras del dominio caen dentro del **0.058 % entre
   * sí** — $74,811,634.04 (obligaciones reales), $74,806,967.37 (las del ejercicio de prueba) y
   * $74,850,066.62 (el vigente de FY2027). Sin el universo al lado, un lector supone que son la
   * misma con un error de dedo, y **las tres responden preguntas distintas**.
   */
  ejercicios: { universo: string; as_of: string; fuente: string; filas: EjercicioFila[] } | null;
  ejercicios_error: string | null;

  obligaciones: ObligacionesResumen | null;
  obligaciones_error: string | null;

  ledger: { universo: string; as_of: string; fuente: string; etapas: EtapaPorEjercicio[] } | null;
  ledger_error: string | null;

  huecos: HuecoDeclarado[];

  /** Cuándo se armó la RESPUESTA. No reemplaza al `as_of` de cada bloque. */
  as_of: string;
}
