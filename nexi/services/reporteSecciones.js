const nexiDatos = require('./nexiDatos');
const nexiPermisos = require('./nexiPermisos');
const nexiOrganigrama = require('./nexiOrganigrama');
const nexiAlcance = require('./nexiAlcance');
const indicadoresService = require('../../indicators/services/indicadoresService');
const suscripcionesService = require('../../finance/services/suscripcionesService');
const { totalesDelRango, aLista, variacionPct } = require('../tools/finanzasTools');
const { conteosContactos } = require('../tools/crmTools');
const operativo = require('../tools/operativoTools');
const protocolos = require('../tools/protocolosTools');
const dashboard = require('../tools/dashboardTools');
const { contarPor } = require('../tools/organizacionTools');
const { SECCIONES, LIMITES_REPORTES } = require('../config/reportes');
const f = require('./reporteFormato');

// Obtención y cálculo de datos de cada sección de un reporte.
//
// Todos los datos salen de los mismos services / helpers que usan las
// herramientas de Nexi (sin duplicar reglas de negocio) y TODOS los cálculos
// (totales, variaciones, porcentajes) se hacen acá, en el backend. Las
// observaciones son frases deterministas armadas con esos números: el modelo
// de IA no participa en el contenido del archivo.
//
// Cada sección recibe ctx = { usuario, niveles, alcance, periodo, hoy, ahora }
// y devuelve:
//   { clave, titulo, alcance_aplicado, cifras[], tablas[], observaciones[],
//     notas[], variaciones[] }
// cifras: [{ etiqueta, valor, formato, anterior?, variacion_pct? }]
// tablas: [{ titulo, columnas: [{ titulo, formato }], filas: [[...]], nota? }]

const MAX_FILAS = LIMITES_REPORTES.MAX_FILAS_TABLA;

function pct(parte, total) {
  return total ? Math.round((parte / total) * 1000) / 10 : null;
}

function cifra(etiqueta, valor, formato, anterior) {
  const c = { etiqueta, valor, formato };
  if (anterior !== undefined && anterior !== null) {
    c.anterior = anterior;
    c.variacion_pct = variacionPct(valor, anterior);
  }
  return c;
}

function variaciones(cifras, prefijo) {
  return cifras
    .filter(c => c.variacion_pct !== undefined && c.variacion_pct !== null)
    .map(c => ({ etiqueta: `${prefijo}: ${c.etiqueta}`, actual: c.valor, anterior: c.anterior, variacion_pct: c.variacion_pct, formato: c.formato }));
}

// "variaron +12,5 %" o, si el período anterior no tenía registros, lo dice.
function fraseVariacion(actual, anterior) {
  if (!anterior) return actual ? 'no tenían registros en el período anterior' : 'se mantuvieron sin registros';
  return `variaron ${f.variacion(variacionPct(actual, anterior))}`;
}

function notaParcial(periodo) {
  return periodo.en_curso ? [`El período está en curso: los datos llegan hasta el ${periodo.datos_hasta.split('-').reverse().join('/')} (parciales).`] : [];
}

function notaAlcance(alcance) {
  return alcance && alcance !== 'global' ? [`Datos limitados al alcance de tus permisos: ${nexiAlcance.DESCRIPCION_ALCANCE[alcance]}.`] : [];
}

// ── Finanzas ────────────────────────────────────────────────────────────────

const RANGO_TOTAL = ['0000-01-01', '9999-12-31'];

async function totalesFinancieros(desde, hasta) {
  const filas = await nexiDatos.totalesMovimientos(desde, hasta);
  const total = totalesDelRango(filas, ...RANGO_TOTAL);
  return { filas, ingresos: total.ingresos, gastos: total.gastos, balance: total.ingresos - total.gastos, total };
}

