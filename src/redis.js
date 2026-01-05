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
const CHANNEL_TEAM_PREFIX = 'channelTeam:';

// TTL for skip votes (15 minutes)
const SKIP_VOTE_TTL = 60 * 15;

const redis = {
  // Channel operations (now scoped by teamId)
  async getChannel(teamId, channelId) {
    await ensureConnection();
    const value = await redisClient.get(`${CHANNEL_PREFIX}${teamId}:${channelId}`);
    return value ? JSON.parse(value) : null;
  },

  async setChannel(teamId, channelId, data) {
    await ensureConnection();
    await redisClient.set(`${CHANNEL_PREFIX}${teamId}:${channelId}`, JSON.stringify(data));
    // Also maintain the channel-to-team mapping for reverse lookups
    await redisClient.set(`${CHANNEL_TEAM_PREFIX}${channelId}`, teamId);
  },

  async updateChannel(teamId, channelId, updates) {
    const channel = await this.getChannel(teamId, channelId) || { slackChannelId: channelId };
    const updated = { ...channel, ...updates };
    await this.setChannel(teamId, channelId, updated);
    return updated;
  },

  // Skip vote operations (now scoped by teamId)
  async getSkipVote(teamId, channelId, skipId) {
    await ensureConnection();
    const value = await redisClient.get(`${SKIP_VOTE_PREFIX}${teamId}:${channelId}:${skipId}`);
    if (!value) return null;

    const vote = JSON.parse(value);

    // Get the vote counts from Redis sets (skipId is globally unique with timestamp)
    const thumbsUpUsers = await redisClient.smembers(`${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsUp`) || [];
    const thumbsDownUsers = await redisClient.smembers(`${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsDown`) || [];

    return {
      ...vote,
      thumbsUpUsers: new Set(thumbsUpUsers),
      thumbsDownUsers: new Set(thumbsDownUsers)
    };
  },

  async setSkipVote(teamId, channelId, skipId, vote) {
    await ensureConnection();
    // Store vote metadata
    const { thumbsUpUsers, thumbsDownUsers, ...voteData } = vote;
    await redisClient.set(
      `${SKIP_VOTE_PREFIX}${teamId}:${channelId}:${skipId}`,
      JSON.stringify(voteData),
      'EX',
      SKIP_VOTE_TTL
    );

    // Store user sets separately
    if (thumbsUpUsers && thumbsUpUsers.size > 0) {
      await redisClient.sadd(`${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsUp`, ...Array.from(thumbsUpUsers));
      await redisClient.expire(`${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsUp`, SKIP_VOTE_TTL);
    }
    if (thumbsDownUsers && thumbsDownUsers.size > 0) {
      await redisClient.sadd(`${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsDown`, ...Array.from(thumbsDownUsers));
      await redisClient.expire(`${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsDown`, SKIP_VOTE_TTL);
    }
  },

  async addThumbsUp(teamId, skipId, userId) {
    await ensureConnection();
    // Add to thumbs up set (users can have both up and down)
    await redisClient.sadd(`${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsUp`, userId);
    // Refresh TTL
    await redisClient.expire(`${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsUp`, SKIP_VOTE_TTL);
  },

  async addThumbsDown(teamId, skipId, userId) {
    await ensureConnection();
    // Add to thumbs down set (users can have both up and down)
    await redisClient.sadd(`${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsDown`, userId);
    // Refresh TTL
    await redisClient.expire(`${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsDown`, SKIP_VOTE_TTL);
  },

  async removeThumbsUp(teamId, skipId, userId) {
    await ensureConnection();
    await redisClient.srem(`${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsUp`, userId);
  },

  async removeThumbsDown(teamId, skipId, userId) {
    await ensureConnection();
    await redisClient.srem(`${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsDown`, userId);
  },

  async deleteSkipVote(teamId, channelId, skipId) {
    await ensureConnection();
    await redisClient.del(
      `${SKIP_VOTE_PREFIX}${teamId}:${channelId}:${skipId}`,
      `${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsUp`,
      `${SKIP_VOTE_USERS_PREFIX}${teamId}:${skipId}:thumbsDown`
    );
  },

  async findSkipVoteByMessageTs(teamId, channelId, messageTs) {
    await ensureConnection();
    // Scan for skip votes in this channel
    const pattern = `${SKIP_VOTE_PREFIX}${teamId}:${channelId}:*`;
    const keys = await redisClient.keys(pattern);

    for (const key of keys) {
      const value = await redisClient.get(key);
      if (value) {
        const vote = JSON.parse(value);
        if (vote.messageTs === messageTs) {
          const skipId = key.split(':')[3]; // Extract skipId from key (team:channel:skipId)
          return await this.getSkipVote(teamId, channelId, skipId);
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
        // Key format is now channel:teamId:channelId
        const parts = key.replace(CHANNEL_PREFIX, '').split(':');
        const teamId = parts[0];
        const channelId = parts[1];
        const fullKey = `${teamId}:${channelId}`;
        channels[fullKey] = JSON.parse(value);
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

  // Get team ID from channel ID (for reverse lookups)
  async getTeamByChannelId(channelId) {
    await ensureConnection();
    const value = await redisClient.get(`${CHANNEL_TEAM_PREFIX}${channelId}`);
    return value;
  },

  // Helper methods for channel-to-team mapping
  async setChannelTeam(channelId, teamId) {
    await ensureConnection();
    await redisClient.set(`${CHANNEL_TEAM_PREFIX}${channelId}`, teamId);
  },

  async getChannelTeam(channelId) {
    await ensureConnection();
    const value = await redisClient.get(`${CHANNEL_TEAM_PREFIX}${channelId}`);
    return value;
  }
};

module.exports = redis;



