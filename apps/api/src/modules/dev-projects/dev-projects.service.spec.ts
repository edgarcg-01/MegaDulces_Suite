import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi } from 'vitest';
import { DevProjectsService } from './dev-projects.service';
import { MAX_ATTACHMENT_BYTES } from './dev-projects.rules';

/**
 * `[DEV.4]` El servicio con dobles: lo que se prueba acá es el ORDEN de las operaciones y las
 * compuertas (validar antes de subir, limpiar el binario si el renglón falla, sólo el equipo puede
 * ser responsable). Lo que toca Postgres de verdad (RLS, CHECKs, folio atómico) se prueba contra la
 * base en `database/tests/test-newdb-dev-projects.js` (ADR-044).
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const MEMBER = 'fbe43d20-1317-4fd9-b485-1779a6bd4355';

interface TableScript {
  first?: unknown;
  update?: number;
  returning?: unknown[];
  rows?: unknown[];
}

/** Un `trx` mínimo: cada tabla responde lo que el test le guionó, y registra lo que se le pidió. */
function fakeTrx(script: Record<string, TableScript>) {
  const calls: { table: string; op: string; arg?: unknown }[] = [];
  const builder = (table: string) => {
    const s = script[table] ?? {};
    const b: any = {};
    for (const m of ['where', 'whereNull', 'whereIn', 'leftJoin', 'orderBy', 'select', 'limit', 'whereILike', 'orWhereILike', 'forUpdate']) {
      b[m] = () => b;
    }
    b.first = () => Promise.resolve(s.first);
    b.update = (arg: unknown) => {
      calls.push({ table, op: 'update', arg });
      return Promise.resolve(s.update ?? 0);
    };
    b.insert = (arg: unknown) => {
      calls.push({ table, op: 'insert', arg });
      return { returning: () => Promise.resolve(s.returning ?? []) };
    };
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(s.rows ?? []).then(res, rej);
    return b;
  };
  const trx: any = (table: string) => builder(table);
  trx.fn = { now: () => 'NOW()' };
  trx.raw = vi.fn(async () => ({ rows: [{ last_number: 7 }] }));
  return { trx, calls };
}

function build(script: Record<string, TableScript>) {
  const { trx, calls } = fakeTrx(script);
  const tk = { run: vi.fn(async (cb: (t: unknown) => unknown) => cb(trx)) };
  const tenantCtx = {
    requireTenantId: () => TENANT,
    get: () => ({ tenantId: TENANT, userId: MEMBER, username: 'david_cisneros' }),
  };
  const storage = {
    putBuffer: vi.fn(async () => ({ key: `devtools/${TENANT}/projects/${PROJECT}/abc.jpg` })),
    signedUrl: vi.fn(async () => 'https://bucket.local/firmada'),
    remove: vi.fn(async () => undefined),
  };
  const svc = new DevProjectsService(tk as any, tenantCtx as any, storage as any);
  return { svc, storage, calls, trx };
}

const file = (over: Partial<{ buffer: Buffer; originalname: string; mimetype: string; size: number }> = {}) => ({
  buffer: Buffer.from('hola'),
  originalname: 'idea.jpg',
  mimetype: 'image/jpeg',
  size: 4,
  ...over,
});

