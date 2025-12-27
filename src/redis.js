const Redis = require('ioredis');

/**
 * Redis-backed store for channel data, Spotify tokens, and skip votes
 *
 * Keys:
 * - channel:{channelId} -> { slackChannelId, spotify: {...}, queue: [...] }
 * - skipVote:{channelId}:{skipId} -> { id, trackName, artistName, ... }
 * - skipVoteUsers:{skipId}:thumbsUp -> Set of user IDs
 * - skipVoteUsers:{skipId}:thumbsDown -> Set of user IDs
 */

// Initialize Redis client with serverless-safe singleton pattern
function createRedisClient() {
  // Use a global singleton to reuse connections across invocations
  if (global.__redisClient) {
    console.log('Redis: Reusing existing connection');
    return global.__redisClient;
  }

  console.log('Redis: Creating new connection to', process.env.REDIS_URL ? 'configured URL' : 'localhost:6379');

  const client = new Redis(process.env.REDIS_URL, {
    // Fail fast when disconnected (don't queue commands)
    enableOfflineQueue: false,
    // Allow unlimited retries at the client level (avoid "max retries per request" errors)
    maxRetriesPerRequest: null,
    // Exponential backoff with cap
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      console.log(`Redis: Retry attempt ${times}, waiting ${delay}ms`);
      return delay;
    },
    // Connection timeout
    connectTimeout: 10000,
    // TLS is handled automatically by ioredis when URL starts with rediss://
    // Use lazyConnect to control when connection happens
    lazyConnect: true
  });

  client.on('connect', () => console.log('Redis: Connected successfully'));
  client.on('ready', () => console.log('Redis: Ready to accept commands'));
  client.on('error', (err) => console.error('Redis connection error:', err.message));
  client.on('close', () => console.warn('Redis: Connection closed'));

  global.__redisClient = client;
  return client;
}

const redisClient = createRedisClient();

let connectionPromise = null;

// Ensure connection is established before any operation
async function ensureConnection() {
  if (redisClient.status === 'ready') {
    return;
  }

  if (!connectionPromise) {
    console.log('Redis: Initiating connection...');
    connectionPromise = redisClient.connect().catch(err => {
      console.error('Redis: Failed to connect:', err.message);
      connectionPromise = null;
      throw err;
    });
  }

  await connectionPromise;
}

const CHANNEL_PREFIX = 'channel:';
const SKIP_VOTE_PREFIX = 'skipVote:';
const SKIP_VOTE_USERS_PREFIX = 'skipVoteUsers:';
const TEAM_PREFIX = 'team:';

// TTL for skip votes (15 minutes)
const SKIP_VOTE_TTL = 60 * 15;

