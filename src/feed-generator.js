const FALLBACK_THUMBNAIL = "https://via.placeholder.com/1280x720.png?text=Image+Not+Available";

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

        return {
            url: stream.url,
            quality: quality,
            videoType: "HLS",
        };
    });

    const releaseDate = new Date().toISOString().split('T')[0];
    const dateAdded = new Date(`${releaseDate}T${game.time}:00Z`).toISOString();

    return {
        id: game.id,
        title: game.name,
        shortDescription: `${game.league} - ${game.time}`,
        startTime: game.time,
        thumbnail: imageUrl || FALLBACK_THUMBNAIL,
        genres: ["sports", "hockey"],
        releaseDate: releaseDate,
        content: {
            dateAdded: dateAdded,
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
