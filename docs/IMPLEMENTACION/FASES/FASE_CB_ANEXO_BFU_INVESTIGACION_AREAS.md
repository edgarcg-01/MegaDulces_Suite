# Investigación BFU.4.5 — quién explica cada movimiento del banco (2026-11-24)

> Anexo de [`FASE_CB_ANEXO_BANCO_FUENTE_UNICA.md`](FASE_CB_ANEXO_BANCO_FUENTE_UNICA.md), BFU.4.5 («cada área ve y
> reconoce sus movimientos del banco»). Pedido de Edgar, 2026-11-24: *«genera una investigación exhaustiva para
> resolver dudas actuales y futuras»*. Cada respuesta dice con qué se midió; lo que no se midió, lo dice.

**Con qué se midió:** `pg-prod` (`system_identifier` 7688376744939610156), sólo lectura (`BEGIN READ ONLY`), el
2026-11-24. Universo: los movimientos de banco de noviembre (descarga del banco, 1–24 nov) y, para aprender o comparar,
los de junio–octubre. Kepler por el ODS (`analytics.kepler_bank_movements`, `analytics.bank_movement_legs`,
`kepler_ods.kdm1`). Todo cruce que pudo darse por azar lleva su **placebo**.

---

## Las respuestas en corto

1. **«Cobranza» son dos cosas**: el depósito de la **venta de la sucursal** (Kepler `U-A-5`, cliente «CONTADO») y el
   **cobro a un cliente** (`U-A-7`, cliente real). No le tocan a la misma gente.
2. **El texto del banco casi nunca dice quién pagó**: identifica al cliente en menos del 3 % de los depósitos.
3. **Kepler tarda días, no semanas**: la mitad de los documentos se capturan en 2–3 días y 8 de cada 10 en una semana.
4. **La mayoría de lo «pendiente» se resuelve solo**: de los depósitos sin documento, la mitad tiene 7 días o menos.
   Lo que de verdad espera a una persona son unos 190 depósitos, no 453.
5. **26 depósitos viejos están en Kepler en otra cuenta de banco** (placebo: 1). No falta el documento: está mal
   registrado.
6. **Pocas personas capturan en Kepler**: la venta de contado la capturan 5 usuarios, cada uno con sus sucursales; los
   cobros a cliente, un usuario (dos cuentas) que por su nombre es Crédito y Cobranza. El responsable **se puede derivar**.
7. **Las compras con tarjeta son sobre todo combustible y casetas**: gasto de la flotilla, de Logística. Y 35 renglones
   de comisión de AMEX están categorizados como compra.
8. **Hoy 9 roles pueden gestionar Bancos y 2 sólo verlo**; los demás tienen el permiso en falso.

---

## P1. ¿Qué es un depósito «cobranza»?

Kepler los separa y el banco no. De los depósitos de noviembre que la conciliación ya casó:

| Documento de Kepler | Casados | A quién | Qué es |
|---|---:|---|---|
| `U-A-5` | 945 | «CONTADO» o un punto de venta | Depósito de la venta de la sucursal (efectivo del corte, cortes de terminal) |
| `U-A-7` | 588 | Más de 170 clientes distintos | Cobro a un cliente de crédito |

De los 453 depósitos «cobranza» de noviembre **sin documento**: 144 son cortes de terminal, 187 efectivo, ~55
transferencias de cliente, 51 venta en línea, 12 compensaciones o traspasos y un préstamo. El efectivo puede ser de
cualquiera de los dos: lo decide el documento de Kepler cuando llega.

**Consecuencia:** el pendiente de un depósito no es de «Crédito y Cobranza» por defecto (D18 del anexo).

## P2. ¿El texto del banco identifica al cliente?

Casi nunca. Se aprendió de los depósitos de junio–octubre ya casados a un cobro `U-A-7` y se probó contra los 588 de
noviembre; placebo = el cliente de otro renglón al azar.

| Señal | Propone | Acierta | Placebo |
|---|---:|---:|---:|
| El mismo texto, sin números, visto 1 vez antes | 124 | 21 | 1 |
| El mismo texto visto 2 o más veces | 10 | 10 | 0 |
| Un número largo del texto (cuenta de origen) visto con un solo cliente | 6 | 6 | 0 |

Exacto cuando hay señal, pero alcanza a menos del 3 %. De los 449 pendientes, 5 tendrían cuenta de origen conocida.
**Causa:** el efectivo y los cortes de terminal no nombran a nadie. **Consecuencia:** la bandeja no se construye sobre
«el sistema propone el cliente»; el pendiente va a quien captura el documento en Kepler.

## P3. ¿Cuánto tarda Kepler en tener el documento?

Días entre el depósito en el banco y la captura del documento casado (`fecha_captura`), sep–nov:

| Documento | Casados | Mediana | 8 de cada 10 | 95 de cada 100 |
|---|---:|---:|---:|---:|
| `U-A-5` venta de sucursal | 4,480 | 2 días | 5 días | 10 días |
| `U-A-7` cobro a cliente | 1,826 | 3 días | 7 días | 19 días |

