# Fase LE — Libro de efectivo de partida doble (Caja General como un banco)

> El método que la gobierna: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Pedido del PM, 2026-10-27: *«rehagamos el motor de caja… debemos pensar que esto es como un
> banco»* y *«revisemos y hagamos la corrección por capas y fases, desde la base de datos hasta el
> backend»*. Nace de ADR-101 y de la medición de abajo; **absorbe** a `CGA-A.50`–`A.57`.

```
OBJETIVO: que cada peso de la Caja General de Oficinas esté en UN lugar a la vez, con una sola
          explicación, y que el libro cuadre todos los días contra un testigo independiente.
MÉTRICA:  (a) depósitos de CAOS explicados más de una vez — HOY: 86 · $1,703,230 (2026-10-27) → META: 0
          (b) cortes cuyo esperado no se puede ir a contar (negativo o con ±$100k de piernas cruzadas)
              — HOY: 7 de 13 cortes (12–26 oct) → META: 0 en el cierre diario en paralelo
          (c) cortes autorizados por una segunda persona — HOY: 0 de 13 → META: 100 %
CAPA TOPE: C2 (la UI es la fase siguiente; ver §2)
ÁREA:      Finanzas
DUEÑO:     Edgar (PM)
ESTADO:    🔨 — D1 y D2 firmadas por el PM el 2026-10-27; LE reemplaza a CGA. Falta D3.
```

---

## 0. Las reglas de banco (BINDING para esta fase)

> Pedido del PM, 2026-10-27: *«piensa como si estuvieras desarrollando esto para un banco… no dejes
> nada a la duda»*. Cada regla dice **cómo se verifica**. Una regla sin verificación es una
> intención (regla 12 del proyecto). Las marcadas ⛔HOY se violan hoy, medido.

### A · El libro

| # | Regla | Cómo se verifica |
|---|---|---|
| B1 | **Partida doble**: todo asiento suma cero, en pesos y, en efectivo, por denominación | trigger diferido + prueba negativa |
| B2 | **Inmutable**: sólo se agrega. Un error se corrige con un asiento de reversa que nombra al original y su motivo. Ni el admin puede UPDATE/DELETE | privilegios de la base + trigger + prueba que lo intenta como `app_runtime` y como dueño |
| B3 | **Un hecho, un registro**: cada evento externo (movimiento CAOS, cobro Kepler, pago) y cada petición (`client_uuid`) se registra una sola vez; un reintento devuelve lo ya registrado | índice único + prueba de doble envío |
| B4 | **Cada peso, una explicación**: ningún peso sale dos veces de una bolsa ni se asigna a dos destinos ⛔HOY (86 · $1.70 M) | se cumple por construcción con B1+B3; compuerta diaria de explicaciones dobles = 0 |
| B5 | **Saldos derivados**: el saldo es la suma de asientos; nada se teclea ni se guarda a mano | vista; si un día se materializa, se recalcula y se compara |
| B6 | **Dinero exacto**: `numeric(18,2)` en la base; en código, **centavos enteros**, nunca `float`; un solo punto de redondeo; moneda explícita | prueba con montos que el float redondea mal |
| B7 | **Fecha valor ≠ fecha de registro**; hora del servidor (México), nunca del navegador; **un día cerrado no se toca**: el ajuste va al día abierto | trigger de periodo cerrado + prueba |
| B8 | **Bolsas físicas nunca negativas**, ni por denominación | trigger + prueba |

### B · Las personas (controles)

