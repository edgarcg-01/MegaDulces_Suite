import { PresupuestoDireccionService } from './presupuesto-direccion.service';

/**
 * `[TES.21]` **El candado que EJECUTA — y por qué el anterior no servía.**
 *
 * ── ⛔ EL DEFECTO DE MÉTODO QUE ESTO VIENE A ARREGLAR ────────────────────────
 *
 * `presupuesto-direccion.contrato.spec.ts` tiene 13 aserciones y **ninguna invoca el servicio**:
 * son `readFileSync` + `toContain` sobre el texto del fuente. La revisión de otro carril le hizo
 * dos mutaciones y las dos quedaron **verdes**:
 *
 *     M1  quitarle el filtro `is_test` a `n_real`        -> 13 passed
 *     M2  intercambiar `reales` y `prueba` ($74.8M)      -> 13 passed
 *
 * ⭐⭐ **Y la lección es más fina que «faltaban pruebas».** Mis propias mutaciones SÍ daban rojo —
 * pero yo muté **reintroduciendo la cadena prohibida** `budget_line_id is null`, y una aserción
 * de texto la atrapa por construcción. El otro carril mutó **quitando la llamada al helper en
 * uno de los cuatro sitios**, y el texto no lo ve: la cadena sigue apareciendo en los otros tres.
 *
 * ⇒ **Una mutación elegida porque coincide con la aserción prueba que la aserción existe, no que
 * el defecto se atrape.** Es la trampa más fina de esta fase, y la cometí yo.
 *
 * ── ⚠️ LO QUE UN DOBLE PUEDE Y NO PUEDE PROBAR, DICHO ANTES ────────────────
 *
 * `obligaciones` parte sus dos universos **en SQL** (`count(*) filter (where …)`), y **un doble
 * de knex no ejecuta SQL**: no puede demostrar que 156+156 no colapsan en 312. Eso se verifica
 * **ejerciendo la consulta contra prod**, que es otra clase de evidencia y ya está hecha.
 *
 * Lo que esta suite sí prueba, ejecutando: que el servicio **no intercambia, no suma y no
 * inventa** en el camino de la fila a la respuesta, que un bloque caído llega `null` **con
 * motivo** y no en ceros, y que las reglas puras —cadencia, días sin firmar, disponible—
 * hacen lo que dicen.
 */

interface Doble { fila: Record<string, unknown>; fallan?: Set<string>; crudos?: string[] }

/** Doble de `trx`: devuelve filas por tabla y puede hacer FALLAR un bloque a propósito. */
function hacerTrx(d: Doble) {
  const chain = (tabla: string): Record<string, unknown> => {
    if (d.fallan?.has(tabla)) throw new Error(`fuente apagada a propósito: ${tabla}`);
    const c: Record<string, unknown> = {};
    const self = () => c;
    for (const m of ['where', 'andWhere', 'select', 'groupBy', 'orderBy', 'limit', 'join', 'leftJoin', 'count']) {
      c[m] = m === 'count'
        ? async () => [{ n: 0 }]
        : self;
    }
    c.first = async () => d.fila[tabla] ?? {};
    c.then = undefined;
    // `select(...)` del ledger y de ejercicios se consume como promesa de arreglo.
    (c as { select: unknown }).select = (...args: unknown[]) => {
      void args;
      const arr = (d.fila[`${tabla}:filas`] as unknown[]) ?? [];
      const p = Promise.resolve(arr) as unknown as Record<string, unknown>;
      p.orderBy = () => Promise.resolve(arr);
      p.leftJoin = () => Promise.resolve((d.fila[`${tabla}:conteos`] as unknown[]) ?? []);
      p.first = async () => d.fila[tabla] ?? {};
      return p;
    };
    return c;
  };
  const trx = (tabla: string) => chain(tabla);
  (trx as unknown as { raw: (s: string) => PromiseLike<unknown> }).raw = (s: string) => {
    // ⭐ Se capturan los fragmentos que el servicio CONSTRUYE DE VERDAD en esta corrida.
    // Es lo que distingue esto de grepear el archivo: el grep dice «la cadena aparece en algún
    // lado»; esto dice «el fragmento que ESTA consulta armó la lleva». Atrapa la mutación de
    // quitar el filtro en UNO de los cuatro sitios, que al texto se le escapa porque la cadena
    // sigue estando en los otros tres.
    d.crudos?.push(s);
    // Como en Knex: `raw` arma un fragmento y sólo se EJECUTA si se espera. Con `async` cada
    // fragmento metido en un `select(...)` nacía como promesa rechazada que nadie esperaba
    // (14 «Unhandled Rejection» en CI con `fallan: raw`). El error sale al esperarla, no antes.
    return {
      then: (ok?: (v: unknown) => unknown, mal?: (e: unknown) => unknown) =>
        (d.fallan?.has('raw')
          ? Promise.reject(new Error('raw apagado a propósito'))
          : Promise.resolve({ rows: [{ n: s.includes('account_code') ? 14 : 0 }] })).then(ok, mal),
    };
  };
  return trx;
}

