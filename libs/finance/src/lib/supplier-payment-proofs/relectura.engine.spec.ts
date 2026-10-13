/**
 * `[AT.1]` — Pruebas de la relectura desde el archivo guardado.
 *
 * ⚠️ Pruebas de COMPORTAMIENTO, no de texto. El candado que ya existía en este directorio
 * (`validacion-automatica.spec.ts`) lee el `.ts` del servicio y le busca cadenas con `toContain`:
 * eso se pone verde con un renombre y rojo con un espacio de más, y nunca ejerce la regla. Acá se
 * llaman las funciones.
 *
 * La prueba que define el éxito es la de la lectura vacía: si esa falla, una caída del proveedor
 * de visión **borra evidencia** de 1,199 comprobantes.
 */
import {
  hojaRelegible, esLlaveDeBucket, motivoDeHoja, tipoLeible, base64De, lecturaSirve,
  camposQueCambiaron, veredictoPasada, notaPasada, pasadaVacia, CAMPOS_QUE_DECIDEN,
} from './relectura.engine';

/**
 * ⛔⛔ Las formas REALES, copiadas de prod el 2026-10-12. No son inventadas: la primera versión
 * de esta regla las confundía y mandó 25 descargas a un bucket donde el objeto no existe.
 */
const LLAVE_BUCKET = 'finance/00000000-0000-0000-0000-00000000d01c/supplier-payments/ab12cd34-5678-90ef-ab12-cd34567890ef.pdf';
const ID_CLOUDINARY = 'finance/00000000-0000-0000-0000-00000000d01c/supplier-payments/uyil38hglpnz7zarmv8g';

describe('[AT.1] ⛔⛔ ¿la evidencia está en NUESTRO bucket o en Cloudinary?', () => {
  it('la llave del bucket termina en extensión', () => {
    expect(esLlaveDeBucket(LLAVE_BUCKET)).toBe(true);
    expect(esLlaveDeBucket('docs/abc.jpg')).toBe(true);
    expect(esLlaveDeBucket('docs/abc.bin')).toBe(true); // el fallback de putFile
  });

  it('⛔ el public_id de Cloudinary se ve IGUAL y no tiene extensión', () => {
    // Si esto fallara, el carril pediría al bucket un objeto que no existe —exactamente lo que
    // pasó en la primera pasada real: 25 × `Key not found`.
    expect(esLlaveDeBucket(ID_CLOUDINARY)).toBe(false);
  });

  it('⛔ una url http nunca es llave', () => {
    expect(esLlaveDeBucket('https://res.cloudinary.com/x/y.pdf')).toBe(false);
    expect(esLlaveDeBucket('')).toBe(false);
    expect(esLlaveDeBucket(null)).toBe(false);
  });

  it('⚠️ un punto en una CARPETA no convierte la llave en válida', () => {
    expect(esLlaveDeBucket('finance/v1.2/supplier-payments/uyil38hglpnz7zarmv8g')).toBe(false);
  });

  it('el motivo distingue las tres ausencias, que no se arreglan igual', () => {
    expect(motivoDeHoja(null)).toBe('sin_hoja');
    expect(motivoDeHoja({ role: 'comprobante', public_id: ID_CLOUDINARY })).toBe('en_cloudinary');
    expect(motivoDeHoja({ role: 'comprobante', public_id: LLAVE_BUCKET })).toBeNull();
  });
});

