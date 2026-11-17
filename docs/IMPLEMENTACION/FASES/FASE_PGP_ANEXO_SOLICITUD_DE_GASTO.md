<!-- INDICE-AUTO:INICIO -->

> **Índice navegable** — 101 KB, 1220 líneas, 17 secciones.
> ⛔ **No intentes leer este archivo entero: no cabe en una ventana de contexto.**
> Buscá tu tema acá y leé sólo ese tramo: `sed -n 'DESDE,HASTAp' docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md`.
> Lo genera `npm run docs:indices` — no lo edites a mano.

| Desde | Hasta | KB | Sección |
|---:|---:|---:|---|
| 29 | 64 | 3 | Fase PGP · Anexo S — La solicitud de gasto nace en la Suite y se escribe en Kepler |
| 65 | 77 | 1 | 1. El pedido, literal |
| 78 | 93 | 1 | 2. Lo que ya existe: falta sólo la primera pieza |
| 94 | 175 | 6 | 3. Lo que dicen las solicitudes (12,744 desde dic-2025) |
| 176 | 194 | 1 | 4. Qué es una X-A-15 dentro de Kepler (lo que hay que escribir) |
| 195 | 337 | 9 | 5. El escritor (C1–C2) |
| 338 | 351 | 1 | 6. Alcance v1 y lo que no entra, con su dueño (DS3) |
| 352 | 431 | 6 | 7. El proceso propuesto: la Suite llena, la persona valida |
| 432 | 493 | 4 | 8. Plan por capas y orden de entrega |
| 494 | 521 | 2 | 9. Pruebas (cada compuerta con su prueba negativa) |
| 522 | 549 | 4 | 10. Decisiones |
| 550 | 565 | 1 | 11. Riesgos y NO MEDIDO |
| 566 | 594 | 2 | 12. Hallazgos fuera de alcance, con su dueño |
| 595 | 620 | 5 | 13. Construcción — lo que ya está y lo que es de Edgar |
| 621 | 859 | 23 | 14. S.13 — La bandeja de facturas del SAT por registrar |
| 860 | 995 | 13 | 15. S.17 — El orden del formulario: base, proveedor y sus facturas, y al final cómo se paga |
| 996 | 1249 | 18 | 16. Revisión del plan antes de encender (2026-11-17) |

<!-- INDICE-AUTO:FIN -->
# Fase PGP · Anexo S — La solicitud de gasto nace en la Suite y se escribe en Kepler

> Anexo de [`FASE_PGP_PAGO_A_PROVEEDOR.md`](FASE_PGP_PAGO_A_PROVEEDOR.md). Propone el objetivo **O9** y el
> item **`[PGP.122]`** con sub-items `S.1`–`S.16` (número a confirmar con el PM: el máximo medido en
> `origin/main` es PGP.121). Decisiones **DS1–DS16** (§10). Lo pidió Francisco el 2026-11-14.
> Todas las cifras son de prod en sólo lectura del 2026-11-14 y las revisó un segundo medidor
> independiente; las que no, dicen «sin verificador».

```
OBJETIVO: que un gasto se capture UNA vez, en la Suite, y que al firmarlo Kepler reciba su solicitud
          X-A-15 escrita como la escribe Kepler, ya autorizada y ligada a su vale. Nadie la vuelve
          a teclear.
MÉTRICA:  HOY (30 días por fecha de captura, 15-oct → 13-nov, solicitudes vivas, 9 sucursales):
          · 1,394 X-A-15; 960 dentro del alcance v1 (§6), por $5.07 M;
          · 906 de esas 960 (94.4 %) se teclearon DOS veces: en Kepler y, una mediana de 9.4 min
            después, como vale en la Suite;
          · X-A-15 escritas por la Suite: 0 (ninguna con c67 = 'SUITE').
          MÉTRICA PRINCIPAL: X-A-15 del alcance v1 con c67 = 'SUITE' / X-A-15 del alcance v1, 30 días,
          por sucursal piloto. HOY: 0 %. → META (a firmar, DS14): ≥ 80 % a 30 días de encender.
          MÉTRICA DE AUTOMATIZACIÓN: campos que la Suite llenó sola y la persona aceptó sin cambiarlos /
          campos de la solicitud. HOY: 0 % (en Kepler todo se teclea). → META: se fija con el piloto.
PRINCIPIO: la Suite LLENA y la persona VALIDA (Francisco, 2026-11-14). Sólo se pregunta lo que ninguna
          fuente puede contestar, y cada dato dice de dónde salió (§7).
CAPA TOPE: C3 en /finanzas/gastos y /finanzas/aprobacion-gastos, que ya existen (cero rutas nuevas)
ÁREA:      Finanzas (Tesorería) · Contabilidad (catálogo, clase fiscal) · Sucursales (quien gasta)
DUEÑO:     a firmar (DS1; PGP dice «por asignar»)
ESTADO:    ⬜ plan — no abre fase (6 fases 🔨 contra un cupo de 4). El MVP-0 (§8) no escribe en Kepler
           y se puede empezar sin decidir nada de este anexo, salvo el dueño.
           Firmadas por Francisco el 2026-11-14: DS3 (alcance v1), DS15 (las dos fechas) y el principio
           de automatización. Encomienda de Edgar a Francisco (2026-11-14): se construye todo hasta
           escribir en Kepler y Edgar hace la configuración final de cada servidor (§13).
           🔨 2026-11-15: escritor, servicio, API, migración y pruebas EN CÓDIGO (§13); falta la UI.
           🚀 2026-11-17: código (#546, #547) y migraciones EN PROD, los 9 interruptores APAGADOS. Antes
           de encender, leer la revisión de §16: el lazo de la cancelación (R1) no existe en el código.
```

## 1. El pedido, literal

> «Solicitud de gasto: ahora vamos a llevar a la nube la solicitud de gastos. ¿Qué propones para que se
> conecte con lo que ya está en la nube, que se haga ya desde la Suite, desde escribir en Kepler el inicio
> de los gastos? Haz un análisis profundo de las solicitudes existentes, y cómo mejoramos este
> proceso.» — Francisco, 2026-11-14, con la captura de *Operación › Gastos › Consulta sol gasto*
> (`MD_Gastos.kpl`, Sucursal Morelia Abastos, `XA1501-0000418`, ya autorizada).

**Cómo cambia (la tesis de este anexo).** La pantalla de Kepler no se copia. La solicitud y el vale ya
son **el mismo acto**: hoy se capturan dos veces con 9 minutos de diferencia. La Suite captura una vez
y **al firmar** escribe la X-A-15 en Kepler **en `A`**. Desde ahí todo sigue igual: Finanzas aplica el
X-A-10, el Calendario o la Ventanilla pagan y el cierre GX.85 cierra el vale.

## 2. Lo que ya existe: falta sólo la primera pieza

| # | Etapa | Dónde vive hoy | Medido |
|---|---|---|---|
| 1 | Pedir | papel o verbal; ningún sistema lo registra | — |
| 2 | **Solicitud X-A-15** | **Kepler, 100 %**: el vale exige folio (`expense-proofs.service.ts:964`) | 0 escritas por la Suite |
| 3 | Vale (evidencia) | Suite, `/finanzas/gastos` → `finance.expense_proofs` | 92.9 % de las solicitudes desde el 1-oct tienen vale (1,906 de 2,051) |
| 4 | Firma = autorización | Suite, `/finanzas/aprobacion-gastos`; `[PGP.79]` escribe `kdm1.c43 N→A` | **encendido** desde el 6-nov 18:15: 353 `escrito`, 1 `no_escrito`, 0 `ya_estaba`; 98.1 % de lo autorizado desde el 7-nov lo autorizó la Suite |
| 5 | Gasto X-A-10 (A→F) | Kepler, a mano (8 tablas) | firma → gasto: mediana 14.2 h, p90 46 h |
| 6 | Pago | Kepler (X-D-26/25); la Suite lo lee | Calendario: 63 de 1,829 vales con gasto (3.4 %); `[PGP.106]` aún no escribe gastos |
| 7 | Comprobación CFDI | nadie | 0 ligas; 2,032 de 2,041 vales quedan `no_comprobable` (GX.19 fija ese valor) |
| 8 | Presupuesto | PU ve el X-A-10 después del hecho (`analytics.expense_entries`) | 0 reservado y 0 comprometido al pedir o firmar |

**Dónde se conecta la solicitud nacida en la Suite:** antes del `create()` del vale. Hay precedente para
cada pieza del escritor (§5): ADR-092, `[CB.62]`, `[PGP.106]` y `[PGP.79]`.

## 3. Lo que dicen las solicitudes (12,744 desde dic-2025)

Universo: `kdm1` con X·A·15·1 y **`sucursal = c1`**. Las 166 filas restantes son réplicas históricas
(03←02, 01←00). El ODS trae el ejercicio Kepler 2026: son ~10.5 meses. Las sucursales 01 y 04–08 sólo
tienen historia propia desde el corte del 1-oct.

### 3.1 Volumen y forma
- **~1,200 solicitudes y ~$8.4 M al mes.** Desde octubre las sucursales ya capturan **la mitad del
  dinero** ($3.97 M contra $4.06 M de 00 en octubre). 00 llegó a 192 en un solo día.
- **Cola larga de importes:** el 63 % son de menos de $2,000 y mueven el 5.1 % del dinero. Las 126 de
  $100 k o más mueven el 37.8 %, y casi la mitad de eso es nómina.
- **No es un gasto ad hoc:** la nómina (GN001) es el **31 % del dinero**, y por la X-A-15 también pasan
  SUA, impuestos (761–763), activo fijo (150) y capital de créditos (210). Las comisiones bancarias (GB)
  son el 29.5 % de los documentos de la cadena y el 3.3 % del dinero (6.5 pagos por gasto).
- **Es recurrente:** 28 acreedores aparecen los 10 meses y suman el 52.8 % de las solicitudes. Para un
  acreedor específico, el concepto más usado acierta el 73.4 %.

### 3.2 Tiempos: el cuello es el registro, no la autorización
| Tramo | Mediana | p90 |
|---|---:|---:|
| solicitud → vale en la Suite | 9.4 min | — |
| vale → firma (que ES la autorización en Kepler) | 5.8 h | 21.4 h |
| firma → gasto X-A-10 | 14.2 h | 46 h |
| solicitud → **salida del dinero** (`c9` del pago = fecha del banco en el 97.2 %) | **1 día** | 16 días |
| salida del dinero → pago **registrado** en Kepler | **~6 días** | 21 días |

El dinero sale rápido; lo que tarda es el papeleo detrás. Por eso **el siguiente anexo es el escritor
del X-A-10** (§8, «después»), no la firma.

### 3.3 ⭐ El modo dominante es «registrar lo ya gastado», no «pedir antes de gastar»
- El dinero salió **antes de que existiera la solicitud** en el 24.5 % de los casos: GB 74.9 %, nómina
  30.7 % y resto 15.4 % (cota baja: en efectivo de sucursal el X-D-26 es la reposición posterior).
- Desde octubre, **1,415 de 2,005 vales ya traen comprobante** al subirse; sólo 590 traen cotización
  (sin verificador).
- Consecuencia de diseño: la puerta principal es **«Registrar un gasto»** y «Pedir un gasto» es la
  segunda (DS4).

### 3.4 Basura y estados que mienten
- **1,013 solicitudes N/A sin gasto y con más de 30 días, por $4.71 M** (con sólo `c16`: $3.65 M). Del
  dinero que llega a gasto, el 99.1 % lo hace en ≤ 30 días, así que esto no es cola: son abandonadas.
  El 42 % de las N viejas de 00 son comisiones bancarias.
- **518 solicitudes A de 00 ya se ejecutaron** (gasto vivo, saldo ≈ 0), pero Kepler no las pasó a F.
  Además hay 13 N con gasto vivo y 41 gastos colgados de solicitudes canceladas: **~583 solicitudes cuyo
  `c43` no dice lo que pasó.** El estado se deriva de la cadena, no de `c43` (§5.6).
- **Kepler no hace cumplir la autorización:** se puede aplicar una N. Y la Suite tiene 60 vales que
  cerró GX.85 sin firma humana.
- **Cancelar:** 672 (5.3 %), sin motivo. **`c68/c69` se reescriben al cancelar**: son la fecha de la
  cancelación, no la de captura (corrige el «no hay fecha de cancelación» de docs anteriores). Cancelar
  pone `c16 = c42 = 0`. ~1 de cada 4 canceladas es una corrección recapturada (exceso de 22–24 pp
  sobre el placebo).
- **43 vales validados con la solicitud cancelada en Kepler ($336,933)**: la Suite no se entera de una C.
  Hay 5 rechazados que siguen en N y 8 que terminaron en F ($15.5 k): rechazar no cancela (PGP.79 D2).

### 3.5 Calidad del contenido (renglones `kdm6`)
- **La cuenta sale del concepto:** 97.6 % de los renglones usan la cuenta del catálogo `kdco` de su
  servidor. Pero **hay 9 catálogos, uno por servidor, y 69 códigos difieren**. Por configuración, el
  concepto **074 CAPITÁN DE MARCA va a la cuenta 102 (caja y bancos) en 01, 06, 07 y 08** (82 renglones,
  $29,050). `kdco` y `kdcp` son fotos actuales: SUA pasó por tres cuentas en bloques limpios, así que lo
  que parece error de captura en lo viejo es un cambio de catálogo.
- **Proyecto o depto inválido:** 751 y 503 renglones en 12 meses. Bajó de 12.4 % a **1.2 % desde
  febrero**. En enero, 305 renglones de 2026 usaron proyectos `-25-`: **el cambio de año es el riesgo.**
- **Lo que debería ser dato vive en texto:**
  - el texto del renglón es el nombre del concepto en el 91.5 %;
  - en los comentarios, 28.9 % traen periodo («del 28 sep al 04 oct»), 16.9 % unidad o vehículo (sólo 94 citan una placa del catálogo) y 350 «FISCAL / NO FISCAL».
- **Acreedor:** el destinatario copia su nombre en el 95.9 % y el RFC está vacío en el 64 %. La clave
  codifica la clase (`GF*` trae RFC en el 95.5 %, `GNF*` en 0 %), y 992 `GF*` no desglosan IVA
  ($2.94 M). Retenciones: 1 en 12 meses; honorarios X-A-15-2 y moneda distinta de PESOS: 0.
- **Duplicados probables:** mismo día, misma sucursal, acreedor, importe, renglones y comentario: 83
  pares contra 14 del placebo (exceso ≈ 69, ~$173 k). De 1 a 3 días es ruido.
- **Fraccionamiento:** 307 grupos acreedor-día cruzan $10 k. Pero no hay amontonamiento bajo el umbral
  (39 entre $9.5 y $10 k contra 58 entre $10 y $10.5 k): es estructural, una solicitud por ticket o
  carga, no evasión.

### 3.6 Quién
- **`c48` «solicita» ya es el username de la Suite** en 2,151 de 2,327 solicitudes desde octubre, y
  coincide con quien sube el vale en 2,023 de 2,027. El «0.0 % usernames» de GX.39.1 quedó rancio.
- `c30` «autoriza» es texto libre (183 valores, 44 variantes de FINANZAS). **Kepler no guarda quién ni
  cuándo autoriza**: ese rastro vive sólo en la Suite.
- **La firma está concentrada:** `FINANCE_EXPENSES_COMPROBAR` lo tiene el rol tesorería (2 personas),
  más 4 por persona y god-mode. Desde el 7-nov firmó **una sola persona en 6 de 7 días** (hasta 81 firmas
  en un día).

## 4. Qué es una X-A-15 dentro de Kepler (lo que hay que escribir)

