// Sin `import ... from 'vitest'`: la config usa `globals: true` (con el import el spec no carga: compuerta spec-vivo).
import {
  AREAS_PARTICIPANTE, ETIQUETA_SITUACION_REUNION, LIMITES_REUNION, SITUACIONES_REUNION, TIPOS_REUNION, type AgendarReunionDto,
} from '@megadulces/contracts';
import {
  acciones, areaDelPuesto, cambiosDeParticipantes, choquesDe, CitasError, esFecha, exigir, porQueNo, semanaDe, situacion,
  validarMinuta, validarMotivo, validarParticipantes, validarReunion, type ParticipanteGuardado, type ReunionParaChoque,
} from './supplier-meetings.domain';

/** `[PQ.3.8]` Citas · C1: el dominio de la reunión con el proveedor, sin base. La base se prueba aparte (Postgres real). */

const HOY = '2026-11-26';
const ANA = '11111111-1111-4111-8111-111111111111';
const LUIS = '22222222-2222-4222-8222-222222222222';
const PEPE = '33333333-3333-4333-8333-333333333333';

const dto = (o: Partial<AgendarReunionDto> = {}): AgendarReunionDto => ({
  supplier_code: 'PRV01', kind: 'executive', date: '2026-12-02', start_time: '10:00', end_time: '11:00', mode: 'in_person',
  location: 'Sala de juntas', topics: ['Precios 2027', 'Lanzamientos'],
  participants: [{ side: 'internal', user_id: ANA, area: 'compras' }, { side: 'supplier', name: 'Ejecutivo de ventas', job_title: 'Gerente regional' }],
  ...o,
});

/** El mensaje con que se rechaza, o `'ok'`. */
const motivo = (f: () => unknown): string => {
  try { f(); return 'ok'; } catch (e) { return e instanceof CitasError ? `${e.tipo}: ${e.message}` : `OTRO: ${String(e)}`; }
};

