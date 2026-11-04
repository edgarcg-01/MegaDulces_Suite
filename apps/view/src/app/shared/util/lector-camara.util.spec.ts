import { controlesSiSigueAbierta, detenerLector } from './lector-camara.util';

/**
 * Un `stop()` que devuelve una «promesa» de prueba: anota si alguien le registró un manejador de RECHAZO.
 * Un rechazo con manejador está atendido; sin manejador es justo el que el navegador reporta como suelto.
 * Se mira eso, y no el evento de rechazo suelto: con zone.js cargado ese evento no llega al proceso.
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

describe('[NP.7] detenerLector — apagar la cámara de zxing sin rechazos sueltos', () => {
  it('⭐ con linterna (stop asíncrono que se rechaza): el rechazo queda ATENDIDO', () => {
    const { estado, controles } = stopQueSeRechaza();
    detenerLector(controles);
    expect(estado.llamado).toBe(1);
    expect(estado.manejadorDeRechazo).toBe(true);
  });

  it('sin linterna (stop síncrono) y sin controles: no lanza', () => {
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