const redis = {
  // Channel operations
  async getChannel(channelId) {
    await ensureConnection();
    const value = await redisClient.get(`${CHANNEL_PREFIX}${channelId}`);
    return value ? JSON.parse(value) : null;
  },

  async setChannel(channelId, data) {
    await ensureConnection();
    await redisClient.set(`${CHANNEL_PREFIX}${channelId}`, JSON.stringify(data));
  },

  async updateChannel(channelId, updates) {
    const channel = await this.getChannel(channelId) || { slackChannelId: channelId, queue: [] };
    const updated = { ...channel, ...updates };
    await this.setChannel(channelId, updated);
    return updated;
  },

  // Skip vote operations
  async getSkipVote(channelId, skipId) {
    await ensureConnection();
    const value = await redisClient.get(`${SKIP_VOTE_PREFIX}${channelId}:${skipId}`);
    if (!value) return null;

    const vote = JSON.parse(value);

    // Get the vote counts from Redis sets
    const thumbsUpUsers = await redisClient.smembers(`${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsUp`) || [];
    const thumbsDownUsers = await redisClient.smembers(`${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsDown`) || [];

    return {
      ...vote,
      thumbsUpUsers: new Set(thumbsUpUsers),
      thumbsDownUsers: new Set(thumbsDownUsers)
    };
  },

  async setSkipVote(channelId, skipId, vote) {
    await ensureConnection();
    // Store vote metadata
    const { thumbsUpUsers, thumbsDownUsers, ...voteData } = vote;
    await redisClient.set(
      `${SKIP_VOTE_PREFIX}${channelId}:${skipId}`,
      JSON.stringify(voteData),
      'EX',
      SKIP_VOTE_TTL
    );

    // Store user sets separately
    if (thumbsUpUsers && thumbsUpUsers.size > 0) {
      await redisClient.sadd(`${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsUp`, ...Array.from(thumbsUpUsers));
      await redisClient.expire(`${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsUp`, SKIP_VOTE_TTL);
    }
    if (thumbsDownUsers && thumbsDownUsers.size > 0) {
      await redisClient.sadd(`${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsDown`, ...Array.from(thumbsDownUsers));
      await redisClient.expire(`${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsDown`, SKIP_VOTE_TTL);
    }
  },

  async addThumbsUp(skipId, userId) {
    await ensureConnection();
    // Add to thumbs up set (users can have both up and down)
    await redisClient.sadd(`${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsUp`, userId);
    // Refresh TTL
    await redisClient.expire(`${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsUp`, SKIP_VOTE_TTL);
  },

  async addThumbsDown(skipId, userId) {
    await ensureConnection();
    // Add to thumbs down set (users can have both up and down)
    await redisClient.sadd(`${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsDown`, userId);
    // Refresh TTL
    await redisClient.expire(`${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsDown`, SKIP_VOTE_TTL);
  },

  async removeThumbsUp(skipId, userId) {
    await ensureConnection();
    await redisClient.srem(`${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsUp`, userId);
  },

  async removeThumbsDown(skipId, userId) {
    await ensureConnection();
    await redisClient.srem(`${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsDown`, userId);
  },

  async deleteSkipVote(channelId, skipId) {
    await ensureConnection();
    await redisClient.del(
      `${SKIP_VOTE_PREFIX}${channelId}:${skipId}`,
      `${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsUp`,
      `${SKIP_VOTE_USERS_PREFIX}${skipId}:thumbsDown`
    );
  },

  async findSkipVoteByMessageTs(channelId, messageTs) {
    await ensureConnection();
    // Scan for skip votes in this channel
    const pattern = `${SKIP_VOTE_PREFIX}${channelId}:*`;
    const keys = await redisClient.keys(pattern);

    for (const key of keys) {
      const value = await redisClient.get(key);
      if (value) {
        const vote = JSON.parse(value);
        if (vote.messageTs === messageTs) {
          const skipId = key.split(':')[2]; // Extract skipId from key
          return await this.getSkipVote(channelId, skipId);
        }
      }
    }
    return null;
  },

  // Debug/admin operations
  async getAllChannels() {
    await ensureConnection();
    const keys = await redisClient.keys(`${CHANNEL_PREFIX}*`);
    const channels = {};
    for (const key of keys) {
      const value = await redisClient.get(key);
      if (value) {
        const channelId = key.replace(CHANNEL_PREFIX, '');
        channels[channelId] = JSON.parse(value);
      }
    }
    return channels;
  },

  // Team token operations (for Slack OAuth)
  async storeTeamToken(teamId, tokenData) {
    await ensureConnection();
    await redisClient.set(`${TEAM_PREFIX}${teamId}`, JSON.stringify(tokenData));
  },

  async getTeamToken(teamId) {
    await ensureConnection();
    const value = await redisClient.get(`${TEAM_PREFIX}${teamId}`);
    return value ? JSON.parse(value) : null;
  },

  async getTeamByChannelId(channelId) {
    await ensureConnection();
    // This requires looking up which team a channel belongs to
    // For now, we'll need to store this mapping when channels are created
    const value = await redisClient.get(`channelTeam:${channelId}`);
    return value;
  },

  async setChannelTeam(channelId, teamId) {
    await ensureConnection();
    await redisClient.set(`channelTeam:${channelId}`, teamId);
  }
};

module.exports = redis;



