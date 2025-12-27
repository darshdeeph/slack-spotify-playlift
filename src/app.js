const express = require('express');
const bodyParser = require('body-parser');
const slack = require('./slack');
const spotify = require('./spotify');
const redis = require('./redis');
const oauth = require('./oauth');
const { Client, Receiver } = require('@upstash/qstash');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());


const qstash = process.env.QSTASH_TOKEN ? new Client({ token: process.env.QSTASH_TOKEN }) : null;
console.log('QStash client initialized:', !!qstash);

// Initialize Receiver for signature verification
const receiver = process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY
  ? new Receiver({
      currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY
    })
  : null;
console.log('QStash Receiver initialized:', !!receiver);
console.log('============================');

// Disable caching for all routes (prevents Vercel edge cache 401 errors)
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});


// Health
app.get('/', (req, res) => res.send('Slack Playlift running'));

// Slack OAuth v2 - Installation URL
app.get('/slack/install', (req, res) => {
  const installUrl = oauth.getInstallUrl();
  res.redirect(installUrl);
});

// Slack OAuth v2 - Callback
app.get('/slack/oauth/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    console.error('OAuth error:', error);
    return res.status(400).send(`Installation failed: ${error}`);
  }

  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  try {
    // Exchange code for token
    const tokenData = await oauth.exchangeCodeForToken(code);

    console.log(`Slack app installed for team: ${tokenData.teamName} (${tokenData.teamId})`);

    // Store token in Redis
    await redis.storeTeamToken(tokenData.teamId, {
      botToken: tokenData.botToken,
      botUserId: tokenData.botUserId,
      teamName: tokenData.teamName,
      scope: tokenData.scope,
      installedAt: new Date().toISOString()
    });

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Installation Successful</title>
          <style>
            body { font-family: system-ui; max-width: 600px; margin: 100px auto; text-align: center; }
            h1 { color: #2eb886; }
          </style>
        </head>
        <body>
          <h1>✅ Installation Successful!</h1>
          <p>Slack Playlift has been installed to <strong>${tokenData.teamName}</strong></p>
          <p>You can now use slash commands in your Slack workspace:</p>
          <ul style="text-align: left; display: inline-block;">
            <li><code>/connect</code> - Connect a channel to Spotify</li>
            <li><code>/add-song Song - Artist</code> - Add a song to the queue</li>
            <li><code>/skip</code> - Vote to skip the current song</li>
          </ul>
          <p style="margin-top: 40px; color: #666;">You can close this window.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(`Installation failed: ${err.message}`);
  }
});

// Helper function to get bot token for a request
async function getBotToken(teamId) {
  const teamData = await redis.getTeamToken(teamId);
  if (!teamData) {
    throw new Error('App not installed in this workspace. Please install at /slack/install');
  }
  return teamData.botToken;
}

// Connect endpoint - starts Spotify OAuth for a channel
app.post('/connect', async (req, res) => {
  // Slack slash command will POST with channel_id, user_id, and team_id
  const { channel_id, team_id } = req.body;
  if (!channel_id) return res.status(400).send('Missing channel_id');
  if (!team_id) return res.status(400).send('Missing team_id');

  try {
    // Verify app is installed
    await getBotToken(team_id);

    // Store team mapping for this channel
    await redis.setChannelTeam(channel_id, team_id);

    // Create channel entry in Redis if needed
    let channel = await redis.getChannel(channel_id);
    if (!channel) {
      await redis.setChannel(channel_id, { slackChannelId: channel_id, queue: [] });
    }

    // Generate Spotify auth URL
    const authUrl = spotify.generateAuthUrl(channel_id);

    // Respond with a message containing the URL for user to click
    return res.json({ text: `Click to connect Spotify for this channel: ${authUrl}` });
  } catch (err) {
    console.error('Connect error:', err);
    return res.json({
      text: err.message.includes('not installed')
        ? `❌ ${err.message}`
        : 'Failed to start Spotify connection'
    });
  }
});

// Spotify redirect callback to exchange code for token
app.get('/spotify-callback', async (req, res) => {
  const { code, state } = req.query; // state will contain channel id
  if (!state) return res.status(400).send('Missing state');
  const channelId = state;

  try {
    const token = await spotify.exchangeCodeForToken(code);
    await redis.updateChannel(channelId, { spotify: token });
    return res.send('Spotify connected for channel ' + channelId + '. You can close this window.');
  } catch (err) {
    console.error(err);
    return res.status(500).send('Spotify token exchange failed');
  }
});

