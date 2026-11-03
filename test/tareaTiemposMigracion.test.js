// Contratos estructurales del SQL, no ejecución de migraciones ni prueba MVCC.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../database/migrations/2026-11-03_tiempos_integridad_y_acceso.sql'), 'utf8');
const { TIPOS_BASE_FINALES } = require('../operations/config/etapas');
const original = fs.readFileSync(path.join(__dirname, '../database/migrations/2026-11-03_tareas_comentarios_y_tiempos.sql'), 'utf8');

test('SQL: CHECK exige motivo no nulo al finalizar y conserva la duración generada', () => {
  assert.match(sql, /fin IS NULL AND motivo_finalizacion IS NULL/);
  assert.match(sql, /fin IS NOT NULL AND motivo_finalizacion IS NOT NULL\s+AND motivo_finalizacion IN \('manual', 'automatico'\)/);
  assert.match(sql, /RAISE EXCEPTION 'Hay tiempos finalizados sin motivo/);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM|DISABLE TRIGGER|SET duracion_segundos/i);
  assert.match(original, /duracion_segundos\s+integer GENERATED ALWAYS AS/);
});

test('SQL: inicio y mutaciones comparten lock antes de comprobar estado o tomar filas', () => {
  const rpc = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.tarea_tiempo_iniciar'));
  assert.ok(rpc.indexOf('PERFORM public.tarea_tiempos_bloquear()') < rpc.indexOf('FOR SHARE'));
  assert.ok(rpc.indexOf('tarea_tiempo_tiene_acceso') < rpc.indexOf('INSERT INTO'));
  assert.ok(rpc.indexOf('tarea_es_final') < rpc.indexOf('INSERT INTO'));
  assert.match(sql, /pg_advisory_xact_lock\(20261103, 1\)/);
  assert.match(sql, /BEFORE UPDATE OF %s OR DELETE.*FOR EACH STATEMENT/);
  assert.match(sql, /AFTER UPDATE OF %s OR DELETE.*FOR EACH STATEMENT/);
  assert.match(sql, /USING ERRCODE = '40001'/);
});

test('SQL: cubre fuentes reales de acceso sin introducir permisos de módulo ni admin', () => {
  for (const fuente of ['tareas', 'operativo_etapas', 'operativo_tablero_miembros', 'usuarios', 'roles']) {
    assert.ok(sql.includes(`('${fuente}',`));
  }
  const acceso = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.tarea_tiempo_tiene_acceso'), sql.indexOf('CREATE OR REPLACE FUNCTION public.tarea_tiempos_reconciliar()'));
  assert.match(acceso, /u.estado = 'Activo'/);
  assert.match(acceso, /r.nivel_jerarquico = 'HIGH'/);
  assert.doesNotMatch(acceso, /es_admin|modulo_permisos/);
  assert.match(sql, /greatest\(clock_timestamp\(\), r.inicio\), motivo_finalizacion = 'automatico'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
});

test('SQL: reutiliza criterio final existente y mantiene paridad con JS', () => {
  assert.deepEqual(TIPOS_BASE_FINALES, ['completada', 'cancelada']);
  assert.match(original, /e.tipo_base IN \('completada', 'cancelada'\)/);
  assert.match(sql, /public.tarea_es_final\(t.etapa_id, t.estado\)/);
  assert.match(sql, /SELECT public.tarea_tiempos_reconciliar\(\);\s*COMMIT;/);
});
