# NexaCore Backend

API REST del sistema de gestión empresarial NexaCore, construida con Node.js y Express. Se conecta a Supabase como base de datos y está diseñada para ejecutarse en un contenedor Docker.

## Tecnologías

- **Node.js** 18
- **Express**
- **Supabase** (base de datos y autenticación)
- **Docker**

---

## Requisitos previos

- [Docker](https://www.docker.com/) instalado en el servidor
- Acceso al proyecto de Supabase (URL y Service Role Key)

---

## Variables de entorno

| Variable | Descripción | Requerida |
|----------|-------------|-----------|
| `PORT` | Puerto en el que corre el servidor | Sí |
| `SUPABASE_URL` | URL del proyecto en Supabase | Sí |
| `SUPABASE_SERVICE_KEY` | Service Role Key de Supabase (nunca exponer en el cliente) | Sí |
| `ALLOWED_ORIGINS` | Orígenes permitidos para CORS, separados por coma | Sí |

---

## Ejecutar con Docker

### 1. Obtener la imagen

```bash
docker pull ghcr.io/pmanavella/nexacore-backend:latest
```

### 2. Levantar el contenedor

```bash
docker run -d \
  -p 3001:3001 \
  -e PORT=3001 \
  -e SUPABASE_URL=https://tu-proyecto.supabase.co \
  -e SUPABASE_SERVICE_KEY=tu-service-role-key \
  -e ALLOWED_ORIGINS=https://tu-dominio-frontend.com \
  --name nexacore-backend \
  ghcr.io/pmanavella/nexacore-backend:latest
```

> En `ALLOWED_ORIGINS` colocá la URL donde está hosteado el frontend (Cloudflare Pages). Para múltiples orígenes separarlos por coma.

### 3. Verificar que está corriendo

```bash
docker ps
```

### 4. Ver los logs

```bash
docker logs nexacore-backend
```

El servidor confirmará que está activo con el mensaje:
```
✅ NexaCore Backend corriendo en http://localhost:3001
```

### 5. Health check

```
GET http://localhost:3001/api/health
```

Respuesta esperada:
```json
{ "status": "ok", "app": "NexaCore", "timestamp": "..." }
```

---

## Ejecutar localmente (sin Docker)

### 1. Clonar el repositorio

```bash
git clone https://github.com/pmanavella/NexaCore_BackEnd.git
cd NexaCore_BackEnd
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar variables de entorno

```bash
cp .env.example .env
```

Completar `.env` con los valores reales.

### 4. Iniciar el servidor

```bash
npm run dev
```

---

## Publicación de la imagen Docker

La imagen se publica automáticamente en GitHub Container Registry cada vez que se hace push a la rama `main`, mediante el workflow de GitHub Actions.

```
ghcr.io/pmanavella/nexacore-backend:latest
```