- **Sólo `kdm1` + `kdm6`:**
  - no genera `kdxe` (0 de 11,444 CxP son X-A-15), póliza (0 renglones en `kdc22610/11`), `kdm2`, `kdm5` ni XML;
  - hipótesis de lo que toca crearla: `kdm1` + `kdm6` + el contador `sqliov`. La lista cerrada sale de la captura de prueba (§8, S.1).
- **`kdm1`:** de 200 columnas (todas NOT NULL), sólo 23 varían; 8 son constantes (X/A/15/1, PESOS, `Sol`,
  paridad 1, `XA1501-`) y 169 están vacías o en cero en el 100 % de 5,224 solicitudes.
  `c16 = Σ kdm6.c11 + c14 − c15` en el 99.6 %. El IVA va en la cabecera y no se deriva: es 16 % exacto
  sólo en 1,065 de 1,552.
- **`kdm6`:** 18 columnas, todas conocidas; se construyen enteras.
- ⭐ **Lo que escribe la Suite es la contabilidad del gasto.** El X-A-10 copia los renglones de la
  solicitud (concepto, proyecto, depto, importe, en orden) en el 99.5 %, y su importe (±$1) en 10,223 de
  10,290. Si la Suite escribe el importe de una cotización, el gasto lo hereda salvo que Finanzas lo edite
  al aplicar. Cuánto difiere hoy la cotización del comprobante es NO MEDIDO.
- ⭐⭐ **`md.sqliov` es el contador de folios de Kepler.** La llave es `KF` + tipo + serie + `.` +
  sucursal, y `c4` es el siguiente folio. Para `KFXA1501` y `KFXA1001` vale MAX(c6)+1 en **9 de 9**
  servidores; los folios X-A-15 no tienen huecos. **ADR-092 regla 2 («no hay contador que tocar») revisó
  `kdfolio`, no `sqliov`, y queda refutada** (ver H1 en §12: ya está dañando la requisición).

## 5. El escritor (C1–C2)

### 5.1 Cuándo y en qué estado: al firmar, directo en `A` (DS2)
| | (a) al pedir, en N; la firma hace N→A | **(b) al firmar, directo en A** ⭐ |
|---|---|---|
| Escrituras por solicitud | INSERT + UPDATE | INSERT |
| Rechazo en la Suite | hay que cancelar en Kepler (KR.7 sin probar) | nunca llega a Kepler |
| Abandonadas | vuelven las N viejas (1,013 por $4.71 M) | no existen |
| Aplicar sin firma | sigue siendo posible (13 N con gasto hoy) | imposible: el documento no existe antes |
| Folio de Kepler | inmediato | tras la firma (mediana 5.8 h); mientras tanto, la clave de la Suite |

Lo de (b) ya es la práctica: desde el 7-nov la firma de la Suite **es** la autorización en el 98.1 %, y
nadie en Kepler actúa sobre una N (0 `ya_estaba`). PGP.79 probó que Kepler aplica un documento cuyo único
cambio fue `c43 → A` (245 de 353 ya están en F). Lo que no está probado es que aplique y cancele uno
**insertado** en A: eso lo prueba el canario (S.10).

### 5.2 Cabecera y renglones
Se clona la plantilla del servidor con `clonarFila` (`kepler-pago-sink.adapter.ts:77-83`) y se pisan
sólo estas columnas:

| Col | Valor | Regla medida |
|---|---|---|
| `c6` | folio | §5.3 |
| `c9` | **fecha de solicitud**: el día en que se registró o pidió en la Suite | DS15. Kepler la muestra como «Fecha»; no se retrofecha: hoy 184 vigentes traen más de 30 días de desfase contra su folio |
| `c10` | acreedor | debe existir en `kdxd` de ESE servidor, leído en vivo |
| `c11` | **folio del comprobante** (CFDI serie-folio o folio del ticket, ≤ 20) | ya es el uso de hoy (82 % lleno, p. ej. «F-393/7537»); el X-A-10 lo hereda en el 99.7 % |
| `c14` / `c15` | IVA del comprobante / 0 | con retención, v1 la rechaza y se captura en Kepler |
| `c16` / `c42` | Σ renglones + IVA / igual a `c16` | se exige al centavo |
| `c18` | fecha de pago: cuándo se necesita, o `c9` | ⛔ no se usa para otra cosa: el X-A-10 la copia y se vuelve el vencimiento de la CxP (`kdxe.c10`) en 4,284 de 4,284, que es lo que lee el Calendario |
| `c22` / `c32` | `kdxd.c10` / `kdxd.c3` | 1,914 de 1,924 / 97.9 % |
| `c24` | comentario armado por la Suite (concepto + periodo o unidad, ≤ 60) | hoy se teclea; 28.9 % trae periodo y 16.9 % unidad |
| `c25` | **fecha del documento que ampara**: `AMPARA <CFDI\|TICKET> <folio> DEL dd/mm/aaaa` (≤ 60) | DS15. Kepler no tiene campo de fecha para el comprobante (§5.2.1); el X-A-10 hereda `c25` en 496 de 496 |
| `c26` | **marca `SUITE SG-<id>`** | hoy ocupada en el 3.1 % (DS10) |
| `c30` | `FINANZAS` | 85 % hoy; quién firmó vive en la Suite |
| `c43` | `A` | DS2 |
| `c48` | username de quien pide (≤ 50) | ya es la práctica (§3.6) |
| `c67` / `c68` / `c69` | `SUITE` / fecha MX / `HH:MM` | igual que KR, PGP.106 y CB.62 |
| `c90` | `FORMAS_PAGO.codigo_kepler` | 07 y 98 siguen sin decodificar: no se escriben |

Renglones `kdm6`, construidos enteros:
- `c7` = 1..n;
- `c8` = `kdco.c3` del concepto en ese servidor;
- `c9` = nombre del concepto (≤ 30);
- `c10` = `C`;
- `c11` = subtotal;
- `c12` concepto, que debe tener cuenta (113 entradas de `kdco` no la tienen);
- `c13` proyecto activo y del año de `c9`;
- `c16` depto en `kdc3`;
- `c14`/`c15` vacías y `c17`/`c18` en 0.

#### 5.2.1 Las dos fechas (DS15, Francisco 2026-11-14)
La solicitud lleva **fecha de solicitud** y **fecha del documento que ampara el gasto**. Medido en
`kdm1`, Kepler sólo tiene dos fechas útiles en esta pantalla, y ninguna es la del comprobante:
- **«Fecha» (`c9`)**: va la **fecha de solicitud**.
- **«Fecha de pago» (`c18`)**: está ocupada. El X-A-10 la copia y la convierte en el vencimiento de su
  CxP (4,284 de 4,284).
- Las otras columnas de fecha (`c41`, `c91`, `c101`, `c188`, `c191`, `c195`, `c197`) son centinelas
  (`1800-01-01` en la solicitud y `2000-01-01` en el gasto). Kepler no las muestra.

Por eso la fecha del comprobante va en un renglón de comentario con formato fijo (`c25`), y su folio en
la referencia (`c11`). Así:
- quien abre la solicitud en Kepler ve las dos fechas;
- el X-A-10 las hereda solo (`c11` en 99.7 %, `c25` en 496 de 496);
- la Suite guarda las dos como columnas propias (`requested_at`, `document_date`), con el UUID del CFDI
  cuando lo hay (Kepler no tiene dónde guardarlo).

⚠️ La fecha que manda en la contabilidad es la del X-A-10, que es la de su póliza. La pone quien aplica
el gasto. Usar la del comprobante es decisión del anexo del escritor del X-A-10, no de éste.

**Fail-closed:** si la plantilla no trae lo medido en las 169 columnas constantes, o si fue cancelada o
borrada, ese servidor no se escribe. Plantillas candidatas (ODS; se leen enteras en el Kepler vivo antes
de fijarlas, como KR y PGP): 00/0010887 · 01/0000174 · 02/0000353 · 03/0000202 · 04/0000114 ·
05/0000079 · 06/0000297 · 07/0000162 · 08/0000414. Variable `KEPLER_SOLGASTO_TEMPLATE_FOLIO_NN`,
**sin default**.

### 5.3 El folio, sin chocar con quien captura en Kepler (DS7)
Todo en una transacción, con `lock_timeout 5s` y el candado tomado al final:
1. arma y valida las temporales;
2. `SELECT c4 FROM md.sqliov WHERE c1 = 'KFXA1501.' || $suc FOR UPDATE` (si no hay fila, rechaza);
3. folio = `greatest(c4, MAX(c6)+1)`;
4. INSERT en `kdm1` y `kdm6`, y `UPDATE sqliov SET c4 = (folio+1)::text`, sin ceros a la izquierda;
5. COMMIT. Si el folio está repetido, la PK lo rebota y se deshace todo.

Vive como primitivo compartido (`libs/platform-core/src/lib/kepler/kepler-folio.ts`) para que lo adopten
KR, TLMK, PGP.106 y PQ.112 (ADR-056). ⚠️ Antes de fijarlo hay que explicar `KFXA3001.04`: c4 = 122, igual
al último folio, sin intervención de la Suite. La semántica exacta de `sqliov` la cierra S.1.

### 5.4 Idempotencia y estados
- **Reclamo atómico** en la Suite (`UPDATE … SET kepler_request_status = 'writing' WHERE id = $1 AND
  kepler_request_status IN ('pending','retry') RETURNING`). Así hay un escritor por vale aunque firmen
  dos pestañas o corra el cron.
- **Marca:** antes de escribir y antes de reintentar se le pregunta al Kepler vivo por `c67 = 'SUITE' AND
  c26 = marca` (patrón `foliosConReferencia`). Si aparece, se adopta ese folio. **Si no se puede
  preguntar, no se reintenta.**
- **Estados visibles en el vale y en Aprobación:**
  - camino feliz: `pending → writing → written → seen_in_ods`;
  - `retry`: conexión, `lock_timeout` o tope diario; reintenta a los 5, 15 y 60 min, máximo 6 veces, y luego `stuck`;
  - `rejected_by_kepler`: regla rota; la arregla una persona;
  - `in_doubt`: más de 10 min en `writing` sin poder preguntar.

  Quien tiene `COMPROBAR` ve «Reintentar». El escritor nunca lanza: la firma ya está guardada (igual que
  `autorizarEnKepler`, `expense-proofs.service.ts:1330`).
- **Bitácora:** `finance.expense_request_kepler_attempts` (tenant_id + audit, sólo inserción). Un renglón
  por intento, con el plan enviado y su hash. Es el único rastro de quién y cuándo, porque `c30` queda
  fijo.

### 5.5 Candados y permisos
Cinco candados, y los cinco tienen que estar abiertos:
1. `KEPLER_GASTO_SOLICITUD=encendida` (apagado por default);
2. `KEPLER_PUSH_URL_NN`;
3. la plantilla del servidor;
4. un renglón `solicitud_gasto` por sucursal en `commercial.kepler_push_switch`, con tope diario (se extiende su CHECK como hizo PQ.110);
5. los GRANT.

`kepler_push` **ya tiene**:
- INSERT y SELECT en `kdm1` (KR);
- UPDATE de `c13–c16`, `c42`, `c43` y `c67–c69` en `kdm1` (PQ.110, aplicado en los 9 el 2026-11-13);
- UPDATE(`c115`).

**Faltan:**
- `SELECT, INSERT` en `md.kdm6` y `SELECT` en `kdco`, `kdcp`, `kdc3` y `kdmm`. Ya están redactados en `ops/prod/kepler-grants/cb62_comisiones_terminal.sql:28-30`, detrás de su `RAISE` de seguro;
- `SELECT, UPDATE(c4)` en `md.sqliov`, que no está redactado.

⚠️ Un GRANT es por columna, no por tipo de documento. Lo único que restringe la escritura a la X-A-15
es el código y el interruptor.

### 5.6 Lazo cerrado (se hace en el MVP-0, antes de escribir nada)
- **Visto en el ODS:** cada 5 min se busca la marca. Si a los 30 min no aparece, alarma.
- **Huérfanas:** una X-A-15 con `c67 = 'SUITE'` sin vale es un hallazgo; deben ser 0.
- **Cancelada en Kepler → el vale lo sabe.** Hoy hay 43 validados con la solicitud en C.
- **El estado se deriva de la cadena** (gasto vivo, saldo, pago), no sólo de `c43`. Incluye corregir
  `analytics.expense_requests.aplicada`, que liga por `c39` sin revisar `c37/c38` y no ve las 518 A ya
  ejecutadas.
- **Compuerta del contador:** alarma si `sqliov.c4 ≤ MAX(c6)` en cualquier tipo que escriba la Suite.
  Hoy sonaría en X-A-30 de 00, 01, 04, 06 y 08.

### 5.7 Cancelación (DS8)
- Antes de firmar: se rechaza en la Suite y Kepler nunca se entera.
- Escrita y sin X-A-10: **v1 no cancela desde la Suite.** Finanzas cancela en Kepler y el lazo anula el
  vale. La v2 sigue el patrón PQ.110: `c43 → C`, `c16 = c42 = 0`, `c67–c69`. No pide GRANT nuevo, sí su
  ADR.
- Con X-A-10 vivo: nunca desde la Suite.

## 6. Alcance v1 y lo que no entra, con su dueño (DS3)

**Entra:** acreedores `G*` de gasto operativo, **incluidos `GNF*`** (viáticos y arrastre: 76 solicitudes y
$252 k en 30 días). En 30 días: **960 de 1,394 solicitudes, $5.07 M**.

| Fuera de v1 | Volumen (30 días) | Por dónde va |
|---|---|---|
| Nómina `GN001` | 128 · 31 % del dinero anual | flujo propio, recurrente y de importe conocido. Su casa natural es RH |
| Comisiones bancarias `GB*` | 274 | CB.62 desde el estado de cuenta, **con el mismo escritor** (armador parametrizado A/F). ⚠️ Su GRANT sólo cubre 01–08: los 19 GB de 00 no tienen camino |
| Tarjetas `TC`, préstamos `A`, compras `C`, sucursales `TI` | — | Kepler, como hoy |
| Renglones a SUA 601-015, impuestos 761–763, activo 150, capital 210 | $9.2 M · $4.2 M · $4.6 M · $2.2 M en 12 meses | Kepler, como hoy (son deuda, impuestos o activo, no gasto) |
| Retenciones, honorarios X-A-15-2, moneda ≠ MXN | 1 · 0 · 0 en 12 meses | se rechazan en la Suite y se capturan en Kepler |
| Logística: liquidación catorcenal (EMB) | 154 de 159 gastos sin vale | **segundo consumidor del escritor** (EMB D7c ya se lo asignó a PGP), sin formulario |

## 7. El proceso propuesto: la Suite llena, la persona valida

Kepler hoy es teclear 23 campos por solicitud. La meta es que la persona **tome la foto, revise y
confirme**, y que sólo escriba lo que ninguna fuente sabe.

### 7.1 Por dónde entra un gasto (de más automático a menos)
| # | Entrada | Qué hace la persona | Volumen medido |
|---|---|---|---|
| 1 | **Llegó una factura del SAT.** Bandeja «Facturas de gasto sin registrar»: los CFDI recibidos (`fiscal.cfdis`, al día) de un RFC que en `kdxd` es acreedor de gasto, sin solicitud que los case | un toque: «registrar este gasto», revisa y confirma | 1-oct → 13-nov: **498 CFDI de 74 acreedores de gasto, $2.08 M**; 273 ya casan con una solicitud (RFC + total ±$1), así que **~225 nacerían de la bandeja** |
| 2 | **Gasto recurrente.** La Suite propone el del periodo (mismo acreedor, concepto, área e importe que la última vez) | confirma, o corrige el importe | 28 acreedores aparecen los 10 meses: **52.8 % de las solicitudes** |
| 3 | **«Registrar un gasto» con foto** (el gasto ya se hizo). El lector lee el comprobante y, si es factura, la Suite la busca en el SAT | toma la foto, revisa y confirma | 1,415 de 2,005 vales desde octubre ya traen comprobante |
| 4 | **«Pedir un gasto»** antes de gastar, con cotización y fecha en que se necesita. Al firmarse en efectivo **es la orden de salida** de la Ventanilla (ADR-112, LE V4/D18) | elige acreedor (sus frecuentes a un toque) e importe | 590 vales desde octubre traen sólo cotización |

