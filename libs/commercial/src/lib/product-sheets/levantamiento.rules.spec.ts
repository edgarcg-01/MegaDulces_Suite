// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import type { ResultadoEscaneo } from '../shared/kdii-codigo';
import {
  apartadoALiberar, apartadoVivo, decidirEscaneo, decidirRevision, estadoTrasFoto, motivosDeRevision, nombreUnidad, nuevoApartado, peldanoPrincipal,
  type EntradaEscaneo, type FotoFicha,
} from './levantamiento.rules';

const AHORA = new Date('2026-11-03T16:00:00Z');
const OK_BASE: ResultadoEscaneo = { tipo: 'ok', resuelto: { sku: '02020', nombre: 'TRIDENT', peldano: 'base', unidad: 'PZA', factor: 1 } };
const OK_DOS: ResultadoEscaneo = { tipo: 'ok', resuelto: { sku: '02020', nombre: 'TRIDENT', peldano: 'dos', unidad: 'PAQ', factor: 12 } };

const entrada = (p: Partial<EntradaEscaneo> = {}): EntradaEscaneo => ({
  resultado: OK_BASE, principal: 'base', estadoFicha: null, apartado: null,
  userId: 'ana', ahora: AHORA, vivosDelUsuario: [], ...p,
});

describe('peldanoPrincipal · rung_modal es un FACTOR', () => {
  const trident = { f2: 12, f3: 384 };
  it('1 → Base; el factor de la Dos → Dos; el de la Tres → Tres', () => {
    expect(peldanoPrincipal(trident, 1)).toBe('base');
    expect(peldanoPrincipal(trident, 12)).toBe('dos');
    expect(peldanoPrincipal(trident, 384)).toBe('tres');
  });
  it('⭐ prueba negativa: un factor que no está en la escalera, o sin dato, NO se adivina', () => {
    expect(peldanoPrincipal(trident, 2)).toBeNull();
    expect(peldanoPrincipal(trident, null)).toBeNull();
    expect(peldanoPrincipal(trident, 0)).toBeNull();
  });
});

describe('decidirEscaneo · qué se le dice a quien escanea', () => {
  it('lo normal: código de la unidad principal, sin ficha → capturar', () => {
    expect(decidirEscaneo(entrada())).toEqual({ accion: 'capturar', liberar: null });
  });

  it('código que no existe / compartido → hallazgo, nunca captura', () => {
    expect(decidirEscaneo(entrada({ resultado: { tipo: 'desconocido' } })).accion).toBe('no_registrado');
    expect(decidirEscaneo(entrada({ resultado: { tipo: 'ambiguo', candidatos: ['1', '2'] } })).accion).toBe('codigo_compartido');
  });

  it('⭐ ficha publicada (o una alta conciliada) → «ya está»; levantada y en revisión → no se duplica', () => {
    expect(decidirEscaneo(entrada({ estadoFicha: 'publicada' })).accion).toBe('ya_esta');
    expect(decidirEscaneo(entrada({ estadoFicha: 'conciliada' })).accion).toBe('ya_esta');
    expect(decidirEscaneo(entrada({ estadoFicha: 'fotos_tomadas' })).accion).toBe('en_revision');
    expect(decidirEscaneo(entrada({ estadoFicha: 'recapturar' })).accion).toBe('capturar');
  });

  it('⭐ D23: el código de la caja cuando la principal es la pieza → otra_unidad (fuera del piloto)', () => {
    expect(decidirEscaneo(entrada({ resultado: OK_DOS, principal: 'base' })).accion).toBe('otra_unidad');
    // control: si la caja ES la unidad principal, sí se captura
    expect(decidirEscaneo(entrada({ resultado: OK_DOS, principal: 'dos' })).accion).toBe('capturar');
  });

  it('por el buscador no hay peldaño escaneado: se captura la unidad principal', () => {
    expect(decidirEscaneo(entrada({ resultado: OK_DOS, principal: 'base', porBusqueda: true })).accion).toBe('capturar');
  });

  it('sin unidad principal conocida → no se adivina qué fotografiar', () => {
    expect(decidirEscaneo(entrada({ principal: null })).accion).toBe('sin_unidad_principal');
  });

  it('⭐ apartado vivo de otra persona bloquea; vencido se retoma; el propio no cuenta doble', () => {
    const deLuis = nuevoApartado('luis', AHORA);
    expect(decidirEscaneo(entrada({ apartado: deLuis })).accion).toBe('apartado_por_otro');
    const vencido = { by: 'luis', until: new Date(AHORA.getTime() - 1000).toISOString() };
    expect(decidirEscaneo(entrada({ apartado: vencido })).accion).toBe('capturar');
    const mio = nuevoApartado('ana', AHORA);
    const tres = [1, 2, 3].map((i) => ({ sheetId: `s${i}`, until: '2026-11-03T16:10:00Z', conFotos: true }));
    expect(decidirEscaneo(entrada({ apartado: mio, vivosDelUsuario: tres })).accion).toBe('capturar');
  });

  it('⭐ un cuarto apartado libera el más viejo SIN fotos; si todos tienen fotos, se bloquea', () => {
    const vivos = [
      { sheetId: 'a', until: '2026-11-03T16:20:00Z', conFotos: false },
      { sheetId: 'b', until: '2026-11-03T16:05:00Z', conFotos: false },
      { sheetId: 'c', until: '2026-11-03T16:01:00Z', conFotos: true },
    ];
    expect(decidirEscaneo(entrada({ vivosDelUsuario: vivos }))).toEqual({ accion: 'capturar', liberar: 'b' });
    const conFotos = vivos.map((v) => ({ ...v, conFotos: true }));
    expect(decidirEscaneo(entrada({ vivosDelUsuario: conFotos })).accion).toBe('demasiados_apartados');
    expect(apartadoALiberar(vivos.slice(0, 2))).toEqual({ liberar: null, bloqueado: false });
  });
});