| # | Regla | Cómo se verifica |
|---|---|---|
| B9 | **Segregación de funciones**: quien registra ≠ quien autoriza ≠ quien cuenta ≠ quien concilia ⛔HOY (una persona hace 84 % de los retiros y cierra todos los cortes) | reglas en la base, no sólo en la pantalla |
| B10 | **Cuatro ojos**: toda reversa, ajuste, faltante y todo movimiento arriba del umbral (D3) lo autoriza una segunda persona ⛔HOY (0 de 13 cortes autorizados) | trigger: autoriza ≠ registra |
| B11 | **Arqueo ciego** (quien cuenta no ve el esperado) **y sorpresa** por un tercero, con frecuencia fija | registro del arqueo con quién y si fue sorpresa |
| B12 | **Usuarios nominales**: nadie opera con una cuenta compartida ni con claves de fábrica ⛔HOY («Vendedor 006» para todas las rutas; consola de CAOS con su clave de fábrica, sin rotar) | inventario de usuarios; bloqueo de cuentas genéricas |
| B13 | **Mínimo privilegio**: permisos por ACCIÓN (registrar, autorizar, revertir, conciliar), revisados cada trimestre | matriz de accesos regenerada y firmada |
| B14 | **Los procesos automáticos tienen identidad propia** y nunca autorizan | `created_by` de servicio; trigger lo impide |
| B15 | **Límites por persona y por día**, como un cajero de banco | regla en la base al registrar |
| B16 | **Campos libres con tope**: un importe tecleado (morralla) no puede reemplazar a un conteo ⛔HOY ($298,484.92 de morralla el 26-oct) | tope + autorización arriba de él |

### C · Conciliación

| # | Regla | Cómo se verifica |
|---|---|---|
| B17 | **Todo saldo tiene un testigo independiente** y se concilia a diario: bóveda ↔ conteo de la máquina, cajón ↔ arqueo, banco ↔ estado de cuenta, por cobrar ↔ Kepler ⛔HOY (el conteo de la máquina no se guarda) | cierre diario |
| B18 | **Ninguna diferencia se absorbe**: cada una es una partida pendiente con monto, dueño, antigüedad y su cierre firmado | tabla de hallazgos + reporte de antigüedad |
| B19 | **Emparejar por llave, nunca por antigüedad** (ruta + fecha + monto); lo dudoso va a revisión humana. Se publica la **precisión** medida con placebo, nunca sólo la cobertura ⛔HOY (`CG.58` FIFO) | placebo ≈ 0 aciertos; muestra revisada a mano |
| B20 | **Sin cierre de ayer no se opera hoy** (ya existe: `[CGS.14]`) | candado vigente |

### D · Auditoría

| # | Regla | Cómo se verifica |
|---|---|---|
| B21 | **Bitácora de todo**: quién, cuándo, desde qué dispositivo, antes/después — de los datos **y** de la configuración y los permisos | trigger genérico (`master_data_history`) |
| B22 | **Toda cifra publicada es reproducible**: dice con qué datos y con qué versión de la regla se calculó | procedencia en la respuesta (ADR-056) |
| B23 | **Retención**: nada se borra; mínimo 5 años (fiscal MX) | sin DELETE (B2) |

### E · Datos de fuera

| # | Regla | Cómo se verifica |
|---|---|---|
| B24 | **Las fuentes externas se leen, nunca se escriben**, y llegan con su frescura; si una fuente se atrasa, la conciliación dice NO MEDIDO, no cero | latidos `cron_runs` + frescura en cada respuesta |
| B25 | **Validación estricta en la frontera**: montos > 0, denominaciones del catálogo, fechas válidas, tipos cerrados | DTO + CHECK en la base |

### F · Seguridad

| # | Regla | Cómo se verifica |
|---|---|---|
| B26 | **Secretos fuera del repo**, rotados, nunca de fábrica; **cifrado en tránsito** para todo lo que toca dinero ⛔HOY (CAOS por HTTP plano, login reutilizable) | inventario de secretos; TLS |
| B27 | **Autorizar pide reautenticación** (MFA o clave) | flujo de autorización |
| B28 | **Nada mueve dinero real desde el sistema** (dispensar CAOS) sin ADR, cuatro ojos y API oficial del fabricante | ADR |

### G · Cómo se desarrolla

