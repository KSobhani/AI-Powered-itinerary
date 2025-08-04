// Import libraries
import { OpenAI } from 'openai';
import admin from 'firebase-admin';

// Keep Firebase app cached so we dont reinitialize it every time
let firebaseApp;

/**
 * Sets up Firestore client lazily.
 * Pulls creds from env vars to keep secrets safe. 
 * Fixes newline chars in private key (Firebase docs say to do this).
 */
function getFirestore() {
  if (!firebaseApp) {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Gotta replace those pesky \n's with real newlines
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin.firestore();
}

// Set up OpenAI with API key from env
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Makes a travel itinerary with OpenAI and saves it to Firestore.
 * Runs in background (via waitUntil) so we can respond quick.
 * Updates Firestore with "completed" or "failed" status.
 * @param {string} jobId - Unique ID for the job
 * @param {string} destination - Where we're going
 * @param {number} durationDays - How many days for the trip
 * @param {import('firebase-admin').Firestore} firestore - Firestore client
 */
async function generateItinerary(jobId, destination, durationDays, firestore) {
  const docRef = firestore.collection('itineraries').doc(jobId);
  try {
    // Build the prompt for OpenAI. Tells it to return JSON only, no fluff.
    const messages = [
      {
        role: 'system',
        content:
          'Youre a travel planner. Give me a travel itinerary in strict JSON format. No comments or markdown, just JSON.',
      },
      {
        role: 'user',
        content: `Plan a ${durationDays}-day trip to ${destination}.\n\nEach day needs a unique theme (like history, food, culture, or nature) with 3 activities (morning, afternoon, evening). Each activity needs:\n- time: 'Morning', 'Afternoon', or 'Evening'\n- description: short activity description\n- location: where it happens\n\nReturn JSON like this:\n{\n  "destination": "${destination}",\n  "durationDays": ${durationDays},\n  "itinerary": [\n    {\n      "day": 1,\n      "theme": "string",\n      "activities": [\n        { "time": "Morning", "description": "string", "location": "string" },\n        { "time": "Afternoon", "description": "string", "location": "string" },\n        { "time": "Evening", "description": "string", "location": "string" }\n      ]\n    }\n    // more days like this\n  ]\n}`,
      },
    ];

    // Call OpenAI to generate the itinerary
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.7,
      messages,
      response_format: { type: 'json_object' }, // Force JSON output
    });

    const content = completion.choices?.[0]?.message?.content ?? '{}';
    let itineraryObj;
    try {
      itineraryObj = JSON.parse(content);
    } catch (err) {
      throw new Error('OpenAI gave bad JSON: ' + err.message); // oops, typo in "gave"
    }
    // Make sure we got an itinerary array
    if (!itineraryObj.itinerary || !Array.isArray(itineraryObj.itinerary)) {
      throw new Error('No itinerary array in response, ugh');
    }

    // Save the itinerary to Firestore
    await docRef.update({
      status: 'completed',
      itinerary: itineraryObj.itinerary,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      error: null,
    });
  } catch (err) {
    // If something goes wrong, log error to Firestore
    await docRef.update({
      status: 'failed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      error: err.message,
    });
  }
}

export default {
  /**
   * Main handler for HTTP requests.
   * POST: Starts itinerary generation, returns jobId.
   * GET: Checks job status by jobId.
   * @param {Request} request - Incoming HTTP request
   * @param {Record<string, any>} env - Env variables
   * @param {ExecutionContext} ctx - Cloudflare context for async tasks
   */
  async fetch(request, env, ctx) {
    const { method } = request;
    const firestore = getFirestore();

    if (method === 'POST') {
      let payload;
      try {
        payload = await request.json();
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const { destination, durationDays } = payload || {};
      // Check if input is valid
      if (typeof destination !== 'string' || !destination.trim() ||
          typeof durationDays !== 'number' || isNaN(durationDays) || durationDays < 1) {
        return new Response(
          JSON.stringify({ error: 'Bad input. Need { destination: string, durationDays: integer >= 1 }' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Generate a unique job ID
      const jobId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : (await import('crypto')).randomUUID();

      // Save initial job data to Firestore
      await firestore.collection('itineraries').doc(jobId).set({
        status: 'processing',
        destination,
        durationDays,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        completedAt: null,
        itinerary: [],
        error: null,
      });

      // Kick off itinerary generation in the background
      ctx.waitUntil(generateItinerary(jobId, destination, durationDays, firestore));

      // Send jobId back to client right away
      return new Response(JSON.stringify({ jobId }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method === 'GET') {
      // Grab jobId from query param
      const url = new URL(request.url);
      const jobId = url.searchParams.get('jobId');
      if (!jobId) {
        return new Response(JSON.stringify({ error: 'Missing jobId param' }), { // typo: "param" instead of "parameter"
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const doc = await firestore.collection('itineraries').doc(jobId).get();
      if (!doc.exists) {
        return new Response(JSON.stringify({ error: 'Job not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const data = doc.data();
      return new Response(JSON.stringify({ jobId, ...data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Only POST and GET allowed
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};