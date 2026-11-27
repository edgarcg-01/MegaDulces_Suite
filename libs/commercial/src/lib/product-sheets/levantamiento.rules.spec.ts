// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { LEVANTAMIENTO_CARAS } from '@megadulces/contracts';
import type { ResultadoEscaneo } from '../shared/kdii-codigo';
import {
  apartadoALiberar, apartadoVivo, carasRequeridas, decidirEscaneo, presentacionAFotografiar, presentacionesDisponibles, decidirRevision, estadoTrasFoto, motivosDeRevision, nombreUnidad, nuevoApartado, peldanoPrincipal,
  caraResuelta, esDetalle, notaDetalle, ordenDeFoto, porQueNoDetalle, sinFotoReal, type EntradaEscaneo, type FotoFicha,
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

  it('⭐ [NP.7.L.23] el código de OTRA presentación ya no se rechaza: se captura la elegida', () => {
    expect(decidirEscaneo(entrada({ resultado: OK_DOS, principal: 'base' })).accion).toBe('capturar');
    expect(decidirEscaneo(entrada({ resultado: OK_DOS, principal: 'dos' })).accion).toBe('capturar');
  });

  describe('[NP.7.L.23] qué presentación se fotografía (UNA, elegida)', () => {
    const TRES = ['base', 'dos', 'tres'] as const;
    it('sin pedir nada: la del código si es de paquete o caja', () => {
      expect(presentacionAFotografiar({ disponibles: [...TRES], pedida: null, escaneada: 'tres', masVendida: 'dos' })).toBe('tres');
    });
    it('⭐ el código de la PIEZA no prueba que tenga una pieza: se marca la más vendida', () => {
      expect(presentacionAFotografiar({ disponibles: [...TRES], pedida: null, escaneada: 'base', masVendida: 'dos' })).toBe('dos');
    });
    it('por el buscador (sin código): la más vendida; sin dato de venta, la pieza', () => {
      expect(presentacionAFotografiar({ disponibles: [...TRES], pedida: null, escaneada: null, masVendida: 'tres' })).toBe('tres');
      expect(presentacionAFotografiar({ disponibles: [...TRES], pedida: null, escaneada: null, masVendida: null })).toBe('base');
    });
    it('lo que la persona eligió manda, aunque el código o la venta digan otra', () => {
      expect(presentacionAFotografiar({ disponibles: [...TRES], pedida: 'base', escaneada: 'tres', masVendida: 'dos' })).toBe('base');
    });
    it('⛔ elegir una presentación que el producto no tiene → null (el servicio responde 400)', () => {
      expect(presentacionAFotografiar({ disponibles: ['base'], pedida: 'tres', escaneada: null, masVendida: null })).toBeNull();
    });
    it('la más vendida que ya no existe en Kepler no se propone', () => {
      expect(presentacionAFotografiar({ disponibles: ['base', 'dos'], pedida: null, escaneada: 'base', masVendida: 'tres' })).toBe('base');
    });
    it('presentaciones disponibles: la pieza siempre; paquete y caja sólo con factor', () => {
      expect(presentacionesDisponibles({ f2: 12, f3: 384 })).toEqual(['base', 'dos', 'tres']);
      expect(presentacionesDisponibles({ f2: null, f3: 0 })).toEqual(['base']);
      expect(presentacionesDisponibles({ f2: 0, f3: 24 })).toEqual(['base', 'tres']);
    });
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
  /** `[NP.7.L.21]` Lo que se pide al escanear: 4 fotos guiadas. */
  const todas = ['frente', 'reverso', 'tabla_nutricional', 'informacion'].map((c) => foto(c));

  it('⭐ [NP.7.L.21] escaneado: las 4 (frente, reverso, tabla, información) → fotos_tomadas; 3 → sigue en_captura', () => {
    expect(carasRequeridas()).toEqual(['frente', 'reverso', 'tabla_nutricional', 'informacion']);
    expect(estadoTrasFoto(todas, 'base')).toBe('fotos_tomadas');
    expect(estadoTrasFoto(todas.slice(0, 3), 'base')).toBe('en_captura');
    // Los lados y la base ya no se piden: con ellos y sin la información, no termina.
    const conLados = [...todas.slice(0, 3), foto('lateral_izq'), foto('lateral_der'), foto('base')];
    expect(estadoTrasFoto(conLados, 'base')).toBe('en_captura');
  });

  it('⭐ [NP.7.L.21] por el buscador se pide además el código de barras (al escanear, ya se leyó)', () => {
    expect(carasRequeridas(true)).toEqual(['frente', 'reverso', 'tabla_nutricional', 'informacion', 'codigo_barras']);
    const porBusqueda = todas.map((f) => ({ ...f, por_busqueda: true }));
    expect(estadoTrasFoto(porBusqueda, 'base')).toBe('en_captura');
    expect(estadoTrasFoto([...porBusqueda, foto('codigo_barras', { por_busqueda: true })], 'base')).toBe('fotos_tomadas');
  });

  it('una ficha vieja con las 8 tomadas sigue completa (las de más no estorban)', () => {
    expect(estadoTrasFoto([...LEVANTAMIENTO_CARAS].map((c) => foto(c)), 'base')).toBe('fotos_tomadas');
  });

  it('un acercamiento que el empaque no trae se salta con motivo y completa igual (manda a revisión)', () => {
    const sinTabla = todas.map((f) => (f.cara === 'tabla_nutricional' ? foto('tabla_nutricional', { storage_key: null, sha256: null, saltada_motivo: 'no_tiene_esa_cara' }) : f));
    expect(estadoTrasFoto(sinTabla, 'base')).toBe('fotos_tomadas');
    expect(motivosDeRevision(sinTabla, 'base')).toEqual(['caras_saltadas']);
  });

  it('⭐ los detalles NO cuentan para terminar: 3 obligatorias + 3 detalles sigue en_captura', () => {
    const conDetalles = [...todas.slice(0, 3), foto('detalle_1'), foto('detalle_2'), foto('detalle_3')];
    expect(estadoTrasFoto(conDetalles, 'base')).toBe('en_captura');
    // Control: con la cuarta sí termina, con o sin detalles.
    expect(estadoTrasFoto([...conDetalles, todas[3]], 'base')).toBe('fotos_tomadas');
  });

  it('una cara saltada con motivo cuenta como resuelta, pero manda a revisión', () => {
    const conSalto = [...todas.slice(0, 3), foto('informacion', { storage_key: null, sha256: null, saltada_motivo: 'no_se_puede_girar' })];
    expect(estadoTrasFoto(conSalto, 'base')).toBe('fotos_tomadas');
    expect(motivosDeRevision(conSalto, 'base')).toEqual(['caras_saltadas']);
  });

  it('⛔ el frente sólo se resuelve con FOTO: un salto del frente (anterior a la regla) no completa la ficha', () => {
    const frenteSaltado = [foto('frente', { storage_key: null, sha256: null, saltada_motivo: 'no_tiene_esa_cara' }), ...todas.slice(1)];
    expect(caraResuelta(frenteSaltado[0])).toBe(false);
    expect(estadoTrasFoto(frenteSaltado, 'base')).toBe('en_captura');
    // Control: otra cara saltada sí se resuelve, y el frente con foto también.
    expect(caraResuelta(foto('reverso', { storage_key: null, sha256: null, saltada_motivo: 'otro' }))).toBe(true);
    expect(caraResuelta(todas[0])).toBe(true);
  });

  it('⭐ las 5 caras saltadas = sin ninguna foto real (la primera captura en prod llegó así a «Por revisar»)', () => {
    const saltada = (c: string) => foto(c, { storage_key: null, sha256: null, saltada_motivo: 'otro' });
    const todasSaltadas = ['frente', 'reverso', 'lateral_izq', 'lateral_der', 'base'].map(saltada);
    expect(sinFotoReal(todasSaltadas, 'base')).toBe(true);
    // Control: con UNA foto real ya hay qué revisar; y una foto de otro peldaño no cuenta.
    expect(sinFotoReal([foto('frente'), ...todasSaltadas.slice(1)], 'base')).toBe(false);
    expect(sinFotoReal([foto('frente', { peldano: 'dos' }), ...todasSaltadas.slice(1)], 'base')).toBe(true);
  });

  it('prueba negativa: fotos de OTRO peldaño no completan la principal', () => {
    expect(estadoTrasFoto(todas.map((f) => ({ ...f, peldano: 'dos' as const })), 'base')).toBe('en_captura');
  });

  it('foto repetida (mismo sha256) y entrada por búsqueda → motivos de revisión', () => {
    const rep = [...todas.slice(0, 7), foto('codigo_barras', { sha256: 'sha-frente', por_busqueda: true })];
    expect(motivosDeRevision(rep, 'base')).toEqual(['entro_por_busqueda', 'foto_repetida']);
    expect(motivosDeRevision(todas, 'base')).toEqual([]);
  });
});

describe('detalles · hasta 3 fotos libres, después de terminar', () => {
  const capturo = { by: 'ana', at: AHORA.toISOString() };
  const en = (min: number) => new Date(AHORA.getTime() + min * 60_000);

  it('esDetalle: sólo detalle_1..3', () => {
    expect(['detalle_1', 'detalle_2', 'detalle_3'].every(esDetalle)).toBe(true);
    expect(esDetalle('detalle_4')).toBe(false);
    expect(esDetalle('frente')).toBe(false);
    expect(esDetalle('tabla_nutricional')).toBe(false);
  });

  it('se puede: terminada (en revisión), quien la terminó, dentro de 30 min', () => {
    for (const s of ['fotos_tomadas', 'analizada', 'por_revisar']) expect(porQueNoDetalle(s, capturo, 'ana', en(29))).toBeNull();
  });

  it('no se puede: a media captura, ya revisada, otra persona, fuera de la ventana o sin quién terminó', () => {
    expect(porQueNoDetalle('en_captura', capturo, 'ana', en(1))?.tipo).toBe('conflicto');
    expect(porQueNoDetalle('publicada', capturo, 'ana', en(1))?.tipo).toBe('conflicto');
    expect(porQueNoDetalle('recapturar', capturo, 'ana', en(1))?.tipo).toBe('conflicto');
    expect(porQueNoDetalle('por_revisar', capturo, 'beto', en(1))?.tipo).toBe('prohibido');
    expect(porQueNoDetalle('por_revisar', capturo, 'ana', en(31))?.tipo).toBe('conflicto');
    expect(porQueNoDetalle('por_revisar', null, 'ana', en(1))?.tipo).toBe('prohibido');
    expect(porQueNoDetalle('por_revisar', { by: 'ana', at: null }, 'ana', en(1))?.tipo).toBe('conflicto');
  });

  it('la nota: recortada a 60, sin saltos de línea, vacía = null', () => {
    expect(notaDetalle('  hecho en \n Colombia ')).toBe('hecho en Colombia');
    expect(notaDetalle('x'.repeat(80))).toHaveLength(60);
    expect(notaDetalle('   ')).toBeNull();
    expect(notaDetalle(undefined)).toBeNull();
  });

  it('orden para mostrar: caras, acercamientos, detalles y lo desconocido al final', () => {
    const orden = ['detalle_2', 'xyz', 'codigo_barras', 'frente', 'detalle_1', 'base'].sort((a, b) => ordenDeFoto(a) - ordenDeFoto(b));
    expect(orden).toEqual(['frente', 'base', 'codigo_barras', 'detalle_1', 'detalle_2', 'xyz']);
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
