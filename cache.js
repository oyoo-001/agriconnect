const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || '';
const CACHE_TTL = {
  WALLET: 30,
  PRODUCTS: 60,
  LISTINGS: 60,
  SESSION: 300,
};

let redis = null;
let redisAvailable = false;

if (REDIS_URL) {
  try {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });
    redis.on('error', (err) => {
      console.error('[CACHE] Redis error:', err.message);
      redisAvailable = false;
    });
    redis.on('ready', () => {
      redisAvailable = true;
    });
    redis.connect().then(() => {
      redisAvailable = true;
      console.log('[CACHE] Redis connected');
    }).catch((err) => {
      console.warn('[CACHE] Redis unavailable — running without cache:', err.message);
      redis = null;
    });
  } catch (e) {
    console.warn('[CACHE] Redis init failed — running without cache:', e.message);
    redis = null;
  }
} else {
  console.log('[CACHE] No REDIS_URL set — running without cache');
}

function isAvailable() {
  return redisAvailable && redis !== null;
}

async function get(key) {
  if (!isAvailable()) return null;
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

async function set(key, value, ttl = 30) {
  if (!isAvailable()) return;
  try {
    const str = JSON.stringify(value);
    if (ttl > 0) {
      await redis.setex(key, ttl, str);
    } else {
      await redis.set(key, str);
    }
  } catch { }
}

async function del(key) {
  if (!isAvailable()) return;
  try {
    await redis.del(key);
  } catch { }
}

async function delPattern(pattern) {
  if (!isAvailable()) return;
  try {
    const stream = redis.scanStream({ match: pattern, count: 100 });
    let pipeline = redis.pipeline();
    let count = 0;
    for await (const keys of stream) {
      if (keys.length > 0) {
        pipeline = redis.pipeline();
        keys.forEach(k => pipeline.del(k));
        await pipeline.exec();
        count += keys.length;
      }
    }
    if (count > 0) console.log('[CACHE] Invalidated ' + count + ' keys matching ' + pattern);
  } catch { }
}

async function getOrSet(key, ttl, fetchFn) {
  if (!isAvailable()) return await fetchFn();
  try {
    const cached = await redis.get(key);
    if (cached !== null) return JSON.parse(cached);
  } catch { }
  const value = await fetchFn();
  if (value !== null && value !== undefined) {
    await set(key, value, ttl);
  }
  return value;
}

function cacheMiddleware(ttl) {
  return (req, res, next) => {
    if (!isAvailable()) return next();
    const key = 'http:' + req.originalUrl;
    redis.get(key).then(cached => {
      if (cached !== null) {
        const data = JSON.parse(cached);
        res.json(data);
      } else {
        const originalJson = res.json.bind(res);
        res.json = (body) => {
          set(key, body, ttl);
          originalJson(body);
        };
        next();
      }
    }).catch(() => next());
  };
}

function walletCacheKey(uid) {
  return 'wallet:' + uid;
}

function productsCacheKey(role, uid) {
  return 'products:' + role + ':' + uid;
}

function invalidateWallet(uid) {
  return del(walletCacheKey(uid));
}

function invalidateProducts() {
  return delPattern('products:*');
}

module.exports = {
  redis,
  isAvailable,
  get,
  set,
  del,
  delPattern,
  getOrSet,
  cacheMiddleware,
  walletCacheKey,
  productsCacheKey,
  invalidateWallet,
  invalidateProducts,
  CACHE_TTL,
};
