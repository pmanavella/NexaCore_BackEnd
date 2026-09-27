// Parser/evaluador restringido para fórmulas de Indicadores.
//
// Seguridad: la fórmula NUNCA se ejecuta como código ni se traduce a SQL. Se
// tokeniza contra una lista blanca (números, identificadores del catálogo,
// + - * / ( )), se construye un árbol con descenso recursivo y el árbol se
// evalúa con aritmética de JS. No se usa eval(), Function() ni similares.
//
// Gramática:
//   expresion := termino (('+' | '-') termino)*
//   termino   := unario (('*' | '/') unario)*
//   unario    := '-' unario | primario
//   primario  := NUMERO | VARIABLE | '(' expresion ')'

const MAX_LONGITUD = 500;
const MAX_TOKENS = 200;
const MAX_PROFUNDIDAD = 20;

const OPERADORES = new Set(['+', '-', '*', '/', '(', ')']);

function errorFormula(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400 });
}

function describirToken(token) {
  return token ? `"${token.texto}" (posición ${token.posicion + 1})` : 'el final de la fórmula';
}

function tokenizar(texto) {
  const tokens = [];
  let i = 0;
  while (i < texto.length) {
    const c = texto[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    if (OPERADORES.has(c)) {
      tokens.push({ tipo: c === '(' || c === ')' ? 'parentesis' : 'operador', texto: c, posicion: i });
      i++;
    } else if (c >= '0' && c <= '9') {
      const match = /^\d+(\.\d+)?/.exec(texto.slice(i));
      const siguiente = texto[i + match[0].length];
      if (siguiente === '.' || siguiente === ',') {
        throw errorFormula(`Número inválido en la posición ${i + 1}. Use punto como separador decimal (ej: 0.5).`);
      }
      tokens.push({ tipo: 'numero', texto: match[0], valor: Number(match[0]), posicion: i });
      i += match[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(texto.slice(i));
      tokens.push({ tipo: 'variable', texto: match[0], posicion: i });
      i += match[0].length;
    } else {
      throw errorFormula(`Carácter no permitido "${c}" en la posición ${i + 1}. Solo se admiten variables, números, + - * / y paréntesis.`);
    }

    if (tokens.length > MAX_TOKENS) {
      throw errorFormula(`La fórmula supera el máximo de ${MAX_TOKENS} elementos.`);
    }
  }
  return tokens;
}

function parsear(tokens) {
  let pos = 0;
  let profundidad = 0;

  const actual = () => tokens[pos];

  function expresion() {
    let nodo = termino();
    while (actual() && (actual().texto === '+' || actual().texto === '-')) {
      const op = tokens[pos++].texto;
      nodo = { tipo: 'binario', op, izq: nodo, der: termino() };
    }
    return nodo;
  }

  function termino() {
    let nodo = unario();
    while (actual() && (actual().texto === '*' || actual().texto === '/')) {
      const op = tokens[pos++].texto;
      nodo = { tipo: 'binario', op, izq: nodo, der: unario() };
    }
    return nodo;
  }

  function unario() {
    if (actual() && actual().texto === '-') {
      tokens[pos++].unario = true;
      return { tipo: 'negativo', operando: unario() };
    }
    return primario();
  }

  function primario() {
    const token = actual();
    if (!token) throw errorFormula('La fórmula está incompleta: se esperaba una variable, un número o "(" al final.');

    if (token.tipo === 'numero') {
      pos++;
      return { tipo: 'numero', valor: token.valor };
    }
    if (token.tipo === 'variable') {
      pos++;
      return { tipo: 'variable', clave: token.texto };
    }
    if (token.texto === '(') {
      profundidad++;
      if (profundidad > MAX_PROFUNDIDAD) {
        throw errorFormula(`La fórmula supera el máximo de ${MAX_PROFUNDIDAD} niveles de paréntesis.`);
      }
      pos++;
      const nodo = expresion();
      if (!actual() || actual().texto !== ')') {
        throw errorFormula(`Falta cerrar un paréntesis abierto en la posición ${token.posicion + 1}.`);
      }
      pos++;
      profundidad--;
      return nodo;
    }
    throw errorFormula(`Se esperaba una variable, un número o "(" y se encontró ${describirToken(token)}.`);
  }

  const arbol = expresion();
  if (pos < tokens.length) {
    const token = tokens[pos];
    if (token.texto === ')') throw errorFormula(`Paréntesis de cierre sin apertura en la posición ${token.posicion + 1}.`);
    throw errorFormula(`Se esperaba un operador y se encontró ${describirToken(token)}.`);
  }
  return arbol;
}

// Representación canónica: operadores binarios separados por un espacio, menos
// unario pegado a su operando, paréntesis sin espacios interiores.
function normalizar(tokens) {
  let salida = '';
  for (const token of tokens) {
    if (token.tipo === 'operador' && !token.unario) salida += ` ${token.texto} `;
    else salida += token.texto;
  }
  return salida;
}

function variablesDelArbol(nodo, acumuladas = new Set()) {
  if (nodo.tipo === 'variable') acumuladas.add(nodo.clave);
  else if (nodo.tipo === 'negativo') variablesDelArbol(nodo.operando, acumuladas);
  else if (nodo.tipo === 'binario') {
    variablesDelArbol(nodo.izq, acumuladas);
    variablesDelArbol(nodo.der, acumuladas);
  }
  return acumuladas;
}

// Valida la fórmula contra el catálogo de variables permitidas.
// Devuelve { formula (normalizada), arbol, variables } o lanza un error 400
// con un mensaje comprensible.
function analizarFormula(texto, clavesPermitidas) {
  if (typeof texto !== 'string' || texto.trim() === '') {
    throw errorFormula('La fórmula es obligatoria.');
  }
  if (texto.length > MAX_LONGITUD) {
    throw errorFormula(`La fórmula no puede superar los ${MAX_LONGITUD} caracteres.`);
  }

  const tokens = tokenizar(texto);
  const arbol = parsear(tokens);

  const variables = [...variablesDelArbol(arbol)];
  if (variables.length === 0) {
    throw errorFormula('La fórmula debe utilizar al menos una variable financiera.');
  }
  const desconocidas = variables.filter(v => !clavesPermitidas.has(v));
  if (desconocidas.length > 0) {
    throw errorFormula(`Variable(s) desconocida(s): ${desconocidas.join(', ')}. Use las variables disponibles en GET /api/indicadores/variables.`);
  }

  return { formula: normalizar(tokens), arbol, variables };
}

class ErrorEvaluacion extends Error {
  constructor(codigo, mensaje) {
    super(mensaje);
    this.codigo = codigo;
  }
}

function evaluarNodo(nodo, valores) {
  switch (nodo.tipo) {
    case 'numero': return nodo.valor;
    case 'variable': {
      const valor = valores[nodo.clave];
      if (typeof valor !== 'number' || !Number.isFinite(valor)) {
        throw new ErrorEvaluacion('VARIABLE_SIN_VALOR', `No se obtuvo valor para la variable ${nodo.clave}.`);
      }
      return valor;
    }
    case 'negativo': return -evaluarNodo(nodo.operando, valores);
    case 'binario': {
      const izq = evaluarNodo(nodo.izq, valores);
      const der = evaluarNodo(nodo.der, valores);
      switch (nodo.op) {
        case '+': return izq + der;
        case '-': return izq - der;
        case '*': return izq * der;
        case '/':
          if (der === 0) throw new ErrorEvaluacion('DIVISION_POR_CERO', 'La fórmula divide por cero con los datos del período (por ejemplo, no hubo movimientos para el divisor).');
          return izq / der;
      }
    }
  }
  throw new ErrorEvaluacion('NODO_INVALIDO', 'La fórmula contiene un elemento no soportado.');
}

// Evalúa un árbol ya validado. Nunca lanza por datos: devuelve
// { valor: number, error: null } o { valor: null, error: { codigo, mensaje } }.
function evaluarFormula(arbol, valores) {
  try {
    const resultado = evaluarNodo(arbol, valores);
    if (!Number.isFinite(resultado)) {
      return { valor: null, error: { codigo: 'RESULTADO_NO_FINITO', mensaje: 'El resultado de la fórmula no es un número finito.' } };
    }
    return { valor: Math.round(resultado * 10000) / 10000 + 0, error: null };
  } catch (err) {
    if (err instanceof ErrorEvaluacion) return { valor: null, error: { codigo: err.codigo, mensaje: err.message } };
    throw err;
  }
}

module.exports = { analizarFormula, evaluarFormula, MAX_LONGITUD, MAX_TOKENS, MAX_PROFUNDIDAD };
