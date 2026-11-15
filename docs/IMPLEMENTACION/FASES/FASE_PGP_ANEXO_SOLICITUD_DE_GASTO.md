<!-- INDICE-AUTO:INICIO -->

> **Índice navegable** — 47 KB, 588 líneas, 14 secciones.
> ⛔ **No intentes leer este archivo entero: no cabe en una ventana de contexto.**
> Buscá tu tema acá y leé sólo ese tramo: `sed -n 'DESDE,HASTAp' docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md`.
> Lo genera `npm run docs:indices` — no lo edites a mano.

| Desde | Hasta | KB | Sección |
|---:|---:|---:|---|
| 26 | 59 | 2 | Fase PGP · Anexo S — La solicitud de gasto nace en la Suite y se escribe en Kepler |
| 60 | 72 | 1 | 1. El pedido, literal |
| 73 | 88 | 1 | 2. Lo que ya existe: falta sólo la primera pieza |
| 89 | 170 | 6 | 3. Lo que dicen las solicitudes (12,744 desde dic-2025) |
| 171 | 189 | 1 | 4. Qué es una X-A-15 dentro de Kepler (lo que hay que escribir) |
| 190 | 332 | 9 | 5. El escritor (C1–C2) |
| 333 | 346 | 1 | 6. Alcance v1 y lo que no entra, con su dueño (DS3) |
| 347 | 426 | 6 | 7. El proceso propuesto: la Suite llena, la persona valida |
| 427 | 488 | 4 | 8. Plan por capas y orden de entrega |
| 489 | 516 | 2 | 9. Pruebas (cada compuerta con su prueba negativa) |
| 517 | 544 | 4 | 10. Decisiones |
| 545 | 560 | 1 | 11. Riesgos y NO MEDIDO |
| 561 | 589 | 2 | 12. Hallazgos fuera de alcance, con su dueño |
| 590 | 614 | 5 | 13. Construcción — lo que ya está y lo que es de Edgar |

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
| S.13 bandeja · S.14 hábito · S.16 recurrentes | ⬜ | la bandeja de facturas del SAT sin registrar, el hábito como vista con su acierto medido, y los recurrentes del periodo | — |
| S.2 lazo general | ⬜ | que el vale de HOY se entere de la C de Kepler (43 validados con la solicitud cancelada) | — |

**Lo que configura Edgar, en orden** (`ops/prod/ensayo-solicitud-gasto/README.md`): (0) aplicar la
migración `20261115003547` en prod **antes** de soltar el código (es aditiva y siembra el interruptor
apagado); (1) captura de prueba en 05 con `foto-contadores.js`; (2) el `GRANT` en 05; (3) el ensayo con
ROLLBACK; (4) `KEPLER_GASTO_SOLICITUD=encendida` y `KEPLER_SOLGASTO_TEMPLATE_FOLIO_05` en el secreto; (5) el
renglón `solicitud_gasto` de 05 encendido (es un `UPDATE`); (6) el canario. Ninguno enciende nada solo.