function hacerServicio(d: Doble): PresupuestoDireccionService {
  const tk = { run: (cb: (trx: unknown) => Promise<unknown>) => cb(hacerTrx(d)) };
  const tenantCtx = { requireTenantId: () => 'T-1' };
  return new PresupuestoDireccionService(tk as never, tenantCtx as never);
}

const SIN_DATOS: Doble['fila'] = {
  'budget.generation_runs': { corridas: 0, ok: 0, err: 0, ultima_ok: null, ultima_error: null },
  'budget.generation_runs:filas': [],
  'budget.budgets': {},
  'budget.budgets:filas': [],
  'budget.expense_obligations': { n_real: 156, m_real: 74811634.04, n_prueba: 156, m_prueba: 74806967.37 },
  'budget.budget_lines as l': {},
  'budget.budget_lines as l:filas': [],
  'budget.budget_lines as l:conteos': [],
};

describe('[TES.21] el servicio de la vista Dirección, EJECUTADO', () => {
  it('⛔ M2 — `reales` y `prueba` NO se intercambian en el camino', async () => {
    const r = await hacerServicio({ fila: { ...SIN_DATOS } }).direccion();
    expect(r.obligaciones).not.toBeNull();
    // Los dos universos son casi iguales ($4,666.67 de diferencia sobre $74.8M):
    // intercambiarlos NO se ve en pantalla, y por eso hay que atraparlo acá.
    expect(r.obligaciones!.reales.monto).toBe(74811634.04);
    expect(r.obligaciones!.prueba.monto).toBe(74806967.37);
    expect(r.obligaciones!.reales.n).toBe(156);
    expect(r.obligaciones!.prueba.n).toBe(156);
  });

  it('⛔ M1 — LOS CUATRO agregados de obligaciones llevan el filtro, no tres de cuatro', async () => {
    const crudos: string[] = [];
    await hacerServicio({ fila: { ...SIN_DATOS }, crudos }).direccion();

    const deObligaciones = crudos.filter((s) => /n_real|m_real|n_prueba|m_prueba/.test(s));
    expect(deObligaciones).toHaveLength(4);
    // Cada uno por separado: quitar el filtro de UNO solo deja a los otros tres intactos,
    // y por eso una regla sobre el texto del archivo no lo ve.
    for (const frag of deObligaciones) {
      expect(frag).toContain('NOT EXISTS');
      expect(frag).toContain('is_test');
    }
  });

  it('⛔ los conteos por ejercicio piden `count(distinct`, no `count(*)`', async () => {
    const crudos: string[] = [];
    await hacerServicio({ fila: { ...SIN_DATOS }, crudos }).direccion();

    const deConteos = crudos.filter((s) => /as renglones|as obligaciones/.test(s));
    expect(deConteos).toHaveLength(2);
    // Con `count(*)` el LEFT JOIN multiplica cada renglón por sus obligaciones: ejercido contra
    // prod daba 190 donde son 47, y 190 es lo bastante verosímil como para pasar sin mirarse.
    for (const frag of deConteos) expect(frag).toContain('count(distinct');
  });

  it('⭐ un ejercicio sin renglones trae 0, no `undefined` — no aparece en el agrupado', async () => {
    const r = await hacerServicio({
      fila: {
        ...SIN_DATOS,
        'budget.budgets:filas': [{ id: 'b-sin-lineas', folio: 'X', fiscal_year: 2028, status: 'borrador', is_test: false, created_at: new Date().toISOString() }],
      },
    }).direccion();
    const fila = r.ejercicios!.filas[0];
    expect(fila.renglones).toBe(0);
    expect(fila.obligaciones).toBe(0);
    expect(fila.renglones).not.toBeUndefined();
  });

  it('⛔ no existe NINGÚN campo del payload que valga la suma de los dos universos', async () => {
    const r = await hacerServicio({ fila: { ...SIN_DATOS } }).direccion();
    const suma = 74811634.04 + 74806967.37;
    const plano = JSON.stringify(r);
    expect(plano).not.toContain(String(suma));
    expect(plano).not.toContain('149618601.41');
  });

  it('⭐ PRUEBA NEGATIVA REAL — con la fuente apagada, el bloque llega null CON MOTIVO, no en ceros', async () => {
    const r = await hacerServicio({
      fila: { ...SIN_DATOS }, fallan: new Set(['budget.expense_obligations']),
    }).direccion();
    expect(r.obligaciones).toBeNull();
    expect(r.obligaciones_error).toContain('apagada a propósito');
    // ⛔ Lo que NUNCA puede pasar: ceros. Un cero es una afirmación.
    expect(r.obligaciones).not.toEqual({ reales: { n: 0, monto: 0 }, prueba: { n: 0, monto: 0 } });
  });

  it('⭐ un bloque caído NO se lleva a los demás', async () => {
    const r = await hacerServicio({
      fila: { ...SIN_DATOS }, fallan: new Set(['budget.generation_runs']),
    }).direccion();
    expect(r.motor).toBeNull();
    expect(r.motor_error).toBeTruthy();
    expect(r.obligaciones).not.toBeNull();   // el de al lado sigue
    expect(r.as_of).toBeTruthy();
  });

  it('⭐ el ledger NO suma ejercicios: una columna por cada uno, y `disponible` se deriva', async () => {
    const filas = [
      { fiscal_year: 2026, vigente: 32425843.06, reservado: 0, comprometido: 0, ejercido: 0, pagado: 0 },
      { fiscal_year: 2027, vigente: 74850066.62, reservado: 0, comprometido: 0, ejercido: 0, pagado: 0 },
    ];
    const r = await hacerServicio({
      fila: { ...SIN_DATOS, 'budget.budget_lines as l:filas': filas },
    }).direccion();

    const vigente = r.ledger!.etapas.find((e) => e.etapa === 'vigente')!;
    expect(vigente.por_ejercicio).toHaveLength(2);
    expect(vigente.por_ejercicio.map((x) => x.monto)).toEqual([32425843.06, 74850066.62]);
    // ⛔ El total de los dos ($107,275,909.68) ya se publicó una vez. No puede aparecer.
    expect(JSON.stringify(r.ledger)).not.toContain('107275909.68');

    const disp = r.ledger!.etapas.find((e) => e.etapa === 'disponible')!;
    expect(disp.por_ejercicio.map((x) => x.monto)).toEqual([32425843.06, 74850066.62]);
  });

  it('⭐ el peso de un hueco se MIDE: las familias salen de la consulta, no de un literal', async () => {
    const r = await hacerServicio({ fila: { ...SIN_DATOS } }).direccion();
    const fam = r.huecos.find((h) => h.nombre.includes('familia'))!;
    expect(fam.peso.valor).toBe(14);      // lo que devuelve el doble, no un 26 escrito
    expect(fam.peso.medido).toBe(true);
    expect(fam.peso.como).toContain('account_code');
  });

  it('⭐ y el hueco SIN consulta viaja con `medido:false` y `valor:null`, nunca 0', async () => {
    const r = await hacerServicio({ fila: { ...SIN_DATOS } }).direccion();
    const ticket = r.huecos.find((h) => h.nombre.includes('Ticket'))!;
    expect(ticket.peso.medido).toBe(false);
    expect(ticket.peso.valor).toBeNull();
    expect(ticket.peso.como.length).toBeGreaterThan(10);
  });

  it('⭐ si la consulta del hueco falla, llega `medido:false` — no un cero inventado', async () => {
    const r = await hacerServicio({ fila: { ...SIN_DATOS }, fallan: new Set(['raw']) }).direccion();
    const fam = r.huecos.find((h) => h.nombre.includes('familia'))!;
    expect(fam.peso.valor).toBeNull();
    expect(fam.peso.medido).toBe(false);
    expect(fam.peso.como).toContain('no se pudo medir');
  });
});
