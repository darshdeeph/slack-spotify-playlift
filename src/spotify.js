const qs = require('qs');
const axios = require('axios');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'fake-client-id';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || 'fake-secret';
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:3000/spotify-callback';

function generateAuthUrl(channelId) {
  // state carries channelId so callback can associate
  const params = qs.stringify({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'user-modify-playback-state user-read-playback-state',
    state: channelId
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

async function exchangeCodeForToken(code) {
  // In a real app, this exchanges code for access token. Here we return mock tokens.
  if (!CLIENT_ID || CLIENT_ID === 'fake-client-id') {
    return { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600 * 1000 };
  }

  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const data = qs.stringify({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  const resp = await axios.post('https://accounts.spotify.com/api/token', data, { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
  return { accessToken: resp.data.access_token, refreshToken: resp.data.refresh_token, expiresAt: Date.now() + resp.data.expires_in * 1000 };
}

function parseSongText(text) {
  // Accept formats like: Song - Artist or "Song" - "Artist" or Song -Artist
  const parts = text.split('-');
  if (parts.length < 2) return null;
  const title = parts[0].trim().replace(/^"|"$/g, '');
  const artist = parts.slice(1).join('-').trim().replace(/^"|"$/g, '');
  if (!title || !artist) return null;
  return { title, artist };
}

async function searchTrack(title, artist, accessToken) {
  // Search for a track on Spotify
  if (!accessToken || accessToken === 'fake-access') {
    console.log(`Mock Spotify search: ${title} - ${artist}`);
    return { uri: 'spotify:track:mock123', name: title, artists: [{ name: artist }] };
  }

  try {
    const query = `track:${title} artist:${artist}`;
    const resp = await axios.get('https://api.spotify.com/v1/search', {
      params: { q: query, type: 'track', limit: 1 },
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (resp.data.tracks.items.length > 0) {
      const track = resp.data.tracks.items[0];
      return { uri: track.uri, name: track.name, artists: track.artists };
    }

    return null;
  } catch (err) {
    console.error('Spotify search error:', err.response?.data || err.message);
    throw new Error('Failed to search Spotify');
  }
}

async function addToQueue(trackUri, accessToken) {
  // Add a track to the user's Spotify queue
  if (!accessToken || accessToken === 'fake-access') {
    console.log(`Mock Spotify add to queue: ${trackUri}`);
    return { success: true };
  }

  try {
    await axios.post('https://api.spotify.com/v1/me/player/queue', null, {
      params: { uri: trackUri },
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    return { success: true };
  } catch (err) {
    console.error('Spotify add to queue error:', err.response?.data || err.message);
    throw new Error('Failed to add to Spotify queue: ' + (err.response?.data?.error?.message || err.message));
  }
}

async function skipTrack(accessToken) {
  // Skip to the next track
  if (!accessToken || accessToken === 'fake-access') {
    console.log('Mock Spotify skip track');
    return { success: true };
  }

  try {
    await axios.post('https://api.spotify.com/v1/me/player/next', null, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    return { success: true };
  } catch (err) {
    console.error('Spotify skip track error:', err.response?.data || err.message);
    // Don't throw - skipping might fail if nothing is playing
    return { success: false, error: err.message };
  }
}

async function getCurrentlyPlayingTrack(accessToken) {
  // Get the currently playing track
  if (!accessToken || accessToken === 'fake-access') {
    console.log('Mock Spotify get currently playing');
    return { trackName: 'Mock Song', artistName: 'Mock Artist', trackId: 'mock123' };
  }

  try {
    const resp = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    // 204 means nothing is playing
    if (resp.status === 204 || !resp.data || !resp.data.item) {
      return null;
    }

    return {
      trackId: resp.data.item.id,
      trackName: resp.data.item.name,
      artistName: resp.data.item.artists.map(a => a.name).join(', '),
      isPlaying: resp.data.is_playing,
      progressMs: resp.data.progress_ms,
      durationMs: resp.data.item.duration_ms
    };
  } catch (err) {
    if (err.response?.status === 204) {
      return null;
    }
    console.error('Spotify get currently playing error:', err.response?.data || err.message);
    throw new Error('Failed to get currently playing track');
  }
}

module.exports = { generateAuthUrl, exchangeCodeForToken, parseSongText, searchTrack, addToQueue, skipTrack, getCurrentlyPlayingTrack };

