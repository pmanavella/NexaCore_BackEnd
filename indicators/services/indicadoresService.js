const supabase = require('../../config/supabase');
const {
  PERSPECTIVAS, UNIDADES, SENTIDOS, FRECUENCIAS, MESES_POR_VENTANA,
  MAX_NOMBRE_LENGTH, MIN_NOMBRE_LENGTH, MAX_RESPONSABLE_LENGTH, MAX_DESCRIPCION_LENGTH,
} = require('../config/indicadores');
const { VARIABLES, CLAVES_VARIABLES, calcularVariables } = require('./variablesFinancieras');
const { analizarFormula, evaluarFormula } = require('./formulaParser');
const { hoyArgentina, resolverPeriodoIndicador, periodosDeVentana } = require('./periodos');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNAS = 'id, nombre, descripcion, perspectiva, responsable, frecuencia, formula, unidad, sentido, valor_objetivo, limite_aceptable, activo, created_at, updated_at, created_by, updated_by';
const DEFAULT_VENTANA_HISTORICO = '12m';

function error400(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400 });
}

function noEncontrado() {
  return Object.assign(new Error('Indicador no encontrado.'), { status: 404 });
}

function textoRequerido(valor, campo, min, max) {
  const limpio = typeof valor === 'string' ? valor.trim() : '';
  if (!limpio) throw error400(`El campo "${campo}" es obligatorio.`);
  if (limpio.length < min || limpio.length > max) {
    throw error400(`El campo "${campo}" debe tener entre ${min} y ${max} caracteres.`);
  }
  return limpio;
}

function opcion(valor, campo, opciones) {
  if (!opciones.includes(valor)) {
    throw error400(`Valor inválido para "${campo}". Opciones: ${opciones.join(', ')}.`);
  }
  return valor;
}

function numeroRequerido(valor, campo) {
  const esNumeroTexto = typeof valor === 'string' && /^-?\d+(\.\d+)?$/.test(valor.trim());
  if (!(typeof valor === 'number' && Number.isFinite(valor)) && !esNumeroTexto) {
    throw error400(`El campo "${campo}" debe ser un número.`);
  }
  return Number(valor);
}

// Estado derivado del resultado — nunca se ingresa manualmente.
// MAYOR_ES_MEJOR: valor >= objetivo → EN_OBJETIVO; límite <= valor < objetivo
// → EN_RIESGO; valor < límite → CRITICO. MENOR_ES_MEJOR: lógica inversa.
// Sin valor calculable (ej. división por cero) no hay estado: null.
function calcularEstado(valor, { sentido, valor_objetivo, limite_aceptable }) {
  if (valor === null || valor === undefined) return null;
  const objetivo = Number(valor_objetivo);
  const limite = Number(limite_aceptable);
  if (sentido === 'MAYOR_ES_MEJOR') {
    if (valor >= objetivo) return 'EN_OBJETIVO';
    if (valor >= limite) return 'EN_RIESGO';
    return 'CRITICO';
  }
  if (valor <= objetivo) return 'EN_OBJETIVO';
  if (valor <= limite) return 'EN_RIESGO';
  return 'CRITICO';
}

function presentarPeriodo({ clave, label, desde, hasta, parcial }) {
  return { clave, label, desde, hasta, parcial };
}

function resumenIndicador(ind) {
  return {
    id: ind.id,
    nombre: ind.nombre,
    perspectiva: ind.perspectiva,
    frecuencia: ind.frecuencia,
    unidad: ind.unidad,
    sentido: ind.sentido,
    valorObjetivo: Number(ind.valor_objetivo),
    limiteAceptable: Number(ind.limite_aceptable),
    activo: ind.activo,
  };
}

