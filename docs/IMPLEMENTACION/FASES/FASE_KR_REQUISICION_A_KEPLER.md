# Fase KR — La requisición de la Suite se escribe en Kepler

> **Estado:** 🔨 EN CURSO — 2026-10-13. Probado end-to-end contra el ERP vivo y **deshecho**:
> tres documentos escritos, verificados en pantalla y borrados; `md_00` quedó en `3110 / 3110`,
> exactamente como estaba. El código está en el repo, **apagado a propósito**.
>
> **ADR:** [`ADR-092`](../02_DECISIONES_ARQUITECTURA.md) — propuesto, supersede **en parte** a
> ADR-016: autoriza UN documento (`X-A-30`) desde UN lugar, no escribir al ERP en general.

---

## 1. Qué es, y qué NO es

Hoy una requisición de compra se captura **dos veces**: en la Suite (`/compras/pedido` →
`/compras/requisiciones`) y a mano otra vez en Kepler. Esta fase quita la segunda captura
escribiendo el documento `X-A-30` directo en el ERP.

⛔ **Es la primera escritura de la plataforma a un ERP.** [`FASE_RA`
§226](FASE_RA_REABASTECIMIENTO.md) lo prohibía —*"HITL sobre requisición propia, nunca write a
Kepler (ADR-016/013)"*— y [`FASE_RA_BENCHMARK`
§85](FASE_RA_BENCHMARK_ENTERPRISE.md) ya había previsto el caso: *"fuera de scope **hasta
decisión explícita**"*. Esa decisión la tomó Edgar el 2026-10-13.

**Alcance decidido el mismo día: SÓLO LA COMPRA.** El traspaso queda fuera, y no por tiempo —
§3 explica por qué no tiene dónde aterrizar.

---

## 2. Lo que se midió antes de construir

Todo contra `md_00` (`192.168.9.95`, el Kepler de oficinas) y la réplica lógica, el 2026-10-13.

### 2.1 El documento

| hecho | medido |
|---|---|
| Las 200 columnas de `md.kdm1` son `NOT NULL` | y las 70 de `md.kdm2` |
| Llave primaria de `kdm1` | `(c1,c2,c3,c4,c5,c6)` = sucursal·género·naturaleza·grupo·serie·folio |
| Llave primaria de `kdm2` | la misma + `c7` = renglón |
| Folio | **denso**: 3,110 requisiciones, folio máximo `0003110` |
| `md.kdfolio` | **NO es el contador de compras**: sólo tiene prefijos del POS (`PD-`, `PD26-`) |
| `c7` | es **`numeric`**, aunque otras columnas guarden números como texto con formato |
| La cadena | se liga en `c36`/`c37`/`c38`/`c39` del documento **HIJO**, no del padre |

⭐ **De ahí sale el método: CLONAR.** Con 200 columnas `NOT NULL` no se puede construir una fila
—habría que inventar un valor para doscientas columnas que nadie decodificó—, así que se copia
una requisición real y se pisan **sólo** los campos de negocio.

⭐ **Y de ahí sale que no haga falta contador**: el folio se deriva con `MAX+1`, y si dos
sesiones compiten por el mismo, **la llave primaria lo rebota sin daño** y la transacción entera
se deshace. No hace falta `LOCK TABLE` — que además bloquearía todas las capturas del ERP, que
está en uso activo (se vio aparecer un folio ajeno entre dos corridas).

### 2.2 El empaque del renglón

| columna | qué es | verificación |
|---|---|---|
| `c11` | unidad de la **línea** | PAQ 64% · PZA 28% · KG 5% |
| `c55` | unidad de la **caja** | PAQ · CJA · PZA · KG · BTO |
| `c58` | cuántas `c11` entran en una `c55` | promedio **22.57** cuando `c55='CJA'` |
| `c57` | costo de la caja | **`c12 × c58 = c57`** en ~99% |
| `c13` | importe del renglón | **`c9 × c12 = c13`** en ~100% |

⛔⛔ **`CJA` casi nunca es unidad de línea: 24 de 17,810 renglones (0.13%).** Kepler expresa la
línea en la unidad del producto y declara la caja aparte. Es el hallazgo que obliga a §4.

### 2.3 Qué tan lejos está la Suite

| | docs | importe |
|---|---:|---:|
| **Elegible** (compra con todo resuelto) | **130** | **$17,591,996** |
| Traspaso — no hay documento que lo reciba | 360 | $11,766,624 |
| Bloqueado por almacén sin `kepler_code` | **0** | — |
| Bloqueado por proveedor sin código | **0** | — |

