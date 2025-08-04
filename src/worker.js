//َAccess for UI

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};


//Importing libraries

import { OpenAI } from 'openai';
import { z } from 'zod';

// Initialize OpenAI client with API key from environment
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Zod schema for validating LLM response
const activitySchema = z.object({
  time: z.enum(['Morning', 'Afternoon', 'Evening']),
  description: z.string().min(1),
  location: z.string().min(1),
});

const daySchema = z.object({
  day: z.number().int().min(1),
  theme: z.string().min(1),
  activities: z.array(activitySchema).length(3),
});

const itinerarySchema = z.object({
  destination: z.string().min(1),
  durationDays: z.number().int().min(1),
  itinerary: z.array(daySchema),
});

/**
 * Generates a JWT and exchanges it for an OAuth 2 access token.
 * @returns {Promise<string>} Access token
 */
async function getFirebaseAuthToken() {
  console.log('Requesting Firebase auth token');
  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    const jwtHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const jwtPayload = Buffer.from(
      JSON.stringify({
        iss: process.env.FIREBASE_CLIENT_EMAIL,
        scope: 'https://www.googleapis.com/auth/datastore',
        aud: 'https://oauth2.googleapis.com/token',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString('base64url');
    const signatureInput = `${jwtHeader}.${jwtPayload}`;

    // Import the private key for signing
    const key = await crypto.subtle.importKey(
      'pkcs8',
      Buffer.from(privateKey.split('\n').slice(1, -1).join('\n'), 'base64'),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(signatureInput)
    );
    const jwt = `${signatureInput}.${Buffer.from(signature).toString('base64url')}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });
    if (!response.ok) {
      const error = await response.text();
      console.error('Failed to get Firebase token:', error);
      throw new Error('Failed to get Firebase token: ' + error);
    }
    const data = await response.json();
    console.log('Firebase auth token obtained');
    return data.access_token;
  } catch (err) {
    console.error('Error in getFirebaseAuthToken:', err.message, err.stack);
    throw err;
  }
}

/**
 * Generate a travel itinerary using OpenAI and update Firestore via REST API.
 * Runs asynchronously via ctx.waitUntil() to allow early response.
 * @param {string} jobId Unique identifier for the itinerary document
 * @param {string} destination Destination provided by the user
 * @param {number} durationDays Number of days for the trip
 */
async function generateItinerary(jobId, destination, durationDays) {
  console.log(`Starting itinerary generation for jobId: ${jobId}, destination: ${destination}, duration: ${durationDays}`);
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/itineraries/${jobId}`;
  
  try {
    // Compose the OpenAI prompt (enforced strict JSON output, and optimized it for token efficiency)
    const messages = [
      {
        role: 'system',
        content: 'You are a helpful travel planning assistant. Your task is to produce a travel itinerary in strict JSON format. Do not include any extra commentary or markdown. Only return a JSON object.',
      },
      {
        role: 'user',
        content: `Create a detailed ${durationDays}-day itinerary for a trip to ${destination}.\n\nFor each day, choose a unique theme (e.g., historical landmarks, local cuisine, cultural experiences, nature) and list three activities for the morning, afternoon and evening. Each activity must include:\n- time: one of 'Morning', 'Afternoon' or 'Evening'\n- description: a concise recommendation describing what to do\n- location: the specific place where the activity takes place.\n\nReturn the response as valid JSON with this top-level structure:\n{\n  "destination": "${destination}",\n  "durationDays": ${durationDays},\n  "itinerary": [\n    {\n      "day": 1,\n      "theme": "string",\n      "activities": [\n        { "time": "Morning", "description": "string", "location": "string" },\n        { "time": "Afternoon", "description": "string", "location": "string" },\n        { "time": "Evening", "description": "string", "location": "string" }\n      ]\n    }\n    // additional days follow the same structure\n  ]\n}`,
      },
    ];

    console.log('Sending request to OpenAI');
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.7,
      messages,
      response_format: { type: 'json_object' },
    });
    console.log('OpenAI response received');

    const content = completion.choices?.[0]?.message?.content ?? '{}';
    let itineraryObj;
    try {
      itineraryObj = JSON.parse(content);
      console.log('Parsed OpenAI response:', itineraryObj);
    } catch (err) {
      console.error('JSON parse error:', err.message, err.stack);
      throw new Error('Invalid JSON returned by OpenAI: ' + err.message);
    }

    // Validate the itinerary with Zod
    try {
      itinerarySchema.parse(itineraryObj);
      console.log('Zod validation successful');
    } catch (err) {
      console.error('Zod validation error:', err.message, err.stack);
      throw new Error('Invalid itinerary structure: ' + err.message);
    }

    // Update Firestore with completed status
    const token = await getFirebaseAuthToken();
    const updatePayload = {
      fields: {
        status: { stringValue: 'completed' },
        itinerary: {
          arrayValue: {
            values: itineraryObj.itinerary.map(day => ({
              mapValue: {
                fields: {
                  day: { integerValue: day.day },
                  theme: { stringValue: day.theme },
                  activities: {
                    arrayValue: {
                      values: day.activities.map(activity => ({
                        mapValue: {
                          fields: {
                            time: { stringValue: activity.time },
                            description: { stringValue: activity.description },
                            location: { stringValue: activity.location },
                          },
                        },
                      })),
                    },
                  },
                },
              },
            })),
          },
        },
        completedAt: { timestampValue: new Date().toISOString() },
        error: { nullValue: null },
      },
    };

    console.log(`Updating Firestore for jobId: ${jobId}`);
    const updateResponse = await fetch(docUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updatePayload),
    });
    if (!updateResponse.ok) {
      const error = await updateResponse.text();
      console.error('Firestore update failed:', error);
      throw new Error('Firestore update failed: ' + error);
    }
    console.log(`Firestore updated successfully for jobId: ${jobId}`);
  } catch (err) {
    console.error('Error in generateItinerary:', err.message, err.stack);
    // Update Firestore with failure status
    try {
      const token = await getFirebaseAuthToken();
      const errorPayload = {
        fields: {
          status: { stringValue: 'failed' },
          completedAt: { timestampValue: new Date().toISOString() },
          error: { stringValue: err.message },
        },
      };
      const errorResponse = await fetch(docUrl, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(errorPayload),
      });
      if (!errorResponse.ok) {
        console.error('Firestore error update failed:', await errorResponse.text());
      }
    } catch (errorUpdateErr) {
      console.error('Failed to update Firestore with error status:', errorUpdateErr.message, errorUpdateErr.stack);
    }
  }
}