En todas el vale nace **sin folio de Kepler** (`origen` nuevo). La firma escribe la X-A-15 y regresa el
folio. La puerta de hoy («tengo un folio de Kepler») sigue viva durante la transición, y lo capturado a
mano lo autoriza PGP.79 como hoy. Comisiones bancarias, Logística y nómina no entran por aquí: las
generan sus propios flujos sobre el mismo escritor (§6).

### 7.2 De dónde sale cada dato (y cada uno lo dice en pantalla, ADR-056)
| Dato | Fuente, en orden | Acierto medido |
|---|---|---|
| Acreedor | RFC del CFDI o del ticket → `kdxd` del servidor; si no, sus frecuentes | — |
| Fecha del documento que ampara, folio, subtotal, IVA, retención, UUID | **el CFDI del SAT** (certeza); si no hay, **el lector del ticket** | lector en prod (GX.33): de 406 vales con comprobante firmados en noviembre, leyó un importe en **292 (72 %)** y no pudo leer 114. Hoy lee sólo el primer comprobante del vale y sólo para avisar |
| Fecha de solicitud, sucursal, solicita | la sesión | 100 % |
| Concepto | los 3 más usados con ese acreedor | el 1º acierta 73.4 % (verificado) |
| Cuenta | `kdco.c3` del concepto en ESE servidor | 97.6 % (verificado) |
| Destinatario, RFC | `kdxd.c3`, `kdxd.c10` | 97.9 %, 99.5 % (verificado) |
| Proyecto + depto | «como la última vez» (sucursal, acreedor, concepto) | sucursales 82 %, **00 23 %** (sin verificador) → en 00 se pregunta, con «Repartir» entre áreas |
| Forma de pago | la del último vale a ese acreedor | 86 % (sin verificador) |
| Comentario `c24` | armado: concepto + periodo o unidad | — |
| Moneda, paridad, `c31`, `c63` | constantes | 100 % |

**La persona valida, no teclea:**
- cada dato prellenado se muestra con su origen: «del CFDI», «leído del ticket», «como la última vez»;
- lo que ninguna fuente contestó es lo único que se pregunta;
- lo leído del ticket con poca confianza se marca para revisar;
- confirmar es un toque.

Esto respeta el contrato de GX.32/GX.33 (pedido del usuario): **la lectura propone y nunca decide.** El
estado lo siguen decidiendo quien registra y quien firma.

Casar con el CFDI se hace por UUID cuando el lector lo encuentra (el código QR de la factura lo trae), y
si no, por RFC + total ±$1 + fecha, con su placebo publicado. Medido sobre 2,859 solicitudes de 90 días,
por RFC + total + fecha ±15/+5 días: 579 casan, contra 7 del placebo por importe y 138 del placebo por
fecha (los gastos mensuales de importe fijo casan con el mes anterior). Por eso el aviso de «esta
factura ya se registró» y el casado automático exigen fecha cercana, y lo dudoso se pregunta.

### 7.3 Lo que se revisa al capturar
- **Catálogo vivo del servidor:** lo inválido no se puede elegir, y el proyecto tiene que ser del año
  de la fecha.
- **Cuadre al centavo:** total = Σ renglones + IVA.
- **Duplicado probable:** misma sucursal, acreedor, importe y renglones el mismo día. Se busca en la
  Suite **y** en el ODS, porque conviven dos puertas. Es un aviso que pide «sí, es otro», no un bloqueo.
- **Suma del día por acreedor:** ofrece «agregar a la de hoy» e informa al firmante.
- **IVA:** `GF*` pregunta «¿trae factura?»; `GNF*` va sin IVA (DS12).
- **Presupuesto:** una línea informativa («ejercido este mes en esta cuenta y área»), rotulada «no es
  presupuesto aprobado». **No bloquea** (DS13): PU tiene 139 partidas en $0 y su plan es el histórico
  copiado.
- **Acreedor nuevo:** no se da de alta aquí; «pídelo a Finanzas».

### 7.4 Las cinco preguntas de diseño (la ley es [`ESTANDAR_DE_INTERFACES`](../../ESTANDAR_DE_INTERFACES.md))
1. **Qué ve y en qué orden:**
   - arriba, lo que ya está listo para confirmar: facturas del SAT sin registrar y recurrentes del periodo;
   - luego, «Registrar con foto» y «Pedir»;
   - al registrar, la solicitud **ya llena**, con el origen de cada dato y lo que falta resaltado, y un botón: Confirmar;
   - abajo, sus solicitudes abiertas, la más nueva primero, con estado y quién debe firmar.
2. **Qué no ve:**
   - a un toque, en «cómo se registra en Kepler»: cuenta y código de proyecto;
   - nunca: RFC, moneda, paridad, `c31`/`c63`, «autoriza», el selector de sucursal (salvo 00) y tablas de presupuesto.
3. **Accesibilidad:** con un pulgar en el celular; acreedor por nombre con sus 5 frecuentes a un toque;
   «otra como ésta». Periodo (del–al) y unidad de flotilla son **campos**, no comentario (hoy 28.9 % y
   16.9 % los escriben a mano).
4. **Ligas:** en la fila va la cadena: firmada (quién y cuándo) → folio X-A-15 → X-A-10 → pago →
   comprobante. Cada folio se abre.
5. **¿Le toca a esta pantalla?** Sí: es la puerta del gasto que ya existe. La firma vive en Aprobación y
   el pago en Calendario o Ventanilla. GB y nómina no pasan por aquí.

Antes de construirla: skill `diseno` y `npm run check:pantalla` antes y después, con validación visual
en celular.

## 8. Plan por capas y orden de entrega

**MVP-0 — sin escribir en Kepler** (C0–C2; se puede empezar ya):
- **S.1** Captura de prueba en 05, en hora tranquila y **en la misma sesión que CB.62.3** (DS9). Pasos:
  foto de contadores (`ops/prod/ensayo-pago-kepler/foto-contadores.js`) + `sqliov` + MAX; una persona
  graba una solicitud de 2 renglones con IVA; segunda foto; búsqueda por `xmin` en las 360 tablas
  (método PGP.79); «Nuevo» y abandonar; cancelarla. Cierra la lista de tablas, la semántica de `sqliov`
  (incluido el caso 04) y qué borra una cancelación.
- **S.2** Lazo cerrado sobre lo que ya existe (§5.6): el vale se entera de la C, el estado se deriva de
  la cadena y se corrige `analytics.expense_requests`. Mueve M5 sin escritor.
- **S.3** Índice único parcial `(tenant_id, sucursal, folio_solicitud)` con `status <> 'rechazada'`.
  Antes hay que resolver el 1 par vivo duplicado (sin verificador). Hoy la unicidad depende sólo de un
  `pg_advisory_xact_lock`.
- **S.4** Primitivo `kepler-folio.ts` y la compuerta del contador, con su prueba negativa.
- **S.5** Armador X-A-15 extraído de CB.62 y parametrizado (A o F, `c42`). CB.62 lo consume.
- **S.13** Vista `derive-no-copy` sobre `fiscal.cfdis` recibidos. Casa cada CFDI de un acreedor de gasto
  con su solicitud: por UUID, o por RFC + total ±$1 + fecha, con el placebo publicado. Sin casar, es la
  fila de la bandeja «Facturas de gasto sin registrar». Sólo lectura: mide hoy cuántas nacerían solas.
- **S.14** Precarga por hábito como vista: concepto, proyecto, depto y forma de pago por (sucursal,
  acreedor), con su acierto medido por holdout. Re-mide las cifras «sin verificador» de §7.2.

**MVP-1 — el escritor, apagado, y el canario:**
- **S.6** Migración generada: renglones del vale (tabla hija, tenant_id + audit), `creditor_code`,
  `vat_amount`, `needed_by`, `is_retroactive`, `kepler_request_status/_at/_note`, `created_by_id` y la
  bitácora de intentos. Se extienden los CHECK de `status` y `origen`, se recorren **los 28 archivos que
  leen el status** y todos los caminos que insertan (regla 14).
- **S.7** Sink `kepler-solicitud-gasto-sink.adapter.ts` colgado de `approve()`, con su revisión y su
  ensayo con ROLLBACK en los 9 servidores. GRANT con guarda.
- **S.8** API: registrar, pedir, prefill y duplicados, con el permiso `CAPTURAR`. **Probada contra base
  real con el payload de la pantalla** (job `pruebas-db`), con las negativas de §9.
- **S.15** Lector por comprobante: cada foto se lee (no sólo la primera) con el extractor que ya existe
  (`llm-extractor.service.ts`, `extractExpenseReceipt`), al que se agrega el UUID del QR. Lo leído
  **propone** la precarga y nunca decide (contrato GX.33). Mide el acierto de fecha, RFC y folio contra
  el CFDI cuando lo hay.
- **S.9** UI (§7): bandeja de facturas y recurrentes, «Registrar con foto» y «Pedir», con la solicitud ya
  llena y el origen de cada dato, más la cadena en Aprobación y Mis gastos.
- **S.10** Canario en 05: una solicitud real escrita por la Suite que una persona aplica en Kepler, y
  otra que se cancela desde Kepler. **Sin canario no se enciende** (KR.7: «un documento que no se puede
  cancelar es peor que uno que no se puede crear»).

**MVP-2 — piloto:**
- **S.11** 07 y 08 (67 y 182 solicitudes al mes en el alcance; 100 % y 98.9 % con vale), luego 01–04 y
  06.
- **S.16** Recurrentes: la Suite propone el gasto del periodo de los acreedores que se repiten cada mes,
  y la persona confirma o corrige el importe. Cuando el CFDI del periodo llega, la propuesta se llena
  sola con él.
- 05 sólo da para el canario: 18 solicitudes al mes, una meta de 80 % sobre eso es ruido.

**MVP-3:**
- **S.12** 00 (418 solicitudes al mes, 27 capturistas), con «Repartir» entre áreas.

**Después** (anexos aparte):
- el **escritor del X-A-10**, que es el cuello real (firma → gasto 14.2 h; salida del dinero → pago
  registrado ~6 días);
- CB.62 y EMB sobre el mismo escritor;
- la cancelación v2.

**Veda:** no se enciende nada entre el 15-dic y el 15-ene sin medir el cambio de año (H6).

Cierre: un ADR nuevo extiende ADR-092 a la X-A-15 y **enmienda su regla 2** (`sqliov`). ⚠️ ADR-092
sigue en «⏳ propuesto»: se ratifica a la vez. El último ADR en `main` hoy es ADR-118.

## 9. Pruebas (cada compuerta con su prueba negativa)
- **vitest (CI):** armador (identidad de `c16`, longitudes, proyecto de otro año; rojo al romper la
  identidad) y `kepler-folio.ts` (`greatest`, `'0003161'`, fila ausente; rojo al quitar el `greatest`).
- **`pruebas-db` (CI), adaptador real** contra un `md` de prueba con tipos, PK y GRANT de Kepler
  (`test-newdb-kepler-solicitud-gasto.js`, 45 ✓ el 2026-11-15): sin INSERT en `kdm6` o sin UPDATE en
  `sqliov` → nada escrito; otro `FOR UPDATE` → `lock_timeout`; folio ocupado → ROLLBACK total, reintentable
  y sin gastar el contador. La marca y el tope se vuelven a medir **dentro** del candado (otro proceso ya la
  escribió → `ya_estaba` con su folio; tope lleno → espera), y una plantilla con algo en las 169 columnas
  que van vacías → `apagado`: la solicitud espera sin gastar intentos.
- **`pruebas-db`, servicio con el payload de la pantalla** (`test-newdb-solicitud-gasto-suite.js`, 83 ✓
  el 2026-11-15 contra el Postgres local, con y sin el catálogo real de la 05 cargado): los servicios REALES
  como `app_runtime` con RLS; «como la última vez» y duplicados (Suite y Kepler); dos reintentos
  a la vez → una escritura; el proceso muere DESPUÉS del COMMIT de Kepler → huérfano a los 10 min, pregunta
  por la marca y adopta el folio sin escribir otro; el dueño firma → 403; tope → mañana 07:00; Kepler caído
  → espera de 5 min respetada; catálogo de Kepler distinto al del ODS → `rejected_by_kepler`; el lazo
  `written → seen_in_ods`. Mutantes medidos: si la firma no escribe → 9 rojos; huérfano a 0 min → 2 rojos.
  Y lo que encontró la revisión independiente del PR (tramo L): puerta cerrada → 409; fecha imposible → 400;
  el doble envío con el mismo `id_cliente` crea una sola; la factura del SAT se verifica contra
  `fiscal.cfdis` (inventada o por otro total → 400) y no respalda dos vales; rechazada antes de escribirse →
  `cancelled` y el cron ya no la toma; ya escrita → 409 (se cancela allá primero, DS8); en `revision` se
  escribe igual; «Capturas sin folio» y «Ligar» no tocan las de la Suite; en duda sin poder preguntar →
  latido rojo.
  ⚠️ El COMMIT cuya RESPUESTA se pierde no se reproduce (se prueba su vecino, el proceso que muere).
- **Ensayo con ROLLBACK en los 9 servidores** (rojo con una constante alterada) y **canario** en 05,
  que es la aceptación.

Las suites HTTP siguen fuera del CI: **NO MEDIDO**.

## 10. Decisiones

