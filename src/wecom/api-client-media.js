import { buildWecomApiUrl } from "./network-config.js";

export function createWecomApiMediaClient({
  fetchWithRetry,
  getWecomAccessToken,
} = {}) {
  if (typeof fetchWithRetry !== "function") {
    throw new Error("createWecomApiMediaClient: fetchWithRetry is required");
  }
  if (typeof getWecomAccessToken !== "function") {
    throw new Error("createWecomApiMediaClient: getWecomAccessToken is required");
  }

  async function uploadWecomMedia({ corpId, corpSecret, type, buffer, filename, logger, proxyUrl, apiBaseUrl }) {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret, proxyUrl, logger, apiBaseUrl });
    const uploadUrl = buildWecomApiUrl(
      `/cgi-bin/media/upload?access_token=${encodeURIComponent(accessToken)}&type=${encodeURIComponent(type)}`,
      { apiBaseUrl },
    );

    const boundary = `----WecomMediaUpload${Date.now()}`;
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, buffer, footer]);

    const res = await fetchWithRetry(
      uploadUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
        apiBaseUrl,
      },
      3,
      1000,
      { proxyUrl, logger },
    );

    const json = await res.json();
    if (json?.errcode !== 0) {
      throw new Error(`WeCom media upload failed: ${JSON.stringify(json)}`);
    }
    return json.media_id;
  }

  async function downloadWecomMedia({ corpId, corpSecret, mediaId, proxyUrl, logger, apiBaseUrl }) {
    const accessToken = await getWecomAccessToken({ corpId, corpSecret, proxyUrl, logger, apiBaseUrl });
    const mediaUrl = buildWecomApiUrl(
      `/cgi-bin/media/get?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(mediaId)}`,
      { apiBaseUrl },
    );

    const res = await fetchWithRetry(mediaUrl, { apiBaseUrl }, 3, 1000, { proxyUrl, logger });
    if (!res.ok) {
      throw new Error(`Failed to download media: ${res.status}`);
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = await res.json();
      throw new Error(`WeCom media download failed: ${JSON.stringify(json)}`);
    }

    const buffer = await res.arrayBuffer();
    return {
      buffer: Buffer.from(buffer),
      contentType,
    };
  }

  return {
    uploadWecomMedia,
    downloadWecomMedia,
  };
}
