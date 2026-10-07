/**
 * DERRCS — Serverless Dispatch Logger (AWS Lambda)
 * Unit 4: Serverless Architecture
 *
 * This function is triggered via AWS API Gateway every time the
 * dispatch-service successfully assigns a resource to an incident.
 *
 * Serverless characteristics demonstrated:
 *  - Stateless: no in-memory state, each invocation is independent
 *  - Event-driven: only runs when a dispatch event occurs
 *  - Pay-per-execution: zero cost when idle
 *  - Managed scaling: AWS auto-scales on concurrent dispatches
 *  - No server management: runtime, OS, patching handled by AWS
 *
 * All logs are persisted in AWS CloudWatch Logs automatically.
 */

exports.handler = async (event) => {
  console.log('[DERRCS Lambda] Dispatch Logger invoked');

  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (e) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const {
    incidentId,
    resourceId,
    resourceName,
    incidentType,
    location,
    dispatchedAt,
    lamportTs,
    dispatchServiceId
  } = body || {};

  // Validate required fields
  if (!incidentId || !resourceId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Missing required fields: incidentId, resourceId' })
    };
  }

  // Build structured dispatch log entry
  const logEntry = {
    eventType: 'DISPATCH_ASSIGNED',
    timestamp: new Date().toISOString(),
    dispatchedAt: dispatchedAt || new Date().toISOString(),
    incidentId,
    resourceId,
    resourceName: resourceName || 'Unknown',
    incidentType: incidentType || 'Unknown',
    location: location || {},
    lamportTs: lamportTs || null,
    dispatchServiceId: dispatchServiceId || 'dispatch-1',
    // AWS Lambda execution context metadata
    awsRequestId: process.env.AWS_REQUEST_ID || 'local',
    region: process.env.AWS_REGION || 'ap-south-1',
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME || 'derrcs-dispatch-logger',
    functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION || '$LATEST',
  };

  // Log to CloudWatch (console.log → CloudWatch Logs automatically)
  console.log('[DERRCS Lambda] DISPATCH EVENT:', JSON.stringify(logEntry, null, 2));
  console.log(`[DERRCS Lambda] Incident ${incidentId} (${incidentType}) → Resource ${resourceName} (${resourceId}) at L:${lamportTs}`);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({
      success: true,
      message: 'Dispatch event logged to CloudWatch',
      logEntry,
      serverless: {
        provider: 'AWS Lambda',
        region: process.env.AWS_REGION || 'ap-south-1',
        concept: 'Unit 4 - Serverless Architecture: stateless, event-driven, pay-per-execution'
      }
    })
  };
};
