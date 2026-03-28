'use strict';

/**
 * PM2 process file for running the Kotak dashboard on a VPS.
 * Usage: pm2 start ecosystem.config.js
 * Env: copy .env to the server and load via dotenv (server reads it at startup).
 */
module.exports = {
  apps: [
    {
      name: 'kotak-options-dashboard',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
