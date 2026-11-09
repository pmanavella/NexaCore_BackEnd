// Contratos estructurales de las migraciones 2026-11-09 (no las ejecuta ni
// prueba PostgreSQL: eso queda para la validación manual en nexacore_dev).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (nombre) => fs.readFileSync(path.join(__dirname, '../database/migrations', nombre), 'utf8');
const tiempos = leer('2026-11-09_tiempos_carga_manual_y_correcciones.sql');
const menciones = leer('2026-11-09_comentarios_menciones_y_notificaciones.sql');
const verificaciones = fs.readFileSync(path.join(__dirname, '../database/verificaciones/2026-11-09_previas_actualizaciones_operativo.sql'), 'utf8');

// Cuerpo de una función CREATE OR REPLACE FUNCTION public.<nombre>(... $$ ... $$;
function funcion(sql, nombre) {
  const desde = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${nombre}(`);
  assert.ok(desde >= 0, `falta la función ${nombre}`);
  const fin = sql.indexOf('$$;', sql.indexOf('$$', desde) + 2);
  return sql.slice(desde, fin);
}

for (const [nombre, sql] of [['tiempos', tiempos], ['menciones', menciones]]) {
  test(`SQL ${nombre}: transaccional, aditiva y sin operaciones destructivas`, () => {
    assert.match(sql, /^BEGIN;$/m);
    assert.match(sql, /^COMMIT;$/m);
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM public\.(tarea_registros_tiempo|tarea_comentarios|notificaciones)\b(?!_)|DISABLE TRIGGER|SET duracion_segundos/i);
    assert.match(sql, /IF NOT EXISTS/);
    assert.match(sql, /RAISE EXCEPTION 'Requiere 2026-11-03_tiempos_integridad_y_acceso'/);
    assert.match(sql, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
  });
}

test('SQL tiempos: origen separado de motivo_finalizacion; duración generada reutilizada', () => {
  assert.match(tiempos, /ADD COLUMN IF NOT EXISTS origen\s+text\s+NOT NULL DEFAULT 'temporizador'/);
  assert.match(tiempos, /CHECK \(origen IN \('temporizador', 'carga_manual'\)\)/);
  assert.match(tiempos, /origen = 'carga_manual' AND fin IS NOT NULL AND fin > inicio\s+AND motivo_finalizacion IS NULL/);
  assert.match(tiempos, /motivo_finalizacion IN \('manual', 'automatico'\)/);
  assert.doesNotMatch(tiempos, /duracion_segundos\s+integer|ADD COLUMN[^;]*duracion/i);
});

test('SQL tiempos: el trigger protector conserva las reglas originales y solo habilita la corrección por RPC', () => {
  const proteger = funcion(tiempos, 'tarea_registros_tiempo_proteger');
  for (const campo of ['tarea_id', 'origen', 'version', 'corregido_at']) {
    assert.match(proteger, new RegExp(`NEW\\.${campo} IS DISTINCT FROM OLD\\.${campo}`), campo);
  }
  assert.match(proteger, /NEW\.usuario_id IS DISTINCT FROM OLD\.usuario_id AND NEW\.usuario_id IS NOT NULL/);
  assert.match(proteger, /NEW\.fin IS NULL OR NEW\.motivo_finalizacion IS DISTINCT FROM OLD\.motivo_finalizacion/);
  assert.match(proteger, /current_setting\('nexacore\.tiempo_correccion', true\) IS DISTINCT FROM OLD\.id::text/);
  assert.match(proteger, /NEW\.version := OLD\.version \+ 1/);
  const alta = funcion(tiempos, 'tarea_registros_tiempo_proteger_alta');
  assert.match(alta, /NEW\.fin IS NOT NULL OR NEW\.motivo_finalizacion IS NOT NULL/);
  assert.match(alta, /current_setting\('nexacore\.tiempo_carga', true\) IS DISTINCT FROM 'on'/);
  // Las marcas son locales a la transacción y solo las fijan las RPC.
  assert.equal((tiempos.match(/set_config\('nexacore\.[a-z_]+', [^)]+, true\)/g) || []).length, 6);
  assert.doesNotMatch(tiempos, /set_config\([^)]*false\)/);
});

test('SQL tiempos: auditoría append-only escrita por trigger en la misma transacción', () => {
  const auditar = funcion(tiempos, 'tarea_registros_tiempo_auditar');
  assert.match(auditar, /SECURITY DEFINER SET search_path = public/);
  assert.match(auditar, /'carga_manual'/);
  assert.match(auditar, /'correccion'/);
  assert.match(auditar, /OLD\.inicio, OLD\.fin, NEW\.inicio, NEW\.fin/);
  assert.match(tiempos, /AFTER INSERT OR UPDATE OF inicio, fin ON public\.tarea_registros_tiempo/);
  assert.match(tiempos, /REVOKE ALL ON TABLE public\.tarea_registros_tiempo_auditoria FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(tiempos, /GRANT SELECT ON TABLE public\.tarea_registros_tiempo_auditoria TO service_role;/);
  assert.doesNotMatch(tiempos, /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*tarea_registros_tiempo_auditoria/);
});

test('SQL tiempos: RPC con lock, acceso, autoría, versión e intervalo antes de escribir; sin RPC de eliminación', () => {
  for (const nombre of ['tarea_tiempo_registrar_manual', 'tarea_tiempo_corregir']) {
    const rpc = funcion(tiempos, nombre);
    const escritura = Math.max(rpc.indexOf('INSERT INTO'), rpc.indexOf('UPDATE public.tarea_registros_tiempo'));
    assert.ok(rpc.indexOf('PERFORM public.tarea_tiempos_bloquear()') < rpc.indexOf('FOR SHARE'), nombre);
    assert.ok(rpc.indexOf('tarea_tiempo_tiene_acceso') < escritura, nombre);
    assert.ok(rpc.indexOf('tarea_tiempo_validar_intervalo') < escritura, nombre);
    assert.doesNotMatch(rpc, /tarea_es_final/, `${nombre}: admite tareas finalizadas`);
    assert.doesNotMatch(rpc, /UPDATE public\.tareas/, `${nombre}: no modifica la tarea`);
  }
  const corregir = funcion(tiempos, 'tarea_tiempo_corregir');
  assert.match(corregir, /v_registro\.usuario_id IS DISTINCT FROM p_usuario_id/);
  assert.match(corregir, /NX_REGISTRO_ACTIVO/);
  assert.match(corregir, /p_version <> v_registro\.version/);
  const intervalo = funcion(tiempos, 'tarea_tiempo_validar_intervalo');
  assert.match(intervalo, /p_inicio >= p_fin/);
  assert.match(intervalo, /p_fin > clock_timestamp\(\)/);
  assert.doesNotMatch(tiempos, /FUNCTION public\.tarea_tiempo_(eliminar|borrar)/);
  // No toca las RPC del temporizador.
  assert.doesNotMatch(tiempos, /FUNCTION public\.tarea_tiempo_(iniciar|detener)\(/);
});

test('SQL menciones: notificaciones sobreviven al comentario y no se duplican', () => {
  const tabla = menciones.slice(menciones.indexOf('CREATE TABLE IF NOT EXISTS public.notificaciones'), menciones.indexOf(');', menciones.indexOf('CREATE TABLE IF NOT EXISTS public.notificaciones')));
  assert.match(tabla, /comentario_id\s+uuid NOT NULL,/);
  assert.doesNotMatch(tabla, /comentario_id[^,]*REFERENCES/);
  assert.match(tabla, /destinatario_id\s+uuid NOT NULL REFERENCES public\.usuarios\(id\) ON DELETE CASCADE/);
  assert.match(tabla, /autor_id\s+uuid\s+REFERENCES public\.usuarios\(id\) ON DELETE SET NULL/);
  assert.match(menciones, /UNIQUE INDEX IF NOT EXISTS uq_notificaciones_destinatario_tipo_comentario\s+ON public\.notificaciones \(destinatario_id, tipo, comentario_id\)/);
  assert.match(menciones, /ON CONFLICT \(destinatario_id, tipo, comentario_id\) DO NOTHING/);
  assert.match(menciones, /AFTER DELETE ON public\.tarea_comentarios/);
  assert.match(funcion(menciones, 'tarea_comentarios_notificaciones_eliminado'), /SET comentario_eliminado_at = now\(\)/);
  assert.match(funcion(menciones, 'tarea_comentario_notificar'), /WHERE x IS DISTINCT FROM p_autor_id/);
});

test('SQL menciones: solo miembros activos (sin mando alto ajeno), verificados con filas bloqueadas', () => {
  const exigir = funcion(menciones, 'tarea_comentario_exigir_mencionables');
  assert.match(exigir, /FOR SHARE OF m, u/);
  assert.match(exigir, /u\.estado = 'Activo'/);
  assert.match(exigir, /operativo_tablero_miembros/);
  assert.doesNotMatch(exigir, /nivel_jerarquico|HIGH|tarea_tiempo_tiene_acceso/);
  for (const nombre of ['tarea_comentario_crear', 'tarea_comentario_editar']) {
    const rpc = funcion(menciones, nombre);
    assert.match(rpc, /SECURITY DEFINER SET search_path = public/, nombre);
    assert.ok(rpc.indexOf('tarea_comentario_exigir_mencionables') < rpc.indexOf('tarea_comentario_notificar'), nombre);
    assert.ok(rpc.indexOf('tarea_tiempo_tiene_acceso') < rpc.indexOf('tarea_comentario_exigir_mencionables'), nombre);
  }
  const editar = funcion(menciones, 'tarea_comentario_editar');
  assert.match(editar, /v_comentario\.usuario_id IS DISTINCT FROM p_autor_id/);
  assert.match(editar, /tarea_comentario_exigir_mencionables\(v_tablero_id, v_nuevos\)/);
  assert.match(editar, /tarea_comentario_notificar\(p_comentario_id, p_tarea_id, p_autor_id, v_nuevos\)/);
});

test('SQL menciones: el backend solo lee menciones y solo marca leida_at', () => {
  assert.match(menciones, /REVOKE ALL ON TABLE public\.tarea_comentario_menciones, public\.notificaciones\s+FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(menciones, /GRANT SELECT ON TABLE public\.tarea_comentario_menciones, public\.notificaciones TO service_role;/);
  assert.match(menciones, /GRANT UPDATE \(leida_at\) ON TABLE public\.notificaciones TO service_role;/);
  assert.doesNotMatch(menciones, /GRANT (INSERT|DELETE|ALL)[^;]*(notificaciones|tarea_comentario_menciones)/);
  const proteger = funcion(menciones, 'notificaciones_proteger');
  assert.match(proteger, /OLD\.leida_at IS NOT NULL AND NEW\.leida_at IS DISTINCT FROM OLD\.leida_at/);
  assert.match(proteger, /NEW\.leida_at := now\(\)/);
  for (const tabla of ['tarea_comentario_menciones', 'notificaciones']) {
    assert.match(menciones, new RegExp(`ALTER TABLE public\\.${tabla} ENABLE ROW LEVEL SECURITY`));
  }
});

test('Verificaciones previas: solo lectura', () => {
  assert.doesNotMatch(verificaciones, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|BEGIN|COMMIT)\b/);
  assert.match(verificaciones, /SELECT/);
});