describe('[PQ.3.8] validarReunion', () => {
  it('una cita completa sale normalizada (los temas vacíos se descartan, el texto sin espacios de más)', () => {
    const r = validarReunion(dto({ supplier_code: ' PRV01 ', topics: ['  Precios 2027 ', '', '   ', 'Lanzamientos'], location: '  ' }), HOY);
    expect(r).toMatchObject({
      supplier_code: 'PRV01', kind: 'executive', status: 'scheduled', date: '2026-12-02', start_time: '10:00', end_time: '11:00',
      mode: 'in_person', location: null, topics: ['Precios 2027', 'Lanzamientos'], work_plan_year: null,
    });
    expect(r.participants).toEqual([
      { id: null, side: 'internal', user_id: ANA, area: 'compras', name: null, job_title: null },
      { id: null, side: 'supplier', user_id: null, area: null, name: 'Ejecutivo de ventas', job_title: 'Gerente regional' },
    ]);
  });

  it('por confirmar se acepta al agendar; realizada y cancelada no (van después, con minuta o motivo)', () => {
    expect(validarReunion(dto({ status: 'to_confirm' }), HOY).status).toBe('to_confirm');
    expect(motivo(() => validarReunion(dto({ status: 'held' as never }), HOY))).toMatch(/^invalida: Una reunión nueva/);
    expect(motivo(() => validarReunion(dto({ status: 'cancelled' as never }), HOY))).toMatch(/^invalida: Una reunión nueva/);
  });

  it('al editar el estado no viaja: se ignora lo que mande la pantalla', () => {
    expect(validarReunion(dto({ status: 'held' as never }), HOY, true).status).toBe('scheduled');
  });

  it('el plan de trabajo lleva año, siempre y sólo él (DC12)', () => {
    expect(validarReunion(dto({ kind: 'work_plan', work_plan_year: 2027 }), HOY).work_plan_year).toBe(2027);
    expect(motivo(() => validarReunion(dto({ kind: 'work_plan' }), HOY))).toMatch(/plan de trabajo es de un año/);
    expect(motivo(() => validarReunion(dto({ kind: 'work_plan', work_plan_year: 2024 }), HOY))).toMatch(/un año/);
    expect(motivo(() => validarReunion(dto({ kind: 'work_plan', work_plan_year: 2027.5 }), HOY))).toMatch(/un año/);
    expect(motivo(() => validarReunion(dto({ kind: 'business_review', work_plan_year: 2027 }), HOY))).toMatch(/Sólo el plan de trabajo lleva año/);
  });

  it('las fechas: existen, hasta 90 días atrás (para escribir la minuta) y hasta dos años adelante', () => {
    expect(validarReunion(dto({ date: '2026-08-28' }), HOY).date).toBe('2026-08-28'); // 90 días antes
    expect(motivo(() => validarReunion(dto({ date: '2026-08-27' }), HOY))).toMatch(/más de 90 días/);
    expect(validarReunion(dto({ date: '2028-11-25' }), HOY).date).toBe('2028-11-25'); // 730 días después
    expect(motivo(() => validarReunion(dto({ date: '2028-11-26' }), HOY))).toMatch(/más de dos años/);
    expect(motivo(() => validarReunion(dto({ date: '2026-02-30' }), HOY))).toMatch(/fecha no es válida/);
    expect(motivo(() => validarReunion(dto({ date: '2/12/2026' }), HOY))).toMatch(/fecha no es válida/);
  });

  it('las horas: HH:MM, el fin después del inicio el mismo día, y no más de 12 horas', () => {
    expect(motivo(() => validarReunion(dto({ start_time: '9:00' }), HOY))).toMatch(/horas no son válidas/);
    expect(motivo(() => validarReunion(dto({ start_time: '24:00' }), HOY))).toMatch(/horas no son válidas/);
    expect(motivo(() => validarReunion(dto({ end_time: '10:00' }), HOY))).toMatch(/fin va después/);
    expect(motivo(() => validarReunion(dto({ start_time: '23:00', end_time: '01:00' }), HOY))).toMatch(/fin va después/);
    expect(validarReunion(dto({ start_time: '07:00', end_time: '19:00' }), HOY).end_time).toBe('19:00');
    expect(motivo(() => validarReunion(dto({ start_time: '07:00', end_time: '19:01' }), HOY))).toMatch(/más de 12 horas/);
  });

  it('tipo, modalidad y proveedor de la lista; temas y lugar con tope', () => {
    expect(motivo(() => validarReunion(dto({ kind: 'visita' as never }), HOY))).toMatch(/tipo de reunión/);
    expect(motivo(() => validarReunion(dto({ mode: 'zoom' as never }), HOY))).toMatch(/cómo se reúnen/);
    expect(motivo(() => validarReunion(dto({ supplier_code: '   ' }), HOY))).toMatch(/Elige el proveedor/);
    expect(motivo(() => validarReunion(dto({ supplier_code: 'X'.repeat(21) }), HOY))).toMatch(/clave del proveedor/);
    expect(motivo(() => validarReunion(dto({ topics: Array.from({ length: 21 }, (_, i) => `t${i}`) }), HOY))).toMatch(/Máximo 20 temas/);
    expect(validarReunion(dto({ topics: Array.from({ length: 20 }, (_, i) => `t${i}`) }), HOY).topics).toHaveLength(20);
    expect(motivo(() => validarReunion(dto({ topics: ['x'.repeat(201)] }), HOY))).toMatch(/máximo 200 caracteres \(uno tiene 201\)/);
    expect(motivo(() => validarReunion(dto({ topics: [3 as never] }), HOY))).toMatch(/Cada tema es texto/);
    expect(motivo(() => validarReunion(dto({ topics: 'uno' as never }), HOY))).toMatch(/temas van en una lista/);
    expect(motivo(() => validarReunion(dto({ location: 'x'.repeat(201) }), HOY))).toMatch(/El lugar: máximo 200/);
  });

  it('sin datos, un error en español, nunca una excepción de JavaScript', () => {
    expect(motivo(() => validarReunion(null as never, HOY))).toMatch(/^invalida: Faltan los datos/);
    expect(motivo(() => validarReunion({} as never, HOY))).toMatch(/^invalida: Elige el proveedor/);
  });
});

