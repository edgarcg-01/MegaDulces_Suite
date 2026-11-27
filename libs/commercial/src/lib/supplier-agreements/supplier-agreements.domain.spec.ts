// Sin `import ... from 'vitest'`: la config usa `globals: true` (con el import el spec no carga: compuerta spec-vivo).
import {
  ACCIONES_ACUERDO, ESTADOS_ACUERDO, ETIQUETA_SITUACION_ACUERDO, MAX_CONTACTO_PROVEEDOR, MAX_DESCRIPCION_ACUERDO,
  MAX_NOTA_CIERRE_ACUERDO, SITUACIONES_ACUERDO, type CapturarAcuerdoDto,
} from '@megadulces/contracts';
import {
  acciones, AcuerdosError, estadoTras, exigir, ordenar, porQueNo, porQueNoRecibe, situacion, validarAcuerdo, validarNota,
  type ReunionDelAcuerdo,
} from './supplier-agreements.domain';

/** `[PQ.3.10]` Acuerdos · C1: el dominio del acuerdo con el proveedor, sin base. La base se prueba aparte (Postgres real). */

const HOY = '2026-11-26';
const ANA = '11111111-1111-4111-8111-111111111111'; // organiza la reunión
const LUIS = '22222222-2222-4222-8222-222222222222'; // agenda Citas
const PEPE = '33333333-3333-4333-8333-333333333333'; // NO agenda Citas
const RESPONSABLES: ReadonlySet<string> = new Set([ANA, LUIS]);

const realizada: ReunionDelAcuerdo = { status: 'held', fecha: '2026-11-24', organizer_user_id: ANA };

const dto = (o: Partial<CapturarAcuerdoDto> = {}): CapturarAcuerdoDto => ({
  area: 'compras', description: '  Mandar el pedido de diciembre con el precio nuevo  ', due_date: '2026-12-05', assigned_to: LUIS, ...o,
});

/** El mensaje con que se rechaza, o `'ok'`. */
const motivo = (f: () => unknown): string => {
  try { f(); return 'ok'; } catch (e) { return e instanceof AcuerdosError ? `${e.tipo}: ${e.message}` : `OTRO: ${String(e)}`; }
};

describe('[PQ.3.10] la reunión de la que sale el acuerdo (DC45)', () => {
  it('sólo una reunión REALIZADA recibe acuerdos', () => {
    expect(porQueNoRecibe({ status: 'held' })).toBeNull();
    expect(porQueNoRecibe({ status: 'scheduled' })).toMatch(/realizada/);
    expect(porQueNoRecibe({ status: 'to_confirm' })).toMatch(/realizada/);
    expect(porQueNoRecibe({ status: 'cancelled' })).toMatch(/cancelada/);
  });

  it('NEGATIVA: capturar en una reunión agendada o cancelada es conflicto, aunque el acuerdo venga completo', () => {
    expect(motivo(() => validarAcuerdo(dto(), { ...realizada, status: 'scheduled' }, RESPONSABLES))).toMatch(/^conflicto: .*minuta/);
    expect(motivo(() => validarAcuerdo(dto(), { ...realizada, status: 'cancelled' }, RESPONSABLES))).toMatch(/^conflicto: .*cancelada/);
    // Control: la misma captura en la reunión realizada entra.
    expect(motivo(() => validarAcuerdo(dto(), realizada, RESPONSABLES))).toBe('ok');
  });
});

describe('[PQ.3.10] validarAcuerdo — de un área de Mega Dulces', () => {
  it('sale normalizado: el texto sin espacios de más, el responsable en minúsculas', () => {
    const a = validarAcuerdo(dto({ assigned_to: LUIS.toUpperCase() }), realizada, RESPONSABLES);
    expect(a).toEqual({ area: 'compras', description: 'Mandar el pedido de diciembre con el precio nuevo', supplier_contact: null, assigned_to: LUIS, due_date: '2026-12-05' });
  });

  it('NEGATIVAS: área, qué se acordó, responsable', () => {
    expect(motivo(() => validarAcuerdo(dto({ area: 'sistemas' as never }), realizada, RESPONSABLES))).toMatch(/^invalido: Elige el área/);
    expect(motivo(() => validarAcuerdo(dto({ description: '   ' }), realizada, RESPONSABLES))).toMatch(/^invalido: Escribe qué se acordó/);
    expect(motivo(() => validarAcuerdo(dto({ description: 'x'.repeat(MAX_DESCRIPCION_ACUERDO + 1) }), realizada, RESPONSABLES))).toMatch(/máximo 500/);
    expect(motivo(() => validarAcuerdo(dto({ description: 'x'.repeat(MAX_DESCRIPCION_ACUERDO) }), realizada, RESPONSABLES))).toBe('ok');
    expect(motivo(() => validarAcuerdo(dto({ assigned_to: null }), realizada, RESPONSABLES))).toMatch(/Elige quién de Mega Dulces/);
    expect(motivo(() => validarAcuerdo(dto({ assigned_to: 'fulano' }), realizada, RESPONSABLES))).toMatch(/Elige quién de Mega Dulces/);
  });

  it('NEGATIVA: un responsable que no puede ver Citas (DC44); control: uno que sí', () => {
    expect(motivo(() => validarAcuerdo(dto({ assigned_to: PEPE }), realizada, RESPONSABLES))).toMatch(/tiene que agendar Citas: cada responsable cierra el suyo/);
    expect(motivo(() => validarAcuerdo(dto({ assigned_to: ANA }), realizada, RESPONSABLES))).toBe('ok');
  });

  it('NEGATIVA: un área de Mega Dulces con nombre de persona del proveedor', () => {
    expect(motivo(() => validarAcuerdo(dto({ supplier_contact: 'Ejecutivo' }), realizada, RESPONSABLES))).toMatch(/Sólo el acuerdo del proveedor/);
    expect(motivo(() => validarAcuerdo(dto({ supplier_contact: '   ' }), realizada, RESPONSABLES))).toBe('ok');
  });
});