class IndicadoresService {
  // Valida y normaliza el cuerpo de creación/edición (PUT = reemplazo completo,
  // igual que el resto de los módulos). `activo` es opcional.
  _validarDatos(body = {}) {
    const nombre = textoRequerido(body.nombre, 'nombre', MIN_NOMBRE_LENGTH, MAX_NOMBRE_LENGTH);
    const responsable = textoRequerido(body.responsable, 'responsable', MIN_NOMBRE_LENGTH, MAX_RESPONSABLE_LENGTH);

    let descripcion = null;
    if (body.descripcion !== undefined && body.descripcion !== null) {
      if (typeof body.descripcion !== 'string') throw error400('El campo "descripcion" debe ser texto.');
      descripcion = body.descripcion.trim() || null;
      if (descripcion && descripcion.length > MAX_DESCRIPCION_LENGTH) {
        throw error400(`El campo "descripcion" no puede superar los ${MAX_DESCRIPCION_LENGTH} caracteres.`);
      }
    }

    const perspectiva = opcion(body.perspectiva, 'perspectiva', PERSPECTIVAS);
    const frecuencia = opcion(body.frecuencia, 'frecuencia', FRECUENCIAS);
    const unidad = opcion(body.unidad, 'unidad', UNIDADES);
    const sentido = opcion(body.sentido, 'sentido', SENTIDOS);
    const valor_objetivo = numeroRequerido(body.valor_objetivo, 'valor_objetivo');
    const limite_aceptable = numeroRequerido(body.limite_aceptable, 'limite_aceptable');

    if (sentido === 'MAYOR_ES_MEJOR' && limite_aceptable > valor_objetivo) {
      throw error400('Con sentido MAYOR_ES_MEJOR el "limite_aceptable" debe ser menor o igual al "valor_objetivo".');
    }
    if (sentido === 'MENOR_ES_MEJOR' && limite_aceptable < valor_objetivo) {
      throw error400('Con sentido MENOR_ES_MEJOR el "limite_aceptable" debe ser mayor o igual al "valor_objetivo".');
    }

    const { formula } = analizarFormula(body.formula, CLAVES_VARIABLES);

    const datos = {
      nombre, descripcion, perspectiva, responsable, frecuencia, formula,
      unidad, sentido, valor_objetivo, limite_aceptable,
    };
    if (body.activo !== undefined) {
      if (typeof body.activo !== 'boolean') throw error400('El campo "activo" debe ser booleano.');
      datos.activo = body.activo;
    }
    return datos;
  }

  async _obtenerFila(id) {
    if (typeof id !== 'string' || !UUID_REGEX.test(id)) throw noEncontrado();
    const { data, error } = await supabase.from('indicadores').select(COLUMNAS).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) throw noEncontrado();
    return data;
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async listar({ perspectiva, activo } = {}) {
    let soloActivos = true;
    if (activo !== undefined && activo !== '') {
      if (activo !== 'true' && activo !== 'false') throw error400('El parámetro "activo" debe ser true o false.');
      soloActivos = activo === 'true';
    }

    let query = supabase
      .from('indicadores')
      .select(COLUMNAS)
      .eq('activo', soloActivos)
      .order('nombre', { ascending: true });

    if (perspectiva !== undefined && perspectiva !== '') {
      query = query.eq('perspectiva', opcion(perspectiva, 'perspectiva', PERSPECTIVAS));
    }

    const { data, error } = await query;
    if (error) throw error;
    return { data, total: data.length };
  }

  async obtenerPorId(id) {
    return this._obtenerFila(id);
  }

  async crear(body, email = null) {
    const datos = this._validarDatos(body);
    const { data, error } = await supabase
      .from('indicadores')
      .insert([{ ...datos, created_by: email }])
      .select(COLUMNAS)
      .single();
    if (error) throw error;
    return data;
  }

  async actualizar(id, body, email = null) {
    await this._obtenerFila(id);
    const datos = this._validarDatos(body);
    const { data, error } = await supabase
      .from('indicadores')
      .update({ ...datos, updated_by: email })
      .eq('id', id)
      .select(COLUMNAS)
      .single();
    if (error) throw error;
    return data;
  }

  // Borrado lógico: el indicador queda con activo = false. Las configuraciones
  // del Dashboard que lo referencian NO se tocan.
  async desactivar(id, email = null) {
    await this._obtenerFila(id);
    const { error } = await supabase
      .from('indicadores')
      .update({ activo: false, updated_by: email })
      .eq('id', id);
    if (error) throw error;
    return { message: 'Indicador desactivado correctamente.' };
  }

  // ── Variables y fórmulas ────────────────────────────────────────────────────

  listarVariables() {
    return { data: VARIABLES, total: VARIABLES.length };
  }

