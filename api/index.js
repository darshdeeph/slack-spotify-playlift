const app = require('../src/app');

// Export handler for Vercel serverless functions
module.exports = async (req, res) => {
  // Pass the request to Express app
  return app(req, res);
};

