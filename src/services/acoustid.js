import { execFile } from "child_process";
import axios from "axios";

const FPCALC_PATH = "./bin/fpcalc";
const ACOUSTID_URL = "https://api.acoustid.org/v2/lookup";

function runFpcalc(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      FPCALC_PATH,
      ["-json", filePath],
      (error, stdout) => {
        if (error) return reject(error);

        try {
          const data = JSON.parse(stdout);
          resolve({
            fingerprint: data.fingerprint,
            duration: Math.round(data.duration)
          });
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

export async function recognizeWithAcoustID(filePath) {
  if (!process.env.ACOUSTID_API_KEY) return null;

  try {
    const { fingerprint, duration } = await runFpcalc(filePath);

    const response = await axios.get(ACOUSTID_URL, {
      params: {
        client: process.env.ACOUSTID_API_KEY,
        fingerprint,
        duration,
        meta: "recordings+releasegroups+artists"
      },
      timeout: 15000
    });

    const results = response.data.results;
    if (!results || results.length === 0) return null;

    const recording = results[0].recordings?.[0];
    if (!recording) return null;

    return {
      title: recording.title,
      artist: recording.artists?.[0]?.name || null,
      source: "AcoustID"
    };
  } catch (err) {
    return null;
  }
}
