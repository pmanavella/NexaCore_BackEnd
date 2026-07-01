-- ============================================================
-- Módulo PROTOCOLOS — NexaCore
-- Gestión de protocolos, checklists y pruebas de proyectos.
--
-- Este script es aditivo y seguro para re-ejecutar:
--   - Crea tablas nuevas (no toca ninguna tabla existente).
--   - Registra el módulo "protocolos" en la tabla `modulos`
--     con INSERT ... ON CONFLICT DO NOTHING (no borra ni
--     modifica módulos existentes).
--
-- NO afecta finance, movimientos, comprobantes, OCR, excel,
-- deudas, empleados, salarios, suscripciones, migraciones,
-- inversiones_historicas, sueldos_historicos,
-- cuentas_por_cobrar ni conciliaciones_migracion.
-- ============================================================

-- ── 1. Tabla: protocolos ─────────────────────────────────────
create table if not exists public.protocolos (
  id           uuid primary key default gen_random_uuid(),
  nombre       text not null,
  descripcion  text,
  categoria    text not null check (categoria in ('robot', 'instalacion', 'hardware', 'rrhh')),
  acceso       text,
  activo       boolean default true,
  created_at   timestamp with time zone default now(),
  updated_at   timestamp with time zone default now(),
  created_by   text,
  updated_by   text
);

-- ── 2. Tabla: protocolo_items (checklist) ────────────────────
create table if not exists public.protocolo_items (
  id            uuid primary key default gen_random_uuid(),
  protocolo_id  uuid not null references public.protocolos(id) on delete cascade,
  texto         text not null,
  orden         integer not null,
  activo        boolean default true,
  created_at    timestamp with time zone default now()
);

create index if not exists idx_protocolo_items_protocolo_id
  on public.protocolo_items(protocolo_id);

-- ── 3. Tabla: protocolo_pruebas (historial de pruebas) ───────
create table if not exists public.protocolo_pruebas (
  id            uuid primary key default gen_random_uuid(),
  protocolo_id  uuid not null references public.protocolos(id) on delete cascade,
  realizado_por text,
  fecha         date not null default current_date,
  resultados    jsonb not null,
  observaciones text,
  created_at    timestamp with time zone default now(),
  created_by    text
);

create index if not exists idx_protocolo_pruebas_protocolo_id
  on public.protocolo_pruebas(protocolo_id);

-- Formato esperado de `resultados` (jsonb):
-- [
--   {
--     "item_id": "uuid",
--     "texto": "Verificar carga de batería",
--     "estado": "ok",   -- 'ok' | 'fail' | 'na'
--     "nota": "Sin observaciones"
--   }
-- ]

-- ── 4. Registro del módulo en la tabla `modulos` ─────────────
-- INSERT seguro: si ya existe un módulo con nombre 'protocolos'
-- no se modifica ni se duplica nada.
insert into public.modulos (nombre, label, descripcion)
values ('protocolos', 'Protocolos', 'Gestión de protocolos, checklists y pruebas de proyectos')
on conflict (nombre) do nothing;
