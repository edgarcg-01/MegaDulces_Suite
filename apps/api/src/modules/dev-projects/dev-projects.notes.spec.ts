import { NOTE_MAX, describeChanges, normalizeNoteInput } from './dev-projects.rules';

/** `[DEV.10]` Reglas del seguimiento: qué se puede escribir y cómo se resume un cambio. */

describe('[DEV.10] normalizeNoteInput', () => {
  it('nota por default, recortada', () => {
    expect(normalizeNoteInput({ body: '  avance  ' })).toEqual({ kind: 'nota', body: 'avance' });
  });
  it('acepta modificación', () => {
    expect(normalizeNoteInput({ kind: 'modificacion', body: 'x' }).kind).toBe('modificacion');
  });
  it('⛔ vacía, demasiado larga o de tipo inventado', () => {
    expect(() => normalizeNoteInput({ body: '   ' })).toThrow(/vacía/);
    expect(() => normalizeNoteInput({ body: 'x'.repeat(NOTE_MAX + 1) })).toThrow(/no puede pasar/);
    expect(() => normalizeNoteInput({ kind: 'cambio', body: 'x' })).toThrow(/Tipo inválido/);
    expect(() => normalizeNoteInput(null)).toThrow(/vacía/);
  });
});

describe('[DEV.10] describeChanges', () => {
  const before = {
    title: 'Portal', objective: 'Viejo', priority: 'media' as const, status: 'nuevo' as const,
    assignee_user_id: null, due_date: null,
  };
  const names = (id: string | null) => (id ? `N(${id})` : 'Sin asignar');

  it('sólo lo que de verdad cambió', () => {
    const d = describeChanges(before, { title: 'Portal', status: 'terminado', priority: 'urgente' }, names)!;
    expect(d.changes.map((c) => c.field)).toEqual(['priority', 'status']);
    expect(d.summary).toBe('Prioridad: Media → Urgente · Estado: Nuevo → Terminado');
  });

  it('⛔ sin un cambio real devuelve null (no ensucia el seguimiento)', () => {
    expect(describeChanges(before, { title: 'Portal', status: 'nuevo' }, names)).toBeNull();
    expect(describeChanges(before, {}, names)).toBeNull();
  });

  it('el objetivo no se copia entero al resumen, pero el texto viejo queda en el detalle', () => {
    const d = describeChanges(before, { objective: 'Nuevo texto larguísimo' }, names)!;
    expect(d.summary).toBe('Objetivo: se reescribió');
    expect(d.changes[0]).toEqual({ field: 'objective', from: 'Viejo', to: 'Nuevo texto larguísimo' });
    expect(describeChanges(before, { objective: null }, names)!.summary).toBe('Objetivo: se borró');
    expect(describeChanges({ ...before, objective: null }, { objective: 'algo' }, names)!.summary).toBe('Objetivo: se agregó');
  });

  it('responsable y fecha con su nombre visible', () => {
    const d = describeChanges(before, { assignee_user_id: 'u1', due_date: '2026-10-31' }, names)!;
    expect(d.summary).toBe('Asignado a: Sin asignar → N(u1) · Fecha compromiso: — → 2026-10-31');
  });
});
