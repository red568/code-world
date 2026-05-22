import Redis from "ioredis";

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
  redisSub: Redis | undefined;
};

function createRedisClient(): Redis {
  const client = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  client.on("error", () => {
    // 静默处理连接错误，避免 build 时抛出未捕获异常
  });
  return client;
}

// 主连接：用于队列、pub/sub 发布、通用读写
export const redis = globalForRedis.redis ?? createRedisClient();

// 订阅专用连接：Redis 进入订阅模式后不能执行其他命令
export const redisSub = globalForRedis.redisSub ?? createRedisClient();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
  globalForRedis.redisSub = redisSub;
}