export default {
  /**
   * HTTP handler for the Cloudflare Worker.
   * Supports POST to initiate itinerary generation and GET to retrieve status/results.
   * @param {Request} request Incoming request
   * @param {Record<string, any>} env Bound environment variables
   * @param {ExecutionContext} ctx Cloudflare execution context
   */
  async fetch(request, env, ctx) {
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const { method } = request;
    const projectId = process.env.FIREBASE_PROJECT_ID;

    if (method === 'POST') {
      console.log('Received POST request');
      let payload;
      try {
        payload = await request.json();
        console.log('Parsed POST payload:', payload);
      } catch (err) {
        console.error('Invalid JSON body:', err.message, err.stack);
        // Updated to include corsHeaders
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const { destination, durationDays } = payload || {};
      if (typeof destination !== 'string' || !destination.trim() ||
          typeof durationDays !== 'number' || isNaN(durationDays) || durationDays < 1) {
        console.error('Invalid input:', { destination, durationDays });
        // Updated to include corsHeaders
        return new Response(
          JSON.stringify({ error: 'Invalid input. Expect { destination: string, durationDays: integer >= 1 }' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const jobId = crypto.randomUUID();
      console.log(`Generated jobId: ${jobId}`);

      // Create Firestore document with processing status
      const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/itineraries/${jobId}`;
      try {
        const token = await getFirebaseAuthToken();
        const createPayload = {
          fields: {
            status: { stringValue: 'processing' },
            destination: { stringValue: destination },
            durationDays: { integerValue: durationDays },
            createdAt: { timestampValue: new Date().toISOString() },
            completedAt: { nullValue: null },
            itinerary: { arrayValue: { values: [] } },
            error: { nullValue: null },
          },
        };
        console.log(`Creating Firestore document for jobId: ${jobId}`);
        const createResponse = await fetch(docUrl, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(createPayload),
        });
        if (!createResponse.ok) {
          const error = await createResponse.text();
          console.error('Firestore create failed:', error);
          throw new Error('Firestore create failed: ' + error);
        }
        console.log(`Firestore document created for jobId: ${jobId}`);
      } catch (err) {
        console.error('Failed to create Firestore document:', err.message, err.stack);
        // Updated to include corsHeaders
        return new Response(JSON.stringify({ error: 'Failed to initiate job' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Schedule itinerary generation
      ctx.waitUntil(generateItinerary(jobId, destination, durationDays));
      console.log(`Returning 202 response with jobId: ${jobId}`);
      // Updated to include corsHeaders
      return new Response(JSON.stringify({ jobId }), {
        status: 202,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (method === 'GET') {
      console.log('Received GET request');
      const url = new URL(request.url);
      const jobId = url.searchParams.get('jobId');
      if (!jobId) {
        console.error('Missing jobId query parameter');
        // Updated to include corsHeaders
        return new Response(JSON.stringify({ error: 'Missing jobId query parameter' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      console.log(`Fetching Firestore document for jobId: ${jobId}`);
      const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/itineraries/${jobId}`;
      try {
        const token = await getFirebaseAuthToken();
        const docResponse = await fetch(docUrl, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!docResponse.ok) {
          if (docResponse.status === 404) {
            console.error(`Job not found for jobId: ${jobId}`);
            // Updated to include corsHeaders
            return new Response(JSON.stringify({ error: 'Job not found' }), {
              status: 404,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          const error = await docResponse.text();
          console.error('Firestore fetch failed:', error);
          throw new Error('Firestore fetch failed: ' + error);
        }
        const doc = await docResponse.json();
        console.log(`Firestore document retrieved for jobId: ${jobId}`);
        // Convert Firestore document to a simpler JSON format
        const data = {
          status: doc.fields.status?.stringValue,
          destination: doc.fields.destination?.stringValue,
          durationDays: parseInt(doc.fields.durationDays?.integerValue) || undefined,
          createdAt: doc.fields.createdAt?.timestampValue,
          completedAt: doc.fields.completedAt?.timestampValue || null,
          itinerary: doc.fields.itinerary?.arrayValue?.values?.map(day => ({
            day: parseInt(day.mapValue.fields.day?.integerValue),
            theme: day.mapValue.fields.theme?.stringValue,
            activities: day.mapValue.fields.activities?.arrayValue?.values?.map(activity => ({
              time: activity.mapValue.fields.time?.stringValue,
              description: activity.mapValue.fields.description?.stringValue,
              location: activity.mapValue.fields.location?.stringValue,
            })) || [],
          })) || [],
          error: doc.fields.error?.stringValue || null,
        };
        // Updated to include corsHeaders
        return new Response(JSON.stringify({ jobId, ...data }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        console.error('Error fetching Firestore document:', err.message, err.stack);
        // Updated to include corsHeaders
        return new Response(JSON.stringify({ error: 'Failed to retrieve job' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    console.error(`Method not allowed: ${method}`);
    // Updated to include corsHeaders
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  },
};