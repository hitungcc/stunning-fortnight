# Stunning Fortnight - Steam Idler Service

A headless Node.js service for idling Steam games 24/7 to accumulate playtime and collect trading card drops. Designed to run on low-power devices like old phones (Termux) or SBCs (Armbian) inside a **tmux** session you can attach to over SSH.

## Features

- **24/7 unattended idling** - set it and forget it
- **Four idle modes** - all-at-once, continuous, pinned+rotating hybrid, or full round-robin
- **Full 2FA support** - auto-generates codes from `shared_secret`, or type the code once into the tmux pane
- **tmux-based** - a real terminal you can detach from and re-attach to over SSH, no daemon manager needed
- **Termux-friendly** - runs on old Android phones + Termux
- **Multi-game idling** - up to 32 games in the pool
- **Game Name Resolution** - resolves App IDs to game names via the Steam Store API
- **Device Customization** - custom machine/device name shown in Steam's authorized devices list
- **Auto-reconnect** - survives network drops and Steam maintenance
- **Stealth mode** - idle while appearing offline
- **Heartbeat logging** - periodic status updates with per-game idle totals

## Prerequisites

- **Node.js** ≥ 18.x
- **npm**
- **tmux**

### For Termux (Android):

```bash
pkg update && pkg upgrade
pkg install nodejs-lts tmux openssh
```