| D | Pregunta | Recomendación | De quién |
|---|---|---|---|
| **DS1** | ¿Dónde se hospeda? | **O9 de PGP**, con dueño nombrado. PGP ya escribe sobre la X-A-15 (PGP.79) y tiene el sink del X-D-26; EMB D7c y CB.62 D4 ya le asignaron «el escritor». Fase nueva no: hay 6 🔨 contra un cupo de 4 | Edgar |
| **DS2** | ¿Cuándo y en qué estado se escribe? | Al firmar, directo en `A` (§5.1; ADR-092 regla 6) | Edgar |
| **DS3** ✅ | Alcance v1 | ✅ **Francisco, 2026-11-14:** §6, es decir `G*` con `GNF*`; fuera `GN001`, `GB`, `TC`, `A`, `C`, `TI` y las cuentas 601-015, 761–763, 150 y 210 | Francisco (falta enterar a Edgar) |
| **DS4** | Por dónde entra | Las cuatro entradas de §7.1, de más automática a menos: factura del SAT, recurrente, registrar con foto y pedir. «Registrar» va antes que «Pedir» porque es lo que pasa (§3.3) | Francisco |
| **DS5** | Firma | v1 igual que hoy: Tesorería firma y nadie firma lo suyo, con **mínimo 2 firmantes activos antes de encender**. Una segunda firma por monto va **en la solicitud o en el pago, no en las dos**. ⚠️ LE D3 ($10 k) es el cuatro ojos de Caja General y PGP D2 ($100 k, sin confirmar) es por pago: ninguno aplica tal cual a la solicitud | Edgar y Dirección |
| **DS6** | ¿Se aceptan gastos ya pagados? | Sí, rotulados como retroactivos y con comprobante. Prohibirlos sólo los saca de la Suite | Edgar y Finanzas |
| **DS7** | ¿Folio por `sqliov` o MAX+1? | `sqliov` con `greatest` (§5.3), condicionado a que S.1 explique el caso 04 | Edgar; el GRANT lo da el administrador de Kepler |
| **DS8** | ¿Quién cancela una solicitud escrita? | v1: Finanzas en Kepler, y el lazo anula el vale. v2: código y ADR (el GRANT ya existe) | Edgar |
| **DS9** | ¿Se autorizan la captura de prueba y el canario? | Sí, en 05, en una sola sesión con CB.62.3 | Edgar |
| **DS10** | ¿Qué escribe la Suite en los textos de Kepler? | `c11` = folio del comprobante; `c24` = comentario armado (concepto + periodo o unidad); `c25` = `AMPARA …` (DS15); `c26` = marca; `c30` = `FINANZAS`; `c48` = username | Francisco |
| **DS11** | ¿Qué pasa con el catálogo mal configurado? | Contabilidad corrige 074→102 en 01/06/07/08 **antes del piloto en 07 y 08**. La Suite escribe lo que dice el catálogo del servidor y levanta un hallazgo si difiere del de 00 | Contabilidad |
| **DS12** | Clase fiscal | Se deriva del acreedor (`GF*` comprobable con RFC; `GNF*` no fiscal). Que `GF*` signifique fiscal no está documentado: se confirma antes | Francisco con Contabilidad |
| **DS13** | ¿El presupuesto bloquea? | Sólo informa, hasta que PU tenga un plan aprobado | Edgar |
| **DS14** | Piloto y meta | Canario en 05 → 07 y 08 → resto → 00; ≥ 80 % a 30 días por sucursal; veda del 15-dic al 15-ene | Edgar y Francisco |
| **DS15** ✅ | Fechas | ✅ **Francisco, 2026-11-14:** la solicitud lleva **fecha de solicitud** y **fecha del documento que ampara el gasto**. Propuesta de dónde (§5.2.1, a confirmar por Francisco): `c9` = fecha de solicitud; `c25` = `AMPARA <CFDI\|TICKET> <folio> DEL dd/mm/aaaa`; `c11` = folio del comprobante. Comprobante de más de 30 días o de otro año: avisa y pide motivo | Francisco |
| **DS16** | ¿Hasta dónde llega lo automático en v1? | Bandeja de facturas del SAT y lector por comprobante en v1 (S.13, S.15); recurrentes en el piloto (S.16). La lectura propone y nunca decide (GX.32/33). Lo que no se pudo leer se pregunta, no se inventa | Francisco |
| **DS17** ✅ | Al **pedir** un pago por transferencia, ¿se exige la referencia del banco? | ✅ **Aplicada el 2026-11-15** (regla de formulario; la misma de GX.111 para la nómina, ahora con `se_paga_despues`): transferencia y cheque no se exigen al pedir; si se escriben, se valida su forma; tarjeta y «otro» sí. **No: al pedir es opcional; la pone Tesorería al pagar** (el X-D-26 ya la lleva). Hoy la pantalla la exige porque reusa la regla del vale (`faltaParaMandar`), que se escribió para gastos ya pagados; al pedir, esa referencia todavía no existe y la persona tendría que inventarla. En X-A-15 no se guarda (sólo `c90`, la forma). Al registrar un gasto ya pagado se sigue exigiendo. Hallado por la prueba de punta a punta (2026-11-15). **Confirmado en la prueba visual:** al pedir por transferencia, en «referencia del banco» quedó el folio del TICKET (no había otra cosa que poner) | Francisco |

**Las toma ingeniería y se anuncian:**
- el vale nace como `expense_proofs`, con tabla hija de renglones (ADR-056: no se inventa una tabla de solicitudes);
- columnas en inglés (`kepler_request_status`);
- estado derivado de la cadena;
- primitivos compartidos (armador, folio).

## 11. Riesgos y NO MEDIDO

**Riesgos:** choque de folio (H1; razón de DS7) · firma concentrada: con DS2, sin firmante Kepler no
recibe nada (por eso el mínimo de DS5) · ráfagas de hasta 81 firmas al día, cada una con un
`FOR UPDATE` corto sobre `sqliov` · dos puertas: el mismo gasto en Kepler y en la Suite (el aviso de
duplicados lee el ODS) · dos bases sin transacción común (la marca y las huérfanas lo recogen) · el
gasto hereda el importe de una cotización (§4) · la pantalla «Autorización Sol Gasto» de Kepler
reescribe su lista al grabar y podría pisar `c43`.

**NO MEDIDO:** la lista cerrada de tablas al crear una X-A-15 y si `sqliov` se mueve en la misma
transacción · qué ve el capturista cuando su folio choca · si Kepler aplica y cancela una X-A-15
**insertada** en A · la PK viva de `kdm6` · `c90` 07 y 98 · cuánto difiere el comprobante de la
cotización · qué tan bien lee el lector la fecha, el RFC y el folio (sólo se midió el importe) · cuántas
facturas de la bandeja son gasto (S.13) · quién firma hoy el vale de papel en sucursal · la latencia
del ODS para la X-A-15 · la validación visual de las pantallas.

## 12. Hallazgos fuera de alcance, con su dueño

- **H1 ⚠️ urgente — el contador de la requisición X-A-30 quedó atrás en 4 servidores.** La requisición
  que escribe la Suite (ADR-092) toma MAX+1 y no avanza `sqliov`:

  | Servidor | `KFXA3001.c4` | Último folio | Folios SUITE |
  |---|---:|---:|---:|
  | 00 | 0003161 | 3,185 | 73 |
  | 01 | 190 | 203 | 26 |
  | 06 | 4 | 22 | 19 |
  | 08 | 21 | 89 | 82 |

  La próxima requisición capturada **a mano** en esos servidores pide un folio que ya existe. En 01 el
  contador avanzó de 178 a 190 sin ningún documento humano: lo más consistente son grabados fallidos
  (inferencia, NO MEDIDO). Dueño: KR / PQ. No se corrige `sqliov` a mano sin foto antes y después; que
  KR adopte el primitivo de S.4.
- **H2** — CLAUDE.md dice «escritura Suite→Kepler apagada»: es más vieja que X-A-30, PQ.110, U-D-40 y
  PGP.79 (encendido desde el 6-nov, sin fila en el tracker). Gana la fecha más nueva.
- **H3** — `finance.bank_movements` incluye la cuenta **CAJA** (`kind = 'cash'`): todo cruce
  banco↔Kepler filtra `kind = 'bank'` (sin eso, el 32 % de los aciertos de una prueba eran la caja).
- **H4** — `kdm1.c68/c69` de un cancelado es la fecha de **cancelación**; `c68` trae 06:00 hasta ~19-sep:
  siempre `c68::date + c69`. Va a [`ERP_KEPLER.md`](../../ERP_KEPLER.md).
- **H5** — Catálogo `kdco` divergente entre servidores (DS11). Para Contabilidad.
- **H6** — **Cambio de año.** La sucursal 02 cruzó de 2025 a 2026 **sin reiniciar folios** (X-A-15
  83→84, X-A-10 55→56, X-D-26 70→71). El folio 1 de 00 nace el 30-dic-2025 en los cinco tipos, lo que
  apunta a una base nueva y no a un reinicio por año. Riesgo bajo, pero la liga `(sucursal, folio)` que
  ya usan PGP.79, GX.85 y `lookupSolicitud` se rompería si Kepler reinicia: **confirmar con Sistemas
  cómo se cierra 2026 antes del 1-ene-2027.**

## 13. Construcción — lo que ya está y lo que es de Edgar

Encomienda (Francisco, 2026-11-14): «avanzamos al 99.9 %; Edgar revisa y configura la escritura en cada
servidor». Estado al 2026-11-15:

| Item | Estado | Qué hay | Prueba |
|---|---|---|---|
| S.4 folio por el contador | 🧪 | `libs/platform-core/src/lib/kepler/kepler-folio.ts`: `greatest(sqliov.c4, MAX+1)` con candado de fila | spec 14 ✓; mutante sin `greatest` → 3 rojos |
| S.5 armador | 🧪 | `solicitud-kepler.armador.ts`: las 23 columnas que varían, las dos fechas (`c9`, `c25` AMPARA), textos como Kepler (`textoParaKepler`, ahora en platform-core) | spec 8 ✓. ⚠️ CB.62 aún no lo consume (deuda con nombre) |
| S.6 migración | 🧪 sin aplicar en prod | `20261115003547_pgp122_solicitud_gasto_nace_en_la_suite`: `origen` admite `solicitud`, 16 columnas, renglones, bitácora de intentos, interruptor `solicitud_gasto` apagado con tope 1, índice único (sucursal, folio) y otro por la factura del SAT (`ux_expense_proofs_cfdi_uuid`: un UUID respalda un solo vale); estado `cancelled` | colisiones ✓ contra el ledger de prod (1,506 migraciones, 2026-11-15) · `up()` real en el Postgres local (Docker) y otra vez encima: idempotente ✓ · en prod la aplica Edgar |
| S.7 escritor, revisión y ensayo | 🧪 | `kepler-solicitud-gasto-sink.adapter.ts` + `…revision.ts` + `ops/prod/ensayo-solicitud-gasto/` + `ops/prod/kepler-grants/pgp122_solicitud_gasto.sql` | spec 7 ✓ (+1 que sólo corre contra el Kepler vivo) · `database/tests/test-newdb-kepler-solicitud-gasto.js` (md con las 200 columnas reales, negativas de permisos y candado; plantilla rara → `apagado`; marca, tope y folio ocupado re-medidos dentro del candado): 45 ✓ contra el Postgres local · ensayo contra Kepler vivo: NO MEDIDO (sólo desde `md`) |
| S.8 API | 🧪 | `/finance/expenses/solicitudes`: `disponibilidad`, `abiertas`, `catalogo`, `acreedores` (buscador compartido), `precarga`, `duplicados`, `leer-comprobante`, `POST`, `:id/detalle`, `:id/reintentar-kepler`; la firma (`approve`) escribe; cómo va cada una lo dice la lectura de Kepler de Aprobación (`nace_en_la_suite`) | typecheck ✓ · los servicios REALES con el payload de la pantalla contra Postgres real, como `app_runtime` con RLS: `test-newdb-solicitud-gasto-suite.js` 83 ✓ (§9) · arranque: `design:paramtypes` probado (`finance-solicitud-gasto.metadata.spec.ts` 6 ✓, mutante → 4 rojos) y la API levantó en Docker local · la capa HTTP (guardias, serialización): NO MEDIDO |
| S.11 cron | 🧪 | `SolicitudGastoService.ciclo`, cada 5 min: reintentos con espera, huérfanos → en duda, lazo con el ODS; latido `gastos_solicitud_kepler` | en la misma prueba: apagado → lo escribe al encender · espera de 5 min respetada · huérfano a los 10 min · `seen_in_ods` · latido en `analytics.cron_runs` |
| S.1, S.10 | ⬜ Edgar | captura de prueba, permisos, ensayo, plantillas, encender: `ops/prod/ensayo-solicitud-gasto/README.md` | — |
| S.9 UI | 🧪 | `/finanzas/gastos` → «Registrar o pedir» (`finanzas-pedir-gasto.component.ts`). Sólo se abre donde la escritura está encendida de punta a punta (`…/disponibilidad`): si no, todo sigue como hoy. Franja con el total, cuánto llenó la Suite y qué falta; barra con la acción pegada abajo (103 persona-días en celular en 30 días). Aprobación avisa cómo quedó en Kepler, muestra los renglones antes de firmar (`…/:id/detalle`) y deja reintentar; la pestaña sólo aparece donde hay algo que abrir (`…/abiertas`) | `check:pantalla` 10 de 10 y tipos ✓ · la vista compila (AOT) · specs de finanzas en la vista 1,554 ✓ (1 ✗ heredado de `origin/main`: `gastos-tabs.spec.ts`) · **validada por Francisco en local** (2026-11-15, escritorio; Docker + Kepler de prueba con el catálogo real de la 05): pidió una persona, firmó otra, quedó UNA solicitud en `A` con folio 0000081, `c9`/`c25`/`c11`, el nombre y RFC del catálogo, forma 03 y su renglón; contador a 82; la API sin errores. Celular (390 px) y el lector: NO MEDIDO |
| S.15 lector por comprobante | 🔨 | `POST …/leer-comprobante`: el lector propone importe, IVA, fecha y folio; busca al acreedor por RFC y la factura recibida en el SAT (RFC + total ±$1 + fecha ±5 días). Nada que la persona escribió se pisa | contra comprobantes reales: NO MEDIDO · el UUID del código QR queda pendiente (es tocar el prompt del lector en platform-core) |
| S.13 bandeja de facturas del SAT | 🧪 | §14: contrato puro, servicio en pasos con el alcance por sucursal del servidor, API propia, migración de descartes (dos alcances), la sección en «Registrar o pedir» con su panel lateral; revisión independiente (§14.12) | spec del contrato 38 ✓ (5 mutantes → todos en rojo) · `test-newdb-facturas-sat-bandeja.js` 65 ✓ contra Postgres real (2 mutantes → rojos) · migración 15 ✓ en local · spec de la vista 12 ✓ · metadata de arranque 4 ✓ · medido en prod (§14.11) · visual: NO MEDIDO |
| S.14 hábito · S.16 recurrentes | ⬜ | el hábito como vista con su acierto medido, y los recurrentes del periodo | — |
| S.2 lazo general | ⬜ | que el vale de HOY se entere de la C de Kepler (43 validados con la solicitud cancelada) | — |

**Lo que configura Edgar, en orden** (`ops/prod/ensayo-solicitud-gasto/README.md`): (0) aplicar la
migración `20261115003547` en prod **antes** de soltar el código (es aditiva y siembra el interruptor
apagado); (1) captura de prueba en 05 con `foto-contadores.js`; (2) el `GRANT` en 05; (3) el ensayo con
ROLLBACK; (4) `KEPLER_GASTO_SOLICITUD=encendida` y `KEPLER_SOLGASTO_TEMPLATE_FOLIO_05` en el secreto; (5) el
renglón `solicitud_gasto` de 05 encendido (es un `UPDATE`); (6) el canario. Ninguno enciende nada solo.

## 14. S.13 — La bandeja de facturas del SAT por registrar

> Diseño del 2026-11-15, antes de la primera línea de código (`diseno` §0a). Todas las cifras son de prod en
> sólo lectura, ventana 15-ago → 13-nov salvo que se diga otra; las consultas viven fuera del repo (traen
> nombres reales). Es la entrada #1 de §7.1: la más automática.

### 14.1 Para qué existe (la prueba de la frase)

**«¿Qué facturas de gasto llegaron del SAT para esta sucursal y nadie las ha registrado?»** Una pregunta, sin
«y». El acto que cierra es **registrarla**: un toque llena «Registrar o pedir» con la factura (acreedor, folio,
fecha, total, IVA y el UUID ya verificado) y la persona valida el concepto y el área.

**Quién entra:** las ~115 personas con `FINANCE_EXPENSES_CAPTURAR` que dan de alta gastos. Desde el corte del
1-oct cada sucursal captura lo suyo (en octubre: 00 500 solicitudes, 08 265, 06 206, 01 133, 07 110…), y 00
sigue registrando gasto de logística de las sucursales (casetas, cargas de combustible del CEDIS).

### 14.2 El estado real

