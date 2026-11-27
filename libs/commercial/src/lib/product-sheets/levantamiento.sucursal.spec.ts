// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { ForbiddenException } from '@nestjs/common';
import { AREA_LEVANTAMIENTO, LevantamientoService, SIN_SUCURSAL, type Quien } from './levantamiento.service';

/**
 * `[NP.7.L.20]` La sucursal del levantamiento la decide el SERVIDOR con el perfil y el alcance de ESCRITURA
 * de la persona; nadie la elige. `sucursalesParaLevantar` es la pieza que escribió un dev en modo aprendizaje.
 * El alcance y el perfil se sustituyen: lo que se prueba es la regla, no la consulta.
 */
type Dim = { modeWrite: 'all' | 'listed' | 'own' | 'none'; valuesWrite: string[] };

class Prueba extends LevantamientoService {
  perfil = '';
  areaPedida: string | undefined;
  constructor(dim: Dim) {
    super(
      {} as never,
      {} as never,
      { current: async (area?: string) => { this.areaPedida = area; return { dims: { warehouse: dim } }; } } as never,
      {} as never,
    );
  }
  protected override async sucursalDelPerfil(): Promise<string> {
    return this.perfil;
  }
  override async sucursales(): Promise<Array<{ code: string; name: string }>> {
    return ['01', '02', '03', '05', '07'].map((code) => ({ code, name: `Sucursal ${code}` }));
  }
}

const QUIEN: Quien = { userId: '00000000-0000-0000-0000-0000000a0a0a', username: 'prueba' };

describe('[NP.7.L.20] sucursalesParaLevantar', () => {
  it('Dado perfil 01 y sin regla de alcance (fail-closed) → [01]', async () => {
    const s = new Prueba({ modeWrite: 'none', valuesWrite: [] });
    s.perfil = '01';
    expect(await s.sucursalesParaLevantar(QUIEN)).toEqual(['01']);
  });

  it('Dado alcance de ESCRITURA «todas» → todas las sucursales, aunque tenga perfil', async () => {
    const s = new Prueba({ modeWrite: 'all', valuesWrite: [] });
    s.perfil = '03';
    expect(await s.sucursalesParaLevantar(QUIEN)).toEqual(['01', '02', '03', '05', '07']);
  });

  it('Dado perfil y lista → perfil + lista, sin repetidos y ordenadas', async () => {
    const s = new Prueba({ modeWrite: 'listed', valuesWrite: ['07', '03', '07'] });
    s.perfil = '03';
    expect(await s.sucursalesParaLevantar(QUIEN)).toEqual(['03', '07']);
  });

  it('⛔ Dado sin perfil (vacío) y con lista → sin el «» colado', async () => {
    const s = new Prueba({ modeWrite: 'listed', valuesWrite: ['05'] });
    expect(await s.sucursalesParaLevantar(QUIEN)).toEqual(['05']);
  });

  it('Dado sin perfil ni alcance → [] (la pantalla dirá «pídela a tu encargado»)', async () => {
    expect(await new Prueba({ modeWrite: 'none', valuesWrite: [] }).sucursalesParaLevantar(QUIEN)).toEqual([]);
  });

  it('pregunta el alcance DEL ÁREA del levantamiento, no el general', async () => {
    const s = new Prueba({ modeWrite: 'none', valuesWrite: [] });
    await s.sucursalesParaLevantar(QUIEN);
    expect(s.areaPedida).toBe(AREA_LEVANTAMIENTO);
  });
});

describe('[NP.7.L.20] sucursal(): el servidor decide, nadie elige', () => {
  it('con perfil → la del perfil primero, y las demás de su alcance después', async () => {
    const s = new Prueba({ modeWrite: 'listed', valuesWrite: ['01', '07'] });
    s.perfil = '05';
    expect(await s.sucursal(QUIEN)).toEqual({ code: '05', source: 'perfil', permitidas: ['05', '01', '07'] });
  });

  it('sin perfil, con alcance → la de código más bajo (decisión A)', async () => {
    const s = new Prueba({ modeWrite: 'listed', valuesWrite: ['07', '03'] });
    expect(await s.sucursal(QUIEN)).toEqual({ code: '03', source: 'alcance', permitidas: ['03', '07'] });
  });

  it('⛔ sin perfil ni alcance → 403 SIN_SUCURSAL con el aviso para su encargado (antes: elegía cualquiera)', async () => {
    const p = new Prueba({ modeWrite: 'none', valuesWrite: [] }).sucursal(QUIEN);
    await expect(p).rejects.toBeInstanceOf(ForbiddenException);
    await expect(p).rejects.toMatchObject({ response: { code: 'SIN_SUCURSAL', message: SIN_SUCURSAL } });
  });
});