### For Armbian / Linux SBC:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs tmux
```

## Quick Start

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

If your Steam account has Steam Guard enabled and you are **NOT** using `STEAM_SHARED_SECRET`, authenticate interactively once so the session token is cached in `sentry/`:

```bash
npm run bootstrap
```

Enter your Steam Guard code when prompted. After this the idler logs in without asking again, as long as `sentry/` is preserved.

### 4. Run in the Foreground (Test)

```bash
npm start
```

### 5. Run in tmux (24/7)

```bash
npm run tmux:start     # starts a detached session named "steam-idler"
npm run tmux:attach    # attach to watch logs / type a 2FA code
# Ctrl+B then D        # detach, leaving it running
npm run tmux:stop      # stop the idler
```

Because it's a real terminal, if Steam ever asks for a Guard code you just attach to the session and type it in - no restart loop, no lost prompt.

## Idle Modes

Idling every game simultaneously gives them **all exactly the same playtime**, which is an obvious tell. The four modes differ only in how `STEAM_GAME_IDS` is split between games that are **always on** and games that **take turns**:

| `IDLE_MODE` | Always on | Takes turns | Never played | Use it when |
|---|---|---|---|---|
| `all` | everything | - | - | You want the old behaviour: one big batch, no rotation |
| `continuous` | `IDLE_PINNED` | - | everything else | You're farming one or two specific games |
| `hybrid` | `IDLE_PINNED` | everything else | - | One priority title always accruing, the rest sharing |
| `rotate` *(default)* | - | everything | - | Full round-robin: spread time evenly across the library |

```env
IDLE_MODE=rotate
IDLE_BATCH_SIZE=1              # games idling at once, TOTAL (pinned included)
IDLE_PINNED=                   # always-on App IDs (continuous / hybrid)
IDLE_INTERVAL=30               # minutes per rotation slot
IDLE_JITTER=15                 # ±15% random variation in slot length
IDLE_STATE_FILE=./data/idle-state.json
```

### What each mode does

**`all`** - every game in the list idles at once, forever. Steam's ~32-game cap applies.

```
730 + 440 + 570 + 220 + 620   ← for as long as the idler runs
```

**`continuous`** - `IDLE_PINNED` idles forever; the rest of the list is parked and never played. If `IDLE_PINNED` is empty, the first `IDLE_BATCH_SIZE` games are pinned and the idler logs which ones it picked.

```env
IDLE_MODE=continuous
IDLE_PINNED=730
```
```
730                            ← never switches
440, 570, 220, 620: parked, 0h
```

**`hybrid`** - `IDLE_PINNED` idles forever, and the remaining games rotate through whatever slots are left (`IDLE_BATCH_SIZE` minus the pinned count).

```env
IDLE_MODE=hybrid
IDLE_PINNED=730
IDLE_BATCH_SIZE=2              # 1 pinned + 1 rotating
```
```
00:00  730 + 570
00:30  730 + 220
01:00  730 + 620
01:30  730 + 440              ← 730 always on, others share slot #2
```

**`rotate`** - nothing pinned; every game takes turns. Each slot the **least-idled** games are promoted, so totals converge without ever matching.

```env
IDLE_MODE=rotate
IDLE_BATCH_SIZE=1
```
```
00:00  440
00:30  570
01:00  220
01:30  620
02:00  730
```

### How the rotating modes pick

1. Each slot, elapsed time is credited to whichever games were active.
2. The queue then picks the games with the *lowest* accumulated total to fill the free slots.
3. Totals are written to `IDLE_STATE_FILE`, so a restart resumes the queue instead of resetting it.
4. Slot lengths are jittered, so totals drift apart naturally and never land on identical numbers.

Time is only credited while idling actually happens - a disconnect or "playing elsewhere" block pauses the clock, and the interrupted game resumes its slot rather than losing its turn.

Every heartbeat prints the running totals, tagged by role:

```
💓 Mode hybrid: 1 pinned + 1 of 4 rotating (2 idling at once) | Uptime: 6h 12m 4s | Memory: 71MB
💓 Active: Counter-Strike 2 (730), Team Fortress 2 (440)
💓   · Counter-Strike 2 - 6h 11m idled [pinned]
💓   · Team Fortress 2 - 1h 34m idled [rotating]
💓   · Dota 2 - 1h 33m idled [rotating]
💓   · Half-Life 2 - 1h 31m idled [rotating]
```

> **Notes**
> - Keep `IDLE_INTERVAL` at 30 or above - Steam credits playtime in roughly 30-minute chunks, so shorter slots risk games not being credited at all.
> - If a mode's settings leave nothing to rotate, the idler says so and falls back to one that works (e.g. `hybrid` with no free slot becomes `continuous`; `rotate` with `IDLE_BATCH_SIZE` ≥ your game count becomes `all`).
> - An unknown `IDLE_MODE` is a hard error listing the valid modes, rather than a silent default.
> - Explicit `IDLE_PINNED` entries win over `IDLE_BATCH_SIZE` - pinning 3 games with `IDLE_BATCH_SIZE=2` idles all 3.

## Steam Guard / 2FA Setup

### The Problem
If your Steam account has 2FA enabled (which it should!), the idler needs a way to generate authentication codes automatically. Without this, it will prompt you for a code every time it connects.

### The Solution: `shared_secret`

The `shared_secret` is the key used by the Steam Mobile Authenticator to generate TOTP codes. If you provide it, the idler generates codes automatically.

#### How to Get Your `shared_secret`

**Option A: Steam Desktop Authenticator (SDA)**
1. Download [Steam Desktop Authenticator](https://github.com/Jessecar96/SteamDesktopAuthenticator)
2. Import/set up your authenticator
3. Open `maFiles/<your_steam_id>.maFile`
4. Find the `"shared_secret"` field - copy the value

**Option B: From a rooted Android device**
1. Navigate to: `/data/data/com.valvesoftware.android.steam.community/files/`
2. Open `Steamguard-<steamid>` file
3. Extract the `shared_secret` value

**Option C: Use a third-party tool**
- Various tools exist to export the shared secret from your phone
- **Be careful** - only use trusted, open-source tools

Once you have it, add to your `.env`:

```env
STEAM_SHARED_SECRET=YourBase64SharedSecretHere
```

### Without `shared_secret` (Manual 2FA)

1. Run the interactive bootstrap once:
   ```bash
   npm run bootstrap
   ```
2. Enter your Steam Guard code manually when prompted.
3. This saves your session token to the `sentry/` directory.
4. As long as `sentry/` is preserved, the idler logs in without asking again.

If Steam does ask for a code later, attach to the tmux session (`npm run tmux:attach`) and type it into the pane.

> For truly unattended 24/7 operation, `STEAM_SHARED_SECRET` is still the most reliable option.

## Project Structure

```
stunning-fortnight/
├── src/
│   ├── idler.js          # Main service - login, idle, reconnect
│   ├── scheduler.js      # Idle modes, rotation queue & playtime accounting
│   ├── config.js         # Config loader & validation
│   └── logger.js         # Colored timestamped logger
├── scripts/
│   ├── bootstrap.js      # One-time interactive login script
│   └── tmux-start.sh     # Launch the idler in a detached tmux session
├── sentry/               # Steam session cache (auto-generated, git-ignored)
├── data/                 # Idle state / playtime totals (auto-generated, git-ignored)
├── .env.example          # Config template
├── .env                  # Your local config (git-ignored)
├── package.json          # Project metadata & npm scripts
└── README.md             # Documentation
```

## tmux Cheat Sheet

```bash
npm run tmux:start                 # start detached session "steam-idler"
npm run tmux:attach                # attach to it
npm run tmux:stop                  # kill it

