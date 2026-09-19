# Roku App

SceneGraph channel that loads a JSON content feed and plays streams.

## Feed URL (synced from web)

**Default feed** (when not linked / no override):

```
https://f004.backblazeb2.com/file/roku-hockey/secretfeedfilename.json
```

### Link to web account (recommended)

1. Run the `backend` API so the Roku can reach it on your LAN (e.g. `http://192.168.x.x:3001`).
2. Sideload this channel. From the grid, press **Options** (`*`).
3. **Set API Base URL** to that backend origin (no trailing path).
4. Choose **Link Web Account** — a 6-digit code appears.
5. Sign in at the `frontend` settings page and enter the code under **Link a Roku**.
6. The TV stores a device token and syncs `effectiveFeedUrl` from `GET /device/settings` on every feed load.

Changing the feed URL on the web updates the TV on the next launch/reload (or **Sync Feed Now**).

### Local override (optional)

Without an account link, you can still set a local registry override for sideload testing. Linked accounts prefer the synced web URL over the local override.

Helpers: `source/feedConfig.brs`. Pairing task: `components/tasks/DevicePairTask.*`.