| Qué | Medido |
|---|---|
| Facturas recibidas (tipo I, vigentes) de acreedores de gasto `G*`, con el RFC reparado | **1,633 · $6.68 M · 114 emisores** en 90 días (~18 al día) |
| Las que sólo se reconocen con la escalera del RFC (§3.z.4 de ERP_KEPLER) | **650 (39.8 %)**; una sola gasolinera aporta 555: su RFC en `kdxd` tiene dos letras cambiadas |
| Ya registradas (cascada de §14.4) | **1,329 (81.4 %)** |
| **Sin registro** | **304 · $2.70 M**; 187 de ellas sí están asociadas en ContPAQi (otra contabilidad, no Kepler) |
| Combustible | 63 % del universo, de 13 gasolineras, casi todo de menos de $2 mil |
| Cuándo llegan a la Suite | mediana **20 h** después de emitidas; 67.5 % en 24 h, 96.3 % en 48 h: la bandeja es «del día siguiente» |
| ¿El CFDI dice la sucursal? | **No**: el domicilio del receptor es el mismo en 983 de 983, el uso es G03 en 964 y los conceptos nombran una sucursal en 2 de 277 |
| ¿Kepler guarda el UUID? | **No**: 0 de 9,127 X-A-10/15 de agosto a noviembre, ni en sus 22,992 renglones. La gente teclea en `c11`/`c24` la cola del UUID o el folio (665 facturas, 40.7 %) |

### 14.3 Decisiones de diseño (de Claude, anunciadas; las de negocio quedan abiertas en §14.9)

| | Decisión | Por qué, medido |
|---|---|---|
| **DS18** | **Universo:** recibidas tipo I, vigentes, en MXN, sin retenciones, uso distinto de G01 (mercancía) e I01–I08 (activo), de un emisor que casa con un acreedor `G*` (sin `GB*` ni `GN001`) por la escalera de `resolverRfcAcreedor` (CP.8.71), que no sea también proveedor de compras (`C*`) ni el RFC propio, **desde el corte del 1-oct** | Antes del corte todo se capturaba en 00 y ya está en ContPAQi. Quitar G01, I0x y retenciones saca 13 + 6 + 1 de 1,650; la retención la rechaza v1 (§6) |
| **DS19** | **«Ya registrada» = la primera señal que se cumpla**, cada una con su documento: (0) un vale vivo de la Suite con ese UUID —y su gasto de Kepler ya no cubre otra factura—; (0b) un vale de la Suite **sin la factura ligada** (capturado con el ticket antes de que llegara el CFDI), mismo acreedor y total, de −5 a +15 días; (1) **por referencia**: un X-A-10/15 vivo del mismo acreedor cuyo `c11` o `c24` trae la cola del UUID (5+ caracteres, o 4 si el total cuadra ±$1) o el folio como número (4+ dígitos; de 3, con el total), de −30 a +120 días; (1b) la referencia **fuerte** (cola de 5+, o folio de 4+ con el total) en el gasto de **otro acreedor** —un reembolso—; (2) **difusa**: mismo acreedor, total ±$1, documento de 0 a +15 días; (3) **pagada**: un X-D-26 del acreedor, ±$1, de 0 a +7 días, que **no** explique un gasto ya usado → «pagada contra un gasto agrupado», no se ofrece | Placebos: (1) 2 falsos en 665 (99.7 %); (2) 3 y 76 en 382 (99.2 % por importe, 80.1 % por fecha); (3) 6 y 13 en 270. Sin el uno a uno, el placebo de fecha casa 331 de 1,085: escondería 1 de cada 3 casetas o recibos fijos |
| **DS20** | **El uno a uno asigna por cercanía y con cardinalidad máxima** (el documento más próximo a la factura; si dos facturas pueden quedar cubiertas, quedan las dos), no exige candidato único como PGP.108 | Con «único», cada importe repetido (casetas, recibos fijos) quedaría «sin registro» y la bandeja invitaría a duplicar el gasto. El codicioso puro dejaba fuera una factura que sí tenía gasto. Es otro primitivo: vive en `libs/contracts` (ADR-056), no en el servicio |
| **DS21** | **Sucursal (regla B):** la líder de las X-A-15/X-A-10 vivas del acreedor **desde el corte**, con 3+ documentos y 80 %+; si no, se pregunta ofreciendo primero las 2 de su historia. Cada sucursal ve las suyas y las que no tienen propuesta pero la tienen entre sus 2; **00 ve todas**. ⛔ El alcance de quien consulta lo decide **el servidor** (ScopeService, ADR-050): quien sólo ve su sucursal no lee la bandeja de otra ni de 00 (403) | Propone en 47.3 % y acierta 93.1 % (98 % en noviembre); el placebo, 27.4 %. Al preguntar, la correcta está entre las 2 en 80.8 %. La historia de 180 días acierta 36.5 %, igual que el placebo. La guarda por departamento (96.7 %) necesita un mapa departamento → sucursal que hoy sólo existe escrito a mano: **queda fuera de v1** |
| **DS22** | **Se agrupa por emisor** (renglón con cuántas, cuánto y la más antigua; al abrirlo, sus facturas) | 63 % son tickets de 13 gasolineras: sin agrupar es una lista de cientos |
| **DS23** | **«No es de aquí» en dos alcances**, y los dos se deshacen: **«No es de esta sucursal»** (sólo sale de ésta; la siguen viendo su otra sucursal de historia y 00, con el aviso) y **«Sacar para todas»** con motivo (sale de todas y queda en «Descartadas» de CADA sucursal que la veía, la dueña incluida). Es una decisión humana (HITL), en una tabla propia `finance.expense_sat_invoice_dismissals` con `tenant_id` y auditoría; una factura sacada para todas no compite por gastos ni pagos | `fiscal.cfdi_assignments` liga una factura con UN documento (exige `doc_tipo` y `doc_folio`): usarla para «no es gasto» sería forzar su significado (regla 2) |
| **DS24** | **Se calcula al leer**, en pasos (como PGP.108), no como vista: la regla vive en el contrato y el servicio sólo junta sus fuentes | El uno a uno es entre filas; en una sola consulta la cascada tardó de 0.7 a 21 s. En pasos: 341 acreedores, 719 emisores, ~1,760 facturas y ~14 mil documentos desde septiembre |

### 14.4 Qué ve, en qué orden (nivel 0) y qué no

> ⚠️ **Reemplazado por S.17 (§15, 2026-11-16):** la bandeja ya no va arriba del formulario. Vive en el paso
> «Proveedor»: sin proveedor, como la fila de proveedores con facturas sin gasto; con proveedor, como SUS facturas, con
> «Usar esta factura». Lo de abajo queda como el diseño original de S.13.

Dentro de «Registrar o pedir», arriba del formulario, para la sucursal elegida:

```
Facturas del SAT por registrar en 06 · 9 · $4,820.10                 SAT al 15-nov 05:52 (ayer)
  ESTACIÓN DE SERVICIO …   5   $2,310.00   la más antigua 06-nov            ▸
  RECIBO DE LUZ …          1   $1,240.00   12-nov                           ▸
  …
  Ya registradas: 41 en Kepler · 3 en la Suite · 5 pagadas con un gasto agrupado   ▸
  Sin sucursal clara: 4 (las tiene entre sus 2 opciones)                           ▸
```

- Al abrir un emisor: sus facturas (fecha, serie-folio, total, días desde emitida) con **[Registrar]** y **[No es de
  aquí]**. Registrar llena el formulario de abajo y lleva el foco a «Qué es y cuánto» (si había una captura en curso,
  primero pregunta). Sólo se ofrece si «Mandar a firma» lo aceptaría (el RFC de Kepler compatible); si no, dice qué
  corregir. Lo que podría ser la factura a nombre de otro acreedor se avisa en la fila.
- **No ve:** las ya registradas (sólo su conteo, desglosable), compras (`C*`), nómina y bancos, canceladas, G01 e
  I0x, las que traen retención (v1 las rechaza al pedir) ni lo anterior al corte.
- **Frescura:** «SAT al …» con la última factura recibida que llegó a la Suite; si pasa de 48 h, se dice.

### 14.5 Mapa de desglose

| Cifra | Dónde se abre | Qué trae | De dónde |
|---|---|---|---|
| «9 por registrar» | la lista, agrupada por emisor | emisor, cuántas, total, la más antigua | `GET …/solicitudes/facturas-sat?sucursal=` |
| una factura | panel lateral | conceptos del XML, RFC del emisor y el acreedor de Kepler con la vía (tal cual, parecido, por nombre), forma y método de pago, IVA, **por qué está aquí** («no hay X-A-15/X-A-10 de GXX por $X entre el dd y el dd, ni su folio o UUID en la referencia») y la sucursal propuesta con su origen | `GET …/facturas-sat/:uuid` |
| «41 en Kepler» | la lista de esas facturas | el documento que la cubre (tipo, folio, fecha) y la señal (referencia, difusa, pago) | la misma lectura |
| el XML | descarga | el comprobante tal cual | `GET …/facturas-sat/:uuid/xml` (con el permiso de la bandeja; sólo de emisores de gasto) |

### 14.6 Accesibilidad, ligas y si le toca a esta pantalla

- **El documento fuente:** el XML está en 444 de 444 facturas sin registrar; se ve desde la fila sin el permiso
  `FISCAL_CFDI_VER` (94 de 116 personas que registran gastos no lo tienen), acotado a emisores de gasto.
- **Ligas:** viene del SAT (descarga de ContPAQi → `fiscal.cfdis`); va a la solicitud (X-A-15, al firmar) y, en la
  siguiente fase, a la comprobación (X-A-10). La factura ya registrada dice qué documento la cubre.
- **¿Le toca?** Sí: es la puerta de entrada del gasto. No reemplaza `/fiscal/cfdi` ni el «CFDI sin póliza» de
  Contabilidad (FISCAL.5.2): ése mide otro universo (632 contra 444, con 195 que sobran) y se declara así.

### 14.7 Criterios de aceptación

- La bandeja de una sucursal responde en menos de 2 s (p95) con el universo desde el corte, medido en prod.
- Ninguna factura de compras, cancelada, G01, I0x o con retención aparece.
- Cada «por registrar» dice por qué; cada «ya registrada», con qué documento y qué señal.
- «Registrar» llena acreedor, documento CFDI con su UUID, fecha, folio, total e IVA (del CFDI: `iva_trasladado`,
  renglón = total − IVA, con descuento); al crear la solicitud con ese UUID, la factura sale sola de la bandeja.
- «No es de esta sucursal» la quita sólo de ésta; «Sacar para todas» pide motivo y la deja en «Descartadas» de cada
  sucursal que la veía; las dos se deshacen. Probado contra Postgres real con el payload de la pantalla (regla 13).
- Quien sólo ve su sucursal recibe 403 al pedir otra, y 404 al abrir, descargar o sacar una factura que no ve.

### 14.8 Lo que la interfaz no puede resolver

- **3 RFC mal capturados en `kdxd`** (la gasolinera de las 555 y dos más): la escalera los repara al leer, pero
  corregirlos en Kepler es de Finanzas.
- **La frescura es la de la descarga de ContPAQi** (1 a 3 oleadas al día). Para el gasto del mismo día el camino
  es el lector del comprobante (S.15), que la casa con la factura cuando llegue.
- **Facturas agrupadas** (varios tickets en una solicitud): la regla «suma del día» agrega 0.7 % y no entra en
  v1; la línea de teléfono de cada sucursal no viene en el CFDI.
- **Quien no tiene sucursal en su ficha y su alcance es «own»** (medido: ~35 personas, casi todas vendedores y
  promotores de ruta) no ve la bandeja: el servidor no le deja leer facturas de ninguna sucursal. Registra con su
  comprobante, como hoy.
- **Fuera de S.13, con dueño:** (a) `cfdi-factura.sql.ts` (PGP.108) lee la fecha del CFDI en hora de México: corre un día
  las de ContPAQi de 00:00 a 05:59 (en su ventana de ±45 días casi no cambia el casado) — PGP; (b) las rutas de PGP.122
  (`catalogo`, `acreedores`, `precarga`, `duplicados`, `leer-comprobante` y el `POST` que crea la solicitud) no validan en el
  servidor la sucursal de quien pide: por API se pide para otra sucursal — PGP.122, siguiente paso.
- **Recall sin verdad de campo:** las 304 «sin registro» no se revisaron una por una; 219 casan con OTRO
  acreedor (contra 88 del placebo), por ejemplo un reembolso a un empleado.

### 14.9 Abierto (de Edgar o Francisco)

- **DS25** — Las facturas asociadas en ContPAQi pero sin documento en Kepler (187 de 304): **v1 las muestra con
  el aviso «ya contabilizada en ContPAQi»**; ¿deben salir de la bandeja?
- **DS26** — ¿Corregir en Kepler los 3 RFC mal capturados? (Finanzas.)

### 14.10 Construcción

- **S.13.1** Contrato puro (`libs/contracts/src/finance/factura-sat.contract.ts`): universo, señal por referencia,
  uno a uno por cercanía, cascada y sucursal propuesta; spec con sus placebos (UUID falso, importe +$7, fecha −120 días).
- **S.13.2** Lectura en pasos (`facturas-sat.service.ts`): acreedores y padrón → RFC reparado → facturas → documentos
  X-A-10/15 y X-D-26 → vales de la Suite y descartes.
- **S.13.3** API: `GET facturas-sat`, `GET facturas-sat/:uuid`, `GET facturas-sat/:uuid/xml`, `POST …/descartar`,
  `POST …/restaurar`, con `FINANCE_EXPENSES_VER/CAPTURAR`.
- **S.13.4** Migración generada: `finance.expense_sat_invoice_dismissals` (RLS, `tenant_id`, auditoría).
- **S.13.5** Pantalla: la sección de §14.4 en «Registrar o pedir» y el panel lateral.
- **S.13.6** Pruebas: spec del contrato; `pruebas-db` con facturas, catálogo y documentos sembrados, y el descarte
  con el payload de la pantalla.
- **S.13.7** Medición en prod (sólo lectura): tamaño de la bandeja por sucursal y tiempo de respuesta.

### 14.11 Medido en prod con el servicio real (2026-11-15, sólo lectura)

| Qué | Medido |
|---|---|
| Tiempo de la bandeja, en frío (sin la lectura guardada) | **1.1 a 1.8 s** (criterio < 2 s ✓, con poco margen: ahora lee los documentos de TODOS los acreedores); con la lectura guardada, 0.4 s |
| Universo desde el corte (1-oct → 15-nov) | **825 facturas** de acreedores de gasto |
| Ya registradas | **649**: 319 por la referencia, 4 por la referencia en el gasto de OTRO acreedor (reembolsos), 180 difusa, 146 pagadas con un gasto agrupado (las señales de la Suite empiezan en 0: la migración de PGP.122 no está en prod) |
| **Por registrar** | **176 · $919,373 · 50 emisores**; 68 ya asociadas en ContPAQi (DS25), 54 de más de 30 días |
| Avisos | 44 con un documento de OTRO acreedor por el mismo importe (no se esconden: se avisa) · 4 con el gasto del mismo importe cubriendo otra factura más cercana (el motivo lo dice) · 2 sin acreedor registrable (Kepler tiene el RFC de otra razón social) |
| RFC del acreedor | 131 tal cual, 30 «parecido» (error de captura en Kepler), 22 por el nombre |
| Con sucursal propuesta | 73 de 176 (41 %); las demás las ven sus 2 sucursales de historia y 00 |
| Por sucursal (por registrar) | 01: 15 · 02: 4 · 03: 9 · 04: 7 · 05: 11 · 06: 23 · 07: 10 · 08: 36 |
| Acreedor fuera del catálogo de la sucursal que la ve | 0 |
| Fechas | `fiscal.cfdis.fecha` tiene dos convenciones: la descarga de ContPAQi guarda la hora LOCAL como UTC y la descarga masiva el instante real. Leída por origen, coincide con el atributo `Fecha` del XML en 2,005 de 2,005; leerla siempre en hora de México corría un día 106 de 1,770 |