async function kpiDePerspectiva(ctx, perspectiva, max) {
  const acceso = nexiPermisos.evaluarRequisitos(SECCIONES.indicadores, ctx.niveles, ctx.usuario);
  if (!acceso.ok) return { excluidos: true };
  return { excluidos: false, filas: await filasIndicadores(ctx, { perspectiva, max }) };
}

async function seccionFinanzas(ctx) {
  const { periodo } = ctx;
  const comp = periodo.comparacion;
  const [actual, anterior, deudas, enRevision] = await Promise.all([
    totalesFinancieros(periodo.desde, periodo.hasta),
    comp ? totalesFinancieros(comp.desde, comp.hasta) : null,
    nexiDatos.deudasPorVencer(periodo.datos_hasta, MAX_FILAS),
    nexiDatos.contarComprobantesEnRevision(),
  ]);
  const suscripciones = periodo.en_curso ? await suscripcionesService.proximasVencer(30) : null;
  const kpi = await kpiDePerspectiva(ctx, 'FINANZAS', 6);

  const cifras = [
    cifra('Ingresos', actual.ingresos, 'moneda', anterior?.ingresos),
    cifra('Gastos', actual.gastos, 'moneda', anterior?.gastos),
    cifra('Balance', actual.balance, 'moneda', anterior?.balance),
  ];
  const ingresosCat = aLista(actual.total.ingresosPorCategoria);
  const gastosCat = aLista(actual.total.gastosPorCategoria);
  const tablas = [];

  if (periodo.meses.length > 1) {
    tablas.push({
      titulo: 'Evolución mensual',
      columnas: [{ titulo: 'Mes' }, { titulo: 'Ingresos', formato: 'moneda' }, { titulo: 'Gastos', formato: 'moneda' }, { titulo: 'Balance', formato: 'moneda' }],
      filas: periodo.meses.map(m => {
        const t = totalesDelRango(actual.filas.filter(r => String(r.mes).slice(0, 7) === m.clave), ...RANGO_TOTAL);
        return [m.clave, t.ingresos, t.gastos, t.ingresos - t.gastos];
      }),
    });
  }
  const tablaCategorias = (titulo, lista, total) => ({
    titulo,
    columnas: [{ titulo: 'Categoría' }, { titulo: 'Total', formato: 'moneda' }, { titulo: '% del total', formato: 'porcentaje' }],
    filas: lista.slice(0, MAX_FILAS).map(c => [c.categoria, c.total, pct(c.total, total)]),
  });
  if (ingresosCat.length) tablas.push(tablaCategorias('Ingresos por categoría', ingresosCat, actual.ingresos));
  if (gastosCat.length) tablas.push(tablaCategorias('Gastos por categoría', gastosCat, actual.gastos));
  if (deudas.total > 0) {
    tablas.push({
      titulo: 'Deudas no pagadas con vencimiento hasta el fin del período',
      columnas: [{ titulo: 'Acreedor' }, { titulo: 'Monto', formato: 'moneda' }, { titulo: 'Vencimiento' }, { titulo: 'Situación' }],
      filas: deudas.filas.map(d => [d.acreedor, Number(d.monto), d.vencimiento, d.vencimiento < ctx.hoy.fecha ? 'Vencida' : 'Por vencer']),
      nota: deudas.total > deudas.filas.length ? `Se muestran ${deudas.filas.length} de ${deudas.total}.` : null,
    });
  }
  if (suscripciones?.length) {
    tablas.push({
      titulo: 'Suscripciones activas que vencen en los próximos 30 días',
      columnas: [{ titulo: 'Suscripción' }, { titulo: 'Proveedor' }, { titulo: 'Monto', formato: 'numero' }, { titulo: 'Moneda' }, { titulo: 'Vence' }],
      filas: suscripciones.slice(0, MAX_FILAS).map(s => [s.nombre, s.proveedor || '-', Number(s.monto), s.moneda, s.proxima_fecha_vencimiento]),
    });
  }
  if (kpi.filas?.length) tablas.push(tablaIndicadores('KPI financieros', kpi.filas));

  const observaciones = [
    `El balance del período fue ${actual.balance >= 0 ? 'positivo' : 'negativo'}: ${f.moneda(actual.balance)}.`,
  ];
  if (anterior) {
    observaciones.push(`Frente a ${comp.etiqueta}, los ingresos ${fraseVariacion(actual.ingresos, anterior.ingresos)} y los gastos ${fraseVariacion(actual.gastos, anterior.gastos)}.`);
  }
  if (gastosCat[0]) observaciones.push(`La principal categoría de gasto fue ${gastosCat[0].categoria} (${f.porcentaje(pct(gastosCat[0].total, actual.gastos))} de los gastos).`);
  const vencidas = deudas.filas.filter(d => d.vencimiento < ctx.hoy.fecha);
  if (vencidas.length) observaciones.push(`Hay ${vencidas.length} deuda(s) vencida(s) sin pagar entre las listadas.`);

  const notas = [...notaParcial(periodo)];
  if (enRevision > 0) notas.push(`A hoy hay ${enRevision} comprobante(s) pendientes de revisión que todavía no impactan en los movimientos.`);
  if (kpi.excluidos) notas.push('KPI financieros no incluidos: requieren permiso de lectura en Indicadores.');
  if (!periodo.en_curso) notas.push('Las suscripciones próximas a vencer solo se informan en períodos en curso.');

  return {
    clave: 'finanzas', titulo: SECCIONES.finanzas.titulo, alcance_aplicado: 'global',
    cifras, tablas, observaciones, notas, variaciones: variaciones(cifras, 'Finanzas'),
  };
}

