/**
 * Inventario de checadores ZKTeco. Editable a mano.
 *
 * `serial` es la identidad estable — la IP cambia y el campo `IPAddress` que
 * reporta el propio equipo NO sirve (varios traen el default de fábrica
 * 192.168.1.201 mientras viven en otra IP). El importer casa por serie: si a un
 * equipo le cambian el IP, se actualiza aquí y el histórico sigue pegado.
 *
 * `label` y `site_code` los llena el operador: el equipo no sabe dónde está.
 *
 * Descubrimiento 2026-08-17: 10 equipos vivos. Los de sucursal se encontraron
 * barriendo UDP 4370 además de TCP (los MB160 viejos contestan por los dos,
 * pero el barrido UDP + broadcast es el que no deja huecos). Subredes reales
 * detectadas por gateway: 0, 11, 13, 30, 32, 40, 42, 44, 50, 54.
 */
module.exports = [
  // ── Matriz / oficinas (subred 192.168.0) ──────────────────────────────
  { ip: '192.168.0.80',   serial: 'UEED255000166', model: 'MB360',    label: null, site_code: null }, //  42 usr /  3,910 logs
  { ip: '192.168.0.81',   serial: 'CLXK233460626', model: 'MB360/ID', label: null, site_code: null }, //  48 usr /  4,010 — misma plantilla que .80 renumerada (+100)
  { ip: '192.168.0.153',  serial: 'CLXK225060395', model: 'MB360/ID', label: null, site_code: null }, //  21 usr / 23,657
  { ip: '192.168.0.196',  serial: 'UEED253600029', model: 'MB360',    label: null, site_code: null }, //  12 usr /  1,314

  // ── Sucursales (vía túnel; latencia 90-130 ms → timeouts holgados) ─────
  { ip: '192.168.32.215', serial: 'UEED255000061', model: 'MB360',    label: null, site_code: null }, //  30 usr /  2,115
  { ip: '192.168.40.12',  serial: 'CEZU201060011', model: 'MB360/ID', label: null, site_code: null }, // 103 usr / 51,818 — el más cargado
  { ip: '192.168.42.37',  serial: 'UEED241600095', model: 'MB360',    label: null, site_code: null }, //  58 usr / 16,892
  { ip: '192.168.44.12',  serial: 'UEED242200104', model: 'MB360',    label: null, site_code: null }, //  16 usr /  7,133
  { ip: '192.168.50.12',  serial: 'CC5B194660472', model: 'MB160',    label: null, site_code: null }, //  95 usr / 10,561 — firmware 2018
  { ip: '192.168.54.10',  serial: 'CC5B194760731', model: 'MB160',    label: null, site_code: null }, //  27 usr /  8,040 — firmware 2018

  // ── Padre Hidalgo (recuperado 2026-08-20) ─────────────────────────────
  // Estaba invisible desde la central porque su GATEWAY estaba mal
  // (0.0.0.0 / 192.168.10.254 = un DNS, no el router). Respondía local pero
  // no podía enrutar la respuesta a través del túnel. Fix: gateway → .10.1
  // (el mismo que usan las PCs de PH). Modelo MB300 (familia distinta).
  { ip: '192.168.10.2',   serial: '3266161700219', model: 'MB300',     label: 'Padre Hidalgo', site_code: null }, // 175 usr / 29,563

  // ── Declarado por el operador pero NO recuperado aún ──────────────────
  // Sucursal 30: la red vive (gateway .30.1 responde) pero el equipo tenía el
  // gateway en 8.8.8.8 (un DNS, no el router). MISMO problema que PH: hay que
  // corregir su gateway a 192.168.30.1 en la pantalla del equipo. Hasta que se
  // haga, no puede contestar a la central. Se deja para que el sync lo reporte.
  { ip: '192.168.30.253', serial: null, model: null, label: null, site_code: null, expected: true },
];