⚠️ Una factura sin sucursal clara aparece en dos bandejas: si las dos la registran, la segunda choca con el índice
único del UUID (`ux_expense_proofs_cfdi_uuid`) y el servidor contesta que ya respalda otro vale.

### 14.12 Lo que encontró la revisión independiente (2026-11-15)

Cuatro revisores (cascada y lecturas, API y seguridad, pantalla, pruebas y documentos) reportaron 34 hallazgos; 5 se
verificaron con un segundo agente y los demás los verifiqué contra el código y prod (los verificadores se cortaron por
límite de uso). Todos se corrigieron, con prueba:

- **Ofrecía registrar facturas YA registradas** (invitaba a duplicar el gasto): la referencia en el gasto de otro
  acreedor (4 en prod), el folio de 3 dígitos, el vale de la Suite capturado con ticket, y el pago X-D-26 que ya
  explicaba otro gasto. Y el uno a uno codicioso podía dejar fuera una factura que sí tenía gasto (ahora es de
  cardinalidad máxima).
- **Escondía facturas NO registradas:** el gasto que escribió un vale de la Suite «cubría» otra factura del mismo
  importe, y una factura descartada competía por el gasto de una real.
- **Afirmaba de más:** «no hay gasto» cuando sí lo había (cubriendo otra factura), el día de la factura corrido uno
  (las dos convenciones de fecha), «sin IVA» cuando el SAT lo traía en el nodo crudo, y «Kepler no tiene su RFC»
  cuando lo tenía de otra razón social —con lo que «Mandar a firma» fallaba siempre—.
- **Alcance:** con `?sucursal=00` cualquiera veía la bandeja de toda la empresa; un descarte desde una sucursal
  borraba la factura de la dueña sin dejarle rastro.
- **Pantalla:** «Registrar» borraba sin preguntar una captura en curso y podía pisar un envío en vuelo; el diálogo
  dejaba de abrir si se cerraba mientras enviaba; el detalle tardío se pintaba en el panel de otra factura; el foco no
  seguía al formulario; el nombre accesible tapaba la fecha; el XML bajaba con el UUID por nombre.
- **Migración y pruebas:** el `down` borraba decisiones humanas; un motivo con emoji daba 500; la RLS y los CHECK de
  la tabla no tenían prueba versionada; una prueba de «al instante» usaba una instancia sin la lectura guardada.

### 14.13 La prueba visual en la pantalla viva, y lo que se corrigió (`[PGP.123]`, 2026-11-15)

Nivel A (skill `auditoria-diseno`): la pantalla corriendo en local contra la copia de la 05 en Docker, en claro,
oscuro, escritorio de 1,440 px y celular de 390 px. Veredicto de la primera vuelta: 🔴 por un rótulo que afirmaba
algo falso. Francisco pidió corregir todo antes del PR, con la recomendación de H5. Cada arreglo tiene prueba y su
mutante se pone rojo; la segunda vuelta se midió con el mismo instrumento.

| # | Lo que estaba mal | Cómo quedó (medido en la segunda vuelta) |
|---|---|---|
| H1 🔴 | El renglón entero decía «de la factura del SAT», pero el concepto, el proyecto y el área salían de «como la última vez»: el rótulo le decía a la persona que no revisara justo lo que tenía que revisar | Cada campo dice su origen, en una línea: «Concepto, proyecto y departamento: como la última vez · importe: de la factura del SAT». Lo que escribe la persona no se rotula (`pedir-gasto.ayudas.ts`) |
| H2 | Las cifras del resumen contaban desde 0 al cargar | `[instant]="true"`: nacen con su valor |
| H3 | Diez botones con el color de acción: cada «Registrar» relleno de naranja y el «9» del resumen del mismo color | «Registrar» con contorno neutro (variante *plain* de Aura, texto 9.50:1) y el conteo sin tono. El único botón de acción de la pantalla es «Mandar a firma» |
| H4 | Jerarquía invertida: el título a 14 px y el emisor, el folio y el monto a 16 px | Título 16 px › emisor y folio 14 px › fecha y días 13 px atenuados |
| H5 | La bandeja empujaba el formulario y separaba su franja («Falta 8») de sus campos | Abre con las 3 facturas más antiguas, cada una con su emisor, y «Ver las N, por emisor»; con 3 o menos se ven todas. La franja de la solicitud va pegada al bloque 1. El bloque 1 empieza a **735 px** en escritorio (1,209 con la lista completa) y a **1,190 px** en el celular (2,057) |
| H6 | Al cerrar el panel o el diálogo el foco caía en la página | Vuelve a la fila que lo abrió; si la factura ya salió de la lista, al título de la sección. Verificado con teclado (Enter → Esc, y «No es de aquí» → Cancelar) |
| H7 | «¿Reemplazo tu captura?» nacía con el foco en «Sí», la opción que borra | Nace en «No, sigo con la mía» y «Sí» va sin color de acción. Un Enter distraído conserva la captura (medido) |
| H8 | Sucursales por clave («sólo sale de 05; la siguen viendo 07, 00») | Por nombre: «sólo sale de 05 Zamora Centro. La siguen viendo 07 Morelia Madero, 00 CEDIS» |
| H9 | «No es de aquí» a 4.40:1 | 18.10:1 en claro, 19.90:1 en oscuro |
| H10 | Botones de 28 px que ninguna regla táctil agrandaba | Con puntero grueso (emulado): «Registrar», «No es de aquí» y «Ver las…» miden 44 px. Con un dedo real: **NO MEDIDO** |
| H11 | El aviso «puede estar registrada como reembolso» sonaba por importes iguales en OTRAS sucursales y con jerga | Sólo cuenta documentos de las sucursales que ven la factura y de la 00 (`sucursalesQueLaVen`), dicho en llano. Medición abajo |
| H12 | En el celular se cortaba el nombre del emisor | Se envuelve; sin desplazamiento horizontal a 390 px |
| H13 | Más de 500 ms por petición; en la 00 viajaban 359 KB | Viajan 49.4 KB (la API ya comprime: el problema no era el peso). El costo era recalcular el registro en cada petición: medición abajo |

Menores, también corregidos: el doble paréntesis de la sucursal; el «por qué está aquí» en llano y con el formato de
la pantalla («$1,234.50», «8-oct»); «sucursal sin confirmar» una vez por emisor (2 veces contra 9); los plegables
con su flecha; un nombre accesible por botón («Registrar la factura A-501 de …»); el diálogo de reemplazo nombra sólo
lo capturado («el folio, el acreedor y el renglón», sin «la foto» cuando no hay foto); con la factura casada al SAT
«Tomar foto (opcional)» deja de ser el botón principal; y después de «Registrar» el foco espera al hábito del
acreedor y va al primer dato que falta en el orden de la pantalla (en la prueba, el motivo por tener 38 días), no a
«Qué es y cuánto» ya lleno.

**H11, medido en prod en sólo lectura** (el servicio real, 176 facturas sin registro; control: la regla del script
da lo mismo que el contrato en las 176):

| Regla | Facturas con aviso | Avisos en pantalla | Placebo de importe ×1.07 | Placebo de fecha −30 días |
|---|---:|---:|---:|---:|
| Antes: cualquier sucursal | 44 | 107 | 19 | 59 |
| Sólo la sucursal que la ve | 20 | 48 | 9 | 35 |
| **Ésa y la 00 (la regla)** | **28** | **67** | **10** | **48** |

Los dos placebos tiran en sentidos opuestos (el de fecha cae en septiembre, antes del corte, con más documentos
libres; el de importe subestima los montos redondos), así que la señal sigue débil: se avisa, no se decide. La parte
que se quita es la más ruidosa. La medición original (219 de 304 contra 88) era de antes de que las reglas de
registro absorbieran los reembolsos con referencia; el texto de «lo que esta lista todavía no ve» ya no lleva cifras
fijas.

**H13, medido en local** (816 facturas, 6,288 documentos): de cada petición, el registro se llevaba 356–388 ms
(el 95 %), aunque fuera la bandeja de una sucursal con 9 facturas; leer lo fresco, 8–14 ms; el JSON, 1 ms. Ahora el
registro se guarda por lectura (que ya se guardaba un minuto) con la firma de lo fresco que lo alimenta: vales con y
sin factura, y lo sacado para todas. Primera petición 405 ms; las siguientes **9–27 ms**. Las 9 bandejas salen
idénticas con y sin el registro guardado. Un vale nuevo o un descarte para todas cambian la firma; la prueba contra
Postgres real lo comprueba con un caso nuevo (una factura sacada antes de la lectura vuelve a competir por su gasto
al regresarla) y los tres mutantes de la firma se ponen rojos.

