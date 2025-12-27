const axios = require('axios');

/**
 * Slack API client functions
 * All functions now accept botToken as parameter for multi-workspace support
 */

async function postQueuedMessage(channel, queued, botToken) {
  // Post a message announcing the queued song. Return the slack response (ts, channel)
  const text = `Queued: "${queued.title}" by ${queued.artist} - react with :thumbsup: or :thumbsdown:`;

  if (!botToken || !botToken.startsWith('xoxb-')) {
    console.log('Mock Slack post (no valid token):', text);
    return { ok: true, ts: (Date.now() / 1000).toString(), channel };
  }

  const r = await axios.post('https://slack.com/api/chat.postMessage', { channel, text }, { headers: { Authorization: `Bearer ${botToken}` } });
  if (!r.data.ok) throw new Error('Slack API error: ' + JSON.stringify(r.data));
  return r.data;
}

async function postMessage(channel, text, botToken) {
  if (!botToken || !botToken.startsWith('xoxb-')) {
    console.log('Mock Slack post (no valid token):', text);
    return { ok: true, ts: (Date.now() / 1000).toString(), channel };
  }

  const r = await axios.post('https://slack.com/api/chat.postMessage', { channel, text }, { headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' } });
  if (!r.data.ok) throw new Error('Slack API error: ' + JSON.stringify(r.data));
  return r.data;
}

async function postSkipVoteMessage(channel, trackName, artistName, requestedBy, botToken) {
  // Post a skip vote message
  const text = `⏭️ Skip requested by ${requestedBy}\n🎵 Currently playing: "${trackName}" by ${artistName}\n\n👍 React with thumbs up in 10 seconds to save it!\n👎 Thumbs down to skip`;

  if (!botToken || !botToken.startsWith('xoxb-')) {
    console.log('Mock Slack skip vote post:', text);
    return { ok: true, ts: (Date.now() / 1000).toString(), channel };
  }

  const r = await axios.post('https://slack.com/api/chat.postMessage', { channel, text }, { headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' } });
  if (!r.data.ok) throw new Error('Slack API error: ' + JSON.stringify(r.data));
  return r.data;
}

module.exports = { postQueuedMessage, postMessage, postSkipVoteMessage };

