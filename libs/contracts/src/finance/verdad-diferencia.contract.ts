/**
 * ⭐⭐ `[CGS.36]` — **La verdad de cada diferencia, antes de que llegue a la supervisora.**
 *
 * La diferencia de un corte (`contado − esperado`) se calcula con TRES cosas que tecleó una persona
 * —el conteo, el fondo y los movimientos— y una que trae la máquina —las piernas de la caja
 * fuerte—. Si cualquiera de las cuatro está mal, la diferencia miente, y la supervisora firma una
 * cifra que no es.
 *
 * Medido contra prod el 2026-10-21 sobre los 8 cortes: **3 de 8 publican una diferencia que no es
 * la verdadera** (CC-4 +$80,019.86 → +$136,602.36; CC-5 +$94,830.30 → +$49,079.30; CC-7
 * −$209,094.59 → −$188,884.59), 2 se confirman al centavo (CC-6, CC-8) y 3 no tienen testigo.
 *
 * ⚠️ El testigo NO reemplaza a la fórmula (Edgar, 2026-10-20: «el arqueo se compara contra la
 * fórmula»). Audita sus ENTRADAS: ¿el conteo es el que se contó?, ¿el fondo es con el que de
 * verdad abrió?, ¿el libro es el que se selló?, ¿la máquina registró todo lo que se movió?
 */

/** `confirma` = un testigo independiente dice lo mismo · `contradice` = dice otra cosa · `sin_testigo` = no hay con qué comparar. */
export type EstadoTestigo = 'confirma' | 'contradice' | 'sin_testigo';

export interface TestigoDiferencia {
  id: 'conteo' | 'fondo' | 'libro' | 'caja_fuerte';
  pregunta: string;
  estado: EstadoTestigo;
  /** En palabras, con las cifras de los dos lados. */
  detalle: string;
  /** Cuánto mueve la diferencia este testigo (0 si confirma o no tiene testigo). */
  ajuste: number;
}

/**
 * Una PISTA, no una explicación: algo que pasó con el dinero ese día y el libro no tiene. No trae
 * signo porque la fuente no lo dice (un movimiento de Control es un paquete contado, no un asiento
 * de entrada o salida); la caja dice qué fue.
 */
export interface PistaDiferencia {
  fuente: 'control_movimiento' | 'control_cheques' | 'caja_fuerte_fuera';
  folio: string | null;
  hora: string | null;
  monto: number;
  detalle: string;
}

/**
 * `confirmada` = los testigos dicen lo mismo que el corte: la diferencia es real ·
 * `corregida` = algún testigo la mueve: se publicó una y la verdadera es otra ·
 * `sin_confirmar` = falta un testigo o uno contradice sin poder corregir: no se puede afirmar.
 */
export type EstadoVerdad = 'confirmada' | 'corregida' | 'sin_confirmar';

/**
 * ⭐ `[CGS.51]` **La caja entera entre dos arqueos completos.** El cajón solo engaña cuando el
 * dinero cambia de rubro: el 15-oct se vació la caja fuerte y el pago de tarjetas quedó como vale,
 * y el cajón publicó +$136,602.36 cuando la caja entera tenía +$80,485.16. Esto mide lo que cambió
 * TODO (cajón + caja fuerte + cheques y vales + dólares) contra lo que el libro registró en el
 * mismo tramo. Lo que queda es dinero que apareció o se fue sin registro, no un cambio de rubro.
 */
export interface CajaEnteraDto {
  /** Los dos arqueos completos que acotan el tramo: «A23648 · 14-oct 17:51». */
  desde: string;
  hasta: string;
  /** Lo que cambió la caja entera según los dos arqueos. */
  cambio: number;
  /** Lo que el libro dice que entró menos lo que salió en ese tramo. */
  libro: number;
  /** `cambio − libro`: positivo sobra, negativo falta. */
  diferencia: number;
  /** Cuánto cambió cada rubro: dice a dónde se movió el dinero. */
  rubros: Array<{ rubro: 'cajon' | 'caja_fuerte' | 'documentos' | 'dolares'; etiqueta: string; cambio: number }>;
  detalle: string;
}

export interface VerdadDiferencia {
  estado: EstadoVerdad;
  /** `[CGS.51]` La caja entera en el tramo del corte. `null` = no hay dos arqueos completos que lo acoten. */
  caja_entera: CajaEnteraDto | null;
  /** La diferencia sellada en el corte. */
  publicada: number | null;
  /** La que sale con los testigos. Igual a `publicada` si nada la mueve. */
  verdadera: number | null;
  testigos: TestigoDiferencia[];
  pistas: PistaDiferencia[];
  /** Una línea, para la supervisora. */
  resumen: string;
}
