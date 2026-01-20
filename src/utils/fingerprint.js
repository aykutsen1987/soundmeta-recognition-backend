import { execFile } from "child_process";
import path from "path";

const fpcalcPath = path.resolve("bin/fpcalc");

export function generateFingerprint(audioPath) {
  return new Promise((resolve, reject) => {
    execFile(fpcalcPath, ["-json", audioPath], (err, stdout) => {
      if (err) return reject(err);
      const data = JSON.parse(stdout);
      resolve({
        fingerprint: data.fingerprint,
        duration: data.duration
      });
    });
  });
}
