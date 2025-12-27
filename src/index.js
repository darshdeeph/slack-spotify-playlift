const app = require('./app');

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Server listening on ${port}`));
}

module.exports = app;