describe('[PQ.3.10] validarAcuerdo — del proveedor (DC43)', () => {
  const prov = (o: Partial<CapturarAcuerdoDto> = {}) => dto({ area: 'supplier', assigned_to: null, supplier_contact: ' Ejecutivo de cuenta ', ...o });

  it('el responsable en la Suite es quien organizó la reunión, sin que la pantalla lo mande', () => {
    const a = validarAcuerdo(prov(), realizada, RESPONSABLES);
    expect(a.assigned_to).toBe(ANA);
    expect(a.supplier_contact).toBe('Ejecutivo de cuenta');
    // Mandar al organizador (en cualquier caja) también vale.
    expect(validarAcuerdo(prov({ assigned_to: ANA.toUpperCase() }), realizada, RESPONSABLES).assigned_to).toBe(ANA);
  });

  it('el organizador es el responsable aunque no esté en la lista de responsables (organizó la reunión)', () => {
    expect(validarAcuerdo(prov(), { ...realizada, organizer_user_id: PEPE }, RESPONSABLES).assigned_to).toBe(PEPE);
  });

  it('NEGATIVA: asignárselo a otra persona no se acepta en silencio', () => {
    expect(motivo(() => validarAcuerdo(prov({ assigned_to: LUIS }), realizada, RESPONSABLES))).toMatch(/lo sigue quien organizó la reunión/);
  });

  it('NEGATIVAS: sin el nombre de la persona del proveedor, o demasiado largo', () => {
    expect(motivo(() => validarAcuerdo(prov({ supplier_contact: null }), realizada, RESPONSABLES))).toMatch(/nombre de la persona del proveedor/);
    expect(motivo(() => validarAcuerdo(prov({ supplier_contact: '  ' }), realizada, RESPONSABLES))).toMatch(/nombre de la persona del proveedor/);
    expect(motivo(() => validarAcuerdo(prov({ supplier_contact: 'x'.repeat(MAX_CONTACTO_PROVEEDOR + 1) }), realizada, RESPONSABLES))).toMatch(/máximo 120/);
    expect(motivo(() => validarAcuerdo(prov({ supplier_contact: 'x'.repeat(MAX_CONTACTO_PROVEEDOR) }), realizada, RESPONSABLES))).toBe('ok');
  });
});

describe('[PQ.3.10] la fecha compromiso', () => {
  it('desde el día de la reunión (incluido) y hasta dos años después', () => {
    expect(motivo(() => validarAcuerdo(dto({ due_date: '2026-11-24' }), realizada, RESPONSABLES))).toBe('ok');
    expect(motivo(() => validarAcuerdo(dto({ due_date: '2026-11-23' }), realizada, RESPONSABLES))).toMatch(/antes de la reunión/);
    expect(motivo(() => validarAcuerdo(dto({ due_date: '2028-11-23' }), realizada, RESPONSABLES))).toBe('ok');
    expect(motivo(() => validarAcuerdo(dto({ due_date: '2028-11-24' }), realizada, RESPONSABLES))).toMatch(/más de dos años/);
  });

  it('NEGATIVAS: fechas que no existen o mal escritas', () => {
    for (const f of ['2026-02-30', '26-12-05', '2026/12/05', '', null]) {
      expect(motivo(() => validarAcuerdo(dto({ due_date: f as string }), realizada, RESPONSABLES))).toMatch(/no es válida/);
    }
  });
});

