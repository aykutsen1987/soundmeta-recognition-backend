import axios from "axios";
import fs from "fs";
import FormData from "form-data";

const AUDD_URL = "https://api.audd.io/";

export async function recognizeWithAudD(filePath) {
  if (!process.env.AUDD_API_TOKEN) {
    return null;
  }

  try {
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));
    form.append("api_token", process.env.AUDD_API_TOKEN);
    form.append("return", "apple_music,spotify");

    const response = await axios.post(AUDD_URL, form, {
      headers: form.getHeaders(),
      timeout: 15000
    });

    if (!response.data?.result) {
      return null;
    }

    return {
      title: response.data.result.title,
      artist: response.data.result.artist,
      album: response.data.result.album,
      release_date: response.data.result.release_date,
      source: "AudD"
    };

  } catch (err) {
    // LIMIT DOLU, 429 vs → sessizce geç
    return null;
  }
}
