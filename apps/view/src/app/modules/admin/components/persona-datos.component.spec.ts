import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { AdminService } from '../admin.service';
import { PersonaDatosComponent } from './persona-datos.component';

/**
 * `[ZN.8]` — **El editor de excepciones por área.**
 *
 * Lo que se prueba acá son las dos compuertas que, si fallan, producen una configuración que
 * *parece* guardada y no hace lo que dice:
 *
 *   · **ofrecer un área que la persona ya tiene** — el backend hace `onConflict … merge`, o sea
 *     que la pisaría sin avisar, y quien la escribió creería estar agregando una segunda;
 *   · **guardar sin motivo** — el motivo es lo único que explica, seis meses después, por qué
 *     esta persona ve distinto acá que en el resto. Sin él la regla sobrevive y la razón no.
 *
 * El caso real que las motiva: alguien que en Compras ve las 9 sucursales y en el resto sólo
 * Morelia. Antes eso no se podía escribir y su alcance cambió cuatro veces en quince días.
 */
const dim = (over: Record<string, unknown> = {}) => ({
  mode: 'listed', modeWrite: 'listed', source: 'user', nota: null,
  values: ['07', '08'], valuesWrite: ['07', '08'], supportsOwn: true, resolvable: true,
  options: [], universe: [{ value: '07', label: 'Madero' }, { value: '08', label: 'Abastos' }],
  valuesFueraDelUniverso: [],
  ...over,
});

const alcance = {
  user_id: 'u1',
  role_name: 'compras_operaciones',
  dimensions: { warehouse: dim() },
  excepciones: [
    {
      dimension: 'warehouse', area: 'compras', area_label: 'Compras',
      mode: 'all', values: null, mode_write: null, nota: 'Hace el pedido de todas.',
    },
  ],
};

let guardado: unknown[] = [];

const montar = async (resp: unknown = alcance): Promise<ComponentFixture<PersonaDatosComponent>> => {
  guardado = [];
  await TestBed.configureTestingModule({
    imports: [PersonaDatosComponent],
    providers: [
      {
        provide: AdminService,
        useValue: {
          alcanceDe: () => of(resp),
          setAlcance: (...args: unknown[]) => { guardado.push(args); return of({}); },
        },
      },
    ],
  }).compileComponents();
  const fix = TestBed.createComponent(PersonaDatosComponent);
  fix.componentRef.setInput('userId', 'u1');
  fix.componentRef.setInput('puedeEscribir', true);
  fix.detectChanges();
  return fix;
};

describe('[ZN.8] excepciones por área — qué se ofrece', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('muestra la excepción que ya existe, con su área y su regla legibles', async () => {
    const cmp = (await montar()).componentInstance;
    const exc = cmp.excepcionesDe('warehouse');
    expect(exc.length).toBe(1);
    expect(exc[0].area_label).toBe('Compras');
    expect(cmp.comoSeLee(exc[0].mode, exc[0].values)).toBe('ve todo');
  });

  it('⛔ NO vuelve a ofrecer un área que ya tiene — el backend la pisaría en silencio', async () => {
    const cmp = (await montar()).componentInstance;
    const libres = cmp.areasLibres('warehouse').map((a) => a.value);
    expect(libres).not.toContain('compras');
    expect(libres.length).toBeGreaterThan(0);
  });

  it('y el contra-ejemplo: sin excepciones, `compras` sí se ofrece', async () => {
    const cmp = (await montar({ ...alcance, excepciones: [] })).componentInstance;
    expect(cmp.areasLibres('warehouse').map((a) => a.value)).toContain('compras');
  });

  it('⛔ el modo de una excepción NO ofrece «lo que diga su perfil»', async () => {
    const cmp = (await montar()).componentInstance;
    const paraExc = cmp.modoOpts(dim() as never, true).map((o) => o.value);
    expect(paraExc).not.toContain(null);
    // En la regla general sí, que es como se vuelve al rol.
    expect(cmp.modoOpts(dim() as never).map((o) => o.value)).toContain(null);
  });

  it('sin `excepciones` en la respuesta no inventa ninguna (API viejo)', async () => {
    const { excepciones: _fuera, ...sinCampo } = alcance;
    const cmp = (await montar(sinCampo)).componentInstance;
    expect(cmp.excepcionesDe('warehouse')).toEqual([]);
  });
});

describe('[ZN.8] excepciones por área — qué se deja guardar', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const abrir = async () => {
    const cmp = (await montar()).componentInstance;
    cmp.nuevaExcepcion('warehouse');
    return cmp;
  };

  it('recién abierta no se puede guardar: falta todo', async () => {
    const cmp = await abrir();
    expect(cmp.puedeGuardarExc('warehouse')).toBe(false);
  });

  it('⛔ con área y modo pero SIN motivo, tampoco', async () => {
    const cmp = await abrir();
    cmp.setExc('warehouse', { area: 'pdv', mode: 'all' });
    expect(cmp.puedeGuardarExc('warehouse')).toBe(false);
  });

  it('con área, modo y motivo, sí — y manda el área al servidor', async () => {
    const cmp = await abrir();
    cmp.setExc('warehouse', { area: 'pdv', mode: 'all', nota: 'Supervisa el mostrador.' });
    expect(cmp.puedeGuardarExc('warehouse')).toBe(true);
    cmp.guardarExc('warehouse');
    expect(guardado.length).toBe(1);
    expect((guardado[0] as unknown[])[2]).toMatchObject({ area: 'pdv', mode: 'all' });
  });

  it('⛔ «una lista» sin valores no se puede guardar: dejaría a la persona sin ver nada', async () => {
    const cmp = await abrir();
    cmp.setExc('warehouse', { area: 'pdv', mode: 'listed', nota: 'x', values: [] });
    expect(cmp.puedeGuardarExc('warehouse')).toBe(false);
    cmp.setExc('warehouse', { values: ['07'] });
    expect(cmp.puedeGuardarExc('warehouse')).toBe(true);
  });

  it('quitar manda `mode: null` CON el área — si fuera sin, borraría la regla general', async () => {
    const cmp = (await montar()).componentInstance;
    cmp.quitarExcepcion('warehouse', 'compras');
    expect((guardado[0] as unknown[])[2]).toEqual({ mode: null, area: 'compras' });
  });
});
