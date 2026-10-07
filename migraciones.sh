#!/bin/bash
set -e
KNEXFILE=database/knexfile-newdb.js

npx knex migrate:up 20260708120000_cash_cuts_desglose.js          --knexfile $KNEXFILE
npx knex migrate:up 20260708120000_commercial_reorder_policy.js   --knexfile $KNEXFILE
npx knex migrate:up 20260708120100_compras_perms_backfill.js      --knexfile $KNEXFILE
npx knex migrate:up 20260708140000_analytics_pos_cashiers.js      --knexfile $KNEXFILE
npx knex migrate:up 20260708160000_cash_cuts_horario.js           --knexfile $KNEXFILE
npx knex migrate:up 20260708180000_reconciliation_blind_counts.js --knexfile $KNEXFILE
npx knex migrate:up 20260708200000_blind_counts_relevo.js         --knexfile $KNEXFILE
npx knex migrate:up 20260708220000_reconciliation_actions.js      --knexfile $KNEXFILE
