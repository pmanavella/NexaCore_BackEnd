const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const rootDir = path.resolve(__dirname, '..');

const NODE_ENV = process.env.NODE_ENV || 'production';
const isDevelopment = NODE_ENV === 'development';

const envFile = isDevelopment ? '.env.development' : '.env';
const envPath = path.join(rootDir, envFile);
const envFileExists = fs.existsSync(envPath);

// En development el archivo local es obligatorio. En production se tolera
// su ausencia porque algunos despliegues (Docker, Render, etc.) excluyen
// el .env de la imagen a propósito y las variables reales las inyecta la
// plataforma de hosting como variables de entorno del sistema.
if (isDevelopment && !envFileExists) {
  throw new Error(
    `Modo development requiere el archivo "${envFile}" en la raíz del proyecto y no se encontró.`
  );
}

if (envFileExists) {
  const result = dotenv.config({ path: envPath });
  if (result.error) {
    throw new Error(`Error al cargar "${envFile}": ${result.error.message}`);
  }
} else {
  console.warn(`⚠️  No se encontró "${envFile}" — se usarán las variables de entorno ya definidas en el sistema.`);
}

// ── Validación de seguridad: nunca cruzar dev <-> prod ─────────────────
// Compara el SUPABASE_URL recién cargado contra el del otro archivo de
// entorno (sin cargarlo en process.env) para detectar si, por error,
// ambos apuntan a la misma base de datos.
const otherFile = isDevelopment ? '.env' : '.env.development';
const otherPath = path.join(rootDir, otherFile);

if (fs.existsSync(otherPath)) {
  const otherParsed = dotenv.parse(fs.readFileSync(otherPath));
  const currentUrl = process.env.SUPABASE_URL;
  const otherUrl = otherParsed.SUPABASE_URL;

  if (currentUrl && otherUrl && currentUrl === otherUrl) {
    throw new Error(
      `🚨 SEGURIDAD: el SUPABASE_URL cargado desde "${envFile}" es idéntico al definido en "${otherFile}". ` +
      `Ambos entornos apuntarían a la misma base de datos. Se aborta el arranque en modo "${NODE_ENV}" ` +
      `para evitar operar por error sobre la base incorrecta. Revisá y corregí los archivos de entorno.`
    );
  }
}

const label = isDevelopment ? 'DEVELOPMENT' : 'PRODUCTION';
const dbLabel = process.env.DB_LABEL || (isDevelopment ? 'Development' : 'nexacore_db');
const port = process.env.PORT || 3001;

console.log(`🔧 Entorno: ${label} | Base: ${dbLabel} | Puerto: ${port} | Archivo: ${envFile} | Supabase: ${process.env.SUPABASE_URL}`);

module.exports = { NODE_ENV, isDevelopment, envFile };