⭐ Los dos huecos que se daban por obvios **no existen**: `catalog.suppliers.code` está en
**1007 de 1007**, y los 7 almacenes sin `kepler_code` no generan requisiciones. El único hueco
real es el traspaso, y es **el 73% del volumen**.

---

## 3. El traspaso — ⚠️ §3 ORIGINAL REFUTADA, ver §3.1

> ⛔ **Lo que decía esta sección era falso y se conserva abajo para que no se reconstruya.**
> Afirmaba que *"Kepler no registra solicitudes de traspaso"* y que por eso el 73 % del volumen
> quedaba fuera. **Sí las registra:** `U-D-40` **Pedido**, el análogo exacto de `X-A-30` — no
> mueve inventario, y 955 documentos en 120 días lo prueban. El error vino de buscar en el
> género `N` (que el doc del ERP señalaba) en vez de preguntarle al catálogo qué documentos
> tienen volumen.

### 3.1 La cadena real, medida (2026-10-13)

```
U-D-40 Pedido        (c8=N · c27='SUCURSAL' · c63='PD-')   ← lo que la Suite escribe
  → U-D-41 Embarque Sucursal     (c8=S ← SALE el inventario)
    → U-A-50 Recepción Traspaso  (c8=S ← ENTRA en el destino)
```

**955 pedidos, 951 con `c27='SUCURSAL'`, y 886 (92.8 %) derivaron en su embarque.**

⭐ **Los dos últimos eslabones YA los cubre la Suite** en `/almacen/movimientos` (Fase DM):
cuadre contable sobre el mayor `515`, validación física `U-D-41`↔`U-A-50` por back-pointer con
cuatro estados, y detalle del descuadre por póliza. Eso abarata el riesgo de escribir el
pedido: un error aparece solo en una pantalla que ya existe y que alguien ya mira. ⚠️ Pero
**no sirve de trazabilidad**: se construye sobre pólizas, y un `U-D-40` no genera ninguna.

### 3.2 Las cuatro diferencias contra la compra

| | compra `X-A-30` | traspaso `U-D-40` |
|---|---|---|
| `c10` | proveedor (`CD015`) | **pseudo-cliente `TI###`** |
| `c11` | la **referencia** → folio Suite | el **ESTADO**: `AUTORIZADO`→`SURTIDO`→`CHECADO`→`EMBARCADO` |
| marca | `c11` | **`c24`** (texto libre: la gente escribe *"LO QUE DIJO LUPITA"*) |
| limpiar al crear | ninguna | **`c100`/`c102`/`c103`** — quién surtió, checó y embarcó |

⛔ **El `TI###` no se infiere del número de sucursal**: `02` La Piedad es `TI008`, `03` 8 Esquinas
es `TI002`. Sale de **`md.pv_suc_ip`** (`c1`→`c7`), que es la fuente que ADR-091 ya señalaba
(cruzar por número da 5 % de acierto).

⛔ **Y el documento se crea en el ORIGEN**, no en el destino: al revés que la compra, donde el
encabezado es dónde se entrega.

⚠️ **Sin explicar:** `md.kdfolio` tiene fila `PD-` con **74,439**, pero el folio máximo real de
`U-D-40` es **`0001081`** sobre 1,077 documentos. La secuencia observada es densa desde 1, así
que `MAX+1` reproduce lo que el ERP hace — pero no se sabe qué es ese 74,439.

---

## 3-bis. [HISTÓRICO, REFUTADO] Por qué el traspaso quedaba fuera

| doctype | qué es | documentos |
|---|---|---|
| `N-A-6` "Entrada Traspaso sucursal" | el traspaso de mercancía | **0 en las 9 sucursales** |
| `N-D-6` salida | idem | **0 en las 9 sucursales** |
| `N-A-26` | **transferencia bancaria** (cuenta 102→102) | 1,154 — *no es mercancía* |

⛔ **El doctype de traspaso está declarado en `kdmm` y jamás se usó en toda la empresa.**

⚠️ **Esto corrige a [`ERP_KEPLER.md`](../../ERP_KEPLER.md)**, que presenta `N-A-6 entrada /
N-D-6 salida` como el mecanismo vigente de traspasos. Hay que enmendarlo.

⭐ La razón de fondo: lo que la Suite llama *requisición de traspaso* es una **solicitud**, y
Kepler no registra solicitudes de traspaso — registra el **movimiento** cuando ocurre, en género
`U` (`U-D-41` embarque → `U-A-50` llegada, ligados por `c37`/`c39`). O sea que escribir el
traspaso **no es extender este adapter**: es integrarse en otro punto del ciclo de vida y en
otro módulo. Fase aparte.

