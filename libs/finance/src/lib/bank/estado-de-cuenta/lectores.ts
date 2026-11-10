import * as ExcelJS from 'exceljs';

/**
 * `[CB.57]` El estado de cuenta tal como lo descarga Tesorería de la banca en línea → movimientos.
 *
 * Reemplaza la captura del libro «CUENTAS» (FASE_CB §8). Los formatos NO se supusieron: salen de
 * las muestras reales del 2026-11-05 (una por banco, guardadas fuera del repo porque es público):
 *
 *   Santander  CSV con coma, valores con apóstrofo, trae la cuenta, hora, referencia, rastreo, RFC.
 *   Banorte    CSV Latin-1 con fin de línea SÓLO CR, «$» en importes, fecha «31/Oct./2026»;
 *              rastreo, CLABE, RFC y referencia vienen DENTRO del concepto. No trae la cuenta.
 *   BBVA       `.exp` de texto con tabuladores, Latin-1, fecha «03-11-2026», del más nuevo al
 *              más viejo. No trae la cuenta.
 *   BanBajío   `.xlsx` con 9 filas de encabezado y TOTALES DECLARADOS (n, cargos, abonos), del
 *              más nuevo al más viejo. Trae el número de cliente, no la cuenta.
 *   Banamex    CSV Latin-1 (muestra del 2026-11-10) con un resumen arriba: la cuenta, saldo inicial
 *              y final, y cuántos depósitos y retiros por cuánto. Del más nuevo al más viejo, y el
 *              SALDO SÓLO EN UN RENGLÓN POR DÍA (el cierre del día); «-» en la columna vacía.
 *
 * El control de que no falta nada es el SALDO del propio banco: saldo anterior + abono − cargo =
 * saldo del renglón. El orden no es fijo entre bancos, así que se prueban los dos y se queda el
 * que encadena. ⛔ Un renglón que no se entiende se REPORTA en `no_leidos`; nunca se tira en
 * silencio (el lector del libro tiró ~82 movimientos así, CB.23).
 *
 * Importes en CENTAVOS enteros: sumar flotantes de pesos rompe el cuadre al centavo.
 */

export type Banco = 'santander' | 'banorte' | 'bbva' | 'banbajio' | 'banamex';

export interface MovimientoBanco {
  /** Renglón del archivo (1 = primera línea), para poder señalarlo en pantalla. */
  linea: number;
  /** YYYY-MM-DD. */
  fecha: string;
  /** HH:MM, si el banco la da. */
  hora: string | null;
  concepto: string;
  cargo_centavos: number;
  abono_centavos: number;
  saldo_centavos: number;
  referencia: string | null;
  clave_rastreo: string | null;
  contraparte_cuenta: string | null;
  contraparte_rfc: string | null;
  contraparte_nombre: string | null;
  /** El renglón tal como venía en el archivo: evidencia, no se interpreta. */
  texto_original: string;
}

export interface RenglonNoLeido {
  linea: number;
  motivo: string;
  texto: string;
}

export interface ControlDeSaldo {
  /** Orden en que venía el archivo; `movimientos` siempre sale del más viejo al más nuevo. */
  orden_original: 'viejo_a_nuevo' | 'nuevo_a_viejo';
  saldo_inicial_centavos: number;
  saldo_final_centavos: number;
  cargos_centavos: number;
  abonos_centavos: number;
  /** Renglones cuyo saldo no es el anterior ± su importe (líneas del archivo). */
  eslabones_rotos: number[];
  cuadra: boolean;
}

export interface TotalesDeclarados {
  movimientos: number | null;
  cargos_centavos: number | null;
  abonos_centavos: number | null;
  /** null = el archivo no declara totales; true/false = coinciden o no con lo leído. */
  coinciden: boolean | null;
}

export interface EstadoDeCuentaLeido {
  banco: Banco;
  /** Número de cuenta si el archivo lo trae; si no, la cuenta se elige al subir. */
  cuenta: string | null;
  /** BanBajío trae el número de cliente en lugar de la cuenta. */
  cliente: string | null;
  movimientos: MovimientoBanco[];
  no_leidos: RenglonNoLeido[];
  /**
   * Renglones que el banco imprime y NO son movimientos (Banamex desglosa el efectivo de un abono
   * en un renglón de $0.00 con la misma autorización). Se declaran; los totales del banco no los cuentan.
   */
  informativos?: RenglonNoLeido[];
  control: ControlDeSaldo | null;
  declarado: TotalesDeclarados | null;
}

