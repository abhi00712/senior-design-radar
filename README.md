# Senior Design Radar

Bengaluru UX and product designer openings for a senior UX designer with 4 years of experience. The listings in `jobs.js` are refreshed every morning by a scheduled scan.

## Daily scan

`.github/workflows/daily-scan.yml` runs `scripts/scan.mjs` every day at 9:00 AM IST on GitHub Actions. It reads LinkedIn's public job search. When the `OPENAI_API_KEY` repository secret is set, it also reads Wellfound and Cutshort and uses OpenAI to pull out experience, pay and domain for new listings. Without the secret it falls back to keyword rules.

Optional: set a repository variable `OPENAI_MODEL` to change the model.
