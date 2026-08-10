import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { getDB } from '../db/index.js';
import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// El secreto JWT NUNCA debe ser el default conocido. En producción se toma de
// JWT_SECRET; si no está seteado, se genera uno aleatorio y se persiste junto
// a la base (para que las sesiones sobrevivan reinicios del server).
function loadJwtSecret(secretPath: string): string {
  try {
    return readFileSync(secretPath, 'utf8').trim();
  } catch {
    const secret = randomBytes(32).toString('hex');
    try {
      mkdirSync(dirname(secretPath), { recursive: true });
      writeFileSync(secretPath, secret, { mode: 0o600 });
    } catch {
      /* si no puede persistir, se cae a secreto efímero */
    }
    return secret;
  }
}

function loadJwtSecretFromEnvOrFile(): string {
  const env = process.env.JWT_SECRET;
  if (env && env.trim()) return env.trim();
  const dbPath = process.env.POS_SERVER_DB_PATH ?? join(process.cwd(), 'data', 'pos-server.db');
  return loadJwtSecret(`${dbPath}.jwt-secret`);
}

const JWT_SECRET = loadJwtSecretFromEnvOrFile();
const JWT_EXPIRES = Number(process.env.JWT_EXPIRES || 28800); // 8 hours in seconds

export interface JWTPayload {
  userId: string;
  sucursalId: string;
  role: string;
  cajaId?: string;
  iat?: number;
  exp?: number;
}

export function generateToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload;
  } catch {
    return null;
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token requerido' });
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Token inválido o expirado' });
    return;
  }

  // Verificar que el usuario sigue activo
  const db = getDB();
  const user = db.prepare('SELECT id, activa FROM usuarios WHERE id = ?').get(payload.userId) as { id: string; activa: number } | undefined;
  if (!user || user.activa !== 1) {
    res.status(401).json({ error: 'Usuario inactivo' });
    return;
  }

  (req as any).user = payload;
  next();
}

export function requireRole(...roles: string[]): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user as JWTPayload;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ error: 'Permisos insuficientes' });
      return;
    }
    next();
  };
}

export function requireSucursal(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user as JWTPayload;
  const sucursalId = req.params.sucursalId || req.body.sucursal_id || req.query.sucursal_id;

  if (sucursalId && sucursalId !== user.sucursalId && user.role !== 'ADMIN') {
    res.status(403).json({ error: 'No autorizado para esta sucursal' });
    return;
  }
  next();
}