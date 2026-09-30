module.exports = {
  apps: [
    {
      name: 'printform-backend',
      cwd: '/var/www/printform/backend',
      script: './dist/main.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      env: { NODE_ENV: 'production' }
    }
  ]
};
