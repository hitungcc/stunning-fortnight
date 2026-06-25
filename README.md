# 🎮 Stunning Fortnight — Steam Idler Service

A headless Node.js service for idling Steam games 24/7 to accumulate playtime and collect trading card drops. Designed to run on low-power devices like old phones (Termux) or SBCs (Armbian) via PM2.

## ✨ Features

- **24/7 unattended idling** — set it and forget it
- **Full 2FA support** — auto-generates codes from `shared_secret` (no manual input needed)
- **PM2 integration** — auto-restart, log management, memory limits
- **Termux-friendly** — runs on old Android phones + Termux
- **Multi-game idling** — idle up to 32 games simultaneously
- **Game Name Resolution** — automatically resolves App IDs to game names via Steam Store API
- **Device Customization** — custom machine/device name shown in Steam authorized devices list
- **Auto-reconnect** — survives network drops and Steam maintenance
- **Stealth mode** — idle while appearing offline
- **Heartbeat logging** — periodic status updates confirming uptime and active games

## 📋 Prerequisites

- **Node.js** ≥ 18.x
- **npm** 
- **PM2** (for 24/7 daemon operation)

### For Termux (Android):

```bash
pkg update && pkg upgrade
pkg install nodejs-lts
npm install -g pm2
```

### For Armbian / Linux SBC:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g pm2
```

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/hitungcc/stunning-fortnight.git
cd stunning-fortnight
npm install
```

### 2. Configure

```bash
cp .env.example .env
nano .env  # or use your preferred editor
```

Fill in your credentials:

```env
STEAM_USERNAME=your_username
STEAM_PASSWORD=your_password
STEAM_GAME_IDS=730,440,570
```

### 3. One-Time Setup (Session Bootstrap)

If your Steam account has Steam Guard enabled and you are **NOT** using `STEAM_SHARED_SECRET`, you must authenticate interactively once to save your session token to the `sentry/` cache:

```bash
npm run bootstrap
```

This script will prompt you for your Steam Guard code (via email or authenticator). Once logged in successfully, it saves your credentials securely in the local `sentry/` directory, allowing PM2 to run unattended without prompts.

### 4. Run (Development)

To test the idler in the foreground:

```bash
npm start
```

### 5. Run with PM2 (Production — 24/7)

```bash
# Start via npm script:
npm run pm2:start

# Or directly:
pm2 start ecosystem.config.cjs --env production

# On Termux:
pm2 start ecosystem.config.cjs --env termux

# Save PM2 state so it survives device reboot:
pm2 save
pm2 startup  # follow the instructions printed on the screen
```

## 🔐 Steam Guard / 2FA Setup

### The Problem
If your Steam account has 2FA enabled (which it should!), the idler needs a way to generate authentication codes automatically. Without this, it will prompt you for a code every time it connects — not ideal for 24/7 operation.

### The Solution: `shared_secret`

The `shared_secret` is the key used by the Steam Mobile Authenticator to generate TOTP codes. If you provide it, the idler generates codes automatically.

#### How to Get Your `shared_secret`