**Consecuencia:** D13 (5 días hábiles ≈ 7 naturales antes de que el pendiente pase al área) queda **validada por
medición**: cubre a 8 de cada 10. Antes de ese plazo, un depósito sin documento es «Kepler todavía no lo tiene», no un
pendiente de nadie.

## P4. ¿Cuántos pendientes son de verdad?

Edad de los depósitos «cobranza» de noviembre sin documento, en días naturales al 24-nov:

| Tipo | Total | ≤ 7 días | 8–14 | > 14 |
|---|---:|---:|---:|---:|
| Corte de terminal | 144 | 116 | 8 | 20 |
| Efectivo | 187 | 108 | 41 | 38 |
| Transferencia de cliente | 54 | 27 | 9 | 18 |
| Venta en línea | 51 | 2 | 49 | 0 |
| Compensación / traspaso | 12 | 8 | 3 | 1 |

**Consecuencia:** una bandeja que muestre todo desde el día uno enseña 453 y la mitad se resuelve sola. Con el plazo de
P3, el trabajo real es de ~190.

## P5. ¿Kepler ya tiene el documento y la conciliación no lo casó?

Para los 187 pendientes de más de 7 días se buscó en Kepler un documento `U-A-5/7/25` **sin casar**, del mismo importe
(al centavo) y ±10 días.

| Dónde | Encontrados | Placebo (+37 centavos) | Placebo (+1 peso) |
|---|---:|---:|---:|
| La misma cuenta de banco | 1 | 0 | — |
| **Otra cuenta de banco** | **26** | 1 | 0 |

**Respuesta:** en la misma cuenta, no (la conciliación no se está dejando nada). En otra cuenta, sí: **26 depósitos
están capturados en Kepler en la cuenta equivocada**. Un solo patrón se repite: depósitos de Canindo que el banco
muestra en BTE 7133 y Kepler registra en BB 854 (6); el resto son casos sueltos. BTE 7133 casa 131 de 151 depósitos, así
que no es una cuenta mal configurada sino capturas puntuales. **Consecuencia:** el motivo `kepler_en_otra_cuenta` (hoy
sólo de retiros) aplica también a depósitos, y le toca a Tesorería corregirlo en Kepler.

Los ~160 restantes de más de 7 días **no tienen documento en Kepler con ese importe**: falta capturarlo, o se capturó
agrupado o con otro importe (NO MEDIDO: el cruce por sumas de varios documentos no se hizo).

## P6. ¿Quién captura esos documentos en Kepler?

El usuario que capturó (`kdm1.c67`) los `U-A-5` y `U-A-7` con captura en noviembre:

| Documento | Usuarios de Kepler | Cómo se reparten |
|---|---:|---|
| `U-A-5` venta de sucursal | 5 principales (+5 con pocos) | Uno lleva CEDIS, Padre Hidalgo, La Piedad Abastos y 8 Esquinas; otro CEDIS, Morelia Madero y Morelia Abastos; otro Canindo; dos Zamora Centro; otro CEDIS y Yurécuaro |
| `U-A-7` cobro a cliente | 1 (en dos cuentas) | Padre Hidalgo, Canindo y Morelia Abastos; por su nombre, Crédito y Cobranza (a confirmar) |

De esos 10 usuarios de Kepler, **sólo 1 tiene un usuario con el mismo nombre en la Suite**. **Consecuencia:** el
responsable de los depósitos de cada sucursal **se deriva** del ODS (quien capturó sus `U-A-5` en los últimos 30 días),
sin configurarlo a mano; lo único que falta es el par «usuario de Kepler → usuario de la Suite», que se pregunta una vez,
como parámetro. La lista con los usuarios está en el chat del 2026-11-24 con Edgar (no va aquí: el repo es público).

## P7. ¿Qué es lo pendiente que no es cobranza?

Noviembre, sin documento de Kepler ni pago del Calendario, sin contar cobranza ni cargos del banco:

| Qué | Cuántos | De quién |
|---|---:|---|
| Compra con tarjeta | 125 | Ver abajo |
| Sin categoría, «Kepler todavía no lo tiene» | 37 | Nadie todavía (recientes) |
| Sin categoría, «Kepler no lo tiene» | 14 | El motor dice «el área» sin decir cuál |
| Sin categoría, «en otra cuenta» | 4 | Tesorería |
| Sin categoría y sin motivo | 2 | Nadie (el motor no decidió) |
| Servicios, crédito, nómina, compra, traspasos, devoluciones, administración | 32 | Su área por categoría (BFU.4.5.1) |

**Las compras con tarjeta**: 85 en gasolineras, 16 casetas («PZA COBRO»), 8 comisiones de AMEX, 12 otras, 4 de
servicios y suscripciones. El texto del banco trae el comercio (y casi siempre su RFC). **Consecuencias:** combustible y
casetas son gasto de la flotilla → Logística (y dato para la fase FC, costo por unidad); «COM. VTA. NAL. AMEX» es
**comisión bancaria mal categorizada** (35 renglones desde agosto: vocabulario del banco, como BFU.7.8).

