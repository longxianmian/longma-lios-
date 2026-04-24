import Redis from 'ioredis';

function makeClient(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    lazyConnect:          true,
    maxRetriesPerRequest: null,   // required for blocking XREADGROUP
    enableReadyCheck:     false,
  });
}

export const redis = makeClient();
