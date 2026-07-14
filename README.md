# PG Installation Report — Mobile Form System

A multi-step installation documentation system I built for [Platform Golf](https://platformgolf.com) that lets field installers submit photos, equipment data, and build notes from their phones at job sites — routing everything to Google Drive and a Slack review workflow automatically.

> This is a sanitized copy of the production system, published to show the approach and code. The Slack bot token, Google Drive folder ID, and GAS deployment URL have been replaced with placeholders.

## The Problem

Platform Golf sends installation teams to customer sites to build and configure golf simulator platforms. After each job, the team needed to document:

- Control box serial numbers and actuator wiring
- Photos at every stage of the build (frame, calibration, finished platform)
- PC hardware, projector setup, and room conditions
- Any issues encountered and how they were resolved

The original process was ad-hoc — photos texted to a group chat, notes in email threads. There was no reliable way to file everything to the right customer folder in Drive, and older installs had no documentation at all.

## The Solution

Three files handle the entire system:

- **`installation-report.html`** — the main 11-step form used for all current installs
- **`platform-golf-legacy-install.html`** — a simplified one-page form for retroactively logging older installs, with support for photo and video uploads
- **`platform-golf-install.gs`** — a Google Apps Script web app that receives submissions, uploads files to Drive, matches the customer folder, and posts an interactive Slack notification for review

## Architecture

```
Installer's phone
      │
      │  POST (base64 photos + form data)
      ▼
Google Apps Script (Web App)
      │
      ├─► Creates ⏳ pending folder in Google Drive
      ├─► Uploads compressed photos (JPEG) and videos with correct MIME type
      ├─► Writes a summary .txt document
      ├─► Fuzzy-matches existing customer folders by name/city/state
      │
      └─► Posts to Slack (#your-slack-channel)
                │
                ├─ ✅ Approve & File  → moves folder into matched customer directory
                ├─ ✏️  Reassign       → opens modal to search and select correct folder
                └─ 🚩 Flag            → renames pending folder, notifies channel
```

**Error reporting** — any GAS exception or client-side JS failure posts a DM to the configured error recipient with the error type, customer name, and stack trace (GAS errors).

## Key Features

- **11-step mobile-first form** with progress tracking, per-step validation, and local storage auto-save so partial submissions survive a browser close
- **Platform type branching** — selecting "No Platform" or a platform type that doesn't require a full build skips the platform-specific steps (actuator wiring, frame, calibration, finished platform) automatically
- **Client-side photo compression** — images resized to 1600px max and re-encoded as JPEG at 0.82 quality before upload, keeping payload sizes manageable over cellular
- **Video support (legacy form)** — videos sent with original MIME type preserved; GAS saves them with the correct extension (`.mp4`, `.mov`, etc.) rather than `.jpg`
- **Fire-and-forget submission (legacy form)** — shows the success screen immediately after the request starts rather than awaiting the response, avoiding timeouts on large video payloads over slow connections
- **Fuzzy folder matching** — scores each existing Drive customer folder by name word overlap plus city/state bonus; labels the suggestion ✅ Strong match / ⚠️ Possible match / ❓ Low confidence
- **Slack interactive review workflow** — Approve, Reassign (with searchable folder picker), and Flag buttons directly on the Slack notification; filing runs in a background GAS trigger to avoid Slack's 3-second response deadline
- **Error reporting** — client-side errors (JS crashes, failed fetches) POST a report back to GAS, which DMs the error details to the configured recipient

## Tech Stack

Vanilla HTML / CSS / JS · Google Apps Script · Google Drive API · Slack Block Kit API · Canvas API (client-side image compression)

## Setup

### Google Apps Script

1. Open [script.google.com](https://script.google.com) and create a new project
2. Paste `platform-golf-install.gs` into the editor
3. Update `CONFIG` at the top of the file:
   - `DRIVE_PARENT_FOLDER_ID` — the Google Drive folder that holds all customer project folders
   - `SLACK_BOT_TOKEN` — a Slack bot token with scopes: `chat:write`, `im:write`, `users:read.email`, `views.open`, `channels:read`
   - `SLACK_CHANNEL` — the channel to post installation notifications to (e.g. `#your-slack-channel`)
   - `SLACK_ERROR_EMAIL` — email address to DM on errors
4. Deploy as a **Web App** (Execute as: Me, Access: Anyone)
5. Copy the deployment URL

### HTML Forms

In `installation-report.html`, update `CONFIG.WEBHOOK_URL` to your GAS deployment URL.

In `platform-golf-legacy-install.html`, update `GAS_URL` to the same deployment URL.

Both files are self-contained — no build step, no dependencies. Upload directly to any static host or CMS (e.g. HubSpot Design Manager).

### Slack App

Your Slack app needs:
- **Interactivity & Shortcuts** URL pointing to your GAS deployment URL
- **Slash Commands** (optional — handled by a separate script not included here)
- **OAuth Scopes**: `chat:write`, `im:write`, `users:read.email`, `views.open`, `channels:read`, `files:read`

## Notes

- The real Slack bot token, Drive folder ID, and GAS deployment URL have been replaced with placeholders — swap in your own values in `CONFIG` before deploying.
- Photo compression happens entirely on the client before upload. No server-side image processing is needed.
- The GAS `doPost` handler distinguishes between the main form (`formType` absent), legacy form (`formType: 'misc'`), and error reports (`formType: 'error'`) by inspecting the posted JSON.