// ── Indicadores ─────────────────────────────────────────────────────────────

function ventanaPara(meses) {
  if (meses <= 3) return '3m';
  if (meses <= 6) return '6m';
  return '12m';
}

async function filasIndicadores(ctx, { perspectiva, max }) {
  const { data } = await indicadoresService.listar(perspectiva ? { perspectiva } : {});
  const ventana = ventanaPara(ctx.periodo.meses.length);
  return Promise.all(data.slice(0, max).map(async ind => {
    let valorPeriodo = null;
    let motivo = null;
    if (ctx.periodo.clave) {
      try {
        const v = await indicadoresService.calcularValor(ind.id, ctx.periodo.clave, { ahora: ctx.ahora });
        valorPeriodo = { valor: v.valor, estado: v.estado };
      } catch (err) {
        if (err.status !== 400) throw err;
        motivo = 'frecuencia incompatible con el período';
      }
    }
    const h = await indicadoresService.calcularHistorico(ind.id, ventana, { ahora: ctx.ahora });
    return {
      nombre: ind.nombre,
      unidad: ind.unidad,
      sentido: ind.sentido,
      objetivo: Number(ind.valor_objetivo),
      valor: valorPeriodo ? valorPeriodo.valor : h.ultimoValido?.valor ?? null,
      estado: valorPeriodo ? valorPeriodo.estado : h.ultimoValido?.estado ?? null,
      origen_valor: valorPeriodo ? 'período del reporte' : (motivo ? `último valor válido (${motivo})` : 'último valor válido'),
      tendencia: h.tendencia?.direccion || null,
    };
  }));
}

const ETIQUETA_ESTADO = { EN_OBJETIVO: 'En objetivo', EN_RIESGO: 'En riesgo', CRITICO: 'Crítico' };
const ETIQUETA_TENDENCIA = { SUBE: 'Sube', BAJA: 'Baja', ESTABLE: 'Estable' };

function tablaIndicadores(titulo, filas) {
  return {
    titulo,
    columnas: [{ titulo: 'Indicador' }, { titulo: 'Valor' }, { titulo: 'Objetivo' }, { titulo: 'Estado' }, { titulo: 'Tendencia' }],
    filas: filas.map(i => [
      i.nombre,
      f.valorIndicador(i.valor, i.unidad),
      f.valorIndicador(i.objetivo, i.unidad),
      ETIQUETA_ESTADO[i.estado] || 's/d',
      ETIQUETA_TENDENCIA[i.tendencia] || 's/d',
    ]),
  };
}