describe('[PQ.3.8] validarParticipantes', () => {
  it('al menos una persona de Mega Dulces', () => {
    expect(motivo(() => validarParticipantes([{ side: 'supplier', name: 'Ejecutivo' }]))).toMatch(/Al menos una persona de Mega Dulces/);
    expect(motivo(() => validarParticipantes([]))).toMatch(/Al menos una persona/);
    expect(motivo(() => validarParticipantes(undefined))).toMatch(/Faltan los participantes/);
  });

  it('por Mega Dulces: usuario y área de la lista, una vez; nombre y puesto se ignoran', () => {
    const [p] = validarParticipantes([{ side: 'internal', user_id: ANA.toUpperCase(), area: 'marketing', name: 'x', job_title: 'y' }]);
    expect(p).toEqual({ id: null, side: 'internal', user_id: ANA, area: 'marketing', name: null, job_title: null });
    expect(motivo(() => validarParticipantes([{ side: 'internal', user_id: 'ana', area: 'compras' }]))).toMatch(/Elige a la persona/);
    expect(motivo(() => validarParticipantes([{ side: 'internal', user_id: ANA }]))).toMatch(/Elige el área/);
    expect(motivo(() => validarParticipantes([{ side: 'internal', user_id: ANA, area: 'ventas' as never }]))).toMatch(/Elige el área/);
    expect(motivo(() => validarParticipantes([
      { side: 'internal', user_id: ANA, area: 'compras' }, { side: 'internal', user_id: ANA.toUpperCase(), area: 'finanzas' },
    ]))).toMatch(/dos veces en la reunión/);
  });

  it('por el proveedor: nombre obligatorio, puesto opcional, sin usuario ni área', () => {
    const [, p] = validarParticipantes([
      { side: 'internal', user_id: ANA, area: 'compras' },
      { side: 'supplier', name: '  Ejecutivo  ', job_title: '  ', user_id: LUIS, area: 'compras' },
    ]);
    expect(p).toEqual({ id: null, side: 'supplier', user_id: null, area: null, name: 'Ejecutivo', job_title: null });
    expect(motivo(() => validarParticipantes([{ side: 'internal', user_id: ANA, area: 'compras' }, { side: 'supplier', name: ' ' }])))
      .toMatch(/Escribe el nombre/);
    expect(motivo(() => validarParticipantes([{ side: 'internal', user_id: ANA, area: 'compras' }, { side: 'supplier', name: 'x'.repeat(121) }])))
      .toMatch(/máximo 120/);
    expect(motivo(() => validarParticipantes([{ side: 'cliente' as never, name: 'x' }]))).toMatch(/de Mega Dulces o del proveedor/);
  });

  it('el id de uno que ya estaba: válido y una sola vez', () => {
    expect(motivo(() => validarParticipantes([{ id: 'abc', side: 'internal', user_id: ANA, area: 'compras' }]))).toMatch(/no es válido/);
    expect(motivo(() => validarParticipantes([
      { id: LUIS, side: 'internal', user_id: ANA, area: 'compras' }, { id: LUIS, side: 'supplier', name: 'x' },
    ]))).toMatch(/viene dos veces/);
  });

  it(`tope de ${LIMITES_REUNION.participantes} participantes`, () => {
    const muchos = Array.from({ length: 31 }, () => ({ side: 'supplier' as const, name: 'x' }));
    expect(motivo(() => validarParticipantes(muchos))).toMatch(/Máximo 30 participantes/);
  });
});

describe('[PQ.3.8] situación y acciones', () => {
  const r = (status: 'to_confirm' | 'scheduled' | 'held' | 'cancelled', starts_at = '2026-11-26T16:00:00Z', ends_at = '2026-11-26T17:00:00Z') =>
    ({ status, starts_at, ends_at });
  const ANTES = '2026-11-26T15:00:00Z';
  const DURANTE = '2026-11-26T16:30:00Z';
  const DESPUES = '2026-11-26T17:00:00Z'; // justo al terminar ya terminó

  it('una reunión abierta que ya terminó es «sin minuta», nunca «realizada» (§9.1)', () => {
    expect(situacion(r('scheduled'), ANTES)).toBe('agendada');
    expect(situacion(r('to_confirm'), ANTES)).toBe('por_confirmar');
    expect(situacion(r('scheduled'), DURANTE)).toBe('en_curso');
    expect(situacion(r('to_confirm'), DURANTE)).toBe('en_curso');
    expect(situacion(r('scheduled'), DESPUES)).toBe('sin_minuta');
    expect(situacion(r('to_confirm'), DESPUES)).toBe('sin_minuta');
    expect(situacion(r('held'), ANTES)).toBe('realizada');
    expect(situacion(r('cancelled'), DESPUES)).toBe('cancelada');
  });

  it('cada situación tiene etiqueta (la pantalla no inventa textos)', () => {
    for (const s of SITUACIONES_REUNION) expect(ETIQUETA_SITUACION_REUNION[s]).toBeTruthy();
  });

  it('los botones salen de la misma regla que frena la escritura', () => {
    expect(acciones(r('to_confirm'), ANTES)).toEqual(['confirmar', 'editar', 'cancelar']);
    expect(acciones(r('scheduled'), ANTES)).toEqual(['editar', 'cancelar']);
    expect(acciones(r('scheduled'), DURANTE)).toEqual(['minuta', 'editar', 'cancelar']);
    expect(acciones(r('to_confirm'), DESPUES)).toEqual(['confirmar', 'minuta', 'editar', 'cancelar']);
    expect(acciones(r('held'), DESPUES)).toEqual([]);
    expect(acciones(r('cancelled'), ANTES)).toEqual([]);
  });

  it('exigir rechaza con conflicto y el porqué', () => {
    expect(motivo(() => exigir('minuta', r('scheduled'), ANTES))).toBe('conflicto: La reunión todavía no empieza: la minuta se escribe cuando ya se reunieron.');
    expect(motivo(() => exigir('editar', r('held'), DESPUES))).toMatch(/^conflicto: La reunión ya se realizó/);
    expect(motivo(() => exigir('cancelar', r('cancelled'), DESPUES))).toMatch(/^conflicto: La reunión está cancelada/);
    expect(motivo(() => exigir('confirmar', r('scheduled'), ANTES))).toMatch(/ya estaba confirmada/);
    expect(motivo(() => exigir('minuta', r('scheduled'), DURANTE))).toBe('ok');
    expect(porQueNo('editar', r('scheduled'), DESPUES)).toBeNull(); // pasó sin minuta: se puede reprogramar
  });
});