tmux ls                            # list sessions
tmux attach -t steam-idler         # attach (same as npm run tmux:attach)
tmux kill-session -t steam-idler   # stop (same as npm run tmux:stop)
```

Inside a session (prefix is `Ctrl+B`):

| Keys | Action |
|------|--------|
| `Ctrl+B` `D` | Detach - the idler keeps running |
| `Ctrl+B` `[` | Scroll back through logs (`q` to exit) |
| `Ctrl+B` `C` | New window |
| `Ctrl+C` | Stop the idler (graceful shutdown, saves idle state) |

Use `TMUX_SESSION=other-name npm run tmux:start` if you want to run more than one account.

### Over SSH

Attaching from another machine means you never have to touch the phone:

```bash
ssh -p 8022 u0_aXXX@<device-ip>   # Termux default SSH port is 8022
tmux attach -t steam-idler
```

Detaching with `Ctrl+B` `D` (or just dropping the SSH connection) leaves the idler running.

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `STEAM_USERNAME` | *(required)* | Your Steam username |
| `STEAM_PASSWORD` | *(required)* | Your Steam password |
| `STEAM_SHARED_SECRET` | *(empty)* | Mobile Authenticator shared secret for auto-2FA |
| `STEAM_IDENTITY_SECRET` | *(empty)* | Identity secret (for trade confirmations, optional) |
| `STEAM_GAME_IDS` | *(required)* | Comma-separated App IDs to idle |
| `STEAM_MACHINE_NAME` | `stunning-fortnight` | Custom device name visible in Steam authorized login history |
| `STEAM_PERSONA_STATE` | `0` | Online status: 0=Offline, 1=Online, 2=Busy, 3=Away |
| `IDLE_MODE` | `rotate` | `all`, `continuous`, `hybrid`, or `rotate` - see [Idle Modes](#-idle-modes) |
| `IDLE_BATCH_SIZE` | `1` | How many games idle at once, total (pinned included) |
| `IDLE_PINNED` | *(empty)* | Always-on App IDs for `continuous` / `hybrid` |
| `IDLE_INTERVAL` | `30` | Minutes per rotation slot |
| `IDLE_JITTER` | `15` | ±% random variation in slot length (0 = exact) |
| `IDLE_STATE_FILE` | `./data/idle-state.json` | Where per-game idle totals are persisted |
| `HEARTBEAT_INTERVAL` | `30` | Status log interval in minutes |
| `RECONNECT_DELAY` | `30` | Seconds to wait before reconnecting |
| `MAX_RECONNECT_ATTEMPTS` | `0` | Max retries (0 = infinite) |
| `DEBUG` | `false` | Set to `true` for verbose debug logging |

## Termux Tips

1. **Keep Termux awake**: acquire a wakelock so Android doesn't kill it (`tmux-start.sh` does this automatically if available):
   ```bash
   termux-wake-lock
   ```

2. **Disable battery optimization**: Android Settings → Apps → Termux → Battery → Unrestricted

3. **Start on boot**: use the Termux:Boot add-on (F-Droid):
   ```bash
   mkdir -p ~/.termux/boot
   cat > ~/.termux/boot/start-idler.sh <<'EOF'
   #!/data/data/com.termux/files/usr/bin/bash
   termux-wake-lock
   cd ~/stunning-fortnight && sh scripts/tmux-start.sh
   EOF
   chmod +x ~/.termux/boot/start-idler.sh
   ```
   The script reuses an existing session, so a reboot won't start a second idler.

4. **SSH in instead of opening Termux**: run `sshd` in Termux and connect on port 8022, then `tmux attach -t steam-idler`.

## Disclaimer

- Steam idling is generally safe and Valve has not banned accounts for using idlers
- This tool only simulates "playing" - it does not interact with games or game servers
- No VAC ban risk - the tool doesn't touch any game processes
- Use at your own discretion. The authors are not responsible for any actions taken by Valve

## License

MIT - feel free to fork, modify, and use however you like.

## Credits

Inspired by [dragonGR/steam-idler](https://github.com/dragonGR/steam-idler). Built with [steam-user](https://github.com/DoctorMcKay/node-steam-user) and [steam-totp](https://github.com/DoctorMcKay/node-steam-totp) by DoctorMcKay.
