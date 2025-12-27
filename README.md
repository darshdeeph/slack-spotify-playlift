# Slack Playlift

A Slack + Spotify integration that lets teams collaboratively control music playback. Connect Slack channels to Spotify, add songs via slash commands, and vote to skip tracks with emoji reactions.

## Technologies

- **Node.js** + **Express** - API server
- **Slack API** - OAuth v2 for multi-workspace support, slash commands, and event subscriptions
- **Spotify Web API** - Search tracks, manage playback queue
- **Redis** (Upstash) - Persistent storage for channel data, tokens, and votes
- **QStash** (Upstash) - Delayed job processing for skip voting
- **Vercel** - Serverless deployment

## Endpoints

- **GET /** - Health check endpoint
- **GET /slack/install** - Redirects to Slack OAuth installation URL
- **GET /slack/oauth/callback** - Handles Slack OAuth callback, stores team tokens
- **GET /spotify-callback** - Handles Spotify OAuth callback, stores access tokens
- **POST /connect** - Slack slash command to initiate Spotify OAuth for a channel
- **POST /add-song** - Slack slash command to add a song to queue (format: "Song - Artist")
- **POST /skip** - Slack slash command to initiate skip voting for current track
- **POST /process-skip** - QStash callback to process skip votes after 10-second delay
- **POST /emoji-callback** - Receives Slack reaction events (👍/👎) for skip voting

## Install in Slack

Install this app to your Slack workspace using this URL:

```
https://slack.com/oauth/v2/authorize?client_id=9916406757152.9908273479763&scope=channels:history,channels:read,chat:write,commands,reactions:read,groups:read&user_scope=
```

After installation, use these commands in any channel:
- `/connect` - Connect the channel to Spotify
- `/add-song Song Name - Artist` - Add a song to the queue
- `/skip` - Vote to skip the current song

## Self-Hosting

### 1. Set up Redis (Upstash)

1. Go to https://console.upstash.com/
2. Create a new Redis database
3. Copy the Redis URL (format: `redis://default:xxx@xxx.upstash.io:6379`)

### 2. Set up QStash (Upstash)

1. In the same Upstash console, go to QStash
2. Copy your QStash token and signing keys

### 3. Create Spotify App

1. Go to https://developer.spotify.com/dashboard
2. Create an app and get Client ID and Secret
3. Add redirect URI: `https://your-domain.com/spotify-callback`

### 4. Deploy to Vercel

```bash
npm install
vercel --prod
```

### 5. Configure Environment Variables

In Vercel dashboard (Settings → Environment Variables), add:

```
SLACK_CLIENT_ID=your_slack_client_id
SLACK_CLIENT_SECRET=your_slack_client_secret
SLACK_REDIRECT_URI=https://your-domain.com/slack/oauth/callback
SLACK_SIGNING_SECRET=your_slack_signing_secret
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
SPOTIFY_REDIRECT_URI=https://your-domain.com/spotify-callback
REDIS_URL=redis://default:xxx@xxx.upstash.io:6379
QSTASH_TOKEN=your_qstash_token
QSTASH_CURRENT_SIGNING_KEY=your_current_key
QSTASH_NEXT_SIGNING_KEY=your_next_key
BASE_URL=https://your-domain.com
```

### 6. Configure Slack App

1. Go to https://api.slack.com/apps and create a new app
2. **OAuth & Permissions**: Add redirect URL `https://your-domain.com/slack/oauth/callback`
3. **Bot Token Scopes**: Add `channels:history`, `channels:read`, `chat:write`, `commands`, `reactions:read`, `groups:read`
4. **Slash Commands**: Create `/connect`, `/add-song`, `/skip` pointing to your domain
5. **Event Subscriptions**: Enable and set URL to `https://your-domain.com/emoji-callback`, subscribe to `reaction_added` and `reaction_removed`

## Publishing to Slack App Directory

If you want to publish your own version instead of using the public installation:

1. Complete all setup steps above with your own Slack app
2. In Slack app settings, go to **Manage Distribution**
3. Complete the App Directory checklist (add descriptions, icons, privacy policy, etc.)
4. Click **Activate Public Distribution**
5. Submit for review or share your custom install link

Your install URL will be: `https://slack.com/oauth/v2/authorize?client_id=YOUR_CLIENT_ID&scope=channels:history,channels:read,chat:write,commands,reactions:read,groups:read&user_scope=`

