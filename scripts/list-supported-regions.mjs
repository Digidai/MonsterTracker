#!/usr/bin/env node
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;

if (!accountId || !token) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
  process.exit(1);
}

const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/placement/regions`,
  {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  }
);

const body = await response.json();
if (!response.ok || body.success === false) {
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(body.result, null, 2));