describe('apartado · 30 minutos', () => {
  it('vive 30 min y después no', () => {
    const a = nuevoApartado('ana', AHORA);
    expect(apartadoVivo(a, new Date(AHORA.getTime() + 29 * 60_000))).toBe(true);
    expect(apartadoVivo(a, new Date(AHORA.getTime() + 30 * 60_000))).toBe(false);
    expect(apartadoVivo(null, AHORA)).toBe(false);
  });
});

describe('fotos · cuándo queda completa la unidad principal', () => {
  const foto = (cara: string, p: Partial<FotoFicha> = {}): FotoFicha => ({
    peldano: 'base', cara, storage_key: `k/${cara}.jpg`, sha256: `sha-${cara}`, captured_by: 'ana', captured_at: AHORA.toISOString(),
    saltada_motivo: null, calidad: null, ancho: 1200, alto: 1600, por_busqueda: false, ...p,
  });
  const cinco = ['frente', 'reverso', 'lateral_izq', 'lateral_der', 'base'].map((c) => foto(c));

  it('5 caras → fotos_tomadas; 4 → sigue en_captura', () => {
    expect(estadoTrasFoto(cinco, 'base')).toBe('fotos_tomadas');
    expect(estadoTrasFoto(cinco.slice(0, 4), 'base')).toBe('en_captura');
  });

  it('una cara saltada con motivo cuenta como resuelta, pero manda a revisión', () => {
    const conSalto = [...cinco.slice(0, 4), foto('base', { storage_key: null, sha256: null, saltada_motivo: 'no_se_puede_girar' })];
    expect(estadoTrasFoto(conSalto, 'base')).toBe('fotos_tomadas');
    expect(motivosDeRevision(conSalto, 'base')).toEqual(['caras_saltadas']);
  });

  it('prueba negativa: fotos de OTRO peldaño no completan la principal', () => {
    expect(estadoTrasFoto(cinco.map((f) => ({ ...f, peldano: 'dos' as const })), 'base')).toBe('en_captura');
  });

  it('foto repetida (mismo sha256) y entrada por búsqueda → motivos de revisión', () => {
    const rep = [...cinco.slice(0, 4), foto('base', { sha256: 'sha-frente', por_busqueda: true })];
    expect(motivosDeRevision(rep, 'base')).toEqual(['entro_por_busqueda', 'foto_repetida']);
    expect(motivosDeRevision(cinco, 'base')).toEqual([]);
  });
});

describe('nombreUnidad · lo que lee la persona', () => {
  it('rótulo de Kepler a palabra, con su factor', () => {
    expect(nombreUnidad('PAQ', 20)).toBe('paquete de 20');
    expect(nombreUnidad('PZA', 1)).toBe('pieza');
    expect(nombreUnidad('CJA', 144)).toBe('caja de 144');
    expect(nombreUnidad('500', 1)).toBe('500 g');
  });
  it('sin rótulo no se inventa: «presentación»', () => {
    expect(nombreUnidad(null, null)).toBe('presentación');
  });
});

describe('decidirRevision · lo que hace Catálogo con cada ficha', () => {
  it('publicar deja la ficha publicada', () => {
    expect(decidirRevision('fotos_tomadas', 'publicar', null)).toEqual({ ok: true, status: 'publicada', borrar: false });
  });
  it('recapturar y descartar exigen nota (quien levantó tiene que saber por qué)', () => {
    expect(decidirRevision('por_revisar', 'recapturar', '  ')).toMatchObject({ ok: false });
    expect(decidirRevision('por_revisar', 'recapturar', 'el frente salió cortado')).toEqual({ ok: true, status: 'recapturar', borrar: false });
    expect(decidirRevision('analizada', 'descartar', '')).toMatchObject({ ok: false });
    expect(decidirRevision('analizada', 'descartar', 'no es este producto')).toEqual({ ok: true, status: null, borrar: true });
  });
  it('⭐ prueba negativa: no se decide sobre una ficha que no está en revisión, ni con una decisión inventada', () => {
    expect(decidirRevision('publicada', 'publicar', null)).toMatchObject({ ok: false });
    expect(decidirRevision('en_captura', 'publicar', null)).toMatchObject({ ok: false });
    expect(decidirRevision('fotos_tomadas', 'aprobar_todo', 'x')).toMatchObject({ ok: false });
  });
});
