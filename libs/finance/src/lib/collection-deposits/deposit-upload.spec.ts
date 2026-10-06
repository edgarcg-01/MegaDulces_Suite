/**
 * `[CC.20]` — La ficha de depósito se puede **FOTOGRAFIAR**.
 *
 * ── El defecto que esto cierra ────────────────────────────────────────────────────────────
 * `/finanzas/cobranza` ofrece dos botones: «Tomar foto» (`accept="image/*"` con
 * `capture="environment"`) y «Elegir archivo» (`image/*,.pdf`); el rótulo del campo dice
 * literal *«Ficha de depósito (imagen o PDF)»*, la pantalla tiene previsualización `<img>` para
 * imágenes, y el OCR (`extractDepositSlip`) lee las dos. Y aun así `uploadFile` llamaba a
 * `putPdf`, que tira 400 **«Solo se aceptan archivos PDF.»** — o sea que el camino principal,
 * el de quien tiene la ficha del banco en la mano, fallaba siempre.
 *
 * ── Por qué una prueba de ESTO y no del SQL ───────────────────────────────────────────────
 * Lo que falló no fue una consulta: fue una **decisión de ruteo** entre dos métodos del
 * almacenamiento. Eso sí se prueba con un doble, porque lo que se afirma es a cuál se llamó —
 * no que el SQL devuelva lo correcto (para eso está el candado contra la DB).
 *
 * ⛔ **La mitad que importa es la negativa.** Los hermanos rechazan imágenes POR DECISIÓN y no
 * se tocan: la remisión de entradas porque una de tres hojas no se sostiene en fotos sueltas, y
 * el `comprobante` de pago a proveedor porque es el SPEI o el cheque. Si alguien algún día
 * "arregla" los tres de un saque, estas pruebas se ponen rojas.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { CollectionDepositsService } from './collection-deposits.service';

/** Una ficha fotografiada con el celular: JPEG, que es lo que manda `capture="environment"`. */
const FOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';
/** Una ficha escaneada a PDF. `%PDF` en base64 arranca con `JVBER`. */
const PDF = 'data:application/pdf;base64,JVBERi0xLjQKJeLjz9MK';

/**
 * El guardia real de `ObjectStorageService.pdfBase64`, copiado tal cual para poder ejercerlo
 * sin levantar el servicio (que exige credenciales S3). Si alguien cambia el original, lo que
 * se cae es la aserción de abajo que compara los dos comportamientos sobre el mismo insumo.
 */
function soloPdf(dataUri: string): string {
  const raw = dataUri || '';
  const body = raw.replace(/^data:[^,]*,/, '');
  const isPdf = /^data:application\/pdf/i.test(raw) || /^JVBER/i.test(body);
  if (!isPdf) throw new BadRequestException('Solo se aceptan archivos PDF.');
  return body;
}

/** Un doble del almacenamiento: no sube nada, sólo deja constancia de por cuál puerta entró. */
function almacenamiento() {
  return {
    putPdf: vi.fn(async (dataUri: string) => ({ key: `k/${soloPdf(dataUri).slice(0, 4)}.pdf`, kind: 'pdf' as const })),
    putFile: vi.fn(async (dataUri: string) => {
      const ct = (/^data:([^;,]+)[;,]/.exec(dataUri)?.[1] || '').toLowerCase();
      return { key: `k/x.${ct === 'application/pdf' ? 'pdf' : 'jpg'}`, kind: (ct === 'application/pdf' ? 'pdf' : 'image') as 'pdf' | 'image' };
    }),
  };
}

describe('[CC.20] la ficha de depósito acepta foto', () => {
  it('⛔ el guardia de putPdf RECHAZA una foto — es el que rompía la pantalla', () => {
    expect(() => soloPdf(FOTO)).toThrow(/Solo se aceptan archivos PDF/);
  });

  it('…y acepta el PDF, así que el guardia no está roto: discrimina', () => {
    expect(() => soloPdf(PDF)).not.toThrow();
  });

  /*
   * ⭐ Acá se ejerce el SERVICIO REAL, no un doble que se parezca a él. Es la diferencia entre
   * probar que `putFile` acepta imágenes —cierto pero irrelevante— y probar que **cobranza llama
   * a `putFile`**, que es lo único que estaba mal. Con la versión previa de este archivo, revertir
   * la línea del servicio a `putPdf` dejaba la suite en verde.
   */
  const servicio = (s: ReturnType<typeof almacenamiento>) =>
    new CollectionDepositsService(
      null as never, // tk — `uploadFile` no toca la base
      { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c' } as never,
      null as never, // cloudinary (legacy, sin uso en esta ruta)
      s as never,
      null as never, // ocr
      null as never, // readings
    );

  it('cobranza sube la FOTO: llama a putFile, NO a putPdf, y la marca como imagen', async () => {
    const s = almacenamiento();
    const f = await servicio(s).uploadFile(FOTO, 'deposito');
    expect(s.putPdf).not.toHaveBeenCalled();
    expect(s.putFile).toHaveBeenCalledTimes(1);
    expect(f.kind).toBe('image');
    expect(f.role).toBe('deposito');
  });

  it('…y el MISMO camino sigue aceptando PDF: no se cambió una restricción por otra', async () => {
    const s = almacenamiento();
    const f = await servicio(s).uploadFile(PDF, 'deposito');
    expect(f.kind).toBe('pdf');
  });

  it('la evidencia adicional también entra como foto (es el mismo mostrador)', async () => {
    const s = almacenamiento();
    const f = await servicio(s).uploadFile(FOTO, 'evidencia_1');
    expect(f.kind).toBe('image');
  });

  it('NEGATIVA: un role inventado se sigue rechazando — la validación no se aflojó', async () => {
    const s = almacenamiento();
    await expect(servicio(s).uploadFile(FOTO, 'lo_que_sea')).rejects.toThrow(/role inválido/);
    expect(s.putFile).not.toHaveBeenCalled();
  });

  /*
   * ⛔ NEGATIVA: los hermanos NO se tocan. Si estas dos se ponen verdes con una foto, alguien
   * aflojó una restricción que es deliberada y está documentada en su propio servicio.
   */
  it('NEGATIVA: la remisión de entradas sigue rechazando una foto (multi-hoja, a propósito)', async () => {
    const s = almacenamiento();
    await expect(s.putPdf(FOTO)).rejects.toThrow(/Solo se aceptan archivos PDF/);
  });

  it('NEGATIVA: el comprobante de pago a proveedor también (es el SPEI o el cheque)', async () => {
    const s = almacenamiento();
    await expect(s.putPdf(FOTO)).rejects.toThrow(/Solo se aceptan archivos PDF/);
  });
});