describe('[AT.1] qué hoja se relee', () => {
  it('la del rol comprobante, no la del gasto', () => {
    const h = hojaRelegible([
      { role: 'gasto', public_id: 'finance/factura.pdf' },
      { role: 'comprobante', public_id: 'finance/spei.pdf' },
    ]);
    expect(h?.public_id).toBe('finance/spei.pdf');
  });

  it('⚠️ devuelve la hoja aunque NO sea del bucket: quien veta es motivoDeHoja', () => {
    // El contrato cambió a propósito. Antes `hojaRelegible` devolvía null y los casos
    // "no está en nuestro bucket" se contaban como `sin_hoja`, o sea mezclados con
    // "nunca adjuntaron nada". Son dos arreglos distintos: migrar vs volver a pedir.
    const h = hojaRelegible([{ role: 'comprobante', public_id: 'https://res.cloudinary.com/x.pdf' }]);
    expect(h).not.toBeNull();
    expect(motivoDeHoja(h)).toBe('en_cloudinary');
  });

  it('⛔ sin public_id no hay hoja: no hay nada que pedirle a nadie', () => {
    expect(hojaRelegible([{ role: 'comprobante', url: 'https://x/y.pdf' }])).toBeNull();
  });

  it('⛔ sin hoja de comprobante no hay nada que releer', () => {
    expect(hojaRelegible([{ role: 'gasto', public_id: 'finance/f.pdf' }])).toBeNull();
    expect(hojaRelegible([])).toBeNull();
    expect(hojaRelegible(null)).toBeNull();
    expect(hojaRelegible('no es un arreglo')).toBeNull();
  });

  it('la forma real de prod: finance/<uuid>.pdf', () => {
    const h = hojaRelegible([{ role: 'comprobante', kind: 'pdf', public_id: 'finance/4f1c-ab.pdf', url: 'https://firmada' }]);
    expect(h?.public_id).toBe('finance/4f1c-ab.pdf');
  });
});

describe('[AT.1] sólo se le manda al modelo lo que sabe leer', () => {
  it('pdf e imágenes pasan', () => {
    expect(tipoLeible('data:application/pdf;base64,AAA')).toBe('application/pdf');
    expect(tipoLeible('data:image/png;base64,AAA')).toBe('image/png');
    expect(tipoLeible('data:IMAGE/JPEG;base64,AAA')).toBe('image/jpeg');
  });

  it('⛔ PRUEBA NEGATIVA: un objeto sin ContentType sale octet-stream y NO se manda', () => {
    // Si esto pasara, el proveedor responde 400 y la falla se leería como
    // "el comprobante es ilegible" — plomería disfrazada de veredicto.
    expect(tipoLeible('data:application/octet-stream;base64,AAA')).toBeNull();
    expect(tipoLeible('data:text/html;base64,AAA')).toBeNull();
    expect(tipoLeible('https://no-es-data-uri')).toBeNull();
    expect(tipoLeible(null)).toBeNull();
  });

  it('el base64 sale sin encabezado', () => {
    expect(base64De('data:application/pdf;base64,SGVsbG8=')).toBe('SGVsbG8=');
    expect(base64De('no soy data uri')).toBe('');
  });
});

describe('[AT.1] ⛔⛔ una lectura vacía NO se persiste', () => {
  it('el retorno de un fallo tragado (todo null) no sirve', () => {
    // Esto es EXACTAMENTE lo que devuelve extractSupplierPayment sin API key,
    // con el modelo caído, o con un PDF que no se pudo decodificar.
    const fallo = {
      monto: null, fecha: null, concepto: null, cuenta_origen: null,
      cuenta_destino: null, beneficiario: null, clave_rastreo: null, banco_destino: null, metodo: null,
    };
    expect(lecturaSirve(fallo)).toBe(false);
    expect(lecturaSirve(null)).toBe(false);
    expect(lecturaSirve(undefined)).toBe(false);
  });

  it('⚠️ un beneficiario suelto NO alcanza: el nombre se adivina, el monto no', () => {
    expect(lecturaSirve({ beneficiario: 'MONDELEZ' } as never)).toBe(false);
  });

  it('cualquiera de los cuatro campos duros alcanza', () => {
    expect(lecturaSirve({ monto: 0 } as never)).toBe(true); // ⚠️ cero es un monto leído
    expect(lecturaSirve({ fecha: '2026-10-01' } as never)).toBe(true);
    expect(lecturaSirve({ concepto: 'PAGO FACTURA' } as never)).toBe(true);
    expect(lecturaSirve({ clave_rastreo: 'MBAN01002' } as never)).toBe(true);
  });
});

