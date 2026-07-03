// /api/horoscope.js
// Vercel Serverless Function (Node.js runtime)
// Keeps PROKERALA_CLIENT_ID / PROKERALA_CLIENT_SECRET on the server only.
// Set these as Environment Variables in the Vercel project settings —
// never put them in the frontend code.

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry - 60_000) {
    return cachedToken;
  }

  const clientId = process.env.PROKERALA_CLIENT_ID;
  const clientSecret = process.env.PROKERALA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "PROKERALA_CLIENT_ID / PROKERALA_CLIENT_SECRET environment variables not set on the server."
    );
  }

  const res = await fetch("https://api.prokerala.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = now + (data.expires_in ? data.expires_in * 1000 : 3000_000);
  return cachedToken;
}

async function geocodePlace(place) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
    place
  )}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "jathagam-app/1.0 (personal horoscope calculator)" },
  });
  if (!res.ok) throw new Error("இடத்தை கண்டறிய முடியவில்லை (geocoding failed).");
  const results = await res.json();
  if (!results.length) throw new Error("இந்த ஊரின் பெயருக்கு இடம் கிடைக்கவில்லை. இன்னும் துல்லியமாக உள்ளிடவும்.");
  return { latitude: parseFloat(results[0].lat), longitude: parseFloat(results[0].lon) };
}

async function callProkerala(endpoint, params, token) {
  const url = new URL(`https://api.prokerala.com/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.errors?.[0]?.detail || `${endpoint} request failed (${res.status})`);
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST method மட்டும் அனுமதிக்கப்படும்." });
  }

  try {
    const { name, date, time, place, utcOffset } = req.body || {};

    if (!date || !time || !place) {
      return res.status(400).json({ error: "தேதி, நேரம், இடம் மூன்றும் அவசியம்." });
    }

    // 1) Resolve birthplace to coordinates
    const { latitude, longitude } = await geocodePlace(place);

    // 2) Build ISO 8601 datetime with the given UTC offset (default India +05:30)
    const offset = utcOffset || "+05:30";
    const datetime = `${date}T${time}:00${offset}`;
    const coordinates = `${latitude},${longitude}`;

    // 3) Get OAuth token (server-side only)
    const token = await getAccessToken();

    // 4) Fetch kundli (birth chart) and planet positions in parallel
    const commonParams = { ayanamsa: 1, coordinates, datetime, la: "ta" };

    const [kundli, planetPosition] = await Promise.all([
      callProkerala("v2/astrology/kundli/advanced", commonParams, token),
      callProkerala("v2/astrology/planet-position", commonParams, token).catch(() => null),
    ]);

    return res.status(200).json({
      name: name || "",
      birth: { date, time, place, latitude, longitude, offset },
      kundli,
      planetPosition,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "தெரியாத பிழை ஏற்பட்டது." });
  }
}
