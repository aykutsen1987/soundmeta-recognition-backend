import axios from "axios";

export async function recognizeWithAcoustID(fingerprint, duration) {
  const apiKey = process.env.ACOUSTID_API_KEY;

  const response = await axios.get(
    "https://api.acoustid.org/v2/lookup",
    {
      params: {
        client: apiKey,
        fingerprint: fingerprint,
        duration: duration,
        meta: "recordings releasegroups artists"
      }
    }
  );

  return response.data;
}
