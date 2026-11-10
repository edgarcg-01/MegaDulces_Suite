import {
  abrirLectorCodigos, camaraDisponible, controlesSiSigueAbierta, detenerLector, motivoSinCamara,
  RESTRICCIONES_CAMARA, type ModulosZxing,
} from './lector-codigos';

/**
 * `[VTK.17]` La lógica del lector de códigos, ahora compartida por las dos apps.
 *
 * Los tres primeros casos son los de `[NP.7]` (vivían en `apps/view`, que ahora sólo reexporta):
 * se movieron con el código para que la invariante siga teniendo quien la sostenga.
 */

/**
 * Un `stop()` que devuelve una «promesa» de prueba: anota si alguien le registró un manejador de RECHAZO.
 * Un rechazo con manejador está atendido; sin manejador es justo el que el navegador reporta como suelto.
 */
function stopQueSeRechaza() {
  const estado = { llamado: 0, manejadorDeRechazo: false };
  const thenable = {
    then(_ok?: unknown, mal?: unknown) {
      if (typeof mal === 'function') estado.manejadorDeRechazo = true;
      return thenable;
    },
  };
  return { estado, controles: { stop: () => { estado.llamado++; return thenable as unknown as void; } } };
}

describe('[NP.7] detenerLector — apagar la cámara sin rechazos sueltos', () => {
  it('⭐ con linterna (stop asíncrono que se rechaza): el rechazo queda ATENDIDO', () => {
    const { estado, controles } = stopQueSeRechaza();
    detenerLector(controles);
    expect(estado).toEqual({ llamado: 1, manejadorDeRechazo: true });
  });

  it('sin linterna (stop síncrono), sin controles o ya cerrada: no lanza', () => {
    let llamado = 0;
    expect(() => detenerLector({ stop: () => { llamado++; } })).not.toThrow();
    expect(llamado).toBe(1);
    expect(() => detenerLector(undefined)).not.toThrow();
    expect(() => detenerLector({ stop: () => { throw new Error('ya estaba cerrada'); } })).not.toThrow();
  });

  it('⭐ «Cancelar» mientras la cámara abría: los controles que llegan tarde se apagan y no se guardan', () => {
    const tarde = stopQueSeRechaza();
    expect(controlesSiSigueAbierta(tarde.controles, false)).toBeUndefined();
    expect(tarde.estado).toEqual({ llamado: 1, manejadorDeRechazo: true });
    // Control: con la cámara todavía abierta se guardan tal cual y NO se apagan.
    const aTiempo = stopQueSeRechaza();
    expect(controlesSiSigueAbierta(aTiempo.controles, true)).toBe(aTiempo.controles);
    expect(aTiempo.estado.llamado).toBe(0);
  });
});

describe('[VTK.17] camaraDisponible / motivoSinCamara — sin cámara se dice por qué, y se puede escribir', () => {
  it('sin getUserMedia (http de LAN, navegador viejo) no hay cámara; con él sí', () => {
    expect(camaraDisponible(undefined)).toBe(false);
    expect(camaraDisponible({})).toBe(false);
    expect(camaraDisponible({ mediaDevices: {} })).toBe(false);
    expect(camaraDisponible({ mediaDevices: { getUserMedia: () => undefined } })).toBe(true);
  });

  it('⭐ permiso negado: lo dice y ofrece escribir (no culpa al teléfono)', () => {
    const t = motivoSinCamara({ name: 'NotAllowedError' });
    expect(t).toContain('permiso');
    expect(t).toContain('escribir');
  });

  it('sin cámara, cámara ocupada y error desconocido: cada uno su texto, ninguno inventa la causa', () => {
    expect(motivoSinCamara({ name: 'NotFoundError' })).toContain('no tiene una cámara');
    expect(motivoSinCamara({ name: 'NotReadableError' })).toContain('otra aplicación');
    const generico = motivoSinCamara(new Error('x'));
    expect(generico).toBe('No se pudo abrir la cámara. Escribe el código o el nombre.');
    expect(motivoSinCamara(null)).toBe(generico);
  });
});

describe('[VTK.17] abrirLectorCodigos — formatos de producto, cámara trasera, código limpio', () => {
  function zxingFalso() {
    const llamadas: { hints?: Map<unknown, unknown>; restricciones?: unknown; cb?: (r: unknown) => void } = {};
    const controles = { stop: vi.fn() };
    class Lector {
      constructor(hints: Map<unknown, unknown>) { llamadas.hints = hints; }
      decodeFromConstraints(restricciones: unknown, _v: unknown, cb: (r: unknown) => void) {
        llamadas.restricciones = restricciones;
        llamadas.cb = cb;
        return Promise.resolve(controles);
      }
    }
    const modulos = {
      browser: { BrowserMultiFormatReader: Lector },
      library: {
        DecodeHintType: { POSSIBLE_FORMATS: 'FORMATOS' },
        BarcodeFormat: { EAN_13: 'EAN13', EAN_8: 'EAN8', UPC_A: 'UPCA', UPC_E: 'UPCE', CODE_128: 'C128', ITF: 'ITF', QR_CODE: 'QR' },
      },
    } as unknown as ModulosZxing;
    return { llamadas, controles, cargar: () => Promise.resolve(modulos) };
  }

  it('pide la cámara trasera y sólo formatos de producto (sin QR)', async () => {
    const z = zxingFalso();
    const ctl = await abrirLectorCodigos({} as HTMLVideoElement, () => undefined, z.cargar);
    expect(ctl).toBe(z.controles);
    expect(z.llamadas.restricciones).toBe(RESTRICCIONES_CAMARA);
    expect(z.llamadas.hints?.get('FORMATOS')).toEqual(['EAN13', 'EAN8', 'UPCA', 'UPCE', 'C128', 'ITF']);
  });

  it('entrega el código sin espacios y no llama con lecturas vacías', async () => {
    const z = zxingFalso();
    const leidos: string[] = [];
    await abrirLectorCodigos({} as HTMLVideoElement, (c) => leidos.push(c), z.cargar);
    z.llamadas.cb?.(undefined);
    z.llamadas.cb?.({ getText: () => '   ' });
    z.llamadas.cb?.({ getText: () => ' 7501234567890 ' });
    expect(leidos).toEqual(['7501234567890']);
  });

  it('⭐ negativa: si getUserMedia rechaza (permiso negado), la promesa se rechaza con ese error', async () => {
    const negado = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const modulos = {
      browser: { BrowserMultiFormatReader: class { decodeFromConstraints() { return Promise.reject(negado); } } },
      library: { DecodeHintType: { POSSIBLE_FORMATS: 0 }, BarcodeFormat: {} },
    } as unknown as ModulosZxing;
    await expect(abrirLectorCodigos({} as HTMLVideoElement, () => undefined, () => Promise.resolve(modulos))).rejects.toBe(negado);
  });
});
