/**
 * CG.19 Capa 4 — El casamiento del Cuadre de `/finanzas/caja`, en funciones PURAS (ADR-070).
 *
 * ── Por qué existe este archivo ──────────────────────────────────────────────────────────────
 *
 * La pestaña **Cuadre** enfrenta la caja operativa (el `.mdb` Control) contra la copia manual
 * del workbook y contra la tesorería de Kepler, **casando movimiento a movimiento por importe**.
 * Ese casamiento vivía como una función anónima dentro de `conciliacionDia()`, y tenía tres
 * defectos que no se ven mirando los números — sólo mirando la fórmula.
 *
 * **(1) ⛔ El resultado NO ERA REPRODUCIBLE.** El greedy consume del otro lado a medida que
 * recorre, así que **quién casa con quién depende del orden en que llegaron las filas** — y los
 * tres `SELECT` que lo alimentan no tenían `ORDER BY`. Postgres no promete orden sin él: cambia
 * con el plan, con las estadísticas, con el paralelismo. Dos cargas del mismo día podían publicar
 * **huérfanos distintos**, y por lo tanto un descuadre distinto, sin que cambiara un solo dato.
 *
 *   caja = [$100.00, $100.03] · otro = [$100.00] · tolerancia ±$5
 *     orden [A,B] → casa A, huérfano B ($100.03)
 *     orden [B,A] → casa B, huérfano A ($100.00)
 *
 *   No es un empate inocuo: **cambia el monto que la pantalla reporta como faltante.**
 *   Acá el orden se deriva de los datos (importe ↓, fecha, llave), nunca de cómo llegaron.
 *   La llave es única por lado, así que el orden es TOTAL: no hay empates que resolver al azar.
 *
 * **(2) Un casamiento por importe se publicaba como si fuera una identidad.** Ligar por
 * (importe, fecha) es un **atributo débil** — la regla M3 de esta fase existe porque ya se pagó:
 * un cruce por fecha+importe daba 32% de cobertura que al sumarle el beneficiario caía a 1%. Eran
 * coincidencias. Acá **no hay llave declarada** entre el Access y Kepler: son dos capturas
 * independientes del mismo efectivo. Mientras no la haya, lo honesto no es dejar de casar — es
 * **declarar cuándo el casamiento pudo haber sido otro**. Por eso cada par sale con
 * `candidatos` y `ambiguo`: un movimiento que casó teniendo 40 iguales enfrente **no puede
 * pintarse igual** que uno que casó porque era el único.
 *
 * **(3) La tolerancia volvía invisible su propio efecto.** `±$5` casa cosas que no son iguales.
 * Un par que difiere $4.99 se veía idéntico a uno que cuadró al centavo. Cada par declara ahora
 * su `delta` real, así que ampliar la tolerancia deja de ser una forma de bajar el descuadre sin
 * que se note.
 *
 * ⚠️ **Lo que este archivo NO arregla, a propósito:** que haga falta casar. Se concilia porque
 * dos sistemas capturaron el mismo efectivo por separado. El destino de CG.19 es que el valor se
 * **tome** de Kepler en vez de recapturarse — cuando eso pase, no hay nada que casar y este motor
 * se retira. Hasta entonces, que al menos conteste siempre lo mismo y diga qué tan seguro está.
 */

/** Un movimiento de cualquiera de las tres fuentes, reducido a lo que el casamiento necesita. */
export interface MovCuadre {
  /** Llave ÚNICA dentro de su lado. Es el desempate final que hace TOTAL al orden. */
  key: string;
  importe: number;
  /** `YYYY-MM-DD`. Desempata entre candidatos que empatan en importe. */
  fecha: string;
}