| # | Regla | Cómo se verifica |
|---|---|---|
| B29 | **Antes de construir algo que toca dinero: inventario de TODO lo que toca ese objeto** (tablas, servicios, crons) y cómo convive con cada uno ⛔HOY (así nacieron las explicaciones dobles) | sección de impacto en el plan, revisada |
| B30 | **Revisión por otra persona** de todo cambio al módulo de dinero ⛔HOY (los PR no tienen revisión) | regla de protección de rama para estas rutas |
| B31 | **Cada invariante con prueba negativa y mutación**; pruebas contra base real; **pruebas de concurrencia** (dos cajeros a la vez) y **de reconstrucción** (el historial reprocesado da el saldo del testigo) | job `caja-db` |
| B32 | **Nunca se prueba contra prod**; datos de prueba sintéticos; prod sólo se lee | `assert-safe-target` |
| B33 | **Migraciones aditivas y reversibles**, ensayadas en base de prueba, aplicadas una por una fuera de horario, con verificación después | runbook + `aplicar-migracion.sh` |
| B34 | **Lo nuevo corre en paralelo** al viejo y se cambia con un criterio medido (LE.2.4), con plan de reversa escrito | 10 cierres seguidos sin diferencias |
| B35 | **Concurrencia controlada**: todo lo que toca un saldo toma candado o va en transacción serializable | prueba de dos escrituras simultáneas |

### H · Operación

| # | Regla | Cómo se verifica |
|---|---|---|
| B36 | **Alertas el mismo día**: diferencia de conciliación, feed atrasado, cierre que no se hizo | notificación a un responsable con nombre |
| B37 | **Un descuadre es un incidente**: dueño, causa, corrección y nota de qué cambió para que no se repita | bitácora de la fase |
| B38 | **Respaldos probados restaurando**, no sólo ejecutados | prueba de restauración periódica |

---

## 1. Qué problema resuelve (medido en `pg-prod`, sólo lectura, `7688376744939610156`)

| Hecho | Cifra | Dónde se ve |
|---|---|---|
| Depósitos de CAOS con DOS explicaciones (libro + `CG.58`) | **86 · $1.70 M** | ej. depósito #1723 «ruta 27 261026»: en el libro es la ruta 27 del 26-oct; en `CG.58`, las rutas 21 y 22 del **28-jul** |
| Depósitos explicados sólo por `CG.58`, por antigüedad (FIFO), no por ruta | 741 · $18.77 M | el FIFO siempre llega al «100 % conciliado» y **tapa jineteo** |
| Cortes con esperado negativo | 5 de 9 (12–22 oct) | el libro resta gastos que no salieron del cajón |
| Retiro y gasto en jornadas distintas | 19-oct «falta» −$188,885 · 21-oct esperado −$221,512 | el mismo dinero contado en la jornada equivocada (ADR-101) |
| Retiros de CAOS enlazados a algún gasto | 30 de 409 · 7 % del dinero | `ux_caos_link_vivo` sólo permitía 1 a 1 |
| Cortes autorizados | **0 de 13** | `carmen_rodriguez` abre y cierra todos |
| Arqueo completo en la suite desde que se jubiló Control (22-oct) | **0** | la caja fuerte se proyecta del arqueo de Control del 21-oct |
| Morralla tecleada en el corte del 26-oct | **$298,484.92** de $342,095.42 «contados» | sólo $43,610.50 se contaron por pieza |
| `CG.58` corre cada hora y no tiene interruptor | sigue escribiendo | `caos-ingreso-cron.service.ts:76` |

### 1.0 El caso diario (el PM, 2026-10-27)

> *«Las rutas venden, llegan y hacen su cobro: vendió 21 mil, mete sólo 19 a CAOS y la diferencia
> se queda en la caja general chica.»*

```
Por cobrar · Ruta 27 (vendedor con nombre)   − $21,000   lo que Kepler dice que cobró
Bóveda CAOS                                  + $19,000   lo contó la máquina (depósito «ruta 27 …»)
Caja General · pesos                         +  $2,000   se cuenta en el arqueo, por denominación
                                             ─────────
                                                    $0   el asiento cuadra o no se guarda (B1)
```

