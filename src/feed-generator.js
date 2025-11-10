const FALLBACK_THUMBNAIL = "https://via.placeholder.com/1280x720.png?text=Image+Not+Available";
const PROXY_SERVER = 'http://192.168.1.50:8787';

/**
 * Creates a single content item for the Roku feed.
 * @param {any} game - The game object.
 * @param {string} imageUrl - The public URL for the game's poster image.
 * @returns {object} A Roku feed item object.
 */
export function createFeedItem(game, imageUrl) {
    const videos = game.streamLinks.map(stream => {
        const quality = stream.feedType && stream.feedType !== 'main'
            ? `${stream.provider} (${stream.feedType})`
            : stream.provider;

        let streamUrl = stream.url;
        
        // If the stream has a Referer header, rewrite the URL to use the proxy.
        if (stream.headers && stream.headers.Referer) {
            console.log(`-- Found referer for stream. Rewriting URL for hardcoded proxy: ${stream.url}`);
            const b64StreamUrl = Buffer.from(stream.url).toString('base64');
            // The proxy is now hardcoded, so we don't need to pass the referer in the query.
            streamUrl = `${PROXY_SERVER}/proxy/${b64StreamUrl}`;
        }

        return {
            url: streamUrl,
            quality: quality,
            videoType: "HLS",
        };
    });

    const startTime = game.time || new Date(game.releaseDate).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    return {
        id: game.id,
        title: game.name,
        shortDescription: `${game.league} - ${startTime}`,
        startTime: startTime,
        thumbnail: imageUrl || FALLBACK_THUMBNAIL,
        genres: ["sports", "hockey"],
        releaseDate: game.releaseDate.split('T')[0], // Use the date part of the releaseDate
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
