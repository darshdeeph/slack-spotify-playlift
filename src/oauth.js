const axios = require('axios');

/**
 * Slack OAuth v2 implementation
 * https://api.slack.com/authentication/oauth-v2
 */

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI;

// Debug logging
console.log('=== Slack OAuth Configuration ===');
console.log('Client ID set:', !!SLACK_CLIENT_ID);
console.log('Client Secret set:', !!SLACK_CLIENT_SECRET);
console.log('Redirect URI:', SLACK_REDIRECT_URI || 'NOT SET');
console.log('==================================');

/**
 * Exchange OAuth code for access token
 */
async function exchangeCodeForToken(code) {
  console.log('Exchanging OAuth code for token...');
  console.log('Using redirect_uri:', SLACK_REDIRECT_URI);

  try {
    const params = {
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code: code,
      redirect_uri: SLACK_REDIRECT_URI
    };

    console.log('OAuth params:', {
      client_id: SLACK_CLIENT_ID,
      code: code.substring(0, 20) + '...',
      redirect_uri: SLACK_REDIRECT_URI
    });

    const response = await axios.post(
      'https://slack.com/api/oauth.v2.access',
      new URLSearchParams(params),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    if (!response.data.ok) {
      console.error('Slack OAuth error response:', response.data);
      throw new Error(`Slack OAuth error: ${response.data.error}`);
    }

    return {
      teamId: response.data.team.id,
      teamName: response.data.team.name,
      botToken: response.data.access_token,
      botUserId: response.data.bot_user_id,
      scope: response.data.scope,
      appId: response.data.app_id,
      enterpriseId: response.data.enterprise?.id || null
    };
  } catch (error) {
    console.error('OAuth token exchange failed:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Generate OAuth installation URL
 */
function getInstallUrl(state = '') {
  const scopes = [
    'channels:history',
    'channels:read',
    'chat:write',
    'commands',
    'reactions:read',
    'groups:read',
    'groups:history',
    'im:history',
    'mpim:history'
  ].join(',');

  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    scope: scopes,
    redirect_uri: SLACK_REDIRECT_URI
  });

  if (state) {
    params.append('state', state);
  }

  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

module.exports = {
  exchangeCodeForToken,
  getInstallUrl
};