Si el vendedor sólo entrega $20,900, los $100 van a **Faltante · vendedor** con su nombre: nunca se
absorben (B18). El depósito se liga a la ruta por su **referencia y su día** («ruta 27 261026»),
nunca por antigüedad (B19). ⛔ Hoy el depósito lo hace el usuario compartido «Vendedor (006)»: no
se sabe qué vendedor depositó (B12).

### 1.1 La causa (el porqué de todas las filas de arriba)

El libro es de **entrada simple**: cada movimiento dice «entró» o «salió», pero no **de dónde a
dónde**. La posición del dinero (cajón, máquina, calle, banco) se reconstruye después con **cuatro
mecanismos que no se conocen entre sí**, cada uno con su propio candado y ninguno cuidando el
dinero entre tablas:

| Mecanismo | Tabla | Filas | Qué explica |
|---|---|---:|---|
| Enlace a mano gasto/ingreso ↔ movimiento CAOS | `finance.caos_cash_links` | 119 | qué movimiento de la máquina financió una captura |
| Conciliador automático `CG.58` (FIFO) | `finance.caos_ingreso_atribucion` | 1,766 | qué cobros de Kepler son un depósito |
| Captura de un movimiento CAOS como fila del libro | `finance.cash_ledger` (`origen_tipo='caos'`) | — | el movimiento entero |
| Custodia de un retiro (`CGA-A.50`) | `finance.caos_retiro_custodia` | 0 | a cargo de quién quedó |
| Grano del depósito (`CG.58.6`) | `finance.caos_deposito_grano` | 827 | de qué ruta viene |

Y el corte suma piernas (`[CG.95]`, `[CG.96]`, custodia) en vez de leer un saldo.

### 1.2 La revisión que faltó — inventario completo (2026-10-27)

**71 objetos** con `caja|cash|caos|arqueo|corte` en `finance.*` y `analytics.*` para un libro de
**504 movimientos y 13 cortes**. Lo relevante:

- **Tres tablas para conteos físicos, las tres vacías**: `finance.cash_arqueos` (0),
  `finance.caos_conteos_fisicos` (0), `analytics.caos_cash_counts` (0, el conteo de la máquina que
  nunca se guardó — `CGA-A.54`).
- **Tablas sin quien las escriba en el código**: `cash_ledger_cut_custody` (4 filas),
  `cash_ledger_cut_vouchers` (0), `cash_ledger_route_links` (0).
- ⛔ **Copias de tablas** (`analytics.caja_arqueos_snapshot_bak` 29,994 · `caja_general_cuentas_snapshot_bak`
  122 · `caja_general_movimientos_snapshot_bak` 12,230): violan la regla 2. Son del espejo de
  Control; se declaran y se decide su destino aparte (no se borran en esta fase — regla 5).
- **Quién escribe**: `cash_ledger` lo escriben 3 servicios; `caos_cash_links` 1; `caos_ingreso_atribucion`
  1 (el cron de `CG.58`); `caos_cash_counts` sólo el importer de CAOS.

---

## 2. Qué NO incluye

- **Pantallas (C3).** Esta fase llega a la API. Las pantallas de captura, corte, arqueo y custodia se
  rehacen en la fase siguiente, sobre esta API. Mientras tanto la pantalla actual sigue operando.
- **Contabilidad.** ContPAQi sigue siendo el SoR contable (ADR-040). Esto es el libro OPERATIVO del
  efectivo físico; no emite pólizas.
- **Escribir en Kepler.** Kepler sólo se lee.
- **Las cajas de las sucursales** (`analytics.cash_cuts`, Wincaja). Sólo la Caja General de Oficinas.
- **Borrar** ninguna tabla vieja: el libro nuevo reconstruye su historia a partir de ellas.

---

## 3. Las capas