**Contraste, con controles** (negro/blanco 21.00, #777/blanco 4.48): en claro lo más bajo es «Facturas que llegaron
del SAT», 4.80:1; en oscuro, 5.89:1.

⚠️ **Hallazgo del sistema, no de S.13 (para Edgar):** el botón `secondary` con contorno de Aura pone el texto en
zinc-500, y sobre el fondo zinc-100 de Operations da **4.40:1**, bajo el mínimo de 4.5 (sobre blanco, 4.81). Hay al
menos 9 en la vista con ese patrón. Arreglarlo es tocar el preset (`operations-preset.ts`, color de
`button.outlined.secondary`), que pide aprobación; la bandeja ya usa la variante *plain*.

**NO MEDIDO:** alto contraste de Windows (`forced-colors`), celular con dedo real, lector de pantalla, 320 px con
zoom al 400 % y la bandeja de la 00 en pantalla (en local no está abierta).

## 15. S.17 — El orden del formulario: base, proveedor y sus facturas, y al final cómo se paga

> Pedido de Francisco el 2026-11-16, literal: *«La lógica, antes de cualquier cosa, es seleccionar en qué base se
> va a solicitar el gasto. Los usuarios con restricción de un solo almacén no hay tema; los que manejan varios sí
> tendrían que seleccionar. Luego el proveedor: si ya tiene timbrada la factura, se extraen los documentos del SAT
> de ese proveedor sin asociar a ningún gasto. Y al final la forma de pago, el plazo y, en caso, la información de
> pago: un (+) «Agregar información de pago» para la cuenta y el correo a enviar.»* Reemplaza el orden de §7.4 y
> la colocación de la bandeja de §14.4. Cifras de prod en sólo lectura del 2026-11-16; las consultas viven fuera
> del repo.

### 15.1 Para qué, y la prueba de la frase

**«¿A quién se le paga, desde qué base, con qué papel y cómo?»**. No es una pregunta con «y»: es el orden en que la
persona ya la piensa. El acto que cierra sigue siendo **mandar a firma una solicitud ya llena**. Lo que cambia es el
orden: primero se fija lo que decide el catálogo (la base), luego a quién (el proveedor) y, con eso, la Suite ya
sabe qué facturas del SAT le corresponden. El documento deja de ser la puerta de entrada y pasa a ser
consecuencia del proveedor.

### 15.2 El estado real (medido)

| Qué | Medido |
|---|---|
| Quién pide gastos (`FINANCE_EXPENSES_CAPTURAR`), por su alcance de almacén en el área `finanzas` (el mismo que usa la bandeja del SAT) | **46** con un solo almacén (cajeros, encargados, auxiliares de tienda) · **16** con varios (promotores de ruta, supervisores) · **37** con todos (oficinas) · **2** con alcance «el suyo» y **sin almacén en su ficha** |
| Los 2 sin almacén en su ficha | un cajero que capturó **179 vales en 60 días en 07 y 08**, y un supervisor con 52 en 07: manejan almacenes que su ficha no dice |
| Con un solo almacén que capturaron en otra sucursal (60 días) | 4 de 15 activos, pocos vales y a inicios de octubre (en 00 o en 05) |
| Plazo de hoy en la X-A-15 (`c18 − c9`), 4,413 desde agosto | **88.0 % el mismo día** · 7.3 % de 1 a 7 días · 1.0 % de 8 a 15 · 0.5 % más · 3.1 % con la fecha de pago antes de la fecha |
| Días de crédito del acreedor en Kepler (`kdxd.c16`) | **12 de 223** acreedores de gasto; coincide con el plazo usado en 54 de 94 solicitudes |
| Correo del acreedor en Kepler (`kdxd.c11`) | **16 de 342** acreedores de gasto (124 filas, todas con forma de correo) |
| CLABE o cuenta del acreedor | **en ningún lado**: ni en `kdxd` (0 columnas con 18 dígitos) ni en el catálogo de cuentas de proveedor de la Suite (`commercial.supplier_payment_accounts`: **0 filas** en prod) |
| Forma de pago de la X-A-15, 90 días (3,875) | 56.9 % sin capturar · 23.7 % efectivo · **9.3 % transferencia (361, 75 acreedores)** · 6.0 % `07` · el resto, menos de 2 % cada una |

### 15.3 Decisiones (de Claude, anunciadas; las de negocio quedan en §15.8)

| | Decisión | Por qué |
|---|---|---|
| **DS27** | **La base sale de los almacenes de la persona** (ScopeService, área `finanzas`, ADR-050), intersectados con las bases abiertas. **Una** → fija, sin pregunta. **Varias o todas** → se elige, **sin preselección**. **Sin almacén en su ficha** o sin alcance → no se abre: se dice por qué y que Sistemas lo arregla; mientras, «Tengo un folio de Kepler». El servidor exige la misma regla al pedir y al leer el catálogo, los acreedores y el hábito | Es el pedido literal. Preseleccionar la última base a quien maneja dos es la manera de pedir en la equivocada (el cajero de 07 y 08). Abrir todas a quien no tiene almacén en su ficha sería ver de más: la bandeja ya le contesta 403 (S.13) y la solicitud de la Suite todavía no está en prod, así que nadie pierde lo que hoy usa. Cierra §14.8 (b) |
| **DS28** | **El proveedor va antes que el documento.** Al elegirlo, debajo aparecen **sus** facturas del SAT sin gasto en esa base (la misma lectura de S.13, filtrada por el acreedor: por su clave o por su RFC). Sin proveedor elegido, la bandeja se vuelve una fila de **proveedores con facturas sin gasto**, la más antigua primero, junto a los frecuentes | La bandeja arriba del formulario decía «registra esta factura» antes de saber a quién se le paga. Así, la entrada más automática de §7.1 sigue a un toque (el proveedor desde su factura) y respeta el orden |
| **DS29** | **«Usar esta factura» no borra al proveedor ni lo que puso su hábito.** Sólo llena el comprobante (UUID, folio, fecha, IVA, importe) y pregunta antes si va a reemplazar un comprobante ya capturado (foto, folio u otra factura) | Con el nuevo orden, elegir al proveedor y luego su factura es el camino normal: preguntar «¿borro tu captura?» por haber elegido al proveedor sería un clic que sólo confirma |
| **DS30** | **Plazo** a un toque: de contado, 7, 15 o 30 días, u otra fecha. La fecha de pago (`c18`, que el X-A-10 vuelve vencimiento de la CxP) = fecha de la factura + días, o hoy + días sin factura; si ya venció, se pide para hoy y se dice. Se precarga de `kdxd.c16` si lo tiene, si no de su última solicitud, y si no, de contado. Viaja en `necesita_para`, que ya existe: **sin columna nueva** | Es lo que Kepler hace con el plazo. El servidor ya descarta una fecha pasada y deja la de hoy: la pantalla lo dice en vez de esconderlo |
| **DS31** | **Información de pago opcional, con (+)**: cuenta o CLABE (la CLABE con su dígito de control), banco (opcional) y el correo donde se manda el comprobante. Se guarda **en el vale** (`payee_account`, `payee_bank`, `payee_email`, columnas nuevas de `finance.expense_proofs`) y la ven quien firma y quien paga. El correo se precarga de `kdxd.c11`; la cuenta, de la última que se capturó en la Suite para ese acreedor. Si ya hay datos, el bloque nace abierto con su origen | La CLABE no existe en ningún catálogo. Escribirla en el catálogo de cuentas de proveedor (PGP, con su firma de alta) es otra decisión (DS32): guardar la de ESTE pago no la toma por nadie |

### 15.4 Qué ve, en qué orden (nivel 0), y qué no

```
Registrar o pedir un gasto
 1 Base       [07 Morelia Madero] [08 …]        ← una: «Base: 05 Zamora Centro», sin pregunta
              Catálogo de Kepler de esta base · leído hace 1 min
 [Total · Llenó la Suite · Falta]
 2 Proveedor  [Nombre, clave o RFC          ▾]
              Con facturas del SAT sin gasto: [GASOLINERA · 4] [LUZ · 1] …   Frecuentes: [A] [B] [C]
              ── al elegirlo ──
              Facturas de GASOLINERA en el SAT sin gasto (4 · $1,920.00)        SAT al 16-nov 05:52
                02-nov  A-501  $480.00   [Usar esta factura] [No es de aquí]
 3 Comprobante   [Ticket o nota | Factura | Cotización]  [Tomar foto] [Subir archivo]  Folio · Fecha
 4 Qué es y cuánto   renglones · IVA · total
 5 Cómo se paga   Forma de pago [Efectivo|Tarjeta|Transferencia|…]
                  Plazo [De contado|7 días|15 días|30 días|Otra fecha]   Se paga el lun 1-dic
                  (+) Agregar información de pago → Cuenta o CLABE · Banco · Correo para el comprobante
 Más datos (opcional): periodo, unidad, nota
 [barra: total · Faltan N · Mandar a firma]
```

**No ve:** la bandeja completa arriba del formulario (sus facturas aparecen con su proveedor); «Se necesita pagar
el» dentro de «Más datos» (ahora es el plazo); el catálogo de cuentas de proveedor de PGP.

### 15.5 Accesibilidad, ligas y si le toca a esta pantalla

- **Sin mouse:** la base y el plazo son botones segmentados (flechas y Tab); con más de 5 bases, un desplegable con
  búsqueda. Al usar una factura, el foco va al primer dato que falta (como en S.13).
- **El documento fuente:** cada factura del proveedor se abre en el panel lateral con su XML, igual que en S.13.
- **Ligas:** la información de pago viaja con el vale a Aprobación (quien firma la ve antes de firmar) y al detalle
  de la solicitud; llevarla al Calendario de pagos y a «Salidas del banco» es el siguiente paso (§15.8).
- **¿Le toca?** Sí: es la misma puerta. El alta de una cuenta en el catálogo de proveedores sigue en PGP.

### 15.6 Criterios de aceptación

- Con un solo almacén, la base aparece fija y el formulario abre sin preguntar; con varios, nada aparece hasta
  elegirla; sin almacén en la ficha, se dice por qué y no se ofrece ninguna.
- Por API, pedir en una base fuera de los almacenes de la persona contesta 403 (prueba contra Postgres real).
- Al elegir un proveedor con facturas sin gasto se ven sólo las suyas; «Usar esta factura» deja al proveedor, su
  concepto, área y forma de pago, y llena UUID, folio, fecha, IVA e importe.
- El plazo calcula la fecha de pago y la dice; un plazo vencido se pide para hoy y lo dice.
- La información de pago rechaza una CLABE con el dígito de control mal y un correo sin forma de correo, en la
  pantalla y en el servidor; quien firma la ve en el detalle.
- `check:pantalla` sin fallas nuevas; prueba visual en claro, oscuro, 1,440 y 390 px.

### 15.7 Lo que la interfaz no puede resolver

- **Los 2 sin almacén en su ficha** (el cajero de 07 y 08, el supervisor de 07): Sistemas les asigna sus almacenes
  (alcance «listado» en `finanzas`). Hasta entonces capturan con «Tengo un folio de Kepler».
- **CLABE:** nadie la tiene hoy; la primera vez se teclea. El banco no se deduce de la CLABE: no hay catálogo de
  bancos en el repo y no se inventa uno.
- **El correo de Kepler** sólo está en 16 acreedores.

### 15.8 Abierto (de Edgar o Francisco)

- **DS32** — ¿La cuenta que se captura en una solicitud se propone al catálogo de cuentas de proveedor de PGP (con
  su firma de alta), para que el siguiente pago ya la traiga? Hoy ese catálogo tiene 0 filas.
- **DS33** — ¿Los 4 encargados con un solo almacén que capturaron en otra sucursal necesitan alcance de varias?
- **DS34** — ¿La información de pago se muestra en el Calendario de pagos y en «Salidas del banco»? (PGP.97/98).

### 15.9 Construcción y prueba (2026-11-16)

| Pieza | Dónde | Probado |
|---|---|---|
| Las reglas: `basesDeQuienPide`, `fechaDePago` y `PLAZOS_DE_PAGO`, `cuentaDePago` (CLABE con su dígito de control), `correoValido`, y la compuerta con `pago_cuenta` / `pago_banco` / `pago_correo` | `libs/contracts/src/finance/solicitud-gasto.contract.ts` | spec 41 ✓; romper «sin almacén → ninguna» la pone roja |
| El servidor: `abiertas` devuelve las bases de quien pide; `crear`, `disponibilidad`, `catalogo`, `acreedores`, `precarga`, `duplicados` y `leer-comprobante` contestan 403 fuera de sus almacenes; la precarga trae el plazo (`kdxd.c16` o la última solicitud) y la información de pago (`kdxd.c11` o la última de la Suite); `crear` guarda la información de pago limpia; el detalle la muestra a quien firma | `solicitud-gasto.service.ts` (gana `ScopeService`, 4º y obligatorio) | contra Postgres real con el payload de la pantalla: **102 ✓** (sección M nueva, 19 casos); romper la regla de la base pone 3 en rojo. Arranque de Nest por `design:paramtypes`: 54 ✓ |
| La migración `20261116200205`: `payee_account`, `payee_bank`, `payee_email` con sus CHECK | `database/migrations-newdb/` | `up()` real dos veces y `down()` en la base local: 15 ✓, con 9 negativas. **Sin aplicar en prod** |
| La pantalla: el orden nuevo; la bandeja en dos modos (proveedores con facturas / sus facturas); plazo; «+ Agregar información de pago» | `finanzas-pedir-gasto.component.ts`, `facturas-sat-bandeja.component.ts`, `pedir-gasto.ayudas.ts` | 19 ✓ y 21 ✓; romper «Usar esta factura» (que cuente al proveedor) pone 6 en rojo. Finanzas completo: 1,598 ✓ y 1 rojo ajeno (`gastos-tabs.spec.ts`, el menú lateral) |

**La prueba visual** (nivel A, en local contra la base Docker, en claro y oscuro, a 1,440 px con mouse y a 390 px con
puntero táctil) encontró y se corrigió:

| Lo que estaba mal | Cómo quedó |
|---|---|
| Con una sola base abierta decía «· tu almacén» aunque la persona viera todas | «tu almacén» sólo con alcance de uno; si no, «la única base abierta hoy» |
| Los «Frecuentes» con el color de acción, junto a los proveedores con facturas en neutro | neutros los dos (texto 9.50:1); el único botón de acción es «Mandar a firma» |
| A 390 px, la forma de pago cortaba sus etiquetas («Transferenc») y el plazo partía cada botón en dos renglones | el grupo se envuelve; ninguna etiqueta cortada |
| Con el dedo, los botones de forma de pago, plazo y base medían 35 px y «Quitar» 28 | 44 px |
| La opción no elegida de un grupo de botones, a 4.40:1 en claro (en la base, sin preselección, todas) | 7.03:1 en claro y 7.76:1 en oscuro |
| La franja contaba desde 0 («7 FALTA» con la barra en «Faltan 8») | nace con su valor |
| La cuenta y el correo mal escritos sólo se decían en texto | además se marcan como inválidos |

Medido después: sin desplazamiento horizontal en ninguno de los dos tamaños; con dos bases abiertas no se
preselecciona ninguna y nada se abre hasta elegir; «Usar esta factura» deja al proveedor y su hábito, la fila dice «En
esta solicitud» y el foco va a lo que falta; una CLABE con el dígito de control mal y un correo sin dominio apagan
«Mandar a firma» y lo dicen; un plazo de 15 días sobre una factura del 29-oct dice «Venció el vie 13 de nov … se pide
para hoy». Contraste más bajo de lo nuevo: 4.80:1 en claro.

⚠️ **Hallazgo del sistema (para Edgar), la misma causa que el botón secundario de §14.13:** la opción no elegida de
`p-selectbutton` va en zinc-500 y sobre el fondo de Operations da 4.40:1. Aquí se corrigió para esta pantalla; el
arreglo de fondo es el preset (`operations-preset.ts`).

**NO MEDIDO:** con un dedo real, lector de pantalla, `forced-colors`, y el selector de base con más de 5 bases (el
desplegable). La 07 se abrió sólo en la base local para ver el selector con dos opciones y se regresó como estaba.

## 16. Revisión del plan antes de encender (2026-11-17)

> Revisión crítica de §1–§15 contra el código en `main` y contra prod en sólo lectura (sid
> `7688376744939610156`), hecha **antes** de los pasos de Edgar (§13). Objetivo: que lo que falta para encender
> esté completo y en un solo lugar, y que el plan no prometa algo que el código no hace.

### 16.1 El estado real hoy (corrige la cabecera, §13 y §15.9)

| Qué | Medido el 2026-11-17 |
|---|---|
| Código de #546 y #547 | **en prod**: los dos están dentro del commit que sirve `/api/health` (`8a48dc0a7`) |
| Migraciones `20261115003547`, `…045210`, `…200205` | **aplicadas** (15-nov y 17-nov). §13 (S.6) y §15.9 dicen «sin aplicar»: rancio |
| Interruptores `solicitud_gasto` | 9 de 9 **apagados**, tope 1 por día |
| Uso | 0 vales con `origen = 'solicitud'`, 0 intentos, 0 descartes de la bandeja |
| Ciclo de 5 min | corre (`gastos_solicitud_kepler` en `ok`, sin trabajo) |
| Permisos en Kepler, secreto `kepler-push`, plantilla | **NO MEDIDO** desde aquí (sólo se ven desde `md`) |

Así que **PGP.122 está 🚀 apagado**, no 🔨. Lo que falta para encender no es código, salvo lo que dicen R1 y R6.

### 16.2 Hallazgos y mejora propuesta (de más grave a menos)

**R1 ⛔ — El lazo que exige DS8 v1 no existe en el código, y el canario lo va a destapar.**
- *Lo que dice el plan:* §5.6 pide, **antes de escribir nada**: «cancelada en Kepler → el vale lo sabe»,
  huérfanas (`c67 = 'SUITE'` sin vale) y la compuerta del contador (`sqliov.c4 ≤ MAX(c6)`). DS8 v1 confía en
  esto: «Finanzas cancela en Kepler y el lazo anula el vale».
- *Lo que hace el código:* `SolicitudGastoService.ciclo` sólo pasa `written → seen_in_ods`. Después de eso
  **nunca vuelve a mirar**: una X-A-15 de la Suite que se cancela en Kepler deja al vale en `seen_in_ods` para
  siempre. Los «huérfanos» del ciclo son otra cosa (`writing` de más de 10 min). Ni las huérfanas de §5.6 ni
  la alarma del contador están en el ciclo. S.2 sigue en ⬜.
- *Consecuencia:* el canario S.10 pide justamente **cancelar una desde Kepler**. Con el código de hoy, el
  vale no se entera, y el canario fallaría su propio criterio.
- *Mejora:* un **S.2-mínimo**, sólo para lo que escribe la Suite, que es **condición del canario**:
  1. `seen_in_ods` con `c43 = 'C'` en el ODS → el vale pasa a cancelado y se avisa a quien pidió;
  2. una X-A-15 con `c67 = 'SUITE'` y marca sin vale → latido rojo;
  3. `sqliov.c4 ≤ MAX(c6)` en `KFXA1501` de una sucursal encendida → latido rojo.

  Cada uno con su prueba negativa en `test-newdb-solicitud-gasto-suite.js`. El S.2 general (los 43 vales de
  hoy) sigue aparte.
- 🧪 **Hecho en código (2026-11-17).** Decisiones de ingeniería:
  - **sin migración**: se reusa `cancelled`, que ya está en el CHECK; su nota dice «Se canceló en Kepler (folio …)», y la
    pastilla ya decía «Kepler: cancelada» porque lee la C del ODS;
  - **el vale no se rechaza solo**: queda firmado y la alarma suena hasta que una persona lo rechace (puede que ya se haya
    pagado en efectivo). Rechazarlo ya no reescribe la nota a «antes de escribirse»;
  - **las huérfanas se buscan por la marca, no por `c67`**;
  - **el contador se lee del Kepler vivo, sólo en sucursales abiertas**, con una sola sentencia (`revisarContador`).

  Medido:
  - `revisarContador` real contra un Kepler de prueba: 7 ✓; un mutante que nunca da «atrasado» → 3 ✗;
  - el SQL exacto del servicio, contra el esquema de prod en `READ ONLY`: válido y sin escribir (el control con una
    columna inventada sí falla);
  - control positivo: la misma unión sobre los vales de hoy encuentra los 43;
  - la sección N de la suite contra Postgres real (15 casos): **NO MEDIDO** aquí, porque Docker local no arrancó. Corre en
    `pruebas-db`.

**R2 ⛔ — La CLABE que teclea quien pide es el vector de fraude de pago más común.**
- *Hoy:* DS31 guarda `payee_account` en el vale y se lo muestra a quien firma. DS34 propone llevarlo al
  Calendario de pagos y a «Salidas del banco». DS32 propone pasarlo al catálogo de cuentas de proveedor.
- *Riesgo:* cambiar la cuenta destino es el fraude de pago más común. Nadie la verifica: el banco no se deduce
  y el catálogo tiene 0 filas.
- *Mejora (para DS32 y DS34):*
  1. La cuenta de una solicitud **nunca es una instrucción de pago**: se muestra como «la escribió X, sin
     verificar».
  2. Se paga sólo a una cuenta dada de alta en el catálogo de PGP, **con su firma y su evidencia** (estado de
     cuenta o carta del proveedor). Nunca se copia sola desde la solicitud.
  3. Si la cuenta difiere de la última pagada a ese acreedor, sale en rojo ante quien firma y ante quien
     paga.

  Hasta decidir DS32 y DS34, la cuenta queda **sólo** en el detalle, como hoy.

**R3 — El tope de 1 por día no alcanza más allá del canario.**
- *Medido:* X-A-15 vivas por día en los últimos 30 días, todas las clases de acreedor:

  | Sucursal | Mediana | p95 | Máximo |
  |---|---:|---:|---:|
  | 05 | 1 | 3 | 5 |
  | 07 | 4 | 6 | 7 |
  | 08 | 8.5 | 12.6 | 14 |

  Con tope 1, en 08 se juntan ~7 por día que esperan «mañana 07:00».
- *Mejora:* que DS14 fije el **tope por etapa**: 1 en el canario; en el piloto, el p95 diario de esa sucursal
  más un margen (07 → 8, 08 → 15). Que diga quién lo sube y con qué evidencia (canario verde y 0 alarmas
  de R1).

**R4 — El calendario aprieta: quedan cuatro semanas antes de la veda.**
- Hoy es 17-nov y la veda empieza el 15-dic.
- H6 (cómo cierra Kepler 2026) sigue sin confirmar.
- El escritor exige que el proyecto sea **del año de `c9`**. En enero, mientras Contabilidad no dé de alta
  los proyectos `-27-`, toda solicitud saldría `rejected_by_kepler` (ya pasó en enero de 2026 con 305
  renglones a mano).
- *Mejora:* fechas compromiso en DS14. Por ejemplo: canario en 05 antes del 28-nov y 07 y 08 antes del
  12-dic, o declarar de una vez que el piloto arranca después del 15-ene. Antes de salir de la veda: H6
  confirmado con Sistemas y los proyectos 2027 dados de alta en los 9 servidores.

**R5 — No están escritos los criterios para APAGAR.**
- El plan dice cómo encender, pero no cuándo apagar.
- *Mejora:* se apaga el interruptor de la sucursal ante cualquiera de estos:
  - una huérfana (R1);
  - un duplicado confirmado Suite + Kepler;
  - la alarma del contador;
  - más de 2 `rejected_by_kepler` en un día;
  - una solicitud sin ver en el ODS en dos ciclos seguidos.

  El latido ya sale en rojo en db-health. Falta **nombrar a la persona que lo mira cada día** del piloto.

**R6 — La métrica de automatización no se puede medir como está definida.**
- *Definida como:* campos que la Suite llenó y la persona aceptó sin cambiarlos.
- *Lo que se guarda:* `expense_proof_lines.prefill_source` dice **de dónde** salió el dato, no **si la
  persona lo cambió**.
- *Mejora:* guardar al crear lo que la precarga propuso (o un «aceptado sin cambio» por campo). Mientras no se
  haga, esa métrica se declara **NO MEDIDA**, no 0 %.

**R7 — Dos puertas sin fecha de cierre.**
- «Tengo un folio de Kepler» sigue viva, y la meta (≥ 80 %) no dice qué pasa con el otro 20 %.
- *Mejora:* medir **por capturista** quién sigue tecleando X-A-15 de alcance v1 en Kepler en una sucursal
  encendida.
- *Decisión (Edgar y Francisco):* cuándo se retira la puerta vieja en esa sucursal. Por ejemplo, después de
  30 días seguidos ≥ 80 %.

**R8 — H1 (el contador de la requisición) tiene arreglo, pero no ha salido.**
- El commit `216245d60` `[PGP.122.4]` («los 4 carriles de escritura a Kepler sacan el folio del CONTADOR»)
  existe en el `main` local y **no está en `origin` ni en prod**.
- Mientras tanto, una requisición capturada a mano en 00, 01, 06 u 08 puede chocar.
- *Mejora:* soltarlo. Luego, con foto antes y después, revisar `KFXA3001` en esos 4 servidores. Anotarlo en
  §12 H1.
- ⛔ **Pero NO antes del permiso (medido el 2026-11-17).** Con ese commit, los 4 carriles toman el candado de `md.sqliov`
  (`SELECT … FOR UPDATE` y `UPDATE (c4)`). En prod, **`compra` y `telemarketing` están encendidos en las 9 sucursales**
  (y `cancela_oc` en 08). Si sale antes de que `kepler_push` tenga `SELECT, UPDATE (c4) ON md.sqliov` en **los 9
  servidores**, la requisición, la OC y el pedido TLMK dejan de escribirse en todos. El mensaje del commit dice «PGP.122 lo
  dio para la solicitud», pero ese `GRANT` **no se ha aplicado en ningún servidor** (es el paso 5 de §16.3, sólo en 05).
  Orden correcto: (1) aplicar las dos líneas de `sqliov` de `pgp122_solicitud_gasto.sql` en los 9 servidores; (2) verificar
  el permiso servidor por servidor desde `md`; (3) recién entonces soltar `216245d60`.
- ⛔⛔ **H1 ya le pega a la gente, y no sólo en la requisición (2026-11-17).**
  - *El caso:* en Zamora Centro, una persona abrió un pedido TELEMARK nuevo y Kepler le propuso `UD4001-0001149`. Ese folio
    ya existe: lo escribió la Suite (`c24 = COT-2026-00412`) con `MAX+1`, después se canceló en Kepler (así `c67` dejó de
    decir `SUITE`), y el contador `KFUD4001.05` se quedó en 1149. Al grabar, choca.
  - *Medido en el ODS, 16 contadores atrasados:*
    - pedido TLMK U-D-40 en 01, 05, 06 y 08 (hasta 6 folios atrás);
    - requisición X-A-30 en 00, 01, 02, 04, 05, 06 y 08 (en 08, 76 atrás);
    - OC X-A-35 en 00, 02, 05 y 06;
    - pago X-D-26 en 01.
  - *Arreglo inmediato:* `ops/prod/kepler-contadores/avanzar-contadores-atrasados.sql`. En cada servidor recalcula contra su
    Kepler vivo y sube a `MAX+1` sólo sus propios contadores atrasados; nunca baja uno, y si algo queda atrás, revierte.
    Probado contra un Kepler de prueba con los tipos reales: 11 ✓; un mutante sin la guarda baja un contador adelantado → 2 ✗.
  - ⚠️ Mientras la Suite siga escribiendo con `MAX+1`, cada documento suyo vuelve a dejar el contador 1 atrás. El arreglo
    permanente es soltar `216245d60` (después del `GRANT`). Si se suelta después de este arreglo, hay que correrlo otra vez.
  - ✅ **Hecho el 2026-11-17** (autorizó Edgar):
    - **Soltado:** `[PGP.122.4]` salió a prod como `44e07aff5` (`/api/health`).
    - **Antes del arreglo** (diagnóstico de sólo lectura en el Kepler vivo, como `kepler_push` desde `md`):
      - el permiso `SELECT`/`UPDATE(c4)` de `sqliov` estaba en los 9;
      - quedaban **6 atrasados**: requisición en 00 (27), 02 (1) y 08 (76); OC en 02 (1); pedido TLMK en 05 (el de la
        captura, 1149) y en 06 (1).
    - **El arreglo:** el SQL corrió en una transacción por servidor, con la comprobación dentro, como `kepler_push`. El
      permiso ya alcanzaba, así que no hizo falta superusuario; la conexión salió del secreto `kepler-push` y no se
      imprimió.
    - **Después:** 0 atrasados en los 9, y `KFUD4001.05` = 1150.

**R9 — `[PGP.123]` está usado dos veces.**
- En el tracker es «Pedir anticipo» (🚀).
- Este anexo (§14.13) y la descripción de #547 lo usan para la prueba visual y para el escritor del X-A-10.
- *Mejora:* el escritor del X-A-10 toma el siguiente código libre y se corrige §14.13.
- *Actualizado más tarde el mismo 17-nov:* el escritor del X-A-10 **ya entró a `main`** (`40b4f55c2`, con su anexo
  [`FASE_PGP_ANEXO_COMPROBACION_DE_GASTO`](FASE_PGP_ANEXO_COMPROBACION_DE_GASTO.md)), todavía como `[PGP.123]`. El
  tracker tiene hoy **dos filas `[PGP.123]`**: «Pedir anticipo» (🚀) y la comprobación del gasto (⬜). El choque sigue: la
  renumera su dueño (Francisco).

**R10 — Falta el ADR que gobierna esta escritura.**
- §8 promete un ADR que extiende ADR-092 a la X-A-15 y **enmienda su regla 2** (`sqliov`). No existe: el
  último es ADR-118, y ADR-092 sigue «propuesto».
- *Mejora:* redactarlo antes del canario. Es lo que alguien leerá cuando Kepler rechace un folio.

**R11 — Dueño y estado.**
- DS1 sigue «a firmar», aunque de hecho el dueño es Francisco (la encomienda del 14-nov).
- *Mejora:* nombrarlo y pasar `[PGP.122]` a 🚀 (apagado) en el tracker.

**R12 — El plazo (DS30) mueve fechas de pago que hoy se piden para el mismo día.**
- `c18` es el vencimiento que lee el Calendario. Hoy, el 88 % se pide para el mismo día.
- Precargar `kdxd.c16` (12 acreedores) o la última solicitud cambia cuándo se paga, y eso es una decisión de
  Tesorería, no de forma.
- En un gasto **ya pagado** (retroactivo, DS6), «vencido → hoy» registra como fecha de pago el día de la
  captura, no el día en que salió el dinero.
- *Mejora:* en un retroactivo, `c18` = fecha en que se pagó. En el canario, contar cuántas solicitudes cambiaron
  de plazo respecto a la práctica de hoy.

**R13 — La firma: el mínimo se cumple, la concentración no se resuelve.**
- En 30 días firmaron 5 personas distintas, así que el mínimo de DS5 (2 activos) se cumple.
- Pero 6 de 7 días firmó una sola persona, y con DS2 nada llega a Kepler sin firma.
- *Mejora:* poner la mediana vale → firma de la sucursal encendida como métrica de guardia del piloto.

**R14 ⛔ — El concepto 074 «Capitán de marca» manda el gasto a caja y bancos en 4 sucursales, y la Suite lo copiaría
sin avisar (2026-11-17).**
- *El caso:* la póliza del gasto `01-XA1001-0000151` (Padre Hidalgo, 17-nov, acreedor `GNFC003`, $1,400) carga 4 × $350 a
  la cuenta **102** (caja y bancos) y abona 201. El gasto **nunca llega a resultados**: se carga a un activo y, al pagarse,
  se cancela contra el mismo activo.
- *Medido (ODS, sólo lectura):*
  - en el catálogo `kdco`, el 074 apunta a **102** en 01, 06, 07 y 08, y a **606-014** en 00, 02, 03, 04 y 05;
  - desde el 2-oct, cuando esas cuatro sucursales estrenaron servidor propio, **todo** gasto 074 de ellas fue a 102: 73
    renglones por $25,900 (01: 27 · 06: 14 · 07: 7 · 08: 25). En 00, 02 y 03 va a 606-014.
- *Por qué toca a la Suite:* el escritor de la solicitud (y el del X-A-10, `[PGP.123]` de Francisco) escriben la cuenta
  que dice el catálogo del servidor (`kdco.c3`). DS11 prometía «levantar un hallazgo si difiere del de 00»; **eso no está
  en el código**.
- *Mejora:*
  1. **Contabilidad** corrige el 074 en el catálogo de 01, 06, 07 y 08 (a la cuenta que use 00) y decide la
     reclasificación de los $25,900 ya posteados. Es de Contabilidad, no de la Suite (ADR-040).
  2. **En código:** el catálogo de la solicitud marca el concepto cuya cuenta difiere de la de 00, y no se puede pedir
     un gasto con él hasta que Contabilidad lo resuelva o lo acepte. Va antes del piloto en 07 y 08 (DS11).
- 🧪 **Punto 2 hecho en código (2026-11-17).**
  - *La regla* (`conceptoDistintoDeCedis`, en `libs/contracts`): bloquea si **el mismo concepto** va aquí a **otro rubro**
    que en CEDIS.
    - Es el mismo concepto cuando coincide el nombre, sin importar el punto final, los espacios o las mayúsculas.
    - El rubro es lo que va antes del primer `-` de la cuenta.
    - Una subcuenta distinta del mismo rubro entra (la caja de La Piedad: `102-0142` contra `102-0042`).
    - El mismo código con otro nombre es otro concepto y entra. Primero se comparó sólo por código, y eso bloqueaba el
      246, que es «Traspaso salida» en 00 y «Degustación a clientes» en 02, 04 y 05.
  - *Dónde se aplica:*
    - el catálogo y la precarga dicen `distinto_de_cedis`;
    - `crear` contesta 400 con el motivo;
    - la pantalla **no ofrece** el concepto, pero **dice por qué**. Si era el concepto de siempre del proveedor, lo dice
      así, en vez de dejar el campo vacío sin razón.
  - *Medido:*
    - la regla con el SQL exacto del servicio, contra el catálogo real de prod (sólo lectura): bloquea **exactamente el
      074** en 01, 06, 07 y 08, y nada más (de 267 a 382 conceptos por sucursal); la consulta a CEDIS tarda 21 ms;
    - spec del contrato: 47 ✓; un mutante que compara la cuenta entera en vez del rubro → 1 ✗;
    - spec de la pantalla: 20 ✓; `check:pantalla` de la pantalla: cumple las 10 reglas y tipa;
    - typecheck de `libs/finance`: sin errores nuevos.
  - **NO MEDIDO:**
    - el mutante del componente, porque mutar dentro del árbol compartido frena el push de otras sesiones;
    - la sección N (d) de la suite contra Postgres real, porque Docker local no arrancó; corre en `pruebas-db`;
    - la validación visual.

### 16.3 Lista única para encender 05 (hoy repartida entre §13, el README del ensayo y #547)

| # | Paso | Dueño | Bloquea |
|---|---|---|---|
| 0 | Migraciones | — | ✅ aplicadas |
| 1 | S.2-mínimo (R1): 🧪 en código el 2026-11-17; falta la sección N en `pruebas-db` y soltarlo | Francisco | el canario |
| 2 | Soltar `[PGP.122.4]` (R8), **sólo después** del `GRANT` de `sqliov` en los 9 servidores (`ops/prod/kepler-grants/pgp1224_contador_sqliov.sql`: sólo el contador, sin `kdm6`): con `compra` y `telemarketing` encendidos en los 9, soltarlo antes los detiene | Edgar | — |
| 3 | ADR de la X-A-15 (R10): ADR-119, ⏳ propuesto el 2026-11-17 | lo ratifica Edgar | el canario |
| 4 | Captura de prueba S.1 en 05 (`foto-contadores.js`) | Edgar + capturista de 05 | 5 |
| 5 | GRANT en 05 | Edgar | 6 |
| 6 | Ensayo con ROLLBACK: `fallas: []`, `control.intacto: true` | Edgar | 7 |
| 7 | Secreto: `KEPLER_GASTO_SOLICITUD`, `KEPLER_SOLGASTO_TEMPLATE_FOLIO_05` | Edgar | 8 |
| 8 | Interruptor de 05, tope 1 | Edgar | — |
| 9 | Canario: una se aplica (X-A-10) y otra se cancela en Kepler, y el vale se entera | Edgar + Finanzas | el piloto |
| 10 | Antes de 07 y 08: almacenes de las 2 personas sin ficha, catálogo 074→102 (DS11), tope por etapa (R3), criterios de apagado y quién mira (R5) | Sistemas, Contabilidad, Edgar | 07 y 08 |

### 16.4 Decisiones nuevas que salen de esta revisión

| D | Pregunta | Recomendación | De quién |
|---|---|---|---|
| **DS35** | ¿Tope diario por etapa? | 1 en el canario; en el piloto, el p95 diario de la sucursal más un margen; lo sube Edgar con el canario verde | Edgar |
| **DS36** | ¿Se arranca antes de la veda o después del 15-ene? | Canario en 05 antes del 28-nov; 07 y 08 sólo si el canario cierra limpio antes del 5-dic; si no, después del 15-ene con H6 y los proyectos 2027 listos | Edgar y Francisco |
| **DS37** | ¿Cuándo se cierra la puerta «Tengo un folio de Kepler» en una sucursal encendida? | Después de 30 días seguidos ≥ 80 %; antes, sólo se mide por capturista | Edgar y Francisco |
| **DS32 / DS34** (precisadas) | Cuenta de pago | Sólo informativa hasta que exista el alta verificada en el catálogo de PGP (R2) | Edgar |