async function seccionIndicadores(ctx) {
  const filas = await filasIndicadores(ctx, { max: LIMITES_REPORTES.MAX_INDICADORES });
  const contar = estado => filas.filter(i => i.estado === estado).length;
  const criticos = filas.filter(i => i.estado === 'CRITICO').map(i => i.nombre);
  const empeoran = filas.filter(i => (i.sentido === 'MAYOR_ES_MEJOR' && i.tendencia === 'BAJA') || (i.sentido === 'MENOR_ES_MEJOR' && i.tendencia === 'SUBE')).map(i => i.nombre);
  const observaciones = filas.length
    ? [`${contar('EN_OBJETIVO')} indicador(es) en objetivo, ${contar('EN_RIESGO')} en riesgo y ${contar('CRITICO')} crítico(s).`]
    : ['No hay indicadores activos.'];
  if (criticos.length) observaciones.push(`Indicadores críticos: ${criticos.join(', ')}.`);
  if (empeoran.length) observaciones.push(`Con tendencia desfavorable: ${empeoran.join(', ')}.`);
  return {
    clave: 'indicadores', titulo: SECCIONES.indicadores.titulo, alcance_aplicado: 'global',
    cifras: [
      cifra('Indicadores activos analizados', filas.length, 'numero'),
      cifra('En objetivo', contar('EN_OBJETIVO'), 'numero'),
      cifra('En riesgo', contar('EN_RIESGO'), 'numero'),
      cifra('Críticos', contar('CRITICO'), 'numero'),
    ],
    tablas: filas.length ? [tablaIndicadores('Indicadores', filas)] : [],
    observaciones,
    notas: [
      ...notaParcial(ctx.periodo),
      ctx.periodo.clave
        ? 'El valor corresponde al período del reporte cuando la frecuencia del indicador lo permite; si no, al último valor válido.'
        : 'Para rangos personalizados se informa el último valor válido de cada indicador.',
      'La tendencia compara los dos últimos períodos con valor de la ventana reciente.',
    ],
    variaciones: [],
  };
}

// ── Operativo ───────────────────────────────────────────────────────────────

async function conteosOperativos(ctx) {
  const { usuario, alcance, hoy, periodo } = ctx;
  const comp = periodo.comparacion;
  if (alcance === 'global') {
    const rango = m => ({ desde: m.desde, hasta: m.hasta });
    const [actual, anterior, porMes] = await Promise.all([
      operativo.resumenTareas({ usuario, alcance, hoy, rango: rango(periodo) }),
      comp ? operativo.resumenTareas({ usuario, alcance, hoy, rango: rango(comp) }) : null,
      Promise.all(periodo.meses.map(async m => {
        const [total, completadas, vencidas] = await Promise.all([
          nexiDatos.contarTareas(rango(m)),
          nexiDatos.contarTareas({ ...rango(m), estado: 'Completada' }),
          nexiDatos.contarTareas({ ...rango(m), estadosAbiertos: ['Pendiente', 'En Proceso'], venceAntesDe: hoy.fecha }),
        ]);
        return { mes: m.clave, total_asignadas: total, completadas, abiertas_vencidas: vencidas };
      })),
    ]);
    return { actual, anterior, porMes };
  }
  // Alcance restringido: las tareas del alcance se leen una sola vez.
  const { ids } = await operativo.idsEnAlcance(usuario, alcance);
  const filas = ids.length ? await nexiDatos.filasTareasPorIds(ids) : [];
  const conteo = r => operativo.conteosAcotados(filas, { desde: r.desde, hasta: r.hasta }, hoy);
  return {
    actual: conteo(periodo),
    anterior: comp ? conteo(comp) : null,
    porMes: periodo.meses.map(m => {
      const c = conteo(m);
      return { mes: m.clave, total_asignadas: c.total_asignadas, completadas: c.por_estado.Completada, abiertas_vencidas: c.abiertas_vencidas };
    }),
  };
}