describe('[PQ.3.10] cerrar con nota', () => {
  it('la nota es obligatoria y tiene tope', () => {
    expect(validarNota({ note: '  Pedido enviado  ' })).toBe('Pedido enviado');
    expect(motivo(() => validarNota({ note: '  ' }))).toMatch(/nota de cierre/);
    expect(motivo(() => validarNota(null))).toMatch(/nota de cierre/);
    expect(motivo(() => validarNota({ note: 'x'.repeat(MAX_NOTA_CIERRE_ACUERDO + 1) }))).toMatch(/máximo 500/);
  });
});

describe('[PQ.3.10] acciones por estado', () => {
  it('pendiente: todo; en curso: todo menos iniciar; cerrado: nada', () => {
    expect(acciones('pending')).toEqual(['iniciar', 'cumplir', 'cancelar', 'editar']);
    expect(acciones('in_progress')).toEqual(['cumplir', 'cancelar', 'editar']);
    expect(acciones('done')).toEqual([]);
    expect(acciones('cancelled')).toEqual([]);
  });

  it('NEGATIVA: un cerrado no se reabre ni se edita (conflicto con su motivo)', () => {
    expect(motivo(() => exigir('editar', 'done'))).toMatch(/^conflicto: El acuerdo ya se cumplió/);
    expect(motivo(() => exigir('cumplir', 'cancelled'))).toMatch(/^conflicto: El acuerdo está cancelado/);
    expect(motivo(() => exigir('iniciar', 'in_progress'))).toMatch(/^conflicto: .*ya está en curso/);
    expect(motivo(() => exigir('cumplir', 'in_progress'))).toBe('ok');
  });

  it('cada acción que cambia estado lleva al estado del canónico', () => {
    expect(estadoTras('iniciar')).toBe('in_progress');
    expect(estadoTras('cumplir')).toBe('done');
    expect(estadoTras('cancelar')).toBe('cancelled');
  });

  it('las acciones del dominio son las del contrato; en un cerrado, ninguna tiene salida', () => {
    expect(new Set(acciones('pending'))).toEqual(new Set(ACCIONES_ACUERDO));
    for (const e of ESTADOS_ACUERDO.filter((x) => x === 'done' || x === 'cancelled')) {
      for (const a of ACCIONES_ACUERDO) expect(porQueNo(a, e)).toMatch(/siguiente reunión/);
    }
  });
});

describe('[PQ.3.10] situación y orden de la pestaña', () => {
  it('vencido · vence hoy · esta semana (los siete días que siguen) · al día · cerrados', () => {
    expect(situacion({ status: 'pending', due_date: '2026-11-25' }, HOY)).toBe('vencido');
    expect(situacion({ status: 'in_progress', due_date: '2026-11-26' }, HOY)).toBe('vence_hoy');
    expect(situacion({ status: 'pending', due_date: '2026-12-02' }, HOY)).toBe('esta_semana');
    expect(situacion({ status: 'pending', due_date: '2026-12-03' }, HOY)).toBe('al_dia');
    // Un cerrado nunca está vencido, aunque su fecha ya pasó.
    expect(situacion({ status: 'done', due_date: '2026-11-01' }, HOY)).toBe('cumplido');
    expect(situacion({ status: 'cancelled', due_date: '2026-11-01' }, HOY)).toBe('cancelado');
  });

  it('cada situación tiene su etiqueta', () => {
    for (const s of SITUACIONES_ACUERDO) expect(ETIQUETA_SITUACION_ACUERDO[s]).toBeTruthy();
  });

  it('lo vencido primero (lo más atrasado arriba), lo cerrado al final (lo más reciente arriba), estable por id', () => {
    const xs = [
      { id: 'a', status: 'pending' as const, due_date: '2026-12-20', closed_at: null },
      { id: 'b', status: 'done' as const, due_date: '2026-11-01', closed_at: '2026-11-20T10:00:00Z' },
      { id: 'c', status: 'pending' as const, due_date: '2026-11-20', closed_at: null },
      { id: 'd', status: 'in_progress' as const, due_date: '2026-11-26', closed_at: null },
      { id: 'e', status: 'cancelled' as const, due_date: '2026-11-02', closed_at: '2026-11-25T10:00:00Z' },
      { id: 'f', status: 'pending' as const, due_date: '2026-11-10', closed_at: null },
      { id: 'g', status: 'pending' as const, due_date: '2026-11-28', closed_at: null },
      { id: 'h', status: 'pending' as const, due_date: '2026-11-28', closed_at: null },
    ];
    expect(ordenar(xs, HOY).map((x) => x.id)).toEqual(['f', 'c', 'd', 'g', 'h', 'a', 'e', 'b']);
    // No muta la lista que recibe.
    expect(xs.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });
});
