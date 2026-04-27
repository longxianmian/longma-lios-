import Redis, { RedisOptions } from 'ioredis';

function makeClient(opts: Partial<RedisOptions> = {}): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    lazyConnect:      true,
    enableReadyCheck: false,
    ...opts,
  });
}

// Used by workers — blocking XREADGROUP requires null (infinite retries)
export const redis = makeClient({ maxRetriesPerRequest: null });

// Used by HTTP handlers — fails fast so requests don't hang
export const redisPub = makeClient({ maxRetriesPerRequest: 2, connectTimeout: 1000 });