async function seccionOperativo(ctx) {
  const { actual, anterior, porMes } = await conteosOperativos(ctx);
  const completadas = actual.por_estado.Completada;
  const cifras = [
    cifra('Tareas con vencimiento en el período', actual.total_asignadas, 'numero', anterior?.total_asignadas),
    cifra('Completadas', completadas, 'numero', anterior?.por_estado.Completada),
    cifra('Abiertas vencidas', actual.abiertas_vencidas, 'numero', anterior?.abiertas_vencidas),
  ];
  if (actual.propuestas_pendientes !== null && actual.propuestas_pendientes !== undefined) {
    cifras.push(cifra('Propuestas pendientes (a hoy)', actual.propuestas_pendientes, 'numero'));
  }
  const tablas = [
    {
      titulo: 'Tareas por estado',
      columnas: [{ titulo: 'Estado' }, { titulo: 'Cantidad', formato: 'numero' }, { titulo: '% del total', formato: 'porcentaje' }],
      filas: operativo.ESTADOS.map(e => [e, actual.por_estado[e], pct(actual.por_estado[e], actual.total_asignadas)]),
    },
    {
      titulo: 'Tareas por prioridad',
      columnas: [{ titulo: 'Prioridad' }, { titulo: 'Cantidad', formato: 'numero' }],
      filas: operativo.PRIORIDADES.map(p => [p, actual.por_prioridad[p]]),
    },
  ];
  if (porMes.length > 1) {
    tablas.push({
      titulo: 'Evolución mensual (por fecha límite)',
      columnas: [{ titulo: 'Mes' }, { titulo: 'Tareas', formato: 'numero' }, { titulo: 'Completadas', formato: 'numero' }, { titulo: 'Abiertas vencidas', formato: 'numero' }],
      filas: porMes.map(m => [m.mes, m.total_asignadas, m.completadas, m.abiertas_vencidas]),
    });
  }
  const observaciones = actual.total_asignadas
    ? [`Se completó el ${f.porcentaje(pct(completadas, actual.total_asignadas))} de las tareas con vencimiento en el período.`]
    : ['No hay tareas con fecha límite dentro del período.'];
  if (actual.abiertas_vencidas) observaciones.push(`${actual.abiertas_vencidas} tarea(s) siguen abiertas con la fecha límite vencida.`);
  return {
    clave: 'operativo', titulo: SECCIONES.operativo.titulo, alcance_aplicado: ctx.alcance,
    cifras, tablas, observaciones,
    notas: [...notaParcial(ctx.periodo), ...notaAlcance(ctx.alcance), 'Las tareas se asignan al período por su fecha límite.'],
    variaciones: variaciones(cifras, 'Operativo'),
  };
}

// ── CRM ─────────────────────────────────────────────────────────────────────

