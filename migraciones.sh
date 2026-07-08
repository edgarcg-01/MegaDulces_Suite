#!/bin/bash
npx knex migrate:up 20260708120000_cash_cuts_desglose.js --knexfile database/knexfile-newdb.js
npx knex migrate:up 20260708120000_commercial_reorder_policy.js --knexfile database/knexfile-newdb.js
npx knex migrate:up 20260708120100_compras_perms_backfill.js --knexfile database/knexfile-newdb.js
