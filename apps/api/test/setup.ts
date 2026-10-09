process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://postgres:postgres@localhost:5432/trading_test';
process.env.REDIS_URL ??= 'redis://localhost:6379/15';
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-123';
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