---

## 4. ⭐ El cambio que da la adaptabilidad: la unidad se LEE de Kepler

Hoy el adapter escribe `c11='CJA'` fijo y hereda `c55`/`c57`/`c58` del renglón plantilla. Las dos
cosas están mal:

- **La unidad impuesta.** La Suite guarda `final_qty` **en cajas**; Kepler espera la línea en la
  unidad del producto. 66 cajas de mazapán no son `66 CJA`: son `66 × c58` en PAQ con
  `c55='CJA'`. Lo que escribimos el ERP lo acepta, pero no significa lo mismo que los otros
  17,786 renglones — y de esa unidad dependen la conversión a OC, la recepción y el descuento de
  inventario.
- **El empaque heredado.** `c55`/`c57`/`c58` traen los valores del producto **de la plantilla**,
  no del producto pedido.

⛔ **Nada de esto se ve en pantalla.** Los tres documentos que se escribieron **se veían
perfectos** en la consulta de Kepler. Es la trampa de unidades que el proyecto ya pagó varias
veces ([`UNIDADES_DE_MEDIDA.md`](../../UNIDADES_DE_MEDIDA.md)), ahora del lado de la escritura.

**La regla nueva: el adapter no impone unidad — la resuelve por SKU desde el propio Kepler**, y
lo que no pueda resolver **lo declara y no lo escribe** (ADR-056). La fuente natural es cómo el
ERP registró antes ese producto: `c11`/`c55`/`c58` de su último renglón de requisición u orden de
compra.

Eso cambia el contrato del puerto: la línea deja de llevar `unidad: 'CJA'` fijo y pasa a llevar
la unidad resuelta, el empaque, y **el motivo cuando no se pudo**.

### 4.0 ⛔⛔ REVERTIDO el 2026-10-14 — se escribe `CJA`, sin convertir

**Lo que §4 y §4.1 argumentaban era falso en su premisa**, y se conserva abajo para que no se
reconstruya. Disparado por la pregunta de Edgar: *«¿por qué necesitamos un resolvedor de unidades
si Kepler recibe cajas, paq y piezas?»*.

**Tres mediciones lo desarmaron:**

1. **Kepler NO convierte entre documentos.** De las 22 requisiciones históricas con unidad `CJA`,
   **las 22** recorrieron requisición → OC → vale → **entrada de inventario**; la razón de
   cantidad es **1.0000** y la unidad se preserva `CJA`→`CJA`. El ERP copia el renglón. La
   conversión obligatoria que §4 daba por hecha **no existe**.
2. **El contraste comparaba universos distintos.** `kdm2.c58` es el empaque *de esa compra*;
   `kdii.c84` es la caja *del producto*. Que `c58=1` y la Suite dijera 50 **no era una
   contradicción**: eran dos preguntas. Bloquear una requisición por eso es el error de universo
   que este proyecto documenta una y otra vez.
3. **El factor para convertir no se pudo fijar.** El segundo intento (`kdii.c84`) dio 50.4 % de
   acuerdo **con una medición defectuosa**: `kdii` tiene una fila por sucursal×producto y se
   comparó contra una plaza arbitraria.

⭐ **La decisión: la fidelidad no vale una multiplicación que no se puede verificar.** Escribir
`CJA` no multiplica nada — `c9=cajas · c11='CJA' · c55='CJA' · c58=1 · c12=costo de la caja` — y
las dos invariantes del ERP se cumplen por construcción.

⚠️ **Lo que se pierde, declarado:** en el documento la unidad dirá `CJA` mientras la ficha del
producto dice `PAQ` (508 de nuestros 714 SKUs), `PZA` (154) o `KG` (39). Es **visible**, y la
cantidad significa exactamente lo que la persona capturó. Convertir mal en silencio sería peor.

⛔ **Se retiraron** `kepler-unidad.ts` y su candado: su regla resolvía un problema que ella misma
creaba. Con esto **desaparece el bloqueo de las 8 requisiciones** de §4.1 y la cobertura de la
compra vuelve a 130 de 130.

---

### 4.1 [HISTÓRICO, REFUTADO] El resolvedor no confía en Kepler: lo CONTRASTA

Leer `c58` de Kepler y convertir sería caer en la trampa de siempre — convertir verificando **un
solo lado**. Se midió el acuerdo entre las dos fuentes sobre los 4,842 SKUs presentes en ambas:

