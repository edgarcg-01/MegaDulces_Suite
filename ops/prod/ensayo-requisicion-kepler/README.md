# Ensayo de la requisición (`X-A-30` / OC `X-A-35` / traspaso `U-D-40`) contra el Kepler vivo (`[PGP.122.4]`)

Espejo de `../ensayo-pago-kepler/`. Corre el `KeplerRequisitionSinkAdapter` **real** contra Kepler y
termina en `ROLLBACK`: no escribe nada. Prueba lo que el spec (`kepler-requisition-sink.ensayo.spec.ts`)
no puede en `md`: que el folio sale del **contador** de Kepler (`md.sqliov`, con el GRANT de
`[PGP.122.4]`) y que `sqliov.c4` quedó avanzado — el arreglo que reemplaza al viejo `MAX(c6)+1`.

**Por qué desde `md`:** `pg_hba.conf` de Kepler sólo acepta `kepler_push` desde `md`, que no tiene
node ni el repo. Se empaqueta en un `.cjs` y corre en un contenedor que se borra.

## Cómo se corre

```bash
# 1. Empaquetar en la máquina de trabajo (sin credenciales dentro):
node ops/prod/ensayo-requisicion-kepler/empaquetar.js /tmp/ensayo-requisicion.cjs
scp /tmp/ensayo-requisicion.cjs superoot@192.168.0.222:/tmp/ensayo-requisicion.cjs
# 2. Correr. 1ª línea stdin = URL de kepler_push; 2ª = JSON { sucursal, plantilla_req, plantilla_ped? }.
#    plantilla_req = KEPLER_REQ_TEMPLATE_FOLIO_NN del maestro; plantilla_ped = la de traspaso (opcional).
{ echo "$KEPLER_PUSH_URL_00"; echo '{"sucursal":"00","plantilla_req":"0000424","plantilla_ped":"0000450"}'; } \
  | ssh superoot@192.168.0.222 'docker run --rm -i --network host -v /tmp/ensayo-requisicion.cjs:/e.cjs:ro mirror.gcr.io/library/node:22-alpine node /e.cjs'
ssh superoot@192.168.0.222 'rm -f /tmp/ensayo-requisicion.cjs'
```

Verde = `fallas: []` en cada caso, `contadores` mostrando `folio` → `contador` (folio+1), y
`CONTROL: … = 0`. El traspaso puede salir **NO MEDIDO** si en esa sucursal no hay un SKU con caja en
la ficha o no hay plantilla de traspaso — es un límite de datos, no del arreglo.

## Resultado

| Fecha | Resultado |
|---|---|
| 2026-11-17 | 00 **verde**: compra `KFXA3001` (cazó 28 de atraso del contador, lo corrigió), OC `KFXA3501`. Control 0. Traspaso `KFUD4001` NO MEDIDO (sin SKU con caja sana en 00). |