**Los 14 «Kepler no lo tiene»**: 6 «crédito líquido, cobro del periodo» (Tesorería), FONACOT (RH), un seguro, un
anticipo a proveedor (Compras) y transferencias sin texto. El texto sí dice el área en la mayoría.

## P8. ¿Qué es la «venta en línea»?

49 depósitos llegaron a BNMX 1463 entre el 10 y el 13 de noviembre con el texto «Venta tiktok dd/mm», por ventas del 24
de agosto al 9 de septiembre: liquidaciones de TikTok con más de dos meses de retraso, de importe chico. Kepler no tiene
documento. **Falta de Edgar:** de quién es ese canal (Mercadotecnia, comercio en línea) y si esa venta pasa por Kepler.

## P9. ¿Quién ve Bancos hoy?

`identity.role_permissions`, valor del permiso (no sólo la clave):

| Permiso | Roles |
|---|---|
| Ver y gestionar | 9: contabilidad, crédito y cobranza, finanzas, finanzas operativo, auxiliar finanzas, tesorería, superadmin, **gerente de compras, marketing** |
| Sólo ver | 2: dirección, auditor externo |
| Clave presente en falso | 20 (vendedores, tienda, almacén, cliente B2B…): no ven nada |

Gente activa en los departamentos que recibirían pendientes: Crédito y Cobranza 3, Tesorería 1, Administración 1,
Contabilidad 4, RH 4, Logística 3, Compras 10, Cajas 16, Tienda 61. **Consecuencias:** (a) hoy Crédito y Cobranza ya ve
**todo** Bancos con saldos; D15 («cada área sólo lo suyo, sin saldos») sería **quitarle** vista, no dársela; (b) que
`marketing` y `gerente_compras` puedan **gestionar** Bancos merece una pregunta (NO MEDIDO: desde cuándo y por qué).

## P10. ¿Los mecanismos de liga a mano se usan?

| Mecanismo | Filas |
|---|---:|
| `finance.bank_capture_inbox` | 0 |
| `finance.bank_movements.customer_code` (cliente declarado) | 0 |
| `finance.payment_program.bank_movement_id` | 0 |
| `contpaqi.pago_confirmaciones` | 0 |
| Categoría puesta a mano (`classified_by = 'manual'`) | 392, la última el 2026-09-10 |

**Consecuencia:** D17 (apagar lo que la bandeja reemplace) se sostiene; no hay datos que migrar.

## P11. ¿Noviembre es representativo?

No para comparar **por tipo de depósito**: agosto–octubre vienen del libro de Tesorería (su propio texto) y noviembre de
la descarga del banco (D1). En total, los depósitos «cobranza» casaron 78 % en agosto, 81 % en septiembre y 88 % en
octubre, ya cerrados: **entre 12 y 22 % nunca encontró su documento** en la era del libro. Noviembre va en 76 % al
24-nov (2,016 depósitos), con la última semana todavía dentro del plazo de captura (P3). Lo que hay que medir al cierre de diciembre: el residuo del primer mes completo de la descarga.

## P12. ¿El préstamo sigue contado como cobranza?

Sí. El depósito de préstamo del 20-nov sigue en «cobranza» (`classified_by = banco`); el arreglo del clasificador
(BFU.7.10, «depósito que no es venta») está en código de otra sesión y no ha llegado a prod. Al llegar, noviembre se
re-clasifica con corrida en seco y respaldo (regla de Bancos).

---

## Lo que cambia en el plan

| # | Cambio | Por qué (respuesta) | Item |
|---|---|---|---|
| 1 | Un depósito sin documento es pendiente **después de 7 días naturales**; antes, «Kepler todavía no lo tiene» | P3, P4 | BFU.4.5.9 |
| 2 | El responsable de los depósitos de una sucursal **se deriva** de quién captura sus `U-A-5`; el cobro a cliente, de quién captura `U-A-7` | P1, P6 | BFU.4.5.10 |
| 3 | «En otra cuenta» también para depósitos → Tesorería | P5 | BFU.4.5.11 |
| 4 | Vocabulario: comisión de AMEX es comisión bancaria; gasolinera y caseta son gasto logístico | P7 | BFU.7.11 |
| 5 | La bandeja no promete «propuesta de cliente»; sólo la muestra en el puñado que la tiene | P2 | BFU.4.5.3 (cerrado) |

## Lo que sigue sin respuesta (de Edgar o de Sistemas)

1. El par «usuario de Kepler → usuario de la Suite» de los 10 que capturan depósitos y cobros (P6).
2. De quién es la venta de TikTok y si pasa por Kepler (P8).
3. Por qué `marketing` y `gerente_compras` gestionan Bancos (P9).
4. D15: ¿se le quita a Crédito y Cobranza la vista de saldos que hoy tiene? (P9)
5. NO MEDIDO: si los ~160 depósitos viejos sin documento están en Kepler agrupados (suma de varios) o con otro importe.
