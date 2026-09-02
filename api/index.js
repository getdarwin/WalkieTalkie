// Vercel serverless entry point.
// vercel.json rewrites every path to this function; the Express app (mounted
// on Bolt's ExpressReceiver) routes internally using the original URL.
require('dotenv').config();

const { app } = require('../src/app');

module.exports = app;