### C0 · Dato — el libro y sus reglas, en la base

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| LE.0.0 | **Contención.** `CG.58` apagado por default (`CAOS_INGRESO_CONCILIAR=on` lo enciende) y sin tocar depósitos que el libro explica. Migración `20261027101810`: regla B4 **en la base** (un depósito explicado por el libro no admite reparto; ligarlo retira el reparto) + baja lógica de las dobles (medidas: 162 atribuciones · $1,703,230, todas contra cobros del 21–28 jul). Pruebas: `caos-ingreso-recon.libro-real.spec.ts` y `test-newdb-caja-una-explicacion.js` (5 negativas + 2 mutaciones). **Sin desplegar, migración sin aplicar, pruebas de base sin correr** | 🔨 | la consulta de §1 da 0 después de aplicar |
| LE.0.1 | **Bolsas** (`finance.cash_bolsas`), con D2: **físicas** = Caja General · pesos (por denominación) · Caja General · dólares (separada: nunca se mezclan monedas en un saldo) · Caja General · documentos (cada cheque o nota de crédito es una pieza con folio) · Bóveda CAOS (billetes en pesos). **De control** = en tránsito (por persona) · por cobrar (por ruta/cobrador) · banco (lo que sale de CAOS al banco) · egresos (por concepto) · faltantes y sobrantes (por persona). Cada física con su **testigo** | ⬜ | D2 ✅ |
| LE.0.2 | **Asientos**: `finance.cash_asientos` (evento, fecha valor, quién, reversa_de) + `cash_asiento_lineas` (bolsa, monto con signo) + `cash_asiento_piezas` (bolsa, `denom_key`, piezas con signo). `tenant_id` + audit + RLS | ⬜ | — |
| LE.0.3 | **Invariantes en la base** (cada uno con su prueba que intenta romperlo y su mutación): (1) un asiento suma cero, en monto y por denominación en efectivo — trigger diferido; (2) **sólo se agrega**: sin UPDATE ni DELETE, se corrige con reversa; (3) ninguna bolsa física queda negativa, ni por denominación; (4) **cada evento externo se registra una sola vez** (`evento_ref` único: movimiento CAOS, cobro Kepler, pago); (5) quien registra no autoriza arriba del umbral (D3) | ⬜ | `test-newdb-libro-efectivo.js` en `caja-db` |
| LE.0.4 | **Saldos derivados**: vista de saldo por bolsa y por denominación a una fecha; nada se materializa | ⬜ | suma de asientos = saldo |
| LE.0.5 | **Testigo de la máquina**: guardar el conteo de CAOS (`caos_cash_counts`, hoy 0 filas) — sin él la bóveda no tiene testigo | ⬜ | conteo de la máquina = saldo de la bolsa bóveda |

⛔ Sin importer: los eventos externos se LEEN de sus fuentes (feed de CAOS, `kepler_ods`). Lo que no
se pueda verificar **se declara**, nunca se dibuja como 0.

### C1 · Dominio — qué asiento produce cada hecho

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| LE.1.1 | **Reglas de registro** (puras, en `libs/finance`): retiro CAOS → bóveda a tránsito/cajón; depósito → cajón/tránsito a bóveda; dotar y vaciar; cobro de ruta llega → por cobrar a cajón; gasto → cajón/tránsito a egreso; sobrante → tránsito a cajón/bóveda; faltante → tránsito a faltante con nombre | ⬜ | spec por evento + negativas |
| LE.1.2 | **Emparejador cobro ↔ efectivo por ruta y fecha** (la referencia del depósito, el grano de `CG.58.6`), nunca por antigüedad. Publica **precisión** con placebo y una muestra revisada a mano, no cobertura | ⬜ | placebo ±días = ~0 aciertos |
| LE.1.3 | **Reconstrucción del historial** desde el 27-may (primer movimiento de CAOS): cada hecho viejo pasa por las mismas reglas. Lo que no cuadre se lista como hallazgo con monto | ⬜ | saldo reconstruido de la bóveda = conteo de la máquina del 20-oct ($360,020) |
| LE.1.4 | **Cierre diario**: libro contra testigo en cada bolsa; cada diferencia, un hallazgo con monto, dueño y fecha | ⬜ | un día sembrado con un faltante da exactamente ese hallazgo |