describe('[DEV.4] addAttachment', () => {
  it('⛔ sin archivo no sube nada', async () => {
    const { svc, storage } = build({});
    await expect(svc.addAttachment(PROJECT, undefined, 'archivo')).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.putBuffer).not.toHaveBeenCalled();
  });

  it('⛔ un archivo arriba del tope se rechaza ANTES de subir', async () => {
    const { svc, storage } = build({});
    await expect(svc.addAttachment(PROJECT, file({ size: MAX_ATTACHMENT_BYTES + 1 }), 'archivo')).rejects.toThrow(/tope/);
    expect(storage.putBuffer).not.toHaveBeenCalled();
  });

  it('⛔ si el proyecto no existe no deja un binario huérfano en el bucket', async () => {
    const { svc, storage } = build({ 'devtools.projects': { first: undefined } });
    await expect(svc.addAttachment(PROJECT, file(), 'archivo')).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.putBuffer).not.toHaveBeenCalled();
  });

  it('camino feliz: sube, registra el renglón con el tipo derivado del MIME y devuelve URL firmada', async () => {
    const { svc, storage, calls } = build({
      'devtools.projects': { first: { id: PROJECT }, update: 1 },
      'devtools.project_attachments': {
        returning: [{ id: 'a1', kind: 'imagen', source: 'camara', file_name: 'idea.jpg', mime_type: 'image/jpeg', size_bytes: '4', created_at: new Date('2026-10-01T16:00:00Z'), created_by_username: 'david_cisneros' }],
      },
    });
    const out = await svc.addAttachment(PROJECT, file(), 'camara');
    expect(storage.putBuffer).toHaveBeenCalledWith(expect.any(Buffer), 'image/jpeg', `devtools/${TENANT}/projects/${PROJECT}`, 'idea.jpg');
    const ins = calls.find((c) => c.table === 'devtools.project_attachments' && c.op === 'insert')!.arg as any;
    expect(ins).toMatchObject({ tenant_id: TENANT, project_id: PROJECT, kind: 'imagen', source: 'camara', size_bytes: 4 });
    expect(out.url).toBe('https://bucket.local/firmada');
    expect(out.size_bytes).toBe(4);
  });

  it('⛔ si el renglón falla, borra el binario que ya había subido', async () => {
    const { svc, storage, trx } = build({ 'devtools.projects': { first: { id: PROJECT } } });
    // Primer run (validar proyecto) pasa; el segundo (insert) revienta.
    let n = 0;
    (svc as any).tk.run = vi.fn(async (cb: (t: unknown) => unknown) => {
      n += 1;
      if (n === 2) throw new Error('violates check constraint');
      return cb(trx);
    });
    await expect(svc.addAttachment(PROJECT, file(), 'archivo')).rejects.toThrow(/check constraint/);
    expect(storage.remove).toHaveBeenCalledWith(`devtools/${TENANT}/projects/${PROJECT}/abc.jpg`);
  });

  it('una foto de canvas sin nombre recibe «foto.jpg»', async () => {
    const { svc, storage } = build({
      'devtools.projects': { first: { id: PROJECT } },
      'devtools.project_attachments': { returning: [{ id: 'a1', kind: 'imagen', source: 'camara', file_name: 'foto.jpg', mime_type: 'image/jpeg', size_bytes: 4, created_at: 'x' }] },
    });
    await svc.addAttachment(PROJECT, file({ originalname: '' }), 'camara');
    expect(storage.putBuffer).toHaveBeenCalledWith(expect.any(Buffer), 'image/jpeg', expect.any(String), 'foto.jpg');
  });
});

