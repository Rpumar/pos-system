import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { initializeDatabase, getDB } from './db/index.js';
import { JWTPayload } from './middleware/auth.js';

const app = express();
const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /api/mi/caja - Resolver la caja de un usuario (accesible a cualquier rol)
app.get('/api/mi/caja', async (req, res) => {
  try {
    const { authMiddleware } = await import('./middleware/auth.js');
    await new Promise<void>((resolve) => {
      authMiddleware(req as any, res as any, () => resolve());
    });
    const user = (req as any).user;
    if (!user) return;

    const { nombre } = req.query;
    const db = getDB();
    let sql = 'SELECT id, nombre, sucursal_id FROM cajas WHERE sucursal_id = ?';
    const params: any[] = [user.sucursalId];
    if (nombre) {
      sql += ' AND nombre = ?';
      params.push(nombre);
    }
    sql += ' ORDER BY nombre ASC LIMIT 1';

    const caja = db.prepare(sql).get(...params);
    if (!caja) {
      res.status(404).json({ error: 'No se encontró caja para la sucursal del usuario' });
      return;
    }
    res.json({ caja_id: caja.id, sucursal_id: caja.sucursal_id, caja_nombre: caja.nombre });
  } catch (error) {
    res.status(500).json({ error: 'Error resolviendo caja' });
  }
});

// Funciones para emitir eventos desde rutas
export function emitToSucursal(sucursalId: string, event: string, data: any): void {
  io.to(`sucursal:${sucursalId}`).emit(event, data);
}

export function emitToCaja(cajaId: string, event: string, data: any): void {
  io.to(`caja:${cajaId}`).emit(event, data);
}

export function broadcast(event: string, data: any): void {
  io.emit(event, data);
}

// WebSocket connection handling
const connectedClients = new Map<string, { socket: Socket; user: JWTPayload; cajaId?: string }>();

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    if (!token) return next(new Error('Token requerido'));

    const { verifyToken } = await import('./middleware/auth.js');
    const payload = verifyToken(token as string);
    if (!payload) return next(new Error('Token inválido'));

    (socket as any).user = payload;
    next();
  } catch (error) {
    next(new Error('Error de autenticación'));
  }
});

io.on('connection', (socket: Socket) => {
  const user = (socket as any).user as JWTPayload;
  console.log(`[WS] Cliente conectado: ${user.userId} (${user.role})`);

  connectedClients.set(socket.id, { socket, user });

  // Unirse a room de sucursal
  socket.join(`sucursal:${user.sucursalId}`);

  // Manejar registro de caja
  socket.on('register-caja', (cajaId: string) => {
    const client = connectedClients.get(socket.id);
    if (client) {
      client.cajaId = cajaId;
      socket.join(`caja:${cajaId}`);
      console.log(`[S] Caja registrada: ${cajaId} por ${user.userId}`);
    }
  });

  socket.on('ping', () => {
    socket.emit('pong', { timestamp: Date.now() });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[S] Cliente desconectado: ${user.userId} (${reason})`);
    connectedClients.delete(socket.id);
  });
});

async function main(): Promise<void> {
  // Inicializar la DB antes de cargar rutas (las rutas usan getDB() a nivel de módulo)
  await initializeDatabase();

  const { default: productosRouter } = require('./routes/productos.js') as { default: import('express').Router };
  const { default: ventasRouter } = require('./routes/ventas.js') as { default: import('express').Router };
  const { default: turnosRouter } = require('./routes/turnos.js') as { default: import('express').Router };
  const { default: syncRouter } = require('./routes/sync.js') as { default: import('express').Router };
  const { default: dashboardRouter } = require('./routes/dashboard.js') as { default: import('express').Router };
  const auth = require('./middleware/auth.js') as typeof import('./middleware/auth.js');

  // Throttle de login server-side (in-memory; por IP+email).
  const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
  const LOGIN_LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MS || 5 * 60_000);
  const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

  function pruneloginAttempts(): void {
    if (loginAttempts.size < 5000) return;
    const now = Date.now();
    for (const [k, v] of loginAttempts) {
      if (v.count === 0 || (v.lockedUntil && v.lockedUntil < now)) loginAttempts.delete(k);
    }
  }

  // Auth routes
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, pin } = req.body;
      if (!email || !pin) {
        res.status(400).json({ error: 'Email y PIN requeridos' });
        return;
      }

      // Throttle server-side por IP+email: el lockout del cliente es solo UI,
      // esto protege la API directamente (fuerza bruta de PIN de 4 dígitos).
      const key = `${req.ip ?? ''}|${String(email).toLowerCase().trim()}`;
      const rec = loginAttempts.get(key);
      if (rec && rec.lockedUntil && Date.now() < rec.lockedUntil) {
        res.setHeader('Retry-After', String(Math.ceil((rec.lockedUntil - Date.now()) / 1000)));
        res.status(429).json({ error: 'Demasiados intentos fallidos. Intente nuevamente más tarde' });
        return;
      }

      const bcrypt = await import('bcryptjs');
      const db = getDB();
      const user = db.prepare('SELECT * FROM usuarios WHERE email = ? AND activa = 1').get(email);

      if (!user || !bcrypt.default.compareSync(pin, user.pin_hash)) {
        // Si el lockout previo ya venció, el conteo arranca de nuevo: un solo
        // error tras la ventana no debe re-bloquear con count perpetuado.
        const lockExpirado = !!rec?.lockedUntil && rec.lockedUntil !== 0 && Date.now() >= rec.lockedUntil;
        const count = lockExpirado ? 1 : (rec?.count ?? 0) + 1;
        const lockedUntil = count >= LOGIN_MAX_ATTEMPTS ? Date.now() + LOGIN_LOCKOUT_MS : 0;
        loginAttempts.set(key, { count, lockedUntil });
        pruneloginAttempts();
        res.status(401).json({ error: 'Credenciales inválidas' });
        return;
      }

      loginAttempts.delete(key);

      const token = auth.generateToken({
        userId: user.id,
        sucursalId: user.sucursal_id,
        role: user.role,
      });

      res.json({
        token,
        user: {
          id: user.id,
          nombre: user.nombre,
          email: user.email,
          role: user.role,
          sucursal_id: user.sucursal_id,
        },
      });
    } catch (error) {
      console.error('[Auth] Error:', error);
      res.status(500).json({ error: 'Error en login' });
    }
  });

  // API Routes
  app.use('/api/productos', productosRouter);
  app.use('/api/ventas', ventasRouter);
  app.use('/api/turnos', turnosRouter);
  app.use('/api/sync', syncRouter);
  app.use('/api/dashboard', dashboardRouter);

  // Start server
  const PORT = process.env.PORT ?? 3001;
  httpServer.listen(PORT, () => {
    console.log(`POS Server corriendo en puerto ${PORT}`);
    console.log(`WebSocket habilitado`);
    console.log(`API: http://localhost:${PORT}/api`);
  });
}

main().catch((error) => {
  console.error('[Server] Error fatal de arranque:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] Apagando...');
  httpServer.close(() => {
    console.log('[Server] Cerrado');
    process.exit(0);
  });
});

export { app, io };