### C2 · API

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| LE.2.1 | Registrar un hecho (captura de gasto/ingreso, clasificación de un retiro, rendición de cuentas) → asiento | ⬜ | sí | servicio real con el payload de la pantalla actual |
| LE.2.2 | Corte y arqueo **sobre saldos**: el esperado es el saldo de la bolsa, no una fórmula; doble llave obligatoria | ⬜ | sí | servicio real |
| LE.2.3 | Lectura: saldo por bolsa y denominación, a cargo de cada persona, cierre diario y hallazgos | ⬜ | no | <500 ms |
| LE.2.4 | **Operación en paralelo**: el libro viejo sigue operando; el nuevo se alimenta de los mismos hechos y se compara cada día. Se cambia cuando 10 cierres seguidos den cero diferencias sin explicar | ⬜ | — | — |

---

## 4. Decisiones (→ ADR)

| # | Decisión | ADR | Fecha |
|---|---|---|---|
| D1 | **LE reemplaza a CGA**: CGA pasa a ⏸️ y sus items A.50–A.57 se absorben aquí. ⚠️ Aun así quedan 5 fases 🔨 (AB, RH, PQ, FC, LE) contra el tope de 4 del método: FC la abrió el PM el 26-oct | firmada por el PM | 2026-10-27 |
| D2 | **Una sola caja física**: la Caja General de Oficinas, con poco efectivo en pesos, **dólares** y **documentos** (notas de crédito y cheques — así se entendió «no tas de crédito o cheques»; a confirmar). **La mayor parte del dinero vive en CAOS.** Ver LE.0.1 | firmada por el PM | 2026-10-27 |
| D3 | **Plazo** para rendir lo que está en tránsito y **umbral** de doble autorización | pendiente | — |
| D4 | **Partida doble como modelo del efectivo** (refina ADR-101: la custodia es una bolsa, los enlaces son asientos) | ADR-102 al abrir | — |
| D5 | Destino de las tablas `*_snapshot_bak` (regla 2) | pendiente | — |

---

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| `CG.58` sigue escribiendo atribuciones FIFO cada hora | Edgar | no tiene interruptor | LE.0.0 desplegado |
| Baja de las 86 atribuciones dobles | Edgar | escritura en prod | autorización del script de LE.0.0 |
| La bóveda no tiene testigo guardado | — | `caos_cash_counts` en 0 filas | LE.0.5 |
| Los gastos que sólo están en Kepler (no en el libro) no se pueden registrar como asientos con detalle | — | el libro de la suite empieza el 25-sep | LE.1.3 los declara por mes, con monto |
| `caja-db` (la base de prueba del CI) | — | ya se arma de nuevo (`fe3d46e88`) | — |

---

## 6. Definición de Terminado

- [ ] 1. Métricas (a), (b), (c) **remedidas**, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. Todo endpoint que escribe **ejercido contra base real** con el payload de la pantalla
- [ ] 4. Cada invariante de LE.0.3 **roto a propósito una vez**, rojo verificado
- [ ] 5. Todo primitivo genérico en `libs/` compartido **o** deuda con nombre en el tracker
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. **En prod**, o escrito por qué no y qué falta

---

## 7. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-27 | Plan escrito con la medición de §1, el inventario de §1.2 y las 38 reglas de banco de §0 | Claude, por pedido del PM |
| 2026-10-27 | PM firma D1 (LE reemplaza a CGA) y D2 (una caja física: pesos, dólares y documentos; el grueso en CAOS) y da el caso diario de §1.0. LE.0.0 en código (sin desplegar) | PM + Claude |
