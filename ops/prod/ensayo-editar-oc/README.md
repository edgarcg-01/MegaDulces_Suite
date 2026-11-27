# Ensayo de «editar cantidades de una OC» contra el Kepler vivo (`[PQ.160]`)

Corre el `KeplerOcCancelAdapter` **real** (`editar`) contra Kepler y **no escribe nada**. Las lecturas son las de
verdad, con el mismo candado `FOR UPDATE NOWAIT`. El único paso que escribe, `confirmarEdicion`, se cambia por:

1. Copia a tablas temporales el encabezado y los renglones de la OC.
2. **Negativa del candado**: cambia `c9` de un renglón de la copia y corre su sentencia: debe afectar 0 filas.
3. Corre sobre las copias las mismas sentencias (`sentenciasEdicion`) y revisa renglones (`c9`, `c13 = c9 × c12`,
   `c24 = c9`, `c56 × c58 = c9`, `c31`, `c51`) y encabezado (IVA, IEPS, total = Σ renglones con impuestos, saldo = total).
4. Le pregunta a Kepler si `kepler_push` tiene cada permiso (`permisosEdicion`).
5. Hace `ROLLBACK`. El control compara la OC real (encabezado y renglones) antes y después: debe ser idéntica.

## Cómo se corre (desde `md`: Kepler sólo acepta a `kepler_push` desde ahí)

```bash
node ops/prod/ensayo-editar-oc/empaquetar.js /tmp/ensayo-editar-oc.cjs
scp /tmp/ensayo-editar-oc.cjs superoot@192.168.0.222:/tmp/ensayo-editar-oc-pq160.cjs
{ echo "$KEPLER_PUSH_URL_00"; echo '{"sucursal":"00","casos":[{"folio":"0007492","renglones":[{"renglon":1,"cantidad":140}]}]}'; } \
  | ssh superoot@192.168.0.222 'docker run --rm -i --network host -v /tmp/ensayo-editar-oc-pq160.cjs:/e.cjs:ro mirror.gcr.io/library/node:22-alpine node /e.cjs'
ssh superoot@192.168.0.222 'rm -f /tmp/ensayo-editar-oc-pq160.cjs'
```

Cómo leer la salida: **verde** = `fallas: []` y `control.intacta: true` en cada caso. El adaptador dice «aplicada»
porque no sabe que es un ensayo: **lo que vale es el control**. Elegir en el ODS una OC de la Suite pendiente y sin
vale, una con vale o recepción (debe salir **rechazada**) y una capturada en Kepler fuera de fórmula (**rechazada**).

## Resultado

| Fecha | Servidor | Resultado |
|---|---|---|
| 2026-11-26 | 00 CEDIS | 0007492 (dos renglones, 120,007.80 → 121,492.77) y 0007505 (un renglón, 202,496.92 → 203,308.52): sentencias 1/1 cada una, candado «0 filas (bien)», renglones y encabezado con la fórmula, **real intacta**. Únicas fallas: los permisos `kdm2.c9/c13/c31/c56` que `pq160_editar_oc.sql` todavía no da. 0007044 rechazada (recepción parcial) y 0007096 rechazada (cantidad ≠ presentación × empaque), intactas. |
