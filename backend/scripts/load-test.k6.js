/**
 * k6 Load Testing Suite for TrustFlow Backend
 *
 * Simulates 500 concurrent users performing:
 * - Escrow creation
 * - Escrow status checks
 * - Webhook registration and triggering
 *
 * Target: p95 response time < 250ms at 200 req/sec sustained load
 *
 * Usage:
 *   k6 run --vus 500 --duration 5m backend/scripts/load-test.k6.js
 *   k6 run --vus 100 --duration 1m --env BASE_URL=https://api.trustflow.xyz backend/scripts/load-test.k6.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const escrowCreationDuration = new Trend('escrow_creation_duration');
const escrowStatusDuration = new Trend('escrow_status_duration');
const webhookRegistrationDuration = new Trend('webhook_registration_duration');
const escrowCreationCount = new Counter('escrow_creation_count');
const webhookTriggerCount = new Counter('webhook_trigger_count');

// Configuration
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_VERSION = 'v1';

export const options = {
  stages: [
    { duration: '30s', target: 50 }, // Ramp up to 50 users
    { duration: '1m', target: 100 }, // Ramp up to 100 users
    { duration: '2m', target: 200 }, // Ramp up to 200 users
    { duration: '3m', target: 500 }, // Ramp up to 500 users (target load)
    { duration: '2m', target: 500 }, // Sustain 500 users
    { duration: '30s', target: 0 }, // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<250'], // 95% of requests must complete below 250ms
    errors: ['rate<0.1'], // Error rate must be below 10%
    http_req_failed: ['rate<0.05'], // Less than 5% failed requests
  },
  ext: {
    loadimpact: {
      projectID: 3000000,
      name: 'TrustFlow Backend Load Test',
    },
  },
};

/**
 * Generate a random Stellar wallet address for testing
 */
function generateWalletAddress() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let address = 'G';
  for (let i = 0; i < 55; i++) {
    address += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return address;
}

/**
 * Generate random escrow data matching CreateEscrowSchema (depositor, beneficiary, amountXLM).
 * The global ValidationPipe uses forbidNonWhitelisted, so any extra field is a 400.
 */
function generateEscrowData() {
  return {
    depositor: generateWalletAddress(),
    beneficiary: generateWalletAddress(),
    amountXLM: String(Math.floor(Math.random() * 10000) + 1000),
  };
}

/**
 * Test scenario: User journey creating an escrow and checking status
 */
export default function () {
  const userId = `user-${__VU}-${__ITER}`;

  // Scenario 1: Create an escrow (40% of requests)
  if (Math.random() < 0.4) {
    const escrowData = generateEscrowData();
    const createStart = Date.now();

    const createResponse = http.post(
      `${BASE_URL}/${API_VERSION}/escrows`,
      JSON.stringify(escrowData),
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': `${userId}-${Date.now()}`,
        },
        tags: { name: 'CreateEscrow' },
      },
    );

    const createDuration = Date.now() - createStart;
    escrowCreationDuration.add(createDuration);
    escrowCreationCount.add(1);

    const createOk = check(createResponse, {
      'escrow created successfully': r => r.status === 201 || r.status === 200,
      'escrow has id': r => {
        try {
          const body = JSON.parse(r.body);
          return body && body.id;
        } catch {
          return false;
        }
      },
    });

    if (!createOk) {
      errorRate.add(1);
      console.error(`Escrow creation failed: ${createResponse.status} ${createResponse.body}`);
    }
  }

  // Scenario 2: Check escrow status (35% of requests)
  if (Math.random() < 0.35) {
    const escrowId = `escrow-${Math.floor(Math.random() * 1000)}`;
    const statusStart = Date.now();

    const statusResponse = http.get(`${BASE_URL}/${API_VERSION}/escrows/${escrowId}`, {
      tags: { name: 'GetEscrowStatus' },
    });

    const statusDuration = Date.now() - statusStart;
    escrowStatusDuration.add(statusDuration);

    const statusOk = check(statusResponse, {
      'status check responded': r => r.status === 200 || r.status === 404,
    });

    if (!statusOk) {
      errorRate.add(1);
    }
  }

  // Scenario 3: Register webhook and trigger (25% of requests)
  if (Math.random() < 0.25) {
    const webhookUrl = `https://webhook.site/${userId}`;
    const registerStart = Date.now();

    const registerResponse = http.post(
      `${BASE_URL}/${API_VERSION}/webhooks`,
      JSON.stringify({
        id: userId,
        url: webhookUrl,
        events: ['escrow.created', 'escrow.released'],
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
        tags: { name: 'RegisterWebhook' },
      },
    );

    const registerDuration = Date.now() - registerStart;
    webhookRegistrationDuration.add(registerDuration);

    const registerOk = check(registerResponse, {
      'webhook registered': r => r.status === 201 || r.status === 200,
    });

    if (!registerOk) {
      errorRate.add(1);
    } else {
      webhookTriggerCount.add(1);
    }
  }

  // Think time: simulate realistic user behavior
  sleep(Math.random() * 2 + 0.5); // 0.5-2.5 seconds between requests
}

/**
 * Setup function - runs once at the start
 */
export function setup() {
  console.log(`Starting load test against ${BASE_URL}`);

  // Health check
  const healthResponse = http.get(`${BASE_URL}/health`);
  if (healthResponse.status !== 200) {
    throw new Error(`API health check failed: ${healthResponse.status}`);
  }

  console.log('✓ API health check passed');
  return { startTime: Date.now() };
}

/**
 * Teardown function - runs once at the end
 */
export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Load test completed in ${duration.toFixed(2)} seconds`);
}

/**
 * Handle summary to generate detailed report
 */
export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
    'load-test-results.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data, opts = {}) {
  const indent = opts.indent || '';
  const colors = opts.enableColors || false;

  let summary = '\n' + indent + '📊 Load Test Summary\n';
  summary += indent + '='.repeat(60) + '\n\n';

  // Response times
  summary += indent + 'Response Times:\n';
  const p95 = data.metrics.http_req_duration?.values?.['p(95)'] || 0;
  const avg = data.metrics.http_req_duration?.values?.avg || 0;
  const max = data.metrics.http_req_duration?.values?.max || 0;

  summary += indent + `  Average: ${avg.toFixed(2)}ms\n`;
  summary += indent + `  p(95): ${p95.toFixed(2)}ms ${p95 < 250 ? '✓' : '✗'}\n`;
  summary += indent + `  Max: ${max.toFixed(2)}ms\n\n`;

  // Request counts
  summary += indent + 'Request Counts:\n';
  summary += indent + `  Total Requests: ${data.metrics.http_reqs?.values?.count || 0}\n`;
  summary +=
    indent + `  Escrow Creations: ${data.metrics.escrow_creation_count?.values?.count || 0}\n`;
  summary +=
    indent + `  Webhook Triggers: ${data.metrics.webhook_trigger_count?.values?.count || 0}\n\n`;

  // Error rates
  const errorRate = (data.metrics.errors?.values?.rate || 0) * 100;
  const failedReqs = (data.metrics.http_req_failed?.values?.rate || 0) * 100;

  summary += indent + 'Error Rates:\n';
  summary +=
    indent + `  Application Errors: ${errorRate.toFixed(2)}% ${errorRate < 10 ? '✓' : '✗'}\n`;
  summary +=
    indent + `  Failed Requests: ${failedReqs.toFixed(2)}% ${failedReqs < 5 ? '✓' : '✗'}\n\n`;

  return summary;
}
