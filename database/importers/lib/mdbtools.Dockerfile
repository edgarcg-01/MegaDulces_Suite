# Adapter Access -> Postgres (Fase WR-hist / CA) — mdbtools en contenedor.
#
# Por qué en contenedor y no instalado en la máquina: mdbtools es nativo de Linux (C) y no tiene
# build oficial de Windows. Docker ya corre en la máquina de feeds (el Postgres local `pgvector-md`
# vive ahí), así que esto no agrega infraestructura ni toca el sistema — y se puede borrar con
# `docker rmi mdbtools:local` sin dejar rastro.
#
# Por qué mdbtools y no Jet (medido 2026-09-01 sobre `2025/44 YURECUARO.MDB`, JET3/Access 97):
#   · las 70 tablas exportadas en 67 s vs 554 s del carril Jet+PS32 → 8.3x
#   · fidelidad exacta: 152,718 filas y ΣValorVenta $7,629,584.75, idénticos al centavo
#   · no necesita PowerShell 32-bit (Jet 4.0 no tiene build 64-bit — ADR-031)
#
# Construir:  docker build -t mdbtools:local -f database/importers/lib/mdbtools.Dockerfile .
# (el importer `import-wincaja-hist.js` la construye solo si falta)
FROM debian:stable-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends mdbtools \
 && rm -rf /var/lib/apt/lists/*