async function seccionCrm(ctx) {
  const { periodo } = ctx;
  const comp = periodo.comparacion;
  const [altas, anterior, totales, porMes] = await Promise.all([
    conteosContactos({ desde: periodo.desde, hasta: periodo.hasta }),
    comp ? conteosContactos({ desde: comp.desde, hasta: comp.hasta }) : null,
    conteosContactos(),
    Promise.all(periodo.meses.map(async m => [m.clave, await nexiDatos.contarContactos({ desde: `${m.desde}T00:00:00.000Z`, hasta: `${m.hasta}T00:00:00.000Z` })])),
  ]);
  const cifras = [
    cifra('Contactos nuevos en el período', altas.total, 'numero', anterior?.total),
    cifra('Clientes nuevos', altas.por_tipo.Cliente, 'numero', anterior?.por_tipo.Cliente),
    cifra('Contactos totales (a hoy)', totales.total, 'numero'),
  ];
  const tablas = [
    {
      titulo: 'Contactos por tipo',
      columnas: [{ titulo: 'Tipo' }, { titulo: 'Nuevos en el período', formato: 'numero' }, { titulo: 'Totales a hoy', formato: 'numero' }],
      filas: Object.keys(totales.por_tipo).map(t => [t, altas.por_tipo[t], totales.por_tipo[t]]),
    },
    {
      titulo: 'Contactos por estado',
      columnas: [{ titulo: 'Estado' }, { titulo: 'Nuevos en el período', formato: 'numero' }, { titulo: 'Totales a hoy', formato: 'numero' }],
      filas: Object.keys(totales.por_estado).map(e => [e, altas.por_estado[e], totales.por_estado[e]]),
    },
  ];
  if (porMes.length > 1) {
    tablas.push({ titulo: 'Altas por mes', columnas: [{ titulo: 'Mes' }, { titulo: 'Altas', formato: 'numero' }], filas: porMes });
  }
  const observaciones = [`Se registraron ${f.numero(altas.total)} contacto(s) nuevo(s), de los cuales ${f.numero(altas.por_tipo.Cliente)} son clientes.`];
  if (anterior) {
    observaciones.push(anterior.total
      ? `Frente a ${comp.etiqueta}, las altas variaron ${f.variacion(variacionPct(altas.total, anterior.total))}.`
      : `En ${comp.etiqueta} no se habían registrado altas.`);
  }
  return {
    clave: 'crm', titulo: SECCIONES.crm.titulo, alcance_aplicado: 'global',
    cifras, tablas, observaciones,
    notas: [...notaParcial(periodo), 'Solo métricas agregadas: el reporte no incluye datos personales de contactos.'],
    variaciones: variaciones(cifras, 'CRM'),
  };
}

// ── Protocolos ──────────────────────────────────────────────────────────────

function resumenEjecuciones(ejecuciones) {
  const total = ejecuciones.length;
  const con = ejecuciones.filter(({ fila }) => protocolos.resumirResultados(fila.resultados).con_incumplimientos).length;
  return { total, con, sin: total - con, cumplimiento: pct(total - con, total) };
}