| | SKUs | |
|---|---:|---|
| `c58` de Kepler **==** `v_product_box_factor` de la Suite | **4,192** | **86.6%** |
| difieren | 650 | 13.4% |

⛔ **Y el desacuerdo tiene un patrón único:** Kepler declara `c58=1` (sin caja) mientras la Suite
dice 50, 24, 12, 8, 10. Convertir ahí a ciegas escribiría un pedido **hasta 50 veces menor** —
y el documento se vería perfecto en pantalla, que es lo que lo hace peligroso.

**Regla implementada: fail-closed.** Si un solo renglón no resuelve —sin precedente en Kepler,
sin testigo en la Suite, o los dos en desacuerdo— **no se escribe la requisición**, y el rechazo
devuelve *cuáles* SKUs y por qué.

Medido antes de elegirla, para que no fuera una corazonada:

| | |
|---|---:|
| Requisiciones de compra elegibles | 130 |
| **Pasan limpias** | **122 (93.8%)** |
| Con al menos un SKU problemático | 8 |
| Renglones: ok / sin precedente / en desacuerdo | 1,644 / 22 / 27 |

⭐ Cuesta **8 requisiciones de 130**. Las alternativas eran peores: escribir parcial deja al
comprador con un pedido incompleto **que parece completo**, y caer a una unidad por defecto es
exactamente el error de 50× que esto evita.

⭐ Las dos invariantes que el ERP cumple en ~99-100% de sus 17,810 renglones —`c9×c12 = c13` y
`c12×c58 = c57`— quedan satisfechas **por construcción**: `cantidad = cajas × c58` y
`costo_unitario = costo_caja / c58`.

### 4.2 El candado

La regla vive en **`kepler-unidad.ts`, aparte del adapter y sin base de datos**, y eso no es
estética: el adapter necesita Postgres, y probarlo exigiría un doble de Knex — que **no ejecuta
SQL** y pasaría en verde sin demostrar nada.

`kepler-unidad.spec.ts`: **14 aserciones, mutado a ROJO** desactivando el contraste (falla
exactamente el caso `1`-contra-`50`, y sólo ése). Cubre las dos invariantes, los cuatro rechazos
—que son cuatro porque cada uno se arregla distinto— y el fail-closed sobre la requisición
entera. Los 10 archivos de prueba del módulo: **197/197**, sin regresiones.

---

## 5. Sprints

| | qué | estado |
|---|---|---|
| **KR.0** | Decode + prueba end-to-end contra el ERP vivo, y deshacerla | ✅ 2026-10-13 |
| **KR.1** | `KeplerRequisitionSinkAdapter` — clona la plantilla, pisa lo de negocio | ✅ |
| **KR.2** | Migración de idempotencia (`kepler_folio` + índice único parcial) | ✅ **en prod** |
| **KR.3** | `pushToKepler()` en el servicio — frenos, idempotencia, consolidación | ✅ |
| **KR.4** | Endpoint `POST requisitions/:id/push-kepler` + binding del puerto | ✅ 2026-10-13 |
| **KR.5** | Enganche en `approve()`, best-effort, que no puede voltear la aprobación | ✅ 2026-10-13 |
| **KR.6** | ⭐ **Resolvedor de unidad por SKU desde Kepler** (§4) | ✅ 2026-10-13 |
| **KR.7** | Cancelabilidad: entender y resolver el rechazo de la Baja (§6) | ⬜ |
| **KR.8** | Pantalla: folio, motivo, reintento, y **declarar los 360 traspasos** | ✅ 2026-10-13 |
| **KR.9** | Encendido: `GRANT INSERT` + `KEPLER_PUSH_URL` + `pg_hba` desde `md` | ⬜ |

**Ruta crítica: KR.6 → KR.7 → KR.8.** KR.4 y KR.5 son cableado y están escritos; KR.6 es el que
decide si lo que se escribe *significa* lo correcto, y KR.7 si se puede deshacer.

⛔ **KR.9 va al final y no antes.** Mientras el rol no tenga `INSERT` y `KEPLER_PUSH_URL` no
exista, nada puede escribir por accidente — y ése es el único candado que no depende de que
alguien se acuerde de algo.

---

## 6. Lo que NO se pudo explicar

**Kepler se negó a dar de baja los documentos que escribimos**, mencionando *"documento
referenciado"*. Dos hipótesis, las dos **refutadas con medición**:

- *Las columnas de etapa del renglón* (`c51`–`c54`): están en **cero en los 17,810 renglones**,
  tengan OC aguas abajo o no.
