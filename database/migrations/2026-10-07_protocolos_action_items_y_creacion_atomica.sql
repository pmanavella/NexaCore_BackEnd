-- Migración: 2026-10-07_protocolos_action_items_y_creacion_atomica
-- Módulo: Protocolos (public.protocolos, public.protocolo_items,
--         public.protocolo_pruebas)
--
-- Objetivo:
--   1) Action items por registro. Cada registro (fila de protocolo_pruebas)
--      tiene su propia lista de action items, independiente del checklist
--      estático del protocolo (protocolo_items) y de los comentarios
--      (observaciones). Se guardan en la misma fila, como `resultados`, así que
--      crear / editar / eliminar un registro sigue siendo una sola sentencia
--      atómica y borrar el registro borra sus action items.
--
--      Formato de action_items (jsonb, array de objetos):
--        [ { "texto": "Revisar sensor delantero" }, ... ]
--      Cada elemento es un objeto para poder sumar campos a futuro (estado,
--      responsable, fecha...) sin cambiar el esquema.
--
--   2) Creación atómica de protocolo + checklist. supabase-js no expone
--      transacciones: public.protocolo_crear_con_items inserta el protocolo y
--      sus ítems en una sola transacción (si falla un ítem, no queda creado un
--      protocolo sin checklist). Solo la ejecuta service_role (backend).
--
-- Esta migración:
--   1) Agrega protocolo_pruebas.action_items (jsonb NOT NULL DEFAULT '[]').
--      Los registros existentes quedan con una lista vacía.
--   2) CHECK: action_items siempre es un array JSON.
--   3) Crea public.protocolo_crear_con_items(...) RETURNS uuid.
--
-- No borra datos ni modifica columnas existentes.
-- Idempotente: puede correrse más de una vez sin error (DEV y PROD).
--
-- NO afecta finance, movimientos, comprobantes, OCR, excel, deudas, empleados,
-- salarios, movimientos_salario, suscripciones, migraciones,
-- inversiones_historicas, sueldos_historicos, cuentas_por_cobrar
-- ni conciliaciones_migracion.

BEGIN;

-- 1) Columna nueva: action_items
ALTER TABLE public.protocolo_pruebas
  ADD COLUMN IF NOT EXISTS action_items jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.protocolo_pruebas.action_items IS 'Action items propios del registro: array de objetos { "texto": text }. Independiente del checklist del protocolo (resultados) y de los comentarios (observaciones).';

-- 2) Constraint: siempre un array
ALTER TABLE public.protocolo_pruebas
  DROP CONSTRAINT IF EXISTS protocolo_pruebas_action_items_array;

ALTER TABLE public.protocolo_pruebas
  ADD CONSTRAINT protocolo_pruebas_action_items_array
  CHECK (jsonb_typeof(action_items) = 'array');

-- 3) Creación atómica de protocolo + checklist
--    p_items: array jsonb de { "texto": text, "orden": int, "activo": bool },
--    ya validado y normalizado por el backend.
CREATE OR REPLACE FUNCTION public.protocolo_crear_con_items(
  p_nombre      text,
  p_descripcion text,
  p_categoria   text,
  p_acceso      text,
  p_usuario     text,
  p_items       jsonb
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.protocolos (nombre, descripcion, categoria, acceso, activo, created_by, updated_by)
  VALUES (p_nombre, p_descripcion, p_categoria, p_acceso, true, p_usuario, p_usuario)
  RETURNING id INTO v_id;

  INSERT INTO public.protocolo_items (protocolo_id, texto, orden, activo)
  SELECT v_id, x.texto, x.orden, coalesce(x.activo, true)
  FROM jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) AS x(texto text, orden integer, activo boolean);

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.protocolo_crear_con_items(text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protocolo_crear_con_items(text, text, text, text, text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protocolo_crear_con_items(text, text, text, text, text, jsonb) TO service_role;

COMMIT;
