export class InvalidPinError extends Error {
  constructor() {
    super('PIN incorrecto');
    this.name = 'InvalidPinError';
  }
}

export class AccountLockedError extends Error {
  constructor(public readonly lockedUntil: Date) {
    super(`Cuenta bloqueada hasta ${lockedUntil.toLocaleTimeString('es-UY')}`);
    this.name = 'AccountLockedError';
  }
}

export class ShiftAlreadyOpenError extends Error {
  constructor(registerId: string) {
    super(`La caja ${registerId} ya tiene un turno abierto`);
    this.name = 'ShiftAlreadyOpenError';
  }
}

export class ShiftNotOpenError extends Error {
  constructor(shiftId: string) {
    super(`No hay turno abierto con id ${shiftId}`);
    this.name = 'ShiftNotOpenError';
  }
}

export class UnauthorizedActionError extends Error {
  constructor(action: string) {
    super(`Se requiere autorización de supervisor para: ${action}`);
    this.name = 'UnauthorizedActionError';
  }
}