- *El puntero al padre heredado* (`c36`–`c39`): la plantilla los tiene **vacíos**, igual que las
  3,110 requisiciones.

Tampoco es llave foránea ni trigger: el `DELETE` directo funcionó sin protestar. Queda abierto, y
se contesta **mirando el mensaje exacto de Kepler**, no el esquema. ⚠️ Sospecha a verificar: en
la captura, *"Documento referenciado"* aparece como **etiqueta** del panel Documento, no como
error — puede que el mensaje real fuera otro.

⭐ **Criterio de aceptación de KR.7: un documento que no se puede cancelar es peor que uno que no
se puede crear.** La prueba no es que el documento aparezca en Kepler, es que se pueda dar de
baja desde la UI.

---

## 7. Decisiones abiertas

**(a) ✅ RESUELTA 2026-10-13 — SKU sin unidad resuelta → se frena la requisición entera.**
Fail-closed, con la lista de cuáles SKUs y por qué. Se eligió **después** de medir su costo (8
de 130 requisiciones, §4.1), no antes: escribir parcial deja un pedido incompleto que parece
completo, y caer a una unidad por defecto es el error de 50× que la regla evita. ⚠️ Aflojarla
más adelante es trivial; lo que no se deshace es una cantidad escrita con el significado
equivocado. **Si Compras prefiere otra cosa, es su llamada — la implementación está en un solo
`if` del adapter.**

**(b) ✅ RESUELTA 2026-10-13 — [`ADR-092`](../02_DECISIONES_ARQUITECTURA.md).** Supersede **en
parte** a ADR-016: autoriza UN documento (`X-A-30`) desde UN lugar, y deja escrito que no abre
la puerta a escribir a Kepler en general. No se borró la regla de
[`FASE_RA`](FASE_RA_REABASTECIMIENTO.md): un ADR borrado se lleva el *porqué*, y quien encuentre
el adapter dentro de seis meses lo leería como permiso general.

⭐ De paso se corrigió [`ERP_KEPLER.md`](../../ERP_KEPLER.md), que describía los traspasos con
`N-A-6`/`N-D-6` —doctypes declarados en `kdmm` y con **cero documentos en las nueve
sucursales**— y no advertía que `N-A-26`, el único género `N` con volumen, es **transferencia
bancaria**. Esa línea es la que hizo que medio sprint de esta fase se diseñara sobre un
documento que no existe.

**(c) ✅ RESUELTA 2026-10-13 — el lote NO empuja.** `bulkEstado()` aprueba hasta 200 llamando a
`approve()`, y con KR.5 eso habrían sido **200 escrituras al ERP dentro de una petición HTTP**:
minutos de espera, riesgo de timeout, y si el timeout corta a la mitad nadie sabe cuáles
salieron. Ahora el lote pasa `empujar:false` y las requisiciones quedan aprobadas con
`kepler_folio` en NULL — el estado *"todavía no salió"* que la bandeja sabe mostrar y
reintentar. Se declara, no se dibuja como entregado.

---

## 8. Lecciones, para que no se repitan

⛔⛔ **Un sink no es idempotente y quien llama tiene que serlo.** El 2026-10-13, antes de que
existiera un botón, `RQ-2026-00807` salió **cuatro veces** y dejó cuatro documentos vivos en el
ERP — en una ronda, `$175,608.84` pedidos a un proveedor real para una necesidad de `$87,804.42`.
Ni el operador ni yo lo notamos hasta revisar los folios uno por uno. La migración KR.2 existe
por eso.

⭐ **`c11` con el folio de la Suite es lo que hizo posible limpiar.** Sin esa referencia no había
forma de distinguir nuestros documentos de los que captura compras, y habría que haber borrado
adivinando. No es decorativo: es la trazabilidad.

⚠️ **Los tipos de Kepler no son uniformes y no se adivinan.** `c7` es `numeric`, `c51`–`c54` son
texto. Por eso cada renglón se escribe con **parámetros** contra la columna destino, dejando que
Postgres resuelva el tipo, en vez de castear a mano — un `::text` sobre `c7` ya reventó una vez.

⚠️ **El `25P02` es el eco, no el error.** Apareció dos veces y las dos escondió la causa real;
una de ellas dejó un documento vivo que se creía borrado. Ante `25P02`: `ROLLBACK` y correr las
sentencias **de a una**.

⭐ **La pantalla no valida la semántica.** Los documentos con la unidad equivocada se veían
perfectos. Lo que los delató fue comparar contra los 17,810 renglones que el ERP ya tenía.
