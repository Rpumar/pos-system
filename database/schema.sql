-- =====================================================================
-- SISTEMA POS SUPERMERCADO — ESQUEMA CONSOLIDADO (SQLite)
-- Corre en el servidor local de la red del supermercado (Módulo 5).
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- USUARIOS Y AUTENTICACIÓN (Módulo 6)
-- ============================================================
CREATE TABLE users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    pin_hash    TEXT NOT NULL,                 -- nunca se guarda el PIN en texto plano
    role        TEXT NOT NULL CHECK (role IN ('CASHIER', 'SUPERVISOR', 'ADMIN')),
    active      INTEGER NOT NULL DEFAULT 1,     -- SQLite no tiene BOOLEAN: 0/1
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- PRODUCTOS (Módulo 1 / 3)
-- ============================================================
CREATE TABLE products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sku         TEXT NOT NULL UNIQUE,
    barcode     TEXT NOT NULL,
    name        TEXT NOT NULL,
    price       REAL NOT NULL CHECK (price >= 0),
    stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    active      INTEGER NOT NULL DEFAULT 1,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- El escaneo se hace SIEMPRE por barcode: debe resolver en microsegundos.
CREATE UNIQUE INDEX idx_products_barcode ON products(barcode);
CREATE INDEX idx_products_active ON products(active) WHERE active = 1;

-- ============================================================
-- LOTES Y VENCIMIENTOS — estrategia FEFO (Módulo 4)
-- ============================================================
CREATE TABLE batches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id      INTEGER NOT NULL REFERENCES products(id),
    batch_code      TEXT NOT NULL,
    quantity        INTEGER NOT NULL CHECK (quantity >= 0),
    expiration_date TEXT NOT NULL,              -- formato ISO 'YYYY-MM-DD'
    received_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Índice parcial: solo lotes con stock real, ordenado por vencimiento.
-- Es lo que hace que el listado de alertas y el consumo FEFO sean instantáneos.
CREATE INDEX idx_batches_expiration ON batches(expiration_date, product_id) WHERE quantity > 0;
CREATE INDEX idx_batches_product ON batches(product_id);

-- ============================================================
-- MOVIMIENTOS DE STOCK — auditoría de inventario (Módulo 3 / 4)
-- ============================================================
CREATE TABLE stock_movements (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id      INTEGER NOT NULL REFERENCES products(id),
    delta           INTEGER NOT NULL,           -- negativo = venta, positivo = reposición/devolución
    reason          TEXT NOT NULL CHECK (reason IN ('SALE', 'RESTOCK', 'ADJUSTMENT', 'RETURN')),
    reference_id    TEXT,                        -- sale_id, código de orden de compra, etc.
    batch_detail    TEXT,                        -- JSON: lotes afectados (trazabilidad FEFO)
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_stock_movements_product ON stock_movements(product_id, created_at);

-- ============================================================
-- TURNOS DE CAJA (Módulo 6)
-- ============================================================
CREATE TABLE shifts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    cashier_id      INTEGER NOT NULL REFERENCES users(id),
    register_id     TEXT NOT NULL,               -- identifica la caja física
    opening_amount  REAL NOT NULL,
    expected_cash   REAL,                        -- calculado recién al cierre
    counted_cash    REAL,                        -- contado físicamente por el cajero
    difference      REAL,
    status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    opened_at       TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at       TEXT
);

-- Garantiza a nivel de BD que nunca haya dos turnos abiertos en la misma caja física.
CREATE UNIQUE INDEX idx_shifts_register_open ON shifts(register_id) WHERE status = 'OPEN';
CREATE INDEX idx_shifts_cashier ON shifts(cashier_id, opened_at);

-- ============================================================
-- VENTAS (Módulo 1 / 3 / 5 / 6)
-- ============================================================
CREATE TABLE sales (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id        INTEGER NOT NULL REFERENCES shifts(id),   -- ninguna venta sin turno abierto
    cashier_id      INTEGER NOT NULL REFERENCES users(id),
    status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'CANCELLED', 'VOIDED')),
    payment_method  TEXT CHECK (payment_method IN ('CASH', 'CARD')),
    auth_code       TEXT,                        -- código de autorización del terminal de tarjeta
    total           REAL NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    synced_at       TEXT                         -- NULL = pendiente de sync a la nube (Outbox)
);

CREATE INDEX idx_sales_synced ON sales(synced_at) WHERE synced_at IS NULL;
CREATE INDEX idx_sales_created_at ON sales(created_at);
CREATE INDEX idx_sales_shift ON sales(shift_id);

-- ============================================================
-- DETALLE DE VENTAS
-- ============================================================
CREATE TABLE sale_details (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id     INTEGER NOT NULL REFERENCES sales(id),
    product_id  INTEGER NOT NULL REFERENCES products(id),
    quantity    INTEGER NOT NULL CHECK (quantity > 0),
    unit_price  REAL NOT NULL,
    subtotal    REAL NOT NULL
);

CREATE INDEX idx_sale_details_sale ON sale_details(sale_id);

-- ============================================================
-- MOVIMIENTOS DE EFECTIVO — para el arqueo (Módulo 6)
-- ============================================================
CREATE TABLE cash_movements (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id        INTEGER NOT NULL REFERENCES shifts(id),
    type            TEXT NOT NULL CHECK (type IN ('SALE_CASH', 'WITHDRAWAL', 'DEPOSIT', 'REFUND')),
    amount          REAL NOT NULL,
    reason          TEXT,
    authorized_by   INTEGER REFERENCES users(id),    -- supervisor, si aplicó
    reference_id    TEXT,                             -- sale_id si type = SALE_CASH
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_cash_movements_shift ON cash_movements(shift_id);

-- ============================================================
-- BITÁCORA DE AUDITORÍA (Módulo 6)
-- ============================================================
CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    action      TEXT NOT NULL,            -- VOID_SALE, PRICE_OVERRIDE, WITHDRAWAL, LOGIN_FAILED...
    entity      TEXT,
    entity_id   TEXT,
    metadata    TEXT,                     -- JSON con detalle (monto anterior/nuevo, etc.)
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_log_user ON audit_log(user_id, created_at);

-- =====================================================================
-- NOTA DE ENDURECIMIENTO (aplicar en el archivo de despliegue, no aquí):
-- revocar permisos UPDATE/DELETE sobre audit_log para el usuario de la
-- aplicación. Una bitácora editable no sirve como evidencia ante un
-- descuadre o fraude.
-- =====================================================================