async function seccionProtocolos(ctx) {
  const { usuario, alcance, periodo } = ctx;
  const comp = periodo.comparacion;
  const limite = LIMITES_REPORTES.MAX_EJECUCIONES;
  const [actual, anterior, activos] = await Promise.all([
    protocolos.ejecucionesDelPeriodo({ usuario, alcance, desde: periodo.desde, hasta: periodo.hasta, limite }),
    comp ? protocolos.ejecucionesDelPeriodo({ usuario, alcance, desde: comp.desde, hasta: comp.hasta, limite }) : null,
    protocolos.protocolosEnAlcance({ usuario, alcance }),
  ]);
  const r = resumenEjecuciones(actual.ejecuciones);
  const ra = anterior ? resumenEjecuciones(anterior.ejecuciones) : null;

  const porProtocolo = new Map();
  const porResponsable = new Map();
  for (const { fila, protocolo } of actual.ejecuciones) {
    const nombre = protocolo?.nombre || 'Protocolo eliminado';
    const p = porProtocolo.get(nombre) || { total: 0, con: 0 };
    p.total++;
    if (protocolos.resumirResultados(fila.resultados).con_incumplimientos) p.con++;
    porProtocolo.set(nombre, p);
    const resp = fila.realizado_por || 'Sin registrar';
    porResponsable.set(resp, (porResponsable.get(resp) || 0) + 1);
  }
  const conFallas = actual.ejecuciones.filter(({ fila }) => protocolos.resumirResultados(fila.resultados).con_incumplimientos);

  const cifras = [
    cifra('Ejecuciones registradas', r.total, 'numero', ra?.total),
    cifra('Con incumplimientos', r.con, 'numero', ra?.con),
    cifra('Cumplimiento (sin incumplimientos)', r.cumplimiento, 'porcentaje', ra?.cumplimiento),
    cifra('Protocolos activos (a hoy)', activos.protocolos.length, 'numero'),
  ];
  const tablas = [];
  if (porProtocolo.size) {
    tablas.push({
      titulo: 'Ejecuciones por protocolo',
      columnas: [{ titulo: 'Protocolo' }, { titulo: 'Ejecuciones', formato: 'numero' }, { titulo: 'Con incumplimientos', formato: 'numero' }, { titulo: 'Cumplimiento', formato: 'porcentaje' }],
      filas: [...porProtocolo.entries()].slice(0, MAX_FILAS).map(([n, p]) => [n, p.total, p.con, pct(p.total - p.con, p.total)]),
    });
    tablas.push({
      titulo: 'Responsables de las ejecuciones',
      columnas: [{ titulo: 'Realizado por' }, { titulo: 'Ejecuciones', formato: 'numero' }],
      filas: [...porResponsable.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_FILAS),
    });
  }
  if (conFallas.length) {
    tablas.push({
      titulo: 'Ejecuciones con incumplimientos',
      columnas: [{ titulo: 'Fecha' }, { titulo: 'Protocolo' }, { titulo: 'Realizado por' }, { titulo: 'Ítems fallidos' }, { titulo: 'Observaciones' }],
      filas: conFallas.slice(0, MAX_FILAS).map(({ fila, protocolo }) => {
        const e = protocolos.presentarEjecucion(fila);
        return [e.fecha, protocolo?.nombre || 'Protocolo eliminado', e.realizado_por || '-', e.items_fallidos.slice(0, 3).join('; ') || '-', e.observaciones ? e.observaciones.slice(0, 140) : '-'];
      }),
      nota: conFallas.length > MAX_FILAS ? `Se muestran ${MAX_FILAS} de ${conFallas.length}.` : null,
    });
  }
  const observaciones = r.total
    ? [`Se registraron ${r.total} ejecución(es); el ${f.porcentaje(r.cumplimiento)} no tuvo incumplimientos.`]
    : ['No se registraron ejecuciones de protocolos en el período.'];
  if (ra) observaciones.push(`En ${comp.etiqueta} se habían registrado ${ra.total} ejecución(es).`);
  const notas = [...notaParcial(periodo), ...notaAlcance(alcance), 'El módulo no registra estados "pendiente" ni fechas de vencimiento de protocolos.'];
  if (actual.truncado) notas.push(`Se analizaron las ${actual.ejecuciones.length} ejecuciones más recientes de ${actual.total}.`);
  return {
    clave: 'protocolos', titulo: SECCIONES.protocolos.titulo, alcance_aplicado: alcance,
    cifras, tablas, observaciones, notas, variaciones: variaciones(cifras, 'Protocolos'),
  };
}

// ── Dashboard ───────────────────────────────────────────────────────────────

function valorPrincipal(d) {
  if (!d.disponible) return ['No disponible', d.motivo];
  if (d.indicador) return [f.valorIndicador(d.ultimo_valido?.valor, d.indicador.unidad), ETIQUETA_ESTADO[d.ultimo_valido?.estado] || 's/d'];
  if (d.valor !== undefined) return [f.moneda(d.valor), `${f.variacion(d.variacion_pct)} vs. ventana anterior`];
  if (d.altas_en_ventana) return [`${f.numero(d.altas_en_ventana.total)} altas`, `${f.numero(d.totales_actuales.total)} contactos en total`];
  if (d.gastos_por_categoria) {
    const g = d.gastos_por_categoria[0];
    return [g ? `${g.categoria}: ${f.moneda(g.total)}` : 'Sin gastos', 'Principal categoría de gasto'];
  }
  const total = d.total ?? d.total_asignadas;
  if (total !== undefined) return [`${f.numero(total)} tareas`, `${f.numero(d.vencidas ?? d.abiertas_vencidas)} vencidas`];
  return ['-', '-'];
}

