# Roku App

SceneGraph channel that loads a JSON content feed and plays streams.

## Feed URL (synced from web)

**Default feed** (when not linked / no override):

```
https://f004.backblazeb2.com/file/roku-hockey/secretfeedfilename.json
```

### Backend API URL (package config)

Set in **`config/channel.json`** before packaging/sideloading (not editable on the device):

```json
{
  "apiBaseUrl": "https://api.welikesports.app",
  "defaultFeedUrl": "https://f004.backblazeb2.com/file/roku-hockey/secretfeedfilename.json",
  "feedSources": [
    { "id": "live", "label": "Live Sports & TV" },
    { "id": "plex", "label": "Plex", "url": "https://your-server/plex-feed.json" }
  ]
}
```

`GetApiBaseUrl()` / `GetDefaultFeedUrl()` / `GetFeedSources()` read that file from `pkg:/config/channel.json`.

### Resilient loading

- Each `feedSources` entry is fetched **independently** with a timeout. If Plex (or any source) hangs or fails, Live Sports / Live TV still appear.
- Sources without a `url` use the account-synced / override / `defaultFeedUrl` chain (`GetFeedUrl()`).
- Last successful libraries are cached on device and shown **immediately** on launch while a refresh runs in the background.
- Account sync is best-effort (short timeout) and never blocks the grid.

### Link to web account

1. Ensure the baked-in API is reachable from the Roku.
2. Sideload this channel. From the grid, press **Options** (`*`).
3. Choose **Link Web Account** — a 6-digit code appears.
4. Sign in at the `frontend` settings page and enter the code under **Link a Roku**.
5. The TV stores a device token and syncs `effectiveFeedUrl` from `GET /device/settings` on every feed load.

Changing the feed URL on the web updates the TV on the next launch/reload (or **Sync Feed Now**).

### Local override (optional)

Without an account link, you can still set a local registry override for sideload testing. Linked accounts prefer the synced web URL over the local override.

Helpers: `source/feedConfig.brs`. Pairing task: `components/tasks/DevicePairTask.*`.

Full system guide: [docs/CONFIGURABLE_FEEDS.md](../docs/CONFIGURABLE_FEEDS.md).