const MESES: Readonly<Record<string, string>> = {
  ENE: '01', FEB: '02', MAR: '03', ABR: '04', MAY: '05', JUN: '06',
  JUL: '07', AGO: '08', SEP: '09', SEPT: '09', OCT: '10', NOV: '11', DIC: '12',
};

/** «$1,234.56», «1,234.56», «'520.00», 1234.56 → centavos. null si no es un importe. */
export function aCentavos(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  const t = String(v).replace(/[$,'"\s]/g, '');
  if (t === '') return 0;
  if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return null; // Banamex: «$ +445,755.39»
  return Math.round(Number(t) * 100);
}

/** Santander encierra valores en apóstrofos (`'03112026'`, `'0144…047  '`): se quitan de los dos lados. */
const limpio = (s: unknown) => String(s ?? '').trim().replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim();
const oNulo = (s: string) => (s === '' ? null : s);

/** UTF-8 si se decodifica limpio; si no, Latin-1 (Banorte y BBVA vienen en Latin-1). */
function aTexto(buf: Buffer): string {
  const utf8 = buf.toString('utf8');
  // Un CSV guardado desde Excel arranca con BOM: sin quitarlo, «Cuenta,Fecha…» no empieza con «CUENTA».
  return (utf8.includes('�') ? buf.toString('latin1') : utf8).replace(/^﻿/, '');
}

/**
 * Para el mensaje de «formato no reconocido»: qué ES el archivo, en palabras, para que quien lo subió
 * (y quien tenga que escribir el lector) sepa cuál es sin pedirlo por otro lado.
 */
export function describirArchivo(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'es un Excel viejo (.xls)';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'es un PDF';
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return 'es un Excel (.xlsx) sin la hoja de movimientos de BanBajío';
  const primera = (lineas(aTexto(buf)).find((l) => l.trim() !== '') ?? '').replace(/[^\x20-\x7EÀ-ÿ]/g, ' ').trim();
  // La misma consulta de BanBajío bajada en .txt NO se lee a propósito (2026-11-10): escribe los
  // importes del concepto sin comas de miles («(3175.35)» contra «(3,175.35)» del .xlsx), así que
  // subir los dos formatos metería dos veces cada movimiento de $1,000 o más (119 de 185 en la muestra).
  if (primera.toUpperCase().includes(',CONECTA BANBAJIO,')) return 'es la consulta de BanBajío en .txt: bájala en Excel (.xlsx), que es la que se lee';
  return primera ? `empieza con «${primera.slice(0, 70)}»` : 'está vacío';
}

const lineas = (texto: string) => texto.split(/\r\n|\r|\n/);

/** Coma con comillas dobles (Banorte). */
function partirCsv(linea: string): string[] {
  const out: string[] = [];
  let cur = '';
  let comillas = false;
  for (const ch of linea) {
    if (ch === '"') comillas = !comillas;
    else if (ch === ',' && !comillas) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Reconoce el banco por el contenido, no por el nombre del archivo (el de BBVA se llama `3TI51PYJ.exp`). */
export function detectarBanco(buf: Buffer): Banco | null {
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return 'banbajio'; // zip = .xlsx
  const primera = lineas(aTexto(buf)).find((l) => l.trim() !== '') ?? '';
  const u = primera.toUpperCase();
  if (u.startsWith('CUENTA,FECHA,HORA') && u.includes('CLAVE DE RASTREO')) return 'santander';
  if (u.includes('"MOVIMIENTO"') && u.includes('"RETIROS"') && u.includes('"SALDOS"')) return 'banorte';
  if (u.includes('\t') && u.includes('CONCEPTO / REFERENCIA') && u.includes('SALDO')) return 'bbva';
  if (u.startsWith('MOVIMIENTO DE CUENTA') && aTexto(buf).toUpperCase().includes('DETALLE DE MOVIMIENTOS')) return 'banamex';
  return null;
}

function leerSantander(buf: Buffer): Omit<EstadoDeCuentaLeido, 'control'> {
  const L = lineas(aTexto(buf));
  const enc = L[0].split(',').map((h) => limpio(h).toUpperCase());
  const col = (nombre: string) => enc.indexOf(nombre);
  const c = {
    cuenta: col('CUENTA'), fecha: col('FECHA'), hora: col('HORA'), desc: col('DESCRIPCION'),
    signo: col('CARGO/ABONO'), importe: col('IMPORTE'), saldo: col('SALDO'), ref: col('REFERENCIA'),
    concepto: col('CONCEPTO'), clabe: col('CLABE BENEFICIARIO'), nomBen: col('NOMBRE BENEFICIARIO'),
    ctaOrd: col('CTA ORDENANTE'), nomOrd: col('NOMBRE ORDENANTE'), rfcBen: col('RFC BENEFICIARIO'),
    rfcOrd: col('RFC ORDENANTE'), rastreo: col('CLAVE DE RASTREO'), larga: col('DESCRIPCION LARGA'),
  };
  const movimientos: MovimientoBanco[] = [];
  const no_leidos: RenglonNoLeido[] = [];
  let cuenta: string | null = null;
  for (let i = 1; i < L.length; i++) {
    const texto = L[i];
    if (texto.trim() === '') continue;
    const v = texto.split(',');
    // Sin comillas: una coma dentro de un texto corre todas las columnas. Se reporta, no se adivina.
    if (v.length !== enc.length) { no_leidos.push({ linea: i + 1, motivo: `trae ${v.length} columnas y el encabezado ${enc.length}`, texto }); continue; }
    const f = limpio(v[c.fecha]);
    const imp = aCentavos(v[c.importe]);
    const saldo = aCentavos(v[c.saldo]);
    const signo = limpio(v[c.signo]);
    if (!/^\d{8}$/.test(f) || imp === null || saldo === null || (signo !== '+' && signo !== '-')) {
      no_leidos.push({ linea: i + 1, motivo: 'fecha, importe, saldo o signo ilegible', texto }); continue;
    }
    cuenta ??= oNulo(limpio(v[c.cuenta]));
    const abono = signo === '+';
    movimientos.push({
      linea: i + 1,
      fecha: `${f.slice(4, 8)}-${f.slice(2, 4)}-${f.slice(0, 2)}`,
      hora: oNulo(limpio(v[c.hora])),
      concepto: limpio(v[c.larga]) || limpio(v[c.desc]),
      cargo_centavos: abono ? 0 : imp,
      abono_centavos: abono ? imp : 0,
      saldo_centavos: saldo,
      referencia: oNulo(limpio(v[c.ref])),
      clave_rastreo: oNulo(limpio(v[c.rastreo])),
      // En un abono la contraparte es quien ordena; en un cargo, el beneficiario.
      contraparte_cuenta: oNulo(limpio(v[abono ? c.ctaOrd : c.clabe])),
      contraparte_rfc: oNulo(limpio(v[abono ? c.rfcOrd : c.rfcBen])),
      contraparte_nombre: oNulo(limpio(v[abono ? c.nomOrd : c.nomBen])),
      texto_original: texto,
    });
  }
  return { banco: 'santander', cuenta, cliente: null, movimientos, no_leidos, declarado: null };
}

function leerBanorte(buf: Buffer): Omit<EstadoDeCuentaLeido, 'control'> {
  const L = lineas(aTexto(buf));
  const movimientos: MovimientoBanco[] = [];
  const no_leidos: RenglonNoLeido[] = [];
  for (let i = 1; i < L.length; i++) {
    const texto = L[i];
    if (texto.trim() === '') continue;
    const v = partirCsv(texto);
    const m = limpio(v[0]).match(/^(\d{1,2})\/([A-Za-z]{3,4})\.?\/(\d{4})$/);
    const mes = m ? MESES[m[2].toUpperCase()] : undefined;
    const cargo = aCentavos(v[4]);
    const abono = aCentavos(v[5]);
    const saldo = aCentavos(v[6]);
    if (v.length < 7 || !m || !mes || cargo === null || abono === null || saldo === null) {
      no_leidos.push({ linea: i + 1, motivo: 'fecha, importe o saldo ilegible', texto }); continue;
    }
    const concepto = limpio(v[3]);
    const pesca = (re: RegExp) => oNulo((concepto.match(re)?.[1] ?? '').trim());
    movimientos.push({
      linea: i + 1,
      fecha: `${m[3]}-${mes}-${m[1].padStart(2, '0')}`,
      hora: pesca(/HR LIQ:\s*(\d{2}:\d{2})/),
      concepto,
      cargo_centavos: cargo,
      abono_centavos: abono,
      saldo_centavos: saldo,
      referencia: pesca(/REFERENCIA:\s*(\S+)/) ?? oNulo(limpio(v[1])),
      clave_rastreo: pesca(/CVE RAST:\s*(\S+)/),
      contraparte_cuenta: pesca(/CLABE\s+(\d{18})/),
      contraparte_rfc: pesca(/RFC\s+([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})/),
      contraparte_nombre: pesca(/DEL CLIENTE\s+(.+?)\s+DE LA CLABE/),
      texto_original: texto,
    });
  }
  return { banco: 'banorte', cuenta: null, cliente: null, movimientos, no_leidos, declarado: null };
}

function leerBbva(buf: Buffer): Omit<EstadoDeCuentaLeido, 'control'> {
  const L = lineas(aTexto(buf));
  const movimientos: MovimientoBanco[] = [];
  const no_leidos: RenglonNoLeido[] = [];
  for (let i = 1; i < L.length; i++) {
    const texto = L[i];
    if (texto.trim() === '') continue;
    const v = texto.split('\t');
    const m = limpio(v[0]).match(/^(\d{2})-(\d{2})-(\d{4})$/);
    const cargo = aCentavos(v[2]);
    const abono = aCentavos(v[3]);
    const saldo = aCentavos(v[4]);
    if (v.length < 5 || !m || cargo === null || abono === null || saldo === null) {
      no_leidos.push({ linea: i + 1, motivo: 'fecha, importe o saldo ilegible', texto }); continue;
    }
    const concepto = limpio(v[1]);
    movimientos.push({
      linea: i + 1, fecha: `${m[3]}-${m[2]}-${m[1]}`, hora: null, concepto,
      cargo_centavos: cargo, abono_centavos: abono, saldo_centavos: saldo,
      referencia: oNulo((concepto.match(/\/(\S+)/)?.[1] ?? '')),
      clave_rastreo: null, contraparte_cuenta: null, contraparte_rfc: null, contraparte_nombre: null,
      texto_original: texto,
    });
  }
  return { banco: 'bbva', cuenta: null, cliente: null, movimientos, no_leidos, declarado: null };
}

async function leerBanBajio(buf: Buffer): Promise<Omit<EstadoDeCuentaLeido, 'control'>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0];
  const texto = (x: any): string => limpio(x && typeof x === 'object' && 'richText' in x ? x.richText.map((t: any) => t.text).join('') : x);
  const valores = (r: number) => (ws.getRow(r).values as any[]).slice(1);
  // El valor de una etiqueta del encabezado está en la siguiente celda con contenido.
  const junto = (fila: any[], etiqueta: string) => {
    const i = fila.findIndex((x) => texto(x).toUpperCase() === etiqueta);
    if (i < 0) return undefined;
    return fila.slice(i + 1).find((x) => x !== null && x !== undefined && texto(x) !== '');
  };
  let hRow = 0;
  let cliente: string | null = null;
  const declarado: TotalesDeclarados = { movimientos: null, cargos_centavos: null, abonos_centavos: null, coinciden: null };
  for (let r = 1; r <= Math.min(20, ws.rowCount); r++) {
    const f = valores(r);
    const u = f.map((x) => texto(x).toUpperCase());
    if (u.includes('FECHA MOVIMIENTO')) { hRow = r; break; }
    const cli = junto(f, 'NÚMERO CLIENTE') ?? junto(f, 'NUMERO CLIENTE');
    if (cli !== undefined) cliente = texto(cli);
    const n = junto(f, 'NO. DE MOVIMIENTOS');
    if (n !== undefined) declarado.movimientos = Number(texto(n));
    const cg = junto(f, 'CARGOS TOTALES');
    if (cg !== undefined) declarado.cargos_centavos = Math.abs(aCentavos(typeof cg === 'number' ? cg : texto(cg)) ?? 0);
    const ab = junto(f, 'ABONOS TOTALES');
    if (ab !== undefined) declarado.abonos_centavos = Math.abs(aCentavos(typeof ab === 'number' ? ab : texto(ab)) ?? 0);
  }
  const movimientos: MovimientoBanco[] = [];
  const no_leidos: RenglonNoLeido[] = [];
  if (!hRow) {
    no_leidos.push({ linea: 0, motivo: 'no se encontró el encabezado «Fecha Movimiento»', texto: ws.name });
    return { banco: 'banbajio', cuenta: null, cliente, movimientos, no_leidos, declarado };
  }
  const enc = valores(hRow).map((x) => texto(x).toUpperCase());
  const c = {
    fecha: enc.indexOf('FECHA MOVIMIENTO'), hora: enc.indexOf('HORA'), recibo: enc.indexOf('RECIBO'),
    desc: enc.indexOf('DESCRIPCIÓN') >= 0 ? enc.indexOf('DESCRIPCIÓN') : enc.indexOf('DESCRIPCION'),
    cargo: enc.indexOf('CARGOS'), abono: enc.indexOf('ABONOS'), saldo: enc.indexOf('SALDO'),
  };
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const hm = (d: Date) => d.toISOString().slice(11, 16);
  for (let r = hRow + 1; r <= ws.rowCount; r++) {
    const f = valores(r);
    if (f.every((x) => x === null || x === undefined || texto(x) === '')) continue;
    // La nota al pie del banco («La información contenida en este archivo…») no tiene fecha ni
    // número: es texto, no un movimiento. Lo que sí trae números y no se entiende, se reporta.
    if (!f.some((x) => x instanceof Date || typeof x === 'number')) continue;
    const fe = f[c.fecha];
    const cargo = aCentavos(f[c.cargo] ?? 0);
    const abono = aCentavos(f[c.abono] ?? 0);
    const saldo = aCentavos(f[c.saldo]);
    if (!(fe instanceof Date) || cargo === null || abono === null || saldo === null) {
      no_leidos.push({ linea: r, motivo: 'fecha, importe o saldo ilegible', texto: f.map(texto).join(' | ') }); continue;
    }
    const concepto = texto(f[c.desc]);
    const ho = f[c.hora];
    movimientos.push({
      linea: r, fecha: ymd(fe), hora: ho instanceof Date ? hm(ho) : oNulo(texto(ho)), concepto,
      cargo_centavos: Math.abs(cargo), abono_centavos: Math.abs(abono), saldo_centavos: saldo,
      referencia: oNulo(texto(f[c.recibo])), clave_rastreo: null, contraparte_cuenta: null,
      contraparte_rfc: oNulo(concepto.match(/RFC\s+([A-ZÑ&]{3,4}\s?\d{6}[A-Z0-9]{3})/)?.[1]?.replace(/\s/g, '') ?? ''),
      contraparte_nombre: null,
      texto_original: f.map(texto).join(' | '),
    });
  }
  return { banco: 'banbajio', cuenta: null, cliente, movimientos, no_leidos, declarado };
}

/**
 * Banamex. El banco sólo atestigua el saldo al CIERRE de cada día (un renglón por día) y el saldo
 * inicial y final del resumen. El saldo de los demás renglones se calcula desde el saldo inicial,
 * en el orden del archivo invertido (del más viejo al más nuevo, igual que los días); ⚠️ el orden
 * DENTRO de un día es supuesto, sólo el cierre es del banco. Si el cálculo no llega al cierre que
 * imprime el banco, ese renglón lleva el saldo IMPRESO: la cadena se rompe ahí y `controlarSaldo` lo
 * marca (nunca se ajusta el cálculo para que cuadre).
 */
function leerBanamex(buf: Buffer): Omit<EstadoDeCuentaLeido, 'control'> {
  const L = lineas(aTexto(buf));
  const no_leidos: RenglonNoLeido[] = [];
  const informativos: RenglonNoLeido[] = [];
  const declarado: TotalesDeclarados = { movimientos: null, cargos_centavos: null, abonos_centavos: null, coinciden: null };
  let cuenta: string | null = null;
  let inicial: number | null = null;
  let final: number | null = null;
  let lineaResumen = 0;
  let hRow = -1;
  for (let i = 0; i < L.length; i++) {
    const v = partirCsv(L[i]).map(limpio);
    const u = v.map((x) => x.toUpperCase());
    if (u[0] === 'FECHA' && u.length >= 5) { hRow = i; break; }
    if (u[0] === 'CUENTA') cuenta = oNulo(v[1].replace(/\D/g, ''));
    if (u[0] === 'SALDO INICIAL') { inicial = aCentavos(v[1]); final = aCentavos(v[4]); lineaResumen = i + 1; }
    const n = u[0].match(/^(DEP[OÓ]SITOS|RETIROS) \((\d+)\)$/);
    if (n) {
      declarado.movimientos = (declarado.movimientos ?? 0) + Number(n[2]);
      if (n[1] === 'RETIROS') declarado.cargos_centavos = aCentavos(v[1]); else declarado.abonos_centavos = aCentavos(v[1]);
    }
  }
  const vacio = { banco: 'banamex' as const, cuenta, cliente: null, movimientos: [] as MovimientoBanco[], no_leidos, informativos, declarado };
  if (hRow < 0 || inicial === null) {
    no_leidos.push({ linea: 0, motivo: 'no se encontró el resumen (saldo inicial) o el encabezado «Fecha»', texto: L.slice(0, 3).join(' ') });
    return vacio;
  }
  const importe = (s: string) => (s === '-' ? 0 : aCentavos(s));
  type Renglon = MovimientoBanco & { cierre: number | null };
  const delArchivo: Renglon[] = [];
  for (let i = hRow + 1; i < L.length; i++) {
    const texto = L[i];
    if (texto.trim() === '') continue;
    const v = partirCsv(texto).map(limpio);
    const m = (v[0] ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const abono = importe(v[2] ?? '');
    const cargo = importe(v[3] ?? '');
    const cierre = (v[4] ?? '') === '' ? null : aCentavos(v[4]);
    if (v.length < 5 || !m || abono === null || cargo === null || (v[4] !== '' && cierre === null)) {
      no_leidos.push({ linea: i + 1, motivo: 'fecha, importe o saldo ilegible', texto }); continue;
    }
    if (abono === 0 && cargo === 0) { informativos.push({ linea: i + 1, motivo: 'renglón de $0.00: desglose de otro movimiento', texto }); continue; }
    const concepto = v[1];
    const pesca = (re: RegExp) => oNulo((concepto.match(re)?.[1] ?? '').trim());
    delArchivo.push({
      linea: i + 1, fecha: `${m[3]}-${m[2]}-${m[1]}`, hora: null, concepto,
      cargo_centavos: cargo, abono_centavos: abono, saldo_centavos: 0, cierre,
      referencia: pesca(/Autorizaci\S*n:\s*(\d+)/i), clave_rastreo: null, contraparte_cuenta: null, contraparte_rfc: null,
      contraparte_nombre: null, texto_original: texto,
    });
  }
  // Del más viejo al más nuevo: el saldo corre desde el inicial; al cerrar cada día se compara con el impreso.
  const cronologico = [...delArchivo].reverse();
  let saldo = inicial;
  cronologico.forEach((r, k) => {
    saldo += r.abono_centavos - r.cargo_centavos;
    const ultimoDelDia = k === cronologico.length - 1 || cronologico[k + 1].fecha !== r.fecha;
    const impreso = ultimoDelDia ? cronologico.filter((x) => x.fecha === r.fecha).find((x) => x.cierre !== null)?.cierre ?? null : null;
    if (impreso !== null && impreso !== saldo) saldo = impreso; // la cadena se rompe aquí, a la vista
    r.saldo_centavos = saldo;
  });
  // El primer renglón no tiene anterior con quien romper la cadena: el saldo inicial del resumen se
  // compara aparte con el que deja el primer cierre impreso.
  const primero = cronologico[0];
  if (primero && primero.saldo_centavos - primero.abono_centavos + primero.cargo_centavos !== inicial) {
    no_leidos.push({ linea: lineaResumen, motivo: 'el saldo inicial del resumen no lleva al cierre que imprime el banco', texto: L[lineaResumen - 1] ?? '' });
  }
  if (final !== null && cronologico.length && saldo !== final) {
    no_leidos.push({ linea: lineaResumen, motivo: 'el saldo final del resumen no es el del último movimiento', texto: L[lineaResumen - 1] ?? '' });
  }
  const movimientos = delArchivo.map(({ cierre: _c, ...mov }) => mov);
  return { ...vacio, movimientos };
}

/** Líneas cuyo saldo no encadena con el renglón anterior, en el orden dado. */
function eslabonesRotos(m: MovimientoBanco[]): number[] {
  const rotos: number[] = [];
  for (let i = 1; i < m.length; i++) {
    if (m[i - 1].saldo_centavos + m[i].abono_centavos - m[i].cargo_centavos !== m[i].saldo_centavos) rotos.push(m[i].linea);
  }
  return rotos;
}

/** Ordena del más viejo al más nuevo (el que encadena) y cuadra saldo inicial + movimientos = final. */
export function controlarSaldo(movimientos: MovimientoBanco[]): { movimientos: MovimientoBanco[]; control: ControlDeSaldo | null } {
  if (movimientos.length === 0) return { movimientos, control: null };
  const tal = eslabonesRotos(movimientos);
  const inverso = [...movimientos].reverse();
  const rotosInv = eslabonesRotos(inverso);
  // Empate (p. ej. un solo renglón): se respeta el orden del archivo.
  const alReves = rotosInv.length < tal.length;
  const orden = alReves ? inverso : movimientos;
  const rotos = alReves ? rotosInv : tal;
  const primero = orden[0];
  const cargos = orden.reduce((s, x) => s + x.cargo_centavos, 0);
  const abonos = orden.reduce((s, x) => s + x.abono_centavos, 0);
  const inicial = primero.saldo_centavos - primero.abono_centavos + primero.cargo_centavos;
  const final = orden[orden.length - 1].saldo_centavos;
  return {
    movimientos: orden,
    control: {
      orden_original: alReves ? 'nuevo_a_viejo' : 'viejo_a_nuevo',
      saldo_inicial_centavos: inicial, saldo_final_centavos: final,
      cargos_centavos: cargos, abonos_centavos: abonos,
      eslabones_rotos: rotos,
      cuadra: rotos.length === 0 && inicial + abonos - cargos === final,
    },
  };
}

/**
 * Lee un estado de cuenta descargado de la banca. `null` si el formato no es de ningún banco
 * conocido: quien sube recibe «formato no reconocido», nunca un estado de cuenta vacío.
 */
export async function leerEstadoDeCuenta(buf: Buffer): Promise<EstadoDeCuentaLeido | null> {
  const banco = detectarBanco(buf);
  if (!banco) return null;
  const leido = banco === 'santander' ? leerSantander(buf)
    : banco === 'banorte' ? leerBanorte(buf)
      : banco === 'bbva' ? leerBbva(buf)
        : banco === 'banamex' ? leerBanamex(buf)
          : await leerBanBajio(buf);
  const { movimientos, control } = controlarSaldo(leido.movimientos);
  const declarado = leido.declarado;
  if (declarado && control && (declarado.movimientos !== null || declarado.cargos_centavos !== null || declarado.abonos_centavos !== null)) {
    declarado.coinciden =
      (declarado.movimientos === null || declarado.movimientos === movimientos.length) &&
      (declarado.cargos_centavos === null || declarado.cargos_centavos === control.cargos_centavos) &&
      (declarado.abonos_centavos === null || declarado.abonos_centavos === control.abonos_centavos);
  }
  return { ...leido, movimientos, control, declarado };
}
