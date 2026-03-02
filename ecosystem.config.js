module.exports = {
  apps: [{
    name: "elmuttahida-api",
    script: "server.js",
    instances: 1, // Safer for your small-scale DB pooling and low traffic
    exec_mode: "fork",
    autorestart: true, // Explicitly enable auto-restart on crash
    wait_ready: true, // Wait for process.send('ready') in your app
    listen_timeout: 3000, // Grace period for readiness
    env: {
      NODE_ENV: "development"
    },
    env_production: {
      NODE_ENV: "production"
    },
    max_memory_restart: "1G", // Bump up slightly for image/CSV handling buffer
    combine_logs: true, // Merge stdout/stderr into one file
    merge_logs: true, // Useful if scaling instances later
    log_file: "./logs/app.log", // Single combined log file
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    watch: false,
    ignore_watch: ["node_modules", "uploads", "logs"]
  }]
};