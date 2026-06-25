// PM2 Ecosystem Configuration
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 start ecosystem.config.cjs --env production
//
// On Termux:
//   pm2 start ecosystem.config.cjs --env termux

module.exports = {
  apps: [
    {
      name: "steam-idler",
      script: "src/idler.js",
      node_args: "--experimental-vm-modules",

      // ── Restart behavior ───────────────────────────────
      autorestart: true,
      max_restarts: 50,
      min_uptime: "10s",           // consider "started" after 10s
      restart_delay: 5000,          // 5s between restarts
      max_memory_restart: "150M",   // restart if memory exceeds 150MB

      // ── Logging ────────────────────────────────────────
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "./logs/error.log",
      out_file: "./logs/output.log",
      merge_logs: true,
      log_type: "json",

      // ── Watch (disable — we want stable 24/7) ─────────
      watch: false,
      ignore_watch: ["node_modules", "logs", "sentry", ".git"],

      // ── Environment variables ──────────────────────────
      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV: "production",
      },
      env_termux: {
        NODE_ENV: "production",
        // Termux may have lower memory; set conservative limit
        NODE_OPTIONS: "--max-old-space-size=128",
      },

      // ── Graceful shutdown ──────────────────────────────
      kill_timeout: 5000,           // 5s to shutdown gracefully
      listen_timeout: 10000,
      shutdown_with_message: true,
    },
  ],
};