export interface ParCasado<T extends MovCuadre> {
  caja: T;
  otro: T;
  /** `caja.importe − otro.importe`. 0 = casó al peso; ≠0 = casó porque la tolerancia lo permitió. */
  delta: number;
  /** Cuántos candidatos había a la MISMA distancia de importe. 1 = casamiento forzado. */
  candidatos: number;
  /** `candidatos > 1`: pudo haber casado con otro. La pantalla tiene que poder decirlo. */
  ambiguo: boolean;
}

export interface ResultadoCuadre<T extends MovCuadre> {
  pares: ParCasado<T>[];
  caja_solos: T[];
  otro_solos: T[];
  caja_total: number;
  otro_total: number;
  delta: number;
  casados_n: number;
  casados_monto: number;
  caja_solos_monto: number;
  otro_solos_monto: number;
  /** Cuántos pares pudieron haber casado con otra cosa. Es la medida de cuánto NO se sabe. */
  ambiguos_n: number;
  /** Cuántos pares NO casaron al peso (los que existen sólo gracias a la tolerancia). */
  inexactos_n: number;
  /** La tolerancia con la que se produjo este resultado, para que viaje con él. */
  tolerancia: number;
}

export function redondea2(v: number): number {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

const centavos = (v: unknown): number => Math.round((Number(v) || 0) * 100);

/**
 * ORDEN CANÓNICO de un lado. Se deriva **de los datos**, nunca de cómo llegaron.
 *
 * Importe descendente a propósito: el dinero grande se casa primero y se queda con el candidato
 * más cercano. Es como concilia una persona, y hace que un centavo de diferencia en una fila
 * chica no pueda desviar un movimiento de $70,000.
 *
 * `key` al final es lo que vuelve TOTAL al orden: sin él, dos filas idénticas en importe y fecha
 * quedarían en orden indefinido y volvería el problema por la ventana.
 */
export function ordenCanonico<T extends MovCuadre>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      centavos(b.importe) - centavos(a.importe) ||
      String(a.fecha).localeCompare(String(b.fecha)) ||
      String(a.key).localeCompare(String(b.key)),
  );
}

/**
 * Casa dos lados por importe, dentro de `tolerancia` PESOS, de forma **determinista**.
 *
 * Gana el candidato de importe más cercano. Entre los que empatan en distancia, gana la fecha más
 * cercana, y si también empata, la llave menor — tres desempates declarados, ninguno accidental.
 *
 * ⚠️ El resultado depende de `tolerancia` y **eso es parte del resultado**: viaja en el objeto.
 * Ampliar la tolerancia siempre baja el descuadre reportado; sin publicarla, ese cambio parece
 * una mejora de la operación.
 */
