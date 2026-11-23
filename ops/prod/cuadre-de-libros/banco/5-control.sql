SELECT 'ctrl', (SELECT count(*) FROM p) p_banco, (SELECT count(*) FROM pm) emparejados, (SELECT round(sum(p.amt)) FROM pm JOIN p USING (pid)) monto_emp, (SELECT count(*) FROM p WHERE amt>=10000) p_10k, (SELECT count(*) FROM pm JOIN p USING (pid) WHERE p.amt>=10000) emp_10k;
ROLLBACK;