describe('[AT.1] qué cambió entre la lectura vieja y la relectura', () => {
  it('idénticas: no cambió nada', () => {
    const v = { monto: '1234.50', fecha: '2026-08-01', cuenta_origen: '1463', beneficiario: 'MONDELEZ' };
    const n = { monto: 1234.5, fecha: '2026-08-01', cuenta_origen: '1463', beneficiario: 'MONDELEZ' };
    expect(camposQueCambiaron(v, n)).toEqual([]);
  });

  it('⚠️ numeric de pg llega como TEXTO y el modelo como número: no es un cambio', () => {
    expect(camposQueCambiaron({ monto: '955249.56' }, { monto: 955249.56 })).toEqual([]);
    expect(camposQueCambiaron({ monto: '100.00' }, { monto: 100 })).toEqual([]);
  });

  it('⚠️ pg devuelve date como objeto Date: no es un cambio', () => {
    // Si esto fallara, TODAS las fechas saldrían como "cambió" y la medición no serviría.
    expect(camposQueCambiaron({ fecha: new Date('2026-08-01T00:00:00Z') }, { fecha: '2026-08-01' })).toEqual([]);
  });

  it('un monto distinto SÍ es un cambio, y se nombra', () => {
    expect(camposQueCambiaron({ monto: '100.00' }, { monto: 100.01 })).toEqual(['monto']);
  });

  it('varios campos a la vez, en orden', () => {
    const v = { monto: '1.00', fecha: '2026-08-01', cuenta_origen: '1463', beneficiario: 'A' };
    const n = { monto: 2, fecha: '2026-08-02', cuenta_origen: '1463', beneficiario: 'B' };
    expect(camposQueCambiaron(v, n)).toEqual(['monto', 'fecha', 'beneficiario']);
  });

  it('un nulo que pasa a tener valor cuenta como cambio', () => {
    expect(camposQueCambiaron({ cuenta_origen: null }, { cuenta_origen: '1463' })).toEqual(['cuenta_origen']);
  });

  it('sólo mira los cuatro campos que deciden', () => {
    expect(CAMPOS_QUE_DECIDEN).toEqual(['monto', 'fecha', 'cuenta_origen', 'beneficiario']);
    // `banco_destino` cambia y no se cuenta: no alimenta ninguna de las cuatro señales.
    expect(camposQueCambiaron({ monto: '1.00' } as never, { monto: 1, banco_destino: 'OTRO' } as never)).toEqual([]);
  });
});

describe('[AT.1] el latido mide ENTREGA (ADR-053)', () => {
  it('⛔ PRUEBA NEGATIVA: revisar 25 y releer 0 es ERROR, aunque no truene nada', () => {
    const r = { ...pasadaVacia(), revisados: 25, releidos: 0 };
    expect(veredictoPasada(r)).toBe('error');
  });

  it('⛔ la cola vacía NO es error: es el estado al que esto tiende', () => {
    expect(veredictoPasada(pasadaVacia())).toBe('ok');
  });

  it('una falla acumulada manda, aunque haya entregado', () => {
    const r = { ...pasadaVacia(), revisados: 10, releidos: 9, errores: ['S3 timeout'] };
    expect(veredictoPasada(r)).toBe('error');
  });

  it('entregar sin fallas es ok', () => {
    expect(veredictoPasada({ ...pasadaVacia(), revisados: 10, releidos: 10 })).toBe('ok');
  });

  it('la nota dice lo entregado Y por qué no se pudo el resto', () => {
    const n = notaPasada({
      ...pasadaVacia(), revisados: 25, releidos: 22, clasificados: 20, validados: 7, cambiaron: 3,
      no_relegibles: { sin_hoja: 1, en_cloudinary: 0, sin_archivo: 0, tipo_no_leible: 0, ilegible: 2 },
    });
    expect(n).toContain('22/25 releidos');
    expect(n).toContain('7 validados solos');
    expect(n).toContain('3 cambiaron de lectura');
    expect(n).toContain('sin releer: sin_hoja 1, ilegible 2');
    // ⛔ Un motivo en cero no se nombra: una lista de ceros esconde al que no lo está.
    expect(n).not.toContain('sin_archivo');
  });
});