// Add song endpoint - invoked by Slack slash command /add-song
app.post('/add-song', async (req, res) => {
  const { channel_id, text, user_name, user_id, team_id } = req.body;
  if (!channel_id) return res.status(400).send('Missing channel_id');
  if (!text) return res.status(400).send('Need song text like "Song - Artist"');
  if (!team_id) return res.status(400).send('Missing team_id');

  try {
    // Get bot token for this team
    const botToken = await getBotToken(team_id);

    const ch = await redis.getChannel(channel_id);
    if (!ch || !ch.spotify) {
      return res.json({ text: 'Channel is not connected to Spotify. Use /connect first.' });
    }

    const parsed = spotify.parseSongText(text);
    if (!parsed) return res.json({ text: 'Could not parse song. Use format: Song - Artist' });

    // Search for the track on Spotify
    console.log(`Searching Spotify for: ${parsed.title} - ${parsed.artist}`);
    const track = await spotify.searchTrack(parsed.title, parsed.artist, ch.spotify.accessToken);

    if (!track) {
      return res.json({ text: `Could not find "${parsed.title}" by ${parsed.artist} on Spotify. Try different search terms.` });
    }

    // Add to Spotify queue
    console.log(`Adding track to Spotify queue: ${track.uri}`);
    await spotify.addToQueue(track.uri, ch.spotify.accessToken);

    // Post public message to channel (with bot token)
    const userName = user_name || user_id;
    await slack.postMessage(
      ch.slackChannelId,
      `✅ ${userName} added "${track.name}" by ${track.artists.map(a => a.name).join(', ')} to the queue!`,
      botToken
    );

    // Send ephemeral confirmation back to slash command
    res.json({ text: 'Song added!' });
  } catch (err) {
    console.error('Failed to add song:', err);
    res.json({ text: `Failed to add song: ${err.message}` });
  }
});

// Skip song endpoint - invoked by Slack slash command /skip
app.post('/skip', async (req, res) => {
  const { channel_id, user_name, user_id, team_id } = req.body;
  if (!channel_id) return res.status(400).send('Missing channel_id');
  if (!team_id) return res.status(400).send('Missing team_id');

  try {
    // Get bot token for this team
    const botToken = await getBotToken(team_id);

    const ch = await redis.getChannel(channel_id);
    if (!ch || !ch.spotify) {
      return res.json({ text: 'Channel is not connected to Spotify. Use /connect first.' });
    }

    // Check if QStash is configured
    console.log('Skip endpoint - QStash check:', {
      qstashExists: !!qstash,
      tokenExists: !!process.env.QSTASH_TOKEN,
      tokenLength: process.env.QSTASH_TOKEN?.length || 0,
      baseUrl: process.env.BASE_URL || 'not set',
      vercelUrl: process.env.VERCEL_URL || 'not set'
    });

    if (!qstash) {
      return res.json({ text: 'QStash is not configured. Please set QSTASH_TOKEN environment variable.' });
    }

    // Get currently playing track
    const currentTrack = await spotify.getCurrentlyPlayingTrack(ch.spotify.accessToken);

    if (!currentTrack || !currentTrack.trackName) {
      return res.json({ text: 'No song is currently playing.' });
    }

    // Create a skip vote entry
    const skipId = Date.now().toString();
    const skipVote = {
      id: skipId,
      trackName: currentTrack.trackName,
      artistName: currentTrack.artistName,
      requestedBy: user_name || user_id,
      messageTs: null,
      resolved: false
    };

    // Post skip vote message to Slack (with bot token)
    const message = await slack.postSkipVoteMessage(
      ch.slackChannelId,
      skipVote.trackName,
      skipVote.artistName,
      skipVote.requestedBy,
      botToken
    );

    skipVote.messageTs = message.ts;

    // Store in Redis with empty vote sets
    await redis.setSkipVote(channel_id, skipId, {
      ...skipVote,
      thumbsUpUsers: new Set(),
      thumbsDownUsers: new Set()
    });

    console.log(`Skip vote initiated for "${skipVote.trackName}" by ${skipVote.requestedBy}. Scheduled to process in 10 seconds.`);

    // Schedule QStash job to process skip vote in 10 seconds
    const baseUrl = process.env.BASE_URL ||
                    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
                    'http://localhost:3000';

    await qstash.publishJSON({
      url: `${baseUrl}/process-skip`,
      body: { channelId: channel_id, skipId, teamId: team_id },
      delay: 10 // seconds
    });

    // Respond immediately to Slack
    res.json({ text: `Skip vote started for "${skipVote.trackName}"! React with 👍 or 👎. Voting closes in 10 seconds.` });

  } catch (err) {
    console.error('Failed to initiate skip:', err);
    res.json({ text: `Failed to skip: ${err.message}` });
  }
});