export function casarPorImporte<T extends MovCuadre>(
  caja: T[],
  otro: T[],
  tolerancia: number,
): ResultadoCuadre<T> {
  const tol = Math.max(0, Math.round(Number(tolerancia) || 0) * 100); // en centavos
  const izq = ordenCanonico(caja);
  const der = ordenCanonico(otro);

  // Índice por importe exacto en centavos. Cada balde conserva el orden canónico.
  const porImporte = new Map<number, T[]>();
  for (const o of der) {
    const k = centavos(o.importe);
    const b = porImporte.get(k);
    if (b) b.push(o);
    else porImporte.set(k, [o]);
  }
  const usados = new Set<string>();

  const pares: ParCasado<T>[] = [];
  const cajaSolos: T[] = [];

  for (const c of izq) {
    const t = centavos(c.importe);
    let elegidos: T[] | null = null;

    // Barrido por distancia creciente: el más cercano en importe gana. A igual distancia se
    // juntan los dos lados (t−d y t+d) y se desempata abajo — NO se prefiere uno por accidente,
    // que es lo que hacía la versión anterior al revisar siempre `t−d` primero.
    for (let d = 0; d <= tol; d++) {
      const claves = d === 0 ? [t] : [t - d, t + d];
      const libres: T[] = [];
      for (const k of claves) {
        for (const cand of porImporte.get(k) ?? []) if (!usados.has(cand.key)) libres.push(cand);
      }
      if (libres.length) { elegidos = libres; break; }
    }

    if (!elegidos) { cajaSolos.push(c); continue; }

    const dias = (a: string, b: string) =>
      Math.abs((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 864e5);
    const ganador = [...elegidos].sort(
      (a, b) =>
        dias(a.fecha, c.fecha) - dias(b.fecha, c.fecha) ||
        String(a.key).localeCompare(String(b.key)),
    )[0];

    usados.add(ganador.key);
    pares.push({
      caja: c,
      otro: ganador,
      delta: redondea2(Number(c.importe) - Number(ganador.importe)),
      candidatos: elegidos.length,
      ambiguo: elegidos.length > 1,
    });
  }

  const otroSolos = der.filter((o) => !usados.has(o.key));
  const suma = (rows: { importe: number }[]) => redondea2(rows.reduce((s, r) => s + (Number(r.importe) || 0), 0));
  const cajaTotal = suma(izq);
  const otroTotal = suma(der);

  return {
    pares,
    caja_solos: cajaSolos,
    otro_solos: otroSolos,
    caja_total: cajaTotal,
    otro_total: otroTotal,
    delta: redondea2(cajaTotal - otroTotal),
    casados_n: pares.length,
    casados_monto: suma(pares.map((p) => p.caja)),
    caja_solos_monto: suma(cajaSolos),
    otro_solos_monto: suma(otroSolos),
    ambiguos_n: pares.filter((p) => p.ambiguo).length,
    inexactos_n: pares.filter((p) => p.delta !== 0).length,
    tolerancia: Math.round(Number(tolerancia) || 0),
  };
}

/**
 * Nombre de banco → clave canónica común a Caja / workbook / Kepler / ContPAQi.
 *
 * ⛔ **Estaba escrita DOS VECES en el mismo archivo y las dos copias NO eran iguales:** la del
 * método de clase no conocía `SCOTIABANK` ni `BANREGIO`, así que una pestaña agrupaba esos dos
 * bancos por su primera palabra y la otra por su clave — el mismo banco, dos filas distintas
 * según por dónde entraras. Un primitivo duplicado que divergió es el caso exacto de ADR-056.
 * Acá vive UNA sola vez, con la unión de lo que sabían las dos.
 *
 * ⚠️ El `else` devuelve la primera palabra: es una heurística, no un catálogo. Un banco que no
 * esté en la lista se agrupa por texto y puede partirse en dos. No se disfraza de exhaustivo.
 */
export function canonBank(s: string): string {
  const u = String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (/BAJIO|BBAJIO/.test(u)) return 'BAJIO';
  if (/BBVA|BANCOMER/.test(u)) return 'BBVA';
  if (/BANORTE/.test(u)) return 'BANORTE';
  if (/SANTANDER/.test(u)) return 'SANTANDER';
  if (/BANAMEX|CITI/.test(u)) return 'BANAMEX';
  if (/AZTECA/.test(u)) return 'AZTECA';
  if (/INBURSA/.test(u)) return 'INBURSA';
  if (/HSBC/.test(u)) return 'HSBC';
  if (/SCOTIA/.test(u)) return 'SCOTIABANK';
  if (/BANREGIO|REGIO/.test(u)) return 'BANREGIO';
  if (/CAJA/.test(u)) return 'CAJA';
  return u.replace(/\s+/g, ' ').trim().split(' ')[0] || 'OTRO';
}

/**
 * Escapa los comodines de `LIKE`/`ILIKE` en texto que tecleó una persona.
 *
 * Sin esto, buscar `%` trae TODO y buscar `_` trae cualquier carácter: el usuario cree que filtró
 * y está viendo el universo completo. No es una inyección (el valor va parametrizado), es una
 * mentira silenciosa en pantalla.
 */
export function escapaLike(s: string): string {
  return String(s ?? '').replace(/[\\%_]/g, (c) => `\\${c}`);
}