**Option A: Steam Desktop Authenticator (SDA)**
1. Download [Steam Desktop Authenticator](https://github.com/Jessecar96/SteamDesktopAuthenticator)
2. Import/set up your authenticator
3. Open `maFiles/<your_steam_id>.maFile`
4. Find the `"shared_secret"` field — copy the value

**Option B: From a rooted Android device**
1. Navigate to: `/data/data/com.valvesoftware.android.steam.community/files/`
2. Open `Steamguard-<steamid>` file
3. Extract the `shared_secret` value

**Option C: Use a third-party tool**
- Various tools exist to export the shared secret from your phone
- **Be careful** — only use trusted, open-source tools

Once you have it, add to your `.env`:

```env
STEAM_SHARED_SECRET=YourBase64SharedSecretHere
```

### Without `shared_secret` (Manual 2FA Setup)

If you do not have or want to extract your `shared_secret`:
1. Use the **Interactive Bootstrap Script**:
   ```bash
   npm run bootstrap
   ```
2. Enter your Steam Guard code manually when prompted.
3. This saves your session token to the `sentry/` directory.
4. As long as the `sentry/` folder is preserved and not deleted, the main idler can login via PM2 automatically without asking for codes.

> ⚠️ For truly unattended 24/7 operation, setting up Mobile Authenticator with `STEAM_SHARED_SECRET` is recommended.

## 📁 Project Structure

```
stunning-fortnight/
├── src/
│   ├── idler.js          # Main service — login, idle, reconnect
│   ├── config.js         # Config loader & validation
│   └── logger.js         # Colored timestamped logger
├── scripts/
│   └── bootstrap.js      # One-time interactive login script
├── sentry/               # Steam session cache (auto-generated, git-ignored)
├── logs/                 # PM2 log files (auto-generated, git-ignored)
├── .env.example          # Config template
├── .env                  # Your local config (git-ignored)
├── ecosystem.config.cjs  # PM2 configuration
├── package.json          # Project metadata & npm scripts
└── README.md             # Documentation
```

## 🔧 PM2 Commands

```bash
pm2 start ecosystem.config.cjs    # Start the service
pm2 stop steam-idler               # Stop
pm2 restart steam-idler             # Restart
pm2 logs steam-idler                # View live logs
pm2 monit                           # Monitor dashboard
pm2 status                          # Check status
pm2 delete steam-idler              # Remove from PM2

# Auto-start on boot
pm2 save
pm2 startup
```

## ⚙️ Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `STEAM_USERNAME` | *(required)* | Your Steam username |
| `STEAM_PASSWORD` | *(required)* | Your Steam password |
| `STEAM_SHARED_SECRET` | *(empty)* | Mobile Authenticator shared secret for auto-2FA |
| `STEAM_IDENTITY_SECRET` | *(empty)* | Identity secret (for trade confirmations, optional) |
| `STEAM_GAME_IDS` | *(required)* | Comma-separated App IDs to idle |
| `STEAM_MACHINE_NAME` | `stunning-fortnight` | Custom device name visible in Steam authorized login history |
| `STEAM_PERSONA_STATE` | `0` | Online status: 0=Offline, 1=Online, 2=Busy, 3=Away |
| `HEARTBEAT_INTERVAL` | `30` | Status log interval in minutes |
| `RECONNECT_DELAY` | `30` | Seconds to wait before reconnecting |
| `MAX_RECONNECT_ATTEMPTS` | `0` | Max retries (0 = infinite) |

## 📱 Termux Tips

1. **Keep Termux awake**: Acquire a wakelock to prevent Android from killing Termux:
   ```bash
   termux-wake-lock
   ```

2. **Disable battery optimization**: Go to Android Settings → Apps → Termux → Battery → Unrestricted

3. **PM2 startup on boot**: Use Termux:Boot add-on:
   ```bash
   # Install Termux:Boot from F-Droid
   mkdir -p ~/.termux/boot
   echo '#!/data/data/com.termux/files/usr/bin/bash
   termux-wake-lock
   pm2 resurrect' > ~/.termux/boot/start-pm2.sh
   chmod +x ~/.termux/boot/start-pm2.sh
   ```

4. **Monitor memory**: Old phones may have limited RAM:
   ```bash
   pm2 monit
   ```

## ⚖️ Disclaimer

- Steam idling is generally safe and Valve has not banned accounts for using idlers
- This tool only simulates "playing" — it does not interact with games or game servers
- No VAC ban risk — the tool doesn't touch any game processes
- Use at your own discretion. The authors are not responsible for any actions taken by Valve

## 📄 License

MIT — feel free to fork, modify, and use however you like.

## 🙏 Credits

Inspired by [dragonGR/steam-idler](https://github.com/dragonGR/steam-idler). Built with [steam-user](https://github.com/DoctorMcKay/node-steam-user) and [steam-totp](https://github.com/DoctorMcKay/node-steam-totp) by DoctorMcKay.
