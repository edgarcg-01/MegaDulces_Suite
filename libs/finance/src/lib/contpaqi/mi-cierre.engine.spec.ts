import {
  armarBandeja, estadoDeFila, conteoVacio, FAMILIAS, ORDEN_ESTADO_BANDEJA,
  type FilaCapturaCruda, type EntregaCruda, type DefinicionFamilia,
} from './mi-cierre.engine';

/**
 * `[CPA.10]` Candado de la REGLA de la bandeja. Puro: sin base, sin Nest, sin jsdom.
 *
 * No prueba "¿corre?" sino las cinco formas en que esta bandeja puede **mentir sin dejar de
 * verse plausible**:
 *
 *  1. ⛔ que `verificada = null` se lea como aplicada (convierte "no sé" en "listo");
 *  2. ⛔ que `verificada = false` se confunda con `null` (son dos fallas distintas);
 *  3. ⛔ que una familia con fuente pero SIN diccionario salga `lista` (verde prematuro);
 *  4. ⛔ que la cobertura de un mes vacío salga `0 %` o `100 %` en vez de `null`;
 *  5. ⛔ que los `numeric` de Postgres lleguen como texto y `+` los concatene.
 *
 * Los números son los REALES de prod, medidos el 2026-10-12.
 */

/** Renglones/mes medidos en prod (jul–sep 2026). No inventados. */
const MEDIDO: Record<string, number> = {
  cobranza_sucursal: 3477,
  pago_gasto: 2722,
  venta_diaria: 2653,
  comisiones_bancarias: 1532,
  nomina: 706,
  venta_telemarketing: 408,
  libro_compras: 407,
  traspasos: 371,
  otros: 44,
  gastos_varios: 37,
};

/** El mes completo tal como lo publica la vista: **todas** las familias, con los valores reales. */
function mesReal(anio_mes = '2026-09', en_curso = false): FilaCapturaCruda[] {
  return FAMILIAS.map((f, i) => ({
    anio_mes,
    familia: f.familia,
    orden: i + 1,
    polizas: 10,
    renglones: MEDIDO[f.familia] ?? 0,
    cargos: 1000,
    en_curso,
  }));
}

const DEF_LISTA: DefinicionFamilia = FAMILIAS.find((f) => f.familia === 'libro_compras')!;
const DEF_CON_MAPA_FALTANTE: DefinicionFamilia = FAMILIAS.find((f) => f.familia === 'pago_gasto')!;
const DEF_NO_AUTO: DefinicionFamilia = FAMILIAS.find((f) => f.familia === 'nomina')!;

