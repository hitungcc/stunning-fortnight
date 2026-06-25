import chalk from "chalk";

/**
 * Simple structured logger with timestamps and color coding.
 * Designed to work well with PM2 log management.
 */

const timestamp = () => {
  const now = new Date();
  return chalk.gray(`[${now.toISOString()}]`);
};

export const log = {
  info: (...args) => console.log(timestamp(), chalk.cyan("ℹ"), ...args),
  success: (...args) => console.log(timestamp(), chalk.green("✔"), ...args),
  warn: (...args) => console.warn(timestamp(), chalk.yellow("⚠"), ...args),
  error: (...args) => console.error(timestamp(), chalk.red("✖"), ...args),
  debug: (...args) => {
    if (process.env.DEBUG === "true") {
      console.log(timestamp(), chalk.magenta("🐛"), ...args);
    }
  },
  steam: (...args) => console.log(timestamp(), chalk.blue("🎮"), ...args),
  heartbeat: (...args) => console.log(timestamp(), chalk.hex("#4a9eff")("💓"), ...args),
};
