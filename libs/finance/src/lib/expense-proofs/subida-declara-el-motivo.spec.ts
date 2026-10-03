import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[GX.64]` — **La subida que falla tiene que decir POR QUÉ.**
 *
 * Reportado por el usuario (2026-10-03), textual de la pantalla:
 *
 *     No se pudo subir el archivo («WhatsApp Image 2026-09-28 at 2.05.02 PM.jpeg»):
 *     no se pudo subir el archivo
 *
 * La misma frase dos veces: el cliente antepone la suya y el servidor devolvía exactamente
 * la misma. Cero información.
 *
 * ## ⛔ Por qué esto importa más de lo que parece
 * `[GX.37]` ya había abierto el canal: el `motivo` del servidor **viaja** hasta la pantalla.
 * Lo que faltaba era que el servidor pusiera uno. El canal existía y llegaba vacío — que es
 * la peor versión, porque parece resuelto.
 *
 * Y la causa real **sí se conocía**: el servicio la escribe en el log del servidor. O sea que
 * diagnosticar una subida fallida exigía acceso al servidor. Con el motivo en pantalla, una
 * captura alcanza.
 *
 * ## Por qué un candado de TEXTO
 * El `catch` envuelve una llamada al bucket. Montar un S3 falso probaría al SDK de AWS, no la
 * regla. Lo que hay que impedir es que alguien «simplifique» el mensaje y el canal vuelva a
 * quedar mudo — porque la pantalla se sigue viendo igual.
 */
const soloCodigo = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8'));

/** El traductor real, extraído del archivo para ejercitarlo sin arrancar Nest. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const motivo: (e: any) => string = (() => {
  const src = readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8');
  const i = src.indexOf('function motivoDeAlmacenamiento');
  if (i < 0) throw new Error('motivoDeAlmacenamiento no existe en el servicio');
  const fin = src.indexOf('\n}', i);
  // ⚠️ La firma se recorta con un patron TOLERANTE AL TIPO. Antes exigia literalmente
  //    `(e: any): string {` y por eso cambiar `any` por `unknown` -- un arreglo correcto, pedido
  //    por el propio boundary gate -- dejaba la firma adentro del cuerpo y `new Function` moria
  //    con `Unexpected token ':'`. Una prueba que se rompe cuando el codigo MEJORA esta midiendo
  //    el texto, no el comportamiento.
  const cuerpo = src.slice(i, fin + 2).replace(/^function motivoDeAlmacenamiento\([^)]*\)\s*:\s*string\s*\{/, '');
  // eslint-disable-next-line no-new-func
  return new Function('e', cuerpo.replace(/\}\s*$/, '')) as (e: unknown) => string;
})();

describe('[GX.64] la subida fallida declara su causa', () => {
  /** ⭐ La frase repetida que vio el usuario no puede volver. */
  it('⛔ el servidor ya NO devuelve la misma frase que el cliente', () => {
    const cuerpo = SERVICIO.slice(SERVICIO.indexOf('async uploadFile('));
    expect(cuerpo).not.toMatch(/BadRequestException\('no se pudo subir el archivo'\)/);
    expect(cuerpo).toContain('motivoDeAlmacenamiento(e)');
  });

  /** La falla de configuración seguía viajando bien: no se rompió al arreglar la otra. */
  it('el 400 de «no configurado» se sigue re-lanzando tal cual', () => {
    const cuerpo = SERVICIO.slice(SERVICIO.indexOf('async uploadFile('));
    expect(cuerpo).toContain('if (e?.status === 400) throw e;');
  });

  /** Y la causa se sigue guardando en el log, que es donde cabe el detalle completo. */
  it('la causa completa queda en el log del servidor', () => {
    const cuerpo = SERVICIO.slice(SERVICIO.indexOf('async uploadFile('));
    expect(cuerpo).toContain('this.logger.error(');
  });

  describe('qué dice cada clase de falla', () => {
    /**
     * ⭐ Lo accionable no es el código del error: es **si reintentar sirve**. Mandar a
     * reintentar algo que no se arregla reintentando deja a la persona en un lazo dándole al
     * botón — la lección que `[GX.37]` ya pagó.
     */
    it('una caída de red dice que NO se arregla reintentando', () => {
      const m = motivo({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8333' });
      expect(m).toContain('no se pudo conectar');
      expect(m).toContain('no se arregla reintentando');
    });

    it('una credencial rechazada se nombra como configuración', () => {
      for (const e of [{ Code: 'InvalidAccessKeyId' }, { Code: 'SignatureDoesNotMatch' }, { $metadata: { httpStatusCode: 403 } }]) {
        expect(motivo(e), JSON.stringify(e)).toContain('credenciales');
      }
    });

    it('el bucket que no existe se nombra', () => {
      expect(motivo({ Code: 'NoSuchBucket' })).toContain('bucket');
    });

    it('el archivo demasiado grande se distingue de un fallo', () => {
      expect(motivo({ $metadata: { httpStatusCode: 413 } })).toContain('demasiado grande');
    });

    /**
     * ⛔ **La prueba que sostiene el cambio.** Lo que no se reconoce NO puede volver a ser
     * una frase vacía: se declara con su nombre técnico, que es más que nada (ADR-056).
     */
    it('⭐ lo desconocido se DECLARA, no se calla', () => {
      const conNombre = motivo({ name: 'WeirdSdkError' });
      expect(conNombre).toContain('WeirdSdkError');

      const sinNada = motivo({});
      expect(sinNada).toContain('sin causa declarada');
      // ⛔ Y en ningún caso repite la frase del cliente.
      for (const m of [conNombre, sinNada]) expect(m).not.toBe('no se pudo subir el archivo');
    });

    /** ⚠️ Nunca se vuelca el error crudo: trae el endpoint y el bucket. */
    it('no filtra el endpoint ni el bucket a la pantalla', () => {
      const m = motivo({ Code: 'AccessDenied', message: 'https://s3.interno.mega/tm-prod rechazó la firma' });
      expect(m).not.toContain('s3.interno.mega');
      expect(m).not.toContain('tm-prod');
    });
  });
});