  // Validación inmediata para el editor de fórmulas: siempre 200 con `valida`.
  validarFormula(formula) {
    if (typeof formula !== 'string') throw error400('El campo "formula" es obligatorio y debe ser texto.');
    try {
      const { formula: normalizada, variables } = analizarFormula(formula, CLAVES_VARIABLES);
      return { valida: true, formula: normalizada, variables, error: null };
    } catch (err) {
      if (err.status !== 400) throw err;
      return { valida: false, formula: null, variables: [], error: err.message };
    }
  }

  // ── Cálculo ─────────────────────────────────────────────────────────────────

  // Re-analiza la fórmula guardada contra el catálogo vigente: si Finanzas
  // quitó una categoría usada, se informa con 409 en vez de calcular mal.
  _analizarFormulaGuardada(indicador) {
    try {
      return analizarFormula(indicador.formula, CLAVES_VARIABLES);
    } catch (err) {
      if (err.status !== 400) throw err;
      throw Object.assign(new Error(`La fórmula del indicador ya no es válida: ${err.message}`), { status: 409 });
    }
  }

  // Totales de public.movimientos agrupados por (mes, tipo, categoria) en
  // [desde, hasta), vía la función SQL de solo lectura de la migración.
  async _totalesMovimientos(desde, hasta) {
    const { data, error } = await supabase.rpc('indicadores_totales_movimientos', { p_desde: desde, p_hasta: hasta });
    if (error) throw error;
    return data || [];
  }

  _calcularPunto(indicador, { arbol, variables }, filas, periodo) {
    const valores = calcularVariables(filas, periodo, variables);
    const { valor, error } = evaluarFormula(arbol, valores);
    return {
      periodo: presentarPeriodo(periodo),
      valor,
      estado: calcularEstado(valor, indicador),
      variables: valores,
      error,
    };
  }

  async calcularValor(id, periodoClave, { ahora } = {}) {
    const indicador = await this._obtenerFila(id);
    const analisis = this._analizarFormulaGuardada(indicador);
    const periodo = resolverPeriodoIndicador(periodoClave, indicador.frecuencia, hoyArgentina(ahora));

    const filas = await this._totalesMovimientos(periodo.desde, periodo.hasta);
    return { indicador: resumenIndicador(indicador), ...this._calcularPunto(indicador, analisis, filas, periodo) };
  }

  async calcularHistorico(id, ventana, { ahora } = {}) {
    const indicador = await this._obtenerFila(id);
    const analisis = this._analizarFormulaGuardada(indicador);
    const period = ventana === undefined || ventana === '' ? DEFAULT_VENTANA_HISTORICO : ventana;
    if (!MESES_POR_VENTANA[period]) {
      throw error400(`Período inválido: "${period}". Opciones: ${Object.keys(MESES_POR_VENTANA).join(', ')}.`);
    }
    const periodos = periodosDeVentana(period, indicador.frecuencia, hoyArgentina(ahora));

    const filas = await this._totalesMovimientos(periodos[0].desde, periodos[periodos.length - 1].hasta);
    const puntos = periodos.map(p => this._calcularPunto(indicador, analisis, filas, p));

    return {
      indicador: resumenIndicador(indicador),
      period,
      puntos,
      ultimoValido: [...puntos].reverse().find(p => p.valor !== null) || null,
      tendencia: this._tendencia(puntos),
    };
  }

  // Variación entre los dos últimos puntos con valor.
  _tendencia(puntos) {
    const validos = puntos.filter(p => p.valor !== null);
    if (validos.length < 2) return null;
    const ultimo = validos[validos.length - 1].valor;
    const anterior = validos[validos.length - 2].valor;
    const variacion = Math.round((ultimo - anterior) * 10000) / 10000 + 0;
    return {
      variacion,
      direccion: variacion > 0 ? 'SUBE' : variacion < 0 ? 'BAJA' : 'ESTABLE',
    };
  }

  // ── Soporte para Dashboard ──────────────────────────────────────────────────

  // Map id → activo para los indicadores pedidos (los inexistentes no figuran).
  async obtenerEstadoIndicadores(ids) {
    const validos = [...new Set(ids)].filter(id => UUID_REGEX.test(id));
    if (validos.length === 0) return new Map();
    const { data, error } = await supabase.from('indicadores').select('id, activo').in('id', validos);
    if (error) throw error;
    return new Map((data || []).map(i => [i.id, i.activo]));
  }
}

const service = new IndicadoresService();
module.exports = service;
module.exports.calcularEstado = calcularEstado;
module.exports.UUID_REGEX = UUID_REGEX;