async function seccionDashboard(ctx) {
  const config = await dashboard.configuracion(ctx.usuario);
  const widgets = config.widgets.slice(0, LIMITES_REPORTES.MAX_MOSAICOS);
  const nombres = await dashboard.nombresIndicadores(widgets);
  const filas = await Promise.all(widgets.map(async w => {
    const p = dashboard.presentarWidget(w, nombres);
    const d = await dashboard.datosWidget(w, ctx);
    const [valor, detalle] = valorPrincipal(d);
    return { titulo: p.titulo, ventana: p.periodo_label, valor, detalle, empeora: !!d.empeora, alerta: !!d.alerta };
  }));
  const empeoran = filas.filter(x => x.empeora).map(x => x.titulo);
  const alertas = filas.filter(x => x.alerta).map(x => x.titulo);
  const observaciones = filas.length ? [] : ['No tenés mosaicos configurados en el Panel General.'];
  if (empeoran.length) observaciones.push(`Mosaicos con evolución desfavorable: ${empeoran.join(', ')}.`);
  if (alertas.length) observaciones.push(`KPI en riesgo o críticos: ${alertas.join(', ')}.`);
  if (filas.length && !empeoran.length && !alertas.length) observaciones.push('Ningún mosaico muestra alertas ni evolución desfavorable.');
  return {
    clave: 'dashboard', titulo: SECCIONES.dashboard.titulo, alcance_aplicado: ctx.alcance,
    cifras: [cifra('Mosaicos configurados', config.widgets.length, 'numero'), cifra('Con alertas o evolución desfavorable', new Set([...empeoran, ...alertas]).size, 'numero')],
    tablas: filas.length ? [{
      titulo: 'Mosaicos del Panel General',
      columnas: [{ titulo: 'Mosaico' }, { titulo: 'Ventana' }, { titulo: 'Valor' }, { titulo: 'Detalle' }],
      filas: filas.map(x => [x.titulo, x.ventana, x.valor, x.detalle]),
    }] : [],
    observaciones,
    notas: ['Valores actuales de cada mosaico según su propia ventana (no según el período del reporte).'],
    variaciones: [],
  };
}

// ── Organización ────────────────────────────────────────────────────────────

async function seccionOrganizacion() {
  const { nodos } = await nexiOrganigrama.obtenerEstructura();
  const tabla = (titulo, campo) => ({
    titulo,
    columnas: [{ titulo: { area: 'Área', nivel: 'Nivel', tipo: 'Tipo de persona' }[campo] }, { titulo: 'Personas', formato: 'numero' }, { titulo: '% del total', formato: 'porcentaje' }],
    filas: Object.entries(contarPor(nodos, campo)).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v, pct(v, nodos.length)]),
  });
  const porArea = contarPor(nodos, 'area');
  const mayor = Object.entries(porArea).sort((a, b) => b[1] - a[1])[0];
  return {
    clave: 'organizacion', titulo: SECCIONES.organizacion.titulo, alcance_aplicado: 'global',
    cifras: [cifra('Personas activas en el organigrama', nodos.length, 'numero'), cifra('Áreas', Object.keys(porArea).length, 'numero')],
    tablas: [tabla('Personas por área', 'area'), tabla('Personas por nivel', 'nivel'), tabla('Personas por tipo', 'tipo')],
    observaciones: mayor ? [`El área con más personas es ${mayor[0]} (${mayor[1]}).`] : ['El organigrama no tiene personas activas.'],
    notas: ['Composición actual del organigrama (no histórica). Solo métricas agregadas: sin datos personales.'],
    variaciones: [],
  };
}

const RECOLECTORES = {
  finanzas: seccionFinanzas,
  indicadores: seccionIndicadores,
  operativo: seccionOperativo,
  crm: seccionCrm,
  protocolos: seccionProtocolos,
  dashboard: seccionDashboard,
  organizacion: seccionOrganizacion,
};

module.exports = { RECOLECTORES, valorPrincipal };
