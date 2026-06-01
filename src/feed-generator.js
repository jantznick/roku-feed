const FALLBACK_THUMBNAIL = "https://via.placeholder.com/1280x720.png?text=Image+Not+Available";
const PROXY_SERVER = process.env.PROXY_SERVER || 'http://192.168.1.50:8787';
const SKIP_PROXY = process.env.SKIP_PROXY === 'true';

/** Stable fingerprint of raw stream URLs (before proxy rewrite) for change detection. */
export function getStreamSignature(game) {
    return (game.streamLinks || [])
        .map((s) => s.url)
        .filter(Boolean)
        .sort()
        .join('|');
}

/**
 * Creates a single content item for the Roku feed.
 * @param {any} game - The game object.
 * @param {string} imageUrl - The public URL for the game's poster image.
 * @returns {object} A Roku feed item object.
 */
export function createFeedItem(game, imageUrl) {
    const videos = game.streamLinks.map(stream => {
        let streamUrl = stream.url;
        
        // Streamed.pk embeds usually need a Referer; optional LAN proxy rewrites the URL.
        if (!SKIP_PROXY && stream.headers?.Referer) {
            const b64StreamUrl = Buffer.from(stream.url).toString('base64');
            streamUrl = `${PROXY_SERVER}/proxy/${b64StreamUrl}`;
            console.log(`-- Proxy rewrite: ${stream.url} -> ${streamUrl}`);
        }
        
        // Create a more descriptive quality string with the source name and domain.
        let quality = stream.name;
        try {
            const domain = new URL(stream.url).hostname;
            quality = `${stream.name} (${domain})`;
        } catch (e) {
            // If the URL is invalid for some reason, just use the stream name.
        }

        return {
            url: streamUrl,
            quality: quality,
            videoType: "HLS",
            confirmedAt: stream.confirmedAt
        };
    });

    const startTime = game.time || new Date(game.releaseDate).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    // Dynamically set the genre based on the game's league/category.
    const sportGenre = game.league ? game.league.toLowerCase().replace(/-/g, ' ') : 'general';

    return {
        id: game.id,
        title: game.name,
        shortDescription: `${game.league} - ${startTime}`,
        startTime: startTime,
        thumbnail: imageUrl || FALLBACK_THUMBNAIL,
        genres: ["sports", sportGenre],
        releaseDate: game.releaseDate.split('T')[0], // Use the date part of the releaseDate
        streamSignature: getStreamSignature(game),
        content: {
            dateAdded: game.releaseDate, // Use the full releaseDate ISO string
            duration: 3 * 60 * 60, // ~3 hours
            videos: videos,
        },
    };
}

/**
 * Generates the main shell of the Roku feed.
 * @returns {object} An object representing the feed structure without content.
 */
export function generateFeedShell() {
  return {
    providerName: "Roku Hockey",
    lastUpdated: new Date().toISOString(),
    language: "en-US",
    "NHL": [],
    "NCAA D1 Mens": []
  };
}