describe('[PQ.3.8] minuta y motivo', () => {
  it('obligatorios, sin espacios de más y con tope', () => {
    expect(validarMinuta({ minutes: '  Se acordó precio  ' })).toBe('Se acordó precio');
    expect(motivo(() => validarMinuta({ minutes: '   ' }))).toMatch(/Escribe la minuta/);
    expect(motivo(() => validarMinuta(null))).toMatch(/Escribe la minuta/);
    expect(motivo(() => validarMinuta({ minutes: 'x'.repeat(4001) }))).toMatch(/máximo 4000/);
    expect(validarMotivo({ reason: ' El ejecutivo no vino ' })).toBe('El ejecutivo no vino');
    expect(motivo(() => validarMotivo({ reason: '' }))).toMatch(/por qué se cancela/);
    expect(motivo(() => validarMotivo({ reason: 'x'.repeat(501) }))).toMatch(/máximo 500/);
  });
});

describe('[PQ.3.8] semanaDe', () => {
  it('lunes a domingo, también si la fecha es domingo o cruza de mes y de año', () => {
    expect(semanaDe('2026-11-26')).toEqual({ desde: '2026-11-23', hasta: '2026-11-29' }); // jueves
    expect(semanaDe('2026-11-23')).toEqual({ desde: '2026-11-23', hasta: '2026-11-29' }); // lunes
    expect(semanaDe('2026-11-29')).toEqual({ desde: '2026-11-23', hasta: '2026-11-29' }); // domingo
    expect(semanaDe('2027-01-01')).toEqual({ desde: '2026-12-28', hasta: '2027-01-03' });
    expect(motivo(() => semanaDe('2026-13-01'))).toMatch(/AAAA-MM-DD/);
    expect(esFecha('2028-02-29')).toBe(true);
    expect(esFecha('2027-02-29')).toBe(false);
  });
});

describe('[PQ.3.8] cambiosDeParticipantes', () => {
  const guardados: ParticipanteGuardado[] = [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', side: 'internal', user_id: ANA, area: 'compras', name: null, job_title: null },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', side: 'internal', user_id: LUIS, area: 'marketing', name: null, job_title: null },
    { id: 'aaaaaaaa-0000-4000-8000-000000000003', side: 'supplier', user_id: null, area: null, name: 'Ejecutivo', job_title: null },
  ];

  it('igual = nada; el que falta se quita; el nuevo se agrega', () => {
    const iguales = validarParticipantes(guardados);
    expect(cambiosDeParticipantes(guardados, iguales)).toEqual({ quitar: [], agregar: [] });
    const pedidos = validarParticipantes([guardados[0], { side: 'internal', user_id: PEPE, area: 'finanzas' }]);
    const c = cambiosDeParticipantes(guardados, pedidos);
    expect(c.quitar).toEqual([guardados[1].id, guardados[2].id]);
    expect(c.agregar).toEqual([{ id: null, side: 'internal', user_id: PEPE, area: 'finanzas', name: null, job_title: null }]);
  });

  it('cambiar el área o el puesto = quitar el renglón y agregar otro (los renglones no se editan)', () => {
    const pedidos = validarParticipantes([{ ...guardados[0], area: 'direccion' }, guardados[1], { ...guardados[2], job_title: 'Gerente' }]);
    const c = cambiosDeParticipantes(guardados, pedidos);
    expect(c.quitar).toEqual([guardados[0].id, guardados[2].id]);
    expect(c.agregar.map((p) => [p.id, p.user_id ?? p.name, p.area ?? p.job_title])).toEqual([[null, ANA, 'direccion'], [null, 'Ejecutivo', 'Gerente']]);
  });

  it('un id que ya no está = conflicto (otra persona cambió la reunión)', () => {
    const pedidos = validarParticipantes([{ id: 'aaaaaaaa-0000-4000-8000-000000000009', side: 'internal', user_id: ANA, area: 'compras' }]);
    expect(motivo(() => cambiosDeParticipantes(guardados, pedidos))).toMatch(/^conflicto: Alguien ya no está/);
  });
});