function entrega(over: Partial<EntregaCruda> = {}): EntregaCruda {
  return {
    periodo: '2026-09',
    evento_tipo: 'libro_compras',
    estado: 'aplicada',
    verificada: true,
    total: 1000,
    motivo: null,
    actualizada_en: '2026-10-01T14:22:00Z',
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('[CPA.10] ⛔ `verificada` es TERNARIA: null no es false y ninguno es true', () => {
  it('aplicada CON bitácora es la única que llega a `aplicada`', () => {
    const r = estadoDeFila(DEF_LISTA, entrega({ verificada: true }));
    expect(r.estado).toBe('aplicada');
    expect(r.motivo).toBeNull();
  });

  it('⛔ aplicada con `verificada = null` NO es aplicada: nadie comprobó', () => {
    const r = estadoDeFila(DEF_LISTA, entrega({ verificada: null }));
    expect(r.estado).toBe('aplicada_sin_verificar');
    expect(r.motivo).toContain('nadie comprobó');
    // La prueba negativa: si el engine colapsara `null` en `true`, esto sería 'aplicada'.
    expect(r.estado).not.toBe('aplicada');
  });

  it('⛔ `verificada = false` es OTRA cosa que `null`, y lo dice distinto', () => {
    const conFalse = estadoDeFila(DEF_LISTA, entrega({ verificada: false }));
    const conNull = estadoDeFila(DEF_LISTA, entrega({ verificada: null }));
    expect(conFalse.estado).toBe('aplicada_sin_verificar');
    expect(conNull.estado).toBe('aplicada_sin_verificar');
    // Mismo estado, motivos DISTINTOS: uno se comprobó y no cuadró, al otro nadie lo miró.
    expect(conFalse.motivo).toContain('NO coincidió');
    expect(conNull.motivo).toContain('sin la bitácora');
    expect(conFalse.motivo).not.toBe(conNull.motivo);
  });

  it('la bandeja publica `verificada` tal cual, sin colapsarla', () => {
    const b = armarBandeja(mesReal(), [entrega({ verificada: null })])!;
    const fila = b.filas.find((f) => f.familia === 'libro_compras')!;
    expect(fila.verificada).toBeNull();
    expect(fila.verificada).not.toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('[CPA.10] ⛔ fuente sin diccionario NO es verde', () => {
  it('una familia automatizable a la que le falta el mapa sale `falta_mapa`, no `lista`', () => {
    const r = estadoDeFila(DEF_CON_MAPA_FALTANTE, undefined);
    expect(r.estado).toBe('falta_mapa');
    expect(r.estado).not.toBe('lista');
    expect(r.dueno).toBe('sistemas');
    expect(r.motivo).toContain('contpaqi.account_rules');
  });

  it('una familia automatizable SIN requisitos pendientes sí sale `lista`', () => {
    expect(DEF_LISTA.requiere.length).toBe(0);
    expect(estadoDeFila(DEF_LISTA, undefined).estado).toBe('lista');
  });

  it('la que no tiene fuente se DECLARA con motivo y con dueño, no se esconde', () => {
    const r = estadoDeFila(DEF_NO_AUTO, undefined);
    expect(r.estado).toBe('no_automatizable');
    expect(r.dueno).toBe('Fase RH');
    expect(r.motivo).toContain('Mega Talento');
  });

  it('⛔ toda familia no automatizable tiene motivo Y dueño — una deuda sin dueño no se paga', () => {
    for (const f of FAMILIAS.filter((x) => !x.automatizable)) {
      expect(f.no_automatizable, f.familia).toBeDefined();
      expect(f.no_automatizable!.motivo.length, f.familia).toBeGreaterThan(10);
      expect(f.no_automatizable!.dueno.length, f.familia).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('[CPA.10] la entrega manda sobre el catálogo', () => {
  it('una familia que normalmente sale `falta_mapa` se pinta por su entrega si la hay', () => {
    const r = estadoDeFila(DEF_CON_MAPA_FALTANTE, entrega({ evento_tipo: 'egreso', estado: 'entregada' }));
    expect(r.estado).toBe('entregada');
  });

  it('una rechazada sin motivo guardado igual explica algo, no deja el hueco', () => {
    const r = estadoDeFila(DEF_LISTA, entrega({ estado: 'rechazada', motivo: null }));
    expect(r.estado).toBe('rechazada');
    expect(r.motivo).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('[CPA.10] la cobertura del mes', () => {
  it('reproduce el 93.6 % medido en prod', () => {
    const b = armarBandeja(mesReal(), [])!;
    expect(b.total_renglones).toBe(12357);
    // 12,357 − nomina 706 − otros 44 − gastos_varios 37 = 11,570
    expect(b.automatizables).toBe(11570);
    expect(b.cobertura_pct).toBe(93.6);
  });

  it('⛔ un mes SIN renglones declara `null`, no 0 % ni 100 %', () => {
    const vacio = mesReal().map((f) => ({ ...f, renglones: 0 }));
    const b = armarBandeja(vacio, [])!;
    expect(b.total_renglones).toBe(0);
    expect(b.cobertura_pct).toBeNull();
    expect(b.cobertura_pct).not.toBe(0);
    expect(b.cobertura_pct).not.toBe(100);
  });

  it('un mes sin ninguna fila devuelve null — no una bandeja vacía que parece sana', () => {
    expect(armarBandeja([], [])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('[CPA.10] los números llegan como TEXTO desde Postgres', () => {
  it('⛔ suma, no concatena', () => {
    const comoTexto: FilaCapturaCruda[] = mesReal().map((f) => ({
      ...f,
      renglones: String(f.renglones),
      cargos: String(f.cargos),
      polizas: String(f.polizas),
      orden: String(f.orden),
    }));
    const b = armarBandeja(comoTexto, [])!;
    expect(b.total_renglones).toBe(12357);
    expect(typeof b.total_renglones).toBe('number');
    // Si concatenara, esto sería una cadena larguísima y no 12357.
    expect(String(b.total_renglones).length).toBeLessThan(8);
  });

  it('un `numeric` basura no rompe la suma: cuenta 0 y no NaN', () => {
    const sucio = mesReal().map((f, i) => (i === 0 ? { ...f, renglones: 'x' } : f));
    const b = armarBandeja(sucio, [])!;
    expect(Number.isFinite(b.total_renglones)).toBe(true);
    expect(b.total_renglones).toBe(12357 - MEDIDO['cobranza_sucursal']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('[CPA.10] el orden de atención', () => {
  it('⛔ lo que nadie comprobó va ARRIBA de lo comprobado, no escondido entre ello', () => {
    const iSinVerificar = ORDEN_ESTADO_BANDEJA.indexOf('aplicada_sin_verificar');
    const iAplicada = ORDEN_ESTADO_BANDEJA.indexOf('aplicada');
    expect(iSinVerificar).toBeLessThan(iAplicada);
  });

  it('lo rechazado es lo primero que se ve', () => {
    expect(ORDEN_ESTADO_BANDEJA[0]).toBe('rechazada');
  });

  it('dentro del mismo estado, primero la que más tecleo ahorra', () => {
    const b = armarBandeja(mesReal(), [])!;
    const faltaMapa = b.filas.filter((f) => f.estado === 'falta_mapa');
    expect(faltaMapa.length).toBeGreaterThan(1);
    for (let i = 1; i < faltaMapa.length; i++) {
      expect(faltaMapa[i - 1].renglones).toBeGreaterThanOrEqual(faltaMapa[i].renglones);
    }
  });

  it('el conteo arranca en cero para TODOS los estados: ausente es 0, no undefined', () => {
    const c = conteoVacio();
    for (const e of ORDEN_ESTADO_BANDEJA) expect(c[e]).toBe(0);
    const b = armarBandeja(mesReal(), [])!;
    for (const e of ORDEN_ESTADO_BANDEJA) expect(typeof b.conteo[e]).toBe('number');
    expect(Object.values(b.conteo).reduce((a, n) => a + n, 0)).toBe(FAMILIAS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('[CPA.10] el registro de familias es coherente', () => {
  it('⛔ ninguna familia automatizable se queda sin fuente declarada', () => {
    for (const f of FAMILIAS.filter((x) => x.automatizable)) {
      expect(f.fuente, f.familia).toBeTruthy();
    }
  });

  it('⛔ ninguna NO automatizable finge tener fuente', () => {
    for (const f of FAMILIAS.filter((x) => !x.automatizable)) {
      expect(f.fuente, f.familia).toBeNull();
      expect(f.requiere.length, f.familia).toBe(0);
    }
  });

  it('los `evento_tipo` son únicos: dos familias con el mismo se pisarían la entrega', () => {
    const tipos = FAMILIAS.map((f) => f.evento_tipo);
    expect(new Set(tipos).size).toBe(tipos.length);
  });

  it('una familia que la vista publique y el registro no conozca cae en `otros`, no se pierde', () => {
    const conIntrusa: FilaCapturaCruda[] = [
      ...mesReal(),
      { anio_mes: '2026-09', familia: 'familia_que_no_existe', orden: 99, polizas: 1, renglones: 500, cargos: 0, en_curso: false },
    ];
    const b = armarBandeja(conIntrusa, [])!;
    expect(b.filas.length).toBe(FAMILIAS.length + 1);
    expect(b.total_renglones).toBe(12357 + 500);
    const intrusa = b.filas.find((f) => f.familia === 'familia_que_no_existe')!;
    expect(intrusa.estado).toBe('no_automatizable');
    // Y NO infla la cobertura: lo desconocido no se cuenta como automatizable.
    expect(b.automatizables).toBe(11570);
  });
});