// Process skip vote - called by QStash after delay
app.post('/process-skip', async (req, res) => {
  console.log(`Processing skip vote request received`);

  // Verify QStash signature if receiver is configured
  if (receiver) {
    const signature = req.headers['upstash-signature'];

    if (!signature) {
      console.error('Missing upstash-signature header');
      return res.status(401).send('Unauthorized: Missing signature');
    }

    try {
      // Verify the request came from QStash
      await receiver.verify({
        signature,
        body: JSON.stringify(req.body)
      });
      console.log('QStash signature verified successfully');
    } catch (err) {
      console.error('Invalid QStash signature:', err.message);
      return res.status(401).send('Unauthorized: Invalid signature');
    }
  } else {
    console.warn('QStash signature verification skipped - signing keys not configured');
  }

  const { channelId, skipId, teamId } = req.body;

  console.log(`Processing skip vote: channelId=${channelId}, skipId=${skipId}, teamId=${teamId}`);

  try {
    // Get bot token for this team
    const botToken = await getBotToken(teamId);

    const ch = await redis.getChannel(channelId);
    if (!ch) {
      console.log('Channel not found');
      return res.sendStatus(200);
    }

    const skipVote = await redis.getSkipVote(channelId, skipId);
    if (!skipVote) {
      console.log('Skip vote not found');
      return res.sendStatus(200);
    }

    // Check if already resolved (shouldn't happen, but safety check)
    if (skipVote.resolved) {
      console.log('Skip vote already resolved');
      return res.sendStatus(200);
    }

    const thumbsUpCount = skipVote.thumbsUpUsers.size;
    const thumbsDownCount = skipVote.thumbsDownUsers.size;

    console.log(`Skip vote completed. Final count: 👍 ${thumbsUpCount} (${Array.from(skipVote.thumbsUpUsers).join(', ')}) 👎 ${thumbsDownCount} (${Array.from(skipVote.thumbsDownUsers).join(', ')})`);

    // Decide result
    let resultMessage;
    if (thumbsUpCount >= thumbsDownCount) {
      resultMessage = `🎵 The song was saved! "${skipVote.trackName}" will keep playing. (👍 ${thumbsUpCount} vs 👎 ${thumbsDownCount})`;
    } else {
      // Skip the song
      await spotify.skipTrack(ch.spotify.accessToken);
      resultMessage = `⏭️ Song skipped: "${skipVote.trackName}" by ${skipVote.artistName} (👍 ${thumbsUpCount} vs 👎 ${thumbsDownCount})`;
    }

    // Post result to Slack (with bot token)
    await slack.postMessage(ch.slackChannelId, resultMessage, botToken);

    // Clean up skip vote from Redis
    await redis.deleteSkipVote(channelId, skipId);

    res.sendStatus(200);
  } catch (err) {
    console.error('Failed to process skip vote:', err);
    res.sendStatus(500);
  }
});

// Emoji callback from Slack Events API
app.post('/emoji-callback', async (req, res) => {
  const payload = req.body;

  // Slack URL verification challenge - respond with challenge value
  if (payload.type === 'url_verification') {
    console.log('Slack URL verification challenge received');
    return res.send(payload.challenge);
  }

  // We're expecting event callbacks for reaction_added and reaction_removed
  if (payload.type === 'event_callback') {
    const ev = payload.event;

    // Only process reaction events
    if (ev.type !== 'reaction_added' && ev.type !== 'reaction_removed') {
      return res.sendStatus(200);
    }

    // Only care about reactions to messages (not files, etc.)
    if (!ev.item || ev.item.type !== 'message') {
      return res.sendStatus(200);
    }

    const channelId = ev.item.channel;
    const messageTs = ev.item.ts;

    // Find the skip vote that matches this message ts (ID)
    const skipVote = await redis.findSkipVoteByMessageTs(channelId, messageTs);

    // Ignore reactions on messages that aren't tracked skip votes
    if (!skipVote) {
      console.log(`Ignoring reaction: message ${messageTs} is not a tracked skip vote`);
      return res.sendStatus(200);
    }

    // Ignore if voting has been resolved (10 seconds passed)
    if (skipVote.resolved) {
      console.log(`Ignoring reaction: skip vote already resolved`);
      return res.sendStatus(200);
    }

    console.log(`Processing ${ev.type} reaction "${ev.reaction}" on skip vote for: ${skipVote.trackName}`);

    const userId = ev.user; // User who reacted
    const skipId = skipVote.id;

    // Update vote sets based on reaction type
    if (ev.type === 'reaction_added') {
      if (ev.reaction === '+1' || ev.reaction === 'thumbsup' || ev.reaction === 'thumbs_up') {
        await redis.addThumbsUp(skipId, userId);
      }
      if (ev.reaction === '-1' || ev.reaction === 'thumbsdown' || ev.reaction === 'thumbs_down') {
        await redis.addThumbsDown(skipId, userId);
      }
    }

    if (ev.type === 'reaction_removed') {
      if (ev.reaction === '+1' || ev.reaction === 'thumbsup' || ev.reaction === 'thumbs_up') {
        await redis.removeThumbsUp(skipId, userId);
      }
      if (ev.reaction === '-1' || ev.reaction === 'thumbsdown' || ev.reaction === 'thumbs_down') {
        await redis.removeThumbsDown(skipId, userId);
      }
    }

    // Fetch updated counts for logging
    const updatedVote = await redis.getSkipVote(channelId, skipId);
    console.log(`Skip vote count: 👍 ${updatedVote.thumbsUpUsers.size} unique users, 👎 ${updatedVote.thumbsDownUsers.size} unique users`);

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// Expose a route to inspect Redis data (for dev/debug)
app.get('/_store', async (req, res) => {
  try {
    const channels = await redis.getAllChannels();
    res.json({ channels });
  } catch (err) {
    console.error('Failed to fetch store data:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;


