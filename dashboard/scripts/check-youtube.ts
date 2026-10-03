// Smoke test of the YouTube Data API integration with the key from the root .env.
// Usage: npm run check:youtube -- <videoId> [channelId]
// Read-only: prints public stats, writes nothing (no history.json, no snapshots). Costs 1-2 quota units.
import { config } from "../server/config.js";
import { fetchChannel, fetchVideos } from "../server/youtube.js";

const [videoId, channelId] = process.argv.slice(2);
const apiKey = config.youtube.apiKey;
if (!apiKey) throw new Error("YOUTUBE_API_KEY não está definida no .env da raiz");
if (!videoId) throw new Error("Uso: npm run check:youtube -- <videoId> [channelId]");

const videos = await fetchVideos(apiKey, [videoId]);
console.log("videos.list:", JSON.stringify(Object.fromEntries(videos), null, 2));
if (channelId) console.log("channels.list:", JSON.stringify(await fetchChannel(apiKey, channelId), null, 2));