describe('[DEV.4] create', () => {
  it('⛔ el responsable tiene que ser del equipo de desarrollo', async () => {
    const { svc, calls } = build({ 'devtools.dev_team': { first: undefined } });
    await expect(svc.create({ title: 'X', assignee_user_id: MEMBER })).rejects.toThrow(/equipo de desarrollo/);
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('genera el folio con el consecutivo del UPSERT y guarda quién lo dio de alta', async () => {
    const { svc, calls } = build({
      'devtools.dev_team': { first: { user_id: MEMBER } },
      'devtools.projects': { returning: [{ id: PROJECT }] },
    });
    // detail() se prueba aparte; acá sólo interesa lo que se insertó.
    vi.spyOn(svc, 'detail').mockResolvedValue({ id: PROJECT } as any);
    await svc.create({ title: 'Bitácora', assignee_user_id: MEMBER, priority: 'alta' });
    const ins = calls.find((c) => c.table === 'devtools.projects' && c.op === 'insert')!.arg as any;
    expect(ins.folio).toMatch(/^DEV-\d{4}-0007$/);
    expect(ins).toMatchObject({
      tenant_id: TENANT, title: 'Bitácora', priority: 'alta', status: 'nuevo',
      assignee_user_id: MEMBER, created_by: MEMBER, created_by_username: 'david_cisneros',
    });
  });

  it('⛔ sin nombre no llega ni a la base', async () => {
    const { svc } = build({});
    await expect(svc.create({ title: '' })).rejects.toBeInstanceOf(BadRequestException);
    expect((svc as any).tk.run).not.toHaveBeenCalled();
  });
});

describe('[DEV.4] update / remove', () => {
  it('⛔ editar un proyecto inexistente (o dado de baja) es 404', async () => {
    const { svc } = build({ 'devtools.projects': { update: 0 } });
    await expect(svc.update(PROJECT, { status: 'terminado' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('la baja es lógica: escribe deleted_at, no borra', async () => {
    const { svc, calls } = build({ 'devtools.projects': { update: 1 } });
    await svc.remove(PROJECT);
    const up = calls.find((c) => c.op === 'update')!.arg as any;
    expect(up).toHaveProperty('deleted_at');
    expect(up.deleted_by).toBe(MEMBER);
  });
});

describe('[DEV.10] seguimiento: el rastro de cada cambio', () => {
  const BEFORE = {
    tenant_id: TENANT, title: 'Portal', objective: 'Hacerlo', priority: 'media', status: 'terminado',
    assignee_user_id: null, due_date: null,
  };

  it('editar deja un registro «cambio» con el antes y el después, legible', async () => {
    const { svc, calls } = build({
      'devtools.dev_team': { first: { user_id: MEMBER } },
      'devtools.projects': { first: BEFORE, update: 1 },
      'identity.users as u': { rows: [{ id: MEMBER, name: 'Ángel David Cisneros Salazar' }] },
    });
    vi.spyOn(svc, 'detail').mockResolvedValue({ id: PROJECT } as any);
    await svc.update(PROJECT, { status: 'en_progreso', assignee_user_id: MEMBER });
    const trail = calls.find((c) => c.table === 'devtools.project_notes' && c.op === 'insert')!.arg as any;
    expect(trail.kind).toBe('cambio');
    expect(trail.body).toBe('Estado: Terminado → En progreso · Asignado a: Sin asignar → Ángel David Cisneros Salazar');
    expect(JSON.parse(trail.changes)).toEqual([
      { field: 'status', from: 'terminado', to: 'en_progreso' },
      { field: 'assignee_user_id', from: null, to: MEMBER },
    ]);
    expect(trail.created_by_username).toBe('david_cisneros');
  });

  it('⛔ reenviar los mismos valores no escribe nada: ni UPDATE ni rastro', async () => {
    const { svc, calls } = build({ 'devtools.projects': { first: BEFORE, update: 1 } });
    vi.spyOn(svc, 'detail').mockResolvedValue({ id: PROJECT } as any);
    await svc.update(PROJECT, { status: 'terminado', title: 'Portal' });
    expect(calls.filter((c) => c.op === 'update' || c.op === 'insert')).toEqual([]);
  });

  it('⛔ editar un proyecto inexistente es 404 y no deja rastro', async () => {
    const { svc, calls } = build({ 'devtools.projects': { first: undefined } });
    await expect(svc.update(PROJECT, { status: 'terminado' })).rejects.toBeInstanceOf(NotFoundException);
    expect(calls.some((c) => c.table === 'devtools.project_notes')).toBe(false);
  });
});

describe('[DEV.10] notas y modificaciones', () => {
  const NOTE = '22222222-2222-4222-8222-222222222222';

  it('agrega una modificación a un proyecto TERMINADO (no se bloquea por estado)', async () => {
    const { svc, calls } = build({
      'devtools.projects': { first: { id: PROJECT }, update: 1 },
      'devtools.project_notes': { returning: [{ id: 'n1', kind: 'modificacion', body: 'Agregar filtro por zona', created_at: new Date('2026-10-01T17:00:00Z'), created_by_username: 'david_cisneros' }] },
    });
    const n = await svc.addNote(PROJECT, { kind: 'modificacion', body: '  Agregar filtro por zona ' });
    const ins = calls.find((c) => c.table === 'devtools.project_notes' && c.op === 'insert')!.arg as any;
    expect(ins).toMatchObject({ tenant_id: TENANT, project_id: PROJECT, kind: 'modificacion', body: 'Agregar filtro por zona' });
    expect(n).toMatchObject({ id: 'n1', kind: 'modificacion', changes: null, attachments: [] });
  });

  it('⛔ una persona no puede escribir un «cambio» (es el rastro del servidor)', async () => {
    const { svc } = build({});
    await expect(svc.addNote(PROJECT, { kind: 'cambio', body: 'x' })).rejects.toThrow(/Tipo inválido/);
  });

  it('⛔ nota en un proyecto que no existe es 404', async () => {
    const { svc } = build({ 'devtools.projects': { first: undefined } });
    await expect(svc.addNote(PROJECT, { body: 'hola' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('⛔ el registro automático no se puede borrar', async () => {
    const { svc, calls } = build({ 'devtools.project_notes': { first: { kind: 'cambio' } } });
    await expect(svc.removeNote(PROJECT, 'n1')).rejects.toThrow(/no se puede borrar/);
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('una nota sí se da de baja (lógica)', async () => {
    const { svc, calls } = build({ 'devtools.project_notes': { first: { kind: 'nota' }, update: 1 } });
    await svc.removeNote(PROJECT, 'n1');
    expect((calls.find((c) => c.op === 'update')!.arg as any).deleted_by).toBe(MEMBER);
  });

  it('⛔ adjuntar a un «cambio» se rechaza ANTES de subir al bucket', async () => {
    const { svc, storage } = build({
      'devtools.projects': { first: { id: PROJECT } },
      'devtools.project_notes': { first: { kind: 'cambio' } },
    });
    await expect(svc.addAttachment(PROJECT, file(), 'archivo', NOTE)).rejects.toThrow(/registro automático/);
    expect(storage.putBuffer).not.toHaveBeenCalled();
  });

  it('el adjunto de una nota guarda su note_id', async () => {
    const { svc, calls } = build({
      'devtools.projects': { first: { id: PROJECT } },
      'devtools.project_notes': { first: { kind: 'nota' } },
      'devtools.project_attachments': { returning: [{ id: 'a1', kind: 'imagen', source: 'camara', file_name: 'x.jpg', mime_type: 'image/jpeg', size_bytes: 4, created_at: 'x', note_id: NOTE }] },
    });
    const out = await svc.addAttachment(PROJECT, file(), 'camara', NOTE);
    expect((calls.find((c) => c.table === 'devtools.project_attachments')!.arg as any).note_id).toBe(NOTE);
    expect(out.note_id).toBe(NOTE);
  });
});