describe('[PQ.3.8] choquesDe', () => {
  const reu = (id: string, ini: string, fin: string, internos: string[], status: ReunionParaChoque['status'] = 'scheduled'): ReunionParaChoque => ({
    id, status, starts_at: `2026-12-02T${ini}:00Z`, ends_at: `2026-12-02T${fin}:00Z`, supplier_code: `P-${id}`, supplier_name: `Proveedor ${id}`,
    start_time: ini, end_time: fin, internos: internos.map((u) => ({ user_id: u, nombre: `n-${u.slice(0, 4)}` })),
  });

  const ANTES = '2026-12-01T00:00:00Z';

  it('la misma persona en dos reuniones abiertas que se enciman: aviso en las dos', () => {
    const m = choquesDe([reu('a', '16:00', '17:00', [ANA, LUIS]), reu('b', '16:30', '17:30', [ANA]), reu('c', '16:30', '17:30', [PEPE])], ANTES);
    expect(m.get('a')).toEqual([{ user_id: ANA, nombre: 'n-1111', meeting_id: 'b', supplier_code: 'P-b', supplier_name: 'Proveedor b', start_time: '16:30', end_time: '17:30' }]);
    expect(m.get('b')?.map((x) => [x.meeting_id, x.user_id])).toEqual([['a', ANA]]);
    expect(m.has('c')).toBe(false);
  });

  it('la que empieza justo cuando la otra acaba no choca; realizada y cancelada no ocupan a nadie', () => {
    expect(choquesDe([reu('a', '16:00', '17:00', [ANA]), reu('b', '17:00', '18:00', [ANA])], ANTES).size).toBe(0);
    expect(choquesDe([reu('a', '16:00', '17:00', [ANA]), reu('b', '16:00', '17:00', [ANA], 'cancelled')], ANTES).size).toBe(0);
    expect(choquesDe([reu('a', '16:00', '17:00', [ANA], 'held'), reu('b', '16:00', '17:00', [ANA])], ANTES).size).toBe(0);
    expect(choquesDe([reu('a', '16:00', '17:00', [ANA], 'to_confirm'), reu('b', '16:59', '17:00', [ANA])], ANTES).get('a')).toHaveLength(1);
  });

  it('las que ya terminaron (sin minuta) no avisan choque: piden su minuta', () => {
    const par = [reu('a', '16:00', '17:00', [ANA]), reu('b', '16:30', '17:30', [ANA])];
    expect(choquesDe(par, '2026-12-02T16:45:00Z').size).toBe(2); // las dos siguen en curso
    expect(choquesDe(par, '2026-12-02T17:00:00Z').size).toBe(0); // «a» ya terminó: sólo queda «b», sin con quién chocar
  });
});

describe('[PQ.3.8] areaDelPuesto', () => {
  it('propone el área por el puesto (DC41) y sólo áreas de la lista', () => {
    expect(areaDelPuesto('gerente_compras')).toBe('compras');
    expect(areaDelPuesto('AUXILIAR_COMPRAS')).toBe('compras');
    expect(areaDelPuesto('jefe_marketing')).toBe('marketing');
    expect(areaDelPuesto('tesoreria')).toBe('finanzas');
    expect(areaDelPuesto('direccion')).toBe('direccion');
    expect(areaDelPuesto('encargado_tienda')).toBeNull();
    expect(areaDelPuesto(null)).toBeNull();
    for (const p of ['gerente_compras', 'compras', 'compras_operaciones', 'auxiliar_compras', 'jefe_marketing', 'marketing', 'tesoreria', 'finanzas', 'direccion']) {
      expect(AREAS_PARTICIPANTE).toContain(areaDelPuesto(p));
    }
  });

  it('el vocabulario es el del contrato (los CHECK de la base lo vigilan aparte)', () => {
    expect(TIPOS_REUNION).toEqual(['executive', 'business_review', 'work_plan']);
  });
});
