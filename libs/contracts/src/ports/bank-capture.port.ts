// Port de inversión de dependencia (ADR-042, Fase CBW): la ingesta de WhatsApp
// (libs/whatsapp) desvía la foto de un remitente autorizado al flujo de captura
// bancaria SIN importar el dominio finance. El ingest inyecta este token con
// @Optional() (el binding solo existe con ENABLE_MULTITENANT=true) y lo llama
// dentro del scope de tenant (CLS). El binding al servicio real (BankCaptureService)
// se hace en el composition root (app.module), único lugar que conoce ambos lados.
//
// INVARIANTE ADR-016/042: la foto es un COMPROBANTE en staging, NUNCA un asiento
// directo en finance.bank_movements. El motor pone los números (OCR + cuenta),
// el bot solo comunica. El humano valida y cuadra después en /finanzas/bancos.

export const BANK_CAPTURE_PORT = 'BANK_CAPTURE_PORT';

/** Remitente autorizado (allowlist) resuelto por teléfono → identidad para atribuir. */
export interface BankCaptureSender {
  id: string;
  full_name: string;
  sucursal: string | null;
  default_bank_account_id: string | null;
}

/** Resultado de procesar una captura: el texto de respuesta al remitente + id de la fila. */
export interface BankCaptureResult {
  reply: string;
  capture_id: string | null;
}

export interface BankCapturePort {
  /**
   * ¿El teléfono es un remitente autorizado (allowlist activa)? Devuelve su
   * identidad (nombre/sucursal/cuenta default) o null. Es la decisión de RUTEO:
   * solo un remitente resuelto desvía la imagen al flujo bancario. Scope CLS.
   */
  resolveSender(phone: string): Promise<BankCaptureSender | null>;

  /**
   * Procesa una foto/ficha ya descargada: sube a Cloudinary, corre OCR
   * (extractDepositSlip), resuelve la cuenta (OCR banco+últ4 → catálogo → default
   * del remitente) e inserta la captura en staging (`pendiente_confirmacion`).
   * Devuelve el texto a responder ("Leí $X… ¿confirmo? SÍ/NO"). `fileBase64` sin
   * prefijo data:. Scope de tenant (CLS) ya establecido.
   */
  capture(input: {
    fromPhone: string;
    sender: BankCaptureSender;
    waMessageId: string;
    fileBase64: string;
    mime: string;
    caption?: string | null;
  }): Promise<BankCaptureResult>;
}